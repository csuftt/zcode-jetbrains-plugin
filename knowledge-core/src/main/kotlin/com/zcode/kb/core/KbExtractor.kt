package com.zcode.kb.core

import org.apache.pdfbox.Loader
import org.apache.pdfbox.text.PDFTextStripper
import org.jsoup.Jsoup
import java.io.ByteArrayInputStream
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction
import java.nio.file.Files
import java.nio.file.Path
import java.util.zip.ZipInputStream
import javax.xml.stream.XMLInputFactory
import javax.xml.stream.XMLStreamConstants

/**
 * 文档文本提取（知识库检索与文本视图的语料来源）。
 *
 * - 白名单扩展（md/txt/html/docx/xlsx/xls/pdf 等）：专属提取路径；
 *   md/markdown/txt/log 直读；html/htm jsoup 去标签（解码走 [decodeText]，GBK html 不再乱码）；
 * - mhtml/mht：极简 MIME 解析取第一个 text/html 分节（quoted-printable/base64 解码）
 *   后去标签——检索与文本视图可达，外链样式不参与；
 * - docx：JDK ZipInputStream + StAX 抽 word/document.xml 的 w:t 文本（w:p 段落断行）——
 *   v1 只需正文文本（提取文本视图+检索），不引 POI 全家桶（issue#54 已确认偏离）；
 * - xlsx：同款手法抽 xl/sharedStrings.xml 的 si/t 文本（si 断行）——全簿字符串池覆盖
 *   绝大多数单元格内容；
 * - xls：[KbBiffText] 手写 CFB+BIFF8 SST 轻提取（Excel 97-2003，全簿字符串池覆盖绝大多
 *   数单元格内容；加密/BIFF5 老格式 fail-soft 返回 null）；
 * - doc：Word 二进制（piece table/CLX）无轻提取路径，不提取（仅元数据参与检索，UI 有
 *   「仅标题检索」提示引导转存 docx）；
 * - pdf：PDFBox 3.x 文本层。
 * - 白名单外任意文本（py/sh/java/Makefile/.env 等嗅探接纳件）：直读 [decodeText]。
 *
 * 收录判据三层：黑名单快拒（[BINARY_EXTS]）→ 白名单直收 → 其余头 8KB 内容嗅探
 * （[sniffIsText]，BOM 豁免 + \0 判据，git 同款）。
 *
 * 超大文件保护：>50MB 返回 null（调用方按提取失败落提示）。
 */
object KbExtractor {

    /** 一期白名单：有专属提取路径的扩展名（小写无点） */
    val SUPPORTED_EXTS = setOf(
        "md", "markdown", "txt", "log",
        "html", "htm", "mhtml", "mht",
        "docx", "doc", "xls", "xlsx", "pdf",
    )

    /**
     * 已知二进制扩展黑名单（快拒，免读头）：可执行/归档/图片/音视频/字体/数据库/Office
     * 二进制。漏项无风险——[isSupportedFile] 的内容嗅探会兜底正确判二进制，黑名单只影响
     * 快拒性能；svg 是 XML 文本、dat 争议大，不进、靠嗅探判。与白名单无交集（测试守护）。
     */
    private val BINARY_EXTS = setOf(
        // 可执行/库/字节码
        "exe", "dll", "so", "dylib", "bin", "com", "obj", "o", "a", "lib",
        "msi", "class", "jar", "war", "ear", "apk", "dex", "wasm",
        // 归档
        "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst", "iso", "dmg", "cab",
        // 图片
        "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "tif", "tiff", "psd", "ai", "sketch", "xcf",
        // 音视频
        "mp3", "wav", "flac", "ogg", "m4a", "mp4", "avi", "mkv", "mov", "wmv", "flv", "webm",
        // 字体
        "ttf", "otf", "woff", "woff2", "eot",
        // 数据库/Office 二进制/模型
        "sqlite", "db", "mdb", "accdb", "ppt", "pptx", "key", "onnx", "pth", "parquet",
    )

    private const val MAX_BYTES = 50L * 1024 * 1024
    private const val SNIFF_BYTES = 8 * 1024

    fun ext(fileName: String): String = fileName.substringAfterLast('.', "").lowercase()

    /** 黑名单快拒：扩展名一眼判二进制，免读头（文件选择器过滤/菜单显隐用） */
    fun isDeniedBinary(fileName: String): Boolean = ext(fileName) in BINARY_EXTS

    /**
     * 名字层面判据：黑名单以外的一切（白名单已知支持，其余待嗅探确认）。
     * 供「不能读文件内容」的场合快筛（右键菜单 update 显隐、文件选择器过滤器）；
     * 收录动作一律走 [isSupportedFile]。注意与旧语义（=白名单）不同：noext/Makefile 也放行。
     */
    fun isSupported(fileName: String): Boolean = !isDeniedBinary(fileName)

    /**
     * 完整收录判据：黑名单快拒 → 白名单直收 → 其余读头 8KB 嗅探。嗅探通过即视为文本
     * （py/sh/java/Makefile/.env 等任意文本，含无扩展名文件）。
     */
    fun isSupportedFile(path: Path): Boolean {
        val name = path.fileName.toString()
        val e = ext(name)
        if (e in BINARY_EXTS) return false
        if (e in SUPPORTED_EXTS) return true
        if (!Files.isRegularFile(path)) return false
        return runCatching {
            val head = Files.newInputStream(path).use { it.readNBytes(SNIFF_BYTES) }
            sniffIsText(head)
        }.getOrDefault(false)
    }

    /**
     * 头部二进制嗅探（git 同款）：BOM 豁免优先——合法编码文本（UTF-8 多字节序列、GBK 双字节）
     * 编码字节均不含 \0，唯一例外是无 BOM UTF-16，主流工具必带 BOM，宁可误杀不误收
     * （乱码正文会污染检索）；无 BOM 含 \0 即判二进制。
     */
    fun sniffIsText(head: ByteArray): Boolean {
        if (hasBom(head)) return true
        return head.none { it == 0.toByte() }
    }

    private fun hasBom(b: ByteArray): Boolean = when {
        b.size >= 3 && b[0] == 0xEF.toByte() && b[1] == 0xBB.toByte() && b[2] == 0xBF.toByte() -> true
        b.size >= 2 && ((b[0] == 0xFF.toByte() && b[1] == 0xFE.toByte()) ||
            (b[0] == 0xFE.toByte() && b[1] == 0xFF.toByte())) -> true
        else -> false
    }

    /** 收录后是否有正文提取路径（UI 用来标注「仅标题检索」）：doc 是唯一差集——Word 二进制无轻提取路径；xls 解析失败（加密/BIFF5）是运行态，不在此列 */
    fun hasTextPath(fileName: String): Boolean = isSupported(fileName) && ext(fileName) != "doc"

    /**
     * 文本解码链（零新依赖）：BOM 定格 → UTF-8 严格试解 → GBK 宽松兜底。GBK 对 ASCII
     * 兼容且 String() 构造对非法序列按替换不抛错，兜底层实际不会失败，故无第四层；
     * 中文 Windows 的 log/bat/老源码多为 GBK，UTF-8 严格试解失败即落 GBK。
     */
    private fun decodeText(bytes: ByteArray): String {
        if (bytes.size >= 3 && bytes[0] == 0xEF.toByte() && bytes[1] == 0xBB.toByte() && bytes[2] == 0xBF.toByte()) {
            return String(bytes, 3, bytes.size - 3, Charsets.UTF_8)
        }
        if (bytes.size >= 2 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xFE.toByte()) {
            return String(bytes, 2, bytes.size - 2, Charsets.UTF_16LE)
        }
        if (bytes.size >= 2 && bytes[0] == 0xFE.toByte() && bytes[1] == 0xFF.toByte()) {
            return String(bytes, 2, bytes.size - 2, Charsets.UTF_16BE)
        }
        if (isStrictUtf8(bytes)) return String(bytes, Charsets.UTF_8)
        return String(bytes, charset("GBK"))
    }

