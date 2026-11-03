package com.zcode.ideaplugin.ui

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.test.assertTrue

/**
 * ZCodeLinkedWorkspaces 目录配色轮询分配纯逻辑单测（不依赖 Project）：
 * 轮询取模归正、colors 映射 JSON 往返、损坏降级
 */
class ZCodeLinkedWorkspacesColorTest {

    @Test
    fun `color index cycles within palette size`() {
        assertEquals(0, ZCodeLinkedWorkspaces.nextColorIndex(0))
        assertEquals(8, ZCodeLinkedWorkspaces.nextColorIndex(8))
        assertEquals(0, ZCodeLinkedWorkspaces.nextColorIndex(9), "第10个目录回到色板首位")
        assertEquals(1, ZCodeLinkedWorkspaces.nextColorIndex(10))
    }

    @Test
    fun `negative counter wraps into range`() {
        assertEquals(8, ZCodeLinkedWorkspaces.nextColorIndex(-1))
        assertEquals(0, ZCodeLinkedWorkspaces.nextColorIndex(-9))
    }

    @Test
    fun `color map json parses keys and values as-is`() {
        val parsed = ZCodeLinkedWorkspaces.parseColorMap("""{"g:/a":0,"e:/工作/目录":8}""")
        assertEquals(mapOf("g:/a" to 0, "e:/工作/目录" to 8), parsed)
    }

    @Test
    fun `corrupted color map degrades to empty`() {
        assertTrue(ZCodeLinkedWorkspaces.parseColorMap(null).isEmpty())
        assertTrue(ZCodeLinkedWorkspaces.parseColorMap("").isEmpty())
        assertTrue(ZCodeLinkedWorkspaces.parseColorMap("not-json{").isEmpty())
    }

    @Test
    fun `displayChar takes basename first codepoint uppercased`() {
        assertEquals("Z", WsTabColors.displayChar("G:/work/zcode-idea-plugin"))
        assertEquals("2", WsTabColors.displayChar("E:\\work\\23-新平台部署"))
        assertEquals("部", WsTabColors.displayChar("E:/工作/部署/"))
        assertEquals("·", WsTabColors.displayChar(""))
        assertEquals("·", WsTabColors.displayChar("///"))
    }

    @Test
    fun `pickLetter uses session initial only in single workspace`() {
        assertEquals("修", WsTabColors.pickLetter(true, "修", "G:/proj"), "单工作区+有会话首字符→会话字符")
        assertEquals("P", WsTabColors.pickLetter(false, "修", "G:/proj"), "多工作区忽略会话字符用目录字符")
        assertEquals("P", WsTabColors.pickLetter(true, null, "G:/proj"), "待命无推送回落目录字符")
        assertEquals("P", WsTabColors.pickLetter(true, "  ", "G:/proj"), "空白推送视同无推送")
    }

    @Test
    fun `resolvePushedLetter adopts only when session matches`() {
        assertEquals("你", WsTabColors.resolvePushedLetter("你", "sess_a", "sess_a"), "配对当前会话→沿用推送字母")
        assertEquals(null, WsTabColors.resolvePushedLetter("你", "sess_a", "sess_b"), "切会话后旧字母失效等新推送")
        assertEquals(null, WsTabColors.resolvePushedLetter("你", "sess_a", null), "待命态不用字母（空心块目录字符）")
        assertEquals(null, WsTabColors.resolvePushedLetter(null, "sess_a", "sess_a"), "无推送回落目录字符")
        assertEquals(null, WsTabColors.resolvePushedLetter("  ", "sess_a", "sess_a"), "空白字母视同无推送")
    }

    @Test
    fun `positional color follows list order so chips order equals palette order`() {
        val list = listOf("E:/work/lab-sdk", "E:/work/skills", "E:/work/yunxiao")
        assertEquals(0, ZCodeLinkedWorkspaces.positionalColorIndex(list, "E:\\work\\lab-sdk"), "第1个目录→色板第1色")
        assertEquals(1, ZCodeLinkedWorkspaces.positionalColorIndex(list, "e:/work/skills"), "第2个目录→色板第2色（分隔符大小写归一）")
        assertEquals(2, ZCodeLinkedWorkspaces.positionalColorIndex(list, "E:/work/yunxiao"))
        assertEquals(null, ZCodeLinkedWorkspaces.positionalColorIndex(list, "E:/work/removed"), "列表外目录走历史映射兜底")
        assertEquals(0, ZCodeLinkedWorkspaces.positionalColorIndex(list, "E:/work/lab-sdk/"), "尾斜杠归一")
    }

    @Test
    fun `positional index wraps for more than palette size`() {
        val list = (0 until 11).map { "G:/d$it" }
        assertEquals(1, ZCodeLinkedWorkspaces.positionalColorIndex(list, "G:/d10"), "第11个目录回到色板第2色")
    }

    @Test
    fun `tooltip html uses badge ratio tint over tooltip bg`() {
        // 红@14% 混黑底：36/255*255=36→#240000；红@75% 混白前景：191/255 红+64/255 白→#ff4040
        val html = WsTabColors.tooltipHtml(
            "23-新平台部署",
            java.awt.Color(255, 0, 0),
            java.awt.Color(0, 0, 0),
            java.awt.Color(255, 255, 255),
            "修复缺陷",
        )
        assertTrue(html.startsWith("<html>"), "多工作区走 Swing HTML 通道")
        assertTrue(html.contains("background-color:#240000"), "徽标同配比：目录色14%混tooltip背景")
        assertTrue(html.contains("color:#ff4040"), "徽标同配比：目录色75%混前景色")
        assertTrue(html.contains("23-新平台部署") && html.contains("修复缺陷"))
    }

    @Test
    fun `tooltip html falls back to plain title when no dir`() {
        assertEquals(
            "修复缺陷",
            WsTabColors.tooltipHtml(null, java.awt.Color(255, 0, 0), java.awt.Color(0, 0, 0), java.awt.Color(255, 255, 255), "修复缺陷"),
            "单工作区纯会话名无 chip",
        )
    }

    @Test
    fun `tooltip html escapes title and dir name`() {
        val html = WsTabColors.tooltipHtml(
            "a<b>&",
            java.awt.Color(18, 52, 86),
            java.awt.Color(0, 0, 0),
            java.awt.Color(255, 255, 255),
            "<img>&\"x\"",
        )
        assertTrue(html.contains("&lt;img&gt;&amp;&quot;x&quot;"), "标题 HTML 转义防结构破坏")
        assertTrue(html.contains("a&lt;b&gt;&amp;"))
        assertFalse(html.contains("<img"))
    }
}
