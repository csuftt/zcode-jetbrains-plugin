package com.zcode.ideaplugin.protocol

import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Disabled
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * 真机验证（仅本机手跑，默认禁用）：官方 HTTP MCP `image_search` 端到端连接。
 *
 * 前置：`~/.zcode/cli/config.json` 的 plugins.enabledPlugins 中
 * `image-search@zcode-plugins-official` = true（本机 2026-11-18 已验证）。
 * 依赖：本机登录态、凭据管理器、网络可达 zcode.z.ai。
 * 链路：spawn app-server（注入 ZCODE_BASE_URL）→ mcp/list connect → CLI 反向请求
 * requestOfficialMcpAuthHeaders → [OfficialMcpAuth] 用真实凭据应答 → HTTP MCP 连上。
 */
@Disabled("真机专属：依赖本机登录态与网络")
class ImageSearchRealMachineTest {

    @Test
    fun `image_search 官方 HTTP MCP 能连接并返回工具`() {
        val workspace = System.getProperty("user.dir")
        ZCodeProtocolClient.start().use { client ->
            val result = client.listMcpServers(workspace, mode = "connect", timeoutMs = 120_000)
            val statuses = result["statuses"]!!.jsonObject
            val key = "plugin:image-search:image_search"
            val status = statuses[key]?.jsonObject
            assertNotNull(status, "运行时未注册 $key（statuses=${statuses.keys}）")
            assertEquals("connected", status["status"]?.jsonPrimitive?.content, "连接状态异常：$status")
            assertTrue(
                (status["toolCount"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0) > 0,
                "连接成功但工具数为 0：$status",
            )
            println("image_search 真机链路 PASS tools=${status["toolCount"]}")
        }
    }
}