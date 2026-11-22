package com.zcode.kb.core

import java.nio.file.Path

/**
 * 收录弹窗的预填推断（确定性启发式，零网络依赖）：
 * - 标题：md 首个 `#` 标题（跳过 frontmatter）/ html `<title>` / docx·pdf 首个非空行，
 *   截 80 字符；**txt/log 与白名单外（嗅探接纳件）不做内容推断**，一律文件名去扩展名
 *   （弹窗可编辑）——纯文本首行是正文/时间戳不是标题（真机：idea.log 标题变日志首行）；
 * - 目录：路径段与既有目录名等值优先、包含次之（大小写不敏感），返回目录名由调用方
 *   映射目录 id（推不出 = 空串，落「根级」或上次收录目录）；
 * - 标签：既有标签出现在路径或正文头部（前 2000 字符）者，至多 5 个。
 */
object KbHeuristics {

    data class Suggestion(val title: String, val folderName: String, val tags: List<String>)

    fun suggest(
        file: Path,
        text: String?,
        existingFolderNames: List<String>,
        existingTags: List<String>,
    ): Suggestion {
        val name = file.fileName.toString()
        return Suggestion(
            title = suggestTitle(name, text),
            folderName = suggestFolderName(path = file.toString(), existingFolderNames),
            tags = suggestTags(path = file.toString(), text, existingTags),
        )
    }

    /** 无内容标题语义的纯文本（首行是正文/时间戳，不是标题）：标题一律落文件名 */
    private val FILENAME_TITLE_EXTS = setOf("txt", "log")

    fun suggestTitle(fileName: String, text: String?): String {
        val fallback = fileName.substringBeforeLast('.').trim().ifEmpty { fileName }
        val ext = KbExtractor.ext(fileName)
        // 纯文本（txt/log）与白名单外嗅探接纳件（py/sh/java/Makefile 等）不做内容推断——
        // 首行常是时间戳/package/shebang，文件名（类名/脚本名）本就是天然标题，弹窗标题框可编辑
        if (ext !in KbExtractor.SUPPORTED_EXTS || ext in FILENAME_TITLE_EXTS) return fallback
        val t = text?.take(64 * 1024) ?: return fallback
        val lines = t.lines()
        // frontmatter 跳过：--- 开头到下一个 ---
        var start = 0
        if (lines.firstOrNull()?.trim() == "---") {
            start = lines.drop(1).indexOfFirst { it.trim() == "---" }
            if (start >= 0) start += 2 else start = 0
        }
        for (i in start until lines.size) {
            val line = lines[i].trim()
            if (line.isEmpty()) continue
            val md = Regex("^#{1,6}\\s+(.+?)\\s*#*\\s*$").find(line)?.groupValues?.get(1)
            if (md != null) return md.take(80)
            val titleTag = Regex("<title>(.*?)</title>", RegexOption.IGNORE_CASE).find(line)?.groupValues?.get(1)
            if (titleTag != null) return titleTag.trim().take(80)
            // 非结构化文本（docx/pdf 提取件）：首个非空行
            if (!fileName.substringAfterLast('.', "").lowercase().let { it == "md" || it == "markdown" || it == "html" || it == "htm" }) {
                return line.take(80)
            }
            break // md/html：首个非空行不是标题就停，落兜底
        }
        return fallback
    }

    fun suggestFolderName(path: String, existingFolderNames: List<String>): String {
        if (existingFolderNames.isEmpty()) return ""
        val segments = path.replace('\\', '/').split('/').filter { it.isNotBlank() }.dropLast(1) // 去文件名
        for (seg in segments.reversed()) {
            existingFolderNames.firstOrNull { it.equals(seg, ignoreCase = true) }?.let { return it }
        }
        val lowerPath = path.lowercase()
        return existingFolderNames.firstOrNull { lowerPath.contains(it.lowercase()) } ?: ""
    }

    fun suggestTags(path: String, text: String?, existingTags: List<String>): List<String> {
        if (existingTags.isEmpty()) return emptyList()
        val lowerPath = path.lowercase()
        val head = text?.take(2000)?.lowercase() ?: ""
        return existingTags.filter { tag ->
            val t = tag.lowercase()
            t.isNotEmpty() && (lowerPath.contains(t) || head.contains(t))
        }.take(5)
    }
}
