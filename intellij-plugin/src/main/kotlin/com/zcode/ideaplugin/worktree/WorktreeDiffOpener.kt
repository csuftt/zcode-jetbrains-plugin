package com.zcode.ideaplugin.worktree

import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffDialogHints
import com.intellij.diff.DiffManager
import com.intellij.diff.chains.SimpleDiffRequestChain
import com.intellij.diff.contents.DiffContent
import com.intellij.diff.editor.ChainDiffVirtualFile
import com.intellij.diff.editor.DiffEditorTabFilesManager
import com.intellij.diff.editor.SimpleDiffVirtualFile
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileTypes.FileType
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.zcode.ideaplugin.ZCodeBundle
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 起点变更的 diff 打开器（2026-11-14 树内展开定案，取代 WorktreeChangesDialog）。
 *
 * ProjectView 树内双击提交行/未提交文件行 → 后台拉 blob → 平台**编辑器标签页** diff
 * （与主界面/平台 VCS 的「看 diff」一致；用户关闭「编辑器内 diff」设置时退回浮窗）。
 * 全部数据走 [GitWorktreeCli] 纯 git 命令（`cat-file blob`），不依赖 git4idea。
 */
object WorktreeDiffOpener {

    private val busy = AtomicBoolean(false)

    /**
     * 文件行双击：单文件 diff（编辑器 tab）。commit 上下文决定旧侧——
     * 提交内 = 父提交 → 该提交；null（未提交组）= HEAD → 工作区磁盘内容。
     */
    fun openFileDiff(
        project: Project,
        entry: WorktreeProjectState.Entry,
        f: GitWorktreeCli.FileChange,
        commit: GitWorktreeCli.CommitChange?,
    ) {
        openAsync(project, f.path.substringAfterLast('/')) {
            if (commit == null) {
                val head = fetchHead(project, entry) ?: return@openAsync emptyList()
                val disk = entry.root.resolve(f.path)
                listOfNotNull(
                    buildRequest(
                        project = project,
                        path = f.path,
                        oldBytes = if (f.status == 'A') null else fetchBlob(project, entry, "$head:${f.oldPath ?: f.path}"),
                        newBytes = if (Files.exists(disk)) Files.readAllBytes(disk) else null,
                        leftLabel = ZCodeBundle.message("worktree.changes.diff.before.head", head.take(7)),
                        rightLabel = ZCodeBundle.message("worktree.changes.diff.after.worktree"),
                    ),
                )
            } else {
                val parent = commit.parentSha
                listOfNotNull(
                    buildRequest(
                        project = project,
                        path = f.path,
                        oldBytes = parent?.let { fetchBlob(project, entry, "$it:${f.oldPath ?: f.path}") },
                        newBytes = fetchBlob(project, entry, "${commit.sha}:${f.path}"),
                        leftLabel = ZCodeBundle.message("worktree.changes.diff.before.parent", parent?.take(7) ?: ""),
                        rightLabel = ZCodeBundle.message("worktree.changes.diff.after.commit", commit.sha.take(7)),
                    ),
                )
            }
        }
    }

    // ============ 内部 ============

    private fun cli(project: Project): GitWorktreeCli =
        GitWorktreeCli(gitExe = WorktreeGits.executablePath(project), timeoutMs = 30_000L)

    private fun fetchBlob(project: Project, entry: WorktreeProjectState.Entry, revPath: String): ByteArray? =
        runCatching { cli(project).blobBytes(entry.root, revPath) }.getOrNull()

    private fun fetchHead(project: Project, entry: WorktreeProjectState.Entry): String? =
        entry.changes?.headSha ?: runCatching { cli(project).headSha(entry.root) }.getOrNull()

    /** 防重入（双击连点）：后台拉 blob 期间忽略新请求；完成后 EDT 打开 */
    private fun openAsync(project: Project, tabName: String, task: () -> List<SimpleDiffRequest>) {
        if (!busy.compareAndSet(false, true)) return
        ApplicationManager.getApplication().executeOnPooledThread {
            val requests = runCatching { task() }.getOrDefault(emptyList())
            ApplicationManager.getApplication().invokeLater {
                busy.set(false)
                if (project.isDisposed) return@invokeLater
                openInEditor(project, tabName, requests)
            }
        }
    }

