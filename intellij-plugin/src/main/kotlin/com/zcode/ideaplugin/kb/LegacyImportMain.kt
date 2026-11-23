package com.zcode.ideaplugin.kb

import com.zcode.kb.core.KbContent
import com.zcode.kb.core.KbEntry
import com.zcode.kb.core.KbExtractor
import com.zcode.kb.core.KbPaths
import com.zcode.kb.core.KbFileStore
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.time.Instant
import kotlin.system.exitProcess

/**
 * 旧版 knowledge-index skill 登记表（Obsidian MOC 时代）→ 新知识库一次性导入工具。
 *
 * ⚠️ 维护者个人迁移用（issue#54 定案：不随插件发布、无 UI 入口）：命令行跑
 * `java -cp <插件lib目录> com.zcode.ideaplugin.kb.LegacyImportMainKt <登记表.json>`
 * ——收录 sourcePath，源文件在盘上的提取文本并落一份文档快照；源文件不在的条目没有
 * 内容，只能靠「重新指定路径」恢复。可重复跑（按 sourcePath 判重，命中即跳过）。
 */
fun main(args: Array<String>) {
    if (args.isEmpty()) {
        System.err.println("usage: LegacyImportMain <登记表.json> [home]")
        exitProcess(2)
    }
    val registry = Path.of(args[0])
    val home = args.getOrNull(1)
    val json = Json { ignoreUnknownKeys = true }
    val root = json.parseToJsonElement(Files.readString(registry)).jsonObject
    val entries = root["entries"]?.jsonArray ?: run {
        System.err.println("no entries array in registry")
        exitProcess(2)
    }
    var imported = 0
    var skipped = 0
    var missing = 0
    KbFileStore(KbPaths.rootDir(home)).use { store ->
        for (el in entries) {
            val e = el.jsonObject
            fun str(k: String): String? = e[k]?.let { if (it.toString() == "null") null else it.jsonPrimitive.content }
            val sourcePath = str("sourcePath") ?: continue
            val display = KbFileStore.displayPath(sourcePath)
            if (store.findBySource(display) != null) {
                skipped++
                continue
            }
            val file = Path.of(display)
            val exists = Files.isRegularFile(file)
            val text = if (exists) KbExtractor.extract(file) else null
            val ingestedAt = str("ingestedAt")?.let {
                runCatching { Instant.parse(it).toEpochMilli() }.getOrDefault(System.currentTimeMillis())
            } ?: System.currentTimeMillis()
            // 登记表 category 语义=目录路径：逐级建目录树（一次性导入工具，无 UI）
            val folderId = str("category")?.takeIf { it.isNotBlank() }?.let { store.ensureFolderPath(it) } ?: ""
            val id = "kb-" + md8(display)
            val captured = if (exists) {
                runCatching { KbContent.capture(store.root(), id, display) }.getOrNull()
            } else {
                null
            }
            val entry = KbEntry(
                id = id,
                sourcePath = display,
                title = str("title")?.take(120) ?: file.fileName.toString(),
                folderId = folderId,
                tags = emptyList(),
                notes = "imported from knowledge-index registry (id=${str("id") ?: "-"})",
                project = str("project") ?: "",
                fileExt = "." + display.substringAfterLast('.', "").lowercase(),
                sizeBytes = captured?.size ?: if (exists) Files.size(file) else 0,
                contentHash = captured?.hash ?: "",
                ingestedAt = ingestedAt,
                updatedAt = System.currentTimeMillis(),
            )
            store.insert(entry, text ?: "")
            imported++
            if (!exists) missing++
        }
    }
    println("imported=$imported skipped=$skipped missingSource=$missing")
}

private fun md8(s: String): String =
    MessageDigest.getInstance("MD5").digest(s.toByteArray())
        .joinToString("") { "%02x".format(it) }.take(8)
