package com.zcode.ideaplugin.protocol

import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * ZCode 凭证值解密器——官方 credential-security 包的 Kotlin 复刻。
 *
 * v1（2026-09-21 开源仓库源码逐行核对，apps/zcode-cli/packages/adapters/src/auth/credential-cipher.ts）：
 * - 格式 `enc:v1:<iv base64url>.<authTag base64url>.<ciphertext base64url>`
 * - AES-256-GCM，IV 12 字节、auth tag 16 字节，key = sha256(secret)
 * - secret = env ZCODE_CREDENTIAL_SECRET（trim 后非空优先），缺省
 *   `zcode-credential-fallback:{platform}:{homedir}:{username}`（Node os.platform()
 *   取值 win32/darwin/linux，userInfo().username 失败时 "unknown"）
 * - 非 `enc:` 前缀原样返回（官方同款）
 *
 * v2（2026-11-11 桌面端 3.18.0 / 开源 b95ebaff，packages/shared/src/credential-security/
 * systemCredentialCipher.ts 逐行核对）：
 * - 格式 `enc:v2:{source}:{fingerprint}:{iv.tag.ct}`，source ∈ {os,env}，
 *   fingerprint = sha256(key) hex 前 24 位（密钥正确性内嵌校验）
 * - AES-256-GCM 同 v1（iv/tag/ct 布局同款），但 **key = 随机 32 字节本体**：
 *   - source=os：密钥存系统密钥环（@napi-rs/keyring），Windows=凭据管理器，条目
 *     target = `{sha256hex(凭证文件绝对路径)}.{服务名}`，服务名 "ZCode Credential
 *     Encryption"，blob 为密码字符串的 UTF-16LE 字节（密码 = 43 字符 base64url =
 *     32 字节 key 本体，无哈希）。旁证文件 credential-source 钉住来源（"os\n"）。
 *   - source=env：ZCODE_CREDENTIAL_SECRET / ZCODE_CREDENTIAL_SECRET_FILE（32~4096
 *     字节），key = sha256(secret)
 * - 指纹不匹配按"密钥不可用"抛（官方 unavailable 语义），不得误判密文损坏
 *
 * Windows 密钥环读取：protocol-client 保持零依赖，默认实现走 PowerShell P/Invoke
 * CredReadW（实测 ~1s，进程内缓存后每会话至多一次）；单测经 [osKeyringReaderOverride]
 * 注入内存替身。macOS/Linux 暂不实现（返回 null → 结构化失败，账号渠道 fail-closed
 * 不阻断主流程）。
 *
 * 消费方：[AccountProviderBridge] 读取账号渠道凭证（zcodejwttoken / oauth:*:user_info /
 * oauth:*:access_token）前统一过本解密器。解密失败抛 [CredentialDecryptException]，
 * 调用方按"凭证不可用"降级，不得让异常冒泡阻断主流程。
 */
object CredentialCipher {

    private const val PREFIX_V1 = "enc:v1:"
    private const val PREFIX_V2 = "enc:v2:"
    private const val IV_BYTES = 12
    private const val TAG_BYTES = 16
    private const val KEY_BYTES = 32
    private const val SECRET_ENV_KEY = "ZCODE_CREDENTIAL_SECRET"
    private const val SECRET_FILE_ENV_KEY = "ZCODE_CREDENTIAL_SECRET_FILE"

    /** 官方 SYSTEM_SERVICE（@napi-rs/keyring service 名，Windows 凭据管理器目标名后半段） */
    const val OS_KEYRING_SERVICE = "ZCode Credential Encryption"

    /** 解密失败（格式非法 / tag 校验不过 / key 不匹配 / 密钥环不可读） */
    class CredentialDecryptException(message: String, cause: Throwable? = null) : Exception(message, cause)

    /** OS 密钥环读取器：返回密钥环存的原始密码（43 字符 base64url）；null = 不可读 */
    fun interface OsKeyringReader {
        fun read(service: String, user: String): String?
    }

    /** 测试注入替身；生产 null 走 [WindowsCredentialManagerReader] */
    @Volatile
    internal var osKeyringReaderOverride: OsKeyringReader? = null

    /** os key 成功缓存：credPath 规范形态 → 32 字节 key（指纹已校验） */
    private val osKeyCache = ConcurrentHashMap<String, ByteArray>()

