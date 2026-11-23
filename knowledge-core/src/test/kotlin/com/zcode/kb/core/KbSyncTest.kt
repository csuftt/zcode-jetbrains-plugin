package com.zcode.kb.core

import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.condition.EnabledOnOs
import org.junit.jupiter.api.condition.OS
import org.junit.jupiter.api.io.TempDir
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.FileTime
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * 知识库 git 同步（KbSync）——共用实现的入口。在临时目录里搭一个知识库、若干源文件和一个
 * 裸远端仓，用真实 git 跑，只断言外部可见的结果：远端提交与文件字节、冲突时的本地状态、
 * 同步结果。前提：环境有 git（无 git 时 assumeTrue 跳过）。
 *
 * 换行转换：仓库属性全仓关闭换行转换，测试仓显式开着 core.autocrlf=true（本机全局也是 true），
 * 才测得出「工作区字节、提交内容、源文件三者一致」。
 */
class KbSyncTest {

    @TempDir
    lateinit var dir: Path

    /** 换电脑用例的用户目录：入口联接建在它下面，不碰真实的用户目录 */
    @TempDir
    lateinit var home: Path

    private val gitAvailable: Boolean by lazy {
        runCatching { ProcessBuilder("git", "--version").start().waitFor() == 0 }.getOrDefault(false)
    }

    /** 机器 A 上的库（主库） */
    private lateinit var root: Path

    /** 裸远端 */
    private lateinit var remote: Path

