package com.zcode.ideaplugin.action

import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.PlatformDataKeys
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.JBUI
import com.zcode.ideaplugin.ZCodeBundle.message
import com.zcode.ideaplugin.ui.ZCodeToolWindowFactory
import com.zcode.ideaplugin.ui.ZCodeToolWindowPanel
import java.awt.Point

/**
 * 重命名标签（issue #18/#21）：改的是标签名（TabState 持久化，默认「会话N」编号），
 * 不是会话标题——标题走 header 铅笔编辑 + setTabTitle tooltip，两条链路独立（当年标签名改编号
 * 就是为了防自动长标题撑爆标签栏，重命名必须防回潮，故输入硬截 16 字符）。
 *
 * 挂载（2026-11-12 用户定稿收进平台 ⋮ 菜单，不再占独立按钮）：
 * - 工具窗标题栏 ⋮（setAdditionalGearActions）：无参构造——目标 panel 从 dataContext 的
 *   ToolWindow 反查 selectedContent（gear 菜单弹出时平台必放 ToolWindow 进 context）；
 * - content.setActions（标签右键菜单，部分 LaF 兼容）：构造持 panel 引用（Content 级
 *   dataContext 无单 Content 的 DataKey，直接持有引用最稳）。改名与持久化封装在 panel.renameTab。
 *
 * 输入弹窗用 JBPopup 而非 Messages.showInputDialog：后者样式厚重（标题条+边框两层），
 * JBPopup 组件弹窗可做单输入框轻量形态，水平居中于工具窗贴顶弹出，预填当前标签名。
 */
class RenameTabAction(private val panel: ZCodeToolWindowPanel? = null) : AnAction(
    message("action.renameTab.text"),
    message("action.renameTab.description"),
    AllIcons.Actions.Edit,
) {

    /** 目标标签面板：构造引用优先（右键菜单模式），缺省从 dataContext 现取选中标签（gear 模式） */
    private fun resolvePanel(e: AnActionEvent): ZCodeToolWindowPanel? =
        panel ?: PlatformDataKeys.TOOL_WINDOW.getData(e.dataContext)
            ?.contentManager?.selectedContent?.component as? ZCodeToolWindowPanel

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = resolvePanel(e) != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val target = resolvePanel(e) ?: return
        val toolWindow = ZCodeToolWindowFactory.getToolWindow(project) ?: return
        val field = JBTextField(target.getBaseTabTitle(), FIELD_COLUMNS)
        field.selectAll()
        // 扁平化：无标题条、输入框自带边框去掉只留 popup 一层轻边——对齐平台原地重命名的轻量形态
        field.border = JBUI.Borders.empty(6, 8)
        val popup = JBPopupFactory.getInstance()
            .createComponentPopupBuilder(field, field)
            .setRequestFocus(true)
            .setCancelOnClickOutside(true)
            .createPopup()
        // 回车提交（空串=取消不动），ESC / 点击外部 = 关闭
        field.addActionListener {
            val name = field.text.trim().take(TAB_NAME_MAX_LENGTH)
            if (name.isNotEmpty()) target.renameTab(name)
            popup.cancel()
        }
        // 定位：水平居中于工具窗、贴顶（标签正下方定位试过——平台标签自绘坐标实际取不到，真机恒居中，
        // 用户拍板就居中）
        val anchor = toolWindow.component
        val loc = runCatching { anchor.locationOnScreen }.getOrNull()
        if (loc != null) {
            val x = loc.x + (anchor.width - field.preferredSize.width - 4) / 2
            popup.showInScreenCoordinates(anchor, Point(x.coerceAtLeast(loc.x), loc.y + 4))
        } else {
            popup.showInFocusCenter()
        }
    }

    companion object {
        /** 标签名长度上限（字符）：防长名挤压相邻标签 */
        const val TAB_NAME_MAX_LENGTH = 16

        /** 输入框列宽（覆盖 16 字上限的常规场景，过长横向滚动） */
        private const val FIELD_COLUMNS = 18
    }
}
