package com.zcode.ideaplugin.ui

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.io.RandomAccessFile
import java.time.LocalDate
import java.time.format.DateTimeFormatter

/**
 * MCP 连接日志读取器（设置页「MCP → 连接日志」数据源）
 *
 * ZCode CLI 把 MCP 连接生命周期写进 ~/.zcode/cli/log/zcode-<本地日期>.jsonl
 * （结构化 JSONL，按天滚动保留 7 天）。关键事件（event 字段）：
 *   mcp.server.connect.started / mcp.server.connected（含 connectDurationMs、
 *   listToolsDurationMs、toolCount）/ mcp.server.failed（warn 级，含 error 与
 *   服务器进程 stderr，截断 4000 字符）/ mcp.server.connection_lost /
 *   mcp.server.reconnect.* / mcp.server.closed / mcp.startup.completed 等。
 *
 * 读取策略：今天 + 昨天两个文件的尾部 chunk（高频使用时单日 >10MB，
 * 全量逐行 parse 太慢；连接日志集中在尾部），按 event 前缀 mcp. 过滤，
 * 剔除高频噪音（pool.lease.* 每次工具调用一条），返回最近 limit 条。
 * 跨天注意：文件按本地日期滚动但 timestamp 是 UTC，昨天的连接日志可能在昨天文件。
 */
object McpLogReader {

    data class McpLogEntry(
        /** 原始 ISO8601 时间戳（UTC，前端 new Date() 转本地展示）*/
        val timestamp: String,
        /** info | warn | error */
        val level: String,
        /** 原始事件名（如 mcp.server.connected，过滤/染色用）*/
        val event: String,
        /** 服务器名（context.mcpServerName；startup 类事件为空）*/
        val serverName: String,
        /** 人读消息（按 event 从 context 拼中文摘要，未识别事件回退原始 message）*/
        val message: String,
        /** 顶层 durationMs（connected/failed 行有）*/
        val durationMs: Long?,
        /** connected 事件 context.toolCount（宿主条目等拿不到 RPC 状态时的工具数兜底）*/
        val toolCount: Int?,
    )

    private const val TAIL_BYTES = 3L * 1024 * 1024 // 每文件读尾部 3MB
    private const val DEFAULT_LIMIT = 200
    private val DATE_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd")

    private val json = Json { ignoreUnknownKeys = true }

    /** 读取最近的 MCP 连接日志（今天+昨天文件尾部，按时间序返回最近 limit 条） */
    fun readRecent(limit: Int = DEFAULT_LIMIT): List<McpLogEntry> {
        val dir = File(System.getProperty("user.home"), ".zcode/cli/log")
        if (!dir.isDirectory) return emptyList()

        val today = LocalDate.now()
        val files = listOf(
            File(dir, "zcode-${today.minusDays(1).format(DATE_FMT)}.jsonl"),
            File(dir, "zcode-${today.format(DATE_FMT)}.jsonl"),
        )

        val entries = ArrayList<McpLogEntry>()
        for (f in files) {
            if (!f.isFile) continue
            entries.addAll(parseMcpLines(readTailLines(f)))
        }
        // 文件序即时间序，再保险排一次（跨天 UTC 边界）
        entries.sortBy { it.timestamp }
        return entries.takeLast(limit)
    }

    /** 读文件尾部 chunk 并按行切（首行可能被截断，丢弃） */
    private fun readTailLines(file: File): List<String> {
        RandomAccessFile(file, "r").use { raf ->
            val len = raf.length()
            val start = maxOf(0L, len - TAIL_BYTES)
            raf.seek(start)
            val buf = ByteArray((len - start).toInt())
            raf.readFully(buf)
            val text = String(buf, Charsets.UTF_8)
            val lines = text.split("\n").filter { it.isNotBlank() }
            // 尾部 chunk 起始行可能不完整；只有从文件头读时首行才可信
            return if (start > 0 && lines.isNotEmpty()) lines.drop(1) else lines
        }
    }