    private val bom = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte())

    /** CRLF + BOM 的样本：开着换行转换的 git 下最容易被改掉字节 */
    private val crlfDoc: ByteArray get() = bom + "标题\r\n第一行\r\n".toByteArray(StandardCharsets.UTF_8)

    private val id = "kb-aaaa1111"

    @BeforeTest
    fun setUp() {
        assumeTrue(gitAvailable, "git 不可用，跳过")
        root = dir.resolve("libA")
        remote = dir.resolve("remote.git")
        Files.createDirectories(dir.resolve("src"))
        // 托管平台形态的远端：默认分支 main（手工 git init --bare 的裸仓默认分支见专门用例）
        g(dir, "init", "-q", "--bare", "-b", "main", remote.toString())
    }

    @AfterTest
    fun tearDown() {
        // git 对象文件只读，JUnit 清临时目录前先放开
        listOf(dir, home).forEach { d -> d.toFile().walkBottomUp().forEach { it.setWritable(true) } }
    }

    // ───────────────────────── 工具 ─────────────────────────

    private fun runGit(cwd: Path, vararg args: String): Pair<Int, ByteArray> {
        val p = ProcessBuilder(listOf("git", "-c", "core.quotepath=off", *args)).directory(cwd.toFile()).start()
        val errDrain = Thread({ p.errorStream.readBytes() }, "kb-sync-test-err").apply { isDaemon = true }
        errDrain.start()
        val out = p.inputStream.readBytes()
        assertTrue(p.waitFor(60, TimeUnit.SECONDS), "git ${args.joinToString(" ")} 超时")
        return p.exitValue() to out
    }

    private fun g(cwd: Path, vararg args: String): String {
        val (code, out) = runGit(cwd, *args)
        assertEquals(0, code, "git ${args.joinToString(" ")} 失败")
        return String(out, StandardCharsets.UTF_8)
    }

    private fun gExit(cwd: Path, vararg args: String): Int = runGit(cwd, *args).first

    /** 测试仓自带身份与「开启换行转换」，不依赖本机全局配置 */
    private fun configure(repo: Path) {
        g(repo, "config", "user.name", "kb-test")
        g(repo, "config", "user.email", "kb-test@example.com")
        g(repo, "config", "core.autocrlf", "true")
    }

    private fun source(name: String, bytes: ByteArray): Path =
        dir.resolve("src").also { Files.createDirectories(it) }.resolve(name).also { Files.write(it, bytes) }

    /** 仿 IDE 收录：文档快照 + 条目（带内容哈希）+ 检索缓存 */
    private fun ingest(store: KbFileStore, entryId: String, src: Path) {
        val display = src.toString().replace('\\', '/')
        val captured = KbContent.capture(store.root(), entryId, display)
        store.insert(
            KbEntry(
                id = entryId, sourcePath = display, title = src.fileName.toString(),
                sizeBytes = captured.size, contentHash = captured.hash, ingestedAt = 100, updatedAt = 100,
            ),
            Files.readString(src),
        )
    }

    private val plainExtractor = KbContent.TextExtractor { Files.readString(it) }

    private fun reconcile(store: KbFileStore): Int =
        KbContent.reconcile(store.root(), store.contentSources(), plainExtractor) { i, hash, size ->
            store.confirmContent(i, hash, size)
        }

    /** 配好远端、推一个提交上去：之后各用例从这个「两机同步过」的状态出发 */
    private fun seedAndPush(): Path {
        val src = source("指南.md", crlfDoc)
        KbFileStore(root).use { store ->
            ingest(store, id, src)
            store.createFolder(null, "运维")
        }
        assertNull(KbSync.setRemoteUrl(root, "git", remote.toString()))
        configure(root)
        assertEquals(KbSync.Outcome.PUSHED, KbSync.sync(root, "git").outcome)
        return src
    }

    /** 机器 B：从远端克隆一份（库位置 = 克隆目录），同样配测试身份 */
    private fun secondClone(name: String = "libB"): Path =
        dir.resolve(name).also {
            g(dir, "-c", "core.autocrlf=true", "clone", "-q", remote.toString(), it.toString())
            configure(it)
        }

    private fun remoteTree(): List<String> = g(remote, "ls-tree", "-r", "--name-only", "main").lines().filter { it.isNotEmpty() }

    private fun remoteHead(): String = g(remote, "rev-parse", "main").trim()

    private fun snapshotPaths(repo: Path): List<String> =
        g(repo, "ls-tree", "-r", "--name-only", "HEAD").lines().filter { it.startsWith("snapshots/") }

    // ───────────────────────── 首次同步 ─────────────────────────

    @Test
    fun `first sync initializes the repository, commits metadata with snapshots and pushes`() {
        val src = source("指南.md", crlfDoc)
        KbFileStore(root).use { store ->
            ingest(store, id, src)
            store.createFolder(null, "运维")

            assertNull(KbSync.remoteUrl(root, "git")) // 未配置远端
            assertNull(KbSync.setRemoteUrl(root, "git", remote.toString()))
            configure(root)
            assertTrue(KbSync.isRepository(root))
            assertEquals(remote.toString(), KbSync.remoteUrl(root, "git"))

            val r = KbSync.sync(root, "git")

            assertEquals(KbSync.Outcome.PUSHED, r.outcome)
            assertEquals(1, r.pushedCommits)
            assertFalse(r.pulled)
            val tree = remoteTree()
            assertTrue("config.json" in tree, tree.toString())
            assertTrue("entries/$id.json" in tree, tree.toString())
            assertTrue("snapshots/$id/指南.md" in tree, tree.toString())
            assertTrue(".gitignore" in tree && ".gitattributes" in tree, tree.toString())
            // 检索缓存与本机缓存可重建 / 只对本机有意义：不进历史
            assertTrue(tree.none { it.startsWith("text/") || it.contains("local-cache") }, tree.toString())
            assertTrue(Files.exists(root.resolve("text/$id.txt"))) // 文件本身还在，只是被忽略
            assertTrue(Files.readString(root.resolve(".gitattributes")).contains("snapshots/** -text -diff -merge"))
            assertFalse(KbSync.hasUnsyncedChanges(root, "git"))
        }
    }

    @Test
    fun `snapshot bytes are identical in the commit and in a fresh clone under autocrlf`() {
        val src = source("指南.md", crlfDoc)
        KbFileStore(root).use { store ->
            ingest(store, id, src)
            assertNull(KbSync.setRemoteUrl(root, "git", remote.toString()))
            configure(root)
            KbSync.sync(root, "git")
        }
        // 提交里的 blob：与源文件逐字节一致（CRLF 与 BOM 原样）
        val (_, blob) = runGit(remote, "cat-file", "blob", "main:snapshots/$id/指南.md")
        assertContentEquals(crlfDoc, blob)
        // 另一台机器克隆出来的工作区文件
        val clone = secondClone("fresh")
        assertContentEquals(crlfDoc, Files.readAllBytes(clone.resolve("snapshots/$id/指南.md")))
        // 本机工作区的快照也没被动过
        assertContentEquals(crlfDoc, Files.readAllBytes(root.resolve("snapshots/$id/指南.md")))
    }

    @Test
    fun `first push follows the remote default branch so a plain bare repository clones cleanly`() {
        val trunkRemote = dir.resolve("trunk-remote.git")
        g(dir, "init", "-q", "--bare", "-b", "trunk", trunkRemote.toString())
        val lib = dir.resolve("libT")
        KbFileStore(lib).use { ingest(it, id, source("指南.md", crlfDoc)) }
        assertNull(KbSync.setRemoteUrl(lib, "git", trunkRemote.toString()))
        configure(lib)

        val r = KbSync.sync(lib, "git")

        assertEquals(KbSync.Outcome.PUSHED, r.outcome)
        assertEquals("trunk", g(lib, "branch", "--show-current").trim()) // 本地分支改成远端默认分支的名字
        assertEquals("1", g(trunkRemote, "rev-list", "--count", "trunk").trim())
        assertEquals(1, g(trunkRemote, "branch", "--list").lines().count { it.isNotBlank() }) // 没有多出一条 main
        // 之后的克隆直接检出内容，不是空目录
        val clone = dir.resolve("clone-of-trunk")
        g(dir, "clone", "-q", trunkRemote.toString(), clone.toString())
        assertTrue(Files.exists(clone.resolve("entries/$id.json")))
        assertEquals("trunk", g(clone, "branch", "--show-current").trim())
        assertFalse(KbSync.hasUnsyncedChanges(lib, "git")) // 上游跟踪已建立
        assertEquals(KbSync.Outcome.UP_TO_DATE, KbSync.sync(lib, "git").outcome)
    }

    @Test
    fun `a renamed local branch is pushed to the remote default branch it descends from`() {
        seedAndPush()
        g(root, "branch", "-m", "kb") // 用户在本地把分支改了名：远端只有 main

        assertEquals(KbSync.Outcome.UP_TO_DATE, KbSync.sync(root, "git").outcome)
        assertEquals("kb", g(root, "branch", "--show-current").trim())
        assertEquals("origin/main", g(root, "rev-parse", "--abbrev-ref", "@{upstream}").trim())
        KbFileStore(root).use { it.transformEntry(id) { e -> e.copy(title = "改名后的提交") } }
        assertEquals(KbSync.Outcome.PUSHED, KbSync.sync(root, "git").outcome)

        assertTrue(g(remote, "show", "main:entries/$id.json").contains("改名后的提交")) // 落在远端的 main 上
        assertEquals(1, g(remote, "branch", "--list").lines().count { it.isNotBlank() }) // 没有多出一条 kb
    }

    @Test
    fun `a library with its own history is not pushed beside an unrelated remote branch`() {
        // 远端 B：默认分支 trunk，已经有别的库的历史
        val trunkRemote = dir.resolve("trunk-remote.git")
        g(dir, "init", "-q", "--bare", "-b", "trunk", trunkRemote.toString())
        val other = dir.resolve("libO")
        KbFileStore(other).use { ingest(it, "kb-00000011", source("o.md", "o".toByteArray())) }
        assertNull(KbSync.setRemoteUrl(other, "git", trunkRemote.toString()))
        configure(other)
        assertEquals(KbSync.Outcome.PUSHED, KbSync.sync(other, "git").outcome)
        seedAndPush() // 本地库 A：自己的历史在 main 上
        assertNull(KbSync.setRemoteUrl(root, "git", trunkRemote.toString()))

        val ex = assertFailsWith<KbSync.SyncException> { KbSync.sync(root, "git") }

        assertEquals(KbSync.Failure.UNRELATED_HISTORIES, ex.failure)
        assertEquals(listOf("trunk"), g(trunkRemote, "branch", "--list").lines().map { it.trim().trimStart('*', '+', ' ') }.filter { it.isNotEmpty() })
    }

    @Test
    fun `without a remote nothing is initialized or synced`() {
        val src = source("指南.md", crlfDoc)
        KbFileStore(root).use { ingest(it, id, src) }

        val ex = assertFailsWith<KbSync.SyncException> { KbSync.sync(root, "git") }

        assertEquals(KbSync.Failure.NO_REMOTE, ex.failure)
        assertFalse(KbSync.isRepository(root))
        assertFalse(KbSync.hasUnsyncedChanges(root, "git"))
        assertNull(KbSync.remoteUrl(root, "git"))
    }

    // ───────────────────────── 提交内容 ─────────────────────────

    @Test
    fun `syncing again without changes adds no commit`() {
        seedAndPush()
        val head = remoteHead()

        val r = KbSync.sync(root, "git")

        assertEquals(KbSync.Outcome.UP_TO_DATE, r.outcome)
        assertEquals(head, remoteHead())
        assertEquals("1", g(root, "rev-list", "--count", "HEAD").trim())
        assertEquals(head, g(root, "rev-parse", "HEAD").trim())
    }

    @Test
    fun `a change becomes one commit holding metadata and snapshot with a summary message`() {
        val src = seedAndPush()
        val other = source("另一篇.md", "另一篇正文".toByteArray())
        KbFileStore(root).use { store ->
            Files.writeString(src, "改过的正文\n第二行\n")
            reconcile(store) // 快照跟上
            ingest(store, "kb-bbbb2222", other)
            store.transformEntry(id) { it.copy(title = "新标题") }
        }

        val r = KbSync.sync(root, "git")

        assertEquals(KbSync.Outcome.PUSHED, r.outcome)
        assertEquals(1, r.pushedCommits)
        val tree = remoteTree()
        assertTrue("snapshots/kb-bbbb2222/另一篇.md" in tree, tree.toString())
        assertTrue("snapshots/$id/指南.md" in tree)
        val changed = g(root, "show", "--name-only", "--format=", "HEAD").lines()
        assertTrue("entries/$id.json" in changed, changed.toString())
        assertTrue("snapshots/$id/指南.md" in changed, changed.toString())
        val message = g(root, "log", "-1", "--format=%B")
        assertTrue(Regex("sync \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}[+-]\\d{2}:\\d{2}").containsMatchIn(message), message)
        assertTrue(message.contains("entries: +1 ~1"), message)
        assertTrue(message.contains("snapshots: +1 ~1"), message)
        val (_, blob) = runGit(remote, "cat-file", "blob", "main:snapshots/$id/指南.md")
        assertContentEquals(Files.readAllBytes(src), blob)
    }

    @Test
    fun `organizing entries never moves snapshot files in history`() {
        seedAndPush()
        val before = snapshotPaths(root)

        KbFileStore(root).use { store ->
            store.transformEntry(id) { it.copy(title = "只改标题") }
            val folder = store.createFolder(null, "故障分析")
            store.reorderEntries(listOf(id), folder)
            store.renameFolder(folder, "故障与复盘")
        }
        assertEquals(KbSync.Outcome.PUSHED, KbSync.sync(root, "git").outcome)

        assertEquals(before, snapshotPaths(root))
        assertEquals(before, remoteTree().filter { it.startsWith("snapshots/") })
    }

    @Test
    fun `stray files in the library directory never enter history`() {
        seedAndPush()
        Files.writeString(root.resolve("Thumbs.db"), "x")
        Files.writeString(root.resolve("notes.txt"), "x")

        assertEquals(KbSync.Outcome.UP_TO_DATE, KbSync.sync(root, "git").outcome)

        val tree = remoteTree()
        assertFalse("notes.txt" in tree, tree.toString())
        assertFalse("Thumbs.db" in tree, tree.toString())
        assertFalse(KbSync.hasUnsyncedChanges(root, "git"))
    }

    @Test
    fun `unsynced flag tracks uncommitted and unpushed work`() {
        assertFalse(KbSync.hasUnsyncedChanges(root, "git")) // 还不是仓库
        val src = source("指南.md", crlfDoc)
        KbFileStore(root).use { ingest(it, id, src) }
        assertNull(KbSync.setRemoteUrl(root, "git", remote.toString()))
        configure(root)
        assertTrue(KbSync.hasUnsyncedChanges(root, "git")) // 有未提交的变化
        KbSync.sync(root, "git")
        assertFalse(KbSync.hasUnsyncedChanges(root, "git"))
        KbFileStore(root).use { it.transformEntry(id) { e -> e.copy(title = "改了标题") } }
        assertTrue(KbSync.hasUnsyncedChanges(root, "git"))
    }

    // ───────────────────────── 待同步角标的缓存 ─────────────────────────

    /** 时效放到足够长：下面测的是「库内容或仓库状态一变，缓存就必须作废」，与时效无关 */
    private val longTtl = TimeUnit.MINUTES.toMillis(5)

    @Test
    fun `pending flag is recomputed right after a sync or an edit instead of reusing the cached answer`() {
        val src = source("指南.md", crlfDoc)
        KbFileStore(root).use { ingest(it, id, src) }
        assertNull(KbSync.setRemoteUrl(root, "git", remote.toString()))
        configure(root)
        val cache = KbSync.PendingCache(longTtl)
        assertTrue(cache.get(root, "git")) // 有未提交的变化

        assertEquals(KbSync.Outcome.PUSHED, KbSync.sync(root, "git").outcome)
        assertFalse(cache.get(root, "git")) // 刚同步完：同步后的第一次刷新不能还是「待同步」

        KbFileStore(root).use { it.transformEntry(id) { e -> e.copy(title = "改了标题") } }
        assertTrue(cache.get(root, "git")) // 刚改完条目：同一次刷新里就得亮
    }

    @Test
    fun `pending flag flipped by another instance is reported so the badge can refresh`() {
        seedAndPush()
        val cache = KbSync.PendingCache(longTtl)
        assertFalse(cache.get(root, "git"))
        assertFalse(cache.flippedIfChanged(root, "git")) // 没变化不报

        KbFileStore(root).use { it.transformEntry(id) { e -> e.copy(title = "改了标题") } }
        assertTrue(cache.get(root, "git"))
        // 同一个库被别处同步了（另一个 IDE）：没有库文件事件可听，只能靠巡检发现
        assertEquals(KbSync.Outcome.PUSHED, KbSync.sync(root, "git").outcome)
        assertTrue(cache.flippedIfChanged(root, "git")) // 「待同步」消失
        assertFalse(cache.flippedIfChanged(root, "git")) // 报过一次就不再报
    }

    @Test
    fun `pending flag turns on once a remote is configured elsewhere`() {
        val src = source("指南.md", crlfDoc)
        KbFileStore(root).use { ingest(it, id, src) }
        val cache = KbSync.PendingCache(longTtl)
        assertFalse(cache.get(root, "git")) // 还不是仓库

        assertNull(KbSync.setRemoteUrl(root, "git", remote.toString())) // 设置页配好了远端
        assertTrue(cache.flippedIfChanged(root, "git")) // 从此有东西可同步
    }

    @Test
    fun `change stamp follows library content and repository state but not ignored files`() {
        seedAndPush()
        val before = KbSync.changeStamp(root)
        assertEquals(before, KbSync.changeStamp(root)) // 没变化指纹不变

        // 不进历史的文件：检索缓存、本机缓存、库目录里的杂物
        Files.writeString(root.resolve("text/$id.txt"), "重建的检索缓存")
        Files.writeString(root.resolve(".local-cache"), "$id=1:2")
        Files.writeString(root.resolve("notes.txt"), "x")
        assertEquals(before, KbSync.changeStamp(root))

        // 判定本身不改仓库状态（否则缓存永远命中不了）
        assertFalse(KbSync.hasUnsyncedChanges(root, "git"))
        assertEquals(before, KbSync.changeStamp(root))

        var previous = before
        fun changed(what: String) {
            val now = KbSync.changeStamp(root)
            assertNotEquals(previous, now, what)
            previous = now
        }
        KbFileStore(root).use { it.transformEntry(id) { e -> e.copy(title = "改了标题") } }
        changed("条目改了")
        Files.write(root.resolve("snapshots/$id/指南.md"), "快照变了".toByteArray())
        changed("文档快照变了")
        Files.writeString(root.resolve("config.json"), Files.readString(root.resolve("config.json")) + "\n")
        changed("目录与标签配置改了")
        assertEquals(KbSync.Outcome.PUSHED, KbSync.sync(root, "git").outcome)
        changed("同步提交之后")
    }

    // ───────────────────────── 两台机器 ─────────────────────────

    @Test
    fun `two clones with equal sources but different mtimes produce no extra commit`() {
        val src = seedAndPush()
        val b = secondClone()
        val head = remoteHead()
        // 机器 B：同一份源文件（两机路径一致的前提），修改时间不同——另一台机器检出的
        Files.setLastModifiedTime(src, FileTime.fromMillis(Files.getLastModifiedTime(src).toMillis() + 7_200_000))
        KbFileStore(b).use { store ->
            reconcile(store) // B 的对账：哈希相同，只更新本机缓存
            assertEquals(crlfDoc.size.toLong(), store.getEntry(id)!!.sizeBytes)
        }

        val r = KbSync.sync(b, "git")

        assertEquals(KbSync.Outcome.UP_TO_DATE, r.outcome)
        assertFalse(r.pulled)
        assertEquals(head, remoteHead()) // 条目文件没被改写，没有新提交
        assertFalse(KbSync.hasUnsyncedChanges(b, "git"))
    }

    @Test
    fun `an entry removed on one clone disappears on the other after sync`() {
        seedAndPush()
        val b = secondClone()

        KbFileStore(root).use { it.removeEntry(id) }
        assertEquals(KbSync.Outcome.PUSHED, KbSync.sync(root, "git").outcome)
        val r = KbSync.sync(b, "git")

        assertEquals(KbSync.Outcome.UP_TO_DATE, r.outcome)
        assertTrue(r.pulled)
        assertFalse(Files.exists(b.resolve("entries/$id.json")))
        assertFalse(Files.exists(b.resolve("snapshots/$id")))
        // 摘除的内容在历史里还找得回
        val (_, blob) = runGit(b, "show", "HEAD~1:snapshots/$id/指南.md")
        assertContentEquals(crlfDoc, blob)
    }

    @Test
    fun `a change made on one clone reaches the other with its snapshot`() {
        val src = seedAndPush()
        val b = secondClone()
        Files.writeString(src, "机器 A 上改过的正文")
        KbFileStore(root).use { reconcile(it) }
        assertEquals(KbSync.Outcome.PUSHED, KbSync.sync(root, "git").outcome)

        val r = KbSync.sync(b, "git")

        assertTrue(r.pulled)
        assertEquals("机器 A 上改过的正文", Files.readString(b.resolve("snapshots/$id/指南.md")))
        // B 上对账：检索缓存缺了按解析规则补齐（同一台机器上源文件路径仍在，所以读源文件；
        // 源文件不在的另一台机器上则读文档快照，见 KbContentTest 与 MCP 契约测试）
        KbFileStore(b).use { store ->
            Files.deleteIfExists(b.resolve("text/$id.txt"))
            reconcile(store)
            assertEquals("机器 A 上改过的正文", store.readText(id))
            assertEquals(KbContent.State.SOURCE, KbContent.resolve(store.root(), id, store.getEntry(id)!!.sourcePath).state)
        }
    }

    @Test
    fun `changes made on both clones merge in one sync that pulls and pushes`() {
        seedAndPush()
        val b = secondClone()
        // 两边各收录一篇不同的文档：机器 A 先同步，机器 B 后同步
        val onB = source("手册.md", "机器 B 上收录的正文".toByteArray())
        KbFileStore(b).use { ingest(it, "kb-bbbb2222", onB) }
        val onA = source("方案.md", "机器 A 上收录的正文".toByteArray())
        KbFileStore(root).use { ingest(it, "kb-cccc3333", onA) }
        assertEquals(KbSync.Outcome.PUSHED, KbSync.sync(root, "git").outcome)

        val r = KbSync.sync(b, "git") // 提交自己的 → 取回 A 的 → 推送

        assertEquals(KbSync.Outcome.PUSHED, r.outcome)
        assertTrue(r.pulled)
        assertEquals(1, r.pushedCommits)
        assertTrue(Files.exists(b.resolve("entries/kb-cccc3333.json")))
        assertEquals("机器 A 上收录的正文", Files.readString(b.resolve("snapshots/kb-cccc3333/方案.md")))
        assertTrue("entries/kb-bbbb2222.json" in remoteTree())
        assertFalse(KbSync.hasUnsyncedChanges(b, "git"))

        val back = KbSync.sync(root, "git") // A 再同步：只取回 B 收录的那篇

        assertEquals(KbSync.Outcome.UP_TO_DATE, back.outcome)
        assertTrue(back.pulled)
        assertEquals("机器 B 上收录的正文", Files.readString(root.resolve("snapshots/kb-bbbb2222/手册.md")))
    }

    @Test
    fun `the same source change reconciled on both clones does not end in a sync conflict`() {
        val src = seedAndPush()
        val b = secondClone()
        // 同一篇文档在两台电脑上都变了（比如它所在的仓库两边都拉取了），两边各自对账；A 先同步
        val fresh = "两边都看到的新正文".toByteArray()
        Files.write(src, fresh)
        Files.setLastModifiedTime(src, FileTime.fromMillis(Files.getLastModifiedTime(src).toMillis() + 2_000))
        KbFileStore(root).use { reconcile(it) }
        assertEquals(KbSync.Outcome.PUSHED, KbSync.sync(root, "git").outcome)

        KbFileStore(b).use { reconcile(it) } // B 的对账先于 B 的同步（对账自动跑，同步要手点）
        val r = KbSync.sync(b, "git")

        assertEquals(KbSync.Outcome.UP_TO_DATE, r.outcome) // 与 A 的提交内容相同：变基后成为空提交被丢弃
        assertContentEquals(fresh, Files.readAllBytes(b.resolve("snapshots/$id/指南.md")))
        assertEquals("两边都看到的新正文", KbFileStore(b).use { it.readText(id) }) // B 的检索缓存没被动过，仍对应现在的内容
    }

    @Test
    fun `a pull that changes a document snapshot drops the stale text cache and it is rebuilt`() {
        val src = seedAndPush()
        val b = secondClone()
        KbFileStore(b).use { reconcile(it) }
        val text = b.resolve("text/$id.txt")
        Files.writeString(text, "上一版文档提取的检索缓存")
        assertEquals(KbSync.Outcome.UP_TO_DATE, KbSync.sync(b, "git").outcome) // 远端没有新东西：缓存不动
        assertEquals("上一版文档提取的检索缓存", Files.readString(text))

        Files.writeString(src, "机器 A 上改过的正文") // 机器 A 改了文档并同步
        Files.setLastModifiedTime(src, FileTime.fromMillis(Files.getLastModifiedTime(src).toMillis() + 2_000))
        KbFileStore(root).use { reconcile(it) }
        assertEquals(KbSync.Outcome.PUSHED, KbSync.sync(root, "git").outcome)

        val r = KbSync.sync(b, "git") // 机器 B 同步：取回新的文档快照

        assertTrue(r.pulled)
        assertFalse(Files.exists(text)) // 旧缓存作废
        KbFileStore(b).use { store ->
            assertEquals("机器 A 上改过的正文", KbContent.ensureText(store.root(), id, src.toString(), plainExtractor)) // 读侧按解析规则重建
            reconcile(store)
            assertEquals("机器 A 上改过的正文", store.readText(id))
        }
    }

    // ───────────────────────── 冲突 ─────────────────────────

    @Test
    fun `a conflicting remote commit aborts the sync and keeps the local state`() {
        seedAndPush()
        val b = secondClone()
        // A 先改标题并推上去
        KbFileStore(root).use { it.transformEntry(id) { e -> e.copy(title = "机器 A 的标题") } }
        assertEquals(KbSync.Outcome.PUSHED, KbSync.sync(root, "git").outcome)
        // B 没取远端，把同一条目改成另一个标题
        KbFileStore(b).use { it.transformEntry(id) { e -> e.copy(title = "机器 B 的标题") } }
        val localEntry = Files.readAllBytes(b.resolve("entries/$id.json"))

        val ex = assertFailsWith<KbSync.SyncException> { KbSync.sync(b, "git") }

        assertEquals(KbSync.Failure.CONFLICT, ex.failure)
        assertEquals(listOf("entries/$id.json"), ex.conflicts)
        assertContentEquals(localEntry, Files.readAllBytes(b.resolve("entries/$id.json"))) // 工作区回到同步前
        assertEquals("机器 B 的标题", KbFileStore(b).use { it.getEntry(id)!!.title })
        assertTrue(g(remote, "show", "main:entries/$id.json").contains("机器 A 的标题")) // 远端没被覆盖
        assertEquals("1", g(b, "rev-list", "--count", "origin/main..HEAD").trim()) // 本地提交保留、未推送
        // 变基已中止，没有停在半途
        assertFalse(Files.exists(b.resolve(g(b, "rev-parse", "--git-path", "rebase-merge").trim())))
        assertTrue(KbSync.hasUnsyncedChanges(b, "git")) // 处理完冲突再来同步
    }

    @Test
    fun `snapshots changed on both sides are never line-merged or given conflict markers`() {
        val src = seedAndPush()
        val b = secondClone()
        val srcB = dir.resolve("src-b/指南.md").also { Files.createDirectories(it.parent); Files.write(it, crlfDoc) }
        // 两侧各改各的源文件
        Files.writeString(src, "A 版本\n第一行\n第二行\n")
        KbFileStore(root).use { reconcile(it) }
        assertEquals(KbSync.Outcome.PUSHED, KbSync.sync(root, "git").outcome)
        val bVersion = "B 版本\n第一行\n第二行\n".toByteArray()
        KbFileStore(b).use { store ->
            store.transformEntry(id) { it.copy(sourcePath = srcB.toString().replace('\\', '/')) }
            Files.write(srcB, bVersion)
            reconcile(store)
        }
        // 不走同步的「冲突即中止」，直接用普通 merge 把两侧合到一起，看快照文件本身的行为
        g(b, "add", "-A")
        g(b, "commit", "-q", "-m", "machine B")
        g(b, "fetch", "-q", "origin")
        assertEquals(1, gExit(b, "merge", "--no-edit", "origin/main"), "两侧都改了，应当冲突")

        val snapshot = Files.readAllBytes(b.resolve("snapshots/$id/指南.md"))
        val text = String(snapshot, StandardCharsets.UTF_8)
        assertFalse(text.contains("<<<<<<<"), "快照里出现了合并标记")
        assertFalse(text.contains(">>>>>>>"), "快照里出现了合并标记")
        assertFalse(text.contains("======="), "快照里出现了合并标记")
        // 是完整的某一个版本，不是拼接
        assertTrue(
            snapshot.contentEquals(bVersion) || snapshot.contentEquals(Files.readAllBytes(src)),
            "快照既不是 A 的版本也不是 B 的版本",
        )
    }

    @Test
    fun `unrelated local and remote histories are rejected instead of merged`() {
        seedAndPush() // 远端 main 已有 A 的历史
        val otherRemote = dir.resolve("other-remote.git")
        g(dir, "init", "-q", "--bare", otherRemote.toString())
        val c = dir.resolve("libC")
        KbFileStore(c).use { ingest(it, "kb-cccc3333", source("c.md", "c".toByteArray())) }
        assertNull(KbSync.setRemoteUrl(c, "git", otherRemote.toString()))
        configure(c)
        assertEquals(KbSync.Outcome.PUSHED, KbSync.sync(c, "git").outcome) // C 有自己独立的历史
        assertNull(KbSync.setRemoteUrl(c, "git", remote.toString())) // 现在指向 A 的远端

        val ex = assertFailsWith<KbSync.SyncException> { KbSync.sync(c, "git") }

        assertEquals(KbSync.Failure.UNRELATED_HISTORIES, ex.failure)
        assertEquals("1", g(remote, "rev-list", "--count", "main").trim()) // 远端没被并入
        assertTrue(Files.exists(c.resolve("entries/kb-cccc3333.json"))) // 本地原样
    }

    // ───────────────────────── 接入远端 ─────────────────────────

    @Test
    fun `an empty library with no history adopts the remote history`() {
        seedAndPush()
        val d = dir.resolve("libD")
        KbFileStore(d).use { it.createFolder(null, "临时目录") } // 空库也可能被写过 config
        KbFileStore(d).use { it.deleteFolder(it.folders().single().id) }
        assertNull(KbSync.setRemoteUrl(d, "git", remote.toString()))
        configure(d)

        val r = KbSync.sync(d, "git")

        assertEquals(KbSync.Outcome.UP_TO_DATE, r.outcome)
        assertTrue(r.pulled)
        assertTrue(Files.exists(d.resolve("entries/$id.json")))
        assertContentEquals(crlfDoc, Files.readAllBytes(d.resolve("snapshots/$id/指南.md")))
        assertEquals(g(root, "rev-parse", "HEAD").trim(), g(d, "rev-parse", "HEAD").trim())
        assertEquals("main", g(d, "branch", "--show-current").trim())
        assertFalse(KbSync.hasUnsyncedChanges(d, "git")) // 上游跟踪已建立
    }

    @Test
    fun `a non-empty library with no history is not merged into the remote`() {
        seedAndPush()
        val e = dir.resolve("libE")
        KbFileStore(e).use { ingest(it, "kb-eeee5555", source("e.md", "本地内容".toByteArray())) }
        assertNull(KbSync.setRemoteUrl(e, "git", remote.toString()))
        configure(e)

        val ex = assertFailsWith<KbSync.SyncException> { KbSync.sync(e, "git") }

        assertEquals(KbSync.Failure.UNRELATED_HISTORIES, ex.failure)
        assertTrue(Files.exists(e.resolve("entries/kb-eeee5555.json"))) // 本地内容没被覆盖
        assertFalse(Files.exists(e.resolve("entries/$id.json")))
    }

    @Test
    fun `a change written right after the commit fails that sync and the retry succeeds`() {
        seedAndPush()
        val b = secondClone()
        KbFileStore(b).use { it.transformEntry(id) { e -> e.copy(title = "远端先走一步") } }
        assertEquals(KbSync.Outcome.PUSHED, KbSync.sync(b, "git").outcome) // 远端有新提交，A 下次同步要变基
        // 模拟 MCP server 恰好在同步瞬间写入：本地提交刚落下，工作区又多出一条条目
        val hook = root.resolve(".git/hooks/post-commit")
        Files.writeString(
            hook,
            "#!/bin/sh\n" +
                "printf '%s' '{\"id\":\"kb-dddd4444\",\"sourcePath\":\"d:/nope.md\",\"title\":\"hook\"}' " +
                "> \"\$(git rev-parse --show-toplevel)/entries/kb-dddd4444.json\"\n",
        )
        val other = source("另一篇.md", "另一篇正文".toByteArray())
        KbFileStore(root).use { ingest(it, "kb-bbbb2222", other) }

        val ex = assertFailsWith<KbSync.SyncException> { KbSync.sync(root, "git") }

        assertEquals(KbSync.Failure.WORKTREE_DIRTY, ex.failure)
        assertEquals(remoteHead(), g(b, "rev-parse", "HEAD").trim()) // 远端没被这次同步动过
        assertTrue(Files.exists(root.resolve("entries/kb-bbbb2222.json"))) // 本地内容都在

        Files.delete(hook)
        val r = KbSync.sync(root, "git")

        assertEquals(KbSync.Outcome.PUSHED, r.outcome)
        assertTrue(r.pulled)
        assertEquals(2, r.pushedCommits)
        assertTrue("entries/kb-dddd4444.json" in remoteTree())
        assertFalse(KbSync.hasUnsyncedChanges(root, "git"))
    }

    // ───────────────────────── 远端地址 ─────────────────────────

    @Test
    fun `library content is versioned even when another ignore file matches it`() {
        val src = dir.resolve("src/服务.log").also { Files.createDirectories(it.parent); Files.write(it, crlfDoc) }
        KbFileStore(root).use { store ->
            ingest(store, "kb-00000099", src)
            store.createFolder(null, "运维") // 让 config.json 落盘
            assertNull(KbSync.setRemoteUrl(root, "git", remote.toString()))
            configure(root)
            // 别处的忽略规则（全局 gitignore、info/exclude）把这些类型全忽略了
            Files.writeString(root.resolve(".git/info/exclude"), "*.log\n*.json\n*.md\n.gitignore\n.gitattributes\n")
            Files.writeString(root.resolve("entries/kb-zzzzzz9999.json.tmp"), "原子写的临时文件残留")
        }

        assertEquals(KbSync.Outcome.PUSHED, KbSync.sync(root, "git").outcome)

        val tree = remoteTree()
        assertTrue("config.json" in tree, tree.toString())
        assertTrue("entries/kb-00000099.json" in tree, tree.toString())
        assertTrue("snapshots/kb-00000099/服务.log" in tree, tree.toString())
        assertTrue(".gitignore" in tree && ".gitattributes" in tree, tree.toString())
        assertTrue(tree.none { it.startsWith("text/") || it.endsWith(".tmp") }, tree.toString())
    }

    @Test
    fun `remote url can be set, replaced and cleared`() {
        assertEquals("invalid remote url", KbSync.setRemoteUrl(root, "git", "a b"))
        assertNull(KbSync.setRemoteUrl(root, "git", remote.toString()))
        assertEquals(remote.toString(), KbSync.remoteUrl(root, "git"))
        val otherRemote = dir.resolve("other-remote.git")
        g(dir, "init", "-q", "--bare", otherRemote.toString())
        assertNull(KbSync.setRemoteUrl(root, "git", otherRemote.toString()))
        assertEquals(otherRemote.toString(), KbSync.remoteUrl(root, "git"))
        assertNull(KbSync.setRemoteUrl(root, "git", ""))
        assertNull(KbSync.remoteUrl(root, "git"))
    }

    // ───────────────────────── 换电脑接入（库位置 + 远端 + 同步） ─────────────────────────
    //
    // 换一台电脑没有单独的「克隆」入口：填同一个远端地址保存，再点同步，整个库就取回到当前位置。
    // 库想放别的盘也一样——先改位置或先填远端都行。入口联接是 Windows 目录联接，用例只在 Windows 跑。

    @Test
    @EnabledOnOs(OS.WINDOWS)
    fun `a new machine that placed its library elsewhere fetches everything by setting the remote and syncing`() {
        seedAndPush()
        val placed = home.resolve("D盘/知识库") // 库目录还没建过，先把位置改到别的盘
        val r = KbPaths.relocate(placed, home.toString())
        assertTrue(r is KbPaths.Relocate.Done, "$r")
        val lib = KbPaths.rootDir(home.toString())
        assertEquals(placed.toRealPath(), lib)

        assertNull(KbSync.setRemoteUrl(lib, "git", remote.toString()))
        configure(lib)
        assertTrue(KbSync.hasUnsyncedChanges(lib, "git")) // 远端配好了还没同步：角标亮着，提醒去点同步

        val result = KbSync.sync(lib, "git")

        assertEquals(KbSync.Outcome.UP_TO_DATE, result.outcome)
        assertTrue(result.pulled)
        assertTrue(Files.exists(lib.resolve("entries/$id.json"))) // 经入口路径读得到
        assertContentEquals(crlfDoc, Files.readAllBytes(placed.resolve("snapshots/$id/指南.md")))
        assertEquals(g(root, "rev-parse", "HEAD").trim(), g(lib, "rev-parse", "HEAD").trim())
        assertEquals("1", g(remote, "rev-list", "--count", "main").trim()) // 只是取回，没往云端多推东西
        assertFalse(KbSync.hasUnsyncedChanges(lib, "git"))
    }

    @Test
    @EnabledOnOs(OS.WINDOWS)
    fun `a new machine that set its remote before moving fetches everything after the move`() {
        seedAndPush()
        // 先在默认位置填了远端（仓库已初始化、还没有任何提交），之后才把库位置改到别的盘
        assertNull(KbSync.setRemoteUrl(KbPaths.rootDir(home.toString()), "git", remote.toString()))
        val placed = home.resolve("D盘/知识库")
        val r = KbPaths.relocate(placed, home.toString())
        assertTrue(r is KbPaths.Relocate.Done, "$r")
        val lib = KbPaths.rootDir(home.toString())
        assertEquals(placed.toRealPath(), lib)
        assertEquals(remote.toString(), KbSync.remoteUrl(lib, "git")) // 远端配置跟着库一起搬了
        configure(lib)

        val result = KbSync.sync(lib, "git")

        assertTrue(result.pulled)
        assertTrue(Files.exists(lib.resolve("entries/$id.json")))
        assertContentEquals(crlfDoc, Files.readAllBytes(lib.resolve("snapshots/$id/指南.md")))
        assertEquals("1", g(remote, "rev-list", "--count", "main").trim())
        assertFalse(KbSync.hasUnsyncedChanges(lib, "git"))
    }
}
