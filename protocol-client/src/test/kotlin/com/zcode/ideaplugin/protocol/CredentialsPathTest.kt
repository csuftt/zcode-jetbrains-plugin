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

    // ============ hasFamilyOAuthToken（订阅制套餐 oauth 兜底判定） ============

    /** 在 config.json 同目录写 credentials.json（token 键值对 JSON 文本） */
    private fun givenCredentials(tokensJson: String) {
        Files.createDirectories(home.resolve(".zcode/v2"))
        home.resolve(".zcode/v2/credentials.json").toFile().writeText(tokensJson)
    }

    @Test
    fun `bigmodel coding-plan 判可用`() {
        givenCredentials("""{"oauth:bigmodel:access_token": "tok-abc"}""")
        assertTrue(Credentials.hasFamilyOAuthToken("builtin:bigmodel-coding-plan", Credentials.configPathFor(home.toString())))
    }

    @Test
    fun `zai coding-plan 判可用`() {
        givenCredentials("""{"oauth:zai:access_token": "tok-xyz"}""")
        assertTrue(Credentials.hasFamilyOAuthToken("builtin:zai-coding-plan", Credentials.configPathFor(home.toString())))
    }

    @Test
    fun `API Key 渠道空 key 不兜底`() {
        // builtin:bigmodel / builtin:zai 是手填 key 渠道，无 oauth 凭证链：空 key =
        // 未配置。兜底放行会出现"列表显示可用而凭据自检报无凭证"的矛盾（0.2.6 实测反馈）
        givenCredentials("""{"oauth:bigmodel:access_token": "tok-abc", "oauth:zai:access_token": "tok-xyz"}""")
        assertEquals(false, Credentials.hasFamilyOAuthToken("builtin:bigmodel", Credentials.configPathFor(home.toString())))
        assertEquals(false, Credentials.hasFamilyOAuthToken("builtin:zai", Credentials.configPathFor(home.toString())))
    }

    @Test
    fun `第三方 provider 永不兜底`() {
        // token 拿了没用：第三方无 oauth 家族，即便 credentials.json 满是官方 token 也不算数
        givenCredentials("""{"oauth:bigmodel:access_token": "tok-abc", "oauth:zai:access_token": "tok-xyz"}""")
        assertEquals(false, Credentials.hasFamilyOAuthToken("27d2ecde-custom", Credentials.configPathFor(home.toString())))
    }

    @Test
    fun `家族 token 缺失或空白判不可用`() {
        givenCredentials("""{"oauth:zai:access_token": "tok-xyz"}""")
        assertEquals(false, Credentials.hasFamilyOAuthToken("builtin:bigmodel-coding-plan", Credentials.configPathFor(home.toString())))
        givenCredentials("""{"oauth:bigmodel:access_token": "  "}""")
        assertEquals(false, Credentials.hasFamilyOAuthToken("builtin:bigmodel-coding-plan", Credentials.configPathFor(home.toString())))
    }

    @Test
    fun `credentials json 缺失或损坏判不可用不抛`() {
        assertEquals(false, Credentials.hasFamilyOAuthToken("builtin:bigmodel-coding-plan", home.resolve("none/config.json")))
        givenCredentials("""{"broken""")
        assertEquals(false, Credentials.hasFamilyOAuthToken("builtin:bigmodel-coding-plan", Credentials.configPathFor(home.toString())))
    }

    // ============ activeBuiltinProviderId（客户端激活渠道判定） ============

    /** 在 config.json 同目录写 setting.json 的 selectedKey/domain 相关键 */
    private fun givenSelection(selectedKeys: String?, domain: String? = null) {
        givenSetting(dataBaseDir = null, content = buildString {
            append("{")
            if (selectedKeys != null) append("\"modelProviderFamilySelectedKeys\": $selectedKeys")
            if (selectedKeys != null && domain != null) append(", ")
            if (domain != null) append("\"providerFamilyDomain\": \"$domain\"")
            append("}")
        })
    }

    @Test
    fun `selectedKey 去前缀得到激活 providerId`() {
        // API Key 模式与订阅模式前缀不同（实测 preset: / coding-plan:），都要剥
        givenSelection("""{"bigmodel": "preset:builtin:bigmodel"}""", "bigmodel")
        assertEquals(
            "builtin:bigmodel",
            Credentials.activeBuiltinProviderId(Credentials.configPathFor(home.toString())),
        )
        givenSelection("""{"bigmodel": "coding-plan:builtin:bigmodel-coding-plan"}""", "bigmodel")
        assertEquals(
            "builtin:bigmodel-coding-plan",
            Credentials.activeBuiltinProviderId(Credentials.configPathFor(home.toString())),
        )
    }

    @Test
    fun `domain 指向的家族优先于首个家族`() {
        givenSelection("""{"bigmodel": "preset:builtin:bigmodel", "zai": "preset:builtin:zai-coding-plan"}""", "zai")
        assertEquals(
            "builtin:zai-coding-plan",
            Credentials.activeBuiltinProviderId(Credentials.configPathFor(home.toString())),
        )
    }

    @Test
    fun `setting 缺失或结构无效返回 null`() {
        assertEquals(null, Credentials.activeBuiltinProviderId(home.resolve("none/config.json")))
        givenSetting(dataBaseDir = null, content = "{}") // 无 selectedKeys 节
        assertEquals(null, Credentials.activeBuiltinProviderId(Credentials.configPathFor(home.toString())))
        givenSelection("""{"broken""") // JSON 损坏
        assertEquals(null, Credentials.activeBuiltinProviderId(Credentials.configPathFor(home.toString())))
    }

    @Test
    fun `loadOrNull 优先激活渠道的 key（计费渠道不串）`() {
        // 两个 enabled 渠道 key 不同：builtin:bigmodel 在 JSON 前、coding-plan 在后；
        // 激活的是 coding-plan → env 注入必须取套餐 key，而非按顺序取首个
        givenConfig("""
            {"builtin:bigmodel": {"enabled": true, "kind": "anthropic",
              "options": {"baseURL": "https://open.bigmodel.cn/api/anthropic", "apiKey": "sk-apikey"},
              "models": {"GLM-5.3": {}}},
             "builtin:bigmodel-coding-plan": {"enabled": true, "kind": "anthropic",
              "options": {"baseURL": "https://open.bigmodel.cn/api/anthropic", "apiKey": "sk-plan"},
              "models": {"GLM-5.3": {}}}}
        """.trimIndent())
        givenSelection("""{"bigmodel": "preset:builtin:bigmodel-coding-plan"}""", "bigmodel")
        val c = Credentials.loadOrNull(Credentials.configPathFor(home.toString()))
        assertEquals("sk-plan", c?.apiKey, "应取激活渠道（coding-plan）的 key")
    }

    // ============ effectiveBuiltinProviderId（selectedKey 权威 + config 兜底） ============

    @Test
    fun `selectedKey 前缀变种解析不匹配时兜底首个可用内置`() {
        // 未知前缀（如未来 mode 变种 "trial:builtin:bigmodel"）→ 解析出的 id 不在
        // provider 表 → 兜底取首个 enabled 且有 apiKey 的内置（builtin:bigmodel）
        givenConfig("""
            {"builtin:bigmodel": {"enabled": true, "kind": "anthropic",
              "options": {"baseURL": "https://example.com/api", "apiKey": "sk-apikey"},
              "models": {"GLM-5.3": {}}},
             "builtin:bigmodel-coding-plan": {"enabled": true, "kind": "anthropic",
              "options": {"baseURL": "https://example.com/api", "apiKey": "sk-plan"},
              "models": {"GLM-5.3": {}}}}
        """.trimIndent())
        givenSelection("""{"bigmodel": "trial:builtin:bigmodel"}""", "bigmodel")
        assertEquals(
            "builtin:bigmodel",
            Credentials.effectiveBuiltinProviderId(Credentials.configPathFor(home.toString())),
        )
    }

    @Test
    fun `selectedKey 缺失时同样走 config 兜底`() {
        givenConfig("""
            {"builtin:bigmodel": {"enabled": false, "kind": "anthropic",
              "options": {"baseURL": "https://example.com/api", "apiKey": "sk-apikey"},
              "models": {"GLM-5.3": {}}},
             "builtin:bigmodel-coding-plan": {"enabled": true, "kind": "anthropic",
              "options": {"baseURL": "https://example.com/api", "apiKey": "sk-plan"},
              "models": {"GLM-5.3": {}}}}
        """.trimIndent())
        givenSetting(dataBaseDir = null, content = "{}") // 无 selectedKeys
        assertEquals(
            "builtin:bigmodel-coding-plan",
            Credentials.effectiveBuiltinProviderId(Credentials.configPathFor(home.toString())),
            "禁用的 builtin:bigmodel 应被跳过，取首个 enabled+key 的 coding-plan",
        )
    }

    @Test
    fun `selectedKey 指向空 key 渠道时兜底到凭证可用的内置`() {
        // 在客户端选着 API Key 方式但把 key 删了：selectedKey 权威命中 builtin:bigmodel
        // 但凭证已失效 → 须落到 coding-plan，否则内置渠道整体消失（0.2.6 实测反馈）
        givenConfig("""
            {"builtin:bigmodel": {"enabled": true, "kind": "anthropic",
              "options": {"baseURL": "https://example.com/api", "apiKey": ""},
              "models": {"GLM-5.3": {}}},
             "builtin:bigmodel-coding-plan": {"enabled": true, "kind": "anthropic",
              "options": {"baseURL": "https://example.com/api", "apiKey": "sk-plan"},
              "models": {"GLM-5.3": {}}}}
        """.trimIndent())
        givenSelection("""{"bigmodel": "preset:builtin:bigmodel"}""", "bigmodel")
        assertEquals(
            "builtin:bigmodel-coding-plan",
            Credentials.effectiveBuiltinProviderId(Credentials.configPathFor(home.toString())),
        )
    }

    @Test
    fun `无任何可用内置时返回 null`() {
        givenConfig("""
            {"builtin:bigmodel": {"enabled": false, "kind": "anthropic",
              "options": {"baseURL": "https://example.com/api", "apiKey": "sk-apikey"},
              "models": {"GLM-5.3": {}}}}
        """.trimIndent())
        givenSetting(dataBaseDir = null, content = "{}")
        assertEquals(null, Credentials.effectiveBuiltinProviderId(Credentials.configPathFor(home.toString())))
    }

    @Test
    fun `dataBaseDir 迁移后激活态从 home 入口 setting 解析`() {
        // 2026-08-28 G 盘迁移实测：setting.json 恒在 home 入口（与 dataBaseDir 同文件），
        // config.json 迁到新位置后其兄弟目录没有 setting.json——兄弟缺席须回 home 入口读，
        // 否则权威链判空误走兜底（模型列表碰巧相同，但命中方式徽章与解析路径都错）
        val newRoot = home.resolve("newroot")
        val escaped = newRoot.toString().replace("\\", "\\\\")
        givenSetting(dataBaseDir = null, content = """
            {"dataBaseDir": "$escaped",
             "modelProviderFamilySelectedKeys": {"bigmodel": "coding-plan:builtin:bigmodel-coding-plan"},
             "providerFamilyDomain": "bigmodel"}
        """.trimIndent())
        val newConfig = newRoot.resolve(".zcode/v2/config.json")
        Files.createDirectories(newConfig.parent)
        newConfig.toFile().writeText("""
            {"builtin:bigmodel-coding-plan": {"enabled": true, "kind": "anthropic",
              "options": {"baseURL": "https://example.com/api", "apiKey": "sk-plan"},
              "models": {"GLM-5.3": {}}}}
        """.trimIndent())
        val cfg = Credentials.configPathFor(home.toString())
        assertEquals(newConfig, cfg) // 重定向生效：此时 cfg 兄弟目录无 setting.json
        assertEquals(
            "builtin:bigmodel-coding-plan",
            Credentials.activeBuiltinProviderId(cfg, home.resolve(".zcode/v2/setting.json")),
        )
    }

    @Test
    fun `resolution 权威命中标记 viaSelected`() {
        givenConfig("""
            {"builtin:zai": {"enabled": true, "kind": "anthropic",
              "options": {"baseURL": "https://example.com/api", "apiKey": "sk-apikey"},
              "models": {"GLM-5.3": {}}}}
        """.trimIndent())
        givenSelection("""{"zai": "preset:builtin:zai"}""", "zai")
        val r = Credentials.builtinResolution(Credentials.configPathFor(home.toString()))
        assertEquals("builtin:zai", r.providerId)
        assertEquals(true, r.viaSelected)
    }

    @Test
    fun `resolution 客户端选中门控渠道时兜底并标记 selectedGated`() {
        // 体验套餐(zcode-plan 网关)在解析层整体排除：客户端切到体验套餐时插件自动
        // 兜底首个非门控内置（个人套餐/API Key），selectedGated 供徽章区分兜底原因
        givenConfig("""
            {"builtin:bigmodel-start-plan": {"enabled": true, "kind": "anthropic",
              "options": {"baseURL": "https://zcode.z.ai/api/v1/zcode-plan/anthropic", "apiKey": "jwt"},
              "models": {"GLM-5.3-Flash": {}}},
             "builtin:bigmodel": {"enabled": true, "kind": "anthropic",
              "options": {"baseURL": "https://example.com/api", "apiKey": "sk-apikey"},
              "models": {"GLM-5.3": {}}}}
        """.trimIndent())
        givenSelection("""{"bigmodel": "coding-plan:builtin:bigmodel-start-plan"}""", "bigmodel")
        val r = Credentials.builtinResolution(Credentials.configPathFor(home.toString()))
        assertEquals("builtin:bigmodel", r.providerId)
        assertEquals(false, r.viaSelected)
        assertEquals(true, r.selectedGated)
    }

    @Test
    fun `loadOrNull 门控激活渠道时凭证取自兜底渠道`() {
        givenConfig("""
            {"builtin:bigmodel-start-plan": {"enabled": true, "kind": "anthropic",
              "options": {"baseURL": "https://zcode.z.ai/api/v1/zcode-plan/anthropic", "apiKey": "jwt"},
              "models": {"GLM-5.3-Flash": {}}},
             "builtin:bigmodel": {"enabled": true, "kind": "anthropic",
              "options": {"baseURL": "https://example.com/api", "apiKey": "sk-apikey"},
              "models": {"GLM-5.3": {}}}}
        """.trimIndent())
        givenSelection("""{"bigmodel": "coding-plan:builtin:bigmodel-start-plan"}""", "bigmodel")
        val creds = Credentials.loadOrNull(Credentials.configPathFor(home.toString()))
        assertEquals("sk-apikey", creds?.apiKey)
    }

    @Test
    fun `resolution 兜底命中标记非 viaSelected`() {
        // 客户端选着订阅渠道但凭证不可用（空 key 无 token）→ 兜底到 API Key 渠道
        givenConfig("""
            {"builtin:zai-coding-plan": {"enabled": true, "kind": "anthropic",
              "options": {"baseURL": "https://example.com/api", "apiKey": ""},
              "models": {"GLM-5.3": {}}},
             "builtin:zai": {"enabled": true, "kind": "anthropic",
              "options": {"baseURL": "https://example.com/api", "apiKey": "sk-apikey"},
              "models": {"GLM-5.3": {}}}}
        """.trimIndent())
        givenSelection("""{"zai": "coding-plan:builtin:zai-coding-plan"}""", "zai")
        val r = Credentials.builtinResolution(Credentials.configPathFor(home.toString()))
        assertEquals("builtin:zai", r.providerId)
        assertEquals(false, r.viaSelected)
    }
}
