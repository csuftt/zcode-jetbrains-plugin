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

/**
 * node 可执行探测结果。code 为机器可读错误码（前端 i18n 键，见 webview app.json
 * envErrors 节）：nodeNotFound/nodeFileNotFound/nodePackageManager/nodeIsScript/
 * nodeTimeout/nodeExecFail；error 为原始中文详情（日志/兜底展示用）。
 */
data class NodeProbe(val found: Boolean, val version: String?, val error: String?, val code: String? = null)

/** zcode.cjs 校验结果：code=cliFileNotFound/cliIsNodeExe/cliNotScript/cliNoSignature/cliFileMissing */
data class CliProbe(val found: Boolean, val error: String?, val code: String? = null)

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
    /** 机器可读错误码（前端 i18n），探测成功 null */
    val code: String? = null,
    /** 错误码插值参数（路径/文件名等）*/
    val arg: String? = null,
) {
    val ok: Boolean get() = found && !versionTooLow
}

data class CliStatus(
    val configured: Boolean,
    val path: String?,
    val found: Boolean,
    val error: String?,
    /** 机器可读错误码（前端 i18n）：cliFileNotFound/cliNotFound */
    val code: String? = null,
    val arg: String? = null,
)

data class CredentialStatus(
    val ok: Boolean,
    /** 生效 provider 的首个 model（展示用）*/
    val model: String?,
    val error: String?,
    /** 实际读取的 config.json 路径（随 dataBaseDir 重定向，展示用）*/
    val path: String? = null,
    /** 机器可读错误码（前端 i18n）：credsMissing/credsInvalid */
    val code: String? = null,
)

/**
 * browser-use 宿主健康（非阻断项：故障只影响 AI 浏览器工具，不影响对话）。
 * code：CODE_CEF_DOWN（JCEF 已起但 CDP 调试端口不可达）/
 * CODE_HANDLER_MISSING（app-server 已起但反向协议 handler 未注册）。
 * null = 探针缺席（app-server 未拉起，属正常未初始化，不评判）。
 */
data class BrowserHostStatus(
    val ok: Boolean,
    val error: String?,
    val code: String? = null,
) {
    companion object {
        /** JCEF 已启动但 CDP 调试端口不可达（宿主浏览器通道废，运行期需重启 IDE）*/
        const val CODE_CEF_DOWN = "browserHostCefDown"
        /** app-server 已启动但宿主 handler 未注册（可经 ensureBrowserExecutor 补注册自愈）*/
        const val CODE_HANDLER_MISSING = "browserHostHandlerMissing"
    }
}

data class EnvStatus(
    val node: NodeStatus,
    val cli: CliStatus,
    val credentials: CredentialStatus,
    val browserHost: BrowserHostStatus? = null,
) {
    /**
     * node + zcode.cjs 就绪即可启动 app-server；browserHost 是建议性检查，不计入。
     * 凭证（issue #4 后）同样不再阻断：oauth 登录的凭证为加密存储，config.json 无
     * 明文 apiKey 时降级裸启（app-server 自身凭证链可接管，实测对话正常），仅经
     * credentials 状态展示警告（用量查询等辅助功能受限）。
     */
    val allOk: Boolean get() = node.ok && cli.found
}

/** getClient 启动前置检查失败：携带完整 EnvStatus 供前端渲染环境提醒条 */
class EnvCheckException(val status: EnvStatus, message: String) : IllegalStateException(message)

