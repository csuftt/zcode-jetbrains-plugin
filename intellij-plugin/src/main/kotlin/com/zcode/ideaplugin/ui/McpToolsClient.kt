package com.zcode.ideaplugin.ui

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.thread

/**
 * MCP 工具列表客户端（设置页「MCP → 工具列表」数据源）
 *
 * 背景：app-server 协议 mcp/list 只回 toolCount 无工具明细（zcode.cjs 已确认
 * 全协议仅此一个 mcp RPC），CLI 连接日志也只有计数字段 —— 工具名单拿不到。
 * 因此参照 cc-gui（ServerToolsPanel + get_mcp_server_tools）的做法：插件自己
 * 按 MCP 规范连一次服务器调 tools/list。
 *
 * 两种传输：
 *   stdio  起子进程走 newline-delimited JSON-RPC：initialize → initialized 通知
 *          → tools/list → 读响应 → 销毁进程。stderr 单独线程 drain（防 4KB
 *          管道满卡死 server，同 appserver stderr 教训）。
 *   http/sse  按 Streamable HTTP POST JSON-RPC（Accept: application/json,
 *          text/event-stream；响应兼容纯 JSON 与 SSE data: 行两种形态），
 *          initialize 响应的 Mcp-Session-Id 回带到后续请求。sse 老协议
 *          （GET /sse 建 endpoint 流）不做，按 streamable 尝试。
 *
 * 协议版本发 "2025-06-18"（server 响应回自身支持版本，双方忽略不识别的更高
 * 版本即可协商成功）。仅读 name/description（description 截 400 字符给 tooltip）。
 */
object McpToolsClient {

    data class McpToolInfo(val name: String, val description: String?)

    class McpClientException(message: String) : Exception(message)

    private const val PROTOCOL_VERSION = "2025-06-18"
    private const val CLIENT_NAME = "zcode-idea-plugin"
    private const val CLIENT_VERSION = "0.2.7"
    private const val DESC_MAX_LEN = 400

    /**
     * ZCode modern era 协议版本（宿主内置 server 如 node_repl 专用，2026-07-28）：
     * 不做标准 initialize（对旧版本号回 Unsupported protocol version -32022，
     * data.supported 列出可用地版本），改由每个请求 params._meta 携带信封
     * （protocolVersion + clientInfo + clientCapabilities，缺一即拒）。
     */
    private const val MODERN_PROTOCOL_VERSION = "2026-07-28"

    /** modern era 请求信封（io.modelcontextprotocol/ 前缀扩展键，三字段缺一不可） */
    private fun modernMeta() = buildJsonObject {
        put("io.modelcontextprotocol/protocolVersion", MODERN_PROTOCOL_VERSION)
        put("io.modelcontextprotocol/clientInfo", buildJsonObject {
            put("name", CLIENT_NAME)
            put("version", CLIENT_VERSION)
        })
        put("io.modelcontextprotocol/clientCapabilities", buildJsonObject { })
    }

    private val json = Json { ignoreUnknownKeys = true }

    /** 连接指定服务器并调 tools/list（阻塞直至完成或超时，调用方须在后台线程）*/
    fun listTools(server: McpConfigReader.McpServerInfo, workspacePath: String, timeoutMs: Long = 45_000L): List<McpToolInfo> {
        val deadline = System.currentTimeMillis() + timeoutMs
        return if (server.transport == "stdio") listToolsStdio(server, workspacePath, deadline)
        else listToolsHttp(server, workspacePath, deadline)
    }

    // ============ stdio ============

