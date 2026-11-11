package com.zcode.ideaplugin.action

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.PlatformDataKeys
import com.intellij.openapi.project.Project
import com.intellij.icons.AllIcons
import com.intellij.ui.content.Content
import com.zcode.ideaplugin.ZCodeBundle.message
import com.zcode.ideaplugin.ui.SessionDetachWindow
import com.zcode.ideaplugin.ui.ZCodeToolWindowPanel

/**
 * 「把标签弹出为独立窗口」（搬运式会话标签弹窗 ⑧ 的主窗入口）：
 * 双屏监督场景——左屏代码被 AI 改、右屏对话监督。
 *
 * 挂载（2026-11-12 用户定稿收进平台 ⋮ 菜单，不再占独立按钮）：
 * - 工具窗标题栏 ⋮（setAdditionalGearActions）：无 content 构造——目标标签从 dataContext
 *   的 ToolWindow 反查 selectedContent（gear 菜单弹出时平台必放 ToolWindow 进 context）；
 * - content.setActions（标签右键菜单）：构造持 content 引用（Content 级 dataContext
 *   无单 Content 的 DataKey，直接持有引用最稳）。
 *
 * 行为承诺见 [SessionDetachWindow] 类注：弹出即整体搬运、关闭独立窗口自动搬回主窗；
 * 每项目同时至多一个弹出窗口（v1）。EDT 要求由 SessionDetachWindow.detach 保证。
 */
class DetachTabAction(
    private val project: Project? = null,
    private val content: Content? = null,
) : AnAction(
    message("action.detachTab.text"),
    message("action.detachTab.description"),
    // 浏览器面板「弹出到独立窗口」同款图标，两处弹出语义呼应
    AllIcons.Actions.MoveToWindow,
) {

    /** 目标 (project, content)：构造引用优先（右键菜单模式），缺省 dataContext 现取（gear 模式） */
    private fun resolve(e: AnActionEvent): Pair<Project, Content>? {
        val p = project ?: e.project ?: return null
        val c = content
            ?: PlatformDataKeys.TOOL_WINDOW.getData(e.dataContext)?.contentManager?.selectedContent
            ?: return null
        return p to c
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT

    override fun update(e: AnActionEvent) {
        val target = resolve(e)
        val chatPanel = target?.second?.component as? ZCodeToolWindowPanel
        e.presentation.isEnabledAndVisible = chatPanel != null
        e.presentation.isEnabled = chatPanel != null && target != null && !SessionDetachWindow.isDetached(target.first)
    }

    override fun actionPerformed(e: AnActionEvent) {
        val (p, c) = resolve(e) ?: return
        SessionDetachWindow.detach(p, c)
    }
}
