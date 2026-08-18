package com.zcode.ideaplugin.ui

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
import com.zcode.ideaplugin.protocol.ZCodeProtocolClient
import com.zcode.ideaplugin.protocol.ZCodeProtocolException
import com.zcode.ideaplugin.protocol.SessionStat
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import java.awt.BorderLayout
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

    // ============ 释放状态 ============
    @Volatile
    private var disposed = false
    // 主题监听连接（dispose 时断开）
    private var themeBusConn: com.intellij.util.messages.MessageBusConnection? = null

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
                    log.info("检测到关闭时浏览器展开，准备还原 TW 宽度到聊天基准宽 $base")
                    SwingUtilities.invokeLater { tryRestoreWidth(base, 10) }
                }
            }
        } catch (e: Exception) {
            log.warn("重启宽度还原失败: ${e.message}")
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
            log.info("重启还原 ToolWindow 宽度：$current → $base（纯聊天宽度）")
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
            log.info("标签懒加载就绪（JCEF 未创建，切到本标签时激活；initialSessionId=$initialSessionId）")
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
        log.info("懒加载标签激活，创建 JCEF 面板（initialSessionId=$initialSessionId）")
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
        log.info("初始化 JCEF 面板")
        jbCefBrowser = JBCefBrowser()

        // ============ JS → Java：用 JBCefJSQuery（官方推荐，签名稳定）============
        jsQuery = JBCefJSQuery.create(jbCefBrowser)
        log.info("JBCefJSQuery 创建成功，funcName=${jsQuery.funcName}")
        jsQuery.addHandler { request ->
            if (!frontendReady) {
                val op = Regex("\"op\"\\s*:\\s*\"([^\"]+)\"").find(request)?.groupValues?.get(1) ?: "?"
                // __jsLog 只是诊断回传（可能是崩溃报告），不算前端就绪
                if (op != "__jsLog") {
                    frontendReady = true
                    log.info("前端已就绪：首条 JS 消息到达（op=$op，面板创建后 ${System.currentTimeMillis() - panelCreatedAt}ms）")
                }
            }
            log.info("收到 JS 消息: ${request.take(200)}")
            handleJsMessage(request)
            JBCefJSQuery.Response("ok")
        }

        // ============ 观测：页面加载状态 + 前端 console 转发（排查白屏用）============
        // 2026-08-15 白屏故障的教训：executeJavaScript 是 fire-and-forget，渲染进程死掉也不报错，
        // 必须靠 loadError / console 日志才能看到渲染层发生了什么
        registerDiagnostics()

        // ============ 加载 webview（dev 优先 → 生产 → fallback）============
        loadWebview()
        // AskUser/ExitPlanMode 协调器在 Service 层注册（多标签共享一个协议 handler）
        project.zCodeService().ensureUserInputHandler()
        // browser-use 宿主执行器（AI 浏览器工具）同样在 Service 层注册一次
        project.zCodeService().ensureBrowserExecutor()

        // 开启 JCEF 外部链接（开发期）
        jbCefBrowser.setOpenLinksInExternalBrowser(true)

        // 移除懒加载占位（如有）
        lazyPlaceholder?.let { remove(it) }
        lazyPlaceholder = null
        add(jbCefBrowser.component, BorderLayout.CENTER)
        log.info("JCEF 面板初始化完成")
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
                    log.info("[webview-load] onLoadEnd httpStatus=$httpStatusCode（页面加载完成）")
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
                    log.info("[webview-load] onLoadError（良性 ERR_ABORTED）")
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
                log.info("IDE 主题变化，推送给前端")
                pushTheme()
            }
        )
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
                log.warn("推送主题失败: ${e.message}")
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

        if (isDevServerAlive(devUrl)) {
            // dev 模式：连 vite dev server
            log.info("检测到 dev server，加载 $devUrl（dev 模式，HMR）")
            jbCefBrowser.loadURL(devUrl)
            return
        }

        // 生产首选：内置静态资源 server
        val baseUrl = ZCodeWebviewServer.baseUrl()
        if (baseUrl != null) {
            log.info("加载内置 server $baseUrl/（生产多文件模式，真实 origin + sourcemap 可调试）")
            jbCefBrowser.loadURL("$baseUrl/")
            return
        }

        // 生产 fallback：读 singlefile 单 HTML
        val bundledHtml = readBundledWebview()
        if (bundledHtml != null) {
            log.info("加载 resources/webview-single/index.html（singlefile fallback，长度=${bundledHtml.length}）")
            // 把桥变量注入到 HTML 的 <head> 最前面（DOMContentLoaded 前可用）
            val htmlWithBridge = injectBridgeIntoHtml(bundledHtml)
            jbCefBrowser.loadHTML(htmlWithBridge)
            return
        }

        // fallback：旧的 inline HTML（内含自己的 sendToJava 定义）
        log.info("无打包产物且无 dev server，使用 fallback inline HTML")
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
            log.warn("读取 resources/webview-single/index.html 失败: ${e.message}")
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
                log.warn("注入桥变量失败: ${e.message}")
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
                log.warn("JS 消息缺少 op 字段")
                sendToJs(errorResponse("缺少 op")); return
            }
            // 前端诊断日志直落 idea.log（不走 pooled thread，量大也无协议调用）
            if (op == "__jsLog") {
                val level = msg["level"]?.jsonPrimitive?.content ?: "?"
                val text = msg["text"]?.jsonPrimitive?.content ?: ""
                log.warn("[webview-console] [$level] $text")
                return
            }
            log.info("处理 op=$op")

            ApplicationManager.getApplication().executeOnPooledThread {
                try {
                    val result = when (op) {
                        "listSessions" -> handleListSessions(msg)
                        "send" -> handleSend(msg)
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
                        "listSkills" -> handleListSkills(msg)
                        "toggleSkill" -> handleToggleSkill(msg)
                        "listMcpServers" -> handleListMcpServers(msg)
                        "mcpServerTools" -> handleMcpServerTools(msg)
                        "getMcpLogs" -> handleGetMcpLogs(msg)
                        "askUserResponse" -> handleAskUserResponse(msg)
                        "deleteSession" -> handleDeleteSession(msg)
                        "listModels" -> handleListModels(msg)
                        "modelManageList" -> handleModelManageList(msg)
                        "modelToggleProvider" -> handleModelToggleProvider(msg)
                        "setModel" -> handleSetModel(msg)
                        "getSettings" -> handleGetSettings(msg)
                        "setThoughtLevel" -> handleSetThoughtLevel(msg)
                        "setMode" -> handleSetMode(msg)
                        "pickFiles" -> handlePickFiles(msg)
                        "getUsage" -> handleGetUsage(msg)
                        "getQuota" -> handleGetQuota(msg)
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
                    log.info("op=$op 处理完成，发送回 JS")
                    sendToJs(result)
                } catch (e: com.zcode.ideaplugin.env.EnvCheckException) {
                    // 环境前置检查失败：附带完整 EnvStatus，前端据此渲染环境提醒条
                    log.warn("op=$op 环境检查失败: ${e.message}")
                    sendToJs(buildJsonObject {
                        put("op", "error")
                        put("message", e.message)
                        put("envStatus", com.zcode.ideaplugin.env.ZCodeEnvChecker.statusJson(e.status))
                    })
                } catch (e: Exception) {
                    log.error("op=$op 处理失败", e)
                    sendToJs(errorResponse("处理失败: ${e.message}"))
                }
            }
        } catch (e: Exception) {
            log.error("JS 消息解析失败: ${request.take(100)}", e)
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
            log.info("外观配置已保存")
            broadcastAppearance(cfg)
        } catch (e: Exception) {
            log.warn("外观配置保存失败: ${e.message}")
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
                    log.warn("外观同步推送失败（标签 sessionId=${panel.currentSessionId}）: ${e.message}")
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
            log.warn("webview kv 保存失败: ${e.message}")
        }
        return buildJsonObject { put("op", "kvSave") }
    }

    // ============ 运行环境检测与配置（参考 cc-gui NodePathHandler）============

    /** 环境三件套状态查询（30s 缓存，spawn node --version 不再重复探测） */
    private fun handleCheckEnv(): JsonObject {
        val status = com.zcode.ideaplugin.env.ZCodeEnvChecker.check()
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
            log.warn("环境配置变更后关闭旧 app-server 失败: ${e.message}")
        }
        // 旧进程上的订阅与全局监听器全部作废（含其他标签），下次 subscribe 重新走完整注册
        activePanels.forEach { it.resetSubscriptionState() }

        val status = com.zcode.ideaplugin.env.ZCodeEnvChecker.check(force = true)
        broadcastEnvStatus(status)
        log.info("环境配置已保存并重新检测: allOk=${status.allOk}, node=${status.node.path}, cli=${status.cli.path}")
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
                    log.warn("环境状态同步推送失败: ${e.message}")
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
                    log.warn("语言同步推送失败（标签 sessionId=${panel.currentSessionId}）: ${e.message}")
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
        log.info("会话内嵌浏览器分栏已显示（${if (migrateWidth > 0) "自其他标签迁移，浏览器宽=$migrateWidth" else "新建挂载/重新展开"}）")
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
        log.info("内嵌浏览器已随标签切换迁移挂载")
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
            log.warn("选中会话 Content 失败: ${e.message}")
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
                log.warn("调整 ToolWindow 宽度失败: ${e.message}")
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
        log.info("会话内嵌浏览器分栏已收起（实例保留，ToolWindow 宽度还原）")
    }

    /** Content 销毁时释放 JCEF 资源（content.setDisposer(panel) 绑定）*/
    override fun dispose() {
        if (disposed) return
        disposed = true
        activePanels.remove(this)
        log.info("释放标签面板（sessionId=$currentSessionId）")
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
            log.warn("摘除内嵌浏览器挂载失败: ${e.message}")
        }
        embeddedBrowser = null
        embeddedSplit = null
        try {
            themeBusConn?.dispose()
        } catch (e: Exception) {
            log.warn("断开主题监听失败: ${e.message}")
        }
        try {
            if (::jsQuery.isInitialized) Disposer.dispose(jsQuery)
        } catch (e: Exception) {
            log.warn("释放 jsQuery 失败: ${e.message}")
        }
        try {
            if (::jbCefBrowser.isInitialized) Disposer.dispose(jbCefBrowser)
        } catch (e: Exception) {
            log.warn("释放 JCEF browser 失败: ${e.message}")
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
            log.info("sendToJs 跳过（JCEF 未创建，懒加载标签未激活）op=${msg["op"]?.jsonPrimitive?.content}")
            return
        }
        val jsonStr = Json.encodeToString(JsonObject.serializer(), msg)
        log.info("sendToJs 准备发送，JSON 长度=${jsonStr.length}, 前 80 字符=${jsonStr.take(80)}")
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
                log.info("sendToJs executeJavaScript 调用成功")
            } catch (e: Exception) {
                log.warn("sendToJs 失败（JCEF 可能未就绪）: ${e.message}")
            }
        }
    }

    private fun handleListSessions(msg: JsonObject): JsonObject {
        log.info("开始获取会话列表")
        val service = project.zCodeService()
        log.info("ZCodeService 获取成功: ${service.javaClass.name}")
        val client = service.getClient()
        log.info("ZCodeProtocolClient 获取成功, isAlive=${client.isAlive()}")

        // workspace 过滤：只显示当前项目的会话（差异化优势，cc-gui 不做）
        // 前端传 workspacePath；没传则用 project.basePath；空串表示不过滤（返回全部）
        val workspacePath = msg["workspacePath"]?.jsonPrimitive?.content
            ?: project.basePath
            ?: ""
        // 服务端过滤（按项目 + 大 limit），避免 app-server 默认"全库最新 50 条"截断；
        // 客户端 normalizePath 过滤保留作兜底
        val sessions = if (workspacePath.isEmpty()) {
            client.listSessions()
        } else {
            client.listSessions(workspacePath)
        }
        log.info("listSessions(workspace=$workspacePath) 返回 ${sessions.size} 个会话")

        val filtered = if (workspacePath.isEmpty()) {
            sessions
        } else {
            val normalized = normalizePath(workspacePath)
            sessions.filter { s ->
                val ws = s.workspace?.workspacePath
                ws != null && normalizePath(ws) == normalized
            }
        }
        log.info("workspace=$workspacePath 过滤后 ${filtered.size} 个会话")

        // 会话统计（消息数/内容大小，直读 db.sqlite；失败内部已降级空 map，字段缺省前端不显示）
        val stats: Map<String, SessionStat> = client.getSessionStats()

        val sessionsJson = JsonArray(filtered.map { s ->
            buildJsonObject {
                put("sessionId", s.sessionId)
                put("title", s.title)
                put("status", s.status)
                put("mode", s.mode)
                put("workspacePath", s.workspace?.workspacePath ?: "")
                put("workspaceKey", s.workspace?.workspaceKey ?: "")
                put("createdAt", s.createdAt)
                put("updatedAt", s.updatedAt)
                stats[s.sessionId]?.let { st ->
                    put("messageCount", st.messageCount)
                    put("sizeBytes", st.sizeBytes)
                }
            }
        })
        return buildJsonObject {
            put("op", "listSessions")
            put("sessions", sessionsJson)
        }
    }

    private fun handleCreateSession(msg: JsonObject): JsonObject {
        val workspacePath = msg["workspacePath"]?.jsonPrimitive?.content
            ?: project.basePath
            ?: System.getProperty("user.dir")
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
            log.info("删除会话成功: $sessionId")
        } catch (e: Exception) {
            log.warn("删除会话失败: ${e.message}")
            return errorResponse("删除失败: ${e.message}")
        }
        // 从已 subscribe 集合中移除
        subscribedSessions.remove(sessionId)
        return buildJsonObject {
            put("op", "sessionDeleted")
            put("sessionId", sessionId)
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
            log.warn("config.json 不存在: $configFile")
            return buildJsonObject {
                put("op", "models")
                put("models", JsonArray(emptyList()))
            }
        }
        val providers = try {
            json.parseToJsonElement(configFile.readText()).jsonObject["provider"]?.jsonObject
        } catch (e: Exception) {
            log.warn("解析 config.json 失败: ${e.message}")
            null
        } ?: return buildJsonObject {
            put("op", "models")
            put("models", JsonArray(emptyList()))
        }

        val models = JsonArray(providers.mapNotNull { (providerId, providerEl) ->
            val pv = providerEl.jsonObject
            // enabled 缺省视为启用（config.json 现状：DeepSeek 无 enabled 字段但已启用）
            val enabled = pv["enabled"]?.jsonPrimitive?.content?.toBoolean() ?: true
            if (!enabled) return@mapNotNull null
            val options = pv["options"]?.jsonObject ?: return@mapNotNull null
            val baseURL = options["baseURL"]?.jsonPrimitive?.content ?: return@mapNotNull null
            // apiKey 缺失 = 无效配置（GUI 残留的未完成 provider），直接过滤；
            // 同模型多 provider 变体各自保留——旧的跨 provider 去重兜底随本过滤一并移除
            val apiKey = options["apiKey"]?.jsonPrimitive?.contentOrNull
            if (apiKey.isNullOrBlank()) return@mapNotNull null
            val providerName = pv["name"]?.jsonPrimitive?.content ?: providerId
            val modelsObj = pv["models"]?.jsonObject ?: return@mapNotNull null
            modelsObj.mapNotNull { (modelId, modelEl) ->
                val modelObj = modelEl.jsonObject
                val modelName = modelObj["name"]?.jsonPrimitive?.content ?: modelId
                // limit.context / limit.output：模型真实上下文窗口与最大输出（config.json）
                // 例：GLM-5.2 context=1000000 / GLM-5-Turbo context=204800
                val limit = modelObj["limit"]?.jsonObject
                buildJsonObject {
                    put("providerId", providerId)
                    put("providerName", providerName)
                    builtinPlanOf(providerId)?.let { put("plan", it) }
                    put("modelId", modelId)
                    put("modelName", modelName)
                    limit?.get("context")?.jsonPrimitive?.content?.toLongOrNull()?.let { put("contextWindow", it) }
                    limit?.get("output")?.jsonPrimitive?.content?.toLongOrNull()?.let { put("maxOutput", it) }
                }
            }
        }.flatten())
        log.info("listModels 返回 ${models.size} 个模型（${providers.size} 个 provider）")
        return buildJsonObject {
            put("op", "models")
            put("models", models)
        }
    }

    /**
     * op=modelManageList — 设置页「模型管理」清单（支持启用/禁用切换）。
     *
     * 与 listModels（聊天切换用）的差异：不去重、不滤 disabled（返回 enabled 标记）、
     * 保留无 baseURL 的 provider；共同口径：apiKey 缺失的无效 provider 一律过滤。
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
            log.warn("config.json 不存在: $configPath")
            return emptyResult()
        }
        val providers = try {
            json.parseToJsonElement(configPath.toFile().readText()).jsonObject["provider"]?.jsonObject
        } catch (e: Exception) {
            log.warn("解析 config.json 失败: ${e.message}")
            null
        } ?: return emptyResult()

        val providerArr = JsonArray(providers.mapNotNull { (providerId, providerEl) ->
            val pv = providerEl.jsonObject
            val options = pv["options"]?.jsonObject
            // apiKey 缺失 = 无效配置（与聊天下拉 listModels 同口径），管理页同样不展示
            val apiKey = options?.get("apiKey")?.jsonPrimitive?.contentOrNull
            if (apiKey.isNullOrBlank()) return@mapNotNull null
            // enabled 缺省视为启用（与 listModels/额度查询口径一致）
            val enabled = pv["enabled"]?.jsonPrimitive?.contentOrNull?.toBoolean() ?: true
            val providerName = pv["name"]?.jsonPrimitive?.contentOrNull ?: providerId
            val baseURL = options?.get("baseURL")?.jsonPrimitive?.contentOrNull
            val models = JsonArray(pv["models"]?.jsonObject?.map { (modelId, modelEl) ->
                val modelObj = modelEl.jsonObject
                val modelName = modelObj["name"]?.jsonPrimitive?.contentOrNull ?: modelId
                val limit = modelObj["limit"]?.jsonObject
                buildJsonObject {
                    put("modelId", modelId)
                    put("modelName", modelName)
                    limit?.get("context")?.jsonPrimitive?.contentOrNull?.toLongOrNull()?.let { put("contextWindow", it) }
                    limit?.get("output")?.jsonPrimitive?.contentOrNull?.toLongOrNull()?.let { put("maxOutput", it) }
                }
            } ?: emptyList())
            buildJsonObject {
                put("providerId", providerId)
                put("providerName", providerName)
                builtinPlanOf(providerId)?.let { put("plan", it) }
                put("enabled", enabled)
                baseURL?.let { put("baseURL", it) }
                put("models", models)
            }
        })
        val modelCount = providerArr.sumOf { it.jsonObject["models"]?.jsonArray?.size ?: 0 }
        log.info("modelManageList 返回 ${providerArr.size} 个 provider / $modelCount 个模型")
        return buildJsonObject {
            put("op", "modelManage")
            put("configPath", configPath.toString())
            put("providers", providerArr)
        }
    }

    /**
     * op=modelToggleProvider — 设置页切换 provider 启用/禁用，写回 config.json。
     *
     * 写回策略（config.json 是含凭证的关键文件，比 cli/config.json 更谨慎）：
     * 仅改 provider.<id>.enabled 字段，其余节点 LinkedHashMap 保序原样保留；
     * 写前备份 .bak，tmp + Files.move 原子替换，失败时从备份回滚。
     * 内置套餐互斥（对齐 Zcode 客户端）：启用任一 builtin: 套餐时，其余内置套餐一并
     * 禁用；回包 changes 携带全部实际变更项，前端按数组刷新。
     * 禁用后 CLI 下次发现生效；进行中的会话不受影响。
     */
    private fun handleModelToggleProvider(msg: JsonObject): JsonObject {
        val providerId = msg["providerId"]?.jsonPrimitive?.contentOrNull
            ?: return errorResponse("缺少 providerId")
        val enabled = msg["enabled"]?.jsonPrimitive?.contentOrNull?.toBooleanStrictOrNull()
            ?: return errorResponse("缺少 enabled")

        val configPath = Credentials.defaultConfigPath()
        if (!java.nio.file.Files.isRegularFile(configPath)) {
            return errorResponse("config.json 不存在: $configPath")
        }
        val file = configPath.toFile()
        val root = try {
            json.parseToJsonElement(file.readText(Charsets.UTF_8)).jsonObject
        } catch (e: Exception) {
            log.warn("解析 config.json 失败: ${e.message}")
            return errorResponse("解析 config.json 失败")
        }
        val providersObj = root["provider"]?.let { runCatching { it.jsonObject }.getOrNull() }
        if (providersObj == null || providersObj[providerId] == null) {
            return errorResponse("provider 不存在: $providerId")
        }

        // 变更集：目标 provider + （启用内置套餐时）其余内置套餐联动禁用（互斥）
        data class Change(val id: String, val newEnabled: Boolean)
        val changes = mutableListOf(Change(providerId, enabled))
        val mutexOthers = enabled && providerId.startsWith("builtin:")
        if (mutexOthers) {
            providersObj.keys.forEach { id ->
                if (id != providerId && id.startsWith("builtin:") &&
                    (providersObj[id]!!.jsonObject["enabled"]?.jsonPrimitive?.contentOrNull?.toBoolean() ?: true)
                ) {
                    changes.add(Change(id, false))
                }
            }
        }

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
            log.info("modelToggleProvider: $changeDesc 已写回 $configPath")
        } catch (e: Exception) {
            log.warn("写回 config.json 失败: ${e.message}")
            return errorResponse("写回失败: ${e.message}")
        }
        return buildJsonObject {
            put("op", "modelToggled")
            put("changes", JsonArray(changes.map { c ->
                buildJsonObject {
                    put("providerId", c.id)
                    put("enabled", c.newEnabled)
                }
            }))
        }
    }

    /**
     * op=getQuota — 查询 GLM Coding Plan 额度（5小时/每周/MCP每月）
     *
     * 凭证：config.json 的 builtin:bigmodel-coding-plan provider（baseURL + apiKey）
     * 端点：{baseDomain}/api/monitor/usage/quota/limit，Authorization: <apiKey>
     * 逻辑移植自 glm-plan-usage-idea 的 GlmUsageClient
     */
    /** 额度查询凭证（baseDomain + 裸 apiKey），三路 monitor HTTP 共用 */
    private data class QuotaCredentials(val baseDomain: String, val apiKey: String)

    /**
     * 从 config.json 读额度查询凭证（baseDomain + 裸 apiKey）。
     * 复用于 quota/limit、model-usage、tool-usage 三路 HTTP。
     * @return Pair(凭证?, 错误信息) —— 凭证非空即成功
     */
    private fun loadQuotaCredentials(): Pair<QuotaCredentials?, String> {
        val configPath = System.getProperty("user.home") + "/.zcode/v2/config.json"
        val configFile = java.io.File(configPath)
        if (!configFile.exists()) return null to "config.json 不存在"
        val providers = try {
            json.parseToJsonElement(configFile.readText()).jsonObject["provider"]?.jsonObject
        } catch (e: Exception) {
            return null to "解析 config.json 失败: ${e.message}"
        } ?: return null to "config.json 无 provider"

        // 找第一个有 apiKey 的启用 provider（优先 bigmodel-coding-plan）
        var baseURL: String? = null
        var apiKey: String? = null
        for ((providerId, providerEl) in providers) {
            val pv = providerEl.jsonObject
            val enabled = pv["enabled"]?.jsonPrimitive?.content?.toBoolean() ?: true
            if (!enabled) continue
            val options = pv["options"]?.jsonObject ?: continue
            val url = options["baseURL"]?.jsonPrimitive?.content ?: continue
            val key = options["apiKey"]?.jsonPrimitive?.content ?: continue
            // 优先 bigmodel-coding-plan，其他有 key 的也行
            if (providerId == "builtin:bigmodel-coding-plan") {
                baseURL = url; apiKey = key; break
            }
            if (baseURL == null) { baseURL = url; apiKey = key }
        }
        if (baseURL == null || apiKey == null) {
            return null to "未找到带 apiKey 的启用 provider（oauth 模式不支持用量查询）"
        }

        // baseDomain：取 scheme://host[:port]，丢弃 path（如 /api/anthropic）
        val baseDomain = try {
            val uri = java.net.URI(baseURL)
            val port = if (uri.port == -1) "" else ":${uri.port}"
            "${uri.scheme}://${uri.host}$port"
        } catch (e: Exception) {
            return null to "baseURL 格式非法: $baseURL"
        }
        return QuotaCredentials(baseDomain, apiKey) to ""
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
                val rawData = json.parseToJsonElement(resp.body()).jsonObject
                rawData["data"]?.let { put("data", it) }
            }
        } catch (e: Exception) {
            usageErrorResponse("quota", "额度查询异常: ${e.message}")
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
                log.warn("打开文件失败：文件不存在 $filePath")
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
                log.warn("Diff 显示失败: ${e.message}")
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
                log.warn("刷新文件失败：文件不存在 $filePath")
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
        val client = project.zCodeService().getClient()
        try {
            // 带 runtimeModel：服务端先把 provider 注册进 workspace（绕过"可选模型"校验）
            // 普通 setModel 只能切 main/lite/available 里的模型（当前只有 anthropic/GLM-5.2）
            val runtimeModel = buildRuntimeModel(providerId, modelId)
            if (runtimeModel == null) {
                log.warn("config.json 中找不到 provider $providerId，退回普通 setModel（可能失败）")
            }
            client.setModel(sessionId, modelId, providerId, runtimeModel)
            log.info("切换模型成功: $sessionId → $providerId/$modelId")
        } catch (e: Exception) {
            log.warn("切换模型失败: ${e.message}")
            return errorResponse("切换模型失败: ${e.message}")
        }
        return buildJsonObject {
            put("op", "modelSet")
            put("sessionId", sessionId)
            put("modelId", modelId)
            put("providerId", providerId)
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
            val settings = client.readSettings(sessionId)
            buildJsonObject {
                put("op", "settings")
                put("sessionId", sessionId)
                put("mode", settings["mode"]?.jsonObject ?: JsonObject(emptyMap()))
                put("thoughtLevel", settings["thoughtLevel"]?.jsonObject ?: JsonObject(emptyMap()))
            }
        } catch (e: Exception) {
            log.warn("读取会话设置失败: ${e.message}")
            errorResponse("读取设置失败: ${e.message}")
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
            log.info("切换思考级别成功: $sessionId → $thoughtLevel")
            buildJsonObject {
                put("op", "thoughtLevelSet")
                put("sessionId", sessionId)
                put("thoughtLevel", thoughtLevel)
            }
        } catch (e: Exception) {
            log.warn("切换思考级别失败: ${e.message}")
            errorResponse("切换思考级别失败: ${e.message}")
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
            log.info("切换权限模式成功: $sessionId → $mode")
            buildJsonObject {
                put("op", "modeSet")
                put("sessionId", sessionId)
                put("mode", modeStr)
            }
        } catch (e: Exception) {
            log.warn("切换权限模式失败: ${e.message}")
            errorResponse("切换权限模式失败: ${e.message}")
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
        val refs = picked.map { f ->
            val p = f.presentableUrl ?: f.path
            if (f.isDirectory && !p.endsWith("/")) "$p/" else p
        }.map { "@$it" }
        log.info("附件选择 ${refs.size} 个: $refs")
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
            }
        } catch (e: Exception) {
            log.warn("获取上下文用量失败: ${e.message}")
            errorResponse("获取用量失败: ${e.message}")
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
        val workspacePath = msg["workspacePath"]?.jsonPrimitive?.content
            ?: project.basePath
            ?: System.getProperty("user.dir")

        val client = project.zCodeService().getClient()

        val accepted = try {
            client.send(sessionId, text, workspacePath)
        } catch (e: ZCodeProtocolException) {
            log.error("send 失败", e)
            return errorResponse("发送失败: ${e.message}")
        }

        return buildJsonObject {
            put("op", "sendAccepted")
            put("sessionId", sessionId)
            put("accepted", "true")
            accepted["cliResponse"]?.let { put("cliResponse", it) }
        }
    }

    private fun handleMessages(msg: JsonObject): JsonObject {
        val sessionId = msg["sessionId"]?.jsonPrimitive?.content
            ?: return errorResponse("缺少 sessionId")
        // JS 传过来的会话原始 workspace（来自 session/list 的 workspace 字段）
        val workspacePath = msg["workspacePath"]?.jsonPrimitive?.content
            ?: project.basePath
            ?: System.getProperty("user.dir")

        val messages = resumeAndReadMessages(sessionId, workspacePath)
        log.info("messages 返回 ${messages.size} 条")
        return buildJsonObject {
            put("op", "messages")
            put("sessionId", sessionId)
            put("messages", messages)
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
        try {
            val ws = com.zcode.ideaplugin.protocol.model.Workspace(workspacePath)
            client.resume(sessionId, ws)
            log.info("resume 会话成功: $sessionId (workspace=$workspacePath)")
        } catch (e: Exception) {
            log.info("resume 会话失败（可能已 active）: ${e.message}")
        }
        return client.messages(sessionId)
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
            log.info("subagents 返回 childSessionIds=${data["childSessionIds"]}")
            buildJsonObject {
                put("op", "subagents")
                put("sessionId", sessionId)
                put("data", data)
            }
        } catch (e: Exception) {
            log.warn("subagents 查询失败: ${e.message}")
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
        val workspacePath = msg["workspacePath"]?.jsonPrimitive?.content
            ?: project.basePath
            ?: System.getProperty("user.dir")
        return try {
            val messages = resumeAndReadMessages(sessionId, workspacePath)
            log.info("subagentMessages($sessionId) 返回 ${messages.size} 条")
            buildJsonObject {
                put("op", "subagentMessages")
                put("sessionId", sessionId)
                put("messages", messages)
            }
        } catch (e: Exception) {
            log.warn("subagentMessages($sessionId) 读取失败: ${e.message}")
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
        globalListenerRegistered = false
        subscribedSessions.clear()
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
        val workspacePath = msg["workspacePath"]?.jsonPrimitive?.content
            ?: project.basePath
            ?: System.getProperty("user.dir")
        val client = project.zCodeService().getClient()

        // 记录当前会话（标签持久化 + 生成中状态归属判断）+ 同步 TabState
        currentSessionId = sessionId
        persistSelfTabState()

        // 注册全局监听器（只注册一次，所有会话的事件都通过它推给前端）
        if (!globalListenerRegistered) {
            client.addGlobalEventListener { event ->
                pushStreamEvent(event.sessionId, event)
            }
            registerBackendErrorHandler(client)
            globalListenerRegistered = true
            log.info("全局事件监听器已注册")
        }

        // 每个 session 只 subscribe 一次（不 unsubscribe，避免切回时丢事件）
        if (sessionId in subscribedSessions) {
            log.info("session $sessionId 已 subscribe 过，跳过")
            return buildJsonObject {
                put("op", "subscribed")
                put("sessionId", sessionId)
            }
        }

        // subscribe 要求会话 active，先 resume
        try {
            val ws = com.zcode.ideaplugin.protocol.model.Workspace(workspacePath)
            client.resume(sessionId, ws)
            log.info("resume 会话成功: $sessionId")
        } catch (e: Exception) {
            log.info("resume 失败（可能已 active）: ${e.message}")
        }

        // subscribe（全局监听器已在 app-server 层面接收所有事件）
        try {
            client.subscribe(sessionId, onEvent = null)
            subscribedSessions.add(sessionId)
            log.info("subscribe session $sessionId 成功（全局监听器接收事件）")
        } catch (e: Exception) {
            log.error("subscribe session $sessionId 失败", e)
            return errorResponse("订阅失败: ${e.message}")
        }

        return buildJsonObject {
            put("op", "subscribed")
            put("sessionId", sessionId)
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
        val workspacePath = msg["workspacePath"]?.jsonPrimitive?.content
            ?: project.basePath
            ?: System.getProperty("user.dir")
        val client = project.zCodeService().getClient()

        // 全局监听器（只注册一次，同 handleSubscribe）
        if (!globalListenerRegistered) {
            client.addGlobalEventListener { event ->
                pushStreamEvent(event.sessionId, event)
            }
            registerBackendErrorHandler(client)
            globalListenerRegistered = true
            log.info("全局事件监听器已注册")
        }

        if (sessionId in subscribedSessions) {
            log.info("subscribeChild: 子会话 $sessionId 已订阅过，跳过")
            return buildJsonObject {
                put("op", "subscribedChild")
                put("sessionId", sessionId)
            }
        }

        // subscribe 要求会话 active，先 resume；运行中的子会话可能已 active，失败静默
        try {
            val ws = com.zcode.ideaplugin.protocol.model.Workspace(workspacePath)
            client.resume(sessionId, ws)
            log.info("subscribeChild: resume 子会话成功 $sessionId")
        } catch (e: Exception) {
            log.info("subscribeChild: resume 失败（可能已 active）: ${e.message}")
        }

        return try {
            client.subscribe(sessionId, onEvent = null)
            subscribedSessions.add(sessionId)
            log.info("subscribeChild: 子会话事件流已订阅 $sessionId")
            buildJsonObject {
                put("op", "subscribedChild")
                put("sessionId", sessionId)
            }
        } catch (e: Exception) {
            log.warn("subscribeChild: subscribe 失败 $sessionId: ${e.message}")
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
            log.warn("[backendError] 模型 API 错误 statusCode=${err.statusCode} code=${err.code} message=${err.message.take(300)}")
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
        // 多标签隔离：只推本面板订阅过的会话（其他标签的事件由各自的监听器推送）
        if (sessionId !in subscribedSessions) return

        // 本标签当前会话的 turn 生命周期 → 标签「●」生成中状态
        if (sessionId == currentSessionId) {
            when (event.type) {
                "turn.started" -> setTabStreaming(true)
                "turn.completed", "turn.failed" -> setTabStreaming(false)
            }
        }

        log.info("[stream] 收到事件 type=${event.type} seq=${event.seq}（推送给前端）")
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
        Thread({
            Thread.sleep(16) // 60fps 节流窗口
            flushStreamBuffer()
            synchronized(streamFlushLock) { streamFlusherRunning = false }
        }, "zcode-stream-flush").apply { isDaemon = true }.start()
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
                log.warn("[stream] sendToJsDirect 失败 op=$op: ${e.message}")
            }
        }
    }

    /** 停止当前 turn（session/stop） */
    private fun handleStop(msg: JsonObject): JsonObject {
        val sessionId = msg["sessionId"]?.jsonPrimitive?.content
            ?: return errorResponse("缺少 sessionId")
        val client = project.zCodeService().getClient()
        try {
            client.stop(sessionId)
            log.info("停止 session $sessionId 的当前 turn")
        } catch (e: Exception) {
            log.warn("stop 失败: ${e.message}")
            return errorResponse("停止失败: ${e.message}")
        }
        return buildJsonObject {
            put("op", "stopped")
            put("sessionId", sessionId)
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
                    log.warn("createTab 失败：找不到 ZCode ToolWindow")
                    return@invokeLater
                }
                ZCodeToolWindowFactory.createNewTab(project, toolWindow)
                log.info("createTab 成功")
            } catch (e: Exception) {
                log.error("createTab 失败", e)
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
        val answer = msg["answer"]?.jsonPrimitive?.content
        return project.zCodeService().completeUserInput(requestId, action, answer)
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
            log.warn("扫描文件失败: ${e.message}")
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
        log.info("斜杠命令扫描完成，共 ${commands.size} 条")
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
     */
    private fun handleListMemoryFiles(msg: JsonObject): JsonObject {
        val files = MemoryFileScanner.list(project.basePath)
        return buildJsonObject {
            put("op", "memoryFiles")
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
        log.info("记忆文件已创建: $path")
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
     * op=listSkills — 技能清单（设置页「技能」条目）
     *
     * SkillScanner 扫描全局/项目/插件三来源（junction 真实路径去重），
     * enabled 判定自 ~/.zcode/cli/config.json 的 skill 节点（CLI 同源机制）。
     */
    private fun handleListSkills(msg: JsonObject): JsonObject {
        val skills = SkillScanner.scan(project.basePath)
        log.info("技能扫描完成，共 ${skills.size} 条")
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
        log.info("技能已${if (enabled) "启用" else "禁用"}: $path")
        return buildJsonObject {
            put("op", "skillToggled")
            put("path", path)
            put("enabled", enabled)
        }
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
            }.onFailure { log.warn("plugins/list（宿主内置 MCP）失败：${it.message}") }
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
                log.warn("mcp/list($mode) 失败：${e.message}")
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
                    log.info("宿主 MCP 直连探测 [${s.name}] 成功，${tools.size} 个工具")
                    s.copy(status = "connected", toolCount = tools.size, statusError = null)
                }.getOrElse { e ->
                    log.warn("宿主 MCP 直连探测 [${s.name}] 失败：${e.message}")
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
            log.info("MCP 工具列表 [$name] 获取成功，共 ${tools.size} 个")
            resp(tools = tools)
        } catch (e: Exception) {
            log.warn("MCP 工具列表 [$name] 获取失败：${e.message}")
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
        log.info("MCP 日志读取完成，共 ${logs.size} 条")
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
        log.info("使用的 JS 函数名: $funcName")

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