    private fun isStrictUtf8(bytes: ByteArray): Boolean = try {
        Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes))
        true
    } catch (e: CharacterCodingException) {
        false
    }

    /** 提取纯文本；不支持/失败/超大返回 null（区分「不支持」与「失败」可先问 [isSupportedFile]） */
    fun extract(file: Path): String? = try {
        if (!Files.isRegularFile(file) || Files.size(file) > MAX_BYTES) {
            null
        } else {
            val bytes = Files.readAllBytes(file)
            when (ext(file.fileName.toString())) {
                "html", "htm" -> jsoupText(decodeText(bytes))
                "mhtml", "mht" -> mhtmlText(bytes)
                "docx" -> docxText(bytes)
                "xlsx" -> xlsxText(bytes)
                "xls" -> KbBiffText.extract(bytes)
                // "doc"：Word 二进制（piece table/CLX）无轻提取路径（仅元数据参与检索）
                "pdf" -> pdfText(bytes)
                // 白名单外嗅探接纳的任意文本（py/sh/java/Makefile…）与 md/txt/log 直读件
                else -> decodeText(bytes)
            }
        }
    } catch (e: Exception) {
        null
    }

    private fun jsoupText(html: String): String = Jsoup.parse(html).text()

    // ── mhtml：极简 MIME 解析，取第一个 text/html 分节 ──

    private fun mhtmlText(bytes: ByteArray): String? {
        val raw = String(bytes, Charsets.ISO_8859_1) // 结构行按 latin1 扫描，正文按声明 charset 解码
        val lower = raw.lowercase()
        val htmlHeaderAt = lower.indexOf("content-type: text/html")
        if (htmlHeaderAt < 0) return null
        val sepIdx = raw.indexOf("\r\n\r\n", htmlHeaderAt).let { if (it >= 0) it else raw.indexOf("\n\n", htmlHeaderAt) }
        if (sepIdx < 0) return null
        val sectionHeader = raw.substring(htmlHeaderAt, sepIdx)
        val bodyStart = sepIdx + (if (raw[sepIdx] == '\r') 4 else 2)
        // boundary 声明在顶层头（首个分节之前）
        val boundary = Regex("boundary=\"?([^\"\r\n;]+)", RegexOption.IGNORE_CASE)
            .find(raw.substring(0, htmlHeaderAt))?.groupValues?.get(1)
        var bodyEnd = raw.length
        if (boundary != null) {
            val next = raw.indexOf("--$boundary", bodyStart)
            if (next >= 0) bodyEnd = next
        }
        if (bodyEnd <= bodyStart) return null
        val body = raw.substring(bodyStart, bodyEnd)
        val cte = Regex("content-transfer-encoding:\\s*([a-z0-9-]+)", RegexOption.IGNORE_CASE)
            .find(sectionHeader)?.groupValues?.get(1)?.lowercase() ?: "quoted-printable"
        val charsetName = Regex("charset=\"?([\\w-]+)", RegexOption.IGNORE_CASE)
            .find(sectionHeader)?.groupValues?.get(1) ?: "utf-8"
        val decoded: ByteArray = when {
            "base64" in cte -> runCatching {
                java.util.Base64.getMimeDecoder().decode(body.replace(Regex("\\s"), ""))
            }.getOrNull() ?: return null
            "quoted-printable" in cte -> qpDecode(body)
            else -> body.toByteArray(Charsets.ISO_8859_1)
        }
        val cs = runCatching { Charset.forName(charsetName) }.getOrDefault(Charsets.UTF_8)
        return jsoupText(String(decoded, cs))
    }

    /** quoted-printable：先吃软换行 =\r\n / =\n，再解 =XX 十六进制字节 */
    private fun qpDecode(s: String): ByteArray {
        val noSoft = s.replace("=\r\n", "").replace("=\n", "")
        val out = java.io.ByteArrayOutputStream(noSoft.length)
        var i = 0
        val n = noSoft.length
        while (i < n) {
            val c = noSoft[i]
            if (c == '=' && i + 2 < n && isHex(noSoft[i + 1]) && isHex(noSoft[i + 2])) {
                out.write((hexVal(noSoft[i + 1]) shl 4) or hexVal(noSoft[i + 2]))
                i += 3
            } else {
                out.write(c.code and 0xFF)
                i++
            }
        }
        return out.toByteArray()
    }

    private fun isHex(c: Char): Boolean = c in '0'..'9' || c in 'a'..'f' || c in 'A'..'F'
    private fun hexVal(c: Char): Int = when (c) {
        in '0'..'9' -> c - '0'
        in 'a'..'f' -> c - 'a' + 10
        else -> c - 'A' + 10
    }

    // ── docx：ZipInputStream + StAX 抽 w:t 文本（w:p 断行；DTD/外部实体全关防 XXE） ──

    private fun docxText(bytes: ByteArray): String? {
        val factory = XMLInputFactory.newFactory().apply {
            setProperty(XMLInputFactory.SUPPORT_DTD, false)
            setProperty(XMLInputFactory.IS_SUPPORTING_EXTERNAL_ENTITIES, false)
        }
        ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
            var entry = zip.nextEntry
            while (entry != null) {
                if (entry.name == "word/document.xml") {
                    val parser = factory.createXMLStreamReader(zip, "UTF-8")
                    val sb = StringBuilder()
                    var inText = false
                    while (parser.hasNext()) {
                        when (parser.eventType) {
                            XMLStreamConstants.START_ELEMENT -> when (parser.localName) {
                                "t" -> inText = true
                                "tab" -> sb.append('\t')
                                "br" -> sb.append('\n')
                            }
                            XMLStreamConstants.CHARACTERS -> if (inText) sb.append(parser.text)
                            XMLStreamConstants.END_ELEMENT -> when (parser.localName) {
                                "t" -> inText = false
                                "p" -> sb.append('\n')
                            }
                        }
                        parser.next()
                    }
                    parser.close()
                    return sb.toString()
                }
                entry = zip.nextEntry
            }
        }
        return null
    }

    // ── xlsx：抽 xl/sharedStrings.xml 的 si/t 文本（si 断行；DTD/外部实体全关防 XXE） ──

    private fun xlsxText(bytes: ByteArray): String? {
        val factory = XMLInputFactory.newFactory().apply {
            setProperty(XMLInputFactory.SUPPORT_DTD, false)
            setProperty(XMLInputFactory.IS_SUPPORTING_EXTERNAL_ENTITIES, false)
        }
        ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
            var entry = zip.nextEntry
            while (entry != null) {
                if (entry.name == "xl/sharedStrings.xml") {
                    val parser = factory.createXMLStreamReader(zip, "UTF-8")
                    val sb = StringBuilder()
                    val cell = StringBuilder()
                    var inText = false
                    while (parser.hasNext()) {
                        when (parser.eventType) {
                            XMLStreamConstants.START_ELEMENT -> if (parser.localName == "t") inText = true
                            XMLStreamConstants.CHARACTERS -> if (inText) cell.append(parser.text)
                            XMLStreamConstants.END_ELEMENT -> when (parser.localName) {
                                "t" -> inText = false
                                "si" -> {
                                    sb.append(cell).append('\n')
                                    cell.setLength(0)
                                }
                            }
                        }
                        parser.next()
                    }
                    parser.close()
                    return sb.toString()
                }
                entry = zip.nextEntry
            }
        }
        return null
    }

    // ── pdf：PDFBox 文本层 ──

    private fun pdfText(bytes: ByteArray): String? =
        Loader.loadPDF(bytes).use { doc -> PDFTextStripper().getText(doc) }
}
