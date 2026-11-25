package com.zcode.kb.mcp

import com.zcode.kb.core.KbContent
import com.zcode.kb.core.KbEntry
import com.zcode.kb.core.KbExtractor
import com.zcode.kb.core.KbFileStore
import com.zcode.kb.core.KbFilter
import java.io.BufferedReader
import java.io.InputStreamReader
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.jupiter.api.io.TempDir

/**
 * MCP server 契约测试：
 * 1. 跨语言——Kotlin KbFileStore 写文件布局（含目录树 config）、Java KbServerStore 只读
 *    扫描并派生 folderPath，检索行为一致（标签渠道三权重同形）；
 * 2. stdio 全链路——fork 真实 JVM 跑 KbMcpServerMain，按 app-server 的调用序对拍
 *    initialize / tools/list / tools/call（协议 client 假脚本同款纪律）。
 */
class KbMcpServerTest {

    private var proc: Process? = null

    @AfterTest
    fun tearDown() {
        proc?.let { p ->
            p.destroyForcibly()
        }
    }

    /** tools/list 应答真 parse：TOOL JSON 是手工拼接串，逗号缺失类语法错只有 parse 能拦（真机实锤） */
    private fun assertToolNames(rawLine: String, expected: List<String>) {
        val names = Json.parseToJsonElement(rawLine)
            .jsonObject["result"]!!.jsonObject["tools"]!!.jsonArray
            .map { it.jsonObject["name"]!!.jsonPrimitive.content }
        assertEquals(expected, names)
    }

    /**
     * 种子数据：目录树 信创/中间件 两级 + 两条目挂载（folderId 是创建返回的 id）。
     * 收录形态与 IDE 一致：源文件真实存在、文档快照已落、条目带内容哈希。
     */
    private fun seed(dir: Path): Pair<String, String> {
        var f1 = ""
        var f2 = ""
        val x = dir.resolve("docs/x.md")
        val y = dir.resolve("docs/y.md")
        Files.createDirectories(x.parent)
        val xText = "信创适配部署实践：DM8 数据库与 Nacos 集群部署步骤"
        val yText = "React 组件分层约定"
        Files.writeString(x, xText)
        Files.writeString(y, yText)
        val dx = x.toString().replace('\\', '/')
        val dy = y.toString().replace('\\', '/')
        KbFileStore(dir).use { s ->
            f1 = s.createFolder(null, "信创")
            f2 = s.createFolder(f1, "中间件")
            val cx = KbContent.capture(dir, "kb-aaaa1111", dx)
            val cy = KbContent.capture(dir, "kb-bbbb2222", dy)
            s.insert(
                KbEntry(
                    id = "kb-aaaa1111", sourcePath = dx, title = "部署手册",
                    folderId = f2, tags = listOf("nacos", "dm8"), project = "proj-a",
                    sizeBytes = cx.size, contentHash = cx.hash,
                ),
                xText,
            )
            s.insert(
                KbEntry(id = "kb-bbbb2222", sourcePath = dy, title = "前端规范", folderId = "", sizeBytes = cy.size, contentHash = cy.hash),
                yText,
            )
        }
        return f1 to f2
    }

    @Test
    fun `java store reads kotlin written file layout consistently`(@TempDir dir: Path) {
        val (f1, f2) = seed(dir)
        KbServerStore(dir).use { server ->
            assertTrue(server.available())
            assertEquals(2, server.entryCount())

            val hits = server.search("部署", null, null, null, 10)
            assertEquals(1, hits.size)
            assertEquals("kb-aaaa1111", hits[0].id)
            assertTrue(hits[0].snippet.isNotEmpty())
            assertEquals("信创/中间件", hits[0].folder) // 派生展示路径（跨语言读 config）

            // 单字 CJK 查询
            assertEquals(1, server.search("部", null, null, null, 10).size)

            // folder 过滤：精确路径 / 子树前缀 / 根级
            assertEquals(1, server.search("部署", "信创/中间件", null, null, 10).size)
            assertEquals(1, server.search("部署", "信创", null, null, 10).size) // 前缀含子目录
            assertEquals(0, server.search("部署", "插件", null, null, 10).size)
            assertEquals(1, server.list("", null, null, 10).size) // 空串=根级（前端规范条目）

            // 标签渠道：标题不含「nacos」，正文含 → 命中
            assertEquals(1, server.search("nacos", null, null, null, 10).size)
            // tag 过滤
            assertEquals(1, server.list(null, "dm8", null, 10).size)

            // 读全文
            assertEquals("信创适配部署实践：DM8 数据库与 Nacos 集群部署步骤", server.readText("kb-aaaa1111"))
            assertNotNull(server.entry("kb-aaaa1111"))
        }
    }

