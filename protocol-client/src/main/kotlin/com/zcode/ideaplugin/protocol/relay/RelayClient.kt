package com.zcode.ideaplugin.protocol.relay

import com.zcode.ideaplugin.protocol.relay.ChannelCodec.ChValue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.net.URI
import java.net.http.HttpClient
import java.net.http.WebSocket
import java.time.Duration
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionStage
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import kotlin.concurrent.thread

/**
 * L1-L5 relay 客户端：device 角色长连云端 relay（wss://zcode.z.ai/ws），
 * 承载 register/auth 状态机、10s 心眺、断线重连、data 信封路由与 rpc-frame 分片。
 *
 * L6 channel 语义由宿主通过 handler 实现（见 RemoteChannelRouter）。
 *
 * 线程约定：所有 handler 在 WS 回调线程执行，严禁秒级阻塞
 * （H5 应答预算 <10s；channel handler 须自行线程池异步后经 responder 回传）。
 *
 * 使用方式：
 * ```
 * val client = RelayClient(config, credentials)
 * client.onPayload = { payload, sender -> ... }
 * client.onChannelRequest = { bridge, req, responder -> ... }
 * client.connect()
 * client.sendChannelEvent(bridge, listenerId, data)
 * client.close()
 * ```
 */
class RelayClient(
    val config: RelayConfig,
    @Volatile var credentials: RelayCredentials,
    private val transportFactory: TransportFactory = JdkWebSocketTransportFactory(),
) : AutoCloseable {

    data class RelayConfig(
        val wsUrl: String = Relay.DEFAULT_WS_URL,
        val origin: String = Relay.DEFAULT_ORIGIN,
        val deviceName: String = "ZCode JetBrains",
        val appVersion: String = Relay.APP_VERSION,
        val platform: String = "win32",
        /** 重连退避序列（ms）；空 = 不自动重连 */
        val reconnectBackoffMs: LongArray = longArrayOf(1_000, 3_000, 10_000, 30_000, 60_000),
    )

    /** WS 传输工厂（测试注入 fake） */
    fun interface TransportFactory {
        fun connect(url: String, headers: Map<String, String>, listener: WebSocket.Listener): WebSocket
    }

    /** L4 控制面应答通道（send 回一条 data payload） */
    fun interface PayloadSender {
        fun send(payload: JsonObject)
    }

    /** channel 调用应答器（异步线程安全；每请求至多调用一次） */
    interface ChannelResponder {
        fun success(result: ChValue)
        fun error(message: String)
    }

    // ---- 宿主 handler（全部 @Volatile 函数属性，对齐 ZCodeProtocolClient 惯例）----

    @Volatile var onStateChange: ((RelayState) -> Unit)? = null
    @Volatile var onRelayError: ((code: String?, message: String?) -> Unit)? = null

    /** 注册成功（deviceSid 已分配）——宿主立即持久化凭据，断线重连依赖它 */
    @Volatile var onDeviceRegistered: ((RelayCredentials) -> Unit)? = null

    /** L4 控制面 payload（bootstrap/bridge-open/…；mobile-diagnostic 等无需应答的也进来，宿主自行忽略） */
    @Volatile var onPayload: ((payload: JsonObject, sender: PayloadSender) -> Unit)? = null

    /** L6 channel 调用（type=100 Promise） */
    @Volatile var onChannelRequest: ((bridgeSessionId: String, request: ChannelCodec.ChannelRequest, responder: ChannelResponder) -> Unit)? = null

    /** channel 事件订阅（type=102 EventListen；filter 为 onDynamicXxx 的参数） */
    @Volatile var onChannelEventListen: ((bridgeSessionId: String, listenerId: Long, channel: String?, event: String?, filter: ChValue?) -> Unit)? = null

    @Volatile var onChannelEventDispose: ((listenerId: Long) -> Unit)? = null

    /** terminal 互顶循环告警（多页面互顶时 H5 零退避重连、KICKED 帧竞速失败送不到，
     *  循环期间会话应答被 relay 的 terminal 切换丢弃——用户感知「点会话打不开」。
     *  宿主收到后应重置 pair（disconnect→connect 同凭据）打断循环，2026-09-23 定案） */
    @Volatile var onTerminalChurn: (() -> Unit)? = null

    private val json = Json { ignoreUnknownKeys = true }
    private val assembler = FrameAssembler { warn -> println("[zcode-relay] $warn") }

    @Volatile private var state = RelayState.IDLE
    @Volatile private var webSocket: WebSocket? = null
    @Volatile private var closed = false
    @Volatile private var reconnecting = false

    /** 最近一次收到任何入站帧的时刻（心跳活性判定，见 HEARTBEAT_DEAD_MS） */
    @Volatile private var lastInboundAt = 0L

    /** terminal 互顶循环检测：WAITING↔PAIRED 翻转时间戳滑窗（见 onTerminalChurn） */
    private val pairFlipTimestamps = java.util.concurrent.ConcurrentLinkedQueue<Long>()

    private val outMessageSeq = AtomicLong(0)
    private val fallbackSeq = AtomicLong(0)
    private val sendLock = Any()
    // 重发帧 ack/dispatch 去重（缺陷FV）：手机链路恢复会原样重发整段 burst（相同
    // messageSeq），ack 只回一次之外 dispatch 也必须只分发一次；有界集防长会话无界泄漏
    private val ackedMessages = BoundedKeySet()
    private val dispatchedMessages = BoundedKeySet()
    private var reconnectAttempt = 0

    /**
     * 每个活跃 bridge 的出站上下文。手机侧 acceptPayload 会校验帧的
     * bridgeGeneration/recoveryId 与 bridge-open 一致（eun identity 校验，
     * 不匹配直接静默丢弃——Initialize 丢失即所有 channel 调用永久挂起），
     * 且入站 assembler 要求 seq 按 bridge 连续。
     */
    private class BridgeOut(
        @Volatile var generation: Long? = null,
        @Volatile var recoveryId: String? = null,
    ) {
        val nextSeq = AtomicLong(0)
        val nextMessageSeq = AtomicLong(0)
    }

    private val bridgesOut = ConcurrentHashMap<String, BridgeOut>()

    /** 手机发来 workspace-bridge-open 时注册（payload 路由层调用） */
    fun registerBridgeOutbound(bridgeSessionId: String, bridgeGeneration: Long?, recoveryId: String?) {
        val ctx = bridgesOut.getOrPut(bridgeSessionId) { BridgeOut() }
        ctx.generation = bridgeGeneration
        ctx.recoveryId = recoveryId
    }

    fun unregisterBridgeOutbound(bridgeSessionId: String) {
        bridgesOut.remove(bridgeSessionId)
    }

    // ============ 生命周期 ============

    fun connect() {
        check(!closed) { "client 已关闭" }
        setState(RelayState.CONNECTING)
        val mid = credentials.deviceMid
        val url = config.wsUrl + (if (config.wsUrl.contains('?')) "&" else "?") + "mid=" + mid
        println("[zcode-relay] 连接 $url (header X-Device-ID)")
        val ws = try {
            transportFactory.connect(url, mapOf("X-Device-ID" to mid), Listener())
        } catch (e: Exception) {
            // 传输建立失败（超时/拒绝/断网）同样进退避重连——此前首连失败只置 ERROR
            // 不再重试（2026-09-22 审查：scheduleReconnect 仅挂 WS 回调，覆盖不到这里）
            scheduleReconnect()
            throw e
        }
        webSocket = ws
        if (credentials.deviceSid != null) {
            sendAuthInit()
        } else {
            setState(RelayState.REGISTERING)
            sendJson(buildJsonObject {
                put("type", Relay.TYPE_DEVICE_REGISTER_INIT)
                put("device_mid", mid)
                put("pass_hash", credentials.passHash)
                put("meta", buildJsonObject {
                    put("platform", config.platform)
                    put("version", config.appVersion)
                    put("name", config.deviceName)
                })
                put("client_ts", System.currentTimeMillis())
            })
        }
    }

    override fun close() {
        closed = true
        setState(RelayState.CLOSED)
        runCatching { webSocket?.abort() }
        webSocket = null
    }

    val currentState: RelayState get() = state

    // ============ 发送 ============

    private fun sendJson(obj: JsonObject) {
        val ws = webSocket ?: return
        val text = json.encodeToString(JsonObject.serializer(), obj)
        synchronized(sendLock) {
            try {
                ws.sendText(text, true).get(10, java.util.concurrent.TimeUnit.SECONDS)
            } catch (e: Exception) {
                println("[zcode-relay] 发送失败: ${e.message?.take(120)}")
            }
        }
    }

    /** 发送 L4 控制面 payload（data 信封） */
    fun sendPayload(payload: JsonObject) {
        sendJson(buildJsonObject {
            put("type", Relay.TYPE_DATA)
            put("payload", payload)
            put("client_ts", System.currentTimeMillis())
        })
    }

    /**
     * 发送 L6 channel 帧（EventFire 推送 / PromiseSuccess 应答等内层二进制），
     * 自动分片为 rpc-frame。identity（bridgeGeneration/recoveryId）与 seq/messageSeq
     * 均按 bridge 上下文带上（H5 侧 identity 校验 + seq 连续性要求）。
     */
    fun sendChannelMessage(bridgeSessionId: String, inner: ByteArray) {
        val ctx = bridgesOut[bridgeSessionId]
        // seq/messageSeq 分配必须与实际上线同锁(可重入):H5 对两序号均做连续性
        // 校验,分配后若被并发帧抢先上线,H5 判空洞立即 recover 重建桥——手机端
        // 「点进会话偶发不断刷新」即此竞态(2026-09-24 IAB 帧级实锤:应答 mseq
        // 95→97 缺 96,1ms 后 H5 发 recover-start 断桥重连)
        synchronized(sendLock) {
            val messageSeq = ctx?.nextMessageSeq?.incrementAndGet() ?: fallbackSeq.incrementAndGet()
            val fragments = FrameFragmenter.fragment(
                bridgeSessionId,
                nextSeq = { ctx?.nextSeq?.incrementAndGet() ?: fallbackSeq.incrementAndGet() },
                messageSeq = messageSeq,
                data = inner,
                bridgeGeneration = ctx?.generation,
                recoveryId = ctx?.recoveryId,
            )
            for (fragment in fragments) sendPayload(fragment)
        }
    }

    /** 便捷：EventFire(listenerId, data) 推送 */
    fun sendChannelEvent(bridgeSessionId: String, listenerId: Long, data: ChValue) {
        sendChannelMessage(bridgeSessionId, ChannelCodec.encodeEvent(listenerId, data))
    }

    private fun sendAuthInit() {
        setState(RelayState.AUTHENTICATING)
        sendJson(buildJsonObject {
            put("type", Relay.TYPE_AUTH_INIT)
            put("role", "device")
            put("device_sid", credentials.deviceSid)
            put("meta", buildJsonObject {
                put("platform", config.platform)
                put("version", config.appVersion)
                put("name", config.deviceName)
            })
            put("client_ts", System.currentTimeMillis())
        })
    }

    private fun setState(next: RelayState) {
        if (state == next) return
        state = next
        // 翻转计数挂在真实状态变化上：心跳 pair_status_query 的 ACK 每 10s 一条，
        // 若在 ACK 分支无条件计数，60s 窗口必凑满阈值——churn 假阳性每 40s 重置
        // 一次 pair 反复踢断手机页（2026-09-23 晚「会话加载不出来」实锤，21:46-48 四连击）
        if (next == RelayState.PAIRED || next == RelayState.WAITING_TERMINAL) recordPairFlip(next)
        println("[zcode-relay] 状态 → $next")
        runCatching { onStateChange?.invoke(next) }
            .onFailure { println("[zcode-relay] onStateChange 异常: ${it.message}") }
    }

    /**
     * terminal 互顶循环检测：滑窗 [Relay.TERMINAL_CHURN_WINDOW_MS] 内 pair 真实
     * 翻转（仅 setState 的 PAIRED↔WAITING_TERMINAL 变化沿，见调用处）≥
     * [Relay.TERMINAL_CHURN_FLIPS] 次即告警（每次告警后冷却一个窗口防重入）。
     * 正常使用（单页面开关/偶发断连）窗口内翻转 1-2 次。
     */
    private fun recordPairFlip(next: RelayState) {
        val now = System.currentTimeMillis()
        pairFlipTimestamps.add(now)
        while (pairFlipTimestamps.isNotEmpty() && now - pairFlipTimestamps.peek() > Relay.TERMINAL_CHURN_WINDOW_MS) {
            pairFlipTimestamps.poll()
        }
        if (pairFlipTimestamps.size >= Relay.TERMINAL_CHURN_FLIPS) {
            pairFlipTimestamps.clear() // 冷却：下个窗口才可再告警
            println("[zcode-relay] terminal churn detected (${Relay.TERMINAL_CHURN_FLIPS} flips in window)")
            runCatching { onTerminalChurn?.invoke() }
                .onFailure { println("[zcode-relay] onTerminalChurn 异常: ${it.message}") }
        }
    }

    // ============ 接收（WS 回调线程） ============

    private inner class Listener : WebSocket.Listener {
        private val textBuffer = StringBuilder()

        override fun onOpen(webSocket: WebSocket) {
            this@RelayClient.webSocket = webSocket
            lastInboundAt = System.currentTimeMillis() // 重连成功即刷新，防旧值误杀新连接
            webSocket.request(1)
        }

        override fun onText(webSocket: WebSocket, data: CharSequence, last: Boolean): CompletionStage<*>? {
            textBuffer.append(data)
            if (last) {
                val text = textBuffer.toString()
                textBuffer.setLength(0)
                runCatching { handleSignal(text) }
                    .onFailure { println("[zcode-relay] 帧处理异常: ${it.message?.take(200)}") }
            }
            webSocket.request(1)
            return null
        }

        override fun onError(webSocket: WebSocket, error: Throwable) {
            println("[zcode-relay] WS error: ${error.message?.take(200)}")
            scheduleReconnect()
        }

        override fun onClose(webSocket: WebSocket, statusCode: Int, reason: String): CompletionStage<*>? {
            println("[zcode-relay] WS close: $statusCode ${reason.take(120)}")
            scheduleReconnect()
            return null
        }
    }

    private fun handleSignal(text: String) {
        lastInboundAt = System.currentTimeMillis() // 任何入站帧（含 error）都是连接活性证据
        val msg = json.parseToJsonElement(text).jsonObject
        when (msg["type"]?.let { (it as? JsonPrimitive)?.content }) {
            Relay.TYPE_DEVICE_REGISTER_ACK -> {
                val sid = (msg["device_sid"] as? JsonPrimitive)?.content
                if (sid.isNullOrBlank()) {
                    println("[zcode-relay] register_ack 缺 device_sid")
                    return
                }
                credentials = credentials.copy(deviceSid = sid)
                println("[zcode-relay] 注册成功 deviceSid=$sid")
                runCatching { onDeviceRegistered?.invoke(credentials) }
                sendAuthInit()
            }
            Relay.TYPE_AUTH_CHALLENGE -> {
                val nonce = (msg["nonce"] as? JsonPrimitive)?.content ?: return
                val sid = credentials.deviceSid ?: return
                val proof = RelayCrypto.calculateProof(credentials.passHash, nonce, "device", sid)
                sendJson(buildJsonObject {
                    put("type", Relay.TYPE_AUTH_RESPONSE)
                    put("device_sid", sid)
                    put("proof", proof)
                    put("client_ts", System.currentTimeMillis())
                })
            }
            Relay.TYPE_AUTH_ACK, Relay.TYPE_PAIR_STATUS_ACK -> {
                when ((msg["pair_status"] as? JsonPrimitive)?.content) {
                    "matched" -> {
                        reconnectAttempt = 0 // 会话真正建立：退避归零（否则闪断几次后每次都等 60s）
                        setState(RelayState.PAIRED)
                    }
                    "waiting" -> {
                        reconnectAttempt = 0
                        setState(RelayState.WAITING_TERMINAL)
                    }
                    else -> setState(RelayState.AUTHENTICATING)
                }
            }
            Relay.TYPE_DATA -> {
                val payload = msg["payload"] as? JsonObject ?: return
                handleDataPayload(payload)
            }
            Relay.TYPE_ERROR -> {
                val code = (msg["code"] as? JsonPrimitive)?.content
                val message = (msg["message"] as? JsonPrimitive)?.content
                println("[zcode-relay] relay error code=$code message=$message")
                if (code == Relay.ERR_KICKED) {
                    setState(RelayState.KICKED)
                    closed = true // 被顶号不重连（宿主决策提示用户）
                    runCatching { webSocket?.abort() }
                }
                runCatching { onRelayError?.invoke(code, message) }
                    .onFailure { println("[zcode-relay] onRelayError 异常: ${it.message}") }
            }
            else -> Unit // 其余信令静默
        }
    }

    private fun handleDataPayload(payload: JsonObject) {
        val zcodeType = (payload["zcode_type"] as? JsonPrimitive)?.content ?: return

        if (zcodeType == Relay.PAYLOAD_RPC_FRAME) {
            handleRpcFrame(payload)
            return
        }
        // bridge-open 先登记出站 identity（后续 rpc-frame 的 generation/recoveryId 必须与之一致）
        if (zcodeType == Relay.PAYLOAD_WORKSPACE_BRIDGE_OPEN) {
            val bridgeId = (payload["bridgeSessionId"] as? JsonPrimitive)?.content
            if (bridgeId != null) {
                registerBridgeOutbound(
                    bridgeId,
                    (payload["bridgeGeneration"] as? JsonPrimitive)?.content?.toLongOrNull(),
                    (payload["recoveryId"] as? JsonPrimitive)?.content,
                )
            }
        }
        // 控制面 payload 交给宿主；应答经 sender 原路回 data 帧
        val sender = PayloadSender { reply -> sendPayload(reply) }
        runCatching { onPayload?.invoke(payload, sender) }
            .onFailure { println("[zcode-relay] onPayload(${zcodeType}) 异常: ${it.message?.take(200)}") }
    }

    private fun handleRpcFrame(payload: JsonObject) {
        val bridge = (payload["bridgeSessionId"] as? JsonPrimitive)?.content ?: return
        val messageSeq = (payload["messageSeq"] as? JsonPrimitive)?.content?.toLongOrNull() ?: return
        val fragmentIndex = (payload["fragmentIndex"] as? JsonPrimitive)?.content?.toIntOrNull() ?: 0
        // generation 入键：同 bridge 换代 recovery 后 H5 侧序号可能重计，无代键会误杀新代帧
        val generation = (payload["bridgeGeneration"] as? JsonPrimitive)?.content
        val epoch = if (generation != null) "$bridge\u0000$generation" else bridge

        // 每条消息首片回一次 ack（对齐官方行为）
        if (fragmentIndex == 0 && !ackedMessages.seenOrAdd("$epoch\u0000$messageSeq")) {
            sendPayload(buildJsonObject {
                put("zcode_type", Relay.PAYLOAD_RPC_FRAME_ACK)
                put("bridgeSessionId", bridge)
                payload["bridgeGeneration"]?.let { put("bridgeGeneration", it) }
                payload["recoveryId"]?.let { put("recoveryId", it) }
                put("ackMessageSeq", messageSeq)
            })
        }

        val assembled = assembler.accept(payload) ?: return
        // 重发帧（同代同 messageSeq，缺陷FV）不二次 dispatch——去重放组装成功后：
        // 多片消息缺片靠重发补齐的路径不被误杀
        if (dispatchedMessages.seenOrAdd("$epoch\u0000${assembled.messageSeq}")) return
        dispatchAssembled(bridge, assembled.data)
    }

    private fun dispatchAssembled(bridge: String, data: ByteArray) {
        val request = try {
            ChannelCodec.parseRequest(data)
        } catch (e: Exception) {
            // 非 channel 二进制：尝试 JSON（防御分支，手机→桌面正常均为 channel 帧）
            val asJson = runCatching {
                json.parseToJsonElement(String(data, Charsets.UTF_8)).jsonObject
            }.getOrNull()
            if (asJson != null) {
                val sender = PayloadSender { reply -> sendPayload(reply) }
                runCatching { onPayload?.invoke(asJson, sender) }
                return
            }
            println("[zcode-relay] rpc-frame 内层不可解析: ${data.size}B")
            return
        }

        val responder = object : ChannelResponder {
            private val done = AtomicLong(0)
            override fun success(result: ChValue) {
                if (done.compareAndSet(0, 1)) sendChannelMessage(bridge, ChannelCodec.encodeSuccess(request.id, result))
            }
            override fun error(message: String) {
                if (done.compareAndSet(0, 1)) sendChannelMessage(bridge, ChannelCodec.encodeError(request.id, message))
            }
        }

        when (request.type) {
            ChannelCodec.REQ_PROMISE ->
                runCatching { onChannelRequest?.invoke(bridge, request, responder) }
                    .onFailure {
                        println("[zcode-relay] onChannelRequest 异常: ${it.message?.take(200)}")
                        responder.error("internal: ${it.message ?: "unknown"}")
                    }
            ChannelCodec.REQ_EVENT_LISTEN ->
                runCatching {
                    onChannelEventListen?.invoke(
                        bridge, request.id, request.channel, request.method,
                        request.args.firstOrNull(),
                    )
                }.onFailure { println("[zcode-relay] onChannelEventListen 异常: ${it.message?.take(200)}") }
            ChannelCodec.REQ_EVENT_DISPOSE ->
                runCatching { onChannelEventDispose?.invoke(request.id) }
            ChannelCodec.REQ_PROMISE_CANCEL -> Unit // 首版不实现取消语义
            else -> println("[zcode-relay] 未知 channel 请求 type=${request.type}")
        }
    }

    // ============ 心跳与重连 ============

    private var heartbeatThread: Thread? = null

    fun startHeartbeat() {
        if (heartbeatThread?.isAlive == true) return
        heartbeatThread = thread(isDaemon = true, name = "zcode-relay-heartbeat") {
            while (!closed) {
                Thread.sleep(Relay.HEARTBEAT_INTERVAL_MS)
                if (closed) return@thread
                // 半开检测：TCP 静默断开时 onClose/onError 不触发、sendJson 照常进缓冲，
                // 状态机从此停摆——relay 侧 device 僵死会连累所有新 terminal 被 30s 清理
                if (lastInboundAt != 0L) {
                    val silent = System.currentTimeMillis() - lastInboundAt
                    if (silent > Relay.HEARTBEAT_DEAD_MS) {
                        println("[zcode-relay] 心跳活性失败（${silent}ms 无入站帧），判定连接半开，强制重连")
                        runCatching { webSocket?.abort() } // 触发 onError → scheduleReconnect
                        continue
                    }
                }
                if (credentials.deviceSid != null &&
                    (state == RelayState.PAIRED || state == RelayState.WAITING_TERMINAL)
                ) {
                    sendJson(buildJsonObject {
                        put("type", Relay.TYPE_PAIR_STATUS_QUERY)
                        put("device_sid", credentials.deviceSid)
                        put("client_ts", System.currentTimeMillis())
                    })
                }
            }
        }
    }

    private fun scheduleReconnect() {
        if (closed || reconnecting) return
        if (config.reconnectBackoffMs.isEmpty()) return
        reconnecting = true
        val delay = config.reconnectBackoffMs[reconnectAttempt.coerceAtMost(config.reconnectBackoffMs.size - 1)]
        reconnectAttempt++
        println("[zcode-relay] ${delay}ms 后重连（第 $reconnectAttempt 次）")
        thread(isDaemon = true, name = "zcode-relay-reconnect") {
            Thread.sleep(delay)
            reconnecting = false
            if (closed) return@thread
            runCatching { connect() }
                .onFailure {
                    println("[zcode-relay] 重连失败: ${it.message?.take(200)}")
                    scheduleReconnect()
                }
        }
    }
}

