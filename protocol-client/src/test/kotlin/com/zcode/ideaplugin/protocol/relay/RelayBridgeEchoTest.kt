package com.zcode.ideaplugin.protocol.relay

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * RelayBridge 控制面应答形状（缺陷FS 六轮）：
 * bridge-open 带 taskId 时 ready 必须回显 bridge.initialTaskId——H5 桥开启后按
 * i.bridge.initialTaskId 续接任务导航，缺失=回落工作区 draft 视图（真机 HAR 实锤）。
 */
class RelayBridgeEchoTest {

    private class Capture : RelayClient.PayloadSender {
        val sent = ArrayList<String>()
        override fun send(payload: kotlinx.serialization.json.JsonObject) {
            sent.add(payload.toString())
        }
    }


    private fun openBridge(bridge: RelayBridge, taskId: String?): Capture {
        val cap = Capture()
        bridge.handlePayload(buildJsonObject {
            put("zcode_type", Relay.PAYLOAD_WORKSPACE_BRIDGE_OPEN)
            put("bridgeSessionId", "bridge-test-1")
            put("bridgeGeneration", "7")
            put("workspaceKey", "G:/ws")
            taskId?.let { put("taskId", it) }
        }, cap)
        return cap
    }

    @Test
    fun `ready echoes taskId as bridge initialTaskId`() {
        val cap = openBridge(RelayBridge(), "sess_target")
        assertEquals(1, cap.sent.size, "ready 应答一帧")
        val ready = Json.parseToJsonElement(cap.sent[0]).jsonObject
        assertEquals(Relay.PAYLOAD_WORKSPACE_BRIDGE_READY, ready["zcode_type"]?.jsonPrimitive?.content)
        val bridge = ready["bridge"]?.jsonObject
        assertEquals("sess_target", bridge?.get("initialTaskId")?.jsonPrimitive?.content, "taskId 回显为 initialTaskId")
        assertEquals("G:/ws", bridge?.get("workspaceKey")?.jsonPrimitive?.content)
    }

    @Test
    fun `ready without taskId omits initialTaskId`() {
        val cap = openBridge(RelayBridge(), null)
        val ready = Json.parseToJsonElement(cap.sent[0]).jsonObject
        assertNull(ready["bridge"]?.jsonObject?.get("initialTaskId"), "无 taskId 不落空串（H5 判空串非空会误导航）")
    }

    @Test
    fun `workspaceKeyOf resolves after open`() {
        val bridge = RelayBridge()
        openBridge(bridge, "sess_target")
        assertEquals("G:/ws", bridge.workspaceKeyOf("bridge-test-1"))
    }

    @Test
    fun `unknown payload returns false without sending`() {
        val cap = Capture()
        val bridge = RelayBridge()
        val handled = bridge.handlePayload(buildJsonObject { put("zcode_type", "mobile-view-state-update") }, cap)
        assertFalse(handled, "遥测类信封不视为 bridge-open")
        assertTrue(cap.sent.isEmpty())
    }
}
