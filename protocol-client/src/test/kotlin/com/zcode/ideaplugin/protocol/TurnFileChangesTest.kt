package com.zcode.ideaplugin.protocol

import kotlinx.serialization.json.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path
import java.util.concurrent.CopyOnWriteArrayList
import com.zcode.ideaplugin.protocol.model.SessionEvent
import kotlin.io.path.writeText
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * 逐轮文件更改与回退（B2）端到端测试 —— 假 app-server 驱动，无真实模型调用：
 *
 * 假服务器：v4/conversation/subscribe → ack + initial 快照帧（窗口含带 fileChanges 的
 * turnHeader 行 + 无 fileChanges 的普通行）；fileChanges/fileRewindPreview/v4/command
 * 三个 RPC 捕获入参写捕获文件（进程间不可见内存，落盘给测试断言）后回罐头应答。
 *
 * 验证四件事：
 * 1. rescanTurnFileChanges 从快照窗口合成 turn.fileChanges 事件（无 fileChanges 的行跳过）
 * 2. fetchTurnFileChanges 的 CAS 值来自快照（baseRevision=7/baseLogEpoch）且 target=turnHeader 行
 * 3. applyTurnFileRewind 走 v4/command 信封（type=applyFileRewind，同款 CAS）
 * 4. 快照窗口外的老轮走 rowsRange 翻页定位
 */
class TurnFileChangesTest {

    @TempDir
    lateinit var tempDir: Path

    private val sid = "sess_main_b2"

    /** 轮询读取假服务端写入的捕获文件（capture JSON：{fileChanges, preview, command}） */
    private fun readCaptured(): JsonObject? {
        val file = tempDir.resolve("captured.json").toFile()
        repeat(40) {
            val text = runCatching { file.readText() }.getOrNull()
            if (!text.isNullOrBlank()) {
                runCatching { return Json.parseToJsonElement(text).jsonObject }
            }
            Thread.sleep(50)
        }
        return null
    }

    private fun fakeServerJs(captureFile: String): String = """
        import readline from 'node:readline';
        import fs from 'node:fs';
        if (process.argv.includes('--version')) {
            process.stdout.write('0.16.5\n');
            process.exit(0);
        }
        const rl = readline.createInterface({ input: process.stdin });
        const sid = '$sid';
        const CAPTURE = String.raw`$captureFile`;
        let subCount = 0;
        const captured = {};
        function save() { fs.writeFileSync(CAPTURE, JSON.stringify(captured)); }
        function send(m) { process.stdout.write(JSON.stringify(m) + '\n'); }
        rl.on('line', line => {
          let m; try { m = JSON.parse(line); } catch { return; }
          if (m.id === undefined || !m.method) return;
          if (m.method === 'v4/conversation/subscribe') {
            subCount++;
            send({ id: m.id, result: { ack: { subscriptionId: 'sub-' + subCount, mode: 'snapshot', logEpoch: 'epoch-b2' } } });
            if (subCount === 1) {
              send({ method: 'v4/conversation/frame', params: {
                topic: 'conversation/' + sid, subscriptionId: 'sub-1',
                frame: { topic: 'conversation/' + sid, sentAt: 1788148526090, fromSeq: 0, toSeq: 3,
                         payload: { kind: 'snapshot', snapshot: { logEpoch: 'epoch-b2', seq: 3, revision: 7,
                           rows: { window: [
                             {rowId:40, kind:'userInput', turnId:'turn_u1', entityId:'msg_user_1',
                              text:'帮我写个文件'},
                             {rowId:42, kind:'assistantText', turnId:'turn_u1', entityId:'msg_assistant_a',
                              state:'complete', text:'已创建', actions:{canFork:true}},
                             {rowId:41, kind:'turnHeader', turnId:'turn_u1', entityId:'msg_user_1',
                              state:'completedSuccess', fileChanges:{additions:12, deletions:3, files:2},
                              actions:{canRewindFiles:true}}
                           ] } } } }
              }});
            }
            return;
          }
          if (m.method === 'v4/conversation/rowsRange') {
            // 翻页兜底：返回窗口外目标轮的行流（turnHeader entityId=user 消息 id，
            // assistantText entityId=assistant 消息 id——同轮反查的数据形态）
            send({ id: m.id, result: { rows: [
              {rowId:50, kind:'userInput', turnId:'turn_old', entityId:'msg_user_old', text:'旧轮'},
              {rowId:51, kind:'assistantText', turnId:'turn_old', entityId:'msg_in_rowsrange',
               state:'complete', text:'旧轮回复'},
              {rowId:49, kind:'turnHeader', turnId:'turn_old', entityId:'msg_user_old',
               state:'completedSuccess', fileChanges:{additions:1, deletions:0, files:1},
               actions:{canRewindFiles:true}}
            ], hasMore: false } });
            return;
          }
          if (m.method === 'v4/conversation/fileChanges') {
            captured.fileChanges = m.params; save();
            send({ id: m.id, result: { files: 1, additions: 12, deletions: 3, state: 'active',
              items: [{ path: 'a.txt', additions: 12, deletions: 3, writeCount: 1, toolNames: ['Write'], patches: [] }] } });
            return;
          }
          if (m.method === 'v4/conversation/fileRewindPreview') {
            captured.preview = m.params; save();
            send({ id: m.id, result: { canApply: true,
              safeFiles: [{ action: 'restore', operationCount: 1, path: 'a.txt', toolNames: ['Write'] }],
              unsafeFiles: [], ignoredFiles: [] } });
            return;
          }
          if (m.method === 'v4/command') {
            captured.command = m.params; save();
            send({ id: m.id, result: { status: 'accepted', result: { type: 'applyFileRewind', applied: true, response: 'ok' } } });
            return;
          }
          if (m.method === 'v4/conversation/unsubscribe') { send({ id: m.id, result: {} }); return; }
          send({ id: m.id, result: {} });
        });
    """.trimIndent()

