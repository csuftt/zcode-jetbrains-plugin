package com.zcode.ideaplugin.ui

import com.zcode.ideaplugin.protocol.Credentials
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * AgentScanner 单元测试（user.home 重定向到临时目录，全隔离不碰真机数据）
 *
 * 覆盖：frontmatter 解析（标量+块列表+内联列表）、写盘 round-trip、改名删旧、
 * 禁用清单过滤、name/description 缺失忽略、name 正则、作用域目录
 */
class AgentScannerTest {

    private lateinit var realHome: String
    private lateinit var home: File

    @BeforeTest
    fun setup() {
        realHome = System.getProperty("user.home")
        home = createTempDir("zcode-agent-test")
        System.setProperty("user.home", home.absolutePath)
    }

    @AfterTest
    fun teardown() {
        System.setProperty("user.home", realHome)
        home.deleteRecursively()
    }

    private fun sampleDef(
        name: String = "my-agent",
        tools: List<String> = emptyList(),
    ) = AgentScanner.AgentDef(
        name = name,
        description = "测试描述",
        model = null,
        thoughtLevel = null,
        color = "blue",
        tools = tools,
        disallowedTools = emptyList(),
        maxTurns = null,
        injectAgentsMd = true,
        mcpServers = emptyList(),
        systemPrompt = "你是测试子智能体",
        path = "",
        scope = "user",
    )

    @Test
    fun `保存后扫描 round-trip（标量字段 + 块列表 tools）`() {
        val def = sampleDef(tools = listOf("Read", "Bash"))
        assertTrue(AgentScanner.save("user", def, null))

        val scanned = AgentScanner.scan(null)
        assertEquals(1, scanned.size)
        val got = scanned[0]
        assertEquals("my-agent", got.name)
        assertEquals("测试描述", got.description)
        assertEquals("blue", got.color)
        assertEquals(listOf("Read", "Bash"), got.tools)
        assertTrue(got.injectAgentsMd)
        assertEquals("你是测试子智能体", got.systemPrompt)
        assertEquals("user", got.scope)
        assertNull(got.model, "inherit/缺省 model 解析为 null")
        assertTrue(File(got.path).isFile, "定义文件应存在")
    }

    @Test
    fun `改名写新文件删旧文件`() {
        assertTrue(AgentScanner.save("user", sampleDef(name = "old-name"), null))
        assertTrue(AgentScanner.save("user", sampleDef(name = "new-name"), originalName = "old-name"))

        val scanned = AgentScanner.scan(null)
        assertEquals(1, scanned.size)
        assertEquals("new-name", scanned[0].name)
        assertFalse(File(home, ".zcode/agents/old-name.md").exists(), "旧文件应被删除")
    }

    @Test
    fun `删除后清单为空`() {
        AgentScanner.save("user", sampleDef(), null)
        assertTrue(AgentScanner.delete("user", "my-agent"))
        assertTrue(AgentScanner.scan(null).isEmpty())
    }

    @Test
    fun `name 或 description 缺失的文件被忽略（zcode 语义）`() {
        val dir = File(home, ".zcode/agents").apply { mkdirs() }
        File(dir, "no-desc.md").writeText(
            """
            ---
            name: "no-desc"
            ---
            正文
            """.trimIndent()
        )
        File(dir, "no-name.md").writeText(
            """
            ---
            description: "缺名字"
            ---
            正文
            """.trimIndent()
        )
        assertTrue(AgentScanner.scan(null).isEmpty())
    }

    @Test
    fun `内联列表与 model 字段解析`() {
        val dir = File(home, ".zcode/agents").apply { mkdirs() }
        File(dir, "inline.md").writeText(
            """
            ---
            name: "inline"
            description: "内联列表"
            model: "GLM-5.2"
            color: "purple"
            tools: ["Read", "Grep"]
            injectAgentsMd: false
            ---
            正文提示词
            """.trimIndent()
        )
        val got = AgentScanner.scan(null).single()
        assertEquals("GLM-5.2", got.model)
        assertEquals("purple", got.color)
        assertEquals(listOf("Read", "Grep"), got.tools)
        assertFalse(got.injectAgentsMd)
    }

