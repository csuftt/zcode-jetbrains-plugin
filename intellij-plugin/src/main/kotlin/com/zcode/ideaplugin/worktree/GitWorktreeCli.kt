package com.zcode.ideaplugin.worktree

import java.io.File
import java.nio.charset.StandardCharsets
import java.nio.file.FileAlreadyExistsException
import java.nio.file.Files
import java.nio.file.Path
import java.security.SecureRandom
import java.util.Comparator
import java.util.concurrent.TimeUnit

/**
 * git worktree 子命令薄封装（0.4.6 worktree，ADR-0012/0013）。
 *
 * 平台无关：只依赖注入的 git 可执行路径与工作目录，测试对真实临时仓库直跑。
 * 语义对齐官方桌面端（托管根/桶结构/porcelain 解析均按 3.18 实现反推）：
 * - 创建恒 detached（`worktree add --detach <path> <sha>`），不占用分支；
 * - 托管根 = `<dataBaseDir>/.zcode/worktrees/<4位hex桶>/<仓库名>`，桶随机分配；
 * - 该结构是 CLI 侧「worktree → 源工作区」映射（记忆/hooks 共享）的唯一识别依据，
 *   移动/改名都会丢失映射，见 ADR-0012。
 */
class GitWorktreeCli(private val gitExe: String = "git", private val timeoutMs: Long = 120_000L) {

    /** code 对齐桌面端错误族：not-repository/invalid-start-ref/git-failed/bucket-exhausted */
    class GitWorktreeException(val code: String, val detail: String? = null) :
        RuntimeException(if (detail.isNullOrBlank()) code else "$code: $detail")

    data class GitOutput(val exitCode: Int, val output: String, val timedOut: Boolean) {
        val ok: Boolean get() = exitCode == 0 && !timedOut
    }

    data class WorktreeEntry(
        val path: Path,
        val headSha: String?,
        val branchName: String?,
        val bare: Boolean,
        val prunable: Boolean,
    )

    data class ManagedWorktree(val bucket: String, val name: String, val root: Path, val relativeCwd: String, val sha: String)

    /** state: ok / missing（目录缺失，桌面端删除或手动删除后） */
    data class ManagedWorktreeEntry(
        val path: Path,
        val bucket: String,
        val name: String,
        val headSha: String?,
        val branchName: String?,
        val dirty: Boolean?,
        val state: String,
    )

    private val random = SecureRandom()

    // ============ 定位与解析 ============

    fun isRepository(dir: Path): Boolean =
        run(dir, "rev-parse", "--is-inside-work-tree").let { it.ok && it.output.trim() == "true" }

    /** 仓库 toplevel（源目录可能是仓库子目录，worktree 恒建在 toplevel，cwd 再映射回去） */
    fun toplevel(dir: Path): Path? {
        val r = run(dir, "rev-parse", "--show-toplevel")
        val out = r.output.trim()
        return if (r.ok && out.isNotEmpty()) Path.of(out) else null
    }

    fun headSha(dir: Path): String? {
        val r = run(dir, "rev-parse", "--verify", "--quiet", "HEAD")
        return if (r.ok) r.output.trim().ifEmpty { null } else null
    }

    fun headBranch(dir: Path): String? {
        val r = run(dir, "symbolic-ref", "--quiet", "--short", "HEAD")
        return if (r.ok) r.output.trim().ifEmpty { null } else null
    }

    /** 桶内目录名：仓库目录名（桌面端同款，取 basename） */
    private fun managedName(sourceRoot: Path): String =
        sourceRoot.fileName?.toString()?.takeIf { it.isNotBlank() } ?: "repo"

    // ============ 创建 / 删除 ============

