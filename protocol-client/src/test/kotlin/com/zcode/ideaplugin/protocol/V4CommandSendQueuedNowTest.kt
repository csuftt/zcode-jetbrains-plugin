package com.zcode.ideaplugin.protocol

import kotlinx.serialization.json.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path
import kotlin.io.path.writeText
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * v4 sendQueuedNow（缺陷FD 促发通道）回归测试 —— 假 app-server 驱动，无真实模型调用：
 *
 * 假服务器行为（对应真机 diag-fd-promote 实测的 CAS 形状）：
 *   - baseRevision != 7 → {status:'stale', reasonCode:'proto.staleRevision', revisionAtDecision:7}
 *   - baseRevision == 7 → {status:'accepted'}（并回显 payload.queueItemId 供信封断言）
 *   - noop 模式：恒 {status:'noop'}（条目不存在的新形态）
 *   - 老 CLI 模式：-32601 Method not found
 *
 * 场景1：CAS 舞蹈——首次 baseRevision=0 吃 stale，带 revisionAtDecision 重发 accepted；
 *        信封 type/payload.queueItemId/baseRevision/issuedAt 形状正确
 * 场景2：noop → IllegalStateException 且消息带 queue.itemMissing（Java 侧据此分类）
 * 场景3：老 CLI 无 v4 面 → ZCodeProtocolException code=-32601
 */
class V4CommandSendQueuedNowTest {

    @TempDir
    lateinit var tempDir: Path

    private fun newFakeServerJs(mode: String): String = """
        import readline from 'node:readline';
        const rl = readline.createInterface({ input: process.stdin });
        const mode = '$mode';
        rl.on('line', line => {
            let m; try { m = JSON.parse(line); } catch { return; }
            if (m.id === undefined || !m.method) return;
            if (m.method === 'v4/command') {
                const p = m.params || {};
                if (mode === 'old') {
                    process.stdout.write(JSON.stringify({ id: m.id, error: { code: -32601, message: 'Method not found' } }) + '\n');
                    return;
                }
                if (mode === 'noop') {
                    process.stdout.write(JSON.stringify({ id: m.id, result: { commandId: p.commandId, status: 'noop' } }) + '\n');
                    return;
                }
                // cas 模式：baseRevision!=7 回 stale（真机形状），==7 回 accepted
                if (p.baseRevision !== 7) {
                    process.stdout.write(JSON.stringify({ id: m.id, result: {
                        commandId: p.commandId, status: 'stale', reasonCode: 'proto.staleRevision', revisionAtDecision: 7
                    } }) + '\n');
                } else {
                    process.stdout.write(JSON.stringify({ id: m.id, result: {
                        commandId: p.commandId, status: 'accepted',
                        echoType: p.type, echoQueueItemId: (p.payload || {}).queueItemId,
                        echoBaseRevision: p.baseRevision,
                        hasIssuedAt: typeof p.issuedAt === 'number'
                    } }) + '\n');
                }
            } else {
                process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\n');
            }
        });
    """.trimIndent()

    private fun startFakeClient(mode: String): ZCodeProtocolClient {
        val script = tempDir.resolve("fake-app-server-$mode.mjs").also { it.writeText(newFakeServerJs(mode)) }
        return ZCodeProtocolClient.start(
            zcodePath = script,
            credentials = ZCodeCredentials("test-model", "http://127.0.0.1:9", "test-key")
        )
    }

    @Test
    fun `CAS 舞蹈 stale 后带 revisionAtDecision 重发 accepted，信封形状正确`() {
        startFakeClient("cas").use { client ->
            val r = client.sendQueuedNowViaV4("sess_fake", "queue_fd_1")
            assertEquals("accepted", r["status"]?.jsonPrimitive?.content, "重试后应答应为 accepted")
            assertEquals("sendQueuedNow", r["echoType"]?.jsonPrimitive?.content, "命令 type 必须是 sendQueuedNow")
            assertEquals("queue_fd_1", r["echoQueueItemId"]?.jsonPrimitive?.content, "queueItemId 应原样送达 payload")
            assertEquals("7", r["echoBaseRevision"]?.jsonPrimitive?.content, "重发必须带 revisionAtDecision 收敛值")
            assertEquals("true", r["hasIssuedAt"]?.jsonPrimitive?.content, "issuedAt 必填且为数字")
        }
    }

    @Test
    fun `条目不存在（noop）抛 queue_itemMissing 供 Java 侧分类`() {
        startFakeClient("noop").use { client ->
            val e = assertFailsWith<IllegalStateException>("noop 应抛 IllegalStateException") {
                client.sendQueuedNowViaV4("sess_fake", "queue_gone")
            }
            assertTrue(e.message?.contains("queue.itemMissing") == true, "异常消息须携带 queue.itemMissing 判据")
        }
    }

    @Test
    fun `老版本 CLI 无 v4 面时报 -32601 且 code 可判`() {
        startFakeClient("old").use { client ->
            val e = assertFailsWith<ZCodeProtocolException>("v4/command 不可用应抛协议异常") {
                client.sendQueuedNowViaV4("sess_fake", "queue_fd_1")
            }
            assertEquals(-32601, e.code, "错误码必须是 -32601，Java 侧走删除兜底")
        }
    }
}