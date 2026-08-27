package com.zcode.ideaplugin.protocol

import java.nio.file.Files
import kotlin.io.path.isRegularFile
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * 凭证路径解析（dataBaseDir 自动跟随）单元测试
 *
 * 场景来自 ZCode 客户端数据目录迁移的实测：
 * - 入口 setting.json 恒在 user home，dataBaseDir 指向新数据根
 * - 配置后 v2 数据（含凭证 config.json）只在新位置演进
 * - 迁移中途/异常（新位置文件缺失）须回退旧位置
 */
class CredentialsPathTest {

    private val home = Files.createTempDirectory("cred-path-test")

    @AfterTest
    fun cleanup() {
        home.toFile().deleteRecursively()
    }

    /** 在 home 下放置 setting.json（写 dataBaseDir 字段则同时建新位置 config.json） */
    private fun givenSetting(dataBaseDir: String?, configInNewLocation: Boolean = false, content: String? = null) {
        Files.createDirectories(home.resolve(".zcode/v2"))
        val setting = buildString {
            append("{")
            if (dataBaseDir != null) append("\"dataBaseDir\": \"${dataBaseDir.replace("\\", "\\\\")}\"")
            append("}")
        }
        home.resolve(".zcode/v2/setting.json").toFile().writeText(content ?: setting)
        if (dataBaseDir != null && configInNewLocation) {
            val newConfig = home.resolve("newroot/.zcode/v2/config.json")
            Files.createDirectories(newConfig.parent)
            newConfig.toFile().writeText("{}")
        }
    }

    @Test
    fun `未配置 dataBaseDir 时走默认旧位置`() {
        givenSetting(dataBaseDir = null)
        assertEquals(
            home.resolve(".zcode/v2/config.json"),
            Credentials.configPathFor(home.toString()),
        )
    }

    @Test
    fun `setting 文件不存在时走默认旧位置`() {
        assertEquals(
            home.resolve(".zcode/v2/config.json"),
            Credentials.configPathFor(home.toString()),
        )
    }

    @Test
    fun `配置 dataBaseDir 且新位置存在时跟随新位置`() {
        givenSetting(dataBaseDir = home.resolve("newroot").toString(), configInNewLocation = true)
        assertEquals(
            home.resolve("newroot/.zcode/v2/config.json"),
            Credentials.configPathFor(home.toString()),
        )
    }

    @Test
    fun `配置 dataBaseDir 但新位置文件缺失时回退旧位置`() {
        // 迁移中途：setting 已指向新位置但拷贝未完成
        givenSetting(dataBaseDir = home.resolve("newroot").toString(), configInNewLocation = false)
        assertEquals(
            home.resolve(".zcode/v2/config.json"),
            Credentials.configPathFor(home.toString()),
        )
    }

    @Test
    fun `setting 文件损坏时按未配置处理`() {
        givenSetting(dataBaseDir = null, content = "{\"dataBaseDir\": \"F:\\\\Zcode\", broken")
        assertEquals(
            home.resolve(".zcode/v2/config.json"),
            Credentials.configPathFor(home.toString()),
        )
    }

    @Test
    fun `dataBaseDir 为空白串时按未配置处理`() {
        givenSetting(dataBaseDir = null, content = "{\"dataBaseDir\": \"  \"}")
        assertEquals(
            home.resolve(".zcode/v2/config.json"),
            Credentials.configPathFor(home.toString()),
        )
    }

    @Test
    fun `defaultConfigPath 真机解析到存在的文件`() {
        // 前置：本机已登录 ZCode（与 EnvChecker 真机测试同风格）
        val p = Credentials.defaultConfigPath()
        assertTrue(p.isRegularFile(), "应解析到存在的 config.json: $p（跟随 dataBaseDir 或默认位置）")
    }

    // ============ loadOrNull（issue #4 凭证降级） ============

    /** 在默认位置写 config.json（providers JSON 文本） */
    private fun givenConfig(providersJson: String) {
        Files.createDirectories(home.resolve(".zcode/v2"))
        home.resolve(".zcode/v2/config.json").toFile().writeText("""{"provider": $providersJson}""")
    }

    private val enabledProvider = """
        {"p1": {"enabled": true, "kind": "anthropic",
          "options": {"baseURL": "https://example.com/api", "apiKey": "sk-test"},
          "models": {"GLM-5.3": {}}}}
    """.trimIndent()

    @Test
    fun `loadOrNull 读到 enabled anthropic provider`() {
        givenConfig(enabledProvider)
        val c = Credentials.loadOrNull(Credentials.configPathFor(home.toString()))
        assertEquals("sk-test", c?.apiKey)
        assertEquals("GLM-5.3", c?.model)
    }

    @Test
    fun `loadOrNull 空串 apiKey 跳过而非穿透`() {
        // oauth 系 provider 的占位空串：旧行为会穿透成"读到 apiKey= 空凭证"，
        // 注入空 ANTHROPIC_API_KEY 反而挡住 app-server 自身凭证链
        givenConfig("""
            {"p1": {"enabled": true, "kind": "anthropic",
              "options": {"baseURL": "https://example.com/api", "apiKey": ""},
              "models": {"GLM-5.3": {}}}}
        """.trimIndent())
        assertEquals(null, Credentials.loadOrNull(Credentials.configPathFor(home.toString())))
    }

    @Test
    fun `loadOrNull 空白 baseURL 同样跳过`() {
        givenConfig("""
            {"p1": {"enabled": true, "kind": "anthropic",
              "options": {"baseURL": "  ", "apiKey": "sk-test"},
              "models": {"GLM-5.3": {}}}}
        """.trimIndent())
        assertEquals(null, Credentials.loadOrNull(Credentials.configPathFor(home.toString())))
    }

    @Test
    fun `enabled 字段缺失视为启用（与 RuntimeModels 同口径）`() {
        // config.json 存在无 enabled 字段但实际启用的自定义 provider（如 DeepSeek）：
        // 旧逻辑按不启用跳过会误报"没有找到 enabled 的 anthropic provider"
        givenConfig("""
            {"p-custom": {"kind": "anthropic",
              "options": {"baseURL": "https://deepseek.example/anthropic", "apiKey": "sk-custom"},
              "models": {"deepseek-v4": {}}}}
        """.trimIndent())
        val c = Credentials.loadOrNull(Credentials.configPathFor(home.toString()))
        assertEquals("sk-custom", c?.apiKey, "enabled 缺失的 provider 应视为启用")
    }

    @Test
    fun `loadOrNull 文件缺失或结构无效返回 null 不抛`() {
        assertEquals(null, Credentials.loadOrNull(home.resolve("none/config.json")))
        givenConfig("{}") // 无 provider 节
        assertEquals(null, Credentials.loadOrNull(Credentials.configPathFor(home.toString())))
    }

    @Test
    fun `load 文件缺失抛 IllegalArgumentException 保留 credsMissing 语义`() {
        val e = kotlin.runCatching { Credentials.load(home.resolve("none/config.json")) }.exceptionOrNull()
        assertTrue(e is IllegalArgumentException, "文件缺失应为 credsMissing 语义: $e")
    }

    @Test
    fun `load 无可用 provider 抛 IllegalStateException`() {
        givenConfig(enabledProvider.replace("\"enabled\": true", "\"enabled\": false"))
        val e = kotlin.runCatching { Credentials.load(Credentials.configPathFor(home.toString())) }.exceptionOrNull()
        assertTrue(e is IllegalStateException && e !is IllegalArgumentException, "结构无效应为 credsInvalid 语义: $e")
    }
}
