package com.zcode.ideaplugin.worktree

import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * GitWorktreeCli 集成测试：对真实临时 git 仓库直跑（测试缝定稿 2026-11-13，spec #52）。
 *
 * 覆盖 0.4.6 设计的关键行为：detached 创建不占分支、同一提交可建多个独立桶副本
 * （git 单分支单 worktree 限制不适用于 --detach）、托管根结构解析、脏判定、
 * 未合并提交计数（detached 提交丢失风险度量）、cherry 口径未合并集（patch 等价，
 * 已合并标识数据源）、删除守卫语义、缺失态与 prune、创建起点推断（worktree 专属
 * HEAD reflog 首条，桌面端 detached 副本「基于 xxx」展示数据源）。
 */
class GitWorktreeCliTest {

    @TempDir
    lateinit var tmp: Path

    private val cli = GitWorktreeCli(timeoutMs = 30_000L)

    // ============ 工具 ============

    private fun git(dir: Path, vararg args: String): String {
        val pb = ProcessBuilder(listOf("git") + args.toList())
            .directory(dir.toFile())
            .redirectErrorStream(true)
        pb.environment().apply {
            put("GIT_OPTIONAL_LOCKS", "0")
            put("LC_ALL", "C")
            put("LANG", "C")
        }
        val p = pb.start()
        val out = p.inputStream.readBytes().toString(Charsets.UTF_8)
        assertTrue(p.waitFor(30, TimeUnit.SECONDS), "git 超时: ${args.joinToString(" ")}")
        assertEquals(0, p.exitValue(), "git 失败: ${args.joinToString(" ")} -> $out")
        return out
    }

    /** 带环境变量的 git 调用（crafting committer/author date 用） */
    private fun gitEnv(dir: Path, env: Map<String, String>, vararg args: String): String {
        val pb = ProcessBuilder(listOf("git") + args.toList())
            .directory(dir.toFile())
            .redirectErrorStream(true)
        pb.environment().apply {
            put("GIT_OPTIONAL_LOCKS", "0")
            put("LC_ALL", "C")
            put("LANG", "C")
            putAll(env)
        }
        val p = pb.start()
        val out = p.inputStream.readBytes().toString(Charsets.UTF_8)
        assertTrue(p.waitFor(30, TimeUnit.SECONDS), "git 超时: ${args.joinToString(" ")}")
        assertEquals(0, p.exitValue(), "git 失败: ${args.joinToString(" ")} -> $out")
        return out
    }

    private fun initRepo(): Path {
        val dir = Files.createDirectory(tmp.resolve("repo-${System.nanoTime()}"))
        git(dir, "init")
        git(dir, "config", "user.email", "t@example.com")
        git(dir, "config", "user.name", "t")
        Files.writeString(dir.resolve("a.txt"), "hello")
        git(dir, "add", ".")
        git(dir, "commit", "-m", "init")
        return dir
    }

    /** 测试内数据根 = tmp，托管根 = tmp/.zcode/worktrees，不碰用户真实目录 */
    private fun base(): Path = tmp.resolve("basedata")

    private fun deleteAll(dir: Path) {
        if (!Files.exists(dir)) return
        Files.walk(dir).use { walk -> walk.sorted(java.util.Comparator.reverseOrder()).forEach { Files.deleteIfExists(it) } }
    }

    companion object {
        @JvmStatic
        @BeforeAll
        fun requireGit() {
            val ok = try {
                val p = ProcessBuilder("git", "--version").start()
                p.waitFor(10, TimeUnit.SECONDS) && p.exitValue() == 0
            } catch (e: Exception) { false }
            assumeTrue(ok, "git 不在 PATH，跳过 GitWorktreeCli 测试")
        }
    }

    // ============ 用例 ============

    @Test
    fun `非 git 目录判定`() {
        val dir = Files.createDirectory(tmp.resolve("plain"))
        assertFalse(cli.isRepository(dir))
        assertNull(cli.toplevel(dir))
        assertNull(cli.headSha(dir))
        assertNull(cli.headBranch(dir))
        val ex = assertIs<GitWorktreeCli.GitWorktreeException>(runCatching {
            cli.createManagedWorktree(dir, base())
        }.exceptionOrNull())
        assertEquals("not-repository", ex.code)
    }

