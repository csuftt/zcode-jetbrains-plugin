package com.zcode.ideaplugin.worktree

import java.nio.file.Files
import java.nio.file.Path

/**
 * worktree 会话创建编排（平台无关核心，0.4.6）。
 *
 * 职责：待命页首发拦截后的完整创建链——起点定版 → 建 detached worktree → 计算执行根 →
 * 建会话（注入回调）→ 产出注册表条目。失败语义对齐桌面端：git 失败抛 [GitWorktreeCli.GitWorktreeException]
 * （调用方映射三键：重试/不用 worktree 直接发送/取消）；会话创建失败时 worktree 保留
 * （桌面同款「worktree 已创建，但任务启动失败」），注册表不落条目。
 *
 * 阶段推进通过 [onPhase] 上报（webview 进度提示），阶段序恒为 PREPARING → CREATING → STARTING。
 */
class WorktreeSessionCreator(private val git: GitWorktreeCli, private val dataBaseDir: Path) {

    enum class Phase { PREPARING, CREATING, STARTING }

    data class CreationResult(val sessionId: String, val info: WorktreeRegistryStore.WorktreeSessionInfo)

    /**
     * @param sourceWorkspace 源工作区目录（本项目或关联目录；可以是仓库子目录）
     * @param startRef 起点（分支名或 "HEAD"），在发送时刻解析定版
     * @param createSession 建会话回调：入参 = worktree 内执行根（cwd），返回 sessionId
     */
    fun create(
        sourceWorkspace: Path,
        startRef: String,
        createSession: (Path) -> String,
        onPhase: (Phase) -> Unit = {},
    ): CreationResult {
        if (!Files.exists(sourceWorkspace)) {
            throw GitWorktreeCli.GitWorktreeException("not-repository", sourceWorkspace.toString())
        }
        onPhase(Phase.PREPARING)
        onPhase(Phase.CREATING)
        val wt = git.createManagedWorktree(sourceWorkspace, dataBaseDir, startRef)
        val cwd = if (wt.relativeCwd == ".") wt.root else wt.root.resolve(wt.relativeCwd)
        onPhase(Phase.STARTING)
        val sessionId = createSession(cwd)
        val info = WorktreeRegistryStore.WorktreeSessionInfo(
            sessionId = sessionId,
            worktreeRoot = wt.root.toString(),
            cwd = cwd.toString(),
            sourceWorkspace = sourceWorkspace.toAbsolutePath().normalize().toString(),
            startRef = startRef,
            startSha = wt.sha,
            bucket = wt.bucket,
            createdAt = System.currentTimeMillis(),
        )
        return CreationResult(sessionId, info)
    }
}
