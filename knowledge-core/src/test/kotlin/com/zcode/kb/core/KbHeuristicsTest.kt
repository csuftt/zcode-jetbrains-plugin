package com.zcode.kb.core

import java.nio.file.Path
import org.junit.jupiter.api.io.TempDir
import kotlin.test.Test
import kotlin.test.assertEquals

class KbHeuristicsTest {

    @Test
    fun `md title from first heading skipping frontmatter`() {
        val text = "---\ntitle: x\n---\n\n# 真标题\n正文"
        val s = KbHeuristics.suggest(Path.of("d:/proj/docs/g.md"), text, emptyList(), emptyList())
        assertEquals("真标题", s.title)
    }

    @Test
    fun `html title from title tag`() {
        val s = KbHeuristics.suggest(Path.of("d:/x/page.html"), "<html><title>部署手册</title></html>", emptyList(), emptyList())
        assertEquals("部署手册", s.title)
    }

    @Test
    fun `docx falls back to first nonblank line`() {
        val s = KbHeuristics.suggest(Path.of("d:/x/report.docx"), "\n \n第一行内容\n第二行", emptyList(), emptyList())
        assertEquals("第一行内容", s.title)
    }

    @Test
    fun `fallback title is filename without ext`() {
        val s = KbHeuristics.suggest(Path.of("d:/x/我的方案.pdf"), null, emptyList(), emptyList())
        assertEquals("我的方案", s.title)
    }

    @Test
    fun `new text types fall back to filename without content inference`() {
        // 白名单外（嗅探接纳件）不做内容推断：首行 package/shebang 不是标题，文件名=天然标题
        assertEquals("Main", KbHeuristics.suggestTitle("Main.java", "package com.x;\n\npublic class Main {}"))
        assertEquals("run", KbHeuristics.suggestTitle("run.sh", "#!/bin/bash\necho hi"))
        assertEquals("Makefile", KbHeuristics.suggestTitle("Makefile", "all:\n\techo hi"))
        assertEquals(".gitignore", KbHeuristics.suggestTitle(".gitignore", "build/"))
    }

    @Test
    fun `txt and log fall back to filename despite whitelist`() {
        // 白名单内的纯文本无内容标题语义：首行是时间戳/正文不是标题（真机：idea.log 标题变日志首行）
        assertEquals("idea", KbHeuristics.suggestTitle("idea.log", "2026-11-12 10:32:33,202 [1143459] INFO - start\nsecond"))
        assertEquals("notes", KbHeuristics.suggestTitle("notes.txt", "第一行正文\n第二行"))
    }

    @Test
    fun `whitelist keeps content-based title`() {
        // 回归：白名单内的 md/html/docx/pdf 内容推断路径不动
        assertEquals("文档标题", KbHeuristics.suggestTitle("a.md", "# 文档标题\n正文"))
        assertEquals("部署手册", KbHeuristics.suggestTitle("a.html", "<html><title>部署手册</title></html>"))
        assertEquals("第一行内容", KbHeuristics.suggestTitle("a.docx", "\n \n第一行内容\n第二行"))
    }

    @Test
    fun `folder name matches path segment equality first`() {
        val s = KbHeuristics.suggest(
            Path.of("E:/1-软件项目/23-新平台部署/信创适配/nacos.md"), null,
            existingFolderNames = listOf("插件开发", "信创适配"), existingTags = emptyList(),
        )
        assertEquals("信创适配", s.folderName)
    }

    @Test
    fun `folder name containment fallback`() {
        val s = KbHeuristics.suggest(
            Path.of("E:/work/23-新平台部署/a.md"), null,
            existingFolderNames = listOf("新平台部署"), existingTags = emptyList(),
        )
        assertEquals("新平台部署", s.folderName)
    }

    @Test
    fun `no folder name match returns empty`() {
        val s = KbHeuristics.suggest(Path.of("d:/random/x.md"), null, listOf("信创"), emptyList())
        assertEquals("", s.folderName)
    }

    @Test
    fun `tags suggested from path and text head`() {
        val s = KbHeuristics.suggest(
            Path.of("E:/w/xxl-job-dm8.md"), "本文讨论 nacos 与 dm8 的适配，后文无关词表很长很长",
            existingFolderNames = emptyList(),
            existingTags = listOf("nacos", "dm8", "xxl-job", "mysql", "redis", "k8s"),
        )
        // dm8 命中路径，nacos/dm8/xxl-job 命中路径或头部；mysql/redis/k8s 不出现
        assertEquals(true, s.tags.containsAll(listOf("dm8", "nacos", "xxl-job")))
        assertEquals(false, s.tags.contains("mysql"))
    }
}