    @Test
    fun `创建 detached worktree 不占分支`() {
        val repo = initRepo()
        val base = base()
        // 不占分支：创建前后仓库本地分支集合不变（起点下拉退役后 listStartRefs 已删，
        // 用 for-each-ref 直证；worktree 与主仓共享 refs，对照须取创建前后）
        val branchSet: () -> List<String> = {
            git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads")
                .lineSequence().map { it.trim() }.filter { it.isNotEmpty() }.toList()
        }
        val branchesBefore = branchSet()
        val wt = cli.createManagedWorktree(repo, base, "HEAD")
        assertEquals(4, wt.bucket.length, "桶为 4 位 hex")
        assertTrue(Files.exists(wt.root), "worktree 根已创建")
        assertTrue(Files.isRegularFile(wt.root.resolve(".git")), "worktree 的 .git 是指针文件")
        assertEquals(cli.headSha(repo), cli.headSha(wt.root), "HEAD 指到起点提交")
        assertNull(cli.headBranch(wt.root), "detached 无分支")
        assertEquals(branchesBefore, branchSet(), "本地分支集合不变（worktree 恒 detached，不建新分支）")
        // 托管结构解析回环
        val parsed = cli.parseManagedWorktreePath(base, wt.root)
        assertEquals(wt.bucket, parsed?.bucket)
        assertEquals(wt.name, parsed?.name)
        assertEquals("", parsed?.relativePath)
    }

    @Test
    fun `创建起点取 reflog 首条 不受后续提交影响`() {
        val repo = initRepo()
        git(repo, "commit", "--allow-empty", "-m", "second")
        val baseSha = git(repo, "rev-parse", "HEAD").trim()
        val wt = cli.createManagedWorktree(repo, base(), "HEAD")
        assertEquals(baseSha, cli.creationBaseSha(wt.root), "首条 reflog=创建时刻 HEAD")
        // 副本里再提交：创建起点仍指向创建时刻（reflog 是历史事实，不是可达性推算）
        git(wt.root, "commit", "--allow-empty", "-m", "wip")
        assertEquals(baseSha, cli.creationBaseSha(wt.root), "后续提交不改变创建起点")
        // detached 无分支的场景（桌面端建副本同形态）同样取得到
        assertNull(cli.headBranch(wt.root))
    }

    @Test
    fun `源工作区反解 副本指回主仓 非仓库目录 null`() {
        val repo = initRepo()
        val base = base()
        val wt = cli.createManagedWorktree(repo, base, "HEAD")
        // 副本根/副本内子路径都反解回主仓工作树（缺陷HQ：注册表缺条目的桌面端副本兜底，
        // --git-common-dir 指回主仓 .git 的 parent）
        assertEquals(repo.toRealPath(), cli.resolveSourceWorkspace(wt.root)?.toRealPath())
        val sub = Files.createDirectories(wt.root.resolve("sub"))
        assertEquals(repo.toRealPath(), cli.resolveSourceWorkspace(sub)?.toRealPath())
        // 非仓库目录 fail-soft null
        assertNull(cli.resolveSourceWorkspace(base))
    }

    @Test
    fun `创建起点 reflog 缺失或非创建条目返回 null`() {
        val repo = initRepo()
        val wt = cli.createManagedWorktree(repo, base(), "HEAD")
        val out = git(wt.root, "rev-parse", "--git-path", "logs/HEAD").trim()
        val reflog = Path.of(out).let { if (it.isAbsolute) it else wt.root.resolve(out) }
        assertTrue(Files.isRegularFile(reflog), "worktree 专属 HEAD reflog 存在")
        // 无 reflog（core.logAllRefUpdates=false 等场景）→ null，不冒充
        Files.delete(reflog)
        assertNull(cli.creationBaseSha(wt.root))
        // 首条 from 非全零（reflog 过期后的残段）→ null，防把任意老 checkout 当起点
        Files.createDirectories(reflog.parent)
        Files.writeString(
            reflog,
            "1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 t 0 +0000\n",
        )
        assertNull(cli.creationBaseSha(wt.root))
    }

