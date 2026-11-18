package com.zcode.ideaplugin.ui

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
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
        // marketplaces/ 下是市场清单（未安装），扫描结果不应包含它们。
        // 环境敏感断言：只检查本机确认未安装的条目（context7 等已被实际安装，
        // 出现在扫描结果是正确行为——plugins 三棵树语义见记忆 zcode-plugins-dir-semantics）
        val servers = McpConfigReader.scan(null)
        val names = servers.map { it.name }.toSet()
        val marketOnly = listOf("discord").filter { it in names }
        assertTrue(marketOnly.isEmpty(), "市场索引条目不应出现: $names")
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

    // ============ 运行时命名空间归并（同一服务两条注册路径不重复展示） ============

    private fun pluginEntry(name: String, pluginName: String?) = McpConfigReader.McpServerInfo(
        name = name, scope = "plugin", transport = "http", command = null,
        args = emptyList(), url = "https://example.com", envKeys = emptyList(),
        envValues = emptyMap(), headerValues = emptyMap(),
        enabled = true, configPath = "C:/x/.mcp.json", pluginName = pluginName,
        status = null, toolCount = null, statusError = null, updatedAt = null,
    )

    private fun st(status: String, toolCount: Int) = buildJsonObject {
        put("status", status)
        put("toolCount", toolCount)
    }

    @Test
    fun `命名空间 key 按 插件名-服务名 拼接`() {
        assertEquals("plugin:context7:context7", McpConfigReader.namespacedRuntimeKey(pluginEntry("context7", "context7")))
        assertEquals("plugin:document-skills:image_search", McpConfigReader.namespacedRuntimeKey(pluginEntry("image_search", "document-skills")))
        assertNull(McpConfigReader.namespacedRuntimeKey(pluginEntry("web-search", null)), "非插件条目无命名空间形态")
    }

    @Test
    fun `pickStatus 命名空间 connected 者胜`() {
        // 直接名 failed + 命名空间 connected → 用命名空间（服务实际可用）
        val statuses = JsonObject(
            mapOf(
                "image_search" to st("failed", 0),
                "plugin:document-skills:image_search" to st("connected", 5),
            )
        )
        val picked = assertNotNull(McpConfigReader.pickStatus(pluginEntry("image_search", "document-skills"), statuses))
        assertEquals("connected", picked.str("status"))
        assertEquals(5, picked.str("toolCount")?.toInt())
    }

    @Test
    fun `pickStatus 双 connected 或双 failed 以直接 key 为准`() {
        val statuses = JsonObject(
            mapOf(
                "context7" to st("connected", 2),
                "plugin:context7:context7" to st("connected", 2),
            )
        )
        val s = pluginEntry("context7", "context7")
        val picked = assertNotNull(McpConfigReader.pickStatus(s, statuses))
        assertTrue(picked === statuses["context7"], "双 connected 用直接条目对象")

        val failBoth = JsonObject(
            mapOf(
                "image_search" to st("failed", 0),
                "plugin:document-skills:image_search" to st("failed", 0),
            )
        )
        val picked2 = assertNotNull(McpConfigReader.pickStatus(pluginEntry("image_search", "document-skills"), failBoth))
        assertTrue(picked2 === failBoth["image_search"], "双 failed 用直接条目（贴近配置文件路径）")
    }

    @Test
    fun `pickStatus 直接名缺失回退命名空间 两者皆无返回 null`() {
        val statuses = JsonObject(mapOf("plugin:context7:context7" to st("connected", 2)))
        val s = pluginEntry("context7", "context7")
        assertEquals("connected", McpConfigReader.pickStatus(s, statuses)?.str("status"))

        assertNull(McpConfigReader.pickStatus(s, JsonObject(emptyMap())), "两者皆无 → null")
        assertNull(
            McpConfigReader.pickStatus(pluginEntry("web-search", null), JsonObject(mapOf("plugin:x:web-search" to st("connected", 1)))),
            "非插件条目只看直接名，不回退命名空间"
        )
    }

    private fun JsonObject.str(key: String): String? =
        runCatching { this[key]!!.jsonPrimitive.content }.getOrNull()

    // ============ 官方 HTTP MCP：URL 占位符 + 探针身份头（0.4.6） ============

    private fun officialHttpEntry(url: String, pluginName: String?) = McpConfigReader.McpServerInfo(
        name = "image_search", scope = "plugin", transport = "http", command = null,
        args = emptyList(), url = url, envKeys = emptyList(),
        envValues = emptyMap(), headerValues = emptyMap(),
        enabled = true, configPath = "C:/x/.mcp.json", pluginName = pluginName,
        raw = buildJsonObject {
            put("type", "http")
            put("url", url)
            put("auth", buildJsonObject { put("type", "zcode_official") })
        },
        status = null, toolCount = null, statusError = null, updatedAt = null,
    )

    @Test
    fun `ZCODE_BASE_URL 占位符展开为官方 origin 且身份头注入`() {
        val entry = officialHttpEntry("\${ZCODE_BASE_URL}/api/v1/mcp/server/image_search", "image-search")
        var seenUrl = ""
        val param = assertNotNull(
            McpConfigReader.toProtocolParam(entry, "E:/ws") { _, url ->
                seenUrl = url
                mapOf("Authorization" to "Bearer test-jwt")
            }
        )
        val json = param.toString()
        assertFalse(json.contains("\${ZCODE_BASE_URL}"), "占位符必须展开：$json")
        assertEquals("https://zcode.z.ai/api/v1/mcp/server/image_search", seenUrl)
        assertTrue(json.contains("Authorization"), "官方 MCP 探针应带身份头：$json")
        assertTrue(json.contains("Bearer test-jwt"))
    }

    @Test
    fun `非官方 origin 不下发身份头`() {
        val entry = officialHttpEntry("https://evil.example.com/mcp", "image-search")
        val json = McpConfigReader.toProtocolParam(entry, "E:/ws").toString()
        assertFalse(json.contains("Authorization"), "跨 origin 不得携带身份头：$json")
    }
}
