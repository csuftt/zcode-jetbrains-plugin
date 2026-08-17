package com.zcode.ideaplugin.ui

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.ui.jcef.JBCefBrowser
import com.zcode.ideaplugin.ZCodeWebviewServer
import com.zcode.ideaplugin.zCodeService
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import java.net.URI
import java.net.http.HttpClient
import java.net.http.WebSocket
import java.time.Duration
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import javax.swing.SwingUtilities

/**
 * browser-use 宿主执行器（方案 A：对齐 ZCode 原生）
 *
 * 实现 app-server 的 interaction/browserList 与 interaction/browserExecute 反向请求，
 * 把 AI 的浏览器命令落到插件的 ZCodeBrowserPanel（JCEF 内嵌浏览器）上：
 * - 导航/状态类命令走 JCEF 原生 API（loadURL/goBack/goForward/reload）
 * - 观测/交互类命令走 JCEF 的 CDP 远程调试端口（registry ide.browser.jcef.debug.port
 *   = 0 随机端口，经 DevToolsActivePort 文件发现）：screenshot=Page.captureScreenshot，
 *   snapshot/evaluate/waitFor=Runtime.evaluate 注入脚本，click/fill/type/press=
 *   Input 域（trusted 事件，React onChange 可靠响应）
 * - CUA 坐标族（cuaScroll/domCuaScroll/cuaKeypress/cuaDrag）走 Input 域的
 *   mouseWheel/组合 keyDown/keyUp/路径插值，语义对齐官方 Xci/rQr 实现
 * - 生命周期标记（markDeliverable/markHandoff/finalize/finalizeTabs/nameSession）
 *   仅标记 tab 状态不关闭不夺控（官方 tab-cleanup 语义）；close 真关闭目标 tab
 * - app-server 批量生命周期命令（turnEnded/closeSession/cancelRequest）幂等空应答
 *
 * Phase 2：多 tab（tabId 路由，每 tab 一个 JBCefBrowser）、JS 对话框
 * （getDialog/handleDialog，面板侧 CefJSDialogHandler 挂起）、select/check/drag、
 * 浏览器分栏可见性（browserVisibilityGet/Set）。
 *
 * 协议 schema 详见 docs/设计与调研/browser-use宿主协议接入设计.md（逆向 zcode.cjs v3.7.7）。
 * execute 在 protocol-client 的独立线程调用，可安全阻塞；JCEF 交互按需切 EDT。
 */
class ZCodeBrowserExecutor(private val project: Project) {

    companion object {
        const val BROWSER_ID = "idea-iab"
        /** JCEF CDP 远程调试默认端口（registry ide.browser.jcef.debug.port 的默认值）*/
        private const val CDP_PORT = 9222
        /**
         * CDP 端点发现：Factory 把 registry 设为 0（随机端口）后，CEF 把实际端口写入
         * jcef_cache 根目录的 DevToolsActivePort 文件（首行端口）——读文件拿真实端口，
         * 彻底免疫端口冲突与 Windows TCP 僵尸条目。文件未就绪/缺失时兜底探测固定 9222
         * （用户手工设正值场景）。IPv4/IPv6 双栈尝试（实测 Windows 上 CEF 可能只监听 [::1]）。
         * 结果缓存；失败时清缓存允许下轮重试（文件可能晚于首个 browserList 写出）。
         */
        @Volatile
        private var cdpBase: String? = null
        private val cdpBaseLock = Any()
        private val json = Json { ignoreUnknownKeys = true }

        /** jcef_cache 定位：系统缓存根下最新修改的产品目录（含正在运行的 IDE）*/
        private fun findDevToolsActivePortFile(): java.io.File? {
            val osName = System.getProperty("os.name", "").lowercase()
            val base = when {
                osName.startsWith("win") ->
                    java.io.File(System.getProperty("user.home"), "AppData/Local/JetBrains")
                osName.contains("mac") ->
                    java.io.File(System.getProperty("user.home"), "Library/Caches/JetBrains")
                else -> java.io.File(System.getProperty("user.home"), ".cache/JetBrains")
            }
            if (!base.isDirectory) return null
            // 找最新修改的 DevToolsActivePort（多个 JetBrains IDE 并存时对应最近启动的那个）
            return base.listFiles { f: java.io.File -> f.isDirectory }
                ?.flatMap { product ->
                    product.resolve("jcef_cache").let { cache ->
                        if (cache.isDirectory) listOf(java.io.File(cache, "DevToolsActivePort")) else emptyList()
                    }
                }
                ?.filter { it.isFile }
                ?.maxByOrNull { it.lastModified() }
        }
    }

    /** CDP 端点 base；不可达返回 null。优先 DevToolsActivePort 随机端口，兜底 9222 双栈探测 */
    private fun cdpBaseUrl(): String? {
        cdpBase?.let { return it }
        synchronized(cdpBaseLock) {
            cdpBase?.let { return it }
            // 1) DevToolsActivePort 文件（随机端口模式，Factory 默认设置）
            val fromFile = readDevToolsActivePort()
            if (fromFile != null) return fromFile
            // 2) 兜底：固定 9222（用户手工设正值）
            for (host in listOf("127.0.0.1", "[::1]")) {
                val base = "http://$host:9222"
                if (httpGetJson("$base/json/version") != null) {
                    cdpBase = base
                    log.info("[browser-use] CDP 端点（9222 兜底）：$base")
                    return base
                }
            }
            // 文件没出来 + 9222 不通：不缓存失败，下轮 browserList 重试（文件可能晚写）
            return null
        }
    }

    /** 读 DevToolsActivePort 首行端口并验证 /json/version 可达 */
    private fun readDevToolsActivePort(): String? {
        return try {
            val f = findDevToolsActivePortFile() ?: return null
            val port = f.readText().trim().lineSequence().firstOrNull()?.trim()?.toIntOrNull() ?: return null
            for (host in listOf("127.0.0.1", "[::1]")) {
                val base = "http://$host:$port"
                if (httpGetJson("$base/json/version") != null) {
                    cdpBase = base
                    log.info("[browser-use] CDP 端点（DevToolsActivePort 端口 $port）：$base")
                    return base
                }
            }
            null
        } catch (e: Exception) {
            log.warn("[browser-use] 读 DevToolsActivePort 失败: ${e.message}")
            null
        }
    }

