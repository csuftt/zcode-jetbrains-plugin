package com.zcode.ideaplugin.protocol

import kotlinx.serialization.json.*
import java.nio.file.Path
import kotlin.io.path.exists
import kotlin.io.path.readText

/**
 * 从 ~/.zcode/v2/config.json 构造协议 runtimeModel 参数。
 *
 * 背景（2026-08-14 真机实测）：
 * -32031 = app-server 的 restoreWarning——resume 时不带 runtimeModel 且会话待还原模型
 * 不在当前工作区目录，send/compact 会被直接拒绝。**普通 session/setModel 即便切到
 * 有效模型也清不掉该标记**；唯一可靠的清除方式是 send/compact 请求自身携带 runtimeModel
 * （zcode.cjs 应用模型时会置 restoreWarning=void 0）。
 *
 * runtimeModel 携带完整 provider 定义（含 apiKey），服务端先把 provider 注册进
 * workspace 目录再切换模型，从而绕过"可选模型"校验。
 */
object RuntimeModels {

    private val json = Json { ignoreUnknownKeys = true }

    /**
     * zcode-plan 网关渠道判定（体验套餐 builtin:bigmodel-start-plan 等）。
     *
     * 该网关（baseURL 含 zcode-plan，如 https://zcode.z.ai/api/v1/zcode-plan/anthropic）
     * 的模型请求强制携带阿里云滑块人机验证 param（x-aliyun-captcha-verify-param，由宿主
     * 经滑块 UI 获取，zcode.cjs 只读不写），且回合 prepare 阶段向宿主发反向请求
     * interaction/requestProviderRuntimeHeaders 索取（2026-08-28 实测定性）。插件宿主
     * 无法完成滑块验证，此类渠道整体不可用：模型列表过滤 + 切换拒绝——用户在 ZCode
     * 客户端自用体验套餐，插件走个人套餐/ApiKey 渠道，互不干扰。
     */
    fun isCaptchaGatedBaseUrl(baseURL: String): Boolean = baseURL.lowercase().contains("zcode-plan")

    /** 按 providerId 查 config.json 判定（provider 缺失/无 baseURL = 不门控）*/
    fun isCaptchaGatedProvider(providerId: String, configPath: Path = Credentials.defaultConfigPath()): Boolean {
        val pv = readProviders(configPath)?.get(providerId)?.jsonObject ?: return false
        val baseURL = pv["options"]?.jsonObject?.get("baseURL")?.jsonPrimitive?.jsonStringOrNull ?: return false
        return isCaptchaGatedBaseUrl(baseURL)
    }

    /**
     * 取第一个 enabled 的 anthropic provider（与 Credentials.load 同一选取规则，
     * 即 app-server 启动时 ZCODE_MODEL 环境变量的来源），构造其第一个模型的 runtimeModel。
     *
     * @return config 缺失/无 enabled provider/无模型时返回 null（调用方走兜底路径）
     */
    fun defaultRuntimeModel(configPath: Path = Credentials.defaultConfigPath()): JsonObject? {
        val providers = readProviders(configPath) ?: return null
        for ((providerId, providerEl) in providers) {
            val pv = try { providerEl.jsonObject } catch (e: Exception) { continue }
            if (!isEnabledAnthropic(pv)) continue
            val options = pv["options"]?.jsonObject ?: continue
            val baseURL = options["baseURL"]?.jsonPrimitive?.jsonStringOrNull ?: continue
            // 体验套餐(zcode-plan 网关)渠道不作默认（-32031 恢复兜底不落门控渠道）
            if (isCaptchaGatedBaseUrl(baseURL)) continue
            val modelId = pv["models"]?.jsonObject?.keys?.firstOrNull() ?: continue
            return build(providerId, modelId, pv)
        }
        return null
    }

    /**
     * 按 providerId + modelId 构造 runtimeModel（provider 定义取自 config.json）。
     * 结构对应协议 schema：{revision, generatedAt(毫秒), model, provider{providerId,kind,label,
     * source,baseURL,apiKey{source,value},models[]}}
     *
     * @return provider 不存在或无模型时返回 null
     */
    fun buildRuntimeModel(providerId: String, modelId: String, configPath: Path = Credentials.defaultConfigPath()): JsonObject? {
        val pv = readProviders(configPath)?.get(providerId)?.jsonObject ?: return null
        if (pv["models"]?.jsonObject?.keys.isNullOrEmpty()) return null
        return build(providerId, modelId, pv)
    }