    @Test
    fun `同一提交可创建两个独立桶副本`() {
        val repo = initRepo()
        val base = base()
        val wt1 = cli.createManagedWorktree(repo, base, "HEAD")
        val wt2 = cli.createManagedWorktree(repo, base, "HEAD")
        assertNotEquals(wt1.bucket, wt2.bucket, "每次创建分配新桶")
        assertNotEquals(wt1.root, wt2.root)
        assertTrue(Files.exists(wt1.root) && Files.exists(wt2.root))
        val managed = cli.listManagedWorktrees(repo, base)
        assertEquals(2, managed.size, "清单含两个托管副本")
        assertTrue(managed.all { it.state == "ok" })
        assertTrue(managed.all { it.dirty == false })
    }

    @Test
    fun `脏判定与未合并提交计数`() {
        val repo = initRepo()
        val base = base()
        val wt = cli.createManagedWorktree(repo, base, "HEAD")
        assertEquals(false, cli.isDirty(wt.root))
        assertEquals(0, cli.countUnmergedCommits(wt.root), "刚建的副本无独立提交")
        // 改动未提交 → 脏
        Files.writeString(wt.root.resolve("a.txt"), "changed")
        assertEquals(true, cli.isDirty(wt.root))
        // 提交后不脏，但形成 1 个不可达提交（detached）
        git(wt.root, "add", "-A")
        git(wt.root, "commit", "-m", "wip")
        assertEquals(false, cli.isDirty(wt.root))
        assertEquals(1, cli.countUnmergedCommits(wt.root), "分支外提交应被计数")
    }

    @Test
    fun `删除守卫语义 脏目录需 force 普通可删`() {
        val repo = initRepo()
        val base = base()
        // 脏目录：不加 force 被 git 拒绝
        val dirty = cli.createManagedWorktree(repo, base, "HEAD")
        Files.writeString(dirty.root.resolve("a.txt"), "dirty")
        val ex = assertIs<GitWorktreeCli.GitWorktreeException>(runCatching {
            cli.removeManagedWorktree(repo, dirty.root, force = false)
        }.exceptionOrNull())
        assertEquals("git-failed", ex.code)
        cli.removeManagedWorktree(repo, dirty.root, force = true)
        assertFalse(Files.exists(dirty.root), "force 删除后目录已清")
        assertTrue(cli.listManagedWorktrees(repo, base).isEmpty())
        // 干净目录：不加 force 可删
        val clean = cli.createManagedWorktree(repo, base, "HEAD")
        cli.removeManagedWorktree(repo, clean.root, force = false)
        assertFalse(Files.exists(clean.root))
    }

    @Test
    fun `目录缺失标记 missing 并可 prune`() {
        val repo = initRepo()
        val base = base()
        val wt = cli.createManagedWorktree(repo, base, "HEAD")
        deleteAll(wt.root)
        val managed = cli.listManagedWorktrees(repo, base)
        assertEquals(1, managed.size, "prune 前记录仍在")
        assertEquals("missing", managed[0].state)
        assertNull(managed[0].dirty)
        cli.prune(repo)
        assertTrue(cli.listManagedWorktrees(repo, base).isEmpty(), "prune 后 git 记录清除")
    }

    @Test
    fun `起点子目录缺失报 start-ref-missing-subdir`() {
        val repo = initRepo()
        val sub = Files.createDirectory(repo.resolve("sub"))
        Files.writeString(sub.resolve("b.txt"), "x")
        git(repo, "add", "-A")
        git(repo, "commit", "-m", "with sub")
        // 起点 HEAD 的树里有 sub；但用「sub 不存在的更早提交」→ 解析失败
        val firstSha = git(repo, "rev-list", "--max-parents=0", "HEAD").trim()
        val ex = assertIs<GitWorktreeCli.GitWorktreeException>(runCatching {
            cli.createManagedWorktree(sub, base(), firstSha)
        }.exceptionOrNull())
        assertEquals("start-ref-missing-subdir", ex.code)
    }

    @Test
    fun `托管路径解析 桶结构校验`() {
        val base = base()
        val ok = base.resolve(".zcode").resolve("worktrees").resolve("ab12").resolve("repo")
        val parsed = cli.parseManagedWorktreePath(base, ok)
        assertEquals("ab12", parsed?.bucket)
        assertEquals("repo", parsed?.name)
        assertEquals("", parsed?.relativePath)
        val deep = cli.parseManagedWorktreePath(base, ok.resolve("sub").resolve("f.txt"))
        assertEquals("sub", deep?.relativePath?.split(File.separatorChar)?.first())
        // 非 4hex 桶 / 根外 / 深度不足
        assertNull(cli.parseManagedWorktreePath(base, base.resolve(".zcode").resolve("worktrees").resolve("abcdX").resolve("repo")))
        assertNull(cli.parseManagedWorktreePath(base, base.resolve("somewhere").resolve("ab12").resolve("repo")))
        assertNull(cli.parseManagedWorktreePath(base, base.resolve(".zcode").resolve("worktrees").resolve("ab12")))
    }

