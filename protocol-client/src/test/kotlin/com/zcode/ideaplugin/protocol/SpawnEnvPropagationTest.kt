package com.zcode.ideaplugin.protocol

import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue

/**
 * `start(extraEnv=...)` 真实 spawn 管道验证（issue #50）：轻任务专用 app-server
 * 的数据根 env 必须真的到达子进程——只测 env 组装函数不够，引线也得通。
 *
 * 夹具 `fake-app-server-env-dump.js` 启动时把 `ZCODE_DATA_BASE_DIR` 落盘（未设置
 * 写空串），并用 `session/list` 应答就绪探测。
 */
class SpawnEnvPropagationTest {

    private fun fakeServerPath(): Path = Path.of(
        javaClass.getResource("/fake-app-server-env-dump.js")!!.toURI()
    )

    /**
     * 等夹具落盘后读取。dump 路径预先不存在（不能预先建空文件——会让轮询立即
     * 命中空内容）；子进程启动首帧同步写，就绪探测返回时通常已可见，轮询兜底。
     */
    private fun awaitDump(dump: Path): String {
        repeat(50) {
            if (Files.isRegularFile(dump)) return Files.readString(dump)
            Thread.sleep(100)
        }
        assertTrue(Files.isRegularFile(dump), "夹具未在 5s 内落盘: $dump")
        return Files.readString(dump)
    }

    @Test
    fun `extraEnv 数据根直达 app-server 子进程`() {
        assumeTrue(
            System.getenv(CliSpawnEnv.DATA_BASE_DIR).isNullOrBlank(),
            "宿主 JVM 已设 ${CliSpawnEnv.DATA_BASE_DIR}，继承值会掩盖引线断言",
        )
        val work = Files.createTempDirectory("spawn-env")
        val dump = work.resolve("env-dump.txt")
        val dataDir = Files.createTempDirectory("spawn-data").toAbsolutePath().toString()
        try {
            val client = ZCodeProtocolClient.start(
                zcodePath = fakeServerPath(),
                credentials = null,
                extraEnv = mapOf(
                    CliSpawnEnv.DATA_BASE_DIR to dataDir,
                    "SPAWN_ENV_DUMP" to dump.toString(),
                ),
                readyTimeoutMs = 15_000,
            )
            try {
                assertTrue(client.isAlive(), "app-server 子进程应存活")
                assertEquals(dataDir, awaitDump(dump), "子进程必须收到 extraEnv 的数据根")
            } finally {
                client.close()
            }
        } finally {
            work.toFile().deleteRecursively()
            Path.of(dataDir).toFile().deleteRecursively()
        }
    }

    @Test
    fun `不传 extraEnv 时不注入数据根（主 client 口径不被误改）`() {
        assumeTrue(
            System.getenv(CliSpawnEnv.DATA_BASE_DIR).isNullOrBlank(),
            "宿主 JVM 已设 ${CliSpawnEnv.DATA_BASE_DIR}，无法区分继承与注入",
        )
        val work = Files.createTempDirectory("spawn-env")
        val dump = work.resolve("env-dump.txt")
        try {
            val client = ZCodeProtocolClient.start(
                zcodePath = fakeServerPath(),
                credentials = null,
                extraEnv = mapOf("SPAWN_ENV_DUMP" to dump.toString()),
                readyTimeoutMs = 15_000,
            )
            try {
                assertTrue(client.isAlive(), "app-server 子进程应存活")
                assertEquals("", awaitDump(dump), "主 client 不应携带数据根变量")
            } finally {
                client.close()
            }
        } finally {
            work.toFile().deleteRecursively()
        }
    }
}
