package com.zcode.kb.mcp

import com.zcode.kb.core.KbEntry
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
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
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

    /** 种子数据：目录树 信创/中间件 两级 + 两条目挂载（folderId 是创建返回的 id） */
    private fun seed(dir: Path): Pair<String, String> {
        var f1 = ""
        var f2 = ""
        KbFileStore(dir).use { s ->
            f1 = s.createFolder(null, "信创")
            f2 = s.createFolder(f1, "中间件")
            s.insert(
                KbEntry(
                    id = "kb-aaaa1111", sourcePath = "d:/docs/x.md", title = "部署手册",
                    folderId = f2, tags = listOf("nacos", "dm8"), project = "proj-a",
                ),
                "信创适配部署实践：DM8 数据库与 Nacos 集群部署步骤",
            )
            s.insert(
                KbEntry(id = "kb-bbbb2222", sourcePath = "d:/docs/y.md", title = "前端规范", folderId = ""),
                "React 组件分层约定",
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
    fun `java store honors snapshotDir in config for text cache`(@TempDir dir: Path) {
        seed(dir)
        val snapRoot = dir.resolve("snap-loc")
        // IDE 侧改快照根（搬 text/ + 写 config）——同款语义直接落盘
        KbFileStore(dir).use { s ->
            // 先建目标父目录再搬（setSnapshotDir 会预建新根 text 空目录，顺序反了 move 目标已存在）
            java.nio.file.Files.createDirectories(snapRoot)
            java.nio.file.Files.move(dir.resolve("text"), snapRoot.resolve("text"))
            s.setSnapshotDir(snapRoot.toString())
        }
        // MCP server（root=元数据根）每请求解析 config.snapshotDir → text 命中新位置
        KbServerStore(dir).use { server ->
            assertTrue(server.available()) // entries 仍在元数据根
            assertEquals("信创适配部署实践：DM8 数据库与 Nacos 集群部署步骤", server.readText("kb-aaaa1111"))
            assertEquals("React 组件分层约定", server.readText("kb-bbbb2222"))
            // 检索正文取自新根缓存（snippet 有内容即取到）
            val hits = server.search("部署", null, null, null, 10)
            assertEquals(1, hits.size)
            assertTrue(hits[0].snippet.contains("部署"))
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
            // Kotlin 读回：字段落库口径与 IDE ingest 一致 + 提取缓存就位
            KbFileStore(dir).use { s ->
                val e = s.getEntry(id)!!
                assertEquals("新标题", e.title)
                assertEquals(listOf("ai"), e.tags)
                assertEquals(".md", e.fileExt)
                assertEquals(src.parent.fileName.toString(), e.project)
                assertEquals("ok", e.status)
                assertEquals("# AI 收录\n正文段落，含中文。", s.readText(id)!!.trim())
            }
        }
    }

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
        // Kotlin 侧读回：Java relink 写 → Kotlin 读，跨进程闭环 + id 稳定
        KbFileStore(dir).use { s ->
            val e = s.getEntry("kb-aaaa1111")!!
            assertEquals(b.toString().replace('\\', '/'), e.sourcePath)
            assertEquals("重指向后的新正文", s.readText("kb-aaaa1111")!!.trim())
            assertEquals("甲", e.title)
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

        p.outputStream.close()
        assertTrue(p.waitFor(30, TimeUnit.SECONDS), "stdin EOF 后应退出")
        watchdog.interrupt()
    }
}