    private val log = Logger.getInstance("ZCodePlugin")
    private val http: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(2))
        .build()

    // ============ browserList ============

    /** interaction/browserList：CDP 端口可达才报浏览器，否则空列表（browser-use 优雅降级）*/
    fun listBrowsers(): JsonObject {
        if (cdpBaseUrl() == null) {
            log.info("[browser-use] CDP $CDP_PORT 不可达（IPv4/IPv6 均失败），browserList 返回空（AI 浏览器工具不可用）")
            return buildJsonObject { put("browsers", JsonArray(emptyList())) }
        }
        val browserCaps = listOf(
            "navigate" to "加载 URL（等待导航生效）",
            "back" to "后退",
            "forward" to "前进",
            "reload" to "刷新",
            "getState" to "当前页面状态（url/title/viewport）",
            "snapshot" to "页面可交互元素快照",
            "screenshot" to "页面截图（PNG base64）",
            "evaluate" to "在页面执行 JS 表达式",
            "click" to "点击元素或坐标",
            "fill" to "填充输入框（React 受控兼容）",
            "type" to "键入文本（可先聚焦 ref）",
            "press" to "按键",
            "scroll" to "滚动页面或元素",
            "hover" to "悬停",
            "waitFor" to "等待 selector/text 出现",
            "elementInfo" to "坐标处元素信息",
            "list" to "tab 列表",
            "select" to "下拉选择（原生 select）",
            "check" to "勾选/取消 checkbox（trusted click）",
            "drag" to "拖拽（mousedown→插值 mousemove→mouseup）",
            "cuaScroll" to "坐标处滚轮滚动",
            "domCuaScroll" to "DOM 节点处滚轮滚动（nodeId=ref）",
            "cuaKeypress" to "组合按键（keys 数组：末位击键、其余按住）",
            "cuaDrag" to "显式路径拖拽（path 坐标序列）",
            "getDialog" to "查询挂起的 JS 对话框",
            "handleDialog" to "处置 JS 对话框（accept/dismiss）",
            "visibility" to "浏览器分栏可见性（get/set）",
            "nameSession" to "命名浏览器会话",
        ).map { capJson(it.first, it.second) }
        val tabCaps = listOf(
            "navigate", "snapshot", "screenshot", "evaluate", "click", "fill", "type",
            "press", "scroll", "hover", "waitFor", "elementInfo", "select", "check",
            "drag", "getDialog", "handleDialog", "close",
            "cuaScroll", "domCuaScroll", "cuaKeypress", "cuaDrag",
            "finalize", "markDeliverable", "markHandoff",
        ).map { capJson(it, it) }
        return buildJsonObject {
            put("browsers", JsonArray(listOf(buildJsonObject {
                put("id", BROWSER_ID)
                put("generation", 0)
                put("type", "iab")
                put("name", "IDEA 内嵌浏览器")
                put("capabilities", buildJsonObject {
                    put("browser", JsonArray(browserCaps))
                    put("tab", JsonArray(tabCaps))
                })
                // API 支持面声明（客户端 BrowserApiPolicy 按 "对象.成员" 键隐藏不可用面）：
                // 生命周期标记官方 iab 默认隐藏（unsupportedByDefaultIn），这里显式开启已实现项
                put("apiSupportOverrides", buildJsonObject {
                    put("Tab.markDeliverable", true)
                    put("Tab.markHandoff", true)
                    put("Tab.finalize", true)
                    put("Tabs.finalize", true)
                    // 无用户浏览器集成：面板全部 tab 均可直接 tabId 控制（tabs.list），
                    // claim 无意义——对齐官方 headless 后端把 BrowserUser 面整个隐藏
                    put("BrowserUser.claimTab", false)
                    put("BrowserUser.openTabs", false)
                    put("BrowserUser.history", false)
                    // Playwright 面：waitForEvent/download/fileChooser 协议即回 capability_unsupported
                    put("PlaywrightAPI.waitForEvent", false)
                    put("PlaywrightDownload.path", false)
                    put("PlaywrightFileChooser.setFiles", false)
                    put("PlaywrightLocator.downloadMedia", false)
                    put("PlaywrightLocator.evaluate", true) // 已实现（官方 headless 为 false）
                    put("CUAAPI.downloadMedia", false)
                    put("DomCUAAPI.downloadMedia", false)
                })
                sessionName?.let {
                    put("metadata", buildJsonObject { put("sessionName", it) })
                }
            })))
        }
    }

    /** nameSession 记录的会话名（browserList metadata 暴露给 AI/客户端）*/
    @Volatile
    private var sessionName: String? = null

    private fun capJson(id: String, description: String): JsonObject = buildJsonObject {
        put("id", id)
        put("description", description)
    }

    // ============ browserExecute ============

    /** interaction/browserExecute：解析 command.method 分发；异常统一转 {ok:false,error} */
    fun execute(params: JsonObject): JsonObject {
        val start = System.currentTimeMillis()
        val command = params["command"]?.jsonObject
            ?: return errorResult("missing command", null, start)
        val method = command["method"]?.jsonPrimitive?.contentOrNull
            ?: return errorResult("missing command.method", command, start)
        log.info("[browser-use] execute command=$method")
        return try {
            val body: JsonObject = when (method) {
                // JCEF 原生导航（tabId 可选，缺省路由到激活 tab）
                "navigate" -> cmdNavigate(command)
                "back" -> cmdGo(command, "goBack")
                "forward" -> cmdGo(command, "goForward")
                "reload" -> cmdGo(command, "reload")
                "getState" -> cmdGetState(command)
                "list" -> cmdListTabs()
                // tab 绑定/创建：客户端包装器强校验 result.tab 存在（缺失即抛
                // "Browser result missing tab"，会掩盖真实错误）——必须带 tab 返回
                "activateTab" -> cmdActivateTab(command)
                "newTab" -> cmdNewTab()
                // CDP 类
                "snapshot" -> cmdSnapshot(command)
                "screenshot" -> cmdScreenshot(command)
                "evaluate" -> cmdEvaluate(command)
                "click" -> cmdClick(command)
                "fill" -> cmdFill(command)
                "type" -> cmdType(command)
                "press" -> cmdPress(command)
                "scroll" -> cmdScroll(command)
                "hover" -> cmdHover(command)
                "waitFor" -> cmdWaitFor(command)
                "elementInfo" -> cmdElementInfo(command)
                // CUA 坐标族（tab.cua / tab.dom_cua 通道：坐标/节点中心的滚轮、组合键、路径拖拽）
                "cuaScroll" -> cmdCuaScroll(command)
                "domCuaScroll" -> cmdDomCuaScroll(command)
                "cuaKeypress" -> cmdCuaKeypress(command)
                "cuaDrag" -> cmdCuaDrag(command)
                // Phase 2 交互
                "select" -> cmdSelect(command)
                "check" -> cmdCheck(command)
                "drag" -> cmdDrag(command)
                // Phase 2 对话框
                "getDialog" -> cmdGetDialog(command)
                "handleDialog" -> cmdHandleDialog(command)
                // Phase 2 面板可见性
                "browserVisibilityGet" -> cmdVisibilityGet()
                "browserVisibilitySet" -> cmdVisibilitySet(command)
                // Phase 3：Playwright 透传（AI skill 的默认工作流：domSnapshot → locator 操作）
                "playwright" -> cmdPlaywright(command)
                "playwrightWaitForTimeout" -> cmdPlaywrightWaitTimeout(command)
                // Phase 3：viewport 自由尺寸（UI 与协议双通道，面板级应用到全部 tab）
                "browserViewportSet" -> cmdViewportSet(command)
                "browserViewportReset" -> cmdViewportReset(command)
                // 生命周期标记（对齐官方语义：仅标记，不关闭/不改变可控性）
                "markDeliverable" -> cmdMarkLifecycle(command, "deliverable")
                "markHandoff" -> cmdMarkLifecycle(command, "handoff")
                "finalize" -> cmdFinalize(command)
                "finalizeTabs" -> cmdFinalizeTabs(command)
                "nameSession" -> cmdNameSession(command)
                // tab 关闭（AI 显式 tab.close()；app-server 生命周期批不含 close，不会误伤）
                "close" -> cmdCloseTab(command)
                // 用户 tab 面：面板全部 tab 均可直接 tabId 控制，无独立"用户浏览器"可认领
                "listUserTabs" -> buildJsonObject {
                    put("ok", true)
                    put("userTabs", JsonArray(emptyList()))
                }
                "claimTab" -> buildJsonObject {
                    put("ok", false)
                    put("error", buildJsonObject {
                        put("code", "capability_unsupported")
                        put("message", "claimTab 在插件 iab 后端不可用：无用户浏览器集成，面板 tab 全部可经 tabs.list + tabId 直接控制")
                    })
                }
                // app-server 批量生命周期命令（turn 结束/会话关闭/中止）：幂等空应答
                "turnEnded", "closeSession", "cancelRequest", "capabilities",
                -> buildJsonObject { put("ok", true) }
                else -> buildJsonObject {
                    put("ok", false)
                    put("error", buildJsonObject {
                        // 协议 error.code 枚举固定九值，乱值会让客户端 zod 解析直接崩
                        put("code", "capability_unsupported")
                        put("message", "命令尚未实现: $method")
                        put("sideEffect", "none")
                    })
                }
            }
            buildJsonObject {
                body.forEach { (k, v) -> put(k, v) }
                put("meta", metaFromPanel(command))
                put("elapsedMs", System.currentTimeMillis() - start)
            }
        } catch (e: Exception) {
            log.warn("[browser-use] 命令 $method 失败: ${e.javaClass.simpleName}: ${e.message}")
            errorResult("${e.javaClass.simpleName}: ${e.message}", command, start)
        }
    }

    private fun errorResult(message: String, command: JsonObject?, start: Long): JsonObject = buildJsonObject {
        put("ok", false)
        put("error", buildJsonObject {
            put("code", "execution_error")
            put("message", message)
            put("sideEffect", "uncertain")
        })
        put("meta", metaFromPanel(command))
        put("elapsedMs", System.currentTimeMillis() - start)
    }

    /**
     * result.meta：openTabIds 用真实 tab 列表（只读，不创建面板——生命周期命令也会走到这），
     * tabId/currentUrl/lifecycle 跟随命令路由（无 tabId 取激活 tab）。
     */
    private fun metaFromPanel(command: JsonObject?): JsonObject {
        val tabId = command?.get("tabId")?.jsonPrimitive?.contentOrNull
        var openIds: List<String> = emptyList()
        var activeId: String? = null
        var currentUrl: String? = null
        var lifecycle: String? = null
        try {
            SwingUtilities.invokeAndWait {
                val panel = findExistingBrowserPanel()
                if (panel != null) {
                    val snaps = panel.tabsSnapshot()
                    openIds = snaps.map { it.tabId }
                    activeId = panel.activeTabId()
                    val routed = snaps.firstOrNull { it.tabId == (tabId ?: activeId) }
                    currentUrl = routed?.url?.takeIf { it.isNotBlank() }
                    lifecycle = routed?.lifecycle
                }
            }
        } catch (_: Exception) {}
        return buildJsonObject {
            put("browserUse", true)
            put("backendType", "iab")
            put("browserId", BROWSER_ID)
            put("browserGeneration", 0)
            put("openTabIds", JsonArray(openIds.map { JsonPrimitive(it) }))
            (tabId ?: activeId)?.let { put("tabId", it) }
            currentUrl?.let { put("currentUrl", it) }
            lifecycle?.let { put("lifecycle", it) }
        }
    }

    /** 已创建的浏览器面板（全局共享单例优先，独立 Content 兜底；只读不创建）*/
    private fun findExistingBrowserPanel(): ZCodeBrowserPanel? {
        project.zCodeService().getSharedBrowserPanel()?.let { return it }
        val tw = ZCodeToolWindowFactory.getToolWindow(project) ?: return null
        return tw.contentManager.contents.firstOrNull { it.component is ZCodeBrowserPanel }
            ?.component as? ZCodeBrowserPanel
    }

    // ============ 面板/tab 访问（EDT）============

    /**
     * 取浏览器面板（无则创建）。
     * 优先「当前激活会话面板的内嵌分栏」——AI 导航时用户同屏观察聊天+浏览器，
     * 无需切标签页（对齐 ZCode 桌面端侧板体验）；无可用会话面板时退回独立
     * Content 标签。对齐桌面端「截图前面板上屏」语义：确保面板真实可见才截图。
     */
    private fun ensureBrowserPanel(): ZCodeBrowserPanel? {
        var panel: ZCodeBrowserPanel? = null
        SwingUtilities.invokeAndWait {
            try {
                val chatPanel = project.zCodeService().getActivePanel()
                panel = chatPanel?.showEmbeddedBrowser()
                if (panel == null) {
                    val tw = ZCodeToolWindowFactory.getToolWindow(project) ?: return@invokeAndWait
                    val cm = tw.contentManager
                    val content = cm.contents.firstOrNull { it.component is ZCodeBrowserPanel }
                        ?: ZCodeToolWindowFactory.createBrowserTab(project, tw)
                        ?: return@invokeAndWait
                    cm.setSelectedContent(content)
                    tw.show(null)
                    panel = content.component as? ZCodeBrowserPanel
                }
            } catch (e: Exception) {
                log.warn("[browser-use] 激活浏览器面板失败: ${e.message}")
            }
        }
        return panel
    }

    /** 面板 + 全部 tab 概要 + viewport 尺寸（EDT 一次读取）*/
    private data class PanelTabs(
        val tabs: List<ZCodeBrowserPanel.TabSnapshot>,
        val width: Int,
        val height: Int,
    )

    private fun readPanelTabs(panel: ZCodeBrowserPanel): PanelTabs {
        var tabs: List<ZCodeBrowserPanel.TabSnapshot> = emptyList()
        var w = 0
        var h = 0
        SwingUtilities.invokeAndWait {
            tabs = panel.tabsSnapshot()
            w = panel.width
            h = panel.height
        }
        // viewport 上报优先页内布局视口（CSS px，与元素 rect/截图 clip 同坐标系；自由尺寸态=虚拟屏尺寸）。
        // 面板物理尺寸是 Swing 像素，DPI 缩放下与页面坐标差约 1.34 倍，仅作 CDP 不可用时的兜底
        val activeId = tabs.firstOrNull { it.active }?.tabId ?: tabs.firstOrNull()?.tabId
        try {
            val v = cdpEvaluateValue(activeId, "(function(){return {w:window.innerWidth,h:window.innerHeight};})()")
            val pw = (v as? JsonObject)?.get("w")?.jsonPrimitive?.intOrNull ?: 0
            val ph = (v as? JsonObject)?.get("h")?.jsonPrimitive?.intOrNull ?: 0
            if (pw > 0 && ph > 0) { w = pw; h = ph }
        } catch (_: Exception) { /* 回退面板物理尺寸 */ }
        return PanelTabs(tabs, maxOf(w, 1), maxOf(h, 1))
    }

    /** 命令 tabId 解析：null/失配取激活 tab；都不存在抛错 */
    private fun resolveSnapshot(pt: PanelTabs, tabId: String?): ZCodeBrowserPanel.TabSnapshot? =
        if (tabId != null) pt.tabs.firstOrNull { it.tabId == tabId }
        else pt.tabs.firstOrNull { it.active } ?: pt.tabs.firstOrNull()

    private fun tabJson(tab: ZCodeBrowserPanel.TabSnapshot, pt: PanelTabs): JsonObject = buildJsonObject {
        put("tabId", tab.tabId)
        put("url", tab.url)
        put("title", tab.title)
        // 协议 viewport 要求 int().positive()：未布局面板的 size 是 (0,0) 会被
        // app-server 的 zod 校验拒绝（"Browser result missing tab" 根因）
        put("viewport", buildJsonObject {
            put("width", pt.width)
            put("height", pt.height)
        })
        put("active", tab.active)
        put("lifecycle", tab.lifecycle)
    }

    /** 解析命令 tabId 对应的 JBCefBrowser（EDT）*/
    private fun panelBrowser(panel: ZCodeBrowserPanel, tabId: String?): JBCefBrowser? {
        var b: JBCefBrowser? = null
        SwingUtilities.invokeAndWait {
            b = panel.browserOf(tabId)
        }
        return b
    }

    /** tab 当前 URL（EDT 读 JCEF）*/
    private fun tabUrlOf(panel: ZCodeBrowserPanel, tabId: String?): String? {
        var url: String? = null
        SwingUtilities.invokeAndWait {
            url = try { panel.browserOf(tabId)?.cefBrowser?.url } catch (_: Exception) { null }
        }
        return url
    }

    /** 从 CDP /json/list 取指定 url 的 target 标题（tab.title 由 onTitleChange 维护，此为回退）*/
    private fun cdpTargetTitle(url: String): String {
        if (url.isBlank()) return ""
        val base = cdpBaseUrl() ?: return ""
        val list = httpGetJson("$base/json/list") as? JsonArray ?: return ""
        return list.map { it.jsonObject }
            .firstOrNull { it["url"]?.jsonPrimitive?.contentOrNull == url }
            ?.get("title")?.jsonPrimitive?.contentOrNull ?: ""
    }

    // ============ JCEF 原生命令 ============

    private fun cmdNavigate(command: JsonObject): JsonObject {
        val url = command["url"]?.jsonPrimitive?.contentOrNull
            ?: throw RuntimeException("navigate 缺少 url")
        val tabId = command["tabId"]?.jsonPrimitive?.contentOrNull
        val panel = ensureBrowserPanel() ?: throw RuntimeException("浏览器面板不可用")
        val browser = panelBrowser(panel, tabId) ?: throw RuntimeException("浏览器 tab 不可用（tabId=$tabId）")
        // 对齐桌面端语义：navigate 等待页面真正加载完成（loadURL + 轮询 URL 生效，≤10s）。
        // 新建面板的 CefBrowser 尚未就绪时 loadURL 可能被吞（地址栏停留在
        // file: 占位页），检测到后重发
        browser.loadURL(url)
        var retries = 3
        val deadline = System.currentTimeMillis() + 10_000
        var current = tabUrlOf(panel, tabId)
        while (System.currentTimeMillis() < deadline && !urlReached(current, url)) {
            Thread.sleep(200)
            current = tabUrlOf(panel, tabId)
            if (current != null && current.startsWith("file:///jbcefbrowser/") && retries > 0) {
                retries--
                try { browser.loadURL(url) } catch (_: Exception) {}
            }
        }
        val pt = readPanelTabs(panel)
        val snap = resolveSnapshot(pt, tabId) ?: throw RuntimeException("浏览器 tab 不可用（tabId=$tabId）")
        return buildJsonObject {
            put("ok", true)
            put("tab", tabJson(snap, pt))
        }
    }

    private fun urlReached(current: String?, target: String): Boolean =
        current != null && (current == target || current.startsWith(target))

    private fun cmdGo(command: JsonObject, what: String): JsonObject {
        val tabId = command["tabId"]?.jsonPrimitive?.contentOrNull
        val panel = ensureBrowserPanel() ?: throw RuntimeException("浏览器面板不可用")
        val browser = panelBrowser(panel, tabId) ?: throw RuntimeException("浏览器 tab 不可用（tabId=$tabId）")
        SwingUtilities.invokeLater {
            try {
                when (what) {
                    "goBack" -> browser.cefBrowser.goBack()
                    "goForward" -> browser.cefBrowser.goForward()
                    else -> browser.cefBrowser.reload()
                }
            } catch (e: Exception) {
                log.warn("[browser-use] $what 失败: ${e.message}")
            }
        }
        val pt = readPanelTabs(panel)
        val snap = resolveSnapshot(pt, tabId) ?: throw RuntimeException("浏览器 tab 不可用（tabId=$tabId）")
        return buildJsonObject {
            put("ok", true)
            put("tab", tabJson(snap, pt))
        }
    }

    private fun cmdGetState(command: JsonObject): JsonObject {
        val tabId = command["tabId"]?.jsonPrimitive?.contentOrNull
        val panel = ensureBrowserPanel() ?: throw RuntimeException("浏览器面板不可用")
        val pt = readPanelTabs(panel)
        val snap = resolveSnapshot(pt, tabId) ?: throw RuntimeException("浏览器 tab 不可用（tabId=$tabId）")
        // 标题优先 onTitleChange 维护值（data: 欢迎页等场景回退 CDP target 元数据）
        val title = snap.title.ifBlank { cdpTargetTitle(snap.url) }
        return buildJsonObject {
            put("ok", true)
            put("state", buildJsonObject {
                put("url", snap.url)
                put("title", title)
                put("canGoBack", snap.canGoBack)
                put("canGoForward", snap.canGoForward)
                put("viewportWidth", pt.width)
                put("viewportHeight", pt.height)
            })
        }
    }

    private fun cmdListTabs(): JsonObject {
        val panel = ensureBrowserPanel() ?: throw RuntimeException("浏览器面板不可用")
        val pt = readPanelTabs(panel)
        if (pt.tabs.isEmpty()) throw RuntimeException("浏览器无 tab")
        val active = pt.tabs.firstOrNull { it.active } ?: pt.tabs.first()
        return buildJsonObject {
            put("ok", true)
            put("tabs", JsonArray(pt.tabs.map { tabJson(it, pt) }))
            put("tab", tabJson(active, pt))
        }
    }

    /** newTab：面板新建独立 JBCefBrowser tab 并激活；返回带 tab */
    private fun cmdNewTab(): JsonObject {
        val panel = ensureBrowserPanel() ?: throw RuntimeException("浏览器面板不可用")
        val newId = panel.createTab() ?: throw RuntimeException("创建 tab 失败（JCEF 不可用）")
        val pt = readPanelTabs(panel)
        val snap = pt.tabs.firstOrNull { it.tabId == newId } ?: throw RuntimeException("新 tab 状态读取失败")
        return buildJsonObject {
            put("ok", true)
            put("tab", tabJson(snap, pt))
        }
    }

    private fun cmdActivateTab(command: JsonObject): JsonObject {
        val tabId = command["tabId"]?.jsonPrimitive?.contentOrNull
            ?: throw RuntimeException("activateTab 缺少 tabId")
        val panel = ensureBrowserPanel() ?: throw RuntimeException("浏览器面板不可用")
        if (!panel.activateTabById(tabId)) throw RuntimeException("tab 不存在: $tabId")
        val pt = readPanelTabs(panel)
        val snap = pt.tabs.firstOrNull { it.tabId == tabId } ?: throw RuntimeException("tab 状态读取失败")
        return buildJsonObject {
            put("ok", true)
            put("tab", tabJson(snap, pt))
        }
    }

    // ============ CDP 通道 ============

    /** GET CDP HTTP 接口（/json/list、/json/version）*/
    private fun httpGetJson(url: String): JsonElement? = try {
        http.send(
            java.net.http.HttpRequest.newBuilder(URI(url)).timeout(Duration.ofSeconds(2)).GET().build(),
            java.net.http.HttpResponse.BodyHandlers.ofString(),
        ).body().takeIf { it.isNotBlank() }?.let { json.parseToJsonElement(it) }
    } catch (e: Exception) {
        null
    }

    /**
     * 定位命令路由 tab 的 CDP target（ws URL）：
     * 1) /json/list 里 url 与该 tab JCEF url 精确匹配的 page target（两个 tab 同 url
     *    时取第一个——边缘歧义，AI 通常 newTab 后立即 navigate 拉开差异）；
     * 2) 失配（如 data: 欢迎页 url 被截断）时排除聊天 webview 的已知 origin 后取第一个 page。
     */
    private fun findPanelTargetWs(tabId: String?, ensurePanel: Boolean = true): String? {
        val panel = if (ensurePanel) {
            ensureBrowserPanel() ?: return null
        } else {
            findExistingBrowserPanel() ?: return null
        }
        val tabUrl = tabUrlOf(panel, tabId)
        val base = cdpBaseUrl() ?: return null
        val list = httpGetJson("$base/json/list") as? JsonArray ?: return null
        val pages = list.map { it.jsonObject }
            .filter { it["type"]?.jsonPrimitive?.contentOrNull == "page" && it["webSocketDebuggerUrl"] != null }
        pages.firstOrNull { it["url"]?.jsonPrimitive?.contentOrNull == tabUrl && !tabUrl.isNullOrBlank() }
            ?.let { return it["webSocketDebuggerUrl"]!!.jsonPrimitive.content }
        val chatOrigins = buildList {
            ZCodeWebviewServer.baseUrl()?.let { add(it) }
            add("http://localhost:5173")
        }
        return pages.firstOrNull {
            val u = it["url"]?.jsonPrimitive?.contentOrNull ?: ""
            chatOrigins.none { o -> u.startsWith(o) } && !u.startsWith("devtools")
        }?.get("webSocketDebuggerUrl")?.jsonPrimitive?.content
    }

    /** 在命令路由 tab 的 target 上执行一条 CDP 命令（每命令建连，用完即弃——免连接状态机）*/
    private fun cdpCommand(
        tabId: String?,
        method: String,
        params: JsonObject,
        ensurePanel: Boolean = true,
    ): JsonObject {
        val wsUrl = findPanelTargetWs(tabId, ensurePanel) ?: throw RuntimeException("CDP target 未找到（浏览器 tab 页面不存在）")
        val future = CompletableFuture<JsonObject>()
        val listener = object : WebSocket.Listener {
            private val buf = StringBuilder()
            override fun onText(ws: WebSocket, data: CharSequence, last: Boolean): java.util.concurrent.CompletionStage<*>? {
                buf.append(data)
                if (last) {
                    try {
                        future.complete(json.parseToJsonElement(buf.toString()).jsonObject)
                    } catch (e: Exception) {
                        future.completeExceptionally(e)
                    }
                    buf.setLength(0)
                }
                ws.request(1)
                return null
            }

            override fun onError(ws: WebSocket, e: Throwable) {
                future.completeExceptionally(e)
            }
        }
        val ws = http.newWebSocketBuilder()
            .connectTimeout(Duration.ofSeconds(3))
            .buildAsync(URI(wsUrl), listener).get(5, TimeUnit.SECONDS)
        try {
            val msg = buildJsonObject {
                put("id", 1)
                put("method", method)
                put("params", params)
            }
            ws.sendText(Json.encodeToString(JsonObject.serializer(), msg), true).get(5, TimeUnit.SECONDS)
            val resp = future.get(20, TimeUnit.SECONDS)
            resp["error"]?.jsonObject?.let {
                throw RuntimeException("CDP $method: ${it["message"]?.jsonPrimitive?.contentOrNull}")
            }
            return resp["result"]?.jsonObject ?: JsonObject(emptyMap())
        } finally {
            ws.abort()
        }
    }

    /** Runtime.evaluate（returnByValue），返回 value 字段（可能为 null）*/
    private fun cdpEvaluateValue(tabId: String?, expression: String, awaitPromise: Boolean = false): JsonElement? {
        val result = cdpCommand(
            tabId,
            "Runtime.evaluate",
            buildJsonObject {
                put("expression", expression)
                put("returnByValue", true)
                put("awaitPromise", awaitPromise)
            },
        )
        val r = result["result"]?.jsonObject ?: return null
        if (r["subtype"]?.jsonPrimitive?.contentOrNull == "error") {
            throw RuntimeException("evaluate 异常: ${r["description"]?.jsonPrimitive?.contentOrNull?.take(300)}")
        }
        return r["value"]
    }

    /** 把 ref（xpath）解析为 JSON 字面量（安全转义）*/
    private fun jsString(s: String): String =
        Json.encodeToString(JsonPrimitive.serializer(), JsonPrimitive(s))

    // ============ CDP 命令实现 ============

    private fun cmdScreenshot(command: JsonObject): JsonObject {
        ensureBrowserPanel() // 上屏后再截，保证渲染真实
        val result = cdpCommand(command["tabId"]?.jsonPrimitive?.contentOrNull, "Page.captureScreenshot", buildJsonObject { put("format", "png") })
        val base64 = result["data"]?.jsonPrimitive?.contentOrNull
            ?: throw RuntimeException("screenshot 无 data 返回")
        // 回传链路排查：确认 executor 侧拿到非空数据（emitImage 不达模型时先看这里有无正常字节数）
        log.info("[browser-use] screenshot captured: ${base64.length} base64 chars")
        return buildJsonObject {
            put("ok", true)
            put("image", buildJsonObject {
                put("base64", base64)
                put("mimeType", "image/png")
            })
        }
    }

    private fun cmdEvaluate(command: JsonObject): JsonObject {
        val expression = command["expression"]?.jsonPrimitive?.contentOrNull
            ?: throw RuntimeException("evaluate 缺少 expression")
        val value = cdpEvaluateValue(
            command["tabId"]?.jsonPrimitive?.contentOrNull,
            "(async()=>{ try { const r = await (${expression}); return {ok:true, value:r}; } catch(e) { return {ok:false, error:String(e)}; } })()",
            awaitPromise = true,
        )
        val obj = value as? JsonObject
            ?: return buildJsonObject { put("ok", false); put("error", buildJsonObject { put("code", "evaluate_error"); put("message", "非对象返回") }) }
        return if (obj["ok"]?.jsonPrimitive?.contentOrNull == "true") {
            buildJsonObject { put("ok", true); obj["value"]?.let { put("value", it) } }
        } else {
            buildJsonObject {
                put("ok", false)
                put("error", buildJsonObject {
                    put("code", "evaluate_error")
                    put("message", obj["error"]?.jsonPrimitive?.contentOrNull ?: "evaluate 失败")
                })
            }
        }
    }

    private fun cmdSnapshot(command: JsonObject): JsonObject {
        val tabId = command["tabId"]?.jsonPrimitive?.contentOrNull
        ensureBrowserPanel()
        val state = cmdGetState(command)
        val value = cdpEvaluateValue(tabId, SNAPSHOT_SCRIPT)
        val elements = (value as? JsonObject)?.get("elements")?.jsonArray ?: JsonArray(emptyList())
        val truncated = (value as? JsonObject)?.get("truncated")?.jsonPrimitive?.contentOrNull == "true"
        return buildJsonObject {
            put("ok", true)
            put("snapshot", buildJsonObject {
                put("url", state["state"]?.jsonObject?.get("url") ?: JsonPrimitive(""))
                put("title", state["state"]?.jsonObject?.get("title") ?: JsonPrimitive(""))
                put("elements", elements)
                put("truncated", truncated)
            })
        }
    }

    private fun cmdClick(command: JsonObject): JsonObject {
        val tabId = command["tabId"]?.jsonPrimitive?.contentOrNull
        val ref = command["ref"]?.jsonPrimitive?.contentOrNull
        if (ref == null) {
            val x = command["x"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull()
            val y = command["y"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull()
            if (x == null || y == null) throw RuntimeException("click 需要 ref 或 x/y")
            return inputClick(tabId, x, y, modifierMask(command["modifiers"]?.jsonArray))
        }
        val rect = refRect(tabId, ref) ?: throw RuntimeException("ref 元素未找到: $ref")
        val doubleClick = command["doubleClick"]?.jsonPrimitive?.contentOrNull == "true"
        val modifiers = modifierMask(command["modifiers"]?.jsonArray)
        return if (doubleClick) inputDoubleClick(tabId, rect.centerX, rect.centerY, modifiers) else inputClick(tabId, rect.centerX, rect.centerY, modifiers)
    }

    private fun cmdHover(command: JsonObject): JsonObject {
        val tabId = command["tabId"]?.jsonPrimitive?.contentOrNull
        val ref = command["ref"]?.jsonPrimitive?.contentOrNull
        val x = command["x"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull()
        val y = command["y"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull()
        val (cx, cy) = when {
            ref != null -> refRect(tabId, ref)?.let { it.centerX to it.centerY }
                ?: throw RuntimeException("ref 元素未找到: $ref")
            x != null && y != null -> x to y
            else -> throw RuntimeException("hover 需要 ref 或 x/y")
        }
        cdpCommand(
            tabId,
            "Input.dispatchMouseEvent",
            buildJsonObject {
                put("type", "mouseMoved")
                put("x", cx)
                put("y", cy)
                put("button", "left")
                put("pointerType", "mouse")
                put("modifiers", modifierMask(command["modifiers"]?.jsonArray))
            },
        )
        return buildJsonObject { put("ok", true) }
    }

    /** 协议 modifiers（Alt/Control/ControlOrMeta/Meta/Shift）→ CDP 位掩码 */
    private fun modifierMask(modifiers: JsonArray?): Int {
        if (modifiers == null) return 0
        val isMac = System.getProperty("os.name", "").lowercase().contains("mac")
        var m = 0
        for (el in modifiers) {
            when (el.jsonPrimitive.contentOrNull) {
                "Alt" -> m = m or 1
                "Control" -> m = m or 2
                "ControlOrMeta" -> m = m or (if (isMac) 4 else 2)
                "Meta" -> m = m or 4
                "Shift" -> m = m or 8
            }
        }
        return m
    }

    /** ref 元素的中心坐标（evaluate 读取 getBoundingClientRect）*/
    private fun refRect(tabId: String?, ref: String): Rect? {
        val v = cdpEvaluateValue(tabId, "(function(){var e=document.evaluate(${jsString(ref)},document,null,9,null).singleNodeValue;if(!e)return null;var r=e.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height,cx:r.left+r.width/2,cy:r.top+r.height/2};})()")
        val o = v as? JsonObject ?: return null
        return Rect(
            o["x"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull() ?: 0.0,
            o["y"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull() ?: 0.0,
            o["w"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull() ?: 0.0,
            o["h"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull() ?: 0.0,
            o["cx"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull() ?: 0.0,
            o["cy"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull() ?: 0.0,
        )
    }

    private data class Rect(val x: Double, val y: Double, val w: Double, val h: Double, val centerX: Double, val centerY: Double)

    /** CDP 坐标点击（trusted 事件，React onClick 响应）*/
    private fun inputClick(tabId: String?, cx: Double, cy: Double, modifiers: Int = 0): JsonObject {
        for (type in listOf("mousePressed", "mouseReleased")) {
            cdpCommand(
                tabId,
                "Input.dispatchMouseEvent",
                buildJsonObject {
                    put("type", type)
                    put("x", cx)
                    put("y", cy)
                    put("button", "left")
                    put("clickCount", 1)
                    put("pointerType", "mouse")
                    put("modifiers", modifiers)
                },
            )
        }
        return buildJsonObject { put("ok", true) }
    }

    private fun inputDoubleClick(tabId: String?, cx: Double, cy: Double, modifiers: Int = 0): JsonObject {
        cdpCommand(
            tabId,
            "Input.dispatchMouseEvent",
            buildJsonObject {
                put("type", "mousePressed")
                put("x", cx); put("y", cy)
                put("button", "left"); put("clickCount", 2); put("pointerType", "mouse"); put("modifiers", modifiers)
            },
        )
        cdpCommand(
            tabId,
            "Input.dispatchMouseEvent",
            buildJsonObject {
                put("type", "mouseReleased")
                put("x", cx); put("y", cy)
                put("button", "left"); put("clickCount", 2); put("pointerType", "mouse"); put("modifiers", modifiers)
            },
        )
        return buildJsonObject { put("ok", true) }
    }

    private fun cmdFill(command: JsonObject): JsonObject {
        val tabId = command["tabId"]?.jsonPrimitive?.contentOrNull
        val ref = command["ref"]?.jsonPrimitive?.contentOrNull ?: throw RuntimeException("fill 缺少 ref")
        val value = command["value"]?.jsonPrimitive?.contentOrNull ?: throw RuntimeException("fill 缺少 value")
        val r = cdpEvaluateValue(
            tabId,
            "(function(){var e=document.evaluate(${jsString(ref)},document,null,9,null).singleNodeValue;if(!e)return {ok:false,error:'element not found'};e.focus();if(e.isContentEditable){var g=document.createRange();g.selectNodeContents(e);var sl=window.getSelection();sl.removeAllRanges();sl.addRange(g);if(!document.execCommand('insertText',false,${jsString(value)})){e.textContent=${jsString(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}return {ok:true};}var p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype);var s=Object.getOwnPropertyDescriptor(p,'value');if(s&&s.set)s.set.call(e,${jsString(value)});else e.value=${jsString(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true};})()",
        )
        return if ((r as? JsonObject)?.get("ok")?.jsonPrimitive?.contentOrNull == "true") {
            buildJsonObject { put("ok", true) }
        } else {
            buildJsonObject {
                put("ok", false)
                put("error", buildJsonObject { put("code", "ref_not_found"); put("message", "fill 目标未找到: $ref") })
            }
        }
    }

    private fun cmdType(command: JsonObject): JsonObject {
        val tabId = command["tabId"]?.jsonPrimitive?.contentOrNull
        val text = command["text"]?.jsonPrimitive?.contentOrNull ?: throw RuntimeException("type 缺少 text")
        command["ref"]?.jsonPrimitive?.contentOrNull?.let { ref ->
            cdpEvaluateValue(
                tabId,
                "(function(){var e=document.evaluate(${jsString(ref)},document,null,9,null).singleNodeValue;if(e)e.focus();return true;})()",
            )
        }
        // Input.insertText 触发 input 事件（React onChange 响应）；比逐字符 keyDown 兼容性好
        cdpCommand(tabId, "Input.insertText", buildJsonObject { put("text", text) })
        return buildJsonObject { put("ok", true) }
    }

    private fun cmdPress(command: JsonObject): JsonObject {
        val tabId = command["tabId"]?.jsonPrimitive?.contentOrNull
        val key = command["key"]?.jsonPrimitive?.contentOrNull ?: throw RuntimeException("press 缺少 key")
        command["ref"]?.jsonPrimitive?.contentOrNull?.let { ref ->
            cdpEvaluateValue(
                tabId,
                "(function(){var e=document.evaluate(${jsString(ref)},document,null,9,null).singleNodeValue;if(e)e.focus();return true;})()",
            )
        }
        pressKey(tabId, key, modifierMask(command["modifiers"]?.jsonArray))
        return buildJsonObject { put("ok", true) }
    }

    /** 按键派发（keyDown/keyUp + Enter 的 char 事件）*/
    private fun pressKey(tabId: String?, key: String, modifiers: Int) {
        val lower = key.lowercase()
        val keyName: String
        val vkCode: Int
        when (lower) {
            "enter" -> { keyName = "Enter"; vkCode = 13 }
            "tab" -> { keyName = "Tab"; vkCode = 9 }
            "escape" -> { keyName = "Escape"; vkCode = 27 }
            "backspace" -> { keyName = "Backspace"; vkCode = 8 }
            "delete" -> { keyName = "Delete"; vkCode = 46 }
            "arrowdown" -> { keyName = "ArrowDown"; vkCode = 40 }
            "arrowup" -> { keyName = "ArrowUp"; vkCode = 38 }
            "arrowleft" -> { keyName = "ArrowLeft"; vkCode = 37 }
            "arrowright" -> { keyName = "ArrowRight"; vkCode = 39 }
            else -> { keyName = key; vkCode = key.firstOrNull()?.code ?: 0 }
        }
        for (type in listOf("keyDown", "keyUp")) {
            cdpCommand(
                tabId,
                "Input.dispatchKeyEvent",
                buildJsonObject {
                    put("type", type)
                    put("key", keyName)
                    put("code", keyName)
                    put("windowsVirtualKeyCode", vkCode)
                    put("nativeVirtualKeyCode", vkCode)
                    put("modifiers", modifiers)
                },
            )
        }
        if (lower == "enter") {
            // 部分框架需要 char 文本事件才触发提交
            cdpCommand(
                tabId,
                "Input.dispatchKeyEvent",
                buildJsonObject { put("type", "char"); put("text", "\r"); put("modifiers", modifiers) },
            )
        }
    }

    private fun cmdScroll(command: JsonObject): JsonObject {
        val tabId = command["tabId"]?.jsonPrimitive?.contentOrNull
        val x = command["x"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull() ?: 0.0
        val y = command["y"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull() ?: 0.0
        command["ref"]?.jsonPrimitive?.contentOrNull?.let { ref ->
            cdpEvaluateValue(
                tabId,
                "(function(){var e=document.evaluate(${jsString(ref)},document,null,9,null).singleNodeValue;if(e)e.scrollIntoView({block:'center'});return true;})()",
            )
            return buildJsonObject { put("ok", true) }
        }
        cdpEvaluateValue(tabId, "(function(){window.scrollBy($x,$y);return true;})()")
        return buildJsonObject { put("ok", true) }
    }

    private fun cmdWaitFor(command: JsonObject): JsonObject {
        val tabId = command["tabId"]?.jsonPrimitive?.contentOrNull
        val timeoutMs = command["timeoutMs"]?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: 5000
        val selector = command["selector"]?.jsonPrimitive?.contentOrNull
        val text = command["text"]?.jsonPrimitive?.contentOrNull
        val textGone = command["textGone"]?.jsonPrimitive?.contentOrNull
        if (selector == null && text == null && textGone == null) {
            throw RuntimeException("waitFor 需要 selector/text/textGone 之一")
        }
        val v = cdpEvaluateValue(
            tabId,
            "(async function(){var deadline=Date.now()+$timeoutMs;" +
                "while(Date.now()<deadline){var pass=true;" +
                (if (selector != null) "if(!document.querySelector(${jsString(selector)}))pass=false;" else "") +
                (if (text != null) "if(document.body.innerText.indexOf(${jsString(text)})<0)pass=false;" else "") +
                (if (textGone != null) "if(document.body.innerText.indexOf(${jsString(textGone)})>=0)pass=false;" else "") +
                "if(pass)return {ok:true};await new Promise(function(r){setTimeout(r,150);});}" +
                "return {ok:false,error:'timeout after '+$timeoutMs+'ms'};})()",
            awaitPromise = true,
        )
        return if ((v as? JsonObject)?.get("ok")?.jsonPrimitive?.contentOrNull == "true") {
            buildJsonObject { put("ok", true) }
        } else {
            buildJsonObject {
                put("ok", false)
                put("error", buildJsonObject {
                    put("code", "timeout")
                    put("message", (v as? JsonObject)?.get("error")?.jsonPrimitive?.contentOrNull ?: "waitFor 超时")
                })
            }
        }
    }

    private fun cmdElementInfo(command: JsonObject): JsonObject {
        val tabId = command["tabId"]?.jsonPrimitive?.contentOrNull
        val x = command["x"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull()
        val y = command["y"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull()
            ?: throw RuntimeException("elementInfo 缺少 x/y")
        val v = cdpEvaluateValue(
            tabId,
            "(function(){var e=document.elementFromPoint($x,$y);if(!e)return null;var r=e.getBoundingClientRect();" +
                "return {tag:e.tagName.toLowerCase(),name:e.getAttribute('aria-label')||e.innerText.slice(0,80)," +
                "text:e.innerText.slice(0,120),rect:{x:r.left,y:r.top,width:r.width,height:r.height}};})()",
        )
        val o = v as? JsonObject ?: throw RuntimeException("坐标 ($x,$y) 处无元素")
        return buildJsonObject {
            put("ok", true)
            put("element", buildJsonObject {
                put("ref", "")
                put("tag", o["tag"] ?: JsonPrimitive(""))
                put("name", o["name"] ?: JsonPrimitive(""))
                put("text", o["text"] ?: JsonPrimitive(""))
                put("selector", "")
                put("xpath", "")
                put("rect", buildJsonObject {
                    put("x", o["rect"]?.jsonObject?.get("x") ?: JsonPrimitive(0))
                    put("y", o["rect"]?.jsonObject?.get("y") ?: JsonPrimitive(0))
                    put("width", o["rect"]?.jsonObject?.get("width") ?: JsonPrimitive(0))
                    put("height", o["rect"]?.jsonObject?.get("height") ?: JsonPrimitive(0))
                })
                put("inViewport", true)
            })
        }
    }

    // ============ CUA 坐标族（tab.cua / tab.dom_cua 通道，对齐官方 CDP 实现）============

    /** 修饰键规格（CDP keyDown/keyUp 用；ControlOrMeta 由调用方按平台归一）*/
    private data class ModKeySpec(val key: String, val code: String, val vk: Int)

    private fun modKeySpec(name: String): ModKeySpec? = when (name) {
        "Control", "Ctrl" -> ModKeySpec("Control", "ControlLeft", 0x11)
        "Shift" -> ModKeySpec("Shift", "ShiftLeft", 0x10)
        "Alt", "Option" -> ModKeySpec("Alt", "AltLeft", 0x12)
        "Meta", "Command", "Cmd" -> ModKeySpec("Meta", "MetaLeft", 0x5B)
        else -> null
    }

    private fun modKeyBit(name: String): Int = when (name) {
        "Alt", "Option" -> 1
        "Control", "Ctrl" -> 2
        "Meta", "Command", "Cmd" -> 4
        "Shift" -> 8
        else -> 0
    }

    /** cuaScroll：坐标处滚轮（mouseMoved 定位 + mouseWheel 增量，对齐 playwright mouse.wheel）*/
    private fun cmdCuaScroll(command: JsonObject): JsonObject {
        val tabId = command["tabId"]?.jsonPrimitive?.contentOrNull
        val x = command["x"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull()
            ?: throw RuntimeException("cuaScroll 缺少 x")
        val y = command["y"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull()
            ?: throw RuntimeException("cuaScroll 缺少 y")
        val scrollX = command["scrollX"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull() ?: 0.0
        val scrollY = command["scrollY"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull() ?: 0.0
        wheelAt(tabId, x, y, scrollX, scrollY, modifierMask(command["modifiers"]?.jsonArray))
        return buildJsonObject { put("ok", true) }
    }

    private fun wheelAt(tabId: String?, x: Double, y: Double, scrollX: Double, scrollY: Double, modifiers: Int) {
        cdpCommand(
            tabId,
            "Input.dispatchMouseEvent",
            buildJsonObject {
                put("type", "mouseMoved")
                put("x", x)
                put("y", y)
                put("pointerType", "mouse")
                put("modifiers", modifiers)
            },
        )
        cdpCommand(
            tabId,
            "Input.dispatchMouseEvent",
            buildJsonObject {
                put("type", "mouseWheel")
                put("x", x)
                put("y", y)
                put("deltaX", scrollX)
                put("deltaY", scrollY)
                put("modifiers", modifiers)
            },
        )
    }

    /** domCuaScroll：DOM 节点处滚轮（nodeId 即 ref/xpath 取元素中心；缺省视口中心——从页面内读，自由尺寸态下面板物理尺寸≠布局视口）*/
    private fun cmdDomCuaScroll(command: JsonObject): JsonObject {
        val tabId = command["tabId"]?.jsonPrimitive?.contentOrNull
        val nodeId = command["nodeId"]?.jsonPrimitive?.contentOrNull
        val scrollX = command["scrollX"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull() ?: 0.0
        val scrollY = command["scrollY"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull() ?: 0.0
        val center: Pair<Double, Double> = if (nodeId != null) {
            refRect(tabId, nodeId)?.let { it.centerX to it.centerY }
                ?: throw RuntimeException("nodeId 元素未找到: $nodeId")
        } else {
            val v = cdpEvaluateValue(tabId, "(function(){return {x:window.innerWidth/2,y:window.innerHeight/2};})()")
            val o = v as? JsonObject
            (o?.get("x")?.jsonPrimitive?.contentOrNull?.toDoubleOrNull() ?: 0.0) to
                (o?.get("y")?.jsonPrimitive?.contentOrNull?.toDoubleOrNull() ?: 0.0)
        }
        wheelAt(tabId, center.first, center.second, scrollX, scrollY, 0)
        return buildJsonObject { put("ok", true) }
    }

    /** cuaKeypress：组合键（官方 Xci 语义：keys 末位为击键键、其余按住；ControlOrMeta 平台归一）*/
    private fun cmdCuaKeypress(command: JsonObject): JsonObject {
        val tabId = command["tabId"]?.jsonPrimitive?.contentOrNull
        val keys = command["keys"]?.jsonArray
            ?.mapNotNull { it.jsonPrimitive.contentOrNull }
            ?.takeIf { it.isNotEmpty() }
            ?: throw RuntimeException("cuaKeypress 缺少 keys")
        val isMac = System.getProperty("os.name", "").lowercase().contains("mac")
        val norm = keys.map {
            when {
                it == "ControlOrMeta" && isMac -> "Meta"
                it == "ControlOrMeta" -> "Control"
                else -> it
            }
        }
        val mods = norm.dropLast(1)
        val finalKey = norm.last()
        var mask = 0
        for (m in mods) {
            val spec = modKeySpec(m) ?: throw RuntimeException("cuaKeypress 不支持的修饰键: $m")
            mask = mask or modKeyBit(m)
            dispatchModifier(tabId, "keyDown", spec, mask)
        }
        // 末键为修饰键本身（如 keys=["Shift"]）时直接 keyDown/keyUp，其余复用 pressKey 键名映射
        val finalSpec = modKeySpec(finalKey)
        if (finalSpec != null) {
            val m = mask or modKeyBit(finalKey)
            dispatchModifier(tabId, "keyDown", finalSpec, m)
            dispatchModifier(tabId, "keyUp", finalSpec, m)
        } else {
            pressKey(tabId, finalKey, mask)
        }
        // 释放阶段递减 mask：keyUp 事件携带"此刻仍按住"的修饰集（对齐真实键盘语义）
        var remaining = mask
        for (m in mods.asReversed()) {
            val spec = modKeySpec(m) ?: continue
            dispatchModifier(tabId, "keyUp", spec, remaining)
            remaining = remaining and modKeyBit(m).inv()
        }
        return buildJsonObject { put("ok", true) }
    }

    private fun dispatchModifier(tabId: String?, type: String, spec: ModKeySpec, modifiers: Int) {
        cdpCommand(
            tabId,
            "Input.dispatchKeyEvent",
            buildJsonObject {
                put("type", type)
                put("key", spec.key)
                put("code", spec.code)
                put("windowsVirtualKeyCode", spec.vk)
                put("nativeVirtualKeyCode", spec.vk)
                put("modifiers", modifiers)
            },
        )
    }

    /** cuaDrag：显式路径拖拽（对齐官方 rQr：首点按下、逐点移动、末点释放；相邻点 4 步插值）*/
    private fun cmdCuaDrag(command: JsonObject): JsonObject {
        val tabId = command["tabId"]?.jsonPrimitive?.contentOrNull
        val path = command["path"]?.jsonArray?.mapNotNull { el ->
            val o = el as? JsonObject ?: return@mapNotNull null
            val px = o["x"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull() ?: return@mapNotNull null
            val py = o["y"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull() ?: return@mapNotNull null
            px to py
        }?.takeIf { it.isNotEmpty() }
            ?: throw RuntimeException("cuaDrag 缺少 path（至少一个坐标点）")
        val modifiers = modifierMask(command["modifiers"]?.jsonArray)
        fun mouse(type: String, x: Double, y: Double, clickCount: Int? = null) {
            cdpCommand(
                tabId,
                "Input.dispatchMouseEvent",
                buildJsonObject {
                    put("type", type)
                    put("x", x)
                    put("y", y)
                    put("button", "left")
                    clickCount?.let { put("clickCount", it) }
                    put("pointerType", "mouse")
                    put("modifiers", modifiers)
                },
            )
        }
        val first = path.first()
        mouse("mousePressed", first.first, first.second, 1)
        for (i in 1 until path.size) {
            val from = path[i - 1]
            val to = path[i]
            val steps = 4
            for (s in 1..steps) {
                val t = s.toDouble() / steps
                mouse("mouseMoved", from.first + (to.first - from.first) * t, from.second + (to.second - from.second) * t)
                Thread.sleep(16)
            }
        }
        val last = path.last()
        mouse("mouseReleased", last.first, last.second, 1)
        return buildJsonObject { put("ok", true) }
    }

    // ============ Phase 2：select / check / drag ============

    /** select：原生 select 设值（nativeSetter + input/change 事件，React 受控兼容；多选取并集）*/
    private fun cmdSelect(command: JsonObject): JsonObject {
        val tabId = command["tabId"]?.jsonPrimitive?.contentOrNull
        val ref = command["ref"]?.jsonPrimitive?.contentOrNull ?: throw RuntimeException("select 缺少 ref")
        val values = command["values"]?.jsonArray
            ?.mapNotNull { it.jsonPrimitive.contentOrNull }
            ?.takeIf { it.isNotEmpty() }
            ?: throw RuntimeException("select 缺少 values（至少一项）")
        val valuesJson = Json.encodeToString(JsonArray.serializer(), JsonArray(values.map { JsonPrimitive(it) }))
        val r = cdpEvaluateValue(
            tabId,
            "(function(){var e=document.evaluate(${jsString(ref)},document,null,9,null).singleNodeValue;" +
                "if(!e)return {ok:false,error:'element not found'};" +
                "if(e.tagName!=='SELECT')return {ok:false,error:'not a select element: '+e.tagName};" +
                "var values=$valuesJson;" +
                "var d=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value');" +
                "if(e.multiple){for(var i=0;i<e.options.length;i++){e.options[i].selected=values.indexOf(e.options[i].value)>=0;}}" +
                "else{var v=values[values.length-1];if(d&&d.set)d.set.call(e,v);else e.value=v;}" +
                "e.dispatchEvent(new Event('input',{bubbles:true}));" +
                "e.dispatchEvent(new Event('change',{bubbles:true}));" +
                "return {ok:true};})()",
        )
        val obj = r as? JsonObject
        return if (obj?.get("ok")?.jsonPrimitive?.contentOrNull == "true") {
            buildJsonObject { put("ok", true) }
        } else {
            buildJsonObject {
                put("ok", false)
                put("error", buildJsonObject {
                    put("code", "ref_not_found")
                    put("message", obj?.get("error")?.jsonPrimitive?.contentOrNull ?: "select 失败: $ref")
                })
            }
        }
    }

    /** check：checkbox/radio 目标状态与当前不同则真实点击（trusted click，radio 只能选中）*/
    private fun cmdCheck(command: JsonObject): JsonObject {
        val tabId = command["tabId"]?.jsonPrimitive?.contentOrNull
        val ref = command["ref"]?.jsonPrimitive?.contentOrNull ?: throw RuntimeException("check 缺少 ref")
        val checked = command["checked"]?.jsonPrimitive?.contentOrNull?.toBooleanStrictOrNull() ?: true
        val current = cdpEvaluateValue(
            tabId,
            "(function(){var e=document.evaluate(${jsString(ref)},document,null,9,null).singleNodeValue;" +
                "if(!e)return {ok:false,error:'element not found'};" +
                "var t=(e.getAttribute('type')||'').toLowerCase();" +
                "if(t!=='checkbox'&&t!=='radio')return {ok:false,error:'not a checkbox or radio: '+e.tagName+':'+t};" +
                "return {ok:true,checked:e.checked===true};})()",
        )
        val obj = current as? JsonObject
        if (obj?.get("ok")?.jsonPrimitive?.contentOrNull != "true") {
            return buildJsonObject {
                put("ok", false)
                put("error", buildJsonObject {
                    put("code", "ref_not_found")
                    put("message", obj?.get("error")?.jsonPrimitive?.contentOrNull ?: "check 目标未找到: $ref")
                })
            }
        }
        val isChecked = obj["checked"]?.jsonPrimitive?.contentOrNull == "true"
        // radio 语义上点不掉：checked=false 的 radio 保持原状（尽力而为，与浏览器一致）
        if (isChecked == checked) return buildJsonObject { put("ok", true) }
        val rect = refRect(tabId, ref) ?: throw RuntimeException("ref 元素未找到: $ref")
        return inputClick(tabId, rect.centerX, rect.centerY)
    }

    /** drag：mousedown → 插值 mousemove（sortable 类库依赖）→ mouseup；HTML5 原生 DnD 不在此列 */
    private fun cmdDrag(command: JsonObject): JsonObject {
        val tabId = command["tabId"]?.jsonPrimitive?.contentOrNull
        val fromRef = command["fromRef"]?.jsonPrimitive?.contentOrNull
        val toRef = command["toRef"]?.jsonPrimitive?.contentOrNull
        val fromObj = command["from"]?.jsonObject
        val toObj = command["to"]?.jsonObject
        val from: Pair<Double, Double> = when {
            fromRef != null -> refRect(tabId, fromRef)?.let { it.centerX to it.centerY }
                ?: throw RuntimeException("fromRef 元素未找到: $fromRef")
            fromObj != null -> (fromObj["x"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull()
                ?: throw RuntimeException("drag from.x 缺少")) to
                (fromObj["y"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull()
                    ?: throw RuntimeException("drag from.y 缺少"))
            else -> throw RuntimeException("drag 需要 fromRef 或 from")
        }
        val to: Pair<Double, Double> = when {
            toRef != null -> refRect(tabId, toRef)?.let { it.centerX to it.centerY }
                ?: throw RuntimeException("toRef 元素未找到: $toRef")
            toObj != null -> (toObj["x"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull()
                ?: throw RuntimeException("drag to.x 缺少")) to
                (toObj["y"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull()
                    ?: throw RuntimeException("drag to.y 缺少"))
            else -> throw RuntimeException("drag 需要 toRef 或 to")
        }
        val modifiers = modifierMask(command["modifiers"]?.jsonArray)
        fun mouse(type: String, x: Double, y: Double, clickCount: Int? = null) {
            cdpCommand(
                tabId,
                "Input.dispatchMouseEvent",
                buildJsonObject {
                    put("type", type)
                    put("x", x)
                    put("y", y)
                    put("button", "left")
                    clickCount?.let { put("clickCount", it) }
                    put("pointerType", "mouse")
                    put("modifiers", modifiers)
                },
            )
        }
        mouse("mousePressed", from.first, from.second, 1)
        val steps = 10
        for (i in 1..steps) {
            val t = i.toDouble() / steps
            mouse("mouseMoved", from.first + (to.first - from.first) * t, from.second + (to.second - from.second) * t)
            Thread.sleep(16) // 给页面 mousemove 处理窗口（sortable 库需要）
        }
        mouse("mouseReleased", to.first, to.second, 1)
        return buildJsonObject { put("ok", true) }
    }

    // ============ Phase 2：JS 对话框 ============

    /** getDialog：查询挂起的 alert/confirm/prompt/beforeunload（无则不带 dialog 字段）*/
    private fun cmdGetDialog(command: JsonObject): JsonObject {
        val tabId = command["tabId"]?.jsonPrimitive?.contentOrNull
        val panel = ensureBrowserPanel() ?: throw RuntimeException("浏览器面板不可用")
        var dialog: ZCodeBrowserPanel.PendingDialog? = null
        SwingUtilities.invokeAndWait {
            dialog = panel.pendingDialogOf(tabId)
        }
        // 兜「触发后立即查询」竞态：evaluate 注入的 setTimeout(0) 触发 confirm 时，
        // evaluate 命令已先返回（实测 22:49 会话），首次 null 短等重查一次
        if (dialog == null) {
            Thread.sleep(150)
            SwingUtilities.invokeAndWait {
                dialog = panel.pendingDialogOf(tabId)
            }
        }
        val d = dialog ?: return buildJsonObject { put("ok", true) }
        return buildJsonObject {
            put("ok", true)
            put("dialog", buildJsonObject {
                put("type", d.type)
                put("message", d.message)
                d.defaultPrompt?.let { put("defaultPrompt", it) }
            })
        }
    }

    /** handleDialog：accept/dismiss 挂起对话框（prompt 带 promptText）*/
    private fun cmdHandleDialog(command: JsonObject): JsonObject {
        val tabId = command["tabId"]?.jsonPrimitive?.contentOrNull
        val accept = command["accept"]?.jsonPrimitive?.contentOrNull?.toBooleanStrictOrNull()
            ?: throw RuntimeException("handleDialog 缺少 accept")
        val promptText = command["promptText"]?.jsonPrimitive?.contentOrNull
        val panel = ensureBrowserPanel() ?: throw RuntimeException("浏览器面板不可用")
        var handled = false
        SwingUtilities.invokeAndWait {
            handled = panel.handleDialog(tabId, accept, promptText)
        }
        return if (handled) {
            buildJsonObject { put("ok", true) }
        } else {
            buildJsonObject {
                put("ok", false)
                put("error", buildJsonObject {
                    put("code", "execution_error")
                    put("message", "无挂起的对话框（tabId=$tabId）")
                })
            }
        }
    }

    // ============ Phase 2：面板可见性 ============

    /**
     * browserVisibilityGet：浏览器是否对用户可见（激活会话分栏展开，或存在独立
     * 浏览器 Content）；客户端强校验 value 为 boolean
     */
    private fun cmdVisibilityGet(): JsonObject {
        var visible = false
        SwingUtilities.invokeAndWait {
            val chatPanel = project.zCodeService().getActivePanel()
            visible = chatPanel?.isEmbeddedBrowserVisible()
                ?: (ZCodeToolWindowFactory.getToolWindow(project)?.contentManager?.contents
                    ?.any { it.component is ZCodeBrowserPanel } ?: false)
        }
        return buildJsonObject {
            put("ok", true)
            put("value", visible)
        }
    }

    /** browserVisibilitySet：展开（顺带选中会话 Content，用户看得见）/收起浏览器分栏 */
    private fun cmdVisibilitySet(command: JsonObject): JsonObject {
        val visible = command["visible"]?.jsonPrimitive?.contentOrNull?.toBooleanStrictOrNull()
            ?: throw RuntimeException("browserVisibilitySet 缺少 visible")
        var applied = false
        SwingUtilities.invokeAndWait {
            val chatPanel = project.zCodeService().getActivePanel()
            applied = if (chatPanel != null) {
                chatPanel.setEmbeddedBrowserVisible(visible)
            } else {
                // 无会话面板的兜底形态：选中/收起独立浏览器 Content
                val tw = ZCodeToolWindowFactory.getToolWindow(project)
                val content = tw?.contentManager?.contents?.firstOrNull { it.component is ZCodeBrowserPanel }
                if (content != null) {
                    if (visible) {
                        content.manager?.setSelectedContent(content)
                        tw.show(null)
                    }
                    true
                } else {
                    false
                }
            }
        }
        return buildJsonObject {
            put("ok", true)
            put("value", applied)
        }
    }

    // ============ 生命周期标记（对齐官方 tab-cleanup 语义：仅标记状态，不关闭不夺控）============

    /** markDeliverable / markHandoff：标记 tab 生命周期（deliverable=成果页 / handoff=待续页）*/
    private fun cmdMarkLifecycle(command: JsonObject, lifecycle: String): JsonObject {
        val method = command["method"]?.jsonPrimitive?.contentOrNull ?: lifecycle
        val tabId = command["tabId"]?.jsonPrimitive?.contentOrNull
            ?: throw RuntimeException("$method 缺少 tabId")
        val panel = findExistingBrowserPanel()
            ?: throw RuntimeException("tab 不存在: $tabId（无浏览器面板）")
        var marked = false
        SwingUtilities.invokeAndWait { marked = panel.setTabLifecycle(tabId, lifecycle) }
        return if (marked) {
            buildJsonObject { put("ok", true) }
        } else {
            buildJsonObject {
                put("ok", false)
                put("error", buildJsonObject {
                    put("code", "ref_not_found")
                    put("message", "tab 不存在: $tabId")
                })
            }
        }
    }

    /** finalize：单 tab 收尾标记（deliverable=true→deliverable，否则 handoff；Tab 包装器总带 tabId）*/
    private fun cmdFinalize(command: JsonObject): JsonObject {
        val tabId = command["tabId"]?.jsonPrimitive?.contentOrNull
        val deliverable = command["deliverable"]?.jsonPrimitive?.contentOrNull?.toBooleanStrictOrNull() ?: false
        val status = if (deliverable) "deliverable" else "handoff"
        val panel = findExistingBrowserPanel() ?: throw RuntimeException("浏览器面板不可用")
        var marked = false
        SwingUtilities.invokeAndWait { marked = panel.setTabLifecycle(tabId, status) }
        if (!marked) throw RuntimeException("浏览器 tab 不可用（tabId=$tabId）")
        return buildJsonObject { put("ok", true) }
    }

    /** finalizeTabs：批量标记（官方语义：keep 内的标记对应状态，未列出的保持原状态且一律不关闭）*/
    private fun cmdFinalizeTabs(command: JsonObject): JsonObject {
        val keep = command["keep"]?.jsonArray ?: JsonArray(emptyList())
        val panel = findExistingBrowserPanel()
        if (panel != null) {
            var marked = 0
            var missing = 0
            for (entry in keep) {
                val o = entry as? JsonObject ?: continue
                val tabId = o["tabId"]?.jsonPrimitive?.contentOrNull ?: continue
                val status = o["status"]?.jsonPrimitive?.contentOrNull ?: continue
                var okMark = false
                SwingUtilities.invokeAndWait { okMark = panel.setTabLifecycle(tabId, status) }
                if (okMark) marked++ else missing++
            }
            log.info("[browser-use] finalizeTabs 标记 $marked 个 tab（未匹配 $missing，未列出的保持原状态）")
        }
        return buildJsonObject { put("ok", true) }
    }

    /** nameSession：记录会话名（browserList metadata 暴露）*/
    private fun cmdNameSession(command: JsonObject): JsonObject {
        val name = command["name"]?.jsonPrimitive?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }
            ?: throw RuntimeException("nameSession 缺少 name")
        sessionName = name
        log.info("[browser-use] 浏览器会话命名: $name")
        return buildJsonObject { put("ok", true) }
    }

    /** close：关闭命令路由的 tab（AI 显式 tab.close()；唯一 tab 复位为欢迎 tab，面板保持可用）*/
    private fun cmdCloseTab(command: JsonObject): JsonObject {
        val tabId = command["tabId"]?.jsonPrimitive?.contentOrNull
        val panel = ensureBrowserPanel() ?: throw RuntimeException("浏览器面板不可用")
        var closed = false
        SwingUtilities.invokeAndWait { closed = panel.closeProtocolTab(tabId) }
        return if (closed) {
            buildJsonObject { put("ok", true) }
        } else {
            buildJsonObject {
                put("ok", false)
                put("error", buildJsonObject {
                    put("code", "ref_not_found")
                    put("message", "tab 不存在: $tabId")
                })
            }
        }
    }

    // ============ Phase 3：Playwright 透传 ============

    /**
     * playwright 命令：AI skill 的默认工作流（domSnapshot 读页面 → getByRole 等 locator 操作）。
     * selector 是客户端编译的 Playwright 引擎语法（internal:role=、internal:text=、css，`>>` 链接），
     * 由注入的 JS 引擎（PW_SELECTOR_ENGINE）解析。waitForEvent/downloadPath/fileChooserSetFiles
     * 与官方 iab 后端一致返回不可用。
     */
    private fun cmdPlaywright(command: JsonObject): JsonObject {
        val action = command["action"]?.jsonObject
            ?: throw RuntimeException("playwright 缺少 action")
        val name = action["name"]?.jsonPrimitive?.contentOrNull
            ?: throw RuntimeException("playwright action 缺少 name")
        val tabId = command["tabId"]?.jsonPrimitive?.contentOrNull
        return when (name) {
            "domSnapshot" -> pwDomSnapshot(tabId)
            "elementInfo" -> pwElementInfo(tabId, action)
            "elementScreenshot" -> pwElementScreenshot(tabId, action)
            "evaluate" -> pwEvaluate(tabId, action)
            "waitForLoadState" -> pwWaitForLoadState(tabId, action)
            "waitForURL" -> pwWaitForUrl(tabId, action)
            "locator" -> pwLocator(tabId, action)
            // 与官方 iab 后端行为一致：这三个 action 官方也 throw unavailable
            "waitForEvent", "downloadPath", "fileChooserSetFiles" -> pwUnavailable("action '$name'")
            else -> pwUnavailable("action '$name'")
        }
    }

    /** playwrightWaitForTimeout：固定等待（skill 文档里的逃生舱）*/
    private fun cmdPlaywrightWaitTimeout(command: JsonObject): JsonObject {
        val timeoutMs = command["timeoutMs"]?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: 0L
        if (timeoutMs > 0) Thread.sleep(timeoutMs.coerceAtMost(30_000))
        return buildJsonObject { put("ok", true) }
    }

    private fun pwUnavailable(what: String): JsonObject = buildJsonObject {
        put("ok", false)
        put("error", buildJsonObject {
            put("code", "capability_unsupported")
            put("message", "Playwright $what 在 iab 后端不可用")
        })
    }

    private fun pwTimeoutMs(action: JsonObject): Long =
        action["timeoutMs"]?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: 3000L

    private fun pwOkValue(value: JsonElement?): JsonObject = buildJsonObject {
        put("ok", true)
        value?.let { put("value", it) }
    }

    private fun pwErrorResult(message: String, code: String = "execution_error"): JsonObject = buildJsonObject {
        put("ok", false)
        put("error", buildJsonObject { put("code", code); put("message", message) })
    }

    /** domSnapshot：注入脚本生成近似 Playwright ariaSnapshot 的 ARIA 树字符串（AI 主读取通道）*/
    private fun pwDomSnapshot(tabId: String?): JsonObject {
        ensureBrowserPanel()
        val value = cdpEvaluateValue(tabId, PW_ARIA_SNAPSHOT_SCRIPT)
        return pwOkValue(value ?: JsonPrimitive(""))
    }

    /** elementInfo：坐标处全层元素信息（官方语义 elementsFromPoint 过滤可交互）*/
    private fun pwElementInfo(tabId: String?, action: JsonObject): JsonObject {
        val x = action["x"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull()
            ?: throw RuntimeException("elementInfo 缺少 x")
        val y = action["y"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull()
            ?: throw RuntimeException("elementInfo 缺少 y")
        val includeAll = action["includeNonInteractable"]?.jsonPrimitive?.contentOrNull == "true"
        val v = cdpEvaluateValue(
            tabId,
            "(function(){var out=[];var els=document.elementsFromPoint($x,$y);" +
                "var INTER='a[href],button,input,textarea,select,[role],[onclick],[tabindex],summary,label';" +
                "for(var i=0;i<els.length&&i<12;i++){var e=els[i];" +
                "if(!" + includeAll + "&&!e.matches(INTER))continue;" +
                "var r=e.getBoundingClientRect();" +
                "out.push({tag:e.tagName.toLowerCase(),name:(e.getAttribute('aria-label')||e.innerText||'').trim().slice(0,80)," +
                "text:(e.innerText||'').trim().slice(0,120)," +
                "rect:{x:r.left,y:r.top,width:r.width,height:r.height}});}" +
                "return out;})()",
        )
        return pwOkValue(v ?: JsonArray(emptyList()))
    }

    /** elementScreenshot：全屏截图后按元素 rect 裁剪（javax.imageio 零依赖）*/
    private fun pwElementScreenshot(tabId: String?, action: JsonObject): JsonObject {
        val x = action["x"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull()
            ?: throw RuntimeException("elementScreenshot 缺少 x")
        val y = action["y"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull()
            ?: throw RuntimeException("elementScreenshot 缺少 y")
        val v = cdpEvaluateValue(
            tabId,
            "(function(){var e=document.elementFromPoint($x,$y);if(!e)return null;var r=e.getBoundingClientRect();" +
                "return {x:r.left,y:r.top,w:r.width,h:r.height};})()",
        )
        val o = v as? JsonObject ?: throw RuntimeException("坐标 ($x,$y) 处无元素")
        ensureBrowserPanel()
        val result = cdpCommand(tabId, "Page.captureScreenshot", buildJsonObject { put("format", "png") })
        val base64 = result["data"]?.jsonPrimitive?.contentOrNull
            ?: throw RuntimeException("screenshot 无 data 返回")
        // 回传链路排查：确认 executor 侧拿到非空数据（emitImage 不达模型时先看这里有无正常字节数）
        log.info("[browser-use] screenshot captured: ${base64.length} base64 chars")
        val rx = (o["x"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull() ?: 0.0).toInt()
        val ry = (o["y"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull() ?: 0.0).toInt()
        val rw = (o["w"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull() ?: 0.0).toInt().coerceAtLeast(1)
        val rh = (o["h"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull() ?: 0.0).toInt().coerceAtLeast(1)
        val cropped = cropPngBase64(base64, rx, ry, rw, rh)
        return buildJsonObject {
            put("ok", true)
            put("image", buildJsonObject {
                put("base64", cropped)
                put("mimeType", "image/png")
            })
        }
    }

    private fun cropPngBase64(base64: String, x: Int, y: Int, w: Int, h: Int): String = try {
        val img = javax.imageio.ImageIO.read(java.io.ByteArrayInputStream(java.util.Base64.getDecoder().decode(base64)))
        val cx = x.coerceIn(0, img.width - 1)
        val cy = y.coerceIn(0, img.height - 1)
        val cw = w.coerceIn(1, img.width - cx)
        val ch = h.coerceIn(1, img.height - cy)
        val baos = java.io.ByteArrayOutputStream()
        javax.imageio.ImageIO.write(img.getSubimage(cx, cy, cw, ch), "png", baos)
        java.util.Base64.getEncoder().encodeToString(baos.toByteArray())
    } catch (e: Exception) {
        log.warn("[browser-use] elementScreenshot 裁剪失败，退回全图: ${e.message}")
        base64
    }

    /** playwright evaluate：expressionKind=function 时包 (fn)(arg)；带超时竞争 */
    private fun pwEvaluate(tabId: String?, action: JsonObject): JsonObject {
        val expression = action["expression"]?.jsonPrimitive?.contentOrNull
            ?: throw RuntimeException("playwright evaluate 缺少 expression")
        val kind = action["expressionKind"]?.jsonPrimitive?.contentOrNull ?: "string"
        val timeout = pwTimeoutMs(action)
        val argJson = action["arg"]?.let { Json.encodeToString(JsonElement.serializer(), it) } ?: "null"
        val call = if (kind == "function") "(${expression})(${argJson})" else "(${expression})"
        val value = cdpEvaluateValue(
            tabId,
            "(async function(){var p=Promise.resolve().then(function(){return " + call + ";});" +
                "var t=new Promise(function(_,rej){setTimeout(function(){rej(new Error('timeout after ' + $timeout + 'ms'));},$timeout);});" +
                "try{var r=await Promise.race([p,t]);return {ok:true,value:r};}" +
                "catch(e){return {ok:false,error:String(e)};}})()",
            awaitPromise = true,
        ) as? JsonObject ?: return pwErrorResult("evaluate 非对象返回")
        return if (value["ok"]?.jsonPrimitive?.contentOrNull == "true") {
            pwOkValue(value["value"])
        } else {
            pwErrorResult(value["error"]?.jsonPrimitive?.contentOrNull ?: "evaluate 失败")
        }
    }

    /** waitForLoadState：readyState 轮询（networkidle 与官方一致不支持）*/
    private fun pwWaitForLoadState(tabId: String?, action: JsonObject): JsonObject {
        val state = action["state"]?.jsonPrimitive?.contentOrNull ?: "load"
        if (state == "networkidle") {
            throw RuntimeException("playwright_wait_for_load_state does not support networkidle")
        }
        val timeout = pwTimeoutMs(action)
        val want = if (state == "domcontentloaded") "'interactive','complete'" else "'complete'"
        val v = cdpEvaluateValue(
            tabId,
            "(async function(){var want=[$want];var deadline=Date.now()+$timeout;" +
                "while(Date.now()<deadline){if(want.indexOf(document.readyState)>=0)return {ok:true};" +
                "await new Promise(function(r){setTimeout(r,100);});}" +
                "return {ok:false,error:'timeout: readyState='+document.readyState};})()",
            awaitPromise = true,
        )
        return if ((v as? JsonObject)?.get("ok")?.jsonPrimitive?.contentOrNull == "true") {
            buildJsonObject { put("ok", true) }
        } else {
            pwErrorResult((v as? JsonObject)?.get("error")?.jsonPrimitive?.contentOrNull ?: "waitForLoadState 超时", "timeout")
        }
    }

    /** waitForURL：轮询 location.href（精确或前缀匹配；waitUntil 仅 load 语义）*/
    private fun pwWaitForUrl(tabId: String?, action: JsonObject): JsonObject {
        val url = action["url"]?.jsonPrimitive?.contentOrNull
            ?: throw RuntimeException("waitForURL 缺少 url")
        if (action["waitUntil"]?.jsonPrimitive?.contentOrNull == "networkidle") {
            throw RuntimeException("playwright_wait_for_url does not support networkidle")
        }
        val timeout = pwTimeoutMs(action)
        val v = cdpEvaluateValue(
            tabId,
            "(async function(){var deadline=Date.now()+$timeout;" +
                "while(Date.now()<deadline){var u=location.href;" +
                "if(u===" + jsString(url) + "||u.indexOf(" + jsString(url) + ")===0)return {ok:true};" +
                "await new Promise(function(r){setTimeout(r,100);});}" +
                "return {ok:false,error:'timeout: url='+location.href};})()",
            awaitPromise = true,
        )
        return if ((v as? JsonObject)?.get("ok")?.jsonPrimitive?.contentOrNull == "true") {
            buildJsonObject { put("ok", true) }
        } else {
            pwErrorResult((v as? JsonObject)?.get("error")?.jsonPrimitive?.contentOrNull ?: "waitForURL 超时", "timeout")
        }
    }

    /** locator 命令：16 种操作，selector 经 PW_SELECTOR_ENGINE 解析 */
    private fun pwLocator(tabId: String?, action: JsonObject): JsonObject {
        val selector = action["selector"]?.jsonPrimitive?.contentOrNull
            ?: throw RuntimeException("locator 缺少 selector")
        val op = action["operation"]?.jsonPrimitive?.contentOrNull
            ?: throw RuntimeException("locator 缺少 operation")
        val timeout = pwTimeoutMs(action)
        val selJson = jsString(selector)

        fun queryFirstRectOnce(): Rect? {
            val v = cdpEvaluateValue(
                tabId,
                "(function(){" + PW_SELECTOR_ENGINE + "var els=__pwq(" + selJson + ");" +
                    "if(!els.length)return null;var e=els[0];var r=e.getBoundingClientRect();" +
                    "return {x:r.left,y:r.top,w:r.width,h:r.height,cx:r.left+r.width/2,cy:r.top+r.height/2};})()",
            )
            val o = v as? JsonObject ?: return null
            return Rect(
                o["x"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull() ?: 0.0,
                o["y"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull() ?: 0.0,
                o["w"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull() ?: 0.0,
                o["h"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull() ?: 0.0,
                o["cx"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull() ?: 0.0,
                o["cy"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull() ?: 0.0,
            )
        }

        /** 引擎查询首个匹配的矩形；按 Playwright 语义等待元素出现（页面加载中操作不立即失败）*/
        fun queryFirstRect(): Rect? {
            val deadline = System.currentTimeMillis() + timeout
            var v = queryFirstRectOnce()
            while (v == null && System.currentTimeMillis() < deadline) {
                Thread.sleep(120)
                v = queryFirstRectOnce()
            }
            return v
        }

        /** 引擎 + 逐元素读表达式：readExpr 里 EL 指代当前元素 */
        fun queryRead(readExpr: String, firstOnly: Boolean): JsonElement? = cdpEvaluateValue(
            tabId,
            "(function(){" + PW_SELECTOR_ENGINE + "var els=__pwq(" + selJson + ");" +
                "if(!els.length)return null;" +
                (if (firstOnly) "var EL=els[0];return " + readExpr + ";"
                else "var out=[];for(var i=0;i<els.length;i++){var EL=els[i];out.push(" + readExpr + ");}return out;") +
                "})()",
        )

        return when (op) {
            "count" -> pwOkValue(
                cdpEvaluateValue(
                    tabId,
                    "(function(){" + PW_SELECTOR_ENGINE + "return __pwq(" + selJson + ").length;})()",
                ) ?: JsonPrimitive(0),
            )

            "click", "dblclick" -> {
                val rect = queryFirstRect()
                    ?: return pwErrorResult("locator 未匹配到元素: $selector", "ref_not_found")
                val modifiers = modifierMask(action["modifiers"]?.jsonArray)
                if (op == "dblclick") {
                    inputDoubleClick(tabId, rect.centerX, rect.centerY, modifiers)
                } else {
                    inputClick(tabId, rect.centerX, rect.centerY, modifiers)
                }
                buildJsonObject { put("ok", true) }
            }

            "fill" -> {
                val value = action["value"]?.jsonPrimitive?.contentOrNull
                    ?: throw RuntimeException("locator fill 缺少 value")
                val r = cdpEvaluateValue(
                    tabId,
                    "(function(){" + PW_SELECTOR_ENGINE + "var els=__pwq(" + selJson + ");" +
                        "if(!els.length)return {ok:false,error:'no match'};var e=els[0];e.focus();" +
                        "if(e.isContentEditable){var g=document.createRange();g.selectNodeContents(e);var sl=window.getSelection();sl.removeAllRanges();sl.addRange(g);if(!document.execCommand('insertText',false," + jsString(value) + ")){e.textContent=" + jsString(value) + ";e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}return {ok:true};}" +
                        "var p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype);" +
                        "var s=Object.getOwnPropertyDescriptor(p,'value');" +
                        "if(s&&s.set)s.set.call(e," + jsString(value) + ");else e.value=" + jsString(value) + ";" +
                        "e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));" +
                        "return {ok:true};})()",
                )
                if ((r as? JsonObject)?.get("ok")?.jsonPrimitive?.contentOrNull == "true") {
                    buildJsonObject { put("ok", true) }
                } else {
                    pwErrorResult("locator fill 未匹配到元素: $selector", "ref_not_found")
                }
            }

            "press" -> {
                val key = action["value"]?.jsonPrimitive?.contentOrNull
                    ?: throw RuntimeException("locator press 缺少 key")
                cdpEvaluateValue(
                    tabId,
                    "(function(){" + PW_SELECTOR_ENGINE + "var els=__pwq(" + selJson + ");if(els.length)els[0].focus();return true;})()",
                )
                pressKey(tabId, key, modifierMask(action["modifiers"]?.jsonArray))
                buildJsonObject { put("ok", true) }
            }

            "innerText" -> pwOkValue(queryRead("(EL.innerText||'')", true) ?: JsonPrimitive(""))
            "textContent" -> pwOkValue(queryRead("(EL.textContent||'')", true) ?: JsonPrimitive(""))
            "getAttribute" -> {
                val attr = action["attribute"]?.jsonPrimitive?.contentOrNull
                    ?: throw RuntimeException("locator getAttribute 缺少 attribute")
                pwOkValue(queryRead("EL.getAttribute(" + jsString(attr) + ")", true))
            }
            "allTextContents" -> pwOkValue(queryRead("(EL.innerText||'')", false) ?: JsonArray(emptyList()))
            "isEnabled" -> pwOkValue(
                queryRead("(!EL.disabled&&EL.getAttribute('aria-disabled')!=='true')", true) ?: JsonPrimitive(false),
            )
            "isVisible" -> pwOkValue(
                queryRead("(function(){var r=EL.getBoundingClientRect();if(r.width<=0&&r.height<=0)return false;var s=getComputedStyle(EL);return s.visibility!=='hidden'&&s.display!=='none';})()", true)
                    ?: JsonPrimitive(false),
            )

            "setChecked" -> {
                val checked = action["checked"]?.jsonPrimitive?.contentOrNull?.toBooleanStrictOrNull() ?: true
                val cur = queryRead("(EL.checked===true)", true)?.jsonPrimitive?.contentOrNull
                if (cur == null) return pwErrorResult("locator 未匹配到元素: $selector", "ref_not_found")
                if (cur != checked.toString()) {
                    val rect = queryFirstRect()
                        ?: return pwErrorResult("locator 未匹配到元素: $selector", "ref_not_found")
                    inputClick(tabId, rect.centerX, rect.centerY)
                }
                buildJsonObject { put("ok", true) }
            }

            "selectOption" -> {
                val selections = action["selections"]?.jsonArray
                    ?: throw RuntimeException("locator selectOption 缺少 selections")
                val selArr = Json.encodeToString(JsonArray.serializer(), selections)
                val r = cdpEvaluateValue(
                    tabId,
                    "(function(){" + PW_SELECTOR_ENGINE + "var els=__pwq(" + selJson + ");" +
                        "if(!els.length)return {ok:false,error:'no match'};var e=els[0];" +
                        "if(e.tagName!=='SELECT')return {ok:false,error:'not a select'};" +
                        "var sels=$selArr;var values=[];" +
                        "for(var j=0;j<sels.length;j++){var s=sels[j];" +
                        "for(var i=0;i<e.options.length;i++){var o=e.options[i];" +
                        "if((s.value!==undefined&&o.value===s.value)||(s.label!==undefined&&o.text===s.label)||(s.index!==undefined&&i===s.index)){values.push(o.value);break;}}}" +
                        "var d=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value');" +
                        "if(e.multiple){for(var k=0;k<e.options.length;k++){e.options[k].selected=values.indexOf(e.options[k].value)>=0;}}" +
                        "else{if(values.length){if(d&&d.set)d.set.call(e,values[values.length-1]);else e.value=values[values.length-1];}}" +
                        "e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));" +
                        "return {ok:true};})()",
                )
                if ((r as? JsonObject)?.get("ok")?.jsonPrimitive?.contentOrNull == "true") {
                    buildJsonObject { put("ok", true) }
                } else {
                    pwErrorResult(
                        (r as? JsonObject)?.get("error")?.jsonPrimitive?.contentOrNull ?: "selectOption 失败",
                        "ref_not_found",
                    )
                }
            }

            "evaluate" -> {
                val expression = action["expression"]?.jsonPrimitive?.contentOrNull
                    ?: throw RuntimeException("locator evaluate 缺少 expression")
                val argJson = action["arg"]?.let { Json.encodeToString(JsonElement.serializer(), it) } ?: "null"
                val v = cdpEvaluateValue(
                    tabId,
                    "(function(){" + PW_SELECTOR_ENGINE + "var els=__pwq(" + selJson + ");" +
                        "if(!els.length)return {ok:false,error:'no match'};" +
                        "var EL=els[0];var r=(" + expression + ")(EL," + argJson + ");" +
                        "return (r&&typeof r.then==='function')?{ok:true,promise:true}:{ok:true,value:r};})()",
                )
                val obj = v as? JsonObject ?: return pwErrorResult("locator evaluate 失败")
                if (obj["ok"]?.jsonPrimitive?.contentOrNull != "true") {
                    return pwErrorResult(obj["error"]?.jsonPrimitive?.contentOrNull ?: "未匹配元素", "ref_not_found")
                }
                pwOkValue(obj["value"])
            }

            "waitFor" -> {
                val state = action["state"]?.jsonPrimitive?.contentOrNull ?: "visible"
                val v = cdpEvaluateValue(
                    tabId,
                    "(async function(){" + PW_SELECTOR_ENGINE + "var deadline=Date.now()+$timeout;" +
                        "function check(){var els=__pwq(" + selJson + ");" +
                        "if('$state'==='attached')return els.length>0;" +
                        "if('$state'==='detached')return els.length===0;" +
                        "var vis=false;if(els.length){var r=els[0].getBoundingClientRect();" +
                        "vis=r.width>0||r.height>0;var s=getComputedStyle(els[0]);vis=vis&&s.visibility!=='hidden'&&s.display!=='none';}" +
                        "return '$state'==='hidden'?!vis:vis;}" +
                        "while(Date.now()<deadline){if(check())return {ok:true};" +
                        "await new Promise(function(r){setTimeout(r,100);});}" +
                        "return {ok:false,error:'timeout waiting for state=$state'};})()",
                    awaitPromise = true,
                )
                if ((v as? JsonObject)?.get("ok")?.jsonPrimitive?.contentOrNull == "true") {
                    buildJsonObject { put("ok", true) }
                } else {
                    pwErrorResult((v as? JsonObject)?.get("error")?.jsonPrimitive?.contentOrNull ?: "waitFor 超时", "timeout")
                }
            }

            else -> pwUnavailable("locator operation '$op'")
        }
    }

    /**
     * Playwright selector 引擎（注入后定义 window.__pwq，返回匹配元素数组，文档序）。
     * 解析客户端编译的引擎语法：internal:role=NAME[name="x"或/re/]、internal:text=、
     * internal:label=、internal:attr=[placeholder=]、internal:testid=[data-testid=]、
     * 裸 css，` >> ` 链接后代，过滤器段 visible=/internal:has=/internal:has-not=。
     * iframe 段（internal:control=enter-frame）不支持，与宿主能力一致。
     */
    private val PW_SELECTOR_ENGINE = """
        window.__pwq = function(sel) {
          function roleOf(el) {
            var a = el.getAttribute('role');
            if (a) { var t = a.trim().split(/\s+/)[0]; if (t && t !== 'presentation' && t !== 'none') return t; }
            if (el.isContentEditable) return 'textbox';
            var tag = el.tagName.toLowerCase();
            if (tag === 'a' && el.getAttribute('href') != null) return 'link';
            if (tag === 'button' || tag === 'summary') return 'button';
            if (tag === 'select') return 'combobox';
            if (tag === 'option') return 'option';
            if (tag === 'textarea') return 'textbox';
            if (tag === 'input') {
              var ty = (el.getAttribute('type') || 'text').toLowerCase();
              if (ty === 'checkbox') return 'checkbox';
              if (ty === 'radio') return 'radio';
              if (ty === 'button' || ty === 'submit' || ty === 'reset') return 'button';
              if (ty === 'range') return 'slider';
              if (ty === 'number') return 'spinbutton';
              return 'textbox';
            }
            if (tag === 'img') return 'img';
            if (tag === 'ul' || tag === 'ol') return 'list';
            if (tag === 'li') return 'listitem';
            if (tag === 'nav') return 'navigation';
            if (/^h[1-6]$/.test(tag)) return 'heading';
            if (tag === 'table') return 'table';
            if (tag === 'tr') return 'row';
            if (tag === 'th') return 'columnheader';
            if (tag === 'td') return 'cell';
            if (tag === 'form') return 'form';
            if (tag === 'header') return 'banner';
            if (tag === 'footer') return 'contentinfo';
            if (tag === 'main') return 'main';
            return '';
          }
          function accName(el) {
            var n = el.getAttribute('aria-label'); if (n) return n;
            if (el.id) {
              try { var l = document.querySelector('label[for="' + el.id + '"]'); if (l) return (l.innerText || '').trim(); } catch (e) {}
            }
            var p = el.closest ? el.closest('label') : null; if (p && p !== el) return (p.innerText || '').trim();
            n = el.getAttribute('alt'); if (n) return n;
            n = el.getAttribute('title'); if (n) return n;
            n = el.getAttribute('placeholder'); if (n) return n;
            var tag = el.tagName.toLowerCase();
            if (tag === 'button' || tag === 'a' || tag === 'summary' || el.getAttribute('role') ||
                (tag === 'input' && (el.type === 'button' || el.type === 'submit')))
              return (el.innerText || el.value || '').trim();
            return '';
          }
          function parseQuoted(s) {
            s = s.trim();
            if (s.charAt(0) === '"') {
              // 客户端 Wj 编译产物："x"i（不区分大小写全等）/"x"s（区分大小写全等）/"x"
              var m = s.match(/^("(?:[^"\\]|\\.)*")(i|s)?$/);
              if (m) {
                try {
                  var lit = JSON.parse(m[1]);
                  if (m[2] === 'i') return { lit: lit, ci: true };
                  return { lit: lit };
                } catch (e) { return { lit: m[1].slice(1, -1) }; }
              }
            }
            if (s.charAt(0) === '/' && s.length > 2) {
              // 正则 /re/（RegExp.toString 可能带 flags，如 /re/i）
              var li = s.lastIndexOf('/');
              if (li > 0) {
                var body = s.slice(1, li);
                var fl = s.slice(li + 1);
                if (/^[gimsuy]*$/.test(fl)) {
                  try { return { re: new RegExp(body, fl.replace('g', '')) }; } catch (e) {}
                }
              }
            }
            return { lit: s, bare: true };
          }
          function textMatch(p, text) {
            if (text == null) text = '';
            if (p.re) return p.re.test(text);
            if (p.ci) return String(text).toLowerCase() === String(p.lit).toLowerCase();
            if (p.bare) return text.indexOf(p.lit) >= 0;
            return text === p.lit;
          }
          function isVisible(el) {
            var r = el.getBoundingClientRect();
            if (r.width <= 0 && r.height <= 0) return false;
            var s = getComputedStyle(el);
            return s.visibility !== 'hidden' && s.display !== 'none';
          }
          function sortDoc(els) {
            return els.sort(function(a, b) {
              return (a.compareDocumentPosition(b) & 2) ? 1 : -1;
            });
          }
          function applySeg(seg, scopeEls) {
            seg = seg.trim();
            if (seg.indexOf('visible=') === 0) {
              var want = seg.slice(8) === 'true';
              return scopeEls.filter(function(e) { return isVisible(e) === want; });
            }
            // nth=（.first()/.last()/.nth(i) 编译产物；负数从尾数）——作用于当前结果集
            if (seg.indexOf('nth=') === 0) {
              var ni = parseInt(seg.slice(4), 10);
              var sc = scopeEls || [];
              if (isNaN(ni)) return [];
              if (ni < 0) ni += sc.length;
              return (ni >= 0 && ni < sc.length) ? [sc[ni]] : [];
            }
            // internal:and=/internal:or=（.and()/.or() 编译产物）
            if (seg.indexOf('internal:and=') === 0) {
              var ain = '';
              try { ain = (JSON.parse(seg.slice(seg.indexOf('=') + 1)) || {}).selector || ''; } catch (e) {}
              if (!ain) return [];
              var am = window.__pwq(ain);
              return (scopeEls || []).filter(function(e) { return am.indexOf(e) >= 0; });
            }
            if (seg.indexOf('internal:or=') === 0) {
              var oarr = null;
              try { oarr = JSON.parse(seg.slice(seg.indexOf('=') + 1)); } catch (e) {}
              var olist = Array.isArray(oarr) ? oarr : (oarr ? [oarr] : []);
              var uni = [];
              olist.forEach(function(it) {
                var s2 = (it && it.selector) || '';
                if (s2) window.__pwq(s2).forEach(function(m) { if (uni.indexOf(m) < 0) uni.push(m); });
              });
              (scopeEls || []).forEach(function(m) { if (uni.indexOf(m) < 0) uni.push(m); });
              return uni;
            }
            if (seg.indexOf('internal:has-not=') === 0 || seg.indexOf('internal:has=') === 0) {
              var not = seg.indexOf('internal:has-not=') === 0;
              var inner = '';
              try { inner = (JSON.parse(seg.slice(seg.indexOf('=') + 1)) || {}).selector || ''; } catch (e) {}
              if (!inner) return [];
              var matched = window.__pwq(inner);
              return scopeEls.filter(function(e) {
                var has = matched.some(function(m) { return e !== m && e.contains(m); });
                return not ? !has : has;
              });
            }
            if (seg.indexOf('internal:control=') === 0) {
              throw new Error('iframe selector（enter-frame）不支持');
            }
            var candidates;
            if (scopeEls == null) {
              candidates = Array.prototype.slice.call(document.querySelectorAll('*'));
            } else {
              candidates = [];
              scopeEls.forEach(function(sc) {
                if (sc.querySelectorAll) Array.prototype.push.apply(candidates, sc.querySelectorAll('*'));
              });
              candidates = Array.from(new Set(candidates));
            }
            if (seg.indexOf('internal:role=') === 0) {
              var rest = seg.slice(14);
              var role = rest, namePat = null;
              var bi = rest.indexOf('[');
              if (bi >= 0) {
                role = rest.slice(0, bi);
                var inner2 = rest.slice(bi + 1, rest.lastIndexOf(']'));
                if (inner2.indexOf('name=') === 0) namePat = parseQuoted(inner2.slice(5));
              }
              role = role.trim().toLowerCase();
              return candidates.filter(function(e) {
                if (roleOf(e) !== role) return false;
                if (namePat && !textMatch(namePat, accName(e))) return false;
                return true;
              });
            }
            if (seg.indexOf('internal:text=') === 0) {
              var pat = parseQuoted(seg.slice(14));
              var hits = candidates.filter(function(e) {
                return isVisible(e) && textMatch(pat, (e.innerText || '').trim());
              });
              return hits.filter(function(e) {
                return !hits.some(function(o) { return o !== e && e.contains(o); });
              });
            }
            if (seg.indexOf('internal:label=') === 0) {
              var lpat = parseQuoted(seg.slice(15));
              return candidates.filter(function(e) {
                var tag = e.tagName.toLowerCase();
                if (tag !== 'input' && tag !== 'select' && tag !== 'textarea') return false;
                return textMatch(lpat, accName(e));
              });
            }
            if (seg.indexOf('internal:attr=') === 0) {
              var arest = seg.slice(14);
              if (arest.indexOf('[placeholder=') === 0) {
                var ppat = parseQuoted(arest.slice(13).replace(/\]$/, ''));
                return candidates.filter(function(e) {
                  return textMatch(ppat, e.getAttribute('placeholder') || '');
                });
              }
              return [];
            }
            if (seg.indexOf('internal:testid=') === 0) {
              var m = seg.match(/data-testid="([^"]*)"/) || seg.match(/data-testid=([^\]]*)/);
              var tid = m ? m[1] : '';
              return candidates.filter(function(e) { return e.getAttribute('data-testid') === tid; });
            }
            var cssEls = [];
            try {
              if (scopeEls == null) {
                cssEls = Array.prototype.slice.call(document.querySelectorAll(seg));
              } else {
                scopeEls.forEach(function(sc) {
                  if (sc.querySelectorAll) Array.prototype.push.apply(cssEls, sc.querySelectorAll(seg));
                });
                cssEls = Array.from(new Set(cssEls));
              }
            } catch (e) {
              // 语法解析失败≠无匹配：静默空结果会诱导 AI 误判"元素不存在"绕远路（08-17 实测踩坑），显式抛错
              throw new Error('selector 语法不支持: ' + String(seg).slice(0, 80));
            }
            return cssEls;
          }
          var parts = String(sel).split(' >> ');
          var current = null;
          for (var i = 0; i < parts.length; i++) {
            var p = parts[i].trim();
            if (!p) continue;
            if (current !== null && !current.length) return [];
            current = applySeg(p, current);
          }
          return sortDoc(current || []);
        };
    """.trimIndent()

    /**
     * domSnapshot 生成器：遍历可见元素输出近似 Playwright ariaSnapshot 的 ARIA 树字符串
     * （AI skill 的主读取通道）。行格式：`- role "name" [attrs]: value`，缩进表层级，
     * link 附 /url 子行，无 role 的文本块输出 `- text: ...`。上限 600 节点。
     */
    private val PW_ARIA_SNAPSHOT_SCRIPT = """
        (function() {
          var out = [];
          var MAX = 600;
          var q = function(s) { return JSON.stringify(String(s)); };
          function roleOf(el) {
            var a = el.getAttribute('role');
            if (a) { var t = a.trim().split(/\s+/)[0]; if (t && t !== 'presentation' && t !== 'none') return t; }
            if (el.isContentEditable) return 'textbox';
            var tag = el.tagName.toLowerCase();
            if (tag === 'a' && el.getAttribute('href') != null) return 'link';
            if (tag === 'button' || tag === 'summary') return 'button';
            if (tag === 'select') return 'combobox';
            if (tag === 'option') return 'option';
            if (tag === 'textarea') return 'textbox';
            if (tag === 'input') {
              var ty = (el.getAttribute('type') || 'text').toLowerCase();
              if (ty === 'checkbox') return 'checkbox';
              if (ty === 'radio') return 'radio';
              if (ty === 'button' || ty === 'submit' || ty === 'reset') return 'button';
              if (ty === 'range') return 'slider';
              if (ty === 'number') return 'spinbutton';
              return 'textbox';
            }
            if (tag === 'img') return 'img';
            if (tag === 'ul' || tag === 'ol') return 'list';
            if (tag === 'li') return 'listitem';
            if (tag === 'nav') return 'navigation';
            if (/^h[1-6]$/.test(tag)) return 'heading';
            if (tag === 'table') return 'table';
            if (tag === 'form') return 'form';
            if (tag === 'header') return 'banner';
            if (tag === 'footer') return 'contentinfo';
            if (tag === 'main') return 'main';
            return '';
          }
          function accName(el) {
            var n = el.getAttribute('aria-label'); if (n) return n;
            if (el.id) {
              try { var l = document.querySelector('label[for="' + el.id + '"]'); if (l) return (l.innerText || '').trim(); } catch (e) {}
            }
            var p = el.closest ? el.closest('label') : null; if (p && p !== el) return (p.innerText || '').trim();
            n = el.getAttribute('alt'); if (n) return n;
            n = el.getAttribute('title'); if (n) return n;
            n = el.getAttribute('placeholder'); if (n) return n;
            var tag = el.tagName.toLowerCase();
            if (tag === 'button' || tag === 'a' || tag === 'summary' || el.getAttribute('role') ||
                (tag === 'input' && (el.type === 'button' || el.type === 'submit')))
              return (el.innerText || el.value || '').trim();
            return '';
          }
          function visible(el) {
            var r = el.getBoundingClientRect();
            if (r.width <= 0 && r.height <= 0) return false;
            var s = getComputedStyle(el);
            return s.visibility !== 'hidden' && s.display !== 'none';
          }
          function walk(el, depth) {
            if (out.length >= MAX) return;
            var tag = el.tagName.toLowerCase();
            if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'link' || tag === 'meta') return;
            if (!visible(el)) return;
            var indent = new Array(depth + 1).join('  ');
            var role = roleOf(el);
            var name = accName(el);
            if (role) {
              var line = indent + '- ' + role + (name ? ' ' + q(name) : '');
              var attrs = [];
              var hm = tag.match(/^h([1-6])$/);
              if (hm) attrs.push('level=' + hm[1]);
              if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') attrs.push('disabled');
              if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio'))
                attrs.push(el.checked ? 'checked' : 'unchecked');
              if (el.getAttribute('aria-expanded')) attrs.push('expanded=' + el.getAttribute('aria-expanded'));
              if (el.getAttribute('aria-selected') === 'true') attrs.push('selected');
              if (attrs.length) line += ' [' + attrs.join(', ') + ']';
              var val = (tag === 'input' || tag === 'textarea') && el.value ? String(el.value).slice(0, 80) : '';
              if (tag === 'select' && el.selectedOptions && el.selectedOptions.length)
                val = el.selectedOptions[0].text.slice(0, 80);
              if (val) line += ': ' + q(val);
              out.push(line);
              if (role === 'link') {
                var href = el.getAttribute('href');
                if (href) out.push(indent + '  - /url: ' + href.slice(0, 120));
              }
              var kids = el.children;
              var kidOut = out.length;
              for (var i = 0; i < kids.length; i++) walk(kids[i], depth + 1);
              if (out.length === kidOut) {
                var t = (el.innerText || '').trim();
                if (t && !name && role !== 'textbox' && role !== 'combobox') out.push(indent + '  - text: ' + q(t.slice(0, 120)));
              }
            } else {
              var own = '';
              for (var n2 = el.firstChild; n2; n2 = n2.nextSibling) if (n2.nodeType === 3) own += n2.textContent;
              own = own.trim();
              if (own && el.children.length === 0) {
                out.push(indent + '- text: ' + q(own.slice(0, 120)));
              } else {
                var kids2 = el.children;
                for (var j = 0; j < kids2.length; j++) walk(kids2[j], depth);
              }
            }
          }
          var body = document.body;
          if (body) walk(body, 0);
          return out.slice(0, MAX).join('\n');
        })()
    """.trimIndent()

    // ============ viewport 自由尺寸（UI 与协议双通道；Emulation + CSS 注入）============

    /**
     * 对全部 tab 应用 viewport + 信箱（阻塞 CDP 调用；UI 层须先转 pooled 线程）。
     *
     * 形态对齐 Chrome DevTools 设备工具栏（ZCode 同款）：
     * - viewport override 固定布局视口（虚拟屏尺寸，媒体查询/断点正确）
     * - 注入信箱脚本：html 深色背景、body 居中固定为虚拟屏尺寸（可滚动）、
     *   transform:scale 显示缩放——CEF 窗口模式可视区域无法从外部限制（实验结论），
     *   只能在页面内把 body 变成"设备屏"容器
     * 导航保持：不用 addScriptToEvaluateOnNewDocument（identifier 是 per-connection 的，
     * 我们每命令建连 remove 必报 Script not found——实测踩坑），由 Panel 的
     * CefLoadHandler.onLoadEnd 重注入（真导航才丢样式，SPA 路由不重建 DOM 天然保持）
     */
    fun applyViewportOverride(width: Int, height: Int, scale: Double) {
        for (tabId in allTabIds()) applyViewportToTab(tabId, width, height, scale)
    }

    /** 信箱化注入脚本（设备屏居中 + transform 缩放 + html 深色信箱背景）*/
    private fun deviceFrameScript(width: Int, height: Int, scale: Double): String {
        val z = "%.4f".format(scale.coerceIn(0.05, 5.0))
        return "(function(){var Z=$z,VW=$width,VH=$height;" +
            "var html=document.documentElement,body=document.body;if(!body)return;" +
            "var vv=window.visualViewport||{};var visW=vv.width||window.innerWidth,visH=vv.height||window.innerHeight;" +
            "var left=Math.max(0,(visW-VW*Z)/2),top=Math.max(0,(visH-VH*Z)/2);" +
            "html.style.setProperty('background','#1e1f22','important');" +
            "html.style.setProperty('overflow','hidden','important');" +
            "body.style.setProperty('position','absolute','important');" +
            "body.style.setProperty('overflow','auto','important');" +
            "body.style.setProperty('margin','0','important');" +
            "body.style.setProperty('width',VW+'px','important');" +
            "body.style.setProperty('height',VH+'px','important');" +
            "body.style.setProperty('transform','scale('+Z+')','important');" +
            "body.style.setProperty('transform-origin','0 0','important');" +
            "body.style.setProperty('left',left+'px','important');" +
            "body.style.setProperty('top',top+'px','important');" +
            "body.style.setProperty('box-shadow','0 0 0 1px rgba(128,128,128,.5), 0 4px 16px rgba(0,0,0,.4)','important');" +
            "})()"
    }

    /** 信箱清理脚本（退出自由尺寸：恢复页面原 inline 样式）*/
    private val DEVICE_FRAME_CLEAR_SCRIPT = """
        (function(){
          var html=document.documentElement,body=document.body;
          ['background','overflow'].forEach(function(k){html.style.removeProperty(k)});
          if(body)['position','overflow','margin','width','height','transform','transform-origin','left','top','box-shadow'].forEach(function(k){body.style.removeProperty(k)});
        })()
    """.trimIndent().replace("\n", " ")

    /** 对单个 tab 应用（新 tab/导航后重注入同走本方法）*/
    fun applyViewportToTab(tabId: String, width: Int, height: Int, scale: Double) {
        try {
            cdpCommand(tabId, "Emulation.setDeviceMetricsOverride", buildJsonObject {
                put("width", width)
                put("height", height)
                put("deviceScaleFactor", 1)
                put("mobile", false)
            }, ensurePanel = false)
            val frameJs = deviceFrameScript(width, height, scale)
            cdpCommand(tabId, "Runtime.evaluate", buildJsonObject { put("expression", frameJs) }, ensurePanel = false)
            log.info("[browser-use] viewport 应用 tab=$tabId 设备屏=${width}x${height} scale=${"%.3f".format(scale)}")
        } catch (e: Exception) {
            log.warn("[browser-use] viewport 应用失败（tab=$tabId）: ${e.message}")
        }
    }

    /** 清除全部 tab 的 viewport override 与信箱样式（退出自由尺寸）*/
    fun clearViewportOverride() {
        for (tabId in allTabIds()) {
            try {
                cdpCommand(tabId, "Emulation.clearDeviceMetricsOverride", JsonObject(emptyMap()), ensurePanel = false)
            } catch (e: Exception) {
                log.warn("[browser-use] viewport override 清除失败（tab=$tabId）: ${e.message}")
            }
            try {
                cdpCommand(tabId, "Runtime.evaluate", buildJsonObject { put("expression", DEVICE_FRAME_CLEAR_SCRIPT) }, ensurePanel = false)
            } catch (e: Exception) {
                log.warn("[browser-use] viewport 样式清理失败（tab=$tabId）: ${e.message}")
            }
        }
    }

    private fun allTabIds(): List<String> {
        val ids = mutableListOf<String>()
        try {
            SwingUtilities.invokeAndWait {
                findExistingBrowserPanel()?.tabsSnapshot()?.forEach { ids.add(it.tabId) }
            }
        } catch (_: Exception) {}
        return ids
    }

    /** browserViewportSet：设置视口尺寸（宽 320-3840 高 320-2160，对齐协议 schema）*/
    private fun cmdViewportSet(command: JsonObject): JsonObject {
        val width = command["width"]?.jsonPrimitive?.contentOrNull?.toIntOrNull()
            ?: throw RuntimeException("browserViewportSet 缺少 width")
        val height = command["height"]?.jsonPrimitive?.contentOrNull?.toIntOrNull()
            ?: throw RuntimeException("browserViewportSet 缺少 height")
        if (width < 320 || width > 3840 || height < 320 || height > 2160) {
            throw RuntimeException("viewport 尺寸越界（宽 320-3840 高 320-2160）：${width}x$height")
        }
        val panel = ensureBrowserPanel() ?: throw RuntimeException("浏览器面板不可用")
        SwingUtilities.invokeAndWait { panel.setViewportSize(width, height) }
        return buildJsonObject { put("ok", true) }
    }

    /** browserViewportReset：退出自由尺寸（页面恢复随面板自适应）*/
    private fun cmdViewportReset(command: JsonObject): JsonObject {
        val panel = ensureBrowserPanel() ?: throw RuntimeException("浏览器面板不可用")
        SwingUtilities.invokeAndWait { panel.exitViewportMode() }
        return buildJsonObject { put("ok", true) }
    }

    /**
     * 页面快照注入脚本：遍历可见元素生成 elements（ref = 稳定 xpath，click/fill 按
     * document.evaluate(ref) 定位——无需服务端元素表，DOM 变化天然容错）。
     * 上限 500 元素（truncated 标记）。
     */
    private val SNAPSHOT_SCRIPT = """
        (function(){
          var MAX = 500;
          function visible(el){
            var r = el.getBoundingClientRect();
            if (r.width <= 0 && r.height <= 0) return false;
            var s = getComputedStyle(el);
            return s.visibility !== 'hidden' && s.display !== 'none';
          }
          function inVp(el){
            var r = el.getBoundingClientRect();
            return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
          }
          function xp(el){
            var parts = [];
            var n = el;
            while (n && n.nodeType === 1) {
              var p = n.parentNode;
              var idx = 1;
              var sib = p ? p.firstElementChild : null;
              while (sib && sib !== n) { if (sib.tagName === n.tagName) idx++; sib = sib.nextElementSibling; }
              parts.unshift(n.tagName.toLowerCase() + '[' + idx + ']');
              n = p;
            }
            return '/' + parts.join('/');
          }
          function cssPath(el){
            var parts = [];
            var n = el;
            while (n && n.nodeType === 1 && n !== document.documentElement) {
              var p = n.parentNode;
              var idx = 1;
              var sib = p ? p.firstElementChild : null;
              while (sib && sib !== n) { if (sib.tagName === n.tagName) idx++; sib = sib.nextElementSibling; }
              parts.unshift(n.tagName.toLowerCase() + ':nth-of-type(' + idx + ')');
              n = p;
            }
            return parts.join(' > ');
          }
          function roleOf(el, tag){
            var a = el.getAttribute('role');
            if (a) return a;
            if (el.isContentEditable) return 'textbox';
            if (tag === 'a' && el.getAttribute('href')) return 'link';
            if (tag === 'button' || tag === 'summary') return 'button';
            if (tag === 'select') return 'combobox';
            if (tag === 'textarea') return 'textbox';
            if (tag === 'input') {
              var t = (el.getAttribute('type') || 'text').toLowerCase();
              if (t === 'checkbox') return 'checkbox';
              if (t === 'radio') return 'radio';
              if (t === 'button' || t === 'submit') return 'button';
              return 'textbox';
            }
            if (tag === 'img') return 'img';
            if (tag === 'ul' || tag === 'ol') return 'list';
            if (tag === 'li') return 'listitem';
            if (tag === 'nav') return 'navigation';
            if (/^h[1-6]$/.test(tag)) return 'heading';
            return '';
          }
          var out = [];
          var truncated = false;
          var all = document.querySelectorAll('*');
          for (var i = 0; i < all.length; i++) {
            var el = all[i];
            var tag = el.tagName.toLowerCase();
            if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'link' || tag === 'meta') continue;
            if (!visible(el)) continue;
            var role = roleOf(el, tag);
            var text = (el.innerText || '').trim().slice(0, 120);
            var name = el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder') || '';
            var interactive = role === 'link' || role === 'button' || role === 'textbox' || role === 'checkbox' ||
              role === 'radio' || role === 'combobox' || el.getAttribute('tabindex') !== null || el.hasAttribute('onclick');
            if (!interactive && !text && role !== 'img' && role !== 'heading') continue;
            if (out.length >= MAX) { truncated = true; break; }
            var r = el.getBoundingClientRect();
            var item = {
              ref: xp(el),
              tag: tag,
              role: role || undefined,
              name: name || undefined,
              text: text || undefined,
              selector: cssPath(el),
              xpath: xp(el),
              rect: { x: r.left, y: r.top, width: r.width, height: r.height },
              inViewport: inVp(el)
            };
            if (tag === 'input' || tag === 'textarea' || tag === 'select') {
              item.value = String(el.value !== undefined ? el.value : '');
              item.disabled = el.disabled === true;
              item.checked = el.checked === true;
            }
            out.push(item);
          }
          return { elements: out, truncated: truncated };
        })()
    """.trimIndent().replace("\n", " ")
}
