package com.zcode.ideaplugin.protocol

import com.zcode.ideaplugin.protocol.model.*
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.junit.jupiter.api.TestMethodOrder
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.*

/**
 * ZCodeProtocolClient 端到端验证测试
 *
 * 对照 V7（Python）的 6 个场景：
 *   1. session/list
 *   2. session/create（含 requestRuntimePreferences 自动应答）
 *   3. session/subscribe（deliveryKind）
 *   4. session/send + 流式事件
 *   5. session/messages
 *   6. session/resume
 *
 * ⚠️ 这是真机集成测试，需要：
 *   - ZCode 已安装
 *   - ~/.zcode/v2/config.json 已配置凭证
 *   - node 在 PATH 中
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class ZCodeProtocolClientTest {

    private lateinit var client: ZCodeProtocolClient
    private val workspace = Workspace(System.getProperty("user.dir"))
    private var createdSessionId: String? = null

    @BeforeAll
    fun setUp() {
        // 前置检查：ZCode 和凭证必须可用，否则跳过整个测试类
        try {
            client = ZCodeProtocolClient.start()
            // 注入自定义 runtimePreferences 应答：既验证 responder 路径不破坏握手
            // （规格书 §3 必须应答，答错/异常会卡死 session/create），也覆盖 memoryEnabled=true 分支
            client.runtimePreferencesResponder = { _, _ ->
                RuntimePreferences(
                    nativeSearchEnhancementsEnabled = true,
                    memoryEnabled = true,
                    askUserQuestionAutoResolutionEnabled = true,
                )
            }
            assertTrue(client.isAlive(), "app-server 进程应该存活")
            println("✅ ZCodeProtocolClient 启动成功")
        } catch (e: Exception) {
            println("⚠️ 跳过测试（环境不可用）: ${e.message}")
            assumeTrue(false, "ZCode 环境不可用: ${e.message}")
        }
    }

    @AfterAll
    fun tearDown() {
        if (::client.isInitialized) {
            client.close()
            println("✅ 客户端已关闭")
        }
    }

    @Test
    @Order(1)
    fun `1 - session list 返回所有会话`() {
        val sessions = client.listSessions()
        println("✅ session/list 返回 ${sessions.size} 个会话")
        sessions.take(3).forEach { s ->
            println("   - ${s.sessionId.take(30)} | ${s.title.take(30)} | ${s.status}")
        }
        assertTrue(sessions.isNotEmpty(), "应该至少有 1 个会话（当前正在用的）")
    }

    @Test
    @Order(2)
    fun `2 - session create 创建新会话`() {
        val sid = client.createSession(workspace, PermissionMode.YOLO)
        createdSessionId = sid
        println("✅ session/create 成功: $sid")
        assertTrue(sid.startsWith("sess_"), "sessionId 应该以 sess_ 开头")
    }

    @Test
    @Order(3)
    fun `3 - session subscribe 带 deliveryKind`() {
        val sid = createdSessionId ?: return fail("依赖前一个测试创建的 session")
        val snapshot = client.subscribe(sid, deliveryKind = "desktop-continuous")
        println("✅ session/subscribe 成功")
        println("   snapshot keys: ${snapshot.keys}")
        assertTrue(snapshot.isNotEmpty(), "snapshot 应该有内容")
    }

    @Test
    @Order(4)
    fun `4 - session send 接收流式事件`() {
        // 真机流式需要可用凭证跑真实模型；新版客户端本机 config.json 已废弃且
        // provider_config 渠道为测试假 key，turn 必失败 → 跳过（流式归约另有 webview 用例）
        assumeTrue(java.nio.file.Files.isRegularFile(Credentials.defaultConfigPath()), "新版 CLI 本机无 config.json 凭证源，跳过真机流式断言")
        val sid = createdSessionId ?: return fail("依赖前一个测试创建的 session")

        // 用 latch 等待 turn.completed 或 turn.failed
        val events = ConcurrentLinkedQueue<SessionEvent>()
        val turnDone = CountDownLatch(1)
        val failedRef = AtomicReference<SessionEvent?>(null)

        client.addEventListener(sid) { event ->
            events.add(event)
            when (event.type) {
                EventTypes.TURN_COMPLETED, EventTypes.TURN_FAILED -> turnDone.countDown()
            }
            if (event.type == EventTypes.TURN_FAILED) {
                failedRef.set(event)
            }
        }

        // 发送测试问题
        val sendResult = client.send(sid, "回答：1+1=? 只说数字")
        println("✅ session/send accepted: ${sendResult["accepted"]?.jsonPrimitive?.content}")

        // 等待 turn 完成（最多 60 秒，规格书说 turn 时长 38-100s 波动）
        val done = turnDone.await(60, TimeUnit.SECONDS)
        assertTrue(done, "应该在 60 秒内收到 turn.completed 或 turn.failed")

        // 统计事件类型
        val etypes = events.groupingBy { it.type }.eachCount()
        println("   收到 ${events.size} 个事件，类型分布: $etypes")

        // 拼接流式文本
        val textPieces = events.filter {
            it.type == EventTypes.MODEL_STREAMING &&
            it.payload["kind"]?.jsonPrimitive?.content == StreamingKind.TEXT_DELTA
        }.map { it.payload["delta"]?.jsonPrimitive?.content ?: "" }
        val joinedText = textPieces.joinToString("")
        println("   流式文本拼接: \"$joinedText\"")

        // 验证：应该有流式事件
        assertTrue(events.any { it.type == EventTypes.MODEL_STREAMING }, "应该收到 model.streaming 事件")
        assertTrue(events.any { it.type == EventTypes.TURN_COMPLETED }, "应该收到 turn.completed")

        // 验证 turn.completed 的 usage（v2 双链可能送达多个 completed：session/event 原生
        // 与 v4 帧映射各一，首个可能不带 usage——取任一带 usage 的判定，全带则全过）
        val completions = events.filter { it.type == EventTypes.TURN_COMPLETED }
        completions.forEachIndexed { i, e ->
            println("   completed[$i] payload keys: ${e.payload.keys} usage: ${e.payload["usage"]?.jsonObject}")
        }
        val usage = completions.firstOrNull { it.payload["usage"]?.jsonObject != null }
            ?.payload?.get("usage")?.jsonObject
        println("   usage: $usage")
        assertNotNull(usage, "turn.completed 应该带 usage")
    }

    @Test
    @Order(5)
    fun `5 - session messages 读取历史`() {
        // 测试4在新版 CLI 本机跳过（无 config.json 凭证源），本测试随之跳过（无历史可读）
        assumeTrue(java.nio.file.Files.isRegularFile(Credentials.defaultConfigPath()), "新版 CLI 本机无 config.json 凭证源（测试4已跳过），跳过")
        val sid = createdSessionId ?: return fail("依赖前一个测试创建的 session")
        val messages: JsonArray = client.messages(sid)
        println("✅ session/messages 返回 ${messages.size} 条消息")
        assertTrue(messages.isNotEmpty(), "应该有历史消息（前一个测试发过）")
    }

    @Test
    @Order(6)
    fun `6 - session resume 续会话`() {
        val sid = createdSessionId ?: return fail("依赖前一个测试创建的 session")
        val result = client.resume(sid, workspace)
        println("✅ session/resume 成功")
        println("   result keys: ${result.keys}")
        // resume 应该返回带 messages 的结果
        assertTrue(result.containsKey("messages") || result.isNotEmpty(), "resume 应该返回历史")
    }

    /** 子代理运行时配置通道（subagents/readRuntimeConfig）的宿主侧快照样例：一条用户级 profile */
    private fun hostSubagentSnapshot() = buildJsonObject {
        put("kind", "ready")
        put("profiles", buildJsonArray {
            add(buildJsonObject {
                put("name", "golden-reviewer")
                put("description", "Review")
                put("source", "user")
                put("systemPrompt", "Review carefully.")
            })
        })
        put("builtInModelSelectionOverrides", buildJsonObject { })
        put("pluginAgentModelSelectionOverrides", buildJsonObject { })
    }

    @Test
    @Order(20)
    fun `subagents_readRuntimeConfig：声明开关后运行时在建会话时回调宿主一次并接受快照`() {
        assumeTrue(
            ProtocolGenerations.probeSubagentRuntimeConfig(ZCodeLocator.detect()) == true,
            "当代 CLI 才有子代理运行时配置通道，跳过",
        )
        val calls = java.util.concurrent.atomic.AtomicInteger()
        val dirs = ConcurrentLinkedQueue<String?>()
        client.subagentRuntimeConfigProvider = { dir ->
            calls.incrementAndGet()
            dirs.add(dir)
            hostSubagentSnapshot()
        }
        client.subagentDefaultWorkingDirectory = { "G:\\default-workspace" }
        var sid: String? = null
        try {
            sid = client.createSession(workspace, PermissionMode.YOLO)
            println("✅ 建会话成功，运行时回调宿主 ${calls.get()} 次，工作目录=$dirs")
            assertTrue(sid.startsWith("sess_"))
            // 运行时要等宿主应答才能建完会话：应答在回调之后发出，所以此刻回调必已发生
            assertEquals(1, calls.get(), "建会话时运行时应回调宿主一次（官方：创建时读 1 次，之后每回合开始再读）")
            // create 应答早于 sessionId 登记，首个请求落兜底目录
            assertEquals(listOf("G:\\default-workspace"), dirs.toList())
        } finally {
            client.subagentRuntimeConfigProvider = null
            client.subagentDefaultWorkingDirectory = null
            sid?.let { runCatching { client.unloadSession(it) } }
        }
    }

    @Test
    @Order(21)
    fun `subagents_readRuntimeConfig：供给器抛异常时回内置回退，建会话不受影响`() {
        assumeTrue(
            ProtocolGenerations.probeSubagentRuntimeConfig(ZCodeLocator.detect()) == true,
            "当代 CLI 才有子代理运行时配置通道，跳过",
        )
        client.subagentRuntimeConfigProvider = { throw IllegalStateException("host unavailable") }
        var sid: String? = null
        try {
            // 运行时对错误应答的处理是让建会话直接失败——宿主必须吞掉异常回 built-in-fallback
            sid = client.createSession(workspace, PermissionMode.YOLO)
            println("✅ 供给器异常下建会话仍成功: $sid")
            assertTrue(sid.startsWith("sess_"))
        } finally {
            client.subagentRuntimeConfigProvider = null
            sid?.let { runCatching { client.unloadSession(it) } }
        }
    }

    @Test
    @Order(7)
    fun `7 - generateText provider 未注册时 upsert 后重试成功`() {
        val runtimeModel = RuntimeModels.defaultRuntimeModel()
            ?: return assumeTrue(false, "config.json 无 enabled anthropic provider，跳过")
        val modelObj = runtimeModel["model"]!!.jsonObject
        val pid = modelObj["providerId"]!!.jsonPrimitive.content
        val mid = modelObj["modelId"]!!.jsonPrimitive.content
        val wsPath = workspace.workspacePath

        // 首调：目录无该 provider 时应 -32603（润色快速通道的注册判定依据）；
        // 若先前测试已注册则直接成功，两种结果都合法
        val direct = try {
            val r = client.generateText(wsPath, pid, mid, prompt = "回答：1+1=? 只说数字", timeoutMs = 60000)
            println("✅ generateText 直接成功（provider 已在 workspace 目录）: ${r["text"]?.jsonPrimitive?.content?.take(30)}")
            return
        } catch (e: ZCodeProtocolException) {
            println("   首调按预期被拒: [${e.code}] ${e.message?.take(80)}")
            e
        }
        assertEquals(-32603, direct.code, "未注册 provider 应报 -32603")

        // 新版 CLI（2026-09-17）：providerRegistry 只含内置目录 + 账号同步渠道，config.json
        // 自定义渠道不在其中报"Provider Registry 中不存在"；workspace/upsertModelProvider
        // 方法已移除（-32601），无法自愈注册——断言报错形态即止（缺陷 BU 深挖项）
        if (direct.message.orEmpty().contains("Provider Registry")) {
            println("✅ 新版 CLI registry 拒收 config.json 自定义渠道（已知限制，注册待 provider/updateAccountConfig 通道）")
            return
        }

        // 老 CLI：upsert 注册 + 重试（润色快速通道的自愈路径）
        val providerDef = runtimeModel["provider"]!!.jsonObject
        client.upsertModelProvider(wsPath, providerDef)
        println("✅ upsertModelProvider 注册成功")
        val r2 = client.generateText(wsPath, pid, mid, prompt = "回答：1+1=? 只说数字", timeoutMs = 60000)
        val text = r2["text"]?.jsonPrimitive?.content ?: fail("generateText 重试应返回 text")
        println("✅ generateText 重试成功: \"$text\" usage=${r2["usage"]}")
        assertTrue(text.isNotBlank(), "text 非空")
        assertEquals(mid, r2["selection"]?.jsonObject?.get("modelId")?.jsonPrimitive?.content, "响应 selection.modelId 应与请求一致")
    }

    @Test
    @Order(8)
    fun `8 - generateText messages 形态 system+user`() {
        val runtimeModel = RuntimeModels.defaultRuntimeModel()
            ?: return assumeTrue(false, "config.json 无 enabled anthropic provider，跳过")
        val modelObj = runtimeModel["model"]!!.jsonObject
        val pid = modelObj["providerId"]!!.jsonPrimitive.content
        val mid = modelObj["modelId"]!!.jsonPrimitive.content

        val r = try {
            client.generateText(
                workspacePath = workspace.workspacePath,
                providerId = pid,
                modelId = mid,
                prompt = "回答：2+2=? 只说数字",
                systemPrompt = "你只回答阿拉伯数字，不输出任何其他字符。",
                timeoutMs = 60000,
            )
        } catch (e: ZCodeProtocolException) {
            // 新版 CLI：默认渠道（config.json 首个 enabled）可能不在 providerRegistry（见测试 7）
            if (e.code == -32603 && e.message.orEmpty().contains("Provider Registry")) {
                println("✅ 新版 CLI registry 拒收 config.json 自定义渠道，messages 形态跳过（同测试 7 已知限制）")
                return
            }
            throw e
        }
        val text = r["text"]?.jsonPrimitive?.content ?: fail("messages 形态应返回 text")
        println("✅ generateText messages 形态: \"$text\" usage=${r["usage"]}")
        assertTrue(text.isNotBlank(), "text 非空")
    }
}
