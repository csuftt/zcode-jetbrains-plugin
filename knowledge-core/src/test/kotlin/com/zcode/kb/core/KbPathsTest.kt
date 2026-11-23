package com.zcode.kb.core

import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.condition.EnabledOnOs
import org.junit.jupiter.api.condition.OS
import org.junit.jupiter.api.io.TempDir
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * 知识库库位置（KbPaths）：入口解析、整体搬迁、失败回滚、用指针文件恢复入口。
 *
 * 真实联接（Windows 目录联接）的用例只在 Windows 跑；拒绝类与回滚类用例用可注入的假联接
 * 实现（不入盘，只记映射），任何平台都能跑，并且能注入「建联接失败」来验证回滚。
 */
class KbPathsTest {

    @TempDir
    lateinit var home: Path

    private val h: String get() = home.toString()

    private val entry: Path get() = KbPaths.entryDir(h)

    private val pointer: Path get() = KbPaths.pointerFile(h)

    private fun write(path: Path, content: String) {
        Files.createDirectories(path.parent)
        Files.writeString(path, content)
    }

    /** 一个有内容的库：条目、配置、检索缓存、文档快照，外加只读的 git 对象文件（模拟同步过的仓库） */
    private fun seedLibrary(dir: Path) {
        write(dir.resolve("entries/kb-1.json"), """{"id":"kb-1","sourcePath":"d:/a.md","title":"条目"}""")
        write(dir.resolve("config.json"), """{"version":2,"folders":[{"id":"f-1","name":"目录"}],"tags":[]}""")
        write(dir.resolve("text/kb-1.txt"), "检索缓存")
        write(dir.resolve("snapshots/kb-1/a.md"), "文档快照")
        val obj = dir.resolve(".git/objects/aa/bbcc")
        write(obj, "blob")
        obj.toFile().setWritable(false)
    }

    /** 假联接：只记映射不入盘；failCreateAt 命中时建联接抛异常（验证回滚） */
    private open class FakeLinks(private val failCreateAt: Path? = null) : KbPaths.LinkOps {
        val links = LinkedHashMap<Path, Path>()
        var creates = 0

        private fun key(p: Path): Path = p.toAbsolutePath().normalize()

        override fun isLink(p: Path): Boolean = links.containsKey(key(p))

        override fun create(link: Path, target: Path) {
            creates++
            if (failCreateAt != null && key(link) == key(failCreateAt)) throw IOException("injected: cannot create link")
            links[key(link)] = key(target)
        }

        override fun remove(link: Path) {
            if (!isLink(link)) {
                if (Files.exists(link, LinkOption.NOFOLLOW_LINKS)) throw IOException("not a link")
                return
            }
            links.remove(key(link))
        }

        override fun supported(target: Path): Boolean = true
    }

    /** 指针文件里记的库目录真实位置（损坏返回 null） */
    private fun pointerRoot(): String? =
        runCatching {
            (kotlinx.serialization.json.Json.parseToJsonElement(Files.readString(pointer))
                as kotlinx.serialization.json.JsonObject)["root"]!!.jsonPrimitive.content
        }.getOrNull()

    private fun done(r: KbPaths.Relocate): Path {
        assertTrue(r is KbPaths.Relocate.Done, "expected Done but was $r")
        return r.root
    }

    // ───────────────────────── 入口解析 ─────────────────────────

    @Test
    fun `entry is the library by default and nothing is created`() {
        assertEquals(entry.toAbsolutePath().normalize(), KbPaths.rootDir(h))
        assertFalse(KbPaths.isCustomized(h))
        assertEquals(entry.resolve("entries"), KbPaths.entriesDir(h))
        assertEquals(entry.resolve("config.json"), KbPaths.configFile(h))
        assertEquals(entry.resolve("text"), KbPaths.textDir(h))
        assertEquals(entry.resolve("snapshots"), KbPaths.snapshotsDir(h))
        assertEquals(entry.toAbsolutePath().normalize(), KbPaths.ensureEntry(h))
        assertFalse(Files.exists(entry, LinkOption.NOFOLLOW_LINKS)) // 库目录首次使用才建
    }

