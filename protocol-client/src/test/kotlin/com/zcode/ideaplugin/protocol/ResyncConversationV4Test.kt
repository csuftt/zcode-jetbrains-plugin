package com.zcode.ideaplugin.protocol

import kotlinx.serialization.json.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path
import kotlin.io.path.writeText
import kotlin.io.path.readText
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * v4/conversation/resync 出参形状回归锁 —— 假 app-server 驱动。
 *
 * 缺陷FV 二轮（2026-11-04 手机 HAR #351 实锤）：resync 的 zod schema 是 strict 的，
 * 顶层 workspace 键直接 -32603 unrecognized_keys——此前把 subscribe 的 workspace
 * {workspacePath, workspaceKey} 形态照搬进 resync，官方 H5 恢复链必死=点大会话恒
 * 「重新连接」。本测试钉死：出参恒不含 workspace 键；同订阅语义 ack 原样回传。
 */
class ResyncConversationV4Test {

    @TempDir
    lateinit var tempDir: Path

    private fun newFakeServerJs(echoFile: String): String = """
        import readline from 'node:readline';
        import fs from 'node:fs';
        const echoPath = ${"\"$echoFile\""};
        const rl = readline.createInterface({ input: process.stdin });
        rl.on('line', line => {
            let m; try { m = JSON.parse(line); } catch { return; }
            if (m.id === undefined || !m.method) return;
            if (m.method === 'v4/conversation/resync') {
                fs.appendFileSync(echoPath, JSON.stringify({ params: m.params || {} }) + '\n');
                process.stdout.write(JSON.stringify({ id: m.id, result: { ack: { subscriptionId: m.params.subscriptionId, logEpoch: 'epoch-1' } } }) + '\n');
            } else {
                process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\n');
            }
        });
    """.trimIndent()

    @Test
    fun `resync 出参不含 workspace 键且 ack 原样回传`() {
        val echoFile = tempDir.resolve("echo-resync.jsonl")
        val script = tempDir.resolve("fake-app-server-resync.mjs")
            .also { it.writeText(newFakeServerJs(echoFile.toString().replace('\\', '/'))) }
        ZCodeProtocolClient.start(
            zcodePath = script,
            credentials = ZCodeCredentials("test-model", "http://127.0.0.1:9", "test-key")
        ).use { client ->
            val r = client.v4ConversationResync("conversation/sess_fake", "sub-mw22he9t-1", "conn-1")
            assertEquals("sub-mw22he9t-1", r["ack"]?.jsonObject?.get("subscriptionId")?.jsonPrimitive?.content)
        }
        val lines = echoFile.readText().trim().lines()
            .map { Json.parseToJsonElement(it).jsonObject["params"]!!.jsonObject }
        assertEquals(1, lines.size)
        val params = lines[0]
        assertEquals("conversation/sess_fake", params["topic"]?.jsonPrimitive?.content)
        assertEquals("sub-mw22he9t-1", params["subscriptionId"]?.jsonPrimitive?.content)
        assertEquals("conn-1", params["connectionId"]?.jsonPrimitive?.content)
        assertTrue(params["forceSnapshot"]?.jsonPrimitive?.booleanOrNull == true, "forceSnapshot 默认 true")
        assertTrue(params.containsKey("base"), "base 必须显式携带（null=放弃增量水位）")
        assertTrue(params["base"] is JsonNull, "base=null 形态")
        assertTrue(!params.containsKey("workspace"), "resync 不得携带 workspace 键（zod strict 拒收，缺陷FV）")
    }
}
