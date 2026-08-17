package com.zcode.ideaplugin.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * McpConfigReader 真机数据冒烟（本机可能无 mcp 配置 → 空列表也算通过，重点是结构不炸）
 */
class McpConfigReaderTest {

    @Test
    fun `扫描不抛异常且条目结构合法`() {
        val servers = McpConfigReader.scan(null)
        println("✅ 扫描到 ${servers.size} 个 MCP 服务器")
        servers.forEach { s ->
            assertTrue(s.name.isNotBlank(), "name 非空")
            assertTrue(s.transport in setOf("stdio", "http", "sse"), "transport 合法: ${s.transport}")
            assertTrue(s.command != null || s.url != null, "stdio 有 command / 远程有 url: ${s.name}")
            assertTrue(s.scope in setOf("user", "project", "plugin"), "scope 合法: ${s.scope}")
            println("   - ${s.name} | ${s.scope} | ${s.transport} | cmd=${s.command} url=${s.url}")
        }
    }

    @Test
    fun `marketplaces 市场索引不算已配置`() {
        // marketplaces/claude-plugins-official/external_plugins/ 下有 context7/discord 等
        // 市场清单（未安装），扫描结果不应包含它们
        val servers = McpConfigReader.scan(null)
        val names = servers.map { it.name }.toSet()
        assertTrue("context7" !in names && "discord" !in names, "市场索引条目不应出现: $names")
    }

    @Test
    fun `toProtocolParam 占位符替换与 env 数组化`() {
        val servers = McpConfigReader.scan(null)
        // 找 cache 下带 ${CLAUDE_PLUGIN_ROOT} 的已安装插件条目（android-emulator 等）
        val target = servers.firstOrNull { it.name == "android-emulator" }
        if (target == null) {
            println("⚠️ 本机无 android-emulator 插件，跳过")
            return
        }
        val param = assertNotNull(McpConfigReader.toProtocolParam(target, "G:/mock/ws"), "应可转换")
        val json = param.toString()
        println("✅ 转换结果: $json")
        assertTrue(!json.contains("\${CLAUDE_PLUGIN_ROOT}"), "占位符应被替换")
        assertTrue(json.contains("\"env\":"), "env 必填字段应存在（数组形态）")
        assertTrue(json.contains("\"args\":"), "args 必填字段应存在")
    }

    @Test
    fun `disabled 条目转 param 返回 null`() {
        val s = McpConfigReader.McpServerInfo(
            name = "x", scope = "user", transport = "stdio", command = "cmd",
            args = emptyList(), url = null, envKeys = emptyList(),
            envValues = emptyMap(), headerValues = emptyMap(),
            enabled = false, configPath = "C:/x/.mcp.json", pluginName = null,
            status = null, toolCount = null, statusError = null, updatedAt = null,
        )
        assertNull(McpConfigReader.toProtocolParam(s, "G:/ws"))
    }
}
