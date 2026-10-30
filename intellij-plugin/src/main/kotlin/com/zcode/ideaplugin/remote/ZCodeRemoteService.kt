package com.zcode.ideaplugin.remote

import com.intellij.credentialStore.Credentials
import com.intellij.ide.passwordSafe.PasswordSafe
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.zcode.ideaplugin.ZCodeBundle
import com.zcode.ideaplugin.ZCodeServiceImpl
import com.zcode.ideaplugin.protocol.relay.ChannelCodec
import com.zcode.ideaplugin.protocol.relay.JdkWebSocketTransportFactory
import com.zcode.ideaplugin.protocol.relay.Relay
import com.zcode.ideaplugin.protocol.relay.RelayClient
import com.zcode.ideaplugin.protocol.relay.RelayCredentials
import com.zcode.ideaplugin.protocol.relay.RelayCrypto
import com.zcode.ideaplugin.protocol.relay.RelayState
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * 手机远程会话宿主（APPLICATION 级单例）：一条 relay device 连接 + 多 workspace 聚合
 * （对齐官方桌面宿主模型；同凭据并发连接会被 relay KICKED，故必须进程级单连接）。
 *
 * 生命周期：懒启动（用户从 webview 发起配对才连接）；凭据稳定存储于 PasswordSafe
 * （手机 H5 localStorage 靠它免重扫码）；IDE 关闭 dispose 断连。
 */
@Service(Service.Level.APP)
class ZCodeRemoteService : Disposable {

    private val log = Logger.getInstance("ZCodePlugin")
    private val json = Json { ignoreUnknownKeys = true }
    private val router = RemoteChannelRouter()

    /** channel 转发执行器（app-server 调用可阻塞，严禁占用 WS 回调线程） */
    private val channelExecutor = java.util.concurrent.Executors.newCachedThreadPool { r ->
        Thread(r, "zcode-remote-channel").apply { isDaemon = true }
    }

    /** v4 帧推送专用单线程（保序）：帧泵回调在 app-server 读线程执行，而 sendJson 持锁
     *  同步发送最多等 10s——relay 变慢会连带冻结 IDE 自身事件处理（2026-09-22 审查）。
     *  有界队列防 relay 僵死时无限堆积，满即丢帧记日志（H5 resync 兜底恢复） */
    private val framePushExecutor = java.util.concurrent.ThreadPoolExecutor(
        1, 1, 0L, java.util.concurrent.TimeUnit.MILLISECONDS,
        java.util.concurrent.LinkedBlockingQueue(2000),
    ) { r -> Thread(r, "zcode-remote-frame-push").apply { isDaemon = true } }

    @Volatile private var client: RelayClient? = null

    /** 推给 webview 的状态机：off → connecting → waiting → paired；error/kicked 可从任意态进入 */
    enum class UiState { OFF, CONNECTING, WAITING, PAIRED, ERROR, KICKED }

    private var uiState = UiState.OFF
        set(value) {
            field = value
            broadcastState()
        }

    @Volatile private var lastQrUrl: String? = null
    @Volatile private var lastError: String? = null

    val deviceName: String
        get() = "ZCode JetBrains (${com.intellij.openapi.application.ApplicationInfo.getInstance().versionName})"

    // ============ 对外操作（webview op → 这里） ============

    /** 远程开启开关持久化（IDE 重启后恢复连接状态，2026-09-24 用户需求）：
     *  发起连接即记开、显式断开记关——unpair 内部 disconnect→connect 最终仍为开 */
    private fun persistEnabled(enabled: Boolean) {
        runCatching {
            com.intellij.ide.util.PropertiesComponent.getInstance().setValue(PERSIST_KEY_ENABLED, enabled, false)
        }.onFailure { log.warn("remote persist enabled=$enabled failed: ${it.message}") }
    }

