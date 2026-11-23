package com.zcode.kb.core

import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.jupiter.api.io.TempDir

class KbFileStoreTest {

    @TempDir
    lateinit var dir: Path

    private fun newStore(root: Path = dir): KbFileStore = KbFileStore(root)

    private fun entry(
        id: String,
        path: String,
        title: String = "t-$id",
        folderId: String = "",
        tags: List<String> = emptyList(),
        project: String = "",
    ) = KbEntry(
        id = id, sourcePath = path, title = title, folderId = folderId, tags = tags,
        project = project, fileExt = ".md", ingestedAt = System.currentTimeMillis(),
        updatedAt = System.currentTimeMillis(),
    )

    @Test
    fun `insert find by source dedupe key is case insensitive on windows-like paths`() {
        val s = newStore()
        s.insert(entry("kb-1", "E:/Projects/Docs/Guide.md"), "正文内容 内容")
        assertNotNull(s.findBySource("E:\\projects\\docs\\guide.md")) // 反斜杠+大小写差异同一条
        assertNull(s.findBySource("E:/other.md"))
        assertEquals(1, s.entryCount())
    }

    @Test
    fun `entries persist across reopen`() {
        newStore().insert(entry("kb-1", "d:/a.md", title = "标题甲"), "正文乙")
        val again = KbFileStore(dir) // 模拟 IDE 重启：同一目录重开
        assertEquals("标题甲", again.getEntry("kb-1")!!.title)
        assertEquals("正文乙", again.readText("kb-1"))
        assertEquals(1, again.entryCount())
    }

    @Test
    fun `snapshot dir relocation persists and reroutes text cache`() {
        val s = newStore()
        s.insert(entry("kb-1", "d:/1.md"), "旧根缓存")
        assertEquals("旧根缓存", s.readText("kb-1"))
        val snapRoot = dir.resolve("snap")
        s.setSnapshotDir(snapRoot.toString())
        // store 层只切指针不搬目录（搬移由 service 层负责）：旧缓存留在旧根、新根读不到
        assertNull(s.readText("kb-1"))
        // 新写入落新根
        s.insert(entry("kb-2", "d:/2.md"), "新根缓存")
        assertEquals("新根缓存", s.readText("kb-2"))
        assertTrue(java.nio.file.Files.exists(snapRoot.resolve("text/kb-2.txt")))
        assertFalse(java.nio.file.Files.exists(snapRoot.resolve("text/kb-1.txt")))
        // 重开 store：config.snapshotDir 权威解析，读侧落新根
        val again = KbFileStore(dir)
        assertEquals(snapRoot, again.snapshotDir())
        assertEquals("新根缓存", again.readText("kb-2"))
        // 恢复默认（空串）后回落元数据根
        again.setSnapshotDir("")
        assertEquals(dir, again.snapshotDir())
        assertEquals("旧根缓存", again.readText("kb-1"))
    }

    @Test
    fun `folders persist and derive display path`() {
        val s = newStore()
        val root = s.createFolder(null, "信创适配")
        val mid = s.createFolder(root, "中间件")
        val again = KbFileStore(dir)
        assertEquals("信创适配", again.folderPath(root))
        assertEquals("信创适配/中间件", again.folderPath(mid))
        assertEquals("", again.folderPath(""))        // 根级/根级
        assertEquals("", again.folderPath("f-nonexist")) // 断链 id 容错
    }

    @Test
    fun `ensureFolderPath creates missing levels and reuses existing`() {
        val s = newStore()
        val id1 = s.ensureFolderPath("运维/部署/Nginx")
        val id2 = s.ensureFolderPath("运维/部署/Nginx") // 幂等复用
        assertEquals(id1, id2)
        assertEquals("运维/部署/Nginx", s.folderPath(id1))
        assertEquals(3, s.folders().size)
        // 不同分支下同名子目录并存（id 区分）
        s.ensureFolderPath("开发/部署")
        assertEquals(5, s.folders().size)
    }

