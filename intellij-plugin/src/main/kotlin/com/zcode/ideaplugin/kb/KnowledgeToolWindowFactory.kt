package com.zcode.ideaplugin.kb

import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

/**
 * 知识库 ToolWindow（issue#54，独立停靠左侧）：浏览/检索/预览/收录入口。
 * 面板构造失败降级占位不炸工具窗（ZCodeToolWindowFactory 同款纪律）。
 */
class KnowledgeToolWindowFactory : ToolWindowFactory, DumbAware {

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        try {
            val panel = KnowledgeToolWindowPanel(project)
            val content = ContentFactory.getInstance().createContent(panel, "", false)
            content.setDisposer(panel)
            content.isCloseable = false
            toolWindow.contentManager.addContent(content)
        } catch (e: Throwable) {
            com.intellij.openapi.diagnostic.Logger.getInstance("ZCodePlugin")
                .warn("Knowledge ToolWindow init failed: ${e.message}", e)
        }
    }
}
