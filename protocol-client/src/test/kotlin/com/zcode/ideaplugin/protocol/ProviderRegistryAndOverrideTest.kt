package com.zcode.ideaplugin.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.nio.file.Files
import kotlin.io.path.writeText
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * ~/.zcgui/config.json 覆盖存取 + runtimeModel 构造的 key 优先级合并（issue #8）。
 */
class ProviderRegistryAndOverrideTest {

    private val home = Files.createTempDirectory("registry-test")
    private val configPath = home.resolve(".zcode/v2/config.json")

    @AfterTest
    fun cleanup() {
        home.toFile().deleteRecursively()
    }

    private fun givenConfig(content: String) {
        Files.createDirectories(configPath.parent)
        configPath.writeText(content)
    }

    // ============ ZcGuiConfig（~/.zcgui/config.json） ============

    @Test
    fun `覆盖表读写与清除`() {
        assertEquals(emptyMap(), ZcGuiConfig.providerKeyOverrides(home.toString()))
        assertTrue(ZcGuiConfig.setProviderKeyOverride("builtin:bigmodel-coding-plan", "k-1", home.toString()))
        assertEquals(mapOf("builtin:bigmodel-coding-plan" to "k-1"), ZcGuiConfig.providerKeyOverrides(home.toString()))
        // 第二渠道写入保留首条
        ZcGuiConfig.setProviderKeyOverride("builtin:zai-coding-plan", "k-2", home.toString())
        assertEquals(
            mapOf("builtin:bigmodel-coding-plan" to "k-1", "builtin:zai-coding-plan" to "k-2"),
            ZcGuiConfig.providerKeyOverrides(home.toString()),
        )
        // 清除单条
        assertTrue(ZcGuiConfig.setProviderKeyOverride("builtin:bigmodel-coding-plan", null, home.toString()))
        assertEquals(mapOf("builtin:zai-coding-plan" to "k-2"), ZcGuiConfig.providerKeyOverrides(home.toString()))
    }

    @Test
    fun `损坏或缺失文件按空表处理`() {
        assertEquals(emptyMap(), ZcGuiConfig.providerKeyOverrides(home.resolve("none").toString()))
        val f = ZcGuiConfig.configPath(home.toString())
        Files.createDirectories(f.parent)
        f.writeText("{broken")
        assertEquals(emptyMap(), ZcGuiConfig.providerKeyOverrides(home.toString()))
    }

    @Test
    fun `空白值条目读取时忽略`() {
        val f = ZcGuiConfig.configPath(home.toString())
        Files.createDirectories(f.parent)
        f.writeText("""{"providerKeyOverrides": {"builtin:bigmodel-coding-plan": "  "}}""")
        assertEquals(emptyMap(), ZcGuiConfig.providerKeyOverrides(home.toString()))
    }

    // ============ RuntimeModels key 优先级（zcgui 覆盖 > config.json） ============

    private val configBody = """
        {"provider": {"builtin:bigmodel-coding-plan": {"kind": "anthropic", "source": "custom",
          "enabled": true,
          "options": {"baseURL": "https://open.bigmodel.cn/api/anthropic", "apiKey": "sk-config"},
          "models": {"GLM-5.3": {"name": "GLM-5.3",
            "limit": {"context": 1000000, "output": 128000}}}}}}
    """.trimIndent()

    private fun apiKeyOf(rm: JsonObject): String? =
        rm["provider"]!!.jsonObject["apiKey"]?.jsonObject?.get("value")?.jsonPrimitive?.content

    private fun buildWith(overrides: Map<String, String>): String? {
        givenConfig(configBody)
        val rm = RuntimeModels.buildRuntimeModel("builtin:bigmodel-coding-plan", "GLM-5.3", configPath, overrides)!!
        return apiKeyOf(rm)
    }

    @Test
    fun `覆盖优先于 config 值且空白覆盖让位`() {
        assertEquals("team-key-1", buildWith(mapOf("builtin:bigmodel-coding-plan" to "team-key-1")), "覆盖替换 config key")
        assertEquals("sk-config", buildWith(mapOf("builtin:bigmodel-coding-plan" to "  ")), "空白覆盖让位 config 值")
        assertEquals("sk-config", buildWith(emptyMap()), "无覆盖维持 config 值")
    }

    @Test
    fun `config 无明文 key 时覆盖仍注入`() {
        givenConfig("""
            {"provider": {"builtin:bigmodel-coding-plan": {"kind": "anthropic", "enabled": true,
              "options": {"baseURL": "https://open.bigmodel.cn/api/anthropic", "apiKey": ""},
              "models": {"GLM-5.3": {}}}}}
        """.trimIndent())
        val rm = RuntimeModels.buildRuntimeModel(
            "builtin:bigmodel-coding-plan", "GLM-5.3", configPath,
            mapOf("builtin:bigmodel-coding-plan" to "oauth-fallback-key"),
        )!!
        assertEquals("oauth-fallback-key", apiKeyOf(rm), "oauth 渠道 config 无 key，手填覆盖注入（团队场景核心）")
    }
}
