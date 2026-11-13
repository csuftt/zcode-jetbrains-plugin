package com.zcode.ideaplugin.protocol

import kotlinx.serialization.json.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path
import kotlin.io.path.writeText
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * session/messages 消息形态归一（桌面端 3.18.0 / CLI 0.17.1 适配）协议测试 —— 假 app-server 驱动。
 *
 * 锁定 2026-11-11 diag-part-key-inventory 实测的形态断裂：
 * - info：`id`→`messageId`、`sessionID`→`sessionId`（webview 按旧键读，id 缺失即
 *   findEditableUserMessage 未捕获 TypeError → React 树卸载 → 内容区黑屏）
 * - tool part：`callID`→`callId`（后台任务匹配/CUA 截图回填按旧键读）
 * - 只补缺不覆盖：旧形态消息带真 id 时原样透传，不得被新键值顶替
 * - 非法形状（无 info）原样保留，不抛
 *
 * 完整键名普查与修复决策见 docs/internal/bugs-regressions/ 缺陷HA。
 */
class SessionMessagesShapeCompatTest {

    @TempDir
    lateinit var tempDir: Path

    /** 新旧形态混合的 session/messages 应答（3.18.0 真机抓包形态） */
    private fun newFakeServerJs(): String = """
        import readline from 'node:readline';
        if (process.argv.includes('--version')) {
            process.stdout.write('0.17.1\n');
            process.exit(0);
        }
        const rl = readline.createInterface({ input: process.stdin });
        rl.on('line', line => {
            let m; try { m = JSON.parse(line); } catch { return; }
            if (m.id === undefined || !m.method) return;
            if (m.method === 'session/messages') {
                process.stdout.write(JSON.stringify({ id: m.id, result: { messages: [
                    // 新形态 user 消息：messageId/sessionId，无 id/sessionID
                    { info: { role: 'user', messageId: 'msg_new_1', sessionId: 'sess_x' },
                      parts: [{ type: 'text', text: 'hi', messageId: 'msg_new_1', partId: 'part_1', sessionId: 'sess_x' }] },
                    // 新形态 assistant 带 tool part：callId 无 callID
                    { info: { role: 'assistant', messageId: 'msg_new_2', sessionId: 'sess_x', parentMessageId: 'msg_new_1' },
                      parts: [
                        { type: 'tool', tool: 'Bash', callId: 'call_a', state: { status: 'completed', output: 'ok' } },
                        { type: 'tool', tool: 'Read', callID: 'call_old_present', callId: 'call_b', state: { status: 'completed' } }
                      ] },
                    // 旧形态消息：id 已在，必须原样透传（不被 messageId 顶替）
                    { info: { role: 'user', id: 'msg_old_1', sessionID: 'sess_old' }, parts: [] },
                    // 无 info 的非法元素：原样保留
                    { broken: true }
                ] } }) + '\n');
            } else {
                process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\n');
            }
        });
    """.trimIndent()

    private fun startClient(): ZCodeProtocolClient {
        val script = tempDir.resolve("fake-app-server-msgshape.mjs").also { it.writeText(newFakeServerJs()) }
        return ZCodeProtocolClient.start(
            zcodePath = script,
            credentials = ZCodeCredentials("test-model", "http://127.0.0.1:9", "test-key")
        )
    }

    @Test
    fun `新形态消息补 id 与 sessionID 别名`() {
        val client = startClient()
        try {
            val messages = client.messages("sess_x")
            assertEquals(4, messages.size)
            val user = messages[0].jsonObject
            val info = user["info"]!!.jsonObject
            assertEquals("msg_new_1", info["id"]!!.jsonPrimitive.content, "id 必须从 messageId 回填")
            assertEquals("sess_x", info["sessionID"]!!.jsonPrimitive.content, "sessionID 必须从 sessionId 回填")
            assertEquals("msg_new_1", info["messageId"]!!.jsonPrimitive.content, "新键保留（只补缺不删源）")
            // parts 不动 text part
            val textPart = user["parts"]!!.jsonArray[0].jsonObject
            assertEquals("hi", textPart["text"]!!.jsonPrimitive.content)
            assertNull(textPart["callID"])
        } finally {
            client.close()
        }
    }

    @Test
    fun `tool part 的 callId 回填 callID 且已有 callID 不覆盖`() {
        val client = startClient()
        try {
            val messages = client.messages("sess_x")
            val parts = messages[1].jsonObject["parts"]!!.jsonArray
            val bash = parts[0].jsonObject
            assertEquals("call_a", bash["callID"]!!.jsonPrimitive.content, "callID 必须从 callId 回填")
            assertEquals("call_a", bash["callId"]!!.jsonPrimitive.content)
            val read = parts[1].jsonObject
            assertEquals("call_old_present", read["callID"]!!.jsonPrimitive.content, "已有 callID 不得被 callId 覆盖")
        } finally {
            client.close()
        }
    }

    @Test
    fun `旧形态消息与非法元素原样透传`() {
        val client = startClient()
        try {
            val messages = client.messages("sess_x")
            val oldInfo = messages[2].jsonObject["info"]!!.jsonObject
            assertEquals("msg_old_1", oldInfo["id"]!!.jsonPrimitive.content, "旧形态 id 不被覆盖")
            assertEquals("sess_old", oldInfo["sessionID"]!!.jsonPrimitive.content)
            assertNull(oldInfo["messageId"])
            assertTrue(messages[3].jsonObject.containsKey("broken"), "无 info 元素原样保留")
        } finally {
            client.close()
        }
    }

    @Test
    fun `纯函数直通性：旧形态数组零拷贝返回`() {
        val arr = JsonArray(listOf(
            buildJsonObject {
                putJsonObject("info") {
                    put("role", JsonPrimitive("user"))
                    put("id", JsonPrimitive("msg_a"))
                    put("sessionID", JsonPrimitive("sess_a"))
                }
                put("parts", JsonArray(emptyList()))
            }
        ))
        val out = ZCodeProtocolClient.normalizeLegacyMessageShape(arr)
        assertTrue(out === arr, "旧形态应零改动直通（同引用），不做无谓重建")
    }
}
