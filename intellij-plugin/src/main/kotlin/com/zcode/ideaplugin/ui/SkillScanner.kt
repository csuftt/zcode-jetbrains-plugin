package com.zcode.ideaplugin.ui

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * 技能磁盘扫描器（设置页「技能列表」数据源）
 *
 * 对齐 ZCode CLI（zcode skills list）的发现语义：
 *   user    ~/.zcode/skills、~/.agents/skills
 *           （junction 挂载时两根指向同一目录，按真实路径去重只保留先扫到的条目）
 *   project 项目根及 git worktree 根的 .zcode/skills、.agents/skills
 *   plugin  ~/.zcode/cli/plugins 下各插件的 skills 目录（限深 7 容错）
 *
 * 启用状态：~/.zcode/cli/config.json 的 skill 节点 {<SKILL.md路径>: {enable:false}}
 * （CLI collectDisabledPaths 只取 enable===false 条目；匹配时对技能路径做 resolve/realpath
 *  双重比对，因此 junction 两侧路径写任一侧都能禁用。已实验验证。）
 */
object SkillScanner {

    data class SkillInfo(
        val name: String,
        val description: String?,
        /** frontmatter when_to_use（自动触发时机说明）*/
        val whenToUse: String?,
        /** SKILL.md 绝对路径（openFile 跳转锚点 / config 禁用条目的 key）*/
        val path: String,
        val directory: String,
        /** user=全局 | project=项目 | plugin=插件贡献（CLI 语义中插件是 system scope）*/
        val scope: String,
        /** zcode | agents | plugin（同一 scope 下的根目录来源）*/
        val source: String,
        /** 插件技能的插件名（从路径推断，版本段回退上一层；识别失败为 null）*/
        val pluginName: String?,
        val enabled: Boolean,
    )

    private const val MAX_READ = 8192
    private const val PLUGIN_WALK_DEPTH = 7
    private val VERSION_LIKE = Regex("^v?\\d+(\\.\\d+)*.*$")
    private val LOCK = Any()

    private val prettyJson = Json { prettyPrint = true }

    /** 扫描全部来源，返回按真实路径去重后的列表（先扫先得：zcode 根优先于 agents 根） */
    fun scan(projectBasePath: String?): List<SkillInfo> {
        val home = System.getProperty("user.home") ?: return emptyList()
        val disabled = disabledSkillPaths()
        val raw = ArrayList<SkillInfo>()

        // 1. 全局（zcode 优先：junction 场景去重后保留 zcode 来源展示）
        scanSkillDir(File(home, ".zcode/skills"), "user", "zcode", null, disabled, raw)
        scanSkillDir(File(home, ".agents/skills"), "user", "agents", null, disabled, raw)

        // 2. 项目级（项目根 + git worktree 根，两根相同只扫一次）
        if (!projectBasePath.isNullOrBlank()) {
            val roots = linkedSetOf(File(projectBasePath))
            findGitRoot(projectBasePath)?.let { roots.add(it) }
            roots.forEach { base ->
                scanSkillDir(File(base, ".zcode/skills"), "project", "zcode", null, disabled, raw)
                scanSkillDir(File(base, ".agents/skills"), "project", "agents", null, disabled, raw)
            }
        }

        // 3. 插件贡献
        scanPluginSkills(File(home, ".zcode/cli/plugins"), disabled, raw)

        // realpath 去重：junction 让同一技能出现在 .zcode 与 .agents 两个根下，只展示一条
        val seen = HashSet<String>()
        return raw.filter { info ->
            val real = runCatching { File(info.path).canonicalPath }.getOrDefault(info.path)
            seen.add(real)
        }
    }

    /** 技能根目录：<root>/<skill-name>/SKILL.md */
    private fun scanSkillDir(
        dir: File,
        scope: String,
        source: String,
        pluginName: String?,
        disabled: Set<String>,
        out: MutableList<SkillInfo>,
    ) {
        if (!dir.isDirectory) return
        dir.listFiles()?.sortedBy { it.name.lowercase() }?.forEach { skillDir ->
            if (!skillDir.isDirectory) return@forEach
            val skillFile = File(skillDir, "SKILL.md")
            if (!skillFile.isFile) return@forEach
            parseSkill(skillFile, skillDir, scope, source, pluginName, disabled, out)
        }
    }

    /** 插件贡献：~/.zcode/cli/plugins 下任意深度（≤7）的 skills/<name>/SKILL.md */
    private fun scanPluginSkills(root: File, disabled: Set<String>, out: MutableList<SkillInfo>) {
        if (!root.isDirectory) return
        try {
            Files.walk(root.toPath(), PLUGIN_WALK_DEPTH).use { stream ->
                stream.forEach { path ->
                    if (path.fileName?.toString() != "SKILL.md") return@forEach
                    val rel = root.toPath().relativize(path).toString().replace('\\', '/')
                    val idx = rel.indexOf("/skills/")
                    if (idx <= 0) return@forEach
                    val skillDir = path.parent?.toFile() ?: return@forEach
                    val pluginName = pluginNameFromRel(rel.substring(0, idx))
                    parseSkill(path.toFile(), skillDir, "plugin", "plugin", pluginName, disabled, out)
                }
            }
        } catch (_: Exception) {
            // 插件目录结构异常不阻塞整体
        }
    }

