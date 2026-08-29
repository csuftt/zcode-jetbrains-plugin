package com.zcode.ideaplugin.ui

import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.zcode.ideaplugin.ZCodeBundle
import com.zcode.ideaplugin.protocol.model.Workspace
import com.zcode.ideaplugin.protocol.ZCodeProtocolException
import com.zcode.ideaplugin.zCodeService
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * 会话内定时消息（B1 改判形态，2026-08-29）：用户给提示词指定执行时间，到点自动发出。
 *
 * 典型动机=额度经济（高峰倍率/额度刷新点后执行，不用掐点等）。纯客户端调度，零协议新依赖。
 *
 * 架构：
 *  - 权威待发列表在本服务（PropertiesComponent 持久化，跨 IDE 重启不丢），webview 只做镜像渲染；
 *  - 到点分派优先走 webview 准入路径（推 scheduledDue 给会话所在标签 → 前端 sendMessage：
 *    回合活跃入队尾/空闲直接发，与手动 Enter 同一段代码）；推送后 15s 无 ack 重推一轮
 *    （标签刚打开时前端 boot 未就绪），仍无 ack 降级本服务直发；
 *  - 标签不在/懒加载未激活：先打开标签、不直发——直发会让回合跑在无人订阅的窗口里，
 *    标签打开后流式接不上（要等回合完成才看到内容，实测）；下轮扫描改走准入推送；
 *  - 直发兜底（两轮推送均无 ack/面板中途消失）：client.send + 冷会话 -32004 resume 重试 +
 *    悬挂回合 -32010 延迟重扫（绝不 stop——定时消息不许打断正在跑的回合），成功后系统通知；
 *  - 错过策略：到点后 [GRACE_MS]（默认 30min）内扫到即补发；超宽限保持待发但卡片呈
 *    「已过期」，由用户决定立即执行/重新定时（避免 9 点高峰替用户跑 6 点想省倍率的单）；
 *  - 切会话回退例外：带定时标记的排队消息在切会话丢弃时经 scheduledRequeue 回到本服务
 *    （hold=true 不自动发，用户切回来再决定）。
 */
@Service(Service.Level.PROJECT)
class ZCodeScheduledMessageService(private val project: Project) : Disposable {

