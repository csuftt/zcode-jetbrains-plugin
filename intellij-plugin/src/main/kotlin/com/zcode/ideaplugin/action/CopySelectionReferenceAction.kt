package com.zcode.ideaplugin.action

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.zcode.ideaplugin.ZCodeBundle.message
import java.awt.datatransfer.StringSelection

/**
 * 右键菜单：复制AI引用 — 把选中代码的「文件路径 + 行号」引用写入系统剪贴板
 * （对齐 cc-gui CopySelectionReferenceAction）
 *
 * - 注册位置：编辑器右键（EditorPopupMenu），紧跟「发送选中代码到 ZC GUI 输入框」之后
 * - 引用串与发送动作同源（buildLineReference）：单行 `@path#L10`、多行 `@path#L10-20`
 * - 可直接粘贴到 ZC GUI 输入框作为 @ 引用，也可粘贴到任意地方分享定位
 * - 无选区时菜单隐藏（没有可复制的行号范围）
 */
class CopySelectionReferenceAction : AnAction() {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val editor = e.getData(CommonDataKeys.EDITOR)
        e.presentation.isEnabledAndVisible = editor?.selectionModel?.hasSelection() == true
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val selectionModel = editor.selectionModel
        if (!selectionModel.hasSelection()) return

        val file = FileDocumentManager.getInstance().getFile(editor.document)
            ?: e.getData(CommonDataKeys.VIRTUAL_FILE)
        if (file == null) {
            notify(project, message("action.copySelectionReference.notify.noFile"), NotificationType.WARNING)
            return
        }

        val reference = buildLineReference(
            file, editor.document,
            selectionModel.selectionStart, selectionModel.selectionEnd
        )
        CopyPasteManager.getInstance().setContents(StringSelection(reference))
        notify(project, message("action.copySelectionReference.notify.copied", reference), NotificationType.INFORMATION)
    }

    private fun notify(project: Project, messageText: String, type: NotificationType) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup("ZCode")
            .createNotification(message("action.copySelectionReference.text"), messageText, type)
            .notify(project)
    }
}
