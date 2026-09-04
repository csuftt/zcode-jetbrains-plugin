package com.zcode.ideaplugin.protocol

import kotlinx.serialization.json.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path
import kotlin.io.path.writeText
import kotlin.io.path.readText
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * 会话分叉（v4/command forkAssistant，官方客户端同款通道）协议测试 —— 假 app-server 驱动，无真实模型调用。
 *
 * 分叉语义是【轮】级别（diag-fork16 真会话定案）：canFork 只打在轮内最后一段 assistantText 上，
 * 长轮次「过渡语→工具→最终回复」的中间段天然无 canFork；legacy 视图整轮合并显示、messageId
 * 取第一段——选行须按 turnId 换算到轮内带 canFork 的行，且 target.entityId 用该行自己的 entityId。
 *
 * 场景1（ok）：全链路编排——subscribe 取 ack.logEpoch → rowsRange 定位 canFork 行（回归锁：
 *        同 entityId 的 reasoning 行在前也不得选中）→ forkAssistant 首发 stale（baseRevision=0）
 *        → 按 revisionAtDecision=11 重试 accepted；回显文件断言第二次命令信封
 * 场景2（multisegment）：目标是轮内第一段（无 canFork），轮末段带 canFork → 自动改选轮末段，
 *        target.entityId=轮末段自己的 id（fork16 回归锁）
 * 场景3（paged）：目标不在首页 → beforeRowId 向前翻页找到（第二页命令携带 beforeRowId）
 * 场景4（notforkable）：目标行存在但整轮无 canFork → 抛「分叉点不可用」
 * 场景5（oldcli）：老版本 CLI 无 v4 面（subscribe -32601）→ code=-32601（前端据此隐藏入口）
 * 场景6（missing）：窗口内无目标 → 抛「那条消息」
 *
 * 协议细节见 docs/internal/design-research/fork对齐客户端调研-2026-09-05.md。
 */
class ForkSessionTest {

    @TempDir
    lateinit var tempDir: Path