    @Synchronized
    fun connect(): JsonObject {
        if (client != null && client!!.currentState != RelayState.CLOSED && client!!.currentState != RelayState.KICKED) {
            return statusJson() // 已在运行
        }
        persistEnabled(true)
        val credentials = loadOrCreateCredentials()
        // 宿主版本 = 本机 ZCode App 版本（app_version 语义是客户端 3.x 体系，非 CLI
        // 包版本 0.16.x——旧值触发 H5 侧拉 cdn.zcode-ai.com 兼容配置，该 CDN 不可用
        // → 手机页面反复刷新，缺陷CZ）。asar 读 package.json，mtime 缓存零重复解析；
        // 读不到时 QR URL 不带该参数（实测 H5 正常加载），auth_init 仍走兜底常量
        val detectedAppVersion = resolveHostAppVersion()
        val hostAppVersion = detectedAppVersion ?: Relay.APP_VERSION
        // relay WS 由插件进程直发：代理环境下直连不通，须显式挂共享 setting.json 的
        // 代理（与官方客户端同源三键；noProxy 后缀匹配内建于 selector，额度 monitor
        // HTTP 同规则）。重连复用同一 factory 实例，selector 无需重建
        val proxySelector = com.zcode.ideaplugin.protocol.ProxyConfigStore.read().let { proxyConfig ->
            log.info("remote relay proxy: ${proxyConfig.logSummary}")
            proxyConfig.toJavaProxySelector()
        }
        val relayClient = RelayClient(
            config = RelayClient.RelayConfig(deviceName = deviceName.take(64), appVersion = hostAppVersion),
            credentials = credentials,
            transportFactory = JdkWebSocketTransportFactory(proxySelector),
        )
        relayClient.onDeviceRegistered = { updated ->
            saveCredentials(updated)
            log.info("remote device registered: ${updated.deviceSid}")
        }
        relayClient.onStateChange = { state ->
            when (state) {
                RelayState.WAITING_TERMINAL -> {
                    lastQrUrl = relayClient.credentials.deviceSid?.let {
                        RelayCrypto.buildQrUrl(relayClient.credentials, deviceName.take(64), appVersion = detectedAppVersion)
                    }
                    uiState = UiState.WAITING
                }
                RelayState.PAIRED -> {
                    if (uiState == UiState.WAITING || uiState == UiState.CONNECTING) {
                        notify("phonePaired")
                    }
                    uiState = UiState.PAIRED
                    channelExecutor.execute { runCatching { ensureV4Pumps() } }
                }
                RelayState.KICKED -> { uiState = UiState.KICKED; lastError = "KICKED" }
                else -> Unit
            }
        }
        relayClient.onRelayError = { code, message ->
            lastError = "relay $code: ${message?.take(120)}"
            // 仅连接建立期的错误帧视为致命（注册被拒等）；PAIRED/WAITING 运行期的
            // error 帧（terminal 断连类 INTERNAL 通知，与 H5 断连振荡同源同批）不改
            // UI——此前一刀切置 ERROR 造出「假异常」：连接实际健在（remotePairStart
            // 已被运行守卫短路），弹窗却显示连接异常、出不了码，用户无从自救
            if (code != null && uiState != UiState.PAIRED && uiState != UiState.WAITING) {
                uiState = UiState.ERROR
            }
        }
        relayClient.onPayload = { payload, sender ->
            router.handlePayload(payload, sender)
            // bridge-ready 后立即推 channel Initialize（探针定案：缺它手机服务调用全挂起）
            if (payload["zcode_type"]?.jsonPrimitive?.content == com.zcode.ideaplugin.protocol.relay.Relay.PAYLOAD_WORKSPACE_BRIDGE_OPEN) {
                val bridgeId = payload["bridgeSessionId"]?.jsonPrimitive?.content
                if (bridgeId != null) {
                    val recoveryId = payload["recoveryId"]?.jsonPrimitive?.content
                    // 单页单桥：新桥建立即全量淘汰旧桥（旧「90s 无活动」判据永不命中，
                    // 僵尸桥双推帧放大流量是页面偶发刷新根因之一，缺陷 DH）
                    handlers.retireStaleBridges(bridgeId)
                    handlers.context(bridgeId)?.let { it.recoveryId = recoveryId }
                    relayClient.sendChannelMessage(bridgeId, ChannelCodec.encodeInitialize())
                }
            }
        }

        relayClient.onChannelRequest = { bridgeId, request, responder ->
            channelExecutor.execute {
                router.handleChannelRequest(bridgeId, request, responder) { project, req, resp ->
                    handleKnownChannel(project, bridgeId, req, resp)
                }
            }
        }
        relayClient.onChannelEventListen = { bridgeId, listenerId, channel, event, _ ->
            router.handleEventListen(bridgeId, listenerId, channel, event)
        }
        relayClient.onChannelEventDispose = { listenerId -> router.handleEventDispose(listenerId) }
        relayClient.onTerminalChurn = {
            // 只通知、不再自动重置 pair（2026-09-23 真机实锤重置是伤害放大器）：
            // 重置会重注册换新 deviceSid，已扫码页面 URL 里的旧 sid 追不上 → 手机页
            // 被踢断后重连风暴 → 凑满下一轮 churn → 再重置，反馈循环永不停机。
            // 且单页弱网同样产生真实翻转（WS 微断 + pair_status ACK 抖动 + 桥重建），
            // churn 无法区分「多页互顶」与「单页弱网」，误伤率不可接受。
            // 多页互顶的正确处置只有用户关闭多余页面（通知提示，5min 去抖）
            log.info("terminal churn detected → notify only (pair reset removed)")
            notifyTerminalChurn()
        }

        client = relayClient
        lastError = null
        uiState = UiState.CONNECTING
        try {
            relayClient.connect()
            relayClient.startHeartbeat()
        } catch (e: Exception) {
            lastError = e.message?.take(200) ?: e.javaClass.simpleName
            uiState = UiState.ERROR
        }
        return statusJson()
    }

    @Synchronized
    fun disconnect(): JsonObject {
        runCatching { client?.close() }
        client = null
        // 桥随 pair 会话终止：不清会让僵尸桥跨 pair 存活，被 relay 放大成
        // INTERNAL 清算风暴并卡死新 terminal 初始化（详见 clearAllBridges 注释）
        channelExecutor.execute { runCatching { handlers.clearAllBridges("disconnect") } }
        lastQrUrl = null
        lastError = null
        uiState = UiState.OFF
        persistEnabled(false)
        return statusJson()
    }

    /**
     * 启动恢复（项目打开 Activity 调用，多项目打开会多次触发、幂等）：上次退出时
     * 远程开着 → 自动重连。仅在「开关开 + 已有配对凭据」时发起——从没用过远程的
     * 用户不会被静默注册新设备（loadOrCreateCredentials 的兜底创建只留给显式操作）。
     * PasswordSafe 读取与 relay 握手都放后台线程，不阻塞启动。
     */
    fun restoreIfEnabled() {
        ApplicationManager.getApplication().executeOnPooledThread {
            runCatching {
                val enabled = com.intellij.ide.util.PropertiesComponent.getInstance().getBoolean(PERSIST_KEY_ENABLED, false)
                if (!enabled) return@executeOnPooledThread
                val stored = PasswordSafe.instance.get(credentialAttributes())
                if (stored == null) {
                    log.info("remote restore skipped (enabled but no credentials)")
                    return@executeOnPooledThread
                }
                log.info("remote restore: reconnecting after restart")
                connect()
            }.onFailure { log.warn("remote restore failed: ${it.message}") }
        }
    }

    /** 清除配对（凭据重置为全新设备，下次 connect 重新注册） */
    @Synchronized
    fun unpair(): JsonObject {
        disconnect()
        PasswordSafe.instance.set(credentialAttributes(), null)
        log.info("remote credentials cleared")
        // 解除后立即重连注册全新设备出新码：用户解除的唯一目的就是重新扫码，
        // 若停在 off 态，弹窗只剩「未连接+暂无配对码」且断开按钮禁用，形同无响应
        return runCatching { connect() }.getOrElse { statusJson() }
    }

    /** 宿主 App 版本原始读取（可空；QR URL 读不到不传参，auth_init 由调用方兜底） */
    private fun resolveHostAppVersion(): String? = runCatching {
        com.zcode.ideaplugin.protocol.relay.DesktopAppVersion
            .read(com.zcode.ideaplugin.protocol.ZCodeLocator.detect())
    }.getOrNull()

    /**
     * 强制重出码（弹窗「刷新二维码」）：connect() 已运行时幂等返回旧码，二维码过期后
     * 用户点刷新无效。重算 buildQrUrl（sid/hash 不变=同一配对，仅 t 时间戳刷新）并广播。
     */
    @Synchronized
    fun refreshQr(): JsonObject {
        val creds = client?.credentials
        if (creds?.deviceSid == null) return statusJson()
        lastQrUrl = RelayCrypto.buildQrUrl(creds, deviceName.take(64), appVersion = resolveHostAppVersion())
        broadcastState()
        return statusJson()
    }

    fun statusJson(): JsonObject = buildJsonObject {
        put("op", "remoteState")
        put("state", uiState.name.lowercase())
        put("deviceName", deviceName)
        lastQrUrl?.let { put("qrUrl", it) }
        lastError?.let { put("error", it) }
    }

    override fun dispose() {
        runCatching { client?.close() }
        client = null
        channelExecutor.shutdownNow()
        framePushExecutor.shutdownNow()
        bridgeSweeper.shutdownNow()
    }

