package com.zcode.ideaplugin.protocol

import kotlinx.serialization.json.*
import com.zcode.ideaplugin.protocol.model.V4AttachmentRef
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path
import kotlin.io.path.writeText
import kotlin.io.path.readText
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * 编辑用户消息（v4/command editUserQuery，官方桌面客户端同款通道）协议测试 —— 假 app-server 驱动，无真实模型调用。
 *
 * 锁定 diag-edit-v4 实测定案的行为：
 * - 链路与 fork 同构：subscribe 取 logEpoch → rowsRange 定位 userInput 行（entityId ==
 *   legacy 消息 id 且 actions.canEdit==true）→ v4/command CAS（stale → revisionAtDecision 重试）
 * - 附件：ref 引用形态 {ref,fileName,mime,bytes}（schema qB strict），null=不带字段
 *   （服务端沿用原附件）/ 空列表=显式清空；回显文件断言第二次命令信封
 * - 行存在但 canEdit!=true（已非最新可编辑消息）→ 抛「只能编辑最后一轮」
 * - 老 CLI 无 v4 面（subscribe -32601）→ code=-32601（前端回退 legacy /rewind 编排）
 * - 窗口内无目标行 → 抛「那条消息」
 *
 * 协议细节见 docs/internal/design-research/编辑历史消息v4通道-2026-09-12.md。
 */
class EditUserQueryTest {

    @TempDir
    lateinit var tempDir: Path

    private fun newFakeServerJs(mode: String, echoFile: String): String = """
        import readline from 'node:readline';
        import fs from 'node:fs';
        if (process.argv.includes('--version')) {
            process.stdout.write('0.16.5\n');
            process.exit(0);
        }
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
                    process.stdout.write(JSON.stringify({ id: m.id, result: { rows: [{ rowId: 2, turnId: 'turn_x', entityId: 'msg_other', kind: 'userInput' }] } }) + '\n');
                } else if (mode === 'noteditable') {
                    // 目标行存在但已非最新可编辑消息（canEdit 被服务端投影收回）；
                    // hasMore=true 模拟大会话——entityId 命中后客户端必须短路，不再翻页
                    process.stdout.write(JSON.stringify({ id: m.id, result: { rows: [
                        { rowId: 2, turnId: 'turn_a', entityId: 'msg_target', kind: 'userInput', text: 'old' },
                        { rowId: 9, turnId: 'turn_b', entityId: 'msg_newer', kind: 'userInput', actions: { canEdit: true, editDisposition: 'rewind' }, text: 'new' }
                    ], hasMore: true } }) + '\n');
                } else if (mode === 'paged' && rowsRangeCalls === 1) {
                    // 目标行在更老端（翻页先遇到大 rowId，beforeRowId 向前翻）
                    process.stdout.write(JSON.stringify({ id: m.id, result: { rows: [
                        { rowId: 50, turnId: 'turn_b', entityId: 'msg_newer', kind: 'userInput', actions: { canEdit: true } }
                    ], hasMore: true } }) + '\n');
                } else if (mode === 'paged') {
                    process.stdout.write(JSON.stringify({ id: m.id, result: { rows: [
                        { rowId: 5, turnId: 'turn_a', entityId: 'msg_target', kind: 'userInput', actions: { canEdit: true }, text: '原始消息' }
                    ], hasMore: false } }) + '\n');
                } else {
                    // 回归锁：userInput 行的 canEdit 落在 actions；assistantText 行不作目标
                    process.stdout.write(JSON.stringify({ id: m.id, result: { rows: [
                        { rowId: 7, turnId: 'turn_a', entityId: 'msg_assist', kind: 'assistantText', state: 'complete', actions: { canFork: true } },
                        { rowId: 5, turnId: 'turn_a', entityId: 'msg_target', kind: 'userInput', actions: { canEdit: true, editDisposition: 'rewind' }, text: '原始消息' }
                    ] } }) + '\n');
                }
            } else if (m.method === 'v4/conversation/unsubscribe') {
                fs.appendFileSync(echoPath, JSON.stringify({ kind: 'unsubscribe', params: p }) + '\n');
                process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\n');
            } else if (m.method === 'v4/command') {
                commandCalls += 1;
                fs.appendFileSync(echoPath, JSON.stringify({ call: commandCalls, envelope: p }) + '\n');
                if (p.type !== 'editUserQuery') {
                    process.stdout.write(JSON.stringify({ id: m.id, result: { status: 'rejected', reasonCode: 'proto.invalidType' } }) + '\n');
                } else if (commandCalls === 1 && mode !== 'paged') {
                    process.stdout.write(JSON.stringify({ id: m.id, result: { commandId: p.commandId, status: 'stale', reasonCode: 'proto.staleRevision', revisionAtDecision: 21 } }) + '\n');
                } else {
                    process.stdout.write(JSON.stringify({ id: m.id, result: { commandId: p.commandId, status: 'accepted',
                        result: { type: 'editUserQuery', disposition: 'rewind', sessionId: 'sess_fake' } } }) + '\n');
                }
            } else {
                process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\n');
            }
        });
    """.trimIndent()

