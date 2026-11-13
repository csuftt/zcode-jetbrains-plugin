package com.zcode.ideaplugin.protocol

import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.jupiter.api.io.TempDir

/**
 * ProtocolGenerations 判代与 BuiltinModelCatalog 解析单测（2026-09-17 双代适配）。
 * 全部基于临时目录构造文件，不依赖本机真实 ~/.zcode。
 */
class ProtocolGenerationTest {

    @TempDir
    lateinit var home: Path

    private fun v2(): Path = home.resolve(".zcode/v2").also { Files.createDirectories(it) }

    // ============ detectByConfig（setting.json 键形态 + provider_config 存在性兜底） ============

    @Test
    fun `setting 含 providerFamilyConnectionSelections 判 NEW`() {
        v2().resolve("setting.json").toFile().writeText("""{"providerFamilyConnectionSelections":{"bigmodel":{"kind":"individual-coding-plan"}}}""")
        assertEquals(ProtocolGeneration.NEW, ProtocolGenerations.detectByConfig(home.toString()))
    }

    @Test
    fun `setting 含 modelProviderFamilySelectedKeys 判 OLD`() {
        v2().resolve("setting.json").toFile().writeText("""{"modelProviderFamilySelectedKeys":{"bigmodel":"coding-plan:builtin:bigmodel-coding-plan"},"modelProviderFamilyModes":{}}""")
        assertEquals(ProtocolGeneration.OLD, ProtocolGenerations.detectByConfig(home.toString()))
    }

    @Test
    fun `setting 缺失且 provider_config 存在判 NEW`() {
        v2().resolve("provider_config.json").toFile().writeText("""{"schemaVersion":1}""")
        assertEquals(ProtocolGeneration.NEW, ProtocolGenerations.detectByConfig(home.toString()))
    }

    @Test
    fun `两者皆无判 OLD`() {
        v2()
        assertEquals(ProtocolGeneration.OLD, ProtocolGenerations.detectByConfig(home.toString()))
    }

    // ============ detect（zcode.cjs 内容标记主判 + mtime 缓存失效） ============

    @Test
    fun `zcode_cjs 含新版标记判 NEW`() {
        val cjs = home.resolve("zcode.cjs")
        cjs.toFile().writeText("x".repeat(100) + "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE" + "y".repeat(100))
        assertEquals(ProtocolGeneration.NEW, ProtocolGenerations.detect(cjs, home.toString()))
    }

    @Test
    fun `zcode_cjs 无标记判 OLD`() {
        val cjs = home.resolve("zcode.cjs")
        cjs.toFile().writeText("console.log('old cli')")
        assertEquals(ProtocolGeneration.OLD, ProtocolGenerations.detect(cjs, home.toString()))
    }

    @Test
    fun `标记跨读块边界仍命中（大文件滑动窗口）`() {
        val cjs = home.resolve("zcode.cjs")
        // 64K 填充 + 标记居中 + 尾部填充，覆盖 containsMarker 的跨块保留逻辑
        cjs.toFile().writeText("a".repeat(70_000) + "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE" + "b".repeat(70_000))
        assertEquals(ProtocolGeneration.NEW, ProtocolGenerations.detect(cjs, home.toString()))
    }

    @Test
    fun `zcode_cjs 不可读落配置兜底`() {
        val missing = home.resolve("nope.cjs")
        v2().resolve("setting.json").toFile().writeText("""{"modelProviderFamilySelectedKeys":{}}""")
        assertEquals(ProtocolGeneration.OLD, ProtocolGenerations.detect(missing, home.toString()))
    }

    @Test
    fun `mtime 变化缓存失效重判（升级回滚场景）`() {
        val cjs = home.resolve("zcode.cjs")
        cjs.toFile().writeText("old content")
        assertEquals(ProtocolGeneration.OLD, ProtocolGenerations.detect(cjs, home.toString()))
        // 改写文件（mtime 推进）→ 重判 NEW；Windows mtime 粒度下强制 sleep 保证时间推进
        Thread.sleep(20)
        cjs.toFile().writeText("ZCODE_PERSONAL_PROVIDER_CONFIG_FILE")
        assertEquals(ProtocolGeneration.NEW, ProtocolGenerations.detect(cjs, home.toString()))
    }

