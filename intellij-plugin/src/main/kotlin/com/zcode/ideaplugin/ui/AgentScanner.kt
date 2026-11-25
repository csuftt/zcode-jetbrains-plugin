package com.zcode.ideaplugin.ui

import com.zcode.ideaplugin.protocol.Credentials
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.nio.channels.FileChannel
import java.nio.channels.OverlappingFileLockException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption

/**
 * 子智能体磁盘扫描器（设置页「子智能体」数据源，与 ZCode 客户端数据打通）
 *
 * 对齐 zcode.cjs 的 agent 发现语义（Itn 函数 + 官方文档）：
 *   user    ~/.zcode/agents 目录下的 .md 文件（取法见 Credentials.storageRoot）
 *   project <项目根及 git 根>/.zcode/agents 目录下的 .md 文件
 *
 * 文件 = 带 frontmatter 的 Markdown，正文即系统提示词。字段（camelCase 大小写敏感，
 * 不认识的字段被 zcode.cjs 静默忽略）：
 *   name/description 必填（缺失时文件被忽略）；model（缺省/inherit=跟随主 Agent）、
 *   thoughtLevel、color、tools/disallowedTools（列表，留空=继承全部工具）、maxTurns、
 *   injectAgentsMd（默认 true）、mcpServers
 *
 * 禁用清单：~/.zcode/v2/agents-state.json 的 disabledAgentIds（读取时过滤）。
 *
 * 生效时机取决于运行时从哪拿子代理配置（两种来源的解析结果应当一致，运行时来源见
 * [SubagentRuntimeConfig]）：插件 spawn 的 app-server 认 subagentRuntimeConfigEnabled
 * 且宿主已挂供给器时，运行时在每次创建会话、以及**每个回合开始**向插件反向请求一次
 * 快照——改完定义/模型覆盖，下一回合即生效；否则走文件 fallback，只在创建会话时读
 * 一次、存量会话不热更。
 *
 * 内置子代理（general-purpose/Explore）不落 .md 文件，模型覆盖存在同文件
 * builtInModelSelectionOverrides（strict schema 仅认这两个名字，继承默认=删 key）。
 * 本类读写的正是这一份，与桌面端共用。单条覆盖必须带思考档位（options.reasoningLevel）：
 * 运行时对缺档位的条目直接拒绝派生子代理（reasoning-level-missing，2026-11-25 真机实锤），
 * 桌面端的写法是「用户选模型时连带落该模型档位集的末位（最高档）」。
 *
 * 与 ADR-0011（数据根重定向的生效边界）的关系，显式说明：主 app-server 不跟随
 * dataBaseDir、始终读 home，所以本类的用户级定义与状态文件也一律指向 home，不跟随
 * 重定向——这是对「v2 直读面跟随 dataBaseDir」的有意例外，判据是消费方是谁。未重定向
 * 时只有一份，桌面端配置的模型插件直接继承，插件写入桌面端同样继承；配置了 dataBaseDir
 * 时桌面端读写的是重定向副本，两端的子代理配置各用一份、互不可见。
 */
object AgentScanner {

    data class AgentDef(
        val name: String,
        val description: String,
        /** null 或 "inherit" = 跟随主 Agent 当前模型 */
        val model: String?,
        val thoughtLevel: String?,
        /** 预设色（zcode.cjs 实测枚举），仅身份标识 */
        val color: String?,
        /** 空 = 继承主会话全部工具（含 MCP）；非空 = 仅列表内工具 */
        val tools: List<String>,
        val disallowedTools: List<String>,
        val maxTurns: Int?,
        val injectAgentsMd: Boolean,
        val mcpServers: List<String>,
        /** Markdown 正文 = 系统提示词 */
        val systemPrompt: String,
        /** .md 绝对路径 */
        val path: String,
        /** user | project */
        val scope: String,
    )

    /** ZCode 支持的颜色标记（zcode.cjs 实测枚举） */
    val COLORS = listOf("blue", "green", "red", "orange", "yellow", "purple", "pink", "cyan")

