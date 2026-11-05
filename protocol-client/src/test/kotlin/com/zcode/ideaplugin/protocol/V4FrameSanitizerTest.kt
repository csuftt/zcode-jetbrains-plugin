package com.zcode.ideaplugin.protocol

import kotlinx.serialization.json.*
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * 出站 v4 帧消毒（缺陷FV 四轮，2026-11-05 三轮 HAR + H5 bundle Node 重放实锤）：
 *
 * 本机 CLI 的 Bash 工具行携带 output.display={kind:"bash_output"}，手机 H5 的
 * output.display 判别联合只认 {file_diff,local_agent_message,task_stop,task_output,
 * respond_to_coordinator,cua,mcp_tool}——zod 单行毒化整个 232KB 快照帧（No matching
 * discriminator @ rows.window[0].output.display.kind），initial/recovery 双双被弃 →
 * fault.subscription.recoveryFailed，会话页死。健康会话无此行，掩盖成单会话打不开。
 *
 * 回归锁：bash_output 行（真实毒化形状）被剥 display；白名单内 display 原样保留；
 * 无违例帧原对象透传（热路径零拷贝）；deltas row.appended 同治；rowsRange 行数组同治。
 */
class V4FrameSanitizerTest {

    private val bashRow = buildJsonObject {
        put("rowId", 24)
        put("turnId", "turn_a")
        put("kind", "toolCall")
        put("toolName", "Bash")
        put("status", "success")
        put("output", buildJsonObject {
            put("text", "命令输出正文")
            // 真实毒化形状（三轮 HAR row0）：CLI 新枚举，H5 联合无此成员
            put("display", buildJsonObject {
                put("kind", "bash_output")
                put("output", "- 很长的命令输出摘要…")
            })
        })
    }

    private fun fileDiffRow(rowId: Int) = buildJsonObject {
        put("rowId", rowId)
        put("turnId", "turn_a")
        put("kind", "toolCall")
        put("toolName", "Edit")
        put("output", buildJsonObject {
            put("text", "diff 正文")
            put("display", buildJsonObject {
                put("kind", "file_diff")
                put("filePath", "a.md")
                put("additions", 1)
                put("deletions", 0)
                put("structuredPatch", buildJsonArray { })
            })
        })
    }

    private fun snapshotFrame(vararg rows: JsonObject) = buildJsonObject {
        put("topic", "conversation/sess_x")
        put("wireVersion", 3)
        put("kind", "complete")
        put("deliveryKind", "initial")
        put("frame", buildJsonObject {
            put("topic", "conversation/sess_x")
            put("subscriptionId", "sub-1")
            put("sentAt", 1L)
            put("fromSeq", 0L)
            put("toSeq", 1L)
            put("payload", buildJsonObject {
                put("kind", "snapshot")
                put("snapshot", buildJsonObject {
                    put("sessionId", "sess_x")
                    put("rows", buildJsonObject {
                        put("window", buildJsonArray { rows.forEach { add(it) } })
                        put("totalCount", rows.size)
                        put("firstRowId", 1)
                    })
                })
            })
        })
    }

    @Test
    fun `bash_output 行被剥 display 正文保留`() {
        val frame = snapshotFrame(bashRow, fileDiffRow(25))
        val out = V4FrameSanitizer.sanitizeOutbound(frame)
        assertFalse(out === frame, "含毒帧应重建副本")
        val rows = out["frame"]!!.jsonObject["payload"]!!.jsonObject["snapshot"]!!.jsonObject["rows"]!!.jsonObject["window"]!!.jsonArray
        val bash = rows[0].jsonObject
        val output = bash["output"]!!.jsonObject
        assertNull(output["display"], "bash_output display 应被剥除")
        assertEquals("命令输出正文", output["text"]!!.jsonPrimitive.content, "output.text 正文必须保留")
        assertEquals("Bash", bash["toolName"]!!.jsonPrimitive.content)
        // 白名单内 display 原样保留
        val diff = rows[1].jsonObject["output"]!!.jsonObject["display"]!!.jsonObject
        assertEquals("file_diff", diff["kind"]!!.jsonPrimitive.content)
    }

    @Test
    fun `无违例帧原对象透传`() {
        val frame = snapshotFrame(fileDiffRow(1), buildJsonObject {
            put("rowId", 2); put("turnId", "t"); put("kind", "assistantText"); put("text", "hi")
        })
        assertSame(frame, V4FrameSanitizer.sanitizeOutbound(frame), "干净帧应零拷贝透传")
    }

    @Test
    fun `行级 display 与 output display 分别按各自白名单消毒`() {
        val row = buildJsonObject {
            put("rowId", 1); put("turnId", "t"); put("kind", "toolCall"); put("toolName", "X")
            put("display", buildJsonObject { put("kind", "node_repl_images"); put("images", buildJsonArray { }) })
            put("output", buildJsonObject {
                put("text", "t")
                put("display", buildJsonObject { put("kind", "future_unknown_kind") })
            })
        }
        val out = V4FrameSanitizer.sanitizeOutbound(snapshotFrame(row))
        val cleaned = out["frame"]!!.jsonObject["payload"]!!.jsonObject["snapshot"]!!.jsonObject["rows"]!!.jsonObject["window"]!!.jsonArray[0].jsonObject
        assertEquals("node_repl_images", cleaned["display"]!!.jsonObject["kind"]!!.jsonPrimitive.content, "行级白名单内保留")
        assertNull(cleaned["output"]!!.jsonObject["display"], "output 侧未知 kind 剥除")
    }

    @Test
    fun `deltas row appended 同治`() {
        val frame = buildJsonObject {
            put("topic", "conversation/sess_x")
            put("frame", buildJsonObject {
                put("payload", buildJsonObject {
                    put("kind", "deltas")
                    put("deltas", buildJsonArray {
                        add(buildJsonObject {
                            put("op", "row.appended")
                            put("row", buildJsonObject {
                                put("rowId", 9); put("turnId", "t"); put("kind", "toolCall")
                                put("output", buildJsonObject {
                                    put("text", "x")
                                    put("display", buildJsonObject { put("kind", "bash_output"); put("output", "o") })
                                })
                            })
                        })
                    })
                })
            })
        }
        val out = V4FrameSanitizer.sanitizeOutbound(frame)
        val row = out["frame"]!!.jsonObject["payload"]!!.jsonObject["deltas"]!!.jsonArray[0].jsonObject["row"]!!.jsonObject
        assertNull(row["output"]!!.jsonObject["display"])
    }

    @Test
    fun `rowsRange 行数组消毒且干净数组零拷贝`() {
        val dirty = buildJsonArray { add(bashRow); add(fileDiffRow(2)) }
        val out = V4FrameSanitizer.sanitizeRows(dirty)
        assertTrue(out !== dirty)
        assertNull(out[0].jsonObject["output"]!!.jsonObject["display"])
        val clean = buildJsonArray { add(fileDiffRow(1)) }
        assertSame(clean, V4FrameSanitizer.sanitizeRows(clean), "干净数组应零拷贝")
    }
}
