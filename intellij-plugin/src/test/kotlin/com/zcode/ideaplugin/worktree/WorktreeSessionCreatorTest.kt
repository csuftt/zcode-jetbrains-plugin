package com.zcode.ideaplugin.worktree

import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * worktree 会话创建编排测试：真实临时仓库直跑（最高缝），建会话以 lambda 假依赖注入。
 * 覆盖：阶段序/信息字段/子目录 cwd 映射/git 失败不建会话/会话失败保留 worktree 不落注册表。
 */
class WorktreeSessionCreatorTest {

    @TempDir
    lateinit var tmp: Path

    private val cli = GitWorktreeCli(timeoutMs = 30_000L)

    private fun git(dir: Path, vararg args: String): String {
        val pb = ProcessBuilder(listOf("git") + args.toList())
            .directory(dir.toFile())
            .redirectErrorStream(true)
        pb.environment().apply { put("LC_ALL", "C"); put("LANG", "C") }
        val p = pb.start()
        val out = p.inputStream.readBytes().toString(Charsets.UTF_8)
        assertTrue(p.waitFor(30, TimeUnit.SECONDS), "git 超时")
        assertEquals(0, p.exitValue(), "git 失败: $out")
        return out
    }

    private fun initRepo(withSub: Boolean = false): Path {
        val dir = Files.createDirectory(tmp.resolve("repo-${System.nanoTime()}"))
        git(dir, "init")
        git(dir, "config", "user.email", "t@example.com")
        git(dir, "config", "user.name", "t")
        Files.writeString(dir.resolve("a.txt"), "hello")
        if (withSub) {
            val sub = Files.createDirectory(dir.resolve("sub"))
            Files.writeString(sub.resolve("b.txt"), "x")
            git(dir, "add", "-A")
        } else {
            git(dir, "add", ".")
        }
        git(dir, "commit", "-m", "init")
        return dir
    }

    private fun creator(): WorktreeSessionCreator = WorktreeSessionCreator(cli, tmp.resolve("basedata"))

    companion object {
        @JvmStatic
        @BeforeAll
        fun requireGit() {
            val ok = try {
                val p = ProcessBuilder("git", "--version").start()
                p.waitFor(10, TimeUnit.SECONDS) && p.exitValue() == 0
            } catch (e: Exception) { false }
            assumeTrue(ok, "git 不在 PATH，跳过")
        }
    }

    @Test
    fun `成功链路 阶段序与注册表信息`() {
        val repo = initRepo()
        val headSha = git(repo, "rev-parse", "HEAD").trim()
        val phases = mutableListOf<WorktreeSessionCreator.Phase>()
        var receivedCwd: Path? = null
        val r = creator().create(repo, "HEAD", createSession = { cwd -> receivedCwd = cwd; "sess_ok-1" }, onPhase = phases::add)

        assertEquals(listOf(
            WorktreeSessionCreator.Phase.PREPARING,
            WorktreeSessionCreator.Phase.CREATING,
            WorktreeSessionCreator.Phase.STARTING,
        ), phases)
        assertEquals("sess_ok-1", r.sessionId)
        assertEquals(receivedCwd!!.toString(), r.info.cwd)
        assertEquals(r.info.worktreeRoot, receivedCwd!!.toString(), "仓库根项目 cwd=worktree 根")
        assertEquals(repo.toAbsolutePath().normalize().toString(), r.info.sourceWorkspace)
        assertEquals(headSha, r.info.startSha, "起点发送时刻定版")
        assertEquals("HEAD", r.info.startRef)
        assertEquals(4, r.info.bucket.length)
        assertTrue(r.info.createdAt > 0)
        // 注册表序列化回环
        assertEquals(listOf(r.info), WorktreeRegistryStore.parse(WorktreeRegistryStore.serialize(listOf(r.info))))
    }

    @Test
    fun `仓库子目录 执行根映射到 worktree 内对应子目录`() {
        val repo = initRepo(withSub = true)
        val sub = repo.resolve("sub")
        val r = creator().create(sub, "HEAD", createSession = { "sess_sub-1" })
        assertTrue(r.info.cwd.endsWith("sub"), "执行根 = worktree 根 + 相对路径: ${r.info.cwd}")
        assertTrue(Files.exists(Path.of(r.info.worktreeRoot)))
        assertTrue(r.info.cwd.startsWith(r.info.worktreeRoot))
    }

    @Test
    fun `git 失败 不建会话`() {
        val repo = initRepo()
        var called = false
        val ex = assertFailsWith<GitWorktreeCli.GitWorktreeException> {
            creator().create(repo, "no-such-branch", { called = true; "sess_x" })
        }
        assertEquals("invalid-start-ref", ex.code)
        assertEquals(false, called, "git 失败不得触发建会话")
    }

    @Test
    fun `会话失败 worktree 保留 不落注册表`() {
        val repo = initRepo()
        val r = runCatching {
            creator().create(repo, "HEAD", createSession = { throw IllegalStateException("session-failed") })
        }
        assertTrue(r.isFailure, "建会话异常向上传播")
        // worktree 保留（桌面同款：worktree 已创建，但任务启动失败）
        val managed = cli.listManagedWorktrees(repo, tmp.resolve("basedata"))
        assertEquals(1, managed.size, "worktree 保留供重试或手动清理")
        assertEquals("ok", managed[0].state)
    }
}
