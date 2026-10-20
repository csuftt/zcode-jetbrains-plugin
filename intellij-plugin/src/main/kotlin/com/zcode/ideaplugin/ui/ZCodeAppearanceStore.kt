package com.zcode.ideaplugin.ui

import com.intellij.ide.ui.LafManager
import com.intellij.ide.util.PropertiesComponent
import com.intellij.ui.JBColor
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * 外观配置共享存储（Application 级 PropertiesComponent 的薄封装）
 *
 * webview 聊天界面与内嵌浏览器分栏都消费"生效主题"：
 * 用户显式偏好（light/dark）优先；否则跟随 IDE 主题（[isIdeDarkNow]）。
 * key 与前端 utils/appearance.ts 的 appearanceSave op 共用（JSON 结构化白名单值）。
 */
object ZCodeAppearanceStore {

    const val KEY_APPEARANCE = "zcode.appearance.config"

    /** 原始配置 JSON（无配置 null）*/
    fun rawJson(): String? = try {
        PropertiesComponent.getInstance().getValue(KEY_APPEARANCE)
    } catch (_: Exception) { null }

    /** 用户显式主题偏好：'light' / 'dark' / ''（空=跟随 IDE）*/
    fun themePref(): String = try {
        rawJson()?.let {
            Json.parseToJsonElement(it).jsonObject["themePref"]?.jsonPrimitive?.contentOrNull ?: ""
        } ?: ""
    } catch (_: Exception) { "" }

    /** 生效主题："light" | "dark"（偏好优先，否则 IDE 当前主题）*/
    fun effectiveTheme(): String {
        val pref = themePref()
        if (pref == "light" || pref == "dark") return pref
        return if (isIdeDarkNow()) "dark" else "light"
    }

    /**
     * 「当下」IDE 主题明暗（新鲜值）：LafManager 当前主题的 isDark 为权威
     * （平台 applyScheduledLaF 写 JBColor 缓存用的正是此值）。
     *
     * 不用 [JBColor.isBright] 判当下：它读进程级 SynchronizedClearableLazy 缓存，
     * 2023.3 上唯一写入口 JBColor.setDark 只在启动/设置导入/动态装主题插件时被调，
     * Settings 常规切主题链（setCurrentLookAndFeel→updateUI→notifyLookAndFeelChanged）
     * 不刷新——用它会在切主题后推旧值给前端，表现为「重启才跟随」。
     *
     * `UIThemeLookAndFeelInfo` 是 internal API（0.4.1 平台 verifier 报 2 处 internal
     * usage），getter 与 isDark 全走反射使字节码零类型引用（getter 方法签名的返回类型
     * 也含该接口，直接调会被 verifier 抓到）。反射失败/不可用（headless 等）回退
     * [JBColor.isBright]（启动后缓存正确）。
     */
    fun isIdeDarkNow(): Boolean = try {
        reflectCurrentThemeIsDark() ?: !JBColor.isBright()
    } catch (_: Exception) {
        !JBColor.isBright()
    }

    private val getThemeInfoMethod by lazy {
        runCatching { LafManager::class.java.getMethod("getUIThemeLookAndFeel") }.getOrNull()
    }

    private val themeIsDarkMethod by lazy {
        runCatching {
            Class.forName("com.intellij.ide.ui.laf.UIThemeLookAndFeelInfo").getMethod("isDark")
        }.getOrNull()
    }

    /** LafManager#getUIThemeLookAndFeel().isDark 的纯反射链（internal API 隔离层）*/
    private fun reflectCurrentThemeIsDark(): Boolean? {
        val getInfo = getThemeInfoMethod ?: return null
        val isDark = themeIsDarkMethod ?: return null
        val info = getInfo.invoke(LafManager.getInstance()) ?: return null
        return isDark.invoke(info) as? Boolean
    }
}
