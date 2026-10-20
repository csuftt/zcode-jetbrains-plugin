package com.zcode.ideaplugin.protocol

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path
import kotlin.io.path.exists
import kotlin.io.path.readText
import kotlin.io.path.writeText
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * session/list includeArchived 版本门控回归（CLI 0.17.0 起该参数被 strict schema 删除，
 * 发了即 -32602 Unrecognized key，启动首个 listSessions 直接失败）。
 *
 * - 纯函数：版本判定边界（含 0.16.10 数值比较、prerelease、探测失败默认值）
 * - 假 app-server：0.17.0 探测命中时绝不发送 key；探测失败时被 -32602 拒绝后去 key 重试
 */
class SessionListVersionGateTest {

    @TempDir
    lateinit var tempDir: Path

    // ---------- 纯版本判定 ----------

    @Test
    fun `旧版本支持 includeArchived`() {
        assertTrue(ZCodeProtocolClient.supportsIncludeArchivedParam("0.16.3"))
        assertTrue(ZCodeProtocolClient.supportsIncludeArchivedParam("0.16.9"))
        // 数值比较：0.16.10 不得按字符串排在 0.17.0 之后
        assertTrue(ZCodeProtocolClient.supportsIncludeArchivedParam("0.16.10"))
    }

    @Test
    fun `0_17_0 起不支持（含 prerelease 与更高版本）`() {
        assertFalse(ZCodeProtocolClient.supportsIncludeArchivedParam("0.17.0"))
        assertFalse(ZCodeProtocolClient.supportsIncludeArchivedParam("0.17.0-beta.1"))
        assertFalse(ZCodeProtocolClient.supportsIncludeArchivedParam("0.17.2"))
        assertFalse(ZCodeProtocolClient.supportsIncludeArchivedParam("1.0.0"))
    }

    @Test
    fun `探测失败或不可解析按支持处理（交运行时 -32602 自愈）`() {
        assertTrue(ZCodeProtocolClient.supportsIncludeArchivedParam(null))
        assertTrue(ZCodeProtocolClient.supportsIncludeArchivedParam(""))
        assertTrue(ZCodeProtocolClient.supportsIncludeArchivedParam("unknown"))
    }

    // ---------- 假 app-server 端到端 ----------

    /**
     * 假服务器：--version 时输出 [versionOutput] 退出；app-server 模式下对携带
     * includeArchived 的 session/list 回 -32602（模拟 0.17.0 strict schema），
     * 其余 session/list 回一条固定会话；拒绝次数追加到 rejectCountFile（JS 用正斜杠路径）。
     */
    private fun fakeServerJs(versionOutput: String, rejectCountFile: Path): String {
        val counterPath = rejectCountFile.toString().replace('\\', '/')
        val versionLine = if (versionOutput.isBlank()) "" else
            "process.stdout.write(${jsString(versionOutput)} + '\\n');"
        return """
            import readline from 'node:readline';
            import fs from 'node:fs';
            if (process.argv.includes('--version')) {
                $versionLine
                process.exit(0);
            }
            const counter = ${jsString(counterPath)};
            const rl = readline.createInterface({ input: process.stdin });
            rl.on('line', line => {
                let m; try { m = JSON.parse(line); } catch { return; }
                if (m.id === undefined || !m.method) return;
                const p = m.params || {};
                if (m.method === 'session/list' && Object.prototype.hasOwnProperty.call(p, 'includeArchived')) {
                    try { fs.appendFileSync(counter, 'x'); } catch {}
                    process.stdout.write(JSON.stringify({
                        id: m.id,
                        error: { code: -32602, message: 'Invalid params - (root): Unrecognized key: "includeArchived"' }
                    }) + '\n');
                    return;
                }
                process.stdout.write(JSON.stringify({
                    id: m.id,
                    result: { sessions: [{ sessionId: 's1', title: 'archived-or-live' }] }
                }) + '\n');
            });
        """.trimIndent()
    }

    /** Kotlin 字符串 → JS 单引号字符串字面量 */
    private fun jsString(s: String): String =
        "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"

    private fun startFake(scriptName: String, versionOutput: String, rejectCountFile: Path): ZCodeProtocolClient {
        val script = tempDir.resolve(scriptName).also { it.writeText(fakeServerJs(versionOutput, rejectCountFile)) }
        return ZCodeProtocolClient.start(
            zcodePath = script,
            credentials = ZCodeCredentials("test-model", "http://127.0.0.1:9", "test-key"),
        )
    }

    @Test
    fun `探测到 0_17_0 时不带 includeArchived 一次成功`() {
        val counter = tempDir.resolve("reject-new.log")
        startFake("fake-017.mjs", "0.17.0", counter).use { client ->
            assertEquals("0.17.0", client.appVersion)
            val sessions = client.listSessions(workspacePath = null, includeArchived = true, limit = 1)
            assertEquals(1, sessions.size)
            assertEquals("s1", sessions.first().sessionId)
        }
        assertFalse(counter.exists(), "0.17.0 门控命中，绝不应发送 includeArchived")
    }

    @Test
    fun `版本探测失败时被 -32602 拒绝后去 key 重试且进程内记忆`() {
        val counter = tempDir.resolve("reject-unknown.log")
        startFake("fake-unknown.mjs", "garbage-output", counter).use { client ->
            assertEquals(null, client.appVersion)
            val first = client.listSessions(workspacePath = null, includeArchived = true, limit = 1)
            assertEquals(1, first.size, "拒绝后自动去 key 重试，调用方无感")
            client.listSessions(workspacePath = null, includeArchived = true, limit = 1)
        }
        // 仅首次调用被拒一次；记忆后第二次直接发无 key 形态
        assertEquals(1, counter.readText().length, "应只拒绝一次，后续请求复用记忆")
    }
}
