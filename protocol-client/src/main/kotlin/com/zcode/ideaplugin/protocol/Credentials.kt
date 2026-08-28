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
     *
     * env 注入的 key 跟随客户端激活渠道（[activeBuiltinProviderId]，setting.json
     * 的 selectedKey）——config.json 的 enabled 不代表激活（API Key 渠道与订阅套餐
     * 可同时 enabled=true），若按 JSON 顺序挑首个 enabled 渠道，会出现"按量 key
     * 配套餐模型"的计费错渠道。
     */
    fun loadOrNull(configPath: Path = defaultConfigPath()): ZCodeCredentials? {
        if (!configPath.exists()) return null
        return try {
            val providers = json.parseToJsonElement(configPath.readText()).jsonObject["provider"]?.jsonObject
                ?: return null
            pickCredential(providers, effectiveBuiltinProviderId(configPath))
        } catch (e: Exception) {
            null
        }
    }

    /**
     * 客户端当前激活的内置 provider（ZCode 客户端模型渠道的权威信号）。
     *
     * 激活态不在 config.json 的 enabled（那只表示"已配置可用"，API Key 渠道与订阅
     * 套餐可同时 enabled=true），而在 setting.json：
     * - providerFamilyDomain：当前活跃家族（bigmodel / zai）
     * - modelProviderFamilySelectedKeys：各家族选中的 provider，形如
     *   "preset:builtin:bigmodel"（取末段即 providerId）
     * - modelProviderFamilyModes：家族当前模式（apiKey / 订阅），仅供展示参考
     *
     * @return 激活的 providerId；未登录内置渠道 / setting 缺失 / 结构不符返回 null
     */
    fun activeBuiltinProviderId(configPath: Path = defaultConfigPath()): String? {
        val settingPath = configPath.resolveSibling("setting.json")
        if (!settingPath.exists()) return null
        return try {
            val st = json.parseToJsonElement(settingPath.readText()).jsonObject
            val selected = st["modelProviderFamilySelectedKeys"]?.jsonObject ?: return null
            if (selected.isEmpty()) return null
            // 用 content 与本文件其余读取一致（contentOrNull 与同包两个 file-private
            // 扩展同名冲突）；这些 setting 值均为普通字符串，不存在时 ?. 短路
            val domainRaw = st["providerFamilyDomain"]?.jsonPrimitive?.content
            val domain = domainRaw?.takeIf { dom -> dom.isNotBlank() }
            val rawEntry = domain?.let { selected[it] } ?: selected.values.firstOrNull()
            val raw = rawEntry?.jsonPrimitive?.content?.trim()
            if (raw.isNullOrBlank()) return null
            // selectedKey 形如 "<mode>:<providerId>"（实测 preset:builtin:bigmodel =
            // API Key 模式、coding-plan:builtin:bigmodel-coding-plan = 订阅模式）；
            // providerId 自身含冒号（builtin: 前缀），只能按已知 mode 前缀剥，不能按
            // 冒号切末段
            val providerId = raw.removePrefix("preset:").removePrefix("coding-plan:")
            providerId.takeIf { it.isNotEmpty() }
        } catch (e: Exception) {
            null
        }
    }

/**
 * 生效内置渠道解析结果。
 * providerId=null：无可用内置渠道；viaSelected=true：selectedKey 权威命中，
 * false：兜底链命中（客户端所选渠道凭证不可用，回退 config 首个可用内置）。
 * 设置页据此展示命中方式徽章。
 */
data class BuiltinResolution(val providerId: String?, val viaSelected: Boolean)

/**
 * 展示用的有效内置 provider（selectedKey 权威 + config 兜底）。
 *
 * 兜底链：selectedKey 解析出的 id 在 config provider 表中存在且凭证可用 → 用
 * 它；解析失败/不匹配/指向的渠道凭证已失效（如在客户端选着 API Key 方式但把
 * key 删了）→ 取 config 里首个 enabled 且凭证可用（apiKey 非空或家族 oauth
 * token）的内置 provider；都没有 → null（无内置渠道可展示）。
 */
fun effectiveBuiltinProviderId(configPath: Path = defaultConfigPath()): String? =
    builtinResolution(configPath).providerId

