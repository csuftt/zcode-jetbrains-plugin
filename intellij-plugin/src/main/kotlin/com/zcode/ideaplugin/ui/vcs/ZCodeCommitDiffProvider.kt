package com.zcode.ideaplugin.ui.vcs

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.vcs.FilePath
import com.intellij.openapi.vcs.VcsException
import com.intellij.openapi.vcs.changes.Change
import com.intellij.openapi.vcs.changes.ChangesUtil
import com.intellij.openapi.vcs.changes.ContentRevision
import com.intellij.openapi.vfs.VirtualFile
import git4idea.commands.Git
import git4idea.commands.GitCommand
import git4idea.commands.GitCommandResult
import git4idea.commands.GitLineHandler
import git4idea.repo.GitRepository
import git4idea.repo.GitRepositoryManager
import java.nio.file.Paths

/**
 * AI Commit Message 的 diff 源（C1）：对用户勾选的 [Change] 产出真实 unified diff，
 * 让模型看到与终端 `git diff` 同形的内容。
 *
 * 主路径 git4idea 按仓库分组跑 `git diff HEAD -- <paths>`（每仓库一个进程，Windows
 * 建进程贵，不逐文件 spawn；参数形状照搬 cc-gui CommitDiffProvider 实证写法）。
 * 新增文件（无 HEAD 版本，diff 输出为空）用 afterRevision 内容合成受限 hunk；
 * git diff 空输出/异常逐文件降级 ContentRevision 内容对照，功能不中断。
 *
 * 预算裁到轻量档：总量 50k / 单文件 12k 字符（generateText 30s 快速通道输入预算内）。
 */
object ZCodeCommitDiffProvider {
    private val log = Logger.getInstance("ZCodePlugin")

    /** diff 总预算（字符）：~12-16k token 量级 */
    private const val MAX_TOTAL_LENGTH = 50_000
    /** 单文件上限：一个大文件不能吃光整个预算 */
    private const val MAX_PER_FILE_LENGTH = 12_000
    /** 新增文件合成 hunk 的行数上限 */
    private const val NEW_FILE_LINE_CAP = 200

    fun generate(project: Project, changes: Collection<Change>): String {
        val out = StringBuilder()
        var omitted = 0
        try {
            val mgr = GitRepositoryManager.getInstance(project)
            val trackedByRepo = LinkedHashMap<GitRepository, MutableList<Change>>()
            val newFiles = mutableListOf<Change>()
            val unresolved = mutableListOf<Change>()
            for (change in changes) {
                val repo = findRepository(mgr, ChangesUtil.getFilePath(change))
                when {
                    repo == null -> unresolved.add(change)
                    change.type == Change.Type.NEW -> newFiles.add(change)
                    else -> trackedByRepo.getOrPut(repo) { mutableListOf() }.add(change)
                }
            }

            for ((repo, repoChanges) in trackedByRepo) {
                val relPaths = repoChanges.mapNotNull { relativePath(repo, ChangesUtil.getFilePath(it)) }
                if (relPaths.isEmpty()) continue
                val seg = capPerFile(runGitDiff(project, repo, relPaths))
                if (seg.isBlank()) {
                    // 尚无 HEAD（新仓库首次提交）或这些路径无输出：逐文件降级而非丢弃
                    for (c in repoChanges) omitted += appendSegment(out, contentDiffQuiet(c))
                } else {
                    omitted += appendSegment(out, seg)
                }
            }
            for (c in newFiles) omitted += appendSegment(out, synthesizeNewFile(c))
            for (c in unresolved) omitted += appendSegment(out, contentDiffQuiet(c))
        } catch (t: Throwable) {
            // git4idea 理论上恒在（optional depends 门控），但不能让 diff 生成打断提交流程
            log.warn("[ai-commit] git diff failed, falling back to content diff: ${t.message}")
            out.setLength(0)
            for (c in changes) appendSegment(out, contentDiffQuiet(c))
        }
        if (omitted > 0) out.append("\n... (").append(omitted).append(" file(s) omitted to fit context budget)\n")
        return out.toString()
    }

