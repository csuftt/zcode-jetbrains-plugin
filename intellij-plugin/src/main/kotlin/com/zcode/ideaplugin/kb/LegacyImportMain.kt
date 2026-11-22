package com.zcode.ideaplugin.kb

import com.zcode.kb.core.KbEntry
import com.zcode.kb.core.KbExtractor
import com.zcode.kb.core.KbGitCli
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
 * ——指针模型收录 sourcePath，git 源条目沿用登记表里的 branch/commit/relFromRoot
 * 锚点（比重新锚定更忠实收录时点）；源文件在盘上的顺手提取文本，失联条目落 missing
 * （后续可从 git 锚点恢复）。可重复跑（按 sourcePath 判重，命中即跳过）。
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
    val cli = KbGitCli()
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
            val git = e["git"]?.let { if (it.toString() == "null") null else it.jsonObject }
            val file = Path.of(display)
            val exists = Files.isRegularFile(file)
            val text = if (exists) KbExtractor.extract(file) else null
            val ingestedAt = str("ingestedAt")?.let {
                runCatching { Instant.parse(it).toEpochMilli() }.getOrDefault(System.currentTimeMillis())
            } ?: System.currentTimeMillis()
            // 登记表 category 语义=目录路径：逐级建目录树（一次性导入工具，无 UI）
            val folderId = str("category")?.takeIf { it.isNotBlank() }?.let { store.ensureFolderPath(it) } ?: ""
            val entry = KbEntry(
                id = "kb-" + md8(display),
                sourcePath = display,
                title = str("title")?.take(120) ?: file.fileName.toString(),
                folderId = folderId,
                tags = emptyList(),
                notes = "imported from knowledge-index registry (id=${str("id") ?: "-"})",
                project = str("project") ?: "",
                fileExt = "." + display.substringAfterLast('.', "").lowercase(),
                sizeBytes = if (exists) Files.size(file) else 0,
                gitRepo = git?.let { str2(it, "branch")?.let { b -> guessRepoRoot(display, b) } },
                gitCommit = git?.let { str2(it, "commit") },
                gitRel = git?.let { str2(it, "relFromRoot") },
                status = if (exists) KbEntry.STATUS_OK else KbEntry.STATUS_MISSING,
                ingestedAt = ingestedAt,
                updatedAt = System.currentTimeMillis(),
                indexedMtime = if (exists) Files.getLastModifiedTime(file).toMillis() else 0,
                indexedSize = if (exists) Files.size(file) else 0,
            )
            store.insert(entry, text ?: "")
            imported++
            if (!exists) missing++
        }
    }
    println("imported=$imported skipped=$skipped missingSource=$missing")
}

private fun str2(o: kotlinx.serialization.json.JsonObject, k: String): String? =
    o[k]?.let { if (it.toString() == "null") null else it.jsonPrimitive.content }

/**
 * 登记表没记仓根只记 branch：按经验规则从源路径猜仓根不可靠——改为只锚 commit+rel，
 * gitRepo 留 null（恢复入口对无 repo 的条目置灰）。此处返回 null。
 */
private fun guessRepoRoot(display: String, branch: String): String? = null

private fun md8(s: String): String =
    MessageDigest.getInstance("MD5").digest(s.toByteArray())
        .joinToString("") { "%02x".format(it) }.take(8)
