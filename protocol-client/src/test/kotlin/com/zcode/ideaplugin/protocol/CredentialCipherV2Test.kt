package com.zcode.ideaplugin.protocol

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path
import java.security.MessageDigest
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlin.io.path.writeText
import kotlin.test.AfterTest
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * CredentialCipher v2（enc:v2，桌面端 3.18.0 / 开源 b95ebaff systemCredentialCipher.ts）单测。
 *
 * 锁定 2026-11-11 缺陷HB 实测的形态与密钥链：
 * - `enc:v2:{os|env}:{指纹24hex}:{iv.tag.ct}`，AES-256-GCM 同 v1，key = 随机 32 字节本体
 * - source=os：key 从 OS 密钥环读（测试注入替身），条目 user = sha256hex(凭证文件路径)，
 *   密码 = 43 字符 base64url（key 本体，无哈希）
 * - source=env：key = sha256(ZCODE_CREDENTIAL_SECRET / _FILE)
 * - 指纹校验：密钥与密文不配套 → 结构化失败（官方 unavailable 语义），不得误当明文
 * - seal 侧同官方 encrypt：[iv, tag, ct] base64url 点连，前缀 `enc:v2:os:<fp>:`
 *
 * 机器相关的真实密钥环链路（cmdkey/CredRead）不在单测覆盖内，以 2026-11-11 本机
 * Python 实证（凭据管理器条目命中、指纹 5/5、access_token 解出 JWT）为定案记录。
 */
class CredentialCipherV2Test {

    @TempDir
    lateinit var tempDir: Path

    private val key = ByteArray(32) { it.toByte() } // 32 字节固定测试密钥
    private val secretB64 = Base64.getUrlEncoder().withoutPadding().encodeToString(key) // 43 字符

    @AfterTest
    fun cleanup() {
        CredentialCipher.osKeyringReaderOverride = null
    }

