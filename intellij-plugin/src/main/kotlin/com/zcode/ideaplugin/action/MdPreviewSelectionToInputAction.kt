package com.zcode.ideaplugin.action

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DataKey
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.ui.awt.RelativePoint
import com.zcode.ideaplugin.ZCodeBundle.message
import com.zcode.ideaplugin.ZCodeIcons
import com.zcode.ideaplugin.mdpreview.MdPreviewSelectionRegistry

/**
 * Markdown 预览（阅读模式）右键：把选中内容的位置引用发送到 ZCode 输入框。
 *
 * 入口注入：运行时 add 进 markdown 插件的 `Markdown.PreviewGroup`（该组在预览右键弹窗时
 * 从 ActionManager 现取，注入即刻生效，与「调整字体大小/查找」并列）——见
 * [com.zcode.ideaplugin.mdpreview.ZcodeMdSelectionRefExtension]。233 等无该组的版本不注入，
 * 本 action 永远隐藏，无副作用。
 *
 * 数据链：注入脚本经 BrowserPipe 维护选区偏移快照（源码字符偏移 from..to）→
 * [MdPreviewSelectionRegistry.resolve] 定位面板 → 偏移转 Document 行号 →
 * `@path#L10-20`（与 SendSelectionToInputAction 同格式）→ pushRefs 内联 chip 到输入框光标处。
 *
 * 本类**不得 import org.intellij.plugins.markdown 类**：action 无条件注册，markdown 插件缺席
 * 时（optional depends）类加载不可触碰 markdown 类型；markdown 类型引用全部隔离在
 * mdpreview 包的扩展类里。
 */
class MdPreviewSelectionToInputAction : AnAction(
    message("action.mdPreviewSelectionToInput.text"),
    message("action.mdPreviewSelectionToInput.description"),
    ZCodeIcons.ZcGui,
) {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = resolveEntry(e)?.snapshot != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val entry = resolveEntry(e) ?: return
        val snapshot = entry.snapshot ?: return
        val project = e.project ?: entry.project ?: return
        val file = entry.file ?: return
        val document = FileDocumentManager.getInstance().getDocument(file) ?: return
        val ref = buildLineReference(file, document, snapshot.from, snapshot.to)
        pushRefs(project, listOf(ref))
    }

    /**
     * 定位右键落点的预览面板。优先从 dataContext 复用 markdown 插件放入的 PREVIEW_POPUP_POINT
     * （DataKey 按 name 匹配，名字取自其常量池；拿不到/名字变更时为 null），以屏幕点精确匹配；
     * 无点时 [MdPreviewSelectionRegistry.resolve] 用唯一 showing 候选兜底。
     */
    private fun resolveEntry(e: AnActionEvent): MdPreviewSelectionRegistry.Entry? {
        val point = try {
            e.getData(DataKey.create<RelativePoint>("PREVIEW_POPUP_POINT"))?.screenPoint
        } catch (_: Exception) {
            null
        }
        return MdPreviewSelectionRegistry.resolve(point)
    }
}
