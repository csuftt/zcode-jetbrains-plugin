package com.zcode.ideaplugin.ui

import java.io.File
import java.nio.charset.Charset
import java.nio.file.Files

/**
 * 斜杠命令/技能磁盘扫描器（输入框 / 快捷选择数据源）
 *
 * 扫描顺序与 ZCode 客户端发现顺序一致（先扫先得，同名后到者被忽略）：
 *   1. 用户级  ~/.zcode/skills、~/.agents/skills、~/.zcode/commands、~/.agents/commands
 *   2. 工作区级 项目根 .zcode/skills、.agents/skills、.zcode/commands、.agents/commands
 *   3. 插件贡献 ~/.zcode/cli/plugins 下的 skills（限深 7 容错）
 *   4. CLI 内置命令兜底（仅 init/compact/goal 3 个，对齐官方客户端 `/` 补全；
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
    )

    private val FRONTMATTER_RE = Regex("^---\\s*\\r?\\n([\\s\\S]*?)\\r?\\n---")
    private const val MAX_READ = 4096

    /**
     * CLI 内置命令提示清单（对齐官方客户端 `/` 补全只展示这 3 个；
     * 其余内置命令如 model/mode/effort/mcp 在官方客户端走专门 UI，不进输入框提示）。
     * name+summary 从 zcode.cjs bundle 提取，版本升级时校准：
     * grep -o 'name:"[a-z-]*",summary:"[^"]*"' zcode.cjs
     */
    private val BUILTIN_COMMANDS = listOf(
        "compact" to "Compact the current conversation with optional instructions.",
        "goal" to "Show or set the current session goal.",
        "init" to "Create or update workspace AGENTS.md instructions.",
    )

    /** 扫描全部来源，返回按名去重后的列表（先扫先得） */
    fun scan(projectBasePath: String?): List<SlashCommand> {
        val result = LinkedHashMap<String, SlashCommand>()
        val home = System.getProperty("user.home") ?: return emptyList()

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
                putIfAbsent(result, name, fm["description"], "skill", source)
            } catch (_: Exception) {
                // frontmatter 解析失败跳过（不中断整体扫描）
            }
        }
    }

    /** 命令目录：递归扫描 .md，嵌套目录冒号连接 */
    private fun scanCommandDir(dir: File, source: String, result: LinkedHashMap<String, SlashCommand>, prefix: String = "") {
        if (!dir.isDirectory) return
        dir.listFiles()?.sorted()?.forEach { f ->
            if (f.isDirectory) {
                val childPrefix = if (prefix.isEmpty()) f.name else "$prefix:${f.name}"
                scanCommandDir(f, source, result, childPrefix)
            } else if (f.isFile && f.extension.equals("md", ignoreCase = true)) {
                val name = if (prefix.isEmpty()) f.nameWithoutExtension else "$prefix:${f.nameWithoutExtension}"
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

    /** 插件贡献：~/.zcode/cli/plugins 下任意深度的 skills 目录与 commands 目录 */
    private fun scanPluginResources(root: File, result: LinkedHashMap<String, SlashCommand>) {
        if (!root.isDirectory) return
        try {
            Files.walk(root.toPath(), 7).use { stream ->
                stream.forEach { path ->
                    val name = path.fileName.toString()
                    val rel = root.toPath().relativize(path).toString().replace('\\', '/')
                    if (name == "SKILL.md" && rel.contains("/skills/")) {
                        val skillDirName = path.parent?.fileName?.toString() ?: return@forEach
                        try {
                            val fm = parseFrontmatter(Files.readString(path, Charsets.UTF_8).take(MAX_READ))
                            if (!isUserInvocable(fm)) return@forEach
                            putIfAbsent(result, fm["name"] ?: skillDirName, fm["description"], "skill", "plugin")
                        } catch (_: Exception) { }
                    } else if (name.endsWith(".md") && rel.contains("/commands/")) {
                        val cmdName = rel.substringAfter("/commands/").removeSuffix(".md").replace('/', ':')
                        try {
                            val fm = parseFrontmatter(Files.readString(path, Charsets.UTF_8).take(MAX_READ))
                            putIfAbsent(result, cmdName, fm["description"], "command", "plugin")
                        } catch (_: Exception) { }
                    }
                }
            }
        } catch (_: Exception) {
            // 插件目录结构异常不阻塞整体
        }
    }

    private fun putIfAbsent(
        result: LinkedHashMap<String, SlashCommand>,
        name: String,
        description: String?,
        kind: String,
        source: String,
    ) {
        if (!result.containsKey(name)) {
            result[name] = SlashCommand(name, description?.takeIf { it.isNotBlank() }, kind, source)
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
