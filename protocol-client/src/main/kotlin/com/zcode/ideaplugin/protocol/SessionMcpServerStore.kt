package com.zcode.ideaplugin.protocol

import com.zcode.ideaplugin.protocol.model.McpServerSpec
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * 会话 → create 时注入的 mcpServers 磁盘档案（跨进程重启的 resume 沿用兜底）。
 *
 * 内存权威在 ZCodeProtocolClient.sessionMcpServers（LRU 200）；本档案把记录同步落
 * ~/.zcode/cli/zcgui-session-mcp.json，resume 内存未命中时按会话回灌。
 *
 * 为什么必须落盘（sess_03b9a979 托盘死循环真机实锤，2026-10-10）：注入记录只存内存，
 * IDE 重启（装包/升级后常规操作）恢复会话标签后 resume 不带 mcpServers → 服务端冷
 * 重建 runtime 丢 create 工具面 → CUA 工具静默消失；而用户级 node_repl（桌面客户端
 * 注册，不走会话注入）还在，模型被其「Computer Use only」描述诱导反复调用、调 CUA
 * 工具名又只拿回空结果（CLI 对不存在工具不报错），51 轮占位调用无法自诊。
 */
internal object SessionMcpServerStore {

    private val lock = Any()
    private val json = Json { ignoreUnknownKeys = true }

    /** 测试可覆盖路径（system property）；生产固定在 CLI 数据目录（与 CuaMediaStore 同区） */
    private fun storeFile(): File {
        System.getProperty("zcode.sessionMcpStore.path")?.let { return File(it) }
        return File(File(System.getProperty("user.home"), ".zcode/cli"), "zcgui-session-mcp.json")
    }

    /** 记录（read-modify-write，tmp+rename 原子落盘）；IO 失败静默（只影响重启后恢复，不挡主流程） */
    fun record(sessionId: String, servers: List<McpServerSpec>) {
        synchronized(lock) {
            try {
                val root = readRoot().toMutableMap()
                root[sessionId] = encodeServers(servers)
                writeRoot(root)
            } catch (e: Exception) {
                println("[ZCodeProtocolClient] session mcpServers store write failed: ${e.message}")
            }
        }
    }

    /** 按会话读取；无记录/文件缺失/形状损坏返回 null（任何异常 fail-soft 为 null） */
    fun load(sessionId: String): List<McpServerSpec>? {
        synchronized(lock) {
            return try {
                val arr = readRoot()[sessionId] ?: return null
                decodeServers(arr)
            } catch (e: Exception) {
                println("[ZCodeProtocolClient] session mcpServers store read failed: ${e.message}")
                null
            }
        }
    }

    /** 会话删除时顺手清档（fail-soft；残留记录只在同 id 会话 resume 时被读，无害） */
    fun forget(sessionId: String) {
        synchronized(lock) {
            try {
                val root = readRoot().toMutableMap()
                if (root.remove(sessionId) != null) writeRoot(root)
            } catch (ignore: Exception) {
            }
        }
    }

    // ───────────────────────── JSON 形状 ─────────────────────────
    // {"<sessionId>":[{name,command,args[],env:[{name,value}],isolation?,timeoutMs?,scope?,alwaysLoad?},...]}

    private fun readRoot(): Map<String, JsonArray> {
        val f = storeFile()
        if (!f.isFile) return emptyMap()
        val obj = json.parseToJsonElement(f.readText()).jsonObject
        val out = LinkedHashMap<String, JsonArray>()
        for ((k, v) in obj) {
            out[k] = v.jsonArray
        }
        return out
    }

    private fun writeRoot(root: Map<String, JsonArray>) {
        val f = storeFile()
        val obj = buildJsonObject {
            for ((k, v) in root) put(k, v)
        }
        f.parentFile?.mkdirs()
        val tmp = File(f.parentFile, f.name + ".tmp")
        Files.write(tmp.toPath(), obj.toString().toByteArray(Charsets.UTF_8))
        Files.move(tmp.toPath(), f.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
    }

    /** 编码与 wire 面 mcpServersJson 同形状（resume 直接可用） */
    private fun encodeServers(servers: List<McpServerSpec>): JsonArray = buildJsonArray {
        servers.forEach { s ->
            add(buildJsonObject {
                put("name", s.name)
                put("command", s.command)
                put("args", JsonArray(s.args.map { kotlinx.serialization.json.JsonPrimitive(it) }))
                put("env", JsonArray(s.env.map { (k, v) ->
                    buildJsonObject {
                        put("name", k)
                        put("value", v)
                    }
                }))
                s.isolation?.let { put("isolation", it) }
                s.timeoutMs?.let { put("timeoutMs", it) }
                // 与 ZCodeProtocolClient.mcpServersJson 同口径（3.17.x scope/alwaysLoad）
                s.scope?.let { put("scope", it) }
                s.alwaysLoad?.let { put("alwaysLoad", it) }
            })
        }
    }

    private fun decodeServers(arr: JsonArray): List<McpServerSpec> = arr.map { el ->
        val o = el.jsonObject
        McpServerSpec(
            name = o["name"]!!.jsonPrimitive.content,
            command = o["command"]!!.jsonPrimitive.content,
            args = o["args"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList(),
            env = o["env"]?.jsonArray?.mapNotNull { e ->
                val eo = e.jsonObject
                val n = eo["name"]?.jsonPrimitive?.content ?: return@mapNotNull null
                n to (eo["value"]?.jsonPrimitive?.content ?: "")
            }?.toMap() ?: emptyMap(),
            isolation = o["isolation"]?.jsonPrimitive?.content,
            timeoutMs = o["timeoutMs"]?.jsonPrimitive?.content?.toLongOrNull(),
            scope = o["scope"]?.jsonPrimitive?.content,
            alwaysLoad = o["alwaysLoad"]?.jsonPrimitive?.booleanOrNull,
        )
    }
}