    private fun newFakeServerJs(mode: String, echoFile: String): String = """
        import readline from 'node:readline';
        import fs from 'node:fs';
        const mode = ${jsonPrimitive(mode)};
        const echoPath = ${jsonPrimitive(echoFile)};
        const rl = readline.createInterface({ input: process.stdin });
        let commandCalls = 0;
        let rowsRangeCalls = 0;
        rl.on('line', line => {
            let m; try { m = JSON.parse(line); } catch { return; }
            if (m.id === undefined || !m.method) return;
            const p = m.params || {};
            if (m.method === 'v4/conversation/subscribe') {
                if (mode === 'oldcli') {
                    process.stdout.write(JSON.stringify({ id: m.id, error: { code: -32601, message: 'Method not found' } }) + '\n');
                } else {
                    process.stdout.write(JSON.stringify({ id: m.id, result: { ack: { subscriptionId: 'sub-1', logEpoch: 'epoch-1' } } }) + '\n');
                }
            } else if (m.method === 'v4/conversation/rowsRange') {
                rowsRangeCalls += 1;
                fs.appendFileSync(echoPath, JSON.stringify({ kind: 'rowsRange', call: rowsRangeCalls, beforeRowId: p.beforeRowId ?? null }) + '\n');
                if (mode === 'missing') {
                    process.stdout.write(JSON.stringify({ id: m.id, result: { rows: [{ rowId: 2, turnId: 'turn_other', entityId: 'msg_other', kind: 'userInput' }] } }) + '\n');
                } else if (mode === 'notforkable') {
                    // 目标行存在但整轮无 canFork（轮未完成/被中断形态）
                    process.stdout.write(JSON.stringify({ id: m.id, result: { rows: [
                        { rowId: 6, turnId: 'turn_a', entityId: 'msg_target', kind: 'reasoning', actions: null },
                        { rowId: 7, turnId: 'turn_a', entityId: 'msg_target', kind: 'assistantText', state: 'complete' }
                    ] } }) + '\n');
                } else if (mode === 'multisegment') {
                    // fork16 真会话形态：目标=轮内第一段（无 canFork），轮末段带 canFork（不同 entityId）
                    process.stdout.write(JSON.stringify({ id: m.id, result: { rows: [
                        { rowId: 100, turnId: 'turn_a', entityId: 'msg_final', kind: 'assistantText', state: 'complete', actions: { canFork: true } },
                        { rowId: 60, turnId: 'turn_a', entityId: 'msg_mid', kind: 'toolCall', actions: null },
                        { rowId: 38, turnId: 'turn_a', entityId: 'msg_target', kind: 'assistantText', state: 'complete' }
                    ] } }) + '\n');
                } else if (mode === 'paged' && rowsRangeCalls === 1) {
                    // 首页只有别轮的 canFork 行，hasMore=true 触发 beforeRowId 翻页
                    process.stdout.write(JSON.stringify({ id: m.id, result: { rows: [
                        { rowId: 50, turnId: 'turn_b', entityId: 'msg_page1', kind: 'assistantText', actions: { canFork: true } }
                    ], hasMore: true } }) + '\n');
                } else if (mode === 'paged') {
                    process.stdout.write(JSON.stringify({ id: m.id, result: { rows: [
                        { rowId: 7, turnId: 'turn_a', entityId: 'msg_target', kind: 'assistantText', actions: { canFork: true } }
                    ], hasMore: false } }) + '\n');
                } else {
                    // 回归锁（diag-fork13/15）：同 entityId 的 reasoning 行在前也不得选中
                    process.stdout.write(JSON.stringify({ id: m.id, result: { rows: [
                        { rowId: 2, turnId: 'turn_other', entityId: 'msg_other', kind: 'userInput' },
                        { rowId: 6, turnId: 'turn_a', entityId: 'msg_target', kind: 'reasoning', actions: null },
                        { rowId: 7, turnId: 'turn_a', entityId: 'msg_target', kind: 'assistantText', actions: { canFork: true, canRetry: true } }
                    ] } }) + '\n');
                }
            } else if (m.method === 'v4/conversation/unsubscribe') {
                fs.appendFileSync(echoPath, JSON.stringify({ kind: 'unsubscribe', params: p }) + '\n');
                process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\n');
            } else if (m.method === 'session/goal') {
                // fork 后的目标暂停收尾（fail-soft 主路径外的 pause 调用会到这里）
                fs.appendFileSync(echoPath, JSON.stringify({ kind: 'goal', params: p }) + '\n');
                process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\n');
            } else if (m.method === 'v4/command') {
                commandCalls += 1;
                fs.appendFileSync(echoPath, JSON.stringify({ call: commandCalls, envelope: p }) + '\n');
                if (p.type !== 'forkAssistant') {
                    process.stdout.write(JSON.stringify({ id: m.id, result: { status: 'rejected', reasonCode: 'proto.invalidType' } }) + '\n');
                } else if (commandCalls === 1 && mode !== 'paged') {
                    // 首发 CAS 必 stale，回传当前 revision
                    process.stdout.write(JSON.stringify({ id: m.id, result: { commandId: p.commandId, status: 'stale', reasonCode: 'proto.staleRevision', revisionAtDecision: 11 } }) + '\n');
                } else {
                    process.stdout.write(JSON.stringify({ id: m.id, result: { commandId: p.commandId, status: 'accepted',
                        result: { type: 'forkAssistant', sessionId: 'sess_forked_fake' } } }) + '\n');
                }
            } else {
                process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\n');
            }
        });
    """.trimIndent()

    // node 字符串字面量（回显文件路径用正斜杠，Windows 下 node 可直接用）
    private fun jsonPrimitive(path: String): String = "\"${path.replace('\\', '/')}\""