/** [effectiveBuiltinProviderId] 的完整解析结果（含命中方式），见 [BuiltinResolution] */
fun builtinResolution(configPath: Path = defaultConfigPath()): BuiltinResolution {
    if (!configPath.exists()) return BuiltinResolution(null, false)
    return try {
        val providers = json.parseToJsonElement(configPath.readText()).jsonObject["provider"]?.jsonObject
            ?: return BuiltinResolution(null, false)
        val active = activeBuiltinProviderId(configPath)
        if (active != null && providers[active] != null &&
            isBuiltinUsable(active, providers[active]!!.jsonObject, configPath)
        ) {
            return BuiltinResolution(active, true)
        }
        val fallback = providers.keys.firstOrNull { id ->
            id.startsWith("builtin:") && isBuiltinUsable(id, providers[id]!!.jsonObject, configPath)
        }
        BuiltinResolution(fallback, false)
    } catch (e: Exception) {
        BuiltinResolution(null, false)
    }
}

    /** 内置 provider 可用判定：enabled（缺省视为启用）且 apiKey 非空或有家族 oauth token */
    private fun isBuiltinUsable(providerId: String, pv: JsonObject, configPath: Path): Boolean {
        val enabled = pv["enabled"]?.jsonPrimitive?.content?.toBoolean() ?: true
        if (!enabled) return false
        val apiKey = pv["options"]?.jsonObject?.get("apiKey")?.jsonPrimitive?.content
        return !apiKey.isNullOrBlank() || hasFamilyOAuthToken(providerId, configPath)
    }

    /** 单个 provider 节点转凭证：enabled + anthropic + baseURL/apiKey/model 非空白才可用 */
    private fun credentialOf(pv: JsonObject): ZCodeCredentials? {
        // enabled 缺省视为启用（与 RuntimeModels.isEnabledAnthropic 同口径）：config.json
        // 存在无 enabled 字段但实际启用的自定义 provider（如 DeepSeek），若按不启用
        // 跳过会误报"没有找到 enabled 的 anthropic provider"
        val enabled = pv["enabled"]?.jsonPrimitive?.content?.toBoolean() ?: true
        val kind = pv["kind"]?.jsonPrimitive?.content ?: ""
        if (!enabled || kind != "anthropic") return null
        val options = pv["options"]?.jsonObject ?: return null
        // 空白 apiKey（oauth 系 provider 的占位空串）与字段缺失同等对待：
        // 旧逻辑 `?: continue` 只拦 null，空串会穿透成"自检通过但注入空 key"，
        // 反而挡住 app-server 自身凭证链（resolveApiKey 的 env fallback 拿到空值）
        val baseURL = options["baseURL"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() } ?: return null
        val apiKey = options["apiKey"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() } ?: return null
        val model = pv["models"]?.jsonObject?.keys?.firstOrNull() ?: return null
        return ZCodeCredentials(model = model, baseURL = baseURL, apiKey = apiKey)
    }

    /** 在 provider 表里找凭证：优先激活渠道，回退首个 enabled + anthropic 完整凭证 */
    private fun pickCredential(providers: JsonObject, activeProviderId: String? = null): ZCodeCredentials? {
        activeProviderId?.let { id ->
            providers[id]?.let { credentialOf(it.jsonObject) }?.let { return it }
        }
        for ((_, provider) in providers) {
            credentialOf(provider.jsonObject)?.let { return it }
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

    /**
     * 订阅制套餐 provider 的 oauth 凭证兜底判定（模型可用性口径用）。
     *
     * 兜底仅限两家 coding-plan：订阅制的调用期凭证由 app-server 从 credentials.json
     * 的家族 access_token 解析，config.json 无明文 apiKey 依然可用（未来 key 改为
     * 运行时换取不落盘时靠此口径保住模型列表）。API Key 渠道（builtin:bigmodel /
     * builtin:zai）设计上就是手填 key，无 oauth 凭证链，空 key = 未配置，不兜底
     * ——否则列表显示可用而凭据自检报无凭证，自相矛盾（0.2.6 实测反馈）。第三方
     * provider（DeepSeek 等）同样仅凭明文 apiKey 判定。
     *
     * credentials.json 与 config.json 同目录（跟随 dataBaseDir 迁移）。
     */
    fun hasFamilyOAuthToken(providerId: String, configPath: Path = defaultConfigPath()): Boolean {
        val tokenKey = when (providerId) {
            "builtin:bigmodel-coding-plan" -> "oauth:bigmodel:access_token"
            "builtin:zai-coding-plan" -> "oauth:zai:access_token"
            else -> return false
        }
        val credFile = configPath.resolveSibling("credentials.json")
        if (!credFile.exists()) return false
        return try {
            json.parseToJsonElement(credFile.readText()).jsonObject[tokenKey]
                ?.jsonPrimitive?.content?.takeIf { it.isNotBlank() } != null
        } catch (e: Exception) {
            false
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
