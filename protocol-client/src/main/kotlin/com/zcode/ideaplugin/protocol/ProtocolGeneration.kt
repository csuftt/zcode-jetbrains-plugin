package com.zcode.ideaplugin.protocol

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.util.concurrent.ConcurrentHashMap
import kotlin.io.path.readText
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * CLI 协议代际（2026-09-17 换代适配定稿，方案全文见
 * docs/internal/design-research/新CLI版本判别与双代适配-2026-09-17.md）：
 *
 * - OLD：老版 CLI——config.json 渠道 + runtimeModel 逐请求注册（插件现状链路）
 * - NEW：灰度 3.12.3+——strict schema（runtimeModel 移除，setModel/send 走模型引用）+
 *   providerRegistry（个人渠道源 = v2/provider_config.json，官方渠道全 SSO 插件不可达）
 *
 * 两代 --version 同号（0.16.5），不能用版本号判；主判据 = zcode.cjs 内容标记
 * （插件 spawn 的就是这份文件，协议行为完全由它决定）。
 */
enum class ProtocolGeneration {
    OLD, NEW;

    /**
     * 对外机器可读标签（环境检测徽章等 UI 展示）：体系序数而非"新/旧"——
     * v1 = 内置渠道体系（config.json），v2 = 供应商注册表体系（provider_config.json
     * 自定义供应商 + zhipu-account 账号渠道）。
     */
    val label: String get() = if (this == NEW) "v2" else "v1"
}

object ProtocolGenerations {

    /** 新版架构标记串：provider_config 个人渠道解析链的 env 变量名（zcode.cjs 实挖） */
    private val NEW_MARKER = "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE".toByteArray(Charsets.US_ASCII)

    /** mcpServers 条目新键标记：zcodeProtocolMcpServerSchema 的 alwaysLoad 字段名。
     *  两键（scope/alwaysLoad）2026-10-19 sync（≈3.16 线）才进 schema——见 [probeMcpServerKeys] */
    private val MCP_KEYS_MARKER = "alwaysLoad".toByteArray(Charsets.US_ASCII)

    /** zcode.cjs → 代际，按 (mtime, size) 缓存；CLI 升级/回滚换文件自动失效重判 */
    private val cache = ConcurrentHashMap<Path, Pair<Pair<Long, Long>, ProtocolGeneration>>()

    /** zcode.cjs → mcp 两键有无，同 [cache] 的 (mtime, size) 缓存口径 */
    private val mcpKeysCache = ConcurrentHashMap<Path, Pair<Pair<Long, Long>, Boolean>>()

    fun detect(zcodePath: Path, home: String = System.getProperty("user.home") ?: "."): ProtocolGeneration {
        try {
            if (Files.isRegularFile(zcodePath)) {
                val attrs = Files.readAttributes(zcodePath, java.nio.file.attribute.BasicFileAttributes::class.java)
                val key = attrs.lastModifiedTime().toMillis() to attrs.size()
                cache[zcodePath]?.let { (k, g) -> if (k == key) return g }
                val gen = if (containsBytes(zcodePath, NEW_MARKER)) ProtocolGeneration.NEW else ProtocolGeneration.OLD
                cache[zcodePath] = key to gen
                return gen
            }
        } catch (_: Exception) {
            // 读不了 .cjs（探测路径异常等）落入配置文件兜底
        }
        return detectByConfig(home)
    }

