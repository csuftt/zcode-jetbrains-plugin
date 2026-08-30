package com.zcode.ideaplugin.protocol.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Session 相关模型
 *
 * 对应 ZCode Protocol 的 session 方法族。
 * 字段定义参考 0.16.1 实测 + zcode-open-bridge 规格书。
 */

@Serializable
data class Workspace(
    val workspacePath: String,
    val workspaceKey: String = workspacePath  // 本地场景 key = path
)

@Serializable
data class SessionInfo(
    val sessionId: String,
    val title: String = "",
    val status: String = "idle",  // idle / running / busy
    val mode: String = "build",   // build / edit / plan / yolo
    val sessionKind: String = "interactive",
    val workspace: Workspace? = null,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    val traceId: String? = null,
    val titleSource: String? = null,
    /** 归档标记时间戳（毫秒，ZCode 客户端任务索引 tasks.updated_at）；null = 未归档 */
    val archivedAt: Long? = null
)

/** session/create 的响应 */
@Serializable
data class CreateSessionResult(
    val session: SessionInfo,
    val protocol: ProtocolVersion? = null
)

@Serializable
data class ProtocolVersion(
    val name: String = "ZCode Protocol",
    val version: Int = 1
)

/** 运行时偏好应答（规格书 §3：必须答这三个 boolean，否则永久卡死） */
@Serializable
data class RuntimePreferences(
    val nativeSearchEnhancementsEnabled: Boolean = false,
    val memoryEnabled: Boolean = false,
    val askUserQuestionAutoResolutionEnabled: Boolean = false
) {
    companion object {
        /** 安全默认值（全 false） */
        val SAFE_DEFAULT = RuntimePreferences()
    }
}

/**
 * session/send 的图片附件（ZCode Protocol 通道原生形态，2026-08-26 zcode.cjs 源码确认）：
 * base64 内联直传，服务端负责缩放（最长边 2000px）/压缩/落盘 image-cache，
 * 模型不支持图片时降级为 [Attached media] 文字占位（不报错）。
 * dataBase64 与 localPath 二选一（都填时 localPath 优先）；插件只走 dataBase64。
 */
@Serializable
data class AttachmentInput(
    val kind: String = "image",
    val filename: String,
    val mimeType: String,
    val sizeBytes: Long? = null,
    val dataBase64: String? = null,
    val localPath: String? = null
)

/**
 * 事件类型（规格书 §4：type 在 params 顶层）
 *
 * payload 结构按 type 不同：
 * - turn.started:    {turnNumber, input, messageId}
 * - model.streaming: {kind: "text_delta"|"reasoning_delta", delta, assistantMessageId}
 * - tool.updated:    {kind: "scheduled"|"started"|"progress"|"result"|"error"|"batch", ...}
 * - session.updated: {model, modelRef, iteration, type}
 * - turn.completed:  {response, usage:{inputTokens, outputTokens, totalTokens, ...}}
 * - turn.failed:     {error:{type, code, message, detail, stack}, turnPhase}  ← 终止帧，无 resultType
 * - session.titleUpdated: {title, source, previousTitle}
 */
object EventTypes {
    const val TURN_STARTED = "turn.started"
    const val MODEL_STREAMING = "model.streaming"
    const val TOOL_UPDATED = "tool.updated"
    const val SESSION_UPDATED = "session.updated"
    const val TURN_COMPLETED = "turn.completed"
    const val TURN_FAILED = "turn.failed"  // 终止帧
    const val SESSION_TITLE_UPDATED = "session.titleUpdated"
}

/** model.streaming 的 kind 值 */
object StreamingKind {
    const val TEXT_DELTA = "text_delta"
    const val REASONING_DELTA = "reasoning_delta"
}

/** 一个事件通知 */
data class SessionEvent(
    val type: String,
    val seq: Long,
    val sessionId: String,
    val timestamp: Long,
    val traceId: String?,
    val turnId: String?,
    val deliveryKind: String?,
    val payload: JsonObject
) {
    companion object {
        fun fromNotification(params: JsonObject): SessionEvent {
            return SessionEvent(
                type = params["type"]?.let { it.toString().trim('"') } ?: "unknown",
                seq = params["seq"]?.toString()?.toLongOrNull() ?: 0,
                sessionId = params["sessionId"]?.toString()?.trim('"') ?: "",
                timestamp = params["timestamp"]?.toString()?.toLongOrNull() ?: 0,
                traceId = params["traceId"]?.toString()?.trim('"'),
                turnId = params["turnId"]?.toString()?.trim('"'),
                deliveryKind = params["deliveryKind"]?.toString()?.trim('"'),
                payload = params["payload"] as? JsonObject ?: JsonObject(emptyMap())
            )
        }
    }
}

/** Token 用量（turn.completed 里） */
@Serializable
data class TokenUsage(
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val totalTokens: Long = 0,
    val cacheReadTokens: Long = 0,
    val cacheWriteTokens: Long = 0,
    val modelRequestCount: Int = 0
)

/** 权限模式 */
enum class PermissionMode(val value: String) {
    BUILD("build"),
    EDIT("edit"),
    PLAN("plan"),
    YOLO("yolo");  // headless 推荐用 yolo

    companion object {
        fun fromValue(v: String?) = entries.firstOrNull { it.value == v }
    }
}
