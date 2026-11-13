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
 * 会话注入面磁盘档案（sess_03b9a979 托盘死循环修复 + 缺陷HH 代际门控）——假 app-server 驱动。
 *
 * 场景：create 带 mcpServers（CUA 注入）→ client 实例销毁（≈IDE 重启，进程内
 * sessionMcpServers 随之清零）→ 新 client resume 同会话 → resume 参数必须带回
 * mcpServers（否则服务端冷重建丢工具面，CUA 工具静默消失）。
 *
 * 缺陷HH（2026-11-12）：scope/alwaysLoad 是 3.17.x 新键，OLD 代 strict schema 拒未知键
 * （老 CLI 上电脑控制开+新建会话必炸 -32602 mcpServers.0: Invalid input）。wire 面按
 * 代际门控：NEW 全量下发、OLD 裁剪两键；磁盘档案恒保全量（CLI 新旧切换不丢信息）。
 * 假脚本带不带 NEW 代标记串（ZCODE_PERSONAL_PROVIDER_CONFIG_FILE）即控代际。
 */
class SessionMcpServerPersistenceTest {

    @TempDir
    lateinit var tempDir: Path

    @AfterEach
    fun restoreProperty() {
        System.clearProperty("zcode.sessionMcpStore.path")
    }

    private fun jsPath(path: String): String = "\"${path.replace('\\', '/')}\""

    private fun newFakeServerJs(echoFile: String, newGen: Boolean): String = """
        import readline from 'node:readline';
        import fs from 'node:fs';
        // 代际标记：${if (newGen) "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE" else "(old generation, no marker)"}
        if (process.argv.includes('--version')) {
            process.stdout.write('0.16.5\n');
            process.exit(0);
        }
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

    private fun startFake(echoFile: Path, newGen: Boolean = false): ZCodeProtocolClient {
        val script = tempDir.resolve(if (newGen) "fake-app-server-mcp-new.mjs" else "fake-app-server-mcp-old.mjs")
            .also { it.writeText(newFakeServerJs(echoFile.toString(), newGen)) }
        return ZCodeProtocolClient.start(
            zcodePath = script,
            credentials = ZCodeCredentials("test-model", "http://127.0.0.1:9", "test-key")
        )
    }

    private fun echoLines(echoFile: Path): List<kotlinx.serialization.json.JsonObject> =
        echoFile.readText().trim().lines().map { Json.parseToJsonElement(it).jsonObject }

    @Test
    fun `NEW代 重启后 resume 从磁盘档案回灌 mcpServers 含scope与alwaysLoad`() {
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
        startFake(echo, newGen = true).use { a ->
            val sid = a.createSession(Workspace("G:\\mock"), PermissionMode.YOLO, mcpServers = listOf(spec))
            assertEquals("sess_mcp_fake", sid)
        }
        // 实例已销毁 = 进程内记录清零；档案必须已落盘
        assertTrue(Files.exists(storeFile), "create 后注入面档案应已落盘")
        // 进程 B（模拟重启后的新 client）：resume 同会话必须带回工具面
        startFake(echo, newGen = true).use { b ->
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

    /**
     * 缺陷HH 回归：OLD 代 wire 面裁剪 scope/alwaysLoad（strict schema 拒未知键，
     * 老 CLI 建会话必炸 -32602），磁盘档案仍保全量，切回 NEW 代 resume 两键回归。
     */
    @Test
    fun `OLD代 wire裁剪scope与alwaysLoad 磁盘档案保全量 切NEW代回灌`() {
        val storeFile = tempDir.resolve("session-mcp-old.json")
        System.setProperty("zcode.sessionMcpStore.path", storeFile.toString())
        val echo = tempDir.resolve("echo-old.jsonl")
        val spec = McpServerSpec(
            name = "zcgui-computer-use",
            command = "java.exe",
            args = listOf("-cp", "lib\\*"),
            isolation = "session",
            timeoutMs = 300_000L,
            scope = "user",
            alwaysLoad = true,
        )
        // OLD 代 client：create 上 wire 两键必须被裁掉（核心断言），基线键保留
        startFake(echo).use { a ->
            a.createSession(Workspace("G:\\mock"), PermissionMode.YOLO, mcpServers = listOf(spec))
        }
        val createParams = echoLines(echo).first()["params"]!!.jsonObject
        val wire = createParams["mcpServers"]!!.jsonArray[0].jsonObject
        assertNull(wire["scope"], "OLD 代 wire 不得携带 scope（strict schema 拒收整条）")
        assertNull(wire["alwaysLoad"], "OLD 代 wire 不得携带 alwaysLoad")
        assertEquals("zcgui-computer-use", wire["name"]!!.jsonPrimitive.content)
        assertEquals("session", wire["isolation"]!!.jsonPrimitive.content)
        assertEquals(300_000L, wire["timeoutMs"]!!.jsonPrimitive.long)
        // 磁盘档案保全量：CLI 升回新版后 resume 仍能带回两键
        val archived = SessionMcpServerStore.load("sess_mcp_fake")
        assertEquals("user", archived?.single()?.scope, "磁盘档案不得被 wire 门控连带裁剪")
        assertEquals(true, archived?.single()?.alwaysLoad)
        // NEW 代 client：resume 同会话（档案是 OLD 代 create 落的），两键回归 wire
        startFake(echo, newGen = true).use { b ->
            b.resume("sess_mcp_fake", Workspace("G:\\mock"))
        }
        val resumeParams = echoLines(echo)
            .first { it["method"]!!.jsonPrimitive.content == "session/resume" }["params"]!!.jsonObject
        val s = resumeParams["mcpServers"]!!.jsonArray[0].jsonObject
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
