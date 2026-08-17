package com.zcode.ideaplugin.env

import com.intellij.ide.util.PropertiesComponent
import com.zcode.ideaplugin.protocol.Credentials
import com.zcode.ideaplugin.protocol.ZCodeCredentials
import com.zcode.ideaplugin.protocol.ZCodeLocator
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.nio.file.Path
import java.util.concurrent.TimeUnit

/**
 * 运行环境三件套检测（Node.js / zcode.cjs / 凭证 config.json）
 *
 * 参考 cc-gui NodeDetector/NodePathHandler：
 * - node 与 cli 路径支持用户配置覆盖（PropertiesComponent），未配置走自动探测
 * - node 探测 = 文件存在 + spawn `--version`（zcode.cjs 需 Node ≥ 18）
 * - 检测含子进程 spawn，结果缓存 30s；调用方均在 pooled thread，同步缓存即可
 *   （cc-gui 的 stale-while-revalidate 是防 UI 线程卡顿，此处无此约束）
 * - 用户显式配置的路径无效时不静默回退自动探测（否则"改错路径"不报错难排查）
 */

/** node 可执行探测结果 */
data class NodeProbe(val found: Boolean, val version: String?, val error: String?)

/** zcode.cjs 路径校验结果 */
data class CliProbe(val found: Boolean, val error: String?)

data class NodeStatus(
    val configured: Boolean,
    /** 实际生效的路径（配置值或 PATH 探测值；未找到 null）*/
    val path: String?,
    val found: Boolean,
    /** 形如 "v20.11.1"，探测成功才有 */
    val version: String?,
    val versionTooLow: Boolean,
    val minVersion: Int,
    val error: String?,
) {
    val ok: Boolean get() = found && !versionTooLow
}

data class CliStatus(
    val configured: Boolean,
    val path: String?,
    val found: Boolean,
    val error: String?,
)

data class CredentialStatus(
    val ok: Boolean,
    /** 生效 provider 的首个 model（展示用）*/
    val model: String?,
    val error: String?,
    /** 实际读取的 config.json 路径（随 dataBaseDir 重定向，展示用）*/
    val path: String? = null,
)

data class EnvStatus(
    val node: NodeStatus,
    val cli: CliStatus,
    val credentials: CredentialStatus,
) {
    val allOk: Boolean get() = node.ok && cli.found && credentials.ok
}

/** getClient 启动前置检查失败：携带完整 EnvStatus 供前端渲染环境提醒条 */
class EnvCheckException(val status: EnvStatus, message: String) : IllegalStateException(message)

/** app-server 启动三参（对齐 ZCodeProtocolClient.start 的参数） */
data class EnvStartParams(
    val nodePath: String,
    val zcodePath: Path,
    val credentials: ZCodeCredentials,
)

object ZCodeEnvChecker {

    const val KEY_NODE_PATH = "zcode.env.nodePath"
    const val KEY_CLI_PATH = "zcode.env.cliPath"
    const val MIN_NODE_MAJOR_VERSION = 18

    private const val PROBE_TIMEOUT_SECONDS = 5L
    private const val CACHE_TTL_MILLIS = 30_000L

    /** JS 脚本扩展名（zcode.cjs 的合法形态；自定义 wrapper 也是其一） */
    private val JS_EXTENSIONS = listOf(".cjs", ".js", ".mjs")

    /**
     * 常见包管理器文件名：它们也有 --version 且输出版本号（如 npm 10.x），
     * spawn 校验无法与 node 区分——填错后启动才炸，需按文件名前置拦截
     */
    private val PACKAGE_MANAGER_NAMES = setOf(
        "npm", "npm.cmd", "npm.exe", "npx", "npx.cmd", "npx.exe",
        "pnpm", "pnpm.cmd", "pnpm.exe", "yarn", "yarn.cmd", "yarn.exe",
        "corepack", "corepack.cmd", "corepack.exe",
    )

    /** 存储抽象：生产走 Application 级 PropertiesComponent，单测注入内存实现 */
    interface EnvStore {
        fun get(key: String): String?
        fun set(key: String, value: String?)
    }

