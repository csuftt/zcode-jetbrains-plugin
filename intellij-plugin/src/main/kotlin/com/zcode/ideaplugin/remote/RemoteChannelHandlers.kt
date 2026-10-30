package com.zcode.ideaplugin.remote

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.zcode.ideaplugin.protocol.ZCodeProtocolClient
import com.zcode.ideaplugin.protocol.model.Workspace
import com.zcode.ideaplugin.protocol.relay.ChannelCodec
import com.zcode.ideaplugin.protocol.relay.ChannelCodec.ChValue
import com.zcode.ideaplugin.protocol.relay.RelayClient
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * readSession 响应体积上限（字节）：H5 浏览器解析/渲染上限。
 * 2026-08-25 真机 HAR 实测：9.7MB（messageBytes=9733651，relay 13 分片）的
 * zcode-session.readSession 响应直接压垮 H5（页面刷新）+ relay recovery 重放
 * 死循环（bridge 积压消息随新连接全量重放，H5 崩→重连→再重放）。官方 H5 历史
 * 消息走 v4RowsRange 分页，readSession 只承载最近消息基线——超限从后往前保留
 * 最近消息至预算耗尽，并带 truncated 标记（供桥侧诊断）。
 */
private const val READ_SESSION_BUDGET_BYTES = 512 * 1024

/**
 * rowsRange 响应体积预算（字节）：手机侧 relay 连接（弱网/蜂窝）转发 ~1MB 物理帧即断连
 * ——真机 HAR 实锤 14/14 多分片消息只到 frag0 连接即死（缺陷FS 七轮），readSession 512KB
 * 预算同款病因同款药方。超预算从旧端（尾部）裁行，hasMore 保持 true 由 H5 按需翻页；
 * 单行超预算无条件保留最新一行（H5 至少能渲染最近内容）。
 */
private const val ROWSRANGE_BUDGET_BYTES = 384 * 1024

/** [trimRowsRangeResult] 纯函数：行数组按累计 JSON 字节数从新端保留（rows 新→旧排序），
 *  超预算从尾部（更旧）丢弃并强制 hasMore=true；单行超预算无条件保留。 */
internal fun trimRowsRangeResult(result: JsonObject, budgetBytes: Int = ROWSRANGE_BUDGET_BYTES): JsonObject {
    val rows = result["rows"] as? kotlinx.serialization.json.JsonArray ?: return result
    var used = 0
    val keptRev = mutableListOf<kotlinx.serialization.json.JsonElement>()
    for (i in rows.size - 1 downTo 0) {
        val el = rows[i]
        val sz = el.toString().length
        if (keptRev.isNotEmpty() && used + sz > budgetBytes) break
        keptRev.add(el)
        used += sz
    }
    if (keptRev.size == rows.size) return result
    keptRev.reverse()
    val out = result.toMutableMap()
    out["rows"] = kotlinx.serialization.json.JsonArray(keptRev)
    out["hasMore"] = kotlinx.serialization.json.JsonPrimitive(true)
    return kotlinx.serialization.json.JsonObject(out)
}

/** 僵尸桥判定（后台兜底）：超过该时长无任何 channel 活动的桥视为已关闭 */
private const val STALE_BRIDGE_MS = 10 * 60_000L

/** 裁剪 session/read 响应：messages 超预算时仅保留最近消息。
 * 单条消息本身超预算时无条件保留最新一条（H5 至少能渲染出会话尾巴）。 */
internal fun trimSessionMessages(state: JsonObject, budgetBytes: Int = READ_SESSION_BUDGET_BYTES): JsonObject {
    val messages = state["messages"] as? kotlinx.serialization.json.JsonArray ?: return state
    var used = 0
    val kept = mutableListOf<kotlinx.serialization.json.JsonElement>()
    for (i in messages.size - 1 downTo 0) {
        val el = messages[i]
        val sz = el.toString().length
        if (kept.isNotEmpty() && used + sz > budgetBytes) break
        kept.add(el)
        used += sz
    }
    if (kept.size == messages.size) return state
    kept.reverse()
    val out = state.toMutableMap()
    out["messages"] = kotlinx.serialization.json.JsonArray(kept)
    out["truncated"] = kotlinx.serialization.json.JsonPrimitive(true)
    out["truncatedReason"] = kotlinx.serialization.json.JsonPrimitive("read-session-size-limit")
    out["totalMessages"] = kotlinx.serialization.json.JsonPrimitive(messages.size)
    return JsonObject(out)
}

/**
 * 官方 mode 选项（asar chunk-QSBP2774 Qu 常量）：build/edit/plan/yolo 固定四项
 */
private val REMOTE_MODE_OPTIONS = listOf(
    Triple("build", "Ask before changes", "Ask before each file changes."),
    Triple("edit", "Edit automatically", "Edit selected files or relevant workspace files automatically."),
    Triple("plan", "Plan mode", "Inspect the code and present a plan before editing."),
    Triple("yolo", "Full access", "Edit and run commands with fewer confirmations."),
)

/** 官方 Nh（formatZCodeModelRef）：providerId/modelId，variant 时追加 $variant */
internal fun formatZCodeModelRef(ref: JsonObject): String {
    val providerId = ref["providerId"]?.jsonPrimitive?.contentOrNull ?: ""
    val modelId = ref["modelId"]?.jsonPrimitive?.contentOrNull ?: ""
    val variant = ref["variant"]?.jsonPrimitive?.contentOrNull
    val base = "$providerId/$modelId"
    return if (!variant.isNullOrEmpty()) "$base\$$variant" else base
}

/** 官方 cP（normalizeAvailableZCodeMode）：不在可用 mode 集时回退 build */
internal fun normalizeRemoteMode(current: String?): String =
    if (REMOTE_MODE_OPTIONS.any { it.first == current }) current!! else "build"

/**
 * 官方 BL（zcodeSessionSettingsToZCodeConfigOptions）：workspace settings →
 * configOptions 配置项数组（Model/Mode/[Thought Level]）。H5 输入框模型选择器
 * 依赖此形状——此前 stub 返回 {settings:{}} 导致输入框不渲染（2026-08-25 真机 HAR）。
 */
internal fun buildRemoteConfigOptions(settings: JsonObject): kotlinx.serialization.json.JsonArray {
    val model = settings["model"]?.jsonObject
    val modelItem = buildJsonObject {
        put("id", "model"); put("name", "Model"); put("category", "model"); put("type", "select")
        put("currentValue", model?.get("current")?.jsonObject?.let { formatZCodeModelRef(it) } ?: "")
        put("options", kotlinx.serialization.json.JsonArray(
            model?.get("available")?.jsonArray?.mapNotNull { el ->
                val r = el.jsonObject ?: return@mapNotNull null
                val ref = r["ref"]?.jsonObject ?: return@mapNotNull null
                val reasoning = r["reasoning"]?.jsonObject
                val levels = reasoning?.let { rj ->
                    if (rj["enabled"]?.jsonPrimitive?.content == "true")
                        rj["levels"]?.jsonArray?.mapNotNull { it.jsonObject["value"]?.jsonPrimitive?.contentOrNull } ?: emptyList()
                    else emptyList()
                }
                buildJsonObject {
                    put("value", formatZCodeModelRef(ref))
                    put("name", r["label"]?.jsonPrimitive?.contentOrNull ?: "")
                    r["description"]?.jsonPrimitive?.contentOrNull?.let { put("description", it) }
                    put("modelProviderId", ref["providerId"]?.jsonPrimitive?.contentOrNull ?: "")
                    put("modelProviderName", r["providerLabel"]?.jsonPrimitive?.contentOrNull
                        ?: ref["providerId"]?.jsonPrimitive?.contentOrNull ?: "")
                    if (levels != null) put("modelThoughtLevels", kotlinx.serialization.json.JsonArray(levels.map { kotlinx.serialization.json.JsonPrimitive(it) }))
                    val dl = reasoning?.get("defaultLevel")?.jsonPrimitive?.contentOrNull
                    if (dl != null && levels?.contains(dl) == true) put("modelDefaultThoughtLevel", kotlinx.serialization.json.JsonPrimitive(dl))
                }
            } ?: emptyList(),
        ))
    }
    val modeItem = buildJsonObject {
        put("id", "mode"); put("name", "Mode"); put("category", "mode"); put("type", "select")
        put("currentValue", normalizeRemoteMode(settings["mode"]?.jsonObject?.get("current")?.jsonPrimitive?.contentOrNull))
        put("options", kotlinx.serialization.json.JsonArray(REMOTE_MODE_OPTIONS.map {
            buildJsonObject { put("value", it.first); put("name", it.second); put("description", it.third) }
        }))
    }
    val items = mutableListOf(modelItem, modeItem)
    val tl = settings["thoughtLevel"]?.jsonObject
    if (tl?.get("enabled")?.jsonPrimitive?.content == "true") {
        val avail = tl["available"]?.jsonArray?.mapNotNull { it.jsonObject } ?: emptyList()
        val default = tl["defaultLevel"]?.jsonPrimitive?.contentOrNull
            ?.takeIf { d -> avail.any { it["value"]?.jsonPrimitive?.contentOrNull == d } }
        items.add(buildJsonObject {
            put("id", "thought_level"); put("name", "Thought Level"); put("category", "thought_level"); put("type", "select")
            put("currentValue", tl["current"]?.jsonPrimitive?.contentOrNull
                ?: default
                ?: avail.firstOrNull()?.get("value")?.jsonPrimitive?.contentOrNull
                ?: "")
            put("options", kotlinx.serialization.json.JsonArray(avail.map {
                buildJsonObject {
                    put("value", it["value"]?.jsonPrimitive?.contentOrNull ?: "")
                    put("name", it["label"]?.jsonPrimitive?.contentOrNull ?: "")
                    it["description"]?.jsonPrimitive?.contentOrNull?.let { d -> put("description", d) }
                }
            }))
        })
    }
    return kotlinx.serialization.json.JsonArray(items)
}

