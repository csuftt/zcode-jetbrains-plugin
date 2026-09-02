package com.zcode.ideaplugin.protocol

import com.zcode.ideaplugin.protocol.model.SessionEvent
import kotlinx.serialization.json.*

/**
 * v4/conversation/frame 增量帧 → legacy SessionEvent 映射（子会话实时流根治通道）
 *
 * 背景（2026-08-30 定案）：legacy session/subscribe(child) 恒返回成功但 0 事件投递，
 * 子会话事件流的唯一活通道是 v4/conversation/subscribe（topic=conversation/<sid>，
 * clientMode=desktop-continuous）。订阅后增量帧到达 v4/conversation/frame 通知：
 * params = {wireVersion, kind:"complete", deliveryKind:"online", topic, subscriptionId,
 * frame:{topic, subscriptionId, sentAt, fromSeq, toSeq, payload.kind=deltas, deltas 为 op 数组。
 *
 * 行模型（op 结构，2026-08-31 scripts/diag-v4-subagent-frames.py 抓包定案）：
 * - row.appended/upserted kind=turnHeader   state: running → completedSuccess/...
 * - row.appended/upserted kind=assistantText/reasoning   state: streaming → done（text 字段）
 * - row.appended/upserted kind=toolCall     status: inputStreaming → running → success/error
 *   （inputText 工具输入 JSON 文本流、input 解析后对象、output.text 结果文本）
 * - row.delta {rowId, path:"text", append}  行内容流式追加（assistantText 与 reasoning 都走 path=text）
 * - state.updated / userInput / timelineMarker   本映射不需要
 *
 * 映射产出（与 legacy 事件流同形，前端 streamReducer/childLiveMessages 零改动）：
 * - turnHeader(running)               → turn.started {messageId=entityId}
 * - turnHeader(completedSuccess)      → turn.completed；其余终态 → turn.failed {error}
 * - row.delta(rowId∈assistantText)    → model.streaming {kind:text_delta, delta}
 * - row.delta(rowId∈reasoning)        → model.streaming {kind:reasoning_delta, delta}
 * - toolCall(inputStreaming, 首次)     → model.streaming {kind:tool_input_start, toolCallId, toolName}
 * - toolCall(inputStreaming, inputText 增长) → model.streaming {kind:tool_input_delta, toolCallId, delta=增量}
 * - toolCall(running, 带 input 对象)   → tool.updated {kind:started, toolCallId, toolName, input, startedAt}
 * - toolCall(success/error)           → tool.updated {kind:result, toolCallId, result:{success, content}}
 *
 * 已知限制：订阅落在回合中途时，未见 turnHeader 的 row.delta 按行类型未知丢弃
 * （回合结束 turn.completed 触发前端权威重拉自愈）。
 * 集中单一类，0.16.x v4 面演进时只改这里。
 */
class V4FrameMapper {

    /** 行登记信息：rowId → 行类型与流式状态（每会话独立行空间） */
    private class RowInfo(val kind: String, val turnId: String?) {
        /** toolCall 输入流已发 tool_input_start（inputText 从 0 增长的基线） */
        var inputStarted: Boolean = false
        /** 上次见到的 inputText 长度（tool_input_delta 增量 diff 基线） */
        var inputTextLen: Int = 0
    }

    /** sessionId → rowId → RowInfo（会话结束/退订时整表清理） */
    private val sessionRows = java.util.concurrent.ConcurrentHashMap<String, MutableMap<Int, RowInfo>>()

    /**
     * sessionId → 本会话是否已发出（真实或合成）turn 上下文。
     * 迟到订阅自愈（2026-08-31 用户实测确诊）：订阅落在回合中途时 turnHeader(running)
     * 已过，前端归约在 streamingMessageId 为 null 时丢弃一切 delta/tool 事件——
     * 1750 个事件全灭、弹窗只能手动刷新。mapFrame 产出内容事件而本会话从未开过
     * turn 时头插一条合成 turn.started，让前端消息挂载点就位。
     */
    private val sessionTurnActive = java.util.concurrent.ConcurrentHashMap<String, Boolean>()

    /** v4 订阅时到达的 initial snapshot 帧（payload.kind=snapshot）→ 快照回放映射（见 mapSnapshot） */
    fun isSnapshot(framePayload: JsonObject): Boolean =
        framePayload["kind"]?.jsonPrimitive?.jsonStringOrNull == "snapshot"

