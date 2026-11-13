package com.zcode.ideaplugin.protocol

import com.zcode.ideaplugin.protocol.model.McpServerSpec
import com.zcode.ideaplugin.protocol.model.PermissionMode
import com.zcode.ideaplugin.protocol.model.Workspace
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
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
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * 会话注入面磁盘档案（sess_03b9a979 托盘死循环修复 + 缺陷HH 代际门控 + 缺陷HO 内容探测）——假 app-server 驱动。
 *
 * 场景：create 带 mcpServers（CUA 注入）→ client 实例销毁（≈IDE 重启，进程内
 * sessionMcpServers 随之清零）→ 新 client resume 同会话 → resume 参数必须带回
 * mcpServers（否则服务端冷重建丢工具面，CUA 工具静默消失）。
 *
 * 缺陷HH（2026-11-12）：scope/alwaysLoad 是 3.17.x 新键，OLD 代 strict schema 拒未知键
 * （老 CLI 上电脑控制开+新建会话必炸 -32602 mcpServers.0: Invalid input）。wire 面按
 * 代际门控：NEW 全量下发、OLD 裁剪两键；磁盘档案恒保全量（CLI 新旧切换不丢信息）。
 *
 * 缺陷HO（2026-11-13，issue#51）：NEW 代是 3.12.3+ 大区间，两键 ≈3.16 线（2026-10-19
 * sync）才进 schema——中间版本「NEW 标记在、键不在」，按代放行同样炸 -32602
 * Unrecognized keys。wire 门控升级为 cjs 内容探测（probeMcpServerKeys），探测漏网由
 * -32602 裁键自愈兜底（callWithMcpKeysHeal）。假脚本带不带 NEW 代标记串
 * （ZCODE_PERSONAL_PROVIDER_CONFIG_FILE）控代际、带不带 alwaysLoad 串控两键。
 */
class SessionMcpServerPersistenceTest {

    @TempDir
    lateinit var tempDir: Path

    @AfterEach
    fun restoreProperty() {
        System.clearProperty("zcode.sessionMcpStore.path")
    }

    private fun jsPath(path: String): String = "\"${path.replace('\\', '/')}\""

    private fun newFakeServerJs(
        echoFile: String,
        newGen: Boolean,
        mcpKeys: Boolean = newGen,
        rejectMcpKeys: Boolean = false,
    ): String = """
        import readline from 'node:readline';
        import fs from 'node:fs';
        // 代际标记：${if (newGen) "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE" else "(old generation, no marker)"}
        // mcp 两键标记：${if (mcpKeys) "alwaysLoad" else "(no mcp keys marker)"}
        if (process.argv.includes('--version')) {
            process.stdout.write('0.16.5\n');
            process.exit(0);
        }
        const echoPath = ${jsPath(echoFile)};
        // NEWKEY 拆串拼接：注释与代码都不得出现该键的连续子串（会污染代客户端的内容探测）
        const NEWKEY = 'always' + 'Load';
        const REJECT = $rejectMcpKeys;
        const rl = readline.createInterface({ input: process.stdin });
        rl.on('line', line => {
            let m; try { m = JSON.parse(line); } catch { return; }
            if (m.id === undefined || !m.method) return;
            const p = m.params || {};
            if (m.method === 'session/create' || m.method === 'session/resume') {
                fs.appendFileSync(echoPath, JSON.stringify({ method: m.method, params: p }) + '\n');
            }
            const s0 = p.mcpServers && p.mcpServers[0];
            if (REJECT && s0 && (s0.scope !== undefined || s0[NEWKEY] !== undefined)) {
                process.stdout.write(JSON.stringify({ id: m.id, error: { code: -32602,
                    message: 'Invalid params - mcpServers.0: Unrecognized keys: "scope", "' + NEWKEY + '"' } }) + '\n');
            } else if (m.method === 'session/create') {
                process.stdout.write(JSON.stringify({ id: m.id, result: { session: { sessionId: 'sess_mcp_fake' } } }) + '\n');
            } else {
                process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\n');
            }
        });
    """.trimIndent()