/**
 * 手机远程 channel 语义层（M0 报告映射表实现，混合路线）：
 * - 发消息走经典 session/send（成熟通道），流式走 v4/conversation/subscribe 直通
 *   （v4 帧零转换经 EventFire 回推，见 ZCodeRemoteService 的事件泵）
 * - 首屏基础调用（setting/oauth/model-provider）以最小合法应答 stub，H5 有容错
 * - 未实现方法回 "Method not found"（H5 fallback 渲染）
 *
 * 全部在 zcode-remote-channel 线程池执行（app-server 调用可阻塞）。
 */
class RemoteChannelHandlers(private val service: ZCodeRemoteService) {

    companion object {
        /** handle() when 分支覆盖的全部 channel——**单一权威源**，路由白名单由此派生。
         *  双源漂移已三次把 handler 实现挡在白名单外（oauth/settings-sync/bots、
         *  model-selection/provider-settings），漏项全回 Method not found 且装包才
         *  复现（H5「加载失败」，2026-09-23 真机日志实锤） */
        val CHANNELS = setOf(
            "setting", "oauth", "model-provider", "model-selection", "provider-settings",
            "zcode-agent", "zcode-task", "zcode-session", "window-controller", "git",
            "usage-stats", "coding-plan-subscription", "off-peak-task", "subagents",
            "skills", "client-scenes", "settings-sync", "bots",
        )
    }

    private val log = Logger.getInstance("ZCodePlugin")
    private val json = Json { ignoreUnknownKeys = true }

    /** 每个活跃 bridge 的 v4 连接上下文（connectionId 由桥分配，clientId 来自 initializeConversationV4） */
    class BridgeV4Context(val connectionId: String) {
        var clientId: String? = null
        /** H5 桥身份（bridge-open 携带）：同 recoveryId 的新桥建立=同一逻辑会话恢复，旧桥即僵尸 */
        @Volatile var recoveryId: String? = null
        /** 最近一次收到该桥任何 channel 请求的时间（僵尸淘汰判据：H5 刷新/关闭后旧桥永不再活动） */
        @Volatile var lastActiveMs: Long = System.currentTimeMillis()
        /** topic → app-server 订阅（subscriptionId + EventFire listenerId） */
        val subscriptions = java.util.concurrent.ConcurrentHashMap<String, V4Subscription>()
    }

    class V4Subscription(val topic: String, var subscriptionId: String, val listenerIds: MutableSet<Long>)

    private val bridgeContexts = java.util.concurrent.ConcurrentHashMap<String, BridgeV4Context>()

    fun context(bridgeSessionId: String): BridgeV4Context? = bridgeContexts[bridgeSessionId]

    fun activeContexts(): Map<String, BridgeV4Context> = bridgeContexts.toMap()

    fun clearBridge(bridgeSessionId: String) {
        val ctx = bridgeContexts.remove(bridgeSessionId)
        val client = service.appServer(null)
        if (ctx != null && client != null) {
            for (sub in ctx.subscriptions.values) {
                runCatching { client.v4ConversationUnsubscribe(sub.topic, sub.subscriptionId, ctx.connectionId) }
            }
        }
        // 路由簿无论 ctx 是否存在都要清：RelayBridge 的桥行/EventFire 监听在
        // bridge-open/listen 时登记，可先于 helloConversationV4 建 ctx；不清则
        // controller 重推的 hasListener 判据恒真，死桥持续收快照帧（缺陷 DH）
        service.clearBridgeRouting(bridgeSessionId)
    }

    /**
     * 僵尸桥淘汰（新桥建立时调用）：H5 单页单桥——新 bridge-open 意味着其余旧桥
     * 已被页面刷新/WS 重连抛弃，**立即全量淘汰**。
     * 旧「90s 无活动」判据实测永不命中（缺陷 DH，2026-09-24 IAB 复现）：旧桥被
     * 抛弃前一刻通常还在处理请求（idle 恒为秒级），僵尸桥因此存活至 10min 兜底
     * 巡检，期间事件泵对新旧桥双推——每帧事件重复两份、流量翻倍，弱网手机端被
     * 放大流量压垮遭 relay 踢断，重连又开新桥，代际叠加滚雪球（页面反复刷新）。
     * recoveryId/bridgeGeneration 均不可作保序判据（页面重载即重置），但单设备
     * WS 有序投递下「最后 open 的桥即活桥」成立。
     */
    fun retireStaleBridges(keepBridgeId: String) {
        for (id in bridgeContexts.keys.toList()) {
            if (id == keepBridgeId) continue
            log.info("retiring replaced bridge $id (new bridge opened)")
            clearBridge(id)
        }
    }

    fun touchBridge(bridgeSessionId: String) {
        bridgeContexts[bridgeSessionId]?.let { it.lastActiveMs = System.currentTimeMillis() }
    }

    /**
     * 清空全部桥上下文（disconnect/unpair 时调用）：桥生命周期绑定 pair 会话。
     * 跨 pair 存活的僵尸桥实测危害极大——relay 对 terminal 断连按「活跃桥×channel」
     * 逐个发 INTERNAL 清算通知，9 个僵尸桥即放大成每秒 70 条 error 帧风暴，且污染
     * 新 terminal 初始化使其在 bridge-open 前反复断连（此时无任何路径能触发
     * retireStaleBridges，死循环无解，直到下一个成功 bridge-open 顺带清桥才中断）。
     */
    fun clearAllBridges(reason: String) {
        if (bridgeContexts.isEmpty()) return
        log.info("clearing ${bridgeContexts.size} bridge(s): $reason")
        for (id in bridgeContexts.keys.toList()) clearBridge(id)
    }

    /** 后台巡检兜底：清 idle 超 [STALE_BRIDGE_MS] 的桥（H5 页面已关闭、无新
     *  bridge-open 触发 retireStaleBridges 时的唯一清理路径） */
    fun sweepStaleBridges() {
        val now = System.currentTimeMillis()
        for ((id, ctx) in bridgeContexts) {
            if (now - ctx.lastActiveMs > STALE_BRIDGE_MS) {
                log.info("retiring stale bridge $id (idle=${now - ctx.lastActiveMs}ms, sweep)")
                clearBridge(id)
            }
        }
    }

    /** channel.method 分发主入口（RemoteChannelRouter.handleChannelRequest 的 channelHandler） */
    fun handle(project: Project?, bridgeSessionId: String, request: ChannelCodec.ChannelRequest, responder: RelayClient.ChannelResponder) {
        val method = request.method ?: return responder.error("method missing")
        touchBridge(bridgeSessionId)
        val args0 = request.args.firstOrNull()?.let { argJson(it) } ?: JsonObject(emptyMap())

        when (request.channel) {
            "setting" -> handleSetting(method, responder)
            "oauth" -> handleOauth(method, responder)
            "model-provider" -> handleModelProvider(method, responder)
            "model-selection" -> when (method) {
                // H5 3.14.x 新协议路径的模型选择器唯一数据源（宿主版本对齐真实客户端后
                // 启用；旧 3.8.1 假版本走 model-provider.getAll 兼容路径）。getView miss
                // → H5 指数退避重试后模型选择器「加载失败」（2026-09-23 真机日志实锤）
                "getView" -> responder.success(ChValue.Obj(modelSelectionView(args0)))
                else -> responder.error("Method not found: model-selection.$method")
            }
            "provider-settings" -> when (method) {
                // H5 3.14.x 设置面数据源；miss 同样触发指数退避重试（真机 6 次刷屏）
                "getView", "refresh" -> responder.success(ChValue.Obj(providerSettingsView()))
                else -> responder.error("Method not found: provider-settings.$method")
            }
            "zcode-agent" -> handleAgent(project, bridgeSessionId, method, args0, request.args, responder)
            "zcode-task" -> handleTask(project, bridgeSessionId, method, args0, responder)
            "zcode-session" -> handleSession(project, method, args0, responder)
            "window-controller" -> handleWindowController(project, bridgeSessionId, method, args0, responder)
            "git" -> when (method) {
                // H5 workspace 视图的 git 状态刷新（回最小成功态；真实 git 集成二期）
                "refresh" -> responder.success(ChValue.Obj(buildJsonObject { put("ok", true) }))
                "getRepositorySummary" -> responder.success(ChValue.Obj(buildJsonObject {
                    put("workspacePath", args0["workspacePath"]?.jsonPrimitive?.content ?: "")
                    put("repoRoot", args0["workspacePath"]?.jsonPrimitive?.content ?: "")
                    put("workspaceInRepoPath", ".")
                    put("isGitAvailable", false)
                    put("isRepository", false)
                }))
                else -> responder.error("Method not found: git.$method")
            }
            "usage-stats" -> when (method) {
                // H5 coding-plan 配额重置面板（官方真实实现调 BigModel HTTP /status）；
                // 桥不承载，空态应答（字段名对齐官方返回）。回 Method not found 会让
                // H5 侧报错（装机 HAR ERR id=44 实证）
                "getCodingPlanResetStatus" -> responder.success(ChValue.Obj(buildJsonObject {
                    put("availableFiveHourResets", kotlinx.serialization.json.JsonArray(emptyList()))
                    put("availableWeekResets", kotlinx.serialization.json.JsonArray(emptyList()))
                    put("latestFiveHourResetHistory", null as String?)
                    put("latestWeekResetHistory", null as String?)
                }))
                // 权益快照：coding-plan 回「有订阅」模板（HAR id=26 形状，remaining.
                // isShow=false 避开假额度数字）；其余 provider 回 no_plan 形状（id=37）。
                // 回 authenticated:false 会让 H5 把 coding-plan provider 从模型下拉过滤
                //（smoke 五轮实证）。真额度接入（HTTP quota API）留后续版本
                "getEntitlementSnapshot" -> {
                    val preferred = args0["preferredProviderId"]?.jsonPrimitive?.contentOrNull
                    responder.success(ChValue.Obj(buildJsonObject {
                        put("generatedAt", System.currentTimeMillis())
                        put("authenticated", true)
                        if (preferred == "builtin:bigmodel-coding-plan") {
                            put("context", buildJsonObject {
                                put("scope", "personal"); put("productId", "product-d46f8b"); put("displayName", "GLM Coding Max")
                            })
                            put("provider", buildJsonObject {
                                put("id", preferred); put("name", "BigModel - Coding Plan")
                            })
                            put("remaining", buildJsonObject {
                                put("count", 5000); put("isShow", false); put("percentage", 5)
                                put("nextResetTime", System.currentTimeMillis() + 86400_000L)
                            })
                            put("subscription", buildJsonObject {
                                put("identityType", "unknown"); put("identityMasked", null as String?)
                                // details 空=H5 判「无有效订阅」→自动弹 CodingPlanUpgradeDialog
                                // →对话框内 e.find 崩；照官方模板放一条（expire 造未来时间）
                                put("details", kotlinx.serialization.json.JsonArray(listOf(buildJsonObject {
                                    put("productId", "product-d46f8b")
                                    put("productName", "GLM Coding Max")
                                    put("purchaseTime", null as String?); put("beginTime", null as String?)
                                    put("billingCycle", "annually")
                                    put("renewTime", java.time.Instant.ofEpochMilli(System.currentTimeMillis() + 31536000_000L).toString())
                                    put("expireTime", java.time.Instant.ofEpochMilli(System.currentTimeMillis() + 63072000_000L).toString())
                                })))
                            })
                            put("quota", buildJsonObject {
                                put("level", "max"); put("limits", kotlinx.serialization.json.JsonArray(emptyList()))
                            })
                        } else {
                            put("unavailableReason", "no_plan")
                            put("context", buildJsonObject { put("scope", "personal") })
                            put("provider", buildJsonObject {
                                put("id", preferred ?: ""); put("name", preferred ?: "")
                            })
                            put("remaining", null as String?)
                        }
                    }))
                }
                else -> responder.error("Method not found: usage-stats.$method")
            }
            "coding-plan-subscription" -> when (method) {
                // 订阅价格类调用：桥不承载，空应答消噪（H5 容错）
                "getOffPeakClientConfig", "getBillingDiscount" -> responder.success(ChValue.Obj(buildJsonObject {}))
                "getEnterprisePricing" -> responder.success(ChValue.Obj(buildJsonObject {
                    put("productList", kotlinx.serialization.json.JsonArray(emptyList()))
                }))
                else -> responder.error("Method not found: coding-plan-subscription.$method")
            }
            "off-peak-task" -> when (method) {
                "getCodingPlanSupport" -> responder.success(ChValue.Obj(buildJsonObject {}))
                "list" -> responder.success(ChValue.Obj(kotlinx.serialization.json.JsonArray(emptyList())))
                else -> responder.error("Method not found: off-peak-task.$method")
            }
            // H5 输入框 @ 引用与 / 命令的来源（agents md / 技能扫描器真实化留后续）：
            // 空列表合法（H5 无可选项容错）
            "subagents" -> when (method) {
                "list" -> responder.success(ChValue.Obj(buildJsonObject {
                    put("agents", kotlinx.serialization.json.JsonArray(emptyList()))
                }))
                else -> responder.error("Method not found: subagents.$method")
            }
            "skills" -> when (method) {
                "list" -> responder.success(ChValue.Obj(buildJsonObject {
                    put("skills", kotlinx.serialization.json.JsonArray(emptyList()))
                }))
                else -> responder.error("Method not found: skills.$method")
            }
            "client-scenes" -> when (method) {
                "list" -> responder.success(ChValue.Obj(kotlinx.serialization.json.JsonArray(emptyList())))
                else -> responder.error("Method not found: client-scenes.$method")
            }
            "settings-sync" -> when (method) {
                // {handled:true} 抑制 H5 首启引导弹窗（null 会触发 FirstRunPrompt）
                "getFirstRunPromptState" -> responder.success(ChValue.Obj(buildJsonObject { put("handled", true) }))
                "markFirstRunPromptHandled" -> responder.success(ChValue.Undefined)
                else -> responder.error("Method not found: settings-sync.$method")
            }
            "bots" -> when (method) {
                // 偏好同步：桥不承载 bot 运行时，回空态（H5 容错）
                "syncAppRuntimePreferences" -> responder.success(ChValue.Undefined)
                else -> responder.error("Method not found: bots.$method")
            }
            else -> responder.error("Method not found: ${request.channel}.$method")
        }
    }