    // ============ seal（官方 encrypt 同构，测试侧生成向量）============

    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private fun sealV2(value: String, keyBytes: ByteArray, source: String = "os"): String {
        val iv = ByteArray(12) { (it * 7).toByte() }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(keyBytes, "AES"), GCMParameterSpec(128, iv))
        val ct = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        val enc = Base64.getUrlEncoder().withoutPadding()
        val body = listOf(
            enc.encodeToString(iv),
            enc.encodeToString(ct.copyOfRange(ct.size - 16, ct.size)), // authTag（尾 16 字节）
            enc.encodeToString(ct.copyOfRange(0, ct.size - 16)),       // ciphertext 本体
        ).joinToString(".")
        return "enc:v2:$source:${sha256Hex(keyBytes).take(24)}:$body"
    }

    private fun credFile(): Path = tempDir.resolve("credentials.json").also { it.writeText("{}") }

    // ============ os 密钥环路径 ============

    @Test
    fun `v2 os 路径从注入密钥环解密`() {
        val credFile = credFile()
        CredentialCipher.osKeyringReaderOverride = CredentialCipher.OsKeyringReader { service, user ->
            assertEquals(CredentialCipher.OS_KEYRING_SERVICE, service)
            // 条目 user = sha256hex(凭证文件绝对路径)
            assertEquals(sha256Hex(credFile.toAbsolutePath().normalize().toString().toByteArray()), user)
            secretB64
        }
        assertEquals("jwt-token-plain", CredentialCipher.decrypt(sealV2("jwt-token-plain", key), credFile))
    }

    @Test
    fun `空明文也是合法 v2 密文`() {
        val credFile = credFile()
        CredentialCipher.osKeyringReaderOverride = CredentialCipher.OsKeyringReader { _, _ -> secretB64 }
        assertEquals("", CredentialCipher.decrypt(sealV2("", key), credFile))
    }

    @Test
    fun `指纹不匹配抛密钥环不可用`() {
        val credFile = credFile()
        // 密钥环里是另一把钥匙 → 指纹全不命中 → 不得当明文返回
        val otherKey = ByteArray(32) { (it + 1).toByte() }
        CredentialCipher.osKeyringReaderOverride = CredentialCipher.OsKeyringReader { _, _ -> secretB64 }
        val e = assertFailsWith<CredentialCipher.CredentialDecryptException> {
            CredentialCipher.decrypt(sealV2("x", otherKey), credFile)
        }
        assertTrue(e.message.orEmpty().contains("os keyring entry unavailable"))
    }

    @Test
    fun `密钥环条目缺失抛结构化异常`() {
        val credFile = credFile()
        CredentialCipher.osKeyringReaderOverride = CredentialCipher.OsKeyringReader { _, _ -> null }
        val e = assertFailsWith<CredentialCipher.CredentialDecryptException> {
            CredentialCipher.decrypt(sealV2("x", key), credFile)
        }
        assertTrue(e.message.orEmpty().contains("os keyring entry unavailable"))
    }

    @Test
    fun `密钥环密码形态非法按缺失处理`() {
        val credFile = credFile()
        // 非 43 字符 base64url（官方同款校验）→ 换下一候选/缺失
        CredentialCipher.osKeyringReaderOverride = CredentialCipher.OsKeyringReader { _, _ -> "short" }
        assertFailsWith<CredentialCipher.CredentialDecryptException> {
            CredentialCipher.decrypt(sealV2("x", key), credFile)
        }
    }

    // ============ env 受管密钥路径 ============

    @Test
    fun `v2 env 路径用受管密钥解密`() {
        val credFile = credFile()
        val envSecret = "managed-secret-for-test"
        val envKey = MessageDigest.getInstance("SHA-256").digest(envSecret.toByteArray())
        val value = sealV2("hello", envKey, source = "env")
        assertEquals("hello", CredentialCipher.decrypt(value, credFile, mapOf("ZCODE_CREDENTIAL_SECRET" to envSecret)))
    }

    @Test
    fun `v2 env 密钥文件路径解密`() {
        val credFile = credFile()
        val secretFile = tempDir.resolve("credential-secret")
        val envSecret = "managed-secret-from-file-0123456789"
        secretFile.writeText(envSecret)
        val envKey = MessageDigest.getInstance("SHA-256").digest(envSecret.toByteArray())
        assertEquals(
            "hi",
            CredentialCipher.decrypt(
                sealV2("hi", envKey, source = "env"), credFile,
                mapOf("ZCODE_CREDENTIAL_SECRET_FILE" to secretFile.toString()),
            ),
        )
    }

    @Test
    fun `v2 env 密钥缺失抛结构化异常`() {
        val credFile = credFile()
        val value = sealV2("x", key, source = "env")
        val e = assertFailsWith<CredentialCipher.CredentialDecryptException> {
            CredentialCipher.decrypt(value, credFile, emptyMap())
        }
        assertTrue(e.message.orEmpty().contains("v2 env secret unavailable"))
    }

    // ============ 版本路由 ============

    @Test
    fun `未知 enc 版本抛异常`() {
        val credFile = credFile()
        val e = assertFailsWith<CredentialCipher.CredentialDecryptException> {
            CredentialCipher.decrypt("enc:v3:whatever", credFile)
        }
        assertTrue(e.message.orEmpty().contains("unknown enc version"))
    }

    @Test
    fun `v1 在生产路由走 legacy 链不受 v2 影响`() {
        val credFile = credFile()
        // 格式非法 → v1 文案（非 v2 的 os/env unavailable 文案）
        val e = assertFailsWith<CredentialCipher.CredentialDecryptException> {
            CredentialCipher.decrypt("enc:v1:!!!.!!!.!!!", credFile)
        }
        assertTrue(e.message.orEmpty().contains("invalid ciphertext format"))
    }

    @Test
    fun `source 非法或指纹格式非法抛异常`() {
        val credFile = credFile()
        listOf("enc:v2:usb:aaa.bbb.ccc", "enc:v2:os:ZZZZ:aaa.bbb.ccc", "enc:v2:os").forEach { v ->
            assertFailsWith<CredentialCipher.CredentialDecryptException> {
                CredentialCipher.decrypt(v, credFile)
            }
        }
    }

    @Test
    fun `非密文原样返回`() {
        val credFile = credFile()
        assertEquals("sk-plain-key", CredentialCipher.decrypt("sk-plain-key", credFile))
        assertEquals("", CredentialCipher.decrypt("", credFile))
    }
}
