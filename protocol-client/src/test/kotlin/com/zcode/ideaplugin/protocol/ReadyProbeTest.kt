package com.zcode.ideaplugin.protocol

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.IOException
import java.nio.file.Path
import kotlin.io.path.writeText
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * start() 就绪探测回归测试（issue #11 崩溃循环）—— 假 app-server 驱动，无真实 CLI：
 *
 * 背景：start() 此前起进程即返回，首个业务请求独自承担 node 冷启动等待；非幂等方法
 * （session/create）禁止超时重试，慢启动一次撞墙就直接报错，且报错会被前端误套
 * "会话恢复中请勿重启"指引。现在 start() 内同步等一个轻量响应（awaitReady），
 * 保证返回的 client 必然已就绪。
 *
 * 假服务器行为（按 delayMs 分档写不同脚本——start() 清空并重建子进程 env，
 * 无法经环境变量传参）：
 *   - delay=0：收到请求立即回 result
 *   - delay=1200：模拟冷启动（bundle 解析 + 杀软扫描）
 *   - delay=5000：模拟"活着但不响应"，配合短探测超时
 *   - crash：起进程即 exit(1)，模拟 CLI 崩溃 / node 版本不兼容秒退
 */
class ReadyProbeTest {

    @TempDir
    lateinit var tempDir: Path

    private fun fakeServerJs(delayMs: Long): String = """
        import readline from 'node:readline';
        if (process.argv.includes('--version')) {
            process.stdout.write('0.16.5\n');
            process.exit(0);
        }
        const rl = readline.createInterface({ input: process.stdin });
        rl.on('line', line => {
            let m; try { m = JSON.parse(line); } catch { return; }
            if (m.id === undefined || !m.method) return;
            setTimeout(() => {
                process.stdout.write(JSON.stringify({ id: m.id, result: { sessions: [] } }) + '\n');
            }, $delayMs);
        });
    """.trimIndent()

    private fun startFake(delayMs: Long, readyTimeoutMs: Long = 30_000): ZCodeProtocolClient {
        val script = tempDir.resolve("fake-ready-$delayMs.mjs").also { it.writeText(fakeServerJs(delayMs)) }
        return ZCodeProtocolClient.start(
            zcodePath = script,
            credentials = ZCodeCredentials("test-model", "http://127.0.0.1:9", "test-key"),
            readyTimeoutMs = readyTimeoutMs,
        )
    }

    @Test
    fun `立即响应的假服务 - start 成功且返回就绪的 client`() {
        startFake(delayMs = 0).use { client ->
            assertTrue(client.isAlive(), "探测通过后进程应存活")
            // 探测后业务请求照常可用（探测请求与业务请求 id 路由互不串扰）
            val sessions = client.listSessions(workspacePath = null, limit = 1)
            assertTrue(sessions.isEmpty(), "假服务固定回空列表")
        }
    }

    @Test
    fun `冷启动延迟 1_2 秒的假服务 - 宽松探测超时下 start 等待后成功`() {
        startFake(delayMs = 1200, readyTimeoutMs = 8000).use { client ->
            assertTrue(client.isAlive(), "慢而活：探测等到响应，不应误杀")
        }
    }

    @Test
    fun `活着但不响应的假服务 - 探测超时抛 IOException 且文案指向崩溃排查`() {
        val e = assertFailsWith<IOException>("活着但不响应：探测超时应快速失败") {
            startFake(delayMs = 5000, readyTimeoutMs = 300)
        }
        assertTrue("app-server 启动超时" in (e.message ?: ""), "文案应指向启动超时: ${e.message}")
        assertTrue("app-server stderr" in (e.message ?: ""), "文案应指路 idea.log 第一现场: ${e.message}")
    }

    @Test
    fun `启动即崩溃的假服务 - start 快速抛 IOException 而非留给业务请求`() {
        val script = tempDir.resolve("fake-crash.mjs")
            .also { it.writeText("process.exit(1);\n") }
        val e = assertFailsWith<IOException>("崩溃循环场景：start 应快速失败") {
            ZCodeProtocolClient.start(
                zcodePath = script,
                credentials = ZCodeCredentials("test-model", "http://127.0.0.1:9", "test-key"),
            )
        }
        // 秒退竞态有两条失败路径：写探测时断管（send checkError）或等待中被 readLoop
        // 退出 fail pending——文案都能指向"进程没了"
        val msg = e.message ?: ""
        assertTrue(
            "stdin 写入失败" in msg || "启动后即退出" in msg || "连接已断开" in msg,
            "文案应指向进程退出: $msg"
        )
    }
}