    /**
     * 在托管根下创建 detached worktree。startRef 缺省 HEAD；解析失败抛 invalid-start-ref。
     * add 失败回滚：删桶目录 + prune（对齐桌面端 rollback）。
     */
    fun createManagedWorktree(sourceDir: Path, dataBaseDir: Path, startRef: String = "HEAD"): ManagedWorktree {
        val sourceRoot = toplevel(sourceDir) ?: throw GitWorktreeException("not-repository", sourceDir.toString())
        val shaRes = run(sourceRoot, "rev-parse", "--verify", "--quiet", "--end-of-options", "$startRef^{commit}")
        val sha = shaRes.output.trim()
        if (!shaRes.ok || sha.isEmpty()) throw GitWorktreeException("invalid-start-ref", startRef)
        // 源目录是仓库子目录时校验该子目录在起点提交中存在（桌面同款 cat-file -t <sha>:<rel>）
        val relativeCwd = relativeOrDot(sourceRoot, sourceDir)
        if (relativeCwd != ".") {
            val t = run(sourceRoot, "cat-file", "-t", "$sha:$relativeCwd")
            if (!t.ok || t.output.trim() != "tree") {
                throw GitWorktreeException("start-ref-missing-subdir", relativeCwd)
            }
        }
        val root = managedRoot(dataBaseDir)
        Files.createDirectories(root)
        ensureNeverIndexMarker(root)
        val bucket = allocateBucket(root) ?: throw GitWorktreeException("bucket-exhausted")
        val name = managedName(sourceRoot)
        val worktreeRoot = root.resolve(bucket).resolve(name)
        val add = run(sourceRoot, "worktree", "add", "--detach", worktreeRoot.toString(), sha)
        if (!add.ok) {
            deleteRecursively(root.resolve(bucket))
            run(sourceRoot, "worktree", "prune")
            throw GitWorktreeException("git-failed", add.output.takeLast(2000))
        }
        return ManagedWorktree(bucket, name, worktreeRoot, relativeCwd, sha)
    }

    /**
     * 删除托管 worktree。目录已缺失 → 直接 prune 清 git 记录；有脏内容时 git 会拒绝，
     * 调用方（删除编排）在确认丢弃后传 force。成功后顺手清残留（被忽略文件可能留在目录）。
     */
    fun removeManagedWorktree(sourceDir: Path, worktreeRoot: Path, force: Boolean) {
        if (!Files.exists(worktreeRoot)) {
            prune(sourceDir)
            return
        }
        val args = mutableListOf("worktree", "remove")
        if (force) args.add("--force")
        args.add(worktreeRoot.toString())
        val r = run(sourceDir, *args.toTypedArray())
        if (!r.ok) throw GitWorktreeException("git-failed", r.output.takeLast(2000))
        deleteRecursively(worktreeRoot)
    }

    fun prune(sourceDir: Path) {
        run(sourceDir, "worktree", "prune")
    }

    // ============ 查询 ============

    /** 脏判定（含未跟踪）；git 失败返回 null（调用方按未知处理，不据此删） */
    fun isDirty(dir: Path): Boolean? {
        val r = run(dir, "status", "--porcelain", "-z", "--untracked-files=normal")
        return if (r.ok) r.output.isNotEmpty() else null
    }

    /** HEAD 上不被任何本地/远端分支可达的提交数（detached 工作的丢失风险度量）；失败 null */
    fun countUnmergedCommits(dir: Path): Int? {
        val r = run(dir, "rev-list", "--count", "HEAD", "--not", "--branches", "--remotes")
        return if (r.ok) r.output.trim().toIntOrNull() else null
    }

    /**
     * HEAD 侧相对上游分支 [upstreamRef] 的未合并提交 sha 集（`git cherry <upstream> <head>`
     * 的 "+" 行）；查询失败（上游分支已删等）返回 null。
     *
     * patch 等价口径：上游存在同补丁提交即判已合并（"-" 行），cherry-pick/rebase 落地
     * 换 sha 也认得；已被上游可达的提交不进候选集，天然视为已合并——调用方按
     * 「提交 sha ∉ 本集合 = 已合并」逐条判定。
     */
    fun unmergedCommitShas(worktreeRoot: Path, upstreamRef: String, headSha: String): Set<String>? {
        val r = run(worktreeRoot, "cherry", upstreamRef, headSha)
        if (!r.ok) return null
        return r.output.lineSequence()
            .map { it.trim() }
            .filter { it.startsWith("+") }
            .map { it.drop(1).trim() }
            .filter { it.isNotEmpty() }
            .toSet()
    }

