package com.zcode.ideaplugin.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * McpToolsClient 真机连接冒烟
 *
 * stdio：node -e 起内联假 server（标准 MCP JSON-RPC 握手 + tools/list），
 *        不落盘不依赖外部凭证，验证握手/解析/进程清理全链路。
 * http： 本机 config.json 的 web-search-mcp-server（千帆，真实外网服务），
 *        无该配置时跳过。
 */
class McpToolsClientTest {

    /** 极简 MCP stdio server：initialize → initialized → tools/list 各回一条 */
    private val FAKE_SERVER_JS = """
        let buf = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (d) => {
          buf += d;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            if (!line.trim()) continue;
            const msg = JSON.parse(line);
            if (msg.method === 'initialize') {
              process.stdout.write(JSON.stringify({
                jsonrpc: '2.0', id: msg.id,
                result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '1.0' } }
              }) + '\n');
            } else if (msg.method === 'tools/list') {
              process.stdout.write(JSON.stringify({
                jsonrpc: '2.0', id: msg.id,
                result: { tools: [
                  { name: 'echo', description: '回显输入', inputSchema: { type: 'object' } },
                  { name: 'search_items', description: '搜索条目', inputSchema: { type: 'object' } }
                ] }
              }) + '\n');
            }
            // notifications/initialized 等通知忽略
          }
        });
    """.trimIndent()

    private fun nodeAvailable(): Boolean =
        runCatching { ProcessBuilder("node", "--version").start().waitFor() == 0 }.getOrDefault(false)

    @Test
    fun `stdio 连接内联 server 拿到工具清单`() {
        if (!nodeAvailable()) {
            println("⚠️ 本机无 node，跳过")
            return
        }
        val server = McpConfigReader.McpServerInfo(
            name = "fake-stdio", scope = "user", transport = "stdio",
            command = "node", args = listOf("-e", FAKE_SERVER_JS), url = null,
            envKeys = emptyList(), envValues = emptyMap(), headerValues = emptyMap(),
            enabled = true, configPath = "C:/mock/.mcp.json", pluginName = null,
            status = null, toolCount = null, statusError = null, updatedAt = null,
        )
        val tools = McpToolsClient.listTools(server, workspacePath = ".")
        println("✅ stdio 工具: ${tools.joinToString { it.name }}")
        assertEquals(listOf("echo", "search_items"), tools.map { it.name }, "应拿到假 server 的两个工具")
        assertEquals("回显输入", tools.first().description, "description 应解析")
    }

    @Test
    fun `stdio 起不存在的命令报可读错误`() {
        val server = McpConfigReader.McpServerInfo(
            name = "broken", scope = "user", transport = "stdio",
            command = "definitely-not-exist-zcode-test", args = emptyList(), url = null,
            envKeys = emptyList(), envValues = emptyMap(), headerValues = emptyMap(),
            enabled = true, configPath = "C:/mock/.mcp.json", pluginName = null,
            status = null, toolCount = null, statusError = null, updatedAt = null,
        )
        val e = runCatching { McpToolsClient.listTools(server, workspacePath = ".") }.exceptionOrNull()
        println("✅ 错误信息: ${e?.message}")
        assertNotNull(e, "应抛出异常")
        assertTrue(e is McpToolsClient.McpClientException, "应是 McpClientException")
        // 非 Windows：ProcessBuilder 直接启动失败 →「无法启动」；
        // Windows：cmd /c 兜底能起来但立刻退出 →「服务器进程已退出」
        assertTrue(
            e.message!!.contains("无法启动") || e.message!!.contains("已退出"),
            "错误应说明启动失败或进程退出，实际: ${e.message}",
        )
    }

    @Test
    fun `http 连接千帆 web-search 拿到工具清单`() {
        val target = McpConfigReader.scan(null).firstOrNull { it.transport != "stdio" }
        if (target == null) {
            println("⚠️ 本机无 http/sse 类型 MCP 配置，跳过")
            return
        }
        val tools = McpToolsClient.listTools(target, workspacePath = ".")
        println("✅ [${target.name}] http 工具: ${tools.joinToString { it.name }}")
        assertTrue(tools.isNotEmpty(), "真实服务应至少返回一个工具")
    }
}
