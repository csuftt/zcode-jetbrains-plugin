package com.zcode.ideaplugin.ui

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.nio.charset.Charset

/**
 * 斜杠命令/技能磁盘扫描器（输入框 / 快捷选择数据源）
 *
 * 扫描顺序与 ZCode 客户端发现顺序一致（先扫先得，同名后到者被忽略）：
 *   1. 用户级  ~/.zcode/skills、~/.agents/skills、~/.zcode/commands、~/.agents/commands
 *   2. 工作区级 项目根 .zcode/skills、.agents/skills、.zcode/commands、.agents/commands
 *   3. 插件贡献 仅实际启用的插件（见 scanPluginResources），注册为 `插件名:名称`
 *   4. CLI 内置命令兜底（仅 compact/init 2 个，服务端 send 可解析；
 *      定义在 zcode.cjs 内磁盘无文件，app-server 协议也无 commands/list RPC，
 *      只能随插件内置清单）
 *
 * - SKILL.md：解析 frontmatter（name/description/userInvocable），name 缺省用目录名，
 *   userInvocable: false 过滤（与 cc-gui SlashCommandRegistry 一致）
 * - 命令 .md：文件名（去 .md）为名，嵌套目录冒号连接（review/code.md → review:code）
 * - frontmatter 解析失败/IO 异常跳过该文件，不影响其他结果
 */
object SlashCommandScanner {

    /** 一条可展示的斜杠命令 */
    data class SlashCommand(
        val name: String,
        val description: String?,
        /** skill=技能（SKILL.md）| command=命令（.md）*/
        val kind: String,
        /** user / workspace / plugin / builtin */
        val source: String,
        /** 技能目录绝对路径（仅 skill 条目；$ 技能提及 chip 序列化 [$name](path) 用）*/
        val path: String? = null,
    )

    private val FRONTMATTER_RE = Regex("^---\\s*\\r?\\n([\\s\\S]*?)\\r?\\n---")
    private const val MAX_READ = 4096

    /**
     * CLI 内置命令提示清单（仅列服务端 send 可解析执行的；goal 虽在官方客户端 `/`
     * 补全中出现，但属客户端本地功能，发到 app-server 不被解析只会原文透传给模型，不列）。
     * name+summary 从 zcode.cjs bundle 提取，版本升级时校准：
     * grep -o 'name:"[a-z-]*",summary:"[^"]*"' zcode.cjs
     */
    private val BUILTIN_COMMANDS = listOf(
        "compact" to "Compact the current conversation with optional instructions.",
        "init" to "Create or update workspace AGENTS.md instructions.",
    )

    /** 扫描全部来源，返回按名去重后的列表（先扫先得）；home 参数供测试注入隔离目录 */
    fun scan(projectBasePath: String?, home: String? = System.getProperty("user.home")): List<SlashCommand> {
        val result = LinkedHashMap<String, SlashCommand>()
        if (home == null) return emptyList()

        // 1. 用户级
        scanSkillDir(File(home, ".zcode/skills"), "user", result)
        scanSkillDir(File(home, ".agents/skills"), "user", result)
        scanCommandDir(File(home, ".zcode/commands"), "user", result)
        scanCommandDir(File(home, ".agents/commands"), "user", result)

        // 2. 工作区级（项目根）
        if (!projectBasePath.isNullOrBlank()) {
            val base = File(projectBasePath)
            scanSkillDir(File(base, ".zcode/skills"), "workspace", result)
            scanSkillDir(File(base, ".agents/skills"), "workspace", result)
            scanCommandDir(File(base, ".zcode/commands"), "workspace", result)
            scanCommandDir(File(base, ".agents/commands"), "workspace", result)
        }

        // 3. 插件贡献
        scanPluginResources(File(home, ".zcode/cli/plugins"), result)

        // 4. CLI 内置命令（最后合入：用户/插件自定义同名命令优先展示）
        BUILTIN_COMMANDS.forEach { (name, summary) ->
            putIfAbsent(result, name, summary, "command", "builtin")
        }

        return result.values.toList()
    }

