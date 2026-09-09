package com.zcode.ideaplugin.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * ZCodeAskUserConfig.parseConfig 纯解析测试（webview kv 通道 JSON → Config）：
 * 与前端 utils/askUserConfig.ts 的读写语义对齐——缺失/损坏/类型不对逐字段回默认，
 * 保证"前端写、Kotlin 读"两端默认值一致（默认关闭=提问一直等待）。
 */
class ZCodeAskUserConfigTest {

    private fun kv(confJson: String?): String =
        """{"zcode.language":"zh","zcode.askUser.config":${confJson?.let { "\"$it\"" } ?: "null"}}"""

    @Test
    fun `kvstore 缺失或无配置键回默认值（默认关闭=一直等待）`() {
        assertEquals(ZCodeAskUserConfig.Config(), ZCodeAskUserConfig.parseConfig(null))
        assertEquals(ZCodeAskUserConfig.Config(), ZCodeAskUserConfig.parseConfig("""{"zcode.language":"zh"}"""))
    }

    @Test
    fun `正常解析开关（开启=5分钟未答自动继续）`() {
        val raw = kv("""{\"autoContinueEnabled\":true}""")
        assertTrue(ZCodeAskUserConfig.parseConfig(raw).autoContinueEnabled)
    }

    @Test
    fun `类型不对回默认（字符串 false 不生效，对齐前端语义）`() {
        val badType = kv("""{\"autoContinueEnabled\":\"false\"}""")
        assertFalse(ZCodeAskUserConfig.parseConfig(badType).autoContinueEnabled)

        val badType2 = kv("""{\"autoContinueEnabled\":\"true\"}""")
        assertFalse(ZCodeAskUserConfig.parseConfig(badType2).autoContinueEnabled)
    }

    @Test
    fun `损坏 JSON 各级均回默认值不抛异常`() {
        assertEquals(ZCodeAskUserConfig.Config(), ZCodeAskUserConfig.parseConfig("{broken"))
        assertEquals(ZCodeAskUserConfig.Config(), ZCodeAskUserConfig.parseConfig(kv("{broken")))
    }

    @Test
    fun `默认值契约：默认关闭（前端 DEFAULT_ASK_USER_AUTO_CONFIG 同源）`() {
        assertFalse(ZCodeAskUserConfig.Config().autoContinueEnabled)
    }
}
