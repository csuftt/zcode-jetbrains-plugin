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
import java.util.concurrent.ConcurrentLinkedQueue
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
 * client.subscribe(sid) { event -> println("收到事件: ${event.type}") }
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
    private val credentials: com.zcode.ideaplugin.protocol.ZCodeCredentials
) : AutoCloseable {

    private val json = Json { ignoreUnknownKeys = true }

    // 请求 ID 生成器
    private val idCounter = AtomicLong(0)

    // 等待响应的 future（按 id 路由）
    private val pendingResponses = ConcurrentHashMap<Long, CompletableFuture<JsonObject>>()

    // 服务器反向请求队列
    private val serverRequests = ConcurrentLinkedQueue<JsonObject>()

    // session/event 订阅者（按 sessionId 路由）
    private val eventListeners = ConcurrentHashMap<String, MutableSet<(SessionEvent) -> Unit>>()

    // 全局事件监听器（所有 session）
    private val globalListeners = ConcurrentHashMap.newKeySet<(SessionEvent) -> Unit>()

    // 运行时偏好应答策略（默认自动应答 SAFE_DEFAULT）
    @Volatile
    var runtimePreferencesResponder: (suspend (sessionId: String, scope: String) -> RuntimePreferences) =
        { _, _ -> RuntimePreferences.SAFE_DEFAULT }

    // 用户输入请求处理器（AskUserQuestion 等需要用户交互的工具）
    // 返回应答 result（JsonObject），由调用方决定怎么拿到用户输入
    @Volatile
    var userInputRequestHandler: ((serverRequestId: String, params: JsonObject) -> JsonObject)? = null

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
         * @param credentials 凭证（默认从 ~/.zcode/v2/config.json 读）
         * @param nodePath node 可执行文件路径（默认从 PATH 找）
         */
        fun start(
            zcodePath: Path = ZCodeLocator.detect(),
            credentials: ZCodeCredentials = Credentials.load(),
            nodePath: String = findNode()
        ): ZCodeProtocolClient {
            val env = (System.getenv() + credentials.toEnvMap()).toMutableMap()

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
                        System.err.println("[app-server stderr] $line")
                        // 模型 API 错误兜底：429 配额超限等被 app-server 按可重试分类退避重试，
                        // turn 终止帧迟迟不发（UI 无限转圈无提示），stderr dump 是错误第一现场
                        backendErrorDetector.feed(line)?.let { err ->
                            println("[ZCodeProtocolClient] 检测到后端 API 错误: statusCode=${err.statusCode} code=${err.code}")
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
            println("[ZCodeProtocolClient] readLoop 启动，开始监听 app-server stdout")
            var lineCount = 0
            while (!closed) {
                val line = stdout.readLine() ?: break
                if (line.isBlank()) continue
                lineCount++

                val msg = try {
                    Json.parseToJsonElement(line).jsonObject
                } catch (e: Exception) {
                    // 非 JSON 行（app-server 偶发日志），转发到 stderr 便于排查而不是静默丢弃
                    System.err.println("[app-server stdout] $line")
                    continue
                }

                dispatchMessage(msg)
            }
        } catch (e: IOException) {
            if (!closed) {
                // 进程异常退出
                System.err.println("[ZCodeProtocolClient] reader 异常: ${e.message}")
            }
        }
    }

    private fun dispatchMessage(msg: JsonObject) {
        val id = msg["id"]
        val method = msg["method"]?.jsonPrimitive?.contentOrNull
        val hasResult = msg.containsKey("result")
        val hasError = msg.containsKey("error")

        when {
            // 是对客户端请求的响应（id 是数字）
            id != null && (hasResult || hasError) && id.toString().trim('"').toLongOrNull() != null -> {
                val idLong = id.jsonPrimitive.content.toLong()
                pendingResponses.remove(idLong)?.complete(msg)
            }
            // 是服务器的反向请求（id 是 "server-N" 字符串）
            id != null && method != null && id.jsonPrimitive.contentOrNull?.startsWith("server") == true -> {
                serverRequests.add(msg)
                handleServerRequest(msg)
            }
            // 是通知（session/event 等）
            method != null && id == null -> {
                // 诊断：确认通知到达 dispatchMessage
                if (method == "session/event") {
                    println("[ZCodeProtocolClient] dispatchMessage: session/event 通知到达，转发到 handleNotification")
                }
                handleNotification(method, msg["params"]?.jsonObject ?: JsonObject(emptyMap()))
            }
            else -> {
                // 未知消息类型（可能是带 id 的通知？打印诊断）
                println("[ZCodeProtocolClient] dispatchMessage: 未知消息类型 id=$id method=$method keys=${msg.keys}")
            }
        }
    }

    /** 处理服务器的反向请求（自动应答 requestRuntimePreferences） */
    private fun handleServerRequest(msg: JsonObject) {
        val method = msg["method"]?.jsonPrimitive?.contentOrNull ?: return
        val id = msg["id"]?.jsonPrimitive?.contentOrNull ?: return
        val params = msg["params"]?.jsonObject ?: JsonObject(emptyMap())

        if (method == "session/requestRuntimePreferences") {
            // 规格书 §3：必须应答，否则卡死
            val prefs = RuntimePreferences.SAFE_DEFAULT
            respondToServer(id, buildJsonObject {
                put("nativeSearchEnhancementsEnabled", prefs.nativeSearchEnhancementsEnabled)
                put("memoryEnabled", prefs.memoryEnabled)
                put("askUserQuestionAutoResolutionEnabled", prefs.askUserQuestionAutoResolutionEnabled)
            })
        }
        else if (method == "interaction/requestUserInput") {
            // AskUserQuestion：需要用户交互，交给 handler 处理
            // ⚠️ 必须异步处理！handler 会阻塞等用户选择，不能卡 reader 线程
            println("[ZCodeProtocolClient] 收到 interaction/requestUserInput，异步交给 handler")
            val handler = userInputRequestHandler
            if (handler != null) {
                Thread({
                    try {
                        val result = handler(id, params)
                        respondToServer(id, result)
                        println("[ZCodeProtocolClient] interaction/requestUserInput 已应答")
                    } catch (e: Exception) {
                        // 带异常类名：TimeoutException/InterruptedException 的 message 为 null，
                        // 只打 message 会显示"异常: null"无法定位（panel 端已自行处理超时/中断，
                        // 走到这里的是真正的意外错误）
                        println("[ZCodeProtocolClient] interaction/requestUserInput handler 异常(${e.javaClass.simpleName}): ${e.message}")
                        respondToServer(id, buildJsonObject { put("action", "decline") })
                    }
                }, "zcode-user-input").apply { isDaemon = true }.start()
            } else {
                println("[ZCodeProtocolClient] 无 userInputRequestHandler，自动 decline")
                respondToServer(id, buildJsonObject { put("action", "decline") })
            }
        }
        // 宿主浏览器反向请求（browser-use）：异步执行——navigate/screenshot 可能秒级耗时，
        // 与 requestUserInput 同理禁止阻塞 reader 线程
        else if (method == "interaction/browserList") {
            val handler = browserListHandler
            if (handler != null) {
                Thread({
                    try {
                        respondToServer(id, handler())
                    } catch (e: Exception) {
                        println("[ZCodeProtocolClient] browserList handler 异常(${e.javaClass.simpleName}): ${e.message}")
                        respondToServer(id, error = ProtocolError(ErrorCodes.INTERNAL_ERROR, "browserList 失败: ${e.message}"))
                    }
                }, "zcode-browser-list").apply { isDaemon = true }.start()
            } else {
                // 无宿主浏览器能力：空列表（协议允许，browser-use 按不可用降级）
                respondToServer(id, buildJsonObject { put("browsers", JsonArray(emptyList())) })
            }
        }
        else if (method == "interaction/browserExecute") {
            val handler = browserExecuteHandler
            if (handler != null) {
                Thread({
                    try {
                        respondToServer(id, handler(params))
                    } catch (e: Exception) {
                        println("[ZCodeProtocolClient] browserExecute handler 异常(${e.javaClass.simpleName}): ${e.message}")
                        respondToServer(id, error = ProtocolError(ErrorCodes.INTERNAL_ERROR, "browserExecute 失败: ${e.message}"))
                    }
                }, "zcode-browser-exec").apply { isDaemon = true }.start()
            } else {
                respondToServer(id, error = ProtocolError(ErrorCodes.METHOD_NOT_FOUND, "宿主未注册 browserExecuteHandler"))
            }
        }
        // 其他未知反向请求：回 -32601 避免空等
        else {
            respondToServer(id, error = ProtocolError(ErrorCodes.METHOD_NOT_FOUND, "未实现的反向请求: $method"))
        }
    }

    /** 处理通知 */
    private fun handleNotification(method: String, params: JsonObject) {
        if (method == "session/event") {
            val event = SessionEvent.fromNotification(params)
            // 诊断：确认事件到达 + sessionId 匹配
            val registered = eventListeners.keys
            println("[ZCodeProtocolClient] 收到 session/event: type=${event.type} sessionId=${event.sessionId} 已注册监听的session=${registered}")
            // 通知该 session 的监听器
            val listeners = eventListeners[event.sessionId]
            println("[ZCodeProtocolClient] 匹配到 ${listeners?.size ?: 0} 个监听器")
            listeners?.forEach { it(event) }
            // 通知全局监听器
            globalListeners.forEach { it(event) }
        }
        // state.updated：模式/思考级别/模型变化推送（含 ZCode 自动进出计划模式）
        // params = {type:"state.updated", reason:"mode_changed"|..., revision, scope:"session",
        //           sessionId, workspace, patch:{mode, thoughtLevel, model, permission}}
        else if (method == "state.updated") {
            val sid = params["sessionId"]?.jsonPrimitive?.contentOrNull ?: return
            val reason = params["reason"]?.jsonPrimitive?.contentOrNull ?: ""
            // 诊断：模式切换（含 ExitPlanMode 审批后退出 plan）依赖此事件的 patch.mode.current，
            // 记录 reason + patch 便于排查"模式切不回"
            println("[ZCodeProtocolClient] state.updated: reason=$reason patch=${params["patch"]}")
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
        // v4/telemetry/event 等暂不处理
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
                println("[ZCodeProtocolClient] $method 超时(${attempt + 1}/$maxAttempts)，退避 ${delay}ms 后重试")
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
        }
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
     * 注意：服务端底层是 SQL `directory = ?` 精确匹配，DB 记录的是 CLI 写入的原生
     * 分隔符形态（Windows 反斜杠），而 IDE basePath 是 VFS 正斜杠形态——这里统一
     * 转成原生形态再传，否则 0 命中。
     */
    fun listSessions(
        workspacePath: String? = null,
        includeArchived: Boolean = false,
        limit: Int = 500,
        timeoutMs: Long = 10000
    ): List<SessionInfo> {
        val params = buildJsonObject {
            if (!workspacePath.isNullOrBlank()) {
                val nativePath = workspacePath.replace('/', File.separatorChar)
                put("workspace", buildJsonObject {
                    put("workspacePath", nativePath)
                    put("workspaceKey", nativePath)
                })
            }
            put("includeArchived", includeArchived)
            put("limit", limit)
        }
        val r = requestWithRetry("session/list", params, timeoutMs, maxAttempts = 2, backoffMs = longArrayOf(500))
        r["error"]?.let { throw ZCodeProtocolException.fromError(it) }

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
     */
    fun createSession(workspace: Workspace, mode: PermissionMode = PermissionMode.BUILD, timeoutMs: Long = 20000): String {
        val params = buildJsonObject {
            put("workspace", buildJsonObject {
                put("workspacePath", workspace.workspacePath)
                put("workspaceKey", workspace.workspaceKey)
            })
            put("mode", mode.value)
        }
        val r = request("session/create", params, timeoutMs)
        r["error"]?.let { throw ZCodeProtocolException.fromError(it) }

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
        r["error"]?.let { throw ZCodeProtocolException.fromError(it) }
        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
    }

    /** session/send — 发消息（字段是 content 不是 message！） */
    fun send(sessionId: String, content: String, workspacePath: String? = null, timeoutMs: Long = 10000): JsonObject {
        val params = buildJsonObject {
            put("sessionId", sessionId)
            put("content", content)
        }
        var r = request("session/send", params, timeoutMs)
        if (r["error"] != null) {
            val errCode = r["error"]?.jsonObject?.get("code")?.jsonPrimitive?.contentOrNull?.toIntOrNull()
            // -32031 = restoreWarning：resume 时会话模型不可用被标记，send 直接拒绝。
            // 实测普通 setModel 清不掉该标记（即便切到有效模型），唯一可靠清除方式 =
            // 本请求携带 runtimeModel（zcode.cjs 应用模型时置 restoreWarning=void 0），
            // 故用带 runtimeModel 的 send 原地重试，成功后走正常流式。
            if (errCode == -32031) {
                println("[ZCodeProtocolClient] send 遇到 -32031（restoreWarning），带 runtimeModel 重试")
                val runtimeModel = runtimeModelFactory()
                if (runtimeModel != null) {
                    val retryParams = buildJsonObject {
                        put("sessionId", sessionId)
                        put("content", content)
                        put("runtimeModel", runtimeModel)
                    }
                    // -32031 是拒绝响应（prompt 未启动），重发不会重复用户消息；
                    // 此处超时/异常直接上抛——回合可能已在跑，再落 CLI 兜底会重复发送
                    r = request("session/send", retryParams, timeoutMs)
                    if (r["error"] == null) {
                        println("[ZCodeProtocolClient] runtimeModel 重试成功，restoreWarning 已清除")
                        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
                    }
                    println("[ZCodeProtocolClient] runtimeModel 重试仍被拒: ${r["error"]}")
                } else {
                    println("[ZCodeProtocolClient] 无法构造 runtimeModel（config.json 无 enabled anthropic provider）")
                }
                // 最后兜底：CLI --resume 走另一条干净代码路径（有回复但无流式）
                println("[ZCodeProtocolClient] fallback 到 CLI --resume")
                return sendViaCliResume(sessionId, content, workspacePath)
            }
            throw ZCodeProtocolException.fromError(r["error"]!!)
        }
        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
    }

    /**
     * Fallback：用 CLI `zcode -p --resume <sid>` 模式发消息
     *
     * app-server 的 -32031（restoreWarning）在无法构造 runtimeModel 时清不掉
     * （普通 setModel 无效，见 send 内注释），CLI 的 --resume 走的是另一条
     * 干净的代码路径——有回复但无流式。
     * 这个方法 spawn 一个 CLI 子进程，等它返回 JSON 结果。
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
        pb.environment().putAll(credentials.toEnvMap())
        pb.redirectErrorStream(true)

        val proc = pb.start()
        val output = proc.inputStream.bufferedReader().readText()
        proc.waitFor(120, TimeUnit.SECONDS)

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
            throw ZCodeProtocolException("CLI resume 发送失败: ${output.take(200)}")
        }
    }

    /** session/messages — 读历史 */
    fun messages(sessionId: String, timeoutMs: Long = 15000): JsonArray {
        val params = buildJsonObject { put("sessionId", sessionId) }
        val r = request("session/messages", params, timeoutMs)
        r["error"]?.let { throw ZCodeProtocolException.fromError(it) }
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
        r["error"]?.let { throw ZCodeProtocolException.fromError(it) }
        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
    }

    /** session/resume — 续会话（命门） */
    fun resume(sessionId: String, workspace: Workspace, timeoutMs: Long = 15000): JsonObject {
        val params = buildJsonObject {
            put("sessionId", sessionId)
            put("workspace", buildJsonObject {
                put("workspacePath", workspace.workspacePath)
                put("workspaceKey", workspace.workspaceKey)
            })
        }
        val r = request("session/resume", params, timeoutMs)
        r["error"]?.let { throw ZCodeProtocolException.fromError(it) }
        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
    }

    /** session/stop — 停止当前 turn */
    fun stop(sessionId: String, timeoutMs: Long = 5000) {
        val params = buildJsonObject { put("sessionId", sessionId) }
        val r = request("session/stop", params, timeoutMs)
        r["error"]?.let { throw ZCodeProtocolException.fromError(it) }
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
        r["error"]?.let { throw ZCodeProtocolException.fromError(it) }
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
        r["error"]?.let { throw ZCodeProtocolException.fromError(it) }
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
        r["error"]?.let { throw ZCodeProtocolException.fromError(it) }
        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
    }

    /** session/usage — 用量查询（累计 token 统计，读类幂等 → 走重试）*/
    fun usage(sessionId: String, timeoutMs: Long = 5000): JsonObject {
        val params = buildJsonObject { put("sessionId", sessionId) }
        val r = requestWithRetry("session/usage", params, timeoutMs, maxAttempts = 2, backoffMs = longArrayOf(500))
        r["error"]?.let { throw ZCodeProtocolException.fromError(it) }
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
        r["error"]?.let { throw ZCodeProtocolException.fromError(it) }
        val runtime = r["result"]?.jsonObject?.get("runtime")?.jsonObject
            ?: return JsonObject(emptyMap())
        // 诊断：确认 runtime 完整结构（是否包含 breakdown 构成明细）
        println("[DIAG-CTX] runtime keys=${runtime.keys} json=${runtime.toString().take(2000)}")
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
        r["error"]?.let { throw ZCodeProtocolException.fromError(it) }
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
        r["error"]?.let { throw ZCodeProtocolException.fromError(it) }
    }

    /** session/resume — 恢复会话为 active（inactive 会话 close 会 -32004，需先 resume）*/
    fun resumeSession(sessionId: String, timeoutMs: Long = 15000) {
        val params = buildJsonObject { put("sessionId", sessionId) }
        val r = request("session/resume", params, timeoutMs)
        r["error"]?.let { throw ZCodeProtocolException.fromError(it) }
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
            println("[ZCodeProtocolClient] resume 失败（可忽略，走删 DB 兜底）: ${e.message}")
        }
        // 2. close 清 app-server 内存/索引。-32004 说明会话不 active（resume 也失败过），可忽略；
        //    其他错误抛给调用方（会话可能半 active，避免静默残留）
        try {
            val params = buildJsonObject { put("sessionId", sessionId) }
            val r = request("session/close", params, timeoutMs)
            r["error"]?.let { throw ZCodeProtocolException.fromError(it) }
        } catch (e: ZCodeProtocolException) {
            if (e.code != -32004) throw e
            println("[ZCodeProtocolClient] close 跳过（会话本就 inactive）: ${e.message}")
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
        val home = System.getProperty("user.home")
        val dbPath = Path.of(home, ".zcode", "cli", "db", "db.sqlite")
        if (!java.nio.file.Files.exists(dbPath)) {
            println("[ZCodeProtocolClient] db.sqlite 不存在，跳过持久化删除: $dbPath")
            return
        }
        val pb = ProcessBuilder(nodePath, "-e", DELETE_SESSION_JS)
        pb.environment()["ZCODE_DELETE_DB"] = dbPath.toString()
        pb.environment()["ZCODE_DELETE_SID"] = sessionId
        val p = pb.start()
        val out = p.inputStream.bufferedReader().readText()
        val err = p.errorStream.bufferedReader().readText()
        val finished = p.waitFor(30, TimeUnit.SECONDS)
        if (!finished) {
            p.destroyForcibly()
            throw IllegalStateException("删除持久化记录超时: $sessionId")
        }
        if (p.exitValue() != 0) {
            throw IllegalStateException("删除持久化记录失败: ${err.ifBlank { out }}")
        }
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
                println("[ZCodeProtocolClient] 会话统计查询超时，降级为空")
                return emptyMap()
            }
            if (p.exitValue() != 0) {
                println("[ZCodeProtocolClient] 会话统计查询失败(exit=${p.exitValue()})，降级为空")
                return emptyMap()
            }
            val stats = parseSessionStats(out)
            sessionStatsCache = fp to stats
            stats
        } catch (e: Exception) {
            println("[ZCodeProtocolClient] 会话统计异常: ${e.message}")
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
        r["error"]?.let { throw ZCodeProtocolException.fromError(it) }
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
        r["error"]?.let { throw ZCodeProtocolException.fromError(it) }
    }

    // ============ 事件监听 ============

    /** 添加指定 session 的事件监听器 */
    fun addEventListener(sessionId: String, listener: (SessionEvent) -> Unit) {
        eventListeners.computeIfAbsent(sessionId) { ConcurrentHashMap.newKeySet() }.add(listener)
        println("[ZCodeProtocolClient] addEventListener: sessionId=$sessionId, 当前已注册=${eventListeners.keys}")
    }

    /** 移除指定 session 的事件监听器 */
    fun removeEventListener(sessionId: String, listener: (SessionEvent) -> Unit) {
        eventListeners[sessionId]?.remove(listener)
    }

    /** 添加全局事件监听器（所有 session 的事件都会触发） */
    fun addGlobalEventListener(listener: (SessionEvent) -> Unit) {
        globalListeners.add(listener)
    }

    // ============ 生命周期 ============

    override fun close() {
        closed = true
        try {
            process.destroy()
        } catch (_: Exception) {}
        // 唤醒所有等待的 future
        pendingResponses.values.forEach { it.completeExceptionally(IOException("client closed")) }
    }

    /** 进程是否存活 */
    fun isAlive(): Boolean = process.isAlive
}

/** 协议异常 */
class ZCodeProtocolException(message: String, val code: Int = -1, cause: Throwable? = null) : RuntimeException(message, cause) {
    companion object {
        fun fromError(errorElement: JsonElement): ZCodeProtocolException {
            val err = errorElement.jsonObject
            val code = err["code"]?.jsonPrimitive?.contentOrNull?.toIntOrNull() ?: -1
            val msg = err["message"]?.jsonPrimitive?.contentOrNull ?: "未知错误"
            return ZCodeProtocolException("[$code] $msg", code = code)
        }
    }
}

/** JsonObject 工具：安全取字符串 */
private val JsonPrimitive.contentOrNull: String?
    get() = if (this.isString) this.content else this.content.takeIf { it != "null" }

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