    @Test
    fun `a stale pointer is cleared when the entry is a real directory`() {
        seedLibrary(entry)
        write(pointer, """{"root":"${home.resolve("gone").toString().replace('\\', '/')}"}""")

        assertEquals(entry.toRealPath(), KbPaths.ensureEntry(h))

        assertFalse(Files.exists(pointer))
        assertFalse(KbPaths.isCustomized(h))
        assertTrue(KbPaths.hasLibraryContent(entry))
    }

    @Test
    fun `rootDir falls back to the pointer directory while the entry is missing`() {
        val real = home.resolve("elsewhere/kb")
        seedLibrary(real)
        write(pointer, """{"root":"${real.toString().replace('\\', '/')}"}""")

        assertEquals(real.toRealPath(), KbPaths.rootDir(h))
        assertTrue(KbPaths.isCustomized(h))
        assertFalse(KbPaths.hasLibraryContent(home.resolve("empty")))
        assertFalse(KbPaths.hasLibraryContent(entry))
        // 只有默认配置、没有条目：算空库
        write(entry.resolve("config.json"), """{"version":2,"folders":[],"tags":[]}""")
        assertFalse(KbPaths.hasLibraryContent(entry))
    }

    @Test
    fun `corrupt, relative or dangling pointers fall back to the entry path`() {
        write(pointer, "{broken")
        assertEquals(entry.toAbsolutePath().normalize(), KbPaths.rootDir(h))
        write(pointer, """{"root":"not absolute"}""") // 相对路径：目录不存在
        assertEquals(entry.toAbsolutePath().normalize(), KbPaths.rootDir(h))
        write(pointer, """{"root":"${home.resolve("vanished")}"}""") // 指的目录已不在
        assertEquals(entry.toAbsolutePath().normalize(), KbPaths.rootDir(h))
        assertFalse(KbPaths.isCustomized(h))
    }

    // ───────────────────────── 真实联接（Windows 目录联接） ─────────────────────────

    @Test
    @EnabledOnOs(OS.WINDOWS)
    fun `relocate moves the whole library and links the entry`() {
        seedLibrary(entry)
        val target = home.resolve("elsewhere/知识 库&x")
        Files.createDirectories(target)

        val root = done(KbPaths.relocate(target, h))

        assertTrue(KbPaths.isCustomized(h))
        assertEquals(target.toRealPath(), root)
        assertEquals(target.toRealPath(), KbPaths.rootDir(h))
        assertEquals(target.toRealPath(), entry.toRealPath()) // git 报告的仓库根是真实路径，入口解析出来的也是
        assertTrue(KbPaths.SystemLinkOps.isLink(entry))
        assertTrue(Files.isDirectory(entry))
        // 数据整体在新位置；经入口读写落到真实目录
        assertTrue(Files.exists(target.resolve("entries/kb-1.json")))
        assertTrue(Files.exists(target.resolve(".git/objects/aa/bbcc")))
        assertContentEquals("文档快照".toByteArray(), Files.readAllBytes(entry.resolve("snapshots/kb-1/a.md")))
        Files.writeString(entry.resolve("entries/kb-2.json"), "{}")
        assertTrue(Files.exists(target.resolve("entries/kb-2.json")))
        assertEquals(target.toRealPath().resolve("entries"), KbPaths.entriesDir(h))
        assertEquals(target.toRealPath().toString(), pointerRoot())
        assertTrue(KbPaths.hasLibraryContent(target))
    }

    @Test
    @EnabledOnOs(OS.WINDOWS)
    fun `restore default moves the library back to the entry path and drops the pointer`() {
        seedLibrary(entry)
        val target = home.resolve("elsewhere/kb")
        Files.createDirectories(target)
        done(KbPaths.relocate(target, h))

        val root = done(KbPaths.relocate(entry, h))

        assertEquals(entry.toRealPath(), root)
        assertFalse(KbPaths.isCustomized(h))
        assertFalse(KbPaths.SystemLinkOps.isLink(entry))
        assertFalse(Files.exists(pointer))
        assertTrue(Files.exists(entry.resolve("entries/kb-1.json")))
        assertTrue(Files.exists(entry.resolve("snapshots/kb-1/a.md")))
        assertFalse(Files.exists(target.resolve("entries"))) // 旧位置不留副本
        assertEquals(entry.toRealPath(), KbPaths.rootDir(h))
    }

