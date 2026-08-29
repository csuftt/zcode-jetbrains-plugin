package com.zcode.ideaplugin

import com.zcode.ideaplugin.protocol.LogRedactor

import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.zcode.ideaplugin.protocol.ZCodeProtocolClient
import com.zcode.ideaplugin.ui.ZCodeToolWindowPanel
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
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

    private val log = com.intellij.openapi.diagnostic.Logger.getInstance("ZCodePlugin")

    companion object {
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

        /** 活跃 Service 实例（多项目并开各一个）；宿主探针聚合判定用，dispose 移除 */
        private val activeInstances = java.util.concurrent.CopyOnWriteArrayList<ZCodeServiceImpl>()

        /**
         * interaction/requestUserInput 等待用户
         * 应答的超时：超时自动 decline 并关弹窗。推送弹窗时随消息附带 deadlineMs
         * （= 当前时刻 + 本值），前端据此显示倒计时——两处必须同源，防显示与实际超时错位。
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
    }

    @Volatile
    private var client: ZCodeProtocolClient? = null

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

    /** handleStop 成功停止后标记（对齐 cc-gui isManuallyInterrupted：手动打断不提醒）*/
    override fun markManualStop(sessionId: String) {
        manualStopMarks[sessionId] = System.currentTimeMillis()
    }

    /** 回合收尾提醒（全局事件线程调用；异常不影响事件链路）*/
    private fun notifyTurnEndIfWanted(event: com.zcode.ideaplugin.protocol.model.SessionEvent) {
        try {
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
            com.zcode.ideaplugin.ui.ZCodeNotifyService.notifyTurnEnd(project, event.sessionId, body, failed)
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
            val newClient = ZCodeProtocolClient.start(
                zcodePath = env.zcodePath,
                credentials = env.credentials,
                nodePath = env.nodePath,
            )
            // requestRuntimePreferences 应答：三项与 ZCode 客户端共用 ~/.zcode/v2/setting.json
            // （设置页「工作区记忆」开关写的也是这份）。每次应答即时读文件——
            // 切换开关后新建会话立即生效，无需重启 app-server；memoryEnabled=false 时
            // CLI 强制 memory:{enabled:false}，MEMORY.md 自动记忆不注入上下文
            newClient.runtimePreferencesResponder = { _, _ ->
                val p = com.zcode.ideaplugin.ui.ZCodeClientSettingStore.readRuntimePrefs()
                com.zcode.ideaplugin.protocol.model.RuntimePreferences(
                    nativeSearchEnhancementsEnabled = p.nativeSearchEnhancementsEnabled,
                    memoryEnabled = p.memoryEnabled,
                    askUserQuestionAutoResolutionEnabled = p.askUserQuestionAutoResolutionEnabled,
                )
            }
            client = newClient
            // 协议就绪即注册反向请求 handler（幂等）。注册点放在这里而非仅面板初始化：
            // 面板初始化时环境未就绪会抛 EnvCheckException 跳过注册，若不在此补注册，
            // 用户配好环境后 handler 永远缺席（Mac 首启 PATH 探测失败即触发过）
            registerProtocolHandlersLocked(newClient)
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
                if (event.type == "turn.completed" || event.type == "turn.failed") {
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
        } catch (e: Exception) {
            log.warn("Protocol handler registration failed (will retry on next getClient): ${e.message}")
        }
    }

    override fun isStarted(): Boolean = client?.isAlive() == true

    override fun shutdown() {
        lock.withLock {
            client?.close()
            client = null
            // handler 注册标志随旧实例作废：getClient 换代后 registerProtocolHandlersLocked
            // 须在新 client 上重挂 askUser / browser-use handler。旧版不重置——环境变更
            // 触发 shutdown 后新 client 缺 handler，AskUserQuestion 被服务端自动 decline、
            // browser-use 反向请求报"宿主未注册"
            userInputHandlerRegistered = false
            permissionHandlerRegistered = false
            browserHandlerRegistered = false
        }
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
            // 收起按钮作用于「当前挂载 owner」——闭包读实时状态，跨标签迁移后仍然正确
            val panel = com.zcode.ideaplugin.ui.ZCodeBrowserPanel(project, onClose = {
                embeddedBrowserOwner?.hideEmbeddedBrowser()
            })
            sharedBrowserPanel = panel
            log.info("[browser-use] Global shared browser panel created (cross-session tab)")
            panel
        }
    }

    override fun getEmbeddedBrowserOwner(): ZCodeToolWindowPanel? = embeddedBrowserOwner

    override fun setEmbeddedBrowserOwner(panel: ZCodeToolWindowPanel?) {
        embeddedBrowserOwner = panel
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
                    put("deadlineMs", System.currentTimeMillis() + USER_INPUT_TIMEOUT_MS)
                }
                targetPanel.pushToWebview(askMsg)
                log.info("[askUser] ExitPlanMode plan approval pushed to frontend, waiting for user decision...")
            } else {
                // 普通 AskUserQuestion：{op:"askUser", requestId, questions, toolName}
                val questions = params["questions"] ?: kotlinx.serialization.json.JsonArray(emptyList())
                val askMsg = buildJsonObject {
                    put("op", "askUser")
                    put("requestId", serverRequestId)
                    put("toolName", toolName)
                    put("questions", questions)
                    put("deadlineMs", System.currentTimeMillis() + USER_INPUT_TIMEOUT_MS)
                }
                targetPanel.pushToWebview(askMsg)
                log.info("[askUser] Pushed to frontend, waiting for user selection...")
            }
            // 广播挂起标志（含未收到弹窗的面板——多标签同会话时弹窗只路由到一个标签，
            // 其余标签的流式看门狗靠它豁免，否则 60s 静默误判 streamLost 收尾回合）
            broadcastAskUserPending(true)
        }

        // 阻塞等用户选择（在协议客户端的独立线程，不阻塞 reader/EDT）。
        // 超时必须立即 decline 并关闭弹窗：悬空的等待线程 5 分钟后向服务端补发
        // 迟到的 decline，会被当作"用户拒绝了计划"（引发重复 ExitPlanMode）。
        return try {
            future.get(USER_INPUT_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
        } catch (e: java.util.concurrent.TimeoutException) {
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
            buildJsonObject {
                put("action", "accept")
                put("content", buildJsonObject {
                    if (answers != null && !answers.isEmpty()) {
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
        log.info("[askUser] User answered, responding to server: action=$action answer=$normalizedAnswer")
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