    @Test
    fun `rename folder keeps entry ids and updates path`() {
        val s = newStore()
        val root = s.createFolder(null, "旧名")
        val child = s.createFolder(root, "子")
        s.insert(entry("kb-1", "d:/1.md", folderId = root), "x")
        s.renameFolder(root, "新名")
        assertEquals("新名", s.getEntry("kb-1")!!.folderId.let { s.folderPath(it) }.substringBefore('/'))
        assertEquals("新名/子", s.folderPath(child))
        assertEquals(root, s.getEntry("kb-1")!!.folderId) // 重命名不动条目挂载（id 引用）
    }

    @Test
    fun `delete folder cascades subtree and returns entries to uncategorized`() {
        val s = newStore()
        val root = s.createFolder(null, "信创")
        val mid = s.createFolder(root, "中间件")
        val leaf = s.createFolder(mid, "DM8")
        s.insert(entry("kb-1", "d:/1.md", folderId = root), "x")
        s.insert(entry("kb-2", "d:/2.md", folderId = leaf), "y")
        s.insert(entry("kb-3", "d:/3.md"), "z") // 根级不受影响

        val moved = s.deleteFolder(root)
        assertEquals(2, moved) // kb-1、kb-2 退回根级
        assertTrue(s.folders().isEmpty())
        assertEquals("", s.getEntry("kb-1")!!.folderId)
        assertEquals("", s.getEntry("kb-2")!!.folderId)
        assertEquals("", s.getEntry("kb-3")!!.folderId)
    }

    @Test
    fun `move folder rejects cycle and reparents`() {
        val s = newStore()
        val a = s.createFolder(null, "A")
        val b = s.createFolder(a, "B")
        val c = s.createFolder(b, "C")
        // B 拖到自己的子孙 C 下 → 防环拒绝
        assertFalse(s.moveFolder(b, c))
        assertEquals(a, s.folders().first { it.id == b }.parentId)
        // C 拖到根级 → 成功换父
        assertTrue(s.moveFolder(c, null))
        val cf = s.folders().first { it.id == c }
        assertNull(cf.parentId)
        assertEquals("C", s.folderPath(c)) // 路径随挂载点变化
    }

    @Test
    fun `move entries to folder and back to uncategorized`() {
        val s = newStore()
        val f = s.createFolder(null, "信创")
        s.insert(entry("kb-1", "d:/1.md"), "x")
        s.insert(entry("kb-2", "d:/2.md"), "y")
        s.reorderEntries(listOf("kb-1", "kb-2"), f) // 默认尾部 = 原移动语义
        assertEquals(f, s.getEntry("kb-1")!!.folderId)
        assertEquals(f, s.getEntry("kb-2")!!.folderId)
        // 断链目标容错回根级
        s.reorderEntries(listOf("kb-1"), "f-nonexist")
        assertEquals("", s.getEntry("kb-1")!!.folderId)
        s.reorderEntries(listOf("kb-2"), "")
        assertEquals("", s.getEntry("kb-2")!!.folderId)
    }

    @Test
    fun `reorder entries reorders within layer and persists order`() {
        val s = newStore()
        s.insert(entry("kb-1", "d:/1.md"), "a")
        Thread.sleep(5)
        s.insert(entry("kb-2", "d:/2.md"), "b")
        Thread.sleep(5)
        s.insert(entry("kb-3", "d:/3.md"), "c")
        // 未排序层 = ingestedAt 倒序（新收录在上）
        assertEquals(listOf("kb-3", "kb-2", "kb-1"), s.listEntries().map { it.id })
        val updatedAtBefore = s.getEntry("kb-1")!!.updatedAt
        // 拖 kb-2 到层首（摘出前位次 0）
        s.reorderEntries(listOf("kb-2"), "", 0)
        assertEquals(listOf("kb-2", "kb-3", "kb-1"), s.listEntries().map { it.id })
        // 同层自拖校正：kb-2 排到 kb-3 之后 = 插入线在 kb-3 下边缘（摘出前位次 2）
        s.reorderEntries(listOf("kb-2"), "", 2)
        assertEquals(listOf("kb-3", "kb-2", "kb-1"), s.listEntries().map { it.id })
        // order 全层重写 0..n-1 且落盘
        val again = KbFileStore(dir)
        assertEquals(listOf("kb-3", "kb-2", "kb-1"), again.listEntries().map { it.id })
        assertEquals(listOf(0, 1, 2), again.listEntries().map { it.order })
        // 排序不刷 updatedAt（纯排序无内容变化）
        assertEquals(updatedAtBefore, again.getEntry("kb-1")!!.updatedAt)
    }