    private val ideStore = object : EnvStore {
        override fun get(key: String): String? = PropertiesComponent.getInstance().getValue(key)
        override fun set(key: String, value: String?) {
            val pc = PropertiesComponent.getInstance()
            if (value == null) pc.unsetValue(key) else pc.setValue(key, value)
        }
    }

    @Volatile
    private var store: EnvStore = ideStore

    /** 单测注入；生产不需要调用 */
    fun setStoreForTest(s: EnvStore) {
        store = s
        invalidate()
    }

    @Volatile
    private var cached: EnvStatus? = null
    @Volatile
    private var cachedAt = 0L
    private val cacheLock = Any()

    // ============ 读写配置 ============

    fun configuredNodePath(): String? = store.get(KEY_NODE_PATH)?.trim()?.ifEmpty { null }
    fun configuredCliPath(): String? = store.get(KEY_CLI_PATH)?.trim()?.ifEmpty { null }

    fun saveNodePath(path: String) = store.set(KEY_NODE_PATH, path.trim())
    fun saveCliPath(path: String) = store.set(KEY_CLI_PATH, path.trim())
    fun clearNodePath() = store.set(KEY_NODE_PATH, null)
    fun clearCliPath() = store.set(KEY_CLI_PATH, null)

    // ============ 检测 ============

    /** 完整检测（30s 缓存）；force 跳过缓存（envSave 后重检用） */
    fun check(force: Boolean = false): EnvStatus = synchronized(cacheLock) {
        val now = System.currentTimeMillis()
        if (!force && cached != null && now - cachedAt < CACHE_TTL_MILLIS) {
            return cached!!
        }
        val status = EnvStatus(
            node = detectNode(configuredNodePath()),
            cli = detectCli(configuredCliPath()),
            credentials = detectCredentials(),
        )
        cached = status
        cachedAt = now
        status
    }

    fun invalidate() = synchronized(cacheLock) {
        cached = null
        cachedAt = 0
    }

    private fun detectNode(configured: String?): NodeStatus {
        if (configured != null) {
            val probe = probeNode(configured)
            if (probe.found) {
                return NodeStatus(
                    configured = true, path = configured, found = true,
                    version = probe.version,
                    versionTooLow = isVersionTooLow(probe.version),
                    minVersion = MIN_NODE_MAJOR_VERSION, error = null,
                )
            }
            return NodeStatus(
                configured = true, path = null, found = false,
                version = null, versionTooLow = false,
                minVersion = MIN_NODE_MAJOR_VERSION,
                error = probe.error ?: "配置的 Node.js 路径无效",
            )
        }
        val fromPath = findNodeOnPath()
            ?: return NodeStatus(
                configured = false, path = null, found = false,
                version = null, versionTooLow = false,
                minVersion = MIN_NODE_MAJOR_VERSION,
                error = "未在系统 PATH 中找到 Node.js，请在设置中配置路径",
            )
        val probe = probeNode(fromPath)
        if (!probe.found) {
            return NodeStatus(
                configured = false, path = fromPath, found = false,
                version = null, versionTooLow = false,
                minVersion = MIN_NODE_MAJOR_VERSION,
                error = probe.error,
            )
        }
        return NodeStatus(
            configured = false, path = fromPath, found = true,
            version = probe.version,
            versionTooLow = isVersionTooLow(probe.version),
            minVersion = MIN_NODE_MAJOR_VERSION, error = null,
        )
    }

    private fun detectCli(configured: String?): CliStatus {
        if (configured != null) {
            val file = Path.of(configured).toFile()
            return if (file.isFile) {
                CliStatus(true, configured, true, null)
            } else {
                CliStatus(true, null, false, "zcode.cjs 不存在：$configured")
            }
        }
        // ZCodeLocator.detect() 按 os 选标准安装路径并校验存在性，异常消息即失败原因
        return try {
            val p = ZCodeLocator.detect()
            CliStatus(false, p.toString(), true, null)
        } catch (e: Exception) {
            CliStatus(false, null, false, e.message ?: "ZCode CLI 未找到")
        }
    }

