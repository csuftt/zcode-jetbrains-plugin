package com.zcode.ideaplugin.protocol

import com.zcode.ideaplugin.protocol.model.McpServerSpec
import com.zcode.ideaplugin.protocol.model.PermissionMode
import com.zcode.ideaplugin.protocol.model.Workspace
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.readText
import kotlin.io.path.writeText
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * 会话注入面磁盘档案（sess_03b9a979 托盘死循环修复）——假 app-server 驱动。
 *
 * 场景：create 带 mcpServers（CUA 注入）→ client 实例销毁（≈IDE 重启，进程内
 * sessionMcpServers 随之清零）→ 新 client resume 同会话 → resume 参数必须带回
 * mcpServers（否则服务端冷重建丢工具面，CUA 工具静默消失）。另锁：无档案会话
 * resume 不带键（向后兼容）、档案损坏 fail-soft。
 */
class SessionMcpServerPersistenceTest {

    @TempDir
    lateinit var tempDir: Path

    @AfterEach
    fun restoreProperty() {
        System.clearProperty("zcode.sessionMcpStore.path")
    }

    private fun jsPath(path: String): String = "\"${path.replace('\\', '/')}\""

    private fun newFakeServerJs(echoFile: String): String = """
        import readline from 'node:readline';
        import fs from 'node:fs';
        const echoPath = ${jsPath(echoFile)};
        const rl = readline.createInterface({ input: process.stdin });
        rl.on('line', line => {
            let m; try { m = JSON.parse(line); } catch { return; }
            if (m.id === undefined || !m.method) return;
            const p = m.params || {};
            if (m.method === 'session/create' || m.method === 'session/resume') {
                fs.appendFileSync(echoPath, JSON.stringify({ method: m.method, params: p }) + '\n');
            }
            if (m.method === 'session/create') {
                process.stdout.write(JSON.stringify({ id: m.id, result: { session: { sessionId: 'sess_mcp_fake' } } }) + '\n');
            } else {
                process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\n');
            }
        });
    """.trimIndent()

    private fun startFake(echoFile: Path): ZCodeProtocolClient {
        val script = tempDir.resolve("fake-app-server-mcp.mjs")
            .also { it.writeText(newFakeServerJs(echoFile.toString())) }
        return ZCodeProtocolClient.start(
            zcodePath = script,
            credentials = ZCodeCredentials("test-model", "http://127.0.0.1:9", "test-key")
        )
    }

    private fun echoLines(echoFile: Path): List<kotlinx.serialization.json.JsonObject> =
        echoFile.readText().trim().lines().map { Json.parseToJsonElement(it).jsonObject }

    @Test
    fun `重启后 resume 从磁盘档案回灌 mcpServers`() {
        val storeFile = tempDir.resolve("session-mcp.json")
        System.setProperty("zcode.sessionMcpStore.path", storeFile.toString())
        val echo = tempDir.resolve("echo.jsonl")
        val spec = McpServerSpec(
            name = "zcgui-computer-use",
            command = "java.exe",
            args = listOf("-cp", "lib\\*", "com.zcode.ideaplugin.cua.CuaMcpServerMain"),
            env = mapOf("A" to "1"),
            isolation = "session",
            timeoutMs = 300_000L,
            scope = "user",
            alwaysLoad = true,
        )
        // 进程 A：create 带注入面（CUA 形态）
        startFake(echo).use { a ->
            val sid = a.createSession(Workspace("G:\\mock"), PermissionMode.YOLO, mcpServers = listOf(spec))
            assertEquals("sess_mcp_fake", sid)
        }
        // 实例已销毁 = 进程内记录清零；档案必须已落盘
        assertTrue(Files.exists(storeFile), "create 后注入面档案应已落盘")
        // 进程 B（模拟重启后的新 client）：resume 同会话必须带回工具面
        startFake(echo).use { b ->
            b.resume("sess_mcp_fake", Workspace("G:\\mock"))
        }
        val lines = echoLines(echo)
        // create 原样带键（基线）
        val createParams = lines.first { it["method"]!!.jsonPrimitive.content == "session/create" }["params"]!!.jsonObject
        assertEquals("zcgui-computer-use", createParams["mcpServers"]!!.jsonArray[0].jsonObject["name"]!!.jsonPrimitive.content)
        // resume 回灌（核心断言）
        val resumeParams = lines.first { it["method"]!!.jsonPrimitive.content == "session/resume" }["params"]!!.jsonObject
        val servers = resumeParams["mcpServers"]!!.jsonArray
        assertEquals(1, servers.size, "resume 必须带回 create 时的注入面")
        val s = servers[0].jsonObject
        assertEquals("zcgui-computer-use", s["name"]!!.jsonPrimitive.content)
        assertEquals("java.exe", s["command"]!!.jsonPrimitive.content)
        assertEquals("session", s["isolation"]!!.jsonPrimitive.content)
        assertEquals(300_000L, s["timeoutMs"]!!.jsonPrimitive.long)
        assertEquals("1", s["env"]!!.jsonArray[0].jsonObject["value"]!!.jsonPrimitive.content)
        // 3.17.x 新字段回灌（scope 绕信任门控 / alwaysLoad 防延迟加载）
        assertEquals("user", s["scope"]!!.jsonPrimitive.content)
        assertEquals(true, s["alwaysLoad"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun `无档案会话 resume 不带 mcpServers 键（向后兼容）`() {
        System.setProperty("zcode.sessionMcpStore.path", tempDir.resolve("absent.json").toString())
        val echo = tempDir.resolve("echo2.jsonl")
        startFake(echo).use { c ->
            c.resume("sess_never_created", Workspace("G:\\mock"))
        }
        val resumeParams = echoLines(echo).single()["params"]!!.jsonObject
        assertNull(resumeParams["mcpServers"], "无注入史的会话不得多发 mcpServers 键")
    }

    @Test
    fun `档案损坏 fail-soft 返回 null 不抛`() {
        val f = tempDir.resolve("corrupt.json")
        f.writeText("not json{{{")
        System.setProperty("zcode.sessionMcpStore.path", f.toString())
        assertNull(SessionMcpServerStore.load("sess_any"), "损坏档案按无记录处理（fail-soft）")
    }
}