    /** 技能目录：<root>/<skill-name>/SKILL.md */
    private fun scanSkillDir(dir: File, source: String, result: LinkedHashMap<String, SlashCommand>) {
        if (!dir.isDirectory) return
        dir.listFiles()?.forEach { skillDir ->
            if (!skillDir.isDirectory) return@forEach
            val skillFile = File(skillDir, "SKILL.md")
            if (!skillFile.isFile) return@forEach
            try {
                val fm = parseFrontmatter(skillFile.readText(Charsets.UTF_8).take(MAX_READ))
                if (!isUserInvocable(fm)) return@forEach
                val name = fm["name"] ?: skillDir.name
                putIfAbsent(result, name, fm["description"], "skill", source, skillDir.absolutePath)
            } catch (_: Exception) {
                // frontmatter 解析失败跳过（不中断整体扫描）
            }
        }
    }

    /**
     * 命令目录：递归扫描 .md，嵌套目录冒号连接；
     * namespace 非空时注册为 `命名空间:名称`（插件命令用，与 CLI 规范名对齐）
     */
    private fun scanCommandDir(
        dir: File,
        source: String,
        result: LinkedHashMap<String, SlashCommand>,
        prefix: String = "",
        namespace: String? = null,
    ) {
        if (!dir.isDirectory) return
        dir.listFiles()?.sorted()?.forEach { f ->
            if (f.isDirectory) {
                val childPrefix = if (prefix.isEmpty()) f.name else "$prefix:${f.name}"
                scanCommandDir(f, source, result, childPrefix, namespace)
            } else if (f.isFile && f.extension.equals("md", ignoreCase = true)) {
                val nested = if (prefix.isEmpty()) f.nameWithoutExtension else "$prefix:${f.nameWithoutExtension}"
                val name = namespace?.let { "$it:$nested" } ?: nested
                if (result.containsKey(name)) return@forEach
                try {
                    val fm = parseFrontmatter(f.readText(Charsets.UTF_8).take(MAX_READ))
                    putIfAbsent(result, name, fm["description"], "command", source)
                } catch (_: Exception) {
                    putIfAbsent(result, name, null, "command", source)
                }
            }
        }
    }

    /**
     * 插件贡献：只认实际启用的插件（对齐 `zcode plugins list` 的 enabled 集合）。
     * ~/.zcode/cli/plugins 下三棵树性质不同（全树扫描会把市场清单当可用项）：
     *   data/<插件名>@<市场名>/      启用插件初始化时创建的数据目录 = 启用判据（实测与 CLI 输出一致）
     *   cache/<市场>/<插件>/<版本>/  安装内容（多版本共存取最新）
     *   marketplaces/<市场>/        市场源完整清单（未安装插件的仓库内容），不进补全
     * 插件项注册为 `插件名:名称`（对齐 CLI 规范名，如 browser-use:control-browser）
     */
    private fun scanPluginResources(root: File, result: LinkedHashMap<String, SlashCommand>) {
        enabledPluginVersionDirs(root).forEach { (pluginName, versionDir) ->
            for (skillDir in pluginSkillDirs(versionDir)) {
                val skillFile = File(skillDir, "SKILL.md")
                if (!skillFile.isFile) continue
                try {
                    val fm = parseFrontmatter(skillFile.readText(Charsets.UTF_8).take(MAX_READ))
                    if (!isUserInvocable(fm)) continue
                    val name = fm["name"] ?: skillDir.name
                    putIfAbsent(result, "$pluginName:$name", fm["description"], "skill", "plugin", skillDir.absolutePath)
                } catch (_: Exception) { }
            }
            scanCommandDir(File(versionDir, "commands"), "plugin", result, namespace = pluginName)
        }
    }

