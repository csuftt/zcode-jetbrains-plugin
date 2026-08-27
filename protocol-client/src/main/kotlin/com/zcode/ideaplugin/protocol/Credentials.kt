package com.zcode.ideaplugin.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.nio.file.Path
import kotlin.io.path.exists
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText

/**
 * ZCode 凭证读取
 *
 * 规格书「凭证注入」：
 * - 从 ~/.zcode/v2/config.json 读 enabled + kind=anthropic 的 provider
 * - 三件套 env：ZCODE_MODEL / ZCODE_BASE_URL / ANTHROPIC_API_KEY
 * - canonical model id 不加 provider 前缀（直接用 models 的 key）
 * - 显式 env 优先于 config（本类不覆盖已有 env）
 */
data class ZCodeCredentials(
    val model: String,
    val baseURL: String,
    val apiKey: String
) {
    /** 转成环境变量 map（用于注入子进程） */
    fun toEnvMap(): Map<String, String> = mapOf(
        "ZCODE_MODEL" to model,
        "ZCODE_BASE_URL" to baseURL,
        "ANTHROPIC_API_KEY" to apiKey
    )
}

object Credentials {
    private val json = Json { ignoreUnknownKeys = true }

    /**
     * 从 ~/.zcode/v2/config.json 读凭证
     * @throws IllegalStateException 配置缺失或无效（仅展示用；主流程应改用 [loadOrNull] 降级）
     */
    fun load(configPath: Path = defaultConfigPath()): ZCodeCredentials =
        loadOrNull(configPath) ?: throw loadFailure(configPath)

    /**
     * [load] 的非抛出版本：读不到可用凭证返回 null。
     *
     * 凭证读取失败不再阻断插件启动（issue #4）：config.json 无可用凭证时调用方
     * 降级处理（不注入凭证 env、经 EnvStatus 展示指引），而非报错拦死主流程。
     */
    fun loadOrNull(configPath: Path = defaultConfigPath()): ZCodeCredentials? {
        if (!configPath.exists()) return null
        return try {
            val providers = json.parseToJsonElement(configPath.readText()).jsonObject["provider"]?.jsonObject
                ?: return null
            pickCredential(providers)
        } catch (e: Exception) {
            null
        }
    }

    /** 在 provider 表里找首个 enabled + anthropic + baseURL/apiKey/model 均非空白的凭证 */
    private fun pickCredential(providers: JsonObject): ZCodeCredentials? {
        for ((_, provider) in providers) {
            val pv = provider.jsonObject
            // enabled 缺省视为启用（与 RuntimeModels.isEnabledAnthropic 同口径）：config.json
            // 存在无 enabled 字段但实际启用的自定义 provider（如 DeepSeek），若按不启用
            // 跳过会误报"没有找到 enabled 的 anthropic provider"
            val enabled = pv["enabled"]?.jsonPrimitive?.content?.toBoolean() ?: true
            val kind = pv["kind"]?.jsonPrimitive?.content ?: ""
            if (!enabled || kind != "anthropic") continue

            val options = pv["options"]?.jsonObject ?: continue
            // 空白 apiKey（oauth 系 provider 的占位空串）与字段缺失同等对待：
            // 旧逻辑 `?: continue` 只拦 null，空串会穿透成"自检通过但注入空 key"，
            // 反而挡住 app-server 自身凭证链（resolveApiKey 的 env fallback 拿到空值）
            val baseURL = options["baseURL"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() } ?: continue
            val apiKey = options["apiKey"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() } ?: continue

            val modelsObj = pv["models"]?.jsonObject ?: continue
            val model = modelsObj.keys.firstOrNull() ?: continue

            return ZCodeCredentials(model = model, baseURL = baseURL, apiKey = apiKey)
        }
        return null
    }

    /** [load] 失败异常：文件缺失保留 credsMissing 语义（IllegalArgumentException），其余 credsInvalid */
    private fun loadFailure(configPath: Path): RuntimeException = if (!configPath.exists()) {
        IllegalArgumentException("ZCode 配置文件不存在：$configPath（请用 ZCode 客户端登录，或升级客户端到最新版后重新登录）")
    } else {
        IllegalStateException("config.json 没有找到可用的凭证（请在 ZCode 客户端重新登录，或添加 API Key 型模型）")
    }

    /**
     * 默认配置路径：~/.zcode/v2/config.json。
     *
     * ZCode 客户端支持配置数据目录（setting.json 的 dataBaseDir）：配置后凭证等 v2
     * 数据只在新位置演进（GUI 写入流整体切换，旧位置冻结为拷贝快照），插件读取须
     * 跟随最新指向。实测入口 setting.json 恒在 user home 不随迁移（两次迁移验证），
     * 故从它探测总能拿到当前 dataBaseDir；新位置文件缺失（迁移中途/异常）回退
     * 旧位置，保证探测失败不误伤默认场景。
     */
    fun defaultConfigPath(): Path = configPathFor(System.getProperty("user.home"))

    /**
     * ZCode 用户级数据根（dataBaseDir 感知）：`~/.zcode` 或 `<dataBaseDir>/.zcode`。
     * agents/ 等顶层资源目录的父路径，与 zcode.cjs 的 storageRoot 同语义。
     */
    fun storageRoot(): Path {
        val home = System.getProperty("user.home") ?: return Path.of(".zcode")
        val dir = readDataBaseDir(home)
        return if (dir != null) Path.of(dir, ".zcode") else Path.of(home, ".zcode")
    }

