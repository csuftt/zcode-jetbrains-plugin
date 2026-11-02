package com.zcode.ideaplugin.action

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.zcode.ideaplugin.ZCodeBundle.message
import com.zcode.ideaplugin.ZCodeIcons
import com.zcode.ideaplugin.ui.FileRefs
import com.zcode.ideaplugin.ui.WorkspaceSendTargets
import com.zcode.ideaplugin.ui.ZCodeLinkedWorkspaces
import com.zcode.ideaplugin.ui.ZCodeToolWindowFactory
import com.zcode.ideaplugin.zCodeService

/**
 * 右键「发送到 ZC GUI 输入框」的多工作区收口组（单一入口形态）：
 *
 * - 可投递目标只有当前标签一个 → 本组隐藏，平铺的 [SendFileToInputAction] 保持一键直达
 * - 目标超过一个（文件还落在关联目录子树/项目根挂载可达）→ 本组以**同名**「发送到
 *   ZC GUI 输入框 ▸」取代平铺项，子项按目录名区分，当前标签置顶标「（当前）」，
 *   悬浮 description 显全路径
 * - 子项点击：当前项=既有平铺行为（推激活面板）；其他工作区=**恒新开标签**
 *   （待命态落位该目录，文案「新开标签（目录名）」与「当前标签（目录名）」对称）
 *   ——引用统一走 panel 待投递通道，避开新标签 React 未就绪时的静默丢失窗口
 *
 * 与 [SendFileToInputAction] 互斥显示（任一菜单语境两者只见其一），三处挂点相同。
 * 无激活面板（无法判定当前标签工作区）→ 整组隐藏保持现状。
 */
class SendFileToWorkspaceGroupAction : DefaultActionGroup(
    message("action.sendFileToInput.text"),
    message("action.sendToWorkspace.description"),
    ZCodeIcons.ZcGui,
) {

    /** update()（BGT）算好的子项快照；getChildren 在 EDT 菜单构建时读，volatile 隔离 */
    @Volatile
    private var childrenSnapshot: List<AnAction> = emptyList()

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val project = e.project
        val files = if (project == null) emptyList() else resolveMenuVirtualFiles(e)
        val refs = if (files.isEmpty()) emptyList() else buildMenuRefs(e, files)
        val targets = if (project == null || files.isEmpty()) emptyList() else computeWorkspaceSendTargets(project, files)
        e.presentation.isVisible = targets.firstOrNull { it.isCurrent } != null && targets.size > 1
        // 选区语境父项换「发送选中代码」口径（此时 refs 本就是行号引用），与平铺的
        // SendSelectionToInputAction 同文案互斥；无选区=文件口径
        val hasSelection = e.getData(CommonDataKeys.EDITOR)?.selectionModel?.hasSelection() == true
        templatePresentation.text =
            message(if (hasSelection) "action.sendSelectionToInput.text" else "action.sendFileToInput.text")
        templatePresentation.description =
            message(if (hasSelection) "action.sendSelectionToInput.description" else "action.sendToWorkspace.description")
        childrenSnapshot = targets.map { SendToWorkspaceTargetAction(it, refs) }
    }

    override fun getChildren(e: AnActionEvent?): Array<AnAction> = childrenSnapshot.toTypedArray()
}

/**
 * 子菜单项：一个可投递工作区目标。
 * [refs] 全目标共用（文件引用与目标工作区无关），update 时点一次性解析。
 */
private class SendToWorkspaceTargetAction(
    private val target: WorkspaceSendTargets.Target,
    private val refs: List<String>,
) : AnAction() {

    init {
        // 当前项语义前置：「（当前）」后缀会被误读成「当前项目」；「当前标签（目录名）」
        // 把目标语义放前面，目录名退为补充；其余工作区恒新开，文案对称「新开标签（目录名）」
        templatePresentation.text =
            if (target.isCurrent) message("action.sendToWorkspace.currentTab", target.displayName)
            else message("action.sendToWorkspace.newTab", target.displayName)
        templatePresentation.description = target.workspacePath
        templatePresentation.icon = ZCodeIcons.ZcGui
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        if (target.isCurrent) {
            // 当前标签通道 = 既有平铺行为原样（推激活面板）
            pushRefs(project, refs)
            return
        }
        ZCodeToolWindowFactory.sendToWorkspaceTab(project, target.workspacePath, refs)
    }
}

/** 两 action 共用的文件解析（缺陷 BR 口径：数组优先、单数兜底，不要求 EDITOR 语境） */
internal fun resolveMenuVirtualFiles(e: AnActionEvent): List<VirtualFile> {
    e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY)?.let { return it.toList() }
    return e.getData(CommonDataKeys.VIRTUAL_FILE)?.let { listOf(it) } ?: emptyList()
}

/**
 * 引用构造：编辑器语境有选区 → 行号引用（SendSelectionToInputAction 同构）；
 * 否则整文件引用（目录补尾斜杠）。空文件表返回空表。
 */
internal fun buildMenuRefs(e: AnActionEvent, files: List<VirtualFile>): List<String> {
    if (files.isEmpty()) return emptyList()
    val editor = e.getData(CommonDataKeys.EDITOR)
    if (editor?.selectionModel?.hasSelection() == true) {
        val file = FileDocumentManager.getInstance().getFile(editor.document) ?: files.first()
        return listOf(
            buildLineReference(file, editor.document, editor.selectionModel.selectionStart, editor.selectionModel.selectionEnd)
        )
    }
    return FileRefs.toRefs(files)
}

/**
 * 两 action 共用的目标计算：无激活面板（工具窗未初始化/全关的瞬态）返回空表——
 * 当前标签通道无从判定，调用方（组）隐藏、平铺项保持现状。
 */
internal fun computeWorkspaceSendTargets(project: Project, files: List<VirtualFile>): List<WorkspaceSendTargets.Target> {
    if (files.isEmpty()) return emptyList()
    val panel = project.zCodeService().getActivePanel() ?: return emptyList()
    return WorkspaceSendTargets.compute(
        filePaths = files.map { it.path },
        basePath = project.basePath,
        projectDisplayName = project.name,
        linkedWorkspaces = ZCodeLinkedWorkspaces.readActive(project),
        currentWorkspace = panel.getTargetingWorkspacePath(),
    )
}