    /**
     * 一帧 → legacy 事件序列。snapshot 帧（订阅 initial / online 重同步）走快照回放
     * （行表重建 + 全量内容回放），deltas 帧走增量映射。
     *
     * @param sessionId 从 topic 剥出的会话 id（frame.topic = conversation/<sid>）
     * @param frame 完整 frame 对象（取 sentAt 做事件时间戳）
     */
    fun mapFrame(sessionId: String, frame: JsonObject): List<SessionEvent> {
        val payload = frame["payload"]?.jsonObject ?: return emptyList()
        if (isSnapshot(payload)) return mapSnapshot(sessionId, frame, payload)
        val deltas = payload["deltas"]?.jsonArray ?: return emptyList()
        // 时间戳：frame.sentAt（服务端权威）；缺省用本地时钟（老结构防御）
        val ts = frame["sentAt"]?.jsonPrimitive?.longOrNull ?: System.currentTimeMillis()
        val seqBase = frame["toSeq"]?.jsonPrimitive?.longOrNull ?: 0L
        val out = ArrayList<SessionEvent>(deltas.size)
        deltas.forEachIndexed { i, el ->
            val op = el.jsonObject
            mapOp(sessionId, op, ts, seqBase + i)?.let { out.add(it) }
        }
        // 迟到订阅自愈：产出了内容事件但本会话从未开过 turn → 头插合成 turn.started
        //（前端 handleTurnStarted 幂等：命中已有 assistant 消息则复用 streamingMessageId）。
        // 仅内容事件（streaming/tool）触发——纯生命周期帧（迟到收到的 turn.completed）
        // 无需挂载点，交给前端权威重拉；本帧已含真实 turn.started（单帧全流程：回合
        // 头+内容+终态同帧，op 处理已把上下文翻回 false）也不再合成，防空壳消息
        if (sessionTurnActive[sessionId] != true
            && out.none { it.type == "turn.started" }
            && out.any { it.type == "model.streaming" || it.type == "tool.updated" }) {
            val syntheticTurnId = out.firstOrNull { it.turnId != null }?.turnId
            out.add(0, event("turn.started", sessionId, ts, seqBase - 1, syntheticTurnId) {
                put("messageId", "v4-late-${syntheticTurnId ?: sessionId.takeLast(8)}")
            })
            sessionTurnActive[sessionId] = true
        }
        return out
    }

