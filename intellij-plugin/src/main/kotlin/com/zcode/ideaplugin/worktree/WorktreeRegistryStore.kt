package com.zcode.ideaplugin.worktree

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put

/**
 * worktree 注册表的纯 JSON 层（0.4.6，GLOSSARY「worktree 注册表」）。
 *
 * 承载插件自建 worktree 会话的「会话 ↔ worktree ↔ 源工作区」对应关系；持久化在
 * project 级 kv（key 见 [KEY]，模式同 ZCodeLinkedWorkspaces，由 intellij-plugin 侧
 * 薄封装读写 PropertiesComponent）。桌面端建的会话不进注册表（tasks-index 只读现查），
 * 两源在列表层合并。
 *
 * 序列化 fail-soft：kv 是插件私有，损坏/缺字段按条丢弃不抛——宁少显示不炸面板。
 */
object WorktreeRegistryStore {

    /** project 级 kv key（PropertiesComponent） */
    const val KEY = "zcode.worktreeSessions.v1"

    data class WorktreeSessionInfo(
        val sessionId: String,
        /** worktree 根（~/.zcode/worktrees/<桶>/<仓库名>） */
        val worktreeRoot: String,
        /** 会话执行根（worktree 内对应源目录的路径，可能是仓库子目录） */
        val cwd: String,
        /** 源工作区（本项目或关联目录，历史列表归属锚点） */
        val sourceWorkspace: String,
        /** 起点（分支名或 "HEAD"），纯展示 */
        val startRef: String,
        /** 起点提交 sha（发送时刻定版） */
        val startSha: String,
        val bucket: String,
        val createdAt: Long,
    )

    fun serialize(list: List<WorktreeSessionInfo>): String =
        Json.encodeToString(JsonArray.serializer(), JsonArray(list.map { e ->
            buildJsonObject {
                put("sessionId", e.sessionId)
                put("worktreeRoot", e.worktreeRoot)
                put("cwd", e.cwd)
                put("sourceWorkspace", e.sourceWorkspace)
                put("startRef", e.startRef)
                put("startSha", e.startSha)
                put("bucket", e.bucket)
                put("createdAt", e.createdAt)
            }
        }))

    /** 损坏/缺必填字段按条丢弃；输出稳定按输入序 */
    fun parse(raw: String?): List<WorktreeSessionInfo> {
        if (raw.isNullOrBlank()) return emptyList()
        val array = try {
            Json.parseToJsonElement(raw).jsonArray
        } catch (_: Exception) {
            return emptyList()
        }
        return array.mapNotNull { el ->
            val o = el as? JsonObject ?: return@mapNotNull null
            val sessionId = str(o, "sessionId") ?: return@mapNotNull null
            val worktreeRoot = str(o, "worktreeRoot") ?: return@mapNotNull null
            val cwd = str(o, "cwd") ?: return@mapNotNull null
            val sourceWorkspace = str(o, "sourceWorkspace") ?: return@mapNotNull null
            WorktreeSessionInfo(
                sessionId = sessionId,
                worktreeRoot = worktreeRoot,
                cwd = cwd,
                sourceWorkspace = sourceWorkspace,
                startRef = str(o, "startRef") ?: "",
                startSha = str(o, "startSha") ?: "",
                bucket = str(o, "bucket") ?: "",
                createdAt = (o["createdAt"] as? JsonPrimitive)?.long ?: 0L,
            )
        }
    }

    /** 同 sessionId 覆盖（重复创建防抖兜底），其余保持输入序 */
    fun upsert(list: List<WorktreeSessionInfo>, info: WorktreeSessionInfo): List<WorktreeSessionInfo> =
        list.filter { it.sessionId != info.sessionId } + info

    fun remove(list: List<WorktreeSessionInfo>, sessionId: String): List<WorktreeSessionInfo> =
        list.filter { it.sessionId != sessionId }

    private fun str(o: JsonObject, key: String): String? =
        (o[key] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() }
}