    /**
     * worktree 创建起点 sha（2026-11-16 排查定案）：worktree 专属 HEAD reflog
     * （`--git-path logs/HEAD` 指回主仓 `.git/worktrees/<name>/logs/HEAD`）首条记录
     * 「全零 → 创建时刻 HEAD」，是 `worktree add` 落笔的历史事实——桌面客户端 detached
     * 建副本既不占分支也不进插件注册表，这里是起点唯一权威来源；主分支其后被 rebase
     * 改写也不影响（对比：merge-base 是动态推算，改写后失真，2026-11-14 四轮已弃）。
     *
     * 首条 from 须为 40 个零（证明确是创建条目而非 reflog 过期/清落后的残段），不符、
     * 文件缺失（core.logAllRefUpdates=false 等场景）返回 null——调用方维持「起点未知
     * 不显示」现状，绝不拿别的推算值冒充。
     */
    fun creationBaseSha(worktreeRoot: Path): String? {
        val r = run(worktreeRoot, "rev-parse", "--git-path", "logs/HEAD")
        val out = r.output.trim().takeIf { r.ok && it.isNotEmpty() } ?: return null
        val reflog = Path.of(out).let { if (it.isAbsolute) it else worktreeRoot.resolve(out) }
        if (!Files.isRegularFile(reflog)) return null
        // ISO_8859_1 逐字节解码：identity 里可能有非 UTF-8 字节，按行解码会整行报废
        val first = runCatching {
            val raw = Files.readAllBytes(reflog)
            val nl = raw.indexOf('\n'.code.toByte())
            String(if (nl >= 0) raw.copyOf(nl) else raw, StandardCharsets.ISO_8859_1)
        }.getOrNull() ?: return null
        val fields = first.trim().split(' ')
        if (fields.size < 2) return null
        if (!fields[0].matches(Regex("^0{40}$"))) return null
        return fields[1].takeIf { it.matches(Regex("^[0-9a-f]{40}$")) }
    }

    /** 托管 worktree 清单：`worktree list --porcelain -z` ∩ 托管根（含桌面端建的），只收桶根 */
    fun listManagedWorktrees(sourceDir: Path, dataBaseDir: Path): List<ManagedWorktreeEntry> {
        val raw = run(sourceDir, "worktree", "list", "--porcelain", "-z")
        if (!raw.ok) return emptyList()
        return parseWorktreeListPorcelain(raw.output).mapNotNull { e ->
            if (e.bare) return@mapNotNull null
            val parsed = parseManagedWorktreePath(dataBaseDir, e.path) ?: return@mapNotNull null
            if (parsed.relativePath.isNotEmpty()) return@mapNotNull null
            val exists = Files.exists(e.path)
            val dirty = if (exists) isDirty(e.path) else null
            ManagedWorktreeEntry(
                path = e.path,
                bucket = parsed.bucket,
                name = parsed.name,
                headSha = e.headSha,
                branchName = e.branchName?.removePrefix("refs/heads/"),
                dirty = dirty,
                state = if (exists) "ok" else "missing",
            )
        }
    }

    // ============ porcelain 解析 ============

