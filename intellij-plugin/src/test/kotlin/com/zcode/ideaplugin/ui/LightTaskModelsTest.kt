package com.zcode.ideaplugin.ui

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

/**
 * 统一轻任务模型链（润色/AI 提交信息/会话标题共用，issue #48）纯选择函数回归。
 * kv/文件读取方法（dedicatedModel/currentModelRef/enabledProviderModels）属集成面，
 * 由真机验证承担——与 ZCodeCommitMessageActionTest 只测纯函数同口径。
 */
class LightTaskModelsTest {

    /** 账号渠道置顶 + 自定义渠道（口径同 enabledProviderModels 输出） */
    private val enabled = listOf(
        "account:bigmodel" to listOf("GLM-5.3", "GLM-4.7"),
        "custom:prov" to listOf("my-model", "my-model-2"),
    )

    @Test
    fun `专用模型有效时最优先`() {
        val got = LightTaskModels.pick("custom:prov" to "my-model", "account:bigmodel" to "GLM-5.3", enabled)
        assertEquals("custom:prov" to "my-model", got)
    }

    @Test
    fun `专用模型失效回退会话当前模型`() {
        val got = LightTaskModels.pick("deleted:prov" to "gone", "account:bigmodel" to "GLM-4.7", enabled)
        assertEquals("account:bigmodel" to "GLM-4.7", got)
    }

    @Test
    fun `两者都失效落到首个启用渠道首模型`() {
        val got = LightTaskModels.pick("deleted:prov" to "gone", "also:dead" to "nope", enabled)
        assertEquals("account:bigmodel" to "GLM-5.3", got)
    }

    @Test
    fun `无专用模型时会话当前模型直接生效`() {
        val got = LightTaskModels.pick(null, "custom:prov" to "my-model-2", enabled)
        assertEquals("custom:prov" to "my-model-2", got)
    }

    @Test
    fun `专用与会话模型都缺席时取首个启用渠道；清单全空返回null`() {
        assertEquals("account:bigmodel" to "GLM-5.3", LightTaskModels.pick(null, null, enabled))
        assertNull(LightTaskModels.pick(null, null, emptyList()))
        assertNull(LightTaskModels.pick("x" to "y", "a" to "b", emptyList()))
    }
}