    /** os key 负缓存（条目缺失/读取失败）：避免每次请求都拉起 PowerShell；30s 内不再尝试 */
    private val osKeyNegativeCache = ConcurrentHashMap<String, Long>()
    private const val NEGATIVE_TTL_MILLIS = 30_000L

    fun decrypt(value: String): String = decrypt(value, Credentials.defaultConfigPath().resolveSibling("credentials.json"))

    /**
     * 解密单个凭证值。[credentialFile] 是值所在的凭证文件（决定 os 密钥环条目的
     * user hash）；非密文原样返回；密文解密失败抛 [CredentialDecryptException]。
     */
    fun decrypt(value: String, credentialFile: java.nio.file.Path): String =
        decrypt(value, credentialFile, System.getenv())

    internal fun decrypt(value: String, credentialFile: java.nio.file.Path, env: Map<String, String>): String {
        return when {
            value.startsWith(PREFIX_V2) -> decryptV2(value, credentialFile, env)
            value.startsWith(PREFIX_V1) -> decryptV1(value)
            value.startsWith("enc:") ->
                throw CredentialDecryptException("Credential decrypt failed: unknown enc version")
            else -> value
        }
    }

    /**
     * v1 专用测试缝（注入固定 secret 的 legacy 语义）：v1 按 [secret] 解密；非 enc
     * 原样返回；**v2 及未知版本同样原样返回**——v1 secret 解不了 v2，v2 必须走
     * [decrypt]（密钥环/环境密钥路由）。历史向量测试与官方 v1 对拍都走这里。
     */
    internal fun decryptWithSecret(value: String, secret: String): String = when {
        value.startsWith(PREFIX_V1) -> decryptV1WithSecrets(value, listOf(secret))
        else -> value
    }

    // ============ v2：系统密钥环 / 受管环境密钥 ============

    private fun decryptV2(value: String, credentialFile: java.nio.file.Path, env: Map<String, String>): String {
        val body = value.substring(PREFIX_V2.length)
        val parts = body.split(":")
        if (parts.size != 3 || parts.any { it.isEmpty() }) {
            throw CredentialDecryptException("Credential decrypt failed: invalid v2 format")
        }
        val (source, fingerprint, payload) = parts
        if (source != "os" && source != "env") {
            throw CredentialDecryptException("Credential decrypt failed: unknown v2 source $source")
        }
        if (!Regex("^[a-f0-9]{24}$").matches(fingerprint)) {
            throw CredentialDecryptException("Credential decrypt failed: invalid v2 fingerprint")
        }
        val key = when (source) {
            "env" -> managedEnvKey(env) ?: throw CredentialDecryptException(
                "Credential decrypt failed: v2 env secret unavailable (set ZCODE_CREDENTIAL_SECRET[_FILE])"
            )
            else -> osKey(credentialFile, fingerprint) ?: throw CredentialDecryptException(
                "Credential decrypt failed: v2 os keyring entry unavailable"
            )
        }
        return openAesGcm(payload, key)
    }

    /** source=env 的 key = sha256(managed secret)；官方 resolveManagedSecret 显式两源（env 参数测试注入） */
    internal fun managedEnvKey(env: Map<String, String> = System.getenv()): ByteArray? {
        val secret = env[SECRET_ENV_KEY]?.takeIf { it.isNotEmpty() }
            ?: env[SECRET_FILE_ENV_KEY]?.let { path ->
                runCatching { java.nio.file.Path.of(path).toFile().readText() }.getOrNull()
                    ?.takeIf { it.length in 32..4096 }
            }
            ?: return null
        return sha256(secret.toByteArray(Charsets.UTF_8))
    }

