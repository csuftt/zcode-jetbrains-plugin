package com.zcode.ideaplugin.protocol

import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import kotlin.test.assertTrue

/**
 * mcp/list RPC 真机集成测试（status 模式，不实际连接）
 *
 * 验证点：请求 schema（workspace + mode）能被 app-server 接受，
 * 响应含 statuses 节点（本机无 MCP 配置时为空对象也合法）。
 *
 * ⚠️ 真机测试：需要 ZCode 已安装 + node 在 PATH（不可用时整类跳过）
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class McpListIntegrationTest {

    private lateinit var client: ZCodeProtocolClient

    @BeforeAll
    fun setUp() {
        try {
            client = ZCodeProtocolClient.start()
            assertTrue(client.isAlive(), "app-server 进程应该存活")
            println("✅ ZCodeProtocolClient 启动成功")
        } catch (e: Exception) {
            println("⚠️ 跳过测试（环境不可用）: ${e.message}")
            assumeTrue(false, "ZCode 环境不可用: ${e.message}")
        }
    }

    @AfterAll
    fun tearDown() {
        if (::client.isInitialized) client.close()
    }

    @Test
    fun `mcp list status 模式返回 statuses`() {
        val result = client.listMcpServers(System.getProperty("user.dir"), mode = "status")
        // 响应可能含 authorization 等凭证字段，先脱敏再截断（showStandardStreams=true 会落入 CI 日志）
        println("✅ mcp/list(status) 响应: ${LogRedactor.redact(result.toString()).take(500)}")
        assertTrue(result.containsKey("statuses"), "响应应含 statuses 节点")
        val statuses = result["statuses"]!!.jsonObject
        println("   statuses 数量: ${statuses.size}")
        statuses.entries.take(5).forEach { (name, st) ->
            println("   - $name: ${LogRedactor.redact(st.toString()).take(120)}")
        }
    }
}