    @Test
    fun `reorder entries moves across folders with insert index`() {
        val s = newStore()
        val f = s.createFolder(null, "信创")
        s.insert(entry("kb-1", "d:/1.md", folderId = f), "a")
        Thread.sleep(5)
        s.insert(entry("kb-2", "d:/2.md", folderId = f), "b")
        Thread.sleep(5)
        s.insert(entry("kb-3", "d:/3.md"), "c")
        // 根级 kb-3 拖入 f 层首：跨层移动 + 插位
        s.reorderEntries(listOf("kb-3"), f, 0)
        assertEquals(f, s.getEntry("kb-3")!!.folderId)
        assertEquals(listOf("kb-3", "kb-2", "kb-1"), s.listEntries(KbFilter(folderId = f)).map { it.id })
        assertEquals(listOf(0, 1, 2), s.listEntries(KbFilter(folderId = f)).map { it.order })
        // 原层（根级）已空
        assertEquals(emptyList(), s.listEntries(KbFilter(folderId = "")).map { it.id })
    }

    @Test
    fun `reorder entries multi-select across origin layers and clamps index`() {
        val s = newStore()
        val f = s.createFolder(null, "信创")
        s.insert(entry("kb-1", "d:/1.md", folderId = f), "a")
        Thread.sleep(5)
        s.insert(entry("kb-2", "d:/2.md", folderId = f), "b")
        Thread.sleep(5)
        s.insert(entry("kb-3", "d:/3.md"), "c") // 根级
        Thread.sleep(5)
        s.insert(entry("kb-4", "d:/4.md"), "d") // 根级
        // 多选跨源层拖入 f 层首：f 的 kb-1 + 根级的 kb-3 一起拖
        s.reorderEntries(listOf("kb-1", "kb-3"), f, 0)
        assertEquals(listOf("kb-1", "kb-3", "kb-2"), s.listEntries(KbFilter(folderId = f)).map { it.id })
        // 各原层剩余条目 order 重写收拢空洞（根级剩 kb-4）
        assertEquals(listOf("kb-4"), s.listEntries(KbFilter(folderId = "")).map { it.id })
        assertEquals(listOf(0), s.listEntries(KbFilter(folderId = "")).map { it.order })
        // 越界截尾兜底：kb-2 拖到尾部（已在尾部，位置不变）
        s.reorderEntries(listOf("kb-2"), f, 99)
        assertEquals(listOf("kb-1", "kb-3", "kb-2"), s.listEntries(KbFilter(folderId = f)).map { it.id })
    }

    @Test
    fun `legacy entry json without order field reads as zero`() {
        newStore().insert(entry("kb-1", "d:/1.md"), "x")
        // 手写旧版格式（无 order 字段，encodeDefaults 之前的落盘形态）
        Files.writeString(
            dir.resolve("entries").resolve("kb-1.json"),
            "{\"id\":\"kb-1\",\"sourcePath\":\"d:/1.md\",\"title\":\"旧格式\",\"folderId\":\"\",\"tags\":[]," +
                "\"notes\":\"\",\"project\":\"\",\"fileExt\":\".md\",\"sizeBytes\":0,\"status\":\"ok\"," +
                "\"ingestedAt\":100,\"updatedAt\":100,\"indexedMtime\":0,\"indexedSize\":0}",
        )
        val s = newStore()
        val e = s.getEntry("kb-1")!!
        assertEquals(0, e.order)
        assertEquals("旧格式", e.title)
    }