    @Test
    fun `java store computes status on read and serves snapshot-only entries`(@TempDir dir: Path) {
        // Kotlin 侧收录：文档快照 + 条目带内容哈希
        val src = dir.resolve("doc.md")
        Files.writeString(src, "源文件正文")
        val display = src.toString().replace('\\', '/')
        val snap = dir.resolve("snapshots/kb-cccc3333/doc.md")
        KbFileStore(dir).use { s ->
            val captured = KbContent.capture(dir, "kb-cccc3333", display)
            s.insert(
                KbEntry(
                    id = "kb-cccc3333", sourcePath = display, title = "文档",
                    sizeBytes = captured.size, contentHash = captured.hash,
                ),
                "源文件正文",
            )
        }
        KbServerStore(dir).use { server ->
            val live = server.entry("kb-cccc3333")!!
            assertEquals("ok", live.status) // 读取时现算，盘上的条目文件里没有 status
            assertEquals(display, live.contentPath)

            Files.delete(src) // 源文件没了（删除 / 改名 / 在另一台机器上）
            Files.delete(dir.resolve("text/kb-cccc3333.txt")) // 检索缓存也没了（新克隆下来的状态）
            val snapshotOnly = server.entry("kb-cccc3333")!!
            assertEquals("snapshot", snapshotOnly.status)
            assertEquals(snap.toString().replace('\\', '/'), snapshotOnly.contentPath)
            assertEquals(display, snapshotOnly.sourcePath) // 源路径照旧记录着
            // kb_read / kb_search 的正文：从文档快照即时重建
            assertEquals("源文件正文", server.readText("kb-cccc3333"))
            assertTrue(Files.exists(dir.resolve("text/kb-cccc3333.txt")))
            assertEquals(1, server.search("源文件", null, null, null, 10).size)
            assertEquals("snapshot", server.list(null, null, null, 10).single().status)
        }
        // 连文档快照也没有：失效，没有正文可给
        Files.writeString(dir.resolve("text/kb-cccc3333.txt"), "残留的旧缓存")
        KbContent.deleteSnapshot(dir, "kb-cccc3333")
        KbServerStore(dir).use { server ->
            val missing = server.entry("kb-cccc3333")!!
            assertEquals("missing", missing.status)
            assertEquals("", missing.contentPath)
            assertNull(server.readText("kb-cccc3333"))
        }
    }

    @Test
    fun `java store management writes are readable by kotlin store`(@TempDir dir: Path) {
        seed(dir)
        KbServerStore(dir).use { server ->
            // 全景数据面（kb_tree 数据源）：2 目录、根级 1 条、条目聚合 2 个标签
            assertEquals(2, server.folderStats().size)
            assertEquals("信创/中间件", server.folderStats().first { it.id != "" && it.path == "信创/中间件" }.path)
            assertEquals(1, server.rootCount())

            // 目录：逐级建（Ops/Nginx 两级一起）+ 条目批量移动
            val opsId = server.createFolderPath("Ops/Nginx")
            assertTrue(opsId.startsWith("f-"))
            assertEquals(1, server.moveEntries(listOf("kb-bbbb2222"), "Ops/Nginx", null))

            // 标签：注册自动配色 + 全局改名
            val color = server.ensureTag("ops", null)
            assertTrue(KbFileStore.TAG_PALETTE.contains(color))
            assertEquals(1, server.renameTag("dm8", "达梦"))

            // 条目：批量打标（替换语义）+ 备注
            assertEquals(1, server.updateEntries(listOf("kb-aaaa1111"), null, listOf("nacos", "达梦", "信创"), "AI 补充", null))

            // 防环：挪进自身子孙拒绝；跨层移动成功
            org.junit.jupiter.api.assertThrows<KbServerStore.KbOpException> { server.moveFolder("信创", "信创/中间件", null) }
            server.moveFolder("信创/中间件", "Ops", null)
            // 删 Ops 子树（含挪入的中间件）：两条目全部退根级，不丢数据
            assertEquals(2, server.deleteFolder("Ops"))
        }
        // Kotlin 侧读回：Java 写 → Kotlin 读，跨进程写语义闭环
        KbFileStore(dir).use { s ->
            assertEquals(2, s.entryCount())
            val a = s.getEntry("kb-aaaa1111")!!
            assertEquals("", a.folderId)
            assertEquals(listOf("nacos", "达梦", "信创"), a.tags)
            assertEquals("AI 补充", a.notes)
            val b = s.getEntry("kb-bbbb2222")!!
            assertEquals("", b.folderId)
            assertTrue(s.folders().none { it.name == "Nginx" || it.name == "中间件" })
            assertTrue(s.folders().any { it.name == "信创" })
        }
    }

