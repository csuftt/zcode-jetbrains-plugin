package com.zcode.ideaplugin.ui.statusbar

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.util.Consumer
import com.zcode.ideaplugin.ZCodeBundle.message
import com.zcode.ideaplugin.ui.ZCodeToolWindowFactory
import com.zcode.ideaplugin.ui.ZCodeToolWindowPanel
import java.awt.Component
import java.awt.event.MouseEvent
import java.util.concurrent.CopyOnWriteArraySet
import javax.swing.SwingUtilities

/**
 * ZCode 状态栏 Widget：项目窗口级常驻监督入口（调研 ③，v1 范围）。
 *
 * - 运行态：本项目内「生成中（●）」的会话标签数，文案 `ZC GUI` / `ZC GUI ●N`；
 *   相位权威与色块/徽标同源（panel 的 tabStreaming，turn.started/completed 驱动，
 *   缺陷 EA 教训后以相位汇点为权威），刷新钩子挂在 panel 视觉状态汇点
 *   applyTabDisplayName 上（setTabStreaming/onTurnStarted/onTurnEnded 全路过它）。
 * - 点击：打开 ZCode 工具窗并聚焦当前标签；双击：新建会话标签。
 *   （调研原文的「右键新会话」在平台 API 上不可行——widget 右键恒为平台的
 *   「自定义状态栏」菜单，无法注入自定义项，改用双击并在 tooltip 里说明。）
 * - Multiframe：多项目窗口各持一份实例（copy() 生成），各自统计各自项目的标签。
 */
class ZCodeStatusBarWidget(private val project: Project) : StatusBarWidget.Multiframe, StatusBarWidget.TextPresentation {

    companion object {
        const val WIDGET_ID = "ZCode.StatusBarWidget"

        private val INSTANCES = CopyOnWriteArraySet<ZCodeStatusBarWidget>()

        /** 标签相位/状态变化后刷新 widget 文案（EDT 排队；幂等、廉价，热路径可随手调） */
        fun refreshFor(project: Project?) {
            SwingUtilities.invokeLater {
                for (w in INSTANCES) {
                    if (project == null || w.project === project) w.refresh()
                }
            }
        }
    }

    @Volatile
    private var statusBar: StatusBar? = null

    init {
        INSTANCES.add(this)
    }

    override fun ID(): String = WIDGET_ID

    /** 多项目窗口：每窗一个实例，各自绑定各自 project（统计口径按实例 project 过滤） */
    override fun copy(): StatusBarWidget = ZCodeStatusBarWidget(project)

    override fun install(statusBar: StatusBar) {
        this.statusBar = statusBar
        refresh()
    }

    override fun dispose() {
        INSTANCES.remove(this)
        statusBar = null
    }

    override fun getPresentation(): StatusBarWidget.WidgetPresentation = this

    override fun getText(): String {
        val running = countStreamingTabs()
        return if (running > 0) message("statusbar.widget.text.running", running) else message("statusbar.widget.text")
    }

    override fun getAlignment(): Float = Component.CENTER_ALIGNMENT

    override fun getTooltipText(): String {
        val running = countStreamingTabs()
        return if (running > 0) message("statusbar.widget.tooltip.running", running) else message("statusbar.widget.tooltip")
    }

    override fun getClickConsumer(): Consumer<MouseEvent> = Consumer { e ->
        SwingUtilities.invokeLater {
            if (project.isDisposed) return@invokeLater
            val toolWindow = ZCodeToolWindowFactory.getToolWindow(project) ?: return@invokeLater
            if (e.clickCount >= 2) {
                ZCodeToolWindowFactory.createNewTab(project, toolWindow)
                return@invokeLater
            }
            toolWindow.show(null)
            (toolWindow.contentManager.selectedContent?.component as? ZCodeToolWindowPanel)?.activateContent(true)
        }
    }

    private fun refresh() {
        statusBar?.updateWidget(ID())
    }

    /** 本项目内生成中的会话标签数（含弹出独立窗口的标签——监督语义不因窗口形态打折） */
    private fun countStreamingTabs(): Int = ZCodeToolWindowPanel.activePanels.count {
        it.getOwningProject() === project && it.isTabStreaming()
    }
}