    /** 解析单个 SKILL.md（frontmatter 失败/IO 异常跳过，不影响其他条目） */
    private fun parseSkill(
        skillFile: File,
        skillDir: File,
        scope: String,
        source: String,
        pluginName: String?,
        disabled: Set<String>,
        out: MutableList<SkillInfo>,
    ) {
        try {
            val fm = SlashCommandScanner.parseFrontmatter(skillFile.readText(Charsets.UTF_8).take(MAX_READ))
            val name = fm["name"]?.takeIf { it.isNotBlank() } ?: skillDir.name
            val path = skillFile.absolutePath.replace('/', File.separatorChar)
            out.add(
                SkillInfo(
                    name = name,
                    description = fm["description"]?.takeIf { it.isNotBlank() },
                    whenToUse = fm["when_to_use"]?.takeIf { it.isNotBlank() },
                    path = path,
                    directory = skillDir.absolutePath.replace('/', File.separatorChar),
                    scope = scope,
                    source = source,
                    pluginName = pluginName,
                    enabled = !isDisabled(path, disabled),
                )
            )
        } catch (_: Exception) {
        }
    }

    /**
     * rel 形如 cache/zcode-plugins-official/browser-use/0.2.1
     * 取最后一段；若形如版本号则回退上一段
     */
    private fun pluginNameFromRel(beforeSkills: String): String? {
        val parts = beforeSkills.split('/')
        val last = parts.lastOrNull() ?: return null
        return if (parts.size >= 2 && VERSION_LIKE.matches(last)) parts[parts.size - 2] else last
    }

    /** 从项目路径向上找 git worktree 根（CLI 项目级技能根会上溯到 worktree 根） */
    private fun findGitRoot(start: String): File? {
        var dir: File? = File(start)
        while (dir != null) {
            if (File(dir, ".git").exists()) return dir
            dir = dir.parentFile
        }
        return null
    }

    // ============ 启用状态（~/.zcode/cli/config.json 的 skill 节点） ============

    private fun configPath(): File =
        File(System.getProperty("user.home"), ".zcode/cli/config.json")

    private fun readConfig(): JsonObject? = runCatching {
        val f = configPath()
        if (!f.isFile) null
        else Json.parseToJsonElement(f.readText(Charsets.UTF_8)).jsonObject
    }.getOrNull()

    /** config.skill 中 enable===false 的路径集合 */
    private fun disabledSkillPaths(): Set<String> {
        val cfg = readConfig() ?: return emptySet()
        val skill = cfg["skill"]?.jsonObject ?: return emptySet()
        return skill.entries.mapNotNull { (k, v) ->
            val enable = runCatching { v.jsonObject["enable"]?.jsonPrimitive?.boolean }.getOrNull()
            if (enable == false) k else null
        }.toSet()
    }

    /** 对齐 CLI isDisabledSkillPath：原样路径或 canonical 路径命中都算禁用 */
    private fun isDisabled(skillPath: String, disabled: Set<String>): Boolean {
        if (skillPath in disabled) return true
        val canonical = runCatching { File(skillPath).canonicalPath }.getOrNull() ?: return false
        return canonical in disabled
    }

    /**
     * 设置技能启用状态并写回 config（保留其他节点，临时文件原子替换）。
     * 禁用 = skill 节点写 {enable:false}；启用 = 删除该条目（恢复默认）。
     * 返回是否成功。
     */
    fun setSkillEnabled(path: String, enabled: Boolean): Boolean = synchronized(LOCK) {
        val file = configPath()
        val root = runCatching {
            if (file.isFile) Json.parseToJsonElement(file.readText(Charsets.UTF_8)).jsonObject
            else JsonObject(emptyMap())
        }.getOrNull() ?: return false

        val skillObj = root["skill"]?.let { runCatching { it.jsonObject }.getOrNull() } ?: JsonObject(emptyMap())
        val newEntries = LinkedHashMap<String, kotlinx.serialization.json.JsonElement>(skillObj.size + 1)
        skillObj.forEach { (k, v) -> newEntries[k] = v }
        if (enabled) newEntries.remove(path) else newEntries[path] = buildJsonObject { put("enable", false) }

        val newRoot = buildJsonObject {
            root.forEach { (k, v) -> if (k != "skill") put(k, v) }
            // 禁用清单清空后整个移除 skill 节点（恢复 config 原貌）
            if (newEntries.isNotEmpty()) put("skill", JsonObject(newEntries))
        }

        runCatching {
            file.parentFile?.mkdirs()
            val tmp = File(file.parentFile, file.name + ".tmp")
            tmp.writeText(prettyJson.encodeToString(JsonObject.serializer(), newRoot), Charsets.UTF_8)
            Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
            true
        }.getOrDefault(false)
    }
}