    companion object {
        private val log = Logger.getInstance(ZCodeScheduledMessageService::class.java)

        /** PropertiesComponent 存储 key（project 级，JSON 数组） */
        const val STORAGE_KEY = "zcode.scheduledMessages.v1"

        /** 已发记录存储 key（project 级，JSON 数组）——持久「定时执行」徽标数据源 */
        const val FIRED_STORAGE_KEY = "zcode.scheduledFiredHistory.v1"

        /** 已发记录上限（新记录插头部，超出丢最旧）——仅服务于徽标匹配与列表尾页，按用户要求只留最新 5 条 */
        const val FIRED_MAX = 5

        /** 到点后自动补发的宽限窗：超过则转「已过期」卡等用户手动决定 */
        const val GRACE_MS: Long = 30 * 60_000L

        /** scheduledDue 推送后等待 webview ack 的时长，超时降级直发 */
        private const val DUE_ACK_TIMEOUT_MS = 15_000L

        /** scheduledDue 最大推送轮次：标签刚打开时前端 boot 未就绪（currentSessionId 未到位），
         *  第一轮推送会被忽略，给第二轮机会；仍无 ack 才直发兜底 */
        private const val DUE_MAX_PUSH_ATTEMPTS = 2

        /** 扫描周期（墙钟判定，抗系统睡眠：醒来后按实际时间补判） */
        private const val SWEEP_PERIOD_MS = 20_000L

        fun getInstance(project: Project): ZCodeScheduledMessageService = project.getService(ZCodeScheduledMessageService::class.java)

        // ============ 纯逻辑（单测直接覆盖，不依赖 Project） ============

        /** 到点且在宽限窗内才自动分派；hold（切会话回退挂起）永不自动 */
        fun shouldAutoFire(item: Item, now: Long, graceMs: Long = GRACE_MS): Boolean =
            !item.hold && item.fireAt <= now && now - item.fireAt <= graceMs

        fun itemsToJson(list: List<Item>): JsonArray = buildJsonArray {
            list.forEach { it ->
                add(
                    buildJsonObject {
                        put("id", it.id)
                        put("sessionId", it.sessionId)
                        put("workspacePath", it.workspacePath)
                        put("text", it.text)
                        put("fireAt", it.fireAt)
                        put("createdAt", it.createdAt)
                        put("hold", it.hold)
                        // 执行模型（可空=跟随会话当前模型）；条件 put 防 null 重载歧义
                        it.providerId?.let { v -> put("providerId", v) }
                        it.modelId?.let { v -> put("modelId", v) }
                    }
                )
            }
        }

        fun parseItems(raw: String?): List<Item> {
            if (raw.isNullOrBlank()) return emptyList()
            return try {
                Json.parseToJsonElement(raw).jsonArray.mapNotNull { el ->
                    val o = el as? JsonObject ?: return@mapNotNull null
                    val id = o["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                    val sessionId = o["sessionId"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                    val text = o["text"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                    val fireAt = o["fireAt"]?.jsonPrimitive?.longOrNull ?: return@mapNotNull null
                    Item(
                        id = id,
                        sessionId = sessionId,
                        workspacePath = o["workspacePath"]?.jsonPrimitive?.contentOrNull ?: "",
                        text = text,
                        fireAt = fireAt,
                        createdAt = o["createdAt"]?.jsonPrimitive?.longOrNull ?: 0L,
                        hold = o["hold"]?.jsonPrimitive?.booleanOrNull ?: false,
                        providerId = o["providerId"]?.jsonPrimitive?.contentOrNull,
                        modelId = o["modelId"]?.jsonPrimitive?.contentOrNull,
                    )
                }
            } catch (_: Exception) {
                emptyList()
            }
        }

        fun firedToJson(list: List<FireRecord>): JsonArray = buildJsonArray {
            list.forEach { f ->
                add(
                    buildJsonObject {
                        put("sessionId", f.sessionId)
                        put("text", f.text)
                        put("fireAt", f.fireAt)
                        put("firedAt", f.firedAt)
                    }
                )
            }
        }

        fun parseFired(raw: String?): List<FireRecord> {
            if (raw.isNullOrBlank()) return emptyList()
            return try {
                Json.parseToJsonElement(raw).jsonArray.mapNotNull { el ->
                    val o = el as? JsonObject ?: return@mapNotNull null
                    FireRecord(
                        sessionId = o["sessionId"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null,
                        text = o["text"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null,
                        fireAt = o["fireAt"]?.jsonPrimitive?.longOrNull ?: return@mapNotNull null,
                        firedAt = o["firedAt"]?.jsonPrimitive?.longOrNull ?: 0L,
                    )
                }
            } catch (_: Exception) {
                emptyList()
            }
        }
    }

    /** 待发定时消息（FIRED/CANCELLED 即时移除不保留——发出后的消息本身就是记录） */
    data class Item(
        val id: String,
        val sessionId: String,
        val workspacePath: String,
        val text: String,
        val fireAt: Long,
        val createdAt: Long,
        /** 切会话回退的挂起项：永不自动发，只呈「已过期」式卡片等用户手动决定 */
        val hold: Boolean = false,
        /** 执行模型（可空=跟随会话当前模型）；执行时模型不在清单则默认兜底 */
        val providerId: String? = null,
        val modelId: String? = null,
    )

    /**
     * 已发定时消息记录：消息真正发出后留存（sessionId+text 匹配），供 webview 渲染
     * 「定时执行」徽标——后台直发/历史重拉/IDE 重启后，服务端消息本身不带任何定时标记，
     * 只能靠这条本地映射还原。webview 真发（sendMessage）与 Java 直发两条路径都上报。
     */
    data class FireRecord(
        val sessionId: String,
        val text: String,
        val fireAt: Long,
        val firedAt: Long,
    )

    private val items = CopyOnWriteArrayList<Item>()

    private val fired = CopyOnWriteArrayList<FireRecord>()

    /** 已推送 scheduledDue、等待 webview ack 的 id（超时降级直发） */
    private val awaitingAck = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    /** 已在「过期」日志播报过的 id（防扫看日志风暴） */
    private val expiredLogged = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    private val executor = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "ZCode-ScheduledMessage-Sweep").apply { isDaemon = true }
    }

    init {
        loadFromStorage()
        loadFired()
        Disposer.register(this) { executor.shutdownNow() }
        executor.scheduleWithFixedDelay({ sweepSafely() }, SWEEP_PERIOD_MS / 2, SWEEP_PERIOD_MS, TimeUnit.MILLISECONDS)
        log.info("[scheduled] service initialized, pending=${items.size} fired=${fired.size}")
    }

    // ============ 对 webview 的 op 入口（ZCodeToolWindowPanel 分发） ============

    /** op:scheduledCreate——新建定时消息（fireAt 过早时钳到 +10s；可指定执行模型，空=跟随会话） */
    fun create(
        sessionId: String,
        workspacePath: String,
        text: String,
        fireAt: Long,
        providerId: String? = null,
        modelId: String? = null,
    ): Item? {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return null
        val now = System.currentTimeMillis()
        val item = Item(
            id = "sched_${now}_${(100..999).random()}",
            sessionId = sessionId,
            workspacePath = workspacePath,
            text = trimmed,
            fireAt = maxOf(fireAt, now + 10_000),
            createdAt = now,
            providerId = providerId?.takeIf { it.isNotBlank() },
            modelId = modelId?.takeIf { it.isNotBlank() },
        )
        items.add(item)
        persistAndBroadcast()
        log.info("[scheduled] created id=${item.id} session=$sessionId fireAt=${item.fireAt}")
        return item
    }

    fun cancel(id: String): Boolean = removeById(id, "cancel")

    /**
     * op:scheduledReschedule——改时间（可同时改提示词）并解除挂起（重定时间=重新参与自动分派）。
     * updateModel=true 时一并更新执行模型（modelId/providerId 空串=清空改回跟随会话）。
     */
    fun reschedule(
        id: String,
        fireAt: Long,
        text: String? = null,
        providerId: String? = null,
        modelId: String? = null,
        updateModel: Boolean = false,
    ): Boolean {
        val idx = items.indexOfFirst { it.id == id }
        if (idx < 0) return false
        val old = items[idx]
        val newText = text?.trim().takeUnless { it.isNullOrEmpty() } ?: old.text
        items[idx] = if (updateModel) {
            old.copy(
                text = newText,
                fireAt = maxOf(fireAt, System.currentTimeMillis() + 10_000),
                hold = false,
                providerId = providerId?.takeIf { it.isNotBlank() },
                modelId = modelId?.takeIf { it.isNotBlank() },
            )
        } else {
            old.copy(text = newText, fireAt = maxOf(fireAt, System.currentTimeMillis() + 10_000), hold = false)
        }
        expiredLogged.remove(id)
        persistAndBroadcast()
        log.info("[scheduled] rescheduled id=$id fireAt=${items[idx].fireAt} (textEdited=${newText != old.text})")
        return true
    }

    /** op:scheduledSendNow——立即执行（走与到点一致的准入分派；挂起项同样放行）。
     *  项不存在时静默成功：webview 镜像可能滞后（乐观移除已发生/广播在途），报错只会误导 */
    fun sendNow(id: String): Boolean {
        val item = items.firstOrNull { it.id == id } ?: return true
        dispatch(item)
        return true
    }

    /** op:scheduledRequeue——切会话丢弃队列时，定时来源的消息回退挂起（不自动发；执行模型随行保留） */
    fun requeueOnSessionLeave(
        sessionId: String,
        workspacePath: String,
        text: String,
        fireAt: Long,
        providerId: String? = null,
        modelId: String? = null,
    ) {
        val trimmed = text.trim()
        if (sessionId.isBlank() || trimmed.isEmpty()) return
        val now = System.currentTimeMillis()
        items.add(
            Item(
                id = "sched_${now}_${(100..999).random()}",
                sessionId = sessionId,
                workspacePath = workspacePath,
                text = trimmed,
                fireAt = fireAt,
                createdAt = now,
                hold = true,
                providerId = providerId?.takeIf { it.isNotBlank() },
                modelId = modelId?.takeIf { it.isNotBlank() },
            )
        )
        persistAndBroadcast()
        log.info("[scheduled] requeued (hold) session=$sessionId fireAt=$fireAt")
    }

    /** op:scheduledDueAck——webview 已受理到点消息（入队或已发），移除并广播 */
    fun onDueAck(id: String) {
        if (awaitingAck.remove(id)) {
            log.info("[scheduled] due ack received id=$id")
        }
        removeById(id, "fired-ack")
    }

    /** op:scheduledFired——webview 真发定时消息上报（sendMessage 真发点；直发路径服务端自记） */
    fun onFiredReport(sessionId: String, text: String, fireAt: Long) {
        recordFired(sessionId, text, fireAt)
    }

    /** 记录一条已发定时消息（同 sessionId+text+fireAt 幂等；随 scheduledList 广播给全部面板） */
    private fun recordFired(sessionId: String, text: String, fireAt: Long) {
        if (sessionId.isBlank() || text.isBlank()) return
        if (fired.any { it.sessionId == sessionId && it.text == text && it.fireAt == fireAt }) return
        fired.add(0, FireRecord(sessionId, text, fireAt, System.currentTimeMillis()))
        while (fired.size > FIRED_MAX) fired.removeAt(fired.size - 1)
        persistFired()
        broadcastList()
        log.info("[scheduled] fired recorded session=$sessionId fireAt=$fireAt total=${fired.size}")
    }

    /** op:scheduledList——webview 初始化水合：把全量列表推给请求面板 */
    fun pushListTo(panel: ZCodeToolWindowPanel) {
        panel.pushToWebview(buildListMessage())
    }

    /** 会话删除/归档：丢弃该会话的全部待发消息与已发记录 */
    fun dropForSession(sessionId: String) {
        val removed = items.removeIf { it.sessionId == sessionId }
        val removedFired = fired.removeIf { it.sessionId == sessionId }
        if (removed || removedFired) {
            if (removedFired) persistFired()
            persistAndBroadcast()
            log.info("[scheduled] dropped all for session=$sessionId (fired=$removedFired)")
        }
    }

    // ============ 扫描与分派 ============

    private fun sweepSafely() {
        try {
            sweep(System.currentTimeMillis())
        } catch (e: Exception) {
            log.warn("[scheduled] sweep failed: ${e.message}")
        }
    }

    internal fun sweep(now: Long) {
        val due = items.filter { shouldAutoFire(it, now) }
        // 超宽限的播报一次（卡片由 webview 按 fireAt 自行呈「已过期」态）
        items.filter { !it.hold && it.fireAt <= now - GRACE_MS }
            .forEach { if (expiredLogged.add(it.id)) log.info("[scheduled] expired beyond grace, holding for manual decision id=${it.id}") }
        due.forEach { dispatch(it) }
    }

    /**
     * 分派单条：优先 webview 准入路径（回合活跃入队尾/空闲直接发，与手动发送同一段代码）。
     * 标签不在/懒加载未激活时**先开标签、不直发**——直发会让回合跑在无人订阅的窗口里，
     * 标签打开后流式接不上（只能等回合完成才看到内容，实测）；开标签后下轮扫描改走推送，
     * 消息由前端在订阅就绪后发出，流式全程在线。无会话项（sessionId 空）路由当前激活面板。
     */
    private fun dispatch(item: Item) {
        if (!awaitingAck.add(item.id)) return // 已在途，防重入
        val sessionless = item.sessionId.isBlank()
        val panelReady = if (sessionless) {
            project.zCodeService().getActivePanel()?.canPushToWebview() == true
        } else {
            project.zCodeService().findPanelForSession(item.sessionId)?.canPushToWebview() == true
        }
        if (panelReady) {
            pushDue(item, 1)
        } else if (sessionless) {
            awaitingAck.remove(item.id)
            log.info("[scheduled] no active panel for session-less item, will retry next sweep id=${item.id}")
        } else {
            awaitingAck.remove(item.id)
            log.info("[scheduled] no ready panel, opening session tab first (fires via webview next sweep) id=${item.id} session=${item.sessionId}")
            openSessionTabOnEdt(item.sessionId)
        }
    }

    /**
     * webview 准入推送（scheduledDue）：前端受理（入队或已发）即 ack。[DUE_MAX_PUSH_ATTEMPTS]
     * 轮无 ack 且面板仍就绪则重推（标签刚打开 boot 慢），面板不在或轮次用尽才直发兜底。
     */
    private fun pushDue(item: Item, attempt: Int) {
        val sessionless = item.sessionId.isBlank()
        val panel = if (sessionless) project.zCodeService().getActivePanel()
        else project.zCodeService().findPanelForSession(item.sessionId)
        if (panel == null || !panel.canPushToWebview()) {
            awaitingAck.remove(item.id)
            if (sessionless) {
                log.info("[scheduled] no active panel for session-less item, will retry next sweep id=${item.id}")
            } else {
                log.warn("[scheduled] panel gone before push, falling back to direct send id=${item.id}")
                directSend(item)
            }
            return
        }
        log.info("[scheduled] dispatch via webview (attempt=$attempt) id=${item.id} session=${item.sessionId.ifBlank { "<standby>" }}")
        panel.pushToWebview(
            buildJsonObject {
                put("op", "scheduledDue")
                put("id", item.id)
                put("sessionId", item.sessionId)
                put("text", item.text)
                put("scheduledFireAt", item.fireAt)
                item.providerId?.let { v -> put("providerId", v) }
                item.modelId?.let { v -> put("modelId", v) }
            }
        )
        executor.schedule({
            if (awaitingAck.remove(item.id)) {
                val stillReady = !sessionless &&
                    project.zCodeService().findPanelForSession(item.sessionId)?.canPushToWebview() == true
                if (attempt < DUE_MAX_PUSH_ATTEMPTS && stillReady) {
                    log.info("[scheduled] due ack timeout, webview likely still booting, retry push id=${item.id}")
                    pushDue(item, attempt + 1)
                } else if (sessionless) {
                    log.info("[scheduled] due ack timeout for session-less item, will retry next sweep id=${item.id}")
                } else {
                    log.warn("[scheduled] due ack timeout, falling back to direct send id=${item.id}")
                    directSend(item)
                }
            }
        }, DUE_ACK_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    }

    /**
     * 直发：冷会话 -32004 先 resume 再重试；-32010（prompt running）延迟重扫——
     * 定时消息绝不 stop 打断正在跑的回合；指定模型已下架（-32603 Unsupported model）
     * 按约定默认兜底（不带模型=会话当前/服务端默认）重试一次；其余错误保持待发下轮再试。
     * 成功即移除+记录已发+通知。
     */
    private fun directSend(item: Item) {
        val sent = try {
            val client = project.zCodeService().getClient()
            try {
                client.send(item.sessionId, item.text, item.workspacePath, providerId = item.providerId, modelId = item.modelId)
                true
            } catch (e: ZCodeProtocolException) {
                val cold = e.message?.contains("-32004") == true ||
                    e.message?.contains("Session is not active", ignoreCase = true) == true
                val running = e.code == -32010 || e.message?.contains("-32010") == true
                val unsupportedModel = (e.code == -32603 || e.message?.contains("-32603") == true) &&
                    e.message?.contains("Unsupported model", ignoreCase = true) == true
                when {
                    unsupportedModel && item.modelId != null -> {
                        log.info("[scheduled] specified model unavailable, falling back to default id=${item.id} model=${item.modelId}")
                        client.send(item.sessionId, item.text, item.workspacePath)
                        true
                    }
                    cold -> {
                        client.resume(item.sessionId, Workspace(item.workspacePath))
                        client.send(item.sessionId, item.text, item.workspacePath, providerId = item.providerId, modelId = item.modelId)
                        true
                    }
                    running -> {
                        log.info("[scheduled] session busy (-32010), deferring id=${item.id}")
                        false
                    }
                    else -> {
                        log.warn("[scheduled] direct send failed (will retry next sweep) id=${item.id}: ${e.message}")
                        false
                    }
                }
            }
        } catch (e: Exception) {
            log.warn("[scheduled] direct send failed (client not ready? will retry) id=${item.id}: ${e.message}")
            false
        }
        if (sent) {
            removeById(item.id, "fired-direct")
            recordFired(item.sessionId, item.text, item.fireAt)
            ZCodeNotifyService.notifyScheduledFired(project, item.sessionId, item.text)
            openSessionTabOnEdt(item.sessionId)
        }
    }

    /**
     * 直发成功后把对应会话标签打开到前台（实时交互可见）——标签已关/JCEF 未建时消息
     * 走了 Java 侧后台发送，回合在跑但用户无窗口可看；自动恢复标签让流式过程即时呈现。
     */
    private fun openSessionTabOnEdt(sessionId: String) {
        com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            try {
                ZCodeToolWindowFactory.openSessionTab(project, sessionId)
            } catch (e: Exception) {
                log.warn("[scheduled] open session tab failed: ${e.message}")
            }
        }
    }

    // ============ 存储与广播 ============

    private fun removeById(id: String, reason: String): Boolean {
        val removed = items.removeIf { it.id == id }
        if (removed) {
            awaitingAck.remove(id)
            persistAndBroadcast()
            log.info("[scheduled] removed id=$id reason=$reason")
        }
        return removed
    }

    private fun persistAndBroadcast() {
        persist()
        broadcastList()
    }

    internal fun broadcastList() {
        val msg = buildListMessage()
        project.zCodeService().broadcastToWebviews(msg)
    }

    /**
     * 全量快照消息：ts=单调取号时间戳，webview 只应用比已应用更新（ts 更大）的快照——
     * 多线程广播（scheduledFired 上报与 scheduledDueAck 处理并发）到达顺序不保证，
     * 旧快照后到会把已移除的项「复活」回镜像（实测卡片残留根因之一）。
     */
    private fun buildListMessage(): JsonObject = buildJsonObject {
        put("op", "scheduledList")
        put("ts", System.currentTimeMillis())
        put("items", itemsToJson(items.sortedBy { it.fireAt }))
        put("fired", firedToJson(fired))
    }

    private fun persist() {
        try {
            PropertiesComponent.getInstance(project).setValue(STORAGE_KEY, Json.encodeToString(JsonArray.serializer(), itemsToJson(items)))
        } catch (e: Exception) {
            log.warn("[scheduled] persist failed: ${e.message}")
        }
    }

    private fun persistFired() {
        try {
            PropertiesComponent.getInstance(project).setValue(FIRED_STORAGE_KEY, Json.encodeToString(JsonArray.serializer(), firedToJson(fired)))
        } catch (e: Exception) {
            log.warn("[scheduled] persist fired failed: ${e.message}")
        }
    }

    private fun loadFromStorage() {
        try {
            val raw = PropertiesComponent.getInstance(project).getValue(STORAGE_KEY) ?: return
            items.addAll(parseItems(raw))
        } catch (e: Exception) {
            log.warn("[scheduled] load failed: ${e.message}")
        }
    }

    private fun loadFired() {
        try {
            val raw = PropertiesComponent.getInstance(project).getValue(FIRED_STORAGE_KEY) ?: return
            fired.addAll(parseFired(raw))
        } catch (e: Exception) {
            log.warn("[scheduled] load fired failed: ${e.message}")
        }
    }

    /** 测试/诊断用快照 */
    internal fun snapshot(): List<Item> = items.toList()

    override fun dispose() {
        // executor 的关闭在 init 里 Disposer.register（保证先于服务字段回收）
    }
}
