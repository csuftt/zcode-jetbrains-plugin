package com.zcode.ideaplugin.protocol

import kotlinx.serialization.json.*
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * V4FrameMapper 回归测试 —— 输入用 2026-08-31 真实抓包帧结构
 * （scripts/diag-v4-subagent-frames.py，子代理读文件任务的 v4/conversation/frame dump）：
 *
 * 覆盖映射表全分支：
 * - turnHeader running/completedSuccess/异常终态 → turn.started/completed/failed
 * - assistantText/reasoning 行 row.delta(path=text) → text_delta/reasoning_delta
 * - 未登记 rowId 的 delta（中途订阅）丢弃
 * - toolCall inputStreaming 增长 → tool_input_start + tool_input_delta（diff 增量）
 * - toolCall running(带 input 对象) → tool.updated kind:started
 * - toolCall success(output.text) → tool.updated kind:result
 * - snapshot 帧 / state.updated / userInput 不产事件
 */
class V4FrameMapperTest {

    private val mapper = V4FrameMapper()
    private val sid = "sess_subagent_agent_test"

    /** 构造一帧 deltas（frame 外壳按抓包形状：sentAt/toSeq/fromSeq） */
    private fun frame(vararg deltas: JsonObject, toSeq: Long = 10): JsonObject = buildJsonObject {
        put("topic", "conversation/$sid")
        put("subscriptionId", "sub-test-1")
        put("sentAt", 1788148526100L)
        put("fromSeq", toSeq - deltas.size)
        put("toSeq", toSeq)
        put("payload", buildJsonObject {
            put("kind", "deltas")
            put("deltas", JsonArray(deltas.toList()))
        })
    }

    private fun appended(row: JsonObject) = buildJsonObject { put("op", "row.appended"); put("row", row) }
    private fun upserted(row: JsonObject) = buildJsonObject { put("op", "row.upserted"); put("row", row) }
    private fun rowDelta(rowId: Int, append: String) = buildJsonObject {
        put("op", "row.delta"); put("rowId", rowId); put("path", "text"); put("append", append)
    }

    private fun turnHeader(rowId: Int, state: String, turnId: String = "msg_turn_1") = buildJsonObject {
        put("rowId", rowId); put("kind", "turnHeader"); put("turnId", turnId)
        put("entityId", turnId); put("state", state)
        put("startedAt", 1788148526000L)
    }

    private fun toolCallRow(rowId: Int, status: String, inputText: String?, turnId: String = "msg_turn_1") = buildJsonObject {
        put("rowId", rowId); put("kind", "toolCall"); put("turnId", turnId)
        put("toolCallId", "call_test_1"); put("toolName", "Read"); put("status", status)
        inputText?.let { put("inputText", it) }
    }

    @Test
    fun `回合生命周期与文本流映射`() {
        // 帧1：回合开始 + 正文行建立
        val f1 = mapper.mapFrame(sid, frame(
            appended(turnHeader(1, "running")),
            appended(buildJsonObject {
                put("rowId", 2); put("kind", "assistantText"); put("turnId", "msg_turn_1"); put("text", "")
            }),
        ))
        assertEquals(1, f1.size, "turnHeader(running) 产 turn.started，assistantText 行建立不产事件")
        assertEquals("turn.started", f1[0].type)
        assertEquals("msg_turn_1", f1[0].payload["messageId"]?.jsonPrimitive?.content)
        assertEquals(sid, f1[0].sessionId)

        // 帧2：正文流式追加
        val f2 = mapper.mapFrame(sid, frame(rowDelta(2, "你好"), rowDelta(2, "，世界")))
        assertEquals(2, f2.size)
        assertEquals("model.streaming", f2[0].type)
        assertEquals("text_delta", f2[0].payload["kind"]?.jsonPrimitive?.content)
        assertEquals("你好", f2[0].payload["delta"]?.jsonPrimitive?.content)
        assertEquals("，世界", f2[1].payload["delta"]?.jsonPrimitive?.content)

        // 帧3：思考行 + 思考流（reasoning 行的 path 也是 text）
        val f3 = mapper.mapFrame(sid, frame(
            appended(buildJsonObject {
                put("rowId", 3); put("kind", "reasoning"); put("turnId", "msg_turn_1"); put("text", "")
            }),
            rowDelta(3, "思考中"),
        ))
        assertEquals(1, f3.size)
        assertEquals("reasoning_delta", f3[0].payload["kind"]?.jsonPrimitive?.content)

        // 帧4：回合成功收尾
        val f4 = mapper.mapFrame(sid, frame(upserted(turnHeader(1, "completedSuccess"))))
        assertEquals(1, f4.size)
        assertEquals("turn.completed", f4[0].type)
    }