    @Test
    fun `move folder insert index reorders siblings`() {
        val s = newStore()
        val a = s.createFolder(null, "A")
        val b = s.createFolder(null, "B")
        val c = s.createFolder(null, "C")
        // folders() 返回 config 存储序（创建序），视觉序按 order 排——断言用 sortedBy order
        fun layerNames(svc: KbFileStore) = svc.folders().sortedBy { it.order }.map { it.name }
        assertEquals(listOf("A", "B", "C"), layerNames(s))
        // A 拖到 B 下边缘（摘出前视觉位次 2）→ 排 B 之后（摘出偏移内部校正）
        assertTrue(s.moveFolder(a, null, 2))
        assertEquals(listOf("B", "A", "C"), layerNames(s))
        // A 拖到层首（插入线 index 0）
        assertTrue(s.moveFolder(a, null, 0))
        assertEquals(listOf("A", "B", "C"), layerNames(s))
        // 默认尾部（右键移动/不传位次）
        assertTrue(s.moveFolder(a, null))
        assertEquals(listOf("B", "C", "A"), layerNames(s))
        // 越界截尾 + 落盘持久化
        assertTrue(s.moveFolder(c, null, 99))
        val again = KbFileStore(dir)
        assertEquals(listOf("B", "A", "C"), layerNames(again))
        assertEquals(listOf(0, 1, 2), again.folders().sortedBy { it.order }.map { it.order })
    }

    @Test
    fun `search hits tags channel with weight between title and body`() {
        val s = newStore()
        // 标题/正文都不含「部署」，仅标签命中 → AND 判据的第三渠道
        s.insert(entry("kb-1", "d:/1.md", title = "上线 checklist", tags = listOf("部署", "发布")), "上线前核对分支与回滚预案")
        // 标题+正文命中（对照：权重应高于纯标签命中）
        s.insert(entry("kb-2", "d:/2.md", title = "部署手册"), "集群部署实践")
        val hits = s.search("部署")
        assertEquals(2, hits.size)
        assertEquals("kb-2", hits[0].entry.id) // 标题 4 > 标签 2
        assertEquals("kb-1", hits[1].entry.id)
        // 标签命中计入 matchCount（checklist 无正文命中，count=1 全来自标签）
        assertEquals(1, hits[1].matchCount)
    }

    @Test
    fun `search respects folder and tag filters`() {
        val s = newStore()
        val f1 = s.createFolder(null, "信创")
        val f2 = s.createFolder(null, "插件")
        s.insert(entry("kb-1", "d:/1.md", folderId = f1, tags = listOf("nacos", "dm8")), "信创适配部署")
        s.insert(entry("kb-2", "d:/2.md", folderId = f2), "插件开发指南")

        assertEquals(1, s.search("部署", KbFilter(folderId = f1)).size)
        assertEquals(0, s.search("部署", KbFilter(folderId = f2)).size)
        assertEquals(1, s.search("适配", KbFilter(tags = setOf("dm8"))).size)
        assertEquals(0, s.search("适配", KbFilter(tags = setOf("mysql"))).size)
        // 根级过滤：两条均有目录，根级为空
        assertEquals(0, s.listEntries(KbFilter(folderId = "")).size)
    }

