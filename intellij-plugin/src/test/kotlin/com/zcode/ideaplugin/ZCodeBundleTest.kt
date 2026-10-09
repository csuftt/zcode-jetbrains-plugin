package com.zcode.ideaplugin

import java.util.Locale
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * ZCodeBundle 按「插件语言码」加载的回归测试（通知标题英文化缺陷）：
 * message() 经 ZCodeLanguageService 解析语言——此前裸 DynamicBundle 只吃 IDE
 * 界面语言，英文 IDE/沙箱下中文用户看到的通知标题是英文。
 * 本类直调 bundleForLanguage 验证：各语言码命中各自文件、zh 落中文基文件
 * （NoFallbackControl 挡住 JVM 默认 locale 回退，否则英文系统上 zh 会命中 _en）。
 */
class ZCodeBundleTest {

    private val key = "notify.turn.completed.title"

    @Test
    fun `各语言码命中各自 bundle`() {
        assertEquals("任务完成", ZCodeBundle.bundleForLanguage("zh").getString(key))
        assertEquals("任務完成", ZCodeBundle.bundleForLanguage("zh-TW").getString(key))
        assertEquals("task completed", ZCodeBundle.bundleForLanguage("en").getString(key))
        assertEquals("タスク完了", ZCodeBundle.bundleForLanguage("ja").getString(key))
        assertEquals("작업 완료", ZCodeBundle.bundleForLanguage("ko").getString(key))
    }

    @Test
    fun `未知语言码回退英文`() {
        assertEquals("task completed", ZCodeBundle.bundleForLanguage("fr").getString(key))
    }

    @Test
    fun `zh 不吃 JVM 默认 locale 回退（英文系统也命中中文基文件）`() {
        val old = Locale.getDefault()
        Locale.setDefault(Locale.US)
        try {
            assertEquals("任务完成", ZCodeBundle.bundleForLanguage("zh").getString(key))
        } finally {
            Locale.setDefault(old)
        }
    }
}
