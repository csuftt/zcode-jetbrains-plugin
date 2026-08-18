package com.zcode.ideaplugin.ui

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.File
import java.nio.file.Files

/**
 * MCP 服务器磁盘配置读取器（设置页「MCP 列表」数据源之一）
 *
 * 三来源合并（先到先得，全局优先）：
 *   user    ~/.zcode/cli/config.json 的 mcp.servers 节点（标准配置位置，已实验验证）
 *   project 项目根 zcode.json / .zcode/config.json 的 mcp.servers（CLI 项目配置发现路径）
 *   plugin  ~/.zcode/cli/plugins 下各插件根的 .mcp.json（标准 MCP 格式 mcpServers）
 *
 * 连接状态/toolCount 不在配置里 —— 由 handleListMcpServers 调 RPC mcp/list 按名合并。
 */
object McpConfigReader {

    data class McpServerInfo(
        val name: String,
        /** user=全局 | project=项目 | plugin=插件贡献 | host=CLI 内置插件宿主 MCP | runtime=会话运行时注入 */
        val scope: String,
        /** stdio | http | sse（按配置推断：有 url→type，否则 stdio）*/
        val transport: String,
        val command: String?,
        val args: List<String>,
        val url: String?,
        /** env 变量名（值不透出前端，仅展示键）*/
        val envKeys: List<String>,
        /** 原样 env（占位符未替换，转协议参数用）*/
        val envValues: Map<String, String>,
        /** http headers 原样（占位符未替换，转协议参数用）*/
        val headerValues: Map<String, String>,
        /** config enabled 字段（false 时 RPC 状态为 disabled；缺省 true）*/
        val enabled: Boolean,
        /** 来源配置文件绝对路径（「打开配置文件」跳转用）*/
        val configPath: String,
        val pluginName: String?,
        /** 配置的 cwd（占位符原样，stdio 进程工作目录用）*/
        val cwd: String? = null,
        // ---- 以下由 RPC mcp/list 状态合并填充（拿不到为 null）----
        /** connecting|connected|disabled|disconnected|failed|untrusted */
        val status: String?,
        val toolCount: Int?,
        val statusError: String?,
        val updatedAt: String?,
    )

    private const val PLUGIN_WALK_DEPTH = 8
    private val VERSION_LIKE = Regex("^v?\\d+(\\.\\d+)*.*$")

    /** 读取三来源全部服务器配置（同名先到先得：user > project > plugin） */
    fun scan(projectBasePath: String?): List<McpServerInfo> {
        val home = System.getProperty("user.home") ?: return emptyList()
        val result = LinkedHashMap<String, McpServerInfo>()

        // 1. 全局
        val globalConfig = File(home, ".zcode/cli/config.json")
        parseConfigServers(globalConfig, "mcp", "servers", scope = "user", pluginName = null, out = result)

        // 2. 项目级（CLI 发现路径：zcode.json 与 .zcode/config.json）
        if (!projectBasePath.isNullOrBlank()) {
            val base = File(projectBasePath)
            parseConfigServers(File(base, "zcode.json"), "mcp", "servers", scope = "project", pluginName = null, out = result)
            parseConfigServers(File(base, ".zcode/config.json"), "mcp", "servers", scope = "project", pluginName = null, out = result)
        }

        // 3. 插件贡献（.mcp.json 标准格式）
        scanPluginMcpJson(File(home, ".zcode/cli/plugins"), result)

        return result.values.toList()
    }

    /** 解析 config 形态文件：servers 节点路径形如 mcp.servers（嵌套键） */
    private fun parseConfigServers(
        file: File,
        vararg nodePath: String,
        scope: String,
        pluginName: String?,
        out: MutableMap<String, McpServerInfo>,
    ) {
        val root = readJson(file) ?: return
        var node: kotlinx.serialization.json.JsonElement? = root
        for (key in nodePath) {
            node = node?.let { runCatching { it.jsonObject[key] }.getOrNull() } ?: return
        }
        val servers = runCatching { node?.jsonObject }.getOrNull() ?: return
        servers.forEach { (name, cfg) ->
            if (name in out) return@forEach
            val info = parseServerEntry(name, cfg, scope, pluginName, file.absolutePath) ?: return@forEach
            out[name] = info
        }
    }