    /** config 缺失/解析失败返回 null */
    private fun readProviders(configPath: Path): JsonObject? {
        if (!configPath.exists()) return null
        return try {
            json.parseToJsonElement(configPath.readText()).jsonObject["provider"]?.jsonObject
        } catch (e: Exception) {
            null
        }
    }

    /** enabled 缺省视为启用（config.json 现状：DeepSeek 无 enabled 字段但已启用） */
    private fun isEnabledAnthropic(pv: JsonObject): Boolean {
        val enabled = pv["enabled"]?.jsonPrimitive?.jsonStringOrNull?.toBoolean() ?: true
        return enabled && pv["kind"]?.jsonPrimitive?.jsonStringOrNull == "anthropic"
    }

    private fun build(providerId: String, modelId: String, pv: JsonObject): JsonObject = buildJsonObject {
        put("revision", "0")
        put("generatedAt", System.currentTimeMillis())
        put("model", buildJsonObject {
            put("providerId", providerId)
            put("modelId", modelId)
        })
        put("provider", buildJsonObject {
            put("providerId", providerId)
            put("kind", pv["kind"]?.jsonPrimitive?.jsonStringOrNull ?: "anthropic")
            pv["name"]?.jsonPrimitive?.jsonStringOrNull?.takeIf { it.isNotBlank() }?.let { put("label", it) }
            put("source", pv["source"]?.jsonPrimitive?.jsonStringOrNull ?: "custom")
            val options = pv["options"]?.jsonObject
            options?.get("baseURL")?.jsonPrimitive?.jsonStringOrNull
                ?.takeIf { it.isNotBlank() }
                ?.let { put("baseURL", it) }
            // apiKey 空（oauth 等走凭据存储）时不传该字段——schema 可选，服务端自行解析
            options?.get("apiKey")?.jsonPrimitive?.jsonStringOrNull
                ?.takeIf { it.isNotBlank() }
                ?.let {
                    put("apiKey", buildJsonObject {
                        put("source", "inline")
                        put("value", it)
                    })
                }
            // 该 provider 的全部模型都注册（后续切换同一 provider 的模型不再需要 runtimeModel）。
            // 模型定义必须携带 limit/modalities（缺陷 2026-08-26：只传 modelId 时服务端用残缺模型
            // 覆盖 workspace 里完整定义，custom provider 的 contextWindow 归零 → autocompact
            // preflight-v1 阈值=0 每请求必压缩 + rapid_refill_breaker 报错；客户端切模型即带完整定义）。
            put("models", JsonArray(pv["models"]?.jsonObject?.map { (mid, mv) ->
                buildJsonObject {
                    put("modelId", mid)
                    val modelDef = mv as? JsonObject ?: return@map buildJsonObject { put("modelId", mid) }
                    (modelDef["limit"] as? JsonObject)?.let { limit ->
                        limit["context"]?.jsonPrimitive?.jsonStringOrNull?.toIntOrNull()
                            ?.takeIf { it > 0 }?.let { put("contextWindow", it) }
                        limit["output"]?.jsonPrimitive?.jsonStringOrNull?.toIntOrNull()
                            ?.takeIf { it > 0 }?.let { put("maxOutputTokens", it) }
                    }
                    // modalities.input 的能力位（USt schema 无 modalities 字段，图像/PDF/视频为布尔位）
                    val inputKinds = (modelDef["modalities"] as? JsonObject)?.get("input")
                        ?.let { it as? JsonArray }?.mapNotNull { (it as? JsonPrimitive)?.content } ?: emptyList()
                    if ("image" in inputKinds) put("supportsImages", true)
                    if ("pdf" in inputKinds) put("supportsPdf", true)
                    if ("video" in inputKinds) put("supportsVideo", true)
                    modelDef["name"]?.jsonPrimitive?.jsonStringOrNull
                        ?.takeIf { it.isNotBlank() }?.let { put("label", it) }
                }
            } ?: emptyList()))
        })
    }
}

/**
 * JsonObject 工具：安全取字符串（模块内共用，替代此前 RuntimeModels/ZCodeProtocolClient
 * 各持一份的 file-private contentOrNull）。与 kotlinx 的 contentOrNull 语义差异：字符串
 * 字面量 "null" 也按 null 处理（CLI 偶发回 JSON null 字符串形态）。
 */
internal val JsonPrimitive.jsonStringOrNull: String?
    get() = if (this.isString) this.content else this.content.takeIf { it != "null" }
