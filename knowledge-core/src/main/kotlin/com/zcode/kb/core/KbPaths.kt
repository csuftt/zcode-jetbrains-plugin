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
 * 双根模型（2026-11-22 改版）：元数据根固定 `~/.zcgui/knowledge/`（config.json + entries/，
 * 不可改——起点好找）；快照根（text/ 提取文本缓存 + restored/ git 恢复副本）默认与元数据
 * 同根，可在 config.json 顶层 `snapshotDir` 字段自定义（改位置由 KbManagerService 负责搬移，
 * 本类只解析）。与 zcode CLI 的 ~/.zcode 全然无关——红线：绝不读写 zcode 的
 * db.sqlite / tasks-index.sqlite。
 *
 * 历史兼容：旧版整库位置 pointer（`~/.zcgui/knowledge.location.json` 内 `{"root": "..."}`）
 * 仍读（rootDir 兼容解析），[migrateLegacyPointer] 负责一次性归位后删除；pointer 缺失/
 * 损坏一律按默认处理（fail-soft）。
 */
object KbPaths {

    private val json = Json { ignoreUnknownKeys = true }

    /** 元数据根目录；home 参数化便于单测。旧 pointer 残留时仍按其解析（迁移前兼容窗） */
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

    /**
     * 快照根目录：config.json 顶层 `snapshotDir`（空/损坏/缺文件 → 元数据根）。
     * config.json 固定在元数据根下，两侧（IDE 与 MCP server）同源解析。
     */
    fun snapshotDir(home: String? = null): Path {
        val root = rootDir(home)
        val custom = try {
            configFile(home).takeIf { it.exists() }
                ?.let { json.parseToJsonElement(it.readText()).jsonObject["snapshotDir"] }
                ?.jsonPrimitive?.content?.trim()
        } catch (e: Exception) {
            null
        }?.takeIf { it.isNotBlank() } ?: return root
        return try {
            Path.of(custom).takeIf { it.isAbsolute } ?: root // 相对路径防误配（与 MCP 侧同形）
        } catch (e: Exception) {
            root
        }
    }

    /** 条目元数据目录（每条目一份 `<id>.json`） */
    fun entriesDir(home: String? = null): Path = rootDir(home).resolve("entries")

    /** 提取文本缓存目录（每条目一份 `<id>.txt`；跟随快照根） */
    fun textDir(home: String? = null): Path = snapshotDir(home).resolve("text")

    /** config.json（目录树/标签注册表/快照位置；固定元数据根下） */
    fun configFile(home: String? = null): Path = rootDir(home).resolve("config.json")

    /** git 历史恢复出的文件落点（跟随快照根） */
    fun restoredDir(home: String? = null): Path = snapshotDir(home).resolve("restored")

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