    /**
     * snapshot 帧（订阅 initial / online 重同步）→ 快照回放事件序列。
     *
     * 背景（2026-08-31 scripts/diag-v4-snapshot-rows.py 抓包定案）：v4 订阅（不带
     * base）服务端先推 snapshot 帧，payload.snapshot.rows.window 带行模型当前状态
     * （尾部 60 行窗口）——userInput 行含全量 prompt、assistantText/reasoning 行含
     * 全量 text、toolCall 行含 input+output+终态。此前跳过 → live 缺订阅前全部内容
     * （弹窗开头缺任务提示词的根因），行表也未登记 → 后续这些行的 row.delta 被丢。
     *
     * 行序为 turnHeader → userInput → 内容行；事件顺序必须 user 消息先于 turn.started
     * （live 消息序 = [user, assistant...]）。turnHeader/userInput 先缓冲 pending，
     * 首个内容行到达时原子 flush；截尾窗口丢 turnHeader 时用内容行 turnId 兜底合成。
     *
     * 头部 stream.snapshotReset：前端清空该会话 live 归约状态再重建（重订阅/online
     * 重同步重放 snapshot 时防内容重复追加）。全量文本 delta 标记 deliveryKind=snapshot
     *（前端切片回放据此跳过——快照恢复不是流式，不做打字机）。
     *
     * 终态事件只对**最后一个 turn** 发：子代理多 turn 续跑（前 turn 失败重试/自动
     * 续轮）时快照里历史 turn 的终态行（failed/completedInterrupted…）若被回放，
     * 前端 markActivityOutcome 会把整个活动误收尾且被防降级锁死（2026-08-31 用户
     * 实测"会话没完成被判失败"的根因）。历史 turn 只发 started 挂载点 + 内容回放。
     */
    private fun mapSnapshot(sessionId: String, frame: JsonObject, payload: JsonObject): List<SessionEvent> {
        val snap = payload["snapshot"]?.jsonObject ?: return emptyList()
        val window = snap["rows"]?.jsonObject?.get("window")?.jsonArray ?: return emptyList()
        val ts = frame["sentAt"]?.jsonPrimitive?.longOrNull ?: System.currentTimeMillis()
        var seq = frame["fromSeq"]?.jsonPrimitive?.longOrNull ?: 0L
        val nextSeq = { seq++ }
        // 最后一个 turnHeader 行（行序递增，取最大 rowId 的那个）——只有它的终态才发事件
        var lastTurnHeaderRowId = -1
        for (el in window) {
            val row = el.jsonObject
            if (row["kind"]?.jsonPrimitive?.jsonStringOrNull == "turnHeader") {
                row["rowId"]?.jsonPrimitive?.intOrNull?.let { if (it > lastTurnHeaderRowId) lastTurnHeaderRowId = it }
            }
        }
        val out = ArrayList<SessionEvent>(window.size + 4)
        out.add(event("stream.snapshotReset", sessionId, ts, nextSeq(), null) { })

        // 行表整体重建：snapshot 是权威状态，旧表作废（重同步场景 rowId 空间可能重编）
        rows(sessionId).clear()

        // 当前 turn 的待发事件缓冲与 flush 状态（见方法注释的顺序约束）。
        // flushed=true 只表示"[user?, started, end?] 已发或无 pending"；内容行到达时
        // 若整个快照从未发过 started（截尾窗口丢 turnHeader）须兜底合成——但
        // turnHeader 自带真实 started，其前置收口 flush 禁止兜底（withFallback=false）
        var pendingUser: SessionEvent? = null
        var pendingStart: SessionEvent? = null
        var pendingEnd: SessionEvent? = null
        var flushed = true
        var emittedAnyStart = false
        fun flushTurnStart(fallbackTurnId: String?, withFallback: Boolean = true) {
            if (!flushed) {
                pendingUser?.let { out.add(it) }
                out.add(pendingStart ?: event("turn.started", sessionId, ts, nextSeq(), fallbackTurnId) {
                    put("messageId", "v4-snap-${fallbackTurnId ?: sessionId.takeLast(8)}")
                })
                val end = pendingEnd
                end?.let { out.add(it) }
                sessionTurnActive[sessionId] = end == null
                pendingEnd = null
            } else if (withFallback && (pendingUser != null || !emittedAnyStart)) {
                pendingUser?.let { out.add(it) }
                out.add(event("turn.started", sessionId, ts, nextSeq(), fallbackTurnId) {
                    put("messageId", "v4-snap-${fallbackTurnId ?: sessionId.takeLast(8)}")
                })
                sessionTurnActive[sessionId] = true
            }
            pendingUser = null
            pendingStart = null
            flushed = true
            emittedAnyStart = true
        }

        for (el in window) {
            val row = el.jsonObject
            val kind = row["kind"]?.jsonPrimitive?.jsonStringOrNull ?: continue
            val rowId = row["rowId"]?.jsonPrimitive?.intOrNull ?: continue
            val turnId = row["turnId"]?.jsonPrimitive?.jsonStringOrNull
            when (kind) {
                "turnHeader" -> {
                    val state = row["state"]?.jsonPrimitive?.jsonStringOrNull ?: continue
                    // 上一 turn 还挂着未 flush（空 turn 罕见）先收口；turnHeader 自带
                    // 真实 started，此收口禁止兜底合成
                    flushTurnStart(turnId, withFallback = false)
                    val entityId = row["entityId"]?.jsonPrimitive?.jsonStringOrNull
                    val started = event("turn.started", sessionId, ts, nextSeq(), turnId) {
                        entityId?.let { put("messageId", it) }
                    }
                    if (state == "running" || state == "completedInterrupted") {
                        // completedInterrupted = step 间隙常态（2026-09-01 复测实锤：一个模型
                        // step 完成而任务未终时 turnHeader 停在此态，下个 step 开始翻回 running）。
                        // 快照抓到它时子代理仍在跑——按 running 处理只发挂载点，此前当终态发
                        // turn.failed 是"活动中途 0.8s 误标失败 + 实时流停更"的根因
                        sessionTurnActive[sessionId] = true
                        pendingStart = started
                        flushed = false
                    } else if (state.isNotBlank()) {
                        val isLastTurn = rowId == lastTurnHeaderRowId
                        // sessionTurnActive 跟随最后 turn 的真实状态（终态=false running=true）；
                        // 历史 turn（多 turn 续跑的前序回合）终态不发——只回放内容，
                        // 防前端 markActivityOutcome 把进行中的活动误收尾
                        sessionTurnActive[sessionId] = isLastTurn
                        pendingStart = started
                        if (isLastTurn) {
                            pendingEnd = if (state == "completedSuccess") {
                                event("turn.completed", sessionId, ts, nextSeq(), turnId) { }
                            } else {
                                ProtocolLog.debug("[V4FrameMapper] snapshot turn.failed emitted: state=$state turnId=$turnId sid=$sessionId")
                                event("turn.failed", sessionId, ts, nextSeq(), turnId) {
                                    put("error", buildJsonObject {
                                        put("type", "turn_state")
                                        put("message", "subagent turn ended: $state")
                                    })
                                }
                            }
                        }
                        flushed = false
                    }
                }
                "userInput" -> {
                    val text = row["text"]?.jsonPrimitive?.jsonStringOrNull ?: ""
                    if (text.isNotEmpty()) {
                        pendingUser = event("turn.userInput", sessionId, ts, nextSeq(), turnId) {
                            row["entityId"]?.jsonPrimitive?.jsonStringOrNull?.let { put("messageId", it) }
                            put("text", text)
                        }
                    }
                }
                "assistantText", "reasoning" -> {
                    rows(sessionId)[rowId] = RowInfo(kind, turnId)
                    val text = row["text"]?.jsonPrimitive?.jsonStringOrNull ?: ""
                    if (text.isNotEmpty()) {
                        flushTurnStart(turnId)
                        out.add(event("model.streaming", sessionId, ts, nextSeq(), turnId, "snapshot") {
                            put("kind", if (kind == "reasoning") "reasoning_delta" else "text_delta")
                            put("delta", text)
                        })
                    }
                }
                "toolCall" -> {
                    flushTurnStart(turnId)
                    val callId = row["toolCallId"]?.jsonPrimitive?.jsonStringOrNull ?: continue
                    val toolName = row["toolName"]?.jsonPrimitive?.jsonStringOrNull ?: continue
                    val status = row["status"]?.jsonPrimitive?.jsonStringOrNull ?: continue
                    // 订阅前的输入流视为已完成流：inputTextLen 记当前长度，后续 upsert 只 diff 增量
                    val info = RowInfo("toolCall", turnId).also {
                        it.inputStarted = true
                        it.inputTextLen = row["inputText"]?.jsonPrimitive?.jsonStringOrNull?.length ?: 0
                    }
                    rows(sessionId)[rowId] = info
                    when (status) {
                        "inputStreaming", "running" -> out.add(event("tool.updated", sessionId, ts, nextSeq(), turnId) {
                            put("kind", "started")
                            put("toolCallId", callId)
                            put("toolName", toolName)
                            row["input"]?.jsonObject?.let { put("input", it) }
                            row["startedAt"]?.jsonPrimitive?.longOrNull?.let { put("startedAt", it) }
                        })
                        "success", "error" -> {
                            out.add(event("tool.updated", sessionId, ts, nextSeq(), turnId) {
                                put("kind", "started")
                                put("toolCallId", callId)
                                put("toolName", toolName)
                                row["input"]?.jsonObject?.let { put("input", it) }
                                row["startedAt"]?.jsonPrimitive?.longOrNull?.let { put("startedAt", it) }
                            })
                            out.add(event("tool.updated", sessionId, ts, nextSeq(), turnId) {
                                put("kind", "result")
                                put("toolCallId", callId)
                                put("toolName", toolName)
                                put("result", buildJsonObject {
                                    put("success", status == "success")
                                    put("content", row["output"]?.jsonObject?.get("text")
                                        ?.jsonPrimitive?.jsonStringOrNull ?: "")
                                })
                                row["startedAt"]?.jsonPrimitive?.longOrNull?.let { put("startedAt", it) }
                                row["endedAt"]?.jsonPrimitive?.longOrNull?.let { put("endedAt", it) }
                            })
                        }
                    }
                }
            }
        }
        // 尾部：最后一个 turn 只有头没有内容（刚起或空 turn）也要 flush，
        // 保证 user prompt 与 turn 生命周期事件不丢；不再有内容行，无需兜底合成
        flushTurnStart(null, withFallback = false)
        return out
    }

