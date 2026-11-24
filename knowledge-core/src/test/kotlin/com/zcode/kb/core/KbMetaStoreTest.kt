package com.zcode.kb.core

import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.io.TempDir

/**
 * 知识库元数据存储的公共实现（KbMetaStore）。两类断言：
 *
 * 1. 文件格式不变——写出的条目与 config 文件，与 IDE 侧过去一直使用的序列化写法逐字节相同
 *    （对照样本由那个序列化库当场生成），读取口径也一致：存量文件不会被重排，损坏的判定不变；
 * 2. 收录与元数据编辑的落库规则。
 */
class KbMetaStoreTest {

    @TempDir
    lateinit var dir: Path

    /** IDE 侧过去写库用的序列化配置，原样留在这里当对照样本 */
    private val oracle = Json { encodeDefaults = true; prettyPrint = true; ignoreUnknownKeys = true }

    @Serializable
    private data class ConfigFile(
        val version: Int = 2,
        val folders: List<KbFolder> = emptyList(),
        val tags: List<KbTagMeta> = emptyList(),
    )

    private fun entryFile(root: Path, id: String): String = Files.readString(root.resolve("entries/$id.json"))

    private fun configFile(root: Path): String = Files.readString(root.resolve("config.json"))

    private fun writeEntryFile(text: String, id: String = "kb-dddd4444") {
        Files.createDirectories(dir.resolve("entries"))
        Files.writeString(dir.resolve("entries/$id.json"), text)
    }

