package com.zcode.ideaplugin.ui

import java.io.File
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.io.path.createTempDirectory

/**
 * SlashCommandScanner 单元测试（临时目录隔离，不依赖本机真机数据）
 */
class SlashCommandScannerTest {

    private val tmp = createTempDirectory("slash-scan-test").toFile()

    @AfterTest
    fun cleanup() {
        tmp.deleteRecursively()
    }

    @Test
    fun `内置命令兜底合入且标记 builtin`() {
        val commands = SlashCommandScanner.scan(tmp.absolutePath)
        val init = commands.firstOrNull { it.name == "init" }
        assertNotNull(init, "/init 应在结果中（CLI 内置命令）")
        assertEquals("command", init.kind)
        assertEquals("builtin", init.source)
        assertTrue(init.description!!.contains("AGENTS.md"), "内置命令应带 CLI summary 描述")
    }

    @Test
    fun `自定义同名命令优先于内置`() {
        val cmdDir = File(tmp, ".zcode/commands").apply { mkdirs() }
        File(cmdDir, "init.md").writeText("---\ndescription: 我的初始化\n---\n自定义内容")

        val commands = SlashCommandScanner.scan(tmp.absolutePath)
        val init = commands.firstOrNull { it.name == "init" }
        assertNotNull(init)
        assertEquals("workspace", init.source, "磁盘扫描先于内置兜底，自定义 init 应胜出")
        assertEquals("我的初始化", init.description)
        assertEquals(1, commands.count { it.name == "init" }, "同名命令应去重为一条")
    }

    @Test
    fun `内置清单对齐官方客户端仅三条`() {
        val commands = SlashCommandScanner.scan(tmp.absolutePath)
        val builtinNames = commands.filter { it.source == "builtin" }.map { it.name }.sorted()
        assertEquals(listOf("compact", "goal", "init"), builtinNames, "内置提示应与官方客户端 `/` 补全一致")
    }

    @Test
    fun `工作区嵌套命令冒号连接`() {
        val cmdDir = File(tmp, ".zcode/commands/review").apply { mkdirs() }
        File(cmdDir, "code.md").writeText("审查当前代码变更")

        val commands = SlashCommandScanner.scan(tmp.absolutePath)
        val nested = commands.firstOrNull { it.name == "review:code" }
        assertNotNull(nested, "review/code.md 应映射为 review:code")
        assertEquals("command", nested.kind)
    }
}
