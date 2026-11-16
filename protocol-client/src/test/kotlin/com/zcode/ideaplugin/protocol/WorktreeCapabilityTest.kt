package com.zcode.ideaplugin.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path
import kotlin.io.path.readText
import kotlin.io.path.writeText
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * worktree 能力探测（isWorktreeSupported）协议测试 —— 假 app-server 驱动。
 *
 * 门控信号 = `runtime/capabilities` 响应的 worktreeCwd 位（官方桌面端同款判据，
 * diag-worktree-capabilities.py 真机实证 0.17.1 空参即回）。覆盖：
 * 场景1（newcli）：worktreeCwd=true → true；
 * 场景2（oldcli）：老 CLI 无该方法（-32601）→ false；
 * 场景3（nocap）：响应缺 worktreeCwd 字段 → false（严格 ===true 判定）；
 * 场景4（缓存）：多次调用只发一次请求（client 实例级缓存，echo 计数断言）。
 */
class WorktreeCapabilityTest {

    @TempDir
    lateinit var tempDir: Path

    private fun newFakeServerJs(mode: String, echoFile: String): String = """
        import readline from 'node:readline';
        import fs from 'node:fs';
        if (process.argv.includes('--version')) {
            process.stdout.write('0.17.1\n');
            process.exit(0);
        }
        const mode = ${jsonPrimitive(mode)};
        const echoPath = ${jsonPrimitive(echoFile)};
        const rl = readline.createInterface({ input: process.stdin });
        let capsCalls = 0;
        rl.on('line', line => {
            let m; try { m = JSON.parse(line); } catch { return; }
            if (m.id === undefined || !m.method) return;
            if (m.method === 'runtime/capabilities') {
                capsCalls += 1;
                fs.appendFileSync(echoPath, JSON.stringify({ capsCalls }) + '\n');
                if (mode === 'oldcli') {
                    process.stdout.write(JSON.stringify({ id: m.id, error: { code: -32601, message: 'Method not found' } }) + '\n');
                } else if (mode === 'nocap') {
                    process.stdout.write(JSON.stringify({ id: m.id, result: { sessionLifecycleWorkspace: true } }) + '\n');
                } else {
                    process.stdout.write(JSON.stringify({ id: m.id, result: { sessionLifecycleWorkspace: true, worktreeCwd: true } }) + '\n');
                }
            } else {
                process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\n');
            }
        });
    """.trimIndent()

    private fun jsonPrimitive(path: String): String = "\"${path.replace('\\', '/')}\""

    private fun startFakeClient(mode: String, echoFile: Path): ZCodeProtocolClient {
        val script = tempDir.resolve("fake-app-server-wtcap-$mode.mjs")
            .also { it.writeText(newFakeServerJs(mode, echoFile.toString())) }
        return ZCodeProtocolClient.start(
            zcodePath = script,
            credentials = ZCodeCredentials("test-model", "http://127.0.0.1:9", "test-key")
        )
    }

    private fun capsCallCount(echoFile: Path): Int =
        echoFile.readText().trim().lines().filter { it.isNotBlank() }
            .map { Json.parseToJsonElement(it).jsonObject["capsCalls"]!!.toString().toInt() }
            .maxOrNull() ?: 0

    @Test
    fun `new cli worktreeCwd true`() {
        startFakeClient("newcli", tempDir.resolve("echo-newcli.jsonl")).use { client ->
            assertTrue(client.isWorktreeSupported(), "worktreeCwd=true 应判支持")
        }
    }

    @Test
    fun `old cli method missing returns false`() {
        startFakeClient("oldcli", tempDir.resolve("echo-oldcli.jsonl")).use { client ->
            assertEquals(false, client.isWorktreeSupported(), "老 CLI -32601 应 fail-soft 判不支持")
        }
    }

    @Test
    fun `missing worktreeCwd field returns false`() {
        startFakeClient("nocap", tempDir.resolve("echo-nocap.jsonl")).use { client ->
            assertEquals(false, client.isWorktreeSupported(), "缺 worktreeCwd 位应判不支持（严格 ===true）")
        }
    }

    @Test
    fun `probe cached per client instance`() {
        val echoFile = tempDir.resolve("echo-cache.jsonl")
        startFakeClient("newcli", echoFile).use { client ->
            assertTrue(client.isWorktreeSupported())
            assertTrue(client.isWorktreeSupported())
            assertTrue(client.isWorktreeSupported())
            assertEquals(1, capsCallCount(echoFile), "实例级缓存：多次调用只探一次")
        }
    }
}
