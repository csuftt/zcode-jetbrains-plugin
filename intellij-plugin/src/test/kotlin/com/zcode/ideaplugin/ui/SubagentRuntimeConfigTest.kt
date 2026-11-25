package com.zcode.ideaplugin.ui

import java.io.File
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * SubagentRuntimeConfig 快照组装单测（user.home 重定向到临时目录，全隔离不碰真机数据）。
 *
 * 解析器本身的等价性由 [SubagentRuntimeConfigGoldenTest] 对官方实现回放，这里只测组装：
 * 两处定义目录的取法、禁用过滤、状态文件读取、以及应答形状自检。
 */
class SubagentRuntimeConfigTest {

    private lateinit var realHome: String
    private lateinit var home: File
    private lateinit var project: File

    @BeforeTest
    fun setup() {
        realHome = System.getProperty("user.home")
        home = createTempDir("zcode-subagent-rt-home")
        project = createTempDir("zcode-subagent-rt-project")
        System.setProperty("user.home", home.absolutePath)
    }

    @AfterTest
    fun teardown() {
        System.setProperty("user.home", realHome)
        home.deleteRecursively()
        project.deleteRecursively()
    }

    private fun storage() = File(home, ".zcode")

    private fun agentDir(source: String) = if (source == "user") File(storage(), "agents") else File(project, ".zcode/agents")

    /** 写一份合法定义；permissionMode=null = 不写该字段 */
    private fun md(fileName: String, source: String = "user", permissionMode: String? = "plan"): File =
        File(agentDir(source).apply { mkdirs() }, fileName).apply {
            writeText(
                "---\nname: ${fileName.substringBeforeLast('.')}\ndescription: d of $fileName\n" +
                    (permissionMode?.let { "permissionMode: $it\n" } ?: "") +
                    "---\nPrompt of $fileName",
            )
        }

    private fun profiles(snapshot: JsonObject): List<JsonObject> = snapshot.getValue("profiles").jsonArray.map { it.jsonObject }

    private fun names(snapshot: JsonObject) =
        profiles(snapshot).map { it.getValue("name").jsonPrimitive.content to it.getValue("source").jsonPrimitive.content }

    private fun writeState(disabled: String = "[]", builtIn: String = "{}", plugin: String = "{}") {
        File(storage(), "v2").mkdirs()
        File(storage(), "v2/agents-state.json")
            .writeText("""{"disabledAgentIds":$disabled,"builtInModelSelectionOverrides":$builtIn,"pluginAgentModelSelectionOverrides":$plugin}""")
    }

    @Test
    fun `没有任何定义与状态文件：空快照，形状自检通过`() {
        val snapshot = SubagentRuntimeConfig.snapshot(null)
        assertEquals("ready", snapshot.getValue("kind").jsonPrimitive.content)
        assertEquals(JsonArray(emptyList()), snapshot.getValue("profiles"))
        assertEquals(JsonObject(emptyMap()), snapshot.getValue("builtInModelSelectionOverrides"))
        assertTrue(SubagentRuntimeConfig.isValidSnapshot(snapshot))
    }

    @Test
    fun `只取两处目录第一层的 md，按路径排序；带诊断的文件跳过，用户级在前项目级在后`() {
        md("b-second.md")
        md("a-first.md")
        md("broken.md").writeText("no frontmatter here")
        md("notes.txt").writeText("---\nname: notes\ndescription: n\n---\nnot markdown")
        // 子目录里的定义不在发现范围（官方：自定义 profile 只支持第一层）
        File(agentDir("user"), "nested").mkdirs()
        File(File(agentDir("user"), "nested"), "deep.md").writeText("---\nname: deep\ndescription: d\n---\nPrompt")
        md("broken.md", source = "project").writeText("no frontmatter here")
        md("proj.md", source = "project", permissionMode = "bypassPermissions")
        md("upper.MARKDOWN", source = "project", permissionMode = null)

        val snapshot = SubagentRuntimeConfig.snapshot(project.absolutePath)
        assertEquals(
            listOf("a-first" to "user", "b-second" to "user", "proj" to "project", "upper" to "project"),
            names(snapshot),
        )
        val first = profiles(snapshot)[0]
        // 项目级定义来自仓库输入：permissionMode 不许借 frontmatter 提升子会话权限；用户级保留
        assertNull(profiles(snapshot)[2]["permissionMode"])
        assertEquals("plan", first.getValue("permissionMode").jsonPrimitive.content)
        assertTrue(first.getValue("path").jsonPrimitive.content.endsWith("a-first.md"), "path 落绝对路径")
        assertEquals("Prompt of a-first.md", first.getValue("systemPrompt").jsonPrimitive.content)
    }