    @Test
    fun `disabledAgentIds 过滤禁用条目`() {
        AgentScanner.save("user", sampleDef(), null)
        val stateDir = File(home, ".zcode/v2").apply { mkdirs() }
        File(stateDir, "agents-state.json").writeText("""{"builtInModelOverrides":{},"builtInThoughtLevelOverrides":{},"disabledAgentIds":["my-agent"]}""")
        assertTrue(AgentScanner.scan(null).isEmpty(), "禁用条目应被过滤")
    }

    @Test
    fun `项目级作用域扫描`() {
        val project = createTempDir("zcode-agent-proj")
        try {
            val def = sampleDef(name = "proj-agent").copy(scope = "project")
            assertTrue(AgentScanner.save("project", def, null, projectBasePath = project.absolutePath))
            val scanned = AgentScanner.scan(project.absolutePath)
            assertEquals(1, scanned.size)
            assertEquals("project", scanned[0].scope)
            assertTrue(scanned[0].path.replace('\\', '/').endsWith(".zcode/agents/proj-agent.md"))
        } finally {
            project.deleteRecursively()
        }
    }

    @Test
    fun `name 正则对齐 zcode（小写字母数字开头，允许点下划线连字符）`() {
        assertTrue(AgentScanner.NAME_RE.matches("abc"))
        assertTrue(AgentScanner.NAME_RE.matches("a1-b.c_d"))
        assertTrue(AgentScanner.NAME_RE.matches("9lives"))
        assertFalse(AgentScanner.NAME_RE.matches("Abc"), "大写不允许")
        assertFalse(AgentScanner.NAME_RE.matches("-abc"), "开头须字母或数字")
        assertFalse(AgentScanner.NAME_RE.matches("a b"), "空格不允许")
        assertFalse(AgentScanner.NAME_RE.matches("中文"), "非 ASCII 不允许")
    }

    // ============ 内置子代理模型覆盖（agents-state.json 读改写） ============

    private fun stateFile() = File(home, ".zcode/v2/agents-state.json")

    private fun writeState(content: String) {
        File(home, ".zcode/v2").apply { mkdirs() }
        stateFile().writeText(content)
    }

    @Test
    fun `内置子代理清单含两个官方名（Explore 大写 E）`() {
        assertEquals(listOf("general-purpose", "Explore"), AgentScanner.BUILTIN_AGENTS.map { it.name })
    }

    @Test
    fun `无 state 文件时读覆盖为空，写入创建骨架文件并 round-trip`() {
        assertTrue(AgentScanner.builtinModelSelections().isEmpty(), "文件缺失按空处理")
        assertNull(
            AgentScanner.setBuiltInModelSelection(
                "general-purpose",
                AgentScanner.BuiltinModelSelection("account:bigmodel-individual-coding-plan", "GLM-5.4"),
            ),
        )
        assertEquals(
            mapOf(
                "general-purpose" to AgentScanner.BuiltinModelSelection("account:bigmodel-individual-coding-plan", "GLM-5.4"),
            ),
            AgentScanner.builtinModelSelections(),
        )
        // 新文件 = 官方空状态骨架三键 + 该条覆盖；键序与 2 空格缩进都对齐官方写法
        assertEquals(
            """
            {
              "builtInModelSelectionOverrides": {
                "general-purpose": {
                  "providerId": "account:bigmodel-individual-coding-plan",
                  "modelId": "GLM-5.4"
                }
              },
              "pluginAgentModelSelectionOverrides": {},
              "disabledAgentIds": []
            }
            """.trimIndent(),
            stateFile().readText(),
        )
    }

    @Test
    fun `覆盖节点按官方顺序落盘（Explore 在前），后写入的不排在前面`() {
        assertNull(AgentScanner.setBuiltInModelSelection("general-purpose", AgentScanner.BuiltinModelSelection("p1", "m1")))
        assertNull(AgentScanner.setBuiltInModelSelection("Explore", AgentScanner.BuiltinModelSelection("p2", "m2")))
        val overrides = Json.parseToJsonElement(stateFile().readText()).jsonObject["builtInModelSelectionOverrides"]!!.jsonObject
        assertEquals(listOf("Explore", "general-purpose"), overrides.keys.toList())
    }

