package com.zcode.ideaplugin.protocol

import kotlinx.serialization.json.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.io.path.writeText
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * v4 子会话实时流端到端测试 —— 假 app-server 驱动，无真实模型调用：
 *
 * 假服务器：v4/conversation/subscribe → 回 ack 后主动推 v4/conversation/frame 通知
 *（一段子代理读文件任务的行流：turnHeader running → toolCall 输入流/执行/结果 →
 * assistantText delta → turnHeader completedSuccess）。
 *
 * 验证：subscribeConversationV4 订阅后，全局监听器收到映射好的 legacy 事件序列
 *（turn.started / model.streaming / tool.updated / turn.completed），事件 sessionId
 * 从 topic 剥出——面板 pushStreamEvent 白名单与前端 childLiveMessages 归约零改动的前提。
 */
class V4ConversationStreamTest {

    @TempDir
    lateinit var tempDir: Path

    private val childSid = "sess_subagent_agent_fake"

    private fun fakeServerJs(withSnapshot: Boolean = false): String = """
        import readline from 'node:readline';
        let pushed = false;
        const rl = readline.createInterface({ input: process.stdin });
        const sid = '$childSid';
        function send(m) { process.stdout.write(JSON.stringify(m) + '\n'); }
        const deltas = [
          {op:'row.appended', row:{rowId:1, kind:'turnHeader', turnId:'t1', entityId:'t1', state:'running'}},
          {op:'row.appended', row:{rowId:4, kind:'toolCall', turnId:'t1', toolCallId:'c1', toolName:'Read', status:'inputStreaming', inputText:'{"file_path"'}},
          {op:'row.upserted', row:{rowId:4, kind:'toolCall', turnId:'t1', toolCallId:'c1', toolName:'Read', status:'inputStreaming', inputText:'{"file_path":"a.txt"'}},
          {op:'row.upserted', row:{rowId:4, kind:'toolCall', turnId:'t1', toolCallId:'c1', toolName:'Read', status:'running', input:{file_path:'a.txt'}}},
          {op:'row.upserted', row:{rowId:4, kind:'toolCall', turnId:'t1', toolCallId:'c1', toolName:'Read', status:'success', output:{text:'内容'}}},
          {op:'row.appended', row:{rowId:5, kind:'assistantText', turnId:'t1', text:''}},
          {op:'row.delta', rowId:5, path:'text', append:'完成'},
          {op:'row.upserted', row:{rowId:1, kind:'turnHeader', turnId:'t1', entityId:'t1', state:'completedSuccess'}}
        ];
        const snapshotDeltas = ${if (withSnapshot) """
          [{op:'row.upserted', row:{rowId:1, kind:'turnHeader', turnId:'t1', entityId:'t1', state:'running'}},
           {op:'row.upserted', row:{rowId:2, kind:'userInput', turnId:'t1', entityId:'t1', text:'读文件任务'}},
           {op:'row.upserted', row:{rowId:3, kind:'reasoning', turnId:'t1', text:'先想一下', state:'complete'}}]
        """ else "null"}
        rl.on('line', line => {
          let m; try { m = JSON.parse(line); } catch { return; }
          if (m.id === undefined || !m.method) return;
          if (m.method === 'v4/conversation/subscribe') {
            send({ id: m.id, result: { ack: { subscriptionId: 'sub-1', mode: 'snapshot', logEpoch: 'e1' } } });
            if (pushed) return;  // 幂等重订不重推（生产订阅幂等只订一次）
            pushed = true;
            if (snapshotDeltas) {
              send({ method: 'v4/conversation/frame', params: {
                wireVersion: 3, kind: 'complete', deliveryKind: 'initial',
                topic: 'conversation/' + sid, subscriptionId: 'sub-1',
                frame: { topic: 'conversation/' + sid, sentAt: 1788148526090, fromSeq: 0, toSeq: 3,
                         payload: { kind: 'snapshot', snapshot: { rows: { window: snapshotDeltas.map(d => d.row) } } } }
              }});
            }
            send({ method: 'v4/conversation/frame', params: {
              wireVersion: 3, kind: 'complete', deliveryKind: 'online',
              topic: 'conversation/' + sid, subscriptionId: 'sub-1',
              frame: { topic: 'conversation/' + sid, sentAt: 1788148526100, fromSeq: 0, toSeq: 8,
                       payload: { kind: 'deltas', deltas } }
            }});
            return;
          }
          if (m.method === 'v4/conversation/unsubscribe') { send({ id: m.id, result: {} }); return; }
          send({ id: m.id, result: {} });
        });
    """.trimIndent()

