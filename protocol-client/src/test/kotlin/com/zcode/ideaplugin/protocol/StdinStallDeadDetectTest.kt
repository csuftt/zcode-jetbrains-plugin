package com.zcode.ideaplugin.protocol

import org.junit.jupiter.api.Test
import java.nio.file.Path
import kotlin.test.assertTrue

/**
 * stdin 写阻塞判死端到端回归（app-server-silent-hang 三/四例根治，2026-10-28/29）：
 * 交互弹窗应答后 app-server 进程挂死、stdin 无人消费，原 send() 持全局锁的阻塞式写
 * 永久卡住——全部 stdio 通信（含用户点停止）排队无痕，唯一解曾是用户手动杀进程。
 *
 * 夹具 fake-app-server-stdin-stall.js：就绪探测正常应答，收到后续请求即永久 pause
 * 停止消费 stdin。本测试向它发送超过 OS 管道缓冲的大消息，验证：写入阻塞在时限内
 * 判死 → 异常语义明确（不再是无限挂死）→ 进程被自动 kill → 判死钩子触发 → 后续
 * 调用快速失败不再排队。
 */
class StdinStallDeadDetectTest {

    private fun fakeServerPath(): Path = Path.of(
        javaClass.getResource("/fake-app-server-stdin-stall.js")!!.toURI()
    )

    @Test
    fun `stdin挂死时大消息写入超时判死并自动kill进程`() {
        var deadEvidence: String? = null
        val client = ZCodeProtocolClient.start(
            zcodePath = fakeServerPath(),
            credentials = null,
            readyTimeoutMs = 15_000,
            stdinWriteTimeoutMs = 500,
        )
        try {
            client.onProtocolDead = { deadEvidence = it }

            // 2MB 消息 >> 管道缓冲（Win 约 4-64KB）：对端 pause 后写入必阻塞 → 判死
            val t0 = System.currentTimeMillis()
            val err = runCatching {
                client.send(
                    sessionId = "sess_stall_fixture",
                    content = "x".repeat(2 * 1024 * 1024),
                    timeoutMs = 60_000,
                )
            }.exceptionOrNull()
            val elapsed = System.currentTimeMillis() - t0

            assertTrue(err is java.io.IOException, "应抛 IOException，实际: $err")
            assertTrue(
                err.message?.contains("阻塞超时") == true,
                "异常应指明写阻塞判死语义，实际: ${err.message}"
            )
            assertTrue(elapsed < 15_000, "判死应在秒级完成（实际 ${elapsed}ms），不得无限挂死")

            // 进程已被判死链路自动 kill
            val deadline = System.currentTimeMillis() + 10_000
            while (client.isAlive() && System.currentTimeMillis() < deadline) Thread.sleep(100)
            assertTrue(!client.isAlive(), "判死后进程应被自动终止")

            // 判死钩子已触发（Service 层重建入口）
            val hookDeadline = System.currentTimeMillis() + 5000
            while (deadEvidence == null && System.currentTimeMillis() < hookDeadline) Thread.sleep(50)
            assertTrue(deadEvidence?.contains("stdin") == true, "onProtocolDead 应带证据回调，实际: $deadEvidence")

            // 后续调用快速失败（DEAD 短路），不再排队挂死
            val t1 = System.currentTimeMillis()
            val err2 = runCatching {
                client.send(sessionId = "sess_stall_fixture", content = "again", timeoutMs = 60_000)
            }.exceptionOrNull()
            assertTrue(err2 is java.io.IOException, "判死后调用应快速失败")
            assertTrue(System.currentTimeMillis() - t1 < 2000, "快速失败不得再等超时")
        } finally {
            client.close()
        }
    }
}
