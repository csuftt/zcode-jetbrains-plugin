package com.zcode.ideaplugin

import com.intellij.DynamicBundle
import org.jetbrains.annotations.Nls
import org.jetbrains.annotations.NonNls
import org.jetbrains.annotations.NotNull
import org.jetbrains.annotations.PropertyKey

/**
 * 插件原生 UI 文案 bundle（来源 cc-gui ClaudeCodeGuiBundle）。
 *
 * 文案定义在 messages/ZCodeBundle*.properties（默认文件=中文，另提供 en/ja/ko），
 * 随 IDE 界面语言自动切换（与 webview 侧语言独立：webview 语言由
 * ZCodeLanguageService 计算"手动值优先，否则 IDE locale"注入）。
 * plugin.xml 中 action 文案用 %key% 语法引用本 bundle。
 */
object ZCodeBundle {
    @NonNls
    private const val BUNDLE = "messages.ZCodeBundle"
    private val INSTANCE = DynamicBundle(ZCodeBundle::class.java, BUNDLE)

    @NotNull
    @Nls
    fun message(
        @NotNull @PropertyKey(resourceBundle = BUNDLE) key: String,
        vararg params: Any,
    ): String = INSTANCE.getMessage(key, *params)
}