    private fun startClient(withSnapshot: Boolean = false): ZCodeProtocolClient {
        val script = tempDir.resolve("fake-v4-stream.mjs").also { it.writeText(fakeServerJs(withSnapshot)) }
        return ZCodeProtocolClient.start(
            zcodePath = script,
            credentials = ZCodeCredentials("test-model", "http://127.0.0.1:9", "test-key")
        )
    }

    @Test
    fun `v4 订阅后帧通知映射为 legacy 事件序列`() {
        val client = startClient()
        try {
            val received = CopyOnWriteArrayList<com.zcode.ideaplugin.protocol.model.SessionEvent>()
            client.addGlobalEventListener { received.add(it) }

            client.subscribeConversationV4(childSid)
            // 幂等：重复订阅不报错
            client.subscribeConversationV4(childSid)

            val deadline = System.currentTimeMillis() + 5000
            while (received.size < 7 && System.currentTimeMillis() < deadline) Thread.sleep(20)

            // 单帧全流程（回合头+内容+终态同帧）：真实 turnHeader 的 7 条映射，
            // 不再自愈合成（终态 op 会把 turn 上下文翻回 false，须防误合成空壳消息）
            assertEquals(7, received.size, "映射事件序列: ${received.map { it.type + "/mid=" + it.payload["messageId"] + "/" + it.payload["kind"] }}")
            assertEquals("turn.started", received[0].type)
            assertEquals("t1", received[0].payload["messageId"]?.jsonPrimitive?.content, "首条为真实 turnHeader 映射")
            assertTrue(received.none { it.payload["messageId"]?.jsonPrimitive?.content?.startsWith("v4-late-") == true },
                "同帧已有真实 turn.started 时不合成")
            assertEquals(childSid, received[0].sessionId, "sessionId 从 topic 剥出（前端按会话归约的前提）")

            val kinds = received.map { it.payload["kind"]?.jsonPrimitive?.content }
            assertEquals(
                listOf(null, "tool_input_start", "tool_input_delta", "started", "result", "text_delta", null),
                kinds,
                "turn.started → 工具输入流 → 执行 → 结果 → 正文增量 → turn.completed 顺序保持"
            )
            assertEquals("tool.updated", received[3].type)
            assertEquals("started", received[3].payload["kind"]?.jsonPrimitive?.content)
            val result = received[4].payload["result"]?.jsonObject
            assertEquals("内容", result?.get("content")?.jsonPrimitive?.content)
            assertEquals("turn.completed", received[6].type)

            // 退订收尾（best-effort，不抛）
            client.unsubscribeConversationV4(childSid)
        } finally {
            client.close()
        }
    }

    @Test
    fun `v4 订阅后 snapshot 帧回放 prompt 与历史内容`() {
        val client = startClient(withSnapshot = true)
        try {
            val received = CopyOnWriteArrayList<com.zcode.ideaplugin.protocol.model.SessionEvent>()
            client.addGlobalEventListener { received.add(it) }

            client.subscribeConversationV4(childSid)

            val deadline = System.currentTimeMillis() + 5000
            while (received.size < 11 && System.currentTimeMillis() < deadline) Thread.sleep(20)

            // snapshot 回放（reset + prompt + started + 思考全文）+ 增量帧 7 条映射
            assertEquals(11, received.size, "事件序列: ${received.map { it.type + "/" + it.payload["kind"] }}")
            assertEquals("stream.snapshotReset", received[0].type, "快照回放以 reset 打头（前端清空归约态防重复）")
            assertEquals("turn.userInput", received[1].type)
            assertEquals("读文件任务", received[1].payload["text"]?.jsonPrimitive?.content, "prompt 随快照回放")
            assertEquals("turn.started", received[2].type)
            assertEquals("t1", received[2].payload["messageId"]?.jsonPrimitive?.content)
            assertEquals("reasoning_delta", received[3].payload["kind"]?.jsonPrimitive?.content)
            assertEquals("snapshot", received[3].deliveryKind, "快照回放文本带标记（前端跳过切片回放）")
            assertEquals("先想一下", received[3].payload["delta"]?.jsonPrimitive?.content)
            // 增量帧正常续流（snapshot 已开 turn 上下文，不再合成 v4-late-）
            assertEquals("turn.started", received[4].type, "增量帧真实 turnHeader 映射（前端按 messageId 幂等复用）")
            assertTrue(received.none { it.payload["messageId"]?.jsonPrimitive?.content?.startsWith("v4-late-") == true })
            assertEquals("turn.completed", received[10].type)

            client.unsubscribeConversationV4(childSid)
        } finally {
            client.close()
        }
    }
}