    /**
     * 当代 cjs 的 zcodeProtocolMcpServerSchema 是否实含 scope/alwaysLoad 两键（缺陷HO）。
     * NEW 代是 3.12.3+ 的大区间，两键 2026-10-19 sync（≈3.16 线）才进 schema——中间版本
     * 「NEW 标记在、键不在」，按代放行即被 strict schema 拒整条（issue#51：-32602
     * mcpServers.0: Unrecognized keys: "scope", "alwaysLoad"）。故 wire 门控按 cjs
     * 内容探测而非版本号/代际，同 [detect] 的 (mtime, size) 缓存口径。
     *
     * @return true/false = 键的有无；null = cjs 不可读不可判（调用方乐观放行，
     *         由 -32602 自愈兜底，见 ZCodeProtocolClient.callWithMcpKeysHeal）
     */
    fun probeMcpServerKeys(zcodePath: Path?): Boolean? {
        if (zcodePath == null) return null
        return try {
            if (!Files.isRegularFile(zcodePath)) return null
            val attrs = Files.readAttributes(zcodePath, java.nio.file.attribute.BasicFileAttributes::class.java)
            val key = attrs.lastModifiedTime().toMillis() to attrs.size()
            mcpKeysCache[zcodePath]?.let { (k, v) -> if (k == key) return v }
            val has = containsBytes(zcodePath, MCP_KEYS_MARKER)
            mcpKeysCache[zcodePath] = key to has
            has
        } catch (_: Exception) {
            null
        }
    }

    /** cjs 流式搜标记（11MB 文件按 64K 窗口滑动，防标记跨块） */
    private fun containsBytes(path: Path, marker: ByteArray): Boolean {
        Files.newByteChannel(path, StandardOpenOption.READ).use { ch ->
            val win = Math.max(marker.size * 2, 64 * 1024)
            val buf = java.nio.ByteBuffer.allocate(win + marker.size)
            while (ch.read(buf) != -1) {
                buf.flip()
                if (indexOf(buf, marker)) return true
                // 留尾部（标记可能跨读块），其余丢弃
                val keep = Math.min(buf.limit(), marker.size - 1)
                val tail = ByteArray(keep)
                System.arraycopy(buf.array(), buf.limit() - keep, tail, 0, keep)
                buf.clear()
                buf.put(tail)
            }
        }
        return false
    }

    private fun indexOf(buf: java.nio.ByteBuffer, marker: ByteArray): Boolean {
        val limit = buf.limit() - marker.size
        outer@ for (i in 0..limit) {
            for (j in marker.indices) {
                if (buf.get(i + j) != marker[j]) continue@outer
            }
            return true
        }
        return false
    }

    /**
     * 配置文件兜底判代（zcode.cjs 不可读时）：
     * 1. setting.json 键形态——`providerFamilyConnectionSelections` 在 = NEW（老客户端不写该键），
     *    `modelProviderFamilySelectedKeys` 在 = OLD。反映"最后实际运行的客户端"（回滚即翻回）。
     * 2. 键形态不可判（缺失/损坏）→ provider_config.json 存在 = NEW（新版启动即建空模板，
     *    老版永不生成；回滚残留是已知假阳性，故仅作最后兜底）。
     */
    internal fun detectByConfig(home: String): ProtocolGeneration {
        val setting = Path.of(home, ".zcode", "v2", "setting.json")
        try {
            if (Files.isRegularFile(setting)) {
                val root = Json.parseToJsonElement(setting.readText()).jsonObject
                if (root.containsKey("providerFamilyConnectionSelections")) return ProtocolGeneration.NEW
                if (root.containsKey("modelProviderFamilySelectedKeys")) return ProtocolGeneration.OLD
            }
        } catch (_: Exception) {
            // 写一半的瞬间等，落入存在性兜底
        }
        return if (Files.exists(Path.of(home, ".zcode", "v2", "provider_config.json"))) {
            ProtocolGeneration.NEW
        } else {
            ProtocolGeneration.OLD
        }
    }
}

/**
 * 内置模型目录（zcode-builtin.json）只读解析。
 *
 * 新版 setModel 的 options.reasoningLevel 对有 reasoning 定义的模型必填（缺了报
 * "Reasoning level is required"），取值必须在该模型的合法值集合内（带了不支持的值报
 * "Reasoning effort ... is not supported"）。权威源 = 目录 modelRules 的 modelMatch
 * 正则链（按序命中、后者覆盖前者；泛化 `.*` 规则恒兜底，故任意模型都有值集）。
 *
 * 目录候选（按序取首个存在）：v2/runtime 缓存（客户端定期刷新，最新）→ 安装目录
 * resources/config/provider → AppData/config/provider（缺陷BT 兜底拷贝）。全部
 * fail-soft：读不到返回 null（调用方省略 reasoningLevel，由服务端裁决）。
 */