    private fun jsonPrimitive(path: String): String = "\"${path.replace('\\', '/')}\""

    private fun startFakeClient(mode: String, echoFile: Path): ZCodeProtocolClient {
        val script = tempDir.resolve("fake-app-server-edit-$mode.mjs")
            .also { it.writeText(newFakeServerJs(mode, echoFile.toString())) }
        return ZCodeProtocolClient.start(
            zcodePath = script,
            credentials = ZCodeCredentials("test-model", "http://127.0.0.1:9", "test-key")
        )
    }

    private fun readEchoLines(echoFile: Path): List<JsonObject> =
        echoFile.readText().trim().lines().map { Json.parseToJsonElement(it).jsonObject }

    @Test
    fun `全链路编排正确且 CAS 重试信封正确`() {
        val echoFile = tempDir.resolve("echo-ok.jsonl")
        startFakeClient("ok", echoFile).use { client ->
            val r = client.editUserQueryViaV4("sess_fake", "msg_target", "编辑后的消息")
            assertEquals("accepted", r["status"]?.jsonPrimitive?.content)
            assertEquals("rewind", r["result"]?.jsonObject?.get("disposition")?.jsonPrimitive?.content)
            // 临时订阅不得污染帧映射白名单（diag-fork19 同款约束）
            assertEquals(false, client.isConversationV4Subscribed("sess_fake"))
        }
        val lines = readEchoLines(echoFile)
        val commands = lines.filter { it["envelope"] != null }
        assertEquals(2, commands.size, "应恰好两次 editUserQuery 命令（stale → 重试）")
        val unsub = lines.filter { it["kind"]?.jsonPrimitive?.content == "unsubscribe" }
        assertEquals(1, unsub.size, "应恰好一次退订（临时订阅收尾）")
        val first = commands[0]["envelope"]!!.jsonObject
        val second = commands[1]["envelope"]!!.jsonObject
        assertEquals(0, first["baseRevision"]!!.jsonPrimitive.content.toInt(), "首发 CAS baseRevision=0")
        assertEquals(21, second["baseRevision"]!!.jsonPrimitive.content.toInt(), "重试应携带 revisionAtDecision=21")
        assertEquals("epoch-1", second["baseLogEpoch"]!!.jsonPrimitive.content, "baseLogEpoch 应来自 subscribe ack")
        assertEquals("editUserQuery", second["type"]!!.jsonPrimitive.content)
        assertEquals("zcode-idea-plugin", second["clientId"]!!.jsonPrimitive.content)
        assertTrue(second["issuedAt"]!!.jsonPrimitive.longOrNull != null, "issuedAt 应为毫秒数")
        assertNull(second["payload"]!!.jsonObject["attachments"], "attachments=null 时信封不带该字段（服务端沿用原附件）")
        val target = second["payload"]!!.jsonObject["target"]!!.jsonObject
        assertEquals(5, target["rowId"]!!.jsonPrimitive.content.toInt(), "target.rowId 应选中带 canEdit 的 userInput 行")
        assertEquals("msg_target", target["entityId"]!!.jsonPrimitive.content)
        assertEquals("编辑后的消息", second["payload"]!!.jsonObject["newText"]?.jsonPrimitive?.content)
    }