    // ============ M3：channel 语义与事件泵 ============

    private val handlers = RemoteChannelHandlers(this)

    /** 僵尸桥巡检（60s 一扫）：H5 页面关闭后无新 bridge-open，retireStaleBridges
     *  永无触发机会，须由定时器按 STALE_BRIDGE_MS 兜底清理 */
    private val bridgeSweeper = java.util.concurrent.ScheduledThreadPoolExecutor(1) { r ->
        Thread(r, "zcode-remote-bridge-sweeper").apply { isDaemon = true }
    }.apply {
        scheduleWithFixedDelay({ runCatching { handlers.sweepStaleBridges(); sweepRunningSessions() } }, 60_000L, 60_000L, java.util.concurrent.TimeUnit.MILLISECONDS)
    }

    // ============ H5 首页任务行实时相位 ============

    /** 回合运行中的会话集合：session/list 快照的 status 只在订阅/拉取时刻刷新，
     *  回合期间 H5 首页恒显示「已完成」而官方客户端转圈（2026-09-23 用户实测）。
     *  事件源=ZCodeServiceImpl 全局监听（legacy turn.*）+ v4 帧扫描（turnHeader 行）。
     *  值=最近一次相位更新时刻，供 sweep 超时兜底（终态事件丢失时防永久运行中） */
    private val runningSessionIds: java.util.concurrent.ConcurrentMap<String, Long> = java.util.concurrent.ConcurrentHashMap()

    private class ControllerSub(val bridgeSessionId: String, val topic: String) {
        /** 帧序号（官方宿主同构：toSeq 随每帧递增）。H5 消费端 `toSeq<=已应用seq`
         *  直接丢弃——恒 1/1 的重推帧会被判旧扔掉，表现=手机端状态不实时、
         *  刷新（重新订阅 seq 归零）才更新（2026-09-23 逆向 H5 bundle 实锤） */
        val seq = java.util.concurrent.atomic.AtomicLong(0)
    }

    /** H5 已建立的 window-controller 订阅（subId → bridge+topic）：回合翻转时重推快照帧 */
    private val controllerSubs = java.util.concurrent.ConcurrentHashMap<String, ControllerSub>()

    private val repushPending = java.util.concurrent.atomic.AtomicBoolean(false)

    init {
        router.isSessionRunning = { id -> id in runningSessionIds }
    }

    fun registerControllerSub(subscriptionId: String, bridgeSessionId: String, topic: String) {
        controllerSubs[subscriptionId] = ControllerSub(bridgeSessionId, topic)
        startPhaseFallbackIfNeeded() // 缺陷EJ：兜底快照链随订阅建立拉起（断连自停）
    }

    /** 桥淘汰的路由侧清理（RemoteChannelHandlers.clearBridge 调用）：RelayBridge 的
     *  桥行/EventFire 监听登记 + controller 订阅随桥移除——否则 repush 的 hasListener
     *  判据对死桥恒真，快照帧持续双推（缺陷 DH） */
    fun clearBridgeRouting(bridgeSessionId: String) {
        router.bridge.clearBridge(bridgeSessionId)
        controllerSubs.entries.removeIf { it.value.bridgeSessionId == bridgeSessionId }
    }

    fun isSessionRunning(sessionId: String): Boolean = sessionId in runningSessionIds

    /** 回合相位入口：集合翻转 + 防抖重推 controller 快照（推完即置位，期间新变化可再排） */
    fun onSessionTurnPhase(sessionId: String, running: Boolean) {
        // 子代理会话不在任务列表（同 webview sessionTurnPhase 口径）
        if (sessionId.startsWith("sess_subagent")) return
        val changed = if (running) runningSessionIds.put(sessionId, System.currentTimeMillis()) == null
                      else {
                          // 终态事件连带清复核确认条目：probe 捞回后若回合正常结束，
                          // 不留 3min TTL 尾巴（列表多显示 3min 运行中）
                          queryBackedRunning.remove(sessionId)
                          runningSessionIds.remove(sessionId) != null
                      }
        if (!changed) return
        scheduleRepushDebounced()
        if (running) startPhaseTickerIfNeeded()
    }

    /** 相位翻转后的防抖重推（400ms 合并窗口，推完即置位，期间新变化可再排） */
    private fun scheduleRepushDebounced() {
        if (controllerSubs.isEmpty()) return
        if (!repushPending.compareAndSet(false, true)) return
        bridgeSweeper.schedule({
            repushPending.set(false)
            channelExecutor.execute { runCatching { repushControllerSnapshots() } }
        }, 400, java.util.concurrent.TimeUnit.MILLISECONDS)
    }

    /**
     * 缺陷EH：stop 序列专用相位补清。NEW CLI 对被停回合可能不发任何终态帧
     * （stop 合成收口只走面板通道、帧泵可能未挂载），远程运行集合会残留到 2h TTL。
     * 守卫：条目时刻须早于 stopStartMs——晚于说明 stop 后已有新回合 turn.started
     * 抢跑刷写条目，此时清掉会误伤新回合的运行态显示。
     */
    fun clearPhaseIfEntryBefore(sessionId: String, beforeMs: Long) {
        if (sessionId.startsWith("sess_subagent")) return
        val entry = runningSessionIds[sessionId] ?: return
        if (entry >= beforeMs) return
        queryBackedRunning.remove(sessionId)
        runningSessionIds.remove(sessionId)
        log.info("remote phase cleared by stop sequence: $sessionId (entry=$entry < stop=$beforeMs)")
        scheduleRepushDebounced()
    }

    /**
     * 运行期周期补推（15s 一轮，2026-09-24 用户实测归档）：回合翻转瞬间只推一帧，
     * 手机发消息短回合（2~5s）用户根本看不到「运行中」；列表页停留时若恰好错过
     * 翻转帧也要等下一轮翻转才更新。H5 消费端对 snapshot 帧无条件接受（fromSeq=0
     * 全量替换），周期补推成本可控（≤150 行），让列表页 15s 内必然追平运行态。
     * 无运行会话或无订阅者即自停，下一轮 running 翻转重启链。
     */
    private val phaseTickerActive = java.util.concurrent.atomic.AtomicBoolean(false)

    private fun startPhaseTickerIfNeeded() {
        if (!phaseTickerActive.compareAndSet(false, true)) return
        bridgeSweeper.schedule({ tickPhaseOnce() }, 15_000, java.util.concurrent.TimeUnit.MILLISECONDS)
    }