    /**
     * 仓库近期提交主题（风格参照，10-01 用户诉求：本仓库是 `fix# 描述` 风格，
     * 裸 Conventional Commits 会产出 `fix(scope):` 括号形态）。取变更集首个可定位
     * 仓库的 `git log` 主题行；空仓库（无提交）/异常返回空列表，prompt 侧跳过该段。
     */
    fun recentCommitSubjects(project: Project, changes: Collection<Change>, limit: Int = 8, maxLenPer: Int = 100): List<String> {
        return try {
            val mgr = GitRepositoryManager.getInstance(project)
            val repo = changes.asSequence()
                .map { findRepository(mgr, ChangesUtil.getFilePath(it)) }
                .firstOrNull { it != null } ?: return emptyList()
            val handler = GitLineHandler(project, repo.root, GitCommand.LOG)
            handler.addParameters("--max-count=$limit", "--format=%s")
            val result: GitCommandResult = Git.getInstance().runCommand(handler)
            result.output
                .map { it.trim() }
                .filter { it.isNotEmpty() }
                .distinct()
                .take(limit)
                .map { if (it.length > maxLenPer) it.take(maxLenPer) + "…" else it }
        } catch (t: Throwable) {
            log.warn("[ai-commit] recent subjects read failed: ${t.message}")
            emptyList()
        }
    }

    /**
     * 单提交 diff（VCS Log 右键「解释提交」用，调研 ⑥）：`git show <rev>` 带提交元信息头
     * （作者/日期/提交说明，解释场景正需要），预算总量收口同族。合并提交 `git show`
     * 输出 combined diff 常为空，调用方按空串提示兜底。
     */
    fun generateForCommit(project: Project, root: VirtualFile, revision: String): String {
        return try {
            val handler = GitLineHandler(project, root, GitCommand.SHOW)
            handler.addParameters("--unified=3", "--no-color", "-M", "--no-ext-diff")
            handler.addParameters(revision)
            val out = Git.getInstance().runCommand(handler).output.joinToString("\n")
            if (out.length <= MAX_TOTAL_LENGTH) out
            else out.take(MAX_TOTAL_LENGTH) + "\n... (diff truncated to fit context budget)\n"
        } catch (t: Throwable) {
            log.warn("[ai-commit] git show $revision failed: ${t.message}")
            ""
        }
    }

    /**
     * 提交头信息（短 id + 主题行，`git log -1 --format=%h %s`）：解释弹窗头部展示用。
     * 失败返回 null（不阻断解释流程，弹窗只是少一行头）。
     */
    fun commitHeading(project: Project, root: VirtualFile, revision: String): Pair<String, String>? {
        return try {
            val handler = GitLineHandler(project, root, GitCommand.LOG)
            handler.addParameters("-1", "--format=%h %s", "--no-color")
            handler.endOptions()
            handler.addParameters(revision)
            val line = Git.getInstance().runCommand(handler).output.joinToString("\n").trim()
            val idx = line.indexOf(' ')
            if (idx > 0) line.take(idx) to line.substring(idx + 1) else null
        } catch (t: Throwable) {
            log.warn("[commit-explain] heading read failed: ${t.message}")
            null
        }
    }

    /** 预算内追加片段；装不下计一个 omitted（防超长 diff 把 generateText 拖过超时） */
    private fun appendSegment(out: StringBuilder, segment: String): Int {
        if (segment.isEmpty()) return 0
        if (out.length + segment.length > MAX_TOTAL_LENGTH) return 1
        out.append(segment)
        return 0
    }

    private fun capPerFile(segment: String): String =
        if (segment.length <= MAX_PER_FILE_LENGTH) segment
        else segment.take(MAX_PER_FILE_LENGTH) + "\n... (single-file diff truncated)\n"