    /**
     * os key 解析：多路径形态候选（Node path.resolve 与 Java toAbsolutePath().normalize()
     * 的分隔符/大小写差异）逐一派生 user hash → 读密钥环 → **指纹校验定谳**。
     * 成功按规范路径缓存；30s 负缓存防止条目缺失时反复拉起子进程。
     */
    private fun osKey(credentialFile: java.nio.file.Path, fingerprint: String): ByteArray? {
        val cacheKey = credentialFile.toString()
        osKeyCache[cacheKey]?.let { return it }
        osKeyNegativeCache[cacheKey]?.let { ts ->
            if (System.currentTimeMillis() - ts < NEGATIVE_TTL_MILLIS) return null
            osKeyNegativeCache.remove(cacheKey)
        }
        val candidates = LinkedHashSet<String>().apply {
            add(credentialFile.toString())
            add(credentialFile.toAbsolutePath().normalize().toString())
            add(credentialFile.toAbsolutePath().normalize().toString().replace('\\', '/'))
        }
        val reader = osKeyringReaderOverride ?: WindowsCredentialManagerReader
        for (candidate in candidates) {
            val user = hex(sha256(candidate.toByteArray(Charsets.UTF_8)))
            val secret = try {
                reader.read(OS_KEYRING_SERVICE, user)
            } catch (_: Exception) {
                null
            } ?: continue
            if (!Regex("^[A-Za-z0-9_-]{43}$").matches(secret)) continue
            val key = runCatching {
                Base64.getUrlDecoder().decode(padBase64Url(secret))
            }.getOrNull() ?: continue
            if (key.size != KEY_BYTES) continue
            if (hex(sha256(key)).take(24) != fingerprint) continue // 路径形态没对上，试下一个候选
            osKeyCache[cacheKey] = key
            return key
        }
        osKeyNegativeCache[cacheKey] = System.currentTimeMillis()
        return null
    }

    // ============ v1：legacy 派生密钥（官方 legacyKeyCandidates 三候选） ============

    private fun decryptV1(value: String): String = decryptV1WithSecrets(value, legacySecretCandidates())

    private fun decryptV1WithSecrets(value: String, secrets: List<String>): String {
        val raw = value.substring(PREFIX_V1.length)
        val parts = raw.split(".").map { runCatching { Base64.getUrlDecoder().decode(padBase64Url(it)) }.getOrNull() }
        if (parts.size != 3 || parts.any { it == null }) {
            throw CredentialDecryptException("Credential decrypt failed: invalid ciphertext format")
        }
        val iv = parts[0]!!; val tag = parts[1]!!; val ct = parts[2]!!
        if (iv.size != IV_BYTES || tag.size != TAG_BYTES) {
            throw CredentialDecryptException("Credential decrypt failed: invalid IV/authTag length")
        }
        val errors = mutableListOf<Exception>()
        for (secret in secrets) {
            try {
                return aesGcm(iv, tag, ct, sha256(secret.toByteArray(Charsets.UTF_8)))
            } catch (e: Exception) {
                errors.add(e)
            }
        }
        throw CredentialDecryptException(
            "Credential decrypt failed: key mismatch or corrupted ciphertext",
            errors.firstOrNull()
        )
    }

    /**
     * 官方 legacyKeyCandidates 三候选：env 原串 / env trim / fallback（v1 旧 plugin 单
     * 候选 trim；官方注释「旧 Desktop 用原字符串，旧 CLI 会 trim」——两端历史规则都试，
     * GCM 认证决定正确历史密钥）。
     */
    private fun legacySecretCandidates(): List<String> {
        val fallback = buildString {
            append("zcode-credential-fallback:")
            append(
                when {
                    System.getProperty("os.name").lowercase().contains("win") -> "win32"
                    System.getProperty("os.name").lowercase().contains("mac") ||
                        System.getProperty("os.name").lowercase().contains("darwin") -> "darwin"
                    else -> "linux"
                }
            )
            append(":")
            append(System.getProperty("user.home") ?: "unknown")
            append(":")
            append(System.getProperty("user.name")?.takeIf { it.isNotBlank() } ?: "unknown")
        }
        val env = System.getenv(SECRET_ENV_KEY)
        return listOfNotNull(
            env?.takeIf { it.isNotEmpty() },
            env?.trim()?.takeIf { it.isNotEmpty() },
            fallback,
        ).distinct()
    }

    // ============ AES-GCM 公共底座 ============

    /** payload = `iv.tag.ct`（base64url 三段）→ 明文。key 即 AES-256 key 本体 */
    private fun openAesGcm(payload: String, key: ByteArray): String {
        val parts = payload.split(".").map { runCatching { Base64.getUrlDecoder().decode(padBase64Url(it)) }.getOrNull() }
        if (parts.size != 3 || parts.any { it == null }) {
            throw CredentialDecryptException("Credential decrypt failed: invalid ciphertext format")
        }
        val iv = parts[0]!!; val tag = parts[1]!!; val ct = parts[2]!!
        if (iv.size != IV_BYTES || tag.size != TAG_BYTES) {
            throw CredentialDecryptException("Credential decrypt failed: invalid IV/authTag length")
        }
        return aesGcm(iv, tag, ct, key)
    }