    // ---- 首屏基础 stub ----

    /**
     * 同源读 `~/.zcode/v2/setting.json`（官方桌面端/CLI 共享设置真身；HAR 实测官方
     * setting.get 应答里的 modelProviderFamilyModes / familySelectedKeys /
     * providerFamilyDomain 等模型选择状态即存于此文件）。H5 对缺失键有 Vdn fallback。
     */
    private fun sharedSettingJson(): JsonObject? = runCatching {
        val f = java.io.File(System.getProperty("user.home"), ".zcode/v2/setting.json")
        if (f.exists()) Json.parseToJsonElement(f.readText()).jsonObject else null
    }.getOrNull()

    private fun handleSetting(method: String, responder: RelayClient.ChannelResponder) {
        when (method) {
            "get" -> responder.success(ChValue.Obj(buildJsonObject {
                val src = sharedSettingJson()
                src?.forEach { (k, v) -> put(k, v) }
                // 形状对齐 H5 Vdn fallback：setting.get 期望对象（recentProjects/locale）
                if (src == null || !src.containsKey("recentProjects")) put("recentProjects", kotlinx.serialization.json.JsonArray(emptyList()))
                if (src == null || !src.containsKey("locale")) put("locale", "zh-CN")
            }))
            "update", "updateDataBaseDir", "ensureDefaultProject" -> responder.success(ChValue.Obj(buildJsonObject {}))
            else -> responder.error("Method not found: setting.$method")
        }
    }

    private fun handleOauth(method: String, responder: RelayClient.ChannelResponder) {
        when (method) {
            // smoke 四轮实证（2026-08-25）：setting.json 的 familyModes bigmodel='oauth'
            // 使 H5 过滤链要求 oauth 会话 authenticated——signed-out 会把 oauth 系
            // provider（GLM coding-plan）全部过滤、模型选择器不渲染。凭证实际由
            // app-server 自管（config.json apiKey），故回 authenticated+中性 userInfo
            "restoreCachedSessionState" -> responder.success(ChValue.Obj(buildJsonObject {
                put("status", "authenticated")
                put("userInfo", buildJsonObject {
                    put("id", "zcode-idea-host")
                    put("username", "IDE")
                    put("displayName", "IDE")
                    put("avatarUrl", "")
                })
            }))
            "restoreCachedSession" -> responder.success(ChValue.Obj(Json.parseToJsonElement("null")))
            // 官方回 family 名字符串（HAR 实测 'bigmodel'，源=setting.json 的 providerFamilyDomain，
            // H5 过滤链 cee({providerId, activeOAuthProvider}) 消费）；回 null 会导致 oauth 系
            // provider 在模型下拉被过滤。与 setting 同源读，无配置则 null
            "getActiveProvider" -> {
                val family = sharedSettingJson()?.get("providerFamilyDomain")?.jsonPrimitive?.contentOrNull
                if (family != null) responder.success(ChValue.Str(family))
                else responder.success(ChValue.Obj(Json.parseToJsonElement("null")))
            }
            else -> responder.error("Method not found: oauth.$method")
        }
    }

    private fun handleModelProvider(method: String, responder: RelayClient.ChannelResponder) {
        when (method) {
            // getAllCached 回退数组（与 getAll 同形）：官方 {providerIds,updatedAt} 形状
            // 实测让 H5 首渲染把对象灌进 provider store → Xut e.find 崩（smoke 十~十四
            // 轮 IAB 定案）；数组形态 H5 容错（find 不到当空）
            "getAll", "getAllCached" -> responder.success(
                ChValue.Obj(kotlinx.serialization.json.JsonArray(modelProviderList())),
            )
            "getDisplayOrder" -> responder.success(ChValue.Obj(buildJsonObject {}))
            // H5 发送门禁（v4-draft-readiness）唯一数据源：resolveZCodeAgentStartupReadiness
            // 要求 providers 里存在 baseURL 非空 + 有凭证 + models 含非 disabled 项的条目，
            // 否则判 missing → 输入框上方弹「当前没有可用模型」+ 点发送被 UI admission
            // 静默拒绝（2026-08-25 装机 HAR+bundle 定案，空 providers 是发送无反应的根因）。
            // registry 条目字段名与 getAll 不同（providerId 非 id、models[].modelId），
            // 形状对齐官方 buildProviderRegistrySnapshot/convertModelProviderConfigToZCodeProviderInput
            "getProviderRegistrySnapshot" -> responder.success(ChValue.Obj(buildJsonObject {
                val providers = modelProviderList()
                put("generatedAt", System.currentTimeMillis())
                put("revision", "sha256-${providers.size}-${System.currentTimeMillis() / 600_000L}")
                put("providers", kotlinx.serialization.json.JsonArray(providers.mapNotNull { p ->
                    val pv = p as? JsonObject ?: return@mapNotNull null
                    val baseURL = pv["endpoints"]?.jsonObject?.get("baseURL")?.jsonPrimitive?.contentOrNull
                        ?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
                    buildJsonObject {
                        put("providerId", pv["id"]?.jsonPrimitive?.contentOrNull ?: "")
                        pv["name"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }?.let { put("label", it) }
                        put("apiFormat", "anthropic-messages")
                        put("apiKeyRequired", true)
                        put("baseURL", baseURL)
                        put("kind", "anthropic")
                        // 凭证形态走 credential（key 非空即满足 hasRuntimeCredential），
                        // 避免把 config.json 的明文 apiKey 再灌进 H5 端存储/HAR
                        put("apiKey", buildJsonObject { put("source", "credential"); put("key", "config.json") })
                        put("source", pv["source"]?.jsonPrimitive?.contentOrNull ?: "custom")
                        put("models", pv["models"]?.let { models ->
                            kotlinx.serialization.json.JsonArray(models.jsonArray.mapNotNull { m ->
                                val mv = m as? JsonObject ?: return@mapNotNull null
                                buildJsonObject {
                                    put("modelId", mv["id"]?.jsonPrimitive?.contentOrNull ?: return@buildJsonObject)
                                    mv["name"]?.jsonPrimitive?.contentOrNull?.let { put("label", it) }
                                }
                            })
                        } ?: kotlinx.serialization.json.JsonArray(emptyList()))
                    }
                }))
            }))
            // 官方对已配 key 的 provider 回 null（HAR id=28/29/45 实测）；key 已在
            // getAll 应答里（config.json 同源），无需刷新
            "refreshCodingPlanApiKey" -> responder.success(ChValue.Obj(Json.parseToJsonElement("null")))
            else -> responder.error("Method not found: model-provider.$method")
        }
    }

