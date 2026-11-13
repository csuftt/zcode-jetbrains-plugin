package com.zcode.ideaplugin.ui

import java.io.File
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.io.path.createTempDirectory

/**
 * SlashCommandScanner 单元测试（临时目录隔离，不依赖本机真机数据）
 */
class SlashCommandScannerTest {

    private val tmp = createTempDirectory("slash-scan-test").toFile()

    @AfterTest
    fun cleanup() {
        tmp.deleteRecursively()
    }

    @Test
    fun `内置命令兜底合入且标记 builtin`() {
        val commands = SlashCommandScanner.scan(tmp.absolutePath)
        val init = commands.firstOrNull { it.name == "init" }
        assertNotNull(init, "/init 应在结果中（CLI 内置命令）")
        assertEquals("command", init.kind)
        assertEquals("builtin", init.source)
        assertTrue(init.description!!.contains("AGENTS.md"), "内置命令应带 CLI summary 描述")
    }

    @Test
    fun `自定义同名命令优先于内置`() {
        val cmdDir = File(tmp, ".zcode/commands").apply { mkdirs() }
        File(cmdDir, "init.md").writeText("---\ndescription: 我的初始化\n---\n自定义内容")

        val commands = SlashCommandScanner.scan(tmp.absolutePath)
        val init = commands.firstOrNull { it.name == "init" }
        assertNotNull(init)
        assertEquals("workspace", init.source, "磁盘扫描先于内置兜底，自定义 init 应胜出")
        assertEquals("我的初始化", init.description)
        assertEquals(1, commands.count { it.name == "init" }, "同名命令应去重为一条")
    }

    @Test
    fun `内置清单仅服务端可解析的两条`() {
        val commands = SlashCommandScanner.scan(tmp.absolutePath)
        val builtinNames = commands.filter { it.source == "builtin" }.map { it.name }.sorted()
        assertEquals(listOf("compact", "init"), builtinNames, "内置提示只列服务端 send 可解析的命令（goal 属客户端本地功能，不列）")
    }

    @Test
    fun `工作区嵌套命令冒号连接`() {
        val cmdDir = File(tmp, ".zcode/commands/review").apply { mkdirs() }
        File(cmdDir, "code.md").writeText("审查当前代码变更")

        val commands = SlashCommandScanner.scan(tmp.absolutePath)
        val nested = commands.firstOrNull { it.name == "review:code" }
        assertNotNull(nested, "review/code.md 应映射为 review:code")
        assertEquals("command", nested.kind)
    }

    @Test
    fun `技能条目带目录路径（$ 技能提及 chip 序列化用）命令不带`() {
        val skillDir = File(tmp, ".zcode/skills/reviewer").apply { mkdirs() }
        File(skillDir, "SKILL.md").writeText("---\nname: reviewer\ndescription: 代码审查\n---\n内容")
        val cmdDir = File(tmp, ".zcode/commands").apply { mkdirs() }
        File(cmdDir, "build.md").writeText("构建命令")

        val commands = SlashCommandScanner.scan(tmp.absolutePath)
        val skill = commands.firstOrNull { it.name == "reviewer" }
        assertNotNull(skill)
        assertEquals("skill", skill.kind)
        assertEquals(skillDir.absolutePath, skill.path, "技能条目应透出技能目录绝对路径")
        val cmd = commands.firstOrNull { it.name == "build" }
        assertNotNull(cmd)
        assertEquals("command", cmd.kind)
        assertEquals(null, cmd.path, "命令条目无 path（$ 面板只列技能）")
    }

    // ============ 插件贡献（home 注入 tmp 隔离，不受本机真实插件影响）============

    /** 在 tmp 下造一个插件：data/<名>@<市场> 启用标记 + cache/<市场>/<名>/<版本> 安装内容 */
    private fun makePlugin(name: String, version: String, enabled: Boolean, files: Map<String, String>) {
        val base = File(tmp, ".zcode/cli/plugins")
        val versionDir = File(base, "cache/mp1/$name/$version").apply { mkdirs() }
        if (enabled) File(base, "data").apply { mkdirs() }.resolve("$name@mp1").mkdirs()
        files.forEach { (rel, content) ->
            val f = File(versionDir, rel).apply { parentFile.mkdirs() }
            f.writeText(content)
        }
    }

    @Test
    fun `市场清单与未启用插件不进补全`() {
        // marketplaces/ 是市场源完整清单（未安装插件），cache 里未启用插件同样不可用
        File(tmp, ".zcode/cli/plugins/marketplaces/mp1/plugins/hookify/commands").apply { mkdirs() }
            .resolve("help.md").writeText("市场清单里的 help")
        makePlugin("ghost", "1.0.0", enabled = false, mapOf("commands/spooky.md" to "未启用插件的命令"))

        val commands = SlashCommandScanner.scan(tmp.absolutePath, tmp.absolutePath)
        assertTrue(commands.none { it.name == "help" || it.name == "hookify:help" }, "市场清单命令不应出现")
        assertTrue(commands.none { it.name.contains("ghost") }, "未启用插件不应贡献命令")
    }

