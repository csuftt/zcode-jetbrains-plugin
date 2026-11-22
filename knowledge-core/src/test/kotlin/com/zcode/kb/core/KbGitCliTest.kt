package com.zcode.kb.core

import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * 对真实临时 git 仓直跑（GitWorktreeCliTest 同款纪律）。
 * 前提：环境有 git（无 git 时 assumeTrue 跳过）。
 */
class KbGitCliTest {

    private val cli = KbGitCli()
    private val gitAvailable: Boolean by lazy {
        runCatching { ProcessBuilder("git", "--version").start().waitFor() == 0 }.getOrDefault(false)
    }

    private var repo: Path? = null

    @AfterTest
    fun tearDown() {
        repo?.toFile()?.deleteRecursively()
    }

    private fun newRepo(): Path {
        org.junit.jupiter.api.Assumptions.assumeTrue(gitAvailable, "git 不可用，跳过")
        val dir = Files.createTempDirectory("kb-git-test")
        fun g(vararg args: String) {
            val p = ProcessBuilder("git", *args).directory(dir.toFile()).start()
            p.inputStream.readBytes()
            p.errorStream.readBytes()
            assertEquals(0, p.waitFor(), "git ${args.joinToString(" ")} 失败")
        }
        g("init")
        g("config", "user.email", "t@t")
        g("config", "user.name", "t")
        g("config", "core.autocrlf", "false")
        Files.createDirectories(dir.resolve("docs"))
        Files.writeString(dir.resolve("docs/指南.md"), "# 指南\n内容 v1")
        g("add", "-A")
        g("commit", "-m", "init")
        repo = dir
        return dir
    }

    @Test
    fun `anchor captures root commit and rel path`() {
        val root = newRepo()
        val a = cli.anchor(root.resolve("docs/指南.md"))
        assertNotNull(a)
        assertEquals(root.toAbsolutePath().normalize().toString().replace('\\', '/'), a.repoRoot.toString().replace('\\', '/'))
        assertEquals(40, a.commit.length)
        assertEquals("docs/指南.md", a.relPath)
        assertTrue(cli.hasBlob(a.repoRoot.toString(), a.commit, a.relPath))
    }

    @Test
    fun `file outside git repo returns null anchor`() {
        org.junit.jupiter.api.Assumptions.assumeTrue(gitAvailable, "git 不可用，跳过")
        val dir = Files.createTempDirectory("kb-nogit")
        val f = dir.resolve("a.md")
        Files.writeString(f, "x")
        assertNull(cli.anchor(f))
        dir.toFile().deleteRecursively()
    }

    @Test
    fun `restore blob after source deleted`() {
        val root = newRepo()
        val a = cli.anchor(root.resolve("docs/指南.md"))!!
        // 模拟分支切换：源文件消失
        Files.delete(root.resolve("docs/指南.md"))
        kotlin.test.assertFalse(Files.exists(root.resolve("docs/指南.md")))

        val target = root.resolve("restored/kb-x/指南.md")
        assertTrue(cli.restoreBlob(a.repoRoot.toString(), a.commit, a.relPath, target))
        assertEquals("# 指南\n内容 v1", Files.readString(target))
    }

    @Test
    fun `hasBlob false for untracked file commit`() {
        val root = newRepo()
        val a = cli.anchor(root.resolve("docs/指南.md"))!!
        // 未跟踪文件的假 rel：blob 不存在
        kotlin.test.assertFalse(cli.hasBlob(a.repoRoot.toString(), a.commit, "docs/不存在.md"))
    }
}