object BuiltinModelCatalog {

    private val json = Json { ignoreUnknownKeys = true }

    /** 目录文件 → 解析结果，按 (path, mtime+size) 缓存。size 入键：NTFS 目录项时间戳
     *  惰性更新，快速连续重写（测试/客户端刷新）可能 mtime 相同，仅 mtime 会读到陈旧规则 */
    private val cache = ConcurrentHashMap<Path, Pair<Pair<Long, Long>, List<Rule>>>()

    private class Rule(
        val match: Regex,
        val reasoningValues: List<String>?,
        val maxOutputTokens: Long?,
        val contextWindow: Long?,
        val supportsImage: Boolean?,
        val supportsVideo: Boolean?,
        val supportsPdf: Boolean?,
    )

    /** 单模型能力（modelRules 正则链合并结果；null = 链上无规则声明该键） */
    class ModelCaps(
        val contextWindow: Long?,
        val supportsImage: Boolean?,
        val supportsVideo: Boolean?,
        val supportsPdf: Boolean?,
    )

    fun defaultReasoningLevel(modelId: String, zcodePath: Path?, home: String = System.getProperty("user.home") ?: "."): String? {
        val values = reasoningValues(modelId, zcodePath, home) ?: return null
        // 默认档对齐插件思考档默认（max）：max > high > enabled > 其余首值
        return values.firstOrNull { it == "max" }
            ?: values.firstOrNull { it == "high" }
            ?: values.firstOrNull { it == "enabled" }
            ?: values.first()
    }

    /** modelId 的 maxOutputTokens 档位上限（modelRules 正则链合并，后者覆盖前者）；无目录/无命中 null */
    fun maxOutputTokensMax(modelId: String, zcodePath: Path?, home: String = System.getProperty("user.home") ?: "."): Long? {
        val rules = loadRules(zcodePath, home) ?: return null
        var max: Long? = null
        for (r in rules) {
            if (!r.match.matches(modelId)) continue
            r.maxOutputTokens?.let { max = it }
        }
        return max
    }

    /** modelId 的 reasoningLevel 合法值（modelRules 正则链合并，后者覆盖前者）；无目录/无命中 null */
    fun reasoningValues(modelId: String, zcodePath: Path?, home: String = System.getProperty("user.home") ?: "."): List<String>? {
        val rules = loadRules(zcodePath, home) ?: return null
        var values: List<String>? = null
        for (r in rules) {
            // 规则大小写混杂（GLM-5.2 专属规则大写、glm-5 泛化规则小写），匹配一律大小写
            // 不敏感（loadRules 编译时统一 IGNORE_CASE）：服务端即同口径解析——自定义渠道
            // 手填小写 glm-5.2 被按 GLM-5.2 规则集校验（缺陷DJ，敏感匹配会掉泛化规则
            // 拿错级别集，H5 侧直接外显）
            if (!r.match.matches(modelId)) continue
            r.reasoningValues?.let { values = it }
        }
        return values
    }

    /**
     * modelId 的上下文窗口与输入能力位（modelRules properties 正则链合并，后者覆盖前者）。
     * v1 内置渠道兜底迁移写 providerModelRules 的数据源（与 registry 同源同语义）：
     * `.*` 泛化规则恒兜底（GLM 系 200K/1M 档、能力位全 false），具体模型规则逐级覆盖
     * （如 GLM-5.3-Flash → 1M + 图/视频/PDF）。无目录返回 null；键未被任何命中规则声明
     * 保持 null（调用方按 sparse 口径缺省 false）。
     */
    fun modelCaps(modelId: String, zcodePath: Path?, home: String = System.getProperty("user.home") ?: "."): ModelCaps? {
        val rules = loadRules(zcodePath, home) ?: return null
        var caps = ModelCaps(null, null, null, null)
        for (r in rules) {
            if (!r.match.matches(modelId)) continue
            caps = ModelCaps(
                r.contextWindow ?: caps.contextWindow,
                r.supportsImage ?: caps.supportsImage,
                r.supportsVideo ?: caps.supportsVideo,
                r.supportsPdf ?: caps.supportsPdf,
            )
        }
        return caps
    }

