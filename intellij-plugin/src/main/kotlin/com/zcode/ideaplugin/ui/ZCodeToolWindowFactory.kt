package com.zcode.ideaplugin.ui

import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.content.Content
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.content.ContentManager
import com.intellij.ui.content.ContentManagerEvent
import com.intellij.ui.content.ContentManagerListener
import com.zcode.ideaplugin.zCodeService

/**
 * ZCode ToolWindow 工厂（多标签页，对齐 cc-gui ContentManager 方案）
 *
 * 每个标签 = 一个 Content = 一个 ZCodeToolWindowPanel（独立 JCEF + React 实例），
 * 会话状态天然隔离、互不影响。标签状态（名字 + 绑定 sessionId）持久化到
 * ZCodeTabState，重启后按 sessionId 懒加载恢复。
 *
 * - 新建标签：前端「新标签页」按钮 → op:createTab → createNewTab（EDT）
 * - 关闭标签：原生 Content 关闭按钮；仅剩 1 个时禁关
 * - 切换标签：selectionChanged → 更新 Service 的激活面板 + 持久化 activeIndex
 */
class ZCodeToolWindowFactory : ToolWindowFactory, DumbAware {

    companion object {
        const val TOOL_WINDOW_ID = "ZCode"
        private const val TAB_NAME_PREFIX = "会话"
        /** 匹配「会话1」「会话1 ●」等，取数字部分 */
        private val TAB_NAME_PATTERN = Regex("^$TAB_NAME_PREFIX(\\d+)")

        fun getToolWindow(project: Project): ToolWindow? =
            ToolWindowManager.getInstance(project).getToolWindow(TOOL_WINDOW_ID)

        /** 新建一个标签页（须在 EDT 调用；新标签 = 新会话，不继承旧会话）*/
        fun createNewTab(project: Project, toolWindow: ToolWindow): Content? {
            val cm = toolWindow.contentManager
            val tabName = getNextTabName(cm)
            val content = addTabContent(project, toolWindow, null, tabName)
            toolWindow.show(null)
            return content
        }

        /** 生成下一个标签名：取现有「会话N」最大编号 + 1 */
        private fun getNextTabName(cm: ContentManager): String {
            var max = 0
            for (c in cm.contents) {
                val m = TAB_NAME_PATTERN.find(c.displayName ?: "") ?: continue
                max = maxOf(max, m.groupValues[1].toIntOrNull() ?: 0)
            }
            return "$TAB_NAME_PREFIX${max + 1}"
        }

        /**
         * 创建标签内容并注册（须在 EDT 调用）
         *
         * @param initialSessionId 重启恢复时绑定的会话 id；null 表示新标签（前端自动建会话）
         * @param lazy 懒加载：不立即创建 JCEF（占位 UI），首次切到本标签时激活。
         *        重启恢复的非激活标签用，避免启动风暴并发拉起多个渲染进程；懒加载不自动选中
         */
        private fun addTabContent(
            project: Project,
            toolWindow: ToolWindow,
            initialSessionId: String?,
            tabName: String,
            lazy: Boolean = false,
        ): Content {
            val panel = ZCodeToolWindowPanel(project, initialSessionId, lazyStart = lazy)
            val content = ContentFactory.getInstance().createContent(panel, tabName, false)
            content.isCloseable = true
            // 标签关闭/销毁时释放 panel（JCEF 资源）
            content.setDisposer(panel)
            panel.attachContent(content)
            toolWindow.contentManager.addContent(content)
            project.zCodeService().registerPanel(panel)
            if (!lazy) toolWindow.contentManager.setSelectedContent(content)
            return content
        }

        /** 把当前标签布局全量写入 TabState（名字 + sessionId + activeIndex）*/
        fun persistTabs(project: Project, cm: ContentManager) {
            val state = ZCodeTabState.getInstance(project).state
            state.tabs = cm.contents.mapNotNull { c ->
                val panel = c.component as? ZCodeToolWindowPanel ?: return@mapNotNull null
                ZCodeTabState.TabInfo(
                    name = panel.getBaseTabTitle().ifBlank { c.displayName ?: "" },
                    sessionId = panel.getCurrentSessionIdForPersist(),
                )
            }.toMutableList()
            val selected = cm.selectedContent
            state.activeIndex = if (selected != null) cm.getIndexOfContent(selected) else 0
        }
    }

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        // 侧边栏标签显示名（id 保持 "ZCode" 供 getToolWindow 查找，显示名改为 ZC GUI）
        toolWindow.stripeTitle = "ZC GUI"
        toolWindow.show(null) // TODO 临时：截图实验用，实验后移除
        val cm = toolWindow.contentManager