    @Test
    fun `recoloring an unknown tag is rejected instead of registering it`(@TempDir dir: Path) {
        seed(dir) // 条目带着 nacos / dm8 两个标签
        KbServerStore(dir).use { server ->
            // 名字打错：报业务错误，不能顺手建出一个没有条目在用的空标签
            val miss = org.junit.jupiter.api.assertThrows<KbServerStore.KbOpException> {
                server.setTagColor("naocs", "#123456")
            }
            assertTrue(miss.message!!.contains("tag not found"), miss.message)
            // 只挂在条目上、还没进注册表的标签算存在：改色即补注册（IDE 标签弹窗走的同一条路）
            server.setTagColor("dm8", "#ABCDEF")
            assertEquals("#ABCDEF", server.tagStats().single { it.name == "dm8" }.color)
        }
        KbFileStore(dir).use { s ->
            assertTrue(s.tagMetas().none { it.name == "naocs" }, s.tagMetas().toString())
        }
    }

    @Test
    fun `folder stats follow the order of the IDE tree`(@TempDir dir: Path) {
        // 建目录的先后与名字的码点顺序故意相反：按路径排序会得到另一个结果
        KbFileStore(dir).use { s ->
            val a = s.createFolder(null, "甲")
            s.createFolder(null, "乙")
            s.createFolder(a, "子")
            s.createFolder(null, "A")
            s.createFolder(null, "A-b")
            s.createFolder(s.folders().single { it.name == "A" }.id, "x")
        }
        KbServerStore(dir).use { server ->
            // 工具窗的目录树：每层按拖出来的先后，父目录后紧跟其子目录
            assertEquals(
                listOf("甲", "甲/子", "乙", "A", "A/x", "A-b"),
                server.folderStats().map { it.path },
            )
        }
    }

    @Test
    fun `folder stats keep a folder whose parent is gone`(@TempDir dir: Path) {
        val config = dir.resolve("config.json")
        val top = KbFileStore(dir).use { s ->
            val root = s.createFolder(null, "甲")
            s.createFolder(root, "乙")
            root
        }
        // 父目录的 id 被改掉，子目录就成了断链目录（界面与 MCP 都造不出来，只有手改文件或同步冲突才会出现）
        Files.writeString(config, Files.readString(config).replace("\"id\": \"$top\"", "\"id\": \"f-0ddba11\""))
        KbServerStore(dir).use { server ->
            // 断链的排在最后，但不能从全景里消失
            assertEquals(listOf("甲", "乙"), server.folderStats().map { it.path })
        }
    }

    @Test
    fun `java store move with index reorders layers like IDE`(@TempDir dir: Path) {
        // 自建确定性数据：ingestedAt 递增 → order 全 0 时视觉序 = 收录倒序（新在前）
        KbFileStore(dir).use { s ->
            s.insert(KbEntry(id = "kb-aaaa1111", sourcePath = "d:/1.md", title = "甲", ingestedAt = 1000, updatedAt = 1000), "x")
            s.insert(KbEntry(id = "kb-bbbb2222", sourcePath = "d:/2.md", title = "乙", ingestedAt = 2000, updatedAt = 2000), "y")
            s.insert(KbEntry(id = "kb-cccc3333", sourcePath = "d:/3.md", title = "丙", ingestedAt = 3000, updatedAt = 3000), "z")
            s.insert(KbEntry(id = "kb-dddd4444", sourcePath = "d:/4.md", title = "丁", ingestedAt = 4000, updatedAt = 4000), "w")
            s.createFolder(null, "Ops")
        }
        KbServerStore(dir).use { server ->
            // 初始视觉序与 IDE listEntries 同形
            assertEquals(
                listOf("kb-dddd4444", "kb-cccc3333", "kb-bbbb2222", "kb-aaaa1111"),
                server.list(null, null, null, 10).map { it.id },
            )
            // 多选插到层首：ids 顺序决定相对序
            assertEquals(2, server.moveEntries(listOf("kb-bbbb2222", "kb-cccc3333"), "", 0))
            assertEquals(
                listOf("kb-bbbb2222", "kb-cccc3333", "kb-dddd4444", "kb-aaaa1111"),
                server.list(null, null, null, 10).map { it.id },
            )
            // 同层自拖校正：bbbb（摘出前位次 0）拖到 index=2 = 排 cccc 之后
            assertEquals(1, server.moveEntries(listOf("kb-bbbb2222"), "", 2))
            assertEquals(
                listOf("kb-cccc3333", "kb-bbbb2222", "kb-dddd4444", "kb-aaaa1111"),
                server.list(null, null, null, 10).map { it.id },
            )
            // 跨层插位：aaaa 移入 Ops
            assertEquals(1, server.moveEntries(listOf("kb-aaaa1111"), "Ops", null))
            assertEquals(listOf("kb-aaaa1111"), server.list("Ops", null, null, 10).map { it.id })
            // 目录插位：Plugins 拖到层首（Ops 之前）
            server.createFolderPath("Plugins")
            server.moveFolder("Plugins", "", 0)
            // 越界截尾 + 尾部缺省
            server.moveFolder("Plugins", "", 99)
        }
        // Kotlin 读回：Java 写的 order 落盘语义与 IDE 拖拽闭环
        KbFileStore(dir).use { s ->
            // 根级：cccc(0) bbbb(1) dddd(2)，aaaa 在 Ops
            assertEquals(listOf("kb-cccc3333", "kb-bbbb2222", "kb-dddd4444"), s.listEntries(KbFilter(folderId = "")).map { it.id })
            assertEquals(0, s.getEntry("kb-cccc3333")!!.order)
            assertEquals(2, s.getEntry("kb-dddd4444")!!.order)
            // 目录视觉序：Plugins 拖尾后 = Ops, Plugins
            assertEquals(listOf("Ops", "Plugins"), s.folders().sortedBy { it.order }.map { it.name })
        }
    }

