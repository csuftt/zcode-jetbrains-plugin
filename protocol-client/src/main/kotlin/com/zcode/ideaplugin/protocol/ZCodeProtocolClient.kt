package com.zcode.ideaplugin.protocol

import com.zcode.ideaplugin.protocol.model.*
import kotlinx.serialization.json.*
import java.io.BufferedReader
import java.io.File
import java.io.IOException
import java.io.PrintWriter
import java.nio.file.Path
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicLong

/**
 * ZCode Protocol 客户端
 *
 * 严格按 zcode-protocol-spec-0.16.1.md 实现。对应 V7 的 Python 客户端，但用 Kotlin 重写。
 *
 * 使用方式：
 * ```
 * val client = ZCodeProtocolClient.start()
 * val sessions = client.listSessions()
 * val sid = client.createSession(Workspace("G:/work"))
 * client.subscribe(sid) { event -> println("Event received: ${event.type}") }
 * client.send(sid, "你好")
 * client.close()
 * ```
 *
 * 关键约束（规格书）：
 * 1. 信封不带 jsonrpc 字段
 * 2. session/create 后必须应答 requestRuntimePreferences
 * 3. session/subscribe 必须带 deliveryKind
 * 4. session/send 用 content 字段（不是 message）
 * 5. 先 subscribe 再 send，否则丢事件
 */