    /** 单个 op → 0 或 1 个 legacy 事件（一个 op 最多产出一个事件，映射保持单射） */
    private fun mapOp(sessionId: String, op: JsonObject, ts: Long, seq: Long): SessionEvent? {
        return when (op["op"]?.jsonPrimitive?.jsonStringOrNull) {
            "row.appended", "row.upserted" -> mapRow(sessionId, op["row"]?.jsonObject ?: return null, ts, seq)
            "row.delta" -> mapRowDelta(sessionId, op, ts, seq)
            else -> null // state.updated / row.removed 等与本映射无关
        }
    }

    /** 行新增/整行更新：按 kind 分派 */
    private fun mapRow(sessionId: String, row: JsonObject, ts: Long, seq: Long): SessionEvent? {
        val kind = row["kind"]?.jsonPrimitive?.jsonStringOrNull ?: return null
        val rowId = row["rowId"]?.jsonPrimitive?.intOrNull ?: return null
        val turnId = row["turnId"]?.jsonPrimitive?.jsonStringOrNull
        return when (kind) {
            "turnHeader" -> mapTurnHeader(sessionId, row, ts, seq)
            "assistantText", "reasoning" -> {
                rows(sessionId)[rowId] = RowInfo(kind, turnId)
                null // 行建立不发事件；内容随 row.delta 流式到达
            }
            "toolCall" -> mapToolCall(sessionId, rowId, row, ts, seq)
            else -> null // userInput / timelineMarker 等：弹窗转录由快照轮询覆盖
        }
    }