    private fun startFake(
        echoFile: Path,
        newGen: Boolean = false,
        mcpKeys: Boolean = newGen,
        rejectMcpKeys: Boolean = false,
    ): ZCodeProtocolClient {
        val script = tempDir.resolve(
            "fake-app-server-mcp-${if (newGen) "new" else "old"}${if (mcpKeys) "-keys" else "-nokeys"}${if (rejectMcpKeys) "-reject" else ""}.mjs"
        ).also { it.writeText(newFakeServerJs(echoFile.toString(), newGen, mcpKeys, rejectMcpKeys)) }
        return ZCodeProtocolClient.start(
            zcodePath = script,
            credentials = ZCodeCredentials("test-model", "http://127.0.0.1:9", "test-key")
        )
    }

    private fun echoLines(echoFile: Path): List<JsonObject> =
        echoFile.readText().trim().lines().map { Json.parseToJsonElement(it).jsonObject }

    private fun firstMcpWire(params: JsonObject): JsonObject =
        params["mcpServers"]!!.jsonArray[0].jsonObject

    private fun hasMcpKeys(wire: JsonObject): Boolean =
        wire.containsKey("scope") || wire.containsKey("alwaysLoad")

    private fun cuaSpec() = McpServerSpec(
        name = "zcgui-computer-use",
        command = "java.exe",
        args = listOf("-cp", "lib\\*", "com.zcode.ideaplugin.cua.CuaMcpServerMain"),
        env = mapOf("A" to "1"),
        isolation = "session",
        timeoutMs = 300_000L,
        scope = "user",
        alwaysLoad = true,
    )