    private fun startClient(): Pair<ZCodeProtocolClient, CopyOnWriteArrayList<SessionEvent>> {
        val captureFile = tempDir.resolve("captured.json").toString().replace('\\', '/')
        val script = tempDir.resolve("fake-turn-file-changes.mjs")
            .also { it.writeText(fakeServerJs(captureFile)) }
        val client = ZCodeProtocolClient.start(
            zcodePath = script,
            credentials = ZCodeCredentials("test-model", "http://127.0.0.1:9", "test-key"),
        )
        val events = CopyOnWriteArrayList<SessionEvent>()
        client.addGlobalEventListener { events.add(it) }
        return client to events
    }

    @Test
    fun `重扫走 rowsRange 无状态翻页并锚定轮内 assistantText`() {
        val (client, events) = startClient()
        try {
            // 重扫不再依赖订阅快照（对已订阅 topic 幂等重订不重推 initial 快照——真机实证），
            // 改 rowsRange 无状态翻页：假服务端翻页返回旧轮行流（带 fileChanges 的 turnHeader）
            val count = client.rescanTurnFileChanges(sid)
            assertEquals(1, count)
            val ev = events.first { it.type == "turn.fileChanges" }
            assertEquals(sid, ev.sessionId)
            // 锚点=同轮 assistantText 行 entityId（=legacy assistant 消息 id）
            assertEquals("msg_in_rowsrange", ev.payload["messageId"]?.jsonPrimitive?.content)
            assertEquals(49, ev.payload["rowId"]?.jsonPrimitive?.intOrNull)
            val fc = ev.payload["fileChanges"]?.jsonObject
            assertEquals(1, fc?.get("additions")?.jsonPrimitive?.intOrNull)
            assertEquals(true, ev.payload["canRewindFiles"]?.jsonPrimitive?.booleanOrNull)
        } finally {
            client.close()
        }
    }

    @Test
    fun `fetchTurnFileChanges 的 CAS 值来自快照且 target 为回合头行`() {
        val (client, _) = startClient()
        try {
            // webview 传 assistant 消息 id → 快照窗口两步匹配（assistantText entityId 反查）
            val result = client.fetchTurnFileChanges(sid, "msg_assistant_a")
            assertEquals(1, result["files"]?.jsonPrimitive?.intOrNull)
            val params = readCaptured()?.get("fileChanges")?.jsonObject ?: error("服务端未捕获 fileChanges 入参")
            assertEquals(7, params["baseRevision"]?.jsonPrimitive?.intOrNull, "baseRevision 必须取快照 revision")
            assertEquals("epoch-b2", params["baseLogEpoch"]?.jsonPrimitive?.content)
            val target = params["target"]?.jsonObject ?: error("缺 target")
            assertEquals(41, target["rowId"]?.jsonPrimitive?.intOrNull, "target 应为该轮 turnHeader 行")
            assertEquals("msg_user_1", target["entityId"]?.jsonPrimitive?.content)
        } finally {
            client.close()
        }
    }

    @Test
    fun `applyTurnFileRewind 走 v4 command 信封且 CAS 同源`() {
        val (client, _) = startClient()
        try {
            val result = client.applyTurnFileRewind(sid, "msg_assistant_a")
            assertEquals(true, result["result"]?.jsonObject?.get("applied")?.jsonPrimitive?.booleanOrNull)
            val params = readCaptured()?.get("command")?.jsonObject ?: error("服务端未捕获 command 入参")
            assertEquals("applyFileRewind", params["type"]?.jsonPrimitive?.content)
            assertEquals(7, params["baseRevision"]?.jsonPrimitive?.intOrNull)
            assertEquals("epoch-b2", params["baseLogEpoch"]?.jsonPrimitive?.content)
            val target = params["payload"]?.jsonObject?.get("target")?.jsonObject ?: error("缺 payload.target")
            assertEquals(41, target["rowId"]?.jsonPrimitive?.intOrNull)
            assertEquals("msg_user_1", target["entityId"]?.jsonPrimitive?.content)
        } finally {
            client.close()
        }
    }

    @Test
    fun `窗口外的老轮走 rowsRange 翻页定位`() {
        val (client, _) = startClient()
        try {
            // 快照窗口没有该轮；rowsRange 返回旧轮行流 → assistantText entityId 反查 turnHeader
            val result = client.previewTurnFileRewind(sid, "msg_in_rowsrange")
            assertEquals(true, result["canApply"]?.jsonPrimitive?.booleanOrNull)
            val params = readCaptured()?.get("preview")?.jsonObject ?: error("服务端未捕获 preview 入参")
            val target = params["target"]?.jsonObject ?: error("缺 target")
            assertEquals(49, target["rowId"]?.jsonPrimitive?.intOrNull)
            assertEquals("msg_user_old", target["entityId"]?.jsonPrimitive?.content)
        } finally {
            client.close()
        }
    }
}
