package com.zcode.ideaplugin.ui.vcs

import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.Project
import com.intellij.openapi.vcs.VcsDataKeys
import com.intellij.openapi.vcs.changes.Change
import com.intellij.openapi.vcs.changes.ChangeListManager

/**
 * 提交对话框「勾选变更集」收集（四级回退，cc-gui 同款）：
 * 提交信息生成（[ZCodeCommitMessageAction]）取勾选范围用，保证口径与用户所见一致。
 */
internal object ZCodeCommitChanges {

    /** 勾选变更集：workflow UI → CheckinProjectPanel → VcsDataKeys → 全部变更 */
    fun userSelectedChanges(e: AnActionEvent, project: Project): Collection<Change>? {
        e.getData(VcsDataKeys.COMMIT_WORKFLOW_HANDLER)?.let { handler ->
            includedChangesViaReflection(handler)?.takeIf { it.isNotEmpty() }?.let { return it }
        }
        (e.getData(VcsDataKeys.COMMIT_MESSAGE_CONTROL) as? com.intellij.openapi.vcs.CheckinProjectPanel)?.let { p ->
            p.selectedChanges.takeIf { it.isNotEmpty() }?.let { return it }
        }
        e.getData(VcsDataKeys.CHANGES)?.takeIf { it.isNotEmpty() }?.let { return it.toList() }
        return ChangeListManager.getInstance(project)
            .allChanges.takeIf { it.isNotEmpty() }
    }

    /** AbstractCommitWorkflowHandler.getUi().getIncludedChanges() 反射读取（旧版 IDE 无此 API 静默降级） */
    private fun includedChangesViaReflection(handler: Any): Collection<Change>? {
        return try {
            val ui = handler.javaClass.getMethod("getUi").invoke(handler) ?: return null
            val included = ui.javaClass.getMethod("getIncludedChanges").invoke(ui) as? Collection<*>
            included?.filterIsInstance<Change>()
        } catch (t: Throwable) {
            null
        }
    }
}
