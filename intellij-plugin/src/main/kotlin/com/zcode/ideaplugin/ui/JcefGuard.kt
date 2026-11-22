package com.zcode.ideaplugin.ui

/**
 * JCEF 可用性探测（issue#55）：Android Studio 2026.2 等未捆绑 jcef 模块的 IDE 上，
 * com.intellij.ui.jcef.* 类整体缺失——直接调 JBCefApp.isSupported() 会 NoClassDefFoundError。
 *
 * 本类类签名零 JCEF 引用（返回 Boolean），自身在无 JCEF 环境可安全加载；方法体里的
 * JBCefApp 调用在字节码验证阶段不解析、执行到才解析，故 runCatching 捕获后按不可用处理。
 *
 * 调用方必须在构造任何 JCEF 面板（ZCodeToolWindowPanel / ZCodeBrowserPanel——字段生成的
 * getter/setter 签名含 JCEF 类型，类被反射枚举方法时即炸，如 AWT checkCoalescing）之前
 * 先走本探测，无 JCEF 时展示安装引导占位而非构造面板。
 */
object JcefGuard {
    /** JCEF API 可用（类存在且运行时支持 CEF）。无 jcef 模块 / JBR 无 CEF 时 false，绝不抛 */
    fun available(): Boolean =
        runCatching { com.intellij.ui.jcef.JBCefApp.isSupported() }.getOrDefault(false)
}