/** 生产传输：JDK HttpClient WebSocket（header 注入 + 3s 连接超时）。
 *  proxySelector 非 null 时挂上——relay WS 由插件进程直发，代理环境下直连不通
 *  （须走共享 setting.json 的 httpProxy，与额度 monitor HTTP 同源同规则）；
 *  null 时不设置，走 JVM 默认 ProxySelector（行为不变） */
class JdkWebSocketTransportFactory(
    private val proxySelector: java.net.ProxySelector? = null,
) : RelayClient.TransportFactory {
    override fun connect(url: String, headers: Map<String, String>, listener: WebSocket.Listener): WebSocket {
        val httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(3))
            .apply { proxySelector?.let { proxy(it) } }
            .build()
        val builder = httpClient
            .newWebSocketBuilder()
            .connectTimeout(Duration.ofSeconds(3))
        for ((k, v) in headers) builder.header(k, v)
        return builder.buildAsync(URI.create(url), listener).join()
    }
}

/**
 * 有界去重集：rpc-frame 的 ack/dispatch 去重键存放处。此前 ackedMessages 为无界
 * ConcurrentHashMap.newKeySet，长驻进程慢性泄漏（缺陷FV 顺手收口）；容量远大于
 * 实际窗口即可——重发总发生在紧邻帧段，淘汰最旧条目不影响判重。
 */
private class BoundedKeySet(private val cap: Int = 8_192) {
    private val map = object : LinkedHashMap<String, Boolean>(64, 0.75f, false) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Boolean>): Boolean = size > cap
    }

    /** @return true=键此前已存在（重复帧） */
    fun seenOrAdd(key: String): Boolean = synchronized(map) { map.put(key, true) != null }
}