    /** name 校验（zcode.cjs 实测正则，与文件名一致） */
    val NAME_RE = Regex("^[a-z0-9][a-z0-9._-]{0,127}$")

    /** 设置页「可用工具」勾选项 = CLI 内置工具（勾选自定义后 MCP 工具不可用，文档语义） */
    val BUILTIN_TOOLS = listOf(
        "Read", "Grep", "Glob", "Bash", "Edit", "Write", "WebFetch", "WebSearch", "TodoWrite"
    )

    private val json = Json { ignoreUnknownKeys = true }
    private val LOCK = Any()

    /** 扫描全部作用域，返回列表（user 在前 project 在后，各自按名排序） */
    fun scan(projectBasePath: String?): List<AgentDef> {
        val disabled = disabledAgentIds()
        val out = ArrayList<AgentDef>()
        scanAgentDir(File(Credentials.storageRoot().toFile(), "agents"), "user", disabled, out)
        if (!projectBasePath.isNullOrBlank()) {
            val roots = linkedSetOf(File(projectBasePath))
            findGitRoot(projectBasePath)?.let { roots.add(it) }
            roots.forEach { base ->
                scanAgentDir(File(base, ".zcode/agents"), "project", disabled, out)
            }
        }
        // 同名时项目级覆盖用户级（对齐 zcode.cjs 后读覆盖先读的合并语义），展示层不再去重
        return out.distinctBy { "${it.scope}/${it.name}" }
    }

    /**
     * 保存（新建/更新/改名）。name 变更 = 写新文件 + 删旧文件。
     * @param originalName 编辑前名称（null = 新建）；与 name 相同 = 原地更新
     * @return 成功与否（IO 异常/目录不可写返回 false）
     */
    fun save(scope: String, def: AgentDef, originalName: String?, projectBasePath: String? = null): Boolean = synchronized(LOCK) {
        val dir = scopeDir(scope, projectBasePath) ?: return false
        if (!dir.exists() && !dir.mkdirs()) return false
        val target = File(dir, "${def.name}.md")
        try {
            atomicWrite(target, renderMarkdown(def))
            // 改名清理旧文件（先写新成功再删旧，失败留旧文件不影响新定义生效）
            if (originalName != null && originalName != def.name) {
                val old = File(dir, "$originalName.md")
                if (old.exists()) old.delete()
            }
            true
        } catch (e: Exception) {
            false
        }
    }

    /** 删除定义文件 */
    fun delete(scope: String, name: String, projectBasePath: String? = null): Boolean = synchronized(LOCK) {
        val dir = scopeDir(scope, projectBasePath) ?: return false
        val f = File(dir, "$name.md")
        f.exists() && f.delete()
    }

    /** 作用域目录（project 依赖项目路径，由调用方保证 basePath 非空） */
    private fun scopeDir(scope: String, projectBasePath: String? = null): File? = when (scope) {
        "user" -> File(Credentials.storageRoot().toFile(), "agents")
        "project" -> projectBasePath?.let { File(it, ".zcode/agents") }
        else -> null
    }

    private fun scanAgentDir(dir: File, scope: String, disabled: Set<String>, out: MutableList<AgentDef>) {
        val files = dir.listFiles { f -> f.isFile && f.name.endsWith(".md") } ?: return
        files.sortedBy { it.name.lowercase() }.forEach { f ->
            val def = parseAgentFile(f, scope) ?: return@forEach
            if (def.name in disabled) return@forEach
            out.add(def)
        }
    }

