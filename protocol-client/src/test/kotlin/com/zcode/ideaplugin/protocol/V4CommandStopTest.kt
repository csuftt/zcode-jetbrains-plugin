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
 * V4 stop 升级通道（缺陷AD重审）回归测试 —— 假 app-server 驱动，无真实模型调用：
 *
 * 假服务器行为：
 *   - v4/command → 回显信封关键字段 + status:accepted（新 CLI 形态）
 *   - 老版本 CLI 形态：v4/command → 回 -32601 Method not found
 *   - 其余方法 → 回空 result
 *
 * 场景1：stopForegroundViaV4 信封形状正确（type=stop / sessionId / commandId / issuedAt / clientMode）
 * 场景2：老 CLI 报 -32601 时抛 ZCodeProtocolException 且 code 可判（面板据此识别"无需升级"）
 */
class V4CommandStopTest {

    @TempDir
    lateinit var tempDir: Path

    private fun newFakeServerJs(supportsV4: Boolean): String = """
        import readline from 'node:readline';
        const rl = readline.createInterface({ input: process.stdin });
        rl.on('line', line => {
            let m; try { m = JSON.parse(line); } catch { return; }
            if (m.id === undefined || !m.method) return;
            if (m.method === 'v4/command') {
                ${if (supportsV4) """
                const p = m.params || {};
                process.stdout.write(JSON.stringify({ id: m.id, result: {
                    commandId: p.commandId, status: 'accepted', revisionAtDecision: 7,
                    echoType: p.type, echoSessionId: p.sessionId, echoClientMode: p.clientMode,
                    echoPayloadEmpty: p.payload !== undefined && Object.keys(p.payload).length === 0,
                    hasCommandId: typeof p.commandId === 'string' && p.commandId.length > 0,
                    hasIssuedAt: typeof p.issuedAt === 'number'
                } }) + '\n');
                """ else """
                process.stdout.write(JSON.stringify({ id: m.id, error: { code: -32601, message: 'Method not found' } }) + '\n');
                """}
            } else {
                process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\n');
            }
        });
    """.trimIndent()

    private fun startFakeClient(supportsV4: Boolean): ZCodeProtocolClient {
        val script = tempDir.resolve("fake-app-server-${if (supportsV4) "v4" else "old"}.mjs")
            .also { it.writeText(newFakeServerJs(supportsV4)) }
        return ZCodeProtocolClient.start(
            zcodePath = script,
            credentials = ZCodeCredentials("test-model", "http://127.0.0.1:9", "test-key")
        )
    }

    @Test
    fun `v4 stop 信封形状正确且应答可解析`() {
        startFakeClient(supportsV4 = true).use { client ->
            val r = client.stopForegroundViaV4("sess_fake")
            assertEquals("accepted", r["status"]?.jsonPrimitive?.content, "应答应为 accepted")
            assertEquals("stop", r["echoType"]?.jsonPrimitive?.content, "命令 type 必须是 stop")
            assertEquals("sess_fake", r["echoSessionId"]?.jsonPrimitive?.content, "sessionId 应原样送达")
            assertEquals("desktop-continuous", r["echoClientMode"]?.jsonPrimitive?.content, "clientMode 固定 desktop-continuous")
            assertEquals("true", r["hasCommandId"]?.jsonPrimitive?.content, "commandId 必填且非空")
            assertEquals("true", r["hasIssuedAt"]?.jsonPrimitive?.content, "issuedAt 必填且为数字")
            assertEquals("true", r["echoPayloadEmpty"]?.jsonPrimitive?.content, "payload 应为空对象")
        }
    }

    @Test
    fun `老版本 CLI 无 v4 面时报 -32601 且 code 可判`() {
        startFakeClient(supportsV4 = false).use { client ->
            val e = assertFailsWith<ZCodeProtocolException>("v4/command 不可用应抛协议异常") {
                client.stopForegroundViaV4("sess_fake")
            }
            assertEquals(-32601, e.code, "错误码必须是 -32601（Method not found），面板据此识别老 CLI 无需升级")
            assertTrue(e.message?.contains("32601") == true, "异常消息应携带错误码")
        }
    }
}