    /**
     * 旧整库 pointer 一次性归位（幂等，store 首建前调用）：pointer 存在且 root≠默认时，
     * entries/ 与 config.json 搬回默认根（元数据固定语义），text/ 与 restored/ 留原地并
     * 记为快照根（config.snapshotDir=旧根），随后删 pointer。目标冲突/搬移失败保守放弃
     * （pointer 保留，下次重试），绝不丢数据。pointer 无有效 root 或 root==默认 → 仅清 pointer。
     *
     * @return 是否有实际迁移动作（测试/日志用）
     */
    fun migrateLegacyPointer(home: String? = null): Boolean {
        val h = home ?: System.getProperty("user.home") ?: "."
        val default = Path.of(h, ".zcgui", "knowledge")
        val pointer = Path.of(h, ".zcgui", "knowledge.location.json")
        if (!pointer.exists()) return false
        val custom = try {
            json.parseToJsonElement(pointer.readText()).jsonObject["root"]
                ?.jsonPrimitive?.content?.trim()
        } catch (e: Exception) {
            null
        }?.takeIf { it.isNotBlank() }
        val customPath = custom?.let { runCatching { Path.of(it).toAbsolutePath().normalize() }.getOrNull() }
        if (customPath == null || customPath == default.toAbsolutePath().normalize()) {
            runCatching { Files.deleteIfExists(pointer) } // 残留/损坏/非法路径/指默认：仅清 pointer
            return false
        }
        val old = customPath
        return try {
            if (!Files.isDirectory(old)) {
                Files.deleteIfExists(pointer)
                return false
            }
            Files.createDirectories(default)
            if (Files.exists(default.resolve("entries")) || Files.exists(default.resolve("config.json"))) {
                return false // 默认根已有同形数据：保守放弃，不覆盖
            }
            if (Files.isDirectory(old.resolve("entries"))) {
                moveDirectory(old.resolve("entries"), default.resolve("entries"))
            }
            if (Files.exists(old.resolve("config.json"))) {
                Files.move(old.resolve("config.json"), default.resolve("config.json"))
            }
            // 快照留原地记为快照根（任一存在才记；都不在=空库，快照根随默认）
            if (Files.isDirectory(old.resolve("text")) || Files.isDirectory(old.resolve("restored"))) {
                writeSnapshotDirField(default.resolve("config.json"), old.toString())
            }
            Files.deleteIfExists(pointer)
            true
        } catch (e: Exception) {
            false
        }
    }

    /**
     * 目录整体搬移：同盘 rename（ATOMIC_MOVE 优先）；跨盘走 walk 复制+删源——⚠️
     * Files.move 跨 provider 对非空目录必抛 DirectoryNotEmptyException（「普通 move 自动
     * copy+delete」是 Files.copy 的语义，此注释曾写错——真机实证）。Windows 瞬时句柄
     * （WatchService close 的异步释放窗口 / Explorer 停留 / 杀毒扫描 / MCP server 读缓存）
     * 会让 rename 偶发失败——失败退避重试（真机实证：一次重试即可过）。
     */
    fun moveDirectory(src: Path, dst: Path, retries: Int = 3) {
        Files.createDirectories(dst.parent)
        var last: Exception? = null
        repeat(retries) { attempt ->
            try {
                try {
                    Files.move(src, dst, StandardCopyOption.ATOMIC_MOVE)
                    return
                } catch (e: java.nio.file.AtomicMoveNotSupportedException) {
                    copyTreeDelete(src, dst)
                    return
                }
            } catch (e: Exception) {
                last = e
                if (attempt < retries - 1) {
                    Thread.sleep(200L * (attempt + 1))
                }
            }
        }
        throw last!!
    }

    /** 跨盘搬移底层：walk 复制（父先子后，覆盖写可续传）→ 复制完整后删源；复制中断源保留 */
    private fun copyTreeDelete(src: Path, dst: Path) {
        Files.walk(src).use { stream ->
            for (f in stream.sorted()) {
                val target = dst.resolve(src.relativize(f).toString())
                if (Files.isDirectory(f)) Files.createDirectories(target)
                else Files.copy(f, target, StandardCopyOption.REPLACE_EXISTING)
            }
        }
        src.toFile().deleteRecursively()
    }

    /** config.json 顶层 snapshotDir 字段写入（缺文件按最小结构新建；临时文件+原子移动） */
    private fun writeSnapshotDirField(configFile: Path, dir: String) {
        val base = try {
            json.parseToJsonElement(configFile.readText()).jsonObject.toMap()
        } catch (e: Exception) {
            emptyMap()
        }
        val merged = kotlinx.serialization.json.JsonObject(base + ("snapshotDir" to kotlinx.serialization.json.JsonPrimitive(dir)))
        Files.createDirectories(configFile.parent)
        val tmp = configFile.resolveSibling(configFile.fileName.toString() + ".tmp")
        tmp.toFile().writeText(json.encodeToString(kotlinx.serialization.json.JsonObject.serializer(), merged))
        Files.move(tmp, configFile, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
    }
}