    @Test
    fun `启用插件命令与技能带插件名前缀`() {
        makePlugin(
            "myplug", "1.0.0", enabled = true,
            mapOf(
                "commands/deploy.md" to "---\ndescription: 部署\n---\n内容",
                "skills/packer/SKILL.md" to "---\nname: packer\ndescription: 打包\n---\n内容",
            )
        )

        val items = SlashCommandScanner.scan(tmp.absolutePath, tmp.absolutePath)
        val cmd = items.firstOrNull { it.name == "myplug:deploy" }
        assertNotNull(cmd, "插件命令应为 插件名:命令名 形式")
        assertEquals("command", cmd.kind)
        assertEquals("plugin", cmd.source)
        assertEquals("部署", cmd.description)
        assertTrue(items.none { it.name == "deploy" }, "插件命令不应以裸名注册")

        val skill = items.firstOrNull { it.name == "myplug:packer" }
        assertNotNull(skill, "插件技能应为 插件名:技能名 形式")
        assertEquals("skill", skill.kind)
    }

    @Test
    fun `多版本共存取最新版本目录`() {
        makePlugin("ver", "0.9.0", enabled = true, mapOf("commands/old.md" to "旧版命令"))
        makePlugin("ver", "0.10.0", enabled = true, mapOf("commands/new.md" to "新版命令"))

        val items = SlashCommandScanner.scan(tmp.absolutePath, tmp.absolutePath)
        assertNotNull(items.firstOrNull { it.name == "ver:new" }, "应加载 0.10.0 的命令")
        assertTrue(items.none { it.name == "ver:old" }, "旧版本命令不应出现（0.10.0 > 0.9.0 按数值比较）")
    }

    @Test
    fun `清单 skills 数组按声明发现技能（分类子目录插件，未声明的不扫）`() {
        // Mattpocock 形态：技能散在 skills/<分类>/<名>/，清单数组逐个声明；in-progress/misc 故意不声明
        makePlugin(
            "catalog", "1.0.0", enabled = true,
            mapOf(
                ".claude-plugin/plugin.json" to
                    """{"name":"catalog","skills":["./skills/eng/alpha","./skills/prod/beta"]}""",
                "skills/eng/alpha/SKILL.md" to "---\nname: alpha\ndescription: 甲\n---\n内容",
                "skills/prod/beta/SKILL.md" to "---\nname: beta\ndescription: 乙\n---\n内容",
                "skills/wip/gamma/SKILL.md" to "---\nname: gamma\ndescription: 未声明\n---\n内容",
            )
        )

        val items = SlashCommandScanner.scan(tmp.absolutePath, tmp.absolutePath)
        assertNotNull(items.firstOrNull { it.name == "catalog:alpha" }, "数组声明的技能应被发现")
        assertNotNull(items.firstOrNull { it.name == "catalog:beta" }, "跨分类子目录的技能应被发现")
        assertTrue(items.none { it.name == "catalog:gamma" }, "清单未声明的技能不应出现（对齐官方 skills 口径）")
    }

    @Test
    fun `清单 skills 字符串形态取技能根直下子目录`() {
        makePlugin(
            "rooted", "1.0.0", enabled = true,
            mapOf(
                ".zcode-plugin/plugin.json" to """{"name":"rooted","skills":"./skills"}""",
                "skills/one/SKILL.md" to "---\nname: one\ndescription: 直下一层\n---\n内容",
            )
        )

        val items = SlashCommandScanner.scan(tmp.absolutePath, tmp.absolutePath)
        assertNotNull(items.firstOrNull { it.name == "rooted:one" }, "字符串声明=技能根，取直下一层")
    }

    @Test
    fun `清单无 skills 字段回退直下一层扫描`() {
        makePlugin(
            "plain", "1.0.0", enabled = true,
            mapOf(
                ".claude-plugin/plugin.json" to """{"name":"plain","description":"无技能声明"}""",
                "skills/direct/SKILL.md" to "---\nname: direct\n---\n内容",
            )
        )

        val items = SlashCommandScanner.scan(tmp.absolutePath, tmp.absolutePath)
        assertNotNull(items.firstOrNull { it.name == "plain:direct" }, "无 skills 声明应回退直下一层扫描")
    }

    @Test
    fun `config 显式禁用的插件不贡献技能与命令`() {
        // 官方禁用开关落在 config.json plugins.enabledPlugins=false，data/ 目录是曾启用残留（不删）
        makePlugin(
            "offplug", "1.0.0", enabled = true,
            mapOf(
                ".zcode-plugin/plugin.json" to """{"name":"offplug","skills":"skills"}""",
                "skills/hidden/SKILL.md" to "---\nname: hidden\ndescription: 不该出现\n---\n内容",
                "commands/secret.md" to "不该出现的命令",
            )
        )
        File(tmp, ".zcode/cli/config.json").apply { parentFile.mkdirs() }
            .writeText("""{"plugins":{"enabledPlugins":{"offplug@mp1":false}}}""")

        val items = SlashCommandScanner.scan(tmp.absolutePath, tmp.absolutePath)
        assertTrue(items.none { it.name == "offplug:hidden" }, "已禁用插件的技能不应出现")
        assertTrue(items.none { it.name == "offplug:secret" }, "已禁用插件的命令不应出现")
    }

    @Test
    fun `未出现在 enabledPlugins 的插件默认启用`() {
        makePlugin("builtin", "1.0.0", enabled = true, mapOf("skills/keep/SKILL.md" to "---\nname: keep\n---\n内容"))
        File(tmp, ".zcode/cli/config.json").apply { parentFile.mkdirs() }
            .writeText("""{"plugins":{"enabledPlugins":{"other@mp1":false}}}""")

        val items = SlashCommandScanner.scan(tmp.absolutePath, tmp.absolutePath)
        assertNotNull(items.firstOrNull { it.name == "builtin:keep" }, "enabledPlugins 未登记的官方内置插件应默认启用")
    }
}