    private fun startFakeClient(mode: String, echoFile: Path): ZCodeProtocolClient {
        val script = tempDir.resolve("fake-app-server-fork-$mode.mjs")
            .also { it.writeText(newFakeServerJs(mode, echoFile.toString())) }
        return ZCodeProtocolClient.start(
            zcodePath = script,
            credentials = ZCodeCredentials("test-model", "http://127.0.0.1:9", "test-key")
        )
    }

    private fun readEchoLines(echoFile: Path): List<JsonObject> =
        echoFile.readText().trim().lines().map { Json.parseToJsonElement(it).jsonObject }

    @Test
    fun `fork 全链路编排正确且 CAS 重试信封正确`() {
        val echoFile = tempDir.resolve("echo-ok.jsonl")
        startFakeClient("ok", echoFile).use { client ->
            val r = client.forkAssistantViaV4("sess_parent_fake", "msg_target")
            assertEquals("sess_forked_fake", r["forkedSessionId"]?.jsonPrimitive?.content, "应答应含 forkedSessionId")
            assertEquals("sess_parent_fake", r["parentSessionId"]?.jsonPrimitive?.content, "parentSessionId 应为请求会话")
            // fork 的临时订阅不得污染帧映射白名单（diag-fork19：initial snapshot 帧进白名单会被
            // V4FrameMapper 回放成 turn.started+全量消息事件推给父会话标签 → 误入流式态）
            assertEquals(false, client.isConversationV4Subscribed("sess_parent_fake"), "fork 后会话不应留在 v4 帧映射白名单")
        }
        val lines = readEchoLines(echoFile)
        val commands = lines.filter { it["envelope"] != null }
        assertEquals(2, commands.size, "应恰好两次 forkAssistant 命令（stale → 重试）")
        val unsub = lines.filter { it["kind"]?.jsonPrimitive?.content == "unsubscribe" }
        assertEquals(1, unsub.size, "应恰好一次退订（fork 临时订阅收尾）")
        // fork 复制的 goal target 是 active 假跑态（fork28），fork 后须 pause 新会话目标
        val goalCalls = lines.filter { it["kind"]?.jsonPrimitive?.content == "goal" }
        assertEquals(1, goalCalls.size, "应恰好一次 session/goal 收尾")
        val goalParams = goalCalls[0]["params"]!!.jsonObject
        assertEquals("pause", goalParams["action"]?.jsonPrimitive?.content, "goal 动作应为 pause")
        assertEquals(
            "sess_forked_fake",
            goalParams["sessionId"]?.jsonPrimitive?.content,
            "pause 目标必须是 fork 出的新会话",
        )
        val unsubParams = unsub[0]["params"]!!.jsonObject
        assertEquals(
            "sub-1",
            unsubParams["subscriptionId"]?.jsonPrimitive?.content,
            "退订参数必须带 subscriptionId（subscribe ack 携带；缺任一必填项恒 -32603，diag-fork20 二分实测）",
        )
        assertEquals(
            "conversation/sess_parent_fake",
            unsubParams["topic"]?.jsonPrimitive?.content,
            "退订参数三件套：topic 也必填",
        )
        assertTrue(unsubParams["connectionId"] != null, "退订参数三件套：connectionId 也必填")
        val first = commands[0]["envelope"]!!.jsonObject
        val second = commands[1]["envelope"]!!.jsonObject
        assertEquals(0, first["baseRevision"]!!.jsonPrimitive.content.toInt(), "首发 CAS baseRevision=0")
        assertEquals(11, second["baseRevision"]!!.jsonPrimitive.content.toInt(), "重试应携带 revisionAtDecision=11")
        assertEquals("epoch-1", second["baseLogEpoch"]!!.jsonPrimitive.content, "baseLogEpoch 应来自 subscribe ack")
        assertEquals("forkAssistant", second["type"]!!.jsonPrimitive.content)
        assertEquals("zcode-idea-plugin", second["clientId"]!!.jsonPrimitive.content)
        assertTrue(second["issuedAt"]!!.jsonPrimitive.longOrNull != null, "issuedAt 应为毫秒数")
        val target = second["payload"]!!.jsonObject["target"]!!.jsonObject
        assertEquals(7, target["rowId"]!!.jsonPrimitive.content.toInt(), "target.rowId 应选中 canFork 的 assistantText 行（而非同 entityId 的 reasoning 行）")
        assertEquals("msg_target", target["entityId"]!!.jsonPrimitive.content, "target.entityId 应为消息 id")
    }