    /** 解析插件 .mcp.json（顶层 mcpServers；只认 cache/ 已安装插件，marketplaces/ 是市场索引清单不算已配置） */
    private fun scanPluginMcpJson(root: File, out: MutableMap<String, McpServerInfo>) {
        if (!root.isDirectory) return
        try {
            Files.walk(root.toPath(), PLUGIN_WALK_DEPTH).use { stream ->
                stream.forEach { path ->
                    if (path.fileName?.toString() != ".mcp.json") return@forEach
                    val rel = root.toPath().relativize(path).toString().replace('\\', '/')
                    if (rel.startsWith("marketplaces/")) return@forEach // 市场索引≠已安装
                    val file = path.toFile()
                    val json = readJson(file) ?: return@forEach
                    val servers = runCatching { json["mcpServers"]?.jsonObject }.getOrNull() ?: return@forEach
                    val pluginName = pluginNameFromPath(rel)
                    servers.forEach { (name, cfg) ->
                        if (name in out) return@forEach
                        val info = parseServerEntry(name, cfg, "plugin", pluginName, file.absolutePath) ?: return@forEach
                        out[name] = info
                    }
                }
            }
        } catch (_: Exception) {
            // 插件目录结构异常不阻塞整体
        }
    }

    /** 单服务器条目 → McpServerInfo（结构非法跳过） */
    private fun parseServerEntry(
        name: String,
        element: kotlinx.serialization.json.JsonElement,
        scope: String,
        pluginName: String?,
        configPath: String,
    ): McpServerInfo? {
        val cfg = runCatching { element.jsonObject }.getOrNull() ?: return null
        val command = str(cfg["command"])
        val url = str(cfg["url"])
        if (command == null && url == null) return null

        val type = str(cfg["type"])
        val transport = when {
            url != null -> if (type == "sse") "sse" else "http"
            else -> "stdio"
        }
        val args = runCatching {
            cfg["args"]?.jsonArray?.mapNotNull { str(it.jsonPrimitive) } ?: emptyList()
        }.getOrDefault(emptyList())
        val envValues = parseStringMap(cfg["env"])
        val headerValues = parseStringMap(cfg["headers"])
        val cwd = str(cfg["cwd"])
        val enabled = runCatching { cfg["enabled"]?.jsonPrimitive?.boolean }.getOrNull() ?: true

        return McpServerInfo(
            name = name,
            scope = scope,
            transport = transport,
            command = command,
            args = args,
            url = url,
            envKeys = envValues.keys.toList(),
            envValues = envValues,
            headerValues = headerValues,
            enabled = enabled,
            configPath = configPath,
            pluginName = pluginName,
            cwd = cwd,
            status = null,
            toolCount = null,
            statusError = null,
            updatedAt = null,
        )
    }

    /** env/headers 兼容两种形态：{K:V} 对象（.mcp.json/用户 config）或 [{name,value}] 数组（协议请求格式） */
    private fun parseStringMap(element: kotlinx.serialization.json.JsonElement?): Map<String, String> {
        if (element == null) return emptyMap()
        runCatching {
            return element.jsonObject.entries.associate { (k, v) -> k to (str(v) ?: "") }
        }
        runCatching {
            return element.jsonArray.mapNotNull { e ->
                runCatching { str(e.jsonObject["name"]) }.getOrNull()?.let { key ->
                    key to (runCatching { str(e.jsonObject["value"]) }.getOrNull() ?: "")
                }
            }.toMap()
        }
        return emptyMap()
    }

    // ============ 协议参数转换（mcp/list 显式传参） ============

    private val USER_CONFIG_PLACEHOLDER = Regex("\\$\\{user_config\\.[^}]*}")

    /**
     * 占位符替换（toProtocolParam 与 McpToolsClient 进程启动共用）：
     * ${CLAUDE_PLUGIN_ROOT}→.mcp.json 所在目录、${CLAUDE_PROJECT_DIR}→项目根、
     * ${CLAUDE_PLUGIN_DATA}→插件数据目录、${user_config.*}→空串（未配置）。
     */
    private fun substitute(s: McpServerInfo, workspacePath: String, v: String): String {
        val pluginRoot = File(s.configPath).parentFile?.absolutePath ?: ""
        return v
            .replace("\${CLAUDE_PLUGIN_ROOT}", pluginRoot)
            .replace("\${CLAUDE_PROJECT_DIR}", workspacePath)
            .replace("\${CLAUDE_PLUGIN_DATA}", pluginDataDir(s))
            .replace(USER_CONFIG_PLACEHOLDER, "")
    }

