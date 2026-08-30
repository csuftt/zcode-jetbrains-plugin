package com.zcode.ideaplugin.ui

import com.zcode.ideaplugin.protocol.LogRedactor

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.Disposable
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptor
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.diff.DiffManager
import com.intellij.diff.contents.DiffContent
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.diff.DiffContentFactory
import com.intellij.ui.JBColor
import com.intellij.ui.content.Content
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefJSQuery
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.SystemInfo
import com.intellij.util.ui.JBUI
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefLoadHandler
import org.cef.network.CefRequest
import com.zcode.ideaplugin.ZCodeService
import com.zcode.ideaplugin.ZCodeWebviewServer
import com.zcode.ideaplugin.zCodeService
import com.zcode.ideaplugin.protocol.Credentials
import com.zcode.ideaplugin.protocol.ImageArtifactMapper
import com.zcode.ideaplugin.protocol.ZCodeProtocolClient
import com.zcode.ideaplugin.protocol.ZCodeProtocolException
import com.zcode.ideaplugin.protocol.SessionStat
import com.zcode.ideaplugin.protocol.model.AttachmentInput
import com.zcode.ideaplugin.protocol.model.SessionInfo
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.awt.BorderLayout
import java.awt.datatransfer.DataFlavor
import java.awt.dnd.DropTarget
import java.awt.dnd.DropTargetAdapter
import java.awt.dnd.DropTargetDropEvent
import java.io.File
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.SwingUtilities

/**
 * ZCode ToolWindow 面板：JCEF 容器 + Java↔JS 双向 IPC
 *
 * 架构（参考 ccgui）：
 *   React UI (webview)
 *     ↕ JBCefJSQuery（JS→Java，官方推荐 API）
 *     ↕ executeJavaScript（Java→JS，直接推）
 *   JCEF (JBCefBrowser)
 *     ↕
 *   ZCodeService → ZCodeProtocolClient → ZCode app-server
 *
 * 消息协议（JS↔Java）：
 *   JS→Java: window.sendToJava(jsonStr) → JBCefJSQuery → handleJsMessage
 *   Java→JS: executeJavaScript("window.zcodeBridge.onMessage(jsonStr)")
 */
