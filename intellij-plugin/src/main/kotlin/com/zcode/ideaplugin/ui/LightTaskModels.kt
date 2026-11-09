package com.zcode.ideaplugin.ui

import com.intellij.openapi.diagnostic.Logger
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * generateText 轻任务（润色 / AI 提交信息 / 会话标题重生成）统一的模型解析器。
 *
 * 三个轻任务同走 workspace/generateText、共用润色专用 app-server 进程，模型选取
 * 统一为一条链（此前 AI 提交信息在 resolveModel 里硬挑「账号渠道首模型→启用渠道
 * 首个」，与专用/会话模型完全脱节，自定义渠道用户被打到无余额渠道——issue #48）：
 *
 * ```
 * 轻任务专用模型（行为设置页「轻任务模型」，kv zcode.enhance.config 的 enhanceModel
 *   字段；不要求润色开关开启——模型选择与润色开关解耦）
 * → kv 会话当前模型（zcode.currentModel）
 * → 首个启用渠道的首模型（账号渠道置顶 + provider_config.json 启用渠道）
 * ```
 *
 * 全程 fail-soft：kv 缺失/损坏、渠道清单为空一律返回 null，调用方按「无可用模型」
 * 报错或放弃通道。
 *
 * 不依赖任何 project/panel 实例（唯一外部状态是 Application 级 PropertiesComponent
 * 的 webview kv 存储），ZCodeToolWindowPanel 与 ZCodeCommitMessageAction 双方共用。
 */
object LightTaskModels {

    private val log = Logger.getInstance(LightTaskModels::class.java)

    /** 与 webview/src/utils/enhanceConfig.ts 的 KEY 同源（行为设置页经通用 kvSave 通道落此键） */
    private const val ENHANCE_CONFIG_KEY = "zcode.enhance.config"

    /** 统一选取链（NEW 代 CLI）：专用模型 → 会话当前模型 → 首个启用渠道。 */
    fun resolveNewCli(): Pair<String, String>? =
        pick(dedicatedModel(), currentModelRef(), enabledProviderModels())

    /**
     * 纯选择函数（单测入口）：dedicated 优先，失效依次落到 sessionRef、首个启用渠道。
     * 合法性判据 = (pid, mid) 在 enabled 清单内；全空返回 null。
     */
    fun pick(
        dedicated: Pair<String, String>?,
        sessionRef: Pair<String, String>?,
        enabled: List<Pair<String, List<String>>>,
    ): Pair<String, String>? {
        val contains = { m: Pair<String, String> ->
            enabled.any { it.first == m.first && m.second in it.second }
        }
        dedicated?.takeIf { contains(it) }?.let { return it }
        sessionRef?.takeIf { contains(it) }?.let { return it }
        return enabled.firstOrNull()?.let { (pid, mids) -> mids.firstOrNull()?.let { pid to it } }
    }

    /** 行为设置页「轻任务模型」（kv zcode.enhance.config 的 enhanceModel 字段）；未选/损坏返回 null */
    fun dedicatedModel(): Pair<String, String>? {
        val raw = readKvStore()?.let {
            try {
                Json.parseToJsonElement(it).jsonObject[ENHANCE_CONFIG_KEY]?.jsonPrimitive?.content
            } catch (_: Exception) {
                null
            }
        } ?: return null
        return try {
            val o = Json.parseToJsonElement(raw).jsonObject["enhanceModel"] as? JsonObject ?: return null
            val pid = o["providerId"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() } ?: return null
            val mid = o["modelId"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() } ?: return null
            pid to mid
        } catch (_: Exception) {
            null
        }
    }

    /**
     * v2 模型解析兜底链：kv 当前会话模型 → 首个启用渠道的首模型。透传模型失效
     * （历史专用配置是 v1 形态渠道 id 如 builtin:bigmodel-coding-plan、渠道已删）时
     * 依次回退；全空返回 null（调用方放弃该通道或报无可用模型）。
     */
    fun fallbackModel(): Pair<String, String>? {
        currentModelRef()?.let { (pid, mid) ->
            if (validModel(pid, mid)) return pid to mid
        }
        return enabledProviderModels().firstOrNull()?.let { (pid, mids) ->
            mids.firstOrNull()?.let { pid to it }
        }
    }

    /** (pid, mid) 是否为 v2 启用渠道的已登记模型（generateText/标题生成透传前的校验） */
    fun validModel(pid: String?, mid: String?): Boolean =
        pid != null && mid != null && enabledProviderModels().any { it.first == pid && mid in it.second }

    /** kv 会话当前模型（webview 每次切模型写 zcode.currentModel）；缺失/损坏返回 null */
    fun currentModelRef(): Pair<String, String>? {
        val raw = readKvStore()?.let {
            try {
                Json.parseToJsonElement(it).jsonObject["zcode.currentModel"]?.jsonPrimitive?.content
            } catch (_: Exception) {
                null
            }
        } ?: return null
        return try {
            val o = Json.parseToJsonElement(raw).jsonObject
            val mid = o["modelId"]?.jsonPrimitive?.contentOrNull ?: return null
            val pid = o["providerId"]?.jsonPrimitive?.contentOrNull ?: return null
            pid to mid
        } catch (_: Exception) {
            null
        }
    }