    @Test
    fun `异常终态映射 turn_failed 带错误详情`() {
        mapper.mapFrame(sid, frame(appended(turnHeader(1, "running"))))
        val out = mapper.mapFrame(sid, frame(upserted(turnHeader(1, "completedError"))))
        assertEquals(1, out.size)
        assertEquals("turn.failed", out[0].type)
        val errMsg = out[0].payload["error"]?.jsonObject?.get("message")?.jsonPrimitive?.content ?: ""
        assertTrue(errMsg.contains("completedError"), "错误信息应携带原始终态: $errMsg")
    }

    @Test
    fun `未登记行的 delta 丢弃（中途订阅快照兜底）`() {
        val out = mapper.mapFrame(sid, frame(rowDelta(99, "未知行")))
        assertTrue(out.isEmpty(), "未见 row.appended 的 rowId 不映射，防半截回合误归约")
    }

    @Test
    fun `工具行输入流与执行收尾全链映射`() {
        // inputStreaming 首个非空输入 → tool_input_start（帧内无 turnHeader → 前置合成
        // turn.started，迟到订阅自愈）
        val f1 = mapper.mapFrame(sid, frame(appended(toolCallRow(5, "inputStreaming", "{\"file_path\""))))
        assertEquals(2, f1.size)
        assertEquals("turn.started", f1[0].type)
        assertEquals("tool_input_start", f1[1].payload["kind"]?.jsonPrimitive?.content)
        assertEquals("Read", f1[1].payload["toolName"]?.jsonPrimitive?.content)

        // inputText 增长（整行 upsert 累积）→ tool_input_delta 增量 = 差值
        val f2 = mapper.mapFrame(sid, frame(upserted(toolCallRow(5, "inputStreaming", "{\"file_path\":\"a.txt\""))))
        assertEquals(1, f2.size)
        assertEquals("tool_input_delta", f2[0].payload["kind"]?.jsonPrimitive?.content)
        assertEquals(":" + "\"a.txt\"", f2[0].payload["delta"]?.jsonPrimitive?.content) // diff 增量 = 累积差值

        // running（input 对象已解析）→ tool.updated kind:started
        val f3 = mapper.mapFrame(sid, frame(upserted(buildJsonObject {
            put("rowId", 5); put("kind", "toolCall"); put("toolCallId", "call_test_1")
            put("toolName", "Read"); put("status", "running")
            put("input", buildJsonObject { put("file_path", "a.txt") })
            put("startedAt", 1788148554063L)
        })))
        assertEquals(1, f3.size)
        assertEquals("tool.updated", f3[0].type)
        assertEquals("started", f3[0].payload["kind"]?.jsonPrimitive?.content)
        assertEquals("a.txt", f3[0].payload["input"]?.jsonObject?.get("file_path")?.jsonPrimitive?.content)

        // success（output.text）→ tool.updated kind:result
        val f4 = mapper.mapFrame(sid, frame(upserted(buildJsonObject {
            put("rowId", 5); put("kind", "toolCall"); put("toolCallId", "call_test_1")
            put("toolName", "Read"); put("status", "success")
            put("output", buildJsonObject { put("text", "文件内容") })
        })))
        assertEquals(1, f4.size)
        assertEquals("result", f4[0].payload["kind"]?.jsonPrimitive?.content)
        assertEquals(true, f4[0].payload["result"]?.jsonObject?.get("success")?.jsonPrimitive?.booleanOrNull)
        assertEquals("文件内容", f4[0].payload["result"]?.jsonObject?.get("content")?.jsonPrimitive?.content)
    }

    @Test
    fun `空输入流与重复 start 幂等`() {
        // 首帧 inputText 为空：不产事件（等非空再 start）
        val f1 = mapper.mapFrame(sid, frame(appended(toolCallRow(5, "inputStreaming", ""))))
        assertTrue(f1.isEmpty())
        // 非空后重复同长度 upsert：无增量不产事件
        mapper.mapFrame(sid, frame(upserted(toolCallRow(5, "inputStreaming", "{\"a\":1"))))
        val f3 = mapper.mapFrame(sid, frame(upserted(toolCallRow(5, "inputStreaming", "{\"a\":1"))))
        assertTrue(f3.isEmpty())
    }