    /** 插件清单位置（按优先级，对齐官方 zcode.cjs 的 .zcode-plugin → .claude-plugin → .codex-plugin） */
    private val PLUGIN_MANIFESTS = listOf(
        ".zcode-plugin/plugin.json",
        ".claude-plugin/plugin.json",
        ".codex-plugin/plugin.json",
    )

    /**
     * 插件技能目录发现（SkillScanner 共用），对齐官方 Mxo/oSo/FZ 语义：
     *
     * 取首个存在的清单的 `skills` 字段，两种形态归一为技能根列表：
     *   - 字符串（如 `"skills": "skills"`）：单个根
     *   - 数组（如 `["./skills/engineering/ask-matt", ...]`）：逐个根
     * 每个根按官方 FZ 两层语义展开：根本身含 SKILL.md 即一个技能，否则取其直下一层
     * `<根>/<name>/SKILL.md`（不递归更深）。
     *
     * - `skills` 字段缺失：官方回退默认根 `skills`（同 `Mxo` 的 manifest.skills===void 0 分支）
     * - 字段存在但为空数组/空串：官方不启用任何根，这里同样不回退
     * - 无任何清单：宽容回退默认根（官方不会加载无清单插件，但多列不会误伤既有技能）
     *
     * 不能只认直下一层：Mattpocock 这类 Claude 市场插件把技能放在分类子目录
     * （skills/engineering/ask-matt），且用清单数组显式声明集合（in-progress/misc 故意不声明），
     * 无脑递归又会把未声明的实验性技能带出来。
     */
    internal fun pluginSkillDirs(versionDir: File): List<File> {
        val manifest = PLUGIN_MANIFESTS.map { File(versionDir, it) }.firstOrNull { it.isFile }
            ?: return childSkillDirs(File(versionDir, "skills"))
        val roots = declaredSkillRoots(manifest)
            ?: return childSkillDirs(File(versionDir, "skills"))
        val base = runCatching { versionDir.canonicalFile }.getOrDefault(versionDir)
        return roots.mapNotNull { rel -> containedUnder(base, rel) }
            .flatMap { skillDirOrRoot(it) }
            .distinct()
    }