    // ============ 起点变更洞察（2026-11-14，spec #52 追评）============

    @Test
    fun `起点变更列表 注册表口径与游离口径`() {
        val repo = initRepo()
        val startSha = cli.headSha(repo)!!
        val wt = cli.createManagedWorktree(repo, base(), "HEAD")
        // worktree 里两个游离提交
        Files.writeString(wt.root.resolve("a.txt"), "w1")
        git(wt.root, "add", "-A")
        git(wt.root, "commit", "-m", "w1")
        val w1 = cli.headSha(wt.root)!!
        Files.writeString(wt.root.resolve("a.txt"), "w2")
        git(wt.root, "add", "-A")
        git(wt.root, "commit", "-m", "w2")
        val w2 = cli.headSha(wt.root)!!
        // 主分支在创建后继续前进（模拟主窗口并行开发）
        Files.writeString(repo.resolve("a.txt"), "on main")
        git(repo, "add", "-A")
        git(repo, "commit", "-m", "on main")

        // 注册表口径：startSha..HEAD = worktree 全部提交
        val byRegistry = cli.listChangesSince(wt.root, startSha)!!
        assertEquals(listOf(w2, w1), byRegistry.commits.map { it.sha })
        // 游离口径（桌面端副本无注册起点）：主分支可达的提交不算，只余 worktree 干的活
        val unmerged = cli.listChangesSince(wt.root, null)!!
        assertEquals(listOf(w2, w1), unmerged.commits.map { it.sha }, "游离口径排除主分支可达提交")
        // startSha 失联（对象库无此提交）自动退游离口径，不返回 null
        val stale = cli.listChangesSince(wt.root, "0123456789abcdef0123456789abcdef01234567")!!
        assertEquals(listOf(w2, w1), stale.commits.map { it.sha })
        assertEquals(w2, unmerged.headSha)
    }

    @Test
    fun `未合并提交集 cherry 口径`() {
        val repo = initRepo()
        val startSha = cli.headSha(repo)!!
        val mainBranch = cli.headBranch(repo)!!
        val wt = cli.createManagedWorktree(repo, base(), "HEAD")
        Files.writeString(wt.root.resolve("a.txt"), "w1")
        git(wt.root, "add", "-A")
        git(wt.root, "commit", "-m", "w1")
        val w1 = cli.headSha(wt.root)!!
        Files.writeString(wt.root.resolve("a.txt"), "w2")
        git(wt.root, "add", "-A")
        git(wt.root, "commit", "-m", "w2")
        val w2 = cli.headSha(wt.root)!!

        // 全部未合并：两个提交都在 "+" 集
        assertEquals(setOf(w1, w2), cli.unmergedCommitShas(wt.root, mainBranch, w2))
        // ff 合并回主分支：上游可达不进候选集，未合并集为空 = 全部已合并
        git(repo, "merge", "--ff-only", w2)
        assertEquals(emptySet<String>(), cli.unmergedCommitShas(wt.root, mainBranch, w2))
        // cherry-pick 落地（换 sha）：patch 等价也算已合并，未 pick 的仍算未合并
        git(repo, "reset", "--hard", startSha)
        git(repo, "cherry-pick", w1)
        assertEquals(setOf(w2), cli.unmergedCommitShas(wt.root, mainBranch, w2))
        // 上游分支不存在：查询失败返回 null（节点不渲染合并标识）
        assertNull(cli.unmergedCommitShas(wt.root, "no-such-ref", w2))
    }