    @Test
    fun `management writes keep every line they do not change`(@TempDir dir: Path) {
        seed(dir)
        val entryA = dir.resolve("entries/kb-aaaa1111.json")
        val entryB = dir.resolve("entries/kb-bbbb2222.json")
        val config = dir.resolve("config.json")
        val before = listOf(entryA, entryB, config).associate { it to Files.readAllLines(it) }

        KbServerStore(dir).use { server ->
            server.ensureTag("ops", null) // config：只多出一个标签
            server.updateEntries(listOf("kb-aaaa1111"), null, listOf("nacos", "dm8", "ops"), null, null) // 条目：只有 tags 变
            server.renameFolder("信创", "信创适配") // config：只有一个目录名变
        }

        // 没被改的条目逐字节不变；被改的文件只有涉及的那几行变，其余行原样（git 历史里看得出到底改了什么）
        assertEquals(before[entryB], Files.readAllLines(entryB))
        for (f in listOf(entryA, config)) {
            val after = Files.readAllLines(f)
            val removed = before.getValue(f).filterNot { it in after }
            assertTrue(removed.size <= 4, "$f 有 ${removed.size} 行被改写：$removed")
            assertTrue(after.first() == "{" && after.last() == "}" && after[1].startsWith("    \""), "$f 不是逐字段一行的排版")
        }
        assertEquals(listOf("nacos", "dm8", "ops"), KbFileStore(dir).use { it.getEntry("kb-aaaa1111")!!.tags })
    }

    @Test
    fun `folder dragged inside its own layer lands where the IDE drops it`(@TempDir dir: Path) {
        KbFileStore(dir).use { s ->
            for (name in listOf("Ops", "Plugins", "Vcs", "Ai")) s.createFolder(null, name)
        }
        KbServerStore(dir).use { server ->
            // Ops 原在首位；拖到摘出前的第 3 个位置（Vcs 与 Ai 之间）
            server.moveFolder("Ops", "", 3)
        }
        // IDE 拖拽语义（KbFileStore.moveFolder，真机验证过的落位）
        KbFileStore(dir).use { s ->
            assertEquals(listOf("Plugins", "Vcs", "Ops", "Ai"), s.folders().sortedBy { it.order }.map { it.name })
        }
        // 反过来：IDE 先拖，MCP 在 IDE 写过的次序上再拖，落位仍按同一套规则
        KbFileStore(dir).use { s -> s.moveFolder(s.folders().single { it.name == "Vcs" }.id, null, 3) }
        KbServerStore(dir).use { server -> server.moveFolder("Ai", "", 0) }
        KbFileStore(dir).use { s ->
            assertEquals(listOf("Ai", "Plugins", "Ops", "Vcs"), s.folders().sortedBy { it.order }.map { it.name })
        }
    }

    @Test
    fun `kb_add and IDE ingest write the same files for the same document`(@TempDir dir: Path) {
        val src = dir.resolve("docs/指南.md")
        Files.createDirectories(src.parent)
        Files.writeString(src, "# 指南\n正文")
        val tags = listOf("ZooKeeper", "ZooKeeper", "a,b")
        val viaMcp = dir.resolve("via-mcp")
        val viaIde = dir.resolve("via-ide")

        val id = KbServerStore(viaMcp).use { it.addEntry(src.toString(), "运维指南", "信创/中间件", tags, "备注")["id"] as String }
        val r = KbFileStore(viaIde).use {
            val folderId = it.ensureFolderPath("信创/中间件")
            it.ingest(src, "运维指南", folderId, tags, "备注", KbContent.TextExtractor { KbExtractor.extract(it) }, "git")
        }
        assertFalse(r.existed)

        // 条目：除收录时间两行外逐行相同；目录 id 是随机生成的，比较时抹掉
        val folderIds = Regex("\"f-[0-9a-f]+\"")
        fun entryLines(lib: Path) = Files.readAllLines(lib.resolve("entries/$id.json"))
            .filterNot { it.contains("\"ingestedAt\"") || it.contains("\"updatedAt\"") }
            .map { it.replace(folderIds, "\"f-\"") }
        assertEquals(id, r.entry.id)
        assertEquals(entryLines(viaMcp), entryLines(viaIde))
        assertEquals(Files.readString(viaMcp.resolve("text/$id.txt")), Files.readString(viaIde.resolve("text/$id.txt")))
        assertContentEquals(Files.readAllBytes(src), Files.readAllBytes(viaIde.resolve("snapshots/$id/指南.md")))
        assertEquals(
            Files.readAllLines(viaMcp.resolve("config.json")).map { it.replace(folderIds, "\"f-\"") },
            Files.readAllLines(viaIde.resolve("config.json")).map { it.replace(folderIds, "\"f-\"") },
        )
    }

