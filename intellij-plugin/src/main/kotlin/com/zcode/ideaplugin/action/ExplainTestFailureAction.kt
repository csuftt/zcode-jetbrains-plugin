package com.zcode.ideaplugin.action

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DataKey
import com.intellij.openapi.project.DumbAware
import com.intellij.execution.testframework.sm.runner.SMTestProxy
import com.zcode.ideaplugin.ZCodeBundle.message
import com.zcode.ideaplugin.ZCodeIcons

/**
 * 测试树右键「让 ZC GUI 解释此次失败」（IDEA 集成面调研 ④ 加分项）。
 *
 * 挂点：`TestTreePopupMenu` 组——现代 SM 树（Gradle/JUnit 实际用的
 * SMTRunnerTestTreeView）与 legacy 树共用该组（2023.3 常量池探针实证）。
 * 数据面：树按 `DataKey.create("testProxy")` 提供选中节点（DataKey 按名等价，
 * 自建同名 Key 即可取到），`SMTestProxy.getStacktrace()/getName()` 在 233 可用。
 *
 * 堆栈非空的节点才启用（失败用例才有堆栈；通过中/未跑的节点右键置灰）。
 * 发送形态与控制台送诊同口径：预填输入框待确认，不自动发送。
 */
class ExplainTestFailureAction : AnAction(
    message("action.explainTestFailure.text"),
    message("action.explainTestFailure.description"),
    ZCodeIcons.ZcGui,
), DumbAware {

    companion object {
        /** 测试树 SMTRunnerTestTreeView.getData 提供的数据键（按名匹配，平台内同名 Key 等价） */
        private val TEST_PROXY: DataKey<SMTestProxy> = DataKey.create("testProxy")
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT

    override fun update(e: AnActionEvent) {
        val proxy = e.getData(TEST_PROXY)
        // getStacktrace 是字段读（非 PSI 查询），EDT update 内调用安全
        e.presentation.isEnabledAndVisible = proxy != null && !proxy.stacktrace.isNullOrBlank()
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val proxy = e.getData(TEST_PROXY) ?: return
        val stack = proxy.stacktrace?.trim().orEmpty()
        if (stack.isEmpty()) {
            NotificationGroupManager.getInstance()
                .getNotificationGroup("ZCode")
                .createNotification(message("action.explainTestFailure.text"), message("test.failure.notify.noStack"), NotificationType.WARNING)
                .notify(project)
            return
        }
        val name = proxy.name ?: ""
        pushTextToInput(
            project,
            message("test.failure.lead", name) + "\n\n```\n" + stack + "\n```",
        )
    }
}
