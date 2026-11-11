package com.zcode.ideaplugin.action

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.zcode.ideaplugin.ZCodeBundle.message
import com.zcode.ideaplugin.ZCodeIcons

/**
 * 控制台右键「发送最近错误到 ZC GUI」（无选区版，IDEA 集成面调研 ④）。
 *
 * 与 [SendConsoleTextToInputAction]（手动划选）互补：跑应用/测试报错时不划选，
 * 右键直接把最近错误段（[RecentErrorExtractor] 锚点提取）送进输入框诊断。
 * 交互口径与 SendSelection 现行为一致：预填输入框待确认，不自动发送（防误发）。
 *
 * 挂点：ConsoleEditorPopupMenu（挂点沿用既有动作实证结论）。
 */
class SendRecentErrorToInputAction : AnAction(
    message("action.sendRecentErrorToInput.text"),
    message("action.sendRecentErrorToInput.description"),
    ZCodeIcons.ZcGui,
) {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val editor = e.getData(CommonDataKeys.EDITOR)
        // 无选区动作：控制台有内容即可用（空控制台禁用，免得点了空手而归）
        e.presentation.isEnabledAndVisible = editor != null
        e.presentation.isEnabled = editor != null && editor.document.text.isNotBlank()
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val segment = RecentErrorExtractor.extract(editor.document.text, message("console.recentError.truncated"))
        if (segment.isBlank()) {
            NotificationGroupManager.getInstance()
                .getNotificationGroup("ZCode")
                .createNotification(message("action.sendRecentErrorToInput.text"), message("console.recentError.notify.noError"), NotificationType.WARNING)
                .notify(project)
            return
        }
        pushTextToInput(project, message("console.recentError.lead") + "\n\n" + segment)
    }
}
