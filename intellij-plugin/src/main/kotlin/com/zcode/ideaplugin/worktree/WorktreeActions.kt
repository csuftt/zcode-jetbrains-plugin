package com.zcode.ideaplugin.worktree

import com.intellij.ide.projectView.ProjectView
import com.intellij.notification.NotificationGroupManager
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.zcode.ideaplugin.ZCodeBundle
import com.zcode.ideaplugin.ZCodeIcons
import com.zcode.ideaplugin.zCodeService
import java.awt.datatransfer.StringSelection
import java.nio.file.Files
import java.nio.file.Path

/**
 * ZCGUIWorktrees 右键动作（0.4.6）：打开（新窗口）/ 复制路径 / 删除（守卫链）/ 清理记录。
 *
 * 数据来源（四轮置灰修复，2026-11-13）：① provider getData 供应的选中条目；
 * ② 当前视图树直读选区（update 已在 EDT）。**关键坑**：IntelliJ 树（AbstractTreeUi）
 * 的选区元素是 `DefaultMutableTreeNode`，自定义节点包在 `userObject` 里——前三轮
 * 直接 cast `lastPathComponent` 恒为 null，换任何数据源都灰；这里双形态兼容
 * （包裹/裸节点）。③ VIRTUAL_FILE 兜底。
 * 选区存在但识别失败时打诊断日志（idea.log 搜 [WorktreeActions]），不再盲猜。
 * 「在终端打开」deferred：需 terminal 插件依赖与 API 验证，0.4.7 候选。
 */
private fun selectedEntries(e: AnActionEvent): List<WorktreeProjectState.Entry> {
    // ① provider getData 通路（树构建方供应）
    (e.dataContext.getData(WorktreeDataKeys.SELECTED_ENTRIES) as? List<WorktreeProjectState.Entry>)?.let { return it }
    val project = e.project ?: return emptyList()
    // ② 当前视图树直读选中节点：DefaultMutableTreeNode.userObject 解包 + 裸节点兼容
    val tree = runCatching {
        com.intellij.ide.projectView.ProjectView.getInstance(project).currentProjectViewPane?.tree
    }.getOrNull()
    val picked = tree?.selectionPaths
        ?.mapNotNull { p ->
            when (val c = p.lastPathComponent) {
                is javax.swing.tree.DefaultMutableTreeNode -> c.userObject
                else -> c
            }
        }
        ?: emptyList()
    val leaf = picked.filterIsInstance<WorktreeEntryNode>().map { it.entry }
    if (leaf.isNotEmpty()) return leaf
    // 容器节点（ZCGUIWorktrees 根/源目录分组）不展开成条目——分组级不出现 worktree 动作
    // 菜单（2026-11-15 反馈：分组级「复制/删除」有歧义，动作只对具体副本有意义）
    // 诊断：有选区但一条都没识别成自家节点 → 打印实际类型（还置灰时看 idea.log 即可定位）。
    // 自家容器/下层节点（分组、提交行/文件行）本就不在 worktree 菜单范围，属正常情况不告警
    // （2026-11-14 真机：选中文件行时四个 action 各打一条 WARN）
    if (picked.isNotEmpty() && picked.none {
            it is WorktreeCommitNode || it is WorktreeFileNode ||
                it is WorktreesRootNode || it is WorktreeSourceGroupNode
        }
    ) {
        com.intellij.openapi.diagnostic.Logger.getInstance("WorktreeActions")
            .warn("selection not recognized: ${picked.joinToString { it.javaClass.name }}")
    }
    // ③ VIRTUAL_FILE 兜底
    val vf = e.getData(com.intellij.openapi.actionSystem.CommonDataKeys.VIRTUAL_FILE) ?: return emptyList()
    val state = WorktreeProjectState.getInstance(project)
    val root = Path.of(vf.path)
    return state.groups.flatMap { it.entries }.filter { samePath(it.root, root) }
}

private fun samePath(a: Path, b: Path): Boolean {
    val an = a.normalize().toString()
    val bn = b.normalize().toString()
    val win = System.getProperty("os.name").lowercase().contains("windows")
    return if (win) an.equals(bn, ignoreCase = true) else an == bn
}

private fun refreshProjectView(project: Project) {
    // 重建快照 + 刷树（refreshAsync 完成后自带 ProjectView refresh）；
    // 只刷树不重建快照 = 已删条目残留（2026-11-13 真机）
    WorktreeProjectState.getInstance(project).refreshAsync()
}