class ZCodeToolWindowPanel(
    private val project: Project,
    /** 重启恢复时绑定的会话 id（注入 webview 作初始会话）；null = 新标签，前端自动建会话 */
    private val initialSessionId: String? = null,
    /**
     * 懒加载：true 时不立即创建 JCEF（只放占位 UI），首次切到本标签才真正创建。
     * 用于重启恢复的非激活标签——避免 IDE 启动风暴中同时拉起多个 Chromium 渲染进程
     * （2026-08-15 白屏故障的触发条件：3 个渲染进程并发初始化全部失败）。
     */
    private val lazyStart: Boolean = false,
) : JPanel(BorderLayout()), Disposable {

    private val log = Logger.getInstance("ZCodePlugin")
    private val json = Json { ignoreUnknownKeys = true }
    private lateinit var jbCefBrowser: JBCefBrowser
    private lateinit var jsQuery: JBCefJSQuery
    // 懒加载占位组件（激活时移除）
    private var lazyPlaceholder: JComponent? = null
    // 面板创建时刻（「前端已就绪」耗时统计基准）
    private val panelCreatedAt = System.currentTimeMillis()
    // 前端首条 JS 消息是否已到达（就绪信号；executeJavaScript 是 fire-and-forget，注入成功不代表页面活着）
    @Volatile
    private var frontendReady = false

    // ============ 多标签页状态 ============
    // 所属 Content（标签标题更新用，Factory 创建后注入）
    @Volatile
    private var attachedContent: Content? = null
    // 标签基础标题（不含「●」生成中后缀）；跟随前端推送的会话标题
    @Volatile
    private var baseTabTitle: String = ""
    // 本标签当前会话是否生成中（displayName 后缀 ●）
    @Volatile
    private var tabStreaming: Boolean = false

    // ============ 流式订阅状态 ============
    // 当前选中的 sessionId（标签持久化 + 生成中状态归属判断）
    @Volatile
    private var currentSessionId: String? = null
    // 已 subscribe 过的会话集合（每个会话只 subscribe 一次，不 unsubscribe）。
    // 多标签下事件按此集合过滤：本面板只推自己订阅会话的事件，与其他标签互不影响
    private val subscribedSessions = java.util.concurrent.CopyOnWriteArraySet<String>()
    // 全局监听器是否已注册
    @Volatile
    private var globalListenerRegistered = false

    /**
     * 会话级请求超时的忙窗口自愈重试（缺陷AB）：resume 恢复带中断回合的会话后
     * app-server 有 ~1-2 分钟窗口期，subscribe/setModel/readSettings 集中超时且
     * 窗口后自愈；失败后延迟重试跨过窗口，避免用户"一看报错就重启"永远撞在窗口内。
     */
    private val busyRetry = BusyRetryScheduler(
        java.util.concurrent.Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "zcode-busy-retry").apply { isDaemon = true }
        }
    )

    /** 协议请求超时（忙窗口内的典型失败形态；-32004 等永久错误不重试）*/
    private fun isTimeoutEx(e: Exception): Boolean =
        e is com.zcode.ideaplugin.protocol.ZCodeProtocolException &&
            e.message?.startsWith("请求超时") == true

    /**
     * 模型不在服务端注册表（-32603 Unsupported model）。回合进行中 setModel 不消费
     * runtimeModel 注册（2026-08-28 实测），未注册模型在该窗口内必然撞此错——
     * 与超时不同，它出现在"回合刚起"的竞态里时可以转延迟切换而非报错。
     */
    private fun isUnsupportedModelEx(e: Exception): Boolean =
        e is com.zcode.ideaplugin.protocol.ZCodeProtocolException &&
            (e.code == -32603 || e.message?.contains("Unsupported model") == true)

    // ============ 回合中延迟切模型（缺陷AC + -32603 变体，2026-08-28）============
    // 回合流式期间 session/setModel 有两个服务端坑：①立即生效会 dispose 旧签名器，
    // 在途回合下一轮请求即死（缺陷AC）；②该窗口内不注册 runtimeModel，切到未注册
    // 模型直接 -32603 Unsupported model。插件侧统一防护：回合中收到 setModel 只挂起，
    // turn.completed/failed 后异步补发（此时注册+切换均正常，实测验证）。
    /** 回合进行中的会话 → turnId（turn.started 进、turn.completed/failed 出；null=事件没带 turnId）。
     *  延迟切换与停止升级（缺陷AD重审：V4 升级的回合 id 守卫）两个状态机共用的判据 */
    private val streamingTurns: MutableMap<String, String?> =
        java.util.Collections.synchronizedMap(HashMap<String, String?>())

    /** 每会话挂起的延迟切换目标（重复点击只保留最新；补发成功或失败后清除）*/
    private data class PendingModelSwitch(val modelId: String, val providerId: String)

    private val pendingModelSwitches = java.util.concurrent.ConcurrentHashMap<String, PendingModelSwitch>()

    /**
     * resume 同会话去重（缺陷AB 优先级编排①）：subscribe 与 messages 两条链路
     * 并发打开同一会话时只排一次 resume 进服务端队列（坏会话每次 8.7s，直接省一半
     * 队列头部）。失败不缓存、也不阻断调用方（旧语义：失败可能 already active，照常继续）
     */
    private val resumeDeduper = ResumeDeduper()

    private fun resumeSessionDeduped(
        client: com.zcode.ideaplugin.protocol.ZCodeProtocolClient,
        sessionId: String,
        workspacePath: String,
    ) {
        val ok = resumeDeduper.resumeOnce(sessionId) {
            try {
                val ws = com.zcode.ideaplugin.protocol.model.Workspace(workspacePath)
                client.resume(sessionId, ws)
                log.info("resume succeeded: $sessionId (workspace=$workspacePath)")
                true
            } catch (e: Exception) {
                log.info("resume failed (may already be active): ${e.message}")
                false
            }
        }
        if (!ok) log.info("resume deduped-skip or failed, continuing: $sessionId")
    }

    // ============ 释放状态 ============
    @Volatile
    private var disposed = false
    // 主题监听连接（dispose 时断开）
    private var themeBusConn: com.intellij.util.messages.MessageBusConnection? = null
    // OS 文件拖入拦截（AWT DropTarget 挂 JBCefBrowser.component，dispose 时显式 removeComponent）
    private var fileDropTarget: DropTarget? = null

    // ============ 会话内嵌浏览器（AI browser-use 同屏观察用）============
    // 浏览器作为聊天 webview 的右侧分栏，AI 导航时无需切标签页——对齐 ZCode 桌面端
    // 「浏览器侧板」形态。实例收回后保留（复用已加载页面）
    private var embeddedBrowser: ZCodeBrowserPanel? = null
    private var embeddedSplit: com.intellij.ui.OnePixelSplitter? = null
    // 浏览器弹出前的 ToolWindow 宽度（收起时还原）；-1 = 未记录
    private var toolWindowWidthBeforeBrowser: Int = -1
    // 收起/还原期间屏蔽「浏览器宽驱动总宽」监听（避免恢复过程被自己打断）
    @Volatile
    private var suppressWidthFollow = false
    // 上一轮事件时的 ToolWindow 总宽/浏览器宽：区分「中间分割线拖动」（总宽不变）与
    // 「左侧边界拖动/主窗口缩放」（总宽先变）两种宽度变化来源
    private var lastKnownTwWidth: Int = -1
    private var lastKnownBrowserWidth: Int = -1
    // 自己发起的总宽调整（followBrowserWidth→applyToolWindowWidth）触发的布局事件
    // 不算外部拖动——否则会被误判重钉基准，与跟随逻辑互相打架（实测行为反转的根因）
    @Volatile
    private var expectOwnTwChange = false
    // 浏览器是全局单例、分栏可多次摘挂（迁移/收起再展开）：先移除旧监听防叠加
    private var browserWidthListener: java.awt.event.ComponentListener? = null

    // 重启宽度还原（PropertiesComponent，project 级）：关闭时浏览器展开 → IDE 恢复的
    // TW 总宽含浏览器宽，重启后浏览器收起、聊天独占总宽显得很大——持久化聊天基准宽+展开
    // 状态，恢复会话时一次性还原到基准宽
    private companion object {
        const val KEY_BROWSER_EXPANDED = "zcode.browser.paneExpanded"
        const val KEY_CHAT_BASE_WIDTH = "zcode.browser.chatBaseWidth"

        /**
         * config.json 读-改-写全程互斥锁（多标签各持独立 Panel 实例，op 处理并发跑在
         * 各自的池线程上）：锁住「读文件→内存改→原子替换」整段，防两个标签同时切换
         * provider 时后写覆盖前写。与 ZCode 官方客户端的跨进程并发无法加锁，靠
         * tmp+原子替换把窗口压到毫秒级、且只改 provider.<id>.enabled 单字段兜底。
         */
        val CONFIG_WRITE_LOCK = Any()

        /** 外观配置（Application 级，跨项目共享，存取见 ZCodeAppearanceStore）：
         *  localStorage 在生产模式下按 origin 隔离——内置 server 每次重启端口随机，
         *  origin 变化导致配置丢失，因此主题/字号/自定义颜色以 IDE 侧持久化为权威源，
         *  webview 启动时经 buildBridgeJs 注入（__ZCODE_APPEARANCE__） */

        /** webview 通用 kv（配置类 localStorage 的权威源，同 appearance 迁移原因）：
         *  string→string JSON map（搜索开关/输入历史/模型记忆/思考级别/会话标题/上下文构成）
         *  PropertiesComponent key 定义在 ZCodeLanguageService.KEY_WEBVIEW_KV（语言服务共用）*/

        /** 多标签面板实例注册表：外观配置保存后向所有已开标签广播（JCEF 多 browser
         *  间 storage 事件不派发，已开标签收不到其他标签的 localStorage 变更——
         *  cc-gui ThemeConfigService 的 CopyOnWriteArraySet 回调注册同模式）*/
        val activePanels = java.util.concurrent.CopyOnWriteArraySet<ZCodeToolWindowPanel>()
    }

    /** 读取外观配置 JSON（fontScale/themePref/chatBg/chatBar/userMsg），无配置返回 null */
    private fun readAppearanceJson(): String? = ZCodeAppearanceStore.rawJson()

    /** 读取 webview kv JSON map，无配置返回 null */
    private fun readKvJson(): String? {
        return try {
            com.intellij.ide.util.PropertiesComponent.getInstance().getValue(ZCodeLanguageService.KEY_WEBVIEW_KV)
        } catch (_: Exception) { null }
    }

    /** 权威 kv 下发（kvLoad）：onLoadStart/onLoadEnd 的 executeJavaScript 注入时序不稳
     *  （冷启动 JS 上下文未就绪时丢失），前端超时后经消息通道拉取——必然可达，
     *  避免输入历史等持久化数据冷启动水合失败（读空） */
    private fun handleKvLoad(): JsonObject = buildJsonObject {
        put("op", "kvLoaded")
        put(
            "kv",
            readKvJson()?.let {
                try { Json.parseToJsonElement(it) } catch (_: Exception) { null }
            } ?: JsonObject(emptyMap()),
        )
    }

    private fun persistBrowserWidthState(expanded: Boolean, base: Int) {
        try {
            val props = com.intellij.ide.util.PropertiesComponent.getInstance(project)
            props.setValue(KEY_BROWSER_EXPANDED, expanded, false)
            if (base > 0) props.setValue(KEY_CHAT_BASE_WIDTH, base, -1)
        } catch (_: Exception) {}
    }

    /** initJcef 后调用：关闭时浏览器展开则把 TW 宽还原到聊天基准宽（一次性，标志自清）*/
    private fun restoreWidthAfterRestart() {
        try {
            val props = com.intellij.ide.util.PropertiesComponent.getInstance(project)
            if (props.getBoolean(KEY_BROWSER_EXPANDED, false)) {
                val base = props.getInt(KEY_CHAT_BASE_WIDTH, -1)
                if (base > 0) {
                    // 自清：只还原一次，避免用户之后无浏览器拖宽也被拉回
                    props.setValue(KEY_BROWSER_EXPANDED, false, false)
                    toolWindowWidthBeforeBrowser = base // 后续 AI/用户展开浏览器以此为聊天基准
                    log.info("Browser pane expanded at close, restoring ToolWindow width to chat baseline $base")
                    SwingUtilities.invokeLater { tryRestoreWidth(base, 10) }
                }
            }
        } catch (e: Exception) {
            log.warn("Width restore on restart failed: ${e.message}")
        }
    }

    /** 等待 TW 有尺寸后还原（重启初期布局未完成 width=0，限次重试）*/
    private fun tryRestoreWidth(base: Int, retries: Int) {
        if (disposed) return
        val tw = ZCodeToolWindowFactory.getToolWindow(project) ?: return
        val current = tw.component.width
        if (current <= 0) {
            if (retries > 0) SwingUtilities.invokeLater { tryRestoreWidth(base, retries - 1) }
            return
        }
        // 明显大于基准（含浏览器宽）才还原；阈值防正常波动误判
        if (current > base + JBUI.scale(120)) {
            applyToolWindowWidth(base)
            log.info("ToolWindow width restored on restart: $current → $base (chat-only width)")
        }
    }

    // ============ 流式推送节流缓冲 ============
    // 高频 delta 事件先缓冲，每 16ms（60fps）合并成一批推送，避免 executeJavaScript 积压
    private val streamBuffer = java.util.concurrent.ConcurrentLinkedQueue<Pair<String, JsonObject>>()
    @Volatile
    private var streamFlusherRunning = false
    private val streamFlushLock = Any()

    init {
        border = JBUI.Borders.empty()
        background = JBColor.background()
        activePanels.add(this) // 多标签实例注册（外观配置广播用）

        if (!JBCefApp.isSupported()) {
            add(createUnsupportedPanel(), BorderLayout.CENTER)
        } else if (lazyStart) {
            val placeholder = createLazyPlaceholder()
            lazyPlaceholder = placeholder
            add(placeholder, BorderLayout.CENTER)
            log.info("Tab lazy-load ready (JCEF not created, activates on tab switch; initialSessionId=$initialSessionId)")
        } else {
            initJcef()
            registerThemeListener()
            restoreWidthAfterRestart()
        }
    }

    /**
     * 懒加载标签激活：首次切到本标签时创建 JCEF（幂等；须在 EDT，非 EDT 自动转）。
     * 激活后前端 boot → listSessions → 按 initialSessionId 恢复会话，与正常路径一致。
     */
    fun ensureJcefCreated() {
        if (disposed || ::jbCefBrowser.isInitialized || !JBCefApp.isSupported()) return
        if (!SwingUtilities.isEventDispatchThread()) {
            SwingUtilities.invokeLater { ensureJcefCreated() }
            return
        }
        log.info("Lazy tab activated, creating JCEF panel (initialSessionId=$initialSessionId)")
        initJcef()
        registerThemeListener()
        restoreWidthAfterRestart()
        revalidate()
        repaint()
    }

    /** 懒加载标签的占位 UI（不创建 Chromium 渲染进程）*/
    private fun createLazyPlaceholder(): JComponent {
        val label = javax.swing.JLabel(com.zcode.ideaplugin.ZCodeBundle.message("panel.lazyPlaceholder"))
        label.foreground = JBColor.foreground()
        label.horizontalAlignment = javax.swing.SwingConstants.CENTER
        val wrapper = JPanel(BorderLayout())
        wrapper.background = JBColor.background()
        wrapper.add(label, BorderLayout.CENTER)
        return wrapper
    }

    private fun initJcef() {
        log.info("Initializing JCEF panel")
        jbCefBrowser = JBCefBrowser()

        // ============ JS → Java：用 JBCefJSQuery（官方推荐，签名稳定）============
        // JBCefJSQuery.create(JBCefBrowser) 已弃用（forRemoval），改用 create(JBCefBrowserBase) 重载
        jsQuery = JBCefJSQuery.create(jbCefBrowser as com.intellij.ui.jcef.JBCefBrowserBase)
        log.info("JBCefJSQuery created, funcName=${jsQuery.funcName}")
        jsQuery.addHandler { request ->
            if (!frontendReady) {
                val op = Regex("\"op\"\\s*:\\s*\"([^\"]+)\"").find(request)?.groupValues?.get(1) ?: "?"
                // __jsLog 只是诊断回传（可能是崩溃报告），不算前端就绪
                if (op != "__jsLog") {
                    frontendReady = true
                    log.info("Frontend ready: first JS message arrived (op=$op, ${System.currentTimeMillis() - panelCreatedAt}ms after panel creation)")
                }
            }
            log.info("JS message received: ${LogRedactor.redact(request.take(600)).take(200)}")
            handleJsMessage(request)
            JBCefJSQuery.Response("ok")
        }

        // ============ 观测：页面加载状态 + 前端 console 转发（排查白屏用）============
        // 2026-08-15 白屏故障的教训：executeJavaScript 是 fire-and-forget，渲染进程死掉也不报错，
        // 必须靠 loadError / console 日志才能看到渲染层发生了什么
        registerDiagnostics()

        // ============ 加载 webview（dev 优先 → 生产 → fallback）============
        loadWebview()
        // AskUser/ExitPlanMode 协调器与 browser-use 执行器在 Service 层注册（多标签共享）。
        // 这两个调用内部会 getClient() 启动协议客户端，触发 ZCodeEnvChecker 环境检查；
        // CLI 未安装/未配置时抛 EnvCheckException——必须捕获，否则 ToolWindow 创建失败
        // 导致整个 IDE 主界面不渲染。捕获后 webview 正常加载，前端通过 checkEnv 渲染环境提醒。
        try {
            project.zCodeService().ensureUserInputHandler()
            project.zCodeService().ensureBrowserExecutor()
        } catch (e: com.zcode.ideaplugin.env.EnvCheckException) {
            log.warn("[initJcef] ZCode CLI unavailable, protocol handlers not registered (frontend will show env reminder): ${e.message}")
        }

        // 开启 JCEF 外部链接（开发期）
        jbCefBrowser.setOpenLinksInExternalBrowser(true)

        // 移除懒加载占位（如有）
        lazyPlaceholder?.let { remove(it) }
        lazyPlaceholder = null
        add(jbCefBrowser.component, BorderLayout.CENTER)
        // OS 文件拖入拦截：必须在 component 加入面板后才挂（否则 Swing DnD 无目标组件）
        registerFileDropTarget()
        log.info("JCEF panel initialized")
    }

    /**
     * 注册渲染层诊断（排查白屏用）+ 桥变量持续注入：
     * - CefLoadHandler：onLoadEnd（页面真正加载完成的时刻）/ onLoadError（加载失败，白屏第一现场）。
     *   executeJavaScript 是 fire-and-forget，渲染进程死掉也不报错，只有 load 日志能看到真相
     *   （2026-08-15 白屏故障的教训）。
     * - 桥变量注入：onLoadStart/onLoadEnd 各注一次（executeJavaScript 赋值幂等），
     *   替代旧「sleep 800ms 一次性注入」——URL 加载路径（dev 5173 / 内置 server）的
     *   HMR full reload、页面导航后桥不再丢失。
     * - 前端 console.error / window.onerror / unhandledrejection 回传：见 buildBridgeJs 注入的
     *   __ZCODE_LOG_HOOK__（走 JBCefJSQuery 桥，op=__jsLog；此版本 JBCefClient 无 console 监听 API）。
     */
    private fun registerDiagnostics() {
        jbCefBrowser.jbCefClient.addLoadHandler(object : CefLoadHandler {
            override fun onLoadingStateChange(
                browser: CefBrowser?, isLoading: Boolean, canGoBack: Boolean, canGoForward: Boolean,
            ) {}

            override fun onLoadStart(browser: CefBrowser?, frame: CefFrame?, transitionType: CefRequest.TransitionType?) {
                if (frame?.isMain == true) injectBridgeVars()
            }

            override fun onLoadEnd(browser: CefBrowser?, frame: CefFrame?, httpStatusCode: Int) {
                if (frame?.isMain == true) {
                    log.info("[webview-load] onLoadEnd httpStatus=$httpStatusCode (page load completed)")
                    injectBridgeVars()
                }
            }

            override fun onLoadError(
                browser: CefBrowser?, frame: CefFrame?, errorCode: CefLoadHandler.ErrorCode?,
                errorText: String?, failedUrl: String?,
            ) {
                if (frame?.isMain != true) return
                if (errorCode == CefLoadHandler.ErrorCode.ERR_ABORTED) {
                    // ERR_ABORTED 常见于正常导航替换，非故障
                    log.info("[webview-load] onLoadError (benign ERR_ABORTED)")
                } else {
                    log.warn("[webview-load] onLoadError code=$errorCode text=$errorText url=${failedUrl?.take(120)}")
                }
            }
        }, jbCefBrowser.cefBrowser)
    }

    /**
     * 注册 IDE 主题变化监听（阶段 2.6）
     *
     * IDE 主题切换时（用户改 Darcula/Light），通过 onIdeThemeChanged 推给前端。
     * 延迟推送：JCEF 页面可能还没 load 完，用定时重试确保前端收到。
     */
    private fun registerThemeListener() {
        val busConn = project.messageBus.connect()
        themeBusConn = busConn
        busConn.subscribe(
            com.intellij.ide.ui.LafManagerListener.TOPIC,
            com.intellij.ide.ui.LafManagerListener {
                // 主题变了，推给前端
                log.info("IDE theme changed, pushing to frontend")
                pushTheme()
            }
        )
    }

    /**
     * 注册 OS 文件拖入拦截（AWT DropTarget 路径）
     *
     * 路径来源 AWT [DataFlavor.javaFileListFlavor] → `List<File>` → 100% 真绝对路径
     * （不依赖 CefDragHandler.getFileNames 的 native 行为；OS 拖动时 transferable 已含完整路径，
     * 与 JBCefBrowser 是否 OSR / remote 无关——windowed 模式稳定）。
     *
     * 触发后复用现有 `filesToInput` 推送链路（与 [handlePickFiles] / [com.zcode.ideaplugin.action.SendFileToInputAction] 同 op），
     * 前端 InputBox 监听器自动接住加 chip。
     *
     * 挂载时机：`JBCefBrowser.component` 已加入面板之后（`initJcef()` 末），否则 Swing DnD 无目标组件。
     * 多 tab：每个 panel 独立 JBCefBrowser 各挂各的——本 panel 只处理自己 webview 的拖入，
     * 跨 tab 拖入由用户在目标 tab 内再次拖（与 SendFileToInputAction 走 activePanel 全局路由不同）。
     */
    private fun registerFileDropTarget() {
        val comp = jbCefBrowser.component
        fileDropTarget = DropTarget(comp, object : DropTargetAdapter() {
            override fun drop(dtde: DropTargetDropEvent) {
                try {
                    // 用拖动源声明的动作（COPY / MOVE / LINK）而非硬编码——尊重 OS 端意图
                    dtde.acceptDrop(dtde.dropAction)
                    val t = dtde.transferable
                    if (!t.isDataFlavorSupported(DataFlavor.javaFileListFlavor)) {
                        dtde.dropComplete(false)
                        return
                    }
                    // AWT DataFlavor.javaFileListFlavor 在 JDK 11+ 标 @Deprecated 警告但仍可用，
                    // 返回类型是 Any!，需要强转 + 空兜底
                    val files: List<File> = runCatching {
                        @Suppress("UNCHECKED_CAST")
                        t.getTransferData(DataFlavor.javaFileListFlavor) as List<File>
                    }.getOrElse { emptyList() }
                    if (files.isEmpty()) {
                        // 空列表 = 接受但无内容，告诉 OS 成功（避免 macOS Finder 残影）
                        dtde.dropComplete(true)
                        return
                    }
                    // 与 FileRefs.toRef 同款格式（不走 FileRefs 因为这里是 java.io.File 不是 VirtualFile，
                    // 语义上等价但来源不同——AWT 没有 presentableUrl 概念）
                    val refs = files.map<File, String> { f ->
                        val p = f.absolutePath
                        val withSlash = if (f.isDirectory && !p.endsWith("/")) "$p/" else p
                        "@$withSlash"
                    }
                    log.info("[fileDrop] intercepted ${refs.size} file(s): ${refs.take(3)}")
                    pushToWebview(buildJsonObject {
                        put("op", "filesToInput")
                        put("refs", JsonArray(refs.map { JsonPrimitive(it) }))
                        // 标记来源让前端按心智分流：拖拽走内联 chip（与"粘贴完整路径"一致），
                        // IDE 右键/附件按钮不带 source 字段走原逻辑（空输入框入顶部 chip 栏）
                        put("source", "drag")
                    })
                    dtde.dropComplete(true)
                } catch (e: Exception) {
                    log.warn("[fileDrop] drop failed: ${e.message}")
                    try { dtde.dropComplete(false) } catch (_: Exception) {}
                }
            }
        })
        log.info("[fileDrop] DropTarget registered")
    }

    /** 推送当前 IDE 主题给前端（通过 executeJavaScript 调 onIdeThemeChanged）*/
    private fun pushTheme() {
        if (!::jbCefBrowser.isInitialized) return // 懒加载标签未激活
        val isDark = !JBColor.isBright()
        val js = "if (window.onIdeThemeChanged) window.onIdeThemeChanged($isDark);"
        SwingUtilities.invokeLater {
            try {
                jbCefBrowser.cefBrowser.executeJavaScript(js, "zcode-theme", 0)
            } catch (e: Exception) {
                log.warn("Theme push failed: ${e.message}")
            }
        }
    }

    /**
     * 加载 webview 内容
     *
     * 加载策略（按优先级）：
     * 1. dev 模式：探测 localhost:5173（vite dev server），通了就 loadURL（带 HMR）
     * 2. 生产首选：内置静态资源 server（ZCodeWebviewServer serve 多文件产物 + sourcemap），
     *    真实 origin，DevTools 可直接看 TS/TSX 源码断点，外部浏览器亦可打开同地址调试
     * 3. 生产 fallback：singlefile 单 HTML（server 启动失败/产物缺失时，无 origin 无 sourcemap）
     * 4. 兜底：旧的 inline HTML（保证没构建产物时也能用）
     *
     * URL 路径（1/2）的桥变量由 registerDiagnostics 的 load handler 在每次
     * onLoadStart/onLoadEnd 注入（幂等），HMR full reload / 页面导航后桥不丢。
     */
    private fun loadWebview() {
        val devUrl = "http://localhost:5173"

        // dev server 探测（socket 300ms + HTTP 校验最多 ~2.6s）挪出 EDT：initJcef 在 EDT
        // 上走到这里，同步探测会把首个标签/新开标签卡住秒级（多标签时 ×N）。池线程探测，
        // 完成后回 EDT 按结果加载——期间 initJcef 余下步骤照常执行，面板先渲染占位
        com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread {
            val devAlive = isDevServerAlive(devUrl)
            com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
                // 探测期间面板可能已 dispose（项目快速关闭）：jbCefBrowser 未初始化即放弃
                if (!::jbCefBrowser.isInitialized) return@invokeLater
                loadWebviewAfterProbe(devUrl, devAlive)
            }
        }
    }

    /** 探测完成后的实际加载决策（EDT 上执行，与原 loadWebview 的优先级链一致） */
    private fun loadWebviewAfterProbe(devUrl: String, devAlive: Boolean) {
        if (devAlive) {
            // dev 模式：连 vite dev server
            log.info("Dev server detected, loading $devUrl (dev mode, HMR)")
            jbCefBrowser.loadURL(devUrl)
            return
        }

        // 生产首选：内置静态资源 server
        val baseUrl = ZCodeWebviewServer.baseUrl()
        if (baseUrl != null) {
            log.info("Loading built-in server $baseUrl/ (production multi-file mode, real origin + sourcemap debuggable)")
            jbCefBrowser.loadURL("$baseUrl/")
            return
        }

        // 生产 fallback：读 singlefile 单 HTML
        val bundledHtml = readBundledWebview()
        if (bundledHtml != null) {
            log.info("Loading resources/webview-single/index.html (singlefile fallback, length=${bundledHtml.length})")
            // 把桥变量注入到 HTML 的 <head> 最前面（DOMContentLoaded 前可用）
            val htmlWithBridge = injectBridgeIntoHtml(bundledHtml)
            jbCefBrowser.loadHTML(htmlWithBridge)
            return
        }

        // fallback：旧的 inline HTML（内含自己的 sendToJava 定义）
        log.info("No build artifact and no dev server, using fallback inline HTML")
        val fallbackHtml = buildInitialHtml(jsQuery)
        jbCefBrowser.loadHTML(fallbackHtml)
    }

    /**
     * 探测 dev server 是否为本插件 webview（localhost:5173）。
     * 仅端口活着不够——其他 vite 项目占 5173 时会把陌生页面当聊天 UI 加载
     * （实测：AI 调试用的 demo dev server 劫持过插件主界面），
     * 必须校验页面身份（title=ZCode）才走 dev 模式。
     */
    private fun isDevServerAlive(url: String): Boolean {
        return try {
            val uri = java.net.URI(url)
            java.net.Socket().use { s ->
                s.connect(java.net.InetSocketAddress(uri.host, uri.port), 300)
                s.isConnected
            } && isOurWebviewPage(url)
        } catch (e: Exception) {
            false
        }
    }

    /** 拉取页面内容校验身份：webview 的 index.html 固定 <title>ZCode</title> */
    private fun isOurWebviewPage(url: String): Boolean {
        return try {
            val body = java.net.http.HttpClient.newBuilder()
                .connectTimeout(java.time.Duration.ofMillis(800))
                .build()
                .send(
                    java.net.http.HttpRequest.newBuilder(java.net.URI(url))
                        .timeout(java.time.Duration.ofMillis(1500))
                        .GET()
                        .build(),
                    java.net.http.HttpResponse.BodyHandlers.ofString(),
                ).body()
            body.contains("<title>ZCode", ignoreCase = true)
        } catch (e: Exception) {
            false
        }
    }

    /** 从 resources/webview-single/index.html 读取 singlefile 产物（内置 server 不可用时的 fallback）*/
    private fun readBundledWebview(): String? {
        return try {
            javaClass.getResourceAsStream("/webview-single/index.html")?.bufferedReader()?.use { it.readText() }
        } catch (e: Exception) {
            log.warn("Failed to read resources/webview-single/index.html: ${e.message}")
            null
        }
    }

    /**
     * 把桥变量注入到 HTML 的 <head> 之后（生产模式用）。
     * React 的 bridge.ts 读 window.__ZCODE_CEF_QUERY__ 发消息。
     *
     * JBCefJSQuery 注入的函数名是运行时生成的（如 cefQuery_1015760238_1），
     * 我们把它赋给固定名 __ZCODE_CEF_QUERY__，React 端就不用关心动态名。
     */
    private fun injectBridgeIntoHtml(html: String): String {
        val bridgeScript = "<script>\n${buildBridgeJs()}\n</script>"
        // 插到 <head> 之后（第一个 script 之前执行）
        return if (html.contains("<head>")) {
            html.replaceFirst("<head>", "<head>$bridgeScript")
        } else {
            bridgeScript + html
        }
    }

    /**
     * 桥变量注入（EDT；幂等）。
     * buildBridgeJs 见下——URL 加载路径（dev 5173 / 内置 server）在 onLoadStart/onLoadEnd
     * 调用本方法；singlefile 路径 head 已注入，此处为兜底重复（赋值幂等无害）。
     */
    private fun injectBridgeVars() {
        if (!::jsQuery.isInitialized || !::jbCefBrowser.isInitialized) return
        val js = buildBridgeJs()
        SwingUtilities.invokeLater {
            if (disposed) return@invokeLater
            try {
                jbCefBrowser.cefBrowser.executeJavaScript(js, "zcode-bridge", 0)
            } catch (e: Exception) {
                log.warn("Bridge variable injection failed: ${e.message}")
            }
        }
    }

    /**
     * 生成注入给前端的桥变量 JS（CEF_QUERY + IDE_THEME + WORKSPACE + INITIAL_SESSION + 日志钩子）
     * workspacePath 来自当前项目，供前端做会话过滤；
     * initialSessionId 是多标签恢复绑定的会话（前端 init 优先用它做 selectSession）；
     * __ZCODE_LOG_HOOK__ 把 console.error/window.onerror/unhandledrejection 经桥回传（op=__jsLog），
     * React 启动崩溃时 idea.log 能直接看到堆栈（此版本 JBCefClient 无原生 console 监听 API）
     */
    private fun buildBridgeJs(): String {
        val funcName = jsQuery.funcName
        val isDark = !JBColor.isBright()
        val theme = if (isDark) "dark" else "light"
        val workspace = (project.basePath ?: "").replace("\\", "\\\\").replace("'", "\\'")
        val initialSession = (initialSessionId ?: "").replace("\\", "\\\\").replace("'", "\\'")
        // 外观配置：JSON 直接作为 JS 对象字面量注入（值为白名单校验过的数字/枚举/#hex 色，
        // 不含需要转义的字符）；无配置时置 null，前端回退 localStorage（dev mock 同）
        val appearance = readAppearanceJson() ?: "null"
        // kv 值来自用户输入（输入历史/会话标题），可能含 "</script>"——singlefile 路径桥脚本
        // 会嵌进 HTML，先转义防提前闭合标签（JS 字符串里 "<\/" 与 "</" 等价，语义不变）
        val kvstore = (readKvJson() ?: "null").replace("</", "<\\/")
        // 语言（ZCodeLanguageService：手动值优先，否则 IDE locale 映射；恒为白名单四值之一，
        // 无需转义）；前端 i18n 以此为初始语言权威源
        val language = ZCodeLanguageService.currentLanguage()
        return """
window.__ZCODE_CEF_QUERY__ = window['$funcName'];
window.__INITIAL_IDE_THEME__ = '$theme';
window.__ZCODE_WORKSPACE__ = '$workspace';
window.__ZCODE_INITIAL_SESSION__ = '$initialSession';
window.__ZCODE_APPEARANCE__ = $appearance;
window.__ZCODE_KVSTORE__ = $kvstore;
window.__ZCODE_LANGUAGE__ = '$language';
if (!window.__ZCODE_LOG_HOOK__) {
  window.__ZCODE_LOG_HOOK__ = true;
  (function() {
    var q = window['$funcName'];
    var send = function(level, text) {
      try {
        q({ request: JSON.stringify({ op: '__jsLog', level: level, text: String(text).slice(0, 500) }) });
      } catch (e) {}
    };
    window.addEventListener('error', function(ev) {
      send('onerror', (ev.message || '') + ' @' + (ev.filename || '') + ':' + (ev.lineno || 0));
    });
    window.addEventListener('unhandledrejection', function(ev) {
      var r = ev.reason;
      send('rejection', r && r.message ? r.message : String(r));
    });
    var origError = console.error;
    console.error = function() {
      try {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) {
          var a = arguments[i];
          parts.push(typeof a === 'object' ? JSON.stringify(a) : String(a));
        }
        send('console.error', parts.join(' '));
      } catch (e) {}
      try { origError.apply(console, arguments); } catch (e) {}
    };
  })();
}
        """.trimIndent()
    }

    /**
     * 处理来自 JS 的消息（在 JCEF 后台线程触发）
     * 用 pooled thread 跑协议调用，避免阻塞 JCEF
     */
    private fun handleJsMessage(request: String) {
        try {
            val msg = json.parseToJsonElement(request).jsonObject
            val op = msg["op"]?.jsonPrimitive?.content ?: run {
                log.warn("JS message missing op field")
                sendToJs(errorResponse("缺少 op")); return
            }
            // 前端诊断日志直落 idea.log（不走 pooled thread，量大也无协议调用）
            if (op == "__jsLog") {
                val level = msg["level"]?.jsonPrimitive?.content ?: "?"
                val text = msg["text"]?.jsonPrimitive?.content ?: ""
                log.warn("[webview-console] [$level] ${LogRedactor.redact(text)}")
                return
            }
            // 高频热路径：debug 级防 log 风暴（idea.log 已知瓶颈，排查时开 debug 看）
            log.debug("Handling op=$op")

            ApplicationManager.getApplication().executeOnPooledThread {
                try {
                    val result = when (op) {
                        "listSessions" -> handleListSessions(msg)
                        "send" -> handleSend(msg)
                        "getClipboardImage" -> handleGetClipboardImage(msg)
                        "messages" -> handleMessages(msg)
                        "subagents" -> handleSubagents(msg)
                        "subagentMessages" -> handleSubagentMessages(msg)
                        "createSession" -> handleCreateSession(msg)
                        "subscribe" -> handleSubscribe(msg)
                        "subscribeChild" -> handleSubscribeChild(msg)
                        "stop" -> handleStop(msg)
                        "listFiles" -> handleListFiles(msg)
                        "listCommands" -> handleListCommands(msg)
                        "listMemoryFiles" -> handleListMemoryFiles(msg)
                        "createMemoryFile" -> handleCreateMemoryFile(msg)
                        "setMemoryEnabled" -> handleSetMemoryEnabled(msg)
                        "browserConfig" -> handleBrowserConfig()
                        "clearBrowserData" -> handleClearBrowserData(msg)
                        "browserDataOverview" -> handleBrowserDataOverview()
                        "listSkills" -> handleListSkills(msg)
                        "toggleSkill" -> handleToggleSkill(msg)
                        "enhancePrompt" -> handleEnhancePrompt(msg)
                        "listAgents" -> handleListAgents(msg)
                        "saveAgent" -> handleSaveAgent(msg)
                        "deleteAgent" -> handleDeleteAgent(msg)
                        "listMcpServers" -> handleListMcpServers(msg)
                        "mcpServerTools" -> handleMcpServerTools(msg)
                        "getMcpLogs" -> handleGetMcpLogs(msg)
                        "askUserResponse" -> handleAskUserResponse(msg)
                        "askUserPendingState" -> handleAskUserPendingState()
                        "deleteSession" -> handleDeleteSession(msg)
                        "archiveSession" -> handleArchiveSession(msg)
                        "restoreSession" -> handleRestoreSession(msg)
                        "scheduledCreate" -> handleScheduledCreate(msg)
                        "scheduledCancel" -> handleScheduledOpSimple(msg, "cancel")
                        "scheduledReschedule" -> handleScheduledReschedule(msg)
                        "scheduledSendNow" -> handleScheduledOpSimple(msg, "sendNow")
                        "scheduledRequeue" -> handleScheduledRequeue(msg)
                        "scheduledList" -> handleScheduledListRequest()
                        "scheduledDueAck" -> handleScheduledDueAck(msg)
                        "scheduledFired" -> handleScheduledFired(msg)
                        "gotoSession" -> handleGotoSession(msg)
                        "locateSession" -> handleLocateSession(msg)
                        "listArchivedSessions" -> handleListArchivedSessions(msg)
                        "listModels" -> handleListModels(msg)
                        "modelManageList" -> handleModelManageList(msg)
                        "modelToggleProvider" -> handleModelToggleProvider(msg)
                        "setModel" -> handleSetModel(msg)
                        "cancelModelSwitch" -> handleCancelModelSwitch(msg)
                        "getSettings" -> handleGetSettings(msg)
                        "setThoughtLevel" -> handleSetThoughtLevel(msg)
                        "setMode" -> handleSetMode(msg)
                        "pickFiles" -> handlePickFiles(msg)
                        "getUsage" -> handleGetUsage(msg)
                        "getQuota" -> handleGetQuota(msg)
                        "getAppUsage" -> handleGetAppUsage(msg)
                        "getModelUsage" -> handleGetModelUsage(msg)
                        "getToolUsage" -> handleGetToolUsage(msg)
                        "openFile" -> handleOpenFile(msg)
                        "showDiff" -> handleShowDiff(msg)
                        "refreshFile" -> handleRefreshFile(msg)
                        "createTab" -> handleCreateTab()
                        "toggleBrowserPane" -> handleToggleBrowserPane()
                        "setTabTitle" -> handleSetTabTitle(msg)
                        "clearTabSession" -> handleClearTabSession()
                        "appearanceSave" -> handleAppearanceSave(msg)
                        "kvSave" -> handleKvSave(msg)
                        "kvLoad" -> handleKvLoad()
                        "checkEnv" -> handleCheckEnv()
                        "envSave" -> handleEnvSave(msg)
                        else -> errorResponse("未知 op: $op")
                    }
                    log.info("op=$op handled, sending back to JS")
                    sendToJs(result)
                } catch (e: com.zcode.ideaplugin.env.EnvCheckException) {
                    // 环境前置检查失败：附带完整 EnvStatus，前端据此渲染环境提醒条
                    log.warn("op=$op env check failed: ${e.message}")
                    sendToJs(buildJsonObject {
                        put("op", "error")
                        put("message", e.message)
                        put("envStatus", com.zcode.ideaplugin.env.ZCodeEnvChecker.statusJson(e.status))
                    })
                } catch (e: Exception) {
                    log.error("op=$op handling failed", e)
                    sendToJs(errorResponse("处理失败: ${e.message}"))
                }
            }
        } catch (e: Exception) {
            log.error("JS message parse failed: ${request.take(100)}", e)
            sendToJs(errorResponse("解析失败: ${e.message}"))
        }
    }

    // ============ 多标签页生命周期 ============

    /** Factory 创建 Content 后注入引用（标签标题更新 + 持久化用）*/
    fun attachContent(content: Content) {
        attachedContent = content
        if (baseTabTitle.isBlank()) baseTabTitle = content.displayName ?: ""
    }

    /** 标签基础标题（不含生成中后缀），持久化用 */
    fun getBaseTabTitle(): String = baseTabTitle

    /** 当前会话 id（重启恢复的绑定来源）*/
    fun getCurrentSessionIdForPersist(): String? = currentSessionId

    /** 本面板是否订阅了指定会话（Service 层 askUser 弹窗路由用）*/
    fun isSubscribedTo(sessionId: String): Boolean = sessionId in subscribedSessions

    /**
     * 激活本面板对应的 Content 标签（对话结束通知点击定位用）。
     * setSelectedContent 触发 selectionChanged 联动（activePanel 更新/懒加载/浏览器挂载迁移）。
     * 必须在 EDT 调用；Content 已关闭/detached 返回 false（调用方回退仅显示工具窗）。
     */
    fun activateContent(requestFocus: Boolean = true): Boolean {
        val content = attachedContent ?: return false
        val cm = content.manager ?: return false
        if (!SwingUtilities.isEventDispatchThread()) {
            SwingUtilities.invokeLater { activateContent(requestFocus) }
            return true
        }
        // Content 可能在 EDT 排队期间被关闭：选中失败按未命中处理（调用方仅显示工具窗）
        return runCatching {
            cm.setSelectedContent(content, requestFocus)
            true
        }.getOrDefault(false)
    }

    /**
     * 「新建会话」延迟创建（对齐新标签）：前端清空 currentSessionId 进入待命态后通知本 op，
     * Java 侧同步清 TabState 绑定（否则重启恢复会绑回旧会话）、标签 tooltip（旧会话标题）
     * 与「●」生成中标记（turn.completed 归属判断依赖 currentSessionId，清空后收不到复位）。
     * 不 unsubscribe 旧会话（同切换会话策略：切回不丢事件；前端按 currentSessionId 过滤不串扰）。
     */
    private fun handleClearTabSession(): JsonObject {
        currentSessionId = null
        setTabStreaming(false)
        persistSelfTabState()
        val content = attachedContent
        if (content != null) {
            SwingUtilities.invokeLater {
                if (!disposed) content.description = null
            }
        }
        return buildJsonObject { put("op", "tabSessionCleared") }
    }

    /**
     * 前端推送会话标题 → 更新标签 tooltip（悬停显示会话名）。
     * 标签名保持固定的「会话N」（cc-gui 编号风格，避免长标题撑爆标签栏）。
     */
    private fun handleSetTabTitle(msg: JsonObject): JsonObject {
        val title = msg["title"]?.jsonPrimitive?.content?.trim()?.take(200)
        val content = attachedContent
        if (!title.isNullOrBlank() && content != null) {
            SwingUtilities.invokeLater {
                if (!disposed) content.description = title
            }
        }
        return buildJsonObject { put("op", "tabTitleSet") }
    }

    /**
     * 保存外观配置（Application 级 PropertiesComponent）。
     * 前端全量提交（fontScale/themePref/chatBg/chatBar/userMsg），此处白名单校验后
     * 整体覆盖存储；颜色仅接受 #rrggbb 或空串（空=恢复主题默认）。
     * 前端不依赖应答（乐观更新），回执仅作调试可见性。
     */
    private fun handleAppearanceSave(msg: JsonObject): JsonObject {
        val cfg = try {
            val c = msg["config"]?.jsonObject ?: return errorResponse("appearanceSave 缺少 config")
            val fontScale = c["fontScale"]?.jsonPrimitive?.intOrNull ?: 3
            val themePref = c["themePref"]?.jsonPrimitive?.contentOrNull ?: ""
            // 颜色白名单：#rrggbb 或空串（空=恢复主题默认），非法返回 null
            fun colorOf(k: String): String? {
                val v = c[k]?.jsonPrimitive?.contentOrNull ?: ""
                return if (v.isEmpty() || v.matches(Regex("^#[0-9a-fA-F]{6}$"))) v.lowercase() else null
            }
            val chatBg = colorOf("chatBg") ?: return errorResponse("chatBg 颜色格式非法")
            val chatBar = colorOf("chatBar") ?: return errorResponse("chatBar 颜色格式非法")
            val userMsg = colorOf("userMsg") ?: return errorResponse("userMsg 颜色格式非法")
            if (fontScale !in 1..6) return errorResponse("fontScale 越界")
            if (themePref.isNotEmpty() && themePref !in setOf("light", "dark")) {
                return errorResponse("themePref 非法")
            }
            buildJsonObject {
                put("fontScale", fontScale)
                put("themePref", themePref)
                put("chatBg", chatBg)
                put("chatBar", chatBar)
                put("userMsg", userMsg)
            }.toString()
        } catch (e: Exception) {
            return errorResponse("appearanceSave 参数解析失败: ${e.message}")
        }
        try {
            com.intellij.ide.util.PropertiesComponent.getInstance()
                .setValue(ZCodeAppearanceStore.KEY_APPEARANCE, cfg)
            log.info("Appearance settings saved")
            broadcastAppearance(cfg)
        } catch (e: Exception) {
            log.warn("Appearance settings save failed: ${e.message}")
        }
        return buildJsonObject { put("op", "appearanceSave") }
    }

    /**
     * 外观配置广播到所有已开标签（保存后调用）。
     * JCEF 多 browser 间 storage 事件不派发，其他已开标签无法感知 localStorage 变更——
     * 统一由本方法推送 onAppearanceChanged（前端 appearance.ts 注册，幂等应用）。
     * 懒加载标签 JCEF 未创建时跳过（首次加载时注入的 __ZCODE_APPEARANCE__ 已是最新值）。
     * 同时通知共享浏览器分栏按新生效主题重着色（工具栏/地址栏/欢迎页）。
     */
    private fun broadcastAppearance(cfgJson: String) {
        SwingUtilities.invokeLater {
            activePanels.forEach { panel ->
                try {
                    if (panel.disposed || !panel::jbCefBrowser.isInitialized) return@forEach
                    panel.jbCefBrowser.cefBrowser.executeJavaScript(
                        "window.onAppearanceChanged && window.onAppearanceChanged($cfgJson);",
                        "zcode-appearance-sync", 0
                    )
                } catch (e: Exception) {
                    log.warn("Appearance sync push failed (tab sessionId=${panel.currentSessionId}): ${e.message}")
                }
            }
            try {
                project.zCodeService().getSharedBrowserPanel()?.onAppearanceThemeChanged()
            } catch (_: Exception) {}
        }
    }

    /**
     * 保存 webview 通用 kv（Application 级 PropertiesComponent，string→string map）。
     * 增量语义（2026-08-17 修复重装清空事故）：entries upsert 合并进现有 kvstore，
     * deletes 显式删除——不再整体覆盖。旧版"全量覆盖"在 localStorage 为空（重装/新
     * origin/注入未达）时会用空快照冲掉存量输入历史等全部数据。
     * 限量防护：合并后条目 ≤500、总量 ≤512KB，超限拒绝。
     */
    private fun handleKvSave(msg: JsonObject): JsonObject {
        val entries = try {
            msg["entries"]?.jsonObject ?: return errorResponse("kvSave 缺少 entries")
        } catch (e: Exception) {
            return errorResponse("kvSave entries 解析失败: ${e.message}")
        }
        val deletes = try {
            (msg["deletes"] as? JsonArray)
                ?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
                ?: emptyList()
        } catch (e: Exception) {
            return errorResponse("kvSave deletes 解析失败: ${e.message}")
        }
        if (entries.size > 500) return errorResponse("kvSave 条目过多（${entries.size} > 500）")
        // 值必须是纯字符串（前端约定），且校验前缀域
        val upserts = HashMap<String, String>(entries.size)
        entries.forEach { (k, v) ->
            val sv = (v as? JsonPrimitive)?.takeIf { it.isString }?.content
                ?: return errorResponse("kvSave 值非字符串: $k")
            if (!k.startsWith("zcode.") && !k.startsWith("zcode-")) {
                return errorResponse("kvSave key 越域: $k")
            }
            if (sv.length > 64 * 1024) return errorResponse("kvSave 单值过大: $k")
            upserts[k] = sv
        }
        deletes.forEach { k ->
            if (!k.startsWith("zcode.") && !k.startsWith("zcode-")) {
                return errorResponse("kvSave deletes key 越域: $k")
            }
        }
        try {
            // 读取现有 kvstore 合并（upsert + delete），失败/无配置按空 map 起步
            val existing = readKvJson()?.let {
                try { Json.parseToJsonElement(it).jsonObject } catch (_: Exception) { null }
            } ?: JsonObject(emptyMap())
            val merged = LinkedHashMap<String, kotlinx.serialization.json.JsonElement>(existing.size + upserts.size)
            merged.putAll(existing)
            upserts.forEach { (k, v) -> merged[k] = JsonPrimitive(v) }
            deletes.forEach { merged.remove(it) }
            if (merged.size > 500) return errorResponse("kvSave 合并后条目过多（${merged.size} > 500）")
            val total = merged.entries.sumOf { it.key.length + ((it.value as? JsonPrimitive)?.content?.length ?: 0) }
            if (total > 512 * 1024) return errorResponse("kvSave 总量过大（$total B）")
            com.intellij.ide.util.PropertiesComponent.getInstance()
                .setValue(ZCodeLanguageService.KEY_WEBVIEW_KV, JsonObject(merged).toString())
            // 语言选择变化：重算生效语言并广播所有已开标签（JCEF 多 browser 间 storage 事件不派发，
            // 同 broadcastAppearance；本标签经 kvSave 前端已自行切换，再推一次幂等无害）
            if (ZCodeLanguageService.KV_KEY_LANGUAGE in upserts.keys || ZCodeLanguageService.KV_KEY_LANGUAGE in deletes) {
                broadcastLanguage(ZCodeLanguageService.currentLanguage())
            }
        } catch (e: Exception) {
            log.warn("webview kv save failed: ${e.message}")
        }
        return buildJsonObject { put("op", "kvSave") }
    }

    // ============ 运行环境检测与配置（参考 cc-gui NodePathHandler）============

    /** 环境三件套状态查询。显式检测一律 force 强刷（用户点「重新检测」期待最新磁盘
     *  状态，吃 30s 缓存会出现"禁用渠道后检测仍正常、过一会才变缺失"的延迟假象；
     *  spawn node --version 的探测成本仅在显式点击时发生，可接受）*/
    private fun handleCheckEnv(): JsonObject {
        var status = com.zcode.ideaplugin.env.ZCodeEnvChecker.check(force = true)
        // browserHost 非阻断告警的轻量自愈：仅 handlerMissing 可修（补注册后立即复测）。
        // cefDown 不做运行期自愈：探针报 cefDown 的前提是 JBCefApp 已起，此时杀
        // cef_server 会弄死现有 webview（restartStaleCefServerIfNeeded 的守卫即为此返回），
        // 自愈只可能在 Factory 面板创建前那条路径生效——运行期只能指引用户重启 IDE（文案）。
        if (status.browserHost?.ok == false &&
            status.browserHost?.code == com.zcode.ideaplugin.env.BrowserHostStatus.CODE_HANDLER_MISSING
        ) {
            try {
                project.zCodeService().ensureBrowserExecutor()
            } catch (e: Exception) {
                log.warn("[envCheck] host handler re-registration failed: ${e.message}")
            }
            status = com.zcode.ideaplugin.env.ZCodeEnvChecker.check(force = true)
        }
        return buildJsonObject {
            put("op", "envStatus")
            put("status", com.zcode.ideaplugin.env.ZCodeEnvChecker.statusJson(status))
        }
    }

    /** 环境校验失败响应：error 消息 + 当前 envStatus（前端刷新提醒条） */
    private fun envErrorResponse(msg: String): JsonObject = buildJsonObject {
        put("op", "error")
        put("message", msg)
        put("envStatus", com.zcode.ideaplugin.env.ZCodeEnvChecker.statusJson(
            com.zcode.ideaplugin.env.ZCodeEnvChecker.check()
        ))
    }

    /**
     * 保存环境路径配置（node / zcode.cjs）。
     * 字段缺席 = 不改该项；空串 = 清除该配置（回退自动探测）。
     * 保存前验证（node spawn --version + 版本下限；cli 文件存在），
     * 验证失败不落盘（cc-gui 同策略，防缓存无效路径）。
     * 保存成功后杀掉旧 app-server（启动参数已变），下次 getClient 按新配置拉起——
     * 会话在服务端侧存续，前端 subscribe/发送会触发重连恢复。
     */
    private fun handleEnvSave(msg: JsonObject): JsonObject {
        val hasNode = "nodePath" in msg.keys
        val hasCli = "cliPath" in msg.keys
        if (!hasNode && !hasCli) return errorResponse("envSave 缺少 nodePath/cliPath")
        val nodePath = msg["nodePath"]?.jsonPrimitive?.contentOrNull?.trim() ?: ""
        val cliPath = msg["cliPath"]?.jsonPrimitive?.contentOrNull?.trim() ?: ""

        // 先全部验证，全通过才落盘（避免半更新）
        if (hasNode && nodePath.isNotEmpty()) {
            val probe = com.zcode.ideaplugin.env.ZCodeEnvChecker.verifyNodePath(nodePath)
            if (!probe.found) {
                return envErrorResponse("Node.js 路径无效：${probe.error ?: "无法执行"}，未保存")
            }
            val major = com.zcode.ideaplugin.env.ZCodeEnvChecker.parseMajorVersion(probe.version)
            if (major != null && major < com.zcode.ideaplugin.env.ZCodeEnvChecker.MIN_NODE_MAJOR_VERSION) {
                return envErrorResponse(
                    "Node.js 版本过低（${probe.version}，需要 v${com.zcode.ideaplugin.env.ZCodeEnvChecker.MIN_NODE_MAJOR_VERSION}+），未保存"
                )
            }
        }
        if (hasCli && cliPath.isNotEmpty()) {
            val probe = com.zcode.ideaplugin.env.ZCodeEnvChecker.verifyCliPath(cliPath)
            if (!probe.found) {
                return envErrorResponse("zcode.cjs 路径无效：${probe.error}，未保存")
            }
        }

        if (hasNode) {
            if (nodePath.isEmpty()) com.zcode.ideaplugin.env.ZCodeEnvChecker.clearNodePath()
            else com.zcode.ideaplugin.env.ZCodeEnvChecker.saveNodePath(nodePath)
        }
        if (hasCli) {
            if (cliPath.isEmpty()) com.zcode.ideaplugin.env.ZCodeEnvChecker.clearCliPath()
            else com.zcode.ideaplugin.env.ZCodeEnvChecker.saveCliPath(cliPath)
        }
        com.zcode.ideaplugin.env.ZCodeEnvChecker.invalidate()

        try { project.zCodeService().shutdown() } catch (e: Exception) {
            log.warn("Failed to close old app-server after env config change: ${e.message}")
        }
        // 旧进程上的订阅与全局监听器全部作废（含其他标签），下次 subscribe 重新走完整注册
        activePanels.forEach { it.resetSubscriptionState() }

        val status = com.zcode.ideaplugin.env.ZCodeEnvChecker.check(force = true)
        broadcastEnvStatus(status)
        log.info("Env config saved and re-checked: allOk=${status.allOk}, node=${status.node.path}, cli=${status.cli.path}")
        return buildJsonObject {
            put("op", "envStatus")
            put("status", com.zcode.ideaplugin.env.ZCodeEnvChecker.statusJson(status))
        }
    }

    /**
     * 环境状态广播到所有已开标签（envSave 后调用，同 broadcastAppearance 模式）：
     * 推送 onEnvStatusChanged（前端 store 注册，幂等刷新 envStatus）。
     */
    private fun broadcastEnvStatus(status: com.zcode.ideaplugin.env.EnvStatus) {
        val json = com.zcode.ideaplugin.env.ZCodeEnvChecker.statusJson(status).toString()
        SwingUtilities.invokeLater {
            activePanels.forEach { panel ->
                try {
                    if (panel.disposed || !panel::jbCefBrowser.isInitialized) return@forEach
                    panel.jbCefBrowser.cefBrowser.executeJavaScript(
                        "window.onEnvStatusChanged && window.onEnvStatusChanged($json);",
                        "zcode-env-sync", 0
                    )
                } catch (e: Exception) {
                    log.warn("Env status sync push failed: ${e.message}")
                }
            }
        }
    }

    /**
     * 语言变更广播到所有已开标签（语言切换保存后调用）：
     * 推送 onLanguageChanged（前端 i18n/language.ts 注册，幂等 changeLanguage）。
     * 懒加载标签 JCEF 未创建时跳过（首次加载时注入的 __ZCODE_LANGUAGE__ 已是最新值）。
     */
    private fun broadcastLanguage(lang: String) {
        SwingUtilities.invokeLater {
            activePanels.forEach { panel ->
                try {
                    if (panel.disposed || !panel::jbCefBrowser.isInitialized) return@forEach
                    panel.jbCefBrowser.cefBrowser.executeJavaScript(
                        "window.onLanguageChanged && window.onLanguageChanged('$lang');",
                        "zcode-language-sync", 0
                    )
                } catch (e: Exception) {
                    log.warn("Language sync push failed (tab sessionId=${panel.currentSessionId}): ${e.message}")
                }
            }
        }
    }

    /** 更新标签 displayName：baseTitle + 生成中后缀（EDT）*/
    private fun applyTabDisplayName() {
        val content = attachedContent ?: return
        val display = if (tabStreaming) "$baseTabTitle ●" else baseTabTitle
        SwingUtilities.invokeLater {
            if (!disposed) content.displayName = display
        }
    }

    /** 本标签生成中状态变化（turn.started/completed/failed 驱动）*/
    private fun setTabStreaming(active: Boolean) {
        if (tabStreaming == active) return
        tabStreaming = active
        applyTabDisplayName()
    }

    /** 本标签当前会话是否生成中（关闭二次确认的提示增强用）*/
    fun isTabStreaming(): Boolean = tabStreaming

    /** 本面板状态变化后同步 TabState（订阅会话/标题变化）*/
    private fun persistSelfTabState() {
        val content = attachedContent ?: return
        SwingUtilities.invokeLater {
            if (disposed) return@invokeLater
            val cm = content.manager ?: return@invokeLater
            ZCodeToolWindowFactory.persistTabs(project, cm)
        }
    }

    /**
     * 显示会话内嵌浏览器分栏（EDT；幂等——已显示/已创建均复用）。
     * 浏览器是**全局共享单例**（协议单一 idea-iab，跨会话标签）：
     * 已挂在他处且展开中 → 迁移过来（宽度延续，不重新拉宽）；
     * 收起状态 → 重新挂载并 stretch。
     * 任何挂载前都先从旧 owner 摘除（Swing 单父语义：不摘会留下空壳 splitter）。
     * ZCodeBrowserExecutor.ensureBrowserPanel 优先调用本方法（AI 同屏观察）。
     */
    fun showEmbeddedBrowser(): ZCodeBrowserPanel? {
        if (disposed || !::jbCefBrowser.isInitialized || !JBCefApp.isSupported()) return null
        if (!SwingUtilities.isEventDispatchThread()) {
            SwingUtilities.invokeLater { showEmbeddedBrowser() }
            return null
        }
        val service = project.zCodeService()
        // 已挂在自己这（展开中）：直接复用
        if (embeddedSplit != null) {
            embeddedBrowser?.let { return it }
        }
        val panel = embeddedBrowser ?: service.getOrCreateSharedBrowserPanel() ?: return null
        // 他处展开中：摘除迁移（返回摘除前浏览器宽，>0 表示迁移；-1 表示收起/未挂载）。
        // owner 面板销毁时已把 owner 清 null，这里的 owner 必然活着
        val owner = service.getEmbeddedBrowserOwner()
        val migrateWidth = if (owner != null && owner !== this) {
            owner.detachEmbeddedBrowserInternal()
        } else {
            -1
        }
        embeddedBrowser = panel
        service.setEmbeddedBrowserOwner(this)
        attachEmbeddedSplit(panel, stretch = migrateWidth <= 0, migrateBrowserWidth = migrateWidth)
        log.info("In-chat browser pane shown (${if (migrateWidth > 0) "migrated from another tab, browser width=$migrateWidth" else "new mount/re-expand"})")
        return panel
    }

    /**
     * 内嵌浏览器全局展开时迁移挂载到自己（标签切换跟随；收起状态不动）。
     * Factory 的 selectionChanged 调用——修复「切到新标签主界面独占被拉宽的 TW」。
     */
    fun adoptEmbeddedBrowserIfDisplayed() {
        if (!SwingUtilities.isEventDispatchThread()) {
            SwingUtilities.invokeLater { adoptEmbeddedBrowserIfDisplayed() }
            return
        }
        if (disposed || !::jbCefBrowser.isInitialized) return
        val service = project.zCodeService()
        val owner = service.getEmbeddedBrowserOwner() ?: return
        if (owner === this) return
        val panel = service.getSharedBrowserPanel() ?: return
        val migrateWidth = owner.detachEmbeddedBrowserInternal()
        if (migrateWidth < 0) return // 浏览器处于收起状态：不自动展开，谁需要谁 show
        embeddedBrowser = panel
        service.setEmbeddedBrowserOwner(this)
        attachEmbeddedSplit(panel, stretch = false, migrateBrowserWidth = migrateWidth)
        log.info("In-chat browser re-mounted on tab switch")
    }

    /**
     * 从本面板摘除内嵌浏览器分栏（实例与页面保留）。
     * 返回摘除前的浏览器宽（未挂载/收起状态返回 -1）；迁移与收起共用本内核。
     */
    internal fun detachEmbeddedBrowserInternal(): Int {
        val splitter = embeddedSplit ?: return -1
        if (!SwingUtilities.isEventDispatchThread()) {
            var w = -1
            SwingUtilities.invokeAndWait { w = detachEmbeddedBrowserInternal() }
            return w
        }
        val browserWidth = embeddedBrowser?.width ?: -1
        suppressWidthFollow = true // 摘除过程中的尺寸变化不再驱动总宽
        val webviewComp = jbCefBrowser.component
        remove(splitter)
        splitter.firstComponent = null // 把 webview 从 splitter 摘出再挂回
        splitter.secondComponent = null
        add(webviewComp, BorderLayout.CENTER)
        embeddedSplit = null
        revalidate()
        repaint()
        return browserWidth
    }

    private fun attachEmbeddedSplit(
        browserPanel: ZCodeBrowserPanel,
        stretch: Boolean,
        migrateBrowserWidth: Int = -1,
    ) {
        val webviewComp = jbCefBrowser.component
        remove(webviewComp)
        val splitter = com.intellij.ui.OnePixelSplitter(false, 0.55f).apply {
            firstComponent = webviewComp
            secondComponent = browserPanel
            border = JBUI.Borders.empty()
        }
        embeddedSplit = splitter
        add(splitter, BorderLayout.CENTER)
        // 拖动来源区分（见 lastKnownTwWidth 注释）：
        // - 中间分割线拖动 → 总宽不变 → 浏览器宽驱动总宽（聊天区恒定）
        // - 左侧边界拖动/主窗口缩放 → 总宽先变 → 浏览器宽度钉住、聊天区吸收变化
        //   （保留 IDE 原生整体调宽能力，不被跟随逻辑劫持）
        // 浏览器是全局单例、分栏可多次摘挂（迁移/收起再展开）：先移除旧监听防叠加
        browserWidthListener?.let { browserPanel.removeComponentListener(it) }
        val listener = object : java.awt.event.ComponentAdapter() {
            override fun componentResized(e: java.awt.event.ComponentEvent?) {
                if (embeddedSplit == null || suppressWidthFollow) return
                val browserWidth = browserPanel.width
                // 布局中间态（新挂载/跨标签迁移后组件尚未布局，width=0）：不驱动任何
                // 宽度逻辑——否则 followBrowserWidth 会按"浏览器宽 0"把 ToolWindow
                // 还原到无浏览器宽度，浏览器被挤成 0 宽（"新标签主界面独占"的根因）
                if (browserWidth <= 0) return
                val tw = ZCodeToolWindowFactory.getToolWindow(project) ?: return
                val twWidth = tw.component.width
                if (twWidth <= 0) return
                val isExternalChange = twWidth != lastKnownTwWidth && !expectOwnTwChange
                if (isExternalChange) {
                    val pinned = if (lastKnownBrowserWidth > 0) lastKnownBrowserWidth else browserWidth
                    val desiredChat = (twWidth - pinned - 1).coerceAtLeast(120)
                    embeddedSplit?.setProportion(desiredChat.toFloat() / twWidth)
                    toolWindowWidthBeforeBrowser = desiredChat
                    persistBrowserWidthState(expanded = true, base = desiredChat)
                }
                if (twWidth != lastKnownTwWidth && expectOwnTwChange) expectOwnTwChange = false
                lastKnownTwWidth = twWidth
                lastKnownBrowserWidth = browserWidth
                followBrowserWidth(browserPanel)
            }
        }
        browserWidthListener = listener
        browserPanel.addComponentListener(listener)
        lastKnownTwWidth = ZCodeToolWindowFactory.getToolWindow(project)?.component?.width ?: -1
        lastKnownBrowserWidth = -1
        suppressWidthFollow = false
        revalidate()
        repaint()
        if (stretch) {
            stretchToolWindowForBrowser(splitter)
        } else if (migrateBrowserWidth > 0) {
            // 跨标签迁移：延续浏览器宽与总宽，聊天基准 = 当前总宽 - 浏览器宽（不重新拉宽）
            val twWidth = ZCodeToolWindowFactory.getToolWindow(project)?.component?.width ?: 0
            if (twWidth > 0) {
                toolWindowWidthBeforeBrowser = (twWidth - migrateBrowserWidth - 1).coerceAtLeast(120)
                splitter.setProportion(toolWindowWidthBeforeBrowser.toFloat() / twWidth)
            }
        }
        if (toolWindowWidthBeforeBrowser > 0) {
            persistBrowserWidthState(expanded = true, base = toolWindowWidthBeforeBrowser)
        }
    }

    /**
     * 中间分割线拖动后同步 ToolWindow 总宽：总宽 = 聊天基准宽 + 浏览器当前宽。
     * 仅在总宽未变（分割线内部拖动）时触发（来源区分见 attachEmbeddedSplit）；
     * 迭代收敛（每轮 chat→基准宽），死区 4px 防像素抖动。
     */
    private fun followBrowserWidth(browserPanel: ZCodeBrowserPanel) {
        if (embeddedSplit == null || suppressWidthFollow) return
        if (toolWindowWidthBeforeBrowser <= 0) return
        val tw = ZCodeToolWindowFactory.getToolWindow(project) ?: return
        val current = tw.component.width
        val target = toolWindowWidthBeforeBrowser + browserPanel.width
        if (current > 0 && kotlin.math.abs(target - current) > 4) {
            applyToolWindowWidth(target)
        }
    }

    /**
     * 浏览器弹出时调宽 ToolWindow：聊天区保持原宽度，浏览器占增量空间；
     * 收起时 restoreToolWindowWidth 还原。
     */
    private fun stretchToolWindowForBrowser(splitter: com.intellij.ui.OnePixelSplitter) {
        val tw = ZCodeToolWindowFactory.getToolWindow(project) ?: return
        val current = tw.component.width
        if (current <= 0) return
        if (toolWindowWidthBeforeBrowser < 0) toolWindowWidthBeforeBrowser = current
        val extra = JBUI.scale(560)
        val newWidth = toolWindowWidthBeforeBrowser + extra
        splitter.setProportion(toolWindowWidthBeforeBrowser.toFloat() / newWidth.toFloat())
        applyToolWindowWidth(newWidth)
    }

    /** 还原浏览器弹出前的 ToolWindow 宽度（收起分栏时）*/
    private fun restoreToolWindowWidth() {
        if (toolWindowWidthBeforeBrowser <= 0) return
        applyToolWindowWidth(toolWindowWidthBeforeBrowser)
    }

    /** 展示/收起内嵌浏览器（Header「浏览器」按钮的开关语义）；返回收起后的可见状态 */
    fun toggleEmbeddedBrowser(): Boolean {
        if (!SwingUtilities.isEventDispatchThread()) {
            var visible = false
            SwingUtilities.invokeAndWait { visible = toggleEmbeddedBrowser() }
            return visible
        }
        if (embeddedSplit != null) {
            hideEmbeddedBrowser()
            return false
        }
        showEmbeddedBrowser()
        return true
    }

    /** 内嵌浏览器分栏当前是否展开（browser-use browserVisibilityGet 用；只读不创建）*/
    fun isEmbeddedBrowserVisible(): Boolean = embeddedSplit != null && embeddedBrowser != null

    /** 只读拿内嵌浏览器面板（已创建返回实例，未创建返回 null——不触发创建）*/
    fun embeddedBrowserPanelOrNull(): ZCodeBrowserPanel? = embeddedBrowser

    /**
     * 设置内嵌浏览器分栏可见性（browser-use browserVisibilitySet 用）；
     * 展开时顺带选中本面板所在 Content（AI 唤起时用户看得见），返回设置后的可见状态
     */
    fun setEmbeddedBrowserVisible(visible: Boolean): Boolean {
        if (!SwingUtilities.isEventDispatchThread()) {
            var result = false
            SwingUtilities.invokeAndWait { result = setEmbeddedBrowserVisible(visible) }
            return result
        }
        if (!visible) {
            hideEmbeddedBrowser()
            return false
        }
        if (showEmbeddedBrowser() == null) return false
        try {
            attachedContent?.let { c -> c.manager?.setSelectedContent(c) }
            ZCodeToolWindowFactory.getToolWindow(project)?.show(null)
        } catch (e: Exception) {
            log.warn("Failed to select session Content: ${e.message}")
        }
        return true
    }

    private fun applyToolWindowWidth(width: Int) {
        SwingUtilities.invokeLater {
            if (disposed) return@invokeLater
            try {
                val tw = ZCodeToolWindowFactory.getToolWindow(project) ?: return@invokeLater
                val twComp = tw.component
                // 2026.1 新 UI 的编辑器↔工具窗口分隔容器是 ThreeComponentsSplitter
                // （祖先链实测：InternalDecoratorImpl 的父容器），设 lastSize 即改工具窗口宽
                var p: java.awt.Container? = twComp.parent
                while (p != null) {
                    if (p is com.intellij.openapi.ui.ThreeComponentsSplitter && !p.orientation) {
                        val splitter = p as com.intellij.openapi.ui.ThreeComponentsSplitter
                        val applied = when {
                            isAncestorOf(splitter.lastComponent, twComp) -> {
                                splitter.lastSize = width.coerceAtMost(splitter.width); true
                            }
                            isAncestorOf(splitter.firstComponent, twComp) -> {
                                splitter.firstSize = width.coerceAtMost(splitter.width); true
                            }
                            else -> false
                        }
                        if (applied) expectOwnTwChange = true // 布局回声不算外部拖动
                        break
                    }
                    p = p.parent
                }
            } catch (e: Exception) {
                log.warn("ToolWindow resize failed: ${e.message}")
            }
        }
    }

    private fun isAncestorOf(candidate: java.awt.Component?, node: java.awt.Component): Boolean {
        var cur: java.awt.Component? = node
        while (cur != null) {
            if (cur === candidate) return true
            cur = cur.parent
        }
        return false
    }

    /**
     * 收起内嵌浏览器（保留实例与页面，工具条「收起」按钮/Header 开关/AI visibilitySet 用）。
     * internal：Service 的全局浏览器 onClose 回调也会调（作用于当前挂载 owner）。
     */
    internal fun hideEmbeddedBrowser() {
        if (!SwingUtilities.isEventDispatchThread()) {
            SwingUtilities.invokeLater { hideEmbeddedBrowser() }
            return
        }
        if (detachEmbeddedBrowserInternal() < 0) return
        restoreToolWindowWidth()
        persistBrowserWidthState(expanded = false, base = toolWindowWidthBeforeBrowser)
        log.info("In-chat browser pane collapsed (instance kept, ToolWindow width restored)")
    }

    /** Content 销毁时释放 JCEF 资源（content.setDisposer(panel) 绑定）*/
    override fun dispose() {
        if (disposed) return
        disposed = true
        activePanels.remove(this)
        log.info("Releasing tab panel (sessionId=$currentSessionId)")
        // 摘掉挂在协议客户端上的全局流式监听器：杀进程是异步的，竞态窗口内残留
        // 监听器会继续把事件推向本面板已释放的 JCEF。只从记录过的 client 上摘
        // （不能调 getClient——那会为项目再拉起新 app-server）
        try {
            globalStreamListener?.let { l -> globalStreamListenerClient?.removeGlobalEventListener(l) }
        } catch (_: Exception) {}
        globalStreamListener = null
        globalStreamListenerClient = null
        // 忙窗口重试随面板释放终止（daemon 线程兜底，仍显式停）
        try {
            busyRetry.shutdown()
        } catch (_: Exception) {}
        try {
            // 内嵌浏览器是全局共享单例：只摘除挂载（还原 TW 宽度），实例交由 Service 释放
            if (embeddedSplit != null) {
                detachEmbeddedBrowserInternal()
                restoreToolWindowWidth()
            }
            val service = project.zCodeService()
            if (service.getEmbeddedBrowserOwner() === this) {
                service.setEmbeddedBrowserOwner(null)
            }
        } catch (e: Exception) {
            log.warn("Failed to unmount in-chat browser: ${e.message}")
        }
        embeddedBrowser = null
        embeddedSplit = null
        try {
            themeBusConn?.dispose()
        } catch (e: Exception) {
            log.warn("Failed to disconnect theme listener: ${e.message}")
        }
        try {
            // DropTarget 解绑：AWT 公开 API 没有 removeComponent，
            // 标准做法是置 null 释放引用，让 AWT 在 component dispose 时通过 removeNotify 自动清理 listener 闭包
            // （JBR / JCEF 释放 jbCefBrowser 走 Disposer.dispose 会触发 component.removeNotify）
            fileDropTarget = null
        } catch (e: Exception) {
            log.warn("Failed to release file drop target: ${e.message}")
        }
        try {
            if (::jsQuery.isInitialized) Disposer.dispose(jsQuery)
        } catch (e: Exception) {
            log.warn("Failed to release jsQuery: ${e.message}")
        }
        try {
            if (::jbCefBrowser.isInitialized) Disposer.dispose(jbCefBrowser)
        } catch (e: Exception) {
            log.warn("Failed to release JCEF browser: ${e.message}")
        }
    }

    /**
     * 公开入口：从 IDE 外部（右键菜单等，经 ZCodeService）推送消息到前端。
     * 与内部 sendToJs 同链路（invokeLater + executeJavaScript）。
     */
    fun pushToWebview(msg: JsonObject) {
        sendToJs(msg)
    }

    /** Java → JS：把消息推给前端 */
    private fun sendToJs(msg: JsonObject) {
        // 懒加载标签未激活（JCEF 未创建）：丢弃推送，激活后前端 subscribe 拉全量恢复
        if (!::jbCefBrowser.isInitialized) {
            log.info("sendToJs skipped (JCEF not created, lazy tab not active) op=${msg["op"]?.jsonPrimitive?.content}")
            return
        }
        val jsonStr = Json.encodeToString(JsonObject.serializer(), msg)
        // 每条消息推送都走这里，流式期间高频：debug 级防 log 风暴
        log.debug("sendToJs dispatch: length=${jsonStr.length}, preview=${LogRedactor.redact(jsonStr.take(600)).take(80)}")
        // 用 JSON.parse 传字符串，避免转义地狱
        // 关键：executeJavaScript 的 JS 代码里，我们构造一个 JS 字符串字面量
        // 用 JSON.stringify 风格转义（双引号字符串）
        val escapedForJs = jsonStr
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\t", "\\t")
            .replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029")
        val js = "try { var __m = JSON.parse(\"$escapedForJs\"); window.zcodeBridge.onMessage(__m); } catch(e) { document.getElementById('status').innerHTML = '<span style=\"color:#f44\">SEND ERR: ' + e.message + '</span>'; }"
        SwingUtilities.invokeLater {
            try {
                jbCefBrowser.cefBrowser.executeJavaScript(js, "about:blank", 0)
                log.info("sendToJs executeJavaScript succeeded")
            } catch (e: Exception) {
                log.warn("sendToJs failed (JCEF may not be ready): ${e.message}")
            }
        }
    }

    private fun handleListSessions(msg: JsonObject): JsonObject {
        log.info("Fetching session list")
        val service = project.zCodeService()
        log.info("ZCodeService acquired: ${service.javaClass.name}")
        val client = service.getClient()
        log.info("ZCodeProtocolClient acquired, isAlive=${client.isAlive()}")

        // workspace 过滤：只显示当前项目的会话（差异化优势，cc-gui 不做）
        // 前端传 workspacePath；空串/未传回退 project.basePath（重启初期前端注入值可能为空）
        val workspacePath = effectiveWorkspacePath(msg)
        // 服务端过滤（按项目 + 大 limit），避免 app-server 默认"全库最新 50 条"截断；
        // 客户端 normalizePath 过滤保留作兜底
        val sessions = if (workspacePath.isEmpty()) {
            client.listSessions()
        } else {
            client.listSessions(workspacePath)
        }
        log.info("listSessions(workspace=$workspacePath) returned ${sessions.size} session(s)")

        // 子代理子会话不进历史列表：session/list 的 DB 查询（roots=true）排除
        // subagent_child，但内存活跃会话补列不排——子代理回合结束后仍驻留 app-server
        // 内存时，每次列表请求都被补列进响应（IDEA 重启杀进程才消失），按 id 前缀过滤
        val listed = sessions.filter { !it.sessionId.startsWith("sess_subagent") }

        val filtered = if (workspacePath.isEmpty()) {
            listed
        } else {
            val normalized = normalizePath(workspacePath)
            listed.filter { s ->
                val ws = s.workspace?.workspacePath
                ws != null && normalizePath(ws) == normalized
            }
        }

        // 归档/软删过滤（ZCode 客户端同源 tasks-index；task_id=会话 id 全局唯一，直接按 id 隐）。
        // schema 不兼容时 listTasks 内部 fail-soft 返回空列表（不过滤，宁多显示不漏显示）
        val hiddenIds = client.taskIndex.listTasks()
            .filter { it.archived || it.deleted }
            .map { it.taskId }
            .toSet()
        val visible = if (hiddenIds.isEmpty()) filtered else filtered.filter { it.sessionId !in hiddenIds }
        log.info("workspace=$workspacePath filtered to ${filtered.size} session(s), ${filtered.size - visible.size} hidden by tasks-index")

        // 会话统计（消息数/内容大小，直读 db.sqlite；失败内部已降级空 map，字段缺省前端不显示）
        val stats: Map<String, SessionStat> = client.getSessionStats()

        val sessionsJson = JsonArray(visible.map { buildSessionJson(it, stats) })
        return buildJsonObject {
            put("op", "listSessions")
            put("sessions", sessionsJson)
        }
    }

    /**
     * 解析本次请求生效的 workspacePath：前端值非空白优先，否则回退 project.basePath。
     * 必须防"空串"（不只是 null）——IDE 重启初期面板可能先于 project.basePath 就绪创建，
     * 注入前端的 __ZCODE_WORKSPACE__ 是空串，后续 createSession 等带空路径会被
     * app-server 以 -32602 拒绝（Mac/Windows 均复现过）。
     */
    private fun effectiveWorkspacePath(msg: JsonObject): String {
        val requested = msg["workspacePath"]?.jsonPrimitive?.contentOrNull
        if (!requested.isNullOrBlank()) return requested
        return project.basePath ?: System.getProperty("user.dir") ?: ""
    }

    private fun handleCreateSession(msg: JsonObject): JsonObject {
        val workspacePath = effectiveWorkspacePath(msg)
        val client = project.zCodeService().getClient()
        val sid = client.createSession(
            com.zcode.ideaplugin.protocol.model.Workspace(workspacePath),
            com.zcode.ideaplugin.protocol.model.PermissionMode.YOLO
        )
        return buildJsonObject {
            put("op", "createSession")
            put("sessionId", sid)
        }
    }

    /** session/close — 删除会话 */
    private fun handleDeleteSession(msg: JsonObject): JsonObject {
        val sessionId = msg["sessionId"]?.jsonPrimitive?.content
            ?: return errorResponse("缺少 sessionId")
        val client = project.zCodeService().getClient()
        try {
            client.closeSession(sessionId)
            log.info("Session deleted: $sessionId")
        } catch (e: Exception) {
            log.warn("Session delete failed: ${e.message}")
            return errorResponse("删除失败: ${e.message}")
        }
        // 从已 subscribe 集合中移除
        subscribedSessions.remove(sessionId)
        // 会话删除：连带丢弃其全部待发定时消息（对齐 webview 侧清理）
        ZCodeScheduledMessageService.getInstance(project).dropForSession(sessionId)
        return buildJsonObject {
            put("op", "sessionDeleted")
            put("sessionId", sessionId)
        }
    }

    /** 归档会话（写 ZCode 客户端任务索引 tasks.archived=1，两端列表一致，可恢复）*/
    private fun handleArchiveSession(msg: JsonObject): JsonObject {
        val sessionId = msg["sessionId"]?.jsonPrimitive?.content
            ?: return errorResponse("缺少 sessionId")
        val client = project.zCodeService().getClient()
        try {
            client.archiveSession(sessionId)
            log.info("Session archived: $sessionId")
        } catch (e: Exception) {
            log.warn("Session archive failed: ${e.message}")
            return errorResponse("归档失败: ${e.message}")
        }
        // 归档=用户把会话收起：待发定时消息一并丢弃（到点给归档会话发消息属惊吓行为）
        ZCodeScheduledMessageService.getInstance(project).dropForSession(sessionId)
        return buildJsonObject {
            put("op", "sessionArchived")
            put("sessionId", sessionId)
        }
    }

    // ============ 定时消息（ZCodeScheduledMessageService 的 webview op 入口） ============

    private fun scheduledService() = ZCodeScheduledMessageService.getInstance(project)

    private fun handleScheduledCreate(msg: JsonObject): JsonObject {
        val sessionId = msg["sessionId"]?.jsonPrimitive?.content
            ?: return errorResponse("缺少 sessionId")
        val text = msg["text"]?.jsonPrimitive?.content
            ?: return errorResponse("缺少 text")
        val fireAt = msg["fireAt"]?.jsonPrimitive?.longOrNull
            ?: return errorResponse("缺少 fireAt")
        val workspacePath = effectiveWorkspacePath(msg)
        val providerId = msg["providerId"]?.jsonPrimitive?.contentOrNull
        val modelId = msg["modelId"]?.jsonPrimitive?.contentOrNull
        val item = scheduledService().create(sessionId, workspacePath, text, fireAt, providerId, modelId)
            ?: return errorResponse("定时消息创建失败（参数不完整）")
        return buildJsonObject {
            put("op", "scheduledCreated")
            put("id", item.id)
        }
    }

    private fun handleScheduledReschedule(msg: JsonObject): JsonObject {
        val id = msg["id"]?.jsonPrimitive?.content ?: return errorResponse("缺少 id")
        val fireAt = msg["fireAt"]?.jsonPrimitive?.longOrNull ?: return errorResponse("缺少 fireAt")
        val text = msg["text"]?.jsonPrimitive?.contentOrNull
        // modelId 字段存在=更新执行模型（空串=清空改回跟随会话）；不存在=保持不变
        val updateModel = msg.containsKey("modelId")
        val providerId = msg["providerId"]?.jsonPrimitive?.contentOrNull
        val modelId = msg["modelId"]?.jsonPrimitive?.contentOrNull
        scheduledService().reschedule(id, fireAt, text, providerId, modelId, updateModel)
        return ackOp("scheduledRescheduled")
    }

    /** cancel / sendNow：只需 id 的简单操作。均幂等：项不存在/已处理按成功应答——
     *  webview 乐观移除先行时 Java 侧可能已无此项，报错横幅只会误导用户 */
    private fun handleScheduledOpSimple(msg: JsonObject, action: String): JsonObject {
        val id = msg["id"]?.jsonPrimitive?.content ?: return errorResponse("缺少 id")
        when (action) {
            "cancel" -> scheduledService().cancel(id)
            "sendNow" -> scheduledService().sendNow(id)
        }
        return ackOp("scheduled${action.replaceFirstChar { it.uppercase() }}Done")
    }

    private fun handleScheduledRequeue(msg: JsonObject): JsonObject {
        val sessionId = msg["sessionId"]?.jsonPrimitive?.content
            ?: return errorResponse("缺少 sessionId")
        val text = msg["text"]?.jsonPrimitive?.content
            ?: return errorResponse("缺少 text")
        val fireAt = msg["fireAt"]?.jsonPrimitive?.longOrNull ?: 0L
        val providerId = msg["providerId"]?.jsonPrimitive?.contentOrNull
        val modelId = msg["modelId"]?.jsonPrimitive?.contentOrNull
        scheduledService().requeueOnSessionLeave(sessionId, effectiveWorkspacePath(msg), text, fireAt, providerId, modelId)
        return ackOp("scheduledRequeued")
    }

    private fun handleScheduledListRequest(): JsonObject {
        scheduledService().pushListTo(this)
        return ackOp("scheduledListServed")
    }

    private fun handleScheduledDueAck(msg: JsonObject): JsonObject {
        val id = msg["id"]?.jsonPrimitive?.content ?: return errorResponse("缺少 id")
        scheduledService().onDueAck(id)
        return ackOp("scheduledDueAcked")
    }

    private fun handleScheduledFired(msg: JsonObject): JsonObject {
        val sessionId = msg["sessionId"]?.jsonPrimitive?.content ?: return errorResponse("缺少 sessionId")
        val text = msg["text"]?.jsonPrimitive?.content ?: return errorResponse("缺少 text")
        val fireAt = msg["fireAt"]?.jsonPrimitive?.longOrNull ?: return errorResponse("缺少 fireAt")
        scheduledService().onFiredReport(sessionId, text, fireAt)
        return ackOp("scheduledFiredRecorded")
    }

    /**
     * 任务列表跳转会话：统一 openSessionTab——已有宿主标签则激活它（含懒加载面板 ensure），
     * 没有则新建标签按 sessionId 恢复打开（与后台补发/重启恢复同路径）。
     * 绝不在发起标签内 selectSession 覆盖当前会话：覆盖会顶掉用户正在看的会话，且
     * 覆盖后宿主判定跟着漂移，再次跳转其他会话时行为混乱。
     * 例外：会话挂有待发定时任务且已不存在（空会话未落库即关 IDE），跳转只会白开死
     * 标签——转定时服务「新会话补发」执行任务（缺陷AH）。存在性判定含阻塞 RPC，放后台线程。
     */
    private fun handleGotoSession(msg: JsonObject): JsonObject {
        val sessionId = msg["sessionId"]?.jsonPrimitive?.content ?: return errorResponse("缺少 sessionId")
        com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread {
            val fellBack = try {
                ZCodeScheduledMessageService.getInstance(project).tryFallbackDeadSession(sessionId)
            } catch (e: Exception) {
                log.warn("goto dead-session fallback check failed: ${e.message}")
                false
            }
            if (fellBack || project.isDisposed) return@executeOnPooledThread
            com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) return@invokeLater
                try {
                    ZCodeToolWindowFactory.openSessionTab(project, sessionId)
                } catch (e: Exception) {
                    log.warn("Open session tab for goto failed: ${e.message}")
                }
            }
        }
        return ackOp("gotoSessionOpened")
    }

    private fun ackOp(op: String): JsonObject = buildJsonObject { put("op", op) }

    /**
     * 历史列表打开会话前的定位查询：任一标签已绑定该会话 → EDT 上激活那个宿主标签
     * （含懒加载面板 ensure）并回 found=true，发起标签只需切回聊天视图；没有任何宿主
     * 标签时回 found=false 且不产生副作用，由 webview 决定覆盖当前标签页还是新开标签。
     */
    private fun handleLocateSession(msg: JsonObject): JsonObject {
        val sessionId = msg["sessionId"]?.jsonPrimitive?.content ?: return errorResponse("缺少 sessionId")
        var found = false
        try {
            com.intellij.openapi.application.ApplicationManager.getApplication().invokeAndWait {
                if (!project.isDisposed) {
                    found = ZCodeToolWindowFactory.activateSessionTab(project, sessionId)
                }
            }
        } catch (e: Exception) {
            log.warn("Locate session tab failed: ${e.message}")
        }
        return buildJsonObject {
            put("op", "sessionTabLocated")
            put("sessionId", sessionId)
            put("found", found)
        }
    }

    /** 懒加载标签未激活（JCEF 未创建）时 webview 推送不可达，定时消息分派需降级直发 */
    fun canPushToWebview(): Boolean = ::jbCefBrowser.isInitialized

    /** 恢复归档会话（置 tasks.archived=0，客户端重启/刷新后同步可见）*/
    private fun handleRestoreSession(msg: JsonObject): JsonObject {        val sessionId = msg["sessionId"]?.jsonPrimitive?.content
            ?: return errorResponse("缺少 sessionId")
        val client = project.zCodeService().getClient()
        try {
            client.restoreSession(sessionId)
            log.info("Session restored: $sessionId")
        } catch (e: Exception) {
            log.warn("Session restore failed: ${e.message}")
            return errorResponse("恢复失败: ${e.message}")
        }
        return buildJsonObject {
            put("op", "sessionRestored")
            put("sessionId", sessionId)
        }
    }

    /** 列出已归档会话（双源合并：tasks-index 新机制 + time_archived 旧机制；含客户端归档的会话）*/
    private fun handleListArchivedSessions(msg: JsonObject): JsonObject {
        // effectiveWorkspacePath（空串回退 basePath）：冷启动桥注入竞态下前端 projectPath
        // 为空串，`?:` 不回退 → 空串落入 listArchivedSessions 的全库分支 → 跨项目归档混入
        val workspacePath = effectiveWorkspacePath(msg)
        val client = project.zCodeService().getClient()
        val sessions = if (workspacePath.isEmpty()) {
            client.listArchivedSessions()
        } else {
            client.listArchivedSessions(workspacePath)
        }
        val filtered = if (workspacePath.isEmpty()) {
            sessions
        } else {
            val normalized = normalizePath(workspacePath)
            sessions.filter { s ->
                val ws = s.workspace?.workspacePath
                ws != null && normalizePath(ws) == normalized
            }
        }
        val stats = client.getSessionStats()
        val sessionsJson = JsonArray(filtered.map { buildSessionJson(it, stats) })
        return buildJsonObject {
            put("op", "archivedSessions")
            put("sessions", sessionsJson)
        }
    }

    /** 单个会话 → 前端 JSON（handleListSessions / handleListArchivedSessions 共用）*/
    private fun buildSessionJson(s: SessionInfo, stats: Map<String, SessionStat>): JsonObject = buildJsonObject {
        put("sessionId", s.sessionId)
        put("title", s.title)
        put("status", s.status)
        put("mode", s.mode)
        put("workspacePath", s.workspace?.workspacePath ?: "")
        put("workspaceKey", s.workspace?.workspaceKey ?: "")
        put("createdAt", s.createdAt)
        put("updatedAt", s.updatedAt)
        s.archivedAt?.takeIf { it > 0 }?.let { put("archivedAt", it) }
        stats[s.sessionId]?.let { st ->
            put("messageCount", st.messageCount)
            put("sizeBytes", st.sizeBytes)
        }
    }

    /**
     * 内置套餐类型（UI 徽章用）：两个内置套餐显示名相同（BigModel - Coding Plan），
     * 靠 providerId 区分——coding-plan=个人套餐、start-plan=体验套餐。
     */
    private fun builtinPlanOf(providerId: String): String? = when (providerId) {
        "builtin:bigmodel-coding-plan" -> "personal"
        "builtin:bigmodel-start-plan" -> "trial"
        else -> null
    }

    /** op=listModels — 读取 config.json 的 provider 注册表，返回可切换的模型列表 */
    private fun handleListModels(msg: JsonObject): JsonObject {
        // 路径跟随 dataBaseDir 迁移（setting.json 重定向后旧位置是冻结快照），与环境检测同一来源
        val configFile = Credentials.defaultConfigPath().toFile()
        if (!configFile.exists()) {
            log.warn("config.json not found: $configFile")
            return buildJsonObject {
                put("op", "models")
                put("models", JsonArray(emptyList()))
            }
        }
        val providers = try {
            json.parseToJsonElement(configFile.readText()).jsonObject["provider"]?.jsonObject
        } catch (e: Exception) {
            log.warn("Failed to parse config.json: ${e.message}")
            null
        } ?: return buildJsonObject {
            put("op", "models")
            put("models", JsonArray(emptyList()))
        }

        // activeBuiltin 来自 Credentials.builtinResolution：体验套餐(zcode-plan 网关)
        // 渠道在解析层整体排除——客户端选中它时自动兜底首个非门控内置（个人套餐/
        // API Key），模型列表/模型管理/额度/启动凭证全部跟随真实使用的兜底渠道
        val activeBuiltin = Credentials.effectiveBuiltinProviderId()
        val models = JsonArray(providers.mapNotNull { (providerId, providerEl) ->
            val pv = providerEl.jsonObject
            // enabled 缺省视为启用（config.json 现状：DeepSeek 无 enabled 字段但已启用）
            val enabled = pv["enabled"]?.jsonPrimitive?.content?.toBoolean() ?: true
            // 内置渠道只展示一个：selectedKey 权威 + config 兜底（effectiveBuiltinProviderId，
            // 解析失败/前缀变种时退首个 enabled 且凭证可用的内置），enabled 不代表激活
            // ——API Key 渠道与订阅套餐可同时 enabled=true，全放出来会模型重复两份
            if (providerId.startsWith("builtin:") && providerId != activeBuiltin) return@mapNotNull null
            if (!enabled) return@mapNotNull null
            val options = pv["options"]?.jsonObject ?: return@mapNotNull null
            val baseURL = options["baseURL"]?.jsonPrimitive?.content ?: return@mapNotNull null
            // 体验套餐(zcode-plan 网关)渠道整体不进聊天可选列表（滑块人机验证插件无法
            // 代答，见 handleSetModel 入口拦截）；设置页模型管理不受此限（可见性信息）
            if (com.zcode.ideaplugin.protocol.RuntimeModels.isCaptchaGatedBaseUrl(baseURL)) return@mapNotNull null
            // apiKey 缺失的过滤对第三方与 API Key 渠道生效，仅订阅制套餐（两家
            // coding-plan）凭 credentials.json 家族 token 兜底（调用期凭证由 oauth
            // 解析，未来 key 不落盘时保住模型列表）；builtin:bigmodel/zai 等 API Key
            // 渠道无 oauth 凭证链，空 key = 未配置，不兜底——否则列表显示可用而
            // 凭据自检报无凭证，自相矛盾；GUI 残留未完成 provider 无 baseURL/models，
            // 前置判据已拦
            val apiKey = options["apiKey"]?.jsonPrimitive?.contentOrNull
            if (apiKey.isNullOrBlank() && !Credentials.hasFamilyOAuthToken(providerId)) return@mapNotNull null
            val providerName = pv["name"]?.jsonPrimitive?.content ?: providerId
            val modelsObj = pv["models"]?.jsonObject ?: return@mapNotNull null
            modelsObj.mapNotNull { (modelId, modelEl) ->
                val modelObj = modelEl.jsonObject
                val modelName = modelObj["name"]?.jsonPrimitive?.content ?: modelId
                // limit.context / limit.output：模型真实上下文窗口与最大输出（config.json）
                // 例：GLM-5.2 context=1000000 / GLM-5-Turbo context=204800
                val limit = modelObj["limit"]?.jsonObject
                // modalities.input 能力位（zcode.cjs supportsImages 判定源）：
                // GLM 套餐仅 ["text"] → 粘贴图片会被服务端剥离成文字占位（模型看不到图），
                // 前端据此在用户带图发送时提示（2026-08-26 实测定性）
                val inputKinds = (modelObj["modalities"]?.jsonObject?.get("input") as? JsonArray)
                    ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull } ?: emptyList()
                buildJsonObject {
                    put("providerId", providerId)
                    put("providerName", providerName)
                    builtinPlanOf(providerId)?.let { put("plan", it) }
                    put("modelId", modelId)
                    put("modelName", modelName)
                    limit?.get("context")?.jsonPrimitive?.content?.toLongOrNull()?.let { put("contextWindow", it) }
                    limit?.get("output")?.jsonPrimitive?.content?.toLongOrNull()?.let { put("maxOutput", it) }
                    if ("image" in inputKinds) put("supportsImages", true)
                }
            }
        }.flatten())
        log.info("listModels returned ${models.size} model(s) (${providers.size} provider(s))")
        return buildJsonObject {
            put("op", "models")
            put("models", models)
        }
    }

    /**
     * op=modelManageList — 设置页「模型管理」清单（支持启用/禁用切换）。
     *
     * 与 listModels（聊天切换用）的差异：不去重、不滤 disabled 的第三方 provider
     * （返回 enabled 标记供开关）；内置渠道只展示生效的那个（禁用不返回，启停
     * 以 ZCode 客户端配置为准）。共同口径：apiKey 缺失的无效 provider 一律过滤。
     * configPath 一并返回供前端展示与「打开配置文件」。
     * 路径同样走 Credentials.defaultConfigPath() 跟随 dataBaseDir 迁移。
     */
    private fun handleModelManageList(msg: JsonObject): JsonObject {
        val configPath = Credentials.defaultConfigPath()
        fun emptyResult() = buildJsonObject {
            put("op", "modelManage")
            put("configPath", configPath.toString())
            put("providers", JsonArray(emptyList()))
        }
        if (!java.nio.file.Files.isRegularFile(configPath)) {
            log.warn("config.json not found: $configPath")
            return emptyResult()
        }
        val providers = try {
            json.parseToJsonElement(configPath.toFile().readText()).jsonObject["provider"]?.jsonObject
        } catch (e: Exception) {
            log.warn("Failed to parse config.json: ${e.message}")
            null
        } ?: return emptyResult()

        val resolution = Credentials.builtinResolution()
        val activeBuiltin = resolution.providerId
        val providerArr = JsonArray(providers.mapNotNull { (providerId, providerEl) ->
            val pv = providerEl.jsonObject
            val options = pv["options"]?.jsonObject
            // apiKey 缺失的过滤对第三方与 API Key 渠道生效（仅订阅制套餐 oauth 兜底，
            // 与聊天下拉 listModels 同口径）；内置渠道只展示一个（selectedKey 权威 +
            // config 兜底，见 effectiveBuiltinProviderId）
            val apiKey = options?.get("apiKey")?.jsonPrimitive?.contentOrNull
            if (apiKey.isNullOrBlank() && !Credentials.hasFamilyOAuthToken(providerId)) return@mapNotNull null
            // enabled 缺省视为启用（与 listModels/额度查询口径一致）
            val enabled = pv["enabled"]?.jsonPrimitive?.contentOrNull?.toBoolean() ?: true
            if (providerId.startsWith("builtin:") && providerId != activeBuiltin) return@mapNotNull null
            val providerName = pv["name"]?.jsonPrimitive?.contentOrNull ?: providerId
            val baseURL = options?.get("baseURL")?.jsonPrimitive?.contentOrNull
            // 体验套餐(zcode-plan 网关)渠道在模型管理页同样不展示（滑块验证插件无法
            // 代答，插件里彻底隐形；聊天下拉已在 listModels 过滤，builtin 门控渠道
            // 也到不了这里——activeBuiltin 解析层已排除）
            if (baseURL != null &&
                com.zcode.ideaplugin.protocol.RuntimeModels.isCaptchaGatedBaseUrl(baseURL)
            ) return@mapNotNull null
            val models = JsonArray(pv["models"]?.jsonObject?.map { (modelId, modelEl) ->
                val modelObj = modelEl.jsonObject
                val modelName = modelObj["name"]?.jsonPrimitive?.contentOrNull ?: modelId
                val limit = modelObj["limit"]?.jsonObject
                // modalities.input 能力位（与 handleListModels 同口径）：设置页展示「视觉」徽章
                val inputKinds = (modelObj["modalities"]?.jsonObject?.get("input") as? JsonArray)
                    ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull } ?: emptyList()
                buildJsonObject {
                    put("modelId", modelId)
                    put("modelName", modelName)
                    if ("image" in inputKinds) put("supportsImages", true)
                    limit?.get("context")?.jsonPrimitive?.contentOrNull?.toLongOrNull()?.let { put("contextWindow", it) }
                    limit?.get("output")?.jsonPrimitive?.contentOrNull?.toLongOrNull()?.let { put("maxOutput", it) }
                }
            } ?: emptyList())
            buildJsonObject {
                put("providerId", providerId)
                put("providerName", providerName)
                builtinPlanOf(providerId)?.let { put("plan", it) }
                // 命中方式：selected = 客户端选中渠道生效；fallback = 所选渠道凭证不可用，
                // 回退 config 首个可用内置（前端据此显示徽章，兜底态提醒用户客户端选择失配）；
                // viaReason=captchaGated = 所选渠道是体验套餐被门控排除（前端换"体验套餐
                // 无法使用"专属文案，区分于凭证失效）
                if (providerId.startsWith("builtin:")) {
                    put("via", if (resolution.viaSelected) "selected" else "fallback")
                    if (!resolution.viaSelected && resolution.selectedGated) put("viaReason", "captchaGated")
                }
                put("enabled", enabled)
                baseURL?.let { put("baseURL", it) }
                put("models", models)
            }
        })
        val modelCount = providerArr.sumOf { it.jsonObject["models"]?.jsonArray?.size ?: 0 }
        log.info("modelManageList returned ${providerArr.size} provider(s) / $modelCount model(s)")
        return buildJsonObject {
            put("op", "modelManage")
            put("configPath", configPath.toString())
            put("providers", providerArr)
        }
    }

    /**
     * op=modelToggleProvider — 设置页切换 provider 启用/禁用，写回 config.json。
     *
     * 仅对第三方/自定义 provider 开放：内置渠道（builtin: 前缀）的启停以 ZCode
     * 客户端配置为准（客户端同一时间仅一个生效），插件代写 config 与客户端内存态
     * 互相覆盖极易出状态错乱（0.2.6 实测反馈），改为只读展示，切换请求直接拒绝。
     *
     * 写回策略（config.json 是含凭证的关键文件，比 cli/config.json 更谨慎）：
     * 仅改 provider.<id>.enabled 字段，其余节点 LinkedHashMap 保序原样保留；
     * 写前备份 .bak，tmp + Files.move 原子替换，失败时从备份回滚。
     * 回包 changes 携带全部实际变更项，前端按数组刷新。
     * 禁用后 CLI 下次发现生效；进行中的会话不受影响。
     */
    private fun handleModelToggleProvider(msg: JsonObject): JsonObject {
        val providerId = msg["providerId"]?.jsonPrimitive?.contentOrNull
            ?: return errorResponse("缺少 providerId")
        if (providerId.startsWith("builtin:")) {
            return errorResponse("内置渠道以 ZCode 客户端配置为准，请在客户端切换后回来刷新")
        }
        val enabled = msg["enabled"]?.jsonPrimitive?.contentOrNull?.toBooleanStrictOrNull()
            ?: return errorResponse("缺少 enabled")

        val configPath = Credentials.defaultConfigPath()
        if (!java.nio.file.Files.isRegularFile(configPath)) {
            return errorResponse("config.json not found: $configPath")
        }
        return synchronized(CONFIG_WRITE_LOCK) {
            val file = configPath.toFile()
            val root = try {
                json.parseToJsonElement(file.readText(Charsets.UTF_8)).jsonObject
            } catch (e: Exception) {
                log.warn("Failed to parse config.json: ${e.message}")
                return@synchronized errorResponse("解析 config.json 失败")
            }
            val providersObj = root["provider"]?.let { runCatching { it.jsonObject }.getOrNull() }
            if (providersObj == null || providersObj[providerId] == null) {
                return@synchronized errorResponse("provider 不存在: $providerId")
            }

            // 变更集：目标 provider 的 enabled 字段（内置互斥已随 builtin 只读化移除）
            data class Change(val id: String, val newEnabled: Boolean)
            val changes = mutableListOf(Change(providerId, enabled))

            // 仅替换各目标 provider 的 enabled 字段，其余内容（含顺序）原样保留
            val newProviders = JsonObject(LinkedHashMap<String, kotlinx.serialization.json.JsonElement>(providersObj.size).apply {
                providersObj.forEach { (k, v) ->
                    val change = changes.find { it.id == k }
                    put(k, if (change != null) buildJsonObject {
                        v.jsonObject.forEach { (pk, pv) -> if (pk != "enabled") put(pk, pv) }
                        put("enabled", change.newEnabled)
                    } else v)
                }
            })
            val newRoot = buildJsonObject {
                root.forEach { (k, v) -> put(k, if (k == "provider") newProviders else v) }
            }

            val pretty = Json { prettyPrint = true }
            val bak = java.nio.file.Path.of(file.parentFile.absolutePath, file.name + ".bak")
            try {
                // 备份 → 写 tmp → 原子替换；替换失败从备份恢复
                java.nio.file.Files.copy(configPath, bak, java.nio.file.StandardCopyOption.REPLACE_EXISTING)
                val tmp = java.nio.file.Path.of(file.parentFile.absolutePath, file.name + ".tmp")
                tmp.toFile().writeText(pretty.encodeToString(JsonObject.serializer(), newRoot), Charsets.UTF_8)
                try {
                    java.nio.file.Files.move(tmp, configPath, java.nio.file.StandardCopyOption.REPLACE_EXISTING)
                } catch (e: Exception) {
                    java.nio.file.Files.move(bak, configPath, java.nio.file.StandardCopyOption.REPLACE_EXISTING)
                    throw e
                }
                val changeDesc = changes.joinToString(", ") { c -> c.id + "=" + c.newEnabled }
                log.info("modelToggleProvider: $changeDesc written back to $configPath")
                // 凭证可用性随 enabled 变化：失效环境检测缓存，30s TTL 内的自动路径不再报旧状态
                com.zcode.ideaplugin.env.ZCodeEnvChecker.invalidate()
            } catch (e: Exception) {
                log.warn("Failed to write back config.json: ${e.message}")
                return@synchronized errorResponse("写回失败: ${e.message}")
            }
            val changesJson = JsonArray(changes.map { c ->
                buildJsonObject {
                    put("providerId", c.id)
                    put("enabled", c.newEnabled)
                }
            })
            // 多标签同步：发起标签由下方 modelToggled 应答合并，其余已开标签靠
            // window.onModelsChanged 广播就地合并 + 重拉下拉（同 broadcastAppearance 模式）
            broadcastModelChanges(changesJson.toString())
            buildJsonObject {
                put("op", "modelToggled")
                put("changes", changesJson)
            }
        }
    }

    /** 模型 provider 启用/禁用变更广播到所有已开标签（modelToggleProvider 写回后调用）*/
    private fun broadcastModelChanges(changesJson: String) {
        SwingUtilities.invokeLater {
            activePanels.forEach { panel ->
                try {
                    if (panel.disposed || !panel::jbCefBrowser.isInitialized) return@forEach
                    panel.jbCefBrowser.cefBrowser.executeJavaScript(
                        "window.onModelsChanged && window.onModelsChanged($changesJson);",
                        "zcode-model-sync", 0
                    )
                } catch (e: Exception) {
                    log.warn("Model sync push failed (tab sessionId=${panel.currentSessionId}): ${e.message}")
                }
            }
        }
    }

    /**
     * op=getQuota — 查询 GLM Coding Plan 额度（5小时/每周/MCP每月）
     *
     * 凭证：config.json 的 builtin:bigmodel-coding-plan provider（baseURL + apiKey）
     * 端点：{baseDomain}/api/monitor/usage/quota/limit，Authorization: <apiKey>
     * 逻辑移植自 glm-plan-usage-idea 的 GlmUsageClient
     */
    /** 额度查询凭证（baseDomain + 裸 apiKey + 来源渠道标识），三路 monitor HTTP 共用 */
    private data class QuotaCredentials(
        val baseDomain: String,
        val apiKey: String,
        /** 实际取 key 的 provider（回退链不筛身份，可能落到非 coding-plan 渠道，前端据此提示）*/
        val providerId: String = "",
        val providerName: String = "",
    )

    /**
     * 从 config.json 读额度查询凭证（baseDomain + 裸 apiKey）。
     * 复用于 quota/limit、model-usage、tool-usage 三路 HTTP。
     * 路径走 [Credentials.defaultConfigPath]（dataBaseDir 感知，与模型列表/env 注入同源）。
     * @return Pair(凭证?, 错误信息) —— 凭证非空即成功
     */
    private fun loadQuotaCredentials(): Pair<QuotaCredentials?, String> {
        val configFile = Credentials.defaultConfigPath().toFile()
        if (!configFile.exists()) return null to "config.json 不存在：$configFile"
        val providers = try {
            json.parseToJsonElement(configFile.readText()).jsonObject["provider"]?.jsonObject
        } catch (e: Exception) {
            return null to "Failed to parse config.json: ${e.message}"
        } ?: return null to "config.json 无 provider"

        // 找第一个有 apiKey 的启用 provider（优先 bigmodel-coding-plan）
        var baseURL: String? = null
        var apiKey: String? = null
        var hitId = ""
        var hitName = ""
        for ((providerId, providerEl) in providers) {
            val pv = providerEl.jsonObject
            val enabled = pv["enabled"]?.jsonPrimitive?.content?.toBoolean() ?: true
            if (!enabled) continue
            val options = pv["options"]?.jsonObject ?: continue
            // 空白与缺失同等对待（与 credentialOf 同口径）：oauth 登录的 coding-plan 在
            // config 里 apiKey 是占位空串，穿透会发出空 Authorization 头
            val url = options["baseURL"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() } ?: continue
            // 体验套餐(zcode-plan 网关)渠道跳过：插件对门控渠道整体隐形（列表/管理/凭证
            // 同口径），额度永远反映实际使用的兜底渠道（2026-08-28 用户定案）
            if (com.zcode.ideaplugin.protocol.RuntimeModels.isCaptchaGatedBaseUrl(url)) continue
            val key = options["apiKey"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() } ?: continue
            val name = pv["name"]?.jsonPrimitive?.content ?: providerId
            // 优先 bigmodel-coding-plan，其他有 key 的也行
            if (providerId == "builtin:bigmodel-coding-plan") {
                baseURL = url; apiKey = key; hitId = providerId; hitName = name; break
            }
            if (baseURL == null) { baseURL = url; apiKey = key; hitId = providerId; hitName = name }
        }
        if (baseURL == null || apiKey == null) {
            return null to "未找到带 apiKey 的启用 provider（oauth 模式不支持用量查询）"
        }
        // 脱敏日志：用量凭证选了哪个渠道（回退链不筛身份，出现"数据口径不对"时先看这行）
        log.info("quota credentials: provider=$hitId ($hitName) keyLen=${apiKey.length}")

        // baseDomain：取 scheme://host[:port]，丢弃 path（如 /api/anthropic）
        val baseDomain = try {
            val uri = java.net.URI(baseURL)
            val port = if (uri.port == -1) "" else ":${uri.port}"
            "${uri.scheme}://${uri.host}$port"
        } catch (e: Exception) {
            return null to "baseURL 格式非法: $baseURL"
        }
        return QuotaCredentials(baseDomain, apiKey, hitId, hitName) to ""
    }

    /** 用量查询的局部错误响应（带 op，不污染全局 error）*/
    private fun usageErrorResponse(op: String, msg: String): JsonObject = buildJsonObject {
        put("op", op)
        put("error", msg)
    }

    /**
     * 通用：GET {baseDomain}/api/monitor/usage/{endpoint}?startTime=&endTime=
     * 透传响应 data 字段。startTime/endTime 格式 yyyy-MM-dd HH:mm:ss。
     */
    private fun queryUsageEndpoint(
        creds: QuotaCredentials, endpoint: String, startTime: String, endTime: String, op: String
    ): JsonObject {
        return try {
            val url = buildString {
                append(creds.baseDomain).append("/api/monitor/usage/").append(endpoint)
                append("?startTime=").append(java.net.URLEncoder.encode(startTime, Charsets.UTF_8))
                append("&endTime=").append(java.net.URLEncoder.encode(endTime, Charsets.UTF_8))
            }
            val client = java.net.http.HttpClient.newBuilder()
                .connectTimeout(java.time.Duration.ofSeconds(15)).build()
            val req = java.net.http.HttpRequest.newBuilder()
                .uri(java.net.URI(url))
                .timeout(java.time.Duration.ofSeconds(20))
                .header("Authorization", creds.apiKey)
                .header("Content-Type", "application/json")
                .header("Accept-Language", "en-US,en")
                .GET().build()
            val resp = client.send(req, java.net.http.HttpResponse.BodyHandlers.ofString())
            if (resp.statusCode() != 200) return usageErrorResponse(op, "查询失败: HTTP ${resp.statusCode()}")
            buildJsonObject {
                put("op", op)
                put("providerId", creds.providerId)
                put("providerName", creds.providerName)
                val rawData = json.parseToJsonElement(resp.body()).jsonObject
                rawData["data"]?.let { put("data", it) }
            }
        } catch (e: Exception) {
            usageErrorResponse(op, "查询异常: ${e.message}")
        }
    }

    /** op=getQuota — 查询额度（每5小时/每周/MCP 进度）*/
    private fun handleGetQuota(msg: JsonObject): JsonObject {
        val (creds, err) = loadQuotaCredentials()
        if (creds == null) return usageErrorResponse("quota", err)
        return try {
            val client = java.net.http.HttpClient.newBuilder()
                .connectTimeout(java.time.Duration.ofSeconds(15)).build()
            val req = java.net.http.HttpRequest.newBuilder()
                .uri(java.net.URI("${creds.baseDomain}/api/monitor/usage/quota/limit"))
                .timeout(java.time.Duration.ofSeconds(20))
                .header("Authorization", creds.apiKey)
                .header("Content-Type", "application/json")
                .header("Accept-Language", "en-US,en")
                .GET().build()
            val resp = client.send(req, java.net.http.HttpResponse.BodyHandlers.ofString())
            if (resp.statusCode() != 200) return usageErrorResponse("quota", "额度查询失败: HTTP ${resp.statusCode()}")
            buildJsonObject {
                put("op", "quota")
                put("providerId", creds.providerId)
                put("providerName", creds.providerName)
                val rawData = json.parseToJsonElement(resp.body()).jsonObject
                rawData["data"]?.let { put("data", it) }
            }
        } catch (e: Exception) {
            usageErrorResponse("quota", "额度查询异常: ${e.message}")
        }
    }

    /**
     * op=getAppUsage — 应用用量统计（app-server usage/stats，本地会话聚合）。
     *
     * 与 monitor 三路 HTTP 的区别：不依赖 config.json 的 apiKey，且覆盖第三方
     * 模型（monitor 的 model-usage 只统计 bigmodel 网关侧 GLM 系）。
     * range 仅支持 7d/30d/all（协议口径，无自定义区间），非法值回落 7d。
     */
    private fun handleGetAppUsage(msg: JsonObject): JsonObject {
        val range = msg["range"]?.jsonPrimitive?.contentOrNull?.takeIf { it in setOf("7d", "30d", "all") } ?: "7d"
        return try {
            val client = project.zCodeService().getClient()
            val data = client.usageStats(range)
            buildJsonObject {
                put("op", "appUsage")
                put("data", data)
            }
        } catch (e: Exception) {
            usageErrorResponse("appUsage", "应用用量查询异常: ${e.message}")
        }
    }

    /** op=getModelUsage — 查询模型用量曲线（startTime/endTime: yyyy-MM-dd HH:mm:ss）*/
    private fun handleGetModelUsage(msg: JsonObject): JsonObject {
        val (creds, err) = loadQuotaCredentials()
        if (creds == null) return usageErrorResponse("modelUsage", err)
        val startTime = msg["startTime"]?.jsonPrimitive?.content ?: ""
        val endTime = msg["endTime"]?.jsonPrimitive?.content ?: ""
        return queryUsageEndpoint(creds, "model-usage", startTime, endTime, "modelUsage")
    }

    /** op=getToolUsage — 查询工具用量曲线（startTime/endTime: yyyy-MM-dd HH:mm:ss）*/
    private fun handleGetToolUsage(msg: JsonObject): JsonObject {
        val (creds, err) = loadQuotaCredentials()
        if (creds == null) return usageErrorResponse("toolUsage", err)
        val startTime = msg["startTime"]?.jsonPrimitive?.content ?: ""
        val endTime = msg["endTime"]?.jsonPrimitive?.content ?: ""
        return queryUsageEndpoint(creds, "tool-usage", startTime, endTime, "toolUsage")
    }

    /** op=openFile — 在 IDEA 编辑器打开文件（支持行号定位）*/
    private fun handleOpenFile(msg: JsonObject): JsonObject {
        val filePath = msg["filePath"]?.jsonPrimitive?.content
            ?: return errorResponse("缺少 filePath")
        val line = msg["line"]?.jsonPrimitive?.content?.toIntOrNull()
        com.intellij.openapi.application.invokeLater {
            val vfile = LocalFileSystem.getInstance().findFileByPath(filePath)
            if (vfile != null) {
                val editor = FileEditorManager.getInstance(project).openFile(vfile, true)
                // 行号定位（caret 移到指定行）
                if (line != null && line > 0) {
                    val selected = FileEditorManager.getInstance(project).selectedTextEditor
                    if (selected != null) {
                        val offset = selected.document.getLineStartOffset(
                            minOf(line - 1, selected.document.lineCount - 1)
                        )
                        selected.caretModel.moveToOffset(offset)
                    }
                }
            } else {
                log.warn("Open file failed: file not found $filePath")
            }
        }
        return buildJsonObject { put("op", "fileOpened") }
    }

    /** op=showDiff — 弹出 IDEA 原生 diff 窗口（old vs new）*/
    private fun handleShowDiff(msg: JsonObject): JsonObject {
        val filePath = msg["filePath"]?.jsonPrimitive?.content ?: return errorResponse("缺少 filePath")
        val oldContent = msg["oldContent"]?.jsonPrimitive?.content ?: ""
        val newContent = msg["newContent"]?.jsonPrimitive?.content ?: ""
        val title = msg["title"]?.jsonPrimitive?.content ?: "Diff: ${filePath.substringAfterLast('/')}"
        com.intellij.openapi.application.invokeLater {
            try {
                val factory = DiffContentFactory.getInstance()
                val left: DiffContent = factory.create(project, oldContent)
                val right: DiffContent = factory.create(project, newContent)
                val request = SimpleDiffRequest(
                    title,
                    left, right,
                    "修改前", "修改后"
                )
                DiffManager.getInstance().showDiff(project, request)
            } catch (e: Exception) {
                log.warn("Diff display failed: ${e.message}")
            }
        }
        return buildJsonObject { put("op", "diffShown") }
    }

    /** op=refreshFile — 刷新 IDEA 编辑器中的文件（从磁盘重载）*/
    private fun handleRefreshFile(msg: JsonObject): JsonObject {
        val filePath = msg["filePath"]?.jsonPrimitive?.content
            ?: return errorResponse("缺少 filePath")
        com.intellij.openapi.application.invokeLater {
            val vfile = LocalFileSystem.getInstance().refreshAndFindFileByPath(filePath)
            if (vfile != null) {
                vfile.refresh(false, false)
            } else {
                log.warn("File refresh failed: file not found $filePath")
            }
        }
        return buildJsonObject { put("op", "fileRefreshed") }
    }

    /** op=setModel — 会话级切换模型（session/setModel + runtimeModel 注册 provider）*/
    private fun handleSetModel(msg: JsonObject): JsonObject {
        val sessionId = msg["sessionId"]?.jsonPrimitive?.content
            ?: return errorResponse("缺少 sessionId")
        val modelId = msg["modelId"]?.jsonPrimitive?.content
            ?: return errorResponse("缺少 modelId")
        val providerId = msg["providerId"]?.jsonPrimitive?.content
            ?: return errorResponse("缺少 providerId")
        // 体验套餐(zcode-plan 网关)渠道需滑块人机验证，插件宿主无法提供 verify param，
        // 切过去回合必失败（2026-08-28 定性，docs/internal/bugs-regressions）。入口直接
        // 拒绝并带 reason=captchaGated（前端映射本地化文案），不进延迟切换/忙重试队列
        if (com.zcode.ideaplugin.protocol.RuntimeModels.isCaptchaGatedProvider(providerId)) {
            log.warn("Model switch rejected: $providerId is captcha-gated (zcode-plan gateway)")
            return buildJsonObject {
                put("op", "modelSetFailed")
                put("sessionId", sessionId)
                put("modelId", modelId)
                put("providerId", providerId)
                put("reason", "captchaGated")
                put("message", "captcha-gated provider: $providerId (zcode-plan gateway requires human verification)")
            }
        }
        // 回合进行中：挂起切换，回合结束后异步补发（见 streamingTurns 注释）。
        // 前端收到 modelSetPending 后回滚选中态并提示"本轮结束后生效"，补发成功再落定
        if (sessionId in streamingTurns) return deferModelSwitch(sessionId, modelId, providerId)
        val client = project.zCodeService().getClient()
        try {
            // 带 runtimeModel：服务端先把 provider 注册进 workspace（绕过"可选模型"校验）
            // 普通 setModel 只能切 main/lite/available 里的模型（当前只有 anthropic/GLM-5.2）
            val runtimeModel = buildRuntimeModel(providerId, modelId)
            if (runtimeModel == null) {
                log.warn("Provider $providerId not found in config.json, falling back to plain setModel (may fail)")
            }
            client.setModel(sessionId, modelId, providerId, runtimeModel)
            log.info("Model switched: $sessionId → $providerId/$modelId")
        } catch (e: Exception) {
            // 竞态兜底：请求下发瞬间回合刚开始（turn.started 未及到达），-32603 同样
            // 转延迟切换——回合结束后补发重试会给出真实结果（真不支持则报 modelSetFailed）
            if (isUnsupportedModelEx(e) && sessionId in streamingTurns) {
                return deferModelSwitch(sessionId, modelId, providerId)
            }
            log.warn("Model switch failed: ${e.message}")
            // 忙窗口超时（缺陷AB）：后台延迟重试，成功后补推 modelSet（前端据此落定切换/清在途标记）
            if (isTimeoutEx(e)) scheduleSetModelBusyRetry(sessionId, modelId, providerId)
            return errorResponse("Model switch failed: ${e.message}")
        }
        return modelSetResponse(sessionId, modelId, providerId)
    }

    /** 挂起回合中的切换并应答 modelSetPending（前端回滚选中态、显示延迟提示）*/
    private fun deferModelSwitch(sessionId: String, modelId: String, providerId: String): JsonObject {
        pendingModelSwitches[sessionId] = PendingModelSwitch(modelId, providerId)
        log.info("Model switch deferred (turn in flight): $sessionId → $providerId/$modelId")
        return buildJsonObject {
            put("op", "modelSetPending")
            put("sessionId", sessionId)
            put("modelId", modelId)
            put("providerId", providerId)
        }
    }

    /**
     * op=cancelModelSwitch — 用户在等待期重新选回生效模型，撤销挂起的延迟切换。
     * 不撤的话回合结束 applyPendingModelSwitch 会把用户已放弃的目标模型真切上去。
     */
    private fun handleCancelModelSwitch(msg: JsonObject): JsonObject {
        val sessionId = msg["sessionId"]?.jsonPrimitive?.content
            ?: return errorResponse("缺少 sessionId")
        val removed = pendingModelSwitches.remove(sessionId)
        if (removed != null) {
            log.info("deferred model switch cancelled: $sessionId (was ${removed.providerId}/${removed.modelId})")
        }
        return buildJsonObject {
            put("op", "modelSwitchCancelled")
            put("sessionId", sessionId)
        }
    }

    /**
     * 回合结束（completed/failed）后补发挂起的切换。事件在协议读线程上到达，
     * setModel 是带重试的阻塞 RPC，须另起线程避免卡住事件流。
     *
     * -32603 短时重试（3 次 × 1.5s）：服务端 runtime 清算滞后于 turn.completed 下发
     * （实测偶发——事件已到、锁未放，立即补发撞 -32603；稍候即恢复）。
     */
    private fun applyPendingModelSwitch(sessionId: String) {
        val pending = pendingModelSwitches.remove(sessionId) ?: return
        Thread({
            if (disposed) return@Thread
            var unsupportedAttempts = 0
            while (true) {
                try {
                    val client = project.zCodeService().getClient()
                    client.setModel(sessionId, pending.modelId, pending.providerId, buildRuntimeModel(pending.providerId, pending.modelId))
                    sendToJs(modelSetResponse(sessionId, pending.modelId, pending.providerId))
                    log.info("deferred model switch applied: $sessionId → ${pending.providerId}/${pending.modelId}")
                    return@Thread
                } catch (e: Exception) {
                    when {
                        // 忙窗口超时（缺陷AB）：走既有忙重试，成功会补推 modelSet
                        isTimeoutEx(e) -> {
                            log.info("deferred model switch hit busy window: $sessionId (${e.message})")
                            scheduleSetModelBusyRetry(sessionId, pending.modelId, pending.providerId)
                            return@Thread
                        }
                        // 补发瞬间新回合已开跑：继续挂起等下一轮回合结束（putIfAbsent 保住期间
                        // 用户更新过的目标，不覆盖）
                        isUnsupportedModelEx(e) && sessionId in streamingTurns -> {
                            log.info("deferred model switch re-deferred (new turn): $sessionId")
                            pendingModelSwitches.putIfAbsent(sessionId, pending)
                            return@Thread
                        }
                        // 回合锁清算滞后：稍候重试
                        isUnsupportedModelEx(e) && unsupportedAttempts < 3 -> {
                            unsupportedAttempts++
                            log.info("deferred model switch retry #$unsupportedAttempts (server lock lag): $sessionId")
                            runCatching { Thread.sleep(1500) }
                        }
                        else -> {
                            log.warn("deferred model switch failed: $sessionId (${e.message})")
                            sendToJs(buildJsonObject {
                                put("op", "modelSetFailed")
                                put("sessionId", sessionId)
                                put("modelId", pending.modelId)
                                put("providerId", pending.providerId)
                                put("message", "Model switch failed: ${e.message}")
                            })
                            return@Thread
                        }
                    }
                }
            }
        }, "zcode-deferred-setmodel").apply { isDaemon = true }.start()
    }

    /** setModel 应答/重试补推共用的响应构造 */
    private fun modelSetResponse(sessionId: String, modelId: String, providerId: String): JsonObject =
        buildJsonObject {
            put("op", "modelSet")
            put("sessionId", sessionId)
            put("modelId", modelId)
            put("providerId", providerId)
        }

    /** setModel 超时后的忙窗口重试：成功即补推 modelSet */
    private fun scheduleSetModelBusyRetry(sessionId: String, modelId: String, providerId: String) {
        busyRetry.schedule("setModel:$sessionId") {
            try {
                val client = project.zCodeService().getClient()
                client.setModel(sessionId, modelId, providerId, buildRuntimeModel(providerId, modelId))
                sendToJs(modelSetResponse(sessionId, modelId, providerId))
                sendToJs(buildJsonObject { put("op", "busyRetryRecovered") })
                log.info("busy-retry: setModel for $sessionId recovered → $providerId/$modelId")
                true
            } catch (e: Exception) {
                // 重试期间回合开跑（或目标模型未注册）：撞 -32603 时转延迟切换，
                // 由回合结束的 applyPendingModelSwitch 补发，本重试链终止（不重复下发）
                if (isUnsupportedModelEx(e) && sessionId in streamingTurns) {
                    pendingModelSwitches.putIfAbsent(sessionId, PendingModelSwitch(modelId, providerId))
                    log.info("busy-retry: setModel for $sessionId re-deferred (turn in flight)")
                    true
                } else {
                    log.info("busy-retry: setModel for $sessionId still failing: ${e.message}")
                    false
                }
            }
        }
    }

    /**
     * op=getSettings — 读会话运行时设置（session/read → settings）
     *
     * 返回 mode（权限模式当前值）+ thoughtLevel（思考级别：available 因模型而异，
     * 如 GLM-5.2=off/high/max、GLM-4.x/qwen=enabled/off，前端级别选择器的数据源）
     */
    private fun handleGetSettings(msg: JsonObject): JsonObject {
        val sessionId = msg["sessionId"]?.jsonPrimitive?.content
            ?: return errorResponse("缺少 sessionId")
        val client = project.zCodeService().getClient()
        return try {
            settingsResponse(sessionId, client.readSettings(sessionId))
        } catch (e: Exception) {
            log.warn("Failed to read session settings: ${e.message}")
            // 忙窗口超时（缺陷AB）：应答仍即时回错误，后台延迟重试，成功后补推 settings
            if (isTimeoutEx(e)) scheduleSettingsBusyRetry(sessionId)
            // 冷会话（-32004 Session is not active）：跨进程会话（其他客户端创建的/
            // CLI 重启后的新进程）在本进程尚未激活，启动恢复上次会话时必撞。与
            // resumeAndReadMessages 同款自愈——resume 激活后重读一次（错误文案里
            // 承诺的"自动恢复后重发"在此落地；resumeSessionDeduped 与并发 messages
            // 链路共用一次 resume）
            val coldSession = e.message?.let {
                it.contains("-32004") || it.contains("Session is not active", ignoreCase = true)
            } == true
            if (coldSession) {
                try {
                    resumeSessionDeduped(client, sessionId, effectiveWorkspacePath(msg))
                    return settingsResponse(sessionId, client.readSettings(sessionId))
                } catch (e2: Exception) {
                    log.warn("settings read still failing after cold-session resume: ${e2.message}")
                }
            }
            errorResponse("读取设置失败: ${e.message}")
        }
    }

    /** getSettings 应答/重试补推共用的响应构造（webview case 'settings' 不区分应答与推送）*/
    private fun settingsResponse(sessionId: String, settings: JsonObject): JsonObject = buildJsonObject {
        put("op", "settings")
        put("sessionId", sessionId)
        put("mode", settings["mode"]?.jsonObject ?: JsonObject(emptyMap()))
        put("thoughtLevel", settings["thoughtLevel"]?.jsonObject ?: JsonObject(emptyMap()))
    }

    /** settings 读取超时后的忙窗口重试：成功即补推 settings（思考深度随权威级别集恢复）*/
    private fun scheduleSettingsBusyRetry(sessionId: String) {
        busyRetry.schedule("settings:$sessionId") {
            try {
                val client = project.zCodeService().getClient()
                val resp = settingsResponse(sessionId, client.readSettings(sessionId))
                sendToJs(resp)
                sendToJs(buildJsonObject { put("op", "busyRetryRecovered") })
                log.info("busy-retry: settings for $sessionId recovered")
                true
            } catch (e: Exception) {
                log.info("busy-retry: settings for $sessionId still failing: ${e.message}")
                false
            }
        }
    }

    /** op=setThoughtLevel — 会话级切换思考级别（session/setThoughtLevel）*/
    private fun handleSetThoughtLevel(msg: JsonObject): JsonObject {
        val sessionId = msg["sessionId"]?.jsonPrimitive?.content
            ?: return errorResponse("缺少 sessionId")
        val thoughtLevel = msg["thoughtLevel"]?.jsonPrimitive?.content
            ?: return errorResponse("缺少 thoughtLevel")
        val client = project.zCodeService().getClient()
        return try {
            client.setThoughtLevel(sessionId, thoughtLevel)
            log.info("Thought level switched: $sessionId → $thoughtLevel")
            buildJsonObject {
                put("op", "thoughtLevelSet")
                put("sessionId", sessionId)
                put("thoughtLevel", thoughtLevel)
            }
        } catch (e: Exception) {
            log.warn("Thought level switch failed: ${e.message}")
            errorResponse("Thought level switch failed: ${e.message}")
        }
    }

    /** op=setMode — 会话级切换权限模式（session/setMode，build/edit/plan/yolo）*/
    private fun handleSetMode(msg: JsonObject): JsonObject {
        val sessionId = msg["sessionId"]?.jsonPrimitive?.content
            ?: return errorResponse("缺少 sessionId")
        val modeStr = msg["mode"]?.jsonPrimitive?.content
            ?: return errorResponse("缺少 mode")
        val mode = com.zcode.ideaplugin.protocol.model.PermissionMode.fromValue(modeStr)
            ?: return errorResponse("未知模式: $modeStr（可选 build/edit/plan/yolo）")
        val client = project.zCodeService().getClient()
        return try {
            client.setMode(sessionId, mode)
            log.info("Permission mode switched: $sessionId → $mode")
            buildJsonObject {
                put("op", "modeSet")
                put("sessionId", sessionId)
                put("mode", modeStr)
            }
        } catch (e: Exception) {
            log.warn("Permission mode switch failed: ${e.message}")
            errorResponse("Permission mode switch failed: ${e.message}")
        }
    }

    /**
     * op=pickFiles — 附件按钮：弹 IDEA 原生文件选择器，选中项以 @绝对路径 推给输入框
     *
     * 不用 webview 原生 <input type=file>：Chromium fakepath 拿不到绝对路径，
     * 而 ZCode 的 @引用 必须绝对路径（与 SendFileToInputAction 的 filesToInput 推送同款格式）。
     */
    private fun handlePickFiles(msg: JsonObject): JsonObject {
        var picked: List<VirtualFile> = emptyList()
        // FileChooser 必须在 EDT 弹出（模态，阻塞到用户关闭）
        ApplicationManager.getApplication().invokeAndWait {
            // (chooseFiles, chooseFolders, chooseJars, chooseJARContents, chooseJarsAsLibraries, multipleSelection)
            val descriptor = FileChooserDescriptor(true, true, false, false, false, true)
                .withTitle("添加附件")
            picked = FileChooser.chooseFiles(descriptor, project, null).toList()
        }
        if (picked.isEmpty()) {
            return buildJsonObject { put("op", "filesPicked"); put("count", 0) }
        }
        // 目录尾加 /（与 SendFileToInputAction 一致，前端 FileRef 靠它判定目录图标）
        val refs = FileRefs.toRefs(picked, presentable = true)
        log.info("${refs.size} attachment(s) selected: $refs")
        // 复用 filesToInput 推送链路（InputBox 已监听，自动加入 fileRefs chips）
        pushToWebview(buildJsonObject {
            put("op", "filesToInput")
            put("refs", JsonArray(refs.map { JsonPrimitive(it) }))
        })
        return buildJsonObject { put("op", "filesPicked"); put("count", refs.size) }
    }

    /** 获取会话上下文用量（session/read → runtime.contextUsage）*/
    private fun handleGetUsage(msg: JsonObject): JsonObject {
        val sessionId = msg["sessionId"]?.jsonPrimitive?.content
            ?: return errorResponse("缺少 sessionId")
        val client = project.zCodeService().getClient()
        return try {
            val runtime = client.contextUsage(sessionId)
            val ctx = runtime["contextUsage"]?.jsonObject ?: JsonObject(emptyMap())
            buildJsonObject {
                put("op", "usage")
                // 响应回带会话 id：流式轮询期间切会话，前端靠它丢弃旧会话的迟到响应
                put("sessionId", sessionId)
                put("used", ctx["used"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L)
                put("size", ctx["size"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L)
                // hitRate 服务端可为 null（新 turn 首次模型调用完成前聚合器为空，
                // zcode.cjs: totalInputTokens>0 ? cacheRead/input : null）——null 时不
                // 输出该字段，前端显示"—"；此前落回 0.0 会把"暂无统计"闪成"0%"再恢复
                val hitRate = ctx["cache"]?.jsonObject?.get("hitRate")?.jsonPrimitive?.content?.toDoubleOrNull()
                if (hitRate != null) put("hitRate", hitRate)
                // 构成明细：runtime 顶层 breakdown（CLI turn 后构建，重命名自 contextUsageBreakdown）
                val breakdownEl = runtime["breakdown"] ?: ctx["breakdown"]
                if (breakdownEl != null) put("breakdown", breakdownEl)
                // 当前回合类型（activeTurnKind，实测见 /compact：值为 "compact" 时正在
                // 压缩上下文）：前端压缩状态条/看门狗豁免的权威信号，覆盖 autocompact。
                // activeTurnId 一并透传：服务端 runtime 清算滞后于 turn.completed 下发，
                // 前端按"读数 turnId == 已完成回合 id"识别滞后读数，防压缩指示器复活卡死
                val turnKind = runtime["activeTurnKind"]?.jsonPrimitive?.content
                if (turnKind != null) {
                    put("activeTurnKind", turnKind)
                    runtime["activeTurnId"]?.jsonPrimitive?.contentOrNull?.let { put("activeTurnId", it) }
                }
            }
        } catch (e: Exception) {
            log.warn("Failed to fetch context usage: ${e.message}")
            // P2 辅助数据失败静默降级（缺陷AB 优先级编排②）：不走 errorResponse——
            // 那会在前端顶栏弹错并复位 streaming（忙窗口期间用量轮询失败曾把故障感知
            // 放大三倍、还误伤流式显示）；前端 case 'usageError' 仅记日志。用量有
            // 流式轮询/回合结束刷新等自愈路径，无需用户感知
            buildJsonObject {
                put("op", "usageError")
                put("sessionId", sessionId)
                put("message", e.message ?: "查询失败")
            }
        }
    }

    /**
     * 构造协议 runtimeModel（provider 完整定义取自 ~/.zcode/v2/config.json）。
     * 委派给 protocol 模块的 RuntimeModels——与 -32031 恢复路径共用同一构造器，
     * 保证 UI 手动切模型与 send 自愈发出去的 runtimeModel 结构完全一致。
     */
    private fun buildRuntimeModel(providerId: String, modelId: String): JsonObject? =
        com.zcode.ideaplugin.protocol.RuntimeModels.buildRuntimeModel(providerId, modelId)

    private fun handleSend(msg: JsonObject): JsonObject {
        val sessionId = msg["sessionId"]?.jsonPrimitive?.content
            ?: return errorResponse("缺少 sessionId")
        val text = msg["text"]?.jsonPrimitive?.content
            ?: return errorResponse("缺少 text")
        val workspacePath = effectiveWorkspacePath(msg)
        // 前端 currentModel 透传：-32031 恢复时优先用用户选择的 provider 构造 runtimeModel，
        // 避免恢复链路静默切回默认 provider（个人套餐）；缺省时协议端走原有默认路径
        val providerId = msg["providerId"]?.jsonPrimitive?.content
        val modelId = msg["modelId"]?.jsonPrimitive?.content
        // 粘贴图片附件（InputBox 压缩后的 base64 内联形态），协议通道原生透传
        val attachments = parseAttachments(msg["attachments"])

        val client = project.zCodeService().getClient()

        val accepted = try {
            client.send(sessionId, text, workspacePath, providerId = providerId, modelId = modelId, attachments = attachments)
        } catch (e: ZCodeProtocolException) {
            // 冷会话 send：CLI 升级/重启后的新进程里会话未激活（-32004 Session is not
            // active）。与 resumeAndReadMessages 同一模式——先 resume 激活再重试一次，
            // 否则用户要靠"从历史重开"手动触发 resume 才能续上（2026-08-19 实测踩坑）
            val coldSession = e.message?.let {
                it.contains("-32004") || it.contains("Session is not active", ignoreCase = true)
            } == true
            // 悬挂回合 send：服务端 prompt 仍在 running（典型：审批反向请求被服务端
            // 退避放弃后回合未收尾，2026-08-20 实测；或多标签 resume 同会话并发）。
            // -32010 是同步拒绝、消息未入队，先 session/stop 打断悬挂回合再重发一次。
            // 注意多标签同会话另一侧真实生成中会被误停——属可接受边缘（同会话本就
            // 不该两标签同时发）；不违反 requestWithRetry 的幂等约束（那是超时未知态）
            val promptRunning = e.code == -32010 || e.message?.contains("-32010") == true
            if (!coldSession && !promptRunning) {
                log.error("send failed", e)
                return errorResponse("发送失败: ${e.message}")
            }
            try {
                if (promptRunning) {
                    client.stop(sessionId)
                    // stop 打断的回合可能正挂着审批/提问弹窗：立即废弃（关窗 + 不发
                    // 迟到应答），否则用户点死弹窗的应答会发给已死请求（缺陷P2/P3）
                    project.zCodeService().abortPendingUserInputs(sessionId)
                    log.info("send hit hung turn (-32010), retrying after stop: $sessionId")
                } else {
                    client.resume(sessionId, com.zcode.ideaplugin.protocol.model.Workspace(workspacePath))
                    log.info("send hit cold session (-32004), retrying after resume: $sessionId")
                }
                // 后端换代场景（进程重启后 send 才触发 getClient 重建）：订阅簿记此时才
                // 失效——立即重挂全局监听器并重新订阅本会话，否则服务端正常产出而前端
                // 收不到流式（一直转圈直到手动停止，2026-08-22 实测）
                invalidateStaleSubscriptions(client)
                ensureGlobalStreamListener(client)
                if (sessionId !in subscribedSessions) {
                    runCatching { client.subscribe(sessionId, onEvent = null) }
                        .onSuccess { subscribedSessions.add(sessionId) }
                }
                client.send(sessionId, text, workspacePath, providerId = providerId, modelId = modelId, attachments = attachments)
            } catch (e2: Exception) {
                log.error("send failed (still failing after recovery retry)", e2)
                return errorResponse("发送失败: ${e2.message}")
            }
        }

        return buildJsonObject {
            put("op", "sendAccepted")
            put("sessionId", sessionId)
            put("accepted", "true")
            accepted["cliResponse"]?.let { put("cliResponse", it) }
        }
    }

    /**
     * op:send 的 attachments 数组（webview InputBox 压缩后的图片附件）→ AttachmentInput 列表。
     * 非数组 / 空 / 字段缺失均 fail-soft 返回 null（按无附件发送，不阻断消息）。
     */
    private fun parseAttachments(el: JsonElement?): List<AttachmentInput>? {
        val arr = el as? JsonArray ?: return null
        val list = arr.mapNotNull { item ->
            val o = item as? JsonObject ?: return@mapNotNull null
            val dataBase64 = o["dataBase64"]?.jsonPrimitive?.content ?: return@mapNotNull null
            AttachmentInput(
                kind = "image",
                filename = o["filename"]?.jsonPrimitive?.content ?: "image.png",
                mimeType = o["mimeType"]?.jsonPrimitive?.content ?: "image/png",
                sizeBytes = o["sizeBytes"]?.jsonPrimitive?.longOrNull,
                dataBase64 = dataBase64,
            )
        }
        return list.ifEmpty { null }
    }

    /**
     * JCEF 剪贴板图片兜底（InputBox.onPaste 无 image 项且无文本时请求）：
     * 读 AWT 系统剪贴板 DataFlavor.imageFlavor → PNG base64 返回。无图/异常返回
     * 空对象（前端拿到空 base64 静默忽略，无副作用）。
     * 剪贴板访问必须在 EDT（本 handler 跑 pooled 线程），PNG 编码留在 pooled 线程。
     */
    private fun handleGetClipboardImage(msg: JsonObject): JsonObject {
        fun empty(): JsonObject = buildJsonObject {
            put("op", "clipboardImage")
            put("requestId", msg["requestId"]?.jsonPrimitive?.content ?: "")
        }
        var image: java.awt.image.BufferedImage? = null
        var clipErr: String? = null
        ApplicationManager.getApplication().invokeAndWait {
            try {
                image = java.awt.Toolkit.getDefaultToolkit()
                    .systemClipboard.getData(java.awt.datatransfer.DataFlavor.imageFlavor)
                    as? java.awt.image.BufferedImage
            } catch (e: Exception) {
                clipErr = e.message
            }
        }
        if (image == null) {
            // 剪贴板无图片内容是常态（FlavorUnsupported/IllegalState），不打错误级
            log.info("clipboard image unavailable${clipErr?.let { ": $it" } ?: ""}")
            return empty()
        }
        return try {
            val baos = java.io.ByteArrayOutputStream()
            javax.imageio.ImageIO.write(image, "png", baos)
            val b64 = java.util.Base64.getEncoder().encodeToString(baos.toByteArray())
            log.info("clipboard image captured: ${b64.length} base64 chars")
            buildJsonObject {
                put("op", "clipboardImage")
                put("requestId", msg["requestId"]?.jsonPrimitive?.content ?: "")
                put("base64", b64)
                put("mediaType", "image/png")
            }
        } catch (e: Exception) {
            log.warn("clipboard image encode failed: ${e.message}")
            empty()
        }
    }

    private fun handleMessages(msg: JsonObject): JsonObject {
        val sessionId = msg["sessionId"]?.jsonPrimitive?.content
            ?: return errorResponse("缺少 sessionId")
        // JS 传过来的会话原始 workspace（来自 session/list 的 workspace 字段）
        val workspacePath = effectiveWorkspacePath(msg)

        val messages = resumeAndReadMessages(sessionId, workspacePath)
        // 前端流式静默对账探测（看门狗只读快照判定回合是否已在服务端结束）：
        // 原样回传 reconcile 标记，前端区分"权威全量落地"与"对账只读"
        val reconcile = msg["reconcile"]?.jsonPrimitive?.booleanOrNull ?: false
        log.info("messages returned ${messages.size} item(s)${if (reconcile) " (reconcile probe)" else ""}")
        return buildJsonObject {
            put("op", "messages")
            put("sessionId", sessionId)
            put("messages", messages)
            if (reconcile) put("reconcile", true)
        }
    }

    /**
     * resume（若需）+ 读指定会话消息（主/子会话通用）。
     *
     * ⚠️ 关键：session/messages 要求会话是 active 的
     * 冷会话（其他进程创建的、或本进程没 resume 过的）会报 -32004 Session is not active
     * 解法：先 resume（带原始 workspace），再读 messages
     */
    private fun resumeAndReadMessages(sessionId: String, workspacePath: String): JsonArray {
        val client = project.zCodeService().getClient()
        // 同会话短窗去重（subscribe 链路可能刚 resume 过，见 resumeSessionDeduped）
        resumeSessionDeduped(client, sessionId, workspacePath)
        val messages = client.messages(sessionId)
        // 用户图片 part 读回适配：type:"file" + zcode-artifact:// uri → 内置 server
        // 的 /zcode-image/ URL（<img> 可加载）。fail-soft，见 ImageArtifactMapper
        return ImageArtifactMapper.mapMessages(messages) { sid, fileName ->
            if (!ImageArtifactMapper.cacheFileExists(ZCodeWebviewServer.imageCacheRoot, sid, fileName)) {
                return@mapMessages null
            }
            ZCodeWebviewServer.imageUrl(sid, fileName)
        }
    }

    /**
     * session/subagents — 当前会话的子代理列表（running + ended，含 childSessionId）。
     * 走持久化存储无需 resume；失败静默返回空数据（前端底部栏有解析兜底，不打全局错误）。
     */
    private fun handleSubagents(msg: JsonObject): JsonObject {
        val sessionId = msg["sessionId"]?.jsonPrimitive?.content
            ?: return errorResponse("缺少 sessionId")
        val client = project.zCodeService().getClient()
        return try {
            val data = client.subagents(sessionId)
            log.info("subagents returned childSessionIds=${data["childSessionIds"]}")
            buildJsonObject {
                put("op", "subagents")
                put("sessionId", sessionId)
                put("data", data)
            }
        } catch (e: Exception) {
            log.warn("subagents query failed: ${e.message}")
            buildJsonObject {
                put("op", "subagents")
                put("sessionId", sessionId)
                put("data", buildJsonObject {
                    put("revision", 0)
                    put("childSessionIds", JsonArray(emptyList()))
                    put("running", JsonArray(emptyList()))
                    put("ended", buildJsonObject {
                        put("total", 0)
                        put("items", JsonArray(emptyList()))
                    })
                })
                put("error", e.message ?: "查询失败")
            }
        }
    }

    /**
     * 子会话完整消息（子代理详情弹窗"原始过程"）。
     * 与 messages op 分开（响应 op 不同），避免前端 case 'messages' 的
     * currentSessionId 过滤把子会话消息丢弃；失败带 error 字段就地提示。
     */
    private fun handleSubagentMessages(msg: JsonObject): JsonObject {
        val sessionId = msg["sessionId"]?.jsonPrimitive?.content
            ?: return errorResponse("缺少 sessionId")
        val workspacePath = effectiveWorkspacePath(msg)
        return try {
            val messages = resumeAndReadMessages(sessionId, workspacePath)
            log.info("subagentMessages($sessionId) returned ${messages.size} item(s)")
            buildJsonObject {
                put("op", "subagentMessages")
                put("sessionId", sessionId)
                put("messages", messages)
            }
        } catch (e: Exception) {
            log.warn("subagentMessages($sessionId) read failed: ${e.message}")
            buildJsonObject {
                put("op", "subagentMessages")
                put("sessionId", sessionId)
                put("messages", JsonArray(emptyList()))
                put("error", e.message ?: "读取失败")
            }
        }
    }

    /**
     * app-server 进程被外部重启（环境配置变更 shutdown）后调用：
     * 旧 client 上的全局监听器随进程销毁，subscribedSessions 记录的也是旧进程上的订阅。
     * 不重置的话下次 subscribe 会被两道记忆挡住（监听器不重挂、会话不重订），
     * 表现为发送正常但收不到实时流，须重启 IDE 才恢复。
     */
    fun resetSubscriptionState() {
        subscribedClientRef = null
        globalListenerRegistered = false
        subscribedSessions.clear()
    }

    /**
     * 订阅簿记所属的协议客户端（app-server 换代检测）：
     * 进程重启（显式 shutdown/崩溃自愈/CLI 升级）后 getClient 返回新实例，旧进程上的
     * 订阅与全局监听器全部随进程消亡——簿记失效，须重新走完整订阅，否则"发送成功但
     * 收不到实时流"（2026-08-22 实测：disable 浏览器控制触发 shutdown 后，发消息
     * -32004 自愈重发成功、服务端正常产出，但前端 subscribe 被 already-subscribed
     * 短路、监听器不重挂 → 一直转圈直到手动停止）。
     */
    @Volatile
    private var subscribedClientRef: com.zcode.ideaplugin.protocol.ZCodeProtocolClient? = null

    /** client 换代则清空订阅簿记（两个 subscribe 入口调用；换代后首访触发）*/
    private fun invalidateStaleSubscriptions(client: com.zcode.ideaplugin.protocol.ZCodeProtocolClient) {
        if (subscribedClientRef === client) return
        log.info("Protocol client changed (app-server restarted), resetting subscription bookkeeping")
        subscribedClientRef = client
        globalListenerRegistered = false
        subscribedSessions.clear()
    }

    /** 已挂到协议客户端上的全局流式监听器及其宿主 client（dispose 时成对摘除用）*/
    @Volatile
    private var globalStreamListener: ((com.zcode.ideaplugin.protocol.model.SessionEvent) -> Unit)? = null

    @Volatile
    private var globalStreamListenerClient: com.zcode.ideaplugin.protocol.ZCodeProtocolClient? = null

    /**
     * 挂全局流式监听器（幂等，两个 subscribe 入口共用）。
     * 保存监听器与宿主 client 的引用，dispose 时成对摘除——匿名监听器摘不掉，
     * client 存活期间会一直把事件推向已释放的 JCEF。
     */
    private fun ensureGlobalStreamListener(client: com.zcode.ideaplugin.protocol.ZCodeProtocolClient) {
        if (globalListenerRegistered) return
        val listener: (com.zcode.ideaplugin.protocol.model.SessionEvent) -> Unit =
            { event -> pushStreamEvent(event.sessionId, event) }
        client.addGlobalEventListener(listener)
        globalStreamListener = listener
        globalStreamListenerClient = client
        registerBackendErrorHandler(client)
        globalListenerRegistered = true
        log.info("Global event listener registered")
    }

    /**
     * 订阅会话的流式事件（阶段 2.4 核心）
     *
     * 调 client.subscribe() 注册事件监听器，把每个 session/event 透传给 JS。
     * 切换会话时先取消旧的监听器，避免串台。
     *
     * 协议要求：先 subscribe 再 send，否则丢事件（规格书 §4）。
     */
    private fun handleSubscribe(msg: JsonObject): JsonObject {
        val sessionId = msg["sessionId"]?.jsonPrimitive?.content
            ?: return errorResponse("缺少 sessionId")
        val workspacePath = effectiveWorkspacePath(msg)
        val client = project.zCodeService().getClient()
        invalidateStaleSubscriptions(client)

        // 记录当前会话（标签持久化 + 生成中状态归属判断）+ 同步 TabState
        currentSessionId = sessionId
        persistSelfTabState()

        // 注册全局监听器（只注册一次，所有会话的事件都通过它推给前端）
        ensureGlobalStreamListener(client)

        // 每个 session 只 subscribe 一次（不 unsubscribe，避免切回时丢事件）
        if (sessionId in subscribedSessions) {
            log.info("session $sessionId already subscribed, skipping")
            return buildJsonObject {
                put("op", "subscribed")
                put("sessionId", sessionId)
            }
        }

        // subscribe 要求会话 active，先 resume（同会话短窗去重：messages 链路并发 resume 只排一次队）
        resumeSessionDeduped(client, sessionId, workspacePath)

        // subscribe（全局监听器已在 app-server 层面接收所有事件）
        try {
            client.subscribe(sessionId, onEvent = null)
            subscribedSessions.add(sessionId)
            log.info("subscribe session $sessionId succeeded (events via global listener)")
        } catch (e: Exception) {
            log.error("subscribe session $sessionId failed", e)
            // 忙窗口超时（缺陷AB）：应答仍即时回错误，后台延迟重试——事件流经全局监听器
            // 转发，重试成功后无需额外通知（事件自然开始流动）
            if (isTimeoutEx(e)) scheduleSubscribeBusyRetry(sessionId)
            return errorResponse("订阅失败: ${e.message}")
        }

        return buildJsonObject {
            put("op", "subscribed")
            put("sessionId", sessionId)
        }
    }

    /**
     * subscribe 超时后的忙窗口重试（缺陷AB）：重试成功只补记 subscribedSessions 并推
     * busyRetryRecovered——事件流经全局监听器转发，成功后事件自然开始流动，无需补推。
     */
    private fun scheduleSubscribeBusyRetry(sessionId: String) {
        busyRetry.schedule("subscribe:$sessionId") {
            try {
                if (sessionId in subscribedSessions) return@schedule true
                val client = project.zCodeService().getClient()
                client.subscribe(sessionId, onEvent = null)
                subscribedSessions.add(sessionId)
                sendToJs(buildJsonObject { put("op", "busyRetryRecovered") })
                log.info("busy-retry: subscribe $sessionId recovered (events via global listener)")
                true
            } catch (e: Exception) {
                log.info("busy-retry: subscribe $sessionId still failing: ${e.message}")
                false
            }
        }
    }

    /**
     * 订阅子代理会话的事件流（子会话详情弹窗实时归约的前提）。
     *
     * 背景：子会话由 Agent 工具在服务端 spawn，本客户端从未对它 session/subscribe，
     * 服务端不会推送其 session/event——pushStreamEvent 的白名单也只放行已订阅会话。
     * 结果是弹窗实时只显示父会话转发的工具级事件（无 AI 文本增量），点刷新拉快照才有
     * 完整对话。本 op 给子会话补上 subscribe，使其原生事件流（text_delta 等）实时到达前端。
     *
     * 与 handleSubscribe 的区别：不改动 currentSessionId / TabState（那是主会话语义，
     * 若被子会话劫持会破坏标签绑定与流式状态归属）。resume 失败（运行中已 active 等）
     * 静默忽略——只读订阅，不干预子会话执行。
     */
    private fun handleSubscribeChild(msg: JsonObject): JsonObject {
        val sessionId = msg["sessionId"]?.jsonPrimitive?.content
            ?: return errorResponse("缺少 sessionId")
        val workspacePath = effectiveWorkspacePath(msg)
        val client = project.zCodeService().getClient()
        invalidateStaleSubscriptions(client)

        // 全局监听器（只注册一次，同 handleSubscribe）
        ensureGlobalStreamListener(client)

        if (sessionId in subscribedSessions) {
            log.info("subscribeChild: child session $sessionId already subscribed, skipping")
            return buildJsonObject {
                put("op", "subscribedChild")
                put("sessionId", sessionId)
            }
        }

        // subscribe 要求会话 active，先 resume（同会话短窗去重）；运行中的子会话可能已 active，失败静默
        resumeSessionDeduped(client, sessionId, workspacePath)

        return try {
            client.subscribe(sessionId, onEvent = null)
            subscribedSessions.add(sessionId)
            log.info("subscribeChild: child session event stream subscribed $sessionId")
            buildJsonObject {
                put("op", "subscribedChild")
                put("sessionId", sessionId)
            }
        } catch (e: Exception) {
            log.warn("subscribeChild: subscribe failed $sessionId: ${e.message}")
            errorResponse("子会话订阅失败: ${e.message}")
        }
    }

    /**
     * 注册后端模型 API 错误兜底通道（app-server stderr 的 APICallError 解析结果，
     * 见 BackendErrorDetector）。场景：429 配额超限等被 app-server 按可重试分类
     * 持续退避重试，turn 终止帧（turn.failed）迟迟不发，事件流上无错误迹象——
     * 前端无限转圈且无提示。stderr 是错误的第一现场，推给前端顶栏展示。
     * 只提示、不复位前端 streaming（turn 可能仍在服务端重试，由终止帧收尾）。
     */
    private fun registerBackendErrorHandler(client: com.zcode.ideaplugin.protocol.ZCodeProtocolClient) {
        client.backendErrorHandler = { err ->
            log.warn("[backendError] model API error statusCode=${err.statusCode} code=${err.code} message=${err.message.take(300)}")
            sendToJsDirect(buildJsonObject {
                put("op", "backendError")
                err.statusCode?.let { put("statusCode", it) }
                err.code?.let { put("code", it) }
                put("message", err.message)
            })
        }
    }

    /**
     * 把一个 session/event 推给前端（Java → JS 流式推送）
     * 包装成 {op:"streamEvent", sessionId, event:{type, payload, ...}}
     *
     * 节流策略：高频 delta 进缓冲队列，每 16ms 合并成一批推送。
     * 关键事件（turn.started/completed/failed）立即 flush，保证生命周期即时。
     */
    private fun pushStreamEvent(sessionId: String, event: com.zcode.ideaplugin.protocol.model.SessionEvent) {
        // 面板已释放：dispose 摘监听器与杀进程之间存在竞态窗口，双保险在此拦断
        if (disposed) return
        // 多标签隔离：只推本面板订阅过的会话（其他标签的事件由各自的监听器推送）
        if (sessionId !in subscribedSessions) return

        // 回合生命周期 → 延迟切模型状态机（缺陷AC：见 streamingTurns 注释）。
        // 覆盖本面板订阅的全部会话（切模型只在当前会话触发，但当前会话一定已订阅）
        when (event.type) {
            "turn.started" -> streamingTurns[sessionId] = event.turnId
            "turn.completed", "turn.failed" -> {
                val wasStreaming = streamingTurns.containsKey(sessionId)
                streamingTurns.remove(sessionId)
                if (wasStreaming) applyPendingModelSwitch(sessionId)
            }
        }

        // 本标签当前会话的 turn 生命周期 → 标签「●」生成中状态
        if (sessionId == currentSessionId) {
            when (event.type) {
                "turn.started" -> setTabStreaming(true)
                "turn.completed", "turn.failed" -> setTabStreaming(false)
            }
        }

        // 每个流式事件一行，高频：debug 级防 log 风暴
        log.debug("[stream] event type=${event.type} seq=${event.seq} (forwarded to frontend)")
        val eventJson = buildJsonObject {
            put("type", event.type)
            put("seq", event.seq)
            put("sessionId", event.sessionId)
            event.turnId?.let { put("turnId", it) }
            put("timestamp", event.timestamp)
            put("payload", event.payload)
        }

        // 关键事件：立即 flush 缓冲 + 直接推送（保证 turn 生命周期即时响应）
        // state.updated（模式/思考级别/模型变化，含 ZCode 自动进出计划模式）也单推——低频且即时性重要
        val isLifecycle = event.type == "turn.started" ||
            event.type == "turn.completed" || event.type == "turn.failed" || event.type == "state.updated"
        if (isLifecycle) {
            flushStreamBuffer() // 先把积压的 delta 推掉
            sendToJsDirect(buildJsonObject {
                put("op", "streamEvent")
                put("sessionId", sessionId)
                put("event", eventJson)
            })
            return
        }

        // 普通 delta：进缓冲，启动节流 flusher
        streamBuffer.add(sessionId to eventJson)
        startStreamFlusher()
    }

    /** 启动节流 flusher（16ms 后合并推送，保证只有一个定时器在跑）*/
    private fun startStreamFlusher() {
        synchronized(streamFlushLock) {
            if (streamFlusherRunning) return
            streamFlusherRunning = true
        }
        // 单线程调度池延迟 16ms 执行：替代此前每窗口裸建 Thread（sleep 即弃，
        // 流式 60fps 下线程抖动明显），线程在首次调度时创建、复用常驻
        streamFlushScheduler.schedule({
            try {
                flushStreamBuffer()
            } finally {
                synchronized(streamFlushLock) { streamFlusherRunning = false }
            }
        }, 16, java.util.concurrent.TimeUnit.MILLISECONDS)
    }

    /** 流式缓冲 flush 调度器（面板级单线程，懒创建、守护线程） */
    private val streamFlushScheduler =
        java.util.concurrent.Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "zcode-stream-flush").apply { isDaemon = true }
        }

    /** 把缓冲区所有事件合并成一批推送 */
    private fun flushStreamBuffer() {
        val batch = mutableListOf<Pair<String, JsonObject>>()
        while (true) {
            val item = streamBuffer.poll() ?: break
            batch.add(item)
        }
        if (batch.isEmpty()) return

        // 按 sessionId 分组，每组一个 streamBatch 消息
        val grouped = batch.groupBy({ it.first }, { it.second })
        for ((sid, events) in grouped) {
            sendToJsDirect(buildJsonObject {
                put("op", "streamBatch")
                put("sessionId", sid)
                put("events", JsonArray(events))
            })
        }
    }

    /**
     * 直接推送（流式专用）。
     * 必须在 EDT 线程调 executeJavaScript（JCEF 要求），但合并后调用频率已降到 60fps，可接受。
     */
    private fun sendToJsDirect(msg: JsonObject) {
        // 懒加载标签未激活（JCEF 未创建）：丢弃流式推送
        if (!::jbCefBrowser.isInitialized) return
        val jsonStr = Json.encodeToString(JsonObject.serializer(), msg)
        val escapedForJs = jsonStr
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\t", "\\t")
            .replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029")
        val op = msg["op"]?.jsonPrimitive?.content ?: "?"
        val js = "try { var __m = JSON.parse(\"$escapedForJs\"); if(window.zcodeBridge) window.zcodeBridge.onMessage(__m); else console.error('[JCEF] zcodeBridge 未定义'); } catch(e) { console.error('[JCEF] push err:', e.message); }"
        SwingUtilities.invokeLater {
            try {
                jbCefBrowser.cefBrowser.executeJavaScript(js, "zcode-stream", 0)
            } catch (e: Exception) {
                log.warn("[stream] sendToJsDirect failed op=$op: ${e.message}")
            }
        }
    }

    /**
     * 停止当前 turn：簿记就地处理后挂停止序列线程（缺陷AD重审定案：V4 优先），
     * op=stopped 立即返回，前端 stopped 应答已复位等待态。
     * 挂起的延迟切模型不取消：停止只中止回合，模型选择是独立意图——终止帧
     * （真实/合成）到达后 applyPendingModelSwitch 照常落地所选模型。
     */
    private fun handleStop(msg: JsonObject): JsonObject {
        val sessionId = msg["sessionId"]?.jsonPrimitive?.content
            ?: return errorResponse("缺少 sessionId")
        // 前端账本里仍在跑的后台 bash 任务（exec_ id），随 stop 一并连带中止
        val extraTaskIds = msg["taskIds"]?.jsonArray
            ?.mapNotNull { it.jsonPrimitive.contentOrNull }
            ?.filter { it.isNotBlank() }
            ?: emptyList()
        try {
            // 手动打断不触发对话结束提醒（30s 内该会话的收尾事件被跳过）
            project.zCodeService().markManualStop(sessionId)
            scheduleStopSequence(sessionId, extraTaskIds)
            log.info("stop requested: $sessionId (extraTaskIds=$extraTaskIds)")
        } catch (e: Exception) {
            log.warn("stop failed: ${e.message}")
            return errorResponse("停止失败: ${e.message}")
        }
        return buildJsonObject {
            put("op", "stopped")
            put("sessionId", sessionId)
        }
    }

    /**
     * 停止序列（缺陷AD重审定案：V4 优先，老版本自动回退）：
     * v4 stop 先发（官方客户端同款运行时原语，diag 实测 0.16.1/0.16.5 均 ~40ms
     * 杀死在途回合）→ 失败（仅老到没有 v4 面的 CLI 会 -32601）→ 回退 session/stop
     * （那些版本上原生生效）。
     * 2s 验证：真实终止帧已到则簿记已被事件流清掉、直接收工；仍无帧时分两种——
     * v4 已受理 = 流式期引擎不发 legacy 帧（合成收口正确）；v4 未受理 = 两个通道都
     * 没杀掉回合，补射一次 v4（新版回归期 session/stop 是空操作），再 2s 仍无帧才
     * 合成；补射仍失败则放弃（回合自然结束，绝不给活回合合成完成帧）。
     * 回合 id 守卫：验证时发现已是新回合（用户新发）则不动作，防误杀。
     *
     * 连带中止后台任务（对齐官方客户端 stop 预期）：v4/legacy stop 只 abort 前台回合
     * （zcode.cjs edn/k9r 实证），后台化的子代理与 bash 任务设计上会存活。停完回合后
     * 立即取消——运行中子代理经 session/subagents 权威枚举（taskId=agentId，zcode.cjs
     * nDi 实证按 taskId 匹配），bash 后台任务 id 由前端账本随 stop 带上来；两类统一走
     * session/cancelBackgroundTask（runtime 按 taskType 分发：local_agent→subagentPort.
     * stopTask，local_bash→abort）。已随回合终止的任务取消返回 alreadyTerminal，幂等无害。
     */
    private fun scheduleStopSequence(sessionId: String, extraTaskIds: List<String> = emptyList()) {
        if (!streamingTurns.containsKey(sessionId)) return // 空闲态点停止：无在途回合，不动作
        val stoppedTurnId = streamingTurns[sessionId] // 可为 null（事件没带 turnId）
        Thread({
            if (disposed) return@Thread
            try {
                val client = project.zCodeService().getClient()
                var v4Accepted = false
                try {
                    val r = client.stopForegroundViaV4(sessionId)
                    v4Accepted = true
                    log.info("stop sequence: v4 stop accepted for $sessionId (status=${r["status"]})")
                } catch (e: Exception) {
                    // 老版本 CLI 无 v4 面（-32601）或其他错误：回退 session/stop（老 CLI 原生生效）
                    log.info("stop sequence: v4 stop unavailable/failed (${e.message}), falling back to session/stop")
                    try {
                        client.stop(sessionId)
                    } catch (e2: Exception) {
                        log.warn("stop sequence: session/stop also failed: ${e2.message}")
                    }
                }
                cancelRunningBackgroundTasks(client, sessionId, extraTaskIds)
                // 2s 验证：真实终止帧（工具期 v4 / 老版本原生路径）此时已到并清了簿记
                Thread.sleep(2000)
                if (stillSameTurn(sessionId, stoppedTurnId) && !v4Accepted) {
                    // 两个通道都没生效：补射一次 v4（幂等），给新版回归期一个二次机会
                    try {
                        val r = client.stopForegroundViaV4(sessionId)
                        v4Accepted = true
                        log.info("stop sequence: v4 stop retry accepted for $sessionId (status=${r["status"]})")
                    } catch (e: Exception) {
                        log.warn("stop sequence: v4 stop retry also failed (${e.message}), giving up")
                        return@Thread // 回合自然结束，不合成
                    }
                    Thread.sleep(2000)
                }
                if (!stillSameTurn(sessionId, stoppedTurnId)) return@Thread // 已终止或已是新回合
                log.warn("stop sequence: no terminal frame after stop, synthesizing turn.completed: $sessionId")
                pushStreamEvent(
                    sessionId,
                    com.zcode.ideaplugin.protocol.model.SessionEvent(
                        type = com.zcode.ideaplugin.protocol.model.EventTypes.TURN_COMPLETED,
                        seq = -1,
                        sessionId = sessionId,
                        timestamp = System.currentTimeMillis(),
                        traceId = null,
                        turnId = stoppedTurnId,
                        deliveryKind = null,
                        payload = buildJsonObject { put("synthetic", true) }
                    )
                )
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }, "zcode-stop-sequence").apply { isDaemon = true }.start()
    }

    /** 回合仍处于被停止的那个回合（存在且 turnId 未变）；已终止或用户新开回合则为 false */
    private fun stillSameTurn(sessionId: String, stoppedTurnId: String?): Boolean =
        synchronized(streamingTurns) {
            streamingTurns.containsKey(sessionId) && streamingTurns[sessionId] == stoppedTurnId
        }

    /**
     * 连带中止运行中的后台任务：session/subagents 枚举 running 子代理（agentId 优先，
     * 缺失兜底 toolCallId——id 不匹配时服务端返回 background_task_not_found，无害），
     * 加上前端账本带上来的 bash 后台任务 id，逐个 session/cancelBackgroundTask。
     * fail-soft：任一失败只记日志，不影响停止序列后续验证与合成收口。
     */
    private fun cancelRunningBackgroundTasks(
        client: com.zcode.ideaplugin.protocol.ZCodeProtocolClient,
        sessionId: String,
        extraTaskIds: List<String>,
    ) {
        val taskIds = LinkedHashSet(extraTaskIds)
        try {
            val data = client.subagents(sessionId)
            val running = data["running"]?.jsonArray ?: JsonArray(emptyList())
            for (item in running) {
                val obj = item.jsonObject
                val taskId = obj["agentId"]?.jsonPrimitive?.contentOrNull
                    ?: obj["toolCallId"]?.jsonPrimitive?.contentOrNull
                    ?: continue
                taskIds.add(taskId)
            }
        } catch (e: Exception) {
            log.warn("stop sequence: subagents query failed, cancel only frontend task ids: ${e.message}")
        }
        for (taskId in taskIds) {
            try {
                val r = client.cancelBackgroundTask(sessionId, taskId)
                log.info("stop sequence: background task cancelled: $sessionId/$taskId (result=$r)")
            } catch (e: Exception) {
                log.warn("stop sequence: background task cancel failed: $sessionId/$taskId (${e.message})")
            }
        }
    }

    private fun errorResponse(msg: String): JsonObject = buildJsonObject {
        put("op", "error")
        put("message", msg)
    }

    /** 新建标签页（前端「新标签页」按钮）：切 EDT 创建新 Content 并选中 */
    private fun handleCreateTab(): JsonObject {
        SwingUtilities.invokeLater {
            try {
                val toolWindow = ZCodeToolWindowFactory.getToolWindow(project)
                if (toolWindow == null) {
                    log.warn("createTab failed: ZCode ToolWindow not found")
                    return@invokeLater
                }
                ZCodeToolWindowFactory.createNewTab(project, toolWindow)
                log.info("createTab succeeded")
            } catch (e: Exception) {
                log.error("createTab failed", e)
            }
        }
        return buildJsonObject { put("op", "tabCreating") }
    }

    /**
     * 内嵌浏览器开关（Header「浏览器」按钮）：展示/收起本会话面板的浏览器分栏。
     * 区别于浏览器工具条的「收起」：这是主界面快捷开关，同样保障聊天区宽度不变
     * （弹出加宽 / 收起还原）。
     */
    private fun handleToggleBrowserPane(): JsonObject {
        val visible = toggleEmbeddedBrowser()
        return buildJsonObject {
            put("op", "browserPaneToggled")
            put("visible", visible)
        }
    }

    /** 处理前端的 askUserResponse（用户选择后回传，转发 Service 层协调器）*/
    private fun handleAskUserResponse(msg: JsonObject): JsonObject {
        val requestId = msg["requestId"]?.jsonPrimitive?.content
            ?: return errorResponse("缺少 requestId")
        val action = msg["action"]?.jsonPrimitive?.content ?: "accept"
        // 答案结构：单问题 answer（string | string[]），多问题 answers（问题文本 → 值）
        val answer = msg["answer"]
        val answers = msg["answers"]?.jsonObject
        return project.zCodeService().completeUserInput(requestId, action, answer, answers)
    }

    /** 前端 init 拉取反向请求挂起状态（新开标签/页面重载错过广播的看门狗豁免兜底）*/
    private fun handleAskUserPendingState(): JsonObject {
        project.zCodeService().pushAskUserPendingState(this)
        return buildJsonObject { put("op", "askUserStateAck") }
    }

    /**
     * 文件列表（@文件补全用）
     *
     * 扫描项目目录下的代码文件，按 query 过滤，限 50 个。
     * 用 VFS（虚拟文件系统）递归扫，跳过 node_modules/.git/build 等。
     */
    private fun handleListFiles(msg: JsonObject): JsonObject {
        val query = msg["query"]?.jsonPrimitive?.content?.lowercase() ?: ""
        val basePath = project.basePath
            ?: return buildJsonObject { put("op", "files"); put("files", JsonArray(emptyList())) }

        val files = mutableListOf<String>()
        val ignoredDirs = setOf("node_modules", ".git", "build", "dist", "out", ".gradle", ".idea", "target", "__pycache__")
        // 常见代码文件扩展名
        val codeExts = setOf(
            "kt", "java", "py", "ts", "tsx", "js", "jsx", "json", "yaml", "yml",
            "xml", "html", "css", "less", "scss", "md", "sql", "go", "rs", "c", "cpp", "h",
            "sh", "bat", "gradle", "properties", "toml"
        )

        try {
            val baseVfs = com.intellij.openapi.vfs.LocalFileSystem.getInstance().findFileByPath(basePath)
            if (baseVfs != null && baseVfs.isDirectory) {
                // 递归扫描（BFS，限深度 5 层）
                val queue = ArrayDeque<Pair<com.intellij.openapi.vfs.VirtualFile, Int>>()
                queue.add(baseVfs to 0)
                while (queue.isNotEmpty() && files.size < 50) {
                    val (dir, depth) = queue.removeFirst()
                    if (depth > 5) continue
                    for (child in dir.children) {
                        if (files.size >= 50) break
                        val name = child.name
                        if (child.isDirectory) {
                            if (name !in ignoredDirs && !name.startsWith(".")) {
                                queue.add(child to depth + 1)
                            }
                        } else {
                            val ext = name.substringAfterLast('.', "").lowercase()
                            if (ext in codeExts) {
                                // 相对路径（更短，补全更友好）
                                val relPath = child.path.removePrefix(basePath).replace('\\', '/').trimStart('/')
                                if (query.isEmpty() || relPath.lowercase().contains(query) || name.lowercase().contains(query)) {
                                    files.add(relPath)
                                }
                            }
                        }
                    }
                }
            }
        } catch (e: Exception) {
            log.warn("File scan failed: ${e.message}")
        }

        files.sortBy { it.length } // 短路径优先（通常更相关）
        return buildJsonObject {
            put("op", "files")
            put("files", JsonArray(files.take(50).map { JsonPrimitive(it) }))
        }
    }

    /**
     * 斜杠命令列表（输入框 / 快捷选择用）
     *
     * 磁盘扫描（SlashCommandScanner）：用户级 + 工作区级 skills/commands + 插件贡献。
     * query 过滤在前端做（数据量小），这里返回全量。
     */
    private fun handleListCommands(msg: JsonObject): JsonObject {
        val commands = SlashCommandScanner.scan(project.basePath)
        log.info("Slash command scan completed, ${commands.size} item(s)")
        return buildJsonObject {
            put("op", "commands")
            put("commands", JsonArray(commands.map { c ->
                buildJsonObject {
                    put("name", c.name)
                    c.description?.let { put("description", it) }
                    put("kind", c.kind)
                    put("source", c.source)
                }
            }))
        }
    }

    /** 路径归一化：统一分隔符 + 去尾部分隔符 + Windows 大小写折叠，用于 workspace 匹配 */
    private fun normalizePath(p: String): String {
        val base = p.replace('\\', '/').trimEnd('/')
        return if (SystemInfo.isWindows) base.lowercase() else base
    }

    /**
     * op=listMemoryFiles — 记忆文件清单（设置页「记忆」条目）
     *
     * 指令记忆（MemoryFileScanner）：全局 ~/.zcode/AGENTS.md + 项目根 AGENTS.md，
     * 缺失项也返回（前端提供创建入口）；另含 ZCode 自动记忆
     * （~/.zcode/cli/memories/projects/<key>/memory/，只读展示）。
     * 附带 memoryEnabled（~/.zcode/v2/setting.json 的「工作区记忆」开关，与客户端共用）。
     */
    private fun handleListMemoryFiles(msg: JsonObject): JsonObject {
        val files = MemoryFileScanner.list(project.basePath)
        return buildJsonObject {
            put("op", "memoryFiles")
            put("memoryEnabled", ZCodeClientSettingStore.readRuntimePrefs().memoryEnabled)
            put("memorySettingPath", ZCodeClientSettingStore.settingPath().absolutePath)
            put("files", JsonArray(files.map { f ->
                buildJsonObject {
                    put("name", f.name)
                    put("scope", f.scope)
                    put("kind", f.kind)
                    put("path", f.path)
                    put("exists", f.exists)
                    f.sizeBytes?.let { put("sizeBytes", it) }
                    f.lastModified?.let { put("lastModified", it) }
                    put("description", f.description)
                    f.title?.let { put("title", it) }
                }
            }))
        }
    }

    /**
     * op=createMemoryFile — 创建缺失的记忆文件（写默认模板）并自动在编辑器打开
     *
     * path 必须来自 listMemoryFiles 返回的清单项（防任意路径写入），
     * 已存在的文件不覆盖（createWithTemplate 内部短路）。
     */
    private fun handleCreateMemoryFile(msg: JsonObject): JsonObject {
        val path = msg["path"]?.jsonPrimitive?.content
            ?: return errorResponse("缺少 path")
        val target = MemoryFileScanner.list(project.basePath)
            .firstOrNull { it.path == path }
            ?: return errorResponse("path 不在记忆文件清单内")
        if (!MemoryFileScanner.createWithTemplate(target)) {
            return errorResponse("创建失败: $path")
        }
        log.info("Memory file created: $path")
        // VFS 刷新 + 编辑器打开需 EDT（分隔符统一为 /，Windows 下 File.absolutePath 是 \）
        com.intellij.openapi.application.invokeLater {
            val vfile = LocalFileSystem.getInstance().refreshAndFindFileByPath(path.replace('\\', '/'))
            if (vfile != null) {
                FileEditorManager.getInstance(project).openFile(vfile, true)
            }
        }
        return buildJsonObject {
            put("op", "memoryFileCreated")
            put("path", path)
        }
    }

    /**
     * op=setMemoryEnabled — 切换「工作区记忆」开关（写 ~/.zcode/v2/setting.json，
     * 与 ZCode 客户端共用同一份配置；requestRuntimePreferences 应答即时读取，
     * 新建会话生效，已在跑的会话不受影响）
     */
    private fun handleSetMemoryEnabled(msg: JsonObject): JsonObject {
        val enabled = msg["enabled"]?.jsonPrimitive?.boolean
            ?: return errorResponse("缺少 enabled")
        if (!ZCodeClientSettingStore.writeMemoryEnabled(enabled)) {
            return errorResponse("写入 setting.json 失败")
        }
        log.info("Workspace memory ${if (enabled) "enabled" else "disabled"} (shared with ZCode client via ~/.zcode/v2/setting.json)")
        return buildJsonObject {
            put("op", "memoryEnabledChanged")
            put("enabled", enabled)
        }
    }

    // ============ 浏览器设置（设置页「浏览器」条目；与 ZCode 客户端公用配置）============

    /**
     * op=browserConfig — 浏览器设置快照：
     * browserControlEnabled（data 目录判据）/ pluginInstalled（cache 树校验）
     */
    private fun handleBrowserConfig(): JsonObject {
        return buildJsonObject {
            put("op", "browserConfig")
            put("browserControlEnabled", ZCodeBrowserSettingStore.isBrowserControlEnabled())
            put("pluginInstalled", ZCodeBrowserSettingStore.isPluginInstalled())
        }
    }

    /**
     * op=clearBrowserData — 清除内置浏览器数据（mode=cache 只清 HTTP 缓存 +
     * Cache Storage + Service Worker；all 追加 Cookie/localStorage/IndexedDB）。
     * 详情实现与能力边界见 ZCodeBrowserExecutor.clearBrowsingData。
     */
    private fun handleClearBrowserData(msg: JsonObject): JsonObject {
        val all = msg["mode"]?.jsonPrimitive?.contentOrNull == "all"
        val executor = project.zCodeService().getBrowserExecutor()
            ?: return errorResponse("浏览器执行器未初始化（请先打开一次聊天界面）")
        return try {
            executor.clearBrowsingData(all)
        } catch (e: Exception) {
            log.warn("clearBrowserData failed: ${e.message}")
            errorResponse("清除失败: ${e.message}")
        }
    }

    /**
     * op=browserDataOverview — 浏览器数据概览（清理条目旁「查看」按钮；只读）：
     * 磁盘目录占用 + Cookie 计数与 top 域 + 已打开站点的缓存/SW/localStorage 计数。
     */
    private fun handleBrowserDataOverview(): JsonObject {
        val executor = project.zCodeService().getBrowserExecutor()
            ?: return errorResponse("浏览器执行器未初始化（请先打开一次聊天界面）")
        return try {
            executor.browseDataOverview()
        } catch (e: Exception) {
            log.warn("browserDataOverview failed: ${e.message}")
            errorResponse("读取概览失败: ${e.message}")
        }
    }

    /**
     * op=listSkills — 技能清单（设置页「技能」条目）
     *
     * SkillScanner 扫描全局/项目/插件三来源（junction 真实路径去重），
     * enabled 判定自 ~/.zcode/cli/config.json 的 skill 节点（CLI 同源机制）。
     */
    private fun handleListSkills(msg: JsonObject): JsonObject {
        val skills = SkillScanner.scan(project.basePath)
        log.info("Skill scan completed, ${skills.size} item(s)")
        return buildJsonObject {
            put("op", "skills")
            put("skills", JsonArray(skills.map { s ->
                buildJsonObject {
                    put("name", s.name)
                    s.description?.let { put("description", it) }
                    s.whenToUse?.let { put("whenToUse", it) }
                    put("path", s.path)
                    put("directory", s.directory)
                    put("scope", s.scope)
                    put("source", s.source)
                    s.pluginName?.let { put("pluginName", it) }
                    put("enabled", s.enabled)
                }
            }))
        }
    }

    /**
     * op=toggleSkill — 启用/禁用技能
     *
     * 写 ~/.zcode/cli/config.json 的 skill 节点（{<SKILL.md路径>:{enable:false}}），
     * CLI 下次技能发现时生效（禁用条目会被剔除，与 zcode skills list 行为一致）。
     * path 必须来自扫描结果（防任意 key 写入 config）。
     */
    private fun handleToggleSkill(msg: JsonObject): JsonObject {
        val path = msg["path"]?.jsonPrimitive?.content
            ?: return errorResponse("缺少 path")
        val enabled = msg["enabled"]?.jsonPrimitive?.boolean
            ?: return errorResponse("缺少 enabled")
        val known = SkillScanner.scan(project.basePath).any { it.path == path }
        if (!known) return errorResponse("path 不在技能清单内")
        if (!SkillScanner.setSkillEnabled(path, enabled)) {
            return errorResponse("写入 config 失败: $path")
        }
        log.info("Skill ${if (enabled) "enabled" else "disabled"}: $path")
        return buildJsonObject {
            put("op", "skillToggled")
            put("path", path)
            put("enabled", enabled)
        }
    }

    // ============ 提示词润色 ============

    /**
     * 润色系统指令（CC-GUI PromptEnhancerHandler 骨架中文化）。
     * 关键实测教训：不带强约束时模型会输出大量解释/表格（2026-08-23 CLI 实测），
     * 故规则前置且明确禁止解释、前后缀、Markdown 标题与追加提问。
     */
    private val enhanceSystemPrompt = """
你是一名提示词优化专家。用户会发送一条待润色的提示词，请输出润色后的版本。

[输出规则]
1. 只输出润色后的提示词本身——不要任何解释、前言、后记、注释或确认语
2. 不要使用「润色后的提示词：」等前缀，不要使用 Markdown 标题或列表包装（除非原文本身需要）
3. 不要向用户提问，输出必须可直接复制使用
4. 润色后的提示词必须与原始提示词使用相同的语言（中文→中文、英文→英文）

[润色原则]
1. 严格保留用户原意，不引入原文没有的新要求
2. 修正错别字、标点与语病，使用清晰、专业的表达
3. 补充必要的上下文指代与细节（把「这个」「它」等模糊指代具体化），但不过度扩写
4. 原文过于简短含糊时，补充合理的假设与约束，使其成为一条完整可执行的指令
5. 保持简洁——润色是打磨，不是扩写
""".trim()

    /** 润色单飞标志：同一时刻只允许一个润色子进程（按钮已禁用，双保险） */
    private val enhanceInProgress = java.util.concurrent.atomic.AtomicBoolean(false)

    /**
     * 润色专用固定临时工作区：不存在则创建（幂等）。
     * 创建失败返回 null → CLI 不带 --cwd（回退进程当前目录），润色仍可用。
     */
    private fun enhanceWorkspacePath(): String? = runCatching {
        java.nio.file.Files.createDirectories(
            java.nio.file.Path.of(System.getProperty("java.io.tmpdir"), "zcode-gui-enhance"),
        ).toString()
    }.onFailure { log.warn("enhancePrompt: create temp workspace failed: ${it.message}" ) }
        .getOrNull()

    /**
     * op=enhancePrompt — 提示词润色
     *
     * 通道优先级（2026-08-26 实测定案）：
     * 1. **快速通道**：常驻 app-server 的 `workspace/generateText`（裸 AI SDK 调用，
     *    实测 input 30 token vs CLI 通道 14858，无进程冷启动，不产生会话记录）。
     *    provider 未注册时经 `workspace/upsertModelProvider` 幂等补注册后重试一次。
     * 2. **降级通道**：CLI 一次性 headless 调用（`zcode -p --json --mode yolo`，无 --resume），
     *    快速通道不可用（app-server 未起/协议错/超时）时兜底，零会话污染。
     *
     * 模型按前端 currentModel 透传的 providerId/modelId；缺失时回退 config.json 默认
     * provider。CLI 通道超时按输入长度动态放大：45s 基础 + 每 400 字符 1s，上限 120s。
     *
     * workspace 固定为临时目录 %TEMP%/zcode-gui-enhance（2026-08-23 sqlite 实测）：
     * CLI 会话按 --cwd 归属 project，挂当前项目会令每次润色在会话列表多出一条记录；
     * 挂固定临时目录则会话归到独立 temp project，不出现在任何真实项目列表，
     * 所有润色共用一个 temp project 也避免了 project 记录累积。
     * （generateText 通道不产生会话，workspace 用当前项目以复用会话的 warm app。）
     */
    private fun handleEnhancePrompt(msg: JsonObject): JsonObject {
        val text = msg["text"]?.jsonPrimitive?.content
            ?: return enhanceError("缺少 text")
        if (text.isBlank()) return enhanceError("输入内容为空")
        if (!enhanceInProgress.compareAndSet(false, true)) {
            return enhanceError("润色进行中，请稍候")
        }
        try {
            val providerId = msg["providerId"]?.jsonPrimitive?.contentOrNull
            val modelId = msg["modelId"]?.jsonPrimitive?.contentOrNull
            val result = enhanceViaGenerateText(providerId, modelId, text)
                ?: enhanceViaCliOneShot(providerId, modelId, text)
                    ?: return enhanceError("润色结果为空")
            val (enhanced, model) = result
            log.info("enhancePrompt done (${enhanced.length} chars, model=$model)")
            return buildJsonObject {
                put("op", "enhancePromptResult")
                put("original", text)
                put("text", enhanced)
                put("model", model)
            }
        } catch (e: Exception) {
            log.warn("enhancePrompt failed: ${LogRedactor.redact(e.toString())}")
            return enhanceError("润色失败: ${e.message}")
        } finally {
            enhanceInProgress.set(false)
        }
    }

    /**
     * 快速通道：常驻 app-server 的 workspace/generateText。
     *
     * 模型解析优先级：前端透传（润色专用模型 > 会话当前模型）→ config.json 默认
     * provider；透传模型失效（provider 已删/订阅过期，config.json 构造不出
     * runtimeModel）时直接回退默认 provider，不降级 CLI。
     *
     * @return 润色文本 to 实际模型；通道不可用返回 null 交上层降级 CLI，异常不上抛。
     */
    private fun enhanceViaGenerateText(providerId: String?, modelId: String?, text: String): Pair<String, String>? {
        val workspacePath = project.basePath ?: return null
        return try {
            val client = project.zCodeService().getClient()
            val fallbackModel = com.zcode.ideaplugin.protocol.RuntimeModels.defaultRuntimeModel()
                ?.get("model")?.jsonObject
            var pid = providerId?.takeIf { it.isNotBlank() }
            var mid = modelId?.takeIf { it.isNotBlank() }
            if (pid == null || mid == null) {
                pid = fallbackModel?.get("providerId")?.jsonPrimitive?.contentOrNull ?: return null
                mid = fallbackModel?.get("modelId")?.jsonPrimitive?.contentOrNull ?: return null
            } else if (com.zcode.ideaplugin.protocol.RuntimeModels.buildRuntimeModel(pid, mid) == null) {
                // 专用/会话模型已失效：回退默认 provider（fallback 不可用才放弃本通道）
                log.info("enhancePrompt: model $pid/$mid unavailable in config.json, falling back to default")
                pid = fallbackModel?.get("providerId")?.jsonPrimitive?.contentOrNull ?: return null
                mid = fallbackModel?.get("modelId")?.jsonPrimitive?.contentOrNull ?: return null
            }
            val timeoutMs = (45_000L + text.length / 400L * 1_000L).coerceAtMost(120_000L)
            try {
                callGenerateText(client, workspacePath, pid, mid, text, timeoutMs)
            } catch (e: com.zcode.ideaplugin.protocol.ZCodeProtocolException) {
                // -32603 = modelRef 指向的 provider 不在 workspace 目录（如 app-server 刚起
                // 还没有任何会话 setModel 过）：幂等补注册后重试一次，仍失败才放弃本通道
                if (e.code != -32603 || !e.message.orEmpty().contains("not configured", ignoreCase = true)) throw e
                log.info("enhancePrompt: provider not in workspace catalog, upserting and retrying")
                val providerDef = com.zcode.ideaplugin.protocol.RuntimeModels
                    .buildRuntimeModel(pid, mid)
                    ?.get("provider")?.jsonObject ?: return null
                client.upsertModelProvider(workspacePath, providerDef)
                callGenerateText(client, workspacePath, pid, mid, text, timeoutMs)
            }
        } catch (e: Exception) {
            log.info("enhancePrompt: generateText channel unavailable (${e.message?.take(150)}), falling back to CLI")
            null
        }
    }

    /** generateText 调用 + 空结果判定（空文本按通道失败处理）；返回 文本 to modelId */
    private fun callGenerateText(
        client: com.zcode.ideaplugin.protocol.ZCodeProtocolClient,
        workspacePath: String,
        providerId: String,
        modelId: String,
        text: String,
        timeoutMs: Long,
    ): Pair<String, String> {
        val result = client.generateText(
            workspacePath = workspacePath,
            providerId = providerId,
            modelId = modelId,
            prompt = text,
            systemPrompt = enhanceSystemPrompt,
            querySource = "workspace_prompt_enhance",
            timeoutMs = timeoutMs,
        )
        val enhanced = result["text"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }
            ?: throw com.zcode.ideaplugin.protocol.ZCodeProtocolException("generateText 返回空文本")
        val actualModel = result["modelRef"]?.jsonObject?.get("modelId")?.jsonPrimitive?.contentOrNull ?: modelId
        return enhanced to actualModel
    }

    /**
     * 降级通道：CLI 一次性 headless 调用（原润色实现，保留为兜底）。
     *
     * @return 润色文本 to 模型；结果为空返回 null（上层转「润色结果为空」错误）。
     */
    private fun enhanceViaCliOneShot(providerId: String?, modelId: String?, text: String): Pair<String, String>? {
        val credentialsOverride = if (!providerId.isNullOrBlank() && !modelId.isNullOrBlank()) {
            com.zcode.ideaplugin.protocol.Credentials.credentialsFor(providerId, modelId)
        } else null
        if (providerId != null && credentialsOverride == null) {
            log.info("enhancePrompt: credentials for $providerId/$modelId unavailable, falling back to default")
        }
        val timeoutMs = (45_000L + text.length / 400L * 1_000L).coerceAtMost(120_000L)
        val prompt = buildString {
            append(enhanceSystemPrompt)
            append("\n\n待润色的原始提示词：\n")
            append(text)
        }
        val client = project.zCodeService().getClient()
        val result = client.cliOneShot(
            prompt = prompt,
            workspacePath = enhanceWorkspacePath(),
            credentialsOverride = credentialsOverride,
            timeoutMs = timeoutMs,
        )
        val enhanced = result["response"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() } ?: return null
        return enhanced to (credentialsOverride?.model ?: "default")
    }

    /** 润色失败统一回包（专用 op：前端弹窗错误态与全局 error 栏分流）*/
    private fun enhanceError(message: String): JsonObject = buildJsonObject {
        put("op", "enhancePromptResult")
        put("error", message)
    }

    // ============ 子智能体（数据打通 ZCode 客户端） ============

    /** op=listAgents — 子智能体清单（user + project 作用域，disabled 已过滤） */
    private fun handleListAgents(msg: JsonObject): JsonObject {
        val agents = AgentScanner.scan(project.basePath)
        log.info("Agent scan completed, ${agents.size} item(s)")
        return buildJsonObject {
            put("op", "agents")
            put("agents", JsonArray(agents.map { a -> agentDefJson(a) }))
        }
    }

    /**
     * op=saveAgent — 新建/更新/改名子智能体（写 <作用域>/agents/<name>.md）
     * 校验对齐 zcode.cjs：name 命中 NAME_RE、description 非空；改名时旧文件清理。
     */
    private fun handleSaveAgent(msg: JsonObject): JsonObject {
        val scope = msg["scope"]?.jsonPrimitive?.content ?: "user"
        if (scope !in setOf("user", "project")) return errorResponse("无效作用域: $scope")
        val obj = msg["agent"]?.jsonObject ?: return errorResponse("缺少 agent")
        val def = parseAgentDef(obj, scope) ?: return errorResponse(
            "子智能体字段无效：名称必填且仅限小写字母/数字/._-（开头须字母或数字），描述与系统提示词不能为空"
        )
        val originalName = msg["originalName"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotEmpty() }
        if (originalName != null && !AgentScanner.NAME_RE.matches(originalName)) {
            return errorResponse("原名称无效: $originalName")
        }
        // 同作用域重名（除自身改名场景）拒绝
        val clash = AgentScanner.scan(project.basePath)
            .any { it.scope == scope && it.name == def.name && it.name != originalName }
        if (clash) return errorResponse("同名子智能体已存在: ${def.name}")
        if (!AgentScanner.save(scope, def, originalName, project.basePath)) {
            return errorResponse("写入失败（目录不可写？）")
        }
        log.info("Agent saved: ${def.name} (scope=$scope, renamedFrom=$originalName)")
        return buildJsonObject {
            put("op", "agentSaved")
            put("name", def.name)
            put("scope", scope)
        }
    }

    /** op=deleteAgent — 删除子智能体定义文件 */
    private fun handleDeleteAgent(msg: JsonObject): JsonObject {
        val scope = msg["scope"]?.jsonPrimitive?.content ?: return errorResponse("缺少 scope")
        val name = msg["name"]?.jsonPrimitive?.content ?: return errorResponse("缺少 name")
        if (!AgentScanner.NAME_RE.matches(name)) return errorResponse("名称无效: $name")
        if (!AgentScanner.delete(scope, name, project.basePath)) {
            return errorResponse("删除失败（文件不存在或目录不可写）")
        }
        log.info("Agent deleted: $name (scope=$scope)")
        return buildJsonObject {
            put("op", "agentDeleted")
            put("name", name)
            put("scope", scope)
        }
    }

    private fun agentDefJson(a: AgentScanner.AgentDef): JsonObject = buildJsonObject {
        put("name", a.name)
        put("description", a.description)
        a.model?.let { put("model", it) }
        a.thoughtLevel?.let { put("thoughtLevel", it) }
        a.color?.let { put("color", it) }
        put("tools", JsonArray(a.tools.map { JsonPrimitive(it) }))
        put("disallowedTools", JsonArray(a.disallowedTools.map { JsonPrimitive(it) }))
        a.maxTurns?.let { put("maxTurns", it) }
        put("injectAgentsMd", a.injectAgentsMd)
        put("mcpServers", JsonArray(a.mcpServers.map { JsonPrimitive(it) }))
        put("systemPrompt", a.systemPrompt)
        put("path", a.path)
        put("scope", a.scope)
    }

    /** 前端 agent 对象 → AgentDef（null = 字段无效） */
    private fun parseAgentDef(obj: JsonObject, scope: String): AgentScanner.AgentDef? {
        val name = obj["name"]?.jsonPrimitive?.contentOrNull?.trim() ?: return null
        val description = obj["description"]?.jsonPrimitive?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val systemPrompt = obj["systemPrompt"]?.jsonPrimitive?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        if (!AgentScanner.NAME_RE.matches(name)) return null
        val color = obj["color"]?.jsonPrimitive?.contentOrNull?.takeIf { it in AgentScanner.COLORS }
        return AgentScanner.AgentDef(
            name = name,
            description = description,
            model = obj["model"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotEmpty() && it != "inherit" },
            thoughtLevel = obj["thoughtLevel"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotEmpty() },
            color = color,
            tools = obj["tools"]?.jsonArray?.mapNotNull { it.jsonPrimitive.contentOrNull } ?: emptyList(),
            disallowedTools = obj["disallowedTools"]?.jsonArray?.mapNotNull { it.jsonPrimitive.contentOrNull } ?: emptyList(),
            maxTurns = obj["maxTurns"]?.jsonPrimitive?.contentOrNull?.toIntOrNull(),
            injectAgentsMd = obj["injectAgentsMd"]?.jsonPrimitive?.boolean ?: true,
            mcpServers = obj["mcpServers"]?.jsonArray?.mapNotNull { it.jsonPrimitive.contentOrNull } ?: emptyList(),
            systemPrompt = systemPrompt,
            path = obj["path"]?.jsonPrimitive?.contentOrNull ?: "",
            scope = scope,
        )
    }


    /**
     * op=listMcpServers — MCP 服务器清单（设置页「MCP」条目）
     *
     * 磁盘配置（McpConfigReader 三来源）为基准 + RPC mcp/list 状态按名合并。
     * ⚠️ 插件 spawn 的 app-server 不会自己发现磁盘上的 MCP 配置（不传参时
     * statuses 恒空——已实测），connect 模式必须把磁盘扫描到的服务器定义
     * 显式转成 mcpServers 参数传入（McpConfigReader.toProtocolParam，含
     * ${CLAUDE_PLUGIN_ROOT} 等占位符替换），才能拿到真实连接状态。
     *
     * 状态兜底链（RPC statuses 未覆盖某服务器时）：enabled=false→disabled →
     * 连接日志推断最近终态（connected/failed/…，宿主 ZCode 的真实连接也落
     * 同一份日志）→ 默认 disconnected。「未知」只留给 RPC 整体失败。
     *
     * mode：status=本进程状态快照（不实际连接）；connect=真实连接（慢，60s）。
     */
    private fun handleListMcpServers(msg: JsonObject): JsonObject {
        val mode = msg["mode"]?.jsonPrimitive?.content?.takeIf { it == "connect" } ?: "status"
        val servers = McpConfigReader.scan(project.basePath).toMutableList()

        // 0. 宿主内置插件 MCP（CLI 内置注册表声明的 hostMcpServerNames，如
        // browser-use → node_repl）：定义不在任何磁盘配置里（注册表硬编码在
        // zcode.cjs），按 plugins/list 补齐；RPC 失败静默降级不影响磁盘条目
        val basePath = project.basePath
        if (basePath != null) {
            runCatching {
                appendHostPluginMcpServers(servers, project.zCodeService().getClient(), basePath)
            }.onFailure { log.warn("plugins/list (host built-in MCP) failed: ${it.message}") }
        }

        var rpcError: String? = null
        if (basePath != null) {
            try {
                val client = project.zCodeService().getClient()
                val timeout = if (mode == "connect") 60_000L else 20_000L
                val statuses: JsonObject = if (mode == "connect") {
                    // 显式传参：磁盘配置 → 协议 schema（enabled=false 的跳过）
                    val paramServers = servers.mapNotNull { McpConfigReader.toProtocolParam(it, basePath) }
                    val params = buildJsonObject {
                        put("workspace", buildJsonObject {
                            put("workspacePath", basePath)
                            put("workspaceKey", basePath)
                        })
                        put("mode", mode)
                        if (paramServers.isNotEmpty()) put("mcpServers", JsonArray(paramServers))
                    }
                    client.rawMcpList(params, timeout, mode)["statuses"]?.jsonObject ?: JsonObject(emptyMap())
                } else {
                    client.listMcpServers(basePath, mode, timeout)["statuses"]?.jsonObject ?: JsonObject(emptyMap())
                }

                // 配置条目合并状态（transport/status 以 RPC 为准，command/url 等保留配置）
                val logs = runCatching { McpLogReader.readRecent(500) }.getOrDefault(emptyList())
                servers.replaceAll { s ->
                    val st = statuses[s.name]?.jsonObject
                    val inferred = inferFromLogs(s.name, logs)
                    val status = when {
                        st != null -> st["status"]?.jsonPrimitive?.contentOrNull
                        !s.enabled -> "disabled"
                        else -> inferred?.first ?: "disconnected"
                    }
                    if (st == null) {
                        // RPC 无此服务器（宿主条目恒走此分支）：工具数从 connected 日志兜底
                        s.copy(status = status, toolCount = inferred?.second ?: s.toolCount)
                    } else s.copy(
                        transport = st["transport"]?.jsonPrimitive?.contentOrNull ?: s.transport,
                        status = status,
                        toolCount = st["toolCount"]?.jsonPrimitive?.contentOrNull?.toIntOrNull(),
                        statusError = st["error"]?.jsonPrimitive?.contentOrNull,
                        updatedAt = st["updatedAt"]?.jsonPrimitive?.contentOrNull,
                    )
                }
                // RPC 有但磁盘配置没有的 → 运行时条目（如会话临时注入的服务器）
                val known = servers.map { it.name }.toSet()
                statuses.forEach { (name, st) ->
                    if (name in known) return@forEach
                    val so = runCatching { st.jsonObject }.getOrNull() ?: return@forEach
                    servers.add(
                        McpConfigReader.McpServerInfo(
                            name = name,
                            scope = "runtime",
                            transport = so["transport"]?.jsonPrimitive?.contentOrNull ?: "stdio",
                            command = null, args = emptyList(), url = null, envKeys = emptyList(),
                            envValues = emptyMap(), headerValues = emptyMap(),
                            enabled = true,
                            configPath = "",
                            pluginName = null,
                            status = so["status"]?.jsonPrimitive?.contentOrNull,
                            toolCount = so["toolCount"]?.jsonPrimitive?.contentOrNull?.toIntOrNull(),
                            statusError = so["error"]?.jsonPrimitive?.contentOrNull,
                            updatedAt = so["updatedAt"]?.jsonPrimitive?.contentOrNull,
                        )
                    )
                }
            } catch (e: Exception) {
                log.warn("mcp/list($mode) failed: ${e.message}")
                rpcError = e.message
            }
        } else {
            rpcError = "项目路径不可用"
        }

        // connect 模式：宿主内置条目不参与 RPC 传参（会话自动连，11:04 类失败后
        // app-server 内无重试入口）——「检测连接」时插件侧直连探测刷新状态：
        // McpToolsClient 走 modern 信封握手（同款启动命令，探测完销毁进程），
        // 成功 → connected + 工具数；失败 → failed + 可读错误
        if (mode == "connect" && basePath != null) {
            servers.replaceAll { s ->
                if (s.scope != "host") s
                else runCatching {
                    val tools = McpToolsClient.listTools(s, basePath, 30_000L)
                    log.info("Host MCP direct probe [${s.name}] succeeded, ${tools.size} tool(s)")
                    s.copy(status = "connected", toolCount = tools.size, statusError = null)
                }.getOrElse { e ->
                    log.warn("Host MCP direct probe [${s.name}] failed: ${e.message}")
                    s.copy(status = "failed", statusError = e.message?.take(200))
                }
            }
        }

        // RPC 失败时也给出可读状态（日志兜底），「未知」不再是常态
        if (rpcError != null) {
            val logs = runCatching { McpLogReader.readRecent(500) }.getOrDefault(emptyList())
            servers.replaceAll { s ->
                if (s.status != null) s
                else s.copy(status = if (!s.enabled) "disabled" else inferFromLogs(s.name, logs)?.first ?: "disconnected")
            }
        }

        return buildJsonObject {
            put("op", "mcpServers")
            put("mode", mode)
            put("servers", JsonArray(servers.map { s ->
                buildJsonObject {
                    put("name", s.name)
                    put("scope", s.scope)
                    put("transport", s.transport)
                    s.command?.let { put("command", it) }
                    if (s.args.isNotEmpty()) put("args", JsonArray(s.args.map { JsonPrimitive(it) }))
                    s.url?.let { put("url", it) }
                    if (s.envKeys.isNotEmpty()) put("envKeys", JsonArray(s.envKeys.map { JsonPrimitive(it) }))
                    put("enabled", s.enabled)
                    put("configPath", s.configPath)
                    s.pluginName?.let { put("pluginName", it) }
                    s.status?.let { put("status", it) }
                    s.toolCount?.let { put("toolCount", it) }
                    s.statusError?.let { put("statusError", it) }
                    s.updatedAt?.let { put("updatedAt", it) }
                }
            }))
            rpcError?.let { put("rpcError", it) }
        }
    }

    /**
     * op=mcpServerTools — 单台 MCP 服务器的工具清单（设置页「MCP」卡片展开区）
     *
     * 协议 mcp/list 只有 toolCount 无明细 → McpToolsClient 自己连一次服务器
     * 调 tools/list（stdio 起进程 / http 按 Streamable POST）。
     * 必须在后台线程调用（handler 已在 pooled thread），单台 45s 超时。
     * 失败走 {error} 字段不抛异常，前端卡片内联展示 + 可重试。
     */
    private fun handleMcpServerTools(msg: JsonObject): JsonObject {
        val name = msg["name"]?.jsonPrimitive?.contentOrNull
            ?: return errorResponse("缺少 name")
        val force = msg["force"]?.jsonPrimitive?.contentOrNull == "true"
        fun resp(tools: List<McpToolsClient.McpToolInfo>? = null, error: String? = null) = buildJsonObject {
            put("op", "mcpServerTools")
            put("name", name)
            if (force) put("force", true)
            tools?.let { list ->
                put("toolCount", list.size)
                put("tools", JsonArray(list.map { t ->
                    buildJsonObject {
                        put("name", t.name)
                        t.description?.let { d -> put("description", d) }
                    }
                }))
            }
            error?.let { put("error", it) }
        }

        // 磁盘三来源 + 宿主内置插件条目（node_repl 等不在磁盘配置，plugins/list 合成）
        val basePath = project.basePath
        var server = McpConfigReader.scan(basePath).find { it.name == name }
        if (server == null && basePath != null) {
            val hostServers = mutableListOf<McpConfigReader.McpServerInfo>()
            runCatching { appendHostPluginMcpServers(hostServers, project.zCodeService().getClient(), basePath) }
            server = hostServers.find { it.name == name }
        }
        if (server == null) return resp(error = "未在磁盘配置与宿主内置插件中找到该服务器（会话临时注入的无法获取工具列表）")
        if (!server.enabled) return resp(error = "服务器已禁用")
        return try {
            val tools = McpToolsClient.listTools(server, project.basePath ?: ".")
            log.info("MCP tool list [$name] fetched, ${tools.size} item(s)")
            resp(tools = tools)
        } catch (e: Exception) {
            log.warn("MCP tool list [$name] fetch failed: ${e.message}")
            resp(error = e.message ?: "未知错误")
        }
    }

    /** 从连接日志推断服务器最近状态与工具数（从新到旧找第一条生命周期事件；无记录 null）*/
    private fun inferFromLogs(name: String, logs: List<McpLogReader.McpLogEntry>): Pair<String, Int?>? {
        for (e in logs.asReversed()) {
            if (e.serverName != name) continue
            return when (e.event) {
                "mcp.server.connected" -> "connected" to e.toolCount
                "mcp.server.failed" -> "failed" to null
                "mcp.server.connect.started", "mcp.server.reconnect.started" -> "connecting" to null
                "mcp.server.connection_lost", "mcp.server.closed", "mcp.pool.connection.closed" -> "disconnected" to null
                else -> continue
            }
        }
        return null
    }

    /**
     * 宿主内置插件 MCP 条目合成（MCP 列表第四来源，scope=host）
     *
     * CLI 内置插件注册表（zcode.cjs 硬编码，browser-use@0.2.1 携带
     * hostMcpServerNames=["node_repl"]）声明的服务器由 CLI 会话自动以
     * `node zcode.cjs __zcode-plugin-host <插件根>/dist/mcp/server.js` 拉起
     * （插件根取 ~/.zcode/cli/plugins/cache 下的已安装副本）——定义不在任何
     * 用户可读的磁盘配置里，McpConfigReader 三来源扫描天然读不到。
     * 这里按 plugins/list 的 hostMcpServerNames + rootPath 补齐：
     *   - server.js 存在 → 合成真实 command/args（工具列表可直连实测）
     *   - 插件 enabled=false → 条目仍列出（enabled=false，卡片呈关闭态）
     *   - 同名已有条目（用户自配同名服务器）跳过，磁盘配置优先
     */
    private fun appendHostPluginMcpServers(
        out: MutableList<McpConfigReader.McpServerInfo>,
        client: ZCodeProtocolClient,
        basePath: String,
    ) {
        val plugins = runCatching { client.listPlugins(basePath)["plugins"]?.jsonArray }.getOrNull() ?: return
        // 展示与工具列表直连用的启动参数（与 CLI 实际拉起方式一致；解析失败回退 node）
        val env = runCatching { com.zcode.ideaplugin.env.ZCodeEnvChecker.resolveForStart() }.getOrNull()
        val nodeCmd = env?.nodePath?.takeIf { it.isNotBlank() } ?: "node"
        for (el in plugins) {
            val p = runCatching { el.jsonObject }.getOrNull() ?: continue
            val pluginName = p["name"]?.jsonPrimitive?.contentOrNull ?: continue
            val hostNames = runCatching { p["hostMcpServerNames"]?.jsonArray }.getOrNull() ?: continue
            val pluginEnabled = runCatching { p["enabled"]?.jsonPrimitive?.boolean }.getOrNull() ?: true
            val rootPath = p["rootPath"]?.jsonPrimitive?.contentOrNull
            for (n in hostNames) {
                val name = runCatching { n.jsonPrimitive.content }.getOrNull() ?: continue
                if (out.any { it.name == name }) continue
                // CLI 约定的 server 入口（内置插件 requiredSeedPaths 同名文件）
                val serverJs = rootPath?.let { java.io.File(java.io.File(it), "dist/mcp/server.js") }?.takeIf { it.isFile }
                out.add(
                    McpConfigReader.McpServerInfo(
                        name = name,
                        scope = "host",
                        transport = "stdio",
                        command = serverJs?.let { nodeCmd },
                        args = serverJs?.let { listOf(env?.zcodePath?.toString() ?: "zcode.cjs", "__zcode-plugin-host", it.absolutePath) } ?: emptyList(),
                        url = null,
                        envKeys = emptyList(),
                        envValues = emptyMap(),
                        headerValues = emptyMap(),
                        enabled = pluginEnabled,
                        configPath = "",
                        pluginName = pluginName,
                        cwd = null,
                        status = null,
                        toolCount = null,
                        statusError = null,
                        updatedAt = null,
                    )
                )
            }
        }
    }

    /**
     * op=getMcpLogs — MCP 连接日志（设置页「MCP → 连接日志」）
     *
     * 读 ZCode CLI 落盘的结构化日志（~/.zcode/cli/log/zcode-<日期>.jsonl 的
     * mcp.* 事件，今天+昨天文件尾部 3MB），最近 200 条。
     * 与 mcp/list 的 connect 检测互补：RPC 只回最终状态，这里有连接过程
     * （started → connected 耗时/工具数 / failed 的 error+stderr）。
     */
    private fun handleGetMcpLogs(msg: JsonObject): JsonObject {
        val logs = McpLogReader.readRecent()
        log.info("MCP log read completed, ${logs.size} line(s)")
        return buildJsonObject {
            put("op", "mcpLogs")
            put("logs", JsonArray(logs.map { e ->
                buildJsonObject {
                    put("timestamp", e.timestamp)
                    put("level", e.level)
                    put("event", e.event)
                    put("serverName", e.serverName)
                    put("message", e.message)
                    e.durationMs?.let { put("durationMs", it) }
                }
            }))
        }
    }

    /** 初始 HTML（后续替换为打包的 React UI） */
    private fun buildInitialHtml(jsQuery: JBCefJSQuery): String {
        // JBCefJSQuery 注入的 JS 函数名（如 cefQuery_1015760238_1）
        // 这个函数接受一个对象 {request: "...", persistent: false, onSuccess: fn, onFailure: fn}
        // 它会触发 Java 端 addHandler 注册的回调，request 字符串就是传给 Java 的内容
        val funcName = jsQuery.funcName
        log.info("JS function name in use: $funcName")

        return """
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { font-family: -apple-system, 'Segoe UI', sans-serif; margin: 8px; color: #ddd; background: #2b2b2b; font-size: 13px; }
  h2 { font-size: 14px; margin: 8px 0; color: #bbb; }
  button { padding: 4px 10px; cursor: pointer; background: #2d4f8f; color: #fff; border: none; border-radius: 3px; }
  button:disabled { background: #555; cursor: not-allowed; }
  #sessions { list-style:none; padding:0; margin:0; }
  #sessions li { padding:6px 8px; border-bottom: 1px solid #3a3a3a; cursor:pointer; }
  #sessions li:hover { background: #3a3a3a; }
  #sessions li.active { background: #2d4f8f; }
  .meta { font-size:11px; color:#888; margin-top:2px; }
  #detail { flex:1; overflow:auto; padding: 8px; border:1px solid #3a3a3a; margin-top:8px; min-height:200px; background: #1e1e1e;}
  .msg { margin: 6px 0; padding:8px; border-radius:4px; white-space: pre-wrap; word-wrap: break-word; }
  .msg.user { background:#1e3a5f; }
  .msg.assistant { background:#2a2a2a; }
  #input { display:flex; gap:4px; margin-top:8px; }
  #input input { flex:1; padding:6px 8px; background:#1e1e1e; color:#ddd; border:1px solid #3a3a3a; border-radius:3px;}
  #status { font-size:11px; color:#888; margin-top:4px; min-height: 16px; }
  .header { display:flex; justify-content:space-between; align-items:center; }
  .header button { padding: 2px 8px; font-size: 11px; }
</style>
</head>
<body>
  <div class="header">
    <h2>ZCode Sessions</h2>
    <button id="newBtn" onclick="createSession()">+ New</button>
  </div>
  <ul id="sessions"><li class="meta">loading...</li></ul>
  <div id="detail"></div>
  <div id="input">
    <input id="text" placeholder="发消息（先选会话）..." disabled/>
    <button id="sendBtn" disabled onclick="sendMessage()">Send</button>
  </div>
  <div id="status"></div>

<script>
  // === JS→Java 桥 ===
  // JBCefJSQuery 注入的函数名（如 cefQuery_1015760238_1），是 window 的属性
  var CEF_QUERY = window['$funcName'];

  window.sendToJava = function(msg) {
    if (typeof CEF_QUERY !== 'function') {
      console.error('CEF_QUERY 函数不可用: $funcName', typeof window['$funcName']);
      document.getElementById('status').textContent = 'ERROR: CEF bridge not ready';
      return;
    }
    try {
      CEF_QUERY({
        request: JSON.stringify(msg),
        persistent: false,
        onSuccess: function(response) { /* Java 端的 Response，这里不用 */ },
        onFailure: function(err) { console.error('query failed', err); }
      });
    } catch(e) {
      console.error('sendToJava 异常', e);
    }
  };

  // Java→JS 回调（通过 executeJavaScript 调用）
  window.zcodeBridge = {
    onMessage: function(msg) {
      try {
        // msg 可能是字符串（旧路径）或对象（新路径）
        if (typeof msg === 'string') msg = JSON.parse(msg);
        handleJavaMessage(msg);
      } catch(e) {
        console.error('onMessage error', e);
        document.getElementById('status').innerHTML = '<span style="color:#f44">JS ERROR: ' + escapeHtml(e.message) + '</span>';
      }
    }
  };

  // 调试：把所有错误显示到页面上
  window.onerror = function(msg, url, line, col, error) {
    document.getElementById('status').innerHTML = '<span style="color:#f44">JS ERROR: ' + escapeHtml(String(msg)) + ' (line ' + line + ')</span>';
    return false;
  };

  var currentSession = null;
  var currentWorkspace = '';

  function setStatus(s) { document.getElementById('status').textContent = s; }

  function loadSessions() {
    setStatus('loading sessions...');
    window.sendToJava({ op: 'listSessions' });
  }

  function createSession() {
    setStatus('creating session...');
    window.sendToJava({ op: 'createSession' });
  }

  function handleJavaMessage(msg) {
    if (msg.op === 'listSessions') {
      renderSessions(msg.sessions || []);
      setStatus('loaded ' + (msg.sessions||[]).length + ' sessions');
    } else if (msg.op === 'createSession') {
      setStatus('created: ' + msg.sessionId);
      loadSessions();
    } else if (msg.op === 'messages') {
      renderMessages(msg.messages || []);
      setStatus('');
    } else if (msg.op === 'sendAccepted') {
      setStatus('sent, accepted=' + msg.accepted + ', waiting for reply...');
      setTimeout(function(){ loadMessages(msg.sessionId, currentWorkspace); }, 3000);
    } else if (msg.op === 'error') {
      setStatus('ERROR: ' + msg.message);
    }
  }

  function renderSessions(sessions) {
    var ul = document.getElementById('sessions');
    ul.innerHTML = '';
    if (sessions.length === 0) {
      ul.innerHTML = '<li class="meta">no sessions, click +New</li>';
      return;
    }
    sessions.forEach(function(s) {
      var li = document.createElement('li');
      li.innerHTML = '<div>' + escapeHtml(s.title || s.sessionId.slice(0,12)) + '</div>' +
                     '<div class="meta">' + escapeHtml(s.status) + ' · ' + escapeHtml((s.workspace||'').slice(-30)) + '</div>';
      li.onclick = function() {
        currentSession = s.sessionId;
        currentWorkspace = s.workspace || '';
        document.querySelectorAll('#sessions li').forEach(function(x){ x.classList.remove('active'); });
        li.classList.add('active');
        document.getElementById('text').disabled = false;
        document.getElementById('sendBtn').disabled = false;
        loadMessages(s.sessionId, currentWorkspace);
      };
      ul.appendChild(li);
    });
  }

  function loadMessages(sessionId, workspacePath) {
    setStatus('loading messages...');
    window.sendToJava({ op: 'messages', sessionId: sessionId, workspacePath: workspacePath || '' });
  }

  function renderMessages(messages) {
    var d = document.getElementById('detail');
    d.innerHTML = '';
    messages.forEach(function(m) {
      // ZCode 消息结构：{ info: { role, ... }, parts: [{ type, text }, ...] }
      // 兼容旧格式：{ role, content }
      var role = (m.info && m.info.role) || m.role || 'assistant';
      var parts = m.parts || m.content || [];
      var text = '';
      if (typeof parts === 'string') {
        text = parts;
      } else if (Array.isArray(parts)) {
        text = parts.map(function(b){
          if (!b || typeof b !== 'object') return '';
          if (b.type === 'text') return b.text || '';
          if (b.type === 'tool_use' || b.type === 'tool-call') return '[🔧 ' + (b.name || b.toolName || 'tool') + ']';
          if (b.type === 'tool_result' || b.type === 'tool-result') {
            var c = b.content || b.result || '';
            return '[结果] ' + (typeof c === 'string' ? c.slice(0,200) : JSON.stringify(c).slice(0,200));
          }
          if (b.type === 'thinking') return '[思考] ' + (b.text || b.thinking || '').slice(0,200);
          return '';
        }).join('\n');
      }
      var div = document.createElement('div');
      div.className = 'msg ' + role;
      div.textContent = (text || '(empty)').slice(0, 3000);
      d.appendChild(div);
    });
    d.scrollTop = d.scrollHeight;
  }

  function sendMessage() {
    if (!currentSession) return;
    var t = document.getElementById('text');
    if (!t.value.trim()) return;
    window.sendToJava({ op: 'send', sessionId: currentSession, text: t.value, workspacePath: currentWorkspace });
    t.value = '';
  }
  document.getElementById('text').addEventListener('keydown', function(e){
    if (e.key === 'Enter') sendMessage();
  });

  function escapeHtml(s) {
    return String(s||'').replace(/[&<>"]/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];
    });
  }

  // 启动
  setTimeout(loadSessions, 500);
</script>
</body>
</html>
        """.trimIndent()
    }

    private fun createUnsupportedPanel(): JComponent {
        val panel = JPanel(BorderLayout())
        panel.background = JBColor.background()
        val label = JLabel(com.zcode.ideaplugin.ZCodeBundle.message("panel.jcefUnsupported.html"))
        panel.add(label, BorderLayout.CENTER)
        return panel
    }
}
