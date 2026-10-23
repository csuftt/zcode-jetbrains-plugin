package com.zcode.ideaplugin

import com.zcode.ideaplugin.protocol.LogRedactor

import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.zcode.ideaplugin.protocol.Credentials
import com.zcode.ideaplugin.protocol.ProxyConfig
import com.zcode.ideaplugin.protocol.ZcGuiConfig
import com.zcode.ideaplugin.protocol.ZCodeProtocolClient
import com.zcode.ideaplugin.ui.ZCodeNotifyService
import com.zcode.ideaplugin.ui.ZCodeToolWindowPanel
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * ZCode 项目级服务实现
 *
 * 管理协议客户端（全局一个 app-server 子进程）与多个标签面板（多标签页）。
 * 用 @Service 注解（现代方式），不在 plugin.xml 里声明。
 */
@Service(Service.Level.PROJECT)
class ZCodeServiceImpl(private val project: Project) : ZCodeService, com.intellij.openapi.Disposable {

    /** 所属项目（手机远程桥做 bridge→project 路由用） */
    val ownerProject: Project get() = project

    private val log = com.intellij.openapi.diagnostic.Logger.getInstance("ZCodePlugin")

    companion object {
        /**
         * workspace-config topic 帧分拣（纯函数，单测覆盖）：快照帧取 payload.snapshot.config、
         * 增量帧取 op=config.updated 的 config（整体替换语义，conflated 最新态——一帧多个
         * delta 取末个）；其余 kind/未知 op 一律跳过（v3.14.3 容错原则：discriminatedUnion
         * 扩 op 是常态，未知成员不得炸整帧）。非本 topic 或无 config 返回 null。
         */
        internal fun extractWorkspaceConfigState(params: JsonObject): JsonObject? {
            val topic = params["topic"]?.jsonPrimitive?.contentOrNull ?: return null
            if (!topic.startsWith("workspace-config/")) return null
            val payload = params["frame"]?.jsonObject?.get("payload")?.jsonObject ?: return null
            return when (payload["kind"]?.jsonPrimitive?.contentOrNull) {
                "snapshot" -> payload["snapshot"]?.jsonObject?.get("config") as? JsonObject
                "deltas", "delta" -> {
                    val deltas = payload["deltas"]?.jsonArray ?: return null
                    var cfg: JsonObject? = null
                    for (d in deltas) {
                        val o = d as? JsonObject ?: continue
                        if (o["op"]?.jsonPrimitive?.contentOrNull == "config.updated") {
                            (o["config"] as? JsonObject)?.let { cfg = it }
                        }
                    }
                    cfg
                }
                else -> null
            }
        }

        /**
         * interaction/requestUserInput 应答是否按 decline 处理（纯函数，单测覆盖）：
         * 显式 decline/cancel；或 ExitPlanMode 审批的 accept 但 answer 为空——
         * 空反馈 ≠ 批准，旧版 normalize 成 "approve" 会在前端防线失守（旧 webview
         * 产物/回归）时把"用户没说批准"变成"批准执行"（2026-08-20 实测）。
         * AskUserQuestion 的空答案不在此列（透传，服务端自行处理）。
         */
        internal fun isDeclineResponse(isPlanApproval: Boolean, action: String, answer: JsonElement?): Boolean {
            val emptyAnswer = answer == null ||
                (answer is JsonPrimitive && answer.contentOrNull.isNullOrBlank())
            return action == "decline" || action == "cancel" || (isPlanApproval && emptyAnswer)
        }

        /**
         * interaction/requestPermission 应答构建（纯函数，单测覆盖）：
         * 用户选中项的 response 原样回传——allow_project 的 permissionUpdates
         * （本项目规则）由服务端生成，宿主不自行构造。缺 optionId / 未知 optionId /
         * options 里无对应项时安全侧 deny（对齐 zcode.cjs v4AnswerToPermissionResponse
         * 的兜底语义；"允许一次" 的兜底为 {decision:"allow"}）。
         */
        internal fun buildPermissionResult(options: JsonArray, action: String, answer: JsonElement?): JsonObject {
            val optionId = if (action == "decline" || action == "cancel") null
            else (answer as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
            val chosen = optionId?.let { oid ->
                options.filterIsInstance<JsonObject>().firstOrNull {
                    it["optionId"]?.jsonPrimitive?.contentOrNull == oid
                }
            }
            (chosen?.get("response") as? JsonObject)?.let { return it }
            return if (optionId == "allow_once") {
                buildJsonObject { put("decision", "allow"); put("reason", "Approved once") }
            } else {
                buildJsonObject { put("decision", "deny"); put("reason", "Denied") }
            }
        }

        /**
         * 回合匹配判据（废弃清理/请求合并共用，纯函数单测覆盖）：双方 turnId 已知
         * 且不同 → 属于不同回合；任一方未知（null，params 缺省/终止事件未带）→
         * 保守视为同回合，保持旧的会话级清理/共享能力
         */
        internal fun sameTurn(a: String?, b: String?): Boolean =
            a == null || b == null || a == b

        /**
         * 回合收尾通知的延迟弹窗口（issue #24 误报修复）：轮末排队消息 flush 后
         * 立刻开新回合，立即弹「任务完成」在用户视角是误报。延迟窗口内同会话
         * turn.started 到达即取消通知（压缩回合的延迟 flush 最长 1.5s 兜底，3s 足够覆盖）。
         */
        internal const val TURN_END_NOTIFY_DELAY_MS = 3_000L

        /**
         * 等待输入通知的正文摘要（纯函数，单测覆盖，issue #24）：
         * 计划审批取 input.plan、提问取 questions 第一项的 question、权限审批取
         * toolName 与 reason 拼接（中性分隔符，bundle 多语言共用）。取不到返回
         * null，通知层回 bundle 兜底文案。
         */
        internal fun pendingInputPreview(
            kind: com.zcode.ideaplugin.ui.ZCodeNotifyService.PendingInputKind,
            toolName: String?,
            params: JsonObject,
        ): String? = when (kind) {
            com.zcode.ideaplugin.ui.ZCodeNotifyService.PendingInputKind.PLAN_APPROVAL ->
                (params["input"] as? JsonObject)?.get("plan")
                    ?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }
            com.zcode.ideaplugin.ui.ZCodeNotifyService.PendingInputKind.ASK_USER ->
                (params["questions"] as? JsonArray)?.filterIsInstance<JsonObject>()
                    ?.firstNotNullOfOrNull { it["question"]?.jsonPrimitive?.contentOrNull?.takeIf { q -> q.isNotBlank() } }
            com.zcode.ideaplugin.ui.ZCodeNotifyService.PendingInputKind.PERMISSION -> {
                val reason = params["reason"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }
                val name = toolName?.takeIf { it.isNotBlank() }
                when {
                    name != null && reason != null -> "$name - $reason"
                    name != null -> name
                    else -> reason
                }
            }
        }

        /** 活跃 Service 实例（多项目并开各一个）；宿主探针聚合判定用，dispose 移除 */
        private val activeInstances = java.util.concurrent.CopyOnWriteArrayList<ZCodeServiceImpl>()

        /** 跨项目广播到全部面板（手机远程等 APPLICATION 级服务调用） */
        fun broadcastToAllPanels(msg: kotlinx.serialization.json.JsonObject) {
            activeInstances.forEach { instance ->
                instance.panels.forEach { panel ->
                    runCatching { panel.pushToWebview(msg) }
                }
            }
        }

        /** 活跃 Service 实例快照（手机远程桥取各项目 app-server 用） */
        fun activeProjectServices(): List<ZCodeServiceImpl> = activeInstances.toList()

        /**
         * 手机远程 model-selection 视图数据源：任一活跃面板的 listModels 口径
         * （与 IDE 输入框下拉同源——账号渠道+自定义渠道）。无活跃面板返回 null，
         * 调用方走 config.json 直读兜底。
         */
        fun modelsListFromAnyPanel(): kotlinx.serialization.json.JsonObject? =
            activeInstances.firstOrNull()?.panels?.firstOrNull()?.let { panel ->
                runCatching { panel.buildModelsListForBridge() }.getOrNull()
            }

        /**
         * interaction/requestUserInput 等待用户
         * 应答的超时：超时自动 decline 并关弹窗。仅普通提问（「提问自动继续」开）与
         * 权限审批使用；ExitPlanMode 审批无超时（不推 deadlineMs，future 无限等）。
         * 推送弹窗时随消息附带 deadlineMs（= 当前时刻 + 本值），前端据此显示倒计时
         * ——两处必须同源，防显示与实际超时错位。
         */
        const val USER_INPUT_TIMEOUT_MS = 5 * 60 * 1000L

        /**
         * 回合终止废弃哨兵：abortPendingUserInputs complete 到 future 的标记值，
         * handler 透传给协议层后转 JSON-RPC error 应答（请求失败语义，非用户拒绝，
         * 不污染服务端权限状态机）。协议层与服务层约定字段名
         */
        const val DISCARD_MARKER = "__zcodeDiscard"
    }

