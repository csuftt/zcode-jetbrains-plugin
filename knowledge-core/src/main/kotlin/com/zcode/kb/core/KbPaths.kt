package com.zcode.kb.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import kotlin.io.path.exists
import kotlin.io.path.readText

/**
 * 知识库存储位置解析。
 *
 * 默认 `~/.zcgui/knowledge/`（插件自有目录，与 zcode CLI 的 ~/.zcode 全然无关——红线：
 * 绝不读写 zcode 的 db.sqlite / tasks-index.sqlite）。用户可在设置里改库位置：改位置
 * 时调用方负责把整个目录搬过去，本类只负责按 pointer 文件（`~/.zcgui/knowledge.location.json`
 * 内 `{"root": "..."}`）解析当前权威根；pointer 缺失/损坏按默认处理（fail-soft）。
 */
object KbPaths {

    private val json = Json { ignoreUnknownKeys = true }

    /** 库根目录；home 参数化便于单测 */
    fun rootDir(home: String? = null): Path {
        val h = home ?: System.getProperty("user.home") ?: "."
        val default = Path.of(h, ".zcgui", "knowledge")
        val pointer = Path.of(h, ".zcgui", "knowledge.location.json")
        if (!pointer.exists()) return default
        return try {
            val custom = json.parseToJsonElement(pointer.readText()).jsonObject["root"]
                ?.jsonPrimitive?.content?.trim()
            if (custom.isNullOrBlank()) default else Path.of(custom)
        } catch (e: Exception) {
            default
        }
    }

    /** 条目元数据目录（每条目一份 `<id>.json`） */
    fun entriesDir(home: String? = null): Path = rootDir(home).resolve("entries")

    /** 提取文本缓存目录（每条目一份 `<id>.txt`） */
    fun textDir(home: String? = null): Path = rootDir(home).resolve("text")

    /** 模块清单（config.json，有序） */
    fun configFile(home: String? = null): Path = rootDir(home).resolve("config.json")

    /** git 历史恢复出的文件落点（收录条目的源失联时按锚点 commit 捞回） */
    fun restoredDir(home: String? = null): Path = rootDir(home).resolve("restored")

    /** 设置页改库位置：写 pointer（root=null 清除恢复默认）。搬目录由调用方负责。 */
    fun setCustomRoot(root: String?, home: String? = null): Boolean = try {
        val h = home ?: System.getProperty("user.home") ?: "."
        val pointer = Path.of(h, ".zcgui", "knowledge.location.json")
        if (root.isNullOrBlank()) {
            Files.deleteIfExists(pointer)
        } else {
            Files.createDirectories(pointer.parent)
            val tmp = pointer.resolveSibling(pointer.fileName.toString() + ".tmp")
            tmp.toFile().writeText(json.encodeToString(
                kotlinx.serialization.json.JsonObject.serializer(),
                buildJsonObject { put("root", root) }
            ))
            Files.move(tmp, pointer, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        }
        true
    } catch (e: Exception) {
        false
    }
}