    @Test
    fun `NEW代 重启后 resume 从磁盘档案回灌 mcpServers 含scope与alwaysLoad`() {
        val storeFile = tempDir.resolve("session-mcp.json")
        System.setProperty("zcode.sessionMcpStore.path", storeFile.toString())
        val echo = tempDir.resolve("echo.jsonl")
        // 进程 A：create 带注入面（CUA 形态）
        startFake(echo, newGen = true).use { a ->
            val sid = a.createSession(Workspace("G:\\mock"), PermissionMode.YOLO, mcpServers = listOf(cuaSpec()))
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
        assertEquals("zcgui-computer-use", firstMcpWire(createParams)["name"]!!.jsonPrimitive.content)
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
        // OLD 代 client：create 上 wire 两键必须被裁掉（核心断言），基线键保留
        startFake(echo).use { a ->
            a.createSession(Workspace("G:\\mock"), PermissionMode.YOLO, mcpServers = listOf(cuaSpec()))
        }
        val createParams = echoLines(echo).first()["params"]!!.jsonObject
        val wire = firstMcpWire(createParams)
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
        val s = firstMcpWire(resumeParams)
        assertEquals("user", s["scope"]!!.jsonPrimitive.content)
        assertEquals(true, s["alwaysLoad"]!!.jsonPrimitive.boolean)
    }

    /**
     * 缺陷HO 回归（issue#51）：NEW 代标记在、cjs 无 mcp 两键（3.12.3~3.15 区间老 NEW
     * 代，两键 ≈3.16 线才进 schema）——wire 面必须裁两键，磁盘档案仍保全量。
     */
    @Test
    fun `NEW标记但cjs无mcp两键（老NEW代） wire裁剪 磁盘档案保全量`() {
        val storeFile = tempDir.resolve("session-mcp-rawnew.json")
        System.setProperty("zcode.sessionMcpStore.path", storeFile.toString())
        val echo = tempDir.resolve("echo-rawnew.jsonl")
        startFake(echo, newGen = true, mcpKeys = false).use { a ->
            a.createSession(Workspace("G:\\mock"), PermissionMode.YOLO, mcpServers = listOf(cuaSpec()))
        }
        val wire = firstMcpWire(echoLines(echo).first()["params"]!!.jsonObject)
        assertNull(wire["scope"], "老 NEW 代（schema 无两键）wire 不得携带 scope，issue#51 必炸")
        assertNull(wire["alwaysLoad"], "老 NEW 代 wire 不得携带 alwaysLoad")
        assertEquals("zcgui-computer-use", wire["name"]!!.jsonPrimitive.content, "基线键保留")
        // 磁盘档案保全量：升到 3.16+ 后 resume 两键回归
        val archived = SessionMcpServerStore.load("sess_mcp_fake")
        assertEquals("user", archived?.single()?.scope)
        assertEquals(true, archived?.single()?.alwaysLoad)
    }

    /**
     * 缺陷HO 自愈兜底：内容探测放行（cjs 含键标记）但当代 schema 实际拒收（未来版本
     * 删键/改名等漏网场景）——首发 -32602 Unrecognized keys 点名两键 → 裁键重发成功，
     * 且进程内降级：后续 create/resume 直接走裁剪面不再撞拒。
     */
    @Test
    fun `-32602 Unrecognized keys 自愈 裁键重试成功并进程内降级`() {
        val storeFile = tempDir.resolve("session-mcp-heal.json")
        System.setProperty("zcode.sessionMcpStore.path", storeFile.toString())
        val echo = tempDir.resolve("echo-heal.jsonl")
        startFake(echo, newGen = true, mcpKeys = true, rejectMcpKeys = true).use { c ->
            // 首发带两键 → 被假 server 以 zod 文本拒收 → 自愈裁键重试成功
            c.createSession(Workspace("G:\\mock"), PermissionMode.YOLO, mcpServers = listOf(cuaSpec()))
            // 降级已生效：第二个 create 直接裁剪，不再撞拒
            c.createSession(Workspace("G:\\mock"), PermissionMode.YOLO, mcpServers = listOf(cuaSpec()))
            // resume（内存回灌路径）同走裁剪面
            c.resume("sess_mcp_fake", Workspace("G:\\mock"))
        }
        val creates = echoLines(echo).filter { it["method"]!!.jsonPrimitive.content == "session/create" }
        assertEquals(3, creates.size, "create 发出 3 次：首发(带键被拒)+自愈重试(裁键)+降级后(create2)")
        assertTrue(hasMcpKeys(firstMcpWire(creates[0]["params"]!!.jsonObject)), "首发按探测结果带两键")
        assertFalse(hasMcpKeys(firstMcpWire(creates[1]["params"]!!.jsonObject)), "被拒后自愈重试必须裁两键")
        assertFalse(hasMcpKeys(firstMcpWire(creates[2]["params"]!!.jsonObject)), "降级后后续 create 直接裁剪")
        val resumes = echoLines(echo).filter { it["method"]!!.jsonPrimitive.content == "session/resume" }
        assertEquals(1, resumes.size)
        assertFalse(hasMcpKeys(firstMcpWire(resumes[0]["params"]!!.jsonObject)), "降级后 resume 同走裁剪面")
    }

    /** probeMcpServerKeys 内容探测三态：含键标记 true / 不含 false / 文件缺失 null */
    @Test
    fun `probeMcpServerKeys 内容探测三态`() {
        val withKeys = tempDir.resolve("probe-with.mjs").apply {
            writeText("// marker ZCODE_PERSONAL_PROVIDER_CONFIG_FILE\n// alwaysLoad\n")
        }
        val withoutKeys = tempDir.resolve("probe-without.mjs").apply {
            writeText("// marker ZCODE_PERSONAL_PROVIDER_CONFIG_FILE only\n")
        }
        assertEquals(true, ProtocolGenerations.probeMcpServerKeys(withKeys))
        assertEquals(false, ProtocolGenerations.probeMcpServerKeys(withoutKeys))
        assertNull(ProtocolGenerations.probeMcpServerKeys(tempDir.resolve("probe-missing.mjs")))
        assertNull(ProtocolGenerations.probeMcpServerKeys(null))
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