    @Test
    fun `附件以 ref 引用形态序列化且空列表显式透传`() {
        val echoFile = tempDir.resolve("echo-att.jsonl")
        startFakeClient("ok", echoFile).use { client ->
            client.editUserQueryViaV4(
                "sess_fake", "msg_target", "看图（改）",
                listOf(V4AttachmentRef(ref = "C:\\cache\\image-x.png", fileName = "shot.png", mime = "image/png", bytes = 74)),
            )
            client.editUserQueryViaV4("sess_fake", "msg_target", "删光图片", emptyList())
        }
        val commands = readEchoLines(echoFile).filter { it["envelope"] != null }
        val att = commands[1]["envelope"]!!.jsonObject["payload"]!!.jsonObject["attachments"]!!.jsonArray
        assertEquals(1, att.size)
        val a = att[0].jsonObject
        assertEquals("C:\\cache\\image-x.png", a["ref"]?.jsonPrimitive?.content)
        assertEquals("shot.png", a["fileName"]?.jsonPrimitive?.content)
        assertEquals("image/png", a["mime"]?.jsonPrimitive?.content)
        assertEquals(74, a["bytes"]?.jsonPrimitive?.content?.toInt())
        assertEquals(4, a.size, "schema qB strict：恰好 ref/fileName/mime/bytes 四字段")
        // 空列表 = 显式清空附件（不能塌缩成"不带字段"）；第二次调用首发即 accepted，
        // commands[2] 是它的唯一命令信封
        val empty = commands[2]["envelope"]!!.jsonObject["payload"]!!.jsonObject["attachments"]!!.jsonArray
        assertEquals(0, empty.size)
    }

    @Test
    fun `目标行不在首页时按 beforeRowId 向前翻页定位`() {
        val echoFile = tempDir.resolve("echo-paged.jsonl")
        startFakeClient("paged", echoFile).use { client ->
            client.editUserQueryViaV4("sess_fake", "msg_target", "编辑后的消息")
        }
        val lines = readEchoLines(echoFile)
        val rowRanges = lines.filter { it["kind"]?.jsonPrimitive?.content == "rowsRange" }
        assertEquals(2, rowRanges.size, "应恰好两次 rowsRange（首页 + beforeRowId 翻页）")
        val commands = lines.filter { it["envelope"] != null }
        assertEquals(1, commands.size, "paged 模式首发即 accepted（假服务端仅一次 stale 注入）")
        val target = commands[0]["envelope"]!!.jsonObject["payload"]!!.jsonObject["target"]!!.jsonObject
        assertEquals("msg_target", target["entityId"]!!.jsonPrimitive.content, "翻页后应定位到目标行")
    }

    @Test
    fun `行存在但已非最新可编辑时报只能编辑最后一轮`() {
        startFakeClient("noteditable", tempDir.resolve("echo-ne.jsonl")).use { client ->
            val e = assertFailsWith<ZCodeProtocolException>("canEdit 缺失应抛守卫异常") {
                client.editUserQueryViaV4("sess_fake", "msg_target", "编辑后的消息")
            }
            assertTrue(e.message?.contains("只能编辑最后一轮") == true, "文案应含「只能编辑最后一轮」: ${e.message}")
            // 2026-09-13 review：①机器码供前端映射 i18n（文案不进协议层）；②entityId
            // 命中后必须短路——fake hasMore=true，翻页会拉出第 2 次 rowsRange
            assertEquals("notLatestUserMessage", e.reason, "应携带机器可读 reason 码")
            assertEquals(
                1,
                readEchoLines(tempDir.resolve("echo-ne.jsonl")).count { it["kind"]?.jsonPrimitive?.content == "rowsRange" },
                "canEdit 守卫命中后应停止翻页（只发一次 rowsRange）",
            )
        }
    }

    @Test
    fun `老版本 CLI 无 v4 面时报 -32601 且 code 可判`() {
        startFakeClient("oldcli", tempDir.resolve("echo-oldcli.jsonl")).use { client ->
            val e = assertFailsWith<ZCodeProtocolException>("无 v4 面应抛协议异常") {
                client.editUserQueryViaV4("sess_fake", "msg_target", "编辑后的消息")
            }
            assertEquals(-32601, e.code, "code 必须是 -32601（前端据此回退 legacy /rewind 编排）")
        }
    }

    @Test
    fun `窗口内无目标行时抛 EditTargetGoneException（降级信号非报错）`() {
        // 2026-09-12 用户三轮反馈一：会话级行流缺失（rowsRange 无目标行，连 send 都
        // 不产生行流）时 v4 编辑必然找不到行——抛专用异常让 handler 回 editUnsupported
        // (reason=targetGone)，前端本次降级 legacy，不再以「原对话已不包含那条消息」
        // 报错收场
        startFakeClient("missing", tempDir.resolve("echo-missing.jsonl")).use { client ->
            val e = assertFailsWith<EditTargetGoneException>("目标缺失应抛降级专用异常") {
                client.editUserQueryViaV4("sess_fake", "msg_target", "编辑后的消息")
            }
            assertTrue(e.message?.contains("那条消息") == true, "文案应含「那条消息」: ${e.message}")
        }
    }
}