    @Test
    @EnabledOnOs(OS.WINDOWS)
    fun `moving between two custom locations keeps the entry path stable`() {
        seedLibrary(entry)
        val first = home.resolve("d1/kb")
        val second = home.resolve("d2/知识库")
        Files.createDirectories(first)
        Files.createDirectories(second)
        done(KbPaths.relocate(first, h))

        val root = done(KbPaths.relocate(second, h))

        assertEquals(second.toRealPath(), root)
        assertEquals(second.toRealPath(), entry.toRealPath())
        assertTrue(Files.exists(entry.resolve("entries/kb-1.json")))
        assertFalse(Files.exists(first.resolve("entries")))
        assertEquals(second.toRealPath().toString(), pointerRoot())
        assertEquals(second.toRealPath(), KbPaths.ensureEntry(h)) // 幂等
    }

    @Test
    @EnabledOnOs(OS.WINDOWS)
    fun `a deleted entry link is rebuilt from the pointer file`() {
        seedLibrary(entry)
        val target = home.resolve("elsewhere/kb")
        Files.createDirectories(target)
        done(KbPaths.relocate(target, h))
        Files.delete(entry) // 入口联接被删（非递归，只摘联接）：真实数据不受影响

        assertTrue(Files.exists(target.resolve("entries/kb-1.json")))
        assertEquals(target.toRealPath(), KbPaths.rootDir(h)) // 入口没了：指针兜住，仍知道库在哪
        assertTrue(KbPaths.isCustomized(h))

        assertEquals(target.toRealPath(), KbPaths.ensureEntry(h))

        assertEquals(target.toRealPath(), entry.toRealPath()) // 入口按指针重建
        assertTrue(KbPaths.SystemLinkOps.isLink(entry))
        // 指针文件也丢了：联接本身就是指向记录，启动对齐时把指针补回来
        Files.delete(pointer)
        assertEquals(target.toRealPath(), KbPaths.ensureEntry(h))
        assertEquals(target.toRealPath().toString(), pointerRoot())
    }

    @Test
    @EnabledOnOs(OS.WINDOWS)
    fun `an existing library is adopted when the current one is empty, never overwritten`() {
        val cloned = home.resolve("cloned-kb")
        seedLibrary(cloned)
        // 当前：默认位置的空库（有默认配置与空目录，属于「空」）
        write(entry.resolve("config.json"), """{"version":2,"folders":[],"tags":[]}""")
        Files.createDirectories(entry.resolve("entries"))
        Files.createDirectories(entry.resolve("text"))

        val root = done(KbPaths.relocate(cloned, h))

        assertEquals(cloned.toRealPath(), root)
        assertEquals(cloned.toRealPath(), entry.toRealPath())
        assertTrue(Files.exists(cloned.resolve("entries/kb-1.json"))) // 目标内容原样
        assertEquals("""{"id":"kb-1","sourcePath":"d:/a.md","title":"条目"}""", Files.readString(cloned.resolve("entries/kb-1.json")))
        val aside = home.resolve(".zcgui").toFile().listFiles()!!.map { it.name }.single { it.startsWith("knowledge.pre-adopt-") }
        assertTrue(Files.exists(home.resolve(".zcgui/$aside/config.json"))) // 原入口目录改名保留，没有删
    }

    @Test
    @EnabledOnOs(OS.WINDOWS)
    fun `network paths and relative paths are rejected before touching the disk`() {
        seedLibrary(entry)

        val r1 = KbPaths.relocate(Path.of("\\\\server\\share\\kb"), h)
        val r2 = KbPaths.relocate(Path.of("relative/kb"), h)

        assertEquals(KbPaths.RejectReason.NETWORK_PATH, (r1 as KbPaths.Relocate.Rejected).reason)
        assertEquals(KbPaths.RejectReason.NOT_ABSOLUTE, (r2 as KbPaths.Relocate.Rejected).reason)
        assertTrue(Files.exists(entry.resolve("entries/kb-1.json")))
        assertFalse(Files.exists(pointer))
    }

    // ───────────────────────── 拒绝与回滚（假联接，任何平台） ─────────────────────────