    // ============ BuiltinModelCatalog（modelRules 正则链 + 默认档选择） ============

    private fun writeCatalog(rules: String) {
        v2().resolve("runtime/provider/win/1.0/endpoint-x").let { Files.createDirectories(it) }
        v2().resolve("runtime/provider/win/1.0/endpoint-x/zcode-builtin.json").toFile()
            .writeText("""{"schemaVersion":1,"revision":28,"config":{"modelConfigRules":{"modelRules":[$rules]}}}""")
    }

    @Test
    fun `规则链后命中覆盖前命中且无 optionSpecs 保留前值`() {
        writeCatalog(
            """{"modelMatch":".*","config":{"optionSpecs":{"reasoningLevel":{"values":["disabled","enabled"]}}}},
                {"modelMatch":".*glm-5\\.3(?:-flash)?(?:[.\\-:/\\[].*)?","config":{"optionSpecs":{"reasoningLevel":{"values":["low","high","max"]}}}},
                {"modelMatch":".*glm-5\\.3-flash(?:[.\\-:/\\[].*)?","config":{"optionSpecs":{"maxOutputTokens":{"max":128000}}}}"""
        )
        assertEquals(listOf("low", "high", "max"), BuiltinModelCatalog.reasoningValues("GLM-5.3", null, home.toString()))
        assertEquals(listOf("low", "high", "max"), BuiltinModelCatalog.reasoningValues("GLM-5.3-Flash", null, home.toString()))
        // 无专属规则模型落泛化 .* 规则
        assertEquals(listOf("disabled", "enabled"), BuiltinModelCatalog.reasoningValues("deepseek-v4", null, home.toString()))
    }

    @Test
    fun `默认档按 max-high-enabled 优先`() {
        writeCatalog(
            """{"modelMatch":".*","config":{"optionSpecs":{"reasoningLevel":{"values":["disabled","enabled"]}}}}"""
        )
        assertEquals("enabled", BuiltinModelCatalog.defaultReasoningLevel("any-model", null, home.toString()))
        writeCatalog(
            """{"modelMatch":".*glm.*","config":{"optionSpecs":{"reasoningLevel":{"values":["low","high","max"]}}}}"""
        )
        assertEquals("max", BuiltinModelCatalog.defaultReasoningLevel("GLM-5.3", null, home.toString()))
    }

    @Test
    fun `目录缺失 fail-soft 返回 null`() {
        v2()
        assertNull(BuiltinModelCatalog.reasoningValues("GLM-5.3", null, home.toString()))
        assertNull(BuiltinModelCatalog.defaultReasoningLevel("GLM-5.3", null, home.toString()))
    }

    @Test
    fun `坏正则规则跳过不炸`() {
        writeCatalog(
            """{"modelMatch":"([invalid","config":{"optionSpecs":{"reasoningLevel":{"values":["max"]}}}},
                {"modelMatch":".*","config":{"optionSpecs":{"reasoningLevel":{"values":["enabled"]}}}}"""
        )
        assertEquals("enabled", BuiltinModelCatalog.defaultReasoningLevel("x", null, home.toString()))
    }

    @Test
    fun `小写模型id命中大写专属规则（自定义渠道手填id，缺陷DJ）`() {
        // 真实目录形态：泛化 glm-5 规则小写、GLM-5.2 专属规则大写（大小写混杂）。
        // 服务端按大小写不敏感解析（自定义渠道小写 glm-5.2 被按 GLM-5.2 规则集校验），
        // 目录匹配必须同口径，否则小写 id 掉泛化规则拿错级别集
        writeCatalog(
            """{"modelMatch":".*","config":{"optionSpecs":{"reasoningLevel":{"values":["disabled","enabled"]}}}},
                {"modelMatch":".*glm-5(?:[.\\-:/\\[].*)?","config":{"optionSpecs":{"reasoningLevel":{"values":["disabled","enabled"]}}}},
                {"modelMatch":".*GLM-5\\.2(?:[.\\-:/\\[].*)?","config":{"optionSpecs":{"reasoningLevel":{"values":["disabled","high","max"]}}}}"""
        )
        assertEquals(listOf("disabled", "high", "max"), BuiltinModelCatalog.reasoningValues("glm-5.2", null, home.toString()))
        assertEquals(listOf("disabled", "high", "max"), BuiltinModelCatalog.reasoningValues("GLM-5.2", null, home.toString()))
        assertEquals("max", BuiltinModelCatalog.defaultReasoningLevel("glm-5.2", null, home.toString()))
    }