    init {
        activeInstances.add(this)
        // browser-use 宿主探针注入 EnvChecker（环境自检第四项，非阻断）。
        // 闭包不捕获实例、读活跃实例聚合（多项目并开时任一实例健康即健康，
        // 避免后开项目覆盖先开项目、dispose 后悬垂引用）：
        // - 全部实例的 app-server 未拉起 → null（未初始化，不评判）
        // - 有实例已拉起但 handler 未注册 → CODE_HANDLER_MISSING
        // - JCEF 已起但 CDP 调试端口不可达 → CODE_CEF_DOWN（宿主浏览器能力废）
        com.zcode.ideaplugin.env.ZCodeEnvChecker.setBrowserHostProbe {
            val live = activeInstances.filter { it.isStarted() }
            when {
                live.isEmpty() -> null
                live.any { !it.browserHandlerRegistered } -> com.zcode.ideaplugin.env.BrowserHostStatus(
                    false, "app-server 已启动但 browser-use 宿主 handler 未注册",
                    com.zcode.ideaplugin.env.BrowserHostStatus.CODE_HANDLER_MISSING,
                )
                com.intellij.ui.jcef.JBCefApp.isStarted() &&
                    !com.zcode.ideaplugin.ui.ZCodeBrowserExecutor.hasReachableCdpEndpoint() ->
                    com.zcode.ideaplugin.env.BrowserHostStatus(
                        false, "JCEF 已启动但 CDP 调试端口不可达",
                        com.zcode.ideaplugin.env.BrowserHostStatus.CODE_CEF_DOWN,
                    )
                else -> com.zcode.ideaplugin.env.BrowserHostStatus(true, null)
            }
        }
        // CDP 实际端点探针（设置页 CDP 输入框未配置时回显生效文件，CLI 路径同款逻辑）
        com.zcode.ideaplugin.env.ZCodeEnvChecker.setCdpEndpointProbe {
            com.zcode.ideaplugin.ui.ZCodeBrowserExecutor.activeCdpEndpoint()?.let { (f, port) ->
                com.zcode.ideaplugin.env.CdpEndpointStatus(f.absolutePath, port)
            }
        }
    }

    @Volatile
    private var client: ZCodeProtocolClient? = null

    /** 会话驻留水位账本（与 app-server 进程同生命周期，换代即清，见 ResidentLedger）*/
    override val residentLedger = com.zcode.ideaplugin.ui.ResidentLedger()

    /**
     * 代理保存后尚未重启过 app-server（issue #12 设置页「重启生效」提示的权威判据）。
     * 保存代理时置 true；新 client 拉起时清 false（新进程已带新 env）。不能用
     * isStarted() 凑数——那只表示进程活着，恒真，会让提示常驻（首版实踩）。
     */
    @Volatile
    override var proxyRestartPending: Boolean = false

    private val lock = ReentrantLock()

    /** 所有已注册面板（多标签页，每个标签一个）*/
    private val panels = java.util.concurrent.CopyOnWriteArrayList<ZCodeToolWindowPanel>()

    /** 当前激活面板（标签切换时更新；外部推送与 askUser fallback 的目标）*/
    @Volatile
    private var activePanel: ZCodeToolWindowPanel? = null

    // ============ 全局共享内嵌浏览器（跨会话标签，协议单一 idea-iab）============
    @Volatile
    private var sharedBrowserPanel: com.zcode.ideaplugin.ui.ZCodeBrowserPanel? = null

    /** 浏览器当前挂载（分栏展开）的面板；收起时保留 owner（实例与页面常驻）*/
    @Volatile
    private var embeddedBrowserOwner: ZCodeToolWindowPanel? = null

    /**
     * 浏览器是否已弹出到独立窗口。弹出 = 面板从侧栏分栏摘出、装进 [browserDetachWindow]：
     * JCEF reparent 下页面与 CDP target 不销毁，AI 操作零中断。
     */
    @Volatile
    private var browserDetached = false

    /** 浏览器独立窗口（搬运式弹出；仅 EDT 访问）*/
    private var browserDetachWindow: com.zcode.ideaplugin.ui.BrowserDetachWindow? = null

    // ============ AskUserQuestion / ExitPlanMode 协调（跨标签共享）============
    // 协议客户端的 userInputRequestHandler 是单例，必须全局只注册一次。
    // serverRequestId → 等待项：前端用户选择后 complete future。
    // 服务端对未应答的 interaction/requestUserInput 会指数退避重发（新 id、同内容），
    // 重试 id 通过 contentKey 识别后共享同一 future：用户应答一次、所有 id 同时应答，
    // 不重复弹窗（保持用户已选状态）。
    private class PendingUserInput(
        val contentKey: String,
        val future: CompletableFuture<JsonObject>,
        val targetPanel: ZCodeToolWindowPanel?,
        /** 请求归属会话（params 可缺省为 null）；turn 终止/stop 按会话定向废弃用 */
        val sessionId: String?,
        /**
         * interaction/requestPermission 的选项列表（含每项的 response 应答体）；
         * askUser/ExitPlanMode 路径为 null。非 null 即权限审批请求，
         * completeUserInput 按 kind=permission 构建 result
         */
        val options: JsonArray? = null,
        /** 服务端权限族 id（params.requestId，perm_*）：同族重发恒同值、新请求新值 */
        val familyId: String? = null,
        /** 请求所属回合（params.turnId，服务端权威）：回合终止废弃按回合精确匹配，
         *  防迟到的旧回合终止事件误杀同会话新回合刚弹出的审批窗。null=服务端未带
         *  （异常形态），匹配时保守按会话处理 */
        val turnId: String? = null,
    )

    /** 族应答缓存条目：permission 请求已给服务端的最终应答（用户选择/超时 deny）*/
    private class FamilyAnswer(val result: JsonObject, val at: Long)

    private val pendingUserInputs = ConcurrentHashMap<String, PendingUserInput>()

    /**
     * permission 族应答缓存（familyId → 最终应答）。服务端对权限请求的重发**无上限**
     * （实测 10s 间隔持续 6 分钟+），且插件超时/应答后 pending 即清——迟到重发会被
     * contentKey 去重当作新请求**重新弹窗**（2026-08-26 实测：server-76 复活弹窗
     * 61 秒后被 turn 终止废弃，用户视角=「弹窗刚出来就消失」）。缓存后迟到重发直接
     * 回已给应答：服务端族定时器收到有效应答才收敛，且不重复打扰用户。
     */
    private val familyAnswers = ConcurrentHashMap<String, FamilyAnswer>()

    @Volatile
    private var userInputHandlerRegistered = false

    @Volatile
    private var permissionHandlerRegistered = false

    // ============ 对话结束提醒（ZCodeNotifyService；手动 stop 不打扰）============

    /** 手动 stop 标记：sessionId → stop 时刻（handleStop 成功后写入，收尾事件 30s 内匹配即跳过提醒）*/
    private val manualStopMarks = ConcurrentHashMap<String, Long>()

    /** 已提醒过的回合收尾（防 deliveryKind 重投重复提醒）：turnKey → 时刻 */
    private val notifiedTurnEnds = ConcurrentHashMap<String, Long>()

    /**
     * 收尾通知延迟调度（issue #24 误报修复）：turn.completed 到达不立即弹，见
     * TURN_END_NOTIFY_DELAY_MS。挂起任务按 sessionId 记账，同会话 turn.started
     * 到达即取消；put 覆盖前先 cancel 防旧任务漏网
     */
    private val pendingTurnEndNotify =
        ConcurrentHashMap<String, java.util.concurrent.ScheduledFuture<*>>()