    /** 回合头：running = 开始；终态 = 完成/失败（翻转迟到订阅合成的 turn 上下文） */
    private fun mapTurnHeader(sessionId: String, row: JsonObject, ts: Long, seq: Long): SessionEvent? {
        val state = row["state"]?.jsonPrimitive?.jsonStringOrNull ?: return null
        val turnId = row["turnId"]?.jsonPrimitive?.jsonStringOrNull
        val entityId = row["entityId"]?.jsonPrimitive?.jsonStringOrNull
        return when (state) {
            "running" -> {
                sessionTurnActive[sessionId] = true
                event("turn.started", sessionId, ts, seq, turnId) {
                    entityId?.let { put("messageId", it) }
                }
            }
            // step 间隙常态（见 mapSnapshot 同名分支）：step 完成、任务未终，下个
            // step 会翻回 running——跳过不发任何 turn 事件，防误发 turn.failed；
            // 真中断场景由权威轮询/lifecycle 收尾兜底
            "completedInterrupted" -> null
            "completedSuccess" -> {
                sessionTurnActive[sessionId] = false
                event("turn.completed", sessionId, ts, seq, turnId) { }
            }
            // completedError / cancelled 等一切非成功终态按失败收口（前端有权威重拉自愈）
            else -> if (state.isNotBlank()) {
                // 诊断（缺陷AO 追查）：turn.failed 的产出源与 state 值——真实终态 vs
                // 未知的中间态误判，凭此行在 idea.log（开 ProtocolLog 后）区分
                ProtocolLog.debug("[V4FrameMapper] turn.failed emitted: state=$state turnId=$turnId sid=$sessionId")
                sessionTurnActive[sessionId] = false
                event("turn.failed", sessionId, ts, seq, turnId) {
                    put("error", buildJsonObject {
                        put("type", "turn_state")
                        put("message", "subagent turn ended: $state")
                    })
                }
            } else null
        }
    }

    /**
     * 行内容流式追加。rowId 必须先经 row.appended 登记（assistantText/reasoning）——
     * 未登记的（订阅落在回合中途）丢弃，快照轮询兜底。
     */
    private fun mapRowDelta(sessionId: String, op: JsonObject, ts: Long, seq: Long): SessionEvent? {
        if (op["path"]?.jsonPrimitive?.jsonStringOrNull != "text") return null
        val rowId = op["rowId"]?.jsonPrimitive?.intOrNull ?: return null
        val append = op["append"]?.jsonPrimitive?.jsonStringOrNull ?: return null
        val info = rows(sessionId)[rowId] ?: return null
        val kind = when (info.kind) {
            "assistantText" -> "text_delta"
            "reasoning" -> "reasoning_delta"
            else -> return null
        }
        return event("model.streaming", sessionId, ts, seq, info.turnId) {
            put("kind", kind)
            put("delta", append)
        }
    }

