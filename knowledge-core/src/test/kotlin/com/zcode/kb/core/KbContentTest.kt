package com.zcode.kb.core

import org.junit.jupiter.api.io.TempDir
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.FileTime
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * 文档快照 / 解析规则 / 对账 / 检索缓存的共用实现（KbContent）——IDE 与 MCP server 共用的那一份。
 * 在临时目录里搭一个库和若干源文件，只断言外部可见的结果：文件字节、条目字段、解析状态、
 * 检索缓存内容。条目落盘走 IDE 侧真实入口（KbFileStore.confirmContent）。
 */
class KbContentTest {

    @TempDir
    lateinit var dir: Path

    private val root: Path get() = dir.resolve("kb")

    /** 测试提取器：文本文件原样读出；可替换成计数/恒空实现 */
    private var extractor: KbContent.TextExtractor = KbContent.TextExtractor { Files.readString(it) }

    private fun reconcile(store: KbFileStore): Int =
        KbContent.reconcile(store.root(), store.contentSources(), extractor) { id, hash, size ->
            store.confirmContent(id, hash, size)
        }

    /** 仿 IDE 收录：落文档快照 → 条目带 contentHash → 检索缓存 */
    private fun ingest(store: KbFileStore, id: String, src: Path, hash: String? = null): KbEntry {
        val display = src.toString().replace('\\', '/')
        val captured = KbContent.capture(store.root(), id, display)
        val entry = KbEntry(
            id = id, sourcePath = display, title = src.fileName.toString(),
            sizeBytes = captured.size, contentHash = hash ?: captured.hash,
            ingestedAt = 100, updatedAt = 100,
        )
        store.insert(entry, Files.readString(src))
        return entry
    }

    private fun source(name: String, bytes: ByteArray): Path =
        dir.resolve("src").also { Files.createDirectories(it) }.resolve(name).also { Files.write(it, bytes) }

