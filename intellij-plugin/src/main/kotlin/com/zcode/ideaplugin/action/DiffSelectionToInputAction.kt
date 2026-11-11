package com.zcode.ideaplugin.action

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.vfs.VirtualFile
import com.zcode.ideaplugin.ZCodeBundle.message
import com.zcode.ideaplugin.ZCodeIcons

/**
 * diff 视图右键「就选中改动问 ZC GUI」（IDEA 验收对话桥，调研 ⑯）。
 *
 * 验收动线的对话闭环：在 IDE diff（更改条弹窗 / VCS diff）里选中改动片段，
 * 一键以「文件+行号引用」回填输入框继续追问——发现可疑改动直接让 AI 调整，
 * 而不是自己手动改。
 *
 * 挂点（探针定案）：**`Diff.EditorPopupMenu` 组**。不能挂标准 `EditorPopupMenu`——
 * diff 文本编辑器的右键由 TextDiffViewerUtil$EditorActionsPopup 经
 * EditorEx.installPopupHandler 追加自己的 handler，EditorImpl 右键分发倒序遍历、
 * 后装先赢、命中即停，标准组在 diff 视图不可达（2023.3 反汇编实证）。
 *
 * 引用装配与 SendSelectionToInput 同链（buildLineReference）；diff 侧拿不到
 * 所属文件时（罕见，双栏临时编辑器）降级发选区原文，功能不断。
 */
class DiffSelectionToInputAction : AnAction(
    message("action.diffSelectionToInput.text"),
    message("action.diffSelectionToInput.description"),
    ZCodeIcons.ZcGui,
), DumbAware {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT

    override fun update(e: AnActionEvent) {
        val editor = e.getData(CommonDataKeys.EDITOR)
        e.presentation.isEnabledAndVisible = editor?.selectionModel?.hasSelection() == true
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor: Editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val selectionModel = editor.selectionModel
        val selected = selectionModel.selectedText?.trim()
        if (selected.isNullOrEmpty()) return

        val file: VirtualFile? = FileDocumentManager.getInstance().getFile(editor.document)
            ?: e.getData(CommonDataKeys.VIRTUAL_FILE)
        if (file == null) {
            // diff 临时编辑器拿不到真实文件：降级送选区原文（堆栈/片段仍可提问）
            pushTextToInput(project, selected)
            return
        }
        val ref = buildLineReference(file, editor.document, selectionModel.selectionStart, selectionModel.selectionEnd)
        pushRefs(project, listOf(ref))
    }
}