    /** 收尾通知调度器（daemon 单线程，项目 dispose 时关闭）*/
    private val notifyScheduler = java.util.concurrent.Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "ZCode-TurnEndNotify").apply { isDaemon = true }
    }

    /** handleStop 成功停止后标记（对齐 cc-gui isManuallyInterrupted：手动打断不提醒）*/
    override fun markManualStop(sessionId: String) {
        manualStopMarks[sessionId] = System.currentTimeMillis()
    }

    /** 回合收尾提醒（全局事件线程调用；异常不影响事件链路）*/
    private fun notifyTurnEndIfWanted(event: com.zcode.ideaplugin.protocol.model.SessionEvent) {
        try {
            // 子代理会话（sess_subagent_*）不提醒（缺陷DZ）：子代理是主回合内的执行
            // 单元，它的收尾不是「任务完成」——主回合还在跑，主回合收尾另有自己的终态帧。
            // 判据与 remote 推送/会话列表过滤同款前缀
            if (com.zcode.ideaplugin.ui.ZCodeNotifyService.isSubagentSession(event.sessionId)) return
            val now = System.currentTimeMillis()
            // resume/回放的旧事件不提醒（timestamp 距今超 5 分钟视为回放帧）
            if (event.timestamp in 1..(now - 5 * 60_000L)) return
            val stopMark = manualStopMarks[event.sessionId]
            if (stopMark != null && now - stopMark < 30_000L) {
                manualStopMarks.remove(event.sessionId)
                return
            }
            val turnKey = "${event.sessionId}|${event.turnId ?: event.seq}"
            if (notifiedTurnEnds.putIfAbsent(turnKey, now) != null) return
            if (notifiedTurnEnds.size > 64) {
                notifiedTurnEnds.entries.removeIf { now - it.value > 60_000L }
            }
            val failed = event.type == "turn.failed"
            val body = if (failed) {
                (event.payload["error"] as? JsonObject)?.get("message")?.jsonPrimitive?.contentOrNull
            } else {
                (event.payload["response"] as? JsonPrimitive)?.contentOrNull
            }
            // 延迟弹（issue #24 误报修复）：轮末排队消息 flush 后立刻开新回合，
            // 立即弹「已完成」在用户视角=任务没完却报完成。延迟窗口内同会话
            // turn.started 到达即取消（全局监听器）；窗口内手动 stop 在任务里二次豁免
            val sid = event.sessionId
            pendingTurnEndNotify.remove(sid)?.cancel(false)
            pendingTurnEndNotify[sid] = notifyScheduler.schedule({
                pendingTurnEndNotify.remove(sid)
                try {
                    val sm = manualStopMarks[sid]
                    if (sm != null && System.currentTimeMillis() - sm < 30_000L) {
                        manualStopMarks.remove(sid)
                        return@schedule
                    }
                    com.zcode.ideaplugin.ui.ZCodeNotifyService.notifyTurnEnd(project, sid, body, failed)
                } catch (e: Exception) {
                    log.warn("Turn-end notification failed: ${e.message}")
                }
            }, TURN_END_NOTIFY_DELAY_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
        } catch (e: Exception) {
            log.warn("Turn-end notification failed: ${e.message}")
        }
    }

    override fun getClient(): ZCodeProtocolClient {
        client?.let { if (it.isAlive()) return it }
        return lock.withLock {
            client?.let { if (it.isAlive()) return it }
            // 环境检测（node/zcode.cjs/凭证）由 EnvChecker 解析：配置路径优先 → 自动探测；
            // node/cli 失败抛 EnvCheckException（带 EnvStatus），Panel 层转成前端可识别的环境错误；
            // 凭证失败降级（credentials=null 裸启，走 app-server 自身凭证链，issue #4）
            val env = com.zcode.ideaplugin.env.ZCodeEnvChecker.resolveForStart()
            // CLI 同级 provider 垫底：AppImage/deb 形态 zcode-builtin.json 缺失即秒退
            // （CLI 自检无环境变量入口，只能落盘补；失败降级 warn 不阻断，见类注释）
            com.zcode.ideaplugin.env.ZCodeProviderBootstrap.ensureBuiltinProvider(env.zcodePath)
            val newClient = ZCodeProtocolClient.start(
                zcodePath = env.zcodePath,
                credentials = env.credentials,
                nodePath = env.nodePath,
            )
            // 代理注入权威日志（issue #12 排障主入口，确定落 idea.log；userinfo 已脱敏）：
            // 「消息发不通」时先查这行——有 proxy= 说明注入生效（问题在网络/代理本身），
            // <no proxy, direct> 说明走直连（问题在配置没保存/没重启）
            log.info("[proxy] app-server ${newClient.proxyConfig?.logSummary ?: ProxyConfig().logSummary}")
            // requestRuntimePreferences 应答：memoryEnabled / nativeSearchEnhancementsEnabled
            // 与 ZCode 客户端共用 ~/.zcode/v2/setting.json（设置页「工作区记忆」开关写的也是
            // 这份）。每次应答即时读文件——切换开关后新建会话立即生效，无需重启 app-server；
            // memoryEnabled=false 时 CLI 强制 memory:{enabled:false}，MEMORY.md 自动记忆不注入
            // 上下文。「提问自动继续」是插件自有配置（ZCodeAskUserConfig，默认关=一直等待），
            // 透传给服务端让自动继续行为与插件本地超时同一开关、同一语义
            newClient.runtimePreferencesResponder = { _, _ ->
                val p = com.zcode.ideaplugin.ui.ZCodeClientSettingStore.readRuntimePrefs()
                com.zcode.ideaplugin.protocol.model.RuntimePreferences(
                    nativeSearchEnhancementsEnabled = p.nativeSearchEnhancementsEnabled,
                    memoryEnabled = p.memoryEnabled,
                    askUserQuestionAutoResolutionEnabled =
                        com.zcode.ideaplugin.ui.ZCodeAskUserConfig.readConfig().autoContinueEnabled,
                )
            }
            // 待交互计数（审批/提问挂起数）→ 所有已开标签红点（SessionItem badge）。
            // 回调在 reader/worker 线程触发，广播函数内部自切 EDT
            newClient.onPendingInteractionsChanged = { counts ->
                val countsJson = buildJsonObject {
                    counts.forEach { (sid, n) -> put(sid, n) }
                }
                com.zcode.ideaplugin.ui.ZCodeToolWindowPanel.broadcastPendingInteractions(countsJson)
            }
            client = newClient
            // 新 app-server 进程的驻留集合从零开始：账本与提醒状态一并重置
            residentLedger.invalidateAll()
            // 新进程 spawn 已带上当时的代理 env：保存待重启的提示随之解除
            proxyRestartPending = false
            // 协议就绪即注册反向请求 handler（幂等）。注册点放在这里而非仅面板初始化：
            // 面板初始化时环境未就绪会抛 EnvCheckException 跳过注册，若不在此补注册，
            // 用户配好环境后 handler 永远缺席（Mac 首启 PATH 探测失败即触发过）
            registerProtocolHandlersLocked(newClient)
            hookSessionsIndex(newClient)
            hookWorkspaceConfig(newClient)
            // app-server 新进程就绪即补扫自动归档（缺陷BH）：调度器已随项目启动（eager init）
            // 但客户端可能晚起，此处保证「客户端一起来 15s 内必有一轮」，不必等 30min 周期或
            // 归档 tab 打开。扫描内部 isStarted 短路，不会递归拉起新进程；只在新进程构造路径
            // 触发（存量 client 的 getClient 快路径不经此处），无重入风险
            try {
                com.zcode.ideaplugin.ui.ZCodeAutoArchiveService.getInstance(project).sweepAfterClientReady()
            } catch (e: Exception) {
                log.warn("[auto-archive] client-ready sweep trigger failed: ${e.message}")
            }
            newClient
        }
    }

    /**
     * 在刚启动的 client 上注册反向请求 handler（幂等，可在任何 getClient 成功后调用）。
     * 不调用 getClient（防重入），不抛异常（注册失败仅记日志，不影响协议链路）。
     */
    private fun registerProtocolHandlersLocked(c: ZCodeProtocolClient) {
        try {
            if (!userInputHandlerRegistered) {
                c.userInputRequestHandler = { serverRequestId, params ->
                    handleUserInputRequest(serverRequestId, params)
                }
                userInputHandlerRegistered = true
                log.info("[askUser] userInputRequestHandler registered at Service level (shared across tabs)")
            }
            // 工具权限审批（interaction/requestPermission）：default 模式写文件/命令前
            // 的批准请求。与 userInputRequestHandler 同为单例、同在 getClient 成功后幂等注册
            if (!permissionHandlerRegistered) {
                c.permissionRequestHandler = { serverRequestId, params ->
                    handlePermissionRequest(serverRequestId, params)
                }
                permissionHandlerRegistered = true
                log.info("[permission] interaction/requestPermission handler registered at Service level")
            }
            // 回合终止联动废弃待应答弹窗：挂起的反向请求随回合而生，回合死了弹窗即死
            // （服务端对未应答权限请求重试到头会自行放弃并 failed 收尾，插件此前无感知，
            // 死弹窗留到 5 分钟超时批量 decline——迟到应答风暴即 P3/P4 污染源）。
            // 按 (sessionId, turnId) 定向废弃：双会话并发时 A 会话收尾不误伤 B 会话挂起
            // 的弹窗；同会话内旧回合终止事件晚到时（工具超时重试的竞态窗口），turnId
            // 不匹配保住新回合刚弹出的弹窗（2026-08-27 实测：重试弹窗被迟到清理顶掉）。
            // 正常应答路径 pending 已清空，此处 no-op 无副作用
            c.addGlobalEventListener { event ->
                // 回合相位 → 所有标签的会话列表行（手机远程驱动的会话在 IDE 无本地
                // streaming 状态，列表只能靠这个实时通道翻转运行中/复位，官方桌面同语义）
                when (event.type) {
                    // 标题实时入缓存（缺陷DZ）：AI 自动生成标题/手动改名后，轮末通知
                    // 的「会话名」前缀才能跟上最新值（历史列表批量刷新只兜住静态面）
                    "session.titleUpdated" -> {
                        val t = event.payload["title"]?.jsonPrimitive?.contentOrNull
                        if (!t.isNullOrBlank()) sessionTitleCache[event.sessionId] = t
                    }
                    "turn.started" -> {
                        com.zcode.ideaplugin.ui.ZCodeToolWindowPanel
                            .broadcastTurnPhase(event.sessionId, "running")
                        // 手机 H5 首页任务行同源相位（运行集合覆写 + 防抖重推快照帧）
                        runCatching { com.zcode.ideaplugin.remote.ZCodeRemoteService.getInstance()
                            .onSessionTurnPhase(event.sessionId, true) }
                    }
                    "turn.completed", "turn.failed" -> {
                        com.zcode.ideaplugin.ui.ZCodeToolWindowPanel
                            .broadcastTurnPhase(event.sessionId, "ended")
                        runCatching { com.zcode.ideaplugin.remote.ZCodeRemoteService.getInstance()
                            .onSessionTurnPhase(event.sessionId, false) }
                    }
                }
                if (event.type == "turn.started") {
                    // 轮末排队消息 flush 开的新回合（issue #24 误报修复）：
                    // 取消刚挂起的「任务完成」通知——任务还在继续
                    pendingTurnEndNotify.remove(event.sessionId)?.cancel(false)
                } else if (event.type == "turn.completed" || event.type == "turn.failed") {
                    if (pendingUserInputs.values.any {
                            it.sessionId == event.sessionId && sameTurn(it.turnId, event.turnId)
                        }
                    ) {
                        log.info("[askUser] Turn terminated (${event.type}, ${event.sessionId}, turn=${event.turnId}), discarding its pending dialogs")
                        abortPendingUserInputs(event.sessionId, event.turnId)
                    }
                    notifyTurnEndIfWanted(event)
                }
            }
            if (!browserHandlerRegistered) {
                val executor = com.zcode.ideaplugin.ui.ZCodeBrowserExecutor(project)
                browserExecutor = executor
                c.browserListHandler = { executor.listBrowsers() }
                c.browserExecuteHandler = { params -> executor.execute(params) }
                browserHandlerRegistered = true
                log.info("[browser-use] host handlers registered (interaction/browserList + browserExecute)")
            }
            // automation/* 宿主化：模型的 Cron* 工具经 app-server 反向请求落到插件，
            // 任务存储/调度由 ZCodeScheduledMessageService 承载（与官方客户端的
            // tasks-index.sqlite 互不共写，双端并行不会双重执行）
            if (!automationHandlerRegistered) {
                val scheduled = com.zcode.ideaplugin.ui.ZCodeScheduledMessageService.getInstance(project)
                c.automationRequestHandler = { method, params ->
                    scheduled.handleAutomationRequest(method, params)
                }
                automationHandlerRegistered = true
                log.info("[automation] host handler registered (automation/create|update|list|delete|checkTaskBinding)")
            }
        } catch (e: Exception) {
            log.warn("Protocol handler registration failed (will retry on next getClient): ${e.message}")
        }
    }

    // ===== 会话列表活性订阅（sessions-index v4 topic）=====

    /**
     * 整 workspace 会话索引的常驻订阅（官方桌面客户端侧栏同源数据面）：
     * 相位/标题/最近活动/后台工作标记全推送，列表行不再只靠本进程事件流——
     * 官方桌面端/手机 H5 驱动的会话在 IDE 里同样实时翻转（此前跨进程无感知，
     * 调研结论见项目记忆 zcode-sessions-index-refresh-entry：publisher 永驻内存、
     * 只吃本进程事件流，本订阅是官方 wire 面上唯一的全量活性通道）。
     *
     * 成本：+1 条 workspace 级 v4 订阅（非会话驻留池，16 槽账本不统计它；
     * 与官方桌面端每个打开的 workspace 恒持一条同构）。
     */
    private fun hookSessionsIndex(c: ZCodeProtocolClient) {
        // 帧监听随 client 实例注册（v4 帧泵对所有 topic 透传，此处按 topic 前缀分拣）
        c.addV4FrameListener { params ->
            runCatching { handleSessionsIndexFrame(c, params) }
        }
        // 订阅 RPC 异步发出：本函数在 getClient 锁内的启动路径被调，同步等订阅回包
        // （忙窗口最长 10s 超时）会把所有等 getClient 的调用方一起堵住
        com.intellij.util.concurrency.AppExecutorUtil.getAppExecutorService().submit {
            subscribeSessionsIndex(c)
        }
    }

    private fun subscribeSessionsIndex(c: ZCodeProtocolClient) {
        try {
            val ws = project.basePath ?: return
            // topic 的 workspaceId = 原始路径（2026-10-01 diag-v4-sessions-index-dump 实帧）；
            // workspace 参数必带——部分版本缺席时订阅成功但无 initial 快照帧（2026-09-22 真机）
            val ack = c.v4ConversationSubscribe(
                "sessions-index/$ws",
                connectionId = "zcode-plugin-index",
                workspacePath = ws,
            )
            log.info("[sessions-index] subscribed: ${ack["ack"].toString().take(140)}")
        } catch (e: Exception) {
            // 订阅失败不致命：列表退回 session/list 拉取语义，仅活性推送缺席
            log.warn("[sessions-index] subscribe failed: ${e.message?.take(160)}")
        }
    }

    /** sessions-index 帧分拣：initial 快照（full 合并）与增量（upsert/removed）。
     *  帧形状照官方 publisher 实证：快照 payload={kind:"snapshot",snapshot}、
     *  增量 payload={kind:"deltas",deltas[]}（复数——2026-10-01 源码核对
     *  sessions-index-publisher.ts reserveDeltaFrame）；seq 断档时服务端整帧退化为
     *  snapshot，客户端无需处理续传。"delta" 单数留作容错别名 */
    private fun handleSessionsIndexFrame(c: ZCodeProtocolClient, params: JsonObject) {
        val topic = params["topic"]?.jsonPrimitive?.contentOrNull ?: return
        if (!topic.startsWith("sessions-index/")) return
        val payload = params["frame"]?.jsonObject?.get("payload")?.jsonObject ?: return
        when (payload["kind"]?.jsonPrimitive?.contentOrNull) {
            "snapshot" -> {
                val sessions = payload["snapshot"]?.jsonObject?.get("sessions")?.jsonArray ?: return
                // 快照时机强制刷新软删缓存（首次对账最便宜的时刻）
                hiddenTaskIdAt = 0L
                pushSessionsIndex(c, sessions.mapNotNull { it as? JsonObject }, full = true, removedIds = emptyList())
            }
            "deltas", "delta" -> {
                val deltas = payload["deltas"]?.jsonArray ?: return
                val upserts = mutableListOf<JsonObject>()
                val removed = mutableListOf<String>()
                for (d in deltas) {
                    val o = d as? JsonObject ?: continue
                    when (o["op"]?.jsonPrimitive?.contentOrNull) {
                        "session.upserted" -> (o["session"] as? JsonObject)?.let { upserts.add(it) }
                        "session.removed" -> o["sessionId"]?.jsonPrimitive?.contentOrNull?.let { removed.add(it) }
                    }
                }
                pushSessionsIndex(c, upserts, full = false, removedIds = removed)
            }
        }
    }

    private fun pushSessionsIndex(c: ZCodeProtocolClient, entries: List<JsonObject>, full: Boolean, removedIds: List<String>) {
        if (entries.isEmpty() && removedIds.isEmpty()) return
        val hidden = hiddenTaskIds(c)
        val visible = entries.filter { e ->
            val sid = e["sessionId"]?.jsonPrimitive?.contentOrNull ?: return@filter false
            // 子代理子会话不进列表（与 session/list 同口径）；软删过滤（见 [hiddenTaskIds]）
            !sid.startsWith("sess_subagent") && sid !in hidden
        }
        val removedVisible = removedIds.filter { !it.startsWith("sess_subagent") && it !in hidden }
        if (visible.isEmpty() && removedVisible.isEmpty()) return
        detectUnreadsOnPhaseChange(c, visible)
        // 移除的会话相位缓存一并清（防泄漏；复活后按无前值处理，不误标）
        removedIds.forEach { sessionPhaseCache.remove(it) }
        com.zcode.ideaplugin.ui.ZCodeToolWindowPanel.broadcastSessionsIndex(visible, removedVisible, full)
    }

    /**
     * 未读标记：sessions-index 相位从 running → 终态（completedSuccess/completedInterrupted/
     * error）且无任一标签正在看该会话 → 写 tasks-index unread_at + 全标签广播
     * （官方 taskStatusUnreadSync「后台终态且非当前激活」语义的跨进程版——官方桌面端/
     * 手机 H5 驱动的会话同样覆盖）。
     *
     * 逐条与相位缓存比对：快照首帧（IDE 重启/订阅建立）无前值不触发——快照重建不会把
     * 历史已完成会话误标未读；只有本进程亲历的 running→终态迁移才标。
     * 缓存 put 同步（内存操作），写库异步（帧泵热路径禁注入式副作用，缺陷EH 教训）。
     */
    private val sessionPhaseCache = java.util.concurrent.ConcurrentHashMap<String, String>()

    private fun detectUnreadsOnPhaseChange(c: ZCodeProtocolClient, entries: List<JsonObject>) {
        val toMark = mutableListOf<String>()
        for (e in entries) {
            val sid = e["sessionId"]?.jsonPrimitive?.contentOrNull ?: continue
            val phase = e["phase"]?.jsonPrimitive?.contentOrNull ?: continue
            val prev = sessionPhaseCache.put(sid, phase)
            if (prev != "running") continue
            if (phase != "completedSuccess" && phase != "completedInterrupted" && phase != "error") continue
            // 任一已开标签正在看：用户亲历完成，不标未读
            if (com.zcode.ideaplugin.ui.ZCodeToolWindowPanel.isSessionBeingWatched(sid)) continue
            toMark.add(sid)
        }
        if (toMark.isEmpty()) return
        com.intellij.util.concurrency.AppExecutorUtil.getAppExecutorService().submit {
            for (sid in toMark) {
                try {
                    c.markSessionUnread(sid)
                    log.info("[unread] marked (phase -> terminal, not watched): $sid")
                } catch (e: Exception) {
                    // 写库失败静默（schema 不兼容/客户端未装），不影响索引推送链路
                    log.warn("[unread] mark failed: $sid: ${e.message?.take(120)}")
                }
            }
            com.zcode.ideaplugin.ui.ZCodeToolWindowPanel.broadcastSessionUnreadsSafe(c)
        }
    }

    /** 软删会话 id 缓存（60s TTL）。实证：归档会话不在 sessions-index（无需过滤）、
     *  软删在（publisher 不排——2026-10-01 直连对账 344 归档 0 命中 / 520 软删 185 命中），
     *  客户端删除=纯软删，不过滤会复活僵尸行。delta 高频期不逐帧查库 */
    @Volatile private var hiddenTaskIdCache: Set<String> = emptySet()
    @Volatile private var hiddenTaskIdAt: Long = 0L

    private fun hiddenTaskIds(c: ZCodeProtocolClient): Set<String> {
        val now = System.currentTimeMillis()
        if (hiddenTaskIdAt != 0L && now - hiddenTaskIdAt < 60_000L) return hiddenTaskIdCache
        return try {
            val ids = c.taskIndex.listTasks().filter { it.archived || it.deleted }.map { it.taskId }.toSet()
            hiddenTaskIdCache = ids
            hiddenTaskIdAt = now
            ids
        } catch (e: Exception) {
            hiddenTaskIdCache // 读库失败沿用旧缓存（宁多显示不漏显示）
        }
    }

    // ===== 配置目录热更新订阅（workspace-config v4 topic，H3 配套）=====

    /**
     * workspace 级配置目录（模型目录+slash 命令目录）的常驻订阅：官方客户端每次打开
     * 模型下拉都要拉一次目录，这里改为推送驱动——渠道/模型目录或命令目录变化时
     * app-server 推 config.updated（provider_config.json 热加载、客户端渠道管理、
     * 技能/命令文件变化都会触发），插件收到后触发各标签重算既有清单并广播，模型
     * 下拉无需重开即见新目录（webview 复用 case 'models'/'commands'，零新协议）。
     *
     * 口径决策：推送只当「变化触发器」，目录数据仍走插件权威链路（listModels 读
     * 注册表 + SlashCommandScanner 扫盘）——topic 的 configOptions 是官方 host 视角
     * 的下拉选项（含注入项/thoughtLevels），与插件渠道管理面（计费 key、captcha 门控、
     * enabled 过滤）口径不同，换源会牵动整个模型管理面，收益不成比例。
     *
     * 成本：+1 条 workspace 级 v4 订阅（不占 16 会话驻留槽，与 sessions-index 同构）。
     * 帧监听挂逻辑帧通道：wire 分片重组产物与整帧同构、fragment 不进（缺陷EK 后
     * 「要吃完整逻辑帧」的消费方推荐姿势，比 sessions-index 的原始通道更稳）。
     */
    private fun hookWorkspaceConfig(c: ZCodeProtocolClient) {
        c.addV4LogicalFrameListener { params ->
            runCatching { handleWorkspaceConfigFrame(params) }
        }
        // 订阅 RPC 异步发出（同 hookSessionsIndex：getClient 锁内不等回包）
        com.intellij.util.concurrency.AppExecutorUtil.getAppExecutorService().submit {
            subscribeWorkspaceConfig(c)
        }
    }

    private fun subscribeWorkspaceConfig(c: ZCodeProtocolClient) {
        try {
            val ws = project.basePath ?: return
            val ack = c.v4ConversationSubscribe(
                "workspace-config/$ws",
                connectionId = "zcode-plugin-config",
                workspacePath = ws,
            )
            log.info("[workspace-config] subscribed: ${ack["ack"].toString().take(140)}")
        } catch (e: Exception) {
            // 订阅失败不致命（旧 CLI 无该 topic）：热更新缺席，清单仍走打开时拉取
            log.warn("[workspace-config] subscribe failed: ${e.message?.take(160)}")
        }
    }

    /** 帧分拣：快照 payload.snapshot.config 与增量 op=config.updated 同形取 config
     *  （整体替换语义，conflated 最新态，一帧多个 delta 取末个）；内容签名比对，
     *  无变化不触发（服务端重连重推同快照时幂等）。 */
    private fun handleWorkspaceConfigFrame(params: JsonObject) {
        val topic = params["topic"]?.jsonPrimitive?.contentOrNull ?: return
        if (!topic.startsWith("workspace-config/")) return
        val config = extractWorkspaceConfigState(params) ?: return
        val sig = config.toString()
        synchronized(configSigLock) {
            if (sig == lastConfigSignature) return
            lastConfigSignature = sig
        }
        scheduleCatalogRefresh()
    }

    /** 变化合并窗口：1s 内多帧只触发一轮重算（命令扫描走磁盘不宜逐帧跑）；
     *  窗口内丢弃的中间帧无影响——广播重算读的是触发时刻的注册表/磁盘=最终态。 */
    private val configSigLock = Any()
    @Volatile private var lastConfigSignature: String? = null
    private val configRefreshQueued = java.util.concurrent.atomic.AtomicBoolean(false)

    private fun scheduleCatalogRefresh() {
        if (!configRefreshQueued.compareAndSet(false, true)) return
        com.intellij.util.concurrency.AppExecutorUtil.getAppScheduledExecutorService().schedule({
            configRefreshQueued.set(false)
            try {
                com.zcode.ideaplugin.ui.ZCodeToolWindowPanel.broadcastCatalogRefresh()
                log.info("[workspace-config] catalog refresh broadcast")
            } catch (e: Exception) {
                log.warn("[workspace-config] refresh broadcast failed: ${e.message}")
            }
        }, 1, java.util.concurrent.TimeUnit.SECONDS)
    }

    override fun isStarted(): Boolean = client?.isAlive() == true

    /**
     * 润色/标题轻任务专用 client（懒启动）：只跑 workspace/generateText，与主
     * app-server 进程隔离——app-server 串行处理请求，generateText 在途会拖住
     * session/list/send（用户实测「润色中历史列表加载不出来」的根因）。
     * 无会话流量，不注册交互 handler，不参与归档扫描；随 shutdown 一并关闭。
     */
    @Volatile
    private var enhanceClient: ZCodeProtocolClient? = null

    override fun getEnhanceClient(): ZCodeProtocolClient {
        enhanceClient?.let { if (it.isAlive()) return it }
        return lock.withLock {
            enhanceClient?.let { if (it.isAlive()) return it }
            val env = com.zcode.ideaplugin.env.ZCodeEnvChecker.resolveForStart()
            com.zcode.ideaplugin.env.ZCodeProviderBootstrap.ensureBuiltinProvider(env.zcodePath)
            val started = ZCodeProtocolClient.start(
                zcodePath = env.zcodePath,
                credentials = env.credentials,
                nodePath = env.nodePath,
            )
            log.info("[enhance] dedicated app-server started (isolates generateText from session traffic)")
            // 无会话一般不会被问，但防御性挂上 fail-soft 应答，避免专用进程万一收到
            // runtimePreferences 反向请求时无人应答卡死
            started.runtimePreferencesResponder = { _, _ ->
                val p = com.zcode.ideaplugin.ui.ZCodeClientSettingStore.readRuntimePrefs()
                com.zcode.ideaplugin.protocol.model.RuntimePreferences(
                    nativeSearchEnhancementsEnabled = p.nativeSearchEnhancementsEnabled,
                    memoryEnabled = p.memoryEnabled,
                    askUserQuestionAutoResolutionEnabled = false,
                )
            }
            // 同步等账号 overlay 推送落地再返回：start() 的推送是后台异步的，首条
            // generateText 立刻就发，竞态下（推送晚 70ms 实测）报 -32603 Registry
            // 不存在、首次润色掉进 CLI 降级。幂等，与后台推送线程并发无害
            started.ensureAccountOverlayPushed(env.zcodePath)
            enhanceClient = started
            started
        }
    }

    override fun shutdown() {
        lock.withLock {
            client?.close()
            client = null
            enhanceClient?.close()
            enhanceClient = null
            // 进程将被杀，驻留集合随之消亡：账本清零（下次 getClient 重建亦会重置，双保险）
            residentLedger.invalidateAll()
            // handler 注册标志随旧实例作废：getClient 换代后 registerProtocolHandlersLocked
            // 须在新 client 上重挂 askUser / browser-use handler。旧版不重置——环境变更
            // 触发 shutdown 后新 client 缺 handler，AskUserQuestion 被服务端自动 decline、
            // browser-use 反向请求报"宿主未注册"
            userInputHandlerRegistered = false
            permissionHandlerRegistered = false
            browserHandlerRegistered = false
            automationHandlerRegistered = false
        }
    }

    /**
     * 本项目存活的常驻 app-server 进程引用（进程管理面板数据源）：
     * 主进程 + 润色专用进程各至多一个，死进程不返回。
     */
    fun liveAppServers(): List<com.zcode.ideaplugin.ui.LiveAppServer> {
        val out = mutableListOf<com.zcode.ideaplugin.ui.LiveAppServer>()
        client?.takeIf { it.isAlive() && it.pid > 0 }
            ?.let { out.add(com.zcode.ideaplugin.ui.LiveAppServer(it.pid, it.startedAtMillis, "main")) }
        enhanceClient?.takeIf { it.isAlive() && it.pid > 0 }
            ?.let { out.add(com.zcode.ideaplugin.ui.LiveAppServer(it.pid, it.startedAtMillis, "enhance")) }
        return out
    }

    /**
     * 按 pid 定向关闭常驻 app-server（进程管理面板 kill 动作）：
     * pid 与当前 client 不符即拒绝（防按过期快照误杀换代后的新进程）。
     * 主进程走 shutdown 同款簿记（handler 标志重置 + 账本清零），下次 getClient
     * 懒重建；润色进程只关自己。返回是否命中并已关闭。
     */
    fun killAppServerByPid(pid: Long): Boolean = lock.withLock {
        var killed = false
        client?.let { c ->
            if (c.isAlive() && c.pid == pid) {
                c.close()
                client = null
                killed = true
                residentLedger.invalidateAll()
                userInputHandlerRegistered = false
                permissionHandlerRegistered = false
                browserHandlerRegistered = false
                automationHandlerRegistered = false
                log.info("[process-mgr] main app-server killed by user (pid=$pid), lazy respawn on next getClient")
            }
        }
        if (!killed) {
            enhanceClient?.let { c ->
                if (c.isAlive() && c.pid == pid) {
                    c.close()
                    enhanceClient = null
                    killed = true
                    log.info("[process-mgr] enhance app-server killed by user (pid=$pid)")
                }
            }
        }
        killed
    }

    override fun registerPanel(panel: ZCodeToolWindowPanel) {
        if (panel !in panels) panels.add(panel)
        if (activePanel == null) activePanel = panel
    }

    override fun unregisterPanel(panel: ZCodeToolWindowPanel) {
        panels.remove(panel)
        if (activePanel === panel) {
            activePanel = panels.lastOrNull()
        }
    }

    override fun setActivePanel(panel: ZCodeToolWindowPanel) {
        activePanel = panel
    }

    override fun getActivePanel(): ZCodeToolWindowPanel? = activePanel

    override fun getSharedBrowserPanel(): com.zcode.ideaplugin.ui.ZCodeBrowserPanel? = sharedBrowserPanel

    override fun getOrCreateSharedBrowserPanel(): com.zcode.ideaplugin.ui.ZCodeBrowserPanel? {
        sharedBrowserPanel?.let { return it }
        return synchronized(this) {
            sharedBrowserPanel?.let { return it }
            // 收起按钮作用于「当前挂载 owner」——闭包读实时状态，跨标签迁移后仍然正确；
            // 弹出独立窗口期间「收起」= 收回侧栏（collapseBrowserPane 内部收口）。
            // 弹出按钮走全局 detachBrowserToWindow（弹窗是项目级单实例）。
            val panel = com.zcode.ideaplugin.ui.ZCodeBrowserPanel(project,
                onClose = { embeddedBrowserOwner?.collapseBrowserPane() },
                onDetach = { detachBrowserToWindow() },
                onToggleAlwaysOnTop = { toggleBrowserAlwaysOnTop() },
            )
            sharedBrowserPanel = panel
            log.info("[browser-use] Global shared browser panel created (cross-session tab)")
            panel
        }
    }

    override fun getEmbeddedBrowserOwner(): ZCodeToolWindowPanel? = embeddedBrowserOwner

    override fun setEmbeddedBrowserOwner(panel: ZCodeToolWindowPanel?) {
        embeddedBrowserOwner = panel
    }

    override fun isBrowserDetached(): Boolean = browserDetached

    /**
     * 弹出浏览器到独立窗口（工具条「弹出」按钮；EDT，幂等）。
     * 搬运式：先置弹出标志（[ZCodeToolWindowPanel.showEmbeddedBrowser] 据此短路，不挂侧栏），
     * 复用收起内核摘出侧栏并还原 ToolWindow 宽度，再把面板整体装进独立窗口——
     * JCEF 在 removeNotify/addNotify 时重挂窗口句柄，页面与 CDP target 不销毁。
     */
    override fun detachBrowserToWindow(): Boolean {
        if (!javax.swing.SwingUtilities.isEventDispatchThread()) {
            var result = false
            javax.swing.SwingUtilities.invokeAndWait { result = detachBrowserToWindow() }
            return result
        }
        if (browserDetached) {
            browserDetachWindow?.let { it.getFrame()?.toFront() }
            return true
        }
        val panel = getOrCreateSharedBrowserPanel() ?: return false
        browserDetached = true
        try {
            // 未挂载侧栏（收起态）时 owner 为 null 或摘无可摘，均无害
            embeddedBrowserOwner?.hideEmbeddedBrowser()
            browserDetachWindow = com.zcode.ideaplugin.ui.BrowserDetachWindow.showWindow(project, panel) {
                // 窗口任何路径关闭（标题栏 × / 外部 dispose）：收回侧栏
                javax.swing.SwingUtilities.invokeLater {
                    if (browserDetached) restoreBrowserFromWindow()
                }
            }
            panel.setBrowserDetachedUI(true)
            log.info("[browser-use] Browser pane detached to standalone window")
            return true
        } catch (e: Exception) {
            browserDetached = false
            log.warn("[browser-use] Failed to detach browser window: ${e.message}")
            return false
        }
    }

    /**
     * 翻转独立浏览器窗口置顶（弹出态工具条图钉按钮；EDT）。
     * 状态权威是 AWT Window 的 alwaysOnTop，按钮视觉回写面板；窗口关闭即失，
     * 新弹出的窗口默认不置顶（[com.zcode.ideaplugin.ui.ZCodeBrowserPanel.setBrowserDetachedUI]
     * 收回时已重置按钮视觉）。
     */
    private fun toggleBrowserAlwaysOnTop() {
        if (!javax.swing.SwingUtilities.isEventDispatchThread()) {
            javax.swing.SwingUtilities.invokeLater { toggleBrowserAlwaysOnTop() }
            return
        }
        val window = browserDetachWindow ?: return
        val pinned = !window.isAlwaysOnTop()
        window.setAlwaysOnTop(pinned)
        sharedBrowserPanel?.setAlwaysOnTopUI(pinned)
        log.info("[browser-use] Browser detach window always-on-top=$pinned")
    }

    /**
     * 收回浏览器到侧栏（窗口关闭回调/AI visibilitySet(false)/Header 开关共用收口；EDT，幂等）。
     * 优先挂当前激活面板（用户在哪个标签收回就在哪个标签展开），无激活面板保持收起态。
     */
    override fun restoreBrowserFromWindow() {
        if (!javax.swing.SwingUtilities.isEventDispatchThread()) {
            javax.swing.SwingUtilities.invokeAndWait { restoreBrowserFromWindow() }
            return
        }
        if (!browserDetached) return
        // 先复位标志：阻断窗口 Disposer 回调（下方主动 dispose 触发）的二次进入
        browserDetached = false
        val window = browserDetachWindow
        browserDetachWindow = null
        sharedBrowserPanel?.setBrowserDetachedUI(false)
        // 面板从窗口内容树摘出（dispose 窗口前摘干净，防销毁链摸到仍在窗口里的活面板）
        sharedBrowserPanel?.let { p ->
            p.parent?.remove(p)
        }
        window?.let {
            if (!it.isDisposed) {
                try {
                    com.intellij.openapi.util.Disposer.dispose(it)
                } catch (e: Exception) {
                    log.warn("[browser-use] Failed to dispose browser detach window: ${e.message}")
                }
            }
        }
        val target = activePanel ?: embeddedBrowserOwner ?: panels.firstOrNull()
        val shown = target?.showEmbeddedBrowser()
        log.info("[browser-use] Browser restored from standalone window (remounted=${shown != null})")
    }

    override fun dispose() {
        // 项目级服务销毁：先停协议客户端（杀 app-server 进程树）。
        // 不停的后果（2026-08-24 实战）：正在执行的回合在无 UI 监督的僵尸进程上自主
        // 续跑，其反向请求打到已 dispose 的容器（browser-use 全废），事件仍被转发、
        // 污染重开项目后的 webview（同会话双流交错）
        try { shutdown() } catch (e: Exception) {
            log.warn("Failed to stop protocol client on project dispose: ${e.message}")
        }
        // 从宿主探针聚合集中摘除（先于释放浏览器实例）
        activeInstances.remove(this)
        // 关闭收尾通知调度器（挂起的延迟任务一并作废，防 dispose 后触达死项目）
        notifyScheduler.shutdownNow()
        // 先静默关浏览器独立窗口（browserDetached 置 false 阻断收回回调——项目都要销毁，无处可收），
        // 再释放共享浏览器实例（窗口若不先关，销毁链会摸到已 dispose 的面板）
        if (browserDetached) {
            browserDetached = false
            browserDetachWindow?.let {
                try {
                    com.intellij.openapi.util.Disposer.dispose(it)
                } catch (e: Exception) {
                    log.warn("Failed to close browser detach window on dispose: ${e.message}")
                }
            }
        }
        browserDetachWindow = null
        // 释放共享浏览器实例（所有标签共用这一个）
        sharedBrowserPanel?.let {
            try {
                com.intellij.openapi.util.Disposer.dispose(it)
            } catch (e: Exception) {
                log.warn("Failed to release shared browser panel: ${e.message}")
            }
        }
        sharedBrowserPanel = null
        embeddedBrowserOwner = null
    }

    override fun findPanelForSession(sessionId: String): ZCodeToolWindowPanel? =
        panels.firstOrNull { it.isSubscribedTo(sessionId) }

    override val sessionTitleCache = java.util.concurrent.ConcurrentHashMap<String, String>()

    override fun pushToWebview(msg: JsonObject) {
        val p = activePanel ?: run {
            log.warn("pushToWebview: no active panel, message dropped: ${msg["op"]}")
            return
        }
        p.pushToWebview(msg)
    }

    override fun broadcastToWebviews(msg: JsonObject) {
        if (panels.isEmpty()) {
            log.warn("broadcastToWebviews: no panels, message dropped: ${msg["op"]}")
            return
        }
        panels.forEach { it.pushToWebview(msg) }
    }

    override fun ensureUserInputHandler() {
        // 注册统一在 getClient() 启动成功后执行（registerProtocolHandlersLocked），
        // 这里只需确保协议客户端已拉起
        getClient()
    }

    // ============ browser-use 宿主执行器（AI 浏览器工具 → JCEF 面板）============

    @Volatile
    private var browserExecutor: com.zcode.ideaplugin.ui.ZCodeBrowserExecutor? = null

    @Volatile
    private var browserHandlerRegistered = false

    // automation/* 宿主化注册标志（换代重置，与 browserHandlerRegistered 同纪律）
    @Volatile
    private var automationHandlerRegistered = false

    override fun ensureBrowserExecutor() {
        // 注册统一在 getClient() 启动成功后执行（registerProtocolHandlersLocked）
        getClient()
    }

    override fun getBrowserExecutor(): com.zcode.ideaplugin.ui.ZCodeBrowserExecutor? = browserExecutor

    /**
     * 收到 interaction/requestUserInput：解析问题、推弹窗到目标面板、阻塞等用户应答。
     * 在协议客户端的独立线程执行，可安全阻塞。
     */
    private fun handleUserInputRequest(serverRequestId: String, params: JsonObject): JsonObject {
        log.info("[askUser] interaction/requestUserInput received: $serverRequestId")
        log.info("[askUser] params: ${LogRedactor.redact(params.toString()).take(600)}")

        val toolName = params["toolName"]?.jsonPrimitive?.content ?: "AskUserQuestion"
        // ExitPlanMode 识别：toolName 为主，interaction:"plan_approval" 兜底
        val isPlanApproval = toolName == "ExitPlanMode" ||
            params["interaction"]?.jsonPrimitive?.contentOrNull == "plan_approval"
        // 「提问自动继续」（插件自有配置 zcode.askUser.config，行为栏可切，默认关）：
        // 关=普通提问不设超时一直等待（弹窗无倒计时）；开=5 分钟未答自动继续（本地
        // decline + requestRuntimePreferences 透传 true，服务端同语义）。ExitPlanMode
        // 审批 0.3.7 起不设超时一直等待（issue #17：长计划读不完就被自动拒绝，且协议面
        // 无重开审批通道——拒绝后只能等 AI 重发 ExitPlanMode；服务端放弃路径已有
        // abortPendingUserInputs 兜底关窗）。权限审批（requestPermission 通道）仍恒 5 分钟。
        // 每次请求即时读配置——切换开关连「当前提问」也生效
        val askUserNoTimeout = isPlanApproval ||
            !com.zcode.ideaplugin.ui.ZCodeAskUserConfig.readConfig().autoContinueEnabled
        // 内容指纹：toolName + 问题/计划文本，用于识别服务端重试（同内容、新 id）
        val contentKey = "$toolName|${params["input"]?.toString() ?: params["questions"]?.toString() ?: ""}"

        // 弹窗目标：优先按 sessionId 精确路由（该字段是否存在取决于服务端实现），
        // 否则 fallback 到当前激活标签
        val sessionId = params["sessionId"]?.jsonPrimitive?.contentOrNull
        val targetPanel = (sessionId?.let { findPanelForSession(it) }) ?: activePanel
        if (targetPanel == null) {
            log.warn("[askUser] No panel available, declining directly: $serverRequestId")
            return buildJsonObject { put("action", "decline") }
        }

        // 共享匹配加回合条件：同回合的服务端重试共享旧 future（各 handler 线程向自己
        // 的 id 应答），不重复弹窗；跨回合同内容（同会话连续两回合问同样的问题）是
        // 新请求——旧 future 可能已随旧回合废弃，共享会拿到哨兵误失败。
        // 回合归属取 params.turnId（服务端权威，与事件到达顺序无关）
        val currentTurn = params["turnId"]?.jsonPrimitive?.contentOrNull
        val existing = pendingUserInputs.values.firstOrNull {
            it.contentKey == contentKey && sameTurn(it.turnId, currentTurn)
        }
        val future: CompletableFuture<JsonObject>
        if (existing != null) {
            // 服务端重试同一请求：共享旧 future（各 handler 线程向自己的 id 应答），
            // 不重复弹窗——重复推送会重建弹窗、重置用户已选状态
            pendingUserInputs[serverRequestId] =
                PendingUserInput(contentKey, existing.future, existing.targetPanel, existing.sessionId, turnId = existing.turnId)
            future = existing.future
            log.info("[askUser] Server retried same request, sharing pending wait: $serverRequestId")
        } else {
            future = CompletableFuture()
            pendingUserInputs[serverRequestId] =
                PendingUserInput(contentKey, future, targetPanel, sessionId, turnId = currentTurn)

            // ExitPlanMode 走专门的计划审批通道：params = {toolName:"ExitPlanMode", input:{plan:"..."}}
            // 它没有 questions 数组，而是 input.plan 直接是计划 markdown 文本。
            if (isPlanApproval) {
                val input = params["input"]?.let { it as? JsonObject }
                val plan = input?.get("plan")?.jsonPrimitive?.content ?: ""
                val askMsg = buildJsonObject {
                    put("op", "exitPlanApproval")
                    put("requestId", serverRequestId)
                    put("plan", plan)
                    // 不带 deadlineMs：审批无超时一直等待（issue #17），前端显示「已等待」正计时
                }
                targetPanel.pushToWebview(askMsg)
                log.info("[askUser] ExitPlanMode plan approval pushed to frontend, waiting for user decision...")
            } else {
                // 普通 AskUserQuestion：{op:"askUser", requestId, questions, toolName}
                // （提问自动继续关闭时不推 deadlineMs——前端 DialogCountdown 对缺省不渲染倒计时）
                val questions = params["questions"] ?: kotlinx.serialization.json.JsonArray(emptyList())
                val askMsg = buildJsonObject {
                    put("op", "askUser")
                    put("requestId", serverRequestId)
                    put("toolName", toolName)
                    put("questions", questions)
                    if (!askUserNoTimeout) put("deadlineMs", System.currentTimeMillis() + USER_INPUT_TIMEOUT_MS)
                }
                targetPanel.pushToWebview(askMsg)
                log.info("[askUser] Pushed to frontend, waiting for user selection...")
            }
            // 广播挂起标志（含未收到弹窗的面板——多标签同会话时弹窗只路由到一个标签，
            // 其余标签的流式看门狗靠它豁免，否则 60s 静默误判 streamLost 收尾回合）
            broadcastAskUserPending(true)
            // 等待输入系统通知（issue #24：规划模式等提问/计划审批等待时用户切走了
            // 不知道 AI 停下在等；受通知总开关门控，点击回会话）
            val notifyKind = if (isPlanApproval) ZCodeNotifyService.PendingInputKind.PLAN_APPROVAL
            else ZCodeNotifyService.PendingInputKind.ASK_USER
            ZCodeNotifyService.notifyPendingInput(project, sessionId, notifyKind, pendingInputPreview(notifyKind, toolName, params))
        }

        // 阻塞等用户选择（在协议客户端的独立线程，不阻塞 reader/EDT）。
        // 超时必须立即 decline 并关闭弹窗：悬空的等待线程 5 分钟后向服务端补发
        // 迟到的 decline，会被当作"用户拒绝了计划"（引发重复 ExitPlanMode）。
        // 提问自动继续关闭时普通提问无超时（future.get() 无限等）：回合终止/stop/
        // 面板关闭走 abortPendingUserInputs 的哨兵 complete 唤醒，线程不会永久滞留
        return try {
            if (askUserNoTimeout) future.get()
            else future.get(USER_INPUT_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
        } catch (e: java.util.concurrent.TimeoutException) {
            // 仅普通提问（「提问自动继续」开）会走到：ExitPlanMode 与关闭自动继续的提问均无限等
            log.warn("[askUser] Answer wait timed out (5 min), auto-declining: $serverRequestId")
            // 关窗 ack 覆盖共享此 future 的全部 id（清理前收集），防弹窗 id 已换新时
            // 只推本线程旧 id 关不掉弹窗（与权限超时路径同款纪律）
            val familyIds = pendingUserInputs.entries.filter { it.value.future === future }.map { it.key }
            cleanupPendingFor(future)
            familyIds.forEach { fid ->
                targetPanel.pushToWebview(buildJsonObject { put("op", "askUserAck"); put("requestId", fid) })
            }
            buildJsonObject { put("action", "decline") }
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            cleanupPendingFor(future)
            buildJsonObject { put("action", "decline") }
        }
    }

    /**
     * 收到 interaction/requestPermission（工具权限审批）：推审批弹窗到目标面板、
     * 阻塞等用户应答。复用 pendingUserInputs 协调器——服务端重试共享 future 不重复
     * 弹窗、turn 终止按会话废弃、askUserPending 广播豁免流式看门狗，全部同 askUser。
     */
    private fun handlePermissionRequest(serverRequestId: String, params: JsonObject): JsonObject {
        log.info("[permission] interaction/requestPermission received: $serverRequestId")
        log.info("[permission] params: ${LogRedactor.redact(params.toString()).take(600)}")

        val toolName = params["toolName"]?.jsonPrimitive?.contentOrNull ?: "UnknownTool"
        val familyId = params["requestId"]?.jsonPrimitive?.contentOrNull
        // 族缓存短路：已应答/已超时的族，迟到重发直接回缓存应答（不弹窗不挂起）。
        // 见 familyAnswers 注释——复活弹窗 + 5 分钟超时风暴的根治点
        familyId?.let { fid ->
            familyAnswers[fid]?.let { cached ->
                log.info("[permission] Late retry of answered family, replying cached result: $serverRequestId (family=$fid)")
                return cached.result
            }
        }

        val contentKey = "PERM|$toolName|${params["input"]?.toString() ?: ""}"
        val sessionId = params["sessionId"]?.jsonPrimitive?.contentOrNull
        // 回合归属取 params.turnId（服务端权威，与事件到达顺序无关）
        val currentTurn = params["turnId"]?.jsonPrimitive?.contentOrNull
        val targetPanel = (sessionId?.let { findPanelForSession(it) }) ?: activePanel
        if (targetPanel == null) {
            log.warn("[permission] No panel available, denying: $serverRequestId")
            return buildJsonObject { put("decision", "deny"); put("reason", "No panel available") }
        }

        // 权限请求合并按族 id：服务端同族重发恒同 familyId → 共享 future 不重复弹窗；
        // 不再按 contentKey 合并——工具超时重试是同会话新回合的新族且参数相同，
        // contentKey 会撞车共享到已随旧回合废弃的 future（2026-08-27 实测顶掉/静默
        // 失败的根因之一）。familyId 缺失（协议异常防御）才退回 contentKey+回合
        val existing = if (familyId != null) {
            pendingUserInputs.values.firstOrNull { it.familyId == familyId }
        } else {
            pendingUserInputs.values.firstOrNull {
                it.contentKey == contentKey && sameTurn(it.turnId, currentTurn)
            }
        }
        val future: CompletableFuture<JsonObject>
        if (existing != null) {
            pendingUserInputs[serverRequestId] =
                PendingUserInput(contentKey, existing.future, existing.targetPanel, existing.sessionId, existing.options, existing.familyId, existing.turnId)
            future = existing.future
            // 弹窗 id 保活：重发换新 id，但前端弹窗还记着旧 id——用户点击会应答到
            // 服务端已放弃的旧 id（迟到应答无效，实测第一次点击白点）。推轻量刷新
            // 只更新前端弹窗的 requestId（不重建弹窗不重置倒计时），点击永远命中
            // 服务端当前在等的 id
            targetPanel.pushToWebview(buildJsonObject { put("op", "permissionRequestRefresh"); put("requestId", serverRequestId) })
            log.info("[permission] Server retried same family, sharing pending wait: $serverRequestId (family=$familyId)")
        } else {
            future = CompletableFuture()
            val options = params["options"] as? JsonArray ?: JsonArray(emptyList())
            pendingUserInputs[serverRequestId] =
                PendingUserInput(contentKey, future, targetPanel, sessionId, options, familyId, currentTurn)

            val askMsg = buildJsonObject {
                put("op", "permissionRequest")
                put("requestId", serverRequestId)
                put("toolName", toolName)
                put("reason", params["reason"]?.jsonPrimitive?.contentOrNull ?: "")
                put("options", options)
                params["input"]?.let { put("input", it) }
                params["riskLevel"]?.jsonPrimitive?.contentOrNull?.let { put("riskLevel", it) }
                put("deadlineMs", System.currentTimeMillis() + USER_INPUT_TIMEOUT_MS)
            }
            targetPanel.pushToWebview(askMsg)
            log.info("[permission] Approval dialog pushed to frontend (tool=$toolName), waiting for user decision...")
            broadcastAskUserPending(true)
            // 等待输入系统通知（issue #24：权限审批卡 5 分钟超时自动 deny，用户切走
            // 错过更伤；受通知总开关门控，点击回会话）
            ZCodeNotifyService.notifyPendingInput(
                project, sessionId, ZCodeNotifyService.PendingInputKind.PERMISSION,
                pendingInputPreview(ZCodeNotifyService.PendingInputKind.PERMISSION, toolName, params),
            )
        }

        // 阻塞等用户选择；超时/中断安全侧 deny（与协议层兜底同语义）。
        // 超时 deny 必须记族缓存：发给当前 serverRequestId 的应答服务端可能已放弃
        // （旧 id 不认账），迟到的同族重发靠缓存拿到 deny 才能让服务端停止重发
        return try {
            val answered = future.get(USER_INPUT_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
            answered
        } catch (e: java.util.concurrent.TimeoutException) {
            log.warn("[permission] Approval wait timed out (5 min), denying: $serverRequestId")
            // 关窗 ack 覆盖该族全部 id（清理前收集）：弹窗 id 已被 refresh 保活换新，
            // 只推本线程的旧 id 关不掉弹窗（2026-08-27 五轮实测：弹窗超时残留壳，
            // 用户点击白点）
            val familyIds = pendingUserInputs.entries.filter { it.value.future === future }.map { it.key }
            cleanupPendingFor(future)
            familyIds.forEach { fid ->
                targetPanel.pushToWebview(buildJsonObject { put("op", "askUserAck"); put("requestId", fid) })
            }
            val deny = buildJsonObject { put("decision", "deny"); put("reason", "Timed out") }
            familyId?.let { rememberFamilyAnswer(it, deny) }
            deny
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            cleanupPendingFor(future)
            buildJsonObject { put("decision", "deny"); put("reason", "Interrupted") }
        }
    }

    /** 记族应答缓存（用户选择/超时 deny），超量时按时间淘汰最老一半 */
    private fun rememberFamilyAnswer(familyId: String, result: JsonObject) {
        val now = System.currentTimeMillis()
        familyAnswers[familyId] = FamilyAnswer(result, now)
        if (familyAnswers.size > 64) {
            val sorted = familyAnswers.entries.sortedBy { it.value.at }
            sorted.take(sorted.size / 2).forEach { familyAnswers.remove(it.key) }
        }
    }

    override fun completeUserInput(
        requestId: String,
        action: String,
        answer: JsonElement?,
        answers: JsonObject?,
    ): JsonObject {
        val pending = pendingUserInputs.remove(requestId)
            ?: return buildJsonObject {
                put("op", "error")
                put("message", "未找到待处理的用户输入请求: $requestId")
            }
        val future = pending.future

        // 权限审批请求（options 非 null）：应答 = 选中项 response（S2 schema 原样，
        // 见 buildPermissionResult），不走 AskUserQuestion/ExitPlanMode 的 action/content 形态。
        // 应答记族缓存：服务端重发无上限，迟到重发直接回此应答（见 familyAnswers 注释）
        if (pending.options != null) {
            val permResult = buildPermissionResult(pending.options, action, answer)
            pending.familyId?.let { rememberFamilyAnswer(it, permResult) }
            future.complete(permResult)
            cleanupPendingFor(future)
            log.info("[permission] User answered, responding to server: decision=${permResult["decision"]}")
            return buildJsonObject { put("op", "askUserAck"); put("requestId", requestId) }
        }

        // 构建应答 result（格式：interaction/requestUserInput 的 result）
        // ExitPlanMode 审批的 answer 语义（zcode.cjs 常量，严格相等比较）：
        // - 小写 "approve" = 批准退出计划模式
        // - 有值但 ≠ "approve" = 反馈式拒绝：AI 留在计划模式按意见文本继续修改
        //   （审批弹窗「继续规划」按钮的通道）
        // - 空 = 按 decline 处理（安全侧，与 5 分钟超时同语义）：空反馈 ≠ 批准
        val isPlanApproval = pending.contentKey.startsWith("ExitPlanMode|")
        val effectiveDecline = isDeclineResponse(isPlanApproval, action, answer)
        // "approve"、意见文本、optionId 或自由文本，原样透传（decline 路径用不到）
        val normalizedAnswer = if (effectiveDecline) null else answer

        val result = if (effectiveDecline) {
            buildJsonObject { put("action", "decline") }
        } else {
            // accept + content：AskUserQuestion 答案（zcode.cjs normalizeAskUserQuestionAnswers）
            // - 多问题：content.answers = {问题文本: 值}（按问题文本回填，丢 key 即答案全失）
            // - 单问题：content.answer = 原始值（字符串 trim；数组服务端 join(", ") 后回填）。
            //   旧版把答案整体 JSON.stringify 成字符串塞 answer——多问题场景服务端匹配不到
            //   任何 key，answers 丢失（AI 认为用户没选）；数组也被当作字面量字符串
            // - 显式空对象 {} 必须走 answers 分支原样透传：服务端语义 = "用户全部跳过，
            //   AI 自行判断"（官方超时兜底同形，interaction-registry auto-resolution）。
            //   不能落 answer=""——空串会被服务端 normalizeAnswerValue 丢弃，整个 answers
            //   变 undefined → 工具报错 "requires user answers"（issue#45-4.2 忽略本题）
            buildJsonObject {
                put("action", "accept")
                put("content", buildJsonObject {
                    if (answers != null) {
                        put("answers", answers)
                    } else {
                        put("answer", normalizedAnswer ?: JsonPrimitive(""))
                    }
                })
            }
        }

        future.complete(result)
        // 服务端重试的其他 id 共享此 future，一并清理
        cleanupPendingFor(future)
        // 应答是用户自由文本（意见/审批反馈），只记形态不记内容——秘钥类可走 LogRedactor
        // 兜底，普通隐私文本没有模式可脱，落日志即泄露面（入参侧 :443 是结构化 params，
        // redact 后可打；应答侧没有这个性质）
        val answerShape = when (normalizedAnswer) {
            null -> "null"
            is JsonPrimitive -> "primitive(len=${normalizedAnswer.content.length})"
            else -> "json(len=${normalizedAnswer.toString().length})"
        }
        log.info("[askUser] User answered, responding to server: action=$action answer=$answerShape")
        return buildJsonObject { put("op", "askUserAck"); put("requestId", requestId) }
    }

    /**
     * 清理共享同一 future 的全部 pending id（应答/超时/中断三路共用）。
     * 挂起标志仅在**全部清空**后才广播 false——多个不同 contentKey 请求并存时，
     * 先应答一个不能把仍挂起的另一弹窗的多标签看门狗豁免标志提前清零。
     */
    private fun cleanupPendingFor(future: CompletableFuture<JsonObject>) {
        pendingUserInputs.entries.removeIf { it.value.future === future }
        if (pendingUserInputs.isEmpty()) broadcastAskUserPending(false)
    }

    /** 向所有面板广播反向请求挂起标志（看门狗豁免用，多标签同会话时无弹窗的面板也需感知）*/
    private fun broadcastAskUserPending(active: Boolean) {
        val msg = buildJsonObject {
            put("op", "askUserPending")
            put("active", active)
        }
        panels.forEach { it.pushToWebview(msg) }
    }

    override fun pushAskUserPendingState(panel: ZCodeToolWindowPanel) {
        // webview init 拉取（新开标签/页面重载错过广播的兜底）：有挂起请求才推
        if (pendingUserInputs.isNotEmpty()) {
            panel.pushToWebview(buildJsonObject {
                put("op", "askUserPending")
                put("active", true)
            })
        }
    }

    override fun abortPendingUserInputs(sessionId: String?, turnId: String?) {
        val victims = pendingUserInputs.entries.filter {
            (sessionId == null || it.value.sessionId == sessionId) && sameTurn(it.value.turnId, turnId)
        }
        if (victims.isEmpty()) return
        // 回合已死：complete 哨兵让各 handler 线程立即退出，协议层对哨兵改发
        // JSON-RPC error（服务端按请求失败处理，非"用户拒绝"）。旧策略"不 complete、
        // 线程 5 分钟超时自灭"实测更糟：超时 catch 照样向服务端补发迟到 decline/deny
        // （2026-08-26 实测一轮 39 条迟到应答），还白占线程 5 分钟；
        // 用户恰好同时应答时 complete 是 no-op，用户应答优先
        val targetPanels = victims.map { it.value.targetPanel }.distinct()
        val sentinel = buildJsonObject { put(DISCARD_MARKER, true) }
        victims.forEach {
            pendingUserInputs.remove(it.key)
            // 被废弃的权限族记哨兵缓存：该族迟到重发短路返回哨兵 → 协议层改发
            // error（与本次废弃同语义），不复活弹窗。此前废弃路径不记缓存，是
            // 「已废弃族重发复活弹窗」缺陷面的残留入口；askUser/ExitPlanMode 无族概念
            it.value.familyId?.let { fid -> familyAnswers[fid] = FamilyAnswer(sentinel, System.currentTimeMillis()) }
            it.value.future.complete(sentinel)
        }
        // ack 逐 victim 带 requestId（前端精确匹配关窗）：无差别单条 ack 会误关
        // 面板上其他回合/请求仍挂着的弹窗
        victims.forEach { v ->
            targetPanels.forEach { it?.pushToWebview(buildJsonObject { put("op", "askUserAck"); put("requestId", v.key) }) }
        }
        if (pendingUserInputs.isEmpty()) broadcastAskUserPending(false)
        val victimTurns = victims.map { "${it.key}@turn=${it.value.turnId ?: "null"}" }.joinToString(", ")
        log.info("[askUser] Turn interrupted (sessionId=${sessionId ?: "all"}, turn=${turnId ?: "any"}), discarding ${victims.size} dialog(s) [$victimTurns] on ${targetPanels.size} panel(s) with discard marker (no late answer sent)")
    }
}

/** 便捷扩展：project.zCodeService() */
fun Project.zCodeService(): ZCodeService = service<ZCodeServiceImpl>()