    @Test
    fun `targets inside or containing the library are rejected`() {
        seedLibrary(entry)
        val links = FakeLinks()
        val inside = KbPaths.relocate(entry.resolve("sub/kb"), h, links)
        val contains = KbPaths.relocate(home.resolve(".zcgui"), h, links)

        assertEquals(KbPaths.RejectReason.INSIDE_LIBRARY, (inside as KbPaths.Relocate.Rejected).reason)
        assertEquals(KbPaths.RejectReason.LIBRARY_INSIDE_TARGET, (contains as KbPaths.Relocate.Rejected).reason)
        assertEquals(0, links.creates)
        assertTrue(Files.exists(entry.resolve("entries/kb-1.json")))
    }

    @Test
    fun `a non-empty target is rejected and nothing moves`() {
        seedLibrary(entry)
        val target = home.resolve("elsewhere/kb")
        write(target.resolve("用户自己的文件.txt"), "x")
        val alsoFile = home.resolve("a-file")
        Files.writeString(alsoFile, "x")

        val r1 = KbPaths.relocate(target, h, FakeLinks())
        val r2 = KbPaths.relocate(alsoFile, h, FakeLinks())

        assertEquals(KbPaths.RejectReason.TARGET_OCCUPIED, (r1 as KbPaths.Relocate.Rejected).reason)
        assertEquals(KbPaths.RejectReason.TARGET_OCCUPIED, (r2 as KbPaths.Relocate.Rejected).reason)
        assertTrue(Files.exists(entry.resolve("entries/kb-1.json")))
        assertEquals("x", Files.readString(target.resolve("用户自己的文件.txt")))
    }

    @Test
    fun `an existing library is not adopted over a non-empty current one`() {
        seedLibrary(entry)
        val cloned = home.resolve("cloned-kb")
        seedLibrary(cloned)

        val r = KbPaths.relocate(cloned, h, FakeLinks())

        assertEquals(KbPaths.RejectReason.CURRENT_NOT_EMPTY, (r as KbPaths.Relocate.Rejected).reason)
        assertTrue(Files.exists(entry.resolve("entries/kb-1.json")))
        assertTrue(Files.exists(cloned.resolve("entries/kb-1.json")))
        assertFalse(Files.exists(pointer))
    }

    @Test
    fun `an unsupported entry link is rejected before moving`() {
        seedLibrary(entry)
        val target = home.resolve("elsewhere/kb")
        val links = object : FakeLinks() {
            override fun supported(target: Path): Boolean = false
        }

        val r = KbPaths.relocate(target, h, links)

        assertEquals(KbPaths.RejectReason.LINK_UNSUPPORTED, (r as KbPaths.Relocate.Rejected).reason)
        assertTrue(Files.exists(entry.resolve("entries/kb-1.json")))
        assertFalse(Files.exists(target.resolve("entries")))
        assertEquals(0, links.creates)
    }

    @Test
    fun `relocating to the same place or restoring the default of a default library is a no-op`() {
        seedLibrary(entry)
        val links = FakeLinks()
        assertEquals(entry.toRealPath(), done(KbPaths.relocate(entry, h, links)).toRealPath()) // 默认态的「恢复默认」
        assertEquals(0, links.creates)
        val target = home.resolve("elsewhere/kb")
        Files.createDirectories(target)
        done(KbPaths.relocate(target, h, links)) // 默认 → 自定义（假联接，入口在盘上不存在）
        assertEquals(target.toAbsolutePath().normalize(), done(KbPaths.relocate(target, h, links)))
        assertTrue(Files.exists(target.resolve("entries/kb-1.json")))
        assertFalse(Files.exists(entry, LinkOption.NOFOLLOW_LINKS))

        val restored = done(KbPaths.relocate(entry, h, links)) // 自定义 → 默认：不需要入口联接

        assertEquals(entry.toRealPath(), restored)
        assertTrue(Files.exists(entry.resolve("entries/kb-1.json")))
        assertFalse(Files.exists(target.resolve("entries")))
        assertFalse(Files.exists(pointer))
        assertFalse(KbPaths.isCustomized(h))
    }