    @Test
    fun `snapshot 帧与无关 op 不产事件`() {
        // 无 rows 的 snapshot（异常/防御形状）不产事件
        val snap = buildJsonObject {
            put("topic", "conversation/$sid")
            put("sentAt", 1788148526100L)
            put("payload", buildJsonObject {
                put("kind", "snapshot")
                put("snapshot", buildJsonObject { put("sessionId", sid) })
            })
        }
        assertTrue(mapper.mapFrame(sid, snap).isEmpty(), "无 rows 的 snapshot 不映射")

        val noise = mapper.mapFrame(sid, frame(
            buildJsonObject { put("op", "state.updated"); put("patch", buildJsonObject { put("revision", 1) }) },
            appended(buildJsonObject { put("rowId", 10); put("kind", "timelineMarker") }),
        ))
        assertTrue(noise.isEmpty(), "state.updated/timelineMarker 不映射")
    }

    // ============ snapshot 快照回放（订阅 initial / online 重同步）============

    /** 构造一帧 snapshot（外壳按 2026-08-31 diag-v4-snapshot-rows.py 抓包形状） */
    private fun snapshotFrame(vararg rows: JsonObject, toSeq: Long = 20): JsonObject = buildJsonObject {
        put("topic", "conversation/$sid")
        put("subscriptionId", "sub-test-1")
        put("sentAt", 1788148526100L)
        put("fromSeq", 0)
        put("toSeq", toSeq)
        put("payload", buildJsonObject {
            put("kind", "snapshot")
            put("snapshot", buildJsonObject {
                put("rows", buildJsonObject { put("window", JsonArray(rows.toList())) })
            })
        })
    }

    @Test
    fun `snapshot 回放 prompt 与已完成内容（running 场景）`() {
        val out = mapper.mapFrame(sid, snapshotFrame(
            turnHeader(1, "running"),
            buildJsonObject { put("rowId", 2); put("kind", "userInput"); put("turnId", "msg_turn_1"); put("entityId", "msg_turn_1"); put("text", "搜索今日热点新闻") },
            buildJsonObject { put("rowId", 3); put("kind", "reasoning"); put("turnId", "msg_turn_1"); put("text", "先搜索再汇总"); put("state", "complete") },
            buildJsonObject {
                put("rowId", 4); put("kind", "toolCall"); put("turnId", "msg_turn_1")
                put("toolCallId", "call_s1"); put("toolName", "WebSearch"); put("status", "success")
                put("inputText", """{"query":"news"}"""); put("input", buildJsonObject { put("query", "news") })
                put("startedAt", 1788148527000L); put("endedAt", 1788148530000L)
                put("output", buildJsonObject { put("text", "结果列表") })
            },
            buildJsonObject { put("rowId", 5); put("kind", "assistantText"); put("turnId", "msg_turn_1"); put("text", "今日要闻如下"); put("state", "complete") },
        ))
        // 顺序硬约束：reset → user 消息先于 turn.started（live 消息序 = [user, assistant]）
        val types = out.map { it.type to (it.payload["kind"]?.jsonPrimitive?.content ?: "") }
        assertEquals(
            listOf(
                "stream.snapshotReset" to "",
                "turn.userInput" to "",
                "turn.started" to "",
                "model.streaming" to "reasoning_delta",
                "tool.updated" to "started",
                "tool.updated" to "result",
                "model.streaming" to "text_delta",
            ),
            types,
        )
        assertEquals("搜索今日热点新闻", out[1].payload["text"]?.jsonPrimitive?.content)
        assertEquals("msg_turn_1", out[1].payload["messageId"]?.jsonPrimitive?.content)
        assertEquals("msg_turn_1", out[2].payload["messageId"]?.jsonPrimitive?.content, "turn.started 用 turnHeader entityId")
        assertEquals("先搜索再汇总", out[3].payload["delta"]?.jsonPrimitive?.content)
        assertEquals("snapshot", out[3].deliveryKind, "快照回放文本标记 deliveryKind=snapshot（前端跳过切片）")
        assertTrue(out.none { it.type == "turn.completed" || it.type == "turn.failed" }, "running 快照不带终态")
    }