    /** 行 → McpLogEntry（非 mcp.* / 坏行 / 噪音事件跳过） */
    private fun parseMcpLines(lines: List<String>): List<McpLogEntry> {
        val out = ArrayList<McpLogEntry>(lines.size / 8)
        for (line in lines) {
            val obj = runCatching { json.parseToJsonElement(line).jsonObject }.getOrNull() ?: continue
            val event = obj["event"]?.let { runCatching { it.jsonPrimitive.content }.getOrNull() } ?: continue
            if (!event.startsWith("mcp.")) continue
            // pool.lease.* 每次工具调用两条，纯噪音
            if (event.startsWith("mcp.pool.lease.")) continue

            val ctx = obj["context"]?.let { runCatching { it.jsonObject }.getOrNull() }
            out.add(
                McpLogEntry(
                    timestamp = str(obj["timestamp"]) ?: continue,
                    level = str(obj["level"]) ?: "info",
                    event = event,
                    serverName = str(ctx?.get("mcpServerName")) ?: "",
                    message = renderMessage(event, obj, ctx),
                    durationMs = obj["durationMs"]?.let { runCatching { it.jsonPrimitive.content.toLong() }.getOrNull() },
                    toolCount = ctx?.get("toolCount")?.let { runCatching { it.jsonPrimitive.content.toInt() }.getOrNull() },
                )
            )
        }
        return out
    }

    /** 按 event 把 context 关键字段拼成人读中文摘要 */
    private fun renderMessage(event: String, obj: JsonObject, ctx: JsonObject?): String {
        val raw = str(obj["message"]) ?: event
        return when (event) {
            "mcp.server.connect.started" -> "开始连接（${str(ctx?.get("transport")) ?: "?"}，超时 ${str(ctx?.get("timeoutMs")) ?: "?"}ms）"
            "mcp.server.connected" -> {
                val connect = str(ctx?.get("connectDurationMs"))
                val tools = str(ctx?.get("listToolsDurationMs"))
                val count = str(ctx?.get("toolCount"))
                buildString {
                    append("连接成功")
                    connect?.let { append(" · 连接耗时 ${it}ms") }
                    tools?.let { append(" · 工具枚举 ${it}ms") }
                    count?.let { append(" · ${it} 个工具") }
                }
            }
            "mcp.server.failed" -> buildString {
                append("连接失败 · ")
                append(str(ctx?.get("error")) ?: raw)
                str(ctx?.get("stderr"))?.take(300)?.let { append("  [stderr] $it") }
            }
            "mcp.server.connection_lost" -> "连接丢失 · ${str(ctx?.get("error")) ?: raw}"
            "mcp.server.reconnect.started" -> "开始重连（第 ${str(ctx?.get("attempt")) ?: "?"} 次）"
            "mcp.server.reconnect.failed" -> "重连失败 · ${str(ctx?.get("error")) ?: raw}"
            "mcp.server.closed" -> "连接已关闭"
            "mcp.server.connect.skipped" -> "跳过连接 · ${str(ctx?.get("reason")) ?: raw}"
            "mcp.tools.registered" -> "注册 ${str(ctx?.get("registeredToolCount")) ?: str(ctx?.get("toolCount")) ?: "?"} 个工具"
            "mcp.existing_tools.failed" -> "既有工具注册失败 · ${str(ctx?.get("error")) ?: raw}"
            "mcp.startup.scheduled" -> "MCP 启动排期（${str(ctx?.get("serverCount")) ?: "?"} 台）"
            "mcp.startup.completed" -> "MCP 启动完成 · ${str(ctx?.get("serverCount")) ?: "?"} 台 · ${objStr(ctx?.get("statusCounts")) ?: ""} · 共 ${str(ctx?.get("toolCount")) ?: "?"} 个工具"
            "mcp.startup.failed", "mcp.initialization.failed" -> "MCP 启动失败 · ${str(ctx?.get("error")) ?: raw}"
            else -> raw
        }
    }

    private fun str(e: kotlinx.serialization.json.JsonElement?): String? =
        e?.let { runCatching { it.jsonPrimitive.content }.getOrNull() }?.takeIf { it.isNotBlank() }

    /** 对象/数组字段 → toString（statusCounts 等嵌套结构，str 的 jsonPrimitive 会失败）*/
    private fun objStr(e: kotlinx.serialization.json.JsonElement?): String? =
        e?.let { runCatching { it.jsonObject.toString() }.getOrNull() }?.takeIf { it.isNotBlank() }
}