private fun notify(project: Project, text: String) {
    NotificationGroupManager.getInstance()
        .getNotificationGroup("ZCode")
        .createNotification(text, com.intellij.notification.NotificationType.INFORMATION)
        .notify(project)
}

/**
 * 新建会话（2026-11-14 反馈；2026-11-15 改懒创建）：在工具窗为该 worktree 开一个
 * 「新会话」待命标签，发出首条消息时才真正建会话（用户定案：会话应到首条消息才落库）。
 *
 * 两轴分家口径（同 handleCreateWorktreeSession）：会话 Workspace=worktree 执行根（AI
 * 在副本里干活），标签落位=源工作区（历史列表/chip/色块按归属语义）。副本规格由面板
 * 持有（pendingWorktree），首条消息的 createSession 在面板拦截——直接在既有副本目录
 * 建会话（不建新副本）+ 注册表登记（删除守卫 runningSessions 由此看得到会话）。
 * 标签标题天然「新会话」；未发消息就关掉 = 零残留，不再产生孤儿空会话。
 */
class WorktreeNewSessionAction : AnAction(ZCodeBundle.message("worktree.menu.newSession"), null, ZCodeIcons.ZcGui) {
    override fun update(e: AnActionEvent) {
        val items = selectedEntries(e)
        e.presentation.isVisible = items.isNotEmpty()
        e.presentation.isEnabled = items.size == 1 && Files.isDirectory(items[0].root)
    }

    override fun actionPerformed(e: AnActionEvent) {
        val entry = selectedEntries(e).firstOrNull() ?: return
        val project = e.project ?: return
        // 只开待命标签零 RPC，EDT 直调。起点沿用节点快照：注册表 startSha 优先，桌面端
        // 副本退 reflog 首条（inferredBaseSha，创建时刻历史事实）。都缺留空（chip 不显示
        // 起点），绝不拿当前 headSha 冒充——headSha 兜底会把该条目登记成「起点=现在」，此后
        // log startSha..HEAD 恒空、变更计数清零（spec #52 追评：不拿推算值凑数）
        val startSha = entry.startSha?.takeIf { it.isNotEmpty() }
            ?: entry.inferredBaseSha?.takeIf { it.isNotEmpty() }
            ?: ""
        com.zcode.ideaplugin.ui.ZCodeToolWindowFactory.openPendingWorktreeTab(
            project,
            WorktreeRegistryStore.WorktreeSessionInfo(
                sessionId = "", // 懒创建：此刻尚无会话，首条消息时才存在
                worktreeRoot = entry.root.toString(),
                cwd = entry.root.toString(),
                sourceWorkspace = entry.sourceDir.toString(),
                startRef = entry.startRef?.takeIf { it.isNotBlank() }
                    ?: if (startSha.isNotEmpty()) "HEAD" else "",
                startSha = startSha,
                bucket = entry.bucket,
                createdAt = System.currentTimeMillis(),
            ),
        )
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT
}

class WorktreeOpenAction : AnAction(ZCodeBundle.message("worktree.menu.open"), null, ZCodeIcons.ZcGui) {
    override fun update(e: AnActionEvent) {
        val items = selectedEntries(e)
        // 非自家节点（普通目录/根容器）整项隐藏，不做灰项占位（2026-11-13 日志实锤污染）
        e.presentation.isVisible = items.isNotEmpty()
        e.presentation.isEnabled = items.size == 1 && Files.isDirectory(items[0].root)
    }

    override fun actionPerformed(e: AnActionEvent) {
        val entry = selectedEntries(e).firstOrNull() ?: return
        val project = e.project ?: return
        runCatching { com.intellij.ide.impl.ProjectUtil.openOrImport(entry.root, project, true) }
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT
}

/** 在系统文件管理器打开副本目录（2026-11-14 反馈）：Desktop.open，目录即资源管理器/Finder */
class WorktreeRevealAction : AnAction(ZCodeBundle.message("worktree.menu.explorer"), null, ZCodeIcons.ZcGui) {
    override fun update(e: AnActionEvent) {
        val items = selectedEntries(e)
        e.presentation.isVisible = items.isNotEmpty()
        e.presentation.isEnabled = items.size == 1 && Files.isDirectory(items[0].root)
    }