    private fun sha256(f: Path): String =
        java.security.MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(f)).joinToString("") { "%02x".format(it) }

    private val plainText = KbContent.TextExtractor { Files.readString(it) }

    // ───────────────────────── 文件格式：写出的字节与过去一致 ─────────────────────────

    @Test
    fun `entry files are byte-identical to what the IDE has always written`() {
        val samples = listOf(
            KbEntry(id = "kb-aaaa1111", sourcePath = "d:/a.md", title = "甲"), // 全是默认值
            KbEntry(
                id = "kb-bbbb2222", sourcePath = "D:/文档/指南 v2.md",
                title = "引号\" 反斜杠\\ 换行\n 回车\r 制表\t 控制\u0001\u001f 结尾",
                folderId = "f-0a1b2c3d",
                tags = listOf("ZooKeeper", "含,逗号\"引号\"", "emoji 🚀", "／全角斜杠/半角"),
                notes = "备注\n第二行\\",
                project = "仓库名", fileExt = ".md", sizeBytes = 1234567890123456L,
                contentHash = "00ff", ingestedAt = 1761200000000L, updatedAt = 1761200000123L, order = 7,
            ),
        )
        for (e in samples) {
            KbFileStore(dir).use { it.insert(e, "x") }
            assertEquals(oracle.encodeToString(KbEntry.serializer(), e), entryFile(dir, e.id), "条目 ${e.id}")
        }
    }

    @Test
    fun `config file is byte-identical to what the IDE has always written`() {
        KbFileStore(dir).use { s ->
            val r1 = s.createFolder(null, "信创适配")
            s.createFolder(r1, "中间件")
            s.createFolder(null, "运维")
            assertEquals(
                oracle.encodeToString(ConfigFile.serializer(), ConfigFile(2, s.folders(), emptyList())),
                configFile(dir),
            )
            s.ensureTagMeta("ZooKeeper", "#4A9EFF")
            s.ensureTagMeta("Keepalived", "#59C17C")
            assertEquals(oracle.encodeToString(ConfigFile.serializer(), ConfigFile(2, s.folders(), s.tagMetas())), configFile(dir))
            s.renameFolder(r1, "引号\" 换行\n")
            assertEquals(oracle.encodeToString(ConfigFile.serializer(), ConfigFile(2, s.folders(), s.tagMetas())), configFile(dir))
        }
        // 旧版 config 的 version 原样带回，不擅自升
        Files.writeString(dir.resolve("config.json"), oracle.encodeToString(ConfigFile.serializer(), ConfigFile(1)))
        KbFileStore(dir).use { s ->
            s.createFolder(null, "x")
            assertEquals(oracle.encodeToString(ConfigFile.serializer(), ConfigFile(1, s.folders(), emptyList())), configFile(dir))
        }
    }

    @Test
    fun `entries written before are read as they are and unknown keys are dropped on the next write`() {
        val e = KbEntry(id = "kb-cccc3333", sourcePath = "d:/c.md", title = "丙", tags = listOf("a"), sizeBytes = 99, order = 3)
        // 一期遗留字段（读取时现算的状态、git 锚点、源文件 stat）与别处写入的未知键
        val legacy = oracle.encodeToString(KbEntry.serializer(), e).replace(
            "{\n",
            "{\n    \"status\": \"ok\",\n    \"indexedMtime\": 1700000000000,\n    \"gitRepo\": \"x\",\n    \"someFutureKey\": [1, 2],\n",
        )
        writeEntryFile(legacy, e.id)
        KbFileStore(dir).use { s ->
            assertEquals(e, s.getEntry(e.id))
            s.transformEntry(e.id) { it.copy(title = "改") }
            assertEquals(oracle.encodeToString(KbEntry.serializer(), e.copy(title = "改")), entryFile(dir, e.id))
        }
    }

    // ───────────────────────── 文件格式：读取口径与过去一致 ─────────────────────────

    @Test
    fun `an entry file counts as corrupt exactly when the old reader rejected it`() {
        val good = """{"id":"kb-dddd4444","sourcePath":"d:/d.md","title":"丁","tags":["a"],"sizeBytes":12,""" +
            """"ingestedAt":1700000000000,"updatedAt":1700000000001,"order":2}"""
        val rejected = listOf(
            good.replace("\"title\":\"丁\",", ""), // 缺必填字段
            good.replace("\"sourcePath\":\"d:/d.md\",", ""),
            good.replace("\"id\":\"kb-dddd4444\",", "\"id\":123,"),
            good.replace("\"title\":\"丁\"", "\"title\":null"),
            good.replace("\"tags\":[\"a\"]", "\"tags\":\"a\""), // 类型不对
            good.replace("\"tags\":[\"a\"]", "\"tags\":[1]"),
            good.replace("\"order\":2", "\"order\":null"),
            good.replace("\"order\":2", "\"order\":\"x\""),
            good.replace("\"order\":2", "\"order\":true"),
            "not json at all",
            "[1,2]",
            "",
        )
        for (text in rejected) {
            writeEntryFile(text)
            assertNull(runCatching { oracle.decodeFromString(KbEntry.serializer(), text) }.getOrNull(), "对照样本应当拒收：$text")
            assertNull(KbMetaStore(dir).entry("kb-dddd4444"), text)
        }
        // 数值字段：带引号的数字照收（与过去的读法一致）
        for (text in listOf(good.replace("\"order\":2", "\"order\":\"2\""), good.replace("\"sizeBytes\":12", "\"sizeBytes\":\"12\""))) {
            writeEntryFile(text)
            val read = KbFileStore.toEntry(KbMetaStore(dir).entry("kb-dddd4444")!!)
            assertEquals(oracle.decodeFromString(KbEntry.serializer(), text), read, text)
        }
        // 小数、指数的写法过去的读法拒收，现在照收并截断取整：别的工具写出的这种文件不再被当成损坏丢掉
        for (text in listOf(good.replace("\"order\":2", "\"order\":2.0"), good.replace("\"order\":2", "\"order\":2.7"),
                            good.replace("\"sizeBytes\":12", "\"sizeBytes\":1.2e1"))) {
            writeEntryFile(text)
            val read = KbFileStore.toEntry(KbMetaStore(dir).entry("kb-dddd4444")!!)
            assertEquals(2, read.order, text)
            assertEquals(12L, read.sizeBytes, text)
        }
    }

    @Test
    fun `config is read with the same leniency as before`() {
        val cases = listOf(
            """{"version":1,"modules":["a"]}""",
            """{"version":1,"lastFolderId":"f-1","folders":[{"id":"f-1","name":"a","order":3}],"tags":[{"name":"t","color":"#112233"}]}""",
            """{"folders":[{"id":"f-1"}]}""", // 缺 name：整份按损坏，读成空目录树
            """{"tags":[{"name":"t"}]}""",
            """{broken""",
            """[]""",
            """{"version":"2"}""",
        )
        for (text in cases) {
            Files.writeString(dir.resolve("config.json"), text)
            val old = runCatching { oracle.decodeFromString(ConfigFile.serializer(), text) }.getOrDefault(ConfigFile())
            val store = KbMetaStore(dir)
            assertEquals(old.folders, store.folders().map { KbFolder(it.id, it.name, it.parentId, it.order) }, text)
            assertEquals(old.tags, store.tagMetas().map { KbTagMeta(it.name, it.color) }, text)
        }
    }

    @Test
    fun `an empty parent id reads as the root level`() {
        Files.writeString(dir.resolve("config.json"), """{"version":2,"folders":[{"id":"f-1","name":"a","parentId":"","order":0}],"tags":[]}""")
        assertEquals(KbFolder("f-1", "a", null, 0), KbFileStore(dir).folders().single())
    }

    @Test
    fun `an entry file whose id is not a safe id is skipped`() {
        writeEntryFile("""{"id":"../x","sourcePath":"d:/a.md","title":"a"}""", "kb-aaaa1111")
        assertEquals(0, KbFileStore(dir).entryCount())
        // 写入侧同样拒绝：id 会拼进文件路径
        assertFailsWith<IllegalArgumentException> {
            KbFileStore(dir).insert(KbEntry(id = "../x", sourcePath = "d:/a.md", title = "a"), "x")
        }
    }

    // ───────────────────────── 收录与元数据编辑 ─────────────────────────

    @Test
    fun `ingest builds the entry the same way whichever side calls it`() {
        val src = dir.resolve("docs/指南.md")
        val noExt = dir.resolve("docs/README")
        val dotFile = dir.resolve("docs/.gitignore")
        Files.createDirectories(src.parent)
        Files.writeString(src, "# 指南\n正文")
        Files.writeString(noExt, "x")
        Files.writeString(dotFile, "x")
        assertEquals(listOf("指南", "README", ".gitignore"), listOf(src, noExt, dotFile).map { KbMetaStore.defaultTitle(it) })
        assertEquals(listOf(".md", "", ""), listOf(src, noExt, dotFile).map { KbMetaStore.fileExtOf(it) })

        val store = KbFileStore(dir)
        val first = store.ingest(src, "  ", "", listOf("ZooKeeper", "ZooKeeper", "a,b", " ", "c\"d"), null, plainText, null)
        assertFalse(first.existed)
        assertTrue(first.textExtracted)
        assertTrue(first.snapshotCaptured)
        val e = first.entry
        assertEquals(KbFileStore.newId(src.toString()), e.id)
        assertEquals("指南", e.title) // 标题空白：取文件名去扩展名
        assertEquals(listOf("ZooKeeper", "a b", "c d"), e.tags)
        assertEquals("", e.notes)
        assertEquals("docs", e.project) // 没给 git：取父目录名
        assertEquals(Files.size(src), e.sizeBytes)
        assertEquals(sha256(src), e.contentHash)
        assertEquals(Files.readString(src), store.readText(e.id))

        // 同一源文件再次收录：传了的覆盖，没传的保留；目录、内容哈希都刷新，收录时间不动
        val folderId = store.ensureFolderPath("运维/中间件")
        val again = store.ingest(src, "", folderId, null, "备注", plainText, null)
        assertTrue(again.existed)
        assertEquals(e.id, again.entry.id)
        assertEquals("指南", again.entry.title)
        assertEquals(folderId, again.entry.folderId)
        assertEquals(listOf("ZooKeeper", "a b", "c d"), again.entry.tags)
        assertEquals("备注", again.entry.notes)
        assertEquals(e.ingestedAt, again.entry.ingestedAt)

        // 提取不出正文、没有扩展名：照常收录，检索缓存为空，只有标题和标签参与检索
        val failed = store.ingest(noExt, null, "", null, null, KbContent.TextExtractor { throw java.io.IOException("boom") }, null)
        assertFalse(failed.textExtracted)
        assertEquals("README", failed.entry.title)
        assertEquals("", failed.entry.fileExt)
        assertEquals("", store.readText(failed.entry.id))
    }

    @Test
    fun `edit changes only the fields it is given and relink re-points the entry`() {
        val a = dir.resolve("a.md")
        val b = dir.resolve("sub/b.txt")
        Files.createDirectories(b.parent)
        Files.writeString(a, "旧正文")
        Files.writeString(b, "新正文")
        val store = KbFileStore(dir)
        val e = store.ingest(a, "甲", "", listOf("t1"), "备注", plainText, null).entry

        val edited = store.edit(e.id, "  ", null, listOf("t2"), null)!! // 空白标题 = 保留原标题；没传的不动
        assertEquals("甲", edited.title)
        assertEquals(listOf("t2"), edited.tags)
        assertEquals("备注", edited.notes)
        assertNull(store.edit("kb-00000000", "x", null, null, null)) // 条目不存在：不写盘

        // 改指新源文件：以新文件为准重新落文档快照（随之改名）与内容哈希；id、标题、标签、备注不动
        val relinked = store.relink(e.id, b, "新正文")!!
        assertEquals(e.id, relinked.id)
        assertEquals(b.toString().replace('\\', '/'), relinked.sourcePath)
        assertEquals(".txt", relinked.fileExt)
        assertEquals("甲", relinked.title)
        assertEquals(listOf("t2"), relinked.tags)
        assertEquals("新正文", store.readText(e.id))
        assertEquals(sha256(b), relinked.contentHash)
        assertEquals(Files.size(b), relinked.sizeBytes)
        assertTrue(Files.exists(dir.resolve("snapshots/${e.id}/b.txt")))
        assertFalse(Files.exists(dir.resolve("snapshots/${e.id}/a.md")))

        assertNull(store.relink("kb-00000000", a, "x")) // 条目不存在：不留孤儿快照
        assertFalse(Files.exists(dir.resolve("snapshots/kb-00000000")))
    }

    // ───────────────────────── 没有变化的写不落盘、边角规则 ─────────────────────────

    @Test
    fun `operations that change nothing leave the file bytes alone`() {
        val store = KbFileStore(dir)
        store.createFolder(null, "A")
        store.ensureTagMeta("t", "#4A9EFF")
        val config = configFile(dir)
        store.ensureFolderPath("A")
        store.ensureFolderPath("")
        store.renameFolder("f-nope", "x")
        store.renameTag("nope", "x")
        store.deleteTag("nope")
        assertEquals(config, configFile(dir))
    }

    @Test
    fun `a new folder goes after its siblings whichever way the parent is given`() {
        val store = KbFileStore(dir)
        store.createFolder(null, "A")
        store.createFolder("", "B")
        store.createFolder(null, "C")
        assertEquals(listOf(0, 1, 2), store.folders().map { it.order })
    }

    @Test
    fun `tags are cleaned deduplicated and capped at twenty`() {
        assertEquals(listOf("a", "b"), KbMetaStore.sanitizeTags(listOf(" a ", "a", "b,", "\"b\"")))
        assertEquals((1..20).map { "t$it" }, KbMetaStore.sanitizeTags((1..30).map { "t$it" }))
    }

    @Test
    fun `a closed store refuses to write and still reads`() {
        val core = KbMetaStore(dir)
        core.ensureDirectories()
        core.close()
        assertFailsWith<IllegalStateException> { core.writeText("kb-aaaa1111", "x") }
        assertNull(core.entry("kb-aaaa1111"))
    }
}