    /**
     * 与主界面「看 diff」动作一致：diff 打开在**编辑器标签页**（Simple/ChainDiffVirtualFile
     * + [FileEditorManager.openFile]——2023.3 的 DefaultDiffTabFilesManager.showDiffFile
     * 内部就是它（javap 实锤 requestFocus 恒 true），直用底层稳定 API，绕开
     * `DiffEditorTabFilesManager.Companion.isDiffInEditor()` 的跨版本漂移
     * （2026.2 NoSuchMethodError 真机坑）；该设置改反射容错读取。任何失败退
     * [DiffManager] 浮窗，两种都吃 [SimpleDiffRequest] 的二进制/编码处理。
     * 必须已在 EDT（调用方 invokeLater）。
     */
    private fun openInEditor(project: Project, tabName: String, requests: List<SimpleDiffRequest>) {
        if (requests.isEmpty()) {
            Messages.showInfoMessage(
                project,
                ZCodeBundle.message("worktree.changes.diff.failed"),
                ZCodeBundle.message("worktree.changes.diff.failed.title"),
            )
            return
        }
        val file = if (requests.size == 1) {
            SimpleDiffVirtualFile(requests[0])
        } else {
            ChainDiffVirtualFile(SimpleDiffRequestChain(requests), tabName)
        }
        try {
            if (editorDiffSettingOn()) {
                FileEditorManager.getInstance(project).openFile(file, true)
            } else {
                showFloating(project, requests)
            }
        } catch (_: Throwable) {
            // 跨版本平台差异兜底：编辑器 tab 打不开（API 漂移/异常）退浮窗
            showFloating(project, requests)
        }
    }

    /** 用户关闭「编辑器内 diff」设置时退浮窗；API 漂移（新版平台移走该方法）则默认开 */
    private fun editorDiffSettingOn(): Boolean = runCatching {
        val companion = DiffEditorTabFilesManager.Companion
        companion.javaClass.getMethod("isDiffInEditor").invoke(companion) as? Boolean
    }.getOrNull() ?: true

    private fun showFloating(project: Project, requests: List<SimpleDiffRequest>) {
        if (requests.size == 1) {
            DiffManager.getInstance().showDiff(project, requests[0])
        } else {
            DiffManager.getInstance().showDiff(project, SimpleDiffRequestChain(requests), DiffDialogHints.DEFAULT)
        }
    }

    private fun buildRequest(
        project: Project,
        path: String,
        oldBytes: ByteArray?,
        newBytes: ByteArray?,
        leftLabel: String,
        rightLabel: String,
    ): SimpleDiffRequest? {
        if (oldBytes == null && newBytes == null) return null
        val factory = DiffContentFactory.getInstance()
        val fileName = path.substringAfterLast('/')
        val fileType = FileTypeManager.getInstance().getFileTypeByFileName(fileName)
        return SimpleDiffRequest(
            ZCodeBundle.message("worktree.changes.diff.title", fileName),
            toContent(factory, project, oldBytes, fileType, fileName),
            toContent(factory, project, newBytes, fileType, fileName),
            leftLabel, rightLabel,
        )
    }

    /**
     * 内容构造：[DiffContentFactory.createFromBytes] 自动处理编码与二进制检测；
     * null = 文件不存在（A 状态旧侧 / D 状态新侧）→ 空内容
     */
    private fun toContent(
        factory: DiffContentFactory,
        project: Project,
        bytes: ByteArray?,
        fileType: FileType,
        fileName: String,
    ): DiffContent {
        if (bytes == null) return factory.create(project, "", fileType)
        return try {
            factory.createFromBytes(project, bytes, fileType, fileName)
        } catch (_: Exception) {
            factory.create(project, "", fileType)
        }
    }
}