    /** 解析单个定义文件（frontmatter 缺 name/description 时整个忽略，对齐 zcode.cjs 语义） */
    private fun parseAgentFile(f: File, scope: String): AgentDef? {
        return try {
            val text = f.readText()
            val (fm, body) = splitFrontmatter(text)
            val name = fm["name"]?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            val description = fm["description"]?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            AgentDef(
                name = name,
                description = description,
                model = fm["model"]?.trim()?.takeIf { it.isNotEmpty() && it != "inherit" },
                thoughtLevel = fm["thoughtlevel"]?.trim()?.takeIf { it.isNotEmpty() },
                color = fm["color"]?.trim()?.takeIf { it.isNotEmpty() },
                tools = fm.list("tools"),
                disallowedTools = fm.list("disallowedtools"),
                maxTurns = fm["maxturns"]?.trim()?.toIntOrNull(),
                injectAgentsMd = fm["injectagentsmd"]?.trim()?.lowercase() != "false",
                mcpServers = fm.list("mcpservers"),
                systemPrompt = body.trim(),
                path = f.absolutePath,
                scope = scope,
            )
        } catch (e: Exception) {
            null
        }
    }

    /**
     * frontmatter 解析（比 SlashCommandScanner.parseFrontmatter 多支持 YAML 块列表）：
     *   tools:            → key 无值，后续缩进 "- item" 行聚合成列表
     *     - Read
     *     - Bash
     */
    private class FmMap(private val scalars: Map<String, String>, private val lists: Map<String, List<String>>) {
        operator fun get(key: String): String? = scalars[key]
        fun list(key: String): List<String> = lists[key] ?: emptyList()
    }

    private fun splitFrontmatter(text: String): Pair<FmMap, String> {
        val m = Regex("^---\\r?\\n(.*?)\\r?\\n---\\r?\\n?(.*)$", RegexOption.DOT_MATCHES_ALL).find(text)
            ?: return FmMap(emptyMap(), emptyMap()) to text
        val scalars = LinkedHashMap<String, String>()
        val lists = LinkedHashMap<String, List<String>>()
        var pendingListKey: String? = null
        val pending = ArrayList<String>()
        for (line in m.groupValues[1].lineSequence()) {
            val indent = line.takeWhile { it == ' ' }.length
            val trimmed = line.trim()
            if (trimmed.isEmpty()) continue
            if (indent > 0 && trimmed.startsWith("- ") && pendingListKey != null) {
                pending.add(trimmed.removePrefix("- ").trim().removeSurrounding("\""))
                continue
            }
            pendingListKey?.let { lists[it] = pending.toList() }
            pendingListKey = null; pending.clear()
            val idx = trimmed.indexOf(':')
            if (idx <= 0) continue
            val key = trimmed.substring(0, idx).trim().lowercase()
            var value = trimmed.substring(idx + 1).trim()
            if (value.length >= 2 && value.first() == value.last() && (value.first() == '"' || value.first() == '\'')) {
                value = value.substring(1, value.length - 1)
            }
            if (key in scalars) continue // 首值生效
            if (value.isEmpty()) {
                pendingListKey = key // 可能是块列表的 key（也可能就是空值，收尾时存空列表）
            } else if (value.startsWith("[") && value.endsWith("]")) {
                lists[key] = value.removeSurrounding("[", "]").split(",").map { it.trim().removeSurrounding("\"") }.filter { it.isNotEmpty() }
            } else {
                scalars[key] = value
            }
        }
        pendingListKey?.let { lists[it] = pending.toList() }
        return FmMap(scalars, lists) to m.groupValues[2]
    }