    /**
     * 工具行：inputStreaming = 参数流（tool_input_start/delta）；running = 执行中
     * （tool.updated kind:started，input 对象已解析）；success/error = 结果。
     */
    private fun mapToolCall(sessionId: String, rowId: Int, row: JsonObject, ts: Long, seq: Long): SessionEvent? {
        val rows = rows(sessionId)
        val info = rows.getOrPut(rowId) { RowInfo("toolCall", row["turnId"]?.jsonPrimitive?.jsonStringOrNull) }
        val callId = row["toolCallId"]?.jsonPrimitive?.jsonStringOrNull ?: return null
        val toolName = row["toolName"]?.jsonPrimitive?.jsonStringOrNull ?: return null
        return when (row["status"]?.jsonPrimitive?.jsonStringOrNull ?: return null) {
            "inputStreaming" -> {
                val inputText = row["inputText"]?.jsonPrimitive?.jsonStringOrNull ?: ""
                return if (!info.inputStarted && inputText.isNotEmpty()) {
                    // 首个非空输入：建工具 part（前端以 inputRaw 累积渲染参数流）
                    info.inputStarted = true
                    info.inputTextLen = inputText.length
                    event("model.streaming", sessionId, ts, seq, info.turnId) {
                        put("kind", "tool_input_start")
                        put("toolCallId", callId)
                        put("toolName", toolName)
                    }
                } else if (info.inputStarted && inputText.length > info.inputTextLen) {
                    // 后续整行 upsert 携带累积 inputText：diff 出增量（服务端不做行级 delta）
                    val delta = inputText.substring(info.inputTextLen)
                    info.inputTextLen = inputText.length
                    event("model.streaming", sessionId, ts, seq, info.turnId) {
                        put("kind", "tool_input_delta")
                        put("toolCallId", callId)
                        put("delta", delta)
                    }
                } else null
            }
            "running" -> event("tool.updated", sessionId, ts, seq, info.turnId) {
                put("kind", "started")
                put("toolCallId", callId)
                put("toolName", toolName)
                row["input"]?.jsonObject?.let { put("input", it) }
                row["startedAt"]?.jsonPrimitive?.longOrNull?.let { put("startedAt", it) }
            }
            "success", "error" -> {
                val isSuccess = row["status"]?.jsonPrimitive?.content == "success"
                event("tool.updated", sessionId, ts, seq, info.turnId) {
                    put("kind", "result")
                    put("toolCallId", callId)
                    put("toolName", toolName)
                    put("result", buildJsonObject {
                        put("success", isSuccess)
                        put("content", row["output"]?.jsonObject?.get("text")?.jsonPrimitive?.jsonStringOrNull ?: "")
                    })
                    row["startedAt"]?.jsonPrimitive?.longOrNull?.let { put("startedAt", it) }
                    row["endedAt"]?.jsonPrimitive?.longOrNull?.let { put("endedAt", it) }
                }
            }
            else -> return null
        }
    }

    private fun rows(sessionId: String): MutableMap<Int, RowInfo> =
        sessionRows.computeIfAbsent(sessionId) { java.util.concurrent.ConcurrentHashMap() }

    /** 统一构造：seq 单调（toSeq+i）、sessionId/turnId 齐全，payload 由调用方填充。
     *  deliveryKind 非 null 时事件标记来源（"snapshot"= 快照回放，前端据此跳过切片回放） */
    private inline fun event(
        type: String, sessionId: String, ts: Long, seq: Long, turnId: String?,
        deliveryKind: String? = null,
        payloadBuilder: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit,
    ): SessionEvent = SessionEvent(
        type = type,
        seq = seq,
        sessionId = sessionId,
        timestamp = ts,
        traceId = null,
        turnId = turnId,
        deliveryKind = deliveryKind,
        payload = buildJsonObject(payloadBuilder),
    )

    /** 会话退订/结束时清行表，防长期累积 */
    fun cleanup(sessionId: String) {
        sessionRows.remove(sessionId)
        sessionTurnActive.remove(sessionId)
    }
}