    @Test
    fun `改模型时整个条目替换，旧条目的 options 不跨模型继承`() {
        writeState(
            """{"builtInModelSelectionOverrides":{"Explore":{"providerId":"p","modelId":"m","options":{"reasoningLevel":"high"}}},""" +
                """"pluginAgentModelSelectionOverrides":{},"disabledAgentIds":[]}""",
        )
        assertNull(AgentScanner.setBuiltInModelSelection("Explore", AgentScanner.BuiltinModelSelection("p", "m2")))
        val entry = Json.parseToJsonElement(stateFile().readText()).jsonObject["builtInModelSelectionOverrides"]!!.jsonObject["Explore"]
        assertEquals("""{"providerId":"p","modelId":"m2"}""", entry.toString())
    }

    @Test
    fun `读覆盖只认两个官方名与合规条目`() {
        writeState(
            """{"builtInModelSelectionOverrides":{"Explore":{"providerId":"p","modelId":"m"},""" +
                """"general-purpose":{"providerId":" ","modelId":"m"},"custom-agent":{"providerId":"p","modelId":"m"}},""" +
                """"pluginAgentModelSelectionOverrides":{},"disabledAgentIds":[]}""",
        )
        assertEquals(
            mapOf("Explore" to AgentScanner.BuiltinModelSelection("p", "m")),
            AgentScanner.builtinModelSelections(),
            "空白 providerId 与非内置名的条目都应忽略",
        )
    }