    /** 序列化为 ZCode 兼容的 frontmatter + 正文 */
    private fun renderMarkdown(def: AgentDef): String {
        val sb = StringBuilder("---\n")
        sb.append("name: \"").append(escapeYaml(def.name)).append("\"\n")
        sb.append("description: \"").append(escapeYaml(def.description)).append("\"\n")
        def.color?.let { sb.append("color: \"").append(it).append("\"\n") }
        def.model?.let { sb.append("model: \"").append(it).append("\"\n") }
        def.thoughtLevel?.let { sb.append("thoughtLevel: \"").append(it).append("\"\n") }
        if (def.tools.isNotEmpty()) {
            sb.append("tools:\n")
            def.tools.forEach { sb.append("  - \"").append(it).append("\"\n") }
        }
        if (def.disallowedTools.isNotEmpty()) {
            sb.append("disallowedTools:\n")
            def.disallowedTools.forEach { sb.append("  - \"").append(it).append("\"\n") }
        }
        if (def.mcpServers.isNotEmpty()) {
            sb.append("mcpServers:\n")
            def.mcpServers.forEach { sb.append("  - \"").append(it).append("\"\n") }
        }
        def.maxTurns?.let { sb.append("maxTurns: ").append(it).append("\n") }
        sb.append("injectAgentsMd: ").append(def.injectAgentsMd).append("\n")
        sb.append("---\n\n")
        sb.append(def.systemPrompt.trimEnd()).append("\n")
        return sb.toString()
    }

    private fun escapeYaml(s: String) = s.replace("\\", "\\\\").replace("\"", "\\\"")

    private fun atomicWrite(target: File, content: String) {
        val tmp = File(target.parentFile, target.name + ".tmp")
        tmp.writeText(content)
        Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
    }

    /** agents-state.json 的 disabledAgentIds（文件缺失/损坏按空处理） */
    private fun disabledAgentIds(): Set<String> =
        (readAgentsStateRoot()?.get("disabledAgentIds") as? JsonArray)
            ?.mapNotNull { (it as? JsonPrimitive)?.content }
            ?.toSet()
            ?: emptySet()

    private fun agentsStateFile() = File(Credentials.storageRoot().toFile(), "v2/agents-state.json")

    /** agents-state.json 根对象；文件缺失或无法解析返回 null（官方读侧同语义：按空状态处理） */
    private fun readAgentsStateRoot(): JsonObject? = try {
        val f = agentsStateFile()
        if (f.isFile) json.parseToJsonElement(f.readText()).jsonObject else null
    } catch (e: Exception) {
        null
    }

    // ============ 内置子代理模型覆盖（与 ZCode 客户端共用 agents-state.json） ============

    /**
     * 内置子代理清单，照抄官方运行时的硬编码定义：general-purpose 全部工具，Explore 为
     * 工具白名单（且不注入 AGENTS.md）。描述取桌面端「子智能体」页的展示文案，不翻译。
     * name 大小写精确（Explore 的 E 大写），即 agents-state.json 里的 key。
     */
    data class BuiltinAgentDef(
        val name: String,
        val description: String,
        val color: String,
        /** 空 = 全部工具（tools:["*"]） */
        val tools: List<String>,
    )

    /** builtInModelSelectionOverrides 认可的 key 全集（官方 strict schema）；顺序即落盘顺序 */
    private val BUILTIN_OVERRIDE_KEYS = listOf("Explore", "general-purpose")

    val BUILTIN_AGENTS = listOf(
        BuiltinAgentDef(
            name = "general-purpose",
            description = "General-purpose agent for researching complex questions, searching for code, " +
                "and executing multi-step tasks.",
            color = "blue",
            tools = emptyList(),
        ),
        BuiltinAgentDef(
            name = "Explore",
            description = "Read-only search agent for broad fan-out searches.",
            color = "cyan",
            tools = listOf("Bash", "Glob", "Grep", "Read", "WebFetch", "WebSearch", "TodoWrite"),
        ),
    )

    /**
     * 内置子代理的模型覆盖，即 builtInModelSelectionOverrides 的单条 value
     * （providerId 与 session/setModel 同一命名空间）。
     *
     * @param reasoningLevel 思考档位（官方 options.reasoningLevel）。派生子代理时必填，
     *   见类注释；展示用读取允许为 null（存量/外部写入的不完整条目，照实显示）
     */
    data class BuiltinModelSelection(val providerId: String, val modelId: String, val reasoningLevel: String? = null) {

        fun toJson(): JsonObject = SubagentMarkdown.modelSelectionJson(providerId, modelId, reasoningLevel)