    /**
     * JCE 的 GCM 解密约定 tag 附在密文尾部（doFinal(ct||tag)，tLen 由 GCMParameterSpec
     * 声明）——官方密文格式 tag/ct 分段存储，解密前须拼回。注意 javax.crypto.Cipher
     * 没有 setAuthTag（那是 node/BouncyCastle 语义），拆开传会在运行期报 Tag mismatch
     * （初版实踩，2026-09-21 对拍定位）。
     */
    private fun aesGcm(iv: ByteArray, tag: ByteArray, ct: ByteArray, key: ByteArray): String {
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BYTES * 8, iv))
            val plain = cipher.doFinal(ct + tag)
            String(plain, Charsets.UTF_8)
        } catch (e: Exception) {
            throw CredentialDecryptException("Credential decrypt failed: key mismatch or corrupted ciphertext", e)
        }
    }

    /** base64url 补位（官方格式无 padding，Java 解码需要） */
    private fun padBase64Url(s: String): String = s + "=".repeat((4 - s.length % 4) % 4)

    private fun sha256(input: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(input)

    private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }
}

/**
 * Windows 凭据管理器读取（@napi-rs/keyring 的 windows 后端同款语义）：
 * - 条目 target = `{user}.{service}`（cmdkey /list 实测形态），类型=普通（generic）
 * - CredentialBlob = 密码字符串的 UTF-16LE 字节（实测 43 字符 → 86 字节）
 * - PowerShell P/Invoke CredReadW，Add-Type 首次编译 ~1s 后系统缓存；进程内每
 *   (service,user) 至多一次（CredentialCipher 层还有正/负缓存）
 * - 密钥不落日志：子进程只回传 base64(blob)，在内存中解码
 */
internal object WindowsCredentialManagerReader : CredentialCipher.OsKeyringReader {

    private const val TIMEOUT_MILLIS = 15_000L

    override fun read(service: String, user: String): String? {
        if (!System.getProperty("os.name").lowercase().contains("win")) return null
        val target = "$user.$service"
        // 类名与方法名不得同名（C# 会当作构造函数冲突，Add-Type 编译失败）
        val script = """
            ${'$'}t = '$target'
            ${'$'}sig = @"
        using System;using System.Runtime.InteropServices;
        public class ZCodeCredReader {
          [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
          static extern bool CredReadNative(string target, int type, int flags, out IntPtr credPtr);
          [DllImport("advapi32.dll")] static extern void CredFree(IntPtr cred);
          [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
          struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize;
            public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes;
            public string TargetAlias; public string UserName; }
          public static byte[] Read(string target) {
            IntPtr p;
            if (!CredReadNative(target, 1, 0, out p)) throw new Exception("CredRead failed: " + Marshal.GetLastWin32Error());
            var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
            var b = new byte[c.CredentialBlobSize];
            Marshal.Copy(c.CredentialBlob, b, 0, b.Length); CredFree(p); return b;
          }
        }
        "@
            Add-Type -TypeDefinition ${'$'}sig
            [Convert]::ToBase64String([ZCodeCredReader]::Read(${'$'}t))
        """.trimIndent()
        // 多行脚本经 -Command 传参会被 Windows 参数引用规则搅碎换行（实测解析错误），
        // 走 -EncodedCommand（base64 UTF-16LE，单参数零歧义）
        val encoded = Base64.getEncoder().encodeToString(script.toByteArray(Charsets.UTF_16LE))
        val proc = ProcessBuilder("powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded)
            .redirectErrorStream(false)
        val p = try {
            proc.start()
        } catch (_: Exception) {
            return null
        }
        return try {
            if (!p.waitFor(TIMEOUT_MILLIS, java.util.concurrent.TimeUnit.MILLISECONDS)) {
                p.destroyForcibly()
                return null
            }
            if (p.exitValue() != 0) return null
            val stdout = p.inputStream.bufferedReader().readText().trim()
            if (stdout.isEmpty()) return null
            // blob(base64) → 原始字节 → UTF-16LE 密码字符串
            String(java.util.Base64.getDecoder().decode(stdout), Charsets.UTF_16LE)
        } catch (_: Exception) {
            null
        } finally {
            p.destroyForcibly()
        }
    }
}