    @Test
    fun `stdio round trip initialize list call`(@TempDir dir: Path) {
        seed(dir)
        val isWindows = System.getProperty("os.name", "").lowercase().contains("windows")
        val java = Path.of(System.getProperty("java.home"), "bin", if (isWindows) "java.exe" else "java")
        val pb = ProcessBuilder(
            java.toString(), "-cp", System.getProperty("java.class.path"),
            "com.zcode.kb.mcp.KbMcpServerMain",
        )
        pb.environment()["ZCODE_KB_ROOT"] = dir.toString()
        pb.redirectErrorStream(false)
        val p = pb.start()
        proc = p

        val errDrain = Thread({ p.errorStream.readBytes() }, "kb-test-err")
        errDrain.isDaemon = true
        errDrain.start()

        val watchdog = Thread({
            try {
                Thread.sleep(60_000)
                p.destroyForcibly()
            } catch (e: InterruptedException) {
            }
        }, "kb-test-watchdog")
        watchdog.isDaemon = true
        watchdog.start()

        val reader = BufferedReader(InputStreamReader(p.inputStream, StandardCharsets.UTF_8))
        fun send(line: String) {
            p.outputStream.write((line + "\n").toByteArray(StandardCharsets.UTF_8))
            p.outputStream.flush()
        }

        send("""{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}""")
        val init = reader.readLine()
        assertTrue(init.contains("zcgui-knowledge"), init)

        send("""{"jsonrpc":"2.0","method":"notifications/initialized"}""")
        send("""{"jsonrpc":"2.0","id":2,"method":"tools/list"}""")
        val tools = reader.readLine()
        // JSON 合法性硬校验：tools/list 应答被 CLI 真 parse，字符串 contains 断言拦不住
        // 手工拼接的语法错（逗号缺失真机实锤：CLI parse 失败 → tools/list 60s 超时连不上）
        assertToolNames(
            tools,
            listOf("kb_search", "kb_read", "kb_list", "kb_tree", "kb_folder", "kb_entry", "kb_tag", "kb_add"),
        )
        assertTrue(tools.contains("kb_search") && tools.contains("kb_read") && tools.contains("kb_list"), tools)

        send("""{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"kb_search","arguments":{"query":"部署"}}}""")
        val search = reader.readLine()
        assertTrue(search.contains("kb-aaaa1111"), search)
        assertTrue(search.contains("部署手册"), search)
        assertTrue(search.contains("信创/中间件"), search) // folder 展示路径入输出

        send("""{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"kb_read","arguments":{"id":"kb-aaaa1111"}}}""")
        val read = reader.readLine()
        assertTrue(read.contains("信创适配部署实践"), read)
        assertTrue(read.contains("folder: 信创/中间件"), read)
        // 正文按原文返回：换行是真换行而不是字面的 \n，模型与工具卡才分得开头信息和正文（只转义一次）
        val readText = Json.parseToJsonElement(read)
            .jsonObject["result"]!!.jsonObject["content"]!!.jsonArray[0]
            .jsonObject["text"]!!.jsonPrimitive.content
        assertTrue(readText.startsWith("### 部署手册\n- folder: 信创/中间件"), readText)
        assertTrue(readText.endsWith("\n\n信创适配部署实践：DM8 数据库与 Nacos 集群部署步骤"), readText)
        assertFalse("\\n" in readText, readText)

        // folder 过滤（子树前缀）+ 标签检索渠道
        send("""{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"kb_search","arguments":{"query":"部署","folder":"信创"}}}""")
        val hitSearch = reader.readLine()
        assertTrue(hitSearch.contains("kb-aaaa1111"), hitSearch)

        send("""{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"kb_search","arguments":{"query":"部署","folder":"插件"}}}""")
        val emptySearch = reader.readLine()
        assertTrue(emptySearch.contains("\"text\":\"[]\""), emptySearch)

        send("""{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"kb_search","arguments":{"query":"nacos"}}}""")
        val tagSearch = reader.readLine()
        assertTrue(tagSearch.contains("kb-aaaa1111"), tagSearch) // 标题不含 nacos，标签+正文命中

        p.outputStream.close()
        assertTrue(p.waitFor(30, TimeUnit.SECONDS), "stdin EOF 后应退出")
        watchdog.interrupt()
    }

