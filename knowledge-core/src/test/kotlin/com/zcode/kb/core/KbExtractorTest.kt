package com.zcode.kb.core

import org.apache.pdfbox.pdmodel.PDDocument
import org.apache.pdfbox.pdmodel.PDPage
import org.apache.pdfbox.pdmodel.common.PDRectangle
import org.apache.pdfbox.pdmodel.font.PDType1Font
import org.apache.pdfbox.pdmodel.font.Standard14Fonts
import org.apache.pdfbox.pdmodel.PDPageContentStream
import java.nio.file.Files
import java.nio.file.Path
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.junit.jupiter.api.io.TempDir
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class KbExtractorTest {

    @Test
    fun `supported extension matrix`(@TempDir dir: Path) {
        assertTrue(KbExtractor.isSupported("a.md"))
        assertTrue(KbExtractor.isSupported("A.PDF"))
        assertTrue(KbExtractor.isSupported("page.mht"))
        assertTrue(KbExtractor.isSupported("b.doc"))
        assertTrue(KbExtractor.isSupported("b.docx"))
        assertTrue(KbExtractor.isSupported("table.xls"))
        assertTrue(KbExtractor.isSupported("table.xlsx"))
        // 名字层面=黑名单以外全放行（noext/py/Makefile 待收录时嗅探确认），完整判据走 isSupportedFile
        assertTrue(KbExtractor.isSupported("noext"))
        assertTrue(KbExtractor.isSupported("script.py"))
        assertFalse(KbExtractor.isSupported("a.exe"))
        assertFalse(KbExtractor.isSupported("photo.png"))
        // 正文提取路径：xls 有（BIFF 轻解析），doc 无（仅元数据参与检索）
        assertTrue(KbExtractor.hasTextPath("table.xls"))
        assertTrue(KbExtractor.hasTextPath("table.xlsx"))
        assertTrue(KbExtractor.hasTextPath("b.docx"))
        assertFalse(KbExtractor.hasTextPath("b.doc"))
        assertTrue(KbExtractor.hasTextPath("script.py"))
        // 黑名单与白名单无交集（黑名单快拒优先于白名单直收的前提）
        assertTrue(KbExtractor.SUPPORTED_EXTS.none { KbExtractor.isDeniedBinary("x.$it") })
    }

    @Test
    fun `isSupportedFile by sniff and blacklist`(@TempDir dir: Path) {
        val py = dir.resolve("script.py")
        Files.writeString(py, "def main():\n    print('hi 中文')")
        assertTrue(KbExtractor.isSupportedFile(py))
        val makefile = dir.resolve("Makefile")
        Files.writeString(makefile, "all:\n\techo hi")
        assertTrue(KbExtractor.isSupportedFile(makefile))
        val dotgit = dir.resolve(".gitignore")
        Files.writeString(dotgit, "build/\n*.tmp")
        assertTrue(KbExtractor.isSupportedFile(dotgit))
        // 黑名单快拒：内容即使是文本也拒（性能层；清单漏项才有嗅探兜底）
        val png = dir.resolve("a.png")
        Files.write(png, "text in disguise".toByteArray())
        assertFalse(KbExtractor.isSupportedFile(png))
        val binary = dir.resolve("blob.dat")
        Files.write(binary, byteArrayOf(0x4D, 0x5A, 0x90.toByte(), 0x00, 0x03))
        assertFalse(KbExtractor.isSupportedFile(binary)) // 嗅探兜底：MZ 头含 \0
        assertFalse(KbExtractor.isSupportedFile(dir.resolve("ghost.py")))
    }

    @Test
    fun `sniff bom exempts and nul rejects`() {
        assertTrue(KbExtractor.sniffIsText(byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte()) + "中文".toByteArray()))
        assertTrue(KbExtractor.sniffIsText(byteArrayOf(0xFF.toByte(), 0xFE.toByte()) + "中文".toByteArray(Charsets.UTF_16LE)))
        assertTrue(KbExtractor.sniffIsText(byteArrayOf(0xFE.toByte(), 0xFF.toByte()) + "中文".toByteArray(Charsets.UTF_16BE)))
        assertTrue(KbExtractor.sniffIsText("plain ascii".toByteArray()))
        assertTrue(KbExtractor.sniffIsText("中文".toByteArray(charset("GBK")))) // GBK 双字节无 \0
        assertFalse(KbExtractor.sniffIsText(byteArrayOf(0x4D, 0x5A, 0x90.toByte(), 0x00))) // exe MZ 头
        assertFalse(KbExtractor.sniffIsText(ByteArray(16))) // 全 \0
    }

    @Test
    fun `extract decodes gbk log and utf16 txt`(@TempDir dir: Path) {
        val gbk = dir.resolve("run.log")
        Files.write(gbk, "错误：连接超时".toByteArray(charset("GBK")))
        assertEquals("错误：连接超时", KbExtractor.extract(gbk))
        val u16 = dir.resolve("notes.txt")
        Files.write(u16, byteArrayOf(0xFF.toByte(), 0xFE.toByte()) + "中文备注".toByteArray(Charsets.UTF_16LE))
        assertEquals("中文备注", KbExtractor.extract(u16))
        val py = dir.resolve("code.py")
        Files.writeString(py, "# 中文注释\nprint('ok')")
        assertEquals("# 中文注释\nprint('ok')", KbExtractor.extract(py))
    }

    @Test
    fun `md and txt direct read`(@TempDir dir: Path) {
        val f = dir.resolve("a.md")
        Files.writeString(f, "# 标题\n中文正文")
        assertEquals("# 标题\n中文正文", KbExtractor.extract(f))
    }

    @Test
    fun `html strips tags`(@TempDir dir: Path) {
        val f = dir.resolve("a.html")
        Files.writeString(f, "<html><head><title>t</title></head><body><p>你好 <b>世界</b></p></body></html>")
        val text = KbExtractor.extract(f)!!
        assertTrue(text.contains("你好"))
        assertTrue(text.contains("世界"))
        assertFalse(text.contains("<p>"))
    }

    @Test
    fun `docx extracts wt text with paragraph breaks`(@TempDir dir: Path) {
        val f = dir.resolve("a.docx")
        ZipOutputStream(Files.newOutputStream(f)).use { zos ->
            zos.putNextEntry(ZipEntry("[Content_Types].xml"))
            zos.write("<Types/>".toByteArray())
            zos.closeEntry()
            zos.putNextEntry(ZipEntry("word/document.xml"))
            zos.write(
                """<?xml version="1.0" encoding="UTF-8"?>
                <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
                  <w:body>
                    <w:p><w:r><w:t>你好</w:t></w:r><w:r><w:t>世界</w:t></w:r></w:p>
                    <w:p><w:r><w:t>second line</w:t></w:r></w:p>
                  </w:body>
                </w:document>""".trimIndent().toByteArray()
            )
            zos.closeEntry()
        }
        val text = KbExtractor.extract(f)!!
        assertTrue(text.contains("你好世界"))
        assertTrue(text.contains("second line"))
        assertTrue(text.indexOf("你好世界") < text.indexOf("second"))
    }

    @Test
    fun `pdf extracts text layer`(@TempDir dir: Path) {
        val f = dir.resolve("a.pdf")
        PDDocument().use { doc ->
            val page = PDPage(PDRectangle.A4)
            doc.addPage(page)
            PDPageContentStream(doc, page).use { cs ->
                cs.beginText()
                cs.setFont(PDType1Font(Standard14Fonts.FontName.HELVETICA), 12f)
                cs.newLineAtOffset(50f, 700f)
                cs.showText("knowledge extraction probe")
                cs.endText()
            }
            doc.save(f.toFile())
        }
        val text = KbExtractor.extract(f)!!
        assertTrue(text.contains("knowledge"))
        assertTrue(text.contains("probe"))
    }

    @Test
    fun `mhtml decodes quoted printable cjk`(@TempDir dir: Path) {
        val f = dir.resolve("a.mht")
        // 你好 = E4 BD A0 E5 A5 BD；中文 = E4 B8 AD E6 96 87（UTF-8 QP）
        val mhtml = """
From: <x@example.com>
MIME-Version: 1.0
Content-Type: multipart/related; boundary="----=_Part_0"

------=_Part_0
Content-Type: text/html; charset=utf-8
Content-Transfer-Encoding: quoted-printable

<html><body><h1>T</h1><p>=E4=BD=A0=E5=A5=BD =E4=B8=AD=E6=96=87</p></body></html>
------=_Part_0--
""".trimIndent()
        Files.writeString(f, mhtml, Charsets.ISO_8859_1)
        val text = KbExtractor.extract(f)!!
        assertTrue(text.contains("你好"))
        assertTrue(text.contains("中文"))
        assertTrue(text.contains("T"))
    }

    @Test
    fun `xlsx extracts shared strings with row breaks`(@TempDir dir: Path) {
        val f = dir.resolve("a.xlsx")
        ZipOutputStream(Files.newOutputStream(f)).use { zos ->
            zos.putNextEntry(ZipEntry("[Content_Types].xml"))
            zos.write("<Types/>".toByteArray())
            zos.closeEntry()
            zos.putNextEntry(ZipEntry("xl/sharedStrings.xml"))
            zos.write(
                """<?xml version="1.0" encoding="UTF-8"?>
                <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
                  <si><t>主机地址</t></si>
                  <si><r><t>数据</t></r><r><t>库</t></r></si>
                  <si><t>第三行</t></si>
                </sst>""".trimIndent().toByteArray()
            )
            zos.closeEntry()
        }
        val text = KbExtractor.extract(f)!!
        assertTrue(text.contains("主机地址"))
        assertTrue(text.contains("数据库")) // 富文本多 run 拼接
        assertTrue(text.contains("第三行"))
        assertTrue(text.indexOf("主机地址") < text.indexOf("第三行"))
    }

    @Test
    fun `missing file returns null`(@TempDir dir: Path) {
        // 旧契约「extract 拒绝白名单外扩展」已转移：不支持性由 isSupportedFile/黑名单表达，
        // extract 对未知扩展一律直读（收录判据前置已过滤）
        assertEquals(null, KbExtractor.extract(dir.resolve("ghost.md")))
    }
}
