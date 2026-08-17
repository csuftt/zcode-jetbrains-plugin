package com.zcode.ideaplugin.ui

import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * McpLogReader 真机数据验证（读本机 ~/.zcode/cli/log/ 的真实 jsonl）
 */
class McpLogReaderTest {

    @Test
    fun `读取今日 MCP 日志且条目结构合法`() {
        val logs = McpLogReader.readRecent()
        println("✅ 读取到 ${logs.size} 条 MCP 日志（最近 200 条窗口内）")
        logs.take(5).forEach { e ->
            println("   ${e.timestamp.take(19)} [${e.level}] ${e.serverName.ifEmpty { "-" }} ${e.message.take(80)}")
        }
        logs.forEach { e ->
            assertTrue(e.timestamp.isNotBlank(), "timestamp 非空")
            assertTrue(e.event.startsWith("mcp."), "event 应为 mcp.* : ${e.event}")
            assertTrue(e.level in setOf("info", "warn", "error", "debug"), "level 合法: ${e.level}")
            assertTrue(e.message.isNotBlank(), "message 非空: ${e.event}")
        }
        assertTrue(logs.none { it.event.startsWith("mcp.pool.lease.") }, "lease 噪音应被过滤")
    }
}