    @Test
    fun `不给工作目录时只取用户级`() {
        md("mine.md")
        md("theirs.md", source = "project")
        assertEquals(listOf("mine" to "user"), names(SubagentRuntimeConfig.snapshot(null)))
        assertEquals(listOf("mine" to "user"), names(SubagentRuntimeConfig.snapshot("  ")))
    }

    @Test
    fun `禁用清单只过滤用户级且 id 精确匹配，两张覆盖表（含档位）原样带出`() {
        md("off.md")
        md("on.md")
        md("off.md", source = "project")
        writeState(
            disabled = """["user:user:off", "user:user:ON"]""",
            builtIn = """{"general-purpose":{"providerId":" p ","modelId":"m","options":{"reasoningLevel":"max"}},""" +
                """"Explore":{"providerId":"gone","modelId":""}}""",
            plugin = """{"plugin:x:y":{"providerId":"p2","modelId":"m2"},"not-plugin:z":{"providerId":"p3","modelId":"m3"}}""",
        )
        val snapshot = SubagentRuntimeConfig.snapshot(project.absolutePath)
        assertEquals(
            listOf("on" to "user", "off" to "project"),
            names(snapshot),
            "用户级 off 被禁用、项目级同名不受影响（用户级在前）；禁用 id 大小写精确，ON 不命中",
        )
        assertEquals(
            """{"general-purpose":{"providerId":"p","modelId":"m","options":{"reasoningLevel":"max"}}}""",
            snapshot.getValue("builtInModelSelectionOverrides").toString(),
            "空 modelId 的条目按官方规则丢弃，合法条目 trim 后上线",
        )
        assertEquals(
            """{"plugin:x:y":{"providerId":"p2","modelId":"m2"}}""",
            snapshot.getValue("pluginAgentModelSelectionOverrides").toString(),
            "只收 plugin: 前缀的条目",
        )
        assertTrue(SubagentRuntimeConfig.isValidSnapshot(snapshot))
    }

    @Test
    fun `状态文件缺失或 JSON 损坏按空状态，快照照常 ready`() {
        md("mine.md")
        assertEquals(listOf("mine" to "user"), names(SubagentRuntimeConfig.snapshot(null)))

        File(storage(), "v2").mkdirs()
        File(storage(), "v2/agents-state.json").writeText("{ not valid json !!")
        val snapshot = SubagentRuntimeConfig.snapshot(null)
        assertEquals("ready", snapshot.getValue("kind").jsonPrimitive.content)
        assertEquals(listOf("mine" to "user"), names(snapshot))
        assertEquals(JsonObject(emptyMap()), snapshot.getValue("builtInModelSelectionOverrides"))
    }

    @Test
    fun `形状自检：顶层多键、内置覆盖多名字、profile 多键或内置来源、工具名非字符串都不过`() {
        val empty = JsonObject(emptyMap())
        fun snapshotOf(profiles: JsonArray, builtIn: JsonObject = empty, extra: Pair<String, kotlinx.serialization.json.JsonElement>? = null) =
            buildJsonObject {
                put("kind", "ready")
                put("profiles", profiles)
                put("builtInModelSelectionOverrides", builtIn)
                put("pluginAgentModelSelectionOverrides", empty)
                extra?.let { (k, v) -> put(k, v) }
            }
        val profile = buildJsonObject {
            put("name", "a")
            put("description", "d")
            put("source", "user")
            put("systemPrompt", "")
        }
        fun profileWith(extra: Pair<String, kotlinx.serialization.json.JsonElement>) = JsonObject(profile + extra)

        assertTrue(SubagentRuntimeConfig.isValidSnapshot(snapshotOf(JsonArray(listOf(profile)))), "合法基线应通过")
        assertFalse(SubagentRuntimeConfig.isValidSnapshot(snapshotOf(JsonArray(emptyList()), extra = "extra" to JsonPrimitive(1))), "顶层多键")
        assertFalse(
            SubagentRuntimeConfig.isValidSnapshot(snapshotOf(JsonArray(emptyList()), builtIn = buildJsonObject { put("not-builtin", "x") })),
            "内置覆盖只认两个名字",
        )
        assertFalse(SubagentRuntimeConfig.isValidSnapshot(snapshotOf(JsonArray(listOf(profileWith("extra" to JsonPrimitive(1)))))), "profile 多键")
        assertFalse(SubagentRuntimeConfig.isValidSnapshot(snapshotOf(JsonArray(listOf(profileWith("source" to JsonPrimitive("built-in")))))), "内置来源不许由宿主下发")
        assertFalse(
            SubagentRuntimeConfig.isValidSnapshot(snapshotOf(JsonArray(listOf(profileWith("tools" to JsonArray(listOf(JsonPrimitive(1)))))))),
            "工具名必须是字符串",
        )
    }
}