    @Test
    fun `java addEntry mirrors ide ingest semantics`(@TempDir dir: Path) {
        seed(dir)
        val src = dir.resolve("ai-sample.md")
        Files.writeString(src, "# AI 收录\n正文段落，含中文。")
        KbServerStore(dir).use { server ->
            // 新收录：folderPath 复用既有目录；默认标题=文件名去扩展；标签清洗去重
            val added = server.addEntry(src.toString(), null, "信创/中间件", listOf("ai", "ai"), null)
            assertEquals(false, added["existed"])
            assertEquals("信创/中间件", added["folder"])
            val id = added["id"] as String
            assertTrue(id.startsWith("kb-"))
            // 判重：同 sourcePath 再收=更新元数据（未传字段保留）
            val again = server.addEntry(src.toString(), "新标题", null, null, null)
            assertEquals(true, again["existed"])
            assertEquals("新标题", again["title"])
            // 内容改过之后再收：正文随内容重提取（重复收录不再是仅元数据更新）
            Files.writeString(src, "# AI 收录\n第二版正文。")
            val third = server.addEntry(src.toString(), null, null, null, null)
            assertEquals(true, third["existed"])
            assertEquals(id, third["id"])
            assertEquals(true, third["textExtracted"])
            // Kotlin 读回：字段落库口径与 IDE ingest 一致 + 检索缓存就位 + 文档快照落盘
            val bytes = Files.readAllBytes(src)
            val id2 = id
            KbFileStore(dir).use { s ->
                val e = s.getEntry(id2)!!
                assertEquals("新标题", e.title)
                assertEquals(listOf("ai"), e.tags)
                assertEquals(".md", e.fileExt)
                assertEquals(src.parent.fileName.toString(), e.project) // 不在 git 仓内：父目录名
                assertEquals(sha256(bytes), e.contentHash) // 上次确认的内容版本
                assertEquals(bytes.size.toLong(), e.sizeBytes)
                assertEquals("# AI 收录\n第二版正文。", s.readText(id2)!!.trim())
                // 文档快照：逐字节副本，路径按条目 id、文件名取源文件名
                val snap = dir.resolve("snapshots").resolve(id2).resolve("ai-sample.md")
                assertTrue(Files.isRegularFile(snap), snap.toString())
                assertTrue(Files.readAllBytes(snap).contentEquals(bytes))
                // 条目文件随 git 同步：没有只对本机有意义的字段
                val json = Files.readString(dir.resolve("entries").resolve("$id2.json"))
                for (retired in listOf("\"status\"", "gitRepo", "gitCommit", "gitRel", "indexedMtime", "indexedSize")) {
                    assertTrue(!json.contains(retired), "$retired 仍在条目文件里：$json")
                }
            }
        }
    }

    private fun sha256(bytes: ByteArray): String =
        java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    @Test
    fun `java store relink re-points entry and re-extracts text`(@TempDir dir: Path) {
        val a = dir.resolve("relink-a.md")
        val b = dir.resolve("relink-b.md")
        val c = dir.resolve("relink-c.md")
        Files.writeString(a, "旧路径正文")
        Files.writeString(b, "重指向后的新正文")
        Files.writeString(c, "另一条目已占用的正文")
        KbFileStore(dir).use { s ->
            s.insert(KbEntry(id = "kb-aaaa1111", sourcePath = a.toString(), title = "甲"), "旧路径正文")
            s.insert(KbEntry(id = "kb-bbbb2222", sourcePath = c.toString(), title = "乙"), "另一条目已占用的正文")
        }
        KbServerStore(dir).use { server ->
            // 重指向：sourcePath 换新 + 文本重抽取，id/标题不动
            assertEquals(1, server.updateEntries(listOf("kb-aaaa1111"), null, null, null, b.toString()))
            val row = server.entry("kb-aaaa1111")!!
            assertEquals(b.toString().replace('\\', '/'), row.sourcePath)
            assertEquals("重指向后的新正文", server.readText("kb-aaaa1111")!!.trim())
            assertEquals("甲", row.title)
            assertEquals("ok", row.status)
            assertEquals(b.toString().replace('\\', '/'), row.contentPath)
            // 文档快照随之改名、内容哈希刷新（以新源文件为准）
            assertTrue(Files.isRegularFile(dir.resolve("snapshots/kb-aaaa1111/relink-b.md")))
            assertFalse(Files.exists(dir.resolve("snapshots/kb-aaaa1111/relink-a.md")))
            assertTrue(Files.readAllBytes(dir.resolve("snapshots/kb-aaaa1111/relink-b.md")).contentEquals(Files.readAllBytes(b)))
            // 传当前路径 = 幂等刷新缓存文本（自占路径不触发判重）
            assertEquals(1, server.updateEntries(listOf("kb-aaaa1111"), null, null, null, b.toString()))
            // 缺文件拒绝
            org.junit.jupiter.api.assertThrows<KbServerStore.KbOpException> {
                server.updateEntries(listOf("kb-aaaa1111"), null, null, null, dir.resolve("nope.md").toString())
            }
            // 撞其他条目已收录路径拒绝
            org.junit.jupiter.api.assertThrows<KbServerStore.KbOpException> {
                server.updateEntries(listOf("kb-aaaa1111"), null, null, null, c.toString())
            }
            // 批量 id + sourcePath 拒绝（仅单条目）
            org.junit.jupiter.api.assertThrows<KbServerStore.KbOpException> {
                server.updateEntries(listOf("kb-aaaa1111", "kb-bbbb2222"), null, null, null, b.toString())
            }
        }
        // Kotlin 侧读回：Java relink 写 → Kotlin 读，跨进程闭环 + id 稳定 + 内容哈希以新源文件为准
        KbFileStore(dir).use { s ->
            val e = s.getEntry("kb-aaaa1111")!!
            assertEquals(b.toString().replace('\\', '/'), e.sourcePath)
            assertEquals("重指向后的新正文", s.readText("kb-aaaa1111")!!.trim())
            assertEquals("甲", e.title)
            assertEquals(sha256(Files.readAllBytes(b)), e.contentHash)
            assertEquals(Files.size(b), e.sizeBytes)
        }
    }