    private fun listToolsStdio(server: McpConfigReader.McpServerInfo, workspacePath: String, deadline: Long): List<McpToolInfo> {
        val (command, args, env) = McpConfigReader.resolvedStdioLaunch(server, workspacePath)
            ?: throw McpClientException("stdio 服务器缺少 command 配置")

        fun newBuilder(cmd: List<String>) = ProcessBuilder(cmd).apply {
            environment().putAll(env)
            McpConfigReader.resolvedCwd(server, workspacePath)?.let { directory(java.io.File(it)) }
        }

        val process = try {
            newBuilder(listOf(command) + args).start()
        } catch (e: IOException) {
            // Windows 下 npx/uvx 等无扩展名命令实为 .cmd 脚本，CreateProcess 找不到
            // → cmd /c 让 shell 按 PATHEXT 解析（其他平台的启动失败同样如实抛出）
            if (System.getProperty("os.name", "").lowercase().contains("win")) {
                try {
                    newBuilder(listOf("cmd.exe", "/c", command) + args).start()
                } catch (e2: IOException) {
                    throw McpClientException("无法启动 ${command}：${e.message}")
                }
            } else throw McpClientException("无法启动 ${command}：${e.message}")
        }

        try {
            val responses = ConcurrentHashMap<Int, CompletableFuture<JsonObject>>()
            // stdout 读线程：逐行解析 JSON-RPC，按 id 唤醒等待方；通知（无 id）丢弃。
            // stdout 关闭（进程退出）时唤醒所有等待方快速失败，避免傻等满超时
            // （Windows cmd /c 包装下命令不存在即此场景：cmd 起来后立刻退出）。
            thread(isDaemon = true, name = "mcp-tools-stdout") {
                runCatching {
                    BufferedReader(InputStreamReader(process.inputStream, StandardCharsets.UTF_8)).use { r ->
                        while (true) {
                            val line = r.readLine() ?: break
                            if (line.isBlank()) continue
                            val obj = runCatching { json.parseToJsonElement(line).jsonObject }.getOrNull() ?: continue
                            val id = runCatching { obj["id"]?.jsonPrimitive?.content?.toInt() }.getOrNull() ?: continue
                            responses[id]?.complete(obj)
                        }
                    }
                }
                responses.values.forEach {
                    it.completeExceptionally(McpClientException("服务器进程已退出，未收到 JSON-RPC 响应"))
                }
            }
            // stderr drain（防管道满；内容留给 CLI 日志，这里不透出）
            thread(isDaemon = true, name = "mcp-tools-stderr") {
                runCatching {
                    BufferedReader(InputStreamReader(process.errorStream, StandardCharsets.UTF_8)).use { r ->
                        while (r.readLine() != null) { /* drain */ }
                    }
                }
            }

            fun remaining() = (deadline - System.currentTimeMillis()).coerceAtLeast(0)

            /** 原始请求（error 响应原样返回不抛，协议协商判断用） */
            fun requestRaw(id: Int, method: String, params: JsonObject? = null): JsonObject {
                val fut = responses.getOrPut(id) { CompletableFuture() }
                val req = buildJsonObject {
                    put("jsonrpc", "2.0")
                    put("id", id)
                    put("method", method)
                    params?.let { put("params", it) }
                }
                process.outputStream.write((req.toString() + "\n").toByteArray(StandardCharsets.UTF_8))
                process.outputStream.flush()
                return fut.get(remaining(), java.util.concurrent.TimeUnit.MILLISECONDS)
            }

            fun request(id: Int, method: String, params: JsonObject? = null): JsonObject {
                val resp = requestRaw(id, method, params)
                resp["error"]?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull?.let { throw McpClientException("$method 失败: $it") }
                return resp
            }

            fun notifyInitialized() {
                val req = buildJsonObject {
                    put("jsonrpc", "2.0")
                    put("method", "notifications/initialized")
                }
                process.outputStream.write((req.toString() + "\n").toByteArray(StandardCharsets.UTF_8))
                process.outputStream.flush()
            }

            // 标准 initialize 优先（第三方 server 零开销）；宿主内置 modern server
            // （node_repl 等）不认旧版本号 → 回 Unsupported protocol version 且
            // data.supported 含 2026-07-28 → 切 modern 信封流程（无需任何握手，
            // tools/list 直接带 _meta 即可——实测 discover/initialize 均非必需）
            val initResp = requestRaw(1, "initialize", buildJsonObject {
                put("protocolVersion", PROTOCOL_VERSION)
                put("capabilities", buildJsonObject { })
                put("clientInfo", buildJsonObject {
                    put("name", CLIENT_NAME)
                    put("version", CLIENT_VERSION)
                })
            })
            if (isModernRejection(initResp)) {
                val toolsResp = request(2, "tools/list", buildJsonObject { put("_meta", modernMeta()) })
                return parseTools(toolsResp["result"]?.jsonObject)
            }
            initResp["error"]?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull?.let {
                throw McpClientException("initialize 失败: $it")
            }
            notifyInitialized()
            val toolsResp = request(3, "tools/list", buildJsonObject { })
            return parseTools(toolsResp["result"]?.jsonObject)
        } catch (e: McpClientException) {
            throw e
        } catch (e: java.util.concurrent.ExecutionException) {
            // completeExceptionally 的 cause 被包一层，解开保留原始可读信息
            throw e.cause as? McpClientException ?: McpClientException("连接失败：${e.cause?.message}")
        } catch (e: java.util.concurrent.TimeoutException) {
            throw McpClientException("连接超时（服务器未在期限内响应 JSON-RPC）")
        } catch (e: Exception) {
            val exit = runCatching { process.exitValue() }.getOrNull()
            throw McpClientException("连接失败：${e.message}" + (exit?.let { "（进程已退出 code=$it）" } ?: ""))
        } finally {
            process.destroy()
            runCatching {
                if (!process.waitFor(2, java.util.concurrent.TimeUnit.SECONDS)) process.destroyForcibly()
            }
        }
    }

    // ============ http / sse（按 Streamable HTTP 尝试）============