        companion object {
            /** 从单条 value 读回；providerId/modelId 缺失、非字符串或空白返回 null */
            fun fromJson(obj: JsonObject): BuiltinModelSelection? {
                val providerId = nonBlankString(obj, "providerId") ?: return null
                val modelId = nonBlankString(obj, "modelId") ?: return null
                return BuiltinModelSelection(
                    providerId,
                    modelId,
                    (obj["options"] as? JsonObject)?.let { nonBlankString(it, "reasoningLevel") },
                )
            }

            /**
             * 前端 setBuiltInAgentModel 请求里的 selection 元素：缺省或 null = 继承默认
             * （success(null)）；形状不对 = failure，消息可直接回给前端。
             * 显式 null 解析出来是 JsonNull，`?.jsonObject` 对它直接抛，必须先判。
             */
            fun fromRequest(el: JsonElement?): Result<BuiltinModelSelection?> {
                if (el == null || el is JsonNull) return Result.success(null)
                val obj = el as? JsonObject
                    ?: return Result.failure(IllegalArgumentException("selection 须为对象"))
                return fromJson(obj)?.let { Result.success(it) }
                    ?: Result.failure(IllegalArgumentException("selection 须含非空的 providerId 与 modelId"))
            }

            private fun nonBlankString(obj: JsonObject, key: String): String? =
                (obj[key] as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim()?.takeIf { it.isNotEmpty() }
        }
    }

    /**
     * 读内置子代理的模型覆盖（key=子代理名）。只认 [BUILTIN_OVERRIDE_KEYS] 里的名字，
     * 其余 key 与不合规的条目一律忽略——判据即官方 modelSelectionSchema（strict：多余键、
     * 档位非字符串等都整条丢弃，与桌面端 normalizeBuiltInSelectionOverrides 同规则）；
     * 文件缺失/损坏按空处理。
     */
    fun builtinModelSelections(): Map<String, BuiltinModelSelection> {
        val structured = readAgentsStateRoot()?.get("builtInModelSelectionOverrides") as? JsonObject
            ?: return emptyMap()
        return BUILTIN_OVERRIDE_KEYS.mapNotNull { name ->
            SubagentRuntimeConfig.parseModelSelection(structured[name])
                ?.let(BuiltinModelSelection::fromJson)
                ?.let { name to it }
        }.toMap()
    }

    /**
     * 设置/清除内置子代理的模型覆盖（直写 agents-state.json，与 ZCode 客户端共用）。
     * selection=null = 恢复「继承默认」（删除 key，与桌面端写法一致，不写 null）；非 null
     * 则整个条目替换，旧模型条目里的 options 不跨模型继承。
     *
     * 请求带了模型但没带档位 = 用户选了新模型：由 [resolveReasoningLevel] 补上该模型的
     * 最高档再落盘（官方 completeNewModelSelection 同语义——落盘的选择必须带档位）。
     * 解析不出档位时不写入并返回错误，宁可让用户看见也不落一条派生必失败的覆盖。
     * 传 null = 不补（按请求原样写入，测试与「只改档位」路径用）。
     *
     * 文件其余内容原样保留（disabledAgentIds/pluginAgentModelSelectionOverrides/未知键及其
     * 键序）；文件不存在时写官方空状态骨架。覆盖节点按 [BUILTIN_OVERRIDE_KEYS] 的顺序落盘：
     * 官方运行时每次建会话会按这个固定顺序重建该节点、与文件内容不等就回写，顺序对齐后
     * 内容合规的文件不会再被运行时改写一遍。
     *
     * 并发：进程内 LOCK + 跨进程 .lock 文件锁串行插件的多个写方（多开 IDE），同
     * McpConfigWriter；桌面端自身与官方运行时的回写不走这把锁，读-改-写窗口内（毫秒级）
     * 的并发写仍会被后写者覆盖。文件损坏时拒绝写入：官方读侧把损坏文件当空状态，桌面端
     * 一改配置就会拿骨架覆盖它，这里保留手工恢复的机会。
     *
     * @return null=成功；非 null=错误消息
     */
    fun setBuiltInModelSelection(
        agentName: String,
        selection: BuiltinModelSelection?,
        resolveReasoningLevel: ((modelId: String) -> String?)? = null,
    ): String? =
        synchronized(LOCK) {
            if (agentName !in BUILTIN_OVERRIDE_KEYS) return "未知的内置子代理: $agentName"
            val f = agentsStateFile()
            try {
                // 父目录先建：FileChannel.open 只建文件不建父目录（首次写入场景 v2/ 尚不存在）
                f.parentFile?.let { Files.createDirectories(it.toPath()) }
                FileChannel.open(
                    f.toPath().resolveSibling(f.name + ".lock"),
                    StandardOpenOption.CREATE, StandardOpenOption.WRITE,
                ).use { ch ->
                    ch.lock()
                    updateAgentsState(f, agentName, selection, resolveReasoningLevel)
                }
            } catch (_: OverlappingFileLockException) {
                "文件锁冲突，放弃写入: ${f.name}"
            } catch (e: Exception) {
                "获取文件锁失败（放弃写入）: ${e.message}"
            }
        }