    @Test
    fun `stdio round trip management tools`(@TempDir dir: Path) {
        seed(dir)
        val isWindows = System.getProperty("os.name", "").lowercase().contains("windows")
        val java = Path.of(System.getProperty("java.home"), "bin", if (isWindows) "java.exe" else "java")
        val pb = ProcessBuilder(
            java.toString(), "-cp", System.getProperty("java.class.path"),
            "com.zcode.kb.mcp.KbMcpServerMain",
        )
        pb.environment()["ZCODE_KB_ROOT"] = dir.toString()
        pb.redirectErrorStream(false)
        val p = pb.start()
        proc = p

        val errDrain = Thread({ p.errorStream.readBytes() }, "kb-test-err2")
        errDrain.isDaemon = true
        errDrain.start()

        val watchdog = Thread({
            try {
                Thread.sleep(60_000)
                p.destroyForcibly()
            } catch (e: InterruptedException) {
            }
        }, "kb-test-watchdog2")
        watchdog.isDaemon = true
        watchdog.start()

        val reader = BufferedReader(InputStreamReader(p.inputStream, StandardCharsets.UTF_8))
        fun send(line: String) {
            p.outputStream.write((line + "\n").toByteArray(StandardCharsets.UTF_8))
            p.outputStream.flush()
        }

        send("""{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}""")
        reader.readLine()

        send("""{"jsonrpc":"2.0","method":"notifications/initialized"}""")
        send("""{"jsonrpc":"2.0","id":2,"method":"tools/list"}""")
        val tools = reader.readLine()
        assertToolNames(
            tools,
            listOf("kb_search", "kb_read", "kb_list", "kb_tree", "kb_folder", "kb_entry", "kb_tag", "kb_add"),
        )

        // kb_tree：目录 path/计数 + 根级计数
        send("""{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"kb_tree","arguments":{}}}""")
        val tree = reader.readLine()
        assertTrue(tree.contains("信创/中间件"), tree)
        // text 字段是 JSON 转义串：断言含引号的片段须用 \" 转义形态
        assertTrue(tree.contains("\\\"rootCount\\\":1"), tree)
        assertTrue(tree.contains("\\\"total\\\":2"), tree)

        // kb_folder create → kb_entry move → kb_list 子树验证
        send("""{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"kb_folder","arguments":{"action":"create","path":"Ops"}}}""")
        assertTrue(reader.readLine().contains("\\\"id\\\":\\\"f-"))
        send("""{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"kb_entry","arguments":{"action":"move","ids":["kb-bbbb2222"],"folderPath":"Ops"}}}""")
        assertTrue(reader.readLine().contains("\\\"moved\\\":1"))
        send("""{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"kb_list","arguments":{"folder":"Ops"}}}""")
        assertTrue(reader.readLine().contains("kb-bbbb2222"))

        // kb_entry update：tags 替换 + notes
        send("""{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"kb_entry","arguments":{"action":"update","ids":["kb-bbbb2222"],"tags":["nginx","部署"],"notes":"整理备注"}}}""")
        assertTrue(reader.readLine().contains("\\\"updated\\\":1"))

        // kb_tag create（自动配色 8 色板）
        send("""{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"kb_tag","arguments":{"action":"create","name":"自动标签"}}}""")
        assertTrue(reader.readLine().contains("\\\"color\\\":\\\"#"))

        // 防环拒绝：业务 error（非 internal）
        send("""{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"kb_folder","arguments":{"action":"move","path":"信创","newPath":"信创/中间件"}}}""")
        val cycle = reader.readLine()
        assertTrue(cycle.contains("its own subtree"), cycle)
        assertTrue(!cycle.contains("internal"), cycle)

        // 不存在路径：业务 error
        send("""{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"kb_folder","arguments":{"action":"delete","path":"不存在"}}}""")
        assertTrue(reader.readLine().contains("folder not found"))

        // 给不存在的标签改色：业务 error（不会顺手建出一个空标签）
        send("""{"jsonrpc":"2.0","id":19,"method":"tools/call","params":{"name":"kb_tag","arguments":{"action":"color","name":"没有的标签","color":"#123456"}}}""")
        val unknownTag = reader.readLine()
        assertTrue(unknownTag.contains("tag not found"), unknownTag)
        assertTrue(!unknownTag.contains("color set"), unknownTag)

        // 删条目：元数据+缓存删除，kb_read 随即 not found（磁盘源文件永不触碰——指针模型）
        send("""{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"kb_entry","arguments":{"action":"delete","ids":["kb-bbbb2222"]}}}""")
        assertTrue(reader.readLine().contains("\\\"removed\\\":1"))
        send("""{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"kb_read","arguments":{"id":"kb-bbbb2222"}}}""")
        assertTrue(reader.readLine().contains("entry not found"))

        // kb_add：收录临时文件（Windows 路径反斜杠 JSON 转义）→ kb_list 验证挂载
        val sample = dir.resolve("stdio-add.md")
        Files.writeString(sample, "stdio 收录正文")
        val escPath = sample.toString().replace("\\", "\\\\")
        send("""{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"kb_add","arguments":{"path":"$escPath","folderPath":"Ops","tags":["stdio"]}}}""")
        val added = reader.readLine()
        assertTrue(added.contains("stdio-add"), added)
        assertTrue(added.contains("Ops"), added)
        send("""{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"kb_list","arguments":{"folder":"Ops"}}}""")
        assertTrue(reader.readLine().contains("stdio-add"))

        // kb_entry update sourcePath：重指向 + 重抽取（id 不变，新正文可读）
        val addedId = """\\\"id\\\":\\\"(kb-[0-9a-f]+)\\\"""".toRegex().find(added)!!.groupValues[1]
        val relinkTarget = dir.resolve("stdio-relink-target.md")
        Files.writeString(relinkTarget, "重指向后的 stdio 正文")
        val escTarget = relinkTarget.toString().replace("\\", "\\\\")
        send("""{"jsonrpc":"2.0","id":15,"method":"tools/call","params":{"name":"kb_entry","arguments":{"action":"update","ids":["$addedId"],"sourcePath":"$escTarget"}}}""")
        assertTrue(reader.readLine().contains("\\\"updated\\\":1"))
        send("""{"jsonrpc":"2.0","id":16,"method":"tools/call","params":{"name":"kb_read","arguments":{"id":"$addedId"}}}""")
        // kb_read 响应头不回显 id：以「新源路径 + 新正文」验证重指向生效（id 稳定性 store 级已断言）
        val readBack = reader.readLine()
        assertTrue(readBack.contains("stdio-relink-target.md"), readBack)
        assertTrue(readBack.contains("重指向后的 stdio 正文"), readBack)
        assertTrue(readBack.contains("status: ok"), readBack)

        // 仅文档快照：源文件在本机不存在 → 状态现算为 snapshot，kb_read 仍返回正文并注明来自文档快照
        Files.delete(relinkTarget)
        send("""{"jsonrpc":"2.0","id":17,"method":"tools/call","params":{"name":"kb_list","arguments":{}}}""")
        val listed = reader.readLine()
        assertTrue(listed.contains("\\\"status\\\":\\\"snapshot\\\""), listed)
        assertTrue(listed.contains("\\\"contentPath\\\":\\\""), listed)
        send("""{"jsonrpc":"2.0","id":18,"method":"tools/call","params":{"name":"kb_read","arguments":{"id":"$addedId"}}}""")
        val fromSnapshot = reader.readLine()
        assertTrue(fromSnapshot.contains("重指向后的 stdio 正文"), fromSnapshot)
        assertTrue(fromSnapshot.contains("knowledge base snapshot"), fromSnapshot)
        assertTrue(fromSnapshot.contains("not present on this machine"), fromSnapshot)

        p.outputStream.close()
        assertTrue(p.waitFor(30, TimeUnit.SECONDS), "stdin EOF 后应退出")
        watchdog.interrupt()
    }
}
