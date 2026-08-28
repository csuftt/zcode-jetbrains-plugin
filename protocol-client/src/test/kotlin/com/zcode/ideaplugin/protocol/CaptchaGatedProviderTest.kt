package com.zcode.ideaplugin.protocol

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path
import kotlin.io.path.writeText
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * 体验套餐(zcode-plan 网关) captcha 门控判定测试（2026-08-28 定性）。
 *
 * zcode-plan 网关（baseURL 含 zcode-plan）的模型请求强制阿里云滑块人机验证，
 * 插件宿主无法提供 verify param → 渠道整体过滤/拦截。锁定 RuntimeModels 的判定：
 * baseURL 指纹（含大小写混排）、按 providerId 查 config、缺失/异常路径不误报。
 */
class CaptchaGatedProviderTest {

    @TempDir
    lateinit var tempDir: Path

    private fun writeConfig(json: String): Path =
        tempDir.resolve("config-$${System.nanoTime()}.json").also { it.writeText(json) }

    @Test
    fun `zcode-plan 网关 baseURL 判定为门控`() {
        assertTrue(RuntimeModels.isCaptchaGatedBaseUrl("https://zcode.z.ai/api/v1/zcode-plan/anthropic"))
        assertTrue(RuntimeModels.isCaptchaGatedBaseUrl("https://ZCode.Z.AI/api/v1/ZCode-Plan/")) // 大小写混排
        assertTrue(RuntimeModels.isCaptchaGatedBaseUrl("https://x.example.com/zcode-plan"))
    }

    @Test
    fun `非 zcode-plan 端点不误报`() {
        assertFalse(RuntimeModels.isCaptchaGatedBaseUrl("https://open.bigmodel.cn/api/anthropic"))
        assertFalse(RuntimeModels.isCaptchaGatedBaseUrl("https://api.z.ai/api/anthropic"))
        assertFalse(RuntimeModels.isCaptchaGatedBaseUrl("https://api.zai.example.com/v1")) // 仅含 "zai" 子串
    }

    @Test
    fun `按 providerId 查 config 判定`() {
        val cfg = """
        {
          "provider": {
            "builtin:bigmodel-start-plan": {
              "kind": "anthropic", "enabled": true, "source": "custom",
              "options": { "baseURL": "https://zcode.z.ai/api/v1/zcode-plan/anthropic", "apiKey": "jwt" },
              "models": { "GLM-5.3-Flash": {} }
            },
            "builtin:bigmodel-coding-plan": {
              "kind": "anthropic", "enabled": true, "source": "custom",
              "options": { "baseURL": "https://open.bigmodel.cn/api/anthropic", "apiKey": "k" },
              "models": { "GLM-5.3": {} }
            }
          }
        }
        """.trimIndent()
        val path = writeConfig(cfg)
        assertTrue(RuntimeModels.isCaptchaGatedProvider("builtin:bigmodel-start-plan", path))
        assertFalse(RuntimeModels.isCaptchaGatedProvider("builtin:bigmodel-coding-plan", path))
        assertFalse(RuntimeModels.isCaptchaGatedProvider("not-exist", path))
    }

    @Test
    fun `config 缺失或 provider 无 baseURL 不误报`() {
        assertFalse(RuntimeModels.isCaptchaGatedProvider("any", tempDir.resolve("missing.json")))
        val noBaseURL = writeConfig(
            """{"provider": {"p1": {"kind": "anthropic", "options": {"apiKey": "k"}}}}"""
        )
        assertFalse(RuntimeModels.isCaptchaGatedProvider("p1", noBaseURL))
        // 无 options 节点也不抛异常
        val noOptions = writeConfig("""{"provider": {"p2": {"kind": "anthropic"}}}""")
        assertFalse(RuntimeModels.isCaptchaGatedProvider("p2", noOptions))
    }
}