    private fun tickPhaseOnce() {
        val cont = !runningSessionIds.isEmpty() && !controllerSubs.isEmpty()
        if (!cont) {
            phaseTickerActive.set(false)
            return
        }
        runCatching { repushControllerSnapshots() }
        if (!runningSessionIds.isEmpty() && !controllerSubs.isEmpty()) {
            bridgeSweeper.schedule({ tickPhaseOnce() }, 15_000, java.util.concurrent.TimeUnit.MILLISECONDS)
        } else {
            phaseTickerActive.set(false)
        }
    }

    /**
     * 兜底快照 ticker（缺陷EJ，30s 一轮）：phaseTicker 只在运行集合非空时跑——集合空
     * 时快照不推，而 EB probe 捞回候选只在快照合成时收集，「回合在跑但 turn.started
     * 丢失」（IDE 重启后首回合 send 先于 resume 完成，2026-09-30 真机实锤）的会话在
     * H5 恒「已完成」且捞回链断。本 ticker 在集合空且有订阅者时每 30s 无条件推一轮
     * 快照（probe 候选随合成天然发生，捞回后 phaseTicker 15s 接管）；集合非空时让位
     * 跳推只续期。无订阅者自停，registerControllerSub 重新拉起。
     * 单轮成本：listSessions RPC ~120ms（538 条实测）+ listTasks 指纹缓存命中 <1ms
     * （客户端写入 tasks-index 时才 spawn node 重读，~1s 罕见路径）。
     */
    private val PHASE_FALLBACK_INTERVAL_MS = 30_000L

    private val phaseFallbackActive = java.util.concurrent.atomic.AtomicBoolean(false)