    private fun detectCredentials(): CredentialStatus {
        val configPath = Credentials.defaultConfigPath().toString()
        return try {
            val c = Credentials.load()
            CredentialStatus(ok = true, model = c.model, error = null, path = configPath)
        } catch (e: Exception) {
            CredentialStatus(ok = false, model = null, error = e.message ?: "凭证配置读取失败", path = configPath)
        }
    }

    /**
     * 验证指定 node 路径（envSave 保存前调用）：
     * 文件名前置拦截（防填反/包管理器）+ 文件存在 + `--version` 可执行且可解析。
     */
    fun verifyNodePath(path: String): NodeProbe = probeNode(path)

    /**
     * 验证指定 cli 路径（envSave 保存前调用）。
     *
     * 语义校验（防"文件存在但不是所需文件"）：
     * - node 可执行文件 → 提示填反了框
     * - 标准 zcode.cjs 文件名 → 信任放行
     * - 非脚本扩展名 → 拒绝
     * - 其他 JS 文件 → 读文件头找 zcode 特征（bundle 必含 CLI 名），找不到拒绝
     */
    fun verifyCliPath(path: String): CliProbe {
        val file = Path.of(path).toFile()
        if (!file.isFile) return CliProbe(false, "文件不存在：$path")
        val name = file.name.lowercase()
        if (name == "node" || name == "node.exe") {
            return CliProbe(false, "这是 Node.js 可执行文件，应填入上方「Node.js 路径」")
        }
        if (name == "zcode.cjs") return CliProbe(true, null)
        if (JS_EXTENSIONS.none { name.endsWith(it) }) {
            return CliProbe(false, "不是 zcode.cjs 脚本文件（期望 .cjs/.js/.mjs）：$name")
        }
        return if (hasZcodeSignature(file)) CliProbe(true, null)
        else CliProbe(false, "文件内容不含 ZCode 特征，请确认这是 zcode.cjs 脚本")
    }

    /** 文件前 512KB 是否含 "zcode"（忽略大小写）；单字节读取纯 ASCII 子串搜索，不受编码影响 */
    private fun hasZcodeSignature(file: java.io.File): Boolean = try {
        file.inputStream().use { ins ->
            val bytes = ins.readNBytes(512 * 1024)
            String(bytes, Charsets.ISO_8859_1).lowercase().contains("zcode")
        }
    } catch (e: Exception) {
        false
    }

    // ============ 启动参数解析 ============

    /**
     * app-server 启动三参（配置优先 → 自动探测）。
     * @throws EnvCheckException 任一依赖不可用（携带完整 EnvStatus）
     */
    fun resolveForStart(): EnvStartParams {
        val s = check()
        if (!s.allOk) throw EnvCheckException(s, firstProblem(s))
        return EnvStartParams(
            nodePath = s.node.path!!,
            zcodePath = Path.of(s.cli.path!!),
            credentials = Credentials.load(),
        )
    }

    /** 首个问题的可读描述（EnvCheckException 消息） */
    fun firstProblem(s: EnvStatus): String = when {
        !s.node.found -> "Node.js 不可用：${s.node.error ?: "未找到"}（可在设置 → 基础设置 → 环境中配置路径）"
        s.node.versionTooLow -> "Node.js 版本过低（${s.node.version}，需要 v$MIN_NODE_MAJOR_VERSION+），请在设置中配置更高版本的路径"
        !s.cli.found -> "ZCode CLI 不可用：${s.cli.error ?: "未找到"}（可在设置 → 基础设置 → 环境中配置 zcode.cjs 路径）"
        !s.credentials.ok -> "凭证不可用：${s.credentials.error}"
        else -> "环境异常"
    }

    // ============ 子进程探测 ============