    private fun listToolsHttp(server: McpConfigReader.McpServerInfo, workspacePath: String, deadline: Long): List<McpToolInfo> {
        val (url, headers) = McpConfigReader.resolvedHttpTarget(server, workspacePath)
            ?: throw McpClientException("远程服务器缺少 url 配置")
        val client = HttpClient.newBuilder()
            .connectTimeout(Duration.ofMillis((deadline - System.currentTimeMillis()).coerceAtLeast(1)))
            .build()
        var sessionId: String? = null

        fun post(body: JsonObject, expectResponse: Boolean): JsonObject? {
            val b = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofMillis((deadline - System.currentTimeMillis()).coerceAtLeast(1)))
                .header("Content-Type", "application/json")
                .header("Accept", "application/json, text/event-stream")
            headers.forEach { (k, v) -> b.header(k, v) }
            sessionId?.let { b.header("Mcp-Session-Id", it) }
            val resp = client.send(b.POST(HttpRequest.BodyPublishers.ofString(body.toString())).build(), HttpResponse.BodyHandlers.ofString())
            if (resp.statusCode() >= 400) {
                throw McpClientException("HTTP ${resp.statusCode()}：${resp.body().take(200)}")
            }
            sessionId = resp.headers().firstValue("mcp-session-id").orElse(sessionId)
            if (!expectResponse) return null
            val contentType = resp.headers().firstValue("content-type").orElse("")
            val text = if (contentType.contains("text/event-stream")) {
                // SSE 响应：取 data: 行拼接为单条 JSON
                resp.body().lineSequence().filter { it.startsWith("data:") }
                    .joinToString("") { it.removePrefix("data:").trim() }
            } else resp.body().trim()
            if (text.isBlank()) throw McpClientException("响应体为空（Content-Type: $contentType）")
            return runCatching { json.parseToJsonElement(text).jsonObject }
                .getOrElse { throw McpClientException("响应不是合法 JSON-RPC：${text.take(200)}") }
        }

        val init = post(buildJsonObject {
            put("jsonrpc", "2.0")
            put("id", 1)
            put("method", "initialize")
            put("params", buildJsonObject {
                put("protocolVersion", PROTOCOL_VERSION)
                put("capabilities", buildJsonObject { })
                put("clientInfo", buildJsonObject {
                    put("name", CLIENT_NAME)
                    put("version", CLIENT_VERSION)
                })
            })
        }, expectResponse = true)
        init?.get("error")?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull?.let {
            throw McpClientException("initialize 失败: $it")
        }
        post(buildJsonObject {
            put("jsonrpc", "2.0")
            put("method", "notifications/initialized")
        }, expectResponse = false)
        val toolsResp = post(buildJsonObject {
            put("jsonrpc", "2.0")
            put("id", 2)
            put("method", "tools/list")
            put("params", buildJsonObject { })
        }, expectResponse = true) ?: throw McpClientException("tools/list 无响应")
        toolsResp["error"]?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull?.let {
            throw McpClientException("tools/list 失败: $it")
        }
        return parseTools(toolsResp["result"]?.jsonObject)
    }

    /** initialize 响应是否为「仅支持 modern era」拒绝（error.data.supported 含 modern 版本） */
    private fun isModernRejection(resp: kotlinx.serialization.json.JsonElement?): Boolean {
        val err = resp?.let { runCatching { it.jsonObject["error"]?.jsonObject }.getOrNull() } ?: return false
        val supported = runCatching {
            err["data"]?.jsonObject?.get("supported")?.jsonArray
                ?.mapNotNull { e -> runCatching { e.jsonPrimitive.content }.getOrNull() }
        }.getOrNull() ?: return false
        return MODERN_PROTOCOL_VERSION in supported
    }

    // ============ 公共解析 ============

    /** tools/list 的 result.tools → [{name, description}] */
    private fun parseTools(result: JsonObject?): List<McpToolInfo> {
        val tools = result?.get("tools")?.let { runCatching { it.jsonArray }.getOrNull() } ?: return emptyList()
        return tools.mapNotNull { el ->
            val obj = runCatching { el.jsonObject }.getOrNull() ?: return@mapNotNull null
            val name = runCatching { obj["name"]?.jsonPrimitive?.content }.getOrNull() ?: return@mapNotNull null
            // contentOrNull 已可空，runCatching.getOrNull 再包一层 → 先提变量剥掉双重可空
            val descRaw = runCatching { obj["description"]?.jsonPrimitive?.contentOrNull }.getOrNull()
            val desc = descRaw
                ?.takeIf { it.isNotBlank() }
                ?.let { if (it.length > DESC_MAX_LEN) it.take(DESC_MAX_LEN) + "…" else it }
            McpToolInfo(name, desc)
        }
    }
}
