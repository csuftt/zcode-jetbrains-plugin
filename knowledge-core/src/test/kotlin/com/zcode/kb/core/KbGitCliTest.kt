package com.zcode.kb.core

import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
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
        repo = Files.createTempDirectory("kb-git-test")
        g("init")
        g("config", "user.email", "t@t")
        g("config", "user.name", "t")
        g("config", "core.autocrlf", "false")
        Files.createDirectories(repo!!.resolve("docs"))
        Files.writeString(repo!!.resolve("docs/指南.md"), "# 指南\n内容 v1")
        g("add", "-A")
        g("commit", "-m", "init")
        return repo!!
    }

    private fun g(vararg args: String) {
        val p = ProcessBuilder("git", *args).directory(repo!!.toFile()).start()
        p.inputStream.readBytes()
        p.errorStream.readBytes()
        assertEquals(0, p.waitFor(), "git ${args.joinToString(" ")} 失败")
    }

    /** 文件最近一次提交的短哈希（对照值，与被测方法同源于 git 自身） */
    private fun shortHead(): String {
        val p = ProcessBuilder("git", "rev-parse", "--short", "HEAD").directory(repo!!.toFile()).start()
        val out = String(p.inputStream.readBytes(), Charsets.UTF_8).trim()
        assertEquals(0, p.waitFor())
        return out
    }

    @Test
    fun `repoRoot is the git top level of a tracked file`() {
        val root = newRepo()
        assertEquals(root.toAbsolutePath().normalize(), cli.repoRoot(root.resolve("docs/指南.md")))
    }

    @Test
    fun `file outside git repo has no repo root`() {
        org.junit.jupiter.api.Assumptions.assumeTrue(gitAvailable, "git 不可用，跳过")
        val dir = Files.createTempDirectory("kb-nogit")
        val f = dir.resolve("a.md")
        Files.writeString(f, "x")
        assertNull(cli.repoRoot(f))
        dir.toFile().deleteRecursively()
    }

    // ── 提交状态（收录/编辑弹窗「Git 提交」行） ──

    @Test
    fun `historyOf reports last commit of clean tracked file`() {
        val root = newRepo()
        g("commit", "--allow-empty", "-m", "另一个无关提交") // HEAD 已前移：文件显示的是它自己的提交
        val h = cli.historyOf(root.resolve("docs/指南.md"))!!
        assertEquals("init", h.commit!!.subject)
        kotlin.test.assertNotEquals(shortHead(), h.commit!!.hash)
        assertTrue(Regex("\\d{4}-\\d{2}-\\d{2}").matches(h.commit!!.date), h.commit!!.date)
        assertEquals("docs/指南.md", h.relPath)
        assertEquals(root.toAbsolutePath().normalize(), h.repoRoot)
        kotlin.test.assertFalse(h.dirty)
        kotlin.test.assertFalse(h.ignored)
    }

    @Test
    fun `historyOf flags uncommitted modification but keeps last commit`() {
        val root = newRepo()
        Files.writeString(root.resolve("docs/指南.md"), "# 指南\n内容 v2")
        val h = cli.historyOf(root.resolve("docs/指南.md"))!!
        assertEquals("init", h.commit!!.subject)
        assertTrue(h.dirty)
    }

    @Test
    fun `historyOf untracked file has no commit`() {
        val root = newRepo()
        Files.writeString(root.resolve("docs/新文档.md"), "x")
        val h = cli.historyOf(root.resolve("docs/新文档.md"))!!
        assertNull(h.commit)
        assertTrue(h.dirty)
        kotlin.test.assertFalse(h.ignored)
    }

    @Test
    fun `historyOf ignored file is marked ignored`() {
        val root = newRepo()
        Files.writeString(root.resolve(".gitignore"), "build/\n")
        Files.createDirectories(root.resolve("build"))
        Files.writeString(root.resolve("build/out.md"), "x")
        val h = cli.historyOf(root.resolve("build/out.md"))!!
        assertNull(h.commit)
        assertTrue(h.ignored)
        kotlin.test.assertFalse(h.dirty)
    }

    @Test
    fun `historyOf file outside git repo is null`() {
        org.junit.jupiter.api.Assumptions.assumeTrue(gitAvailable, "git 不可用，跳过")
        val dir = Files.createTempDirectory("kb-nogit")
        val f = dir.resolve("a.md")
        Files.writeString(f, "x")
        assertNull(cli.historyOf(f))
        dir.toFile().deleteRecursively()
    }

    @Test
    fun `pathspec metacharacters in file name are matched literally`() {
        val root = newRepo()
        // 当通配时 `部署[测试].md` 匹配的是 部署测.md / 部署试.md，匹配不到它自己
        Files.writeString(root.resolve("docs/部署[测试].md"), "x")
        g("add", "-A")
        g("commit", "-m", "方括号文件名")
        val h = cli.historyOf(root.resolve("docs/部署[测试].md"))!!
        assertEquals("方括号文件名", h.commit!!.subject)
        kotlin.test.assertFalse(h.dirty)
    }
}
