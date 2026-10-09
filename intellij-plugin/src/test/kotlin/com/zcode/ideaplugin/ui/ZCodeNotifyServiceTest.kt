package com.zcode.ideaplugin.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * ZCodeNotifyService.parseConfig 纯解析测试（webview kv 通道 JSON → NotifyConfig）：
 * 与前端 utils/notifyConfig.ts 的读写语义对齐——缺失/损坏/类型不对逐字段回默认，
 * 保证"前端写、Kotlin 读"两端默认值一致（默认关闭；无焦点门控字段）。
 */
class ZCodeNotifyServiceTest {

    private fun kv(confJson: String?): String =
        """{"zcode.language":"zh","zcode.notify.config":${confJson?.let { "\"$it\"" } ?: "null"}}"""

    @Test
    fun `kvstore 缺失或无配置键回默认值（默认关闭）`() {
        assertEquals(ZCodeNotifyService.NotifyConfig(), ZCodeNotifyService.parseConfig(null))
        assertEquals(ZCodeNotifyService.NotifyConfig(), ZCodeNotifyService.parseConfig("""{"zcode.language":"zh"}"""))
    }

    @Test
    fun `正常解析开关（开启即始终弹，无焦点门控字段）`() {
        val raw = kv("""{\"notifyEnabled\":true}""")
        assertTrue(ZCodeNotifyService.parseConfig(raw).notifyEnabled)
    }

    @Test
    fun `部分字段缺席与类型不对回默认（字符串 false 不生效，对齐前端语义）`() {
        val badType = kv("""{\"notifyEnabled\":\"false\"}""")
        assertFalse(ZCodeNotifyService.parseConfig(badType).notifyEnabled)

        val badType2 = kv("""{\"notifyEnabled\":\"true\"}""")
        assertFalse(ZCodeNotifyService.parseConfig(badType2).notifyEnabled)
    }

    @Test
    fun `损坏 JSON 各级均回默认值不抛异常`() {
        assertEquals(ZCodeNotifyService.NotifyConfig(), ZCodeNotifyService.parseConfig("{broken"))
        assertEquals(ZCodeNotifyService.NotifyConfig(), ZCodeNotifyService.parseConfig(kv("{broken")))
    }

    @Test
    fun `默认值契约：默认关闭（前端 DEFAULT_NOTIFY_CONFIG 同源）`() {
        assertFalse(ZCodeNotifyService.NotifyConfig().notifyEnabled)
    }

    @Test
    fun `旧版遗留的 notifyOnlyUnfocused 字段被忽略`() {
        val raw = kv("""{\"notifyEnabled\":true,\"notifyOnlyUnfocused\":false}""")
        val c = ZCodeNotifyService.parseConfig(raw)
        assertTrue(c.notifyEnabled)
    }

    // ============ 悬浮弹窗开关与时长（popupNotifyEnabled / popupDurationSec）============

    @Test
    fun `popup 开关与时长正常解析（0=常驻合法值）`() {
        val c = ZCodeNotifyService.parseConfig(kv("""{\"popupNotifyEnabled\":true,\"popupDurationSec\":0}"""))
        assertTrue(c.popupNotifyEnabled)
        assertEquals(0, c.popupDurationSec)
    }

    @Test
    fun `popup 字段缺席与类型不对回默认（关、10 秒）`() {
        val missing = ZCodeNotifyService.parseConfig(kv("""{\"notifyEnabled\":true}"""))
        assertFalse(missing.popupNotifyEnabled)
        assertEquals(10, missing.popupDurationSec)

        val badTypes = ZCodeNotifyService.parseConfig(
            kv("""{\"popupNotifyEnabled\":\"true\",\"popupDurationSec\":\"30\"}""")
        )
        assertFalse(badTypes.popupNotifyEnabled)
        assertEquals(10, badTypes.popupDurationSec)

        assertEquals(10, ZCodeNotifyService.NotifyConfig().popupDurationSec)
    }

    // ============ 悬浮弹窗位置（popupPosition，默认右上角）============

    @Test
    fun `popup 位置正常解析（BOTTOM_RIGHT）`() {
        val c = ZCodeNotifyService.parseConfig(
            kv("""{\"popupNotifyEnabled\":true,\"popupPosition\":\"BOTTOM_RIGHT\"}""")
        )
        assertEquals(ZCodePopupNotifier.PopupPosition.BOTTOM_RIGHT, c.popupPosition)
    }