    /** 进程内锁与跨进程 .lock 均已持有时的读-改-写本体 */
    private fun updateAgentsState(
        f: File,
        agentName: String,
        selection: BuiltinModelSelection?,
        resolveReasoningLevel: ((modelId: String) -> String?)?,
    ): String? {
        if (selection != null && selection.reasoningLevel == null && resolveReasoningLevel != null) {
            val level = resolveReasoningLevel(selection.modelId)
                ?: return "无法确定模型 ${selection.modelId} 的思考档位，未写入（请检查 ZCode 安装是否完整）"
            return updateAgentsState(f, agentName, selection.copy(reasoningLevel = level), null)
        }
        val root: JsonObject? = if (f.isFile) {
            try {
                json.parseToJsonElement(f.readText()).jsonObject
            } catch (e: Exception) {
                return "解析 ${f.name} 失败，已放弃写入（防止覆盖）；请手动修正该文件后重试: ${f.absolutePath}"
            }
        } else {
            null
        }
        val overrides = root?.get("builtInModelSelectionOverrides") as? JsonObject
        val newOverrides = buildJsonObject {
            BUILTIN_OVERRIDE_KEYS.forEach { name ->
                val entry = if (name == agentName) selection?.toJson() else overrides?.get(name)
                if (entry != null) put(name, entry)
            }
            // 该节点内的其余 key 原样跟在后面
            overrides?.forEach { (k, v) -> if (k !in BUILTIN_OVERRIDE_KEYS) put(k, v) }
        }
        val newRoot = if (root == null) {
            buildJsonObject {
                put("builtInModelSelectionOverrides", newOverrides)
                put("pluginAgentModelSelectionOverrides", buildJsonObject { })
                put("disabledAgentIds", JsonArray(emptyList()))
            }
        } else {
            buildJsonObject {
                root.forEach { (k, v) -> put(k, if (k == "builtInModelSelectionOverrides") newOverrides else v) }
                if (overrides == null) put("builtInModelSelectionOverrides", newOverrides)
            }
        }
        return try {
            atomicWrite(f, prettyJson.encodeToString(JsonElement.serializer(), newRoot))
            null
        } catch (e: Exception) {
            "写回失败: ${e.message}"
        }
    }

    /** 2 空格缩进（对齐桌面端 JSON.stringify(..., null, 2) 写出格式） */
    private val prettyJson = Json { prettyPrint = true; prettyPrintIndent = "  " }

    /** 向上探测 git 根（含 .git 的最近祖先） */
    private fun findGitRoot(start: String): File? {
        var dir: File? = File(start).absoluteFile
        while (dir != null) {
            if (File(dir, ".git").exists()) return dir
            dir = dir.parentFile
        }
        return null
    }
}