    /**
     * v2 启用渠道的模型清单（providerId to 模型 ids；激活账号渠道（overlay 合并序）置顶，
     * 自定义渠道随后；modelOrder 优先 personalModelIds 兜底；渠道停用整组排除、
     * 模型级 config.enabled:false 逐项排除——与 registry executable 口径对齐）
     */
    fun enabledProviderModels(): List<Pair<String, List<String>>> {
        // 模型级停用集合（PersonalModelConfigRules 的 enabled:false 条目）——与 panel
        // NewCliModelRule.modelEnabled 口径一致，这里只需布尔位不搬整个规则投影
        val disabled = com.zcode.ideaplugin.protocol.PersonalModelConfigRules
            .load(com.zcode.ideaplugin.protocol.Credentials.personalProviderConfigPath())
            .filter { it.enabled == false }
            .map { it.providerId to it.modelId }
            .toSet()
        val enabled = { pid: String, mid: String -> (pid to mid) !in disabled }
        // 账号渠道置顶（订阅套餐是主用渠道，与下拉 accountModelRows 置顶同序）：此前
        // 本清单只读 provider_config.json 规则——渠道无 personal 覆盖规则时账号模型
        // 全部判无效（validModel），generateText/标题透传被误回退；纯账号环境下
        // 首选回退模型也与官方 defaultModelSelection（账号渠道首模型）同向
        val account = accountChannelModels().map { (pid, mids) ->
            pid to mids.filter { enabled(pid, it) }
        }.filter { it.second.isNotEmpty() }
        val self = readProviderRules()
            .filter { it["enabled"]?.jsonPrimitive?.contentOrNull != "false" }
            .mapNotNull { rule ->
                val pid = rule["providerId"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                // account:* 规则是账号渠道的 personal 覆盖，模型集已并入上方账号渠道行
                if (pid.startsWith(com.zcode.ideaplugin.protocol.AccountProviderBridge.ACCOUNT_RULE_PREFIX)) {
                    return@mapNotNull null
                }
                val cfg = rule["config"] as? JsonObject
                val mids = (cfg?.get("modelOrder")?.jsonArray ?: cfg?.get("personalModelIds")?.jsonArray)
                    ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.takeIf { m -> m.isNotBlank() } }
                    ?.distinct() ?: return@mapNotNull null
                pid to mids.filter { enabled(pid, it) }
            }.filter { it.second.isNotEmpty() }
        return account + self
    }

    /**
     * 激活账号渠道的最终模型集（官方 overlay 合并后）：pid to 完整模型序。
     * 渠道行与模型序的唯一共用入口——下拉、设置页、发送守卫、轻任务兜底同源不漂移。
     */
    fun accountChannelModels(): List<Pair<String, List<String>>> {
        val zcodePath = com.zcode.ideaplugin.env.ZCodeEnvChecker.resolveCliPathForOps()
        val overlay = readProviderRules().mapNotNull { rule ->
            val pid = rule["providerId"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            if (!pid.startsWith(com.zcode.ideaplugin.protocol.AccountProviderBridge.ACCOUNT_RULE_PREFIX)) {
                return@mapNotNull null
            }
            pid to rule["config"]?.jsonObject
        }.toMap()
        return com.zcode.ideaplugin.protocol.AccountProviderBridge
            .activatableAccountChannels(zcodePath)
            .map { e -> e.providerId to com.zcode.ideaplugin.protocol.AccountProviderBridge
                .overlayModelIds(overlay[e.providerId], e.builtinModelIds) }
    }

    /** provider_config.json 的 providerRules（用户在客户端建的自定义供应商）；空/损坏返回空表 */
    fun readProviderRules(): List<JsonObject> {
        val path = com.zcode.ideaplugin.protocol.Credentials.personalProviderConfigPath()
        if (!java.nio.file.Files.isRegularFile(path)) return emptyList()
        return try {
            val root = Json.parseToJsonElement(path.toFile().readText()).jsonObject
            val rules = root["config"]?.jsonObject?.get("providerConfigRules")?.jsonObject?.get("providerRules")?.jsonArray
                ?.mapNotNull { it as? JsonObject } ?: emptyList()
            if (rules.isEmpty()) return rules
            // 客户端展示序 = providerOrder（权威，客户端 UI 拖拽写这里）；文件 rule 序只是
            // 追加序。按 order 稳定重排，order 缺失/多余的渠道保持相对次序排尾部
            val orderIdx = root["config"]?.jsonObject?.get("providerOrder")?.jsonArray
                ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }?.withIndex()
                ?.associate { (i, id) -> id to i } ?: return rules
            rules.sortedBy { rule ->
                orderIdx[rule["providerId"]?.jsonPrimitive?.contentOrNull] ?: Int.MAX_VALUE
            }
        } catch (e: Exception) {
            log.warn("Failed to parse provider_config.json: ${e.message}")
            emptyList()
        }
    }

    /** 读取 webview kv JSON map（Application 级 PropertiesComponent），无配置返回 null */
    private fun readKvStore(): String? = try {
        com.intellij.ide.util.PropertiesComponent.getInstance()
            .getValue(ZCodeLanguageService.KEY_WEBVIEW_KV)
    } catch (_: Exception) {
        null
    }
}
