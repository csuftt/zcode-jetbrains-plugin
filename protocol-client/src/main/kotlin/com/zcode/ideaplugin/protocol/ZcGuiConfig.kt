package com.zcode.ideaplugin.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
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
 * 插件自有配置（~/.zcgui/config.json）：内置渠道的 apiKey 手动覆盖表。
 *
 * 背景（issue #8 终案）：内置渠道的 key 权威在 ZCode 客户端——团队套餐 key 只在客户端
 * 主进程内存投影不落盘、未来个人版 key 也可能停止落盘；与其追客户端内部机制，不如让
 * 用户手填（团队项目 key 在 bigmodel 开放平台创建，即 Claude Code 接入用的那种）。
 * 渠道本体（baseURL/模型清单/上下文长度）仍以 ~/.zcode/v2/config.json 为准自动跟随，
 * 本文件只存「渠道 id → key」映射；在 [RuntimeModels]/[Credentials] 构造出口按
 * 「zcgui 覆盖 > config.json 值」合并——runtimeModel 随 send/resume 每轮上送，
 * 服务端自动刷进 workspace 目录，无需注册表推送（推送会被会话链覆盖，实测冲突）。
 *
 * 写入原子（临时文件 + ATOMIC_MOVE），损坏/缺失文件按空表处理（fail-soft）。
 */
object ZcGuiConfig {

    private val json = Json {
        ignoreUnknownKeys = true
        prettyPrint = true
    }

    /** 配置文件路径（~/.zcgui/config.json）；home 参数化便于单测 */
    fun configPath(home: String? = null): Path =
        Path.of(home ?: System.getProperty("user.home") ?: ".", ".zcgui", "config.json")

    /** 当前全部 apiKey 覆盖（渠道 id → key）；无配置/损坏返回空表 */
    fun providerKeyOverrides(home: String? = null): Map<String, String> {
        val f = configPath(home)
        if (!f.exists()) return emptyMap()
        return try {
            val node = json.parseToJsonElement(f.readText()).jsonObject["providerKeyOverrides"]?.jsonObject
                ?: return emptyMap()
            node.entries.mapNotNull { (id, v) ->
                val key = (v as? kotlinx.serialization.json.JsonPrimitive)?.content?.trim()
                if (key.isNullOrEmpty()) null else id to key
            }.toMap()
        } catch (e: Exception) {
            emptyMap()
        }
    }

    /**
     * 写/清单个渠道的覆盖 key（key=null 删除该条）；其余键保留。
     * @return 成功与否（失败调用方提示，不影响主流程）
     */
    fun setProviderKeyOverride(providerId: String, key: String?, home: String? = null): Boolean = try {
        val f = configPath(home)
        val root: JsonObject = if (f.exists()) {
            json.parseToJsonElement(f.readText()).jsonObject
        } else {
            JsonObject(emptyMap())
        }
        val overrides = root.toMutableMap()
        val table = root["providerKeyOverrides"]?.jsonObject?.toMutableMap() ?: mutableMapOf()
        if (key.isNullOrBlank()) table.remove(providerId) else table[providerId] = kotlinx.serialization.json.JsonPrimitive(key)
        overrides["providerKeyOverrides"] = JsonObject(table)
        Files.createDirectories(f.parent)
        val tmp = f.resolveSibling(f.fileName.toString() + ".tmp")
        tmp.toFile().writeText(json.encodeToString(JsonObject.serializer(), buildJsonObject {
            overrides.forEach { (k, v) -> put(k, v) }
        }))
        Files.move(tmp, f, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        true
    } catch (e: Exception) {
        false
    }
}