        // 恢复持久化的标签（或首个默认标签）
        val saved = ZCodeTabState.getInstance(project).state.tabs
        if (saved.isEmpty()) {
            addTabContent(project, toolWindow, null, "${TAB_NAME_PREFIX}1")
        } else {
            // 激活索引先算好：只有激活标签立即创建 JCEF，其余懒加载（切到时才建）。
            // 2026-08-15 白屏故障：重启恢复 3 个标签 → 启动瞬间并发拉起 3 个渲染进程全部失败 → UI 空白
            val activeIdx = ZCodeTabState.getInstance(project).state.activeIndex
                .coerceIn(0, saved.size - 1)
            for ((i, info) in saved.withIndex()) {
                val sid = info.sessionId?.takeIf { it.isNotBlank() }
                addTabContent(
                    project, toolWindow, sid, info.name.ifBlank { "$TAB_NAME_PREFIX ?" },
                    lazy = i != activeIdx,
                )
            }
            // 恢复激活索引
            if (cm.contentCount > 0) cm.setSelectedContent(cm.contents[activeIdx])
        }

        cm.addContentManagerListener(object : ContentManagerListener {
            override fun contentAdded(event: ContentManagerEvent) {
                updateCloseable(cm)
                persistTabs(project, cm)
            }

            override fun selectionChanged(event: ContentManagerEvent) {
                if (cm.selectedContent !== event.content) return
                val panel = event.content.component as? ZCodeToolWindowPanel ?: return
                panel.ensureJcefCreated() // 懒加载标签激活（已激活时为 no-op）
                project.zCodeService().setActivePanel(panel)
                persistTabs(project, cm)
            }

            /** 关闭二次确认：移除前弹确认框，取消则拦截关闭（event.consume）*/
            override fun contentRemoveQuery(event: ContentManagerEvent) {
                val content = event.content
                val panel = content.component as? ZCodeToolWindowPanel
                val tabName = content.displayName ?: "标签"
                val streaming = panel?.isTabStreaming() == true
                val message = if (streaming) {
                    "标签「$tabName」的会话正在生成中，确定关闭吗？"
                } else {
                    "确定关闭标签「$tabName」吗？"
                }
                val result = com.intellij.openapi.ui.Messages.showYesNoDialog(
                    project,
                    message,
                    "关闭标签",
                    com.intellij.openapi.ui.Messages.getQuestionIcon(),
                )
                if (result != com.intellij.openapi.ui.Messages.YES) {
                    event.consume()
                }
            }

            override fun contentRemoved(event: ContentManagerEvent) {
                updateCloseable(cm)
                val panel = event.content.component as? ZCodeToolWindowPanel
                if (panel != null) project.zCodeService().unregisterPanel(panel)
                persistTabs(project, cm)
                // panel 的 JCEF 资源由 content.setDisposer(panel) 释放
            }
        })

        updateCloseable(cm)

        // 初始激活面板（外部推送目标）
        (cm.selectedContent?.component as? ZCodeToolWindowPanel)?.let {
            it.ensureJcefCreated() // 兜底：选中项若为懒加载则激活（正常路径激活标签已立即创建）
            project.zCodeService().setActivePanel(it)
        }
    }

    /** 仅剩 1 个标签时禁用关闭按钮 */
    private fun updateCloseable(cm: ContentManager) {
        val closeable = cm.contentCount > 1
        cm.contents.forEach { it.isCloseable = closeable }
    }
}
