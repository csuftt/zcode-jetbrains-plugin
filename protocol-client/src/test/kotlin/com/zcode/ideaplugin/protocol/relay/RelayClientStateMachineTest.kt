package com.zcode.ideaplugin.protocol.relay

import com.zcode.ideaplugin.protocol.relay.ChannelCodec.ChValue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.net.http.WebSocket
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionStage
import java.util.concurrent.LinkedBlockingQueue
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * 状态机与 L4/L6 路由测试：fake WebSocket 驱动 register→auth→paired→payload→channel 全链。
 */
class RelayClientStateMachineTest {

    /** fake WS：记录发送帧文本；fireText 模拟 relay 下行（转发给真实 Listener） */
    private class FakeWebSocket : WebSocket {
        val sent = LinkedBlockingQueue<String>()
        @Volatile var listener: WebSocket.Listener? = null

        fun fireText(text: String) {
            listener?.onText(this, text, true)
        }

        override fun sendText(text: CharSequence, last: Boolean): CompletableFuture<WebSocket> {
            sent.add(text.toString())
            return CompletableFuture.completedFuture(this)
        }
        override fun sendBinary(data: java.nio.ByteBuffer, last: Boolean): CompletableFuture<WebSocket> =
            CompletableFuture.completedFuture(this)
        override fun sendPing(message: java.nio.ByteBuffer): CompletableFuture<WebSocket> =
            CompletableFuture.completedFuture(this)
        override fun sendPong(message: java.nio.ByteBuffer): CompletableFuture<WebSocket> =
            CompletableFuture.completedFuture(this)
        override fun sendClose(code: Int, reason: String): CompletableFuture<WebSocket> =
            CompletableFuture.completedFuture(this)
        override fun request(n: Long) {}
        override fun getSubprotocol(): String = ""
        override fun isOutputClosed(): Boolean = false
        override fun isInputClosed(): Boolean = false
        override fun abort() {}
    }

    private val json = Json { ignoreUnknownKeys = true }

    private fun sentType(text: String): String? =
        runCatching { json.parseToJsonElement(text).jsonObject["type"] }.getOrNull()
            ?.let { (it as kotlinx.serialization.json.JsonPrimitive).content }

    private fun sentPayload(text: String): JsonObject? =
        runCatching {
            json.parseToJsonElement(text).jsonObject["payload"]?.jsonObject
        }.getOrNull()

    @Test
    fun `register 到 paired 全流程`() {
        val ws = FakeWebSocket()
        val client = RelayClient(
            config = RelayClient.RelayConfig(deviceName = "test-ide", reconnectBackoffMs = longArrayOf()),
            credentials = RelayCredentials(deviceMid = "mid-x", deviceSid = null, passHash = "hash-x"),
            transportFactory = { _, _, listener -> ws.listener = listener; listener.onOpen(ws); ws },
        )
        val states = ArrayList<RelayState>()
        client.onStateChange = { states.add(it) }
        var registered: RelayCredentials? = null
        client.onDeviceRegistered = { registered = it }

        client.connect()
        // 1) register_init 已发
        assertEquals(Relay.TYPE_DEVICE_REGISTER_INIT, sentType(ws.sent.poll()))
        // 2) relay 回 register_ack → 客户端应发 auth_init 并回调持久化
        ws.fireText("""{"type":"device_register_ack","device_sid":"sid-1"}""")
        assertEquals("sid-1", registered?.deviceSid)
        assertEquals(Relay.TYPE_AUTH_INIT, sentType(ws.sent.poll()))
        // 3) challenge → proof 应答
        ws.fireText("""{"type":"auth_challenge","nonce":"n1"}""")
        val resp = ws.sent.poll()
        assertEquals(Relay.TYPE_AUTH_RESPONSE, sentType(resp))
        val proof = json.parseToJsonElement(resp).jsonObject["proof"].let { (it as kotlinx.serialization.json.JsonPrimitive).content }
        assertEquals(RelayCrypto.calculateProof("hash-x", "n1", "device", "sid-1"), proof)
        // 4) auth_ack waiting → WAITING_TERMINAL；matched → PAIRED
        ws.fireText("""{"type":"auth_ack","pair_status":"waiting"}""")
        assertEquals(RelayState.WAITING_TERMINAL, client.currentState)
        ws.fireText("""{"type":"pair_status_ack","pair_status":"matched"}""")
        assertEquals(RelayState.PAIRED, client.currentState)
        assertTrue(RelayState.WAITING_TERMINAL in states && RelayState.PAIRED in states)
        client.close()
    }