    private fun runGitDiff(project: Project, repo: GitRepository, relPaths: List<String>): String = try {
        val handler = GitLineHandler(project, repo.root, GitCommand.DIFF)
        handler.addParameters("--unified=3", "--no-color", "-M", "--no-ext-diff", "HEAD")
        handler.endOptions()
        handler.addParameters("--")
        for (p in relPaths) handler.addParameters(p)
        val result: GitCommandResult = Git.getInstance().runCommand(handler)
        result.output.joinToString("\n")
    } catch (t: Throwable) {
        log.warn("[ai-commit] git diff command failed: ${t.message}")
        ""
    }

    private fun findRepository(mgr: GitRepositoryManager, fp: FilePath?): GitRepository? {
        if (fp == null) return null
        val vf: VirtualFile? = fp.virtualFile
        if (vf != null) mgr.getRepositoryForFile(vf)?.let { return it }
        val abs = fp.path
        return mgr.repositories.firstOrNull { abs.startsWith(it.root.path) }
    }

    private fun relativePath(repo: GitRepository, fp: FilePath?): String? {
        if (fp == null) return null
        return try {
            val root = Paths.get(repo.root.path)
            val abs = Paths.get(fp.path)
            if (!abs.startsWith(root)) null
            else root.relativize(abs).toString().replace('\\', '/')
        } catch (t: Throwable) {
            null
        }
    }

    /** 新增文件（未跟踪）：afterRevision 内容合成受限 unified hunk */
    private fun synthesizeNewFile(change: Change): String {
        val path = ChangesUtil.getFilePath(change)?.path ?: "(unknown)"
        val raw: String? = try {
            change.afterRevision?.content
        } catch (e: VcsException) {
            log.warn("[ai-commit] failed to read new file content: ${e.message}")
            null
        }
        val content = raw ?: return ""
        val lines = content.replace("\r\n", "\n").split("\n").let { if (it.last().isEmpty()) it.dropLast(1) else it }
        val shown = minOf(lines.size, NEW_FILE_LINE_CAP)
        val sb = StringBuilder()
        sb.append("diff --git a/").append(path).append(" b/").append(path).append('\n')
        sb.append("new file mode 100644\n")
        sb.append("--- /dev/null\n")
        sb.append("+++ b/").append(path).append('\n')
        sb.append("@@ -0,0 +1,").append(shown).append(" @@\n")
        for (i in 0 until shown) sb.append('+').append(lines[i]).append('\n')
        if (lines.size > NEW_FILE_LINE_CAP) {
            sb.append("... (new file truncated at ").append(NEW_FILE_LINE_CAP).append(" lines)\n")
        }
        return sb.toString()
    }

    /** 降级路径：ContentRevision 前后内容逐文件对照（无仓库上下文时的功能保底） */
    private fun contentDiffQuiet(change: Change): String = try {
        contentDiff(change)
    } catch (e: VcsException) {
        log.warn("[ai-commit] failed to build content diff: ${e.message}")
        ""
    }

    private fun contentDiff(change: Change): String {
        val before: String? = change.beforeRevision?.content
        val after: String? = change.afterRevision?.content
        if (before == after) return ""
        val path = ChangesUtil.getFilePath(change)?.path ?: "(unknown)"
        val sb = StringBuilder()
        sb.append("--- a/").append(path).append('\n')
        sb.append("+++ b/").append(path).append('\n')
        for ((prefix, content) in listOf("-" to before, "+" to after)) {
            val lines = (content ?: "").replace("\r\n", "\n").split("\n").let {
                if (it.last().isEmpty()) it.dropLast(1) else it
            }
            for (line in lines.take(80)) sb.append(prefix).append(line).append('\n')
            if (lines.size > 80) sb.append(prefix).append("... (").append(lines.size - 80).append(" more lines)\n")
        }
        return sb.toString()
    }
}