    // ============ locateBuiltinFile（spawn env 对目录定位，issue #50） ============

    private fun writeInstallCatalog(zcodePath: Path, relative: String): Path {
        Files.createDirectories(zcodePath.parent)
        if (!Files.isRegularFile(zcodePath)) zcodePath.toFile().writeText("// cli")
        val file = zcodePath.parent.resolve(relative).normalize()
        Files.createDirectories(file.parent)
        file.toFile().writeText("{}")
        return file
    }

    @Test
    fun `builtin 定位优先跟随 dataBaseDir 的 runtime 缓存`() {
        val redirect = home.resolve("redirect-root").toAbsolutePath()
        v2().resolve("setting.json").toFile()
            .writeText("""{"dataBaseDir":"${redirect.toString().replace("\\", "\\\\")}"}""")
        val redirected = redirect.resolve(".zcode/v2/runtime/provider/ep/1.0/endpoint-x/zcode-builtin.json")
        Files.createDirectories(redirected.parent)
        redirected.toFile().writeText("""{"revision":44}""")
        // 安装目录副本也存在：旧口径会先命中它，新口径必须让重定向缓存胜出
        val zcode = home.resolve("install/glm/zcode.cjs")
        writeInstallCatalog(zcode, "../config/provider/zcode-builtin.json")
        assertEquals(
            redirected.toAbsolutePath(),
            BuiltinModelCatalog.locateBuiltinFile(zcode, home.toString(), localAppData = null)?.toAbsolutePath(),
        )
    }

    @Test
    fun `config_provider 缺失时回退历史 home_AppData 拷贝`() {
        val zcode = home.resolve("install/glm/zcode.cjs")
        Files.createDirectories(zcode.parent)
        zcode.toFile().writeText("// cli")
        val legacy = home.resolve("AppData/config/provider/zcode-builtin.json")
        Files.createDirectories(legacy.parent)
        legacy.toFile().writeText("{}")
        assertEquals(
            legacy.toAbsolutePath(),
            BuiltinModelCatalog.locateBuiltinFile(zcode, home.toString(), localAppData = null)?.toAbsolutePath(),
        )
    }

    @Test
    fun `LOCALAPPDATA 兜底`() {
        val zcode = home.resolve("install/glm/zcode.cjs")
        Files.createDirectories(zcode.parent)
        zcode.toFile().writeText("// cli")
        val localAppData = home.resolve("localappdata")
        val fallback = localAppData.resolve("config/provider/zcode-builtin.json")
        Files.createDirectories(fallback.parent)
        fallback.toFile().writeText("{}")
        // 历史误拼位置同时存在：正确位置 LOCALAPPDATA 必须优先
        val legacy = home.resolve("AppData/config/provider/zcode-builtin.json")
        Files.createDirectories(legacy.parent)
        legacy.toFile().writeText("{}")
        assertEquals(
            fallback.toAbsolutePath(),
            BuiltinModelCatalog.locateBuiltinFile(zcode, home.toString(), localAppData = localAppData.toString())
                ?.toAbsolutePath(),
        )
    }

    @Test
    fun `所有候选缺失 fail-soft 返回 null`() {
        val zcode = home.resolve("missing/glm/zcode.cjs")
        assertNull(BuiltinModelCatalog.locateBuiltinFile(zcode, home.toString(), localAppData = null))
    }

    @Test
    fun `真实样式目录冒烟（存在才跑）`() {
        val real = Path.of(System.getProperty("user.home"), ".zcode", "v2", "runtime", "provider")
        if (!Files.isDirectory(real)) return
        val values = BuiltinModelCatalog.reasoningValues("GLM-5.3", null)
        if (values != null) {
            assertTrue(values.contains("max"), "GLM-5.3 应含 max 档: $values")
        }
    }
}