    @Test
    fun `KICKED 不再重连`() {
        val ws = FakeWebSocket()
        var reconnected = false
        val client = RelayClient(
            config = RelayClient.RelayConfig(reconnectBackoffMs = longArrayOf(10)),
            credentials = RelayCredentials(deviceMid = "m", deviceSid = "s", passHash = "h"),
            transportFactory = { _, _, listener -> ws.listener = listener; listener.onOpen(ws); ws },
        )
        client.onRelayError = { code, _ -> if (code == Relay.ERR_KICKED) reconnected = true }
        client.connect()
        assertEquals(Relay.TYPE_AUTH_INIT, sentType(ws.sent.poll()))
        ws.fireText("""{"type":"error","code":"KICKED","message":"kicked by relay"}""")
        assertEquals(RelayState.KICKED, client.currentState)
        assertTrue(reconnected)
        Thread.sleep(60) // backoff 10ms 后不应产生重连动作
        assertTrue(ws.sent.isEmpty(), "KICKED 后不应再发任何帧")
        client.close()
    }

    @Test
    fun `L4 控制面 payload 进 onPayload 且 sender 可应答`() {
        val ws = FakeWebSocket()
        val client = RelayClient(
            config = RelayClient.RelayConfig(reconnectBackoffMs = longArrayOf()),
            credentials = RelayCredentials(deviceMid = "m", deviceSid = "s", passHash = "h"),
            transportFactory = { _, _, listener -> ws.listener = listener; listener.onOpen(ws); ws },
        )
        val received = ArrayList<String>()
        client.onPayload = { payload, sender ->
            received.add((payload["zcode_type"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: "?")
            if ((payload["zcode_type"] as? kotlinx.serialization.json.JsonPrimitive)?.content == Relay.PAYLOAD_BOOTSTRAP_REQUEST) {
                sender.send(buildJsonObject {
                    put("zcode_type", Relay.PAYLOAD_BOOTSPONSE)
                    put("requestId", (payload["requestId"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: "")
                    put("success", true)
                })
            }
        }
        client.connect()
        assertEquals(Relay.TYPE_AUTH_INIT, sentType(ws.sent.poll()), "connect 先发 auth_init")
        ws.fireText("""{"type":"data","payload":{"zcode_type":"bootstrap-request","requestId":"r1"},"client_ts":1}""")
        assertEquals(listOf(Relay.PAYLOAD_BOOTSTRAP_REQUEST), received)
        val reply = ws.sent.poll()
        val replyPayload = sentPayload(reply)!!
        assertEquals(Relay.PAYLOAD_BOOTSPONSE, (replyPayload["zcode_type"] as kotlinx.serialization.json.JsonPrimitive).content)
        client.close()
    }

    @Test
    fun `L6 channel 请求解析与应答回传`() {
        val ws = FakeWebSocket()
        val client = RelayClient(
            config = RelayClient.RelayConfig(reconnectBackoffMs = longArrayOf()),
            credentials = RelayCredentials(deviceMid = "m", deviceSid = "s", passHash = "h"),
            transportFactory = { _, _, listener -> ws.listener = listener; listener.onOpen(ws); ws },
        )
        client.onChannelRequest = { _, req, responder ->
            if (req.channel == "zcode-task" && req.method == "echo") {
                responder.success(req.args.firstOrNull() ?: ChValue.Undefined)
            } else {
                responder.error("Method not found: ${req.channel}.${req.method}")
            }
        }
        val listens = ArrayList<Pair<String?, String?>>()
        client.onChannelEventListen = { _, _, channel, event, _ -> listens.add(channel to event) }
        client.connect()
        assertEquals(Relay.TYPE_AUTH_INIT, sentType(ws.sent.poll()), "connect 先发 auth_init")

        // 手机发 echo 请求（bridge-open 前直接发 rpc-frame 也应处理）
        val inner = ChannelCodec.encodeRequest(
            42, "zcode-task", "echo",
            listOf(ChValue.Obj(buildJsonObject { put("v", 7) })),
        )
        ws.fireText(
            """{"type":"data","payload":{""" +
                """"zcode_type":"rpc-frame","bridgeSessionId":"br1","seq":1,"messageSeq":1,"fragmentIndex":0,"fragmentCount":1,""" +
                """"messageBytes":${inner.size},"checksum":{"algorithm":"crc32","value":"${FrameAssembler.crc32Hex(inner)}"},""" +
                """"dataBase64":"${java.util.Base64.getEncoder().encodeToString(inner)}"}}""",
        )
        // 应答分两帧：ack + PromiseSuccess
        val ack = sentPayload(ws.sent.poll())!!
        assertEquals(Relay.PAYLOAD_RPC_FRAME_ACK, (ack["zcode_type"] as kotlinx.serialization.json.JsonPrimitive).content)
        assertEquals(1, (ack["ackMessageSeq"] as kotlinx.serialization.json.JsonPrimitive).content.toLong())
        val reply = sentPayload(ws.sent.poll())!!
        assertEquals(Relay.PAYLOAD_RPC_FRAME, (reply["zcode_type"] as kotlinx.serialization.json.JsonPrimitive).content)
        val replyInner = java.util.Base64.getDecoder().decode((reply["dataBase64"] as kotlinx.serialization.json.JsonPrimitive).content)
        val values = ChannelCodec.decodeAll(replyInner)
        val replyHead = (values[0] as ChValue.Arr).items
        assertEquals(ChannelCodec.RES_PROMISE_SUCCESS, (replyHead[0] as ChValue.IntVal).value)
        assertEquals(42, (replyHead[1] as ChValue.IntVal).value)

        // EventListen 帧（真机形态：数组头 [102, id, channel, event]）
        val listen = ChannelCodec.encodeMessage(
            listOf(
                ChValue.Arr(
                    listOf(
                        ChValue.IntVal(ChannelCodec.REQ_EVENT_LISTEN), ChValue.IntVal(99),
                        ChValue.Str("zcode-task"), ChValue.Str("onDynamicStreamEvent"),
                    )
                )
            )
        )
        ws.fireText(
            """{"type":"data","payload":{"zcode_type":"rpc-frame","bridgeSessionId":"br1","seq":2,"messageSeq":2,""" +
                """"fragmentIndex":0,"fragmentCount":1,"messageBytes":${listen.size},""" +
                """"checksum":{"algorithm":"crc32","value":"${FrameAssembler.crc32Hex(listen)}"},""" +
                """"dataBase64":"${java.util.Base64.getEncoder().encodeToString(listen)}"}}""",
        )
        assertEquals("zcode-task", listens.first().first)
        assertEquals("onDynamicStreamEvent", listens.first().second)
        ws.sent.poll() // ack
        client.close()
    }

    @Test
    fun `重发帧只 ack 与 dispatch 一次，换代后同 messageSeq 放行`() {
        // 缺陷FV（2026-11-04 手机 HAR #237-245 实锤）：手机链路恢复会原样重发整段
        // burst（相同 messageSeq），此前 dispatch 不去重 → subscribeConversationV4
        // 双订阅烧 v4 槽、快照双推，并触发 H5 恢复链 resync 失败=「重新连接」
        val ws = FakeWebSocket()
        var requests = 0
        val client = RelayClient(
            config = RelayClient.RelayConfig(reconnectBackoffMs = longArrayOf()),
            credentials = RelayCredentials(deviceMid = "m", deviceSid = "s", passHash = "h"),
            transportFactory = { _, _, listener -> ws.listener = listener; listener.onOpen(ws); ws },
        )
        client.onChannelRequest = { _, _, responder -> requests++; responder.success(ChValue.Undefined) }
        client.connect()
        assertEquals(Relay.TYPE_AUTH_INIT, sentType(ws.sent.poll()))

        val inner = ChannelCodec.encodeRequest(
            7, "zcode-task", "echo",
            listOf(ChValue.Obj(buildJsonObject { put("v", 1) })),
        )
        fun frame(seq: Long, mseq: Long, gen: Long?): String {
            val genPart = if (gen != null) """"bridgeGeneration":$gen,""" else ""
            return """{"type":"data","payload":{"zcode_type":"rpc-frame","bridgeSessionId":"br1",""" + genPart +
                """"seq":$seq,"messageSeq":$mseq,"fragmentIndex":0,"fragmentCount":1,""" +
                """"messageBytes":${inner.size},"checksum":{"algorithm":"crc32","value":"${FrameAssembler.crc32Hex(inner)}"},""" +
                """"dataBase64":"${java.util.Base64.getEncoder().encodeToString(inner)}"}}"""
        }

        // 首发：ack + dispatch 应答
        ws.fireText(frame(1, 1, null))
        val ack1 = sentPayload(ws.sent.poll())!!
        assertEquals(Relay.PAYLOAD_RPC_FRAME_ACK, (ack1["zcode_type"] as kotlinx.serialization.json.JsonPrimitive).content)
        ws.sent.poll() // PromiseSuccess
        assertEquals(1, requests)

        // 原样重发（相同 messageSeq）：不得再 ack、不得二次 dispatch
        ws.fireText(frame(1, 1, null))
        assertTrue(ws.sent.isEmpty(), "重发帧不应产生任何下行帧")
        assertEquals(1, requests, "重发帧不应二次 dispatch")

        // 换代（bridgeGeneration 变化）后同 messageSeq 是新代消息：放行
        ws.fireText(frame(2, 1, 2L))
        val ack2 = sentPayload(ws.sent.poll())!!
        assertEquals(Relay.PAYLOAD_RPC_FRAME_ACK, (ack2["zcode_type"] as kotlinx.serialization.json.JsonPrimitive).content)
        ws.sent.poll() // PromiseSuccess
        assertEquals(2, requests)
        client.close()
    }

    @Test
    fun `并发 sendChannelMessage 时 wire 顺序与 messageSeq 分配一致`() {
        val ws = FakeWebSocket()
        val client = RelayClient(
            config = RelayClient.RelayConfig(deviceName = "test-ide", reconnectBackoffMs = longArrayOf()),
            credentials = RelayCredentials(deviceMid = "m", deviceSid = "s", passHash = "h"),
            transportFactory = { _, _, listener -> ws.listener = listener; listener.onOpen(ws); ws },
        )
        client.connect()
        ws.sent.poll() // auth_init
        client.registerBridgeOutbound("br1", 1L, null)
        ws.sent.clear()

        val total = 400
        val threads = (1..4).map { t ->
            Thread {
                repeat(total / 4) { i ->
                    client.sendChannelMessage(
                        "br1",
                        ChannelCodec.encodeMessage(listOf(ChValue.Str("t$t-$i"))),
                    )
                }
            }
        }
        threads.forEach { it.start() }
        threads.forEach { it.join() }

        // H5 对 messageSeq/seq 做连续性校验:分配序号与实际上线顺序不一致时,
        // H5 判空洞立即 recover 重建桥(手机端点进会话偶发不断刷新的根因)
        val seqs = ws.sent.mapNotNull { sentPayload(it) }
            .filter { (it["zcode_type"] as? kotlinx.serialization.json.JsonPrimitive)?.content == Relay.PAYLOAD_RPC_FRAME }
            .map { (it["messageSeq"] as kotlinx.serialization.json.JsonPrimitive).content.toLong() }
        assertEquals(total, seqs.size)
        assertEquals((1L..total.toLong()).toList(), seqs, "wire 顺序必须与 messageSeq 分配一致")
        client.close()
    }
}