    @Test
    fun `起点变更列表 提交与未提交`() {
        val repo = initRepo()
        val startSha = cli.headSha(repo)!!
        val wt = cli.createManagedWorktree(repo, base(), "HEAD")
        // 提交1：改 a + 新建 b；提交2：改 b
        Files.writeString(wt.root.resolve("a.txt"), "changed")
        Files.writeString(wt.root.resolve("b.txt"), "new")
        git(wt.root, "add", "-A")
        git(wt.root, "commit", "-m", "commit1")
        val commit1 = cli.headSha(wt.root)!!
        Files.writeString(wt.root.resolve("b.txt"), "v2")
        git(wt.root, "add", "-A")
        git(wt.root, "commit", "-m", "commit2")
        val commit2 = cli.headSha(wt.root)!!
        // 未提交：改 a + untracked c
        Files.writeString(wt.root.resolve("a.txt"), "dirty")
        Files.writeString(wt.root.resolve("c.txt"), "untracked")

        val snap = cli.listChangesSince(wt.root, startSha)!!
        assertEquals(listOf(commit2, commit1), snap.commits.map { it.sha }, "提交按新→旧")
        assertEquals("commit2", snap.commits[0].subject)
        assertEquals(listOf('M'), snap.commits[0].files.map { it.status })
        assertEquals(listOf('M', 'A'), snap.commits[1].files.map { it.status })
        assertEquals(0, snap.commits[0].files.count { it.path == "a.txt" }, "提交2 不含 a.txt")
        // 未提交 = diff(HEAD) ∪ untracked
        val uncommitted = snap.uncommitted.associateBy { it.path }
        assertEquals('M', uncommitted["a.txt"]?.status)
        assertEquals('A', uncommitted["c.txt"]?.status, "untracked 归为新增")
        assertNull(uncommitted["b.txt"], "已提交内容不算未提交")
        assertEquals(commit2, snap.headSha)
    }

    @Test
    fun `起点变更列表 rename 与零变更`() {
        val repo = initRepo()
        val startSha = cli.headSha(repo)!!
        val wt = cli.createManagedWorktree(repo, base(), "HEAD")
        // 零变更空态
        val empty = cli.listChangesSince(wt.root, startSha)!!
        assertTrue(empty.commits.isEmpty() && empty.uncommitted.isEmpty())
        // rename：R 状态带 oldPath
        git(wt.root, "mv", "a.txt", "renamed.txt")
        git(wt.root, "commit", "-m", "move")
        val snap = cli.listChangesSince(wt.root, startSha)!!
        val f = snap.commits[0].files.single()
        assertEquals('R', f.status)
        assertEquals("a.txt", f.oldPath)
        assertEquals("renamed.txt", f.path)
    }

    @Test
    fun `blob 回读`() {
        val repo = initRepo()
        val sha = cli.headSha(repo)!!
        val wt = cli.createManagedWorktree(repo, base(), "HEAD")
        assertEquals("hello", cli.blobBytes(wt.root, "$sha:a.txt")?.toString(Charsets.UTF_8))
        assertNull(cli.blobBytes(wt.root, "$sha:missing.txt"), "路径不存在返回 null")
        assertNull(cli.blobBytes(wt.root, "deadbeef:a.txt"), "sha 失效返回 null")
    }

    @Test
    fun `提交时间取 committer 时刻且列表从新到旧`() {
        val repo = initRepo()
        val wt = cli.createManagedWorktree(repo, base(), "HEAD")
        // c1 正常提交（现在）——提交落在 worktree 游离 HEAD 上（分支可达的会被游离口径排除）
        Files.writeString(wt.root.resolve("a.txt"), "one")
        git(wt.root, "add", ".")
        git(wt.root, "commit", "-m", "c1 now")
        // c2 committer/author date 都拨到两天前（模拟滞后落库/补交）
        val old = "2000-01-01T00:00:00+0000"
        Files.writeString(wt.root.resolve("a.txt"), "two")
        git(wt.root, "add", ".")
        gitEnv(wt.root, mapOf("GIT_COMMITTER_DATE" to old, "GIT_AUTHOR_DATE" to old), "commit", "-m", "c2 old")
        val changes = cli.listChangesSince(wt.root, null, knownHeadSha = cli.headSha(wt.root))!!
        // 时间字段 = %ct（committer 操作时刻）：c2 的 time 是拨过去的旧值而非当前钟
        val c1 = changes.commits.first { it.subject == "c1 now" }
        val c2 = changes.commits.first { it.subject == "c2 old" }
        assertTrue(c2.time < c1.time - 24 * 3600, "committer 时间应取 %ct：c2=${c2.time} c1=${c1.time}")
        // 严格时间降序（拓扑让位）：时间新的 c1 排第一，即使它是 c2 的父辈
        assertEquals("c1 now", changes.commits.first().subject)
    }
}