    private fun sha256(p: Path): String =
        MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(p)).joinToString("") { "%02x".format(it) }

    private fun snapshotOf(id: String): Path? =
        Files.list(root.resolve("snapshots").resolve(id)).use { s -> s.filter { Files.isRegularFile(it) }.findFirst().orElse(null) }

    // ───────────────────────── 文档快照 ─────────────────────────

    @Test
    fun `capture stores a byte-identical snapshot and records its hash`() {
        val store = KbFileStore(root)
        val bom = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte())
        val bytes = bom + "第一行\r\nline two\r\n".toByteArray(StandardCharsets.UTF_8) // CRLF + BOM，逐字节原样
        val src = source("指南.md", bytes)

        val captured = KbContent.capture(root, "kb-aaaa1111", src.toString().replace('\\', '/'))

        val snap = root.resolve("snapshots/kb-aaaa1111/指南.md")
        assertTrue(Files.isRegularFile(snap))
        assertContentEquals(bytes, Files.readAllBytes(snap))
        assertEquals(bytes.size.toLong(), captured.size)
        assertEquals(sha256(src), captured.hash)
        assertEquals(64, captured.hash.length)
        assertEquals(Files.getLastModifiedTime(src).toMillis(), captured.mtime)
        // 本机缓存记下了这次确认的 stat
        assertTrue(Files.readString(KbContent.localCacheFile(root)).contains("kb-aaaa1111="))
        store.close()
    }

    @Test
    fun `capture throws when the source is missing and refuses unsafe ids`() {
        KbFileStore(root).use { store ->
            assertFailsWithIOException { KbContent.capture(root, "kb-1", dir.resolve("nope.md").toString()) }
            assertFailsWithIOException { KbContent.capture(root, "../evil", dir.resolve("a.md").toString()) }
            assertFalse(Files.exists(root.resolve("snapshots/../evil")))
        }
    }

    @Test
    fun `snapshot file name follows the source file and falls back when the name is illegal`() {
        assertEquals(
            root.resolve("snapshots/kb-1/部署 手册.md"),
            KbContent.snapshotFile(root, "kb-1", "d:/docs/部署 手册.md"),
        )
        assertEquals(
            root.resolve("snapshots/kb-1/kb-1"),
            KbContent.snapshotFile(root, "kb-1", "d:/docs/"), // 没有文件名：回退 <id>
        )
        if (System.getProperty("os.name", "").lowercase().contains("windows")) {
            // 另一台机器收录的、在本机文件系统上非法的名字（保留设备名 / 非法字符）
            assertEquals(
                root.resolve("snapshots/kb-1/kb-1.md"),
                KbContent.snapshotFile(root, "kb-1", "/home/u/CON.md"),
            )
            assertEquals(
                root.resolve("snapshots/kb-1/kb-1.md"),
                KbContent.snapshotFile(root, "kb-1", "/home/u/a:b?.md"),
            )
            // 整条路径超过 Windows 传统上限：回退成短名，快照才写得出来
            assertEquals(
                root.resolve("snapshots/kb-1/kb-1.md"),
                KbContent.snapshotFile(root, "kb-1", "/home/u/" + "长".repeat(200) + ".md"),
            )
        }
    }

    @Test
    fun `recapture after relink renames the snapshot and drops the old copy`() {
        KbFileStore(root).use { store ->
            val a = source("旧名字.md", "v1".toByteArray())
            val b = source("新名字.md", "v2".toByteArray())
            KbContent.capture(root, "kb-1", a.toString())
            assertTrue(Files.exists(root.resolve("snapshots/kb-1/旧名字.md")))

            KbContent.capture(root, "kb-1", b.toString())

            assertFalse(Files.exists(root.resolve("snapshots/kb-1/旧名字.md")))
            assertContentEquals("v2".toByteArray(), Files.readAllBytes(root.resolve("snapshots/kb-1/新名字.md")))
            assertEquals(1, Files.list(root.resolve("snapshots/kb-1")).use { s -> s.count() })
        }
    }

    // ───────────────────────── 解析 ─────────────────────────

    @Test
    fun `resolve reads the source, falls back to the snapshot, then reports missing`() {
        KbFileStore(root).use { store ->
            val src = source("doc.md", "正文".toByteArray())
            ingest(store, "kb-1", src)
            val snap = snapshotOf("kb-1")!!

            assertEquals(KbContent.State.SOURCE, KbContent.resolve(root, "kb-1", src.toString()).state)
            assertEquals(src.toAbsolutePath().normalize(), KbContent.resolve(root, "kb-1", src.toString()).path)

            Files.delete(src) // 删除 / 改名 / 切分支：源文件不在
            val snapshot = KbContent.resolve(root, "kb-1", src.toString())
            assertEquals(KbContent.State.SNAPSHOT, snapshot.state)
            assertEquals(snap.toAbsolutePath().normalize(), snapshot.path)
            assertEquals("snapshot", KbContent.statusCode(snapshot.state))

            Files.delete(snap)
            val missing = KbContent.resolve(root, "kb-1", src.toString())
            assertEquals(KbContent.State.MISSING, missing.state)
            assertNull(missing.path)
            assertEquals("missing", KbContent.statusCode(missing.state))

            Files.writeString(src, "正文") // 源文件回来（切回分支）：自动改回读源文件
            val back = KbContent.resolve(root, "kb-1", src.toString())
            assertEquals(KbContent.State.SOURCE, back.state)
            assertEquals("ok", KbContent.statusCode(back.state))
        }
    }

    @Test
    fun `resolve tolerates an illegal stored path and an unsafe id`() {
        KbFileStore(root).use { _ ->
            assertEquals(KbContent.State.MISSING, KbContent.resolve(root, "kb-1", "   ").state)
            assertEquals(KbContent.State.MISSING, KbContent.resolve(root, "../x", "a.md").state)
            assertEquals(KbContent.State.MISSING, KbContent.resolve(root, "kb-1", dir.resolve("is-a-dir").also { Files.createDirectories(it) }.toString()).state)
        }
    }

    // ───────────────────────── 对账 ─────────────────────────

    @Test
    fun `source change updates snapshot, entry hash, size and text cache`() {
        KbFileStore(root).use { store ->
            val src = source("a.md", "版本一".toByteArray())
            ingest(store, "kb-1", src)
            Thread.sleep(5)

            Files.writeString(src, "版本二，内容更长")
            assertTrue(reconcile(store) > 0)

            val e = store.getEntry("kb-1")!!
            assertEquals(sha256(src), e.contentHash)
            assertEquals(Files.size(src), e.sizeBytes)
            assertEquals(100, e.updatedAt) // 内容变化不动 updatedAt：两台电脑各自对账到同一处变化，写下的条目要逐字节相同
            assertEquals("版本二，内容更长", store.readText("kb-1"))
            assertContentEquals(Files.readAllBytes(src), Files.readAllBytes(snapshotOf("kb-1")!!))
        }
    }

    @Test
    fun `touching only the mtime leaves the entry file and snapshot untouched`() {
        KbFileStore(root).use { store ->
            val src = source("a.md", "内容不变".toByteArray())
            ingest(store, "kb-1", src)
            assertTrue(reconcile(store) >= 0) // 首轮把本机缓存补齐
            val entryFile = root.resolve("entries/kb-1.json")
            val entryBefore = Files.readAllBytes(entryFile)
            val snapBefore = Files.readAllBytes(snapshotOf("kb-1")!!)
            val cacheBefore = Files.readString(KbContent.localCacheFile(root))
            val newMtime = Files.getLastModifiedTime(src).toMillis() + 3_600_000

            Files.setLastModifiedTime(src, FileTime.fromMillis(newMtime)) // 另一台机器检出的同一份文件：时间不同、内容相同
            assertEquals(0, reconcile(store))

            assertContentEquals(entryBefore, Files.readAllBytes(entryFile))
            assertContentEquals(snapBefore, Files.readAllBytes(snapshotOf("kb-1")!!))
            assertNotEquals(cacheBefore, Files.readString(KbContent.localCacheFile(root))) // 只动了本机缓存
            assertTrue(Files.readString(KbContent.localCacheFile(root)).contains("kb-1=$newMtime:"))
            assertEquals(100, store.getEntry("kb-1")!!.updatedAt)
        }
    }

    @Test
    fun `a restored source with the same content is re-snapshotted without touching the entry`() {
        KbFileStore(root).use { store ->
            val src = source("a.md", "同一份内容".toByteArray())
            ingest(store, "kb-1", src)
            reconcile(store)
            val entryBefore = Files.readAllBytes(root.resolve("entries/kb-1.json"))
            Files.delete(snapshotOf("kb-1")!!) // 快照文件丢了（手工删的）

            assertTrue(reconcile(store) > 0)

            assertContentEquals("同一份内容".toByteArray(), Files.readAllBytes(snapshotOf("kb-1")!!))
            assertContentEquals(entryBefore, Files.readAllBytes(root.resolve("entries/kb-1.json")))
        }
    }

    @Test
    fun `legacy entries without contentHash are backfilled without re-extracting or bumping updatedAt`() {
        val calls = AtomicInteger()
        extractor = KbContent.TextExtractor { calls.incrementAndGet(); "重新提取" }
        KbFileStore(root).use { store ->
            val src = source("a.md", "旧条目的源文件".toByteArray())
            store.insert(
                KbEntry(id = "kb-1", sourcePath = src.toString().replace('\\', '/'), title = "旧条目", ingestedAt = 100, updatedAt = 100),
                "收录时提取的正文",
            )
            store.insert(KbEntry(id = "kb-2", sourcePath = "d:/not-here.md", title = "源不在也没有快照"), "残留正文")

            assertTrue(reconcile(store) > 0)

            val e = store.getEntry("kb-1")!!
            assertEquals(sha256(src), e.contentHash) // 补齐内容哈希
            assertEquals(Files.size(src), e.sizeBytes)
            assertEquals(100, e.updatedAt) // 只是补齐：不知道内容变没变，不动 updatedAt
            assertEquals("收录时提取的正文", store.readText("kb-1")) // 缓存文本还在就不重新提取
            assertEquals(0, calls.get())
            assertContentEquals(Files.readAllBytes(src), Files.readAllBytes(snapshotOf("kb-1")!!))
            // 第二轮命中本机缓存：不重算哈希（快照在、缓存在、stat 没变）
            assertEquals(0, reconcile(store))
        }
    }

    @Test
    fun `missing text cache is rebuilt from the source, or from the snapshot when the source is gone`() {
        KbFileStore(root).use { store ->
            val src = source("a.md", "源文件正文".toByteArray())
            ingest(store, "kb-1", src)
            reconcile(store)

            Files.delete(root.resolve("text/kb-1.txt"))
            assertTrue(reconcile(store) > 0)
            assertEquals("源文件正文", store.readText("kb-1")) // 源文件在：从源文件建

            Files.delete(src)
            Files.delete(root.resolve("text/kb-1.txt"))
            assertTrue(reconcile(store) > 0)
            assertEquals("源文件正文", store.readText("kb-1")) // 源文件不在：从文档快照建
        }
    }

    @Test
    fun `a pulled snapshot change drops the stale text cache and it is rebuilt from the new snapshot`() {
        val calls = AtomicInteger()
        extractor = KbContent.TextExtractor { calls.incrementAndGet(); Files.readString(it) }
        KbFileStore(root).use { store ->
            val src = source("a.md", "旧正文".toByteArray())
            ingest(store, "kb-1", src)
            reconcile(store)
            Files.delete(src) // 这台电脑上没有源文件，只靠文档快照
            val text = root.resolve("text/kb-1.txt")
            assertEquals("旧正文", store.readText("kb-1"))
            calls.set(0)

            // 另一台电脑改了文档并同步；这台同步取回之后，文档快照是新的，检索缓存还是旧的
            Files.writeString(snapshotOf("kb-1")!!, "另一台电脑改过的正文")
            KbContent.afterPull(store.root(), listOf("config.json", "entries/kb-1.json", "snapshots/kb-1/a.md", "snapshots/kb-9"))

            assertFalse(Files.exists(text))
            assertTrue(reconcile(store) > 0)
            assertEquals("另一台电脑改过的正文", store.readText("kb-1"))
            assertEquals(0, reconcile(store)) // 重建一次就稳住
        }
    }

    @Test
    fun `a pulled snapshot change is not overwritten by an untouched local source`() {
        val calls = AtomicInteger()
        extractor = KbContent.TextExtractor { calls.incrementAndGet(); Files.readString(it) }
        KbFileStore(root).use { store ->
            val src = source("a.md", "本机的旧版正文".toByteArray())
            ingest(store, "kb-1", src)
            reconcile(store)
            val snap = snapshotOf("kb-1")!!

            // 远端的版本更新（另一台电脑改过并同步），本机源文件没动过；同步取回并作废旧缓存
            val remote = "另一台电脑改过的正文".toByteArray(StandardCharsets.UTF_8)
            Files.write(snap, remote)
            store.transformEntry("kb-1") { it.copy(contentHash = sha256(snap), sizeBytes = remote.size.toLong()) }
            KbContent.afterPull(store.root(), listOf("snapshots/kb-1/a.md"))
            assertFalse(Files.exists(root.resolve("text/kb-1.txt")))

            assertTrue(reconcile(store) > 0)

            // 本机读的仍是本机的源文件，缓存按它重建；取回来的版本不被旧源文件盖回去
            assertEquals("本机的旧版正文", store.readText("kb-1"))
            assertContentEquals(remote, Files.readAllBytes(snap))
            assertEquals(sha256(snap), store.getEntry("kb-1")!!.contentHash)
            assertEquals(0, reconcile(store))
        }
    }

    @Test
    fun `a cache line without the content version rebuilds the text once`() {
        val calls = AtomicInteger()
        extractor = KbContent.TextExtractor { calls.incrementAndGet(); Files.readString(it) }
        KbFileStore(root).use { store ->
            val src = source("a.md", "内容不变".toByteArray())
            ingest(store, "kb-1", src)
            reconcile(store)
            // 较早版本写下的本机缓存：只有 mtime 与大小
            Files.writeString(KbContent.localCacheFile(root), "# old format\nkb-1=1:1\n")

            assertEquals(1, reconcile(store)) // 命中不了本机缓存：重算哈希，内容没变；版本未知，缓存重建一次
            assertEquals(1, calls.get())
            assertEquals(sha256(src), store.getEntry("kb-1")!!.contentHash)

            Files.setLastModifiedTime(src, FileTime.fromMillis(Files.getLastModifiedTime(src).toMillis() + 3_600_000))
            assertEquals(0, reconcile(store)) // 之后再只是被碰了修改时间：不重建
            assertEquals(1, calls.get())
        }
    }

    @Test
    fun `text cache catches up once the local source reaches the content version of the entry`() {
        val calls = AtomicInteger()
        extractor = KbContent.TextExtractor { calls.incrementAndGet(); Files.readString(it) }
        KbFileStore(root).use { store ->
            val src = source("a.md", "v1".toByteArray())
            val v2 = "v2".toByteArray()
            ingest(store, "kb-1", src)
            reconcile(store)
            assertEquals("v1", store.readText("kb-1"))

            // 拉取远端：条目的内容版本与文档快照已经是另一台电脑确认过的 v2，本机源文件暂时还是 v1
            val snap = snapshotOf("kb-1")!!
            Files.write(snap, v2)
            store.transformEntry("kb-1") { it.copy(contentHash = sha256(snap), sizeBytes = v2.size.toLong()) }
            calls.set(0)
            reconcile(store)
            assertEquals("v1", store.readText("kb-1")) // 本机源文件没动：仍读本机的源文件，缓存照旧
            assertEquals(0, calls.get())

            // 本机源文件随后跟上了（比如文档所在的仓库也拉取了）
            Files.write(src, v2)
            Files.setLastModifiedTime(src, FileTime.fromMillis(Files.getLastModifiedTime(src).toMillis() + 2_000))
            assertTrue(reconcile(store) > 0)
            assertEquals("v2", store.readText("kb-1")) // 缓存跟上本机现在读到的内容
            assertEquals(0, reconcile(store))
        }
    }

    @Test
    fun `unextractable content gets an empty cache instead of being retried every round`() {
        val calls = AtomicInteger()
        extractor = KbContent.TextExtractor { calls.incrementAndGet(); null } // 无正文（格式不支持 / 解析失败）
        KbFileStore(root).use { store ->
            val src = source("a.doc", "x".toByteArray())
            store.insert(KbEntry(id = "kb-1", sourcePath = src.toString().replace('\\', '/'), title = "doc"), "")
            Files.delete(root.resolve("text/kb-1.txt")) // 检索缓存缺失（新机器克隆下来的状态）

            reconcile(store)
            reconcile(store)

            assertEquals(1, calls.get()) // 第二轮不再重试
            assertTrue(Files.exists(root.resolve("text/kb-1.txt")))
            assertEquals("", store.readText("kb-1"))
        }
    }

    @Test
    fun `a failed extraction on real change keeps the previous text`() {
        var fail = false
        extractor = KbContent.TextExtractor { if (fail) null else Files.readString(it) }
        KbFileStore(root).use { store ->
            val src = source("a.md", "旧正文".toByteArray())
            ingest(store, "kb-1", src)
            fail = true // 提取器失败（文件被占用等）
            Files.writeString(src, "新正文")

            reconcile(store)

            assertEquals("旧正文", store.readText("kb-1")) // 一次读失败不抹掉已有正文
            assertEquals(sha256(src), store.getEntry("kb-1")!!.contentHash) // 快照与哈希照常更新
        }
    }

    @Test
    fun `rebuildText follows the resolve rule and clears stale cache of missing entries`() {
        KbFileStore(root).use { store ->
            val src = source("a.md", "正文".toByteArray())
            val display = src.toString().replace('\\', '/')
            ingest(store, "kb-1", src)
            store.insert(KbEntry(id = "kb-2", sourcePath = "d:/gone.md", title = "失效条目"), "残留")
            Files.writeString(root.resolve("text/kb-1.txt"), "被改坏的缓存")

            assertEquals("正文", KbContent.rebuildText(root, "kb-1", display, extractor))
            assertEquals("正文", store.readText("kb-1"))
            Files.delete(src)
            assertEquals("正文", KbContent.rebuildText(root, "kb-1", display, extractor)) // 从文档快照重建
            assertNull(KbContent.rebuildText(root, "kb-2", "d:/gone.md", extractor))
            assertFalse(Files.exists(root.resolve("text/kb-2.txt")))
            assertEquals("正文", KbContent.ensureText(root, "kb-1", display, extractor))
        }
    }

    // ───────────────────────── 摘除与孤儿清理 ─────────────────────────

    @Test
    fun `removing an entry deletes its snapshot too`() {
        KbFileStore(root).use { store ->
            val src = source("a.md", "唯一内容关键词".toByteArray())
            ingest(store, "kb-1", src)
            assertTrue(Files.exists(root.resolve("snapshots/kb-1")))

            store.removeEntry("kb-1")

            assertFalse(Files.exists(root.resolve("snapshots/kb-1")))
            assertNull(store.getEntry("kb-1"))
            assertNull(store.readText("kb-1"))
            assertTrue(store.search("唯一").isEmpty())
            assertFalse(Files.exists(root.resolve("snapshots/kb-1")), "残留的本机缓存条目随下轮对账清掉")
        }
    }

    @Test
    fun `reconcile removes orphan snapshots and caches but keeps snapshots whose entry file exists`() {
        KbFileStore(root).use { store ->
            val src = source("a.md", "存活".toByteArray())
            ingest(store, "kb-1", src)
            // 孤儿：没有条目的快照目录与检索缓存（id 形态的目录名才归对账管）
            Files.createDirectories(root.resolve("snapshots/kb-000000ff"))
            Files.writeString(root.resolve("snapshots/kb-000000ff/a.md"), "孤儿")
            Files.writeString(root.resolve("text/kb-000000ff.txt"), "孤儿")
            // 条目文件在但内容损坏：快照必须留着（损坏不等于不存在）
            Files.createDirectories(root.resolve("snapshots/kb-000000ee"))
            Files.writeString(root.resolve("snapshots/kb-000000ee/a.md"), "等修复")
            Files.writeString(root.resolve("entries/kb-000000ee.json"), "{ not json")
            // 不是条目 id 形态的东西：一概不碰
            Files.createDirectories(root.resolve("snapshots/keep-me"))
            Files.writeString(root.resolve("snapshots/keep-me/x.md"), "x")
            Files.writeString(root.resolve("text/README.md"), "x")

            assertTrue(reconcile(store) > 0)

            assertFalse(Files.exists(root.resolve("snapshots/kb-000000ff")))
            assertFalse(Files.exists(root.resolve("text/kb-000000ff.txt")))
            assertTrue(Files.exists(root.resolve("snapshots/kb-1")))
            assertTrue(Files.exists(root.resolve("snapshots/kb-000000ee/a.md")))
            assertTrue(Files.exists(root.resolve("snapshots/keep-me/x.md")))
            assertTrue(Files.exists(root.resolve("text/README.md")))
        }
    }

    @Test
    fun `a stale cache of an entry with neither source nor snapshot is dropped`() {
        KbFileStore(root).use { store ->
            val src = source("a.md", "还在时的正文".toByteArray())
            ingest(store, "kb-1", src)
            reconcile(store)
            Files.delete(src)
            Files.delete(snapshotOf("kb-1")!!) // 快照也没了：只剩过时的检索缓存
            assertEquals("还在时的正文", store.readText("kb-1"))

            assertTrue(reconcile(store) > 0)

            assertNull(store.readText("kb-1")) // 没有内容来源的条目不留过时正文
        }
    }

    private fun assertFailsWithIOException(block: () -> Unit) {
        try {
            block()
        } catch (e: java.io.IOException) {
            return
        }
        throw AssertionError("expected IOException")
    }
}