    private fun startPhaseFallbackIfNeeded() {
        if (!phaseFallbackActive.compareAndSet(false, true)) return
        bridgeSweeper.schedule({ tickPhaseFallbackOnce() }, PHASE_FALLBACK_INTERVAL_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
    }

    private fun tickPhaseFallbackOnce() {
        if (controllerSubs.isEmpty()) {
            phaseFallbackActive.set(false)
            return
        }
        if (runningSessionIds.isEmpty() && queryBackedRunning.isEmpty()) {
            runCatching { repushControllerSnapshots() }
        }
        if (controllerSubs.isEmpty()) {
            phaseFallbackActive.set(false)
        } else {
            bridgeSweeper.schedule({ tickPhaseFallbackOnce() }, PHASE_FALLBACK_INTERVAL_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
        }
    }

    /** 超时兜底（sweep）：session/list 的 status 恒 idle（db 无 status 列，app-server
     *  内存合成、不反映回合相位，scripts/diag-sessionlist-running-status.py 实测
     *  500 条全 idle）——不能作为纠偏权威，retainAll(空权威) 曾把真跑着的会话
     *  每分钟清一遍，相位修复全出口失效（缺陷 DD，18:18:32 running=1 → 18:19:29
     *  running=0 与 60s sweep 网格对齐实锤）。终态丢失防御降级为时间阈值：
     *  超过 2h 无任何相位帧刷新才移除（误清代价=列表显示已完成，可接受） */
    private fun sweepRunningSessions() {
        if (runningSessionIds.isEmpty() && queryBackedRunning.isEmpty()) return
        val now = System.currentTimeMillis()
        val stale = runningSessionIds.entries.removeIf { now - it.value > RUNNING_ENTRY_TTL_MS }
        // 复核确认条目短 TTL：到期移除、下轮快照重新 probe 维持（真终态由事件正常移除，
        // 本清理只防「probe 捞回后会话已结束而终态事件又丢」的永久运行中）
        val probeStale = queryBackedRunning.entries.removeIf { now - it.value > QUERY_BACKED_TTL_MS }
        if ((stale || probeStale) && controllerSubs.isNotEmpty()) {
            channelExecutor.execute { runCatching { repushControllerSnapshots() } }
        }
    }

    /** 向全部存活的 tasks-index 订阅重推快照（桥已清/无监听者的订阅顺带淘汰） */
    private fun repushControllerSnapshots() {
        log.info("remote controller repush: subs=${controllerSubs.size} running=${runningSessionIds.size}")
        // 相位盲区取证（协议号修复后仍不显示时用）：淘汰与推送逐条落日志
        for ((subId, sub) in controllerSubs) {
            if (!sub.topic.endsWith("tasks-index")) continue
            val hasListener = router.bridge.subscriptionsFor(sub.bridgeSessionId).any {
                it.value.channel == "window-controller" && it.value.event == "onDynamicControllerFrame"
            }
            if (!hasListener) {
                log.info("remote controller repush: drop sub $subId (no window-controller listener on bridge ${sub.bridgeSessionId})")
                controllerSubs.remove(subId)
                continue
            }
            pushControllerSnapshot(sub.bridgeSessionId, subId, sub.topic)
        }
    }

    /** v4 帧监听注销句柄（app-server 换代时重挂） */
    private val v4ListenerDetachers = java.util.concurrent.CopyOnWriteArrayList<() -> Unit>()

    /** app-server 访问（project null 时取任一活跃实例；不可用返回 null 由调用方回错误） */
    fun appServer(project: com.intellij.openapi.project.Project?): com.zcode.ideaplugin.protocol.ZCodeProtocolClient? = runCatching {
        val impl = com.zcode.ideaplugin.ZCodeServiceImpl.activeProjectServices()
            .firstOrNull { project == null || it.ownerProject == project }
            ?: return null
        if (impl.isStarted()) impl.getClient() else null
    }.getOrNull()

    /** bridge-open 登记的 workspaceKey（手机进工作区时上报）：v4 订阅链在
     *  project 解析不到（挂载目录）、H5 不带 workspacePath 时的兜底工作区来源 */
    fun bridgeWorkspaceKey(bridgeSessionId: String): String? = router.bridge.workspaceKeyOf(bridgeSessionId)

    private fun handleKnownChannel(
        project: com.intellij.openapi.project.Project?,
        bridgeSessionId: String,
        request: ChannelCodec.ChannelRequest,
        responder: RelayClient.ChannelResponder,
    ) {
        runCatching { ensureV4Pumps() } // 幂等：app-server 换代后首个请求重挂事件泵
        handlers.handle(project, bridgeSessionId, request, responder)
    }

    /**
     * v4 帧事件泵：app-server 的 v4/conversation/frame → 手机 EventFire。
     * 帧只推给订阅了该 topic 的 bridge（handlers 上下文登记），listener 按
     * channel.event 匹配（conversation→onDynamicConversationFrame，
     * sessions-index→onDynamicSessionsIndexFrame），H5 客户端按 frame.topic 自分发。
     */
    private fun pumpV4Frame(project: com.intellij.openapi.project.Project?, frame: JsonObject) {
        val relay = client ?: return
        val topic = frame["topic"]?.jsonPrimitive?.content ?: return
        val targetEvent = when {
            topic.startsWith("conversation/") -> "onDynamicConversationFrame"
            topic.startsWith("sessions-index/") -> "onDynamicSessionsIndexFrame"
            else -> return
        }
        // v4 面会话的 turn 相位提取（远程 H5 会话专属）：H5 建的会话走 v4 面，turn 状态
        // 只在 turnHeader 行里、不产生 legacy turn.started 事件——全局监听器收不到，
        // 任务行运行中翻转失效（手机发消息列表恒已完成，2026-09-23 复测实锤）
        if (topic.startsWith("conversation/")) {
            scanTurnPhaseFromFrame(topic.removePrefix("conversation/"), frame)
        }
        // sessions-index 快照限流（delta 不动）：500+ 任务的全量 sessions 数组与 controller
        // tasks-index 同源放大 H5 端压力，只保留最近 150 行（按 lastActivityAt 降序）
        val outbound = if (topic.startsWith("sessions-index/")) trimSessionsIndexSnapshot(frame) else frame
        for ((bridgeId, ctx) in handlers.activeContexts()) {
            if (ctx.subscriptions[topic] == null) continue
            for ((listenerId, sub) in router.bridge.subscriptionsFor(bridgeId)) {
                if (sub.channel == "zcode-agent" && sub.event == targetEvent) {
                    try {
                        // 异步保序推送：单线程串行维持帧序，队列满=relay 慢到失配，丢帧交 H5 resync
                        framePushExecutor.execute {
                            runCatching {
                                relay.sendChannelEvent(bridgeId, listenerId, com.zcode.ideaplugin.protocol.relay.ChannelCodec.ChValue.Obj(outbound))
                            }.onFailure { log.warn("v4 frame push failed: ${it.message}") }
                        }
                    } catch (e: java.util.concurrent.RejectedExecutionException) {
                        log.warn("v4 frame push queue full, dropped topic=$topic")
                    }
                }
            }
        }
    }

    /** v4 帧轻量相位扫描：turnHeader 行 state=running → 运行中；其余任何值 → 结束
     *  （结构判据对齐 V4FrameMapper 行模型，快照帧不带实时相位直接跳过）。
     *  注意：快照帧相位恢复曾在此实现（037834e），真机实锤触发 H5 resync 风暴
     *  （105 次循环→relay 报 INTERNAL→桥 11~19s 周期性重建→会话页打不开），
     *  已回滚——重连后列表相位修复换路（走 pushControllerSnapshot 的 mapper 兜底，
     *  不碰帧泵路径），快照帧一律原样透传 */
    private fun scanTurnPhaseFromFrame(sessionId: String, frame: JsonObject) {
        // pumpV4Frame 入参是外层通知对象（{topic, subscriptionId, frame:{payload}}，
        // 对齐 trimSessionsIndexSnapshot 的 frame["frame"] 内层访问），payload 在内层
        val payload = (frame["frame"] as? JsonObject)?.get("payload") as? JsonObject ?: return
        if (payload["kind"]?.jsonPrimitive?.contentOrNull == "snapshot") return
        val deltas = payload["deltas"]?.jsonArray ?: return
        var running: Boolean? = null
        for (el in deltas) {
            val op = el as? JsonObject ?: continue
            if (op["op"]?.jsonPrimitive?.contentOrNull != "row.appended" &&
                op["op"]?.jsonPrimitive?.contentOrNull != "row.upserted"
            ) continue
            val row = op["row"]?.jsonObject ?: continue
            if (row["kind"]?.jsonPrimitive?.contentOrNull != "turnHeader") continue
            running = row["state"]?.jsonPrimitive?.contentOrNull == "running"
        }
        // 同帧多行取最后一个 turnHeader（理论少见，防御）；null=本帧无相位变化
        running?.let { onSessionTurnPhase(sessionId, it) }
    }

    /** app-server 换代/启动后重挂 v4 帧监听（幂等） */
    fun ensureV4Pumps() {
        for (impl in com.zcode.ideaplugin.ZCodeServiceImpl.activeProjectServices()) {
            if (!impl.isStarted()) continue
            val c = runCatching { impl.getClient() }.getOrNull() ?: continue
            if (c in pumpedClients) continue
            pumpedClients.add(c)
            val detach = c.addV4FrameListener { frame -> pumpV4Frame(impl.ownerProject, frame) }
            v4ListenerDetachers.add(detach)
            log.info("v4 frame pump attached (project=${impl.ownerProject.name})")
        }
    }

    private val pumpedClients = java.util.Collections.newSetFromMap(java.util.concurrent.ConcurrentHashMap<com.zcode.ideaplugin.protocol.ZCodeProtocolClient, Boolean>())

    /** sessions-index 快照帧限流：内层 frame.sessions 只留最近 TASK_SNAPSHOT_LIMIT 行。
     *  行序=官方注释明确「无序，排序是客户端逻辑」，按 lastActivityAt 降序取；
     *  结构异常/已小于上限时原帧透传（delta 帧无 sessions 数组，天然走透传） */
    private fun trimSessionsIndexSnapshot(frame: JsonObject): JsonObject {
        val inner = frame["frame"] as? JsonObject ?: return frame
        val sessions = inner["sessions"] as? kotlinx.serialization.json.JsonArray ?: return frame
        if (sessions.size <= TASK_SNAPSHOT_LIMIT) return frame
        val kept = sessions
            .sortedByDescending {
                (it as? JsonObject)?.get("lastActivityAt")?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: 0
            }
            .take(TASK_SNAPSHOT_LIMIT)
        val trimmedInner = kotlinx.serialization.json.buildJsonObject {
            inner.forEach { (k, v) -> if (k != "sessions") put(k, v) }
            put("sessions", kotlinx.serialization.json.JsonArray(kept))
        }
        return kotlinx.serialization.json.buildJsonObject {
            frame.forEach { (k, v) -> if (k != "frame") put(k, v) }
            put("frame", trimmedInner)
        }
    }

    /** controller 快照推送（window-controller 订阅后的 initial 帧，tasks 自聚合）。
     *  task 行按官方宿主 HAR 权威形状（address/meta/membership/sourceAvailability/
     *  liveStatus[+activity]；model/thoughtLevel/target/activity 官方亦可选——248 条
     *  样本出现率 107/105/107/71）；旧扁平形状被 H5 zod strict 丢弃=任务列表恒空 */
    fun pushControllerSnapshot(bridgeSessionId: String, subscriptionId: String, topic: String) {
        val relay = client ?: return
        // 每 project 用自己的 app-server 聚合（会话库全局共享，但 workspace 过滤按各自 basePath）
        val taskItems = ArrayList<kotlinx.serialization.json.JsonElement>()
        val now = System.currentTimeMillis()
        // 查询复核候选：判 completed 但 updatedAt 很新（回合在跑而相位喂源丢失，缺陷EB兜底）
        val probeCandidates = ArrayList<Pair<com.zcode.ideaplugin.protocol.ZCodeProtocolClient, String>>()
        // 纠偏候选（缺陷EH兜底）：事件集合判 running 但条目时刻陈旧——终态丢失场景
        // （帧泵挂载窗口/legacy 终态哑火/stop 合成不过全局）残留，query 复核 idle 则清出
        val staleRunningCandidates = ArrayList<Pair<com.zcode.ideaplugin.protocol.ZCodeProtocolClient, String>>()
        for (impl in com.zcode.ideaplugin.ZCodeServiceImpl.activeProjectServices()) {
            if (!impl.isStarted()) continue
            val c = runCatching { impl.getClient() }.getOrNull() ?: continue
            val base = impl.ownerProject.basePath ?: continue
            // 归档/软删过滤（IDE 历史列表同源口径）：session/list 只认 db.sqlite 旧
            // time_archived 列，插件归档写在 tasks-index.sqlite——不过滤则几百条归档
            // 任务泄漏给 H5 首页（503 vs 真实五十几，2026-09-23 用户实测定案）
            val hidden = runCatching { c.hiddenSessionIds() }.getOrDefault(emptySet())
            // 挂载目录会话同列（与 RemoteChannelRouter.ideTasks 同口径）：只按项目
            // basePath 查询，挂载目录下的会话在手机首页任务列表不可见
            val workspaces = listOf(base) +
                com.zcode.ideaplugin.ui.ZCodeLinkedWorkspaces.readActive(impl.ownerProject)
            for (ws in workspaces) {
                for (s in runCatching { c.listSessions(ws) }.getOrDefault(emptyList())) {
                    if (s.sessionId in hidden) continue
                    // 运行中覆写：session/list 快照滞后且 status 恒 idle（缺陷 DD 实证不可作
                    // 权威）。四重判据=相位集合（事件喂源）+ 查询复核确认（queryBackedRunning，
                    // 缺陷EB兜底）+ mapper 活跃投影（桌面 v4 订阅会话的兜底）
                    val turnActive = s.sessionId in runningSessionIds ||
                        queryBackedRunning.containsKey(s.sessionId) ||
                        runCatching { c.isSessionTurnActive(s.sessionId) }.getOrDefault(false)
                    val status = if (turnActive || s.status == "running") "running" else "completed"
                    // 复核候选收集：事件/查询两源都说非 running，但 updatedAt 距今很新——
                    // 回合大概率在跑而 turn.started 事件丢了（计划批准续跑回合实测不发 legacy
                    // started，2026-09-29 真机日志实锤）。异步 probe 捞回，快照照常先推
                    if (status == "completed" &&
                        now - s.updatedAt < PROBE_RECHECK_WINDOW_MS &&
                        probeCandidates.size < PROBE_MAX_PER_ROUND &&
                        (lastProbeAt[s.sessionId] ?: 0) < now - PROBE_MIN_INTERVAL_MS
                    ) {
                        probeCandidates.add(c to s.sessionId)
                    }
                    // 纠偏候选收集：事件集合说 running 且条目超时无相位刷新——回合大概率已结束
                    // 而终态事件丢了（缺陷EH 四路断法），异步 probe 纠偏，快照照常先推
                    if (status == "running" && runningSessionIds.containsKey(s.sessionId) &&
                        now - (runningSessionIds[s.sessionId] ?: 0L) > STALE_RUNNING_RECHECK_MS &&
                        staleRunningCandidates.size < PROBE_MAX_PER_ROUND &&
                        (lastProbeAt[s.sessionId] ?: 0) < now - PROBE_MIN_INTERVAL_MS
                    ) {
                        staleRunningCandidates.add(c to s.sessionId)
                    }
                    // workspacePath 统一正斜杠：app-server 返回反斜杠，而 H5 按当前工作区
                    //（basePath 正斜杠）对 address.workspacePath 严格字符串匹配（kFe），
                    // 斜杠不一致=150 任务全被滤掉列表显示 0（2026-08-25 装机 HAR 定案）
                    val wsFwd = (s.workspace?.workspacePath ?: ws).replace('\\', '/')
                    taskItems.add(buildJsonObject {
                        put("address", buildJsonObject {
                            put("workspacePath", wsFwd)
                            put("taskId", s.sessionId)
                        })
                        put("meta", buildJsonObject {
                            put("taskId", s.sessionId)
                            put("traceId", s.traceId ?: s.sessionId)
                            put("title", s.title.ifBlank { "session" })
                            put("titleOverridden", s.titleSource == "user")
                            put("workspacePath", wsFwd)
                            put("createdAt", s.createdAt)
                            put("updatedAt", s.updatedAt)
                            put("mode", s.mode)
                            put("provider", "glm")
                            put("status", status)
                        })
                        put("membership", buildJsonObject {
                            put("pinned", false)
                            put("archived", s.archivedAt != null)
                            put("active", false)
                        })
                        put("sourceAvailability", "online")
                        put("liveStatus", status)
                        put("activity", buildJsonObject {
                            put("phase", if (status == "completed") "completedSuccess" else "running")
                            put("lastActivityAt", s.updatedAt)
                            put("hasBackgroundWork", false)
                        })
                    })
                }
            }
        }
        // 会话库大会员（500+ 任务）全量下发打爆 H5：手机端首页渲染/内存压力 → 页面崩溃
        // → WS 断 → 自动重连 → 再全量 → 死循环（表现=首页闪来闪去；2026-09-23 对照：
        // 官方宿主 74 任务稳定、本宿主 503 任务必现）。对齐 0.3.0 readSession 512KB 预算
        // 先例：只下发最近 150 条（按 updatedAt 倒序），旧任务靠 H5 搜索/桌面端查看
        val limited = taskItems
            .sortedByDescending {
                (it as? JsonObject)?.get("meta")?.jsonObject?.get("updatedAt")?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: 0
            }
            .take(TASK_SNAPSHOT_LIMIT)
        // workspaces topic 推 {workspaces}、tasks-index topic 推 {tasks}（官方两 topic
        // 快照内容不同，HAR 实测；外层帧字段 fromSeq/toSeq 对齐官方）
        val snapshotContent = buildJsonObject {
            // protocolVersion 必须为 1：H5 window-controller 快照 zod schema 字面量
            // la(1)（z.literal），发 3 → 整帧 strict 校验失败静默丢弃——任务列表实时
            // 相位翻转文件全盲（IDEA 侧跑回合手机列表恒「已完成」，2026-09-24 逆向
            // H5 bundle 实锤：sue=Ta({protocolVersion:la(1),logEpoch,tasks}).strict()）
            put("protocolVersion", 1)
            put("logEpoch", "zcodeidea")
            if (topic.endsWith("tasks-index")) {
                put("tasks", kotlinx.serialization.json.JsonArray(limited))
            } else {
                put("workspaces", kotlinx.serialization.json.JsonArray(
                    com.zcode.ideaplugin.ZCodeServiceImpl.activeProjectServices()
                        .flatMap { impl ->
                            listOfNotNull(impl.ownerProject.basePath) +
                                com.zcode.ideaplugin.ui.ZCodeLinkedWorkspaces.readActive(impl.ownerProject)
                        }
                        .distinct()
                        .map { path ->
                            buildJsonObject {
                                put("workspacePath", path)
                                put("sourceAvailability", "online")
                                put("connectionState", "online")
                            }
                        }
                ))
            }
        }
        // toSeq 递增（官方宿主 fromSeq:0/toSeq:seq 同构）：H5 消费端按 toSeq 判新旧
        val seq = controllerSubs[subscriptionId]?.seq?.incrementAndGet() ?: 1L
        val frame = buildJsonObject {
            put("subscriptionId", subscriptionId)
            put("topic", topic)
            put("logEpoch", "zcodeidea")
            put("fromSeq", 0)
            put("toSeq", seq)
            // sentAt 必填：H5 window-controller 帧的 zod schema sentAt 为必填数字
            // （缺省=整帧静默丢弃，任务列表实时相位全盲——IDEA 侧跑回合手机列表
            // 恒「已完成」，2026-09-24 IAB 帧级对照官方快照实锤，官方恒带 sentAt）
            put("sentAt", System.currentTimeMillis())
            put("payload", buildJsonObject {
                put("kind", "snapshot")
                put("snapshot", snapshotContent)
            })
        }
        for ((listenerId, sub) in router.bridge.subscriptionsFor(bridgeSessionId)) {
            if (sub.channel == "window-controller" && sub.event == "onDynamicControllerFrame") {
                runCatching {
                    relay.sendChannelEvent(bridgeSessionId, listenerId, com.zcode.ideaplugin.protocol.relay.ChannelCodec.ChValue.Obj(frame))
                }
            }
        }
        // 相位盲区取证：快照实际推送内容概要（running 会话 id、行数、协议号）
        val runIds = runningSessionIds.keys.take(3).joinToString(",")
        log.info("remote controller snapshot pushed: topic=$topic toSeq=$seq tasks=${limited.size} running=[$runIds] proto=${snapshotContent["protocolVersion"]}")
        scheduleRunningProbe(probeCandidates, staleRunningCandidates)
    }

    // ============ 查询式活性复核（缺陷EB兜底：事件喂源丢失时把运行中会话捞回） ============

    /** 复核候选窗口：判 completed 但 updatedAt 距今在此内的才值得问（回合中的会话
     *  updatedAt 随落库推进，diag-eb 实测；再老的会话运行概率趋零，控制 read 成本） */
    private val PROBE_RECHECK_WINDOW_MS = 10 * 60_000L

    /** 同会话两次复核的最小间隔（防 15s 周期快照每轮都打 read） */
    private val PROBE_MIN_INTERVAL_MS = 60_000L

    /** 单轮快照合成的复核上限（成本护栏） */
    private val PROBE_MAX_PER_ROUND = 5

    /** 复核确认条目的保鲜期：到期移除、下轮快照重新 probe 维持——事件终态若正常
     *  到达则走 onSessionTurnPhase(false) 正常移除，本表条目不阻碍 */
    private val QUERY_BACKED_TTL_MS = 3 * 60_000L

    /** 纠偏候选门槛（缺陷EH）：事件集合判 running 且条目超过此时长无相位刷新才值得问。
     *  条目时刻只在相位翻转时刷新（单 step 长回合不刷新），超门槛≠已结束——probe 复核
     *  权威兜底，无误清（projection.status=running 则续期条目） */
    private val STALE_RUNNING_RECHECK_MS = 5 * 60_000L

    /** 复核确认仍在运行的会话（sessionId → 确认时刻）。独立于 runningSessionIds
     * （事件喂源）：probe 单向捞回、不纠偏——事件说 running 而查询说 idle 时信事件
     * （缺陷DD 教训：以 X 为权威纠偏须先实证 X 携带信息，这里查询只做增量捞回） */
    private val queryBackedRunning = java.util.concurrent.ConcurrentHashMap<String, Long>()

    /** 复核去抖簿记：sessionId → 上次 probe 时刻 */
    private val lastProbeAt = java.util.concurrent.ConcurrentHashMap<String, Long>()

    /**
     * 异步复核候选会话的运行相位（session/read projection.status）。
     * diag-eb 实证：回合中 status="running"、终态翻 "idle"，messageLimit=1 下返回体
     * KB 级；H5 端会话页/官方客户端同源读取。命中 running → 写 queryBackedRunning +
     * 走 onSessionTurnPhase(true) 正常通道（集合翻转+防抖重推快照，H5 列表翻运行中）。
     * 桥线程零阻塞：read 放 bridgeSweeper 池执行（串行池阻塞几秒只推迟 sweep，无害）。
     */
    private fun scheduleRunningProbe(
        candidates: List<Pair<com.zcode.ideaplugin.protocol.ZCodeProtocolClient, String>>,
        staleCandidates: List<Pair<com.zcode.ideaplugin.protocol.ZCodeProtocolClient, String>> = emptyList(),
    ) {
        if (candidates.isEmpty() && staleCandidates.isEmpty()) return
        val now = System.currentTimeMillis()
        for ((client, sessionId) in candidates) probeOnce(client, sessionId, now, stale = false)
        for ((client, sessionId) in staleCandidates) probeOnce(client, sessionId, now, stale = true)
    }

    private fun probeOnce(
        client: com.zcode.ideaplugin.protocol.ZCodeProtocolClient,
        sessionId: String,
        now: Long,
        stale: Boolean,
    ) {
        lastProbeAt[sessionId] = now // 无论结果如何都记，60s 内不重复问同一会话
        bridgeSweeper.execute {
            val running = runCatching {
                parseProjectionStatus(client.readSessionFull(sessionId, timeoutMs = 5_000, messageLimit = 1))
            }.getOrNull()
            when (running) {
                true -> {
                    queryBackedRunning[sessionId] = System.currentTimeMillis()
                    if (stale) {
                        // 确认仍在跑：续期条目时刻（防 2h sweep 误清真长回合）+ 4min 节流
                        runningSessionIds[sessionId] = System.currentTimeMillis()
                        lastProbeAt[sessionId] = System.currentTimeMillis() + 4 * 60_000L
                        log.info("[eb-probe] session $sessionId confirmed still running (stale recheck, entry renewed)")
                    } else {
                        log.info("[eb-probe] session $sessionId confirmed running via session/read, restoring phase")
                    }
                    onSessionTurnPhase(sessionId, true)
                }
                // 确认非运行：补偿节流到 ~5min（判定式再减 60s 间隔），防结束不久的
                // 会话在 10min 候选窗内每 60s 被白问一次
                false -> {
                    lastProbeAt[sessionId] = System.currentTimeMillis() + 4 * 60_000L
                    runCatching { queryBackedRunning.remove(sessionId) }
                    if (stale) {
                        log.info("[eb-probe] stale running entry corrected via session/read: $sessionId")
                        onSessionTurnPhase(sessionId, false)
                    }
                }
                null -> log.info("[eb-probe] session $sessionId read failed (fail-soft, keep current phase)")
            }
        }
    }

    /** session/read 结果 → 会话是否运行中（projection.status；结构变化/异常返回 null） */
    private fun parseProjectionStatus(readResult: kotlinx.serialization.json.JsonObject): Boolean? =
        parseSessionReadRunning(readResult)

    // ============ 凭据（PasswordSafe 首次引入） ============

    private fun credentialAttributes() = RemoteCredentialAttributes.forService(SERVICE_NAME)

    private fun loadOrCreateCredentials(): RelayCredentials {
        val stored = PasswordSafe.instance.get(credentialAttributes())
        val payload = stored?.getPasswordAsString()
        if (!payload.isNullOrBlank()) {
            runCatching {
                val obj = json.parseToJsonElement(payload).jsonObject
                fun str(key: String) = obj[key]?.jsonPrimitive?.content
                val mid = str("deviceMid"); val sid = str("deviceSid"); val hash = str("passHash")
                if (!mid.isNullOrBlank() && !hash.isNullOrBlank()) {
                    return RelayCredentials(deviceMid = mid, deviceSid = sid, passHash = hash)
                }
            }.onFailure { log.warn("remote credentials parse failed: ${it.message}") }
        }
        val password = RelayCrypto.createPassword()
        return RelayCredentials(
            deviceMid = "idea-" + java.util.UUID.randomUUID().toString().replace("-", ""),
            deviceSid = null,
            passHash = RelayCrypto.createPassHash(password),
        )
    }

    private fun saveCredentials(credentials: RelayCredentials) {
        val payload = buildJsonObject {
            put("deviceMid", credentials.deviceMid)
            credentials.deviceSid?.let { put("deviceSid", it) }
            put("passHash", credentials.passHash)
        }
        runCatching {
            PasswordSafe.instance.set(credentialAttributes(), Credentials(credentials.deviceMid, payload.toString()))
        }.onFailure { log.warn("remote credentials save failed: ${it.message}") }
    }

    // ============ 状态广播与通知 ============

    private fun broadcastState() {
        val msg = statusJson()
        ApplicationManager.getApplication().executeOnPooledThread {
            ZCodeServiceImpl.broadcastToAllPanels(msg)
        }
    }

    /** 上次「手机已连接」通知时刻（H5 断连重连风暴时 PAIRED 每秒翻转一次，
     *  不过滤=通知中心 2 分钟刷 20+ 条，2026-09-23 用户截图实锤） */
    @Volatile private var lastPairedNotifyAt: Long = 0

    private fun notify(messageKey: String) {
        // 简单系统通知（配对状态类）；回合级通知才走 ZCodeNotifyService 体系
        runCatching {
            if (messageKey == "phonePaired") {
                val now = System.currentTimeMillis()
                if (now - lastPairedNotifyAt < 10 * 60_000L) return  // 10 分钟冷却
                lastPairedNotifyAt = now
            }
            val text = if (messageKey == "phonePaired") ZCodeBundle.message("remote.notify.phonePaired") else messageKey
            com.intellij.notification.NotificationGroupManager.getInstance()
                .getNotificationGroup("ZCode")
                .createNotification(text, com.intellij.notification.NotificationType.INFORMATION)
                .notify(null)
        }.onFailure { log.warn("remote notify failed: ${it.message}") }
    }

    /** 多页面互顶告警（5 分钟冷却）：旧页面持续重连会互顶（手机/浏览器侧行为，
     *  device 无法代为关闭）——必须提示用户关闭多余页面，否则页面反复刷新、
     *  会话加载时断时续（2026-09-23 用户真机实锤）。
     *  注意：单页弱网也会凑满 churn 阈值（见 onTerminalChurn 注释），本通知
     *  可能误报，文案只作提示不作断言 */
    @Volatile private var lastChurnNotifyAt: Long = 0

    private fun notifyTerminalChurn() {
        val now = System.currentTimeMillis()
        if (now - lastChurnNotifyAt < 5 * 60_000L) return
        lastChurnNotifyAt = now
        runCatching {
            com.intellij.notification.NotificationGroupManager.getInstance()
                .getNotificationGroup("ZCode")
                .createNotification(
                    ZCodeBundle.message("remote.notify.terminalChurn"),
                    com.intellij.notification.NotificationType.WARNING,
                )
                .notify(null)
        }.onFailure { log.warn("churn notify failed: ${it.message}") }
    }

    companion object {
        private const val SERVICE_NAME = "zcode.remote.relay"

        /** 远程开启开关持久化键（应用级 PropertiesComponent，重启恢复用） */
        private const val PERSIST_KEY_ENABLED = "zcode.remote.enabled"

        /** H5 列表/快照下发上限：会话库大会员（500+）全量下发打爆 H5 端（崩溃重连循环） */
        internal const val TASK_SNAPSHOT_LIMIT = 150

        /** sweep 超时兜底阈值：相位事件正常每回合至少一次翻转（started/completed），
         *  长跑回合按 v4 turnHeader 流也会持续刷新；2h 无刷新=事件源已丢 */
        private const val RUNNING_ENTRY_TTL_MS = 2 * 60 * 60 * 1000L

        @JvmStatic
        fun getInstance(): ZCodeRemoteService = ApplicationManager.getApplication().getService(ZCodeRemoteService::class.java)
    }
}

/**
 * session/read 结果 → 会话是否运行中（缺陷EB兜底的解析纯函数）：
 * projection.status=="running" → true；其他已知值（idle 等）→ false；
 * 节点缺失/结构变化 → null（调用方 fail-soft 保持原判）。
 */
internal fun parseSessionReadRunning(readResult: kotlinx.serialization.json.JsonObject): Boolean? {
    val status = readResult["projection"]?.jsonObject
        ?.get("status")?.jsonPrimitive?.contentOrNull ?: return null
    return status == "running"
}