    override fun actionPerformed(e: AnActionEvent) {
        val entry = selectedEntries(e).firstOrNull() ?: return
        val project = e.project ?: return
        runCatching { java.awt.Desktop.getDesktop().open(entry.root.toFile()) }
            .onFailure { notify(project, ZCodeBundle.message("worktree.explorer.failed", it.message ?: "")) }
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT
}

/**
 * 发送到 ZCGUI（2026-11-16 反馈：复制路径对 AI 协作无意义，资源管理器入口已有）：
 * 组装结构化上下文文案插进当前激活会话输入框（用户补充诉求后自己发，绝不直接发——
 * 合并等大动作必须用户确认细节）。文案带 AI 干活所需的全部要素：副本目录/源仓库/
 * 相对起点变更统计（快照现成，AI 免探索），光标落在诉求占位行后。
 * 目标=当前激活标签（pushTextToInput 全局路由）；无激活标签时前端输入框侧自行处理。
 * 单选语义（多副本上下文混在一条消息里 AI 分不清主次），多选置灰。
 */
class WorktreeSendToGuiAction : AnAction(
    ZCodeBundle.message("worktree.menu.send"), null, ZCodeIcons.ZcGui,
) {

    override fun update(e: AnActionEvent) {
        val items = selectedEntries(e)
        e.presentation.isVisible = items.isNotEmpty()
        e.presentation.isEnabled = items.size == 1
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val entry = selectedEntries(e).firstOrNull() ?: return
        com.zcode.ideaplugin.action.pushTextToInput(project, buildSendText(entry))
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT

    /** 结构化上下文（AskUserQuestion 拍板形态）；start/变更统计与树节点展示同源 */
    private fun buildSendText(entry: WorktreeProjectState.Entry): String {
        val refName = entry.startRef?.takeIf { it.isNotEmpty() && it != "HEAD" }
            ?: entry.branchName
            ?: entry.startRef?.takeIf { it.isNotEmpty() }
        val start = buildString {
            if (!refName.isNullOrEmpty()) append(refName)
            entry.startSha?.takeIf { it.isNotEmpty() }?.let {
                if (isNotEmpty()) append('@')
                append(it.take(7))
            }
        }.takeIf { it.isNotEmpty() }
            // 桌面端 detached 副本注册表无记录：与树节点同源回退 reflog 推断起点（2026-11-16）
            ?: entry.inferredBaseSha?.takeIf { it.isNotEmpty() }?.let { it.take(7) }
        val header = if (start != null) {
            ZCodeBundle.message("worktree.send.header", entry.bucket, start)
        } else {
            ZCodeBundle.message("worktree.send.headerNoBase", entry.bucket)
        }
        val changes = entry.changes
        val changesBody = if (changes == null || (changes.commits.isEmpty() && changes.uncommitted.isEmpty())) {
            ZCodeBundle.message("worktree.send.noChanges")
        } else {
            buildList {
                if (changes.commits.isNotEmpty()) {
                    add(ZCodeBundle.message("worktree.changes.node.commits", changes.commits.size))
                }
                if (changes.uncommitted.isNotEmpty()) {
                    add(ZCodeBundle.message("worktree.changes.node.uncommitted", changes.uncommitted.size))
                }
            }.joinToString(" · ")
        }
        val mergedSuffix = run {
            val commits = changes?.commits.orEmpty()
            val unmerged = entry.unmergedShas
            if (commits.isNotEmpty() && unmerged != null) {
                val merged = commits.count { it.sha !in unmerged }
                if (merged == commits.size) ZCodeBundle.message("worktree.send.mergedAll")
                else if (merged > 0) ZCodeBundle.message("worktree.send.mergedPartial", merged, commits.size)
                else ""
            } else ""
        }
        return buildString {
            appendLine(header)
            appendLine(ZCodeBundle.message("worktree.send.dir", entry.root.toString()))
            appendLine(ZCodeBundle.message("worktree.send.source", entry.sourceDir.toString()))
            appendLine(ZCodeBundle.message("worktree.send.changes", changesBody) + mergedSuffix)
            append(ZCodeBundle.message("worktree.send.ask"))
        }
    }
}

/**
 * 打开原文件（2026-11-17 反馈：文件行点/双击只有 diff，缺「直接看原文件」的入口）：
 * 变更树文件行（提交内/未提交组）右键菜单——未提交组打开副本目录里的工作文件
 * （真实可编辑）；提交内打开该提交时刻的快照（内存只读 LightVirtualFile，标签名带
 * 提交短 hash 标识历史版本）。D 状态置灰：未提交 D=磁盘已无此文件，提交内 D=该提交
 * 删的（blob 在该提交树上不存在）。
 *
 * 选区解析走 SELECTED_ITEMS（WorktreeOpenSessionsGroup 同款双路兜底）：文件行不是
 * EntryNode，provider 的 SELECTED_ENTRIES 不供给；自定义 DataKey 在 BGT update 下
 * 会整项消失（2026-11-16 实锤），SELECTED_ITEMS pane 直接应答两线程都稳。
 */
class WorktreeOpenFileAction : AnAction(ZCodeBundle.message("worktree.file.open"), null, ZCodeIcons.ZcGui) {

    private fun selectedFileNodes(e: AnActionEvent): List<WorktreeFileNode> {
        // ① SELECTED_ITEMS（pane 快照应答，EDT/BGT 均可靠）
        e.dataContext.getData(com.intellij.openapi.actionSystem.PlatformCoreDataKeys.SELECTED_ITEMS)
            ?.filterIsInstance<WorktreeFileNode>()?.takeIf { it.isNotEmpty() }?.let { return it }
        val project = e.project ?: return emptyList()
        // ② 当前视图树直读：DefaultMutableTreeNode.userObject 解包（selectedEntries 同款）
        return runCatching {
            com.intellij.ide.projectView.ProjectView.getInstance(project).currentProjectViewPane?.tree
                ?.selectionPaths
                ?.mapNotNull { p -> (p.lastPathComponent as? javax.swing.tree.DefaultMutableTreeNode)?.userObject }
                ?.filterIsInstance<WorktreeFileNode>()
                ?: emptyList()
        }.getOrDefault(emptyList())
    }

    override fun update(e: AnActionEvent) {
        val nodes = selectedFileNodes(e)
        e.presentation.isVisible = nodes.isNotEmpty()
        e.presentation.isEnabled = nodes.all { it.file.status != 'D' }
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val nodes = selectedFileNodes(e)
        if (nodes.isEmpty()) return
        val app = com.intellij.openapi.application.ApplicationManager.getApplication()
        // blob 拉取/磁盘 VFS 刷新放后台，EDT 只做打开（WorktreeDiffOpener 同款节奏）
        app.executeOnPooledThread {
            val failures = mutableListOf<String>()
            val binaries = mutableListOf<String>()
            val opened = mutableListOf<com.intellij.openapi.vfs.VirtualFile>()
            for (node in nodes) {
                val ioFile = node.entry.root.resolve(node.file.path).toFile()
                if (node.commit == null) {
                    val vf = runCatching {
                        com.intellij.openapi.vfs.LocalFileSystem.getInstance().refreshAndFindFileByIoFile(ioFile)
                    }.getOrNull()
                    if (vf == null) failures += node.file.path else opened += vf
                } else {
                    val bytes = runCatching {
                        GitWorktreeCli(gitExe = WorktreeGits.executablePath(project), timeoutMs = 30_000L)
                            .blobBytes(node.entry.root, "${node.commit.sha}:${node.file.path}")
                    }.getOrNull()
                    if (bytes == null) {
                        failures += node.file.path
                        continue
                    }
                    // 内容通道：LightVirtualFile 全 CharSequence 化（233 javap 实锤，无 byte[] 构造），
                    // 编码检测复用 DiffContentFactory.createFromBytes（diff 视图同款，UTF-8/GBK 自动识别），
                    // 文本取解码后的 document.text；二进制快照不硬塞文本编辑器，单独提示
                    val fileName = node.file.path.substringAfterLast('/')
                    val content = runCatching {
                        com.intellij.diff.DiffContentFactory.getInstance().createFromBytes(
                            project, bytes,
                            com.intellij.openapi.fileTypes.FileTypeManager.getInstance().getFileTypeByFileName(fileName),
                            fileName,
                        )
                    }.getOrNull()
                    val text = (content as? com.intellij.diff.contents.DocumentContent)?.document?.text
                    if (text == null) {
                        binaries += node.file.path
                    } else {
                        opened += com.intellij.testFramework.LightVirtualFile(
                            "$fileName @ ${node.commit.sha.take(7)}",
                            com.intellij.openapi.fileTypes.FileTypeManager.getInstance().getFileTypeByFileName(fileName),
                            text,
                        ).apply { setWritable(false) }
                    }
                }
            }
            app.invokeLater {
                if (project.isDisposed) return@invokeLater
                val fem = com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project)
                for (vf in opened) {
                    runCatching { fem.openFile(vf, true) }
                }
                if (failures.isNotEmpty()) {
                    notify(project, ZCodeBundle.message("worktree.file.openFailed", failures.joinToString("、")))
                }
                if (binaries.isNotEmpty()) {
                    notify(project, ZCodeBundle.message("worktree.file.binary", binaries.joinToString("、")))
                }
            }
        }
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT
}

class WorktreeDeleteAction : AnAction(ZCodeBundle.message("worktree.menu.delete"), null, ZCodeIcons.ZcGui) {
    override fun update(e: AnActionEvent) {
        val items = selectedEntries(e)
        e.presentation.isVisible = items.isNotEmpty()
        e.presentation.isEnabled = items.isNotEmpty()
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        // 子节点与组节点可能同时入选区（Ctrl/Shift 多选），同一 root 先归一化去重
        val entries = selectedEntries(e).distinctBy { WorktreeRegistry.normalize(it.root.toString()) }
        if (entries.isEmpty()) return
        val app = com.intellij.openapi.application.ApplicationManager.getApplication()
        // 守卫巡检与删除都放后台线程：多个 worktree 的 git 巡检 + 逐个删除会长时间卡 EDT；
        // delete() 内部 closeProjectsUnder 走 invokeAndWait，本就要求非 EDT 调用方
        app.executeOnPooledThread {
            val lifecycle = WorktreeLifecycle(project)
            val guarded = entries.map { entry ->
                val using = lifecycle.sessionsUsing(entry.root.toString())
                entry to lifecycle.inspect(entry.root, using, entry.startRef)
            }
            val blocked = guarded.filter { it.second.runningSessions.isNotEmpty() }
            val targets = guarded.filter { it.second.runningSessions.isEmpty() }
            app.invokeLater {
                if (project.isDisposed) return@invokeLater
                if (targets.isEmpty()) {
                    val msg = if (blocked.size == 1) ZCodeBundle.message("worktree.delete.running")
                    else ZCodeBundle.message("worktree.delete.multi.skipRunning", names(blocked.map { it.first }))
                    Messages.showErrorDialog(project, msg, ZCodeBundle.message("worktree.menu.delete"))
                    return@invokeLater
                }
                val answer = Messages.showYesNoDialog(
                    project,
                    confirmBody(targets, blocked),
                    confirmTitle(targets, blocked),
                    Messages.getWarningIcon(),
                )
                if (answer != Messages.YES) return@invokeLater
                app.executeOnPooledThread {
                    val removed = mutableListOf<WorktreeProjectState.Entry>()
                    val leftEmpty = mutableListOf<Path>()
                    val failed = mutableListOf<WorktreeProjectState.Entry>()
                    for ((entry, guard) in targets) {
                        // 单个失败不拦批：继续删余下，最后汇总通知
                        runCatching { lifecycle.delete(entry.root, entry.sourceDir, guard.dirty == true) }
                            .onSuccess { outcome ->
                                // Path 实现了 Iterable<Path>，+= 会二义解析成集合相加，这里必须显式 add
                                if (outcome == WorktreeLifecycle.DeleteOutcome.DIR_LEFT) leftEmpty.add(entry.root) else removed.add(entry)
                                // 乐观移除（2026-11-14 反馈：全量 rebuild 带变更查询十几秒，
                                // 树迟迟不移除）——每删一个立即摘节点，全量 rebuild 收尾校准。
                                // DIR_LEFT 同摘（2026-11-17 删除慢排查）：prune 已清 git 记录，
                                // rebuild 后节点本就不复存在，不必陪跑十几秒
                                app.invokeLater {
                                    if (!project.isDisposed) {
                                        WorktreeProjectState.getInstance(project).removeEntry(entry.root.toString())
                                    }
                                }
                            }
                            .onFailure { failed += entry }
                    }
                    app.invokeLater {
                        if (project.isDisposed) return@invokeLater
                        notify(project, resultText(removed.size, leftEmpty, failed))
                        refreshProjectView(project)
                    }
                }
            }
        }
    }

    /** 名单展示：超过 8 个截断为「xxx、yyy …等共 N 个」 */
    private fun names(entries: List<WorktreeProjectState.Entry>): String {
        val all = entries.map { it.name }
        return if (all.size <= 8) all.joinToString("、")
        else all.take(8).joinToString("、") + ZCodeBundle.message("worktree.delete.multi.more", all.size)
    }

    private fun confirmTitle(targets: List<Pair<WorktreeProjectState.Entry, WorktreeLifecycle.Guard>>, blocked: List<Pair<WorktreeProjectState.Entry, WorktreeLifecycle.Guard>>): String =
        if (blocked.isEmpty() && targets.size == 1) ZCodeBundle.message("worktree.delete.title", targets[0].first.name)
        else ZCodeBundle.message("worktree.delete.multi.title", targets.size)

    private fun confirmBody(targets: List<Pair<WorktreeProjectState.Entry, WorktreeLifecycle.Guard>>, blocked: List<Pair<WorktreeProjectState.Entry, WorktreeLifecycle.Guard>>): String =
        buildList {
            add(ZCodeBundle.message("worktree.delete.body"))
            if (blocked.isEmpty() && targets.size == 1) {
                // 单选：保留原有逐条提醒形态
                val guard = targets[0].second
                if ((guard.unmerged ?: 0) > 0) add(ZCodeBundle.message("worktree.delete.unmerged", guard.unmerged!!))
                if (guard.dirty == true) add(ZCodeBundle.message("worktree.delete.dirty"))
            } else {
                add(ZCodeBundle.message("worktree.delete.multi.names", names(targets.map { it.first })))
                val unmerged = targets.count { (it.second.unmerged ?: 0) > 0 }
                if (unmerged > 0) add(ZCodeBundle.message("worktree.delete.multi.unmerged", unmerged))
                val dirty = targets.count { it.second.dirty == true }
                if (dirty > 0) add(ZCodeBundle.message("worktree.delete.multi.dirty", dirty))
            }
            if (blocked.isNotEmpty()) add(ZCodeBundle.message("worktree.delete.multi.skipRunning", names(blocked.map { it.first })))
        }.joinToString("\n")

    private fun resultText(removedCount: Int, leftEmpty: List<Path>, failed: List<WorktreeProjectState.Entry>): String =
        buildList {
            if (failed.isEmpty()) {
                // 全部只剩空目录暂留时，「已删除 0 个」反而误导，只报 leftEmpty 明细
                if (removedCount > 0) add(ZCodeBundle.message("worktree.delete.multi.done", removedCount))
            } else {
                add(ZCodeBundle.message("worktree.delete.multi.doneFailed", removedCount, failed.size, failed.joinToString("、") { it.name }))
            }
            leftEmpty.forEach { add(ZCodeBundle.message("worktree.delete.leftEmpty", it.toString())) }
        }.joinToString("\n")

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT
}

/** 清理记录：目录已缺失的孤儿条目（prune git 记录；注册表条目保留——会话不连带删除） */
class WorktreeCleanupAction : AnAction(ZCodeBundle.message("worktree.menu.cleanup"), null, ZCodeIcons.ZcGui) {
    override fun update(e: AnActionEvent) {
        val items = selectedEntries(e)
        e.presentation.isVisible = items.isNotEmpty()
        e.presentation.isEnabled = items.isNotEmpty() && items.all { it.state != "ok" }
    }

    override fun actionPerformed(e: AnActionEvent) {
        val entries = selectedEntries(e)
        val project = e.project ?: return
        val cli = GitWorktreeCli(gitExe = WorktreeGits.executablePath(project), timeoutMs = 15_000L)
        val state = WorktreeProjectState.getInstance(project)
        for (entry in entries) {
            runCatching { cli.prune(entry.sourceDir) }
            // 注册表条目保留（2026-11-15 反馈：会话不连带删除，chip 灰态标记副本已删除）——
            // 清理语义=摘 git 管理区记录，树上的 ⚠ 孤儿节点随之消失
            // 乐观移除：孤儿记录即时从树消失（同删除，不等全量 rebuild）
            state.removeEntry(entry.root.toString())
        }
        notify(project, ZCodeBundle.message("worktree.cleanup.done"))
        refreshProjectView(project)
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT
}

/**
 * 打开既有会话（2026-11-16 反馈）：副本右键二级菜单——无既有会话置灰；有则列出
 * 会话名+相对时间（running 加 ●），点击新标签打开（落位=源目录，两轴分家口径）。
 * 不含已归档（archivedAt 非 null 过滤）；软删会话 store 查询天然不含。
 *
 * 数据两源 = [WorktreeLifecycle.sessionsUsing]（注册表 ∪ 任务索引，与删除守卫同款）。
 * 详情查询放 BGT update 预取（volatile 缓存），children（EDT 弹出瞬间）只读缓存——
 * update 必先于弹出执行，缓存命中率恒定，EDT 零阻塞。
 */
class WorktreeOpenSessionsGroup : DefaultActionGroup(ZCodeBundle.message("worktree.menu.openSessions"), true) {

    init {
        // 父项图标与组内其他动作同款 Z 字（2026-11-16 真机反馈：图标在父项，子项裸文字）
        templatePresentation.icon = ZCodeIcons.ZcGui
    }

    private data class SessionItem(val sessionId: String, val label: String, val sourceDir: Path)

    /** 详情预取缓存（update BGT 写，children EDT 读）；empty = 无既有会话 */
    @Volatile
    private var cached: List<SessionItem> = emptyList()

    override fun getChildren(e: AnActionEvent?): Array<AnAction> {
        val project = e?.project ?: return AnAction.EMPTY_ARRAY
        return cached.map { item ->
            // 子项裸文字（2026-11-16 真机反馈：图标只在父项，二级会话项不带）
            object : AnAction(item.label) {
                override fun actionPerformed(e: AnActionEvent) {
                    com.zcode.ideaplugin.ui.ZCodeToolWindowFactory.openSessionTab(
                        project, item.sessionId, item.sourceDir.toString(),
                    )
                }

                override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT
            }
        }.toTypedArray()
    }

    override fun update(e: AnActionEvent) {
        // 选区解析双路（2026-11-16 真机：单路自定义键在 BGT update 下整组消失——
        // SELECTED_ENTRIES 供给链 pane→provider 是 EDT-bound，后台 update 解析为 null
        // → entry==null → isVisible=false）。兜底 = SELECTED_ITEMS：pane 直接应答、
        // BGT 稳定（AbstractProjectViewPane.getData 快照），元素=树节点 user object
        // =自家 WorktreeEntryNode 实例
        val entries = e.dataContext.getData(WorktreeDataKeys.SELECTED_ENTRIES) as? List<WorktreeProjectState.Entry>
            ?: e.dataContext.getData(com.intellij.openapi.actionSystem.PlatformCoreDataKeys.SELECTED_ITEMS)
                ?.filterIsInstance<WorktreeEntryNode>()?.map { it.entry }
        val entry = entries?.firstOrNull()
        e.presentation.isVisible = entry != null
        if (entry == null || e.project == null) {
            e.presentation.isEnabled = false
            cached = emptyList()
            return
        }
        // BGT：预取详情（会话名/时间/running），并按有无结果置灰
        val items = fetch(e.project!!, entry)
        cached = items
        e.presentation.isEnabled = items.isNotEmpty()
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    private fun fetch(project: Project, entry: WorktreeProjectState.Entry): List<SessionItem> {
        val client = runCatching { project.zCodeService().getClient() }.getOrNull() ?: return emptyList()
        val ids = runCatching { WorktreeLifecycle(project).sessionsUsing(entry.root.toString()) }.getOrDefault(emptyList())
        if (ids.isEmpty()) return emptyList()
        // 归档/软删过滤与历史列表同源（任务索引 archived/deleted 位，handleListSessions
        // 同款 hiddenIds）——只查 SessionInfo.archivedAt（db.time_archived）不够：自动归档
        // 只写任务索引不回写 db（2026-11-16 真机：菜单 4 项列表 2 项，多出的两个
        // tasks.archived=1 而 db.time_archived=None，打开还是空面板）
        val hidden = runCatching {
            client.taskIndex.listTasks().filter { it.archived || it.deleted }.map { it.taskId }.toSet()
        }.getOrDefault(emptySet())
        val details = runCatching {
            client.listSessionsByIds(ids.filter { it !in hidden }, entry.sourceDir.toString(), timeoutMs = 5_000L)
        }.getOrDefault(emptyList())
        return details.asSequence()
            .filter { it.archivedAt == null && it.sessionId !in hidden }
            .sortedByDescending { it.updatedAt }
            .map { info ->
                val title = (info.title.ifBlank { info.sessionId.take(12) }).take(48)
                val run = if (info.status == "running") "● " else ""
                SessionItem(info.sessionId, "$run$title  ·  ${worktreeRelTime(info.updatedAt / 1000)}", entry.sourceDir)
            }
            .toList()
    }
}
