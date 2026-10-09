package com.zcode.ideaplugin

import com.zcode.ideaplugin.ui.ZCodeLanguageService
import org.jetbrains.annotations.Nls
import org.jetbrains.annotations.NonNls
import org.jetbrains.annotations.NotNull
import org.jetbrains.annotations.PropertyKey
import java.text.MessageFormat
import java.util.Locale
import java.util.ResourceBundle

/**
 * 插件原生 UI 文案 bundle（来源 cc-gui ClaudeCodeGuiBundle）。
 *
 * 文案定义在 messages/ZCodeBundle*.properties（默认文件=中文，另提供 en/ja/ko/zh_TW），
 * 随「插件语言」切换（ZCodeLanguageService：webview 设置页手动值优先，否则映射 IDE locale），
 * 不再跟 IDE 界面语言走——英文 IDE/沙箱下中文用户的通知标题也是中文。
 * plugin.xml 中 action 文案用 %key% 语法引用本 bundle（那部分仍随 IDE 界面语言，
 * 与本 message() 通道解耦）。
 */
object ZCodeBundle {
    @NonNls
    private const val BUNDLE = "messages.ZCodeBundle"

    /**
     * 禁 JVM 默认 locale 回退：否则请求 zh（无 _zh 文件，靠基文件兜底）时会先命中
     * 默认 locale 对应的 _en/_zh_TW 等现有文件，基文件（中文）永远轮不到
     */
    private val NO_FALLBACK = ResourceBundle.Control.getNoFallbackControl(ResourceBundle.Control.FORMAT_DEFAULT)

    /** bundle 本体按语言码缓存；语言码每次调用重算，设置页切语言即时生效 */
    @Volatile
    private var cachedLang: String? = null

    @Volatile
    private var cachedBundle: ResourceBundle? = null

    @NotNull
    @Nls
    fun message(
        @NotNull @PropertyKey(resourceBundle = BUNDLE) key: String,
        vararg params: Any,
    ): String {
        val pattern = bundleForLanguage(ZCodeLanguageService.currentLanguage()).getString(key)
        return if (params.isEmpty()) pattern else MessageFormat.format(pattern, *params)
    }

    /** 语言码 → bundle（zh 落中文基文件，zh-TW/en/ja/ko 各自文件；未知码回英文）*/
    internal fun bundleForLanguage(lang: String): ResourceBundle {
        if (lang == cachedLang) cachedBundle?.let { return it }
        val locale = when (lang) {
            "zh" -> Locale.SIMPLIFIED_CHINESE
            "zh-TW" -> Locale.TRADITIONAL_CHINESE
            "ja" -> Locale.JAPANESE
            "ko" -> Locale.KOREAN
            else -> Locale.ENGLISH
        }
        val bundle = ResourceBundle.getBundle(BUNDLE, locale, ZCodeBundle::class.java.classLoader, NO_FALLBACK)
        cachedLang = lang
        cachedBundle = bundle
        return bundle
    }
}