    @Test
    fun `rollback when the entry link cannot be created from the default location`() {
        seedLibrary(entry)
        val target = home.resolve("elsewhere/kb")
        val links = FakeLinks(failCreateAt = entry)

        val r = KbPaths.relocate(target, h, links)

        assertEquals(KbPaths.RejectReason.MOVE_FAILED, (r as KbPaths.Relocate.Rejected).reason)
        // 一切回到原样：库在入口路径，目标清掉，没有指针
        assertTrue(Files.exists(entry.resolve("entries/kb-1.json")))
        assertTrue(Files.exists(entry.resolve("snapshots/kb-1/a.md")))
        assertFalse(Files.exists(target.resolve("entries")))
        assertFalse(Files.exists(pointer))
        assertEquals(entry.toRealPath(), KbPaths.rootDir(h))
        assertFalse(KbPaths.isCustomized(h))
    }

    @Test
    fun `rollback when the entry link cannot be created between custom locations`() {
        seedLibrary(entry)
        val first = home.resolve("d1/kb")
        val second = home.resolve("d2/kb")
        Files.createDirectories(first)
        Files.createDirectories(second)
        done(KbPaths.relocate(first, h, FakeLinks()))
        val links = FakeLinks(failCreateAt = entry)

        val r = KbPaths.relocate(second, h, links)

        assertEquals(KbPaths.RejectReason.MOVE_FAILED, (r as KbPaths.Relocate.Rejected).reason)
        // 库回到原自定义位置，指针指回它（入口联接下次启动由 ensureEntry 重建）
        assertTrue(Files.exists(first.resolve("entries/kb-1.json")))
        assertFalse(Files.exists(second.resolve("entries")))
        assertEquals(first.toAbsolutePath().normalize().toString(), pointerRoot())
        assertEquals(first.toAbsolutePath().normalize(), KbPaths.rootDir(h))
    }

    @Test
    fun `restore default needs no entry link and leaves the custom location clean`() {
        seedLibrary(entry)
        val first = home.resolve("d1/kb")
        Files.createDirectories(first)
        done(KbPaths.relocate(first, h, FakeLinks()))
        val links = FakeLinks(failCreateAt = entry)

        val root = done(KbPaths.relocate(entry, h, links))

        assertEquals(entry.toRealPath(), root) // 入口路径重新成为真实目录，全程不建联接
        assertTrue(Files.exists(entry.resolve("entries/kb-1.json")))
        assertTrue(Files.exists(entry.resolve(".git/objects/aa/bbcc")))
        assertFalse(Files.exists(first.resolve("entries")))
        assertFalse(Files.exists(pointer))
        assertEquals(0, links.creates)
    }

    // ───────────────────────── 目录搬移 ─────────────────────────

    @Test
    fun `moveTree relocates the tree including read-only files and removes the source`() {
        val src = home.resolve("a/kb")
        seedLibrary(src)
        val dst = home.resolve("b/kb")

        KbPaths.moveTree(src, dst)

        assertFalse(Files.exists(src))
        assertEquals("检索缓存", Files.readString(dst.resolve("text/kb-1.txt")))
        assertEquals("blob", Files.readString(dst.resolve(".git/objects/aa/bbcc")))
        assertFalse(dst.resolve(".git/objects/aa/bbcc").toFile().canWrite()) // 只读属性保留
        dst.resolve(".git/objects/aa/bbcc").toFile().setWritable(true)
        // 不存在的源、相同位置：无操作
        KbPaths.moveTree(home.resolve("missing"), dst)
        KbPaths.moveTree(dst, dst)
        assertTrue(Files.exists(dst.resolve("entries/kb-1.json")))
    }

    @Test
    fun `moveTree across volumes copies, verifies, then removes the read-only source`() {
        val other = System.getProperty("kb.test.otherVolume")?.takeIf { it.isNotBlank() }
        assumeTrue(other != null, "未指定另一个卷上的目录（-Pkb.test.otherVolume 或系统属性），跳过")
        val src = home.resolve("a/kb")
        seedLibrary(src)
        val dst = Path.of(other).resolve("zcode-kb-test-" + System.nanoTime())

        try {
            KbPaths.moveTree(src, dst)

            assertFalse(Files.exists(src))
            assertEquals("文档快照", Files.readString(dst.resolve("snapshots/kb-1/a.md")))
            assertEquals("blob", Files.readString(dst.resolve(".git/objects/aa/bbcc")))
        } finally {
            dst.toFile().walkBottomUp().forEach { it.setWritable(true) }
            dst.toFile().deleteRecursively()
        }
    }
}
