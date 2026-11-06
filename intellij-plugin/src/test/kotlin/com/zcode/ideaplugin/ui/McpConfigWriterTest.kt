package com.zcode.ideaplugin.ui

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * McpConfigWriter 离线单测（@TempDir，无环境依赖）：增删/重名拒/缺文件创建/
 * 其余键保序保留/坏文件拒绝写入/滚动备份链。
 */
class McpConfigWriterTest {

    @TempDir
    lateinit var tmp: Path

    private fun file(name: String = "config.json"): File = tmp.resolve(name).toFile()

    private fun entry(command: String = "npx", vararg args: String): JsonObject = buildJsonObject {
        put("command", command)
        if (args.isNotEmpty()) put("args", kotlinx.serialization.json.JsonArray(args.map { JsonPrimitive(it) }))
    }

    private fun readServers(f: File): JsonObject =
        Json.parseToJsonElement(f.readText()).jsonObject["mcp"]!!.jsonObject["servers"]!!.jsonObject

    @Test
    fun `新增到不存在的文件 创建文件与 mcp servers 节点`() {
        val f = file(".zcode/config.json")
        assertNull(McpConfigWriter.addServer(f, "alpha", entry()))
        val saved = readServers(f)
        assertEquals("npx", (saved["alpha"] as JsonObject)["command"]?.let { (it as JsonPrimitive).content })
    }

    @Test
    fun `新增保留根节点其余键且新条目追加在后`() {
        val f = file()
        f.writeText("""{"schemaVersion":2,"theme":"dark","mcp":{"servers":{"keep":{"command":"foo"}},"other":1}}""")
        assertNull(McpConfigWriter.addServer(f, "new1", entry()))
        val root = Json.parseToJsonElement(f.readText()).jsonObject
        assertEquals(setOf("schemaVersion", "theme", "mcp"), root.keys, "根节点键集合不变")
        assertEquals(setOf("servers", "other"), root["mcp"]?.jsonObject?.keys, "mcp 节点其余键保留")
        assertEquals(listOf("keep", "new1"), readServers(f).keys.toList(), "新条目追加在尾部且旧条目保序")
        assertNull(McpConfigWriter.addServer(f, "new2", entry()), "连续写不互斥")
    }

    @Test
    fun `同文件重名新增拒绝`() {
        val f = file()
        assertNull(McpConfigWriter.addServer(f, "dup", entry()))
        val err = assertNotNull(McpConfigWriter.addServer(f, "dup", entry(command = "node")), "重名应拒绝")
        assertTrue(err.contains("dup"))
        // 拒绝后原条目未被覆盖
        assertEquals("npx", (readServers(f)["dup"] as JsonObject)["command"]?.let { (it as JsonPrimitive).content })
    }

    @Test
    fun `编辑覆盖保存 previousName 等于自身时放行重名`() {
        val f = file()
        assertNull(McpConfigWriter.addServer(f, "srv", entry(command = "npx", "-y", "pkg")))
        // 编辑模式：previousName=name 即原条目自身 → 覆盖而非拒绝
        assertNull(McpConfigWriter.addServer(f, "srv", entry(command = "node"), previousName = "srv"), "upsert 应放行")
        assertEquals("node", (readServers(f)["srv"] as JsonObject)["command"]?.let { (it as JsonPrimitive).content })
        assertEquals(listOf("srv"), readServers(f).keys.toList())
    }

    @Test
    fun `改名保存 同一次写内移除旧键写新键`() {
        val f = file()
        assertNull(McpConfigWriter.addServer(f, "a", entry()))
        assertNull(McpConfigWriter.addServer(f, "b", entry()))
        // a 改名为 c：旧键移除、新键追加、b 保序
        assertNull(McpConfigWriter.addServer(f, "c", entry(command = "node"), previousName = "a"))
        assertEquals(listOf("b", "c"), readServers(f).keys.toList(), "旧键应被移除且其余保序")
        assertEquals("node", (readServers(f)["c"] as JsonObject)["command"]?.let { (it as JsonPrimitive).content })
    }

    @Test
    fun `改名撞已有键拒绝`() {
        val f = file()
        assertNull(McpConfigWriter.addServer(f, "a", entry()))
        assertNull(McpConfigWriter.addServer(f, "b", entry()))
        val err = assertNotNull(McpConfigWriter.addServer(f, "b", entry(), previousName = "a"), "改名落到已有键应拒绝")
        assertTrue(err.contains("b"))
        assertEquals(listOf("a", "b"), readServers(f).keys.toList(), "拒绝后两键原样")
    }

    @Test
    fun `删除存在的条目 其余条目保序`() {
        val f = file()
        assertNull(McpConfigWriter.addServer(f, "a", entry()))
        assertNull(McpConfigWriter.addServer(f, "b", entry()))
        assertNull(McpConfigWriter.addServer(f, "c", entry()))
        assertNull(McpConfigWriter.deleteServer(f, "b"))
        assertEquals(listOf("a", "c"), readServers(f).keys.toList(), "删除后保序")
    }

    @Test
    fun `删除不存在的条目拒绝`() {
        val f = file()
        f.writeText("""{"mcp":{"servers":{"x":{"command":"y"}}}}""")
        val err = assertNotNull(McpConfigWriter.deleteServer(f, "missing"), "应拒绝")
        assertTrue(err.contains("missing"))
    }

    @Test
    fun `已有文件损坏时拒绝写入不覆盖`() {
        val f = file()
        f.writeText("{ not valid json !!")
        val err = assertNotNull(McpConfigWriter.addServer(f, "x", entry()), "坏文件应拒绝")
        assertTrue(err.contains("解析"))
        assertEquals("{ not valid json !!", f.readText(), "坏文件内容不被改写")
    }

    @Test
    fun `已有文件写入产生滚动备份`() {
        val f = file()
        f.writeText("""{"mcp":{"servers":{}}}""")
        assertNull(McpConfigWriter.addServer(f, "x", entry()))
        assertNull(McpConfigWriter.addServer(f, "y", entry()))
        val bak1 = tmp.resolve("config.json.bak.1").toFile()
        assertTrue(bak1.isFile, "首次写入应产生 .bak.1")
        // bak.1 = 上一次写盘前的状态（只有 x）
        assertEquals(listOf("x"), readServers(bak1).keys.toList(), ".bak.1 应为上一版")
    }

    @Test
    fun `写回持跨进程点lock文件锁`() {
        val f = file()
        assertNull(McpConfigWriter.addServer(f, "x", entry()))
        assertTrue(tmp.resolve("config.json.lock").toFile().isFile, "写回应创建 .lock 跨进程锁文件（0.4.3 审查补齐）")
        assertNull(McpConfigWriter.deleteServer(f, "x"), "锁文件存在不影响后续读写")
    }

    @Test
    fun `作用域解析文件路径`() {
        val user = McpConfigWriter.resolveFile("user", null)
        assertNotNull(user)
        assertTrue(user.absolutePath.replace('\\', '/').endsWith(".zcode/cli/config.json"))
        assertNull(McpConfigWriter.resolveFile("project", null), "project 无路径应返回 null")
        assertNull(McpConfigWriter.resolveFile("plugin", "G:/x"), "plugin 作用域不受支持")
        val project = McpConfigWriter.resolveFile("project", tmp.toString())
        assertNotNull(project)
        assertTrue(project.absolutePath.replace('\\', '/').endsWith(".zcode/config.json"))
    }
}
