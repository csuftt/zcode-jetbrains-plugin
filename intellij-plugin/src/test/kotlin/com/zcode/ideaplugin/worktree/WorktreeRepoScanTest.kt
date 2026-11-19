package com.zcode.ideaplugin.worktree

import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * WorktreeRepoScan 纯函数测试（缺陷HU）：被列目录 → 所在仓库 → 副本执行根。
 *
 * 不依赖 git/IntelliJ：toplevel/roots 全注入，覆盖非 git 短路、子目录映射、
 * 同名仓库隔离（只采信 provider 给的本仓库副本）、TTL 与负缓存、主动失效代数。
 */
class WorktreeRepoScanTest {

    @TempDir
    lateinit var tmp: Path

    private lateinit var repo: Path
    private lateinit var roots: List<GitWorktreeCli.ManagedRootInfo>
    private var now = 1_000L
    private var toplevelCalls = 0
    private var rootsCalls = 0

    @BeforeEach
    fun setUp() {
        repo = tmp.resolve("repo")
        roots = listOf(
            GitWorktreeCli.ManagedRootInfo("ab12", "repo", tmp.resolve("wt/ab12/repo"), exists = true),
            GitWorktreeCli.ManagedRootInfo("cd34", "repo", tmp.resolve("wt/cd34/repo"), exists = false),
        )
        now = 1_000L
        toplevelCalls = 0
        rootsCalls = 0
    }

    private fun scanner(
        toplevel: (Path) -> Path? = { repo },
    ) = WorktreeRepoScan(
        toplevelOf = { dir -> toplevelCalls++; toplevel(dir) },
        rootsOf = { r -> rootsCalls++; if (r == repo) roots else emptyList() },
        ttlMs = 30_000L,
        clock = { now },
    )

    @Test
    fun `非 git 目录返回空并缓存负结果`() {
        val scan = scanner { null }
        val first = scan.scan(repo)
        assertFalse(first.isRepository)
        assertTrue(first.roots.isEmpty())
        assertEquals(".", first.relativePath)
        // TTL 内第二次命中负缓存，不再问 provider
        scan.scan(repo)
        assertEquals(1, toplevelCalls)
    }

    @Test
    fun `仓库根映射副本根 子目录映射到副本内执行根`() {
        val scan = scanner()
        val atRoot = scan.scan(repo)
        assertTrue(atRoot.isRepository)
        assertEquals(".", atRoot.relativePath)
        assertEquals(roots[0].root, atRoot.execRootFor(roots[0]))
        assertEquals(roots[1].root, atRoot.execRootFor(roots[1]))

        now += 60_000L // 越过 TTL，换上子目录调用
        val fromSub = scan.scan(repo.resolve("sub/dir"))
        assertEquals("sub/dir", fromSub.relativePath)
        assertEquals(repo, fromSub.repoRoot)
        assertEquals(roots[0].root.resolve("sub/dir"), fromSub.execRootFor(roots[0]))
        // 缓存键=被列目录：根目录与子目录各自一次；同一目录的重复列表请求才命中 TTL
        assertEquals(2, rootsCalls)
    }

    @Test
    fun `同名仓库不互串 只采信 provider 给的本仓库副本`() {
        val otherRepo = tmp.resolve("clone2/repo")
        val scan = WorktreeRepoScan(
            toplevelOf = { otherRepo },
            rootsOf = { r ->
                rootsCalls++
                // 模拟 git 只回该仓库自己的副本：别的仓库即便同名也不返回
                if (r == otherRepo) emptyList() else roots
            },
            ttlMs = 30_000L,
            clock = { now },
        )
        val result = scan.scan(otherRepo)
        assertTrue(result.isRepository)
        assertTrue(result.roots.isEmpty(), "别家同名仓库的副本不会因名字相同被采信")
    }

    @Test
    fun `TTL 过期后重扫`() {
        val scan = scanner()
        scan.scan(repo)
        assertEquals(1, toplevelCalls)
        now += 29_999L
        scan.scan(repo)
        assertEquals(1, toplevelCalls, "TTL 内命中缓存")
        now += 2L
        scan.scan(repo)
        assertEquals(2, toplevelCalls)
    }

    @Test
    fun `主动失效代数让缓存立即过期`() {
        val scan = scanner()
        scan.scan(repo)
        assertEquals(1, toplevelCalls)
        WorktreeRepoScan.bumpGeneration()
        scan.scan(repo)
        assertEquals(2, toplevelCalls)
    }

    @Test
    fun `relativeTo 不把前缀相似目录误判为子目录`() {
        assertEquals(".", WorktreeRepoScan.relativeTo(repo, repo))
        assertEquals("sub", WorktreeRepoScan.relativeTo(repo, repo.resolve("sub")))
        assertNull(WorktreeRepoScan.relativeTo(repo, tmp.resolve("repo2")))
        assertNull(WorktreeRepoScan.relativeTo(repo, tmp.resolve("other")))
    }
}