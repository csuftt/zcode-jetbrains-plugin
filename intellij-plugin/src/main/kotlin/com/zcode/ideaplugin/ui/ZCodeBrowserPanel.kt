package com.zcode.ideaplugin.ui

import com.intellij.icons.AllIcons
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.Disposable
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.util.Disposer
import com.intellij.ui.JBColor
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.util.ui.JBUI
import com.zcode.ideaplugin.zCodeService
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.callback.CefJSDialogCallback
import org.cef.handler.CefDisplayHandlerAdapter
import org.cef.handler.CefJSDialogHandler
import org.cef.handler.CefLoadHandler
import org.cef.network.CefRequest
import java.awt.BorderLayout
import java.awt.CardLayout
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.Box
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JTextField
import javax.swing.SwingConstants
import javax.swing.SwingUtilities

/**
 * 内嵌浏览器面板（前端调试用）
 *
 * 移植自 ZCode 客户端「浏览器」侧板的核心子集：导航工具条（后退/前进/刷新）+
 * 地址栏 + DevTools + 外部浏览器打开 + 多标签页（每个协议 tab 一个独立 JBCefBrowser）。
 * 被调试页面的服务（如 vite dev server）由用户前端项目自己提供，本面板只负责加载与调试
 * ——与 ZCode 客户端一致，插件不起 server。
 *
 * - 会话内嵌分栏或独立 Content 标签，不绑定会话、不持久化
 * - 与聊天 webview 共享 JCEF profile：登录态互通，调试需登录的本地站点更方便
 * - DevTools 走 JBCefBrowser.openDevtools()（Chrome DevTools 独立窗口）
 * - JS 对话框（alert/confirm/prompt/beforeunload）不弹原生框：挂起等 AI 的
 *   getDialog/handleDialog 处置（browser-use 宿主协议），120s 超时自动 dismiss 兜底
 */
class ZCodeBrowserPanel(
    /** 项目（自由尺寸 viewport 走 browser-use 执行器的 CDP 通道）*/
    private val project: com.intellij.openapi.project.Project?,
    /** 关闭回调（会话内嵌分栏形态时提供：点关闭按钮收回分栏；独立 Content 形态为 null）*/
    private val onClose: (() -> Unit)? = null,
) : JPanel(BorderLayout()), Disposable {

    companion object {
        /** 无协议输入按 http 补全（裸 scheme 前缀的按原样）*/
        private val SCHEME_PATTERN = Regex("^[a-zA-Z][a-zA-Z0-9+.-]*:")

        /** JS 对话框挂起超时：AI 未处理时自动 dismiss，防页面永久卡死 */
        private const val DIALOG_TIMEOUT_MS = 120_000L
    }

    /** 一个逻辑 tab = 一个独立 JBCefBrowser（browser-use 协议 tab 的真实载体）*/
    internal class BrowserTab(
        val id: String,
        val browser: JBCefBrowser,
        @Volatile var title: String = "",
        @Volatile var url: String = "",
        @Volatile var canGoBack: Boolean = false,
        @Volatile var canGoForward: Boolean = false,
        /** 生命周期标记（协议 active/deliverable/handoff；仅标记不改变可控性，对齐官方 tab-cleanup 语义）*/
        @Volatile var lifecycle: String = "active",
    )

    /** tab 概要快照（executor 组协议响应用；全部字段 EDT 读取）*/
    internal class TabSnapshot(
        val tabId: String,
        val url: String,
        val title: String,
        val active: Boolean,
        val canGoBack: Boolean,
        val canGoForward: Boolean,
        val lifecycle: String,
    )

    /** 挂起的 JS 对话框：callback 已持有，等 handleDialog 消费 */
    internal class PendingDialog(
        val tabId: String,
        val type: String,
        val message: String,
        val defaultPrompt: String?,
        val callback: CefJSDialogCallback,
        val createdAt: Long = System.currentTimeMillis(),
    )

    private val log = Logger.getInstance("ZCodePlugin")
    private val jcefSupported = JBCefApp.isSupported()
    private lateinit var addressField: JTextField
    private lateinit var backBtn: JButton
    private lateinit var forwardBtn: JButton

    // ============ 多 tab 状态（EDT 约束）============
    private val tabs = java.util.concurrent.CopyOnWriteArrayList<BrowserTab>()
    @Volatile
    private var activeTab: BrowserTab? = null
    private var tabCounter = 0
    private val cardPanel = JPanel(CardLayout())
    private val tabStrip = JPanel(FlowLayout(FlowLayout.LEFT, 0, 0))

    /** tabId → 挂起对话框（一个 tab 同时最多一个：JS alert/confirm 本身模态）*/
    private val pendingDialogs = java.util.concurrent.ConcurrentHashMap<String, PendingDialog>()

    // ============ 自由尺寸（对齐 ZCode 客户端/DevTools 设备工具栏：虚拟屏居中信箱 + 显示缩放）============
    internal class ViewportState {
        var active = false
        var width = 1920
        var height = 1080
        /** 缩放百分比；0 = 适应屏幕（等比放进面板）*/
        var scalePct = 100
    }

    private val viewportState = ViewportState()
    private lateinit var viewportBtn: JButton
    private var fitResizeTimer: javax.swing.Timer? = null

    /** 持久化视口配置（下次进入自由尺寸沿用；默认 1920x1080 @100%）*/
    private fun persistViewportConfig() {
        val p = project ?: return
        try {
            val props = com.intellij.ide.util.PropertiesComponent.getInstance(p)
            props.setValue("zcode.browser.vpWidth", viewportState.width, 1920)
            props.setValue("zcode.browser.vpHeight", viewportState.height, 1080)
            props.setValue("zcode.browser.vpScalePct", viewportState.scalePct, 100)
        } catch (_: Exception) {}
    }

    private fun restoreViewportConfig() {
        val p = project ?: return
        try {
            val props = com.intellij.ide.util.PropertiesComponent.getInstance(p)
            viewportState.width = props.getInt("zcode.browser.vpWidth", 1920).coerceIn(320, 3840)
            viewportState.height = props.getInt("zcode.browser.vpHeight", 1080).coerceIn(320, 2160)
            viewportState.scalePct = props.getInt("zcode.browser.vpScalePct", 100)
        } catch (_: Exception) {}
    }

    init {
        border = JBUI.Borders.empty()
        background = JBColor.background()
        // 允许压缩到很窄：Splitter 尊重组件 minimumSize，JCEF 组件默认最小尺寸会让
        // 内嵌分栏「往右拖压不动浏览器」
        minimumSize = Dimension(32, 32)

        if (!jcefSupported) {
            add(createUnsupportedPanel(), BorderLayout.CENTER)
        } else {
            restoreViewportConfig()
            add(buildToolbar(), BorderLayout.NORTH)
            tabStrip.isOpaque = true
            tabStrip.background = JBColor.border()
            tabStrip.border = JBUI.Borders.empty(2, 2, 0, 2)
            tabStrip.isVisible = false // 单 tab 时隐藏，保持精简外观
            add(tabStrip, BorderLayout.SOUTH)
            add(cardPanel, BorderLayout.CENTER)
            // 自由尺寸激活时面板 resize 重发（fit 比例与信箱居中坐标都依赖面板尺寸；去抖 200ms）
            cardPanel.addComponentListener(object : java.awt.event.ComponentAdapter() {
                override fun componentResized(e: java.awt.event.ComponentEvent?) {
                    if (!viewportState.active) return
                    if (fitResizeTimer == null) {
                        fitResizeTimer = javax.swing.Timer(200) {
                            if (viewportState.active) applyViewportOverride()
                        }.apply { isRepeats = false }
                    }
                    fitResizeTimer?.restart()
                }
            })
            createTab()
        }
    }

    // ============ 工具条 ============

    /** 顶部工具条：导航按钮 | 地址栏 | DevTools / 外部浏览器 */
    private fun buildToolbar(): JComponent {
        addressField = JTextField().apply {
            toolTipText = "输入网址后回车打开（无协议按 http:// 补全）"
            addActionListener { navigate() }
        }

        backBtn = navButton(AllIcons.Actions.Back, "后退") {
            activeTab?.browser?.cefBrowser?.goBack()
        }
        forwardBtn = navButton(AllIcons.Actions.Forward, "前进") {
            activeTab?.browser?.cefBrowser?.goForward()
        }
        val reloadBtn = navButton(AllIcons.Actions.Refresh, "刷新") {
            activeTab?.browser?.cefBrowser?.reload()
        }
        val devtoolsBtn = navButton(AllIcons.Actions.Preview, "打开调试工具（DevTools）") {
            try {
                activeTab?.browser?.openDevtools()
            } catch (e: Exception) {
                log.error("打开 DevTools 失败", e)
            }
        }
        val externalBtn = navButton(AllIcons.General.Web, "在默认浏览器中打开") {
            val url = activeTab?.browser?.cefBrowser?.url
            if (!url.isNullOrBlank() && url != "about:blank") BrowserUtil.browse(url)
        }
        viewportBtn = JButton("自由尺寸").apply {
            toolTipText = "自由尺寸：固定视口大小与显示缩放（对齐 ZCode 客户端）"
            isFocusPainted = false
            isFocusable = false
            margin = JBUI.insets(1, 8)
            addActionListener { showViewportMenu() }
        }

        val toolbar = JPanel(BorderLayout())
        toolbar.border = JBUI.Borders.empty(2, 4)
        toolbar.add(
            Box.createHorizontalBox().apply {
                add(backBtn)
                add(forwardBtn)
                add(reloadBtn)
            },
            BorderLayout.WEST,
        )
        toolbar.add(addressField, BorderLayout.CENTER)
        toolbar.add(
            Box.createHorizontalBox().apply {
                add(viewportBtn)
                add(devtoolsBtn)
                add(externalBtn)
                if (onClose != null) {
                    add(navButton(AllIcons.Actions.Close, "收起浏览器") { onClose.invoke() })
                }
            },
            BorderLayout.EAST,
        )
        return toolbar
    }

    private fun navButton(icon: javax.swing.Icon, tooltip: String, action: () -> Unit): JButton =
        JButton(icon).apply {
            toolTipText = tooltip
            isBorderPainted = false
            isFocusPainted = false
            isContentAreaFilled = false
            isFocusable = false
            preferredSize = Dimension(JBUI.scale(28), JBUI.scale(28))
            addActionListener { action() }
        }

    // ============ tab 生命周期（EDT）============

    /** 新建 tab 并激活（browser-use newTab / 面板初始）；返回新 tabId，JCEF 不可用时 null */
    internal fun createTab(): String? {
        if (!jcefSupported) return null
        if (!SwingUtilities.isEventDispatchThread()) {
            var result: String? = null
            SwingUtilities.invokeAndWait { result = createTab() }
            return result
        }
        val browser = JBCefBrowser()
        val tab = BrowserTab("tab-${++tabCounter}", browser)
        tabs.add(tab)
        cardPanel.add(browser.component, tab.id)
        registerBrowserHandlers(tab)
        // 空态欢迎页（对齐 ZCode 文案；data: 地址不回写地址栏，见 registerBrowserHandlers）
        browser.loadHTML(buildWelcomeHtml())
        // 兜底：JBCefBrowser 刚创建时 CefBrowser 可能未就绪，首个 loadHTML 会被吞
        // （地址栏停留在 file: 斜杠 jbcefbrowser 占位页），500ms 后检测补发一次
        Thread({
            Thread.sleep(500)
            SwingUtilities.invokeLater {
                val cur = try { tab.browser.cefBrowser.url } catch (_: Exception) { null }
                if (cur == null || cur.startsWith("file:///jbcefbrowser/")) {
                    try { tab.browser.loadHTML(buildWelcomeHtml()) } catch (_: Exception) {}
                }
            }
        }, "zcode-browser-welcome-${tab.id}").apply { isDaemon = true }.start()
        rebuildTabStrip()
        activateTabInternal(tab)
        // 自由尺寸激活时新 tab 同步应用（target 注册有延迟，稍等后应用）
        if (viewportState.active) {
            val ex = browserExecutor()
            val w = viewportState.width
            val h = viewportState.height
            val s = currentViewportScale()
            if (ex != null) {
                com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread {
                    Thread.sleep(800)
                    try {
                        ex.applyViewportToTab(tab.id, w, h, s)
                    } catch (_: Exception) {}
                }
            }
        }
        log.info("[browser-use] 浏览器新建 tab=${tab.id}（共 ${tabs.size} 个）")
        return tab.id
    }

    /** 激活指定 tab（browser-use activateTab / 用户点 tab 条）*/
    internal fun activateTabById(tabId: String): Boolean {
        if (!jcefSupported) return false
        if (!SwingUtilities.isEventDispatchThread()) {
            var result = false
            SwingUtilities.invokeAndWait { result = activateTabById(tabId) }
            return result
        }
        val tab = tabs.firstOrNull { it.id == tabId } ?: return false
        activateTabInternal(tab)
        return true
    }

    private fun activateTabInternal(tab: BrowserTab) {
        activeTab = tab
        (cardPanel.layout as CardLayout).show(cardPanel, tab.id)
        rebuildTabStrip()
        // 地址栏与导航按钮同步为该 tab 的状态
        addressField.text = tab.url
        backBtn.isEnabled = tab.canGoBack
        forwardBtn.isEnabled = tab.canGoForward
    }

    /** 关闭 tab（tab 条关闭按钮）：至少保留一个；返回是否真的关闭 */
    internal fun closeTabById(tabId: String): Boolean {
        if (!jcefSupported) return false
        if (!SwingUtilities.isEventDispatchThread()) {
            var result = false
            SwingUtilities.invokeAndWait { result = closeTabById(tabId) }
            return result
        }
        if (tabs.size <= 1) return false
        val tab = tabs.firstOrNull { it.id == tabId } ?: return false
        val wasActive = tab === activeTab
        tabs.remove(tab)
        pendingDialogs.remove(tabId) // 挂起对话框随 tab 销毁放弃（不回调，CEF 侧已重置）
        cardPanel.remove(tab.browser.component)
        rebuildTabStrip()
        try {
            Disposer.dispose(tab.browser)
        } catch (e: Exception) {
            log.warn("[browser-use] 释放 tab ${tab.id} 的 JCEF 失败: ${e.message}")
        }
        if (wasActive) {
            tabs.lastOrNull()?.let { activateTabInternal(it) }
        }
        log.info("[browser-use] 浏览器关闭 tab=$tabId（剩 ${tabs.size} 个）")
        return true
    }

    /**
     * 协议 close（AI 显式 tab.close()）：关闭目标 tab（tabId 缺省=激活 tab，失配返回 false
     * ——路由语义对齐 browserOf）。
     * 与 tab 条关闭的唯一差异：唯一 tab 也允许"关"——复位为全新欢迎 tab
     * （旧 tabId 从协议视角消失、新 tab 出现），保持面板至少一页可用的 UI 不变量。
     */
    internal fun closeProtocolTab(tabId: String?): Boolean {
        if (!jcefSupported) return false
        if (!SwingUtilities.isEventDispatchThread()) {
            var result = false
            SwingUtilities.invokeAndWait { result = closeProtocolTab(tabId) }
            return result
        }
        val target = if (tabId != null) {
            tabs.firstOrNull { it.id == tabId } ?: return false
        } else {
            activeTab ?: return false
        }
        if (tabs.size > 1) return closeTabById(target.id)
        tabs.remove(target)
        pendingDialogs.remove(target.id)
        cardPanel.remove(target.browser.component)
        activeTab = null
        try {
            Disposer.dispose(target.browser)
        } catch (e: Exception) {
            log.warn("[browser-use] 释放 tab ${target.id} 的 JCEF 失败: ${e.message}")
        }
        createTab()
        log.info("[browser-use] 协议关闭唯一 tab=${target.id}，已复位欢迎 tab")
        return true
    }

    /** 协议生命周期标记（markDeliverable/markHandoff/finalize/finalizeTabs）；tabId null → 激活 tab */
    internal fun setTabLifecycle(tabId: String?, lifecycle: String): Boolean {
        if (!jcefSupported) return false
        if (!SwingUtilities.isEventDispatchThread()) {
            var result = false
            SwingUtilities.invokeAndWait { result = setTabLifecycle(tabId, lifecycle) }
            return result
        }
        val tab = if (tabId != null) tabs.firstOrNull { it.id == tabId } ?: return false
        else activeTab ?: return false
        tab.lifecycle = lifecycle
        return true
    }

    // ============ tab 条 UI（EDT）============

    private fun rebuildTabStrip() {
        tabStrip.isVisible = tabs.size > 1
        tabStrip.removeAll()
        for (tab in tabs) {
            tabStrip.add(buildTabButton(tab))
        }
        tabStrip.revalidate()
        tabStrip.repaint()
    }

    private fun buildTabButton(tab: BrowserTab): JComponent {
        val isActive = tab === activeTab
        val label = JLabel(tab.title.ifBlank { "新标签页" }).apply {
            foreground = if (isActive) JBColor.foreground() else JBColor.foreground().darker()
            border = JBUI.Borders.emptyRight(2)
        }
        val close = JButton(AllIcons.Actions.Close).apply {
            toolTipText = "关闭标签页"
            isBorderPainted = false
            isFocusPainted = false
            isContentAreaFilled = false
            isFocusable = false
            preferredSize = Dimension(JBUI.scale(16), JBUI.scale(16))
            addActionListener { closeTabById(tab.id) }
        }
        val row = JPanel(BorderLayout()).apply {
            isOpaque = true
            background = if (isActive) JBColor.background() else JBColor.border().brighter()
            border = JBUI.Borders.empty(2, 8)
            add(label, BorderLayout.CENTER)
            add(close, BorderLayout.EAST)
            addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent?) {
                    if (e == null || SwingUtilities.isLeftMouseButton(e)) activateTabById(tab.id)
                }
            })
        }
        row.preferredSize = Dimension(
            (label.preferredSize.width + close.preferredSize.width + JBUI.scale(16)).coerceIn(
                JBUI.scale(60), JBUI.scale(200),
            ),
            JBUI.scale(24),
        )
        return row
    }

    // ============ per-browser 事件注册 ============

    /**
     * 每个 tab 的浏览器事件：导航状态、地址/标题回写、JS 对话框接管。
     * CefLoadHandler 等回调在 JCEF 线程，切 EDT 更新 Swing。
     */
    private fun registerBrowserHandlers(tab: BrowserTab) {
        val browser = tab.browser

        browser.jbCefClient.addLoadHandler(object : CefLoadHandler {
            override fun onLoadingStateChange(
                browser: CefBrowser?, isLoading: Boolean, canGoBack: Boolean, canGoForward: Boolean,
            ) {
                tab.canGoBack = canGoBack
                tab.canGoForward = canGoForward
                SwingUtilities.invokeLater {
                    if (tab !== activeTab) return@invokeLater
                    backBtn.isEnabled = canGoBack
                    forwardBtn.isEnabled = canGoForward
                }
            }

            override fun onLoadStart(browser: CefBrowser?, frame: CefFrame?, transitionType: CefRequest.TransitionType?) {}
            override fun onLoadEnd(browser: CefBrowser?, frame: CefFrame?, httpStatusCode: Int) {
                // 自由尺寸激活时主框架导航完成即重注入信箱（文档重建丢样式；addScript 方案因
                // CDP identifier per-connection 不可用——每命令建连 remove 必报 Script not found）
                if (frame?.isMain == true) reapplyViewportForTab(tab.id)
            }
            override fun onLoadError(
                browser: CefBrowser?, frame: CefFrame?, errorCode: CefLoadHandler.ErrorCode?,
                errorText: String?, failedUrl: String?,
            ) {}
        }, browser.cefBrowser)

        browser.jbCefClient.addDisplayHandler(object : CefDisplayHandlerAdapter() {
            override fun onAddressChange(browser: CefBrowser?, frame: CefFrame?, url: String?) {
                if (frame?.isMain != true || url.isNullOrBlank()) return
                // data:/about:blank（欢迎页与空页）不覆盖，避免清掉用户正在输入的内容
                if (url.startsWith("data:") || url == "about:blank") return
                tab.url = url
                SwingUtilities.invokeLater {
                    if (tab === activeTab) addressField.text = url
                }
            }

            override fun onTitleChange(browser: CefBrowser?, title: String?) {
                if (title.isNullOrBlank() || tab.title == title) return
                tab.title = title
                SwingUtilities.invokeLater {
                    // strip 上显示所有 tab 标题；单 tab 时 strip 隐藏无需刷新
                    if (tabs.size > 1) rebuildTabStrip()
                }
            }
        }, browser.cefBrowser)

        // JS 对话框接管：返回 true（不弹原生框），挂起等 AI 的 handleDialog。
        // beforeunload 不走 onJSDialog（JCEF 单独的 onBeforeUnloadDialog），同样挂起
        browser.jbCefClient.addJSDialogHandler(object : CefJSDialogHandler {
            override fun onJSDialog(
                browser: CefBrowser?, originUrl: String?,
                dialogType: CefJSDialogHandler.JSDialogType?,
                messageText: String?, defaultValue: String?,
                callback: CefJSDialogCallback?, suppressDialog: org.cef.misc.BoolRef?,
            ): Boolean {
                if (callback == null) return false
                storePendingDialog(tab.id, dialogTypeOf(dialogType), messageText, defaultValue, callback)
                return true
            }

            override fun onBeforeUnloadDialog(
                browser: CefBrowser?, messageText: String?, isReload: Boolean,
                callback: CefJSDialogCallback?,
            ): Boolean {
                if (callback == null) return false
                storePendingDialog(tab.id, "beforeunload", messageText, null, callback)
                return true
            }

            override fun onResetDialogState(browser: CefBrowser?) {
                // 页面导航/刷新时 CEF 重置对话框状态：放弃挂起项（callback 不再有效）
                pendingDialogs.remove(tab.id)
            }

            override fun onDialogClosed(browser: CefBrowser?) {}
        }, browser.cefBrowser)
    }

    private fun storePendingDialog(
        tabId: String, type: String, messageText: String?,
        defaultValue: String?, callback: CefJSDialogCallback,
    ) {
        val pending = PendingDialog(
            tabId = tabId,
            type = type,
            message = messageText ?: "",
            defaultPrompt = defaultValue?.takeIf { it.isNotBlank() },
            callback = callback,
        )
        // 同 tab 已有挂起对话框（理论不该发生，CEF 是模态的）：先顶掉旧的
        pendingDialogs.put(tabId, pending)?.let { stale ->
            try {
                stale.callback.Continue(false, "")
            } catch (_: Exception) {}
        }
        log.info("[browser-use] JS 对话框挂起（tab=$tabId type=$type）：${pending.message.take(80)}")
        scheduleDialogTimeoutCheck()
    }

    private fun dialogTypeOf(t: CefJSDialogHandler.JSDialogType?): String = when (t) {
        CefJSDialogHandler.JSDialogType.JSDIALOGTYPE_CONFIRM -> "confirm"
        CefJSDialogHandler.JSDialogType.JSDIALOGTYPE_PROMPT -> "prompt"
        else -> "alert"
    }

    /** 对话框超时兜底：定时检查，超时未处理的自动 dismiss（防 AI 不处理页面永久卡死）*/
    private fun scheduleDialogTimeoutCheck() {
        SwingUtilities.invokeLater {
            val timer = javax.swing.Timer(DIALOG_TIMEOUT_MS.toInt(), null)
            timer.isRepeats = false
            timer.addActionListener {
                val now = System.currentTimeMillis()
                pendingDialogs.entries.removeIf { (_, d) ->
                    val expired = now - d.createdAt > DIALOG_TIMEOUT_MS
                    if (expired) {
                        log.info("[browser-use] 对话框超时自动 dismiss（tab=${d.tabId} type=${d.type}）")
                        try {
                            d.callback.Continue(false, "")
                        } catch (_: Exception) {}
                    }
                    expired
                }
            }
            timer.start()
        }
    }

    // ============ 自由尺寸（viewport + 缩放；UI 与协议 browserViewportSet/Reset 双通道）============

    private fun browserExecutor(): ZCodeBrowserExecutor? =
        project?.let { it.zCodeService().getBrowserExecutor() }

    /** 生效视口尺寸（虚拟屏；持久化配置或默认 1920x1080）*/
    private fun effectiveViewportSize(): Pair<Int, Int> = viewportState.width to viewportState.height

    /** 当前显示缩放系数：fit = min(面板宽/视口宽, 面板高/视口高)；否则按百分比 */
    private fun currentViewportScale(): Double {
        if (viewportState.scalePct > 0) return viewportState.scalePct / 100.0
        val size = cardPanel.size
        if (size.width <= 0 || size.height <= 0 || viewportState.width <= 0 || viewportState.height <= 0) return 1.0
        return minOf(size.width.toDouble() / viewportState.width, size.height.toDouble() / viewportState.height)
            .coerceIn(0.1, 3.0)
    }

    /** 把当前 viewport 状态应用到全部 tab（CDP 阻塞调用，转 pooled 线程执行）*/
    private fun applyViewportOverride() {
        val ex = browserExecutor() ?: run {
            log.warn("[browser-use] 自由尺寸不可用：浏览器执行器未初始化")
            return
        }
        val (w, h) = effectiveViewportSize()
        val s = currentViewportScale()
        com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread {
            ex.applyViewportOverride(w, h, s)
        }
    }

    /** 进入自由尺寸：使用持久化配置（默认 1920x1080 @100%）*/
    internal fun enterViewportMode() {
        viewportState.active = true
        applyViewportOverride()
        refreshViewportButton()
        log.info("[browser-use] 进入自由尺寸：${viewportState.width}x${viewportState.height} @${viewportState.scalePct}%")
    }

    /** 设置视口尺寸（UI 对话框与协议 browserViewportSet 共用；未激活时自动激活并持久化）*/
    internal fun setViewportSize(width: Int, height: Int) {
        if (!viewportState.active) {
            viewportState.active = true
            viewportState.scalePct = 100
        }
        viewportState.width = width.coerceIn(320, 3840)
        viewportState.height = height.coerceIn(320, 2160)
        persistViewportConfig()
        applyViewportOverride()
        refreshViewportButton()
        log.info("[browser-use] 视口尺寸：${viewportState.width}x${viewportState.height}")
    }

    /** 设置缩放：0=适应屏幕，其余为百分比（持久化）*/
    internal fun setViewportScale(pct: Int) {
        viewportState.scalePct = pct
        persistViewportConfig()
        applyViewportOverride()
        refreshViewportButton()
    }

    /** 退出自由尺寸（清除 CDP override 与信箱样式，页面恢复随面板自适应）*/
    internal fun exitViewportMode() {
        viewportState.active = false
        browserExecutor()?.let { ex ->
            com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread {
                ex.clearViewportOverride()
            }
        }
        refreshViewportButton()
        log.info("[browser-use] 退出自由尺寸")
    }

    /** 导航结束后重注入信箱（真导航重建 DOM 丢样式；SPA 路由不重建无需处理）。onLoadEnd 在 JCEF 线程回调 */
    internal fun reapplyViewportForTab(tabId: String) {
        if (!viewportState.active) return
        val ex = browserExecutor() ?: return
        var w = viewportState.width
        var h = viewportState.height
        var s = 1.0
        try {
            SwingUtilities.invokeAndWait {
                s = currentViewportScale()
            }
        } catch (_: Exception) {}
        com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread {
            try {
                ex.applyViewportToTab(tabId, w, h, s)
            } catch (_: Exception) {}
        }
    }

    private fun refreshViewportButton() {
        if (!::viewportBtn.isInitialized) return
        if (viewportState.active) {
            val size = "${viewportState.width}×${viewportState.height}"
            val scale = when (viewportState.scalePct) {
                0 -> "适应"
                else -> "${viewportState.scalePct}%"
            }
            viewportBtn.text = "$size · $scale"
            viewportBtn.toolTipText = "自由尺寸中（点击调整/退出）"
        } else {
            viewportBtn.text = "自由尺寸"
            viewportBtn.toolTipText = "自由尺寸：固定视口大小与显示缩放（对齐 ZCode 客户端）"
        }
    }

    private fun showViewportMenu() {
        val menu = javax.swing.JPopupMenu()
        fun item(text: String, action: () -> Unit) =
            javax.swing.JMenuItem(text).apply { addActionListener { action() } }

        if (!viewportState.active) {
            menu.add(item("进入自由尺寸（${viewportState.width}×${viewportState.height}）") { enterViewportMode() })
        } else {
            menu.add(item("退出自由尺寸") { exitViewportMode() })
            menu.addSeparator()
            menu.add(item("视口尺寸…（当前 ${viewportState.width}×${viewportState.height}）") { promptViewportSize() })
            menu.addSeparator()
            for (pct in listOf(0, 50, 75, 100, 125, 150, 200)) {
                val label = if (pct == 0) "适应屏幕" else "$pct%"
                val mark = if (viewportState.scalePct == pct) "● " else ""
                menu.add(item(mark + label) { setViewportScale(pct) })
            }
        }
        menu.show(viewportBtn, 0, viewportBtn.height)
    }

    /** 视口尺寸对话框（宽/高输入，持久化）*/
    private fun promptViewportSize() {
        var result: Pair<Int, Int>? = null

        object : com.intellij.openapi.ui.DialogWrapper(project) {
            val wField = JTextField(8)
            val hField = JTextField(8)

            init {
                title = "视口尺寸"
                init()
            }

            override fun createCenterPanel(): JComponent {
                wField.text = viewportState.width.toString()
                hField.text = viewportState.height.toString()
                return JPanel(java.awt.GridBagLayout()).apply {
                    val gbc = java.awt.GridBagConstraints().apply {
                        insets = JBUI.insets(2, 4)
                        anchor = java.awt.GridBagConstraints.WEST
                    }
                    gbc.gridx = 0; gbc.gridy = 0; add(JLabel("宽 (320-3840)："), gbc)
                    gbc.gridx = 1; add(wField, gbc)
                    gbc.gridx = 0; gbc.gridy = 1; add(JLabel("高 (320-2160)："), gbc)
                    gbc.gridx = 1; add(hField, gbc)
                }
            }

            override fun doOKAction() {
                val w = wField.text.trim().toIntOrNull()
                val h = hField.text.trim().toIntOrNull()
                if (w == null || h == null) return
                result = w to h
                super.doOKAction()
            }
        }.show()

        result?.let { (w, h) -> setViewportSize(w, h) }
    }

    // ============ 地址栏导航 ============

    /** 地址栏提交：回车导航（当前激活 tab）*/
    private fun navigate() {
        val target = normalizeUrl(addressField.text)
        activeTab?.browser?.loadURL(target)
    }

    private fun normalizeUrl(input: String): String {
        val t = input.trim()
        if (t.isEmpty()) return "about:blank"
        if (SCHEME_PATTERN.containsMatchIn(t)) return t
        return "http://$t"
    }

    /** 空态欢迎页（跟随 IDE 主题的静态快照；文案对齐 ZCode 客户端浏览器面板）*/
    private fun buildWelcomeHtml(): String {
        val bg = if (JBColor.isBright()) "#ffffff" else "#1e1f22"
        val fg = if (JBColor.isBright()) "#42464d" else "#b6b9bd"
        return """
            <html><head><meta charset="utf-8"></head>
            <body style="margin:0;background:$bg;color:$fg;font-family:'Segoe UI',system-ui,sans-serif">
            <div style="display:flex;height:100vh;align-items:center;justify-content:center;flex-direction:column;gap:8px">
              <div style="font-size:15px">粘贴或输入 URL 以打开网页</div>
              <div style="font-size:12px;opacity:.6">例如 http://localhost:5173（前端 dev server）</div>
            </div></body></html>
        """.trimIndent()
    }

    private fun createUnsupportedPanel(): JComponent {
        val label = JLabel("当前 IDE 运行时不支持 JCEF，无法使用内嵌浏览器")
        label.foreground = JBColor.foreground()
        label.horizontalAlignment = SwingConstants.CENTER
        val wrapper = JPanel(BorderLayout())
        wrapper.background = JBColor.background()
        wrapper.add(label, BorderLayout.CENTER)
        return wrapper
    }

    /** Content 销毁时释放 JCEF 资源（content.setDisposer(panel) 绑定）*/
    override fun dispose() {
        for (tab in tabs) {
            pendingDialogs.remove(tab.id)
            try {
                Disposer.dispose(tab.browser)
            } catch (e: Exception) {
                log.warn("释放浏览器 tab ${tab.id} 的 JCEF 失败: ${e.message}")
            }
        }
        tabs.clear()
        activeTab = null
    }

    // ============ browser-use 宿主执行器访问（ZCodeBrowserExecutor 用，EDT）============

    /** 全部 tab 概要（协议 list / meta.openTabIds）；url 用 cefBrowser 实时值（CDP 定位一致）*/
    internal fun tabsSnapshot(): List<TabSnapshot> = tabs.map {
        val liveUrl = try { it.browser.cefBrowser.url } catch (_: Exception) { null }
        TabSnapshot(it.id, liveUrl ?: it.url, it.title, it === activeTab, it.canGoBack, it.canGoForward, it.lifecycle)
    }

    internal fun activeTabId(): String? = activeTab?.id

    /** 解析 tab（null/失配 → 当前激活 tab；用于协议命令的 tabId 路由）*/
    internal fun browserOf(tabId: String?): JBCefBrowser? {
        val tab = if (tabId != null) {
            tabs.firstOrNull { it.id == tabId } ?: return null
        } else {
            activeTab ?: return null
        }
        return tab.browser
    }

    /** 挂起对话框查询（getDialog）：无 tabId 取激活 tab 的 */
    internal fun pendingDialogOf(tabId: String?): PendingDialog? =
        if (tabId != null) pendingDialogs[tabId] else activeTab?.let { pendingDialogs[it.id] }

    /** 处置挂起对话框（handleDialog）：accept=false 等价 dismiss；promptText 仅 prompt 型有效 */
    internal fun handleDialog(tabId: String?, accept: Boolean, promptText: String?): Boolean {
        val dialog = pendingDialogOf(tabId) ?: return false
        pendingDialogs.remove(dialog.tabId)
        return try {
            dialog.callback.Continue(accept, promptText ?: "")
            log.info("[browser-use] 对话框已处理（tab=${dialog.tabId} accept=$accept）")
            true
        } catch (e: Exception) {
            log.warn("[browser-use] 对话框回调失败: ${e.message}")
            true // callback 已从挂起表移除，语义上已处置
        }
    }
}
