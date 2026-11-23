package com.zcode.ideaplugin.kb

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.vcs.VcsDataKeys
import com.intellij.openapi.vfs.VirtualFile
import com.zcode.ideaplugin.ZCodeBundle
import com.zcode.ideaplugin.ZCodeIcons
import com.zcode.kb.core.KbExtractor
import java.nio.file.Path

/**
 * 右键「加入知识库」（issue#54）：项目视图/编辑器 tab/变更视图，多选支持。
 * 弹窗确认（预填启发式推断）→ 后台收录 → 气泡回执。
 */
class KbAddFilesAction : AnAction(
    ZCodeBundle.message("kb.action.add.text"),
    ZCodeBundle.message("kb.action.add.description"),
    ZCodeIcons.ZcGui, // 品牌图标（与「发送到 ZC GUI 输入框」同视觉位，真机反馈补上）
) {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        // 开关关闭：菜单项实时移除（缺陷HW-2）
        if (!KbFeature.isEnabled()) {
            e.presentation.isVisible = false
            return
        }
        val files = resolveMenuVirtualFiles(e)
        // 名字层面快筛（黑名单外全放行，isSupported 已是「待嗅探」语义），不读内容——
        // update 跑在 BGT，读头 IO 会卡菜单弹出；嗅探延迟到 actionPerformed
        val supported = files.filter { it.isValid && !it.isDirectory && KbExtractor.isSupported(it.name) }
        e.presentation.isVisible = supported.isNotEmpty()
        e.presentation.isEnabled = supported.isNotEmpty()
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val candidates = resolveMenuVirtualFiles(e)
            .filter { it.isValid && !it.isDirectory }
            .map { Path.of(it.path) }
        // 完整判据（黑名单快拒 + 白名单 + 头部嗅探）；被拒文件统一跳过通知，静默 filter 是排查黑洞
        val (files, skipped) = KbIngestHelper.partitionIngestable(candidates)
        KbIngestHelper.notifySkipped(project, skipped)
        if (files.isEmpty()) return
        val service = KbManagerService.instance
        val folderOptions = service.folders().map { f ->
            KbIngestDialog.FolderOption(f.id, service.folderPath(f.id), f.name)
        }
        val dialog = KbIngestDialog(
            files,
            folderOptions,
            project = project,
        )
        if (!dialog.showAndGet()) return
        val title = dialog.titleValue
        val folderId = if (dialog.folderValue.isNotEmpty()) dialog.folderValue
        else service.ensureFolderPath(dialog.folderPathValue)
        val tags = dialog.tagsValue
        val notes = dialog.notesValue
        ApplicationManager.getApplication().executeOnPooledThread {
            var ok = 0
            var fail = 0
            for (vf in files) {
                try {
                    val perFileTitle = if (files.size == 1) title else vf.fileName.toString().substringBeforeLast('.')
                    if (service.ingest(vf, perFileTitle, folderId, tags, notes, project) != null) ok++ else fail++
                } catch (ex: Exception) {
                    fail++
                }
            }
            ApplicationManager.getApplication().invokeLater {
                notify(
                    project,
                    if (fail == 0) NotificationType.INFORMATION else NotificationType.WARNING,
                    if (fail == 0) {
                        ZCodeBundle.message("kb.notify.ingested", ok)
                    } else {
                        ZCodeBundle.message("kb.notify.ingestedWithFail", ok, fail)
                    },
                )
            }
        }
    }

    private fun notify(project: com.intellij.openapi.project.Project, type: NotificationType, text: String) {
        NotificationGroupManager.getInstance().getNotificationGroup("ZCode")
            .createNotification(ZCodeBundle.message("kb.notify.groupTitle"), text, type)
            .notify(project)
    }

    companion object {
        /** 选中文件解析三级降级（SendFileToWorkspaceGroupAction.resolveMenuVirtualFiles 同款）。 */
        internal fun resolveMenuVirtualFiles(e: AnActionEvent): List<VirtualFile> {
            e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY)?.let { return it.toList() }
            e.getData(CommonDataKeys.VIRTUAL_FILE)?.let { return listOf(it) }
            return e.getData(VcsDataKeys.CHANGES)?.mapNotNull { it.virtualFile } ?: emptyList()
        }
    }
}

/**
 * 「加入 ZC GUI 知识库」右键入口组（缺陷HW续：用户要求与上方「发送到 ZC GUI 输入框」
 * 之间画分隔线——平台 popup 组边界不自动画线，用组内首项前 addSeparator 显式画出）。
 * 子项全隐藏时组自身也不显示（update 守卫仍由 KbAddFilesAction 承担）。
 * 组带文案（取子动作的那两条键）：平台建动作树（Search Everywhere / 键位映射）时读的是模板展示，
 * 没文案会报 WARN 并把这个组显示成 action id；右键菜单里非弹出组只渲染子项，文案不露面。
 */
class KbAddFilesGroup : DefaultActionGroup() {
    init {
        templatePresentation.setText(ZCodeBundle.message("kb.action.add.text"))
        templatePresentation.setDescription(ZCodeBundle.message("kb.action.add.description"))
        addSeparator()
        add(KbAddFilesAction())
    }
}

/**
 * 会话中「拖文件进知识库 ToolWindow」的收录入口（面板 DnD 调用同一 ingest 流程）。
 * 独立 object 仅作进程内复用点（不注册 action）。
 */
internal object KbIngestHelper {

    fun supportedFile(path: Path): Boolean = KbExtractor.isSupportedFile(path)

    /** 右键/DnD/文件选择器共用的收录前置分流：完整判据（黑名单快拒 + 白名单 + 头部嗅探），返回（可收录, 被拒） */
    fun partitionIngestable(paths: List<Path>): Pair<List<Path>, List<Path>> =
        paths.partition { supportedFile(it) }

    /** 被拒文件统一跳过通知（Q8）：静默 filter 是排查黑洞；内部包 EDT（DnD drop 线程不定） */
    fun notifySkipped(project: com.intellij.openapi.project.Project, skipped: List<Path>) {
        if (skipped.isEmpty()) return
        val shown = skipped.take(5).joinToString("、") { it.fileName.toString() } +
            if (skipped.size > 5) "…" else ""
        val text = ZCodeBundle.message("kb.notify.skippedBinary", skipped.size, shown)
        ApplicationManager.getApplication().invokeLater {
            NotificationGroupManager.getInstance().getNotificationGroup("ZCode")
                .createNotification(ZCodeBundle.message("kb.notify.groupTitle"), text, NotificationType.WARNING)
                .notify(project)
        }
    }
}