    /**
     * cwd → 源工作区反解（fork-to-worktree 编排用）：cwd 在托管 worktree 下时经
     * `rev-parse --git-common-dir`（worktree 指回主仓 `.git`）取主仓工作树；cwd 本身
     * 是普通仓库/主仓则原样返回。注册表未收录（桌面端建的副本）时的兜底，与 CLI 侧
     * resolveManagedWorktreeSourcePath 同语义但实现走 git。失败 fail-soft 返回 null。
     */
    fun resolveSourceWorkspace(cwd: Path): Path? {
        val r = run(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")
        if (!r.ok) return null
        val commonDir = r.output.trim().takeIf { it.isNotEmpty() }?.let { Path.of(it) } ?: return null
        val root = commonDir.parent ?: return null
        return if (isRepository(root)) root else null
    }

    /** `worktree list --porcelain -z`：NUL 分块，块内「token 值」（桌面端同款切法） */
    internal fun parseWorktreeListPorcelain(output: String): List<WorktreeEntry> {
        val result = mutableListOf<WorktreeEntry>()
        var current: WorktreeEntry? = null
        for (chunk in output.split('\u0000')) {
            if (chunk.isEmpty()) {
                current?.let { result.add(it) }
                current = null
                continue
            }
            val sp = chunk.indexOf(' ')
            if (sp < 0) continue
            val token = chunk.substring(0, sp)
            val value = chunk.substring(sp + 1)
            current = when (token) {
                "worktree" -> {
                    current?.let { result.add(it) }
                    WorktreeEntry(Path.of(value), null, null, bare = false, prunable = false)
                }
                "HEAD" -> current?.copy(headSha = value.ifEmpty { null })
                "branch" -> current?.copy(branchName = value.ifEmpty { null })
                "prunable" -> current?.copy(prunable = true)
                "bare" -> current?.copy(bare = true)
                else -> current
            }
        }
        current?.let { result.add(it) }
        return result
    }

    // ============ 路径与托管根 ============

    fun managedRoot(dataBaseDir: Path): Path = dataBaseDir.resolve(".zcode").resolve("worktrees")

    /**
     * 数据根解析与 CLI 侧 resolveZCodeDataBaseDir 同语义：env `ZCODE_DATA_BASE_DIR`
     * 优先（主 app-server 不注入 → 缺省 homedir，与桌面端托管根一致，ADR-0011/0012）。
     */
    fun dataBaseDir(env: Map<String, String> = System.getenv(), home: String = System.getProperty("user.home") ?: "."): Path =
        Path.of(env["ZCODE_DATA_BASE_DIR"]?.trim()?.takeIf { it.isNotEmpty() } ?: home)

    data class ParsedManagedPath(val bucket: String, val name: String, val relativePath: String)

    /** 托管根下 `<4hex桶>/<仓库名>/…` 结构解析；不匹配（含桶非 4hex、根外）返回 null */
    fun parseManagedWorktreePath(dataBaseDir: Path, path: Path): ParsedManagedPath? {
        val root = managedRoot(dataBaseDir)
        val rel = relativeToIgnoreCase(root, path) ?: return null
        val parts = rel.split(File.separatorChar).filter { it.isNotEmpty() }
        if (parts.size < 2) return null
        if (!BUCKET.matches(parts[0])) return null
        return ParsedManagedPath(parts[0], parts[1], parts.drop(2).joinToString(File.separator))
    }

    // ============ 起点变更洞察（2026-11-14，spec #52 追加）============

    /** 变更文件条目；status A/M/D/R/C/T，R/C 时 oldPath 为原名（rename/copy） */
    data class FileChange(val path: String, val oldPath: String?, val status: Char)

    /** 单提交变更（文件序 = git log --name-status 输出序）；time=committer 时间（操作时刻，cherry-pick/rebase 后是新时间，%at 的 author 时间会留旧账） */
    data class CommitChange(
        val sha: String,
        val parentSha: String?,
        val subject: String,
        val time: Long,
        val files: List<FileChange>,
    )

    /** 起点以来变更快照：提交列表（新→旧）+ 未提交改动；两段拼合=起点→工作区全景 */
    data class ChangesSince(
        val headSha: String?,
        val commits: List<CommitChange>,
        val uncommitted: List<FileChange>,
    )

    /**
     * worktree 的提交与未提交改动（纯 git 数据面，diff 展示由 UI 层按需拉 blob 自建，
     * 不依赖 git4idea 的 GitRepository 映射——worktree 目录不在 project 内容根里）。
     *
     * 提交口径双模式（2026-11-14 三轮反馈：merge-base 兜底在主分支被 rebase 改写时
     * 会把创建前的主分支提交也装进来，误导，已删）：
     * - 注册表 startSha 有效（插件自建条目）→ `log startSha..HEAD`（创建点定版语义，
     *   合并回分支后仍可见）；
     * - startSha 缺失/失联（桌面端建副本等）→ `log HEAD --not --branches --remotes`
     *   （**游离提交口径**：不被任何分支可达的提交=纯这个 worktree 干的活，主分支
     *   改写免疫；提交合并回分支后会从列表消失，视为「已归属」）。
     * 未提交 = `diff HEAD`（staged+unstaged 合并视图）∪ untracked（AI 常建新文件不
     * add，`ls-files --others` 补齐）。git 失败返回 null。
     * 顺序（2026-11-15 反馈）：提交列表**严格按 committer 时间从新到旧**——git 侧
     * `--date-order` + Kotlin 兜底重排（拓扑约束会让时间旧的父亲插队中间）；时间取
     * %ct（committer 操作时刻，cherry-pick/rebase 后是新时间，%at 的 author 时间会
     * 留旧账），与行尾相对时间同源。
     */
    fun listChangesSince(worktreeRoot: Path, startSha: String?, knownHeadSha: String? = null): ChangesSince? {
        val base = if (!startSha.isNullOrBlank()) {
            val r = run(worktreeRoot, "rev-parse", "--verify", "--quiet", "--end-of-options", "$startSha^{commit}")
            r.output.trim().takeIf { r.ok && it.isNotEmpty() }
        } else {
            null
        }
        val log = if (base != null) {
            run(worktreeRoot, "log", "--date-order", "--name-status", "-M", "--format=%x01%H%x02%P%x03%ct%x04%s", "$base..HEAD")
        } else {
            run(worktreeRoot, "log", "--date-order", "--name-status", "-M", "--format=%x01%H%x02%P%x03%ct%x04%s", "HEAD", "--not", "--branches", "--remotes")
        }
        if (!log.ok) return null
        // 严格时间降序（2026-11-15 二次反馈：--date-order 仍受拓扑约束，父提交时间旧于
        // 子提交时照样插队中间）——这是平铺变更列表不是历史图，时间序优先于拓扑序；
        // --date-order 保留让 git 输出近乎有序，此处兜底强制
        val commits = parseCommitChanges(log.output).sortedByDescending { it.time }
        // knownHeadSha：调用方从 worktree list 已拿到的 HEAD，复用省一条 rev-parse
        val head = knownHeadSha ?: headSha(worktreeRoot)
        val uncommitted = mutableListOf<FileChange>()
        if (head != null) {
            val diff = run(worktreeRoot, "diff", "--name-status", "-M", head)
            if (diff.ok) uncommitted += parseNameStatus(diff.output)
        }
        run(worktreeRoot, "ls-files", "--others", "--exclude-standard", "-z").output
            .split('\u0000').map { it.trim() }
            .filter { it.isNotEmpty() && uncommitted.none { c -> c.path == it } }
            .forEach { uncommitted.add(FileChange(it, null, 'A')) }
        return ChangesSince(
            headSha = head,
            commits = commits,
            uncommitted = uncommitted,
        )
    }

    /** 指定 revision 的 blob 原始字节（`cat-file blob rev:path`，diff 展示数据源）；失败返回 null */
    fun blobBytes(dir: Path, revPath: String): ByteArray? {
        val (code, bytes, timedOut) = exec(dir, "cat-file", "blob", revPath)
        return if (code == 0 && !timedOut) bytes else null
    }

    internal fun parseCommitChanges(output: String): List<CommitChange> {
        val commits = mutableListOf<CommitChange>()
        var current: CommitChange? = null
        for (line in output.lineSequence()) {
            if (line.startsWith("\u0001")) {
                // %x01%H%x02%P%x03%ct%x04%s，limit=4 保 subject 完整
                val f = line.substring(1).split('\u0002', '\u0003', '\u0004', limit = 4)
                val parents = f.getOrNull(1)?.trim().orEmpty()
                current = CommitChange(
                    sha = f.getOrNull(0).orEmpty(),
                    parentSha = parents.split(' ').firstOrNull { it.isNotEmpty() },
                    subject = f.getOrNull(3).orEmpty(),
                    time = f.getOrNull(2)?.trim()?.toLongOrNull() ?: 0L,
                    files = mutableListOf(),
                )
                commits.add(current)
            } else if (line.isNotBlank() && current != null) {
                parseNameStatusLine(line)?.let { (current.files as MutableList).add(it) }
            }
        }
        return commits
    }

    internal fun parseNameStatus(output: String): List<FileChange> =
        output.lineSequence().mapNotNull(::parseNameStatusLine).toList()

    private fun parseNameStatusLine(line: String): FileChange? {
        val cols = line.split('\t')
        if (cols.size < 2) return null
        val letter = cols[0].firstOrNull() ?: return null
        return if ((letter == 'R' || letter == 'C') && cols.size >= 3) {
            FileChange(path = cols[2], oldPath = cols[1], status = letter)
        } else {
            FileChange(path = cols[1], oldPath = null, status = letter)
        }
    }

    // ============ 内部 ============

    private val BUCKET = Regex("^[0-9a-f]{4}$")

    private fun allocateBucket(managedRoot: Path): String? {
        repeat(64) {
            val bytes = ByteArray(2).also(random::nextBytes)
            val bucket = bytes.joinToString("") { "%02x".format(it) }
            try {
                Files.createDirectory(managedRoot.resolve(bucket))
                return bucket
            } catch (_: FileAlreadyExistsException) {
                // 桶撞名重试（桌面同款，最多 64 次）
            } catch (_: java.io.IOException) {
                return null
            }
        }
        return null
    }

    private fun ensureNeverIndexMarker(managedRoot: Path) {
        try {
            Files.createFile(managedRoot.resolve(".metadata_never_index"))
        } catch (_: FileAlreadyExistsException) {
        } catch (_: java.io.IOException) {
        }
    }

    private fun relativeOrDot(base: Path, child: Path): String {
        val rel = relativeToIgnoreCase(base, child) ?: return "."
        return rel.ifEmpty { "." }
    }

    /** 大小写不敏感（Windows）的前缀裁剪；child 在 base 外返回 null；同级返回 "" */
    private fun relativeToIgnoreCase(base: Path, child: Path): String? {
        val bn = base.toAbsolutePath().normalize().toString()
        val cn = child.toAbsolutePath().normalize().toString()
        val b = if (IS_WINDOWS) bn.lowercase() else bn
        val c = if (IS_WINDOWS) cn.lowercase() else cn
        if (c == b) return ""
        val prefix = b + File.separatorChar
        if (!c.startsWith(prefix)) return null
        return child.toAbsolutePath().normalize().toString().substring(prefix.length)
    }

    private fun deleteRecursively(dir: Path) {
        if (!Files.exists(dir)) return
        Files.walk(dir).use { walk ->
            // Windows 只读文件（git objects/指针）直接 unlink 会 Permission denied，先清只读
            walk.sorted(Comparator.reverseOrder()).forEach {
                it.toFile().setWritable(true)
                Files.deleteIfExists(it)
            }
        }
    }

    private fun run(dir: Path?, vararg args: String): GitOutput {
        val (code, bytes, timedOut) = exec(dir, *args)
        return GitOutput(code, bytes.toString(StandardCharsets.UTF_8), timedOut)
    }

    /** 字节级执行（blob 原文不走 UTF-8 字符串，防二进制损坏）；返回 (exitCode, bytes, timedOut) */
    private fun exec(dir: Path?, vararg args: String): Triple<Int, ByteArray, Boolean> {
        val pb = ProcessBuilder(listOf(gitExe) + args.toList()).apply {
            dir?.let { directory(it.toFile()) }
            redirectErrorStream(true)
            // 稳定解析：不受 pager/locale 干扰（对齐桌面端 git 环境）
            environment().apply {
                put("GIT_OPTIONAL_LOCKS", "0")
                put("GIT_PAGER", "cat")
                put("PAGER", "cat")
                put("TERM", "dumb")
                put("LC_ALL", "C")
                put("LANG", "C")
            }
        }
        val p = pb.start()
        val bytes = p.inputStream.readBytes()
        val finished = p.waitFor(timeoutMs, TimeUnit.MILLISECONDS)
        if (!finished) {
            p.destroyForcibly()
            return Triple(-1, bytes, true)
        }
        return Triple(p.exitValue(), bytes, false)
    }

    companion object {
        private val IS_WINDOWS = System.getProperty("os.name").lowercase().contains("windows")
    }
}