    /** manifest.skills → 根路径列表；null = 字段缺失（官方语义：回退默认 skills 根） */
    private fun declaredSkillRoots(manifest: File): List<String>? = runCatching {
        val skills = Json.parseToJsonElement(manifest.readText(Charsets.UTF_8)).jsonObject["skills"]
            ?: return null
        when (skills) {
            is JsonArray -> skills.mapNotNull { el ->
                (el as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
            }
            is JsonPrimitive -> listOfNotNull(skills.contentOrNull?.takeIf { it.isNotBlank() })
            else -> emptyList()
        }
    }.getOrNull()

    /**
     * 根路径解析并限制在插件目录内（对齐官方 VT：绝对路径/../ 越界视为非法根，跳过）。
     * 解析不到（越界）返回 null。
     */
    private fun containedUnder(base: File, rel: String): File? {
        val f = File(rel)
        if (f.isAbsolute) return null
        val resolved = runCatching { File(base, rel).canonicalFile }.getOrNull() ?: return null
        val basePath = base.path.trimEnd(File.separatorChar)
        val path = resolved.path
        if (path != basePath && !path.startsWith(basePath + File.separatorChar)) return null
        return resolved
    }

    /** 根本身是技能目录则取自身；否则取其直下一层子目录（官方 FZ 两层语义） */
    private fun skillDirOrRoot(dir: File): List<File> =
        if (File(dir, "SKILL.md").isFile) listOf(dir) else childSkillDirs(dir)

    private fun childSkillDirs(dir: File): List<File> =
        dir.listFiles()?.filter { it.isDirectory }?.sortedBy { it.name.lowercase() }.orEmpty()

    /**
     * 启用插件 → 其最新版本目录（SkillScanner / McpConfigReader 共用）。
     *
     * 双重判据：
     *   data/<插件名>@<市场名>/           插件曾初始化（cache 有但从未启用的不列）
     *   config.json plugins.enabledPlugins 显式 false = 官方禁用开关（权威；禁用不删 data/cache，
     *   所以只看 data 目录会把已禁用插件当启用——pdf/presentations 等实测就是 data 残留）
     *   未出现在 enabledPlugins 的视为默认启用（官方内置插件不写该节点）。
     */
    internal fun enabledPluginVersionDirs(root: File): List<Pair<String, File>> {
        val dataDir = File(root, "data")
        val cacheDir = File(root, "cache")
        if (!dataDir.isDirectory || !cacheDir.isDirectory) return emptyList()
        val disabled = disabledPluginIds(root)
        return dataDir.listFiles().orEmpty()
            .filter { it.isDirectory && it.name.contains('@') && it.name !in disabled }
            .mapNotNull { data ->
                val pluginName = data.name.substringBefore('@')
                val marketplace = data.name.substringAfter('@')
                if (pluginName.isEmpty() || marketplace.isEmpty()) return@mapNotNull null
                newestVersionDir(File(cacheDir, "$marketplace/$pluginName"))?.let { pluginName to it }
            }
    }

    /** config.json 的 plugins.enabledPlugins 中显式 false 的插件 id（插件名@市场名） */
    internal fun disabledPluginIds(pluginsRoot: File): Set<String> {
        val cfg = File(pluginsRoot.parentFile, "config.json")
        if (!cfg.isFile) return emptySet()
        return runCatching {
            val plugins = Json.parseToJsonElement(cfg.readText(Charsets.UTF_8)).jsonObject["plugins"]?.jsonObject
            val enabled = plugins?.get("enabledPlugins")?.jsonObject ?: return emptySet()
            enabled.entries.mapNotNull { (id, v) ->
                if (runCatching { v.jsonPrimitive.boolean }.getOrNull() == false) id else null
            }.toSet()
        }.getOrElse { emptySet() }
    }

    /** 版本目录取语义最新（点分数值比较，0.10.0 > 0.9.0；非数字段按 0）*/
    private fun newestVersionDir(pluginRoot: File): File? =
        pluginRoot.listFiles().orEmpty()
            .filter { it.isDirectory }
            .maxWithOrNull { a, b -> compareVersionNames(a.name, b.name) }

    private fun compareVersionNames(a: String, b: String): Int {
        val va = a.split('.').map { it.toIntOrNull() ?: 0 }
        val vb = b.split('.').map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(va.size, vb.size)) {
            val c = va.getOrElse(i) { 0 }.compareTo(vb.getOrElse(i) { 0 })
            if (c != 0) return c
        }
        return 0
    }

    private fun putIfAbsent(
        result: LinkedHashMap<String, SlashCommand>,
        name: String,
        description: String?,
        kind: String,
        source: String,
        path: String? = null,
    ) {
        if (!result.containsKey(name)) {
            result[name] = SlashCommand(name, description?.takeIf { it.isNotBlank() }, kind, source, path)
        }
    }

    /** 解析 YAML frontmatter 首行值（name/description 等单行标量；SkillScanner 共用） */
    internal fun parseFrontmatter(text: String): Map<String, String> {
        val m = FRONTMATTER_RE.find(text) ?: return emptyMap()
        val map = LinkedHashMap<String, String>()
        for (line in m.groupValues[1].lineSequence()) {
            val idx = line.indexOf(':')
            if (idx <= 0) continue
            val key = line.substring(0, idx).trim().lowercase()
            if (key in map) continue // 首值生效
            var value = line.substring(idx + 1).trim()
            // 去掉首尾引号
            if (value.length >= 2 && value.first() == value.last() && (value.first() == '"' || value.first() == '\'')) {
                value = value.substring(1, value.length - 1)
            }
            map[key] = value
        }
        return map
    }

    private fun isUserInvocable(fm: Map<String, String>): Boolean {
        val v = fm["userinvocable"]?.lowercase() ?: return true // 默认可调用
        return v !in setOf("false", "no", "0")
    }
}