class ZCodeProtocolClient private constructor(
    private val process: Process,
    private val stdin: PrintWriter,
    private val stdout: BufferedReader,
    private val zcodePath: java.nio.file.Path,
    private val nodePath: String,
    /** 可空：config.json 无明文凭证（oauth 登录）时不注入 env，由 app-server 自身凭证链接管 */
    private val credentials: com.zcode.ideaplugin.protocol.ZCodeCredentials?
) : AutoCloseable {

    private val json = Json { ignoreUnknownKeys = true }

    /** app-server 会话库（session/list 数据源；删除、旧归档迁移直写） */
    private val cliDbPath = Path.of(System.getProperty("user.home"), ".zcode", "cli", "db", "db.sqlite")

    /** ZCode 客户端任务索引（归档/恢复与客户端共写同一数据源，见 TaskIndexStore） */
    val taskIndex = TaskIndexStore(nodePath, Path.of(System.getProperty("user.home"), ".zcode", "v2", "tasks-index.sqlite"))

    // 请求 ID 生成器
    private val idCounter = AtomicLong(0)

    // 等待响应的 future（按 id 路由）
    private val pendingResponses = ConcurrentHashMap<Long, CompletableFuture<JsonObject>>()

    /**
     * 反向请求异步处理池（requestUserInput/requestPermission/browserList/browserExecute 共用）。
     * handler 会阻塞等用户选择或浏览器操作，绝不能卡 reader 线程；cached 池 60s 回收
     * 空闲线程并复用——替代此前每请求裸建 Thread（弹窗风暴/子代理并行时无上限累积）。
     */
    private val reverseRequestExecutor = java.util.concurrent.ThreadPoolExecutor(
        0, Int.MAX_VALUE, 60L, TimeUnit.SECONDS,
        java.util.concurrent.SynchronousQueue()
    ) { r -> Thread(r).apply { isDaemon = true; name = "zcode-reverse-req" } }

    // session/event 订阅者（按 sessionId 路由）
    private val eventListeners = ConcurrentHashMap<String, MutableSet<(SessionEvent) -> Unit>>()

    // 全局事件监听器（所有 session）
    private val globalListeners = ConcurrentHashMap.newKeySet<(SessionEvent) -> Unit>()

    // ============ v4 会话协议（子会话实时流根治通道） ============

    /** 连接级 connectionId：一次生成全程复用（同一 connection 可订阅多个 topic） */
    private val v4ConnectionId = "zcode-idea-plugin-${java.util.UUID.randomUUID()}"

    /** 已 v4 订阅的会话（幂等去重；帧到达时也以此为门禁，未订阅会话的帧不映射） */
    private val v4SubscribedSessions = ConcurrentHashMap.newKeySet<String>()

    /** 帧到达计数（[V4FrameProbe] 诊断，见 handleNotification 的 v4/conversation/frame 分支） */
    private val v4FrameProbe = ConcurrentHashMap<String, Long>()

    /** v4 增量帧 → legacy SessionEvent 映射（行表等状态集中此处，v4 面演进只改一类） */
    private val v4FrameMapper = V4FrameMapper()

    // 运行时偏好应答策略：memoryEnabled 决定 MEMORY.md 自动记忆是否注入会话上下文
    // （宿主答 false 时 CLI 强制 memory:{enabled:false}）。默认 SAFE_DEFAULT（全 false），
    // 宿主可注入真实配置。在 reader 线程同步调用，实现必须快（本地小文件读取级别）
    @Volatile
    var runtimePreferencesResponder: (sessionId: String, scope: String) -> RuntimePreferences =
        { _, _ -> RuntimePreferences.SAFE_DEFAULT }

    // 用户输入请求处理器（AskUserQuestion 等需要用户交互的工具）
    // 返回应答 result（JsonObject），由调用方决定怎么拿到用户输入
    @Volatile
    var userInputRequestHandler: ((serverRequestId: String, params: JsonObject) -> JsonObject)? = null

    /**
     * 工具权限审批请求处理器（interaction/requestPermission）：default（"变更前询问"）
     * 等模式下文件写入/命令执行前 app-server 反向请求宿主批准。返回应答 result，
     * 形状 = {decision:"allow"|"deny"|"escalate"|"modify", reason?, modifiedInput?,
     * permissionUpdates?}（zcode.cjs S2 schema，strict——多余字段校验失败）。
     * 在独立线程调用，可安全阻塞（等待用户点击弹窗）。
     */
    @Volatile
    var permissionRequestHandler: ((serverRequestId: String, params: JsonObject) -> JsonObject)? = null

    /**
     * 宿主浏览器清单（interaction/browserList）：返回 {browsers:[...]}；
     * null / 未注册时自动应答空列表（app-server 侧 browser-use 优雅降级为不可用）。
     * 详见 docs/设计与调研/browser-use宿主协议接入设计.md
     */
    var browserListHandler: (() -> JsonObject)? = null

    /**
     * 宿主浏览器命令执行（interaction/browserExecute）：params 为请求参数
     * （含 command），返回 execute result。在独立线程调用，可安全阻塞（截图/导航有耗时）。
     */
    var browserExecuteHandler: ((params: JsonObject) -> JsonObject)? = null

    // -32031 恢复用的 runtimeModel 构造器（默认读 config.json 的 enabled provider；测试可注入）
    @Volatile
    var runtimeModelFactory: () -> JsonObject? = { RuntimeModels.defaultRuntimeModel() }

    /**
     * 后端模型 API 错误回调（stderr 的 APICallError dump 解析结果，见 BackendErrorDetector）。
     * 场景：429 配额超限等被 app-server 按可重试分类持续退避，turn 终止帧迟迟不发，
     * 事件流上无错误迹象——stderr 是唯一的第一现场。在 stderr 线程调用。
     */
    @Volatile
    var backendErrorHandler: ((BackendErrorDetector.BackendApiError) -> Unit)? = null

    // 进程是否还活着
    @Volatile
    private var closed = false

    // ============ 启动方式 ============

    companion object {
        /**
         * 启动 ZCode app-server 子进程并连接
         *
         * @param zcodePath zcode.cjs 路径（默认自动探测）
         * @param credentials 凭证（默认从 ~/.zcode/v2/config.json 读；null = 无明文凭证，
         *   不注入 env，app-server 用自身凭证链——cli/config.json 的 provider 注册）
         * @param nodePath node 可执行文件路径（默认从 PATH 找）
         */
        fun start(
            zcodePath: Path = ZCodeLocator.detect(),
            credentials: ZCodeCredentials? = Credentials.loadOrNull(),
            nodePath: String = findNode()
        ): ZCodeProtocolClient {
            val env = (System.getenv() + (credentials?.toEnvMap() ?: emptyMap())).toMutableMap()

            val pb = ProcessBuilder(nodePath, zcodePath.toString(), "app-server")
            pb.environment().clear()
            pb.environment().putAll(env)
            pb.redirectErrorStream(false)

            val process = pb.start()
            val stdin = PrintWriter(process.outputStream.bufferedWriter(), true)
            val stdout = process.inputStream.bufferedReader()

            val client = ZCodeProtocolClient(process, stdin, stdout, zcodePath, nodePath, credentials)
            // ⚠️ 必须 drain stderr！Windows 管道缓冲约 4KB，node 写 stderr 是同步阻塞的。
            // 模型调用失败时 app-server 会向 stderr 打错误堆栈，一次就可能填满缓冲；
            // 无人读 → node 永久阻塞在写 stderr → 整个 app-server 事件循环停摆，
            // 症状为所有协议请求超时（进程 alive 但不响应）。
            val stderr = process.errorStream.bufferedReader()
            val backendErrorDetector = BackendErrorDetector()
            Thread({
                try {
                    stderr.forEachLine { line ->
                        System.err.println("[app-server stderr] ${LogRedactor.redact(line)}")
                        // 模型 API 错误兜底：429 配额超限等被 app-server 按可重试分类退避重试，
                        // turn 终止帧迟迟不发（UI 无限转圈无提示），stderr dump 是错误第一现场
                        backendErrorDetector.feed(line)?.let { err ->
                            println("[ZCodeProtocolClient] Backend API error detected: statusCode=${err.statusCode} code=${err.code}")
                            client.backendErrorHandler?.invoke(err)
                        }
                    }
                } catch (e: IOException) {
                    // 进程退出时管道关闭，属正常
                }
            }, "zcode-appserver-stderr").apply {
                isDaemon = true
                start()
            }
            // 启动 reader 线程（在 client 创建之后，因为 readLoop 是 client 的成员）
            Thread({ client.readLoop() }, "zcode-protocol-reader").apply {
                isDaemon = true
                start()
            }
            return client
        }

        /** 从 PATH 找 node */
        private fun findNode(): String {
            val os = System.getProperty("os.name").lowercase()
            val names = if (os.contains("win")) listOf("node.exe", "node") else listOf("node")
            for (name in names) {
                val path = System.getenv("PATH")
                    ?.split(if (os.contains("win")) ";" else ":")
                    ?.map { Path.of(it).resolve(name) }
                    ?.firstOrNull { it.toFile().exists() }
                if (path != null) return path.toString()
            }
            throw IllegalStateException("找不到 node，请确认 Node.js 已安装并在 PATH 中")
        }
    }

    // ============ Reader 线程：按行读 stdout 并分发 ============

    private fun readLoop() {
        try {
            println("[ZCodeProtocolClient] readLoop started, listening on app-server stdout")
            var lineCount = 0
            while (!closed) {
                val line = stdout.readLine() ?: break
                if (line.isBlank()) continue
                lineCount++

                val msg = try {
                    Json.parseToJsonElement(line).jsonObject
                } catch (e: Exception) {
                    // 非 JSON 行（app-server 偶发日志），转发到 stderr 便于排查而不是静默丢弃
                    System.err.println("[app-server stdout] ${LogRedactor.redact(line)}")
                    continue
                }

                dispatchMessage(msg)
            }
        } catch (e: IOException) {
            if (!closed) {
                // 进程异常退出
                System.err.println("[ZCodeProtocolClient] reader error: ${e.message}")
            }
        }
    }

    private fun dispatchMessage(msg: JsonObject) {
        val id = msg["id"]
        val method = msg["method"]?.jsonPrimitive?.jsonStringOrNull
        val hasResult = msg.containsKey("result")
        val hasError = msg.containsKey("error")

        when {
            // 是对客户端请求的响应（id 是数字）
            id != null && (hasResult || hasError) && id.toString().trim('"').toLongOrNull() != null -> {
                val idLong = id.jsonPrimitive.content.toLong()
                pendingResponses.remove(idLong)?.complete(msg)
            }
            // 是服务器的反向请求（id 是 "server-N" 字符串）
            id != null && method != null && id.jsonPrimitive.jsonStringOrNull?.startsWith("server") == true -> {
                handleServerRequest(msg)
            }
            // 是通知（session/event 等）
            method != null && id == null -> {
                // 诊断：确认通知到达 dispatchMessage
                if (method == "session/event") {
                    println("[ZCodeProtocolClient] dispatchMessage: session/event notification arrived, forwarding to handleNotification")
                }
                handleNotification(method, msg["params"]?.jsonObject ?: JsonObject(emptyMap()))
            }
            else -> {
                // 未知消息类型（可能是带 id 的通知？打印诊断）
                println("[ZCodeProtocolClient] dispatchMessage: unknown message type id=$id method=$method keys=${msg.keys}")
            }
        }
    }

    /** 处理服务器的反向请求（自动应答 requestRuntimePreferences） */
    private fun handleServerRequest(msg: JsonObject) {
        val method = msg["method"]?.jsonPrimitive?.jsonStringOrNull ?: return
        val id = msg["id"]?.jsonPrimitive?.jsonStringOrNull ?: return
        val params = msg["params"]?.jsonObject ?: JsonObject(emptyMap())

        if (method == "session/requestRuntimePreferences") {
            // 规格书 §3：必须应答，否则卡死。responder 异常时兜底 SAFE_DEFAULT（不答就永久卡死）
            val prefs = try {
                val sid = params["sessionId"]?.jsonPrimitive?.jsonStringOrNull ?: ""
                val scope = params["scope"]?.jsonPrimitive?.jsonStringOrNull ?: ""
                runtimePreferencesResponder(sid, scope)
            } catch (e: Exception) {
                System.err.println("[ZCodeProtocolClient] runtimePreferencesResponder error (${e.javaClass.simpleName}): ${e.message}, falling back to SAFE_DEFAULT")
                RuntimePreferences.SAFE_DEFAULT
            }
            respondToServer(id, buildJsonObject {
                put("nativeSearchEnhancementsEnabled", prefs.nativeSearchEnhancementsEnabled)
                put("memoryEnabled", prefs.memoryEnabled)
                put("askUserQuestionAutoResolutionEnabled", prefs.askUserQuestionAutoResolutionEnabled)
            })
        }
        else if (method == "interaction/requestUserInput") {
            // AskUserQuestion：需要用户交互，交给 handler 处理
            // ⚠️ 必须异步处理！handler 会阻塞等用户选择，不能卡 reader 线程
            println("[ZCodeProtocolClient] interaction/requestUserInput received, dispatching to async handler")
            val handler = userInputRequestHandler
            if (handler != null) {
                reverseRequestExecutor.execute {
                    try {
                        respondInteractiveAnswer(id, handler(id, params))
                        println("[ZCodeProtocolClient] interaction/requestUserInput answered")
                    } catch (e: Exception) {
                        // 带异常类名：TimeoutException/InterruptedException 的 message 为 null，
                        // 只打 message 会显示"异常: null"无法定位（panel 端已自行处理超时/中断，
                        // 走到这里的是真正的意外错误）
                        println("[ZCodeProtocolClient] interaction/requestUserInput handler error (${e.javaClass.simpleName}): ${e.message}")
                        respondToServer(id, buildJsonObject { put("action", "decline") })
                    }
                }
            } else {
                println("[ZCodeProtocolClient] no userInputRequestHandler registered, auto-declining")
                respondToServer(id, buildJsonObject { put("action", "decline") })
            }
        }
        // 工具权限审批（interaction/requestPermission）：default（"变更前询问"）模式下
        // 写文件/执行命令前的批准请求。未实现时旧版落入"未知反向请求"回 -32601，
        // app-server 侧 requestClient 抛错 → 工具按拒绝处理 → AI 反复重试直至放弃
        // （issue #2）。异步执行，与 requestUserInput 同理禁止阻塞 reader 线程
        else if (method == "interaction/requestPermission") {
            val handler = permissionRequestHandler
            if (handler != null) {
                reverseRequestExecutor.execute {
                    try {
                        respondInteractiveAnswer(id, handler(id, params))
                    } catch (e: Exception) {
                        println("[ZCodeProtocolClient] interaction/requestPermission handler error (${e.javaClass.simpleName}): ${e.message}")
                        respondToServer(id, buildJsonObject {
                            put("decision", "deny")
                            put("reason", "Handler error: ${e.message ?: e.javaClass.simpleName}")
                        })
                    }
                }
            } else {
                println("[ZCodeProtocolClient] no permissionRequestHandler registered, denying")
                respondToServer(id, buildJsonObject {
                    put("decision", "deny")
                    put("reason", "No permission handler")
                })
            }
        }
        // 体验套餐(zcode-plan 网关)模型请求前的运行时 headers 刷新（携带滑块验证 param）。
        // 插件无法完成人机验证，如实应答 headersApplied=false：服务端在 prepare 阶段
        // 快速失败，errorMessage 原文进入 turn.failed detail（2026-08-28 实测）——替代
        // 此前落入 -32601 兜底的 ZodError 校验崩溃（用户只见 "Model request failed."）
        else if (method == "interaction/requestProviderRuntimeHeaders") {
            respondToServer(id, buildJsonObject {
                put("headersApplied", false)
                put("errorMessage", "host plugin cannot provide captcha verify param " +
                    "(zcode-plan gateway requires human verification; switch to a non-zcode-plan model)")
            })
        }
        // 宿主浏览器反向请求（browser-use）：异步执行——navigate/screenshot 可能秒级耗时，
        // 与 requestUserInput 同理禁止阻塞 reader 线程
        else if (method == "interaction/browserList") {
            val handler = browserListHandler
            if (handler != null) {
                reverseRequestExecutor.execute {
                    try {
                        respondToServer(id, handler())
                    } catch (e: Exception) {
                        println("[ZCodeProtocolClient] browserList handler error (${e.javaClass.simpleName}): ${e.message}")
                        respondToServer(id, error = ProtocolError(ErrorCodes.INTERNAL_ERROR, "browserList 失败: ${e.message}"))
                    }
                }
            } else {
                // 无宿主浏览器能力：空列表（协议允许，browser-use 按不可用降级）
                respondToServer(id, buildJsonObject { put("browsers", JsonArray(emptyList())) })
            }
        }
        else if (method == "interaction/browserExecute") {
            val handler = browserExecuteHandler
            if (handler != null) {
                reverseRequestExecutor.execute {
                    try {
                        respondToServer(id, handler(params))
                    } catch (e: Exception) {
                        println("[ZCodeProtocolClient] browserExecute handler error (${e.javaClass.simpleName}): ${e.message}")
                        respondToServer(id, error = ProtocolError(ErrorCodes.INTERNAL_ERROR, "browserExecute 失败: ${e.message}"))
                    }
                }
            } else {
                respondToServer(id, error = ProtocolError(ErrorCodes.METHOD_NOT_FOUND, "宿主未注册 browserExecuteHandler"))
            }
        }
        // 其他未知反向请求：回 -32601 避免空等
        else {
            respondToServer(id, error = ProtocolError(ErrorCodes.METHOD_NOT_FOUND, "未实现的反向请求: $method"))
        }
    }

    /**
     * 交互类反向请求（requestUserInput/requestPermission）的应答分发：
     * 宿主返回废弃哨兵（回合终止废弃，宿主层 DISCARD_MARKER 同名字段）时改发
     * JSON-RPC error——服务端按请求失败处理，不会被误读为"用户拒绝"；
     * 正常应答原样透传。
     */
    private fun respondInteractiveAnswer(id: String, result: JsonObject) {
        if (result.containsKey("__zcodeDiscard")) {
            respondToServer(id, error = ProtocolError(ErrorCodes.INTERNAL_ERROR, "request discarded: turn ended"))
        } else {
            respondToServer(id, result)
        }
    }

    /** 处理通知 */
    private fun handleNotification(method: String, params: JsonObject) {
        if (method == "session/event") {
            val event = SessionEvent.fromNotification(params)
            // 诊断：确认事件到达 + sessionId 匹配
            val registered = eventListeners.keys
            println("[ZCodeProtocolClient] session/event received: type=${event.type} sessionId=${event.sessionId} registeredSessions=${registered}")
            // 通知该 session 的监听器
            val listeners = eventListeners[event.sessionId]
            println("[ZCodeProtocolClient] matched ${listeners?.size ?: 0} listener(s)")
            listeners?.forEach { it(event) }
            // 通知全局监听器
            globalListeners.forEach { it(event) }
        }
        // state.updated：模式/思考级别/模型变化推送（含 ZCode 自动进出计划模式）
        // params = {type:"state.updated", reason:"mode_changed"|..., revision, scope:"session",
        //           sessionId, workspace, patch:{mode, thoughtLevel, model, permission}}
        else if (method == "state.updated") {
            val sid = params["sessionId"]?.jsonPrimitive?.jsonStringOrNull ?: return
            val reason = params["reason"]?.jsonPrimitive?.jsonStringOrNull ?: ""
            // 诊断：模式切换（含 ExitPlanMode 审批后退出 plan）依赖此事件的 patch.mode.current，
            // 记录 reason + patch 便于排查"模式切不回"
            println("[ZCodeProtocolClient] state.updated: reason=$reason patch=${LogRedactor.redact(params["patch"].toString())}")
            val event = SessionEvent(
                type = "state.updated",
                seq = params["revision"]?.jsonPrimitive?.longOrNull ?: 0L,
                sessionId = sid,
                timestamp = System.currentTimeMillis(),
                traceId = null,
                turnId = null,
                deliveryKind = null,
                payload = buildJsonObject {
                    put("reason", reason)
                    params["patch"]?.let { put("patch", it) }
                }
            )
            eventListeners[sid]?.forEach { it(event) }
            globalListeners.forEach { it(event) }
        }
        // v4/conversation/frame：v4 订阅会话的增量帧（子会话实时流根治通道）。
        // topic=conversation/<sessionId>；只对主动 v4 订阅过的会话映射，防与 legacy 流双写
        else if (method == "v4/conversation/frame") {
            val topic = params["topic"]?.jsonPrimitive?.jsonStringOrNull ?: return
            val sid = topic.removePrefix("conversation/")
            if (sid.length == topic.length || sid !in v4SubscribedSessions) return
            val frame = params["frame"]?.jsonObject ?: return
            // 帧到达诊断（缺陷AO 终测：live 在快照后停更——区分"服务端没推帧"vs
            // "帧到了没渲染"）：每会话首帧 + 每 20 帧打一条计数（STDOUT → idea.log）
            val n = v4FrameProbe.merge(sid, 1L, Long::plus)
            if (n != null && (n == 1L || n % 20L == 0L)) {
                val pk = frame["payload"]?.jsonObject?.get("kind")?.jsonPrimitive?.jsonStringOrNull ?: "?"
                println("[V4FrameProbe] $sid frame#$n payload=$pk")
            }
            val events = try {
                v4FrameMapper.mapFrame(sid, frame)
            } catch (e: Exception) {
                System.err.println("[ZCodeProtocolClient] v4 frame map error (frame dropped): ${e.javaClass.simpleName}: ${e.message}")
                return
            }
            for (ev in events) dispatchSessionEvent(ev)
        }
        // v4/telemetry/event 等暂不处理
    }

    /** 会话事件统一分发：per-session 监听器 + 全局监听器（session/event 与 v4 映射共用出口） */
    private fun dispatchSessionEvent(event: SessionEvent) {
        eventListeners[event.sessionId]?.forEach { it(event) }
        globalListeners.forEach { it(event) }
    }

    // ============ 底层发送 ============

    /** 发送客户端请求并等待响应 */
    private fun request(method: String, params: JsonObject, timeoutMs: Long = 20000): JsonObject {
        val id = idCounter.incrementAndGet()
        val future = CompletableFuture<JsonObject>()
        pendingResponses[id] = future

        val req = buildJsonObject {
            put("id", id)
            put("method", method)
            put("params", params)
        }
        send(req)

        return try {
            future.get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (e: TimeoutException) {
            pendingResponses.remove(id)
            throw ZCodeProtocolException("请求超时: $method (${timeoutMs}ms)")
        }
    }

    /**
     * 带超时重试的请求（⚠️ 仅限幂等请求调用！）
     *
     * 背景：初始化阶段多个请求并发打到 app-server，Node 单线程处理能力有限，
     * 易出现"进程存活但响应延迟 → 单次超时"。此时重试往往能命中服务器恢复的窗口
     * （实测手动第二次 setModel 仅 2.5s 成功）。
     *
     * 安全红线：只对"请求超时"重试，业务错误（-32031/-32004 等）立即抛出。
     *
     * ⚠️ 非幂等请求绝不可走此路径：
     *   - session/send    会重复发送用户消息
     *   - session/create  会创建多个会话
     *
     * 重试安全性：app-server 响应按 id 路由，request() 超时后已 remove 旧 future；
     * 重试发新 id 对应新 future，旧响应晚到也不会串扰。
     *
     * 调用方已在 pooled thread（见 handleJsMessage 的 executeOnPooledThread），
     * request() 本身就是阻塞调用，故退避用 Thread.sleep 不会阻塞 EDT。
     *
     * @param backoffMs 退避序列，长度应 ≥ maxAttempts-1；不足则取最后一个值
     */
    private fun requestWithRetry(
        method: String,
        params: JsonObject,
        timeoutMs: Long,
        maxAttempts: Int,
        backoffMs: LongArray = longArrayOf(300, 800)
    ): JsonObject {
        var lastException: ZCodeProtocolException? = null
        for (attempt in 0 until maxAttempts) {
            try {
                return request(method, params, timeoutMs)
            } catch (e: ZCodeProtocolException) {
                lastException = e
                // 仅对"请求超时"重试；业务错误（-32031 等）立即抛出，不浪费重试
                val isTimeout = e.message?.startsWith("请求超时") == true
                if (!isTimeout || attempt == maxAttempts - 1) throw e
                val delay = if (attempt < backoffMs.size) backoffMs[attempt] else backoffMs.last()
                println("[ZCodeProtocolClient] $method timeout (${attempt + 1}/$maxAttempts), retrying after ${delay}ms backoff")
                Thread.sleep(delay)
            }
        }
        throw lastException ?: ZCodeProtocolException("请求失败: $method")
    }

    /** 回答服务器的反向请求 */
    private fun respondToServer(serverId: String, result: JsonElement? = null, error: ProtocolError? = null) {
        val msg = buildJsonObject {
            put("id", serverId)
            if (result != null) put("result", result)
            if (error != null) {
                put("error", buildJsonObject {
                    put("code", error.code)
                    put("message", error.message)
                    error.data?.let { put("data", it) }
                })
            }
        }
        send(msg)
    }

    /** 原始发送（线程安全）*/
    private val sendLock = Any()
    private fun send(msg: JsonObject) {
        synchronized(sendLock) {
            stdin.println(msg.toString())
            stdin.flush()
            // PrintWriter 吞底层 IO 异常：app-server 进程死后写入静默失败，请求只会
            // 表现为超时——checkError 显式检出并抛出，让调用方立即感知连接已断
            if (stdin.checkError()) {
                throw IOException("app-server stdin 写入失败（进程可能已退出），method=${msg["method"]?.jsonPrimitive?.jsonStringOrNull}")
            }
        }
    }

    /** 错误检查样板收敛点：response.error 存在即抛协议异常，无错误原样返回 */
    private fun requireOk(r: JsonObject): JsonObject {
        r["error"]?.let { throw ZCodeProtocolException.fromError(it) }
        return r
    }

    // ============ 高层 API：session 方法族 ============

    /**
     * session/list — 列会话（读类幂等，初始化并发易超时 → 走重试）
     *
     * 不传 workspacePath 时 app-server 的默认行为是"全库维度、排除子代理、按更新
     * 时间倒序取 limit=50"——历史项目多的机器上，当前项目的会话会被其他项目的
     * 活跃会话挤出前 50 名窗口（表现为历史会话"丢失"）。传 workspacePath 让服务
     * 端按项目过滤，limit 放大取全量。
     *
     * 分隔符形态（0.16.5 装机实测定案，缺陷 U）：服务端底层是 SQL `directory = ?`
     * 精确匹配；≤0.16.3 的 CLI 会把传入 workspacePath 规范化为原生分隔符（Windows
     * 反斜杠）后落库，0.16.5 起原样记录——DB 里同一项目存在反斜杠（历史行 + 本客户
     * 端统一原生形态写入）与正斜杠（IDE basePath VFS 形态直传）两种行，单形态查询
     * 各丢一半。这里两种形态各查一次，按 sessionId 去重取并集。
     */
    fun listSessions(
        workspacePath: String? = null,
        includeArchived: Boolean = false,
        limit: Int = 500,
        timeoutMs: Long = 10000
    ): List<SessionInfo> {
        if (workspacePath.isNullOrBlank()) {
            return listSessionsOnce(null, includeArchived, limit, timeoutMs)
        }
        val nativePath = workspacePath.replace('/', File.separatorChar)
        val primary = listSessionsOnce(nativePath, includeArchived, limit, timeoutMs)
        val altPath = workspacePath.replace('\\', '/')
        if (altPath.equals(nativePath, ignoreCase = true)) return primary
        val primaryIds = primary.mapTo(HashSet()) { it.sessionId }
        // 补查 fail-soft：老 CLI（≤0.16.3）库中只有反斜杠行，主查已覆盖全量；若旧版本
        // 对正斜杠参数报协议错误，补查失败不能拖垮主结果（整列表清空的回归比丢补集严重）
        val alt = try {
            listSessionsOnce(altPath, includeArchived, limit, timeoutMs)
        } catch (e: Exception) {
            println("[ZCodeProtocolClient] listSessions alt-form query failed, keep primary only: ${e.message?.let { LogRedactor.redact(it).take(120) }}")
            emptyList()
        }
        // 并集必须按 updatedAt 重排：两查各自按时间倒序返回，直接拼接会把补查命中的
        // 会话整段垫到列表尾部（历史列表表现为"不按时间倒序"）。sortedWith 稳定排序，
        // 同时间戳保持服务端原序
        return (primary + alt.filter { it.sessionId !in primaryIds })
            .sortedWith(compareByDescending { it.updatedAt })
    }

    private fun listSessionsOnce(
        workspacePath: String?,
        includeArchived: Boolean,
        limit: Int,
        timeoutMs: Long
    ): List<SessionInfo> {
        val params = buildJsonObject {
            if (!workspacePath.isNullOrBlank()) {
                put("workspace", buildJsonObject {
                    put("workspacePath", workspacePath)
                    put("workspaceKey", workspacePath)
                })
            }
            put("includeArchived", includeArchived)
            put("limit", limit)
        }
        val r = requestWithRetry("session/list", params, timeoutMs, maxAttempts = 2, backoffMs = longArrayOf(500))
        requireOk(r)

        val sessionsArray = r["result"]?.jsonObject?.get("sessions")?.jsonArray ?: return emptyList()
        return sessionsArray.mapNotNull { elem ->
            try {
                json.decodeFromJsonElement(SessionInfo.serializer(), elem)
            } catch (e: Exception) { null }
        }
    }

    /**
     * session/create — 创建新会话
     * 注意：服务器会反向发 requestRuntimePreferences，本客户端会自动应答
     *
     * workspacePath 统一转原生分隔符形态写入（0.16.5 起 directory 原样记录传入值，
     * IDE basePath 的正斜杠直传会产生正斜杠行，与历史数据撕裂；project_id 规范化
     * 折叠斜杠差异，两形态同 id，归一写入无归属风险）
     */
    fun createSession(workspace: Workspace, mode: PermissionMode = PermissionMode.BUILD, timeoutMs: Long = 20000): String {
        val nativePath = workspace.workspacePath.replace('/', File.separatorChar)
        val params = buildJsonObject {
            put("workspace", buildJsonObject {
                put("workspacePath", nativePath)
                put("workspaceKey", nativePath)
            })
            put("mode", mode.value)
        }
        val r = request("session/create", params, timeoutMs)
        requireOk(r)

        val result = r["result"]?.jsonObject ?: throw ZCodeProtocolException("create 响应缺 result")
        // 规格书 §2：sessionId 在 result.session.sessionId（兼容顶层 result.sessionId）
        val sessionObj = result["session"]?.jsonObject ?: result
        return sessionObj["sessionId"]?.jsonPrimitive?.content
            ?: throw ZCodeProtocolException("create 响应缺 sessionId")
    }

    /**
     * session/subscribe — 订阅事件流
     * 必须带 deliveryKind（0.16+）
     *
     * @param onEvent 事件回调（每个事件都会调一次）
     */
    fun subscribe(
        sessionId: String,
        deliveryKind: String = "desktop-continuous",
        includeSnapshot: Boolean = true,
        afterSeq: Long = 0,
        onEvent: ((SessionEvent) -> Unit)? = null,
        timeoutMs: Long = 10000
    ): JsonObject {
        // 先注册监听器（避免丢事件）
        if (onEvent != null) {
            addEventListener(sessionId, onEvent)
        }

        val params = buildJsonObject {
            put("sessionId", sessionId)
            put("deliveryKind", deliveryKind)
            put("includeSnapshot", includeSnapshot)
            put("afterSeq", afterSeq)
        }
        val r = request("session/subscribe", params, timeoutMs)
        requireOk(r)
        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
    }

    /**
     * v4/conversation/subscribe — 订阅会话的 v4 增量帧流（子会话实时流根治通道）。
     *
     * legacy session/subscribe 对子会话恒成功但 0 事件投递（0.16.5 实测），本通道
     * 订阅后增量帧实时到达 v4/conversation/frame，由 V4FrameMapper 映射回 legacy
     * SessionEvent 推给现有监听器——前端归约链路零改动。clientMode 固定
     * desktop-continuous（continuous profile 含 inputText/output.text 流路径，
     * flush 窗口 30ms；replayable 不推 output 流）。幂等：同会话重复订阅直接返回。
     * 老版本 CLI 无 v4 面时报 -32601，调用方按降级处理（快照轮询兜底）。
     */
    fun subscribeConversationV4(sessionId: String, timeoutMs: Long = 10000): JsonObject {
        if (sessionId in v4SubscribedSessions) return JsonObject(emptyMap())
        val params = buildJsonObject {
            put("topic", "conversation/$sessionId")
            put("connectionId", v4ConnectionId)
            put("clientMode", "desktop-continuous")
        }
        val r = request("v4/conversation/subscribe", params, timeoutMs)
        requireOk(r)
        v4SubscribedSessions.add(sessionId)
        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
    }

    /**
     * v4/conversation/unsubscribe — 退订（best-effort：失败只清本地状态不抛）。
     * 连接级开销可忽略，不退订也无害；供会话关闭路径收敛使用。
     */
    fun unsubscribeConversationV4(sessionId: String, timeoutMs: Long = 5000) {
        v4SubscribedSessions.remove(sessionId)
        v4FrameProbe.remove(sessionId)
        v4FrameMapper.cleanup(sessionId)
        try {
            request("v4/conversation/unsubscribe", buildJsonObject {
                put("topic", "conversation/$sessionId")
                put("connectionId", v4ConnectionId)
            }, timeoutMs)
        } catch (e: Exception) {
            // 退订失败可忽略（连接回收/进程退出时服务端自清）
        }
    }

    /** 该会话是否已建立 v4 增量帧订阅（订阅幂等应答的 v4 标志数据源） */
    fun isConversationV4Subscribed(sessionId: String): Boolean = sessionId in v4SubscribedSessions

    /**
     * session/send — 发消息（字段是 content 不是 message！）
     *
     * @param providerId 用户当前选择的 provider（来自前端 currentModel）；-32031 恢复时
     *   优先用它构造 runtimeModel，避免恢复链路静默切回默认 provider（个人套餐）导致
     *   "显示百度千帆、实际走个人套餐"。null 时回退 runtimeModelFactory（默认 provider）。
     * @param modelId 同上，与 providerId 配对；两者都非 null 才走指定 provider 路径。
     */
    fun send(
        sessionId: String,
        content: String,
        workspacePath: String? = null,
        timeoutMs: Long = 10000,
        providerId: String? = null,
        modelId: String? = null,
        attachments: List<AttachmentInput>? = null,
    ): JsonObject {
        val params = buildJsonObject {
            put("sessionId", sessionId)
            put("content", content)
            // 带 runtimeModel 的 send（协议原生形态，对齐官方客户端按回合携带模型）：
            // 首条消息即注册 provider 并让本回合直接跑在目标模型上。setModel 与新建会话
            // 首回合在服务端赛跑会撞 -32603 Unsupported（08-29 定时触发实测：新会话
            // runtime 未注册任何 provider，available 只有内置目录），send 携带则无此竞态。
            // 构造失败（provider 不在 config.json）省略字段走服务端默认，与原行为一致
            if (providerId != null && modelId != null) {
                RuntimeModels.buildRuntimeModel(providerId, modelId)?.let { put("runtimeModel", it) }
            }
            if (!attachments.isNullOrEmpty()) {
                put("attachments", buildAttachmentsJson(attachments))
            }
        }
        var r = request("session/send", params, timeoutMs)
        if (r["error"] != null) {
            val errCode = r["error"]?.jsonObject?.get("code")?.jsonPrimitive?.jsonStringOrNull?.toIntOrNull()
            // -32031 = restoreWarning：resume 时会话模型不可用被标记，send 直接拒绝。
            // 实测普通 setModel 清不掉该标记（即便切到有效模型），唯一可靠清除方式 =
            // 本请求携带 runtimeModel（zcode.cjs 应用模型时置 restoreWarning=void 0），
            // 故用带 runtimeModel 的 send 原地重试，成功后走正常流式。
            if (errCode == -32031) {
                println("[ZCodeProtocolClient] send hit -32031 (restoreWarning), retrying with runtimeModel")
                // 优先用用户当前选择的 provider 构造 runtimeModel（跟随前端 currentModel），
                // 避免恢复链路用默认 provider 把会话静默切到个人套餐；构造失败回退默认 factory
                val runtimeModel = if (providerId != null && modelId != null) {
                    RuntimeModels.buildRuntimeModel(providerId, modelId) ?: runtimeModelFactory()
                } else {
                    runtimeModelFactory()
                }
                if (runtimeModel != null) {
                    val retryParams = buildJsonObject {
                        put("sessionId", sessionId)
                        put("content", content)
                        put("runtimeModel", runtimeModel)
                        if (!attachments.isNullOrEmpty()) {
                            put("attachments", buildAttachmentsJson(attachments))
                        }
                    }
                    // -32031 是拒绝响应（prompt 未启动），重发不会重复用户消息；
                    // 此处超时/异常直接上抛——回合可能已在跑，再落 CLI 兜底会重复发送
                    r = request("session/send", retryParams, timeoutMs)
                    if (r["error"] == null) {
                        println("[ZCodeProtocolClient] runtimeModel retry succeeded, restoreWarning cleared")
                        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
                    }
                    println("[ZCodeProtocolClient] runtimeModel retry still rejected: ${LogRedactor.redact(r["error"].toString())}")
                } else {
                    println("[ZCodeProtocolClient] cannot build runtimeModel (no enabled anthropic provider in config.json)")
                }
                // 最后兜底：CLI --resume 走另一条干净代码路径（有回复但无流式）。
                // 带附件时跳过该兜底——CLI -p 不支持附件，硬走会静默丢图（边缘路径：-32031
                // 且带图概率极低，宁可显式报错让用户重试）
                if (attachments.isNullOrEmpty()) {
                    println("[ZCodeProtocolClient] falling back to CLI --resume")
                    return sendViaCliResume(sessionId, content, workspacePath)
                }
                throw ZCodeProtocolException("带图片的消息无法走 CLI 恢复兜底（-32031 且 attachments 非空），请重试")
            }
            throw ZCodeProtocolException.fromError(r["error"]!!)
        }
        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
    }

    /** attachments → session/send 请求体（协议通道原生形态 {kind,filename,mimeType,sizeBytes,dataBase64}）*/
    private fun buildAttachmentsJson(attachments: List<AttachmentInput>): JsonArray = buildJsonArray {
        attachments.forEach { a ->
            add(buildJsonObject {
                put("kind", a.kind)
                put("filename", a.filename)
                put("mimeType", a.mimeType)
                a.sizeBytes?.let { put("sizeBytes", it) }
                a.dataBase64?.let { put("dataBase64", it) }
                a.localPath?.let { put("localPath", it) }
            })
        }
    }

    /**
     * Fallback：用 CLI `zcode -p --resume <sid>` 模式发消息
     *
     * app-server 的 -32031（restoreWarning）在无法构造 runtimeModel 时清不掉
     * （普通 setModel 无效，见 send 内注释），CLI 的 --resume 走的是另一条
     * 干净的代码路径——有回复但无流式。
     * 这个方法 spawn 一个 CLI 子进程，等它返回 JSON 结果。
     * 进程治理与 cliOneShot 同型：stderr 独立 drain 防管道满卡死、不混入 stdout 保
     * JSON 纯净、waitFor 超时强杀、finally 兜底杀（修复：曾 readText 无超时永久阻塞、
     * redirectErrorStream(true) 令 stderr 告警污染 JSON 解析、超时不杀进程）。
     */
    private fun sendViaCliResume(sessionId: String, content: String, workspacePath: String?): JsonObject {
        val cliPath = zcodePath.toString()
        val args = mutableListOf(
            nodePath, cliPath,
            "-p", content,
            "--resume", sessionId,
            "--json",
            "--mode", "yolo"
        )
        workspacePath?.let { args.addAll(listOf("--cwd", it)) }

        val pb = ProcessBuilder(args)
        pb.environment().clear()
        pb.environment().putAll(credentials?.toEnvMap() ?: emptyMap())
        pb.redirectErrorStream(false)

        val proc = pb.start()
        val errText = StringBuilder()
        Thread({
            runCatching {
                proc.errorStream.bufferedReader().forEachLine {
                    if (errText.length < 8000) errText.appendLine(it)
                }
            }
        }, "zcode-cli-resume-stderr").start()

        val outputFuture = CompletableFuture.supplyAsync {
            proc.inputStream.bufferedReader().readText()
        }
        try {
            if (!proc.waitFor(120, TimeUnit.SECONDS)) {
                proc.destroyForcibly()
                throw ZCodeProtocolException("CLI resume 发送超时（120s），进程已终止")
            }
            val output = outputFuture.get(5, TimeUnit.SECONDS)
            // CLI 输出是单个 JSON 对象
            return try {
                val cliResult = Json.parseToJsonElement(output).jsonObject
                // 转成 app-server 的 send 响应格式
                buildJsonObject {
                    put("accepted", true)
                    put("sessionId", sessionId)
                    put("cliResponse", cliResult["response"] ?: JsonNull)
                    put("cliUsage", cliResult["usage"] ?: JsonNull)
                }
            } catch (e: Exception) {
                throw ZCodeProtocolException("CLI resume 发送失败: ${LogRedactor.redact(output).take(200)}")
            }
        } finally {
            if (proc.isAlive) proc.destroyForcibly()
        }
    }

    /**
     * 一次性 CLI 问答（headless）：`zcode -p <prompt> --json --mode yolo`（不带 --resume）。
     *
     * 独立子进程、不接续任何会话，用于提示词润色等旁路模型调用——零会话污染。
     * 实测输出为单个 JSON 对象，`response` 字段即回复文本（与 sendViaCliResume
     * 同一解析方式）。stderr 单独 drain 防管道满卡死，且不混入 stdout 保 JSON 纯净。
     *
     * @param credentialsOverride 指定模型凭证（注入 ZCODE_MODEL 等 env，实现"用当前
     *   选择的模型润色"）；null 用客户端启动时的凭证
     * @param timeoutMs 进程超时：超时强杀并抛异常（真正的超时保护，stdout 异步读）
     */
    fun cliOneShot(
        prompt: String,
        workspacePath: String?,
        credentialsOverride: ZCodeCredentials? = null,
        timeoutMs: Long = 120_000,
    ): JsonObject {
        val args = mutableListOf(
            nodePath, zcodePath.toString(),
            "-p", prompt,
            "--json",
            "--mode", "yolo"
        )
        workspacePath?.let { args.addAll(listOf("--cwd", it)) }

        val pb = ProcessBuilder(args)
        pb.environment().clear()
        pb.environment().putAll(credentialsOverride?.toEnvMap() ?: credentials?.toEnvMap() ?: emptyMap())
        pb.redirectErrorStream(false)

        val proc = pb.start()
        val errText = StringBuilder()
        Thread({
            runCatching {
                proc.errorStream.bufferedReader().forEachLine {
                    if (errText.length < 8000) errText.appendLine(it)
                }
            }
        }, "zcode-cli-oneshot-stderr").start()

        val outputFuture = CompletableFuture.supplyAsync {
            proc.inputStream.bufferedReader().readText()
        }
        try {
            if (!proc.waitFor(timeoutMs, TimeUnit.SECONDS)) {
                proc.destroyForcibly()
                throw ZCodeProtocolException("CLI 一次性调用超时（${timeoutMs / 1000}s），进程已终止")
            }
            val output = outputFuture.get(5, TimeUnit.SECONDS)
            return try {
                Json.parseToJsonElement(output).jsonObject
            } catch (e: Exception) {
                throw ZCodeProtocolException(
                    "CLI 一次性调用输出解析失败: stdout=${LogRedactor.redact(output).take(150)} stderr=${LogRedactor.redact(errText.toString()).take(150)}"
                )
            }
        } finally {
            if (proc.isAlive) proc.destroyForcibly()
        }
    }

    /**
     * workspace/generateText — 常驻 app-server 上的一次性文本生成（无会话、无 agent 系统上下文）。
     *
     * 与 CLI -p 通道的本质差异（2026-08-26 协议直连实测）：裸 AI SDK generateText，
     * input 仅本方法的消息（实测 30 token vs CLI 通道 14858），无进程冷启动；
     * 不产生会话记录（session/list 前后不变），workspace 同会话时复用 warm app。
     *
     * 前置条件：modelRef 指向的 provider 须已在 workspace 目录注册（会话 setModel
     * runtimeModel 时顺带注册）；未注册时报 -32603 "Model provider is not configured"，
     * 可调 [upsertModelProvider] 补注册后重试。
     *
     * @return result：{text, modelRef{providerId,modelId}, finishReason?, usage?}
     */
    fun generateText(
        workspacePath: String,
        providerId: String,
        modelId: String,
        prompt: String,
        systemPrompt: String? = null,
        querySource: String = "workspace_prompt_enhance",
        timeoutMs: Long = 60000,
    ): JsonObject {
        val nativePath = workspacePath.replace('/', File.separatorChar)
        val params = buildJsonObject {
            put("workspace", buildJsonObject {
                put("workspacePath", nativePath)
                put("workspaceKey", nativePath)
            })
            put("modelRef", buildJsonObject {
                put("providerId", providerId)
                put("modelId", modelId)
            })
            if (systemPrompt != null) {
                put("messages", buildJsonArray {
                    add(buildJsonObject {
                        put("role", "system")
                        put("content", systemPrompt)
                    })
                    add(buildJsonObject {
                        put("role", "user")
                        put("content", prompt)
                    })
                })
            } else {
                put("prompt", prompt)
            }
            put("querySource", querySource)
        }
        val r = request("workspace/generateText", params, timeoutMs)
        requireOk(r)
        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
    }

    /**
     * workspace/upsertModelProvider — 向 workspace 目录注册/更新模型 provider（幂等）。
     *
     * provider 定义与 runtimeModel.provider 同构（[RuntimeModels.buildRuntimeModel] 的
     * "provider" 字段可直接传入）；目录中已有同 id 条目时整体替换。
     */
    fun upsertModelProvider(
        workspacePath: String,
        provider: JsonObject,
        timeoutMs: Long = 10000,
    ): JsonObject {
        val nativePath = workspacePath.replace('/', File.separatorChar)
        val params = buildJsonObject {
            put("workspace", buildJsonObject {
                put("workspacePath", nativePath)
                put("workspaceKey", nativePath)
            })
            put("provider", provider)
        }
        val r = request("workspace/upsertModelProvider", params, timeoutMs)
        requireOk(r)
        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
    }

    /** session/messages — 读历史 */
    fun messages(sessionId: String, timeoutMs: Long = 15000): JsonArray {
        val params = buildJsonObject { put("sessionId", sessionId) }
        val r = request("session/messages", params, timeoutMs)
        requireOk(r)
        return r["result"]?.jsonObject?.get("messages")?.jsonArray ?: JsonArray(emptyList())
    }

    /**
     * session/subagents — 子代理列表（running + ended，含 childSessionId/toolCallId/summary）
     * 走持久化存储，不要求会话 active（无需 resume）。endedLimit 协议默认 20、上限 100。
     */
    fun subagents(sessionId: String, timeoutMs: Long = 10000): JsonObject {
        val params = buildJsonObject {
            put("sessionId", sessionId)
            put("endedLimit", 50)
        }
        // 读类幂等，初始化并发拥堵易超时 → 走重试
        val r = requestWithRetry("session/subagents", params, timeoutMs, maxAttempts = 2, backoffMs = longArrayOf(500))
        requireOk(r)
        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
    }

    /** session/resume — 续会话（命门） */
    fun resume(sessionId: String, workspace: Workspace, timeoutMs: Long = 15000): JsonObject {
        // 归一原生分隔符（同 createSession：防 0.16.5 原样落库造成同项目双形态行）
        val nativePath = workspace.workspacePath.replace('/', File.separatorChar)
        val params = buildJsonObject {
            put("sessionId", sessionId)
            put("workspace", buildJsonObject {
                put("workspacePath", nativePath)
                put("workspaceKey", nativePath)
            })
        }
        val r = request("session/resume", params, timeoutMs)
        requireOk(r)
        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
    }

    /** session/stop — 停止当前 turn */
    fun stop(sessionId: String, timeoutMs: Long = 5000) {
        val params = buildJsonObject { put("sessionId", sessionId) }
        val r = request("session/stop", params, timeoutMs)
        requireOk(r)
    }

    /**
     * v4/command {type:"stop"} — V4 会话协议的一等停止命令（官方客户端同款），
     * 调运行时原语 stopActiveForegroundExecution，立即终止在途回合。
     * 升级通道（缺陷AD重审）：0.16.x 的 legacy session/stop 静默失效，本方法实测
     * 40ms 终止且 legacy 事件流收到真实收尾帧；老版本 CLI 无 v4 面时报 -32601
     * （此时 session/stop 本就原生生效）。
     *
     * @return 应答 result（含 status: accepted/noop 等，仅日志用）
     */
    fun stopForegroundViaV4(sessionId: String, timeoutMs: Long = 8000): JsonObject {
        val params = buildJsonObject {
            put("commandId", "stop-${java.util.UUID.randomUUID()}")
            put("clientId", "zcode-idea-plugin")
            put("sessionId", sessionId)
            put("type", "stop")
            put("payload", buildJsonObject { })
            put("issuedAt", System.currentTimeMillis())
            put("connectionId", "zcode-idea-plugin")
            put("clientMode", "desktop-continuous")
        }
        val r = request("v4/command", params, timeoutMs)
        requireOk(r)
        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
    }

    /**
     * session/cancelBackgroundTask — 取消子代理/后台任务（taskId = agentId）。
     * 作用于主会话（须 active）；runtime 按 taskType 分发——local_agent 走
     * subagentPort.stopTask（前台子代理也能停），bash 后台任务走 abort。
     */
    fun cancelBackgroundTask(sessionId: String, taskId: String, timeoutMs: Long = 8000): JsonObject {
        val params = buildJsonObject {
            put("sessionId", sessionId)
            put("taskId", taskId)
        }
        val r = request("session/cancelBackgroundTask", params, timeoutMs)
        requireOk(r)
        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
    }

    /** session/setMode — 切换权限模式 */
    fun setMode(sessionId: String, mode: PermissionMode, timeoutMs: Long = 5000) {
        val params = buildJsonObject {
            put("sessionId", sessionId)
            put("mode", mode.value)
        }
        request("session/setMode", params, timeoutMs)
    }

    /**
     * mcp/list — 列 MCP 服务器及连接状态
     *
     * 响应（zcode.cjs LNe/mU schema）：{statuses: {<name>: {status, transport,
     * toolCount, updatedAt, error?, protocolEra, authorization?}}}
     * 注意：响应不含 command/url/来源 scope——配置详情由 McpConfigReader 从磁盘配置补齐。
     *
     * @param mode status=只报状态不连接（快）；connect=真实连接（每服务器起子进程，
     *             慢且有副作用 → 不重试，调用方传长超时）
     */
    fun listMcpServers(workspacePath: String, mode: String = "status", timeoutMs: Long = 30000): JsonObject {
        val params = buildJsonObject {
            put("workspace", buildJsonObject {
                put("workspacePath", workspacePath)
                put("workspaceKey", workspacePath) // 本地场景 key = path（同 Workspace 默认值）
            })
            put("mode", mode)
        }
        return rawMcpList(params, timeoutMs, mode)
    }

    /**
     * plugins/list — 已安装插件清单（MCP 列表「宿主内置」条目来源）
     *
     * 响应（zcode.cjs mVn/fVn 构造）：{plugins: [{id, name, description?,
     * version?, enabled, source, marketplace, skillCount, skillRootCount,
     * commandRootCount, components, declaredMcpServerNames, mcpServerNames,
     * hostMcpServerNames?, hookDetails, rootPath, ...}], diagnostics: [...]}
     *
     * hostMcpServerNames：CLI 内置注册表（browser-use@0.2.1 → ["node_repl"]）
     * 声明的「宿主提供 MCP server」名——不在任何磁盘配置里，会话启动时由
     * CLI 按 `node zcode.cjs __zcode-plugin-host <rootPath>/dist/mcp/server.js`
     * 自动拉起，磁盘配置扫描天然读不到。
     */
    fun listPlugins(workspacePath: String, timeoutMs: Long = 15000): JsonObject {
        val params = buildJsonObject {
            put("workspace", buildJsonObject {
                put("workspacePath", workspacePath)
                put("workspaceKey", workspacePath)
            })
        }
        val r = requestWithRetry("plugins/list", params, timeoutMs, maxAttempts = 2, backoffMs = longArrayOf(500))
        requireOk(r)
        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
    }

    /**
     * mcp/list 原始请求（完整 params 由调用方构造）。
     * 调用方可通过 params.mcpServers 显式传入服务器定义（磁盘扫描的配置转
     * 协议 schema）——插件 spawn 的 app-server 不会自己发现插件贡献的 MCP
     * 配置（statuses 恒空），显式传参是获取真实连接状态的唯一途径。
     */
    fun rawMcpList(params: JsonObject, timeoutMs: Long = 30000, modeForRetry: String = "status"): JsonObject {
        val r = if (modeForRetry == "status") {
            // status 只读幂等 → 可重试；connect 有真实连接副作用 → 单次
            requestWithRetry("mcp/list", params, timeoutMs, maxAttempts = 2, backoffMs = longArrayOf(500))
        } else {
            request("mcp/list", params, timeoutMs)
        }
        requireOk(r)
        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
    }

    /** session/usage — 用量查询（累计 token 统计，读类幂等 → 走重试）*/
    fun usage(sessionId: String, timeoutMs: Long = 5000): JsonObject {
        val params = buildJsonObject { put("sessionId", sessionId) }
        val r = requestWithRetry("session/usage", params, timeoutMs, maxAttempts = 2, backoffMs = longArrayOf(500))
        requireOk(r)
        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
    }

    /**
     * usage/stats — 应用用量统计（app-server 本地会话聚合，非 HTTP）。
     *
     * 覆盖 zcode 经手的全部模型（含第三方直连，monitor 的 model-usage 只统计
     * bigmodel 网关侧 GLM 系），不依赖任何 apiKey。range 仅支持 7d/30d/all。
     */
    fun usageStats(range: String, timeoutMs: Long = 15000): JsonObject {
        val params = buildJsonObject { put("range", range) }
        val r = requestWithRetry("usage/stats", params, timeoutMs, maxAttempts = 2, backoffMs = longArrayOf(500))
        requireOk(r)
        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
    }

    /**
     * session/read → 提取 runtime（含 contextUsage + 可能的 breakdown 构成明细）
     * 返回完整 runtime JsonObject，调用者按需提取 contextUsage / breakdown 子字段。
     * 需要会话处于 active 状态（subscribe/resume 后即可）。
     */
    fun contextUsage(sessionId: String, timeoutMs: Long = 10000): JsonObject {
        val params = buildJsonObject { put("sessionId", sessionId) }
        // 读类幂等，初始化并发拥堵易超时 → 走重试
        val r = requestWithRetry("session/read", params, timeoutMs, maxAttempts = 2, backoffMs = longArrayOf(500))
        requireOk(r)
        val runtime = r["result"]?.jsonObject?.get("runtime")?.jsonObject
            ?: return JsonObject(emptyMap())
        return runtime
    }

    /**
     * session/read → 提取 settings（权限模式 + 思考级别）
     *
     * 实测返回结构：settings = {
     *   mode: { current: "yolo" },
     *   thoughtLevel: { available: [{label,value}], current?, defaultLevel?, enabled },
     *   model: {...}, permission: {...}
     * }
     * thoughtLevel.available 因模型而异（GLM-5.2=off/high/max，GLM-4.x/qwen=enabled/off），
     * 是级别选择器的权威数据源（不能硬编码）。
     */
    fun readSettings(sessionId: String, timeoutMs: Long = 10000): JsonObject {
        val params = buildJsonObject { put("sessionId", sessionId) }
        // 读类幂等，初始化并发拥堵易超时 → 走重试
        val r = requestWithRetry("session/read", params, timeoutMs, maxAttempts = 2, backoffMs = longArrayOf(500))
        requireOk(r)
        return r["result"]?.jsonObject?.get("settings")?.jsonObject ?: JsonObject(emptyMap())
    }

    /**
     * session/setThoughtLevel — 会话级切换思考级别
     *
     * 协议参数（zcode.cjs iKt schema）：{sessionId, thoughtLevel, runtimeModel?,
     * expectedRevision?, persistAsWorkspaceLastUsed=true}——persistAsWorkspaceLastUsed
     * 默认 true（服务端记住为工作区上次使用），取值须在模型的 available 里
     * （off/high/max 或 enabled/off，见 readSettings）。
     */
    fun setThoughtLevel(sessionId: String, thoughtLevel: String, timeoutMs: Long = 6000) {
        val params = buildJsonObject {
            put("sessionId", sessionId)
            put("thoughtLevel", thoughtLevel)
        }
        // 重复设置同值幂等，初始化并发拥堵易超时 → 走重试
        val r = requestWithRetry("session/setThoughtLevel", params, timeoutMs, maxAttempts = 3, backoffMs = longArrayOf(300, 800))
        requireOk(r)
    }

    /** session/resume — 恢复会话为 active（inactive 会话 close 会 -32004，需先 resume）*/
    fun resumeSession(sessionId: String, timeoutMs: Long = 15000) {
        val params = buildJsonObject { put("sessionId", sessionId) }
        val r = request("session/resume", params, timeoutMs)
        requireOk(r)
    }

    /**
     * 删除会话：resume（激活）→ close（清 app-server 内存/索引）→ 删 db.sqlite 记录（清持久化）
     *
     * 背景（已实测验证）：
     * - session/close 只对 active 会话生效，inactive 报 -32004（Session is not active）
     * - session/close 只清内存索引，不删持久化记录
     * - session/list 直接查 ~/.zcode/cli/db/db.sqlite，所以持久化记录必须直接删 DB
     * - ZCode 本身没有删除会话的协议方法，故用 node:sqlite（Node 22+ 内置）执行删除
     */
    fun closeSession(sessionId: String, timeoutMs: Long = 15000) {
        // 1. resume 激活（失败可忽略：会话已 active 或 resume 失败，后续 close 与删 DB 兜底）
        try {
            resumeSession(sessionId, timeoutMs)
        } catch (e: Exception) {
            println("[ZCodeProtocolClient] resume failed (ignorable, will fall back to DB deletion): ${e.message}")
        }
        // 2. close 清 app-server 内存/索引。-32004 说明会话不 active（resume 也失败过），可忽略；
        //    其他错误抛给调用方（会话可能半 active，避免静默残留）
        try {
            val params = buildJsonObject { put("sessionId", sessionId) }
            val r = request("session/close", params, timeoutMs)
            requireOk(r)
        } catch (e: ZCodeProtocolException) {
            if (e.code != -32004) throw e
            println("[ZCodeProtocolClient] close skipped (session already inactive): ${e.message}")
        }
        // 3. 删 db.sqlite 持久化记录（关键步骤，session/list 的数据源，失败则抛异常）
        deleteSessionFromDb(sessionId)
    }

    /**
     * 直接删 ~/.zcode/cli/db/db.sqlite 中该会话的所有记录（含子会话，node:sqlite 内联执行）
     *
     * 注意：dbPath/sessionId 用**环境变量**传参而非命令行参数——Windows 上 `node -e` 后的
     * 第一个命令行参数会被 Node 吃掉（实测），导致 node 用错误的路径创建空 DB。
     */
    private fun deleteSessionFromDb(sessionId: String) {
        if (!java.nio.file.Files.exists(cliDbPath)) {
            println("[ZCodeProtocolClient] db.sqlite not found, skipping persistent deletion: $cliDbPath")
            return
        }
        val pb = ProcessBuilder(nodePath, "-e", DELETE_SESSION_JS)
        pb.environment()["ZCODE_DELETE_DB"] = cliDbPath.toString()
        pb.environment()["ZCODE_DELETE_SID"] = sessionId
        // 统一执行器：stdout 并发读 + stderr 异步 drain（先 waitFor 后读输出、stderr
        // 不读都会因管道缓冲死锁——getSessionStats/stderr 4KB 两次实踩的同型坑）
        val r = SubprocessUtil.runForOutput(pb, 30, "删除持久化记录超时: $sessionId")
        if (r.exitValue != 0) {
            throw IllegalStateException("删除持久化记录失败: ${r.err.ifBlank { r.out }}")
        }
    }

    /**
     * 归档会话：写 ZCode 客户端任务索引（tasks.archived=1，无行补 UPSERT）
     *
     * 与桌面客户端同一数据源（~/.zcode/v2/tasks-index.sqlite），两端列表一致：
     * 客户端（下次重读库时）同步隐藏。session meta（title/时间/工作区）由脚本
     * 从 cli db 读取。旧机制（session.time_archived）已废弃，见 migrateLegacyArchivesOnce。
     */
    fun archiveSession(sessionId: String) = taskIndex.setArchived(sessionId, cliDbPath, archive = true)

    /**
     * 恢复归档会话：置 tasks.archived=0 并清旧机制归档位（time_archived，老版本插件
     * 归档的既有用户会话由此真正恢复；NULL 时幂等空操作）。客户端重启/刷新后同步可见。
     */
    fun restoreSession(sessionId: String) = taskIndex.setArchived(sessionId, cliDbPath, archive = false)

    /**
     * 列出已归档会话：双源合并（兼容既有用户的老机制归档）
     *
     * - 新机制：tasks-index archived=1（ZCode 客户端归档/自动归档 + 新版插件归档），
     *   archivedAt 取 tasks.updated_at（客户端同义，表无专门归档时间列）
     * - 旧机制：session/list 响应的 archivedAt（session.time_archived，老版本插件归档）
     *
     * 客户端归档后会话在其侧无恢复入口——插件的「已归档」列表即恢复出口。
     * tasks 里的 claude-import-* 等无 session 行的任务自然跳过。
     */
    fun listArchivedSessions(workspacePath: String? = null, limit: Int = 500, timeoutMs: Long = 10000): List<SessionInfo> {
        // 归档列表必须限定工作区：无 workspace 的全库 session/list ∪ tasks-index 的
        // 全局归档 id 交集会把**所有项目**的归档会话并进当前列表（0.3.0 装机实测缺陷：
        // 冷启动 workspacePath 空串直落全库）。空路径直接返回空，宁可空显示不跨项目污染
        if (workspacePath.isNullOrBlank()) return emptyList()
        val all = listSessions(workspacePath, includeArchived = true, limit = limit, timeoutMs = timeoutMs)
        val archivedById = taskIndex.listTasks().filter { it.archived }.associateBy { it.taskId }
        return all.mapNotNull { s ->
            val t = archivedById[s.sessionId]
            when {
                t != null -> s.copy(archivedAt = t.updatedAt)   // 新机制（tasks-index）
                (s.archivedAt ?: 0L) > 0L -> s                  // 旧机制（time_archived）
                else -> null
            }
        }.sortedByDescending { it.archivedAt ?: 0L }
    }

    // 会话统计缓存：db 文件指纹（mtime:size，主库+WAL）→ 统计结果（见 getSessionStats）
    @Volatile
    private var sessionStatsCache: Pair<String, Map<String, SessionStat>>? = null

    /**
     * 会话统计（历史列表展示）：sessionId → (消息数, 内容字节数)
     *
     * ZCode 主会话存 SQLite（~/.zcode/cli/db/db.sqlite，WAL 模式）而非 jsonl，
     * cc-gui 的 lite-read jsonl 方案不适用；message/part 表均有 session_id 列，
     * 两条 GROUP BY 精确统计（实测 204 会话 <100ms）。大小 = message.data +
     * part.data 的字节和（CAST AS BLOB 后 LENGTH 按 UTF-8 字节数计）。
     * WAL 下只读不与 CLI 写入竞争；失败/超时降级空 map，不阻塞会话列表主流程。
     */
    fun getSessionStats(): Map<String, SessionStat> {
        val dbPath = Path.of(System.getProperty("user.home"), ".zcode", "cli", "db", "db.sqlite")
        if (!java.nio.file.Files.exists(dbPath)) return emptyMap()

        // 指纹未变直接复用（WAL 追加写必变 size，空闲时稳定命中），免去 node 子进程开销
        val fp = fileFingerprint(dbPath) + "|" + fileFingerprint(Path.of(dbPath.toString() + "-wal"))
        sessionStatsCache?.let { if (it.first == fp) return it.second }

        return try {
            val pb = ProcessBuilder(nodePath, "-e", SESSION_STATS_JS)
            pb.environment()["ZCODE_STATS_DB"] = dbPath.toString()
            // stderr 只有 ExperimentalWarning，丢弃防止与统计输出混流
            pb.redirectError(ProcessBuilder.Redirect.DISCARD)
            val p = pb.start()
            // 先读输出再 waitFor（输出超过管道缓冲时先等会死锁）；脚本恒退出，readText 不致久阻塞
            val out = p.inputStream.bufferedReader().readText()
            if (!p.waitFor(10, TimeUnit.SECONDS)) {
                p.destroyForcibly()
                println("[ZCodeProtocolClient] session stats query timed out, degrading to empty")
                return emptyMap()
            }
            if (p.exitValue() != 0) {
                println("[ZCodeProtocolClient] session stats query failed (exit=${p.exitValue()}), degrading to empty")
                return emptyMap()
            }
            val stats = parseSessionStats(out)
            sessionStatsCache = fp to stats
            stats
        } catch (e: Exception) {
            println("[ZCodeProtocolClient] session stats error: ${e.message}")
            emptyMap()
        }
    }

    private fun parseSessionStats(out: String): Map<String, SessionStat> = try {
        Json.parseToJsonElement(out.trim()).jsonObject.mapNotNull { (sid, v) ->
            try {
                val o = v.jsonObject
                sid to SessionStat(
                    messageCount = o["cnt"]?.jsonPrimitive?.intOrNull ?: 0,
                    sizeBytes = o["bytes"]?.jsonPrimitive?.longOrNull ?: 0L,
                )
            } catch (e: Exception) {
                null
            }
        }.toMap()
    } catch (e: Exception) {
        emptyMap()
    }

    private fun fileFingerprint(path: Path): String = try {
        val attr = java.nio.file.Files.readAttributes(path, java.nio.file.attribute.BasicFileAttributes::class.java)
        "${attr.lastModifiedTime().toMillis()}:${attr.size()}"
    } catch (e: Exception) {
        "missing"
    }

    /**
     * session/setModel — 会话级切换模型
     *
     * ⚠️ 实测（2026-08-14）普通 setModel 即便切到有效模型也**清不掉 -32031 的
     * restoreWarning**——清除该标记须用携带 runtimeModel 的 send/compact（见 send）。
     *
     * @param runtimeModel 可选的完整运行时模型配置（provider 定义 + model）：
     *   服务端收到后会把 provider 注册进 workspace providers 再切换，
     *   从而绕过"可选模型"校验（普通 setModel 只能切 main/lite/available 里的模型）。
     */
    fun setModel(sessionId: String, modelId: String, providerId: String, runtimeModel: JsonObject? = null, timeoutMs: Long = 6000) {
        // setModel 的参数 schema 要求 model 是对象 {modelId, providerId}，不是 modelId 字符串
        val params = buildJsonObject {
            put("sessionId", sessionId)
            put("model", buildJsonObject {
                put("modelId", modelId)
                put("providerId", providerId)
            })
            runtimeModel?.let { put("runtimeModel", it) }
        }
        // setModel 幂等（同 session 设同模型语义等价），初始化并发拥堵易超时 → 走重试
        val r = requestWithRetry("session/setModel", params, timeoutMs, maxAttempts = 3, backoffMs = longArrayOf(300, 800))
        requireOk(r)
    }

    /** session/setRuntimeModelConfig — 设置运行时模型配置（更完整的模型切换）*/
    fun setRuntimeModelConfig(sessionId: String, modelId: String, providerId: String, timeoutMs: Long = 5000) {
        val params = buildJsonObject {
            put("sessionId", sessionId)
            put("runtimeModel", buildJsonObject {
                put("modelId", modelId)
                put("providerId", providerId)
                put("revision", "0")  // 规格书 §2：0.16 要求 revision 字段
            })
        }
        val r = request("session/updateRuntimeModelConfig", params, timeoutMs)
        requireOk(r)
    }

    // ============ 事件监听 ============

    /** 添加指定 session 的事件监听器 */
    fun addEventListener(sessionId: String, listener: (SessionEvent) -> Unit) {
        eventListeners.computeIfAbsent(sessionId) { ConcurrentHashMap.newKeySet() }.add(listener)
        println("[ZCodeProtocolClient] addEventListener: sessionId=$sessionId, registered=${eventListeners.keys}")
    }

    /** 移除指定 session 的事件监听器 */
    fun removeEventListener(sessionId: String, listener: (SessionEvent) -> Unit) {
        eventListeners[sessionId]?.remove(listener)
    }

    /** 添加全局事件监听器（所有 session 的事件都会触发） */
    fun addGlobalEventListener(listener: (SessionEvent) -> Unit) {
        globalListeners.add(listener)
    }

    /** 移除全局事件监听器（面板 dispose 时摘除，防事件继续推向已释放的 JCEF）*/
    fun removeGlobalEventListener(listener: (SessionEvent) -> Unit) {
        globalListeners.remove(listener)
    }

    // ============ 生命周期 ============

    override fun close() {
        closed = true
        // 先断全部回调再杀进程：杀进程是异步的，竞态窗口里残留监听器会把事件继续
        // 转发到已释放的面板（重开项目后双流污染），反向请求 handler 也会打到已
        // dispose 的 Service 容器（browser-use 全废）；摘空后未知反向请求自动走
        // 优雅降级应答（decline / 空浏览器列表）
        globalListeners.clear()
        eventListeners.clear()
        userInputRequestHandler = null
        permissionRequestHandler = null
        browserListHandler = null
        browserExecuteHandler = null
        backendErrorHandler = null
        // 唤醒所有等待的 future
        pendingResponses.values.forEach { it.completeExceptionally(IOException("client closed")) }
        destroyProcessTree()
    }

    /**
     * 终止 app-server 进程树。仅 process.destroy() 只杀 node 主进程：app-server
     * 派生的 __zcode-plugin-host 子进程（browser-use 宿主等）不会随主进程退出——
     * 项目关闭后整棵子树存活，正在执行的回合变成无 UI 监督的"僵尸代理"自主续跑
     * （2026-08-24 实战：旧回合自跑 15 分钟、自起 vite 与无头 Edge、与重开项目的
     * 新客户端双线并行烧额度）。
     * Windows：taskkill /PID /T /F 连树强杀（destroy() 本身也只是 TerminateProcess，
     * 不通知子进程）；Unix：先 TERM 子进程与主进程、5s 未退强杀。
     * 全程异步不等待——close 可能运行在 EDT（项目 dispose 路径）。
     */
    private fun destroyProcessTree() {
        val pid = try { process.pid() } catch (_: Exception) { -1L }
        val isWin = System.getProperty("os.name").lowercase().contains("win")
        try {
            when {
                pid > 0 && isWin ->
                    ProcessBuilder("taskkill", "/PID", pid.toString(), "/T", "/F")
                        .redirectErrorStream(true).start()
                pid > 0 -> {
                    ProcessBuilder("sh", "-c", "pkill -TERM -P $pid; kill -TERM $pid")
                        .redirectErrorStream(true).start()
                    Thread({
                        try { if (!process.waitFor(5, TimeUnit.SECONDS)) process.destroyForcibly() } catch (_: Exception) {}
                    }, "zcode-cli-kill-escalate").apply { isDaemon = true }.start()
                }
                else -> process.destroyForcibly()
            }
        } catch (_: Exception) {
            try { process.destroyForcibly() } catch (_: Exception) {}
        }
    }

    /** 进程是否存活 */
    fun isAlive(): Boolean = process.isAlive
}

/** 协议异常 */
class ZCodeProtocolException(message: String, val code: Int = -1, cause: Throwable? = null) : RuntimeException(message, cause) {
    companion object {
        fun fromError(errorElement: JsonElement): ZCodeProtocolException {
            val err = errorElement.jsonObject
            val code = err["code"]?.jsonPrimitive?.jsonStringOrNull?.toIntOrNull() ?: -1
            val msg = err["message"]?.jsonPrimitive?.jsonStringOrNull ?: "未知错误"
            return ZCodeProtocolException("[$code] $msg", code = code)
        }
    }
}

/** node:sqlite 内联脚本：递归删子会话 + 删所有关联表记录（表名硬编码，无注入）
 * 参数经环境变量 ZCODE_DELETE_DB / ZCODE_DELETE_SID 传入（Windows 上 node -e 命令行参数会被吃掉）*/
private val DELETE_SESSION_JS = """
    const {DatabaseSync} = require('node:sqlite');
    const dbPath = process.env.ZCODE_DELETE_DB;
    const sid = process.env.ZCODE_DELETE_SID;
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA busy_timeout = 15000');
    const childQ = db.prepare('SELECT DISTINCT child_session_id FROM session_task_link WHERE parent_session_id = ?');
    function del(id) {
      const rows = childQ.all(id);
      for (const r of rows) if (r.child_session_id && r.child_session_id !== id) del(r.child_session_id);
      for (const t of ['part','message','todo','session_entry','session_input','session_target','model_usage','turn_usage','tool_usage']) {
        db.prepare('DELETE FROM ' + t + ' WHERE session_id = ?').run(id);
      }
      db.prepare('DELETE FROM session WHERE id = ?').run(id);
    }
    db.exec('BEGIN IMMEDIATE');
    try { del(sid); db.exec('COMMIT'); console.log('deleted'); }
    catch (e) { try { db.exec('ROLLBACK'); } catch(_){} console.error('ERR: ' + e.message); process.exit(1); }
""".trimIndent()

/** node:sqlite 内联脚本：按会话统计消息数与内容字节数（只读，表名硬编码，无注入）。
 * 输出 {sid: {cnt, bytes}} 单行 JSON；参数经环境变量传入（同上的 Windows 命令行参数坑）*/
private val SESSION_STATS_JS = """
    const {DatabaseSync} = require('node:sqlite');
    const db = new DatabaseSync(process.env.ZCODE_STATS_DB);
    db.exec('PRAGMA busy_timeout = 15000');
    const msgs = db.prepare('SELECT session_id AS sid, COUNT(*) AS cnt FROM message GROUP BY session_id').all();
    const parts = db.prepare('SELECT session_id AS sid, SUM(LENGTH(CAST(data AS BLOB))) AS bytes FROM part GROUP BY session_id').all();
    const map = {};
    for (const r of msgs) map[r.sid] = { cnt: r.cnt, bytes: 0 };
    for (const r of parts) { (map[r.sid] || (map[r.sid] = { cnt: 0, bytes: 0 })).bytes = r.bytes; }
    console.log(JSON.stringify(map));
""".trimIndent()

/** 会话统计（历史列表展示）：消息数 + message/part 内容字节和 */
data class SessionStat(val messageCount: Int, val sizeBytes: Long)