    @Test
    fun `snapshot 多 turn 续跑只发最后一个 turn 的终态`() {
        // 复现 2026-08-31 用户实测"会话没完成被判失败"：子代理 turn1 失败后重试，
        // 快照里 turn1=failed + turn2=running——历史 turn1 终态若被回放，前端会把
        // 进行中的活动误收尾（且被防降级锁死）
        val out = mapper.mapFrame(sid, snapshotFrame(
            turnHeader(1, "failed"),
            buildJsonObject { put("rowId", 2); put("kind", "userInput"); put("turnId", "msg_turn_1"); put("text", "第一次尝试") },
            buildJsonObject { put("rowId", 5); put("kind", "assistantText"); put("turnId", "msg_turn_1"); put("text", "失败前的输出") },
            turnHeader(6, "running", "msg_turn_2"),
            buildJsonObject { put("rowId", 7); put("kind", "userInput"); put("turnId", "msg_turn_2"); put("text", "重试") },
            buildJsonObject { put("rowId", 8); put("kind", "toolCall"); put("turnId", "msg_turn_2"); put("toolCallId", "call_r1"); put("toolName", "WebSearch"); put("status", "running") },
        ))
        // 无任何终态事件（turn1 failed 被跳过、turn2 running 未结束）
        assertTrue(out.none { it.type == "turn.completed" || it.type == "turn.failed" },
            "历史 turn 终态不回放: " + out.map { it.type })
        // 两个 turn 的 started 都在（live 消息序 = [user1, assistant1, user2, assistant2]）
        assertEquals(2, out.count { it.type == "turn.started" })
        assertEquals(2, out.count { it.type == "turn.userInput" })
        // turn 上下文保持 active（turn2 running——后续增量不触发自愈合成）
        val follow = mapper.mapFrame(sid, frame(appended(toolCallRow(9, "inputStreaming", "{\"q\"", "msg_turn_2"))))
        assertEquals(0, follow.count { it.type == "turn.started" }, "上下文在场不合成")
        assertEquals(1, follow.count { it.payload["kind"]?.jsonPrimitive?.content == "tool_input_start" })
    }

    @Test
    fun `snapshot 回放终态快照（结束后订阅场景）`() {
        val out = mapper.mapFrame(sid, snapshotFrame(
            turnHeader(1, "completedSuccess"),
            buildJsonObject { put("rowId", 2); put("kind", "userInput"); put("turnId", "msg_turn_1"); put("text", "任务") },
            buildJsonObject { put("rowId", 5); put("kind", "assistantText"); put("turnId", "msg_turn_1"); put("text", "结论") },
        ))
        assertEquals(listOf("stream.snapshotReset", "turn.userInput", "turn.started", "turn.completed", "model.streaming"), out.map { it.type })
        assertEquals("text_delta", out.last().payload["kind"]?.jsonPrimitive?.content)
    }

    @Test
    fun `snapshot 截尾窗口无 turnHeader 时内容行兜底合成 started`() {
        val out = mapper.mapFrame(sid, snapshotFrame(
            buildJsonObject { put("rowId", 2); put("kind", "userInput"); put("turnId", "msg_t9"); put("text", "任务") },
            buildJsonObject { put("rowId", 3); put("kind", "assistantText"); put("turnId", "msg_t9"); put("text", "正文") },
        ))
        assertEquals(listOf("stream.snapshotReset", "turn.userInput", "turn.started", "model.streaming"), out.map { it.type })
        assertTrue(out[2].payload["messageId"]?.jsonPrimitive?.content!!.startsWith("v4-snap-"), "兜底合成 messageId")
    }

    @Test
    fun `snapshot 行表重建后增量帧继续归约`() {
        mapper.mapFrame(sid, snapshotFrame(
            turnHeader(1, "running"),
            buildJsonObject {
                put("rowId", 4); put("kind", "toolCall"); put("turnId", "msg_turn_1")
                put("toolCallId", "call_s1"); put("toolName", "WebSearch"); put("status", "inputStreaming")
                put("inputText", """{"query":"ne""")
            },
        ))
        // 后续 deltas 帧同 rowId 的 inputText 增长：基线已设（订阅前输入流视为完成），只 diff 增量
        val d1 = mapper.mapFrame(sid, frame(upserted(buildJsonObject {
            put("rowId", 4); put("kind", "toolCall"); put("turnId", "msg_turn_1")
            put("toolCallId", "call_s1"); put("toolName", "WebSearch"); put("status", "inputStreaming")
            put("inputText", """{"query":"news"}""")
        })))
        assertEquals(listOf("model.streaming"), d1.map { it.type })
        assertEquals("tool_input_delta", d1[0].payload["kind"]?.jsonPrimitive?.content)
        assertEquals("ws\"}", d1[0].payload["delta"]?.jsonPrimitive?.content, "增量 = 累积差值（基线 12 字符 → 16 字符）")

        // 快照登记的文本行：后续 row.delta 正常映射（此前行表未登记会丢弃）
        mapper.mapFrame(sid, snapshotFrame(
            turnHeader(1, "running"),
            buildJsonObject { put("rowId", 7); put("kind", "assistantText"); put("turnId", "msg_turn_1"); put("text", "") },
        ))
        val d2 = mapper.mapFrame(sid, frame(rowDelta(7, "续写")))
        assertEquals(listOf("model.streaming"), d2.map { it.type })
        assertEquals("续写", d2[0].payload["delta"]?.jsonPrimitive?.content)
    }

