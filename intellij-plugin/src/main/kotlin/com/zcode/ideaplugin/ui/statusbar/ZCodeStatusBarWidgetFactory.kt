package com.zcode.ideaplugin.ui.statusbar

import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.zcode.ideaplugin.ZCodeBundle.message

/**
 * ZCode 状态栏 Widget 工厂（IDEA 集成面调研 ③）。
 *
 * 监督面入口前移：ToolWindow 收起后后台会话干活不可见是监督面的头号缺口，
 * 状态栏常驻一个 ZC GUI widget——运行中的会话标签数转「●N」，点击聚焦会话标签、
 * 双击新建会话（v1 范围，见 ZCodeStatusBarWidget 类注）。
 *
 * 注册：plugin.xml `statusBarWidgetFactory` EP（233 稳定 API，签名经 233 jar javap 核验：
 * 只覆写 `createWidget(Project)`——带 CoroutineScope 形参的重载是平台侧向后兼容默认实现，
 * 会委托回本方法；插件侧不得覆写 scope 重载，签名含跨类加载器 coroutines 类型）。
 */
class ZCodeStatusBarWidgetFactory : StatusBarWidgetFactory {

    override fun getId(): String = ZCodeStatusBarWidget.WIDGET_ID

    override fun getDisplayName(): String = message("statusbar.widget.displayName")

    override fun createWidget(project: Project): StatusBarWidget = ZCodeStatusBarWidget(project)

    override fun disposeWidget(widget: StatusBarWidget) {
        Disposer.dispose(widget)
    }

    override fun canBeEnabledOn(statusBar: StatusBar): Boolean = true
}
