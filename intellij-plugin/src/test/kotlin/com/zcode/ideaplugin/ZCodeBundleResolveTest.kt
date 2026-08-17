package com.zcode.ideaplugin

import java.io.File
import java.net.URLClassLoader
import java.nio.charset.StandardCharsets
import java.util.Locale
import java.util.PropertyResourceBundle
import java.util.ResourceBundle
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * ZCodeBundle 解析回归测试（右键菜单占位符事故排查）
 *
 * 用户 IDE（2026.1, locale=zh_CN）上 action text 显示 %action.xxx% 原文。
 * 此测试用 JDK ResourceBundle（UTF-8 control，等价 DynamicBundle 加载路径）
 * 从打包产物 classpath 加载 messages.ZCodeBundle，验证 zh_CN locale 下 key 可解析。
 */
class ZCodeBundleResolveTest {

    private fun bundleFrom(vararg roots: File, locale: Locale): ResourceBundle {
        val urls = roots.filter { it.exists() }.map { it.toURI().toURL() }.toTypedArray()
        assertTrue(urls.isNotEmpty(), "classpath 根不存在: ${roots.joinToString()}")
        val cl = URLClassLoader(urls, null)
        return ResourceBundle.getBundle(
            "messages.ZCodeBundle", locale, cl,
            object : ResourceBundle.Control() {
                override fun getFallbackLocale(baseName: String, locale: Locale): Locale? = null
                override fun newBundle(
                    baseName: String, locale: Locale, format: String,
                    loader: ClassLoader, reload: Boolean,
                ): ResourceBundle? {
                    val resName = toResourceName(toBundleName(baseName, locale), "properties") ?: return null
                    loader.getResourceAsStream(resName)?.use { stream ->
                        return PropertyResourceBundle(stream.reader(StandardCharsets.UTF_8))
                    }
                    return null
                }
            },
        )
    }

    @Test
    fun `resources 目录 zh_CN locale 解析 action key`() {
        val resDir = File("build/resources/main")
        val b = bundleFrom(resDir, locale = Locale.SIMPLIFIED_CHINESE)
        println("resolved bundle class=${b.javaClass.name}, locale=${b.locale}")
        assertEquals("发送选中代码到 ZC GUI 输入框", b.getString("action.sendSelectionToInput.text"))
        assertEquals("发送到 ZC GUI 输入框", b.getString("action.sendFileToInput.text"))
        assertEquals("复制AI引用", b.getString("action.copySelectionReference.text"))
    }

    @Test
    fun `en locale 回退解析`() {
        val resDir = File("build/resources/main")
        val b = bundleFrom(resDir, locale = Locale.ENGLISH)
        assertEquals("Send Selected Code to ZC GUI Input", b.getString("action.sendSelectionToInput.text"))
    }
}
