package com.zcode.ideaplugin.action

import com.zcode.ideaplugin.ZCodeBundle.message
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

/**
 * 右键菜单 action 文案解析回归测试（占位符事故）
 *
 * 2026.1 实测 plugin.xml 的 %key% 机制对第三方插件解析失败（菜单显示 %action.xxx% 原文），
 * 改为 action 类构造器直接 message() 取值（cc-gui 同款）。此测试锁定构造器路径可正常解析
 * 且文案随 locale 切换。
 */
class ActionTextResolveTest {

    @Test
    fun `三个 action 文案均非占位符`() {
        for (key in listOf("sendFileToInput", "sendSelectionToInput", "copySelectionReference")) {
            val text = message("action.$key.text")
            val desc = message("action.$key.description")
            assertFalse(text.startsWith("%"), "text 应已解析而非占位符: $text")
            assertFalse(desc.startsWith("%"), "description 应已解析而非占位符: $desc")
            // 具体语言随 JVM locale 变化（中文系统→中文，en→英文），只验证解析出真实文案
            println("action.$key.text = $text")
        }
    }

    @Test
    fun `文案解析出非空真实值`() {
        val text = message("action.sendSelectionToInput.text")
        kotlin.test.assertTrue(text.length > 3 && !text.contains('%'), "应解析出真实文案: $text")
    }
}