    @Test
    fun `cleanup 清行表后 delta 丢弃`() {
        mapper.mapFrame(sid, frame(appended(turnHeader(1, "running"))))
        mapper.cleanup(sid)
        assertTrue(mapper.mapFrame(sid, frame(rowDelta(2, "x"))).isEmpty())
    }

    @Test
    fun `迟到订阅自愈：无 turnHeader 的内容事件头插合成 turn started`() {
        // 复现 2026-08-31 用户实测：订阅落在回合中途（turnHeader 已过），首事件是
        // tool.updated——前端 streamingMessageId=null 会丢弃一切内容事件
        val f1 = mapper.mapFrame(sid, frame(
            appended(toolCallRow(5, "inputStreaming", "{\"q\"")),
        ))
        assertEquals(2, f1.size, "合成 turn.started + tool_input_start")
        assertEquals("turn.started", f1[0].type)
        assertTrue(f1[0].payload["messageId"]?.jsonPrimitive?.content!!.startsWith("v4-late-"))
        assertEquals("model.streaming", f1[1].type)

        // 后续帧不再合成（上下文已开）
        val f2 = mapper.mapFrame(sid, frame(upserted(toolCallRow(5, "inputStreaming", "{\"query\":\"x\""))))
        assertEquals(1, f2.size)

        // 迟到的纯终态帧不触发合成（无挂载点需求，交权威重拉）
        mapper.cleanup(sid)
        val f3 = mapper.mapFrame(sid, frame(upserted(turnHeader(1, "completedSuccess"))))
        assertEquals(1, f3.size)
        assertEquals("turn.completed", f3[0].type)

        // 终态清上下文后：新内容事件重新合成（下一轮迟到场景）
        val f4 = mapper.mapFrame(sid, frame(appended(toolCallRow(6, "inputStreaming", "{\"q\""))))
        assertEquals(2, f4.size)
    }

    @Test
    fun `多会话行空间隔离`() {
        val other = "sess_other"
        mapper.mapFrame(sid, frame(appended(turnHeader(1, "running"))))
        val out = mapper.mapFrame(other, frame(rowDelta(1, "x")))
        assertTrue(out.isEmpty(), "行表按会话隔离，他会的 rowId 不串扰")
    }

    @Test
    fun `turnHeader 打头的完整序列不重复合成`() {
        val out = mapper.mapFrame(sid, frame(
            appended(turnHeader(1, "running")),
            appended(toolCallRow(5, "inputStreaming", "{\"q\"")),
            upserted(toolCallRow(5, "running", null)),
            rowDelta(3, "x"),
        ))
        assertEquals(1, out.count { it.type == "turn.started" }, "真实 turnHeader 在场时不合成: " + out.map { it.type })
    }

    @Test
    fun `原始 JSON 帧直喂（端到端差异定位）`() {
        val raw = """{"topic":"conversation/x","subscriptionId":"s","sentAt":1788148526100,"fromSeq":0,"toSeq":8,
            "payload":{"kind":"deltas","deltas":[
              {"op":"row.appended","row":{"rowId":1,"kind":"turnHeader","turnId":"t1","entityId":"t1","state":"running"}},
              {"op":"row.appended","row":{"rowId":4,"kind":"toolCall","turnId":"t1","toolCallId":"c1","toolName":"Read","status":"inputStreaming","inputText":"{\"q\""}},
              {"op":"row.delta","rowId":5,"path":"text","append":"x"}
            ]}}"""
        val frame = kotlinx.serialization.json.Json.parseToJsonElement(raw).jsonObject
        val out = mapper.mapFrame("sess_x", frame)
        println("RAW-OUT: " + out.map { it.type + "/" + it.payload["messageId"] })
        assertEquals(1, out.count { it.type == "turn.started" })
    }
}