    @Test
    fun `multi-tag filter and-or modes`() {
        val s = newStore()
        s.insert(entry("kb-1", "d:/1.md", tags = listOf("nacos", "dm8")), "信创适配")
        s.insert(entry("kb-2", "d:/2.md", tags = listOf("dm8")), "达梦手册")
        s.insert(entry("kb-3", "d:/3.md", tags = listOf("mysql")), "MySQL 指南")
        s.insert(entry("kb-4", "d:/4.md", tags = listOf("redis", "nacos")), "缓存实践")

        // OR（默认）：任一包含即命中
        assertEquals(
            setOf("kb-1", "kb-2", "kb-3"),
            s.listEntries(KbFilter(tags = setOf("dm8", "mysql"))).map { it.id }.toSet(),
        )
        // AND：全部包含才命中（kb-4 只有 nacos 不含 dm8，不命中）
        assertEquals(
            setOf("kb-1"),
            s.listEntries(KbFilter(tags = setOf("dm8", "nacos"), tagMatchAll = true)).map { it.id }.toSet(),
        )
        // AND 无交集为空
        assertEquals(0, s.listEntries(KbFilter(tags = setOf("dm8", "mysql"), tagMatchAll = true)).size)
        // search 同语义：facet 过滤与全文命中正交（标题或正文含「手册」且带 dm8 标签）
        assertEquals(
            listOf("kb-2"),
            s.search("手册", KbFilter(tags = setOf("dm8"), tagMatchAll = false)).map { it.entry.id },
        )
        // 空标签集=不过滤（全量）
        assertEquals(4, s.listEntries(KbFilter(tags = emptySet())).size)
    }

    @Test
    fun `search returns up to three disjoint snippets`() {
        val s = newStore()
        // 分散 3 处命中的长文本：窗口 [-40,+80) 互不重叠 → 3 片段
        val filler = (1..40).joinToString("") { "字$it" }
        val body = "开头" + filler + "部署" + filler + "部署" + filler + "部署" + filler + "结尾"
        s.insert(entry("kb-1", "d:/1.md"), body)
        val hits = s.search("部署")
        assertEquals(1, hits.size)
        assertTrue(hits[0].snippets.size in 2..3, "expect 2-3 snippets, got ${hits[0].snippets.size}")
        assertTrue(hits[0].matchCount >= 3)
        // 片段内都含命中词
        hits[0].snippets.forEach { assertTrue(it.contains("部署"), it.take(20)) }
        // 单命中条目只出 1 个片段
        s.insert(entry("kb-2", "d:/2.md"), "只有一次部署的地方")
        val h2 = s.search("只有一次")
        assertEquals(1, h2.size)
        assertEquals(1, h2[0].snippets.size)
    }

    @Test
    fun `remove entry cleans metadata and text`() {
        val s = newStore()
        s.insert(entry("kb-1", "d:/1.md"), "唯一内容关键词")
        assertEquals(1, s.search("唯一").size)
        s.removeEntry("kb-1")
        assertEquals(0, s.entryCount())
        assertNull(s.readText("kb-1"))
        assertNull(s.getEntry("kb-1"))
        assertTrue(s.search("唯一").isEmpty())
    }

    @Test
    fun `list orders by ingest desc and filters uncategorized`() {
        val s = newStore()
        val f = s.createFolder(null, "m")
        s.insert(entry("kb-1", "d:/1.md", folderId = f), "a")
        Thread.sleep(5)
        s.insert(entry("kb-2", "d:/2.md"), "b")
        assertEquals(listOf("kb-2", "kb-1"), s.listEntries().map { it.id })
        assertEquals(listOf("kb-1"), s.listEntries(KbFilter(folderId = f)).map { it.id })
        assertEquals(listOf("kb-2"), s.listEntries(KbFilter(folderId = "")).map { it.id })
    }

    @Test
    fun `empty folders stay visible and unknown entry folder tolerated`() {
        val s = newStore()
        s.createFolder(null, "空目录")
        assertEquals(1, s.folders().size) // 空目录也保留（拖拽落点）
        // 断链条目（config 手删/损坏）不属任何已知目录：id 精确过滤不含（隔离态），
        // UI 树构建时按根级垫底展示，MCP folderPath 派生为 "" 归根级
        s.insert(entry("kb-1", "d:/1.md", folderId = "f-nonexist"), "x")
        assertEquals(emptyList(), s.listEntries(KbFilter(folderId = "")).map { it.id })
        assertEquals(listOf("kb-1"), s.listEntries().map { it.id })
        assertEquals("", s.folderPath("f-nonexist"))
    }

