package com.zcode.ideaplugin.ui

import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/**
 * ZCode 客户端（桌面版）设置文件读写：~/.zcode/v2/setting.json
 *
 * 「工作区记忆（自动记忆）」开关与客户端共用这一份——桌面端 设置→常规 的开关、
 * 插件设置页的开关、app-server 的 session/requestRuntimePreferences 应答三处同源：
 * 插件切换时写回此文件，客户端下次读配置同样生效，反之亦然。
 * （「提问自动继续」不在此列：插件自有配置走 ZCodeAskUserConfig，见该类注释。）
 *
 * 字段默认值对齐 zcode.cjs 的 zod schema：
 *   memoryEnabled=false / nativeSearchEnhancementsEnabled=true
 * 该文件还存了客户端的窗口尺寸、最近项目等大量无关状态——写入时只改目标字段，
 * 其余键原样保留。
 */
object ZCodeClientSettingStore {

    private val LOCK = Any()

    private val prettyJson = Json { prettyPrint = true; prettyPrintIndent = "  " }

    /** requestRuntimePreferences 应答所需两项（askUser 自动继续由 ZCodeAskUserConfig 提供） */
    data class RuntimePrefs(
        val memoryEnabled: Boolean = false,
        val nativeSearchEnhancementsEnabled: Boolean = true,
    )

    /**
     * 自动归档旧任务配置（与客户端「设置→任务」同源共享）
     *
     * 客户端 zod schema：taskAutoArchiveEnabled boolean optional（缺失=关）、
     * taskAutoArchiveOlderThanDays int positive max(365) optional（缺失取 7，
     * 见 asar readTaskAutoArchiveConfig 的 ??7 兜底）。
     */
    data class AutoArchiveConfig(
        val enabled: Boolean = false,
        val olderThanDays: Int = 7,
    )

    fun settingPath(home: String = System.getProperty("user.home")): File =
        File(File(home, ".zcode/v2"), "setting.json")

    /** 读两项运行时偏好（文件缺失/损坏/字段缺失时用 CLI 侧同款默认值） */
    fun readRuntimePrefs(home: String = System.getProperty("user.home")): RuntimePrefs = synchronized(LOCK) {
        val root = readRoot(home) ?: return RuntimePrefs()
        RuntimePrefs(
            memoryEnabled = root.booleanField("memoryEnabled") ?: false,
            nativeSearchEnhancementsEnabled = root.booleanField("nativeSearchEnhancementsEnabled") ?: true,
        )
    }

    /** 读自动归档配置（客户端同默认：关 + 7 天） */
    fun readAutoArchiveConfig(home: String = System.getProperty("user.home")): AutoArchiveConfig = synchronized(LOCK) {
        val root = readRoot(home) ?: return AutoArchiveConfig()
        AutoArchiveConfig(
            enabled = root.booleanField("taskAutoArchiveEnabled") ?: false,
            olderThanDays = root.intField("taskAutoArchiveOlderThanDays")?.coerceIn(1, 365) ?: 7,
        )
    }

    /** 写自动归档两键（其余键原样保留）；days 钳到客户端 schema 界 1..365 */
    fun writeAutoArchiveConfig(enabled: Boolean, olderThanDays: Int, home: String = System.getProperty("user.home")): Boolean =
        writeFields(home, "taskAutoArchiveEnabled" to JsonPrimitive(enabled),
            "taskAutoArchiveOlderThanDays" to JsonPrimitive(olderThanDays.coerceIn(1, 365)))

    /** 只改 memoryEnabled 一个字段，其余键原样保留；tmp + 原子 move 防写坏 */
    fun writeMemoryEnabled(enabled: Boolean, home: String = System.getProperty("user.home")): Boolean =
        writeFields(home, "memoryEnabled" to JsonPrimitive(enabled))

    /** 多字段写入（保留其余键；文件缺失写最小片段——客户端按 zod schema 读缺失键走默认值）*/
    private fun writeFields(home: String, vararg fields: Pair<String, JsonPrimitive>): Boolean = synchronized(LOCK) {
        val file = settingPath(home)
        val root = readRoot(home)
        val newRoot = buildJsonObject {
            if (root != null) root.forEach { (k, v) -> if (k !in fields.map { it.first }) put(k, v) }
            fields.forEach { (k, v) -> put(k, v) }
        }
        try {
            file.parentFile?.mkdirs()
            val tmp = File(file.parentFile, file.name + ".tmp")
            tmp.writeText(prettyJson.encodeToString(JsonObject.serializer(), newRoot), Charsets.UTF_8)
            Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun readRoot(home: String): JsonObject? = try {
        val f = settingPath(home)
        if (f.isFile) Json.parseToJsonElement(f.readText(Charsets.UTF_8)).jsonObject else null
    } catch (_: Exception) {
        null
    }

    private fun JsonObject.booleanField(key: String): Boolean? =
        (this[key] as? JsonPrimitive)?.booleanOrNull

    private fun JsonObject.intField(key: String): Int? =
        (this[key] as? JsonPrimitive)?.content?.toIntOrNull()
}