/** app-server 启动三参（对齐 ZCodeProtocolClient.start 的参数） */
data class EnvStartParams(
    val nodePath: String,
    val zcodePath: Path,
    /** null = config.json 无明文凭证（oauth 登录），裸启由 app-server 自身凭证链接管 */
    val credentials: ZCodeCredentials?,
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

    /**
     * browser-use 宿主探针（依赖 Service/JCEF 运行态，EnvChecker 自身无法探测）。
     * 生产由 ZCodeServiceImpl 构造时注入；返回 null = 未初始化（不评判）。
     */
    @Volatile
    private var browserHostProbe: (() -> BrowserHostStatus?)? = null

    /** Service 层注入宿主探针；单测可注入桩后再清空 */
    fun setBrowserHostProbe(probe: (() -> BrowserHostStatus?)?) {
        browserHostProbe = probe
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
            browserHost = null,
        )
        // 环境三件套有硬伤时宿主不评判（app-server 未起是正常状态，免噪音）；
        // 探针异常同样按未探测处理（check 不能因宿主探测炸掉）
        val resolved = if (status.allOk) {
            status.copy(browserHost = try {
                browserHostProbe?.invoke()
            } catch (e: Exception) {
                null
            })
        } else status
        cached = resolved
        cachedAt = now
        resolved
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
                code = probe.code ?: "nodeExecFail",
                arg = nodeErrorArg(probe.code, configured, probe.error),
            )
        }
        val fromPath = locateNode()
            ?: return NodeStatus(
                configured = false, path = null, found = false,
                version = null, versionTooLow = false,
                minVersion = MIN_NODE_MAJOR_VERSION,
                error = "未找到 Node.js（已尝试 PATH、常见安装位置与登录 shell），请在设置中配置路径",
                code = "nodeNotFound",
            )
        val probe = probeNode(fromPath)
        if (!probe.found) {
            return NodeStatus(
                configured = false, path = fromPath, found = false,
                version = null, versionTooLow = false,
                minVersion = MIN_NODE_MAJOR_VERSION,
                error = probe.error,
                code = probe.code ?: "nodeExecFail",
                arg = nodeErrorArg(probe.code, fromPath, probe.error),
            )
        }
        return NodeStatus(
            configured = false, path = fromPath, found = true,
            version = probe.version,
            versionTooLow = isVersionTooLow(probe.version),
            minVersion = MIN_NODE_MAJOR_VERSION, error = null,
        )
    }

    /** node 错误码 → 展示参数（路径或文件名；execFail 直接给原始详情）*/
    private fun nodeErrorArg(code: String?, path: String, rawError: String?): String? = when (code) {
        "nodePackageManager", "nodeIsScript" -> java.io.File(path).name
        "nodeExecFail" -> rawError ?: path
        else -> path
    }

    private fun detectCli(configured: String?): CliStatus {
        if (configured != null) {
            val file = Path.of(configured).toFile()
            return if (file.isFile) {
                CliStatus(true, configured, true, null)
            } else {
                CliStatus(true, null, false, "zcode.cjs 不存在：$configured", code = "cliFileNotFound", arg = configured)
            }
        }
        // ZCodeLocator.detect() 按 os 选标准安装路径并校验存在性，异常消息即失败原因
        return try {
            val p = ZCodeLocator.detect()
            CliStatus(false, p.toString(), true, null)
        } catch (e: Exception) {
            CliStatus(false, null, false, e.message ?: "ZCode CLI 未找到", code = "cliNotFound")
        }
    }

    private fun detectCredentials(): CredentialStatus {
        val configPath = Credentials.defaultConfigPath().toString()
        return try {
            val c = Credentials.load()
            CredentialStatus(ok = true, model = c.model, error = null, path = configPath)
        } catch (e: Exception) {
            // Credentials.load：文件缺失抛 IllegalArgumentException（credsMissing），
            // 其余 IllegalStateException（credsInvalid）。均不再阻断启动（见 EnvStatus.allOk）
            CredentialStatus(
                ok = false, model = null, error = e.message ?: "凭证配置读取失败", path = configPath,
                code = if (e is IllegalArgumentException) "credsMissing" else "credsInvalid",
            )
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
        if (!file.isFile) return CliProbe(false, "文件不存在：$path", "cliFileNotFound")
        val name = file.name.lowercase()
        if (name == "node" || name == "node.exe") {
            return CliProbe(false, "这是 Node.js 可执行文件，应填入上方「Node.js 路径」", "cliIsNodeExe")
        }
        if (name == "zcode.cjs") return CliProbe(true, null)
        if (JS_EXTENSIONS.none { name.endsWith(it) }) {
            return CliProbe(false, "不是 zcode.cjs 脚本文件（期望 .cjs/.js/.mjs）：$name", "cliNotScript")
        }
        return if (hasZcodeSignature(file)) CliProbe(true, null)
        else CliProbe(false, "文件内容不含 ZCode 特征，请确认这是 zcode.cjs 脚本", "cliNoSignature")
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
     * 凭证读取失败不抛（loadOrNull → null = 裸启），仅 node/cli 不可用抛异常。
     * @throws EnvCheckException node 或 zcode.cjs 不可用（携带完整 EnvStatus）
     */
    fun resolveForStart(): EnvStartParams {
        val s = check()
        if (!s.allOk) throw EnvCheckException(s, firstProblem(s))
        return EnvStartParams(
            nodePath = s.node.path!!,
            zcodePath = Path.of(s.cli.path!!),
            credentials = Credentials.loadOrNull(),
        )
    }

    /** 首个问题的可读描述（EnvCheckException 消息；凭证降级后不再出现凭证分支） */
    fun firstProblem(s: EnvStatus): String = when {
        !s.node.found -> "Node.js 不可用：${s.node.error ?: "未找到"}（可在设置 → 基础设置 → 环境中配置路径）"
        s.node.versionTooLow -> "Node.js 版本过低（${s.node.version}，需要 v$MIN_NODE_MAJOR_VERSION+），请在设置中配置更高版本的路径"
        !s.cli.found -> "ZCode CLI 不可用：${s.cli.error ?: "未找到"}（可在设置 → 基础设置 → 环境中配置 zcode.cjs 路径）"
        else -> "环境异常"
    }

    // ============ 子进程探测 ============

    private fun probeNode(path: String): NodeProbe {
        val file = Path.of(path).toFile()
        if (!file.exists() || !file.isFile) return NodeProbe(false, null, "文件不存在：$path", "nodeFileNotFound")
        // 文件名预检：明显填错的内容给明确提示（spawn 也能失败，但错误信息难懂）
        precheckNodeName(file.name.lowercase())?.let { (msg, code) -> return NodeProbe(false, null, msg, code) }
        return try {
            val proc = ProcessBuilder(path, "--version")
                .redirectErrorStream(true)
                .start()
            try {
                // node --version 输出仅一行几十字节，waitFor 先行不会撑爆管道缓冲
                if (!proc.waitFor(PROBE_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                    return NodeProbe(false, null, "执行超时：$path --version", "nodeTimeout")
                }
                val output = proc.inputStream.bufferedReader().readText().trim()
                val exit = proc.exitValue()
                if (exit != 0) return NodeProbe(false, null, "退出码 $exit：${output.take(120)}", "nodeExecFail")
                val version = Regex("""v?(\d+)\.\d+\.\d+""").find(output)?.value
                    ?: return NodeProbe(false, null, "无法解析版本输出：${output.take(120)}", "nodeExecFail")
                NodeProbe(true, version, null)
            } finally {
                proc.destroyForcibly()
            }
        } catch (e: Exception) {
            NodeProbe(false, null, "执行失败：${e.message}", "nodeExecFail")
        }
    }

    /** node 主版本号（"v20.11.1" → 20）；解析失败 null */
    fun parseMajorVersion(version: String?): Int? {
        if (version.isNullOrBlank()) return null
        return Regex("""v?(\d+)\.""").find(version)?.groupValues?.get(1)?.toIntOrNull()
    }

    /** node 文件名预检：返回 (消息, 错误码) 即拒绝（包管理器伪装 / JS 脚本填反） */
    private fun precheckNodeName(name: String): Pair<String, String>? = when {
        name in PACKAGE_MANAGER_NAMES -> "这是包管理器（$name），不是 Node.js 可执行文件" to "nodePackageManager"
        JS_EXTENSIONS.any { name.endsWith(it) } ->
            "这是 JS 脚本文件，不是 Node.js 可执行文件（zcode.cjs 应填到下方「ZCode CLI 路径」）" to "nodeIsScript"
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

    /**
     * node 自动定位：PATH → 常见安装位置 → 登录 shell。
     * macOS 上 IDE 从 Dock/Finder 启动时继承 launchd 的精简 PATH（不含 Homebrew/
     * ~/.local/bin/nvm 等），PATH 探测必然落空，必须补候选位置才能免配置。
     */
    private fun locateNode(): String? =
        findNodeOnPath() ?: findNodeInCommonDirs() ?: findNodeViaLoginShell()

    /** PATH 之外的常见安装位置（固定目录 + 版本管理器取最高版本） */
    private fun findNodeInCommonDirs(): String? {
        val home = Path.of(System.getProperty("user.home"))
        val os = System.getProperty("os.name").lowercase()
        val exe = if (os.contains("win")) "node.exe" else "node"

        // 固定常见目录
        val fixed = buildList {
            if (os.contains("mac")) {
                add(home.resolve(".local/bin/$exe"))
                add(Path.of("/opt/homebrew/bin/$exe"))   // Apple Silicon Homebrew
                add(Path.of("/usr/local/bin/$exe"))      // Intel Homebrew / 官方 pkg
            } else if (os.contains("win")) {
                add(Path.of("C:/Program Files/nodejs/$exe"))
                // nvm-windows：版本根目录下目录名即版本号
                home.resolve("AppData/Roaming/nvm").toFile().takeIf { it.isDirectory }
                    ?.listFiles()?.let { files -> files.forEach { add(it.toPath().resolve(exe)) } }
            } else {
                add(home.resolve(".local/bin/$exe"))
                add(Path.of("/usr/local/bin/$exe"))
                add(Path.of("/usr/bin/$exe"))
            }
            add(home.resolve(".asdf/shims/$exe"))  // asdf shim（可执行，代理真实 node）
        }
        // 版本管理器：版本目录名解析主版本取最大（nvm/volta/fnm 的 mac·linux 布局）
        val versioned = listOf(
            home.resolve(".nvm/versions/node") to "bin/$exe",                       // nvm
            home.resolve(".volta/tools/image/node") to "bin/$exe",                  // volta
            home.resolve(".fnm/node-versions") to "installation/bin/$exe",          // fnm(linux)
            home.resolve("Library/Application Support/fnm/node-versions") to "installation/bin/$exe", // fnm(mac)
        ).flatMap { (root, rel) -> versionDirs(root).map { it.resolve(rel) } }

        return (fixed + versioned).firstOrNull { it.toFile().isFile }?.toString()
    }

    /** root 下形如 v20.11.1 / 20.11.1 的版本目录，按主版本降序（最高版本优先） */
    private fun versionDirs(root: Path): List<Path> {
        val dir = root.toFile().takeIf { it.isDirectory } ?: return emptyList()
        return dir.listFiles { f: java.io.File -> f.isDirectory }
            ?.mapNotNull { f ->
                val major = Regex("""^v?(\d+)\.""").find(f.name)?.groupValues?.get(1)?.toIntOrNull()
                major?.let { it to f.toPath() }
            }
            ?.sortedByDescending { it.first }
            ?.map { it.second }
            ?: emptyList()
    }

    /** 登录 shell 兜底：读取用户 shell 配置（.zprofile/.zshrc/.bash_profile 等）解析 node 位置 */
    private fun findNodeViaLoginShell(): String? {
        val os = System.getProperty("os.name").lowercase()
        if (os.contains("win")) return null
        val shells = if (os.contains("mac")) listOf("/bin/zsh", "/bin/bash") else listOf("/bin/bash", "/bin/zsh")
        for (shell in shells) {
            if (!Path.of(shell).toFile().canExecute()) continue
            val output: String? = try {
                // -l 加载 profile；-i 加载 .zshrc/.bashrc（nvm 等常在这里初始化）。
                // 无 tty 的交互 shell 可能挂起，靠超时 + destroyForcibly 兜底
                val proc = ProcessBuilder(shell, "-l", "-i", "-c", "command -v node")
                    .redirectErrorStream(true)
                    .start()
                try {
                    if (!proc.waitFor(PROBE_TIMEOUT_SECONDS, TimeUnit.SECONDS)) null
                    else if (proc.exitValue() != 0) null
                    else proc.inputStream.bufferedReader().readText()
                } finally {
                    proc.destroyForcibly()
                }
            } catch (e: Exception) {
                null
            }
            val hit = output?.lineSequence()
                ?.map { it.trim() }
                ?.firstOrNull { it.isNotEmpty() && Path.of(it).toFile().isFile }
            if (hit != null) return hit
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
            putStringOrNull("code", s.node.code)
            putStringOrNull("arg", s.node.arg)
        })
        put("cli", buildJsonObject {
            put("configured", s.cli.configured)
            putStringOrNull("path", s.cli.path)
            put("found", s.cli.found)
            putStringOrNull("error", s.cli.error)
            putStringOrNull("code", s.cli.code)
            putStringOrNull("arg", s.cli.arg)
        })
        put("credentials", buildJsonObject {
            put("ok", s.credentials.ok)
            putStringOrNull("model", s.credentials.model)
            putStringOrNull("error", s.credentials.error)
            putStringOrNull("path", s.credentials.path)
            putStringOrNull("code", s.credentials.code)
        })
        // 非阻断项（null = 未探测/未初始化，省略节点）
        s.browserHost?.let { bh ->
            put("browserHost", buildJsonObject {
                put("ok", bh.ok)
                putStringOrNull("error", bh.error)
                putStringOrNull("code", bh.code)
            })
        }
        put("allOk", s.allOk)
    }
}