    @Test
    fun `轮内第一段自动改选轮末段且 entityId 换算`() {
        val echoFile = tempDir.resolve("echo-multiseg.jsonl")
        startFakeClient("multisegment", echoFile).use { client ->
            val r = client.forkAssistantViaV4("sess_parent_fake", "msg_target")
            assertEquals("sess_forked_fake", r["forkedSessionId"]?.jsonPrimitive?.content, "轮内第一段应自动换算到轮末段分叉成功")
        }
        val commands = readEchoLines(echoFile).filter { it["envelope"] != null }
        val second = commands[1]["envelope"]!!.jsonObject
        val target = second["payload"]!!.jsonObject["target"]!!.jsonObject
        assertEquals(100, target["rowId"]!!.jsonPrimitive.content.toInt(), "target.rowId 应为轮末段（带 canFork）行")
        assertEquals("msg_final", target["entityId"]!!.jsonPrimitive.content, "target.entityId 必须用轮末段自己的 entityId（守卫校验 entityIdByRowId 匹配），不能用用户点的 messageId")
    }

    @Test
    fun `目标不在首页时按 beforeRowId 向前翻页定位`() {
        val echoFile = tempDir.resolve("echo-paged.jsonl")
        startFakeClient("paged", echoFile).use { client ->
            val r = client.forkAssistantViaV4("sess_parent_fake", "msg_target")
            assertEquals("sess_forked_fake", r["forkedSessionId"]?.jsonPrimitive?.content)
        }
        val rowRanges = readEchoLines(echoFile).filter { it["kind"]?.jsonPrimitive?.content == "rowsRange" }
        assertEquals(2, rowRanges.size, "应恰好两次 rowsRange（首页 + beforeRowId 翻页）")
        assertEquals(50, rowRanges[1]["beforeRowId"]!!.jsonPrimitive.content.toInt(), "翻页应携带首页最小 rowId 作为 beforeRowId")
    }

    @Test
    fun `整轮无 canFork 时报分叉点不可用`() {
        startFakeClient("notforkable", tempDir.resolve("echo-nf.jsonl")).use { client ->
            val e = assertFailsWith<ZCodeProtocolException>("整轮无 canFork 应抛分叉点不可用") {
                client.forkAssistantViaV4("sess_parent_fake", "msg_target")
            }
            assertTrue(e.message?.contains("分叉点不可用") == true, "文案应含「分叉点不可用」: ${e.message}")
        }
    }

    @Test
    fun `老版本 CLI 无 v4 面时报 -32601 且 code 可判`() {
        startFakeClient("oldcli", tempDir.resolve("echo-oldcli.jsonl")).use { client ->
            val e = assertFailsWith<ZCodeProtocolException>("无 v4 面应抛协议异常") {
                client.forkAssistantViaV4("sess_parent_fake", "msg_target")
            }
            assertEquals(-32601, e.code, "code 必须是 -32601（前端据此隐藏分叉入口）")
        }
    }

    @Test
    fun `窗口内无目标时抛那条消息`() {
        startFakeClient("missing", tempDir.resolve("echo-missing.jsonl")).use { client ->
            val e = assertFailsWith<ZCodeProtocolException>("目标缺失应抛协议异常") {
                client.forkAssistantViaV4("sess_parent_fake", "msg_target")
            }
            assertTrue(e.message?.contains("那条消息") == true, "文案应含「那条消息」: ${e.message}")
        }
    }
}