    /**
     * config.json（v2）provider 聚合。形状逐字段对齐官方宿主 getAll 应答
     * （2026-08-25 官方宿主 HAR 抓包定案，8 provider 与本机 config 一一对应）：
     * - provider = {id, name, enabled, endpoints:{baseURL, paths:{anthropic}}, apiFormat,
     *   source, apiKey, defaultKind, models, createdAt, updatedAt}
     * - model = {id, name?, kinds, defaultKind, modalities, contextWindow,
     *   maxOutputTokens?, reasoning?, priority?, modified?}——无 modelId（H5 内部派生）
     * 多余键有被 H5 zod strict 校验丢弃整个对象的风险：endpoints.anthropic、
     * authenticated、modelId 均为实测踩坑（模型下拉只剩「管理模型」的根因候选）。
     * disabled provider 官方也返回（H5 按 enabled 过滤），apiKey 必须是 string：
     * H5 coding-plan 恢复链裸调 n.apiKey.trim()，缺失即整页崩溃；空 apiKey 串合法
     * （trim 后长度 0 = 该 provider 无凭证，H5 会过滤） */
    /** H5 按 revision 丢弃回退帧（`revision < 已应用 → 丢弃`），视图版本必须单调递增 */
    private val modelViewRevision = java.util.concurrent.atomic.AtomicLong(0)

    /**
     * H5 3.14.x 模型选择 view（model-selection.getView 应答）。
     * 形状逆向自官方 app.asar（freezeView + effectiveSelection 解析链）+ H5 bundle 消费面：
     * providers[].models[].config.optionSpecs.reasoningLevel.values 必读（级别合法性校验
     * 与下拉），preferredSelection 缺 options.reasoningLevel 判 ready-empty（不预选）。
     * 模型清单与 IDE 输入框下拉同源（面板 listModels：账号渠道+自定义渠道），面板不可用
     * 回退 config.json 直读。
     *
     * input.selection 回显契约（官方 facades.ts getView(input) → resolveEffectiveModelSelection）：
     * H5 点选模型只更新本地草稿，随即带 {selection:草稿} 重调 getView，**显示层以应答的
     * effectiveSelection 为权威覆盖草稿**——宿主必须校验并回显请求的 selection，否则 UI
     * 立刻回弹旧模型、提交也带旧值（2026-09-23 IAB 实锤「切模型不生效」根因：此前忽略
     * 入参恒回 kv 解析值）。校验失败按官方 selectionIssue 码回 null（provider-not-found/
     * model-not-found）；无入参时回退 kv preferredSelection（老调用面兼容）。
     */
    private fun modelSelectionView(input: JsonObject): JsonObject {
        val zcodePath = runCatching { com.zcode.ideaplugin.protocol.ZCodeLocator.detect() }.getOrNull()
        val levelsByKey = mutableMapOf<Pair<String, String>, List<String>>()
        val rows = bridgeModelRows()
        val providers = rows.groupBy { it.first }.mapNotNull { (provider, models) ->
            val viewModels = models.mapNotNull { row ->
                modelSelectionModel(row.second, provider, zcodePath, levelsByKey)
            }
            if (viewModels.isEmpty()) return@mapNotNull null
            buildJsonObject {
                put("providerId", provider)
                put("providerName", models.first().third ?: provider)
                put("config", buildJsonObject {
                    put("visibility", "visible")
                    // H5 工具栏模型列表构建（HH→nSt）判 t.config.api?.type：缺失=整个
                    // provider 被过滤=「管理模型」空列表（2026-09-23 IAB 实锤）。'glm'
                    // 分支只要求 type 非空（sa('glm') 恒真，官方硬编码 selectedProvider='glm'）
                    put("api", buildJsonObject { put("type", "anthropic-messages") })
                    // 账号渠道必须带 access.mode：H5 rSt(providerId, access) 按 mode 派生
                    // 渠道徽标（Individual/Team/Free）与短名查表；缺失时 zod safeParse
                    // 失败掉 providerName 兜底=长全名无徽标（2026-09-23 IAB 实测「BigModel
                    // Individual Coding Plan」vs 官方「BigModel 个人」）。自定义渠道不
                    // 伪装账号身份，同一兜底显示用户命名
                    com.zcode.ideaplugin.protocol.AccountProviderBridge.accessModeOf(provider)?.let { mode ->
                        put("access", buildJsonObject {
                            put("type", "zhipu-account")
                            put("mode", mode)
                        })
                    }
                })
                put("models", kotlinx.serialization.json.JsonArray(viewModels))
            }
        }
        val selection = resolveModelSelection(levelsByKey, zcodePath)
        val effective = resolveRequestedSelection(input["selection"] as? JsonObject, levelsByKey, zcodePath)
            ?: selection
        return buildJsonObject {
            put("revision", modelViewRevision.incrementAndGet())
            put("providers", kotlinx.serialization.json.JsonArray(providers))
            if (selection != null) {
                put("preferredSelection", selection)
            } else {
                put("preferredSelection", kotlinx.serialization.json.JsonNull)
            }
            if (effective != null) {
                put("effectiveSelection", effective)
            } else {
                put("effectiveSelection", kotlinx.serialization.json.JsonNull)
                put("selectionIssue", "selection-missing")
            }
        }
    }

    /**
     * 官方 getView(input) 的 resolveEffectiveModelSelection 对齐：H5 传入的草稿 selection
     * 命中当前清单即归一化回显（reasoningLevel 非法回退目录默认）。未命中（provider 已
     * 删/清单未就绪）返回 null 走 kv preferredSelection 兜底——官方此处回
     * provider-not-found 等 selectionIssue + null，但 H5 消费面 effectiveSelection=null
     * 会判 submission-not-ready 阻断发送，兜底旧值比阻断更符合宿主单渠道事实
     */
    private fun resolveRequestedSelection(
        req: JsonObject?,
        levelsByKey: Map<Pair<String, String>, List<String>>,
        zcodePath: java.nio.file.Path?,
    ): JsonObject? {
        if (req == null) return null
        val pid = req["providerId"]?.jsonPrimitive?.contentOrNull ?: return null
        val mid = req["modelId"]?.jsonPrimitive?.contentOrNull ?: return null
        val values = levelsByKey[pid to mid] ?: return null
        val reqLevel = (req["options"] as? JsonObject)?.get("reasoningLevel")?.jsonPrimitive?.contentOrNull
        val level = reqLevel?.takeIf { it in values }
            ?: runCatching {
                com.zcode.ideaplugin.protocol.BuiltinModelCatalog.defaultReasoningLevel(mid, zcodePath)
            }.getOrNull()?.takeIf { it in values }
            ?: values.lastOrNull()
        return buildJsonObject {
            put("providerId", pid)
            put("modelId", mid)
            if (level != null) put("options", buildJsonObject { put("reasoningLevel", level) })
        }
    }