    private fun probeNode(path: String): NodeProbe {
        val file = Path.of(path).toFile()
        if (!file.exists() || !file.isFile) return NodeProbe(false, null, "文件不存在：$path")
        // 文件名预检：明显填错的内容给明确提示（spawn 也能失败，但错误信息难懂）
        precheckNodeName(file.name.lowercase())?.let { return NodeProbe(false, null, it) }
        return try {
            val proc = ProcessBuilder(path, "--version")
                .redirectErrorStream(true)
                .start()
            try {
                // node --version 输出仅一行几十字节，waitFor 先行不会撑爆管道缓冲
                if (!proc.waitFor(PROBE_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                    return NodeProbe(false, null, "执行超时：$path --version")
                }
                val output = proc.inputStream.bufferedReader().readText().trim()
                val exit = proc.exitValue()
                if (exit != 0) return NodeProbe(false, null, "退出码 $exit：${output.take(120)}")
                val version = Regex("""v?(\d+)\.\d+\.\d+""").find(output)?.value
                    ?: return NodeProbe(false, null, "无法解析版本输出：${output.take(120)}")
                NodeProbe(true, version, null)
            } finally {
                proc.destroyForcibly()
            }
        } catch (e: Exception) {
            NodeProbe(false, null, "执行失败：${e.message}")
        }
    }

    /** node 主版本号（"v20.11.1" → 20）；解析失败 null */
    fun parseMajorVersion(version: String?): Int? {
        if (version.isNullOrBlank()) return null
        return Regex("""v?(\d+)\.""").find(version)?.groupValues?.get(1)?.toIntOrNull()
    }

    /** node 文件名预检：返回非 null 即拒绝（包管理器伪装 / JS 脚本填反） */
    private fun precheckNodeName(name: String): String? = when {
        name in PACKAGE_MANAGER_NAMES -> "这是包管理器（$name），不是 Node.js 可执行文件"
        JS_EXTENSIONS.any { name.endsWith(it) } ->
            "这是 JS 脚本文件，不是 Node.js 可执行文件（zcode.cjs 应填到下方「ZCode CLI 路径」）"
        else -> null
    }

    private fun isVersionTooLow(version: String?): Boolean {
        val major = parseMajorVersion(version) ?: return false
        return major in 1 until MIN_NODE_MAJOR_VERSION
    }

    /** 从系统 PATH 找 node（ZCodeProtocolClient.findNode 的非抛异常版） */
    private fun findNodeOnPath(): String? {
        val os = System.getProperty("os.name").lowercase()
        val names = if (os.contains("win")) listOf("node.exe", "node") else listOf("node")
        val pathEnv = System.getenv("PATH") ?: return null
        val sep = if (os.contains("win")) ";" else ":"
        for (name in names) {
            val hit = pathEnv.split(sep)
                .map { Path.of(it).resolve(name) }
                .firstOrNull { it.toFile().exists() }
            if (hit != null) return hit.toString()
        }
        return null
    }

    // ============ 前端 JSON 契约 ============

    /** null 值省略（本版本 kotlinx.serialization 无 putOrNull） */
    private fun kotlinx.serialization.json.JsonObjectBuilder.putStringOrNull(key: String, value: String?) {
        if (value != null) put(key, value)
    }

    /** EnvStatus → 前端 envStatus 消息体（camelCase 字段对齐 webview types/messages.ts） */
    fun statusJson(s: EnvStatus): JsonObject = buildJsonObject {
        put("node", buildJsonObject {
            put("configured", s.node.configured)
            putStringOrNull("path", s.node.path)
            put("found", s.node.found)
            putStringOrNull("version", s.node.version)
            put("versionTooLow", s.node.versionTooLow)
            put("minVersion", s.node.minVersion)
            putStringOrNull("error", s.node.error)
        })
        put("cli", buildJsonObject {
            put("configured", s.cli.configured)
            putStringOrNull("path", s.cli.path)
            put("found", s.cli.found)
            putStringOrNull("error", s.cli.error)
        })
        put("credentials", buildJsonObject {
            put("ok", s.credentials.ok)
            putStringOrNull("model", s.credentials.model)
            putStringOrNull("error", s.credentials.error)
            putStringOrNull("path", s.credentials.path)
        })
        put("allOk", s.allOk)
    }
}