    @Test
    fun `popup 位置缺席与非法值回默认 TOP_RIGHT`() {
        val missing = ZCodeNotifyService.parseConfig(kv("""{\"popupNotifyEnabled\":true}"""))
        assertEquals(ZCodePopupNotifier.PopupPosition.TOP_RIGHT, missing.popupPosition)

        val unknown = ZCodeNotifyService.parseConfig(kv("""{\"popupPosition\":\"LEFT\"}"""))
        assertEquals(ZCodePopupNotifier.PopupPosition.TOP_RIGHT, unknown.popupPosition)

        val badType = ZCodeNotifyService.parseConfig(kv("""{\"popupPosition\":1}"""))
        assertEquals(ZCodePopupNotifier.PopupPosition.TOP_RIGHT, badType.popupPosition)

        assertEquals(ZCodePopupNotifier.PopupPosition.TOP_RIGHT, ZCodeNotifyService.NotifyConfig().popupPosition)
    }

    // ============ 轮末通知正文组装（缺陷DZ：会话名前缀）============

    @Test
    fun `带标题时正文前缀「会话名」`() {
        val out = ZCodeNotifyService.turnEndNotificationContent("修复登录 bug", "改好了", "AI 已完成本轮任务")
        assertEquals("「修复登录 bug」改好了", out)
    }

    @Test
    fun `标题缺失或空白回退纯正文`() {
        assertEquals("改好了", ZCodeNotifyService.turnEndNotificationContent(null, "改好了", "兜底"))
        assertEquals("改好了", ZCodeNotifyService.turnEndNotificationContent("", "改好了", "兜底"))
        assertEquals("改好了", ZCodeNotifyService.turnEndNotificationContent("   ", "改好了", "兜底"))
    }

    @Test
    fun `正文空或纯空白回退兜底文案（前缀仍保留）`() {
        assertEquals("「会话」AI 已完成本轮任务", ZCodeNotifyService.turnEndNotificationContent("会话", null, "AI 已完成本轮任务"))
        assertEquals("「会话」AI 已完成本轮任务", ZCodeNotifyService.turnEndNotificationContent("会话", "   ", "AI 已完成本轮任务"))
    }

    @Test
    fun `标题截30字正文截120字且先 trim`() {
        val longTitle = "标".repeat(40)
        val out = ZCodeNotifyService.turnEndNotificationContent("  $longTitle  ", "正".repeat(200), "兜底")
        assertEquals("「${"标".repeat(30)}」${"正".repeat(120)}", out)
    }

    // ============ 悬浮弹窗通道正文（2026-10-09 拍板：仅「会话标题」，气泡通道文案不变）============

    @Test
    fun `弹窗正文带标题时仅「会话名」，不含预览与兜底`() {
        assertEquals("「修复登录 bug」", ZCodeNotifyService.popupNotificationContent("修复登录 bug", "任意预览"))
    }

    @Test
    fun `弹窗正文标题缺失或空白回退现状内容`() {
        assertEquals("任意预览", ZCodeNotifyService.popupNotificationContent(null, "任意预览"))
        assertEquals("任意预览", ZCodeNotifyService.popupNotificationContent("", "任意预览"))
        assertEquals("任意预览", ZCodeNotifyService.popupNotificationContent("   ", "任意预览"))
    }

    @Test
    fun `弹窗正文标题先 trim 再截30字`() {
        val longTitle = "标".repeat(40)
        assertEquals("「${"标".repeat(30)}」", ZCodeNotifyService.popupNotificationContent("  $longTitle  ", "兜底"))
    }

    // ============ 子代理会话判据（缺陷DZ：子代理完成不通知）============

    @Test
    fun `sess_subagent 前缀命中子代理判据`() {
        assertTrue(ZCodeNotifyService.isSubagentSession("sess_subagent_abc123"))
        assertTrue(ZCodeNotifyService.isSubagentSession("sess_subagent"))
    }

    @Test
    fun `主会话与空值不命中子代理判据`() {
        assertFalse(ZCodeNotifyService.isSubagentSession("sess_abc123"))
        assertFalse(ZCodeNotifyService.isSubagentSession(null))
        assertFalse(ZCodeNotifyService.isSubagentSession(""))
        // 前缀必须落在开头：中间出现的不是子代理会话
        assertFalse(ZCodeNotifyService.isSubagentSession("sess_x_subagent"))
    }
}