    @Test
    fun `写覆盖保留其余键与未知键（整体读改写）`() {
        writeState(
            """{"builtInModelSelectionOverrides":{"Explore":{"providerId":"builtin:bigmodel-coding-plan","modelId":"GLM-5.3"}},""" +
                """"pluginAgentModelSelectionOverrides":{"plugin:foo:bar":{"providerId":"p","modelId":"m"}},""" +
                """"disabledAgentIds":["my-agent"],"futureUnknownKey":123}""",
        )
        assertNull(AgentScanner.setBuiltInModelSelection("general-purpose", AgentScanner.BuiltinModelSelection("p2", "m2")))
        val root = Json.parseToJsonElement(stateFile().readText()).jsonObject
        assertEquals(
            listOf("builtInModelSelectionOverrides", "pluginAgentModelSelectionOverrides", "disabledAgentIds", "futureUnknownKey"),
            root.keys.toList(),
            "顶层键与键序原样保留",
        )
        val builtin = root["builtInModelSelectionOverrides"]!!.jsonObject
        assertEquals(2, builtin.size, "既有 Explore 覆盖应保留")
        assertEquals("GLM-5.3", builtin["Explore"]!!.jsonObject["modelId"]!!.jsonPrimitive.content)
        assertEquals(
            "m",
            root["pluginAgentModelSelectionOverrides"]!!.jsonObject["plugin:foo:bar"]!!.jsonObject["modelId"]!!.jsonPrimitive.content,
        )
        assertEquals(listOf("my-agent"), root["disabledAgentIds"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals("123", root["futureUnknownKey"]!!.jsonPrimitive.content, "未知键应原样保留")
    }

    @Test
    fun `selection 为 null 删除 key 恢复继承默认`() {
        writeState("""{"builtInModelSelectionOverrides":{"general-purpose":{"providerId":"p","modelId":"m"},"Explore":{"providerId":"p2","modelId":"m2"}},"pluginAgentModelSelectionOverrides":{},"disabledAgentIds":[]}""")
        assertNull(AgentScanner.setBuiltInModelSelection("general-purpose", null))
        assertEquals(mapOf("Explore" to AgentScanner.BuiltinModelSelection("p2", "m2")), AgentScanner.builtinModelSelections(), "只删目标 key，其余保留")
    }

    @Test
    fun `非法内置名拒绝且不动文件`() {
        val before = stateFile().let { if (it.isFile) it.readText() else null }
        val err = AgentScanner.setBuiltInModelSelection("not-builtin", AgentScanner.BuiltinModelSelection("p", "m"))
        assertTrue(err != null, "应返回错误")
        assertEquals(before, stateFile().let { if (it.isFile) it.readText() else null }, "文件不应被改动")
    }

    @Test
    fun `损坏 state 文件拒绝写入，报错带文件路径（防吞用户数据）`() {
        writeState("{ not valid json !!")
        val err = AgentScanner.setBuiltInModelSelection("general-purpose", AgentScanner.BuiltinModelSelection("p", "m"))
        assertNotNull(err, "损坏文件应拒绝写入")
        assertTrue(err.contains("解析") && err.contains(stateFile().absolutePath), "报错应说明原因并给出文件路径: $err")
        assertEquals("{ not valid json !!", stateFile().readText(), "原文件应原样保留")
    }

    @Test
    fun `disabledAgentIds 不是数组时按空处理（扫描不抛）`() {
        AgentScanner.save("user", sampleDef(), null)
        writeState("""{"disabledAgentIds":"my-agent"}""")
        assertEquals(1, AgentScanner.scan(null).size)
    }

    @Test
    fun `配置了 dataBaseDir 时仍只读写 home 那份（主 app-server 不跟随重定向）`() {
        val redirected = createTempDir("zcode-agent-redirected")
        try {
            // 重定向副本：一份用户级定义 + 一条内置覆盖，都不该被插件看到或改动
            File(redirected, ".zcode/agents").apply { mkdirs() }
            File(redirected, ".zcode/agents/redirected-only.md").writeText(
                "---\nname: \"redirected-only\"\ndescription: \"只在重定向副本\"\n---\n你是重定向副本里的子代理\n",
            )
            val redirectedState = """{"builtInModelSelectionOverrides":{"Explore":{"providerId":"redirected","modelId":"m"}},""" +
                """"pluginAgentModelSelectionOverrides":{},"disabledAgentIds":[]}"""
            File(redirected, ".zcode/v2").apply { mkdirs() }
            File(redirected, ".zcode/v2/agents-state.json").writeText(redirectedState)
            // home 入口的 setting.json 声明重定向
            File(home, ".zcode/v2").apply { mkdirs() }
            File(home, ".zcode/v2/setting.json")
                .writeText("""{"dataBaseDir":"${redirected.absolutePath.replace("\\", "\\\\")}"}""")
            assertNotNull(Credentials.configuredDataBaseDir(), "前置：重定向已生效")

            // 用户级定义：只列 home 的，新建也写到 home
            assertTrue(AgentScanner.scan(null).isEmpty(), "不应列出重定向副本里的定义")
            assertTrue(AgentScanner.save("user", sampleDef(name = "home-agent"), null))
            assertEquals(listOf("home-agent"), AgentScanner.scan(null).map { it.name })
            assertTrue(File(home, ".zcode/agents/home-agent.md").isFile)
            assertFalse(File(redirected, ".zcode/agents/home-agent.md").exists())

            // 内置模型覆盖：读写 home 那份，重定向副本原样不动
            assertTrue(AgentScanner.builtinModelSelections().isEmpty(), "不应读到重定向副本里的覆盖")
            assertNull(AgentScanner.setBuiltInModelSelection("general-purpose", AgentScanner.BuiltinModelSelection("p", "m")))
            assertEquals(
                mapOf("general-purpose" to AgentScanner.BuiltinModelSelection("p", "m")),
                AgentScanner.builtinModelSelections(),
            )
            assertTrue(stateFile().isFile)
            assertEquals(redirectedState, File(redirected, ".zcode/v2/agents-state.json").readText())
        } finally {
            redirected.deleteRecursively()
        }
    }

    // ---- 请求解析（前端 setBuiltInAgentModel 的 selection 元素）----

    @Test
    fun `请求 selection 缺省或为 null 都表示继承默认`() {
        // 回归：显式 null 解析出来是 JsonNull，早先的 `?.jsonObject` 对它直接抛，
        // 「继承默认」端到端失效
        assertEquals(Result.success(null), AgentScanner.BuiltinModelSelection.fromRequest(null))
        assertEquals(Result.success(null), AgentScanner.BuiltinModelSelection.fromRequest(JsonNull))
        assertEquals(
            Result.success(AgentScanner.BuiltinModelSelection("p", "m")),
            AgentScanner.BuiltinModelSelection.fromRequest(Json.parseToJsonElement("""{"providerId":" p ","modelId":"m"}""")),
        )
    }

    @Test
    fun `请求 selection 形状不对判失败，不当成继承默认`() {
        val blank = AgentScanner.BuiltinModelSelection.fromRequest(Json.parseToJsonElement("""{"providerId":"","modelId":"m"}"""))
        assertTrue(blank.isFailure, "providerId 空白应失败")
        val notObject = AgentScanner.BuiltinModelSelection.fromRequest(Json.parseToJsonElement(""""p/m""""))
        assertTrue(notObject.isFailure, "非对象应失败")
        val noModel = AgentScanner.BuiltinModelSelection.fromRequest(Json.parseToJsonElement("""{"providerId":"p"}"""))
        assertTrue(noModel.isFailure, "缺 modelId 应失败")
    }

    // ---- 思考档位（options.reasoningLevel）：运行时对缺档位的条目直接拒绝派生子代理 ----

    @Test
    fun `覆盖条目带档位：写入时落 options 的 reasoningLevel，读回时一并还原`() {
        assertNull(
            AgentScanner.setBuiltInModelSelection(
                "general-purpose",
                AgentScanner.BuiltinModelSelection("p", "m", reasoningLevel = "max"),
            ),
        )
        val entry = Json.parseToJsonElement(stateFile().readText()).jsonObject["builtInModelSelectionOverrides"]!!
            .jsonObject["general-purpose"]!!
        assertEquals("""{"providerId":"p","modelId":"m","options":{"reasoningLevel":"max"}}""", entry.toString())
        assertEquals(
            mapOf("general-purpose" to AgentScanner.BuiltinModelSelection("p", "m", "max")),
            AgentScanner.builtinModelSelections(),
        )
    }

    @Test
    fun `请求 selection 自带档位时原样落盘（只改档位路径）`() {
        assertNull(AgentScanner.setBuiltInModelSelection("general-purpose", AgentScanner.BuiltinModelSelection("p", "m")))
        val request = AgentScanner.BuiltinModelSelection.fromRequest(
            Json.parseToJsonElement("""{"providerId":"p","modelId":"m","options":{"reasoningLevel":"high"}}"""),
        ).getOrThrow()!!
        assertEquals("high", request.reasoningLevel)
        assertNull(AgentScanner.setBuiltInModelSelection("general-purpose", request))
        assertEquals(
            mapOf("general-purpose" to AgentScanner.BuiltinModelSelection("p", "m", "high")),
            AgentScanner.builtinModelSelections(),
        )
    }

    @Test
    fun `选了新模型且请求未带档位：补该模型最高档再落盘`() {
        assertNull(
            AgentScanner.setBuiltInModelSelection("Explore", AgentScanner.BuiltinModelSelection("p", "m")) { modelId ->
                if (modelId == "m") "max" else null
            },
        )
        assertEquals(
            mapOf("Explore" to AgentScanner.BuiltinModelSelection("p", "m", "max")),
            AgentScanner.builtinModelSelections(),
        )
    }

    @Test
    fun `解析不出档位时不写入并报错（不落一条派生必失败的覆盖）`() {
        val before = stateFile().let { if (it.isFile) it.readText() else null }
        val err = AgentScanner.setBuiltInModelSelection("Explore", AgentScanner.BuiltinModelSelection("p", "m")) { null }
        assertNotNull(err, "应返回错误")
        assertTrue(err.contains("思考档位"), "报错应说明原因: $err")
        assertEquals(before, stateFile().let { if (it.isFile) it.readText() else null }, "文件不应被创建或改动")
    }

    @Test
    fun `读覆盖按官方 strict 丢非法条目：多余键、档位非字符串都整条丢弃`() {
        writeState(
            """{"builtInModelSelectionOverrides":{"Explore":{"providerId":"p","modelId":"m","extra":1},""" +
                """"general-purpose":{"providerId":"p","modelId":"m","options":{"reasoningLevel":5}}},""" +
                """"pluginAgentModelSelectionOverrides":{},"disabledAgentIds":[]}""",
        )
        assertTrue(AgentScanner.builtinModelSelections().isEmpty(), "两条都不合规，应全部忽略")
    }
}
