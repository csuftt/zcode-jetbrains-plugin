package com.zcode.ideaplugin.worktree

import com.intellij.openapi.project.Project
import com.zcode.ideaplugin.ZCodeBundle
import com.zcode.ideaplugin.zCodeService
import java.nio.file.Files
import java.nio.file.Path

/**
 * worktree 生命周期编排（删除守卫链，0.4.6 设计 §4.4）。ProjectView 右键动作调用，
 * chip 不放删除入口（防误触）。
 *
 * 守卫链：运行中会话（拒绝）→ 未合并提交提醒 → 未提交改动丢弃确认（调用方二次确认后
 * 传 force）→ 卸载会话（保留聊天记录，变只读）→ `git worktree remove [--force]`→
 * **注册表条目保留**（2026-11-15 反馈：会话不连带删除，历史列表照常显示、chip 灰态
 * 标记副本已删除）。跨端边界（ADR-0012）：桌面端建的 worktree 删除感知不到插件运行中会话。
 */
class WorktreeLifecycle(private val project: Project) {

    data class Guard(
        /** 正在使用该 worktree 且本插件侧仍在运行的会话 id（非空 → 拒绝删除） */
        val runningSessions: List<String>,
        /** 未提交改动（null = git 判定失败，按未知处理，交由调用方提示） */
        val dirty: Boolean?,
        /**
         * 未合并提交数（null = 判定失败跳过提醒）。口径与树上「已合并」标识一致
         * （2026-11-14）：有起点分支走 patch 等价（cherry-pick/rebase 落地换 sha
         * 也不误报），否则退游离口径（不被任何分支可达）。
         */
        val unmerged: Int?,
    )

    private val cli = GitWorktreeCli(gitExe = WorktreeGits.executablePath(project), timeoutMs = 30_000L)
    private val registry = WorktreeRegistry(project)

    private fun isRunning(sessionId: String): Boolean = runCatching {
        com.zcode.ideaplugin.remote.ZCodeRemoteService.getInstance().isSessionRunning(sessionId)
    }.getOrDefault(false)

    /** 使用该 worktree 的全部已知会话 id：注册表（插件自建）∪ 任务索引（桌面建，只读） */
    fun sessionsUsing(worktreeRoot: String): List<String> {
        val norm = WorktreeRegistry.normalize(worktreeRoot)
        val fromRegistry = registry.list()
            .filter { WorktreeRegistry.normalize(it.worktreeRoot) == norm }
            .map { it.sessionId }
        val fromTasks = runCatching { project.zCodeService().getClient().taskIndex.listWorktreeTasks() }
            .getOrDefault(emptyList())
            .filter { it.worktreeRoot?.let(WorktreeRegistry::normalize) == norm }
            .map { it.taskId }
        return (fromRegistry + fromTasks).distinct()
    }

    fun inspect(worktreeRoot: Path, sessionsUsing: List<String>, startRef: String? = null): Guard {
        val exists = Files.exists(worktreeRoot)
        return Guard(
            runningSessions = sessionsUsing.filter { isRunning(it) },
            dirty = if (exists) cli.isDirty(worktreeRoot) else null,
            unmerged = if (exists) unmergedCount(worktreeRoot, startRef) else null,
        )
    }

    /**
     * 未合并提交数，与树上「已合并」标识同口径（2026-11-14）：有起点分支（注册表落的
     * 创建时刻分支名）走 `git cherry` patch 等价——cherry-pick/rebase 落地换 sha 不再
     * 误报；headSha 现场重查不吃快照旧账（删除守卫宁多查一条 rev-parse）。cherry 失败
     * （起点分支已删等）或无起点分支退游离口径（不被任何分支可达）。
     */
    private fun unmergedCount(worktreeRoot: Path, startRef: String?): Int? {
        val ref = startRef?.takeIf { it.isNotBlank() && it != "HEAD" }
        val head = if (ref != null) cli.headSha(worktreeRoot) else null
        if (ref != null && head != null) {
            cli.unmergedCommitShas(worktreeRoot, ref, head)?.let { return it.size }
        }
        return cli.countUnmergedCommits(worktreeRoot)
    }

    /** 删除结果：REMOVED=目录已删净；DIR_LEFT=内容全删、空目录被占用暂留（记录已清，列表收敛） */
    enum class DeleteOutcome { REMOVED, DIR_LEFT }

