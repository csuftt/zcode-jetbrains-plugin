package com.zcode.ideaplugin.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/**
 * 出站 v4 帧消毒（缺陷FV 四轮定案，2026-11-05）：
 *
 * 本机 CLI 的 Bash 工具行会携带 `output.display={kind:"bash_output",...}`——手机 H5
 * （zcode.z.ai/remote/v4 最新 bundle）的 output.display 判别联合（ol）只认
 * {file_diff, local_agent_message, task_stop, task_output, respond_to_coordinator,
 * cua, mcp_tool}，行级 display 联合（ll）只认 {node_repl_images, task_output,
 * respond_to_coordinator, mcp_tool}。未知 kind 使 zod 判别失败 → **整个快照帧
 * InvalidPayload**（单行毒化 232KB 全帧）→ 装配器吐 fault → store 判恢复升级、
 * forceSnapshot 已在飞 → `fault.subscription.recoveryFailed`，会话页死。
 * 健康会话恰好无此 kind 行，掩盖成「只有某个会话打不开」。
 *
 * 消毒策略：白名单外的 display 对象整只剥除（output.text 等正文保留，H5 渲染退化为
 * 纯文本不丢行）。快照 rows、deltas 的 row.appended/row.upserted、rowsRange 结果行
 * 三个入口共用 [sanitizeRow]。无违例帧原对象透传（热路径零拷贝）。
 *
 * kind 提取一律 `as? JsonPrimitive` 安全转型，**不用 jsonPrimitive 扩展**——后者对
 * 对象/数组形状抛 IllegalArgumentException，会被调用侧 runCatching 放大成整帧静默
 * 丢弃（0.4.3 审查：把「单行毒化」换成「整帧丢失」，同症状家族）。
 */
object V4FrameSanitizer {

    /** H5 output.display 联合（ol）实成员（2026-11-05 逆向 bundle 实锤） */
    private val OUTPUT_DISPLAY_KINDS = setOf(
        "file_diff", "local_agent_message", "task_stop", "task_output",
        "respond_to_coordinator", "cua", "mcp_tool",
    )

    /** H5 行级 display 联合（ll）实成员（同上） */
    private val ROW_DISPLAY_KINDS = setOf(
        "node_repl_images", "task_output", "respond_to_coordinator", "mcp_tool",
    )

    /**
     * 泵出站帧消毒：入参为 v4/conversation/frame 外层通知对象
     * {topic, wireVersion, kind, frame:{payload:{kind:snapshot|deltas,...}}}，
     * 返回消毒后的帧（无违例时原对象返回）。
     */
    fun sanitizeOutbound(frame: JsonObject): JsonObject {
        val inner = frame["frame"] as? JsonObject ?: return frame
        val payload = inner["payload"] as? JsonObject ?: return frame
        val changed = when ((payload["kind"] as? JsonPrimitive)?.content) {
            "snapshot" -> {
                val snapshot = payload["snapshot"] as? JsonObject ?: return frame
                val rows = snapshot["rows"] as? JsonObject ?: return frame
                val window = rows["window"] as? JsonArray ?: return frame
                val cleaned = sanitizeRows(window)
                if (cleaned === window) return frame
                val newSnapshot = JsonObject(snapshot.toMutableMap().apply { put("rows", JsonObject(rows.toMutableMap().apply { put("window", cleaned) })) })
                val newPayload = JsonObject(payload.toMutableMap().apply { put("snapshot", newSnapshot) })
                val newInner = JsonObject(inner.toMutableMap().apply { put("payload", newPayload) })
                JsonObject(frame.toMutableMap().apply { put("frame", newInner) })
            }
            "deltas" -> {
                val deltas = payload["deltas"] as? JsonArray ?: return frame
                var touched = false
                val newDeltas = JsonArray(deltas.map { op ->
                    val opObj = op as? JsonObject ?: return@map op
                    val row = opObj["row"] as? JsonObject ?: return@map op
                    val cleanedRow = sanitizeRow(row)
                    if (cleanedRow === row) op
                    else {
                        touched = true
                        JsonObject(opObj.toMutableMap().apply { put("row", cleanedRow) })
                    }
                })
                if (!touched) return frame
                val newPayload = JsonObject(payload.toMutableMap().apply { put("deltas", newDeltas) })
                val newInner = JsonObject(inner.toMutableMap().apply { put("payload", newPayload) })
                JsonObject(frame.toMutableMap().apply { put("frame", newInner) })
            }
            else -> return frame
        }
        return changed
    }

    /** rowsRange 结果行消毒（H5 对分页行同走 El 行联合校验） */
    fun sanitizeRows(rows: JsonArray): JsonArray {
        var touched = false
        val out = JsonArray(rows.map { el ->
            val row = el as? JsonObject ?: return@map el
            val cleaned = sanitizeRow(row)
            if (cleaned !== row) touched = true
            cleaned
        })
        return if (touched) out else rows
    }

    /** 单行消毒：toolCall 行的 output.display / 行级 display 白名单外剥除 */
    fun sanitizeRow(row: JsonObject): JsonObject {
        if ((row["kind"] as? JsonPrimitive)?.content != "toolCall") return row
        var current = row
        val output = current["output"] as? JsonObject
        if (output != null) {
            val display = output["display"] as? JsonObject
            if (display != null && (display["kind"] as? JsonPrimitive)?.content !in OUTPUT_DISPLAY_KINDS) {
                val newOutput = JsonObject(output.toMutableMap().apply { remove("display") })
                current = JsonObject(current.toMutableMap().apply { put("output", newOutput) })
            }
        }
        val display = current["display"] as? JsonObject
        if (display != null && (display["kind"] as? JsonPrimitive)?.content !in ROW_DISPLAY_KINDS) {
            current = JsonObject(current.toMutableMap().apply { remove("display") })
        }
        return current
    }
}
