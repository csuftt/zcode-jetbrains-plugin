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
import java.util.concurrent.ExecutionException
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
    private val credentials: com.zcode.ideaplugin.protocol.ZCodeCredentials?,
    /** spawn 时注入的代理配置（null=未配置直连；排障查「代理注入了没」，日志在 ZCodeServiceImpl） */
    val proxyConfig: ProxyConfig?,
    /** CLI 协议代际（start() 判定注入；模型相关方法的参数形态按代分支，见 ProtocolGenerations） */
    val generation: ProtocolGeneration = ProtocolGeneration.OLD,
    /** spawn 前 `--version` 探测结果（null=探测失败；协议参数版本门控用，见 supportsIncludeArchivedParam） */
    val appVersion: String? = null,
    /** stdin 写阻塞判死时限（毫秒）：写入被对端挂死对端卡住的封顶等待，见 StdinWriteGate */
    private val stdinWriteTimeoutMs: Long = 30_000L,
) : AutoCloseable {

    private val json = Json { ignoreUnknownKeys = true }

    /** app-server 进程 pid（进程管理面板用；进程已退出/取不到时为 -1） */
    val pid: Long
        get() = try {
            process.pid()
        } catch (_: Exception) {
            -1L
        }

    /** 进程启动时刻（epoch ms，进程管理面板运行时长用）。client 在 spawn 成功后立刻构造，误差毫秒级 */
    val startedAtMillis: Long = System.currentTimeMillis()

    /** app-server 会话库（session/list 数据源；删除、旧归档迁移直写） */
    private val cliDbPath = Path.of(System.getProperty("user.home"), ".zcode", "cli", "db", "db.sqlite")

    /** ZCode 客户端任务索引（归档/恢复与客户端共写同一数据源，见 TaskIndexStore） */
    val taskIndex = TaskIndexStore(nodePath, Path.of(System.getProperty("user.home"), ".zcode", "v2", "tasks-index.sqlite"))

    /**
     * 归档/软删会话排除集合（tasks-index 与 ZCode 客户端同源，task_id=会话 id）。
     * IDE 历史列表与手机远程各列表出口共用：session/list 只认 db.sqlite 的旧
     * time_archived 列，插件归档（写 tasks-index.sqlite）后 session/list 仍返回，
     * 不过滤则大会员几百条归档任务全量泄漏给 H5 首页。fail-soft：schema 不兼容
     * 返回空集合（宁多显示不漏显示，同 handleListSessions 口径）
     */
    fun hiddenSessionIds(): Set<String> = runCatching {
        taskIndex.listTasks().filter { it.archived || it.deleted }.map { it.taskId }.toSet()
    }.getOrDefault(emptySet())

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

    /**
     * 后台工作投影缓存（session → 最近一次 backgroundWorks 全量数组）。投影只经订阅帧
     * 推送且重复订阅不重推快照——打开会话时前端经 [listBackgroundWorks] 从此补齐
     * （跨标签共享本进程数据；进程重启后缓存消失，此时后台 bash 子进程也已随
     * app-server 死亡，空投影是正确语义非缺陷）。
     */
    private val backgroundWorksCache = java.util.concurrent.ConcurrentHashMap<String, kotlinx.serialization.json.JsonArray>()

    /** 查会话的后台工作投影缓存（无数据返回空数组，不 hydrate 冷会话） */
    fun listBackgroundWorks(sessionId: String): kotlinx.serialization.json.JsonArray =
        backgroundWorksCache[sessionId] ?: kotlinx.serialization.json.JsonArray(emptyList())

    /**
     * 仅订阅标题更新的主会话（v2 代）。v2 的标题生成结果只在 v4 帧
     * `state.updated` delta 的 `patch.meta.title` 上广播，legacy session/event 流
     * 不再有 session.titleUpdated——主会话（legacy 驱动）在此登记后，帧处理只抽
     * meta.title 合成 session.titleUpdated 事件，行数据不映射（防与 legacy 双写）。
     */
    private val v4TitleSessions = ConcurrentHashMap.newKeySet<String>()

    /** v4 订阅 id（sessionId → subscribe 应答 ack.subscriptionId）：退订 RPC 的
     * 必填参数之一（三件套 topic+connectionId+subscriptionId，缺任一 -32603） */
    private val v4SubscriptionIds = java.util.concurrent.ConcurrentHashMap<String, String>()

    /**
     * 会话投影 revision 水位（sessionId → 最近一帧携带的投影 revision）。
     * fileChanges/fileRewindPreview 查询的 CAS 是严格相等校验且拒绝应答不带
     * revisionAtDecision，已全量订阅会话（子会话）重入查询时靠这里取兜底水位。
     * trackProjectionRevision 维护（快照帧 revision + 增量帧 state.updated 的
     * patch.revision），cleanup 时随会话清理。
     */
    private val v4ProjectionRevisions = java.util.concurrent.ConcurrentHashMap<String, Int>()

    /** v4 帧累计映射产出事件数（[V4FrameProbe] 的 mapped 字段，见 handleNotification） */
    private val v4MappedProbe = ConcurrentHashMap<String, Long>()

    /** 已 dump 过空壳帧原文的会话（每会话一次，防刷屏） */
    private val v4EmptyDumped = ConcurrentHashMap.newKeySet<String>()

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

    /**
     * 宿主自动化任务反向请求（automation/create|update|list|delete|checkTaskBinding）：
     * 模型的 CronCreate/CronUpdate/CronList/CronDelete 工具经 app-server 中继落到宿主，
     * 任务存储与调度全在宿主侧（官方 Electron 持 sqlite，本插件由
     * ZCodeScheduledMessageService 承载）。method 为完整方法名，返回应答 result；
     * 业务拒绝用异常抛出（message 模型可读，转 -32603 回给 app-server）。
     * 在独立线程调用（本地存储读写+全量广播，禁止卡 reader）。
     */
    var automationRequestHandler: ((method: String, params: JsonObject) -> JsonObject)? = null

    // -32031 恢复用的 runtimeModel 构造器（默认读 config.json 的 enabled provider；测试可注入）
    @Volatile
    var runtimeModelFactory: () -> JsonObject? = { RuntimeModels.defaultRuntimeModel() }

    // ============ 模型参数按代际分支（2026-09-17 定稿，替代试错降级）============
    // 新版 CLI（zod strict）移除 runtimeModel：setModel 收模型引用 + options.reasoningLevel
    // （有 reasoning 定义的模型必填，值集见 BuiltinModelCatalog）、send 收 modelSelection。
    // 代际由 start() 判定（zcode.cjs 内容标记，权威无试错）；OLD 链路保持原样零改动。

    /** NEW 代 setModel 的 model 对象（引用 + reasoningLevel 默认档）；OLD 为无 options 引用 */
    private fun modelRefJson(modelId: String, providerId: String): JsonObject = buildJsonObject {
        put("modelId", modelId)
        put("providerId", providerId)
        if (generation == ProtocolGeneration.NEW) {
            BuiltinModelCatalog.defaultReasoningLevel(modelId, zcodePath)?.let {
                put("options", buildJsonObject { put("reasoningLevel", it) })
            }
        }
    }

    /**
     * NEW 代 modelSelection 对象（send 主路径 / -32031 重试 / generateText 三处共用）。
     * 引用 + reasoningLevel（v2 必填，缺失 turn 在 model_creation 静默 failed）。
     * [reasoningLevel] 传会话当前档位（缺陷CX：send 恒带目录默认档 max 会写回会话冲掉
     * 用户设置；generateText 等无会话语义的调用传 null 走目录默认档）。合法性裁决见
     * [resolveSelectionReasoningLevel]。提取前三处内联已现漂移苗头（缺 personalModelIds
     * 兜底之类），形状改动只改这里。
     */
    private fun modelSelectionJson(providerId: String, modelId: String, reasoningLevel: String? = null): JsonObject = buildJsonObject {
        put("providerId", providerId)
        put("modelId", modelId)
        resolveSelectionReasoningLevel(
            reasoningLevel,
            BuiltinModelCatalog.reasoningValues(modelId, zcodePath),
            BuiltinModelCatalog.defaultReasoningLevel(modelId, zcodePath),
        )?.let {
            put("options", buildJsonObject { put("reasoningLevel", it) })
        }
    }

    /**
     * 后端模型 API 错误回调（stderr 的 APICallError dump 解析结果，见 BackendErrorDetector）。
     * 场景：429 配额超限等被 app-server 按可重试分类持续退避，turn 终止帧迟迟不发，
     * 事件流上无错误迹象——stderr 是唯一的第一现场。在 stderr 线程调用。
     */
    @Volatile
    var backendErrorHandler: ((BackendErrorDetector.BackendApiError) -> Unit)? = null

    /**
     * 模型 API 错误的**不去重**原始通道（stderr 线程调用）：每条命中 APICallError 的
     * dump 都回调，无 60s 同签名去重（去重只作用于 [backendErrorHandler] 的横幅展示）。
     * 消费方：连通性测试的真因缓存——连点重测同签名错误时，去重窗内主回调静默，
     * 只有本通道能持续供数。
     */
    @Volatile
    var rawBackendErrorHandler: ((BackendErrorDetector.BackendApiError) -> Unit)? = null

    /**
     * app-server 崩溃级进程异常通道（官方 `[zcode-process-exception]` stderr 契约，
     * BackendErrorDetector.parseProcessException 解析、errorId 去重）。与
     * [backendErrorHandler] 的区别：那是模型 API 错误（进程活着、服务端在重试），
     * 这是进程要挂了——readLoop 断连收尾另行走，此处只负责把结构化根因实时递给
     * 宿主展示（比断连后翻 stderr 尾部更直接）。在 stderr 线程调用。
     */
    @Volatile
    var processExceptionHandler: ((BackendErrorDetector.ProcessException) -> Unit)? = null

    /**
     * 会话级「待用户交互」计数（requestPermission / requestUserInput 到来 +1、应答 -1），
     * 变更即回调快照（sessionId → pending 数）。会话列表红点的数据源——这是本地方案：
     * 官方 pendingInteractionSummary 只在 v4 sessions-index topic 订阅里（要常驻占
     * v4 订阅槽），而反向请求本来就路经本客户端，零协议成本；app-server 重启后挂起
     * 交互会重发反向请求，计数自愈。reader/worker 双线程触达，全部并发容器。
     */
    private val pendingInteractions = java.util.concurrent.ConcurrentHashMap<String, MutableSet<String>>()

    @Volatile
    var onPendingInteractionsChanged: ((Map<String, Int>) -> Unit)? = null

    private fun addPendingInteraction(sessionId: String, requestId: String) {
        pendingInteractions.getOrPut(sessionId) { java.util.concurrent.ConcurrentHashMap.newKeySet() }.add(requestId)
        notifyPendingInteractions()
    }

    private fun removePendingInteraction(requestId: String) {
        var changed = false
        for (set in pendingInteractions.values) {
            changed = set.remove(requestId) || changed
        }
        if (changed) notifyPendingInteractions()
    }

    private fun notifyPendingInteractions() {
        val snapshot = pendingInteractions.mapValues { it.value.size }.filterValues { it > 0 }
        onPendingInteractionsChanged?.invoke(snapshot)
    }

    /**
     * 会话思考档缓存（缺陷CX，issue#25）：NEW 代 send 的 modelSelection 若恒带目录默认档
     * （GLM 恒 max），服务端回合装配会把它写回会话并持久化——用户设置的思考档每回合被
     * 冲回最高，回合结束 webview 兜底重拉设置后 UI 显示「最高」。send 改带「最后已知会话
     * 档位」替代。写入点=setThoughtLevel 成功 + readSettings 读回 current（服务端权威校准，
     * 外部改档后回合结束的例行重拉即自愈）；读取点=send 的 modelSelection（含 -32031 重试）。
     * 不为此发额外 RPC（拥堵面零扩大）；进程重启后缓存为空的首条消息走目录默认档（打开过
     * 会话即有 getSettings 预热），下回合自愈。会话关闭不清理：同 id resume 档位仍有效。
     */
    private val sessionThoughtLevels = java.util.concurrent.ConcurrentHashMap<String, String>()

    /**
     * 服务端实锤拒绝 includeArchived（-32602 Unrecognized key）后置位：版本探测失败
     * （appVersion=null）时的运行时自愈。0.17.0 起该参数从 session/list strict schema
     * 删除，发了即整请求失败（启动首个 listSessions 就炸）。
     */
    @Volatile
    private var includeArchivedRejected = false

    /** session/list 是否可带 includeArchived：版本门控（<0.17.0）+ 服务端拒绝记忆 */
    private fun canSendIncludeArchived(): Boolean =
        !includeArchivedRejected && supportsIncludeArchivedParam(appVersion)

    // 进程是否还活着
    @Volatile
    private var closed = false

    /**
     * stdin 写入门禁（app-server-silent-hang 三/四例根治）：阻塞写封顶 30s，
     * 到期判死 → kill 进程树 → readLoop EOF 集中 fail 在途请求 → Service 层
     * onProtocolDead 钩子懒重建。取代原「synchronized(sendLock) + 无超时阻塞写」
     * ——挂死后首个卡进 println 的调用持锁永不释放，全部 stdio 通信（含用户点
     * 停止）排队卡死无痕，唯一解曾是用户手动杀进程。
     */
    private val writeGate = StdinWriteGate(stdinWriteTimeoutMs) { evidence -> declareProtocolDead(evidence) }

    /**
     * stdin 写阻塞判死后的通知钩子（ZCodeServiceImpl 挂）：延迟片刻走 getClient()
     * 正常换代重建（handler 重挂/账本重置全套）。null 时退化为旧行为——靠下一次
     * getClient 调用（2s 轮询/用户操作）兜底重建。
     */
    var onProtocolDead: ((evidence: String) -> Unit)? = null

    /** 判死收尾：kill 进程树（异步，不占调用线程）+ 通知重建钩子。gate 保证恰好一次 */
    private fun declareProtocolDead(evidence: String) {
        System.err.println(
            "[ZCodeProtocolClient] stdin 写阻塞判死 app-server 挂死（$evidence, pid=$pid）——kill 进程树，等待懒重建"
        )
        Thread({ destroyProcessTree() }, "zcode-protocol-dead-kill").apply { isDaemon = true }.start()
        onProtocolDead?.let { hook ->
            Thread({
                try {
                    hook(evidence)
                } catch (_: Exception) {
                }
            }, "zcode-protocol-dead-notify").apply { isDaemon = true }.start()
        }
    }

    /**
     * 外部主动判死（Service 层心跳/探活确认后调用，缺陷FQ）：与 stdin 写阻塞判死
     * 同一条收尾链（kill + onProtocolDead 钩子），gate 防重复。挂死进程 stdin 缓冲
     * 未满时写不阻塞——写超时防线探不到这种形态，只能靠上层「重发心跳静默 +
     * 探活超时」双重证据从外面判。
     */
    fun declareDeadExternally(evidence: String) = declareProtocolDead(evidence)

    /**
     * 轻量探活：probe RPC 带独立短超时。false = 无应答（进程死/挂死不消费）。
     * 写入走 writeGate（挂死形态写通常成功——缓冲未满，只是没人应答）。
     */
    fun probeAlive(timeoutMs: Long): Boolean = try {
        request("session/list", buildJsonObject { put("limit", 1) }, timeoutMs)
        true
    } catch (_: Exception) {
        false
    }

    // ============ 启动方式 ============

    companion object {
        /**
         * 启动 ZCode app-server 子进程并连接
         *
         * @param zcodePath zcode.cjs 路径（默认自动探测）
         * @param credentials 凭证（默认从 ~/.zcode/v2/config.json 读；null = 无明文凭证，
         *   不注入 env，app-server 用自身凭证链——cli/config.json 的 provider 注册）
         * @param nodePath node 可执行文件路径（默认从 PATH 找）
         * @param readyTimeoutMs 就绪探测超时：等 app-server 首个轻量响应的上限。慢机器
         *   冷启动（12MB bundle 解析 + 杀软首扫）实测可达 10s+，30s 是"慢而活"与
         *   "快而死"的分界余量；探测超时即杀进程抛人话异常（issue #11 崩溃循环，
         *   此前首个业务请求独自撞 20s 超时还会被前端误套"恢复中"指引）
         * @param stdinWriteTimeoutMs stdin 写阻塞判死时限（毫秒）：对端挂死不再消费
         *   stdin 时写入会永久阻塞，此参数封顶阻塞等待，到期 kill 进程树触发重建
         *   （app-server-silent-hang 三/四例；仅测试传小值）
         */
        fun start(
            zcodePath: Path = ZCodeLocator.detect(),
            credentials: ZCodeCredentials? = Credentials.loadOrNull(),
            nodePath: String = findNode(),
            readyTimeoutMs: Long = 30_000,
            stdinWriteTimeoutMs: Long = 30_000
        ): ZCodeProtocolClient {
            val env = (System.getenv() + (credentials?.toEnvMap() ?: emptyMap())).toMutableMap()
            // 模型请求 UA 版本号对齐官方客户端：zcode.cjs 请求头构造读 env.ZCODE_APP_VERSION
            // 优先（w4i），官方客户端经 clientHello 带真实版本，插件不发握手 → 不注入则 UA 落
            // "ZCode/unknown"（工具级权益如 1.5 倍用量的识别信号在请求头族，2026-09-14 探针
            // 实证 env 路径生效）。用户显式设置时不覆盖；探测失败 fail-soft 不注入。
            // UA 与协议门控同源：探测一次，UA 注入 env、能力门控传 client 构造
            val appVersion = detectAppVersion(zcodePath, nodePath)
            if (env["ZCODE_APP_VERSION"].isNullOrBlank()) {
                appVersion?.let { env["ZCODE_APP_VERSION"] = it }
            }
            // 代理：setting.json 配了就整套注入（对齐官方客户端 buildAgentRuntimeEnv，
            // issue #12——插件 spawn 的 app-server 不走系统代理）。setting 是用户在
            // 客户端/插件设置页的显式配置，覆盖继承 env 同名变量；未配置不注入，
            // 高级用户自设的 ZCODE_HTTP_PROXY 等 env 原样透传（zcode.cjs 自行消费）
            val proxyConfig = ProxyConfigStore.read().takeIf { !it.isEmpty }
            proxyConfig?.toEnvMap()?.let { env.putAll(it) }
            // 代际判定提前到 env 组装（原在 spawn 后）：NEW 代需要显式 provider 文件 env 对。
            // 显式对被 CLI 直接采用、不做 SEA 物化缓存（provider-runtime-env.ts L61-66）——
            // 路径受控后 updateAccountConfig 的 basedOnZCodeBuiltinRevision 才能与 CLI 侧
            // 逐字符对齐（不匹配则 Registry 冻结不发布，账号渠道激活整个失效）；顺带绕开
            // 多进程共享物化缓存的版本撕裂（0.3.x 实踩 -32603）。OLD 代无此机制不注入。
            val generation = ProtocolGenerations.detect(zcodePath)
            if (generation == ProtocolGeneration.NEW) {
                val providerEnv = AccountProviderBridge.buildProviderFileEnv(zcodePath)
                if (providerEnv.isNotEmpty()) {
                    env.putAll(providerEnv)
                    println("[ZCodeProtocolClient] provider config env: builtin=${providerEnv[AccountProviderBridge.ENV_BUILTIN]}")
                } else {
                    println("[ZCodeProtocolClient] provider config env skipped: zcode-builtin.json not found (account channels stay fail-closed)")
                }
            }

            val pb = ProcessBuilder(nodePath, zcodePath.toString(), "app-server")
            pb.environment().clear()
            pb.environment().putAll(env)
            pb.redirectErrorStream(false)

            val process = pb.start()
            val stdin = PrintWriter(process.outputStream.bufferedWriter(), true)
            val stdout = process.inputStream.bufferedReader()

            // 代际已提前判定（spawn 侧同款判据）：进程已在跑，文件即权威
            println("[ZCodeProtocolClient] CLI generation = $generation (zcode.cjs=${zcodePath.fileName})")
            val client = ZCodeProtocolClient(process, stdin, stdout, zcodePath, nodePath, credentials, proxyConfig, generation, appVersion, stdinWriteTimeoutMs)
            // 排障主线索（issue #12 用户实测三态：坏地址失败/清空直连/好地址成功——
            // 没有这行日志时分不清「代理坏了」还是「没注入」）：代理地址 userinfo 脱敏
            println("[ZCodeProxy] app-server spawn ${proxyConfig?.logSummary ?: "<no proxy, direct>"}")
            // ⚠️ 必须 drain stderr！Windows 管道缓冲约 4KB，node 写 stderr 是同步阻塞的。
            // 模型调用失败时 app-server 会向 stderr 打错误堆栈，一次就可能填满缓冲；
            // 无人读 → node 永久阻塞在写 stderr → 整个 app-server 事件循环停摆，
            // 症状为所有协议请求超时（进程 alive 但不响应）。
            val stderr = process.errorStream.bufferedReader()
            val backendErrorDetector = BackendErrorDetector()
            // 不去重原始通道：每条模型 API 错误都递给宿主（连通性测试真因缓存依赖；
            // backendErrorHandler 有 60s 同签名去重，仅供横幅展示防轰炸）
            backendErrorDetector.onRawApiError = { err -> client.rawBackendErrorHandler?.invoke(err) }
            Thread({
                try {
                    stderr.forEachLine { line ->
                        val redacted = LogRedactor.redact(line)
                        System.err.println("[app-server stderr] $redacted")
                        client.recordStderr(redacted)
                        // 崩溃级进程异常（官方 [zcode-process-exception] JSON 契约）：
                        // 实时上报结构化根因，替代"断连后翻 stderr 尾部"
                        backendErrorDetector.parseProcessException(line)?.let { pe ->
                            println("[ZCodeProtocolClient] Process exception detected: kind=${pe.kind} origin=${pe.origin} name=${pe.name}")
                            client.processExceptionHandler?.invoke(pe)
                        }
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
            // 就绪探测：同步等首个轻量响应再返回（崩溃快速失败+杀进程，慢启动安静等待），
            // 保证调用方拿到的 client 必然已就绪——详见 awaitReady 注释
            try {
                client.awaitReady(readyTimeoutMs)
            } catch (e: Exception) {
                client.close()
                throw e
            }
            // 账号渠道激活推送（NEW 代）：CLI Provider Registry 已就绪，推 Account Overlay
            // 解除 zhipu-account 渠道 fail-closed（官方 Desktop Host 同构做法）。后台线程
            // fail-soft：无凭证/推送失败只是保持现状（账号渠道不可用），绝不阻断主流程
            if (generation == ProtocolGeneration.NEW) {
                Thread({ client.pushAccountOverlay(zcodePath) }, "zcode-account-overlay-push")
                    .apply { isDaemon = true; start() }
            }
            return client
        }

        /** --version 探测缓存：CLI 升级（mtime 变）自动失效；null 也缓存——崩溃循环重连时不反复 spawn */
        private val appVersionCache = ConcurrentHashMap<Path, Pair<Long, String?>>()

        private const val VERSION_PROBE_TIMEOUT_SECONDS = 15L

        /** session/list sessionIds 批量上限（zcodeSessionListParamsSchema：min1/max64） */
        private const val SESSION_IDS_MAX = 64

        /**
         * 探测 CLI 版本注入 ZCODE_APP_VERSION（UA 用）。spawn `node <cli> --version`，
         * 与 ZCodeEnvChecker.probeCliVersion 同口径；仅首次/升级后探测（mtime 缓存）。
         */
        internal fun detectAppVersion(zcodePath: Path, nodePath: String): String? {
            val mtime = try {
                java.nio.file.Files.getLastModifiedTime(zcodePath).toMillis()
            } catch (e: Exception) {
                return null
            }
            appVersionCache[zcodePath]?.let { (cachedMtime, cached) ->
                if (cachedMtime == mtime) return cached
            }
            val version = try {
                val proc = ProcessBuilder(nodePath, zcodePath.toString(), "--version")
                    .redirectErrorStream(true)
                    .start()
                try {
                    if (!proc.waitFor(VERSION_PROBE_TIMEOUT_SECONDS, TimeUnit.SECONDS)) null
                    else if (proc.exitValue() != 0) null
                    else parseCliVersion(proc.inputStream.bufferedReader().readText())
                } finally {
                    proc.destroyForcibly()
                }
            } catch (e: Exception) {
                null
            }
            appVersionCache[zcodePath] = mtime to version
            return version
        }

        /** `--version` 输出解析：取首个语义化版本号（"0.16.5" 形，含 prerelease/build 段）；无则 null */
        internal fun parseCliVersion(output: String): String? =
            Regex("""\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?""").find(output.trim())?.value

        /**
         * session/list 的 includeArchived 参数支持判定：CLI 0.17.0 起该 key 从 zod strict
         * schema 删除（发即 -32602 Unrecognized key），归档会话改用 sessionIds 显式身份
         * 查询。null/不可解析按"支持"处理（保持旧形态发送），由调用方在 -32602 时运行时
         * 自愈（[includeArchivedRejected]）；prerelease 按核心版本号比较（0.17.0-rc 即新）。
         */
        internal fun supportsIncludeArchivedParam(version: String?): Boolean {
            val core = version?.substringBefore('+')?.substringBefore('-')
                ?.split('.')?.mapNotNull { it.toIntOrNull() }
                ?.takeIf { it.size == 3 } ?: return true
            val threshold = listOf(0, 17, 0)
            for (i in 0..2) {
                val cmp = core[i].compareTo(threshold[i])
                if (cmp != 0) return cmp < 0
            }
            return false // 恰好 0.17.0 也不支持
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

                // 单帧处理失败只丢该帧，绝不杀 reader 线程：线程一死 app-server 虽活着
                // 但响应再也读不回（症状=全线请求超时，新会话也建不了）。2026-09-19 事故：
                // 新版 CLI 每 5 分钟推 process/mcpResourceSamples（params 为数组），旧代码
                // 强转 JsonObject 抛 IllegalArgumentException 穿透到这里杀死线程（外层只
                // catch IOException）——任何未来协议形状变化都应止步于丢帧+日志
                try {
                    dispatchMessage(msg)
                } catch (e: Exception) {
                    val method = msg["method"]?.toString()?.take(60) ?: "?"
                    System.err.println(
                        "[ZCodeProtocolClient] dispatch failed (method=$method), frame dropped: " +
                            "${e.javaClass.simpleName}: ${LogRedactor.redact(e.message ?: "")}"
                    )
                }
            }
        } catch (e: IOException) {
            if (!closed) {
                // 进程异常退出
                System.err.println("[ZCodeProtocolClient] reader error: ${e.message}")
            }
        } finally {
            // 管道关闭（进程退出/崩溃）即连接终结：在途请求立即失败，不再各自干等超时
            // （completeExceptionally 幂等，与 close() 的集中 fail 并存无害）
            val ex = IOException("app-server 进程已退出，连接已断开")
            pendingResponses.values.forEach { it.completeExceptionally(ex) }
            pendingResponses.clear()
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
            // 注：此处与 handleNotification 的 session/event 分支原有三层诊断 println
            // （通知到达/事件接收/监听器匹配），为"切会话丢流式"排查埋点——该问题已由
            // 全局监听器机制根治，埋点于 0.3.1 收尾摘除（实测 10 分钟 1092 事件 ≈ 3300 行日志洪水）
            method != null && id == null -> {
                // params 形状防御：遥测类通知（process/mcpResourceSamples 等）的 params 是
                // 数组，?.jsonObject 强转会抛异常；as? 落空对象让未知通知照常走忽略路径
                handleNotification(method, msg["params"] as? JsonObject ?: JsonObject(emptyMap()))
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
        // 与 dispatchMessage 通知分支同款形状防御：params 非对象时落空对象
        val params = msg["params"] as? JsonObject ?: JsonObject(emptyMap())

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
                addPendingInteraction(params["sessionId"]?.jsonPrimitive?.jsonStringOrNull ?: "", id)
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
                    } finally {
                        removePendingInteraction(id)
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
                addPendingInteraction(params["sessionId"]?.jsonPrimitive?.jsonStringOrNull ?: "", id)
                reverseRequestExecutor.execute {
                    try {
                        respondInteractiveAnswer(id, handler(id, params))
                    } catch (e: Exception) {
                        println("[ZCodeProtocolClient] interaction/requestPermission handler error (${e.javaClass.simpleName}): ${e.message}")
                        respondToServer(id, buildJsonObject {
                            put("decision", "deny")
                            put("reason", "Handler error: ${e.message ?: e.javaClass.simpleName}")
                        })
                    } finally {
                        removePendingInteraction(id)
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
        // 模型请求前的运行时鉴权供给（Account 型渠道每次 attempt 都会来要，runner.ts
        // 仅 zhipu-account Model 挂此端口；普通 apiKey 渠道不进）。2026-09-21 开源源码
        // 升级：按 accountAccess.mode 从 credentials.json 供给 apiKey（官方同款判据
        // AccountProviderBridge.requestAuthApiKey）——此前恒拒绝是 zcode-plan 滑块场景
        // 的防御，但那同时把插件本可代答的登录型渠道也堵死了（fail-closed 总根因的
        // 应答半边）。供给不了（team 需远端解析/凭证缺失/captcha 类）时快速失败：
        // 服务端 prepare 阶段即抛 -32031，errorMessage 进 turn.failed detail，替代
        // 旧版落入 -32601 兜底的 ZodError 校验崩溃（用户只见 "Model request failed."）
        else if (method == "interaction/requestProviderRuntimeHeaders") {
            val providerId = params["providerId"]?.jsonPrimitive?.jsonStringOrNull ?: ""
            val mode = params["accountAccess"]?.jsonObject?.get("mode")?.jsonPrimitive?.jsonStringOrNull
            val apiKey = try {
                AccountProviderBridge.requestAuthApiKey(providerId, mode)
            } catch (e: Exception) {
                println("[ZCodeProtocolClient] providerRuntimeHeaders credential read error (${e.javaClass.simpleName}): ${e.message}")
                null
            }
            if (apiKey != null) {
                println("[ZCodeProtocolClient] providerRuntimeHeaders: supplying apiKey for $providerId (mode=$mode)")
                respondToServer(id, buildJsonObject {
                    put("headersApplied", true)
                    put("requestAuth", buildJsonObject { put("apiKey", apiKey) })
                })
            } else {
                respondToServer(id, buildJsonObject {
                    put("headersApplied", false)
                    put("errorMessage", "host plugin cannot provide runtime auth for $providerId " +
                        "(mode=$mode: credential missing, team-plan not supported, or captcha-gated gateway)")
                })
            }
        }
        // 官方 MCP 鉴权头（interaction/requestOfficialMcpAuthHeaders）：官方插件 server
        // （browser-use 等）的官方市场鉴权取数口。插件无 Coding Plan 官方身份，固定按
        // 「不可用」拒绝（应答 schema discriminatedUnion("ok")，reason 枚举取
        // official_auth_unavailable；diag-cua-inject.py 实证 -32601 拒绝也能容错跑通，
        // 结构化拒绝更干净——server 置 failed 而非协议崩溃）
        else if (method == "interaction/requestOfficialMcpAuthHeaders") {
            respondToServer(id, buildJsonObject {
                put("ok", false)
                put("reason", "official_auth_unavailable")
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
        // 宿主自动化任务（automation/*）：模型 Cron* 工具的宿主落点，与 browser-use 同族。
        // 异步执行（存储读写+面板广播，禁止卡 reader 线程）；未注册时回 -32601 保持
        // 旧版行为（模型侧工具报错，至少不空等）
        else if (method == "automation/create" || method == "automation/update" || method == "automation/list" ||
            method == "automation/delete" || method == "automation/checkTaskBinding"
        ) {
            val handler = automationRequestHandler
            if (handler != null) {
                reverseRequestExecutor.execute {
                    try {
                        respondToServer(id, handler(method, params))
                    } catch (e: Exception) {
                        println("[ZCodeProtocolClient] automation handler error ($method, ${e.javaClass.simpleName}): ${e.message}")
                        respondToServer(id, error = ProtocolError(ErrorCodes.INTERNAL_ERROR, e.message ?: e.javaClass.simpleName))
                    }
                }
            } else {
                respondToServer(id, error = ProtocolError(ErrorCodes.METHOD_NOT_FOUND, "宿主未注册 automationRequestHandler"))
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
            // 哨兵也收敛（缺陷FR）：只有标记的 id 发 error，其余重发 id 静默丢弃
            val onlyDiscard = result["__zcodeRespondOnly"]?.jsonPrimitive?.contentOrNull
            if (onlyDiscard != null && onlyDiscard != id) return
            respondToServer(id, error = ProtocolError(ErrorCodes.INTERNAL_ERROR, "request discarded: turn ended"))
        } else {
            // 重发堆积应答收敛（缺陷FR）：服务端 interaction pending 的任意一个 id 收到
            // 应答即 cleanup 全部 key（源码 cleanupClientRequest），旧 id 应答本就被忽略。
            // 3.16.3 起 reannounce 从指数退避改固定 10s，挂起 5min+ 堆积 30+ 在途 id，
            // 全量应答的风暴实测触发服务端挂死（应答处理后零事件死寂）——只由标记的
            // 最新 id 发送，其余静默跳过
            val only = result["__zcodeRespondOnly"]?.jsonPrimitive?.contentOrNull
            if (only != null && only != id) {
                ProtocolLog.info("[interaction] duplicate id skipped (respondOnly=$only, id=$id)")
                return
            }
            respondToServer(id, if (only != null) JsonObject(result.filterKeys { it != "__zcodeRespondOnly" }) else result)
        }
    }

    /** 处理通知 */
    private fun handleNotification(method: String, params: JsonObject) {
        if (method == "session/event") {
            val event = SessionEvent.fromNotification(params)
            // 3.14.0 起 legacy 流恢复推送 titleUpdated（0.3.6 适配 3.12.x 时的"不再推送"
            // 结论已过时）——透传即生效，与 v4 合成通道并存，前端 applyTitleUpdated 幂等。
            // 低频（每会话标题一次），info 保留生产可见性供实时链路排查
            if (event.type == com.zcode.ideaplugin.protocol.model.EventTypes.SESSION_TITLE_UPDATED) {
                ProtocolLog.info("[title-sub] legacy session/event titleUpdated: ${event.sessionId} title=${event.payload["title"]?.jsonPrimitive?.contentOrNull?.take(30)}")
            }
            // 通知该 session 的监听器（诊断埋点已摘：见 dispatchMessage 通知分支注释）
            val listeners = eventListeners[event.sessionId]
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
        // v4/telemetry/event：回合级遥测（含 turn.terminal 终态）。v2 渠道模型引用非法时
        // （如 reasoningLevel 缺失），turn 在 model_creation 阶段静默 failed——该失败只走
        // 此通道（session/event 流无 turn.failed 帧），不映射则 UI 表现"一直没响应"。
        // 终态映射策略：failed → turn.failed（payload.error 取 errorCode/errorMessage）；
        // aborted/cancelled 等异常终态 → 合成 turn.completed 作"回合已结束"信号（前端
        // streaming 复位，防快速回合终态仅存于遥测时入口永久禁用）。成功终态（status=
        // success/completed，真机实挖 success）**不合成**——真实 turn.completed（带
        // usage/response）由既有事件链正常到达，遥测重复合成会以空 payload 抢先污染
        // 消费方（通知空预览/双气泡、消费方 usage 断言失败，2026-09-17 实测回退）。
        // 门控 NEW：master 对 v1 遥测帧"暂不处理"（v1 是否推 aborted 遥测未实证），
        // 合成是 v2 专属补偿——门死保证 v1 行为与 master 逐字一致（2026-09-17 review）
        else if (method == "v4/telemetry/event" && generation == ProtocolGeneration.NEW) {
            val kind = params["kind"]?.jsonPrimitive?.jsonStringOrNull
            if (kind == "turn.terminal") {
                val status = params["status"]?.jsonPrimitive?.jsonStringOrNull
                if (status == "success" || status == "completed") {
                    ProtocolLog.debug("[ZCodeProtocolClient] turn.terminal status=$status → skip (real event chain authoritative)")
                    return
                }
                val sid = params["sessionId"]?.jsonPrimitive?.jsonStringOrNull ?: return
                val failed = status == "failed"
                val event = SessionEvent(
                    type = if (failed) "turn.failed" else "turn.completed",
                    seq = params["eventSeq"]?.jsonPrimitive?.longOrNull ?: 0L,
                    sessionId = sid,
                    timestamp = params["occurredAt"]?.jsonPrimitive?.longOrNull ?: System.currentTimeMillis(),
                    traceId = null,
                    turnId = params["turnId"]?.jsonPrimitive?.jsonStringOrNull,
                    deliveryKind = null,
                    payload = if (failed) buildJsonObject {
                        put("error", buildJsonObject {
                            put("type", params["errorCode"]?.jsonPrimitive?.contentOrNull ?: "turn_failed")
                            put("message", params["errorMessage"]?.jsonPrimitive?.contentOrNull
                                ?: "回合失败（v2 模型请求被拒）")
                        })
                        params["turnPhase"]?.jsonPrimitive?.contentOrNull?.let { put("turnPhase", it) }
                    } else buildJsonObject {
                        put("viaTelemetry", true)
                    }
                )
                ProtocolLog.debug("[ZCodeProtocolClient] turn.terminal status=$status → ${event.type} (sid=${sid.take(20)})")
                eventListeners[sid]?.forEach { it(event) }
                globalListeners.forEach { it(event) }
            }
        }
        // v4/conversation/frame：v4 订阅会话的增量帧（子会话实时流根治通道）。
        // topic=conversation/<sessionId>；只对主动 v4 订阅过的会话映射，防与 legacy 流双写。
        // 手机远程桥的原始帧透传挂在映射链最前（onV4FrameListeners）：映射链对标题订阅/
        // 未订阅会话多处早退（return），桥需要全量帧，必须先于任何 return 分发。
        // wire 分片重组（V4WireAssembler，缺陷EK）：大会话的快照（数百 KB）被服务端拆成
        // kind:"fragment" 的分片通知逐片下发，插件只认整帧时分会话全灭（小会话不分片所以
        // 时好时坏）。重组放桥透传之后（桥/H5 侧自管 wire 协议），重组产物 {topic,frame}
        // 与整帧同构，下游零改动
        else if (method == "v4/conversation/frame") {
            v4FrameListeners.forEach { runCatching { it(params) } }
            val effectiveParams = wireAssembler.accept(params)
            // 逻辑帧分发（整帧与重组产物统一走此通道；fragment 分片本身不进——快照水位
            // 捕获等消费方挂 addV4LogicalFrameListener，见字段注释）
            v4LogicalFrameListeners.forEach { runCatching { it(effectiveParams) } }
            val topic = effectiveParams["topic"]?.jsonPrimitive?.jsonStringOrNull ?: return
            val sid = topic.removePrefix("conversation/")
            if (sid.length == topic.length) return
            // 投影 revision 水位跟踪：fileChanges/fileRewindPreview 两查询的 CAS 是
            // 严格相等校验（baseRevision ≠ snapshot.revision 直接 staleRevision 拒绝、
            // 无 revisionAtDecision 可回），客户端必须持有当前值。快照帧直读 revision，
            // 增量帧扫 state.updated 的 patch.revision（投影每变更必带，见 delta.ts）。
            // 主要消费方是已全量订阅会话（子会话）重入查询时的兜底水位
            trackProjectionRevision(sid, effectiveParams)
            // 后台工作投影（H7 汇总入口数据源）：在两类订阅的分流前提取——主会话走
            // 标题轻订阅（v4TitleSessions，轻分支内 return），子会话走完整订阅，两条路
            // 都需要 badge 数据。快照帧 snapshot.backgroundWorks 全量 + state.updated
            // delta 的 patch.backgroundWorks 全量替换（服务端投影语义）。合成
            // backgroundWorks 事件推前端，payload 原样透传不裁字段。低频（启停时各一帧）
            extractBackgroundWorks(sid, effectiveParams["frame"]?.jsonObject?.get("payload") as? JsonObject)?.let { dispatchSessionEvent(it) }
            // 工作区钩子准入投影（workspaceHookAdmission，官方「N 个 Hook 待审核」
            // 横幅的数据源）：与 backgroundWorks 同款，在两类订阅分流前提取——主会话
            // 标题轻订阅、子会话完整订阅都要收。null（已准入）也透传，前端据以清横幅。
            WorkspaceHookAdmissionExtraction.extract(
                sid, effectiveParams["frame"]?.jsonObject?.get("payload") as? JsonObject
            )?.let { dispatchSessionEvent(it) }
            // 仅标题订阅的主会话：只抽 state.updated delta 的 meta.title 合成
            // session.titleUpdated（v2 标题广播唯一通道，见 v4TitleSessions），行数据
            // 不映射——主会话已有 legacy 流，映射会造成双写
            if (sid in v4TitleSessions && sid !in v4SubscribedSessions) {
                val frame = effectiveParams["frame"]?.jsonObject ?: return
                val payload = frame["payload"]?.jsonObject ?: return
                // 逐轮文件更改摘要（B2 回合产物）：turnHeader 行自带服务端权威 fileChanges
                // 账本（+/−行数服务端算好直出）——快照窗口（订阅 initial/重同步）与
                // row.appended/upserted 增量两路都提取，合成 turn.fileChanges 事件供前端
                // 渲染逐轮「N 个文件已更改」条。行无 fileChanges 键（无写入的轮）静默跳过
                val frameTs = frame["sentAt"]?.jsonPrimitive?.longOrNull ?: System.currentTimeMillis()
                if (payload["kind"]?.jsonPrimitive?.jsonStringOrNull == "snapshot") {
                    val windowRows = payload["snapshot"]?.jsonObject?.get("rows")?.jsonObject
                        ?.get("window")?.jsonArray?.mapNotNull { it as? JsonObject } ?: emptyList()
                    for (row in windowRows) {
                        turnFileChangesEvent(sid, row, frameTs, windowRows)?.let { dispatchSessionEvent(it) }
                    }
                    return
                }
                val deltas = payload["deltas"]?.jsonArray ?: return
                for (d in deltas) {
                    val delta = d as? JsonObject ?: continue
                    val opName = delta["op"]?.jsonPrimitive?.jsonStringOrNull
                    if (opName == "row.appended" || opName == "row.upserted") {
                        val row = delta["row"] as? JsonObject ?: continue
                        if (row["kind"]?.jsonPrimitive?.jsonStringOrNull == "turnHeader") {
                            turnFileChangesEvent(sid, row, frameTs)?.let { dispatchSessionEvent(it) }
                        }
                        continue
                    }
                    if (opName != "state.updated") continue
                    val meta = delta["patch"]?.jsonObject?.get("meta")?.jsonObject ?: continue
                    val title = meta["title"]?.jsonPrimitive?.jsonStringOrNull?.takeIf { it.isNotBlank() } ?: continue
                    ProtocolLog.info("[title-sub] meta.title synthesized from v4 frame: $sid title=${title.take(30)}")
                    dispatchSessionEvent(SessionEvent(
                        type = "session.titleUpdated",
                        seq = 0L,
                        sessionId = sid,
                        timestamp = System.currentTimeMillis(),
                        traceId = null,
                        turnId = null,
                        deliveryKind = null,
                        payload = buildJsonObject {
                            put("title", title)
                            meta["titleSource"]?.jsonPrimitive?.jsonStringOrNull?.let { put("source", it) }
                        },
                    ))
                    break // 一帧内多个 meta.title delta 取首个即可（均为同一权威值）
                }
                return
            }
            if (sid !in v4SubscribedSessions) return
            val frame = effectiveParams["frame"]?.jsonObject ?: return
            // 帧到达诊断（缺陷AO 终测：live 在快照后停更——区分"服务端没推帧"vs
            // "帧到了没渲染"）：每会话首帧 + 每 100 帧打一条心跳计数。
            // mapped=累计映射产出事件数——帧计数增长而 mapped 停滞 = 行表/映射层
            // 把 delta 全部判空（如 rowId 未登记），推送层无从推起
            val n = v4FrameProbe.merge(sid, 1L, Long::plus)
            val events = try {
                v4FrameMapper.mapFrame(sid, frame)
            } catch (e: Exception) {
                ProtocolLog.error("[ZCodeProtocolClient] v4 frame map error (frame dropped): ${e.javaClass.simpleName}: ${e.message}")
                return
            }
            v4MappedProbe.merge(sid, events.size.toLong(), Long::plus)
            val payload = frame["payload"]?.jsonObject
            if (n != null && (n == 1L || n % 100L == 0L)) {
                val pk = payload?.get("kind")?.jsonPrimitive?.jsonStringOrNull ?: "?"
                val ds = (payload?.get("deltas")?.jsonArray)?.size ?: -1
                ProtocolLog.debug("[V4FrameProbe] $sid frame#$n payload=$pk deltas=$ds mapped=${v4MappedProbe[sid] ?: 0L}")
            }
            // 空壳帧首遇 dump（增量零产出追查 2026-09-02）：payload.kind=deltas 但数组为空
            // ——服务端 resync/recovery 的"已追平"应答。原文含 fromSeq/toSeq/deliveryKind/
            // subscriptionId，直接暴露帧的路由身份与游标状态
            if (payload != null
                && payload["kind"]?.jsonPrimitive?.jsonStringOrNull == "deltas"
                && (payload["deltas"]?.jsonArray ?: kotlinx.serialization.json.JsonArray(emptyList())).isEmpty()
            ) {
                val dumped = v4EmptyDumped.add(sid)
                if (dumped) {
                    ProtocolLog.debug("[V4FrameProbe] empty-frame dump $sid: ${frame.toString().take(600)}")
                }
            }
            for (ev in events) dispatchSessionEvent(ev)
        }
    }

    /** 从 v4 帧 payload 提取后台工作投影，合成 SessionEvent；帧内无该字段返回 null */
    private fun extractBackgroundWorks(sid: String, payload: JsonObject?): SessionEvent? {
        payload ?: return null
        val works: kotlinx.serialization.json.JsonArray = when (
            payload["kind"]?.jsonPrimitive?.jsonStringOrNull
        ) {
            "snapshot" -> payload["snapshot"]?.jsonObject?.get("backgroundWorks") as? kotlinx.serialization.json.JsonArray
            "deltas" -> {
                // 逐 delta 扫，取最后一个带 backgroundWorks 的 state.updated（一帧内多 delta
                // 均为同代投影，末位即最新；全量替换语义无需 diff）
                var latest: kotlinx.serialization.json.JsonArray? = null
                for (d in payload["deltas"]?.jsonArray ?: kotlinx.serialization.json.JsonArray(emptyList())) {
                    val delta = d as? JsonObject ?: continue
                    if (delta["op"]?.jsonPrimitive?.jsonStringOrNull != "state.updated") continue
                    val bw = delta["patch"]?.jsonObject?.get("backgroundWorks")
                        as? kotlinx.serialization.json.JsonArray ?: continue
                    latest = bw
                }
                latest
            }
            else -> null
        } ?: return null
        // 进程级投影缓存（历史加载兜底）：同 topic 重复 v4 subscribe 幂等、服务端不重推
        // initial 快照（B2②坑），跨标签/重复打开会话时订阅快照帧缺席、前端 map 无数据——
        // 打开会话时经 listBackgroundWorks(op) 从此缓存补齐。会话删除时随 closeSession 清理
        backgroundWorksCache[sid] = works
        return SessionEvent(
            type = "backgroundWorks",
            seq = 0L,
            sessionId = sid,
            timestamp = System.currentTimeMillis(),
            traceId = null,
            turnId = null,
            deliveryKind = null,
            payload = buildJsonObject { put("works", works) },
        )
    }

    /** 会话事件统一分发：per-session 监听器 + 全局监听器（session/event 与 v4 映射共用出口） */
    private fun dispatchSessionEvent(event: SessionEvent) {
        eventListeners[event.sessionId]?.forEach { it(event) }
        globalListeners.forEach { it(event) }
    }

    /**
     * 注入合成会话事件（走与真实通知完全相同的分发链）。远程桥用：手机经 v4/command
     * 发的消息在 legacy 面没有独立事件，宿主就地合成 turn.userInput 补 IDE 侧实时气泡。
     * seq=0/turnId=null 合成标记；下游按 payload.messageId 幂等去重，重放安全。
     */
    fun emitSyntheticEvent(event: SessionEvent) = dispatchSessionEvent(event)

    // ============ v4 网关（手机远程会话流式底座） ============

    /** v4 帧监听器（params = v4/conversation/frame 的完整通知参数，含 topic/subscriptionId/frame） */
    private val v4FrameListeners = ConcurrentHashMap.newKeySet<(JsonObject) -> Unit>()

    /** wire 分片重组器（wireVersion 3 fragment 帧；缺陷EK——大会话快照分片此前全被丢弃） */
    private val wireAssembler = V4WireAssembler()

    /**
     * 逻辑帧监听器（wire 分片重组后的 {topic, frame}，V4WireAssembler 产物分发通道）。
     * fragment 分片对原始透传通道不可见——快照水位捕获等「要吃完整逻辑帧」的消费方挂
     * 本通道；远程桥保持挂原始 v4FrameListeners（H5 侧自管 wire 协议，不能收到重组后的
     * 重复帧）
     */
    private val v4LogicalFrameListeners = ConcurrentHashMap.newKeySet<(JsonObject) -> Unit>()

    fun addV4FrameListener(listener: (JsonObject) -> Unit): () -> Unit {
        v4FrameListeners.add(listener)
        return { v4FrameListeners.remove(listener) }
    }

    fun addV4LogicalFrameListener(listener: (JsonObject) -> Unit): () -> Unit {
        v4LogicalFrameListeners.add(listener)
        return { v4LogicalFrameListeners.remove(listener) }
    }

    /**
     * 订阅会话帧流（ack={subscriptionId, mode, logEpoch}）。workspacePath 对齐官方宿主
     * subscribeConversationV4 形状（{topic, connectionId, clientMode, workspace}）——
     * app-server 的 sessions-index topic 按工作区路由，缺 workspace 可能无初始快照帧
     * （2026-09-22 真机：新桥订阅后零下行帧）。
     */
    fun v4ConversationSubscribe(
        topic: String,
        connectionId: String,
        clientMode: String = "web-remote-replayable",
        workspacePath: String? = null,
    ): JsonObject = requestResult("v4/conversation/subscribe") {
        put("topic", topic)
        put("connectionId", connectionId)
        put("clientMode", clientMode)
        workspacePath?.let {
            put("workspace", buildJsonObject {
                put("workspacePath", it)
                put("workspaceKey", it)
            })
        }
    }

    fun v4ConversationUnsubscribe(
        topic: String,
        subscriptionId: String,
        connectionId: String,
        workspacePath: String? = null,
    ): JsonObject = requestResult("v4/conversation/unsubscribe") {
        put("topic", topic)
        put("subscriptionId", subscriptionId)
        put("connectionId", connectionId)
        workspacePath?.let {
            put("workspace", buildJsonObject {
                put("workspacePath", it)
                put("workspaceKey", it)
            })
        }
    }

    /** 会话行分页读取（历史消息；返回 {rows, atSeq, atLogEpoch, hasMore}） */
    fun v4RowsRange(sessionId: String, connectionId: String, limit: Int = 200): JsonObject =
        request(
            "v4/conversation/rowsRange",
            buildJsonObject {
                put("sessionId", sessionId)
                put("connectionId", connectionId)
                put("limit", limit)
            },
        )

    /**
     * 同订阅恢复重同步（官方 zcodeAgentService.resyncConversationV4 同款语义）：
     * subscriptionId 精确命中现有订阅、**不新建 id**——重订阅会产生新 id，H5 按帧内
     * id 与已注册值严格匹配，失配即静默丢弃重推的快照（2026-09-22 对照开源定案）。
     * base=null + forceSnapshot=true = 放弃增量水位、整段重放快照。
     * 快照帧经 v4/conversation/frame 通知到达（帧泵已透传）。
     */
    fun v4ConversationResync(
        topic: String,
        subscriptionId: String,
        connectionId: String,
        forceSnapshot: Boolean = true,
        workspacePath: String? = null,
    ): JsonObject = requestResult("v4/conversation/resync") {
        put("topic", topic)
        put("subscriptionId", subscriptionId)
        put("connectionId", connectionId)
        put("base", kotlinx.serialization.json.JsonNull)
        if (forceSnapshot) put("forceSnapshot", true)
        workspacePath?.let {
            put("workspace", buildJsonObject {
                put("workspacePath", it)
                put("workspaceKey", it)
            })
        }
    }

    /**
     * v4/command 信封透传（手机远程 sendConversationCommandV4 桥用）：H5 侧自构造
     * 命令信封（sendText/createSession 等），宿主只做透传——官方
     * zcodeAgentService.sendConversationCommandV4 本体即 client.request(V4_COMMANDS.command, envelope)。
     * 信封形状由 H5 保证（含 commandId/clientId/sessionId/type/payload/CAS 基准）。
     */
    fun v4CommandRaw(envelope: JsonObject, timeoutMs: Long = 30_000): JsonObject =
        requestResultRaw("v4/command", envelope, timeoutMs)

    /**
     * v4/conversation/backgroundBashOutput — 后台 bash 任务输出快照（H7 面板输出面）。
     * 只读观察（不 hydrate 冷会话，任务须由现有 runtime 授权）。响应两形态：
     * {kind:"output", output≤8KB, truncated, outputPath, status} 或
     * {kind:"unavailable"|"unsupported"|"read_failed", code?}——原样透传，前端分支展示。
     * 幂等只读，超时可安全重发。
     */
    fun backgroundBashOutput(sessionId: String, workId: String, timeoutMs: Long = 10_000): JsonObject {
        val params = buildJsonObject {
            put("sessionId", sessionId)
            put("workId", workId)
        }
        val r = requestWithRetry("v4/conversation/backgroundBashOutput", params, timeoutMs, maxAttempts = 2, backoffMs = longArrayOf(500))
        r["error"]?.let { throw ZCodeProtocolException.fromError(it) }
        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
    }

    /**
     * v4/command cancelBackgroundWork — 取消后台工作（bash 任务/workflow run；子代理经
     * 既有 cancelBackgroundTask）。**刻意不带 baseRevision**（官方 command.ts 注释同款：
     * 免 revision，假 CAS 失败只会误伤）；拒绝以 ACK fault.backgroundWorkCancelRejected.
     * {not_found|not_running|cancel_not_supported} 回，不抛协议错误，原样返回供前端分支。
     */
    fun cancelBackgroundWork(sessionId: String, workId: String, timeoutMs: Long = 15_000): JsonObject {
        val envelope = buildJsonObject {
            put("commandId", "bgcancel-${java.util.UUID.randomUUID()}")
            put("clientId", "zcode-idea-plugin")
            put("sessionId", sessionId)
            put("type", "cancelBackgroundWork")
            put("payload", buildJsonObject { put("workId", workId) })
            put("issuedAt", System.currentTimeMillis())
        }
        val r = request("v4/command", envelope, timeoutMs)
        requireOk(r)
        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
    }

    /**
     * workspace/hooks/trustGrant — 工作区钩子信任授予（单 hookDeclarationDigest）。
     *
     * 与 CLI 写盘的本质差异：RPC 成功后 app-server 会对同 workspaceKey 的全部运行中
     * 会话重载钩子信任（会话级 admission 重算并推送投影），信任在当前会话立即生效、
     * 待审横幅随投影消失；CLI 外部写盘只改共享 trust store，运行中会话感知不到，
     * 只能等新会话（真机实证）。
     *
     * workspace 键规则（zcode.cjs workspaceKey() + superRefine 校验）：无 identity 时
     * key = path 原样，且必须与 createSession/resume 传入的同款归一形态（原生分隔符）
     * 一致——否则服务端 reload 的会话匹配不命中，退化为「新会话才生效」。
     *
     * result={accepted, reasonCode?}：accepted=false 不走 JSON-RPC error，由调用方
     * 按 reasonCode 提示（bundle_changed/snapshot_mismatch 等）。
     */
    fun workspaceHooksTrustGrant(
        workspacePath: String,
        bundleDigest: String,
        hookDeclarationDigest: String,
        timeoutMs: Long = 15_000,
    ): JsonObject {
        val nativePath = workspacePath.replace('/', File.separatorChar)
        val params = buildJsonObject {
            put("workspace", buildJsonObject {
                put("workspacePath", nativePath)
                put("workspaceKey", nativePath)
            })
            put("bundleDigest", bundleDigest)
            put("hookDeclarationDigest", hookDeclarationDigest)
        }
        val r = request("workspace/hooks/trustGrant", params, timeoutMs)
        requireOk(r)
        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
    }

    /**
     * v4/command reloadWorkspaceHookTrust — 通知 app-server 重读共享信任存储。
     *
     * CLI 写盘（grant 回退路径/revoke）后追加一发：服务端以盘上最新记录替换协调器
     * 内存态，运行中会话的下一次钩子准入评估即改用新信任态。无命令参数；信封
     * sessionId 仅做路由，传当前活跃会话。
     */
    fun reloadWorkspaceHookTrust(sessionId: String, timeoutMs: Long = 15_000): JsonObject {
        val envelope = buildJsonObject {
            put("commandId", "hooktrust-reload-${java.util.UUID.randomUUID()}")
            put("clientId", "zcode-idea-plugin")
            put("sessionId", sessionId)
            put("type", "reloadWorkspaceHookTrust")
            put("payload", JsonObject(emptyMap()))
            put("issuedAt", System.currentTimeMillis())
        }
        val r = request("v4/command", envelope, timeoutMs)
        requireOk(r)
        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
    }

    /**
     * session/read 完整结果（手机远程桥用：settings/runtime/消息基线一次取齐）。
     * @param messageLimit 官方语义（zcode.cjs Gpa）：>0 时仅返回最近 N 条消息（H5
     *   readSession 请求固定带 messageLimit=1——H5 渲染异常）
     */
    fun readSessionFull(sessionId: String, timeoutMs: Long = 10000, messageLimit: Int? = null): JsonObject {
        val params = buildJsonObject {
            put("sessionId", sessionId)
            messageLimit?.let { put("messageLimit", it) }
        }
        val r = requestWithRetry("session/read", params, timeoutMs, maxAttempts = 2, backoffMs = longArrayOf(500))
        r["error"]?.let { throw ZCodeProtocolException.fromError(it) }
        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
    }

    /** workspace/readState（手机远程 readWorkspaceState 桥：settings/slashCommands 权威源） */
    fun workspaceReadState(workspace: Workspace, timeoutMs: Long = 10000): JsonObject {
        val params = buildJsonObject {
            put("workspace", buildJsonObject {
                put("workspacePath", workspace.workspacePath)
                put("workspaceKey", workspace.workspaceKey)
            })
        }
        val r = requestWithRetry("workspace/readState", params, timeoutMs, maxAttempts = 2, backoffMs = longArrayOf(500))
        r["error"]?.let { throw ZCodeProtocolException.fromError(it) }
        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
    }

    // ============ 底层发送 ============

    /**
     * 账号渠道激活推送：provider/updateAccountConfig（Account Overlay 内存资格位）。
     * 在 start() 就绪探测后由后台线程调用（每次 app-server 启动至多一次）。全程
     * fail-soft：无 Built-in 文件/无可用凭证/CLI 拒绝/超时都只打日志——账号渠道
     * 保持 fail-closed 是可接受的现状（此前一直如此），不能反过来阻断会话主流程。
     */
    private fun pushAccountOverlay(zcodePath: Path) {
        try {
            val builtin = BuiltinModelCatalog.locateBuiltinFile(zcodePath)
            val overlay = builtin?.let { AccountProviderBridge.buildAccountOverlay(it) }
            if (builtin == null || overlay == null) {
                println("[ZCodeAccountOverlay] push skipped: builtin file or credentials unavailable (account channels stay fail-closed)")
                return
            }
            val result = request(
                "provider/updateAccountConfig",
                buildJsonObject {
                    put("revision", overlay.revision)
                    put("basedOnZCodeBuiltinRevision", overlay.basedOnZCodeBuiltinRevision)
                    put("providers", overlay.providers)
                    put("states", overlay.states)
                },
                timeoutMs = 15_000,
            )
            requireOk(result)
            accountOverlayPushed = true
            val payload = result["result"]?.jsonObject
            val status = payload?.get("status")?.jsonPrimitive?.jsonStringOrNull ?: "?"
            val count = payload?.get("providerCount")?.jsonPrimitive?.contentOrNull ?: "?"
            println("[ZCodeAccountOverlay] pushed: status=$status providerCount=$count providers=${overlay.providers.keys}")
        } catch (e: Exception) {
            println("[ZCodeAccountOverlay] push failed (fail-soft, account channels stay unavailable): ${e.message}")
        }
    }

    /** updateAccountConfig 已成功落地（幂等去重用；后台推送线程与同步 ensure 竞态无害，
     *  CLI 按 revision 去重返回 unchanged） */
    @Volatile
    private var accountOverlayPushed = false

    /**
     * 同步确保账号渠道激活推送已落地（幂等，可重复调用）。
     *
     * start() 的推送是后台异步的——主 client 靠「spawn 到首次发消息」的自然间隔掩盖，
     * 但润色等首次请求立刻就发的调用方会在推送落地前撞 -32603「Provider Registry
     * 中不存在」（0.3.8 实测：推送比首条 generateText 晚 70ms）。轻任务专用实例
     * start 后、首个 generateText 前调用本方法。
     */
    fun ensureAccountOverlayPushed(zcodePath: Path) {
        if (accountOverlayPushed || generation != ProtocolGeneration.NEW) return
        pushAccountOverlay(zcodePath)
    }

    /** 发送客户端请求并等待响应 */
    /** request + 解包 result（error 抛 ZCodeProtocolException）——v4 网关方法族专用。
     *  此前 v4ConversationSubscribe 直接回完整响应，handler 按解包后形状取 ack["ack"]
     *  恒为空 → H5 收到空 ack 判订阅失败，v4 渲染门禁不放行（会话页空白的直接根因，
     *  2026-09-22 真机 CDP 帧对照官方宿主定位）。 */
    private fun requestResult(method: String, timeoutMs: Long = 20_000, params: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit): JsonObject {
        val r = request(method, buildJsonObject(params), timeoutMs)
        r["error"]?.let { throw ZCodeProtocolException.fromError(it) }
        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
    }

    private fun requestResultRaw(method: String, params: JsonObject, timeoutMs: Long = 20_000): JsonObject {
        val r = request(method, params, timeoutMs)
        r["error"]?.let { throw ZCodeProtocolException.fromError(it) }
        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
    }

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
        } catch (e: ExecutionException) {
            // readLoop 退出时集中 fail（进程退出/崩溃）：解包抛原始异常，
            // 避免 ExecutionException 的全限定类名前缀漏进用户可见文案
            pendingResponses.remove(id)
            throw e.cause as? Exception ?: IOException("app-server 连接已断开", e)
        }
    }

    /**
     * 启动期 stderr 尾部留存（脱敏后，进程生命周期内累计、上限 16 行）：秒退/超时
     * 报错时直接引用 stderr 原文与已知根因翻译，用户不再需要翻 idea.log 找第一现场。
     */
    private val stderrTail = ArrayDeque<String>()
    private val stderrTailLock = Any()

    private fun recordStderr(redactedLine: String) {
        synchronized(stderrTailLock) {
            stderrTail.addLast(redactedLine)
            while (stderrTail.size > 16) stderrTail.removeFirst()
        }
    }

    private fun stderrFirstMeaningful(): String = synchronized(stderrTailLock) {
        stderrTail.firstOrNull { it.isNotBlank() } ?: ""
    }

    private fun stderrLastMeaningful(): String = synchronized(stderrTailLock) {
        stderrTail.lastOrNull { it.isNotBlank() } ?: ""
    }

    /** 已知秒退根因的关键字翻译（按 stderr 首行匹配；返回 null = 未知原因走通用文案） */
    private fun explainStartupExit(firstStderr: String): String? = when {
        firstStderr.contains("Built-in Provider Config") ->
            "ZCode CLI 内置渠道目录缺失（provider/zcode-builtin.json）：" +
                "插件自动垫底未成功（客户端从未登录过没有渠道目录源，或 zcode.cjs 所在目录无写权限）。" +
                "手动修复：把客户端自带的 zcode-builtin.json 拷贝到 zcode.cjs 同级 provider/ 目录下"
        firstStderr.contains("node:sqlite") || firstStderr.contains("No such built-in module") ->
            "Node.js 版本过旧：CLI 依赖 node:sqlite 内置模块（Node ≥22.5），" +
                "请在设置 → 基础设置 → 环境中指定更高版本的 Node 路径"
        else -> null
    }

    /**
     * 启动后就绪探测：发一个轻量请求并等待任意响应（result / error 均算就绪——收到
     * 应答即证明 JSON-RPC 循环已活）。
     *
     * 背景（issue #11 崩溃循环）：start() 起进程即返回，首个业务请求独自承担 node
     * 冷启动等待（12MB bundle 解析 + 杀软首扫，慢机器 10s+）；session/create 等非幂等
     * 方法禁止超时重试，一次撞墙就直接报错。探测把冷启动等待收敛到进程生命周期起点：
     * 崩溃/秒退场景经 send()（checkError 检出断管）或 readLoop 退出（pending 被 fail）
     * 快速失败，慢启动场景安静等待——两者共同保证"返回的 client 必然已就绪"。
     *
     * 探测选 session/list + limit=1：插件既有的最轻幂等读，全版本 CLI 支持、无副作用。
     */
    fun awaitReady(timeoutMs: Long) {
        val startedAt = System.currentTimeMillis()
        val id = idCounter.incrementAndGet()
        val future = CompletableFuture<JsonObject>()
        pendingResponses[id] = future
        // 进程秒退时 send() 的 checkError 在此抛 IOException（断管），直接走 start() 的失败收尾
        send(buildJsonObject {
            put("id", id)
            put("method", "session/list")
            put("params", buildJsonObject { put("limit", 1) })
        })
        try {
            future.get(timeoutMs, TimeUnit.MILLISECONDS)
            println("[ZCodeProtocolClient] app-server ready in ${System.currentTimeMillis() - startedAt}ms (probe=session/list)")
        } catch (e: TimeoutException) {
            pendingResponses.remove(id)
            val last = stderrLastMeaningful()
            throw IOException(
                "app-server 启动超时：${timeoutMs / 1000} 秒内未响应就绪探测，进程可能已崩溃" +
                    (if (last.isNotEmpty()) "；stderr 尾行：$last" else "（第一现场见 idea.log 中 \"app-server stderr\" 行）") +
                    "；常见原因：node 版本过旧、ZCode 客户端损坏"
            )
        } catch (e: ExecutionException) {
            pendingResponses.remove(id)
            val cause = e.cause as? Exception ?: e
            val first = stderrFirstMeaningful()
            val explained = explainStartupExit(first)
            throw IOException(
                explained
                    ?: buildString {
                        append("app-server 进程启动后即退出")
                        if (first.isNotEmpty()) append("：").append(first)
                        else append("（第一现场见 idea.log 中 \"app-server stderr\" 行；常见原因：node 版本过旧、ZCode 客户端损坏）")
                    },
                cause
            )
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

    /**
     * 原始发送（经 StdinWriteGate 串行 + 限时）：写入顺序由门禁单执行器 FIFO 保证
     * （等价原 sendLock 串行语义）；写失败/阻塞超时的异常语义——
     * BROKEN_PIPE/WRITE_ERROR = 进程死/断管（旧行为文案）；TIMEOUT/DEAD = 写入
     * 阻塞判死，进程已被 kill 等待重建（app-server-silent-hang 三/四例）。
     */
    private fun send(msg: JsonObject) {
        val method = msg["method"]?.jsonPrimitive?.jsonStringOrNull
        when (writeGate.submit(method) {
            stdin.println(msg.toString())
            stdin.flush()
            // PrintWriter 吞底层 IO 异常：app-server 进程死后写入静默失败，请求只会
            // 表现为超时——checkError 显式检出写失败，让调用方立即感知连接已断
            !stdin.checkError()
        }) {
            WriteOutcome.OK -> return
            WriteOutcome.BROKEN_PIPE, WriteOutcome.WRITE_ERROR ->
                throw IOException("app-server stdin 写入失败（进程可能已退出），method=$method")
            WriteOutcome.TIMEOUT, WriteOutcome.DEAD ->
                throw IOException("app-server stdin 写入阻塞超时，已判定进程挂死并终止（等待自动重建），method=$method")
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
     *
     * [includeArchived] 仅 CLI <0.17.0 生效（该版起参数从 strict schema 删除）；
     * ≥0.17.0 取归档会话须走 [listArchivedSessions]（sessionIds 显式身份查询）。
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
        val merged = (primary + alt.filter { it.sessionId !in primaryIds })
            .sortedWith(compareByDescending { it.updatedAt })

        // fork/目标模式补查（diag-fork21 定案）：session/list 的 DB 查询固定 roots=true
        // （只查 parent_id IS NULL 的根会话），fork 会话天然被排除——fork 刚发生时
        // 靠 app-server 内存补列可见，重启后（新进程纯查 DB）就从列表消失、恢复标签
        // 也因列表查不到退化为空白。目标模式会话同理（session_target 关联列表不暴露）。
        // 官方客户端走 sessions-index v4 索引（含 fork），legacy 协议参数（schema strict）
        // 无口子放开，故直读 db.sqlite 补齐（与删除会话/归档同一数据源）。fail-soft：
        // 查询失败保持原列表，宁少显示不拖垮主流程
        val nativeDir = workspacePath.replace('/', File.separatorChar)
        val forkDir = workspacePath.replace('\\', '/')
        val extras = querySessionExtrasFromDb(nativeDir, forkDir)
        // fork+goal 可同属一会话：两路标识都打上
        val forks = extras.forks.map {
            if (it.sessionId in extras.goalIds) it.copy(goalTarget = true) else it
        }
        if (forks.isEmpty() && extras.goalIds.isEmpty()) return merged
        val forkIds = forks.mapTo(HashSet()) { it.sessionId }
        val knownIds = merged.mapTo(HashSet()) { it.sessionId }
        // 内存驻留行（fork 刚发生时的补列）sessionKind=interactive 且 title 为空，按
        // sqlite 的 fork id 集合统一打标——前端 fork 徽标判据收敛为单一来源
        // sessionKind==='fork'（diag-fork23：内存行与补查行形态不一致的弥合）
        val marked = merged.map {
            val isFork = it.sessionId in forkIds
            val isGoal = it.sessionId in extras.goalIds
            when {
                isFork && isGoal -> it.copy(sessionKind = "fork", goalTarget = true)
                isFork -> it.copy(sessionKind = "fork")
                isGoal -> it.copy(goalTarget = true)
                else -> it
            }
        }
        return (marked + forks.filter { it.sessionId !in knownIds })
            .sortedWith(compareByDescending { it.updatedAt })
    }

    /** [listSessions] 补查结果：fork 会话行 + 目标模式会话 id 集（可同属一个会话） */
    private data class SessionExtras(val forks: List<SessionInfo>, val goalIds: Set<String>)

    /**
     * 直读 ~/.zcode/cli/db/db.sqlite 补查当前工作区的 fork 会话与目标模式会话
     * （session/list 缺口的补集，见 [listSessions]）。fork 限定 task_type='fork'
     * （parent_id 非空还可能是 subagent_child，混入即子会话泄漏）；goal 取
     * session_target 有行即算（status active/complete 都标识——历史列表表达
     * "这是目标模式会话"，运行态由会话内 GoalCard 呈现）；directory 双形态 IN
     * （斜杠撕裂同因）；title 库里有服务端自动命名的 "Fork of <父标题>"（插件
     * persist 的 "Fork · " 前缀名由前端合并时优先）。失败/超时/库缺失降级空集。
     */
    private fun querySessionExtrasFromDb(nativeDir: String, forkDir: String): SessionExtras {
        if (!java.nio.file.Files.exists(cliDbPath)) return SessionExtras(emptyList(), emptySet())
        return try {
            val pb = ProcessBuilder(nodePath, "-e", SESSION_LIST_EXTRAS_JS)
            pb.environment()["ZCODE_FORK_DB"] = cliDbPath.toString()
            pb.environment()["ZCODE_FORK_DIR_NATIVE"] = nativeDir
            pb.environment()["ZCODE_FORK_DIR_ALT"] = forkDir
            pb.redirectError(ProcessBuilder.Redirect.DISCARD)
            val p = pb.start()
            val out = p.inputStream.bufferedReader().readText()
            if (!p.waitFor(10, TimeUnit.SECONDS) || p.exitValue() != 0) {
                return SessionExtras(emptyList(), emptySet())
            }
            val o = Json.parseToJsonElement(out.trim()).jsonObject
            val forks = o["forks"]?.jsonArray?.mapNotNull { el ->
                try {
                    val r = el.jsonObject
                    SessionInfo(
                        sessionId = r["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null,
                        title = r["title"]?.jsonPrimitive?.contentOrNull ?: "",
                        sessionKind = "fork",
                        workspace = Workspace(nativeDir),
                        createdAt = r["time_created"]?.jsonPrimitive?.longOrNull ?: 0L,
                        updatedAt = r["time_updated"]?.jsonPrimitive?.longOrNull ?: 0L,
                    )
                } catch (e: Exception) {
                    null
                }
            } ?: emptyList()
            val goals = o["goalIds"]?.jsonArray
                ?.mapNotNullTo(HashSet()) { it.jsonPrimitive.contentOrNull }
                ?: emptySet()
            SessionExtras(forks, goals)
        } catch (e: Exception) {
            println("[ZCodeProtocolClient] session extras query failed (degrading to empty): ${e.message}")
            SessionExtras(emptyList(), emptySet())
        }
    }

    /**
     * @param sessionIds 显式身份查询（≥0.17.0 取隐藏/归档会话的唯一入口，单批 ≤[SESSION_IDS_MAX]）
     */
    private fun listSessionsOnce(
        workspacePath: String?,
        includeArchived: Boolean,
        limit: Int,
        timeoutMs: Long,
        sessionIds: List<String>? = null,
    ): List<SessionInfo> {
        fun buildParams(sendArchived: Boolean) = buildJsonObject {
            if (!workspacePath.isNullOrBlank()) {
                put("workspace", buildJsonObject {
                    put("workspacePath", workspacePath)
                    put("workspaceKey", workspacePath)
                })
            }
            if (sendArchived) put("includeArchived", includeArchived)
            if (!sessionIds.isNullOrEmpty()) {
                put("sessionIds", JsonArray(sessionIds.map { JsonPrimitive(it) }))
            }
            put("limit", limit)
        }
        val sendArchived = includeArchived && canSendIncludeArchived()
        var r = requestWithRetry("session/list", buildParams(sendArchived), timeoutMs, maxAttempts = 2, backoffMs = longArrayOf(500))
        // 版本探测缺失时的兜底：strict schema 拒绝未知 key（0.17.0+），记忆后去 key 原样重发一次
        if (sendArchived && isUnrecognizedKeyError(r["error"], "includeArchived")) {
            includeArchivedRejected = true
            println("[ZCodeProtocolClient] session/list rejected includeArchived (-32602); retrying without it (cli=${appVersion ?: "unknown"})")
            r = requestWithRetry("session/list", buildParams(false), timeoutMs, maxAttempts = 1)
        }
        requireOk(r)

        val sessionsArray = r["result"]?.jsonObject?.get("sessions")?.jsonArray ?: return emptyList()
        return sessionsArray.mapNotNull { elem ->
            try {
                json.decodeFromJsonElement(SessionInfo.serializer(), elem)
            } catch (e: Exception) { null }
        }
    }

    /** -32602 Invalid params 且文案点名某 Unrecognized key（strict schema 拒绝） */
    private fun isUnrecognizedKeyError(errorEl: JsonElement?, key: String): Boolean {
        val e = errorEl?.jsonObject ?: return false
        val code = e["code"]?.jsonPrimitive?.jsonStringOrNull?.toIntOrNull() ?: return false
        val msg = e["message"]?.jsonPrimitive?.jsonStringOrNull ?: return false
        return code == -32602 && msg.contains("Unrecognized key") && msg.contains(key)
    }

    /**
     * 显式身份批量查询会话（≥0.17.0 session/list 取归档等隐藏会话的唯一通道）。
     * 每批 ≤[SESSION_IDS_MAX]，分批失败 fail-soft 保留其余，按 id 去重；工作区路径
     * 双形态各查一遍（斜杠撕裂同 [listSessions]，tasks-index 行可能是任一形态）。
     */
    private fun listSessionsByIds(
        ids: Collection<String>,
        workspacePath: String,
        altWorkspacePath: String? = null,
        timeoutMs: Long,
    ): List<SessionInfo> {
        val distinct = ids.toSet()
        if (distinct.isEmpty()) return emptyList()
        val forms = listOfNotNull(workspacePath, altWorkspacePath?.takeIf { !it.equals(workspacePath, ignoreCase = true) })
        val out = ArrayList<SessionInfo>(distinct.size)
        val seen = HashSet<String>()
        for (form in forms) {
            for (chunk in distinct.chunked(SESSION_IDS_MAX)) {
                val part = try {
                    listSessionsOnce(form, includeArchived = false, limit = chunk.size,
                        timeoutMs = timeoutMs, sessionIds = chunk)
                } catch (e: Exception) {
                    println("[ZCodeProtocolClient] listSessionsByIds chunk failed (${chunk.size}), keeping others: ${LogRedactor.redact(e.message ?: "").take(120)}")
                    emptyList()
                }
                part.forEach { if (seen.add(it.sessionId)) out.add(it) }
            }
        }
        return out
    }

    /**
     * session/create — 创建新会话
     * 注意：服务器会反向发 requestRuntimePreferences，本客户端会自动应答
     *
     * workspacePath 统一转原生分隔符形态写入（0.16.5 起 directory 原样记录传入值，
     * IDE basePath 的正斜杠直传会产生正斜杠行，与历史数据撕裂；project_id 规范化
     * 折叠斜杠差异，两形态同 id，归一写入无归属风险）
     */
    fun createSession(
        workspace: Workspace,
        mode: PermissionMode = PermissionMode.BUILD,
        timeoutMs: Long = 20000,
        thoughtLevel: String? = null,
        mcpServers: List<McpServerSpec>? = null,
    ): String {
        val nativePath = workspace.workspacePath.replace('/', File.separatorChar)
        val params = buildJsonObject {
            put("workspace", buildJsonObject {
                put("workspacePath", nativePath)
                put("workspaceKey", nativePath)
            })
            put("mode", mode.value)
            // 会话创建即落档（缺陷CX 闪最高治本）：create schema 有 thoughtLevel 可选字段
            // （diag-thoughtlevel-create.py 实证）——不落档的话，create 后 webview 例行
            // loadSettings 读到的是服务端初始默认档（max），赶在首条消息 modelSelection
            // 写回之前，UI 出现「预选低→闪最高→回合后回低」的竞态抖动。非法值服务端
            // 静默忽略落默认（fail-soft 实证），不炸建会话
            thoughtLevel?.takeIf { it.isNotBlank() }?.let {
                put("thoughtLevel", it)
            }
            // 电脑控制（CUA）注入通道：顶层 mcpServers 数组（diag-cua-inject.py 实测，
            // stdio 分支 strict 形状见 McpServerSpec 注释）。空/null 不发键
            mcpServers?.takeIf { it.isNotEmpty() }?.let { servers ->
                put("mcpServers", mcpServersJson(servers))
            }
        }
        val r = request("session/create", params, timeoutMs)
        requireOk(r)
        // 会话档缓存写入（sessionId 此刻才可知；create 带档即缓存，供首条 send 的
        // modelSelection 直接取用同值）
        thoughtLevel?.takeIf { it.isNotBlank() }?.let { lvl ->
            val created = r["result"]?.jsonObject
            val sessionObj = created?.get("session")?.jsonObject ?: created
            sessionObj?.get("sessionId")?.jsonPrimitive?.content?.let { sessionThoughtLevels[it] = lvl }
        }

        val result = r["result"]?.jsonObject ?: throw ZCodeProtocolException("create 响应缺 result")
        // 规格书 §2：sessionId 在 result.session.sessionId（兼容顶层 result.sessionId）
        val sessionObj = result["session"]?.jsonObject ?: result
        val sessionId = sessionObj["sessionId"]?.jsonPrimitive?.content
            ?: throw ZCodeProtocolException("create 响应缺 sessionId")
        // 记录注入面：冷恢复 resume 时沿用（源码注释——不沿用会绕过 create 的工具面约束，
        // 尤其 CUA 会话）；同步落盘档案，进程重启后内存记录清零仍可回灌
        // （sess_03b9a979 实锤：内存态记录过不了 IDE 重启，resume 丢 CUA 工具面）
        mcpServers?.takeIf { it.isNotEmpty() }?.let {
            sessionMcpServers[sessionId] = it
            SessionMcpServerStore.record(sessionId, it)
        }
        return sessionId
    }

    /** 会话 → create 时注入的 mcpServers（resume 冷恢复沿用；上限保护防泄漏） */
    private val sessionMcpServers = object : LinkedHashMap<String, List<McpServerSpec>>(64, 0.75f) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, List<McpServerSpec>>): Boolean {
            return size > 200
        }
    }

    private fun mcpServersJson(servers: List<McpServerSpec>): JsonArray = buildJsonArray {
        servers.forEach { s ->
            add(buildJsonObject {
                put("name", s.name)
                put("command", s.command)
                put("args", JsonArray(s.args.map { JsonPrimitive(it) }))
                put("env", JsonArray(s.env.map { (k, v) ->
                    buildJsonObject {
                        put("name", k)
                        put("value", v)
                    }
                }))
                s.isolation?.let { put("isolation", it) }
                s.timeoutMs?.let { put("timeoutMs", it) }
            })
        }
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
        // v2：legacy 流不再推 session.titleUpdated（标题只在 v4 帧 meta.title 广播，
        // 见 v4TitleSessions）。主会话 legacy 订阅成功后异步挂一条仅标题用途的 v4 订阅
        // ——失败静默（标题退化为"切历史/重开会话时 listSessions 刷新"的既有兜底）
        if (generation == ProtocolGeneration.NEW && sessionId !in v4SubscribedSessions
            && v4TitleSessions.add(sessionId)
        ) {
            ProtocolLog.debug("[title-sub] v4 title subscribe launching: $sessionId")
            Thread({
                runCatching {
                    val rr = request("v4/conversation/subscribe", buildJsonObject {
                        put("topic", "conversation/$sessionId")
                        put("connectionId", v4ConnectionId)
                        put("clientMode", deliveryKind)
                    }, timeoutMs)
                    rr["result"]?.jsonObject?.get("ack")?.jsonObject
                        ?.get("subscriptionId")?.jsonPrimitive?.contentOrNull
                        ?.let {
                            v4SubscriptionIds[sessionId] = it
                            ProtocolLog.info("[title-sub] v4 title subscribe ok: $sessionId sub=${it.take(12)}")
                        }
                }.onFailure {
                    v4TitleSessions.remove(sessionId)
                    ProtocolLog.info("[title-sub] v4 title subscribe FAILED (falls back to listSessions refresh): $sessionId: ${it.message?.take(150)}")
                }
            }, "zcode-v4-title-sub").start()
        }
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
        // 先登记再发请求：帧路由按 v4SubscribedSessions 白名单放行（handleNotification 帧分支
        // `sid !in v4SubscribedSessions → return`），而服务端 ack 之后立刻推首帧（initial 快照 +
        // 首批增量）。等 ack 回来才登记会把这批帧静默丢掉（实测竞态：丢快照帧=少 4 条映射事件、
        // 首帧全丢=0 条，V4ConversationStreamTest 全量跑偶发红灯即此；生产表现=订阅后首个快照/
        // 首条内容缺失）。失败回滚登记，保证重试路径可用。
        v4SubscribedSessions.add(sessionId)
        val params = buildJsonObject {
            put("topic", "conversation/$sessionId")
            put("connectionId", v4ConnectionId)
            put("clientMode", "desktop-continuous")
        }
        val r = try {
            request("v4/conversation/subscribe", params, timeoutMs).also { requireOk(it) }
        } catch (e: Exception) {
            v4SubscribedSessions.remove(sessionId)
            throw e
        }
        r["result"]?.jsonObject?.get("ack")?.jsonObject
            ?.get("subscriptionId")?.jsonPrimitive?.contentOrNull
            ?.let { v4SubscriptionIds[sessionId] = it }
        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
    }

    /**
     * v4/conversation/unsubscribe — 退订（best-effort：失败只清本地状态不抛）。
     * 参数三件套全必填：topic+connectionId+subscriptionId（diag-fork20 二分实测：
     * 缺任一均 -32603 ZodError；旧实现缺 subscriptionId 故退订从未成功——服务端侧
     * 自清兜底故无症状）。连接级开销可忽略，不退订也无害；供会话关闭路径收敛使用。
     */
    fun unsubscribeConversationV4(sessionId: String, timeoutMs: Long = 5000) {
        val subId = v4SubscriptionIds.remove(sessionId)
        v4SubscribedSessions.remove(sessionId)
        v4TitleSessions.remove(sessionId)
        v4ProjectionRevisions.remove(sessionId)
        v4FrameProbe.remove(sessionId)
        v4MappedProbe.remove(sessionId)
        v4FrameMapper.cleanup(sessionId)
        try {
            // 服务端 schema 三件套全必填（diag-fork20 二分实测：缺 subscriptionId 或
            // 缺 topic/connectionId 均 -32603 ZodError）
            request("v4/conversation/unsubscribe", buildJsonObject {
                put("topic", "conversation/$sessionId")
                put("connectionId", v4ConnectionId)
                if (subId != null) put("subscriptionId", subId)
            }, timeoutMs)
        } catch (e: Exception) {
            // 退订失败可忽略（连接回收/进程退出时服务端自清）
        }
    }

    /**
     * 会话回合是否活跃（V4FrameMapper 权威投影，快照回放+实时帧共同维护）。
     * 供订阅完成时补推运行相位：重开标签的 webview 没经历过进行中会话的
     * turn.started（快照回放有意不置流式），靠这个知道「会话还在跑」。
     */
    fun isSessionTurnActive(sessionId: String): Boolean = v4FrameMapper.isSessionTurnActive(sessionId)

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
        thoughtLevel: String? = null,
        attachments: List<AttachmentInput>? = null,
    ): JsonObject {
        // 前端 UI 当前档随 send 喂进会话档缓存（缺陷CX）：懒创建首条消息路径 webview
        // 从不下发 setThoughtLevel（防 -32603 赛跑的旧守卫），缓存必 miss——没有这一步，
        // 首回合 modelSelection 只能带目录默认档 max，把用户待命态预选的档位冲掉。
        // 仅写本地缓存不发独立 RPC（协议 send schema strict 无 thoughtLevel 字段，
        // 档位只能搭 modelSelection.options 同行）；值集合法性由 modelSelectionJson
        // 内 resolver 裁决，UI 值陈旧/跨模型非法时自动回退目录默认档
        thoughtLevel?.takeIf { it.isNotBlank() }?.let { sessionThoughtLevels[sessionId] = it }
        // 模型字段按代分支（代际由 start() 判定，无试错）：
        // - OLD：runtimeModel（协议原生形态，对齐官方客户端按回合携带模型）——首条消息即
        //   注册 provider 并让本回合直接跑在目标模型上。setModel 与新建会话首回合在服务端
        //   赛跑会撞 -32603 Unsupported（08-29 定时触发实测：新会话 runtime 未注册任何
        //   provider，available 只有内置目录），send 携带则无此竞态。构造失败（provider 不在
        //   config.json）省略字段走服务端默认，与原行为一致
        // - NEW：modelSelection 模型引用（渠道须已在 providerRegistry = provider_config.json
        //   用户自建渠道；strict schema 拒收 runtimeModel）
        val sentRuntimeModel = if (providerId != null && modelId != null && generation == ProtocolGeneration.OLD) {
            RuntimeModels.buildRuntimeModel(providerId, modelId)
        } else {
            null
        }
        val params = buildJsonObject {
            put("sessionId", sessionId)
            put("content", content)
            if (providerId != null && modelId != null) {
                if (generation == ProtocolGeneration.NEW) {
                    // reasoningLevel 必填（diag-v2-send-silent-fail.py 实证：缺了 send RPC 仍
                    // 返回成功，但 turn 在 model_creation 阶段立即 failed——错误只走
                    // v4/telemetry 事件不进 session/event 流，UI 表现为"一直没有响应"）。
                    // 档位带会话当前值（缺陷CX）：恒带目录默认档 max 会被服务端回合装配
                    // 写回会话，冲掉用户设置的思考档
                    put("modelSelection", modelSelectionJson(providerId, modelId, sessionThoughtLevels[sessionId]))
                } else if (sentRuntimeModel != null) {
                    put("runtimeModel", sentRuntimeModel)
                }
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
            // 故用带模型的 send 原地重试，成功后走正常流式。
            // NEW 代清除机制未知：best effort 带模型引用，失败仍落 CLI 兜底
            if (errCode == -32031) {
                println("[ZCodeProtocolClient] send hit -32031 (restoreWarning), retrying with model")
                // 优先用用户当前选择的 provider 构造（跟随前端 currentModel），避免恢复链路
                // 用默认 provider 把会话静默切到个人套餐；构造失败回退默认 factory
                val runtimeModel = if (providerId != null && modelId != null && generation == ProtocolGeneration.OLD) {
                    RuntimeModels.buildRuntimeModel(providerId, modelId) ?: runtimeModelFactory()
                } else {
                    runtimeModelFactory()
                }
                if (generation == ProtocolGeneration.OLD && runtimeModel != null) {
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
                } else if (generation == ProtocolGeneration.NEW && providerId != null && modelId != null) {
                    println("[ZCodeProtocolClient] -32031 retry with modelSelection (NEW cli)")
                    val retryParams = buildJsonObject {
                        put("sessionId", sessionId)
                        put("content", content)
                        put("modelSelection", modelSelectionJson(providerId, modelId, sessionThoughtLevels[sessionId]))
                        if (!attachments.isNullOrEmpty()) {
                            put("attachments", buildAttachmentsJson(attachments))
                        }
                    }
                    r = request("session/send", retryParams, timeoutMs)
                    if (r["error"] == null) {
                        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
                    }
                    println("[ZCodeProtocolClient] modelSelection retry still rejected: ${LogRedactor.redact(r["error"].toString())}")
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

    /** attachments → session/send 请求体（协议通道原生形态 {kind,filename,mimeType,sizeBytes,dataBase64,localPath,textContent}）*/
    private fun buildAttachmentsJson(attachments: List<AttachmentInput>): JsonArray = buildJsonArray {
        attachments.forEach { a ->
            add(buildJsonObject {
                put("kind", a.kind)
                put("filename", a.filename)
                put("mimeType", a.mimeType)
                a.sizeBytes?.let { put("sizeBytes", it) }
                a.dataBase64?.let { put("dataBase64", it) }
                a.localPath?.let { put("localPath", it) }
                a.textContent?.let { put("textContent", it) }
            })
        }
    }

    /**
     * CLI 通道代理注入（与 app-server 主通道同源 setting.json，issue #12）：
     * cliOneShot / sendViaCliResume 的 env 是 clear() 后的白名单，代理变量组
     * 须显式补上，保证降级通道与主通道网络行为一致
     */
    private fun applyProxyEnv(pb: ProcessBuilder) {
        val cfg = ProxyConfigStore.read().takeIf { !it.isEmpty }
        cfg?.toEnvMap()?.let { pb.environment().putAll(it) }
        println("[ZCodeProxy] CLI subprocess spawn ${cfg?.logSummary ?: "<no proxy, direct>"}")
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
        applyProxyEnv(pb)
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
        processHook: ((Process) -> Unit)? = null,
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
        applyProxyEnv(pb)
        pb.redirectErrorStream(false)

        val proc = pb.start()
        processHook?.invoke(proc)
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
     * 轻任务（润色/标题）快速通道的首选思考档：disabled > low > null（null=不传，
     * 服务端落目录默认档）。默认档 max 的思考时长把短输入也拖到 13s+（2026-09-28
     * diag 实测：短输入 max 13s vs low 3s，长输入压线 45s 超时），润色/标题类
     * 不需要深思考；模型值集不含两者时回退默认（resolveSelectionReasoningLevel 兜底）。
     */
    fun lightReasoningLevel(modelId: String): String? {
        val values = BuiltinModelCatalog.reasoningValues(modelId, zcodePath) ?: return null
        return when {
            "disabled" in values -> "disabled"
            "low" in values -> "low"
            else -> null
        }
    }

    /**
     * workspace/generateText — 常驻 app-server 上的一次性文本生成（无会话、无 agent 系统上下文）。
     *
     * 与 CLI -p 通道的本质差异（2026-08-26 协议直连实测）：裸 AI SDK generateText，
     * input 仅本方法的消息（实测 30 token vs CLI 通道 14858），无进程冷启动；
     * 不产生会话记录（session/list 前后不变），workspace 同会话时复用 warm app。
     *
     * 前置条件（按代）：OLD——modelRef 指向的 provider 须已在 workspace 目录注册
     * （setModel runtimeModel 时顺带注册），未注册报 -32603 可 upsert 自愈；
     * NEW——selection 指向的模型须已在 providerRegistry（provider_config.json 用户
     * 自建渠道；upsert 方法已删，无自愈）。请求字段按代 modelRef/selection，
     * 响应 NEW 为 {text, selection{...}}、OLD 为 {text, modelRef{...}}（调用方双读）。
     *
     * @return result：{text, selection|modelRef{providerId,modelId}, finishReason?, usage?}
     */
    fun generateText(
        workspacePath: String,
        providerId: String,
        modelId: String,
        prompt: String,
        systemPrompt: String? = null,
        querySource: String = "workspace_prompt_enhance",
        timeoutMs: Long = 60000,
        reasoningLevel: String? = null,
        operationId: String? = null,
    ): JsonObject {
        val nativePath = workspacePath.replace('/', File.separatorChar)
        val params = buildJsonObject {
            put("workspace", buildJsonObject {
                put("workspacePath", nativePath)
                put("workspaceKey", nativePath)
            })
            // 模型字段按代分支：OLD=modelRef / NEW=selection（2026-09-17 schema 实挖改名）
            val key = if (generation == ProtocolGeneration.NEW) "selection" else "modelRef"
            if (generation == ProtocolGeneration.NEW) {
                // v2 selection 必带 options.reasoningLevel（缺失报 "Reasoning level is
                // required"，润色/标题快速通道曾因此全量降级 CLI）；显式传轻量档时按值
                // 传递（值集不含时 resolveSelectionReasoningLevel 回退默认档）
                put(key, modelSelectionJson(providerId, modelId, reasoningLevel))
            } else {
                put(key, buildJsonObject {
                    put("providerId", providerId)
                    put("modelId", modelId)
                })
            }
            // v2 请求顶层 maxOutputTokens 参与模型选项强校验（缺省报 "outside the model
            // option range"，diag-v2-generatetext-reasoning.py 实挖）；标题/润色输出很短，
            // 取模型档位上限与 8192 的较小值。OLD 无此校验不传
            if (generation == ProtocolGeneration.NEW) {
                put("maxOutputTokens", minOf(BuiltinModelCatalog.maxOutputTokensMax(modelId, zcodePath) ?: 8192L, 8192L))
            }
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
            // 取消句柄：服务端按 operationId 注册 AbortController，workspace/cancelGenerateText
            // 传同 id 即中止（schema strict 可选字段；重复 operationId 报 -32600 already active）
            if (operationId != null) {
                put("operationId", operationId)
            }
        }
        val r = request("workspace/generateText", params, timeoutMs)
        requireOk(r)
        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
    }

    /**
     * workspace/cancelGenerateText — 中止在途的 generateText（插队旁路，不用等串行队列）。
     *
     * @return 服务端回执 cancelled：true=已中止在途请求；false=无此 operationId 的在途请求
     */
    fun cancelGenerateText(operationId: String, timeoutMs: Long = 5000): Boolean {
        val r = request(
            "workspace/cancelGenerateText",
            buildJsonObject { put("operationId", operationId) },
            timeoutMs,
        )
        requireOk(r)
        return r["result"]?.jsonObject?.get("cancelled")?.jsonPrimitive?.booleanOrNull ?: false
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

    /**
     * provider/testModelConnectivity — 渠道连通性测试（2026-09-21 开源源码确认）。
     *
     * 服务端行为（workspace-model-runtime.ts）：先强制 refreshProviderRegistry
     * （「跨进程 watcher 可能永久漏掉原子写事件」——外部直写 provider_config.json 后
     * 调它即生效，插件无需自测），再对 selection 真发一次最小模型请求。成功回
     * {success:true}；失败走 JSON-RPC error（message 为服务端原始报错，含
     * provider.notInRegistry / 鉴权失败 / 网络错误等）。
     *
     * 仅 NEW 代支持（providerRegistry 体系方法，OLD 代 -32601，调用方按代际分流）。
     * selection 复用 [modelSelectionJson]（含 reasoningLevel 默认档，缺了报
     * "Reasoning level is required"）。
     */
    fun testModelConnectivity(
        workspacePath: String,
        providerId: String,
        modelId: String,
        timeoutMs: Long = 30_000,
    ) {
        val nativePath = workspacePath.replace('/', File.separatorChar)
        val params = buildJsonObject {
            put("workspace", buildJsonObject {
                put("workspacePath", nativePath)
                put("workspaceKey", nativePath)
            })
            put("selection", modelSelectionJson(providerId, modelId))
        }
        val r = request("provider/testModelConnectivity", params, timeoutMs)
        requireOk(r)
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

    /**
     * v4 临时订阅（forkAssistant/editUserQuery 共用块）：订阅只为取 ack.logEpoch
     * （rowsRange 信封 + CAS baseLogEpoch）并记 subscriptionId（退订要用），不进
     * v4SubscribedSessions 白名单——initial snapshot 帧进白名单会被 V4FrameMapper
     * 回放出全量事件推给会话标签，前端误入流式态（diag-fork19 定案）。
     *
     * @return ack.logEpoch
     * @throws ZCodeProtocolException 应答缺 ack.logEpoch
     */
    private fun tempV4Subscribe(sessionId: String, timeoutMs: Long): String {
        val subParams = buildJsonObject {
            put("topic", "conversation/$sessionId")
            put("connectionId", v4ConnectionId)
            put("clientMode", "desktop-continuous")
        }
        val subResp = request("v4/conversation/subscribe", subParams, timeoutMs)
        requireOk(subResp)
        subResp["result"]?.jsonObject?.get("ack")?.jsonObject
            ?.get("subscriptionId")?.jsonPrimitive?.contentOrNull
            ?.let { v4SubscriptionIds[sessionId] = it }
        return subResp["result"]?.jsonObject?.get("ack")?.jsonObject
            ?.get("logEpoch")?.jsonPrimitive?.content
            ?: throw ZCodeProtocolException("v4 订阅应答缺 ack.logEpoch")
    }

    /**
     * v4/command forkAssistant — 会话分叉（官方桌面客户端同款通道，行为对齐定案）。
     *
     * 链路（diag-fork10~16/26 探针全链路实测）：v4/conversation/subscribe（ack.logEpoch）→
     * v4/conversation/rowsRange 定位目标行所在轮（从最新往回 beforeRowId 翻页至覆盖全会话）→
     * 改选该轮内带 canFork 的 assistantText 行
     * （官方分叉语义是轮级别：canFork 只打在轮内最后一段，长轮次的中间段天然无；legacy 视图
     * 整轮合并显示、messageId 取第一段，须换算到轮末段）→ v4/command forkAssistant
     * （target={rowId,entityId}，CAS：baseRevision 首发必 stale，取应答 revisionAtDecision
     * 重试一次即 accepted）→ result.sessionId。
     *
     * 与 legacy session/fork 的本质差异：官方通道**零文件操作**（restoredFiles:[]，handler
     * 只复制消息），无 legacy 路径的 checkpoint 工作区恢复副作用——这正是切换通道的动因。
     *
     * v4 订阅为 fork 期间临时行为：完成即退订，避免与 legacy 流双投递（分叉入口仅
     * 非流式可见，窗口期无帧）；若会话已在 v4SubscribedSessions（子代理场景）则
     * 复用既有订阅不退订。
     *
     * @return result {forkedSessionId, parentSessionId}
     * @throws ZCodeProtocolException code=-32601 老版本 CLI 无 v4 面（调用方据此让前端
     * 隐藏分叉入口）；rejected 带 reasonCode 原文案
     */
    fun forkAssistantViaV4(sessionId: String, messageId: String, timeoutMs: Long = 20000): JsonObject {
        val wasSubscribed = sessionId in v4SubscribedSessions
        // 常驻标题订阅判据：服务端对同 topic 幂等复用同一 subscriptionId，"临时订阅"
        // 即常驻订阅本身，退订即断服务端帧流（标题/更改条静默丢失）——一律不退订
        val wasTitle = sessionId in v4TitleSessions
        val logEpoch = tempV4Subscribe(sessionId, timeoutMs)
        try {
            // rowsRange 定位分叉行。注意四点（fork14~16/26 真会话取证定案）：
            // ① 分页参数是 beforeRowId（没有 fromRowId），从最新往回翻页，hasMore 标记还有更早的行；
            // ② 投影活窗口有限（snapshotTailWindowRows=60 起，limit 上限 200），目标行须翻页找；
            // ③ 分叉语义是【轮】级别（fork16 定案）：canFork 只打在轮内最后一段 assistantText 上，
            //    而长轮次是「过渡语→工具→最终回复」多段结构，legacy 视图把整轮合并成一条消息、
            //    messageId 取轮内第一段——按 messageId 直选必然选中无 canFork 的中间段被守卫拒。
            //    官方客户端的 fork 按钮挂在轮尾、目标行=轮内带 canFork 的行。对齐做法：按 entityId
            //    找到目标行取其 turnId，改选该轮内带 canFork 的行（轮末段 rowId 更大、翻页先遇到，
            //    一遍扫描即可同时收齐）；target.entityId 必须用该行自己的 entityId（守卫校验
            //    entityIdByRowId 匹配）。actions:null 是 JSON 显式 null，须 as? JsonObject 防 JsonNull 崩溃。
            // ④ 翻页上限须覆盖全会话（fork26 定案）：本会话 1300+ 行/首轮 39 行，目标（第一条
            //    回复）在最老端——页数上限小了 targetSeen=false 会误报「原对话已不包含」。
            //    limit=200×50 页=万行封顶；找到目标轮即停，长会话通常 1~2 页就命中。
            var beforeRowId: Long? = null
            var hasMore = true
            var pages = 0
            var targetSeen = false
            var targetTurnId: String? = null
            val forkableByTurn = LinkedHashMap<String, JsonObject>()
            while (hasMore && pages < 50) {
                val rowsParams = buildJsonObject {
                    put("sessionId", sessionId)
                    put("topic", "conversation/$sessionId")
                    put("limit", 200)
                    beforeRowId?.let { put("beforeRowId", it) }
                }
                val rowsResp = request("v4/conversation/rowsRange", rowsParams, timeoutMs)
                requireOk(rowsResp)
                val result = rowsResp["result"]?.jsonObject
                    ?: throw ZCodeProtocolException("rowsRange 应答缺 result")
                val rows = result["rows"]?.jsonArray ?: JsonArray(emptyList())
                if (rows.isEmpty()) break
                for (element in rows) {
                    val o = element.jsonObject
                    val turnId = o["turnId"]?.jsonPrimitive?.contentOrNull
                    val canFork = o["kind"]?.jsonPrimitive?.contentOrNull == "assistantText" &&
                        (o["actions"] as? JsonObject)?.get("canFork")?.jsonPrimitive?.booleanOrNull == true
                    if (canFork && turnId != null) forkableByTurn.putIfAbsent(turnId, o)
                    if (o["entityId"]?.jsonPrimitive?.contentOrNull == messageId) {
                        targetSeen = true
                        if (turnId != null) targetTurnId = turnId
                    }
                }
                if (targetTurnId != null && targetTurnId in forkableByTurn) break
                hasMore = result["hasMore"]?.jsonPrimitive?.booleanOrNull == true
                beforeRowId = rows.firstOrNull()?.jsonObject?.get("rowId")?.jsonPrimitive?.longOrNull
                pages += 1
            }
            val row = targetTurnId?.let { forkableByTurn[it] } ?: throw ZCodeProtocolException(
                if (targetSeen) "分叉点不可用：该轮次未完成或已被中断，完成一轮对话后才能分叉"
                else "原对话已不包含分叉那条消息"
            )
            val targetRowId = row["rowId"]?.jsonPrimitive?.intOrNull
                ?: throw ZCodeProtocolException("rowsRange 行缺 rowId")
            val targetEntityId = row["entityId"]?.jsonPrimitive?.contentOrNull
                ?: throw ZCodeProtocolException("rowsRange 分叉行缺 entityId")

            // CAS：baseRevision 首发必 stale，revisionAtDecision 重试一次（fork12 模式）
            var baseRevision = 0
            var res: JsonObject = JsonObject(emptyMap())
            var forkedId: String? = null
            for (attempt in 0 until 2) {
                val params = buildJsonObject {
                    put("commandId", "fork-${java.util.UUID.randomUUID()}")
                    put("clientId", "zcode-idea-plugin")
                    put("sessionId", sessionId)
                    put("type", "forkAssistant")
                    put("payload", buildJsonObject {
                        put("target", buildJsonObject {
                            put("rowId", targetRowId)
                            put("entityId", targetEntityId)
                        })
                    })
                    put("issuedAt", System.currentTimeMillis())
                    put("baseRevision", baseRevision)
                    put("baseLogEpoch", logEpoch)
                }
                val r = request("v4/command", params, timeoutMs)
                requireOk(r)
                res = r["result"]?.jsonObject ?: JsonObject(emptyMap())
                val status = res["status"]?.jsonPrimitive?.content
                if (status == "accepted" || status == "duplicate") {
                    forkedId = res["result"]?.jsonObject?.get("sessionId")
                        ?.jsonPrimitive?.content
                    break
                }
                if (status == "stale" && attempt == 0) {
                    baseRevision = res["revisionAtDecision"]?.jsonPrimitive?.intOrNull ?: break
                } else {
                    break
                }
            }
            if (forkedId == null) {
                val reason = res["reasonCode"]?.jsonPrimitive?.content ?: ""
                val detail = res["message"]?.jsonPrimitive?.content ?: ""
                throw ZCodeProtocolException(
                    "fork 被拒绝: ${res["status"]?.jsonPrimitive?.content ?: "unknown"} $reason $detail".trim()
                )
            }
            // fork 会把父会话的 goal target 整行复制（含 active 状态，diag-fork28 取证），
            // 但引擎不会在新会话续跑（active_run_* 全空）——前端目标卡会一直显示
            // "运行中"且本地计时累加（假跑）。fork 后把新会话的目标暂停：objective
            // 保留、状态转 paused（用户可经目标卡恢复按钮 resume），pause 也会落
            // 一张"已暂停"timeline 卡让来源可见。无目标/已完成的会话 pause 报错，
            // 失败一律静默不阻塞分叉主流程。
            try {
                goal(forkedId, "pause", timeoutMs = 5000)
            } catch (_: Exception) {
            }
            return buildJsonObject {
                put("forkedSessionId", forkedId)
                put("parentSessionId", sessionId)
            }
        } finally {
            if (!wasSubscribed && !wasTitle) {
                unsubscribeConversationV4(sessionId, timeoutMs)
            }
        }
    }

    /**
     * v4/command editUserQuery — 编辑最后一轮用户消息并重新生成（官方桌面客户端同款通道）。
     *
     * 链路与 forkAssistantViaV4 同构：临时 v4 订阅取 ack.logEpoch → rowsRange 定位目标
     * userInput 行（entityId == legacy 消息 id，diag-edit-v4 实测）→ v4/command CAS
     * （baseRevision 首发必 stale，取 revisionAtDecision 重试一次即 accepted）。
     *
     * 相比 legacy `/rewind conversation` 命令方案的两个本质升级（diag-edit-v4 实测定案）：
     * ① **回合中可编辑**——服务端执行链自带「活动回合先 abort」（abortMessage =
     *    "v4 editUserQuery preempts active turn"），行投影的 canEdit 只要求「最新
     *    realUser userInput 行」、不随活动回合收回；legacy 流上被中止的旧回合【没有】
     *    turn 终点帧，直接 rewind.triggered → turn.started(新文本)。
     * ② **附件可保留**——payload.attachments 走 [V4AttachmentRef] ref 引用形态；
     *    不传时服务端沿用原回合 intent 的 ref 附件（ofn 过滤），而插件 legacy
     *    dataBase64 内联发的图在 intent 里 ref=原文件名（解析不了，实测重发后图
     *    变 "[Attached image/png: xxx]" 文字占位）——**带图消息必须显式传全量
     *    列表**（保留图=image-cache 落盘路径 ref，由调用方解析）。
     *
     * 编辑语义 = 服务端就地 rewindConversationToMessage + 用 newText（+ attachments）
     * 重发，legacy 快照仍不反映截断（前端 rewind-cuts 记忆机制不变）。
     *
     * @param attachments null=不传字段（服务端沿用原附件，仅限纯文本消息）；
     *   空列表=显式清空附件（编辑时删掉了全部图片）
     * @return v4/command 应答 result（status=accepted/duplicate，含 result.disposition）
     * @throws ZCodeProtocolException code=-32601 老版本 CLI 无 v4 面；目标行存在但
     *   已不是最新可编辑消息 / rejected 带 reasonCode 原文案
     * @throws EditTargetGoneException 行流窗口内找不到目标行（会话级行流缺失或乐观
     *   id 过期）——调用方应降级（editUnsupported）而非报错
     */
    fun editUserQueryViaV4(
        sessionId: String,
        messageId: String,
        newText: String,
        attachments: List<V4AttachmentRef>? = null,
        timeoutMs: Long = 20000,
    ): JsonObject {
        // 订阅块与 forkAssistantViaV4 同款，收口在 tempV4Subscribe：临时订阅只为
        // ack.logEpoch/rowsRange 信封/退订，不进 v4SubscribedSessions 白名单
        val wasSubscribed = sessionId in v4SubscribedSessions
        // 常驻标题订阅判据：服务端对同 topic 幂等复用同一 subscriptionId，"临时订阅"
        // 即常驻订阅本身，退订即断服务端帧流（标题/更改条静默丢失）——一律不退订
        val wasTitle = sessionId in v4TitleSessions
        val logEpoch = tempV4Subscribe(sessionId, timeoutMs)
        try {
            // rowsRange 定位目标 userInput 行：编辑目标是最新 user 消息，通常首页命中，
            // 翻页兜底同 fork（投影活窗口有限，limit=200×50 页封顶）。找到即校验 canEdit：
            // 行存在但 canEdit!=true = 已不是最新可编辑消息（服务端 guard.actionUnavailable
            // 的前置版，省一次必拒的命令往返）
            var beforeRowId: Long? = null
            var hasMore = true
            var pages = 0
            var targetSeen = false
            var row: JsonObject? = null
            while (hasMore && pages < 50 && row == null && !targetSeen) {
                val rowsParams = buildJsonObject {
                    put("sessionId", sessionId)
                    put("topic", "conversation/$sessionId")
                    put("limit", 200)
                    beforeRowId?.let { put("beforeRowId", it) }
                }
                val rowsResp = request("v4/conversation/rowsRange", rowsParams, timeoutMs)
                requireOk(rowsResp)
                val result = rowsResp["result"]?.jsonObject
                    ?: throw ZCodeProtocolException("rowsRange 应答缺 result")
                val rows = result["rows"]?.jsonArray ?: JsonArray(emptyList())
                if (rows.isEmpty()) break
                for (element in rows) {
                    val o = element.jsonObject
                    if (o["kind"]?.jsonPrimitive?.contentOrNull == "userInput" &&
                        o["entityId"]?.jsonPrimitive?.contentOrNull == messageId
                    ) {
                        targetSeen = true
                        if ((o["actions"] as? JsonObject)?.get("canEdit")
                                ?.jsonPrimitive?.booleanOrNull == true
                        ) {
                            row = o
                        }
                        break
                    }
                }
                if (row == null) {
                    // targetSeen（entityId 已命中但 canEdit!=true）时短路：entityId 全会话
                    // 唯一，继续翻页不可能再命中，白耗最多 50 页往返（2026-09-13 review）
                    if (targetSeen) break
                    hasMore = result["hasMore"]?.jsonPrimitive?.booleanOrNull == true
                    beforeRowId = rows.firstOrNull()?.jsonObject?.get("rowId")?.jsonPrimitive?.longOrNull
                    pages += 1
                }
            }
            val target = row ?: if (targetSeen) {
                throw ZCodeProtocolException(
                    "只能编辑最后一轮用户消息（该消息已不是最新可编辑消息）",
                    reason = "notLatestUserMessage",
                )
            } else {
                // 行流里没有目标行：会话级行流缺失（用户三轮反馈实锤，探针无法复现）
                // 或前端传了乐观/过期 id——走降级信号而非报错（调用方回 editUnsupported，
                // 前端按 reason 决定 legacy 回退或明确提示）
                throw EditTargetGoneException("原对话已不包含那条消息")
            }
            val targetRowId = target["rowId"]?.jsonPrimitive?.intOrNull
                ?: throw ZCodeProtocolException("rowsRange 行缺 rowId")
            val targetEntityId = target["entityId"]?.jsonPrimitive?.contentOrNull
                ?: throw ZCodeProtocolException("rowsRange 行缺 entityId")

            // CAS：baseRevision 首发必 stale，revisionAtDecision 重试一次（fork12 模式）
            var baseRevision = 0
            var res: JsonObject = JsonObject(emptyMap())
            var accepted = false
            for (attempt in 0 until 2) {
                val payload = buildJsonObject {
                    put("target", buildJsonObject {
                        put("rowId", targetRowId)
                        put("entityId", targetEntityId)
                    })
                    put("newText", newText)
                    if (attachments != null) {
                        put("attachments", buildJsonArray {
                            attachments.forEach { a ->
                                add(buildJsonObject {
                                    put("ref", a.ref)
                                    put("fileName", a.fileName)
                                    put("mime", a.mime)
                                    put("bytes", a.bytes)
                                })
                            }
                        })
                    }
                }
                val params = buildJsonObject {
                    put("commandId", "edit-${java.util.UUID.randomUUID()}")
                    put("clientId", "zcode-idea-plugin")
                    put("sessionId", sessionId)
                    put("type", "editUserQuery")
                    put("payload", payload)
                    put("issuedAt", System.currentTimeMillis())
                    put("baseRevision", baseRevision)
                    put("baseLogEpoch", logEpoch)
                }
                val r = request("v4/command", params, timeoutMs)
                requireOk(r)
                res = r["result"]?.jsonObject ?: JsonObject(emptyMap())
                val status = res["status"]?.jsonPrimitive?.content
                if (status == "accepted" || status == "duplicate") {
                    accepted = true
                    break
                }
                if (status == "stale" && attempt == 0) {
                    baseRevision = res["revisionAtDecision"]?.jsonPrimitive?.intOrNull ?: break
                } else {
                    break
                }
            }
            if (!accepted) {
                val reason = res["reasonCode"]?.jsonPrimitive?.content ?: ""
                val detail = res["message"]?.jsonPrimitive?.content ?: ""
                throw ZCodeProtocolException(
                    "编辑被拒绝: ${res["status"]?.jsonPrimitive?.content ?: "unknown"} $reason $detail".trim(),
                    reason = "commandFailed",
                )
            }
            return res
        } finally {
            if (!wasSubscribed && !wasTitle) {
                unsubscribeConversationV4(sessionId, timeoutMs)
            }
        }
    }

    // ============ 回合文件更改与回退（B2：v4/conversation/fileChanges 族） ============
    //
    // 协议面（开源 v3.14.3 transport.ts/command.ts 实证，官方桌面端 ConversationFileSummaryPanel
    // 同款用法）：turnHeader 行自带 fileChanges 摘要（additions/deletions/files/state）与
    // actions.canRewindFiles，订阅帧直出；详情与回退走三条 RPC——
    // - v4/conversation/fileChanges     查询某轮改动文件清单（每文件 unified diff hunks）
    // - v4/conversation/fileRewindPreview 预览回退影响（safe/unsafe/ignored 三桶，hash 预检）
    // - v4/command applyFileRewind      执行回退（恢复/删除文件，不截断聊天历史，不依赖 git）
    // 两查询 + 命令的 CAS 都要 {rowId,entityId} 目标行 + baseRevision/baseLogEpoch 水位；
    // 查询侧是严格相等校验（staleRevision 直接抛错、无 revisionAtDecision 可回），命令侧
    // 与 fork 同款（baseRevision 首发可 stale，取 revisionAtDecision 重试一次）。

    /**
     * 临时 v4 订阅，快照上下文交给 block 执行后保证退订。
     *
     * 与 fork/editUserQuery 的 tempV4Subscribe 差异：那两个只要 ack.logEpoch，本链路
     * 的查询 CAS 还要**当前 revision**（ack 不带）。
     *
     * 快照获取两路（2026-10-01 真机实证：对已订阅 topic 重复 subscribe 是幂等的，
     * 服务端**不重推 initial 快照**——历史会话的标题订阅常驻后，等快照必超时）：
     * - 新订阅：ack 后立即推 initial 快照帧（帧监听先于订阅白名单闸，短窗即到）
     * - 幂等重订：等不到快照 → 用 v4ProjectionRevisions 帧水位（trackProjectionRevision
     *   对标题订阅会话持续跟踪）+ block 内行定位走 rowsRange 无状态翻页
     *
     * 副作用对齐 fork：临时订阅覆盖 v4SubscriptionIds，退订会清 v4TitleSessions——
     * 恢复标题订阅登记，让仍在推送的服务端标题订阅帧继续被路由。
     */
    private fun <T> withV4ConversationSnapshot(
        sessionId: String,
        timeoutMs: Long,
        block: (snapshot: JsonObject, logEpoch: String, revision: Int) -> T,
    ): T {
        val wasSubscribed = sessionId in v4SubscribedSessions
        val wasTitle = sessionId in v4TitleSessions
        // 监听器必须先于订阅挂上：服务端 ack 应答后立刻推 initial 快照（同一竞态在
        // subscribeConversationV4 的注释里有过实证），后挂必漏首帧
        val latch = java.util.concurrent.CountDownLatch(1)
        var snapshotRef: JsonObject? = null
        val removeListener = addV4LogicalFrameListener { params ->
            if (snapshotRef != null) return@addV4LogicalFrameListener
            val topic = params["topic"]?.jsonPrimitive?.jsonStringOrNull ?: return@addV4LogicalFrameListener
            if (topic != "conversation/$sessionId") return@addV4LogicalFrameListener
            val payload = params["frame"]?.jsonObject?.get("payload")?.jsonObject ?: return@addV4LogicalFrameListener
            if (payload["kind"]?.jsonPrimitive?.jsonStringOrNull != "snapshot") return@addV4LogicalFrameListener
            val snap = payload["snapshot"]?.jsonObject ?: return@addV4LogicalFrameListener
            snapshotRef = snap
            latch.countDown()
        }
        val logEpoch = try {
            tempV4Subscribe(sessionId, timeoutMs)
        } catch (e: Exception) {
            removeListener()
            throw e
        }
        try {
            try {
                // 快照要么亚秒到达（新订阅首帧）要么不会来（幂等重订），短窗即可
                latch.await(3000L, java.util.concurrent.TimeUnit.MILLISECONDS)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            }
            val snap = snapshotRef
            if (snap != null && snap.isNotEmpty()) {
                val revision = snap["revision"]?.jsonPrimitive?.intOrNull
                    ?: throw ZCodeProtocolException("v4 快照缺 revision", reason = "snapshotMalformed")
                return block(snap, logEpoch, revision)
            }
            // 幂等重订（标题订阅常驻）：用帧水位跟踪的 revision，行定位走 rowsRange
            val tracked = v4ProjectionRevisions[sessionId]
            if (tracked != null) {
                return block(JsonObject(emptyMap()), logEpoch, tracked)
            }
            // 水位也空（真机实锤 2026-10-06：IDE 重启后重开历史会话，标题订阅 ack 成功但
            // initial 快照帧始终未推——v4ProjectionRevisions 永远空，op 查询全部
            // revisionUnknown，前端变更条「加载中」无限重试+产物卡片门控抑制）。兜底：
            // resync forceSnapshot 强制服务端整段重放快照（subscriptionId 精确命中现有
            // 订阅不新建 id，重放是「只归位」语义幂等安全）；快照帧到达后本函数的
            // listener 捕获 snapshotRef、trackProjectionRevision 同帧补水位，一次修复两处。
            val subId = v4SubscriptionIds[sessionId]
            if (subId != null) {
                ProtocolLog.info("[v4-snapshot] projection revision unknown, forcing resync snapshot: $sessionId")
                runCatching {
                    v4ConversationResync(
                        topic = "conversation/$sessionId",
                        subscriptionId = subId,
                        connectionId = v4ConnectionId,
                        forceSnapshot = true,
                    )
                }.onFailure {
                    ProtocolLog.info("[v4-snapshot] resync failed: ${it.message?.take(150)}")
                }
                try {
                    latch.await(2000L, java.util.concurrent.TimeUnit.MILLISECONDS)
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                }
                val afterResync = snapshotRef
                if (afterResync != null && afterResync.isNotEmpty()) {
                    val revision = afterResync["revision"]?.jsonPrimitive?.intOrNull
                        ?: throw ZCodeProtocolException("v4 快照缺 revision", reason = "snapshotMalformed")
                    return block(afterResync, logEpoch, revision)
                }
            }
            throw ZCodeProtocolException(
                "会话投影 revision 水位未知（订阅期内未见快照/revision 帧）",
                reason = "revisionUnknown",
            )
        } finally {
            removeListener()
            // 退订判据必须含常驻标题订阅（wasTitle）：服务端对同 topic 幂等返回同一
            // subscriptionId，"临时订阅"实际就是常驻订阅本身——退订即断服务端帧流，
            // 后续所有增量（标题/更改条）静默丢失（真机实证：撤销后下一轮更改条全灭）。
            // 常驻订阅会话一律不退订（水位兜底已不依赖快照，无订阅等待成本）
            if (!wasSubscribed && !wasTitle) {
                unsubscribeConversationV4(sessionId, timeoutMs)
            }
        }
    }

    /**
     * turnHeader 行两步匹配：① entityId 直接命中 turnHeader；② entityId 命中该轮
     * 任意行（assistantText/userInput 的 entityId=消息 id）→ 经 turnId 反查该轮
     * turnHeader。webview 弹窗传来的是 assistant 消息 id（重扫锚点）或 user 消息 id
     * （增量兜底=productTurnId），两步分别覆盖。
     */
    private fun matchTurnHeaderRow(rows: List<JsonObject>, messageId: String): JsonObject? {
        for (r in rows) {
            if (r["kind"]?.jsonPrimitive?.jsonStringOrNull == "turnHeader" &&
                r["entityId"]?.jsonPrimitive?.jsonStringOrNull == messageId
            ) return r
        }
        var turnId: String? = null
        for (r in rows) {
            if (r["entityId"]?.jsonPrimitive?.jsonStringOrNull == messageId) {
                turnId = r["turnId"]?.jsonPrimitive?.jsonStringOrNull
                if (turnId != null) break
            }
        }
        if (turnId != null) {
            for (r in rows) {
                if (r["kind"]?.jsonPrimitive?.jsonStringOrNull == "turnHeader" &&
                    r["turnId"]?.jsonPrimitive?.jsonStringOrNull == turnId
                ) return r
            }
        }
        return null
    }

    /**
     * 定位某轮回合头行（rewind/fileChanges 的 CAS target = turnHeader 行自身）。
     * messageId 可能是该轮 assistant 消息 id（弹窗从回复消息打开/重扫锚点）或 user
     * 消息 id（=turnHeader entityId）。先扫快照窗口（尾部 60 行，最近轮一击命中），
     * 窗口外翻 rowsRange（同 fork 手法：beforeRowId 从最新往回、50 页封顶）；行流
     * 跨页时用 seenHeaders/turnIdsOfMessage 跨页记忆（turnHeader 行先于同轮内容行
     * 被扫到，反查需要回头联接）。
     */
    private fun locateTurnHeaderRow(
        sessionId: String,
        messageId: String,
        snapshot: JsonObject?,
        timeoutMs: Long,
    ): JsonObject {
        if (snapshot != null && snapshot.isNotEmpty()) {
            val window = snapshot["rows"]?.jsonObject?.get("window")?.jsonArray
                ?.mapNotNull { it as? JsonObject }
            if (window != null) {
                matchTurnHeaderRow(window, messageId)?.let { return it }
            }
        }
        var beforeRowId: Long? = null
        var hasMore = true
        var pages = 0
        val seenHeaders = LinkedHashMap<String, JsonObject>() // turnId → turnHeader 行
        val turnIdsOfMessage = LinkedHashMap<String, String>() // entityId → turnId
        while (hasMore && pages < 50) {
            val rowsParams = buildJsonObject {
                put("sessionId", sessionId)
                put("topic", "conversation/$sessionId")
                put("limit", 200)
                beforeRowId?.let { put("beforeRowId", it) }
            }
            val rowsResp = request("v4/conversation/rowsRange", rowsParams, timeoutMs)
            requireOk(rowsResp)
            val result = rowsResp["result"]?.jsonObject
                ?: throw ZCodeProtocolException("rowsRange 应答缺 result")
            val rows = result["rows"]?.jsonArray ?: JsonArray(emptyList())
            if (rows.isEmpty()) break
            val pageRows = rows.mapNotNull { it as? JsonObject }
            for (r in pageRows) {
                val entityId = r["entityId"]?.jsonPrimitive?.jsonStringOrNull
                val rTurnId = r["turnId"]?.jsonPrimitive?.jsonStringOrNull
                if (r["kind"]?.jsonPrimitive?.jsonStringOrNull == "turnHeader" && rTurnId != null) {
                    seenHeaders.putIfAbsent(rTurnId, r)
                } else if (entityId == messageId && rTurnId != null) {
                    turnIdsOfMessage.putIfAbsent(entityId!!, rTurnId)
                }
            }
            matchTurnHeaderRow(pageRows, messageId)?.let { return it }
            // 跨页联接：目标 entityId 在本页命中、其轮 turnHeader 在先前页扫到过
            turnIdsOfMessage[messageId]?.let { tid -> seenHeaders[tid]?.let { return it } }
            hasMore = result["hasMore"]?.jsonPrimitive?.booleanOrNull == true
            beforeRowId = rows.firstOrNull()?.jsonObject?.get("rowId")?.jsonPrimitive?.longOrNull
            pages += 1
        }
        throw ZCodeProtocolException("原对话已不包含该轮的回合头行（messageId=$messageId）", reason = "targetGone")
    }

    /** 查询侧 stale 单次重试包装：快照水位与查询之间投影若又前进（罕见，点击间隙
     *  有别的写入方），重取快照水位再试一次；staleLogEpoch（epoch 已换代）不重试。 */
    private fun queryTurnFileRpc(
        sessionId: String,
        messageId: String,
        method: String,
        timeoutMs: Long,
        attempt: Int = 0,
    ): JsonObject {
        return try {
            withV4ConversationSnapshot(sessionId, timeoutMs) { snap, logEpoch, revision ->
                val row = locateTurnHeaderRow(sessionId, messageId, snap.takeIf { it.isNotEmpty() }, timeoutMs)
                val targetRowId = row["rowId"]?.jsonPrimitive?.intOrNull
                    ?: throw ZCodeProtocolException("回合头行缺 rowId")
                val targetEntityId = row["entityId"]?.jsonPrimitive?.jsonStringOrNull
                    ?: throw ZCodeProtocolException("回合头行缺 entityId")
                val params = buildJsonObject {
                    put("sessionId", sessionId)
                    put("target", buildJsonObject {
                        put("rowId", targetRowId)
                        put("entityId", targetEntityId)
                    })
                    put("baseRevision", revision)
                    put("baseLogEpoch", logEpoch)
                }
                val r = request(method, params, timeoutMs)
                requireOk(r)
                r["result"]?.jsonObject ?: throw ZCodeProtocolException("$method 应答缺 result")
            }
        } catch (e: ZCodeProtocolException) {
            val stale = e.message?.contains("proto.staleRevision") == true
            if (stale && attempt == 0) {
                queryTurnFileRpc(sessionId, messageId, method, timeoutMs, attempt = 1)
            } else {
                throw e
            }
        }
    }

    /**
     * v4/conversation/fileChanges — 查询某轮改动的文件清单（详情弹窗数据源）。
     * 应答：{files, additions, deletions, state?, items:[{path, additions, deletions,
     * writeCount, toolNames, patches:[{oldStart, oldLines, newStart, newLines, lines}]}]}
     */
    fun fetchTurnFileChanges(sessionId: String, messageId: String, timeoutMs: Long = 20000): JsonObject =
        queryTurnFileRpc(sessionId, messageId, "v4/conversation/fileChanges", timeoutMs)

    /**
     * v4/conversation/fileRewindPreview — 预览某轮回退的影响面。
     * 应答：{canApply, safeFiles:[{action, operationCount, path, toolNames}],
     * unsafeFiles:[{reason, message?, currentHash?, expectedHash?, ...}],
     * ignoredFiles:[{reason:"bash_ignored", ...}]}
     */
    fun previewTurnFileRewind(sessionId: String, messageId: String, timeoutMs: Long = 20000): JsonObject =
        queryTurnFileRpc(sessionId, messageId, "v4/conversation/fileRewindPreview", timeoutMs)

    /**
     * v4/command applyFileRewind — 执行某轮文件回退（恢复/删除文件，不截断聊天）。
     * CAS 与 fork 同款：baseRevision 用快照水位首发，stale 取 revisionAtDecision
     * 重试一次。应答 result 形如 {type:"applyFileRewind", applied, preview, response}。
     */
    fun applyTurnFileRewind(sessionId: String, messageId: String, timeoutMs: Long = 20000): JsonObject {
        return withV4ConversationSnapshot(sessionId, timeoutMs) { snap, logEpoch, revision ->
            val row = locateTurnHeaderRow(sessionId, messageId, snap.takeIf { it.isNotEmpty() }, timeoutMs)
            val targetRowId = row["rowId"]?.jsonPrimitive?.intOrNull
                ?: throw ZCodeProtocolException("回合头行缺 rowId")
            val targetEntityId = row["entityId"]?.jsonPrimitive?.jsonStringOrNull
                ?: throw ZCodeProtocolException("回合头行缺 entityId")
            var baseRevision = revision
            var res: JsonObject = JsonObject(emptyMap())
            var accepted = false
            for (attempt in 0 until 2) {
                val params = buildJsonObject {
                    put("commandId", "rewind-${java.util.UUID.randomUUID()}")
                    put("clientId", "zcode-idea-plugin")
                    put("sessionId", sessionId)
                    put("type", "applyFileRewind")
                    put("payload", buildJsonObject {
                        put("target", buildJsonObject {
                            put("rowId", targetRowId)
                            put("entityId", targetEntityId)
                        })
                    })
                    put("issuedAt", System.currentTimeMillis())
                    put("baseRevision", baseRevision)
                    put("baseLogEpoch", logEpoch)
                }
                val r = request("v4/command", params, timeoutMs)
                requireOk(r)
                res = r["result"]?.jsonObject ?: JsonObject(emptyMap())
                val status = res["status"]?.jsonPrimitive?.content
                if (status == "accepted" || status == "duplicate") {
                    accepted = true
                    break
                }
                if (status == "stale" && attempt == 0) {
                    baseRevision = res["revisionAtDecision"]?.jsonPrimitive?.intOrNull ?: break
                } else {
                    break
                }
            }
            if (!accepted) {
                val reason = res["reasonCode"]?.jsonPrimitive?.content ?: ""
                val detail = res["message"]?.jsonPrimitive?.content ?: ""
                throw ZCodeProtocolException(
                    "回退被拒绝: ${res["status"]?.jsonPrimitive?.content ?: "unknown"} $reason $detail".trim(),
                    reason = "commandFailed",
                )
            }
            res
        }
    }

    /**
     * 重扫会话的逐轮文件更改摘要（会话重开场景）：rowsRange 无状态翻页收集行窗口，
     * 每个带 fileChanges 的回合头合成一条 turn.fileChanges 事件（锚定同轮
     * assistantText 行 entityId）。返回发出的事件数。
     *
     * 为什么不走订阅快照（2026-10-01 真机实证）：对已订阅 topic 重复 subscribe 幂等、
     * 服务端不重推 initial 快照——历史会话标题订阅常驻后重扫等快照必超时。rowsRange
     * 是只读查询零订阅依赖（fork 定位同款）。翻页从最新往旧，assistantText（rowId 大）
     * 先于同轮 turnHeader 遇到，锚定数据天然在手；连续整页无新目标即停（最近轮语义，
     * 与快照 60 行窗口对齐，3 页 600 行封顶）。
     */
    fun rescanTurnFileChanges(sessionId: String, timeoutMs: Long = 15000): Int {
        val allRows = ArrayList<JsonObject>(400)
        var beforeRowId: Long? = null
        var hasMore = true
        var pages = 0
        var foundTotal = 0
        while (hasMore && pages < 3) {
            val rowsParams = buildJsonObject {
                put("sessionId", sessionId)
                put("topic", "conversation/$sessionId")
                put("limit", 200)
                beforeRowId?.let { put("beforeRowId", it) }
            }
            val rowsResp = request("v4/conversation/rowsRange", rowsParams, timeoutMs)
            requireOk(rowsResp)
            val result = rowsResp["result"]?.jsonObject
                ?: throw ZCodeProtocolException("rowsRange 应答缺 result")
            val rows = result["rows"]?.jsonArray ?: JsonArray(emptyList())
            if (rows.isEmpty()) break
            val pageRows = rows.mapNotNull { it as? JsonObject }
            allRows.addAll(pageRows)
            var foundInPage = 0
            for (r in pageRows) {
                if (r["kind"]?.jsonPrimitive?.jsonStringOrNull == "turnHeader" &&
                    (r["fileChanges"] as? JsonObject) != null
                ) foundInPage++
            }
            foundTotal += foundInPage
            hasMore = result["hasMore"]?.jsonPrimitive?.booleanOrNull == true
            beforeRowId = rows.firstOrNull()?.jsonObject?.get("rowId")?.jsonPrimitive?.longOrNull
            pages += 1
            // 本页无新目标且此前已有收集 → 更旧的轮更早于快照窗口语义，停
            if (foundInPage == 0 && foundTotal > 0) break
        }
        if (foundTotal == 0) return 0
        var count = 0
        val ts = System.currentTimeMillis()
        for (row in allRows) {
            if (row["kind"]?.jsonPrimitive?.jsonStringOrNull != "turnHeader") continue
            turnFileChangesEvent(sessionId, row, ts, allRows)?.let {
                dispatchSessionEvent(it)
                count++
            }
        }
        return count
    }

    /**
     * turnHeader 行 → turn.fileChanges 事件（标题订阅分支与重扫共用）。行无
     * fileChanges 键（无文件写入的轮）返回 null。payload = {messageId, rowId,
     * fileChanges{additions,deletions,files,state?}, canRewindFiles}。
     *
     * messageId 锚点：turnHeader 行的 entityId = productTurnId（product-projection
     * 3661 实证：常态=该轮 user 消息 id，队列 drain 可能是轮 id 变体）——快照窗口
     * 可用时改锚到**同轮最早的 assistant 侧消息 id 行的 entityId**（=legacy 首段
     * assistant 消息 id；前端 mergeTurnMessages 把同轮多段 assistant 合并为一条时
     * 保留首段的 id，锚非首段会「host not in messages」挂起死锁——首段可能没有
     * assistantText 行（纯 reasoning/工具 step），必须取全 kind 最早行，见过滤处
     * 注释；真机日志实证）；
     * 窗口不可用（增量单行 upsert）时退回 entityId，由前端 user→assistant 换算
     * +挂起重试兜底。
     */
    private fun turnFileChangesEvent(
        sessionId: String,
        row: JsonObject,
        ts: Long,
        window: List<JsonObject>? = null,
    ): SessionEvent? {
        val fc = row["fileChanges"] as? JsonObject ?: return null
        val rowId = row["rowId"]?.jsonPrimitive?.intOrNull ?: return null
        val turnId = row["turnId"]?.jsonPrimitive?.jsonStringOrNull
        val anchor = if (window != null && turnId != null) {
            window
                .filter {
                    val kind = it["kind"]?.jsonPrimitive?.jsonStringOrNull
                    // 首段 assistant 消息 id：前端 mergeTurnMessages 把同轮多段 assistant
                    // 合并为一条时保留**首段** id——锚必须取同轮最早的 assistant 侧行。
                    // 只取 assistantText 会漏掉「首段是纯 reasoning/工具 step」的轮
                    //（首段无 assistantText 行 → 锚落到次段 id → 前端 host 解析必 miss，
                    // 历史加载后逐轮更改条全灭，2026-10-01 真机实锤）。turnHeader/userInput
                    // 是轮/user 消息身份，toolCall 的 entityId=call_* 非消息 id，一并跳过。
                    kind != "turnHeader" && kind != "userInput" &&
                        it["turnId"]?.jsonPrimitive?.jsonStringOrNull == turnId &&
                        !(it["entityId"]?.jsonPrimitive?.jsonStringOrNull ?: "").startsWith("call_")
                }
                .minByOrNull { it["rowId"]?.jsonPrimitive?.intOrNull ?: Int.MAX_VALUE }
                ?.get("entityId")?.jsonPrimitive?.jsonStringOrNull
        } else null
        val messageId = anchor
            ?: row["entityId"]?.jsonPrimitive?.jsonStringOrNull
            ?: return null
        return SessionEvent(
            type = "turn.fileChanges",
            seq = 0L,
            sessionId = sessionId,
            timestamp = ts,
            traceId = null,
            turnId = turnId,
            deliveryKind = null,
            payload = buildJsonObject {
                put("messageId", messageId)
                put("rowId", rowId)
                put("fileChanges", fc)
                put(
                    "canRewindFiles",
                    (row["actions"] as? JsonObject)?.get("canRewindFiles")
                        ?.jsonPrimitive?.booleanOrNull == true,
                )
            },
        )
    }

    /** 投影 revision 水位跟踪（见 [v4ProjectionRevisions]）：快照帧直读 revision，
     *  增量帧扫 state.updated 的 patch.revision。解析失败静默（诊断辅助不影响主流程）。 */
    private fun trackProjectionRevision(sid: String, params: JsonObject) {
        try {
            val payload = params["frame"]?.jsonObject?.get("payload")?.jsonObject ?: return
            if (payload["kind"]?.jsonPrimitive?.jsonStringOrNull == "snapshot") {
                payload["snapshot"]?.jsonObject?.get("revision")?.jsonPrimitive?.intOrNull
                    ?.let { v4ProjectionRevisions[sid] = it }
                return
            }
            val deltas = payload["deltas"]?.jsonArray ?: return
            for (d in deltas) {
                val delta = d as? JsonObject ?: continue
                if (delta["op"]?.jsonPrimitive?.jsonStringOrNull != "state.updated") continue
                delta["patch"]?.jsonObject?.get("revision")?.jsonPrimitive?.intOrNull
                    ?.let { v4ProjectionRevisions[sid] = it }
            }
        } catch (_: Exception) {
        }
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
            // 冷恢复重建 runtime 时必须沿用 create 的工具面（源码 zcodeSessionResumeParamsSchema
            // 注释：否则会绕过 create 的 allow/deny 约束，尤其 CUA 会话）；热订阅复挂无影响。
            // 内存未命中（IDE 重启后新 client 实例）回灌磁盘档案——注入记录不得因重启丢失
            val resumedSpecs = sessionMcpServers[sessionId]
                ?: SessionMcpServerStore.load(sessionId)?.also {
                    println("[ZCodeProtocolClient] session mcpServers restored from disk store (${it.size} servers) for ${sessionId.takeLast(8)}")
                    sessionMcpServers[sessionId] = it
                }
            resumedSpecs?.let { put("mcpServers", mcpServersJson(it)) }
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
     * v4/command {type:"sendText", requestedDelivery:"guide"} — 引导式插队（steer）：
     * 把消息注入运行中的回合让模型当场转向，不打断、不排队（官方客户端同款输入路由，
     * requestedDelivery 三态 startNow|queue|guide）。
     *
     * 协议定案（diag-steer/diag-steer2 真机探针，2026-09-07）：
     * - 裸命令即可（无需 v4/conversation/subscribe，对齐 stopForegroundViaV4）；
     * - 注入过程经 legacy session/event 透传：turn.steerQueued（delivery=guide、
     *   targetTurnId、inputPreview）→ turn.steerDrained（injectedMessageIds，
     *   注入消息的服务端正式 id）——前端渲染全走事件，本方法只负责受理；
     * - guide 未降级实锤过；若服务端降级为 queue，条目不会自动排空（sendQueuedNow
     *   是客户端职责），表现为回合结束仍无 steerDrained（前端按未生效提示重发）；
     * - legacy session/send 在回合中并发行为不可靠（实测 accepted 但消息无声消失），
     *   steer 是唯一的运行中输入通道。
     *
     * 带附件引导已砍（0.3.4 定案）：guide+attachments 服务端必降级为 queue
     * （fallbackReasonCode=guide.attachmentsUnsupported，runtime.steerTurn 只收纯文本）
     * 且降级条目不自动排空（sendQueuedNow 是客户端职责）——促发链路复杂且实测不可靠，
     * 带图只保留立即发送与排队自动发出，本方法仅收纯文本。
     * commandId 由调用方传入以派生 queueItemId（queue_<commandId>），供撤销。
     *
     * @return 应答 result（type=inputAccepted、delivery=初始准入 coarse 值——实测
     *          guide 也报 "queue"，真实路由以 steerQueued 事件为准，勿据此判断降级）
     */
    fun steerViaV4(
        sessionId: String,
        text: String,
        commandId: String = "steer-${java.util.UUID.randomUUID()}",
        timeoutMs: Long = 8000,
    ): JsonObject {
        val params = buildJsonObject {
            put("commandId", commandId)
            put("clientId", "zcode-idea-plugin")
            put("sessionId", sessionId)
            put("type", "sendText")
            put("payload", buildJsonObject {
                put("text", text)
                put("requestedDelivery", "guide")
            })
            put("issuedAt", System.currentTimeMillis())
            put("connectionId", "zcode-idea-plugin")
            put("clientMode", "desktop-continuous")
        }
        val r = request("v4/command", params, timeoutMs)
        requireOk(r)
        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
    }

    /**
     * v4/command {type:"deleteQueueItem"} — 撤销队列/引导条目。
     *
     * 【缺陷BQ二轮重审定案 2026-09-15，diag-steer4/5/6 真机探针】新 CLI 给写命令加了
     * 乐观并发校验（decide() 的 qft 集合）：baseRevision 必须严格等于服务端 revision
     * （每次会话状态变化 +1），否则拒绝且不执行——status=stale（值不等）/rejected
     * （缺省），两者均非 JSON-RPC error，旧实现据此误判"撤销成功"（removed=true）。
     * 三步重试法（探针终验）：首发带 0 → stale 应答的 revisionAtDecision 即服务端
     * 当前 revision → 带该值重发 → accepted（真删，session_input→cancelled）/
     * noop（条目不存在=已落位，旧版 queue.itemMissing error 的新形态）。
     * part.delta 不推进 revision（只有状态结构变化 +1），流式期实测 2-4 轮收敛。
     */
    fun deleteQueueItemViaV4(sessionId: String, queueItemId: String, timeoutMs: Long = 8000): JsonObject {
        var baseRevision = 0L
        repeat(5) { attempt ->
            val params = buildJsonObject {
                put("commandId", "delq-${java.util.UUID.randomUUID()}")
                put("clientId", "zcode-idea-plugin")
                put("sessionId", sessionId)
                put("type", "deleteQueueItem")
                put("payload", buildJsonObject { put("queueItemId", queueItemId) })
                put("issuedAt", System.currentTimeMillis())
                put("connectionId", "zcode-idea-plugin")
                put("clientMode", "desktop-continuous")
                put("baseRevision", baseRevision)
            }
            val r = requireOk(request("v4/command", params, timeoutMs))
            val result = r["result"]?.jsonObject ?: JsonObject(emptyMap())
            when (result["status"]?.jsonPrimitive?.content) {
                "accepted" -> return result
                // 太迟：条目已落位/已促发/不存在（调用方按 removed=false 处理）
                "noop" -> throw IllegalStateException("queue.itemMissing (status=noop)")
                else -> {
                    result["revisionAtDecision"]?.jsonPrimitive?.content?.toLongOrNull()?.let {
                        baseRevision = it
                    }
                    if (attempt == 4) throw IllegalStateException(
                        "deleteQueueItem stale retry exhausted (baseRevision=$baseRevision)")
                }
            }
        }
        throw IllegalStateException("deleteQueueItem retry loop exited unexpectedly")
    }

    /**
     * v4/command {type:"sendQueuedNow"} — 促发队列条目立即执行（官方客户端"排队消息立即
     * 发送"同款原语，官方 auto-drain 亦走它）。缺陷FD：legacy session/send 落在服务端
     * "回合工作在途"窗口（stop 异步拆卸/通知批次起轮前）时会被 admitPrompt 静默降级为
     * delivery=queue 且 ack 正常——本方法把这类被吞的输入从服务端队列捞出执行。
     * 手动路径语义（非 autoDrainPromotion）：preempt 当前回合 + requireIdle 重新准入，
     * 拆卸等待在 runtime 内部完成，无客户端 stop+send 的竞态窗口。
     *
     * CAS 形状与 deleteQueueItemViaV4 相同（同为 znn 集合命令）：baseRevision 必填，
     * stale 带 revisionAtDecision 重试收敛；accepted=已促发；noop=条目不存在（已落位/
     * 已移除，旧版 queue.itemMissing error 的新形态）；其余拒绝（guard.queuePromotionBusy
     * / guard.queueItemReserved 等）带 reasonCode，重试耗尽后抛出由调用方兜底。
     * 老版本 CLI 无该命令时报 -32601/-32602。
     */
    fun sendQueuedNowViaV4(sessionId: String, queueItemId: String, timeoutMs: Long = 8000): JsonObject {
        var baseRevision = 0L
        var lastReject = ""
        repeat(5) { attempt ->
            val params = buildJsonObject {
                put("commandId", "qnow-${java.util.UUID.randomUUID()}")
                put("clientId", "zcode-idea-plugin")
                put("sessionId", sessionId)
                put("type", "sendQueuedNow")
                put("payload", buildJsonObject { put("queueItemId", queueItemId) })
                put("issuedAt", System.currentTimeMillis())
                put("connectionId", "zcode-idea-plugin")
                put("clientMode", "desktop-continuous")
                put("baseRevision", baseRevision)
            }
            val r = requireOk(request("v4/command", params, timeoutMs))
            val result = r["result"]?.jsonObject ?: JsonObject(emptyMap())
            when (result["status"]?.jsonPrimitive?.content) {
                "accepted" -> return result
                // 条目不存在（已落位/已促发/已移除）：调用方按 queue.itemMissing 处理
                "noop" -> throw IllegalStateException("queue.itemMissing (status=noop)")
                else -> {
                    lastReject = "status=${result["status"]?.jsonPrimitive?.content}" +
                        " reason=${result["reasonCode"]?.jsonPrimitive?.content}"
                    result["revisionAtDecision"]?.jsonPrimitive?.content?.toLongOrNull()?.let {
                        baseRevision = it
                    }
                    if (attempt == 4) throw IllegalStateException(
                        "sendQueuedNow not accepted ($lastReject, baseRevision=$baseRevision)")
                }
            }
        }
        throw IllegalStateException("sendQueuedNow retry loop exited unexpectedly")
    }

    /**
     * v4/command {type:"renameSession"} — 设置会话标题（服务端落库，zcode.cjs 内部
     * 走 runtime.setCustomSessionTitle，titleSource=custom）。
     * 用途：AI 重新生成会话标题（op=regenerateSessionTitle 生成后经此持久化）。
     * 仅对 app-server 已驻留的会话有效（宿主会话表解析失败时报错，调用方兜底
     * 前端 persist 持久化）；无 baseRevision 要求（元数据命令，非历史行变更）。
     *
     * @return 应答 result（含 status: accepted 等，仅日志用）
     */
    fun renameSessionViaV4(sessionId: String, title: String, timeoutMs: Long = 8000): JsonObject {
        val params = buildJsonObject {
            put("commandId", "rename-${java.util.UUID.randomUUID()}")
            put("clientId", "zcode-idea-plugin")
            put("sessionId", sessionId)
            put("type", "renameSession")
            put("payload", buildJsonObject { put("title", title) })
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
     * session/goal — 目标模式管理（长目标自动续跑，2026-09 协议实测定案）
     *
     * 服务端引擎自治：set/resume 后自动启动第一轮，之后每轮结束 runtime 内部
     * 自动校验（continueActiveTargetLoop）并决定续跑/收尾，宿主零驱动责任。
     * 目标状态实时推送走 session/event 的 session.updated（payload 带
     * action/target/previousTarget），事件转发链路原样透传，无需本方法参与。
     *
     * 行为（zcode.cjs Qcn handler）：
     * - set/replace: objective 必填；plan 模式只回提示不启动轮；回合运行中报错（pause 例外）
     * - pause: 状态转 paused 并 abort 当前活跃 turn
     * - resume: 状态转 active，空闲时自动开续跑轮
     * - clear: 清除目标
     * - show: 返回目标文本
     *
     * @return 应答 result {response, snapshot(含 goalStats/todoGroups), startedTurn?}
     */
    fun goal(
        sessionId: String,
        action: String,
        objective: String? = null,
        inputId: String? = null,
        timeoutMs: Long = 10000
    ): JsonObject {
        val params = buildJsonObject {
            put("sessionId", sessionId)
            put("action", action)
            objective?.takeIf { it.isNotBlank() }?.let { put("objective", it) }
            inputId?.let { put("inputId", it) }
        }
        val r = request("session/goal", params, timeoutMs)
        requireOk(r)
        return r["result"]?.jsonObject ?: JsonObject(emptyMap())
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
     * session/debug — 调试快照（官方开发者工具 TPS 面板数据源）。
     *
     * 返回 { sessionId, rounds[], networkEntries[], cache }：rounds 每模型请求一条，
     * 含 usage 六字段 / hitRate / generationDurationMs / tokensPerSecond（服务端已算好）。
     * 数据是 app-server 进程内存（agent 重启清零、只收 main_turn、rounds≤200），
     * 会话须 active（resume/订阅后）。读类幂等 → 走重试。
     */
    fun sessionDebug(sessionId: String, timeoutMs: Long = 5000): JsonObject {
        val params = buildJsonObject { put("sessionId", sessionId) }
        val r = requestWithRetry("session/debug", params, timeoutMs, maxAttempts = 2, backoffMs = longArrayOf(500))
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
        val settings = r["result"]?.jsonObject?.get("settings")?.jsonObject ?: JsonObject(emptyMap())
        // 缺陷CX：读回的会话档位入缓存（send 的 modelSelection 数据源；服务端权威校准，
        // 外部改档/切模型重置后随例行重拉自愈）
        settings["thoughtLevel"]?.jsonObject?.get("current")?.jsonPrimitive?.contentOrNull?.let {
            sessionThoughtLevels[sessionId] = it
        }
        return settings
    }

    /**
     * session/read — 目标状态提取（goal 恢复用）
     *
     * 实测（diag-goal*.py）：session/read 的 result.session.target（nullable，与
     * TUI 侧 schema 同款：objective/summaryTitle/status/tokensUsed/timeUsedSeconds/
     * tokenBudget）+ result.goalStats（统计 + iterationCount）。无目标时 target
     * 为 null/缺失。goalStats 无 objective/status——目标文本与状态只在此 target。
     */
    fun readGoalState(sessionId: String, timeoutMs: Long = 10000): JsonObject {
        val params = buildJsonObject { put("sessionId", sessionId) }
        val r = requestWithRetry("session/read", params, timeoutMs, maxAttempts = 2, backoffMs = longArrayOf(500))
        requireOk(r)
        val result = r["result"]?.jsonObject
        return buildJsonObject {
            result?.get("session")?.jsonObject?.get("target")?.let { put("target", it) }
            result?.get("goalStats")?.let { put("goalStats", it) }
        }
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
        // 缺陷CX：成功档位入缓存（send 的 modelSelection 数据源；send 带目录默认档会
        // 写回会话冲掉本设置——缺陷CX 根因）
        sessionThoughtLevels[sessionId] = thoughtLevel
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
        // 4. 注入面磁盘档案顺手清（会话没了，resume 沿用记录不再有意义；fail-soft）
        SessionMcpServerStore.forget(sessionId)
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
     * 删除会话（软删，对齐 ZCode 客户端删除语义）：tasks.deleted=1，db.sqlite 数据全保留，
     * 两端列表同步隐藏（客户端 queryTaskList 与本插件列表均过滤 deleted）。与硬删
     * [closeSession]（递归删 db 行，正常列表在用）语义不同，归档页删除走本方法。
     */
    fun deleteArchivedSession(sessionId: String) = taskIndex.setDeleted(sessionId, cliDbPath)

    /**
     * 置顶/取消置顶会话：写 tasks-index.sqlite tasks.pinned（ZCode 客户端侧栏同列同源，
     * 两端互通；客户端自动归档判据 pinned=0，置顶会话天然免疫自动归档）。
     * 协议 wire 面无 pin 方法（v4/controller membership 是预留位，调用 -32601），
     * 与归档同策直写共享索引库。
     */
    fun setSessionPinned(sessionId: String, pinned: Boolean) = taskIndex.setPinned(sessionId, cliDbPath, pinned)

    /** 当前置顶的会话 id 集（pinned=1 且未软删；按会话 id 全局唯一，跨工作区取并集无害） */
    fun listPinnedSessionIds(): List<String> =
        taskIndex.listTasks().filter { it.pinned && !it.deleted }.map { it.taskId }

    /**
     * 标记会话未读：写 tasks-index.sqlite tasks.unread_at（ZCode 客户端侧栏同列同源）。
     * 协议 wire 面无未读方法，与 pin/归档同策直写共享索引库；unread_at 非空即客户端
     * 自动归档判据豁免（unread_at IS NULL 判据，TaskIndexStore.AUTO_ARCHIVE_JS 同款）。
     */
    fun markSessionUnread(sessionId: String) = taskIndex.setUnread(sessionId, cliDbPath)

    /** 清除会话未读（用户打开会话即视为已读；行不存在为无害空操作） */
    fun clearSessionUnread(sessionId: String) = taskIndex.clearUnread(sessionId)

    /** 当前未读的会话 id 集（unread_at 非空且未软删；走 listTasks 指纹缓存，命中零 node 进程） */
    fun listUnreadSessionIds(): List<String> =
        taskIndex.listTasks().filter { it.unreadAt != null && !it.deleted }.map { it.taskId }

    /**
     * 自动归档陈旧任务（对齐 ZCode 客户端「自动归档旧任务」）：对本工作区执行一轮
     * 客户端同款判据扫描（详见 [TaskIndexStore.autoArchiveStale]），返回归档条目。
     */
    fun autoArchiveStaleSessions(workspacePath: String, olderThanDays: Int): List<TaskIndexStore.ArchiveRef> =
        taskIndex.autoArchiveStale(cliDbPath, workspacePath, olderThanDays)

    /**
     * 列出已归档会话：双源合并（兼容既有用户的老机制归档）
     *
     * - 新机制：tasks-index archived=1（ZCode 客户端归档/自动归档 + 新版插件归档），
     *   archivedAt 取 tasks.updated_at（客户端同义，表无专门归档时间列）
     * - 旧机制：session/time_archived（老版本插件归档）
     *
     * 按 CLI 版本分两条取数链路：
     * - <0.17.0：session/list 带 includeArchived=true 返回全部隐藏会话（含 time_archived 行）
     * - ≥0.17.0：该参数被 strict schema 删除，tasks-index 归档行走 sessionIds 显式身份
     *   查询（≤64/批），time_archived 行直读 db.sqlite 补集
     *
     * 客户端归档后会话在其侧无恢复入口——插件的「已归档」列表即恢复出口。
     * tasks 里的 claude-import-* 等无 session 行的任务自然跳过。
     */
    fun listArchivedSessions(workspacePath: String? = null, limit: Int = 500, timeoutMs: Long = 10000): List<SessionInfo> {
        // 归档列表必须限定工作区：无 workspace 的全库 session/list ∪ tasks-index 的
        // 全局归档 id 交集会把**所有项目**的归档会话并进当前列表（0.3.0 装机实测缺陷：
        // 冷启动 workspacePath 空串直落全库）。空路径直接返回空，宁可空显示不跨项目污染
        if (workspacePath.isNullOrBlank()) return emptyList()
        // deleted 必须排除：客户端删除归档会话只置 tasks.deleted=1（archived 位保持 1，
        // 2026-09-08 实库实证），不过滤则客户端删掉的会话在本列表阴魂不散。
        // deletedIds 兜底覆盖"软删但 time_archived 意外残留"的行（tasks-index 是客户端
        // 私有库无兼容承诺，删除语义必须严格执行，不适用"宁多显示"原则）
        val taskRows = taskIndex.listTasks()
        val deletedIds = taskRows.asSequence().filter { it.deleted }.map { it.taskId }.toSet()

        if (canSendIncludeArchived()) {
            // 旧 CLI（<0.17.0）：includeArchived=true 一次拿全（工作区由 listSessions 限定）
            val all = listSessions(workspacePath, includeArchived = true, limit = limit, timeoutMs = timeoutMs)
            val archivedById = taskRows.filter { it.archived && !it.deleted }.associateBy { it.taskId }
            return all.mapNotNull { s ->
                if (s.sessionId in deletedIds) return@mapNotNull null
                val t = archivedById[s.sessionId]
                when {
                    t != null -> s.copy(archivedAt = t.updatedAt)   // 新机制（tasks-index）
                    (s.archivedAt ?: 0L) > 0L -> s                  // 旧机制（time_archived）
                    else -> null
                }
            }.sortedByDescending { it.archivedAt ?: 0L }
        }

        // 新 CLI（≥0.17.0）：includeArchived 已删除，先按工作区筛 tasks-index 归档行，
        // 再经 sessionIds 显式身份查询取会话详情（斜杠双形态匹配，同 listSessions 撕裂因）
        val nativePath = workspacePath.replace('/', File.separatorChar)
        val altPath = workspacePath.replace('\\', '/')
        val archivedById = taskRows.asSequence()
            .filter { it.archived && !it.deleted }
            .filter {
                it.workspacePath.equals(nativePath, ignoreCase = true) ||
                    it.workspacePath.equals(altPath, ignoreCase = true)
            }
            .associateBy { it.taskId }
        val seen = HashSet<String>()
        val fromTasks = listSessionsByIds(archivedById.keys, nativePath, altPath, timeoutMs).mapNotNull { s ->
            if (s.sessionId in deletedIds || !seen.add(s.sessionId)) return@mapNotNull null
            s.copy(archivedAt = archivedById[s.sessionId]?.updatedAt ?: s.archivedAt)
        }
        // 旧机制补集：tasks 无行、仅 session.time_archived 非空（老版本插件归档的存量用户）
        val fromLegacyDb = queryLegacyArchivedFromDb(nativePath, altPath)
            .filter { it.sessionId !in deletedIds && seen.add(it.sessionId) }
        return (fromTasks + fromLegacyDb).sortedByDescending { it.archivedAt ?: 0L }
    }

    /**
     * 直读 db.sqlite 捞旧机制归档会话（session.time_archived IS NOT NULL）。
     * ≥0.17.0 的 session/list 不再返回隐藏会话，老插件归档的存量行只能由此补集；
     * 列存在性 fail-soft（未来 CLI 若删列，返回空，归档走 tasks-index 新机制不受影响）。
     */
    private fun queryLegacyArchivedFromDb(nativeDir: String, altDir: String): List<SessionInfo> {
        if (!java.nio.file.Files.exists(cliDbPath)) return emptyList()
        return try {
            val pb = ProcessBuilder(nodePath, "-e", SESSION_ARCHIVED_LEGACY_JS)
            pb.environment()["ZCODE_ARCH_DB"] = cliDbPath.toString()
            pb.environment()["ZCODE_ARCH_DIR_NATIVE"] = nativeDir
            pb.environment()["ZCODE_ARCH_DIR_ALT"] = altDir
            pb.redirectError(ProcessBuilder.Redirect.DISCARD)
            val p = pb.start()
            val out = p.inputStream.bufferedReader().readText()
            if (!p.waitFor(10, TimeUnit.SECONDS) || p.exitValue() != 0) return emptyList()
            Json.parseToJsonElement(out.trim()).jsonArray.mapNotNull { el ->
                try {
                    val r = el.jsonObject
                    SessionInfo(
                        sessionId = r["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null,
                        title = r["title"]?.jsonPrimitive?.contentOrNull ?: "",
                        sessionKind = "interactive",
                        workspace = Workspace(nativeDir),
                        createdAt = r["time_created"]?.jsonPrimitive?.longOrNull ?: 0L,
                        updatedAt = r["time_updated"]?.jsonPrimitive?.longOrNull ?: 0L,
                        archivedAt = r["time_archived"]?.jsonPrimitive?.longOrNull,
                    )
                } catch (e: Exception) {
                    null
                }
            }
        } catch (e: Exception) {
            println("[ZCodeProtocolClient] legacy archived query failed (degrading to empty): ${e.message}")
            emptyList()
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
     * @param runtimeModel 仅 OLD 代生效：服务端收到后把 provider 注册进 workspace
     *   providers 再切换，绕过"可选模型"校验。NEW 代忽略（strict schema 拒收该字段，
     *   模型须已在 providerRegistry——即 provider_config.json 的用户自建渠道）。
     */
    fun setModel(sessionId: String, modelId: String, providerId: String, runtimeModel: JsonObject? = null, timeoutMs: Long = 6000) {
        // setModel 的参数 schema 要求 model 是对象 {modelId, providerId}，不是 modelId 字符串。
        // setModel 幂等（同 session 设同模型语义等价），初始化并发拥堵易超时 → 走重试
        val params = buildJsonObject {
            put("sessionId", sessionId)
            put("model", modelRefJson(modelId, providerId))
            if (generation == ProtocolGeneration.OLD) runtimeModel?.let { put("runtimeModel", it) }
        }
        requireOk(requestWithRetry("session/setModel", params, timeoutMs, maxAttempts = 3, backoffMs = longArrayOf(300, 800)))
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
        rawBackendErrorHandler = null
        // 唤醒所有等待的 future
        pendingResponses.values.forEach { it.completeExceptionally(IOException("client closed")) }
        // 停收新写入任务（在途/卡住的写入线程随下方 kill 的管道断裂自然解锁）
        writeGate.close()
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

/**
 * 协议异常。reason 是可选的机器可读错误码（如 v4 编辑链路的 notLatestUserMessage /
 * commandFailed）：本模块无 i18n 依赖，用户可见文案由前端按 reason 映射五语言包，
 * message 原文仅落日志与回退兜底。
 */
class ZCodeProtocolException(
    message: String,
    val code: Int = -1,
    cause: Throwable? = null,
    val reason: String? = null,
) : RuntimeException(message, cause) {
    companion object {
        fun fromError(errorElement: JsonElement): ZCodeProtocolException {
            val err = errorElement.jsonObject
            val code = err["code"]?.jsonPrimitive?.jsonStringOrNull?.toIntOrNull() ?: -1
            val msg = err["message"]?.jsonPrimitive?.jsonStringOrNull ?: "未知错误"
            return ZCodeProtocolException("[$code] $msg", code = code)
        }
    }
}

/**
 * v4 编辑目标行在行流里找不到（2026-09-12 用户三轮反馈定性）：会话的 v4 行流
 * （rowsRange 数据源）为空或不含目标行——实测会话级发生（连 send 都不产生行流，
 * 探针复刻插件启动形态无法复现，zcode.cjs 内部行为）。调用方（editUserQuery /
 * forkAssistant 命令）收到此异常应走降级路径而非直接报错。
 */
class EditTargetGoneException(message: String) : RuntimeException(message)

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

/** 历史列表补查（fork 会话 + 目标模式会话，session/list roots=true/session_target 两缺口）：
 *  目录用环境变量传参与 [SESSION_STATS_JS] 同模式。internal：供 [ForkSessionsQueryTest]
 *  做临时库回归（防双引号转义坑回归）。
 *  ⚠️ JS 字符串一律单引号/反引号，禁双引号——Windows 上 Java ProcessBuilder 传 -e 脚本参数
 *  的转义链（Java→CreateProcess→node argv 解析）会把 JS 双引号弄坏，node 收到残缺脚本
 *  SyntaxError exit 1（fork24 实测复现：双引号 exit=1 零输出、反引号 exit=0 出 23 行） */
internal val SESSION_LIST_EXTRAS_JS = """
    const {DatabaseSync} = require('node:sqlite');
    const db = new DatabaseSync(process.env.ZCODE_FORK_DB);
    db.exec('PRAGMA busy_timeout = 15000');
    const forks = db.prepare(
        `SELECT id, title, time_created, time_updated FROM session ` +
        `WHERE parent_id IS NOT NULL AND task_type='fork' AND directory IN (?, ?) ` +
        `ORDER BY time_updated DESC LIMIT 200`
    ).all(process.env.ZCODE_FORK_DIR_NATIVE, process.env.ZCODE_FORK_DIR_ALT);
    const goals = db.prepare(
        `SELECT DISTINCT st.session_id AS sid FROM session_target st ` +
        `JOIN session s ON s.id = st.session_id ` +
        `WHERE s.directory IN (?, ?)`
    ).all(process.env.ZCODE_FORK_DIR_NATIVE, process.env.ZCODE_FORK_DIR_ALT).map(r => r.sid);
    console.log(JSON.stringify({ forks: forks, goalIds: goals }));
""".trimIndent()

/** 旧机制归档补查（≥0.17.0 listArchivedSessions 用）：session.time_archived IS NOT NULL。
 *  列不存在（CLI 未来删列）输出空数组；目录双形态同 SESSION_LIST_EXTRAS_JS。JS 全单引号。 */
private val SESSION_ARCHIVED_LEGACY_JS = """
    const {DatabaseSync} = require('node:sqlite');
    const db = new DatabaseSync(process.env.ZCODE_ARCH_DB);
    db.exec('PRAGMA busy_timeout = 15000');
    const cols = db.prepare('PRAGMA table_info(session)').all().map(c => c.name);
    if (!cols.includes('time_archived')) { console.log('[]'); process.exit(0); }
    const rows = db.prepare(
        `SELECT id, title, time_created, time_updated, time_archived FROM session ` +
        `WHERE time_archived IS NOT NULL AND directory IN (?, ?) ` +
        `ORDER BY time_archived DESC LIMIT 500`
    ).all(process.env.ZCODE_ARCH_DIR_NATIVE, process.env.ZCODE_ARCH_DIR_ALT);
    console.log(JSON.stringify(rows));
""".trimIndent()

/** 会话统计（历史列表展示）：消息数 + message/part 内容字节和 */
data class SessionStat(val messageCount: Int, val sizeBytes: Long)