    /**
     * stdio 服务器占位符替换后的启动参数（McpToolsClient 起进程用；
     * command 缺失返回 null）。Windows 的 .cmd 解析兼容在 McpToolsClient 处理。
     */
    fun resolvedStdioLaunch(s: McpServerInfo, workspacePath: String): Triple<String, List<String>, Map<String, String>>? {
        val command = s.command ?: return null
        fun sub(v: String) = substitute(s, workspacePath, v)
        return Triple(
            sub(command),
            s.args.map { sub(it) },
            s.envValues.entries.associate { (k, v) -> k to sub(v) },
        )
    }

    /** http/sse 服务器替换后的 url 与 headers（McpToolsClient 请求用；url 缺失返回 null） */
    fun resolvedHttpTarget(s: McpServerInfo, workspacePath: String): Pair<String, Map<String, String>>? {
        val url = s.url ?: return null
        fun sub(v: String) = substitute(s, workspacePath, v)
        return sub(url) to s.headerValues.entries.associate { (k, v) -> k to sub(v) }
    }

    /** stdio 进程工作目录（配置 cwd 替换后；缺省 null=继承当前进程） */
    fun resolvedCwd(s: McpServerInfo, workspacePath: String): String? =
        s.cwd?.let { substitute(s, workspacePath, it) }

    /**
     * 服务器配置 → mcp/list 的 mcpServers 请求条目（zod strict schema：
     * stdio={name,command,args,env,...} / http={name,type,url,headers,...}，
     * args/env/headers 必填；cwd 等多余字段会被拒需丢弃）。
     * 占位符替换规则见 [substitute]；enabled=false、host 宿主条目或结构不完整
     * （stdio 缺 command / 远程缺 url）返回 null。host 条目（browser-use 的
     * node_repl 等）由 CLI 会话自动拉起，显式传参只会多起一个重复进程。
     */
    fun toProtocolParam(s: McpServerInfo, workspacePath: String): kotlinx.serialization.json.JsonObject? {
        if (!s.enabled) return null
        if (s.scope == "host") return null
        fun sub(v: String) = substitute(s, workspacePath, v)

        return if (s.transport == "stdio") {
            val command = s.command ?: return null
            kotlinx.serialization.json.buildJsonObject {
                put("name", s.name)
                put("command", sub(command))
                put("args", kotlinx.serialization.json.JsonArray(s.args.map { kotlinx.serialization.json.JsonPrimitive(sub(it)) }))
                put("env", kotlinx.serialization.json.JsonArray(s.envValues.entries.map { (k, v) ->
                    kotlinx.serialization.json.buildJsonObject {
                        put("name", k)
                        put("value", sub(v))
                    }
                }))
            }
        } else {
            val url = s.url ?: return null
            kotlinx.serialization.json.buildJsonObject {
                put("name", s.name)
                put("type", if (s.transport == "sse") "sse" else "http")
                put("url", sub(url))
                put("headers", kotlinx.serialization.json.JsonArray(s.headerValues.entries.map { (k, v) ->
                    kotlinx.serialization.json.buildJsonObject {
                        put("name", k)
                        put("value", sub(v))
                    }
                }))
            }
        }
    }

    /** ${CLAUDE_PLUGIN_DATA} 的目标（~/.zcode/cli/plugins/data/<plugin>；推断失败回退插件根） */
    private fun pluginDataDir(s: McpServerInfo): String {
        val home = System.getProperty("user.home") ?: return ""
        val plugin = s.pluginName ?: return ""
        return File(File(home, ".zcode/cli/plugins/data"), plugin).absolutePath
    }

    /** rel 形如 cache/marketplace/<plugin>/<version>/.mcp.json → 取版本段上一层 */
    private fun pluginNameFromPath(rel: String): String? {
        val parts = rel.split('/')
        val dirParts = parts.dropLast(1) // 去掉 .mcp.json
        val last = dirParts.lastOrNull() ?: return null
        return if (dirParts.size >= 2 && VERSION_LIKE.matches(last)) dirParts[dirParts.size - 2] else last
    }

    private fun str(e: kotlinx.serialization.json.JsonElement?): String? =
        e?.let { runCatching { it.jsonPrimitive.content }.getOrNull() }?.takeIf { it.isNotBlank() }

    private fun readJson(file: File): JsonObject? = runCatching {
        if (!file.isFile) null
        else Json.parseToJsonElement(file.readText(Charsets.UTF_8)).jsonObject
    }.getOrNull()
}
