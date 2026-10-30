package com.zcode.ideaplugin.protocol.relay

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * L4 控制面应答桥（纯协议，零 IDE 依赖）：bootstrap / workspace-list / bridge-open /
 * reconnect / platform 五类应答 + bridge 与事件订阅路由簿。
 *
 * IDE 侧（ZCodeRemoteService）注入 workspace 列表提供者；channel 语义层（L6 →
 * app-server 转发）由宿主在 onChannelRequest 里实现，本类只维护路由簿。
 */
class RelayBridge(
    private val workspacesProvider: () -> List<RelayWorkspace> = { emptyList() },
    /** 首页任务行提供者（官方 HAR 定案形状：archived/createdAt/displayStatus/provider/
     *  taskId/title/updatedAt/workspaceKind/workspaceLabel/workspacePath） */
    private val tasksProvider: () -> List<JsonObject> = { emptyList() },
) {

    /** workspace 聚合条目（IDE 打开的项目 / 测试注入的静态列表） */
    data class RelayWorkspace(
        val path: String,
        val label: String,
        val identity: String = path,
        val kind: String = "local",
        val connectionState: String = "connected",
    )

    /** 活跃 bridge：手机一次 workspace 进入对应一条 */
    data class Bridge(
        val bridgeSessionId: String,
        val workspaceKey: String,
        val bridgeGeneration: Long?,
        val recoveryId: String?,
    )

    /** 事件订阅注册表条目（EventFire 推送按 bridgeSessionId 路由） */
    data class EventSubscription(val bridgeSessionId: String, val channel: String?, val event: String?)

    private val bridges = java.util.concurrent.ConcurrentHashMap<String, Bridge>()
    private val subscriptions = java.util.concurrent.ConcurrentHashMap<Long, EventSubscription>()

    /** @return true=bridge-open（调用方需在应答后推 channel Initialize） */
    fun handlePayload(payload: JsonObject, sender: RelayClient.PayloadSender): Boolean {
        val type = payload["zcode_type"]?.jsonPrimitive?.content ?: return false
        val requestId = payload["requestId"]?.jsonPrimitive?.content
        when (type) {
            Relay.PAYLOAD_BOOTSTRAP_REQUEST ->
                sender.send(buildJsonObject {
                    requestId?.let { put("requestId", it) }
                    put("zcode_type", Relay.PAYLOAD_BOOTSPONSE)
                    put("success", true)
                    put("result", buildJsonObject {
                        put("windowControlSessionId", "zcode-host")
                        // mobileViewState.activeWorkspaceKey 驱动 H5 连接后直接进入
                        // 工作区会话页（官方 HAR 实测；缺失则停在首页命令面板）
                        put("mobileViewState", buildJsonObject {
                            put("activeWorkspaceKey", workspacesProvider().firstOrNull()?.path ?: "")
                            put("updatedAt", System.currentTimeMillis())
                        })
                        put("workspaces", workspaceArray())
                        put("tasks", kotlinx.serialization.json.JsonArray(tasksProvider()))
                    })
                })
            Relay.PAYLOAD_WORKSPACE_LIST_REQUEST ->
                sender.send(buildJsonObject {
                    requestId?.let { put("requestId", it) }
                    put("zcode_type", Relay.PAYLOAD_WORKSPACE_LIST_RESPONSE)
                    put("success", true)
                    put("result", buildJsonObject {
                        put("workspaces", workspaceArray())
                        put("tasks", kotlinx.serialization.json.JsonArray(tasksProvider()))
                        put("activeWorkspaceKey", workspacesProvider().firstOrNull()?.path ?: "")
                    })
                })
            Relay.PAYLOAD_WORKSPACE_BRIDGE_OPEN -> {
                val bridgeId = payload["bridgeSessionId"]?.jsonPrimitive?.content
                if (bridgeId != null) {
                    val workspaceKey = payload["workspaceKey"]?.jsonPrimitive?.content ?: ""
                    val generation = payload["bridgeGeneration"]?.jsonPrimitive?.content?.toLongOrNull()
                    val recoveryId = payload["recoveryId"]?.jsonPrimitive?.content
                    // 首页点任务进的桥会带 taskId：必须回显为 bridge.initialTaskId——H5 桥开启
                    // 后按 i.bridge.initialTaskId 续接任务导航（bundle P 函数定案），缺失=回落
                    // 工作区默认 draft 视图=「点会话恒进新会话页」（缺陷FS 六轮，真机 HAR 实锤：
                    // 前两次点击 bridge-open 带 taskId 但 ready 未回显，任务打开 RPC 零发出）
                    val taskId = payload["taskId"]?.jsonPrimitive?.content
                    bridges[bridgeId] = Bridge(bridgeId, workspaceKey, generation, recoveryId)
                    sender.send(buildJsonObject {
                        requestId?.let { put("requestId", it) }
                        put("zcode_type", Relay.PAYLOAD_WORKSPACE_BRIDGE_READY)
                        put("bridgeSessionId", bridgeId)
                        generation?.let { put("bridgeGeneration", it) }
                        recoveryId?.let { put("recoveryId", it) }
                        put("bridge", buildJsonObject {
                            put("kind", "local")
                            put("bridgeSessionId", bridgeId)
                            generation?.let { put("bridgeGeneration", it) }
                            recoveryId?.let { put("recoveryId", it) }
                            put("workspaceKey", workspaceKey)
                            put("workspacePath", workspaceKey)
                            taskId?.let { put("initialTaskId", it) }
                        })
                    })
                    return true
                }
            }
            Relay.PAYLOAD_WORKSPACE_RECONNECT_REQUEST ->
                sender.send(buildJsonObject {
                    requestId?.let { put("requestId", it) }
                    put("zcode_type", Relay.PAYLOAD_WORKSPACE_RECONNECT_RESPONSE)
                    payload["workspaceKey"]?.let { put("workspaceKey", it) }
                    put("success", true)
                })
            Relay.PAYLOAD_PLATFORM_REQUEST ->
                // platform 全集为 Docker/WSL/SSH/MCP 杂项（M0），宿主不支持
                sender.send(buildJsonObject {
                    requestId?.let { put("requestId", it) }
                    put("zcode_type", Relay.PAYLOAD_PLATFORM_RESPONSE)
                    payload["method"]?.let { put("method", it) }
                    put("success", false)
                    put("error", "not supported by host")
                })
            Relay.PAYLOAD_MOBILE_VIEW_STATE_UPDATE, Relay.PAYLOAD_MOBILE_DIAGNOSTIC -> Unit // 遥测忽略
            else -> Unit
        }
        return false
    }

    fun handleEventListen(bridgeSessionId: String, listenerId: Long, channel: String?, event: String?) {
        subscriptions[listenerId] = EventSubscription(bridgeSessionId, channel, event)
    }

    fun handleEventDispose(listenerId: Long) {
        subscriptions.remove(listenerId)
    }

    fun subscriptionsFor(bridgeSessionId: String): List<Map.Entry<Long, EventSubscription>> =
        subscriptions.entries.filter { it.value.bridgeSessionId == bridgeSessionId }

    fun bridge(id: String): Bridge? = bridges[id]

    fun workspaceKeyOf(bridgeSessionId: String): String? = bridges[bridgeSessionId]?.workspaceKey

    fun clearBridge(bridgeSessionId: String) {
        bridges.remove(bridgeSessionId)
        subscriptions.entries.removeIf { it.value.bridgeSessionId == bridgeSessionId }
    }

    private fun workspaceArray(): kotlinx.serialization.json.JsonArray {
        // bootstrap/workspace-list 的 workspace 行官方形状（HAR 定案）：
        // {kind, label, workspacePath, workspacePurpose}——多余键有 zod strict 丢弃风险
        val items = workspacesProvider().map { w ->
            buildJsonObject {
                put("kind", w.kind)
                put("label", w.label)
                put("workspacePath", w.path)
                put("workspacePurpose", "project")
            }
        }
        return kotlinx.serialization.json.JsonArray(items)
    }
}
