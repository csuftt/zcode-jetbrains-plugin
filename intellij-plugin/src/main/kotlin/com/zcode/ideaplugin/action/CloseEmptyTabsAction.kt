package com.zcode.ideaplugin.action

import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.Project
import com.zcode.ideaplugin.ZCodeBundle.message
import com.zcode.ideaplugin.ui.ZCodeToolWindowFactory
import com.zcode.ideaplugin.ui.ZCodeToolWindowPanel

/**
 * 批量关闭无会话空标签（displayName 挂「°」前置度号标识的那批）：一次清掉「新开了
 * 没发消息」/「新建会话后闲置」/「绑定会话已删」的标签。判据单一来源 =
 * panel.isStandbyUnbound()，与 ° 前缀标识、关闭免确认共用（见 companion 注释的场景矩阵）。
 * （「（空）」文字后缀撑长标签被否，定版 ° 空心小圆=「● 生成中」的空态对偶）
 *
 * 挂载：工具窗标题栏按钮（setTitleActions，与 RenameTabAction 并列随 selectionChanged 切换）
 * + content.setActions（部分 LaF 兼容——2026-11-02 真机实锤新 UI 下 Content 右键菜单
 * 不渲染 setActions 组，标题栏按钮才是可靠入口；同 RenameTabAction 双入口原因）。
 *
 * 关闭走 cm.removeContent(content, dispose=true)：会触发 contentRemoveQuery——空标签
 * 已在 Factory 豁免二次确认（无会话可丢），故批量执行不弹窗；contentRemoved 里的
 * updateCloseable/persistTabs 随每个移除自动补，持久化无需此处关心。
 *
 * 保护规则对齐 updateCloseable 的「最后一个标签禁关」语义：若全部标签都是空标签，
 * 保留当前选中的那一个不关，工具窗不清空。
 */
class CloseEmptyTabsAction(private val project: Project) : AnAction(
    message("action.closeEmptyTabs.text"),
    message("action.closeEmptyTabs.description"),
    AllIcons.Actions.GC,
) {

    override fun actionPerformed(e: AnActionEvent) {
        val cm = ZCodeToolWindowFactory.getToolWindow(project)?.contentManager ?: return
        val empty = cm.contents.filter {
            (it.component as? ZCodeToolWindowPanel)?.isStandbyUnbound() == true
        }
        if (empty.isEmpty()) return
        // 全部都是空标签 → 留当前选中的一个（无浏览器标签时 selectedContent 必在 empty 内）
        val toClose = if (empty.size == cm.contents.size) {
            empty.filterNot { it === cm.selectedContent }
        } else {
            empty
        }
        // removeContent 会改动 contents，快照后逐个移除；全部 EDT 串行，无并发窗口
        toClose.forEach { content -> cm.removeContent(content, true) }
    }

    override fun update(e: AnActionEvent) {
        // 显隐判据（真机定版）：只有空标签「值得批量关」才显示——空标签 ≥2 个，或唯一空标签
        // 不是当前标签；单个空标签且就在当前标签时直接点 × 更快，不显示按钮。
        // update 只由 IDE 事件驱动（重启后可能冻结不跑），空标签集合变化点由
        // ZCodeToolWindowFactory.refreshTitleToolbar 主动强制刷新兜底。
        val cm = project.let { ZCodeToolWindowFactory.getToolWindow(it)?.contentManager }
        val contents = cm?.contents
        // 工具窗构建早期（标签还没恢复进 cm）不表态：此时判必得「无空标签」，
        // 一旦冻结成隐藏，之后没有任何事件能纠正（重启首开体感 bug，2026-11-02）
        if (cm == null || contents == null || contents.isEmpty()) return
        val empty = contents.filter {
            (it.component as? ZCodeToolWindowPanel)?.isStandbyUnbound() == true
        }
        e.presentation.isEnabledAndVisible = empty.size >= 2 ||
            (empty.size == 1 && empty[0] !== cm.selectedContent)
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT
}
