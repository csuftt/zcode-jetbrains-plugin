package com.zcode.ideaplugin.action

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.vfs.VirtualFile
import com.zcode.ideaplugin.ZCodeBundle.message
import com.zcode.ideaplugin.ZCodeIcons

/**
 * 右键菜单：把选中代码的行号引用发送到 ZCode 输入框（对齐 cc-gui SendSelectionToTerminalAction）
 *
 * - 注册位置：编辑器右键（EditorPopupMenu）+ 快捷键 Ctrl+Alt+K
 * - 选区转引用串：单行 `@path#L10`，多行 `@path#L10-20`（1-based，末尾换行特判）
 * - 发送的是引用而非代码文本：消息简洁，后端按引用读取最新代码
 * - 无选区时只打开/聚焦 ZCode 输入框
 */
class SendSelectionToInputAction : AnAction(
    message("action.sendSelectionToInput.text"),
    message("action.sendSelectionToInput.description"),
    ZCodeIcons.Zai,
) {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.getData(CommonDataKeys.EDITOR) != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val selectionModel = editor.selectionModel

        if (!selectionModel.hasSelection()) {
            // 无选区：只打开 ZCode 输入框（前端收到空 refs 时仅聚焦）
            pushRefs(project, emptyList())
            return
        }

        val file = FileDocumentManager.getInstance().getFile(editor.document)
            ?: e.getData(CommonDataKeys.VIRTUAL_FILE)
        if (file == null) {
            pushRefs(project, emptyList())
            return
        }

        val ref = buildLineReference(file, editor.document, selectionModel.selectionStart, selectionModel.selectionEnd)
        pushRefs(project, listOf(ref))
    }
}

/**
 * 构造行号引用：`@path#L10` 或 `@path#L10-20`。
 * 末尾换行特判：选区含末尾换行时排除空行（对齐 cc-gui SelectionReferenceBuilder）。
 * 编辑器右键"发送选中代码/复制AI引用"两个动作共用，保证引用串格式一致。
 */
internal fun buildLineReference(file: VirtualFile, document: Document, startOffset: Int, endOffset: Int): String {
    var end = endOffset
    val textLength = document.textLength
    if (end > startOffset && end == textLength && textLength > 0 && document.charsSequence[end - 1] == '\n') {
        end--
    }
    val startLine = document.getLineNumber(startOffset.coerceAtMost(end)) + 1
    val endLine = document.getLineNumber(end.coerceAtLeast(startOffset)) + 1
    return if (startLine == endLine) {
        "@${file.path}#L$startLine"
    } else {
        "@${file.path}#L$startLine-$endLine"
    }
}