    /**
     * 归一化模型行 Triple(providerId, 行JSON, providerName?)：与 IDE 输入框下拉同源
     * （面板 listModels 行字段 providerId/providerName?/modelId/modelName?/contextWindow?/
     * maxOutput?/supportsImages?）。无活跃面板回退 config.json 直读（旧路径同源）。
     */
    private fun bridgeModelRows(): List<Triple<String, JsonObject, String?>> {
        val fromPanel = runCatching {
            com.zcode.ideaplugin.ZCodeServiceImpl.modelsListFromAnyPanel()
        }.getOrNull()?.get("models")?.jsonArray
        if (fromPanel != null) {
            return fromPanel.mapNotNull { el ->
                val m = el as? JsonObject ?: return@mapNotNull null
                val pid = m["providerId"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                val mid = m["modelId"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                Triple(pid, m, m["providerName"]?.jsonPrimitive?.contentOrNull)
            }.distinctBy { it.first to it.second["modelId"]?.jsonPrimitive?.content }
        }
        return modelProviderList().mapNotNull { el ->
            val p = el as? JsonObject ?: return@mapNotNull null
            val pid = p["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            val enabled = p["enabled"]?.jsonPrimitive?.content?.toBoolean() ?: true
            val apiKey = p["apiKey"]?.jsonPrimitive?.contentOrNull ?: ""
            if (!enabled || apiKey.isBlank()) return@mapNotNull null
            val name = p["name"]?.jsonPrimitive?.contentOrNull
            p["models"]?.jsonArray?.mapNotNull { me ->
                val m = me as? JsonObject ?: return@mapNotNull null
                val mid = m["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                Triple(pid, buildJsonObject {
                    put("providerId", pid)
                    put("modelId", mid)
                    m["contextWindow"]?.let { put("contextWindow", it) }
                }, name)
            }
        }.flatten().distinctBy { it.first to it.second["modelId"]?.jsonPrimitive?.content }
    }

    /** 单模型 view 条目：config 按官方 cs schema 全量给（H5 侧有 zod 级 config store）*/
    private fun modelSelectionModel(
        m: JsonObject,
        providerId: String,
        zcodePath: java.nio.file.Path?,
        levelsByKey: MutableMap<Pair<String, String>, List<String>>,
    ): JsonObject? {
        val mid = m["modelId"]?.jsonPrimitive?.contentOrNull ?: return null
        return buildJsonObject {
            put("modelId", mid)
            put("config", modelConfig(m, providerId, zcodePath, levelsByKey))
        }
    }

    /** 模型 config 块（model-selection 与 provider-settings 两 view 共用，官方同源形状） */
    private fun modelConfig(
        m: JsonObject,
        providerId: String,
        zcodePath: java.nio.file.Path?,
        levelsByKey: MutableMap<Pair<String, String>, List<String>>,
    ): JsonObject {
        val mid = m["modelId"]?.jsonPrimitive?.contentOrNull ?: ""
        val values = runCatching {
            com.zcode.ideaplugin.protocol.BuiltinModelCatalog.reasoningValues(mid, zcodePath)
        }.getOrNull()
        val default = runCatching {
            com.zcode.ideaplugin.protocol.BuiltinModelCatalog.defaultReasoningLevel(mid, zcodePath)
        }.getOrNull()
        val levels = values?.takeIf { it.isNotEmpty() } ?: listOf(default ?: "max")
        levelsByKey[providerId to mid] = levels
        val caps = runCatching {
            com.zcode.ideaplugin.protocol.BuiltinModelCatalog.modelCaps(mid, zcodePath)
        }.getOrNull()
        val contextWindow = m["contextWindow"]?.jsonPrimitive?.contentOrNull?.toLongOrNull()
            ?: caps?.contextWindow ?: 200_000L
        val maxOut = m["maxOutput"]?.jsonPrimitive?.contentOrNull?.toLongOrNull()
            ?: runCatching {
                com.zcode.ideaplugin.protocol.BuiltinModelCatalog.maxOutputTokensMax(mid, zcodePath)
            }.getOrNull()
        val supportsImage = m["supportsImages"]?.jsonPrimitive?.content?.toBoolean() == true || caps?.supportsImage == true
        return buildJsonObject {
            put("enabled", true)
            put("properties", buildJsonObject {
                put("requiresMfjsToolSchema", false)
                put("contextWindow", contextWindow)
                put("inputFormat", buildJsonObject {
                    put("supportsText", true)
                    put("supportsImage", supportsImage)
                    put("supportsVideo", caps?.supportsVideo == true)
                    put("supportsAudio", false)
                    put("supportsPdf", caps?.supportsPdf == true)
                })
                put("outputFormat", buildJsonObject { put("supportsText", true) })
                put("supportsToolCall", true)
                put("supportsJsonSchemaOutput", false)
                put("supportsNativeWebSearch", false)
                put("supportsMidConversationSystem", false)
            })
            put("optionSpecs", buildJsonObject {
                put("reasoningLevel", buildJsonObject {
                    put("values", kotlinx.serialization.json.JsonArray(levels.map { kotlinx.serialization.json.JsonPrimitive(it) }))
                    put("map", buildJsonObject {})
                })
                maxOut?.let {
                    put("maxOutputTokens", buildJsonObject {
                        put("max", it)
                        put("map", buildJsonObject {})
                    })
                }
            })
        }
    }

    /**
     * 首选模型解析：kv（zcode.currentModel/zcode.thoughtLevel，IDE 输入框切换时写入）
     * 命中清单即用；kv 级别不在该模型级别集时回退目录默认。无记录/不在清单返回 null
     * 保持 ready-empty——发送走宿主侧默认模型，不越权代选（账号套餐渠道不在
     * config.json 时尤为关键）。
     */
    private fun resolveModelSelection(
        levelsByKey: Map<Pair<String, String>, List<String>>,
        zcodePath: java.nio.file.Path?,
    ): JsonObject? {
        var ref: Pair<String, String>? = null
        var kvLevel: String? = null
        runCatching {
            val kv = com.intellij.ide.util.PropertiesComponent.getInstance()
                .getValue(com.zcode.ideaplugin.ui.ZCodeLanguageService.KEY_WEBVIEW_KV) ?: return@runCatching
            val root = Json.parseToJsonElement(kv).jsonObject
            root["zcode.currentModel"]?.jsonPrimitive?.contentOrNull?.let { cur ->
                runCatching {
                    val o = Json.parseToJsonElement(cur).jsonObject
                    val pid = o["providerId"]?.jsonPrimitive?.contentOrNull
                    val mid = o["modelId"]?.jsonPrimitive?.contentOrNull
                    if (pid != null && mid != null) ref = pid to mid
                }
            }
            kvLevel = root["zcode.thoughtLevel"]?.jsonPrimitive?.contentOrNull
        }
        val ref0 = ref
        if (ref0 == null || !levelsByKey.containsKey(ref0)) return null
        val (providerId, modelId) = ref0
        val values = levelsByKey[ref0].orEmpty()
        val level = kvLevel?.takeIf { it in values }
            ?: runCatching {
                com.zcode.ideaplugin.protocol.BuiltinModelCatalog.defaultReasoningLevel(modelId, zcodePath)
            }.getOrNull()?.takeIf { it in values }
            ?: values.lastOrNull()
        return buildJsonObject {
            put("providerId", providerId)
            put("modelId", modelId)
            if (level != null) put("options", buildJsonObject { put("reasoningLevel", level) })
        }
    }

    /**
     * H5 3.14.x 设置面 view（provider-settings.getView/refresh 应答）。形状逐字段对齐
     * 官方 createProviderSettingsView（app.asar OY 投影）：providers 必带 **effectiveConfig**
     * （H5 套餐入口 i7e/XT 与设置页 TA 全部裸读 `effectiveConfig.access/group`，缺字段=
     * 「reading 'access'」整页错误边界，2026-09-23 真机堆栈 X9e 实锤）；models 必带
     * kind/builtin/effectiveBuiltinConfig/effectiveConfig/enabled/executable/selectable/issues
     * （kEn 投影消费面）。access 不声明（null）=不伪装 zhipu-account 套餐身份，H5 套餐
     * 入口走空态容错。
     */
    private fun providerSettingsView(): JsonObject {
        val zcodePath = runCatching { com.zcode.ideaplugin.protocol.ZCodeLocator.detect() }.getOrNull()
        val rows = bridgeModelRows()
        return buildJsonObject {
            put("revision", modelViewRevision.incrementAndGet())
            put("providerTemplates", kotlinx.serialization.json.JsonArray(emptyList()))
            put("providerOrder", kotlinx.serialization.json.JsonArray(emptyList()))
            put("providers", kotlinx.serialization.json.JsonArray(rows.groupBy { it.first }.map { (provider, models) ->
                val levelMap = mutableMapOf<Pair<String, String>, List<String>>()
                buildJsonObject {
                    put("providerId", provider)
                    models.first().third?.let { put("providerName", it) }
                    put("templateId", null as String?)
                    put("enabled", true)
                    put("executable", true)
                    put("effectiveConfig", buildJsonObject {
                        put("visibility", "visible")
                        put("access", null as String?)
                    })
                    put("issues", kotlinx.serialization.json.JsonArray(emptyList()))
                    put("models", kotlinx.serialization.json.JsonArray(models.map { row ->
                        val cfg = modelConfig(row.second, provider, zcodePath, levelMap)
                        buildJsonObject {
                            put("kind", "anthropic")
                            put("modelId", row.second["modelId"]?.jsonPrimitive?.contentOrNull ?: "")
                            put("builtin", true)
                            put("effectiveBuiltinConfig", cfg)
                            put("effectiveConfig", cfg)
                            put("enabled", true)
                            put("executable", true)
                            put("selectable", true)
                            put("issues", kotlinx.serialization.json.JsonArray(emptyList()))
                        }
                    }))
                }
            }))
        }
    }

    private fun modelProviderList(): List<kotlinx.serialization.json.JsonElement> = runCatching {
        val configFile = com.zcode.ideaplugin.protocol.Credentials.defaultConfigPath().toFile()
        if (!configFile.exists()) return emptyList()
        val providers = Json.parseToJsonElement(configFile.readText()).jsonObject["provider"]?.jsonObject
            ?: return emptyList()
        val now = System.currentTimeMillis()
        providers.mapNotNull { (providerId, providerEl) ->
            val pv = providerEl.jsonObject
            val enabled = pv["enabled"]?.jsonPrimitive?.content?.toBoolean() ?: true
            val opts = pv["options"]?.jsonObject
            val apiKey = opts?.get("apiKey")?.jsonPrimitive?.contentOrNull ?: ""
            val baseURL = opts?.get("baseURL")?.jsonPrimitive?.contentOrNull ?: ""
            val models = pv["models"]?.jsonObject?.mapNotNull { (modelId, modelEl) ->
                val m = modelEl.jsonObject
                buildJsonObject {
                    // 模型对象消费链有多条且字段名不一致（2026-08-25 浏览器复现实测定案，
                    // 权威形状=src chunk 的 zod schema md：id/kinds/modalities/contextWindow 必填）：
                    // - NU 过滤链 Fi(t)&&t.id.trim()：id 必须 string——缺失=任务会话区 bdt
                    //   "reading 'trim'" 崩（本缺陷根因，field id 非 modelId）
                    // - NU 映射链 r.kinds.includes(kind)：kinds 必须数组——缺失=下一崩点
                    // - name 仅 config 显式配置才放（官方 GLM-5.2 应答即无 name）
                    put("id", modelId)
                    m["name"]?.jsonPrimitive?.contentOrNull?.let { put("name", it) }
                    put("kinds", kotlinx.serialization.json.JsonArray(listOf(kotlinx.serialization.json.JsonPrimitive("anthropic"))))
                    put("defaultKind", "anthropic")
                    put("modalities", buildJsonObject {
                        put("input", kotlinx.serialization.json.JsonArray(listOf(kotlinx.serialization.json.JsonPrimitive("text"))))
                        put("output", kotlinx.serialization.json.JsonArray(listOf(kotlinx.serialization.json.JsonPrimitive("text"))))
                    })
                    put("contextWindow", m["limit"]?.jsonObject?.get("context")?.jsonPrimitive?.content?.toLongOrNull() ?: 200000L)
                    m["limit"]?.jsonObject?.get("output")?.jsonPrimitive?.content?.toLongOrNull()?.let { put("maxOutputTokens", it) }
                    put("modified", false)
                }
            } ?: emptyList()
            buildJsonObject {
                put("id", providerId)
                put("name", pv["name"]?.jsonPrimitive?.content ?: providerId)
                put("enabled", enabled)
                put("endpoints", buildJsonObject {
                    put("baseURL", baseURL)
                    put("paths", buildJsonObject { put("anthropic", "/v1/messages") })
                })
                put("apiFormat", "anthropic-messages")
                put("source", "custom")
                put("apiKey", apiKey)
                put("defaultKind", "anthropic")
                put("models", kotlinx.serialization.json.JsonArray(models))
                put("createdAt", now)
                put("updatedAt", now)
            }
        }
    }.getOrDefault(emptyList())

    // ---- zcode-agent：v4 网关桥 ----

    private fun handleAgent(
        project: Project?, bridgeSessionId: String, method: String, args: JsonObject,
        rawArgs: List<ChValue>, responder: RelayClient.ChannelResponder,
    ) {
        when (method) {
            "helloConversationV4" -> {
                val ctx = bridgeContexts.getOrPut(bridgeSessionId) { BridgeV4Context("zcodeidea-${java.util.UUID.randomUUID().toString().take(13)}") }
                responder.success(ChValue.Obj(buildJsonObject {
                    put("kind", "hello")
                    put("protocolVersion", 3)
                    put("connectionId", ctx.connectionId)
                    put("clientMode", "web-remote-replayable")
                    put("deliveryProfile", "replayable")
                    put("serverTime", System.currentTimeMillis())
                    put("capabilities", buildJsonObject {
                        put("nativeDialogs", false)
                        put("localTerminal", false)
                        put("binaryFrames", false)
                        put("compression", "none")
                        put("workspaceHookReview", false)
                    })
                    put("auth", buildJsonObject {})
                }))
            }
            "initializeConversationV4" -> {
                val ctx = bridgeContexts[bridgeSessionId]
                val clientId = args["clientId"]?.jsonPrimitive?.content
                if (ctx == null || clientId.isNullOrBlank()) {
                    responder.error("fault.connection.helloRequired")
                } else {
                    ctx.clientId = clientId
                    responder.success(ChValue.Undefined)
                }
            }
            // H5 发消息/建会话都走 v4 命令信封（官方 zcodeAgentService.sendConversationCommandV4
            // 本体即 client.request(v4/command, envelope)）——宿主透传，缺它发送按钮永远无反应
            // （2026-09-22 真机抓帧定案：H5 每轮恢复链都调，此前 Method not found）
            "sendConversationCommandV4" -> {
                val ctx = bridgeContexts[bridgeSessionId]
                    ?: return responder.error("fault.connection.helloRequired")
                val client = service.appServer(project)
                    ?: return responder.error("app-server unavailable")
                // 官方 params={envelope, clientMode?, workspacePath?...}；envelope 缺失时
                // 防御性把 args 本身当信封（H5 版本差异兜底）
                val envelope = args["envelope"] as? JsonObject ?: args
                val ack = runCatching { client.v4CommandRaw(envelope) }.getOrElse { e ->
                    return responder.error("command failed: ${e.message?.take(160)}")
                }
                emitRemoteUserBubble(client, envelope)
                responder.success(ChValue.Obj(ack))
            }
            "subscribeConversationV4", "subscribeSessionsIndexV4" -> {
                val ctx = bridgeContexts[bridgeSessionId]
                    ?: return responder.error("fault.connection.helloRequired")
                val client = service.appServer(project)
                    ?: return responder.error("app-server unavailable")
                // 订阅 workspace 解析链：project → H5 显式传参 → bridge-open 登记的
                // workspaceKey。第三级是挂载目录工作区的唯一正确来源：conversation 订阅
                // H5 不带 workspacePath、projectForBridge 对挂载 key 解析不到项目，缺了它
                // v4 水合 loadPersistedEvents 报 Session not found（2026-10-30 手机首进
                // 挂载目录会话恒「新会话页」实锤；坏订阅在网关留半活会话，重试跳过水合
                // =「返回再点就好」假象）
                val wsResolved = resolveSubscribeWorkspace(project, args, bridgeSessionId)
                val sessionId = args["sessionId"]?.jsonPrimitive?.content
                val topic = when {
                    sessionId != null -> "conversation/$sessionId"
                    method.endsWith("SessionsIndexV4") -> {
                        wsResolved ?: return responder.error("workspacePath required")
                        "sessions-index/$wsResolved"
                    }
                    else -> return responder.error("sessionId required")
                }
                // 先占坑再订阅：app-server 的 initial 快照帧与订阅 RPC 应答在 stdout 上
                // 竞速，live draft 零水合耗、快照恒抢先——帧泵按 ctx.subscriptions[topic]
                // 判空转发，等订阅应答返回才注册必丢首帧（缺陷FS：H5 等 1s 无快照退订，
                // 工作区首进导航被打断恒落新会话页；持久化会话水合慢（读库）侥幸掩盖竞态）
                val sub = ctx.subscriptions.getOrPut(topic) {
                    V4Subscription(topic, "", java.util.concurrent.ConcurrentHashMap.newKeySet())
                }
                try {
                    val ack = client.v4ConversationSubscribe(topic, ctx.connectionId, workspacePath = wsResolved)
                    ack["ack"]?.jsonObject?.get("subscriptionId")?.jsonPrimitive?.content?.let { sub.subscriptionId = it }
                    // 应答形状对齐桌面（{ack} 包装）；EventFire 监听由 listen 侧登记
                    responder.success(ChValue.Obj(buildJsonObject { put("ack", ack["ack"] ?: buildJsonObject {}) }))
                    log.info("remote v4 subscribe ok: topic=$topic ws=${wsResolved ?: "<none>"} bridge=$bridgeSessionId")
                    // 订阅成功即有 initial 快照帧——由事件泵从 app-server 通知转推，此处无需处理
                } catch (e: Exception) {
                    val msg = e.message.orEmpty()
                    // 换进程后的 draft（既不活跃也未持久化）订阅硬失败。官方宿主对该形态按
                    // 空会话继续（水合软失败语义），合成 ack 让 H5 落空会话页而不是打断
                    // 导航；真会话的订阅失败仍原样回错并拆登记
                    if (msg.contains("not active and not persisted") || msg.contains("fault.subscribe.sessionNotFound")) {
                        sub.subscriptionId = "zcsyn-${java.util.UUID.randomUUID().toString().take(13)}"
                        responder.success(ChValue.Obj(buildJsonObject {
                            put("ack", buildJsonObject { put("subscriptionId", sub.subscriptionId) })
                        }))
                        log.info("remote v4 subscribe rescued (unpersisted session): topic=$topic bridge=$bridgeSessionId")
                    } else {
                        ctx.subscriptions.remove(topic)
                        log.warn("remote v4 subscribe failed: topic=$topic ws=${wsResolved ?: "<none>"}: ${e.message?.take(150)}")
                        responder.error("subscribe failed: ${e.message?.take(120)}")
                    }
                }
            }
            // H5 索引恢复重同步：ack.subscriptionId 必须回请求值（H5 校验不等即
            // resync-ack-mismatch）。走官方 resync RPC same-sub 恢复——此前静默重发
            // subscribe 会产生新 subscriptionId，重推的快照帧带新 id，H5 按帧内 id
            // 严格匹配即静默丢弃（2026-09-22 对照开源 zcodeAgentService 定案）
            "resyncSessionsIndexV4" -> {
                val ctx = bridgeContexts[bridgeSessionId]
                    ?: return responder.error("fault.connection.helloRequired")
                val subId = args["subscriptionId"]?.jsonPrimitive?.content
                    ?: return responder.error("subscriptionId required")
                // workspace 解析链与 subscribe 同（挂载目录靠 bridge-open workspaceKey 兜底）
                val ws = resolveSubscribeWorkspace(project, args, bridgeSessionId)
                    ?: return responder.error("workspacePath required")
                val client = service.appServer(project)
                    ?: return responder.error("app-server unavailable")
                val result = runCatching {
                    client.v4ConversationResync("sessions-index/$ws", subId, ctx.connectionId, workspacePath = ws)
                }.getOrElse { e ->
                    return responder.error("resync failed: ${e.message?.take(120)}")
                }
                responder.success(ChValue.Obj(buildJsonObject { put("ack", result["ack"] ?: result) }))
            }
            // conversation 订阅的同构恢复（H5 恢复链会话详情重同步）
            "resyncConversationV4" -> {
                val ctx = bridgeContexts[bridgeSessionId]
                    ?: return responder.error("fault.connection.helloRequired")
                val subId = args["subscriptionId"]?.jsonPrimitive?.content
                    ?: return responder.error("subscriptionId required")
                val sessionId = args["sessionId"]?.jsonPrimitive?.content
                    ?: return responder.error("sessionId required")
                val client = service.appServer(project)
                    ?: return responder.error("app-server unavailable")
                val result = runCatching {
                    client.v4ConversationResync(
                        "conversation/$sessionId", subId, ctx.connectionId,
                        workspacePath = resolveSubscribeWorkspace(project, args, bridgeSessionId),
                    )
                }.getOrElse { e ->
                    // 未持久化会话（live draft 换进程后）resync 同样硬失败；H5 校验
                    // ack.subscriptionId 必须等于请求值，原样回填让恢复链落地空会话
                    if (e.message.orEmpty().contains("not active and not persisted") ||
                        e.message.orEmpty().contains("fault.subscribe.sessionNotFound")
                    ) {
                        responder.success(ChValue.Obj(buildJsonObject {
                            put("ack", buildJsonObject { put("subscriptionId", subId) })
                        }))
                        return
                    }
                    return responder.error("resync failed: ${e.message?.take(120)}")
                }
                responder.success(ChValue.Obj(buildJsonObject { put("ack", result["ack"] ?: result) }))
            }
            // H5 会话历史行分页：v4 行模型的渲染数据源（官方 service 直透
            // v4/conversation/rowsRange，readSession 只承载最近消息基线）——缺它 H5 拿不到
            // 历史行，超尾部窗口（60 行）的会话页面恒空=「新会话页」（缺陷FS 三轮实锤：
            // 12:50 真机点击持久化会话走完整 open 链后调本方法，此前 Method not found）
            "conversationRowsRangeV4" -> {
                val client = service.appServer(project)
                    ?: return responder.error("app-server unavailable")
                val sid = args["sessionId"]?.jsonPrimitive?.content
                    ?: return responder.error("sessionId required")
                val limit = args["limit"]?.jsonPrimitive?.contentOrNull?.toIntOrNull()?.coerceIn(1, 200) ?: 200
                val beforeRowId = args["beforeRowId"]?.jsonPrimitive?.longOrNull
                try {
                    // 体积预算：弱网手机 relay 连接扛不住 ~1MB 物理帧（断连→recover 循环），
                    // 裁到单分片内（384KB 预算≈512KB base64 帧），旧内容由 H5 翻页拉取
                    responder.success(ChValue.Obj(trimRowsRangeResult(client.v4RowsRangePage(sid, beforeRowId, limit))))
                } catch (e: Exception) {
                    responder.error("rowsRange failed: ${e.message?.take(120)}")
                }
            }
            // 计划目录：空合法（此前一直 Method not found 也不阻塞 H5 渲染）
            "conversationPlansV4" -> responder.success(ChValue.Obj(buildJsonObject {
                put("plans", kotlinx.serialization.json.JsonArray(emptyList()))
                put("atSeq", 0)
                put("atLogEpoch", "zcodeidea")
            }))
            // 附件内容分块读（zcode-artifact://<sid>/<name> ref → artifacts 落盘文件）：
            // H5 渲染带图片附件的用户消息必调，Method not found=渲染崩→错误边界黑屏
            //（缺陷FS 八轮）。文件内容为 data URL（IDE 端附件管线落盘形态），按二进制
            // 分块回 {totalBytes, mediaType, dataBase64, nextOffset}。块收敛单片预算内
            //（384KB，多分片 ~1MB 帧手机断连——七轮教训）
            "attachmentReadV4" -> {
                val prefix = "zcode-artifact://"
                val ref = args["ref"]?.jsonPrimitive?.contentOrNull
                    ?: return responder.error("ref required")
                if (!ref.startsWith(prefix)) return responder.error("unsupported ref: ${ref.take(40)}")
                val rel = ref.removePrefix(prefix)
                val slash = rel.indexOf('/')
                if (slash <= 0) return responder.error("malformed ref")
                val refSid = rel.substring(0, slash)
                val refName = rel.substring(slash + 1)
                // 防路径穿越：段内不允许分隔符与 ..
                if (refName.contains('/') || refName.contains("\\") || refName.contains("..")) {
                    return responder.error("malformed ref name")
                }
                val offset = args["offset"]?.jsonPrimitive?.longOrNull ?: 0L
                val requested = args["limit"]?.jsonPrimitive?.longOrNull ?: ROWSRANGE_BUDGET_BYTES.toLong()
                val limit = requested.coerceIn(1L, ROWSRANGE_BUDGET_BYTES.toLong())
                try {
                    val dir = java.nio.file.Path.of(
                        System.getProperty("user.home"), ".zcode", "cli", "artifacts", refSid)
                    val exact = dir.resolve(refName)
                    val file = when {
                        java.nio.file.Files.isRegularFile(exact) -> exact
                        else -> runCatching {
                            java.nio.file.Files.list(dir).use { stream ->
                                stream.filter { p -> p.fileName.toString().endsWith(refName) }
                                    .findFirst().orElse(null)
                            }
                        }.getOrNull()
                    } ?: return responder.error("artifact not found: ${refName.take(60)}")
                    val text = java.nio.file.Files.readString(file)
                    // 落盘形态 data:<mime>;base64,<载荷>
                    val comma = text.indexOf(",") + 1
                    val mime = Regex("^data:([^;,]+)").find(text)?.groupValues?.get(1) ?: "application/octet-stream"
                    val bin = java.util.Base64.getDecoder().decode(text.substring(comma))
                    val total = bin.size
                    val from = offset.coerceIn(0L, total.toLong()).toInt()
                    val to = minOf(total, from + limit.toInt())
                    val chunk = bin.copyOfRange(from, to)
                    val next = if (to >= total) null else to
                    responder.success(ChValue.Obj(buildJsonObject {
                        put("totalBytes", total)
                        put("mediaType", mime)
                        put("dataBase64", java.util.Base64.getEncoder().encodeToString(chunk))
                        if (next != null) put("nextOffset", next) else put("nextOffset", kotlinx.serialization.json.JsonNull)
                    }))
                } catch (e: Exception) {
                    responder.error("attachmentRead failed: ${e.message?.take(120)}")
                }
            }
            "unsubscribeConversationV4" -> {
                val ctx = bridgeContexts[bridgeSessionId] ?: return responder.success(ChValue.Undefined)
                val client = service.appServer(project) ?: return responder.success(ChValue.Undefined)
                val sessionId = args["sessionId"]?.jsonPrimitive?.content ?: return responder.success(ChValue.Undefined)
                val topic = "conversation/$sessionId"
                ctx.subscriptions.remove(topic)?.let {
                    runCatching { client.v4ConversationUnsubscribe(topic, it.subscriptionId, ctx.connectionId) }
                }
                responder.success(ChValue.Undefined)
            }
            "readWorkspaceState" -> {
                // workspace 级状态读取：app-server 无独立 RPC（session/read 需活跃会话），
                // 桥给最小合法应答（slashCommands 空——H5 容错）
                responder.success(ChValue.Obj(buildJsonObject {
                    put("settings", buildJsonObject {})
                    put("slashCommands", kotlinx.serialization.json.JsonArray(emptyList()))
                }))
            }
            "syncAppRuntimePreferences" -> responder.success(ChValue.Undefined)
            "initialize" -> responder.success(ChValue.Obj(buildJsonObject {
                put("available", true)
                put("workspaceKey", args["workspacePath"]?.jsonPrimitive?.content ?: "")
            }))
            "disposeAll" -> {
                clearBridge(bridgeSessionId)
                responder.success(ChValue.Undefined)
            }
            else -> responder.error("Method not found: zcode-agent.$method")
        }
    }

    /**
     * 远程发信成功后就地合成 turn.userInput 注入 IDE 事件面（2026-09-22 真机缺陷）：
     * 手机经 v4/command 发的用户消息在 IDE 侧没有实时气泡通道——乐观回显只在本地发送
     * 路径、v4 实时帧的 userInput 行被主会话 title 门禁丢弃，AI delta 走 legacy 广播正常
     * 而用户消息要等轮末全量重拉才补出。合成事件走 pushStreamEvent 既有门禁（IDE 正订阅
     * 该会话才推），webview turn.userInput 按 messageId 幂等去重，轮末重拉由服务端真身
     * 对账顶替（commandId 命名空间仅存活于回合中窗口）。
     */
    private fun emitRemoteUserBubble(client: ZCodeProtocolClient, envelope: JsonObject) {
        runCatching {
            if (envelope["type"]?.jsonPrimitive?.contentOrNull != "sendText") return
            val sessionId = envelope["sessionId"]?.jsonPrimitive?.contentOrNull ?: return
            val text = (envelope["payload"] as? JsonObject)
                ?.get("text")?.jsonPrimitive?.contentOrNull ?: return
            if (text.isBlank()) return
            client.emitSyntheticEvent(com.zcode.ideaplugin.protocol.model.SessionEvent(
                type = "turn.userInput",
                seq = 0,
                sessionId = sessionId,
                timestamp = System.currentTimeMillis(),
                traceId = null,
                turnId = null,
                deliveryKind = null,
                payload = buildJsonObject {
                    put("messageId", envelope["commandId"]?.jsonPrimitive?.contentOrNull
                        ?: "remote_u_${System.currentTimeMillis()}")
                    put("text", text)
                },
            ))
        }
    }

    /** v4 订阅族 workspace 解析链：project → H5 传参 → bridge-open workspaceKey（空白串视为缺席）。
     *  第三级是挂载目录场景的唯一正确来源，缺了它 v4 水合报 Session not found（见调用处长注） */
    private fun resolveSubscribeWorkspace(
        project: Project?, args: JsonObject, bridgeSessionId: String,
    ): String? =
        project?.basePath
            ?: args["workspacePath"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }
            ?: service.bridgeWorkspaceKey(bridgeSessionId)?.takeIf { it.isNotBlank() }

    // ---- zcode-task：会话操作（经典通道直通） ----

    /** task index 扁平行（桌面 adapter listTasks 返回=task index 原始 meta 透传；
     *  H5 消费 taskId/title/status/workspacePath/createdAt/updatedAt，unreadAt 可选） */
    private fun taskIndexRow(s: com.zcode.ideaplugin.protocol.model.SessionInfo, workspacePath: String) = buildJsonObject {
        put("taskId", s.sessionId)
        put("title", s.title.ifBlank { "session" })
        // 运行中覆写：session/list 快照滞后于回合事件（pushControllerSnapshot 同口径）
        put("status", if (s.status == "running" || service.isSessionRunning(s.sessionId)) "running" else "completed")
        put("workspacePath", (s.workspace?.workspacePath ?: workspacePath).replace('\\', '/'))
        put("workspaceKind", "local")
        put("createdAt", s.createdAt)
        put("updatedAt", s.updatedAt)
        s.archivedAt?.takeIf { it > 0 }?.let { put("archivedAt", it) }
    }

    private fun handleTask(
        project: Project?, bridgeSessionId: String, method: String, args: JsonObject,
        responder: RelayClient.ChannelResponder,
    ) {
        val client = service.appServer(project) ?: return responder.error("app-server unavailable")
        val workspacePath = args["workspacePath"]?.jsonPrimitive?.content ?: project?.basePath ?: ""
        try {
            when (method) {
                "prepareWorkspace" -> responder.success(ChValue.Obj(buildJsonObject {
                    put("workspacePath", workspacePath)
                    put("preparedSessionId", "")
                    put("version", "ZCode Protocol/1")
                    put("provider", "glm")
                    put("configOptions", kotlinx.serialization.json.JsonArray(emptyList()))
                    put("slashCommands", kotlinx.serialization.json.JsonArray(emptyList()))
                }))
                // H5 任务列表消费链（lGt）对 listTasks/listArchivedTasks/listPinnedTasks
                // 期望**裸数组**（t3 包装 items=service 返回值再 .flat()；桌面 adapter 即
                // 返回数组）——回 {items,total,hasMore} 会让 items=undefined → throw
                // "task 行读取不完整"。仅 listTaskList 是 {items,total,hasMore} 分页形状。
                // 行内 workspacePath 统一正斜杠：H5 kFe 按当前工作区（basePath 正斜杠）
                // 严格字符串匹配，反斜杠（app-server 返回）全被滤掉=列表 0
                "listTaskList" -> {
                    val sessions = runCatching { client.listSessions(workspacePath) }.getOrDefault(emptyList())
                    // 归档/软删过滤（IDE 历史列表同口径）：session/list 不认 tasks-index 归档
                    val hidden = runCatching { client.hiddenSessionIds() }.getOrDefault(emptySet())
                    val tasks = sessions.filter { it.status != null && it.sessionId !in hidden }
                        .sortedByDescending { it.updatedAt }
                        .take(ZCodeRemoteService.TASK_SNAPSHOT_LIMIT)
                        .map { s -> taskIndexRow(s, workspacePath) }
                    responder.success(ChValue.Obj(buildJsonObject {
                        put("items", kotlinx.serialization.json.JsonArray(tasks))
                        put("total", tasks.size)
                        put("hasMore", false)
                    }))
                }
                // H5 任务列表三源 merge（lGt）：listTasks/listArchivedTasks/listPinnedTasks
                // 任一 reject 即 throw"tasks-index task 行读取不完整"→ 任务区域错误边界
                //（2026-08-25 装机日志定案）。归档源走 app-server 归档列表（与主列表同源过滤）
                // 大会话库限流：只下发最近 TASK_SNAPSHOT_LIMIT 条（全量 500+ 行打爆 H5 手机端）
                "listTasks" -> responder.success(ChValue.Obj(kotlinx.serialization.json.JsonArray(
                    runCatching { client.listSessions(workspacePath) }.getOrDefault(emptyList())
                        .filter { it.status != null }
                        .let { list ->
                            val hidden = runCatching { client.hiddenSessionIds() }.getOrDefault(emptySet())
                            if (hidden.isEmpty()) list else list.filter { it.sessionId !in hidden }
                        }
                        .sortedByDescending { it.updatedAt }
                        .take(ZCodeRemoteService.TASK_SNAPSHOT_LIMIT)
                        .map { s -> taskIndexRow(s, workspacePath) }
                )))
                "listArchivedTasks" -> responder.success(ChValue.Obj(kotlinx.serialization.json.JsonArray(
                    runCatching { client.listArchivedSessions(workspacePath) }.getOrDefault(emptyList())
                        .map { s -> taskIndexRow(s, workspacePath) }
                )))
                "listPinnedTasks" -> responder.success(
                    ChValue.Obj(kotlinx.serialization.json.JsonArray(emptyList())),
                )
                // 可选源（H5 失败容错）：空应答消噪
                "listPinnedTaskIds", "listDeletedTaskIds" -> responder.success(
                    ChValue.Obj(kotlinx.serialization.json.JsonArray(emptyList())),
                )
                "createTask" -> {
                    val sid = client.createSession(
                        com.zcode.ideaplugin.protocol.model.Workspace(workspacePath),
                        com.zcode.ideaplugin.protocol.model.PermissionMode.BUILD,
                    )
                    responder.success(ChValue.Obj(buildJsonObject { put("taskId", sid); put("sessionId", sid) }))
                }
                "sendPrompt" -> {
                    val sessionId = args["taskId"]?.jsonPrimitive?.content
                        ?: args["sessionId"]?.jsonPrimitive?.content
                        ?: return responder.error("taskId required")
                    val content = args["content"]?.jsonPrimitive?.content
                        ?: return responder.error("content required")
                    // 主链路同款时序：先 subscribe 再 send（send 对未激活会话撞 -32004）
                    runCatching { client.subscribe(sessionId) }
                    client.send(sessionId, content)
                    responder.success(ChValue.Obj(buildJsonObject { put("ok", true) }))
                }
                "stopGeneration" -> {
                    val sessionId = args["taskId"]?.jsonPrimitive?.content ?: return responder.error("taskId required")
                    client.stop(sessionId)
                    responder.success(ChValue.Undefined)
                }
                "closeTask" -> {
                    val sessionId = args["taskId"]?.jsonPrimitive?.content ?: return responder.success(ChValue.Undefined)
                    runCatching { client.closeSession(sessionId) }
                    responder.success(ChValue.Undefined)
                }
                "getTaskMeta" -> responder.success(ChValue.Obj(Json.parseToJsonElement("null")))
                // 会话文件路径类查询（官方形状）：exists=false 走 H5「无文件」容错分支
                "getTaskSessionFilePath" -> responder.success(ChValue.Obj(buildJsonObject {
                    val tid = args["taskId"]?.jsonPrimitive?.contentOrNull ?: ""
                    put("path", "$workspacePath/$tid.zcode-session")
                    put("exists", false)
                }))
                "getTaskNativeSessionLogFile" -> responder.success(ChValue.Obj(buildJsonObject {
                    put("provider", "glm"); put("path", ""); put("exists", false)
                }))
                // 官方形状 {provider, path, exists}（asar 实测）：path=请求的 workspacePath
                "getWorkspaceProviderConfigFile" -> responder.success(ChValue.Obj(buildJsonObject {
                    put("provider", "glm")
                    put("path", workspacePath)
                    put("exists", false)
                }))
                "getTaskSnapshot", "getTaskSnapshotWithEtag" -> {
                    // 快照读取：v4 initial 帧（订阅时事件泵已推）承担实时态；此处给最小合法空快照
                    responder.success(ChValue.Obj(buildJsonObject { put("snapshot", Json.parseToJsonElement("null")) }))
                }
                "renameTask" -> responder.success(ChValue.Undefined) // 标题落库由 tasks-index 维护，桥不透写
                // H5 切模型后的工作区进程重启请求：app-server 进程由 ZCodeService 管理，
                // 模型切换即时生效无需重启，回成功打通切换链
                "restartWorkspaceProcess" -> responder.success(ChValue.Obj(buildJsonObject { put("ok", true) }))
                else -> responder.error("Method not found: zcode-task.$method")
            }
        } catch (e: Exception) {
            responder.error("${method} failed: ${e.message?.take(150)}")
        }
    }

    // ---- zcode-session ----

    private fun handleSession(project: Project?, method: String, args: JsonObject, responder: RelayClient.ChannelResponder) {
        val client = service.appServer(project) ?: return responder.error("app-server unavailable")
        try {
            when (method) {
                "readSession" -> {
                    val sid = args["sessionId"]?.jsonPrimitive?.content ?: return responder.error("sessionId required")
                    // H5 固定带 messageLimit（官方语义 slice(-t)，zcode.cjs Gpa 定案）；
                    // 此前忽略返回全量（9.7MB 压垮 H5 / 93 条渲染异常，缺陷V）
                    val limit = args["messageLimit"]?.jsonPrimitive?.contentOrNull?.toIntOrNull()
                    val state = client.readSessionFull(sid, messageLimit = limit)
                    // 体积兜底（单条超大消息仍可能超 H5 承受）
                    responder.success(ChValue.Obj(trimSessionMessages(state)))
                }
                // H5 输入框渲染依赖：官方 readWorkspaceState = workspace/readState 应答
                // 形状 {workspacePath, preparedSessionId, version, provider, configOptions,
                // slashCommands}（asar host readWorkspaceState 定案）。此前 stub 回
                // {settings:{}} 导致模型选择器/输入框不渲染（2026-08-25 真机 HAR）
                "readWorkspaceState" -> {
                    val wsPath = args["workspacePath"]?.jsonPrimitive?.contentOrNull
                        ?: project?.basePath ?: return responder.error("workspacePath required")
                    val state = client.workspaceReadState(Workspace(wsPath))
                    val settings = state["settings"]?.jsonObject ?: JsonObject(emptyMap())
                    responder.success(ChValue.Obj(buildJsonObject {
                        put("workspacePath", wsPath)
                        put("preparedSessionId", "")
                        put("version", "ZCode Protocol/1")
                        put("provider", "glm")
                        put("configOptions", buildRemoteConfigOptions(settings))
                        put("slashCommands", state["slashCommands"]
                            ?: kotlinx.serialization.json.JsonArray(emptyList()))
                    }))
                }
                // workspace 呈现直透（{workspace, mode, slashCommands}）：H5 每次进工作区
                // 必调，此前 Method not found 靠容错活着
                "readWorkspacePresentation" -> {
                    val wsPath = args["workspacePath"]?.jsonPrimitive?.contentOrNull
                        ?: args["workspace"]?.jsonObject?.get("workspacePath")?.jsonPrimitive?.contentOrNull
                        ?: project?.basePath
                        ?: return responder.error("workspacePath required")
                    try {
                        responder.success(ChValue.Obj(client.workspaceReadPresentation(Workspace(wsPath))))
                    } catch (e: Exception) {
                        responder.error("readPresentation failed: ${e.message?.take(100)}")
                    }
                }
                // H5 发送前设默认模型（model:{providerId, modelId…}）；app-server 无
                // workspace 级 setModel RPC，桥回成功打通发送链（会话实际模型由
                // session/setModel 与 send 上下文决定）
                "setWorkspaceDefaultModel" -> responder.success(ChValue.Obj(buildJsonObject {}))
                "closeSession" -> {
                    val sid = args["sessionId"]?.jsonPrimitive?.content ?: return responder.success(ChValue.Undefined)
                    runCatching { client.closeSession(sid) }
                    responder.success(ChValue.Undefined)
                }
                else -> responder.error("Method not found: zcode-session.$method")
            }
        } catch (e: Exception) {
            responder.error("${method} failed: ${e.message?.take(120)}")
        }
    }

    // ---- window-controller：自聚合 controller 帧 ----

    private fun handleWindowController(project: Project?, bridgeSessionId: String, method: String, args: JsonObject, responder: RelayClient.ChannelResponder) {
        when (method) {
            "subscribeControllerV4" -> {
                val topic = args["topic"]?.jsonPrimitive?.content ?: return responder.error("topic required")
                val subId = "wc-${java.util.UUID.randomUUID().toString().take(13)}"
                // 登记：回合翻转时 ZCodeRemoteService 按此重推快照帧（H5 列表实时相位）
                service.registerControllerSub(subId, bridgeSessionId, topic)
                // ack：{subscriptionId, mode, logEpoch}（对齐 app-server ack 形状）
                responder.success(ChValue.Obj(buildJsonObject {
                    put("ack", buildJsonObject {
                        put("subscriptionId", subId)
                        put("mode", "snapshot")
                        put("logEpoch", "zcodeidea")
                    })
                }))
                // 立即推 initial 快照帧（EventFire）——task 列表当前值
                service.pushControllerSnapshot(bridgeSessionId, subId, topic)
            }
            else -> responder.error("Method not found: window-controller.$method")
        }
    }

    private fun argJson(value: ChValue): JsonObject? = when (value) {
        is ChValue.Obj -> value.json as? JsonObject
        else -> null
    }
}