    @Test
    fun `last folder id round trips`() {
        val s = newStore()
        assertEquals("", s.lastFolderId())
        val f = s.createFolder(null, "信创")
        s.setLastFolderId(f)
        assertEquals(f, KbFileStore(dir).lastFolderId())
    }

    @Test
    fun `clearIndex drops text cache but keeps metadata`() {
        val s = newStore()
        s.insert(entry("kb-1", "d:/1.md", title = "留存标题"), "正文关键词")
        s.clearIndex()
        assertNull(s.readText("kb-1"))
        assertEquals("留存标题", s.getEntry("kb-1")!!.title)
        assertEquals(0, s.search("正文关键词").size) // 正文没了不再命中
        assertEquals(1, s.search("留存标题").size)  // 标题仍可命中
    }

    @Test
    fun `corrupt entry file is isolated not fatal`() {
        val s = newStore()
        s.insert(entry("kb-1", "d:/1.md"), "好内容")
        Files.writeString(dir.resolve("entries").resolve("kb-deadbeef.json"), "{ not json")
        Files.writeString(dir.resolve("entries").resolve("kb-COMMON.json"), "{}") // 非法 id 文件名
        assertEquals(1, s.entryCount())
        assertEquals(listOf("kb-1"), s.allEntries().map { it.id })
        assertNull(s.getEntry("kb-deadbeef"))
    }

    @Test
    fun `legacy config without folders is treated as empty tree`() {
        // 旧版 version 1 config（modules 清单）反序列化：folders 缺省空表，不迁移自然重置
        Files.writeString(dir.resolve("config.json"), "{\"version\":1,\"modules\":[\"旧模块\"]}")
        val s = newStore()
        assertTrue(s.folders().isEmpty())
        assertEquals("", s.lastFolderId())
        // 新写 config 升 version 2（folders 结构覆盖旧文件）
        val f = s.createFolder(null, "新目录")
        assertEquals(f, KbFileStore(dir).folders().single().id)
    }

    @Test
    fun `setStatus flips status and bumps updatedAt`() {
        val s = newStore()
        s.insert(entry("kb-1", "d:/1.md"), "x")
        Thread.sleep(5)
        s.setStatus("kb-1", KbEntry.STATUS_MISSING)
        val e = s.getEntry("kb-1")!!
        assertEquals(KbEntry.STATUS_MISSING, e.status)
        assertTrue(e.updatedAt >= e.ingestedAt)
    }

    @Test
    fun `entry id is deterministic per source path`() {
        // id=normPath 的 SHA-256 指纹：同一源文件摘除重加 id 恒定（外部引用稳定）
        val a = KbFileStore.newId("G:/AI/x.md")
        assertEquals(a, KbFileStore.newId("G:/AI/x.md")) // 同路径同 id
        assertEquals(a, KbFileStore.newId("g:\\ai\\x.md")) // 写法差异（盘符大小写/反斜杠）归一后同 id
        assertEquals(a, KbFileStore.newId("  G:/AI/x.md ")) // trim
        assertTrue(KbFileStore.newId("G:/AI/y.md") != a) // 不同路径不同 id
        assertTrue(KbFileStore.newId("G:/AI/x.md").startsWith("kb-"))
        // 碰撞兜底：原生 id 被占用时确定性派生（同占用状态恒定），无占用时回原生
        val taken = setOf(a)
        assertEquals(KbFileStore.newId("G:/AI/x.md", taken), KbFileStore.newId("G:/AI/x.md", taken))
        assertEquals(a, KbFileStore.newId("G:/AI/x.md", taken = emptySet()))
    }
}