    /**
     * 供应商模板的 api 节（type/baseUrl），编辑回填用：provider_config.json 的 rule 带
     * templateId 时 api/baseUrl 由模板 overlay 提供（rule 自身可不落 api 节），模型管理页
     * 展示与编辑弹窗回填需解析到实际生效值。无目录/无该模板 null（调用方回退 rule 自身）。
     */
    fun templateApi(templateId: String, zcodePath: Path?, home: String = System.getProperty("user.home") ?: "."): Pair<String, String>? {
        val file = catalogFile(zcodePath, home) ?: return null
        return try {
            val root = Json.parseToJsonElement(file.readText()).jsonObject
            (root["config"]?.jsonObject?.get("providerConfigRules")?.jsonObject?.get("templateRules")?.jsonArray)
                ?.asSequence()?.mapNotNull { el ->
                    val o = el as? JsonObject ?: return@mapNotNull null
                    if (o["templateId"]?.jsonPrimitive?.contentOrNull != templateId) return@mapNotNull null
                    val api = o["config"]?.jsonObject?.get("api")?.jsonObject ?: return@mapNotNull null
                    val type = api["type"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                    val baseUrl = api["baseUrl"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                    type to baseUrl
                }?.firstOrNull()
        } catch (_: Exception) {
            null
        }
    }

    /** 模板渠道定义（v1 内置渠道兜底迁移用）：建 rule 所需的全部模板侧字段 */
    class TemplateChannel(
        val templateId: String,
        val name: String,
        val accessType: String,
        val apiType: String,
        val baseUrl: String,
        val builtinModelIds: List<String>,
    )

    /**
     * 模板渠道全量定义：name（templateNameMap 中文优先）/access.type/api 节/builtinModelIds。
     * 无目录/模板缺 api 节（不可直接建渠道）返回 null。
     */
    fun templateChannel(templateId: String, zcodePath: Path?, home: String = System.getProperty("user.home") ?: "."): TemplateChannel? {
        val file = catalogFile(zcodePath, home) ?: return null
        return try {
            val root = Json.parseToJsonElement(file.readText()).jsonObject
            (root["config"]?.jsonObject?.get("providerConfigRules")?.jsonObject?.get("templateRules")?.jsonArray)
                ?.asSequence()?.mapNotNull { el ->
                    val o = el as? JsonObject ?: return@mapNotNull null
                    if (o["templateId"]?.jsonPrimitive?.contentOrNull != templateId) return@mapNotNull null
                    val cfg = o["config"]?.jsonObject ?: return@mapNotNull null
                    val api = cfg["api"]?.jsonObject ?: return@mapNotNull null
                    val apiType = api["type"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                    val baseUrl = api["baseUrl"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                    val names = o["templateNameMap"]?.jsonObject
                    val name = (names?.get("zh-CN") ?: names?.get("en-US"))?.jsonPrimitive?.contentOrNull
                        ?: templateId
                    TemplateChannel(
                        templateId = templateId,
                        name = name,
                        accessType = cfg["access"]?.jsonObject?.get("type")?.jsonPrimitive?.contentOrNull ?: "api-key",
                        apiType = apiType,
                        baseUrl = baseUrl,
                        builtinModelIds = cfg["builtinModelIds"]?.jsonArray
                            ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
                            ?.filter { it.isNotBlank() }
                            ?: emptyList(),
                    )
                }?.firstOrNull()
        } catch (_: Exception) {
            null
        }
    }

    /** 账号渠道条目（zcode-builtin.json providerRules 里 access.type=zhipu-account 的定义） */
    class AccountProviderEntry(
        val providerId: String,
        val providerName: String,
        val mode: String,
        val baseUrl: String,
        val builtinModelIds: List<String>,
    )

    /** 账号渠道条目缓存（同 loadRules 的 mtime+size 键；发送路径每次校验会读） */
    private val accountEntryCache = ConcurrentHashMap<Path, Pair<Pair<Long, Long>, List<AccountProviderEntry>>>()

    /**
     * 账号渠道全量定义（2026-09-21 开源源码：registry 里账号渠道的模型权威 = 条目
     * config.builtinModelIds，providerName 即官方 picker 的 label；mode/baseUrl 供激活
     * 判据用——start-plan 系 zcode-plan 网关、off-peak 需服务端票据，均不可激活）。
     * 无目录返回空表。
     */
    fun accountProviderEntries(zcodePath: Path?, home: String = System.getProperty("user.home") ?: "."): List<AccountProviderEntry> {
        val file = catalogFile(zcodePath, home) ?: return emptyList()
        return accountProviderEntriesFromFile(file)
    }

    /** [accountProviderEntries] 的直读文件版（AccountProviderBridge 已定位文件时用） */
    fun accountProviderEntriesFromFile(file: Path): List<AccountProviderEntry> {
        return try {
            val mtime = Files.getLastModifiedTime(file).toMillis()
            val size = Files.size(file)
            accountEntryCache[file]?.let { (k, v) -> if (k.first == mtime && k.second == size) return v }
            val parsed = parseAccountEntries(file)
            accountEntryCache[file] = (mtime to size) to parsed
            parsed
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun parseAccountEntries(file: Path): List<AccountProviderEntry> {
        val root = Json.parseToJsonElement(file.readText()).jsonObject
        return (root["config"]?.jsonObject?.get("providerConfigRules")?.jsonObject?.get("providerRules")?.jsonArray)
            ?.mapNotNull { el ->
                val o = el as? JsonObject ?: return@mapNotNull null
                val cfg = o["config"]?.jsonObject ?: return@mapNotNull null
                if (cfg["access"]?.jsonObject?.get("type")?.jsonPrimitive?.contentOrNull != "zhipu-account") {
                    return@mapNotNull null
                }
                AccountProviderEntry(
                    providerId = o["providerId"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null,
                    providerName = o["providerName"]?.jsonPrimitive?.contentOrNull
                        ?: o["providerId"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null,
                    mode = cfg["access"]?.jsonObject?.get("mode")?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null,
                    baseUrl = cfg["api"]?.jsonObject?.get("baseUrl")?.jsonPrimitive?.contentOrNull ?: "",
                    builtinModelIds = cfg["builtinModelIds"]?.jsonArray
                        ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
                        ?.filter { it.isNotBlank() }
                        ?: emptyList(),
                )
            }?.filter { it.builtinModelIds.isNotEmpty() } ?: emptyList()
    }

    private fun loadRules(zcodePath: Path?, home: String): List<Rule>? {
        val file = catalogFile(zcodePath, home) ?: return null
        try {
            val mtime = Files.getLastModifiedTime(file).toMillis()
            val size = Files.size(file)
            cache[file]?.let { (k, rules) -> if (k.first == mtime && k.second == size) return rules }
            val root = Json.parseToJsonElement(file.readText()).jsonObject
            val rules = (root["config"]?.jsonObject?.get("modelConfigRules")?.jsonObject?.get("modelRules")?.jsonArray
                ?: return null).mapNotNull { el ->
                    val o = el as? JsonObject ?: return@mapNotNull null
                    val match = o["modelMatch"]?.jsonPrimitive?.content?.let { runCatching { Regex(it, RegexOption.IGNORE_CASE) }.getOrNull() }
                        ?: return@mapNotNull null
            val values = o["config"]?.jsonObject?.get("optionSpecs")?.jsonObject
                ?.get("reasoningLevel")?.jsonObject?.get("values")?.jsonArray
                ?.mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.content }
            val maxOut = o["config"]?.jsonObject?.get("optionSpecs")?.jsonObject
                ?.get("maxOutputTokens")?.jsonObject?.get("max")?.jsonPrimitive?.contentOrNull?.toLongOrNull()
            val props = o["config"]?.jsonObject?.get("properties")?.jsonObject
            val input = props?.get("inputFormat")?.jsonObject
            fun inputFlag(key: String) = input?.get(key)?.jsonPrimitive?.contentOrNull?.toBooleanStrictOrNull()
            Rule(
                match,
                values?.takeIf { it.isNotEmpty() },
                maxOut,
                props?.get("contextWindow")?.jsonPrimitive?.contentOrNull?.toLongOrNull(),
                inputFlag("supportsImage"),
                inputFlag("supportsVideo"),
                inputFlag("supportsPdf"),
            )
                }
            cache[file] = (mtime to size) to rules
            return rules
        } catch (_: Exception) {
            return null
        }
    }

    private fun catalogFile(
        zcodePath: Path?,
        home: String,
        localAppData: String? = System.getenv("LOCALAPPDATA"),
    ): Path? {
        // ① v2/runtime 缓存（多 endpoint 目录取 mtime 最新）：数据根跟随 dataBaseDir
        //    重定向（issue #50——重定向用户的 CDN 缓存不在 home，读 home 会落空或命中
        //    迁移前冻结快照）
        try {
            val dataRoot = Credentials.configuredDataBaseDir(home)?.let { Path.of(it) } ?: Path.of(home)
            val runtimeRoot = dataRoot.resolve(".zcode/v2/runtime/provider")
            if (Files.isDirectory(runtimeRoot)) {
                var newest: Path? = null
                var newestMtime = -1L
                Files.walk(runtimeRoot, 6).use { stream ->
                    stream.filter {
                        it.fileName.toString() == "zcode-builtin.json" && Files.isRegularFile(it)
                    }.forEach {
                        val t = runCatching { Files.getLastModifiedTime(it).toMillis() }.getOrDefault(0L)
                        if (t > newestMtime) {
                            newestMtime = t
                            newest = it
                        }
                    }
                }
                if (newestMtime >= 0) newest?.let { return it }
            }
        } catch (_: Exception) {
        }
        // ②+ 安装副本候选（按序取首个存在）：resources/config/provider →
        //    %LOCALAPPDATA%/config/provider（缺陷BT 兜底拷贝；旧版误拼为 home/AppData）→
        //    home/AppData/config/provider（历史误拼位置，个别机器上确有拷贝，兼容保留）
        val installCandidates = listOf(
            runCatching { zcodePath?.resolve("../config/provider/zcode-builtin.json")?.normalize() }.getOrNull(),
            localAppData?.trim()?.takeIf { it.isNotEmpty() }
                ?.let { Path.of(it, "config", "provider", "zcode-builtin.json") },
            Path.of(home, "AppData", "config", "provider", "zcode-builtin.json"),
        )
        return installCandidates.firstOrNull { it != null && Files.isRegularFile(it) }
    }

    /**
     * 定位 zcode-builtin.json 供 [AccountProviderBridge] 组 spawn env 对与 revision
     * 计算。与读侧 [catalogFile] 同一候选序（dataBaseDir 感知的 runtime CDN 缓存 →
     * 安装目录 config/provider → LOCALAPPDATA 兜底 → 历史 home/AppData 兼容）；
     * 找不到返回 null（env 对不注入，CLI 走自解析，账号渠道保持 fail-closed——功能
     * 降级但不致错）。
     *
     * @param localAppData Windows 兜底根（默认取环境变量；测试注入用）
     */
    fun locateBuiltinFile(
        zcodePath: Path?,
        home: String = System.getProperty("user.home") ?: ".",
        localAppData: String? = System.getenv("LOCALAPPDATA"),
    ): Path? = catalogFile(zcodePath, home, localAppData)
}