    /**
     * 按 providerId + modelId 构造凭证（provider 定义取自 config.json）。
     * 提示词润色等一次性 CLI 调用按前端当前选择模型注入 ZCODE_MODEL 环境用。
     *
     * @return provider 不存在 / baseURL / apiKey 缺失或为空（oauth 等走凭据存储的
     *   provider 无法用 env 注入）时返回 null，调用方回退 [load] 默认凭证
     */
    fun credentialsFor(providerId: String, modelId: String, configPath: Path = defaultConfigPath()): ZCodeCredentials? {
        if (!configPath.exists()) return null
        return try {
            val config = json.parseToJsonElement(configPath.readText()).jsonObject
            val pv = config["provider"]?.jsonObject?.get(providerId)?.jsonObject ?: return null
            val options = pv["options"]?.jsonObject ?: return null
            val baseURL = options["baseURL"]?.jsonPrimitive?.content ?: return null
            val apiKey = options["apiKey"]?.jsonPrimitive?.content ?: return null
            if (baseURL.isBlank() || apiKey.isBlank()) return null
            ZCodeCredentials(model = modelId, baseURL = baseURL, apiKey = apiKey)
        } catch (e: Exception) {
            null
        }
    }

    /** 同 [defaultConfigPath]，home 参数化便于单测（真实 home 无法在测试内替换） */
    internal fun configPathFor(home: String): Path {
        val legacy = Path.of(home, ".zcode", "v2", "config.json")
        val redirected = readDataBaseDir(home)?.let { Path.of(it, ".zcode", "v2", "config.json") }
        return if (redirected?.isRegularFile() == true) redirected else legacy
    }

    /** 读 setting.json 的 dataBaseDir；未配置/文件缺失/解析失败均返回 null（按未配置处理） */
    private fun readDataBaseDir(home: String): String? {
        return try {
            val setting = Path.of(home, ".zcode", "v2", "setting.json")
            if (!setting.isRegularFile()) return null
            val dir = json.parseToJsonElement(setting.readText()).jsonObject["dataBaseDir"]
                ?.jsonPrimitive?.content?.trim()
            dir?.takeIf { it.isNotEmpty() }
        } catch (e: Exception) {
            // setting.json 是 GUI 高频写文件，可能撞上写一半的瞬间；失败即回退旧位置
            null
        }
    }
}

/** 默认的 zcode.cjs 路径（按操作系统探测标准 Electron 安装位置） */
object ZCodeLocator {

    private val GLM_SUFFIX = arrayOf("resources", "glm", "zcode.cjs")

    /**
     * Windows 候选安装路径（按命中概率排序）：
     * - %LOCALAPPDATA%\Programs\ZCode\... — NSIS 单用户安装（默认）
     * - %ProgramFiles%\ZCode\... — NSIS 全局安装（all users，64 位）
     * - %ProgramFiles(x86)%\ZCode\... — 全局安装 32 位兜底
     *
     * Electron app 的 resources/glm/zcode.cjs 路径结构三处一致，仅安装根不同；
     * 用环境变量而非硬编码盘符，系统盘非 C: 也覆盖。
     */
    fun windowsCandidates(): List<Path> {
        val localAppData = System.getenv("LOCALAPPDATA") ?: "C:\\Users\\Public"
        val programFiles = System.getenv("ProgramFiles") ?: "C:\\Program Files"
        val programFilesX86 = System.getenv("ProgramFiles(x86)") ?: "C:\\Program Files (x86)"
        return listOf(
            Path.of(localAppData, "Programs", "ZCode", *GLM_SUFFIX),
            Path.of(programFiles, "ZCode", *GLM_SUFFIX),
            Path.of(programFilesX86, "ZCode", *GLM_SUFFIX),
        )
    }

    /** 标准 Windows 安装路径（向后兼容，返回首个候选） */
    fun windowsDefault(): Path = windowsCandidates().first()

    /** 标准 macOS 安装路径 */
    fun macDefault(): Path = Path.of(
        "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"
    )

    /** 标准 Linux 安装路径 */
    fun linuxDefault(): Path = Path.of(
        "/opt/ZCode/app/resources/glm/zcode.cjs"
    )

    /**
     * 自动按操作系统探测：Windows 遍历全部候选取首个存在，其余系统单路径。
     * 仅做文件存在性检查（[Path.exists]，微秒级），不 spawn 子进程。
     */
    fun detect(): Path {
        val os = System.getProperty("os.name").lowercase()
        return when {
            os.contains("win") -> {
                val hit = windowsCandidates().firstOrNull { it.exists() }
                requireNotNull(hit) {
                    "ZCode CLI 未找到，已检查：${windowsCandidates().joinToString("、")}"
                }
                hit
            }
            os.contains("mac") || os.contains("darwin") -> {
                val p = macDefault()
                require(p.exists()) { "ZCode CLI 未找到：$p（请确认 ZCode 已安装）" }
                p
            }
            else -> {
                val p = linuxDefault()
                require(p.exists()) { "ZCode CLI 未找到：$p（请确认 ZCode 已安装）" }
                p
            }
        }
    }
}