    /**
     * 执行删除（守卫已由调用方过完）。卸载本插件打开的该 worktree 会话（聊天记录保留，
     * 不删库——与插件「删除会话」语义不同），git remove（force 由调用方按确认结果传）。
     * 注册表条目保留（2026-11-15 反馈：会话不连带消失，chip 灰态）。桌面端的任务索引
     * 行不动（只读边界），其会话卸载由桌面端自身处理。
     *
     * Windows 占用兜底（2026-11-13 真机：git failed to delete … Permission denied）：
     * ① 删除前先关掉以该 worktree（或其子目录）为根的 IDE 项目窗口——「打开」功能开的
     * 新窗口持有句柄，git 删不动；② git remove 仍失败 → 文件系统递归强删（清只读）+
     * prune 清 git 管理区；③ 只剩空目录（真机实证：会话进程 cwd 停在目录里，Windows 对
     * cwd 目录拒删）→ 视为删除成功，记录照清、列表收敛，通知空目录暂留可手删；
     * ④ 还有文件删不掉 → in-use 指引 + 残留诊断日志。
     */
    fun delete(worktreeRoot: Path, sourceWorkspace: Path, force: Boolean): DeleteOutcome {
        val client = project.zCodeService().getClient()
        // 先捕获使用方全集：unload/关标签都要用，注册表清条目后就查不到了
        val sids = sessionsUsing(worktreeRoot.toString()).toSet()
        sids.forEach { sid ->
            runCatching { client.unloadSession(sid) }
                .onFailure { println("[WorktreeLifecycle] unload $sid failed: ${it.message}") }
        }
        closeProjectsUnder(worktreeRoot)
        val outcome = try {
            cli.removeManagedWorktree(sourceWorkspace, worktreeRoot, force)
            DeleteOutcome.REMOVED
        } catch (first: GitWorktreeCli.GitWorktreeException) {
            if (!deleteRecursivelyRobust(worktreeRoot)) {
                // 残留诊断：列出删不掉的具体条目（占用方定位就看它，idea.log 搜 WorktreeLifecycle）
                val rest = runCatching {
                    Files.walk(worktreeRoot).use { s -> s.map(Path::toString).toList() }
                }.getOrDefault(emptyList())
                val onlyRoot = rest.size == 1 && Path.of(rest[0]).normalize() == worktreeRoot.normalize()
                println("[WorktreeLifecycle] delete incomplete, ${rest.size} entries left: ${rest.take(8)}")
                if (!onlyRoot) {
                    throw GitWorktreeCli.GitWorktreeException(
                        "in-use",
                        "${ZCodeBundle.message("worktree.delete.locked")}（残留 ${rest.size} 项）",
                    )
                }
                // 只剩目录本身：内容已删净，被进程 cwd 占用。记录照清（列表收敛），空目录暂留
                runCatching { cli.prune(sourceWorkspace) }
                    .onFailure { println("[WorktreeLifecycle] prune failed: ${it.message}") }
                DeleteOutcome.DIR_LEFT
            } else {
                DeleteOutcome.REMOVED
            }
        }
        // 注册表条目保留（2026-11-15 反馈：会话不连带删除）——worktreeExtraSessions 靠
        // 条目持续把会话注入历史列表，meta.deleted（worktreeMetaJson 按根目录存在性判定）
        // 驱动 chip 灰态；桶名随机不复用，陈旧条目无碰撞面
        // 标签联动收尾：宿着该 worktree 会话的标签一并关闭（选中的推前端回落待命态，
        // 幂等）；动作线程不在 EDT，ContentManager 是 Swing 模型，invokeLater 进
        if (sids.isNotEmpty()) {
            com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
                if (!project.isDisposed) {
                    com.zcode.ideaplugin.ui.ZCodeToolWindowFactory.closeSessionTabs(project, sids)
                }
            }
        }
        return outcome
    }

    /** 解占用：关闭以 worktree（或其子目录）为项目根的 IDE 窗口（「打开」开的副本窗口）；当前项目除外 */
    private fun closeProjectsUnder(worktreeRoot: Path) {
        val target = WorktreeRegistry.normalize(worktreeRoot.toString())
        val pm = com.intellij.openapi.project.ProjectManager.getInstanceIfCreated() ?: return
        for (p in pm.openProjects) {
            if (p == project || p.isDisposed) continue
            val base = p.basePath ?: continue
            val bn = WorktreeRegistry.normalize(base)
            if (bn == target || bn.startsWith("$target/")) {
                runCatching {
                    com.intellij.openapi.application.ApplicationManager.getApplication().invokeAndWait {
                        if (!p.isDisposed) pm.closeProject(p)
                    }
                }.onFailure { println("[WorktreeLifecycle] close ${p.name} failed: ${it.message}") }
            }
        }
        // 关窗口是同步的，但索引/监视句柄释放有延迟，留 300ms 宽限再删（EDT 上可接受）
        Thread.sleep(300)
    }

    /** 文件系统递归强删（清 Windows 只读属性），删除完以 root 是否消失为准；单个文件失败跳过 */
    private fun deleteRecursivelyRobust(root: Path): Boolean {
        if (!Files.exists(root)) return true
        runCatching {
            Files.walkFileTree(root, object : java.nio.file.SimpleFileVisitor<Path>() {
                override fun visitFile(file: Path, attrs: java.nio.file.attribute.BasicFileAttributes): java.nio.file.FileVisitResult {
                    file.toFile().setWritable(true)
                    runCatching { Files.deleteIfExists(file) }
                    return java.nio.file.FileVisitResult.CONTINUE
                }

                override fun postVisitDirectory(dir: Path, exc: java.io.IOException?): java.nio.file.FileVisitResult {
                    dir.toFile().setWritable(true)
                    runCatching { Files.deleteIfExists(dir) }
                    return java.nio.file.FileVisitResult.CONTINUE
                }
            })
        }
        return !Files.exists(root)
    }
}

/** git 可执行路径解析：git4idea（各 IDE 内置捆绑）优先，未装/异常回退 PATH 上的 git */
object WorktreeGits {
    fun executablePath(project: Project?): String = runCatching {
        git4idea.config.GitExecutableManager.getInstance().getPathToGit(project)
    }.getOrDefault("git")
}
