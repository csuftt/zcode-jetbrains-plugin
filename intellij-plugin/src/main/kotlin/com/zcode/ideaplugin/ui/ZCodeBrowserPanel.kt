package com.zcode.ideaplugin.ui

import com.intellij.icons.AllIcons
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.Disposable
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.util.Disposer
import com.intellij.ui.JBColor
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.scale.JBUIScale
import com.intellij.util.ui.JBUI
import com.zcode.ideaplugin.ZCodeBundle.message
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

        /**
         * 浏览器层 console 消息格式化（onConsoleMessage 兜底采集用；console-api 类
         * 已在调用方过滤——页内 __zcodeDebug 补丁已全量记录）。
         */
        internal fun formatBrowserConsoleLine(
            level: org.cef.CefSettings.LogSeverity?, message: String, source: String?, line: Int,
        ): String {
            val lv = when (level) {
                org.cef.CefSettings.LogSeverity.LOGSEVERITY_ERROR,
                org.cef.CefSettings.LogSeverity.LOGSEVERITY_FATAL,
                -> "error"
                org.cef.CefSettings.LogSeverity.LOGSEVERITY_WARNING -> "warn"
                else -> "info"
            }
            val src = source?.takeIf { it.isNotBlank() }?.let { " ($it${if (line > 0) ":$line" else ""})" } ?: ""
            return "[$lv] $message$src"
        }
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
    ) {
        /**
         * 浏览器层 console 消息（onConsoleMessage 回调写入，JCEF 线程）。
         * 只存非 console API 类消息（网络资源加载失败等）——console API 页内
         * __zcodeDebug 补丁已全量结构化记录，重记只会重复。executor 在 AI 读取
         * __zcodeDebug 时取走（drain）合入页面缓冲。
         */
        val browserConsoleLines: MutableList<String> =
            java.util.Collections.synchronizedList(ArrayList<String>())
    }

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

    /** IDE 主题变化订阅（跟随模式下刷新分栏配色；dispose 断开）*/
    private var lafConn: com.intellij.util.messages.MessageBusConnection? = null

    private val log = Logger.getInstance("ZCodePlugin")
    private val jcefSupported = JBCefApp.isSupported()
    private lateinit var addressField: JTextField
    private lateinit var backBtn: JButton
    private lateinit var forwardBtn: JButton
    private lateinit var toolbarPanel: JPanel

    // ============ 主题（跟 webview 生效主题：显式偏好优先，否则 IDE 主题）============

    /** 主题色组（值对齐 webview variables.less，浏览器分栏与聊天界面观感一致）*/
    private class PanelTheme(
        val bg: java.awt.Color,        // 工具栏/tab 条容器背景
        val fg: java.awt.Color,        // 主文字
        val fgMuted: java.awt.Color,   // 次文字（非激活 tab）
        val fieldBg: java.awt.Color,   // 地址栏背景
        val fieldFg: java.awt.Color,   // 地址栏文字
        val tabActiveBg: java.awt.Color,
        val tabInactiveBg: java.awt.Color,
        val welcomeBg: String,         // 欢迎页 HTML 色
        val welcomeFg: String,
        val stripBg: java.awt.Color,   // 底部 tab 条背景（比工具栏深/浅一档，衬出激活卡片）
        val tabHoverAlpha: Int,        // 非激活 tab hover 提亮的叠加色 alpha（0-255）
        val closeHoverAlpha: Int,      // 关闭按钮 hover 底色 alpha
    )

    private fun panelTheme(): PanelTheme {
        val dark = ZCodeAppearanceStore.effectiveTheme() == "dark"
        return if (dark) {
            PanelTheme(
                bg = java.awt.Color(0x25, 0x25, 0x26), fg = java.awt.Color(0xE0, 0xE0, 0xE0),
                fgMuted = java.awt.Color(0x85, 0x85, 0x85),
                fieldBg = java.awt.Color(0x1E, 0x1E, 0x1E), fieldFg = java.awt.Color(0xCC, 0xCC, 0xCC),
                tabActiveBg = java.awt.Color(0x25, 0x25, 0x26), tabInactiveBg = java.awt.Color(0x2D, 0x2D, 0x2D),
                welcomeBg = "#1e1f22", welcomeFg = "#b6b9bd",
                stripBg = java.awt.Color(0x1E, 0x1E, 0x1E),
                tabHoverAlpha = 0x18, closeHoverAlpha = 0x2E,
            )
        } else {
            PanelTheme(
                bg = java.awt.Color(0xF3, 0xF3, 0xF3), fg = java.awt.Color(0x1E, 0x1E, 0x1E),
                fgMuted = java.awt.Color(0x61, 0x61, 0x61),
                fieldBg = java.awt.Color(0xFF, 0xFF, 0xFF), fieldFg = java.awt.Color(0x33, 0x33, 0x33),
                tabActiveBg = java.awt.Color(0xFF, 0xFF, 0xFF), tabInactiveBg = java.awt.Color(0xE8, 0xE8, 0xE8),
                welcomeBg = "#ffffff", welcomeFg = "#42464d",
                stripBg = java.awt.Color(0xE8, 0xE8, 0xE8),
                tabHoverAlpha = 0x0D, closeHoverAlpha = 0x14,
            )
        }
    }

    /** 当前生效主题缓存（刷新欢迎页时判断是否变了）*/
    @Volatile
    private var appliedTheme: String = ""

    /** 把生效主题应用到分栏可见 UI（EDT）：工具栏/地址栏/tab 条/面板背景 */
    private fun applyPanelTheme() {
        if (!SwingUtilities.isEventDispatchThread()) {
            SwingUtilities.invokeLater { applyPanelTheme() }
            return
        }
        appliedTheme = ZCodeAppearanceStore.effectiveTheme()
        val t = panelTheme()
        background = t.bg
        if (::toolbarPanel.isInitialized) toolbarPanel.background = t.bg
        if (::addressField.isInitialized) {
            addressField.background = t.fieldBg
            addressField.foreground = t.fieldFg
            addressField.caretColor = t.fieldFg
        }
        // tab 条上的组件颜色在 buildTabButton 里按 panelTheme() 现取，这里重绘即可
        tabStrip.background = t.stripBg
        tabScrollPane.background = t.stripBg
        tabScrollPane.viewport.background = t.stripBg
        if (tabs.size > 1) rebuildTabStrip()
        repaint()
    }

    /**
     * webview 外观保存后的回调（ZCodeToolWindowPanel.broadcastAppearance 调用）：
     * 重着色 + 欢迎页 tab 重载（仍在欢迎态时换新配色；已打开网页的不动）。
     * 自由尺寸激活时重发信箱样式（信箱背景/阴影按生效主题配色）。
     */
    internal fun onAppearanceThemeChanged() {
        val changed = appliedTheme != ZCodeAppearanceStore.effectiveTheme()
        applyPanelTheme()
        if (!changed || !jcefSupported) return
        if (viewportState.active) applyViewportOverride()
        val tab = activeTab ?: return
        val cur = try { tab.browser.cefBrowser.url } catch (_: Exception) { null }
        if (cur == null || cur.startsWith("data:") || cur == "about:blank" ||
            cur.startsWith("file:///jbcefbrowser/")
        ) {
            try { tab.browser.loadHTML(buildWelcomeHtml()) } catch (_: Exception) {}
        }
    }

    // ============ 多 tab 状态（EDT 约束）============
    private val tabs = java.util.concurrent.CopyOnWriteArrayList<BrowserTab>()
    @Volatile
    private var activeTab: BrowserTab? = null
    private var tabCounter = 0
    private val cardPanel = JPanel(CardLayout())

    /**
     * 底部 tab 条（现代浏览器溢出习惯）：宽度不足时先等比收缩 tab 到最小宽（40px，
     * 大致只余关闭按钮），仍放不下由外层 JScrollPane 横向滚动（滚轮，无滚动条）。
     */
    private inner class TabStripPanel : JPanel(null), javax.swing.Scrollable {
        private val gap = JBUI.scale(4)
        /** 收缩下限：再窄关闭按钮都点不中，宁可横向滚 */
        private val minTabWidth = JBUI.scale(40)

        init {
            isOpaque = true
            border = JBUI.Borders.empty(3, 6, 4, 4) // 上方留缝让激活卡片圆角"浮出"
        }

        /** 内容真实需求宽（未收缩），JScrollPane 据此判断可滚范围 */
        override fun getPreferredSize(): java.awt.Dimension {
            val ins = insets
            var w = ins.left + ins.right
            var h = 0
            components.forEachIndexed { i, c ->
                w += c.preferredSize.width + if (i > 0) gap else 0
                h = maxOf(h, c.preferredSize.height)
            }
            return java.awt.Dimension(w, ins.top + ins.bottom + h)
        }

        override fun getMaximumSize(): java.awt.Dimension =
            java.awt.Dimension(Int.MAX_VALUE, preferredSize.height)

        override fun doLayout() {
            val ins = insets
            val count = componentCount
            if (count == 0) return
            val avail = width - ins.left - ins.right
            val prefs = IntArray(count) { components[it].preferredSize.width }
            val totalW = prefs.sum() + gap * (count - 1)
            // 放不下 → 均匀收缩（对齐浏览器 tab 等比收缩），压到 minTabWidth 后交给滚动
            val each = if (totalW > avail) {
                ((avail - gap * (count - 1)) / count).coerceAtLeast(minTabWidth)
            } else -1
            var x = ins.left
            for (i in 0 until count) {
                val c = components[i]
                val w = if (each == -1) prefs[i] else each
                c.setBounds(x, ins.top, w, height - ins.top - ins.bottom)
                x += w + gap
            }
        }

        override fun getPreferredScrollableViewportSize(): java.awt.Dimension = preferredSize
        override fun getScrollableTracksViewportWidth() = false
        override fun getScrollableTracksViewportHeight() = true
        override fun getScrollableBlockIncrement(
            visibleRect: java.awt.Rectangle, orientation: Int, direction: Int,
        ) = JBUI.scale(120)
        override fun getScrollableUnitIncrement(
            visibleRect: java.awt.Rectangle, orientation: Int, direction: Int,
        ) = JBUI.scale(30)
    }

    private val tabStrip = TabStripPanel()

    /** tab 条滚动容器：不显示滚动条，滚轮转横向滚动 */
    private val tabScrollPane = javax.swing.JScrollPane(tabStrip).apply {
        horizontalScrollBarPolicy = javax.swing.ScrollPaneConstants.HORIZONTAL_SCROLLBAR_NEVER
        verticalScrollBarPolicy = javax.swing.ScrollPaneConstants.VERTICAL_SCROLLBAR_NEVER
        border = null
        isOpaque = true
        viewport.isOpaque = true
        addMouseWheelListener { e ->
            // 默认 wheel 只滚垂直滚动条（且 NEVER 策略下不滚），这里转横向
            val bar = horizontalScrollBar
            if (bar.maximum > bar.minimum) {
                bar.value = (bar.value + e.wheelRotation * JBUI.scale(60)).coerceIn(bar.minimum, bar.maximum)
                e.consume()
            }
        }
    }

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
            tabStrip.isVisible = false // 单 tab 时隐藏，保持精简外观
            add(tabScrollPane, BorderLayout.SOUTH)
            add(cardPanel, BorderLayout.CENTER)
            // 跟随 IDE 模式下 IDE 主题切换时刷新分栏配色（显式偏好模式 IDE 切换不生效，
            // 由 webview 保存时的 onAppearanceThemeChanged 刷新）
            lafConn = com.intellij.openapi.application.ApplicationManager.getApplication()
                .messageBus.connect().also { conn ->
                    conn.subscribe(
                        com.intellij.ide.ui.LafManagerListener.TOPIC,
                        com.intellij.ide.ui.LafManagerListener {
                            if (ZCodeAppearanceStore.themePref().isEmpty()) applyPanelTheme()
                        },
                    )
                }
            applyPanelTheme()
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
            toolTipText = message("browser.urlField.tooltip")
            addActionListener { navigate() }
        }

        backBtn = navButton(AllIcons.Actions.Back, message("browser.nav.back")) {
            activeTab?.browser?.cefBrowser?.goBack()
        }
        forwardBtn = navButton(AllIcons.Actions.Forward, message("browser.nav.forward")) {
            activeTab?.browser?.cefBrowser?.goForward()
        }
        val reloadBtn = navButton(AllIcons.Actions.Refresh, message("browser.nav.reload")) {
            activeTab?.browser?.cefBrowser?.reload()
        }
        val devtoolsBtn = navButton(AllIcons.Actions.Preview, message("browser.nav.devtools")) {
            try {
                activeTab?.browser?.openDevtools()
            } catch (e: Exception) {
                log.error("Failed to open DevTools", e)
            }
        }
        val externalBtn = navButton(AllIcons.General.Web, message("browser.nav.external")) {
            val url = activeTab?.browser?.cefBrowser?.url
            if (!url.isNullOrBlank() && url != "about:blank") BrowserUtil.browse(url)
        }
        viewportBtn = ThemePillButton(message("browser.nav.viewport"), message("browser.nav.viewport.tooltip")) {
            showViewportMenu()
        }
        val newTabBtn = ThemeIconButton(message("browser.nav.newTab"), "+") { createTab() }

        val toolbar = JPanel(BorderLayout())
        toolbarPanel = toolbar
        toolbar.border = JBUI.Borders.empty(2, 4)
        toolbar.isOpaque = true
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
                add(newTabBtn)
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

    /**
     * 图标主题染色包装：保留原图形状，整体染成生效主题的前景色；宿主组件禁用时降透明。
     * AllIcons 跟 IDE LaF 走——IDE 暗色 LaF 的浅灰图标叠在浅色工具栏上"像被禁用"，
     * 工具栏图标统一经此包装，颜色与主题恒一致。
     * HiDPI：按设备实际缩放倍数光栅化染色缓存（1x buffer 会被拉伸出马赛克毛刺），
     * 绘制时以逻辑尺寸落位。
     */
    private inner class ThemedIcon(private val base: javax.swing.Icon) : javax.swing.Icon {
        /** 染色缓存键：theme × scale%（HiDPI 各档分别光栅化）*/
        private val cache = HashMap<Pair<String, Int>, java.awt.image.BufferedImage>()

        private fun tinted(theme: String, scale: Double): java.awt.image.BufferedImage {
            val key = theme to (scale * 100).toInt()
            cache[key]?.let { return it }
            val t = panelTheme()
            val w = maxOf(1, Math.ceil(base.iconWidth * scale).toInt())
            val h = maxOf(1, Math.ceil(base.iconHeight * scale).toInt())
            val img = java.awt.image.BufferedImage(
                w, h, java.awt.image.BufferedImage.TYPE_INT_ARGB,
            )
            val ig = img.createGraphics()
            // 带缩放画原图：IntelliJ 图标（SVG 体系）按变换分辨率光栅化，避免 1x 拉伸
            ig.scale(scale, scale)
            base.paintIcon(null, ig, 0, 0)
            // SrcIn：把已画形状的非透明像素替换为主题前景色
            ig.composite = java.awt.AlphaComposite.SrcIn
            ig.color = t.fg
            ig.fillRect(0, 0, w + 2, h + 2)
            ig.dispose()
            cache[key] = img
            return img
        }

        override fun paintIcon(c: java.awt.Component?, g: java.awt.Graphics, x: Int, y: Int) {
            val g2 = g as? java.awt.Graphics2D ?: return
            val at = g2.deviceConfiguration.defaultTransform
            val scale = maxOf(at.scaleX, at.scaleY).coerceAtLeast(1.0)
            val disabled = c != null && !c.isEnabled
            val oldComp = g2.composite
            if (disabled) {
                g2.composite = java.awt.AlphaComposite.getInstance(
                    java.awt.AlphaComposite.SRC_OVER, 0.35f,
                )
            }
            g2.drawImage(
                tinted(ZCodeAppearanceStore.effectiveTheme(), scale),
                x, y, base.iconWidth, base.iconHeight, null,
            )
            g2.composite = oldComp
        }

        override fun getIconWidth() = base.iconWidth
        override fun getIconHeight() = base.iconHeight
    }

    private fun navButton(icon: javax.swing.Icon, tooltip: String, action: () -> Unit): JButton =
        JButton(ThemedIcon(icon)).apply {
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
        log.info("[browser-use] browser tab opened id=${tab.id} (${tabs.size} total)")
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
        scrollActiveTabVisible()
    }

    /** 激活 tab 滚入可见区（条溢出横向滚动时，新建/切换后目标 tab 不在视野外）*/
    private fun scrollActiveTabVisible() {
        SwingUtilities.invokeLater {
            val comp = tabStrip.components.firstOrNull { (it as? TabCard)?.tab === activeTab }
                as? javax.swing.JComponent ?: return@invokeLater
            comp.scrollRectToVisible(comp.bounds)
        }
    }

    /**
     * 安全重挂内容卡片区：换全新 CardLayout 后整体重建（removeAll + 逐个 add + show 激活）。
     * 不能直接 cardPanel.remove(旧组件)：CardLayout.removeLayoutComponent 会自动切下一张卡
     * 并触发 validate，布局链摸到 dispose 过程中的 JCEF 组件（内部 Alarm 已注销）报
     * "Already disposed" 插件错误；新 CardLayout 内部无记录，next() 无卡可切不触发布局。
     */
    private fun relayoutCardPanel() {
        cardPanel.layout = CardLayout()
        cardPanel.removeAll()
        for (t in tabs) cardPanel.add(t.browser.component, t.id)
        activeTab?.let { (cardPanel.layout as CardLayout).show(cardPanel, it.id) }
        cardPanel.revalidate()
        cardPanel.repaint()
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
        if (wasActive) activeTab = null
        relayoutCardPanel() // 被关组件随重建脱离容器，此后才 dispose
        rebuildTabStrip()
        try {
            Disposer.dispose(tab.browser)
        } catch (e: Exception) {
            log.warn("[browser-use] Failed to release JCEF of tab ${tab.id}: ${e.message}")
        }
        if (wasActive) {
            tabs.lastOrNull()?.let { activateTabInternal(it) }
        }
        log.info("[browser-use] browser tab closed id=$tabId (${tabs.size} left)")
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
        activeTab = null
        relayoutCardPanel() // 同 closeTabById：先脱离容器再 dispose
        try {
            Disposer.dispose(target.browser)
        } catch (e: Exception) {
            log.warn("[browser-use] Failed to release JCEF of tab ${target.id}: ${e.message}")
        }
        createTab()
        log.info("[browser-use] protocol closed the only tab=${target.id}, welcome tab restored")
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

    /** tab 圆角半径（仅下侧两角，卡片自底部条"浮出"与内容区衔接）*/
    private val tabArc = 8

    /** 现代 tab 卡片：激活=实底圆角卡片 + 加粗标题；非激活=透明，hover 半透明提亮 */
    private inner class TabCard(internal val tab: BrowserTab) : JPanel(BorderLayout()) {
        private var hover = false
        private val label: JLabel

        init {
            isOpaque = false
            val t = panelTheme()
            val active = tab === activeTab
            label = JLabel(tab.title.ifBlank { "新标签页" }).apply {
                foreground = if (active) t.fg else t.fgMuted
                font = font.deriveFont(if (active) java.awt.Font.BOLD else java.awt.Font.PLAIN, JBUIScale.scale(11f))
                border = JBUI.Borders.emptyLeft(8)
                // 条收缩时标题被截断，tooltip 兜底显示全名
                toolTipText = tab.title.ifBlank { "新标签页" }
                cursor = java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR)
            }
            add(label, BorderLayout.CENTER)
            add(TabCloseButton { closeTabById(tab.id) }, BorderLayout.EAST)
            // 点击/悬停监听须同时挂卡片与 label：Swing 鼠标事件不冒泡，
            // 落在 label（占卡片大部分面积）上的事件到不了卡片自身的 listener
            val handler = object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent?) {
                    if (e == null || SwingUtilities.isLeftMouseButton(e)) activateTabById(tab.id)
                }
                override fun mouseEntered(e: MouseEvent?) { hover = true; repaint() }
                override fun mouseExited(e: MouseEvent?) { hover = false; repaint() }
            }
            addMouseListener(handler)
            label.addMouseListener(handler)
        }

        override fun getPreferredSize(): java.awt.Dimension {
            val close = (getComponent(1) as TabCloseButton).preferredSize
            return java.awt.Dimension(
                (label.preferredSize.width + close.width + JBUI.scale(16)).coerceIn(
                    JBUI.scale(80), JBUI.scale(220),
                ),
                JBUI.scale(28),
            )
        }

        override fun paintComponent(g: java.awt.Graphics) {
            val g2 = g as? java.awt.Graphics2D ?: return
            g2.setRenderingHint(
                java.awt.RenderingHints.KEY_ANTIALIASING, java.awt.RenderingHints.VALUE_ANTIALIAS_ON,
            )
            val t = panelTheme()
            val w = width
            val h = height
            val fill = when {
                tab === activeTab -> t.tabActiveBg
                hover -> overlay(t.stripBg, t.fg, t.tabHoverAlpha)
                else -> return // 非激活静息态全透明，融入底条
            }
            // 上圆角画到组件上方（y=-arc）被组件 clip 自然裁掉 → 视觉只有下侧两角
            g2.color = fill
            g2.fill(java.awt.geom.RoundRectangle2D.Float(
                0f, -tabArc.toFloat(), (w - 1).toFloat(), (h + tabArc).toFloat(),
                tabArc.toFloat(), tabArc.toFloat(),
            ))
        }
    }

    /** 关闭按钮：无边框扁平，hover 圆角小底（现代浏览器同款），避免抢视觉 */
    private inner class TabCloseButton(action: () -> Unit) : JButton(ThemedIcon(AllIcons.Actions.Close)) {
        private var hover = false

        init {
            toolTipText = "关闭标签页"
            isBorderPainted = false
            isFocusPainted = false
            isContentAreaFilled = false
            isFocusable = false
            isOpaque = false
            margin = JBUI.insets(2, 2)
            preferredSize = java.awt.Dimension(JBUI.scale(22), JBUI.scale(22))
            addActionListener { action() }
            addMouseListener(object : MouseAdapter() {
                override fun mouseEntered(e: MouseEvent?) { hover = true; repaint() }
                override fun mouseExited(e: MouseEvent?) { hover = false; repaint() }
            })
        }

        override fun paintComponent(g: java.awt.Graphics) {
            if (hover) {
                val g2 = g as? java.awt.Graphics2D ?: return super.paintComponent(g)
                g2.setRenderingHint(
                    java.awt.RenderingHints.KEY_ANTIALIASING, java.awt.RenderingHints.VALUE_ANTIALIAS_ON,
                )
                val t = panelTheme()
                val s = JBUI.scale(16)
                val x = (width - s) / 2
                val y = (height - s) / 2
                g2.color = overlay(t.tabActiveBg, t.fg, t.closeHoverAlpha)
                g2.fillOval(x, y, s, s)
            }
            super.paintComponent(g)
        }
    }

    /** 半透明叠加色（base 上叠 fg 的 alpha 混合，用于 hover 提亮）*/
    private fun overlay(base: java.awt.Color, fg: java.awt.Color, alpha: Int): java.awt.Color {
        val r = (fg.red * alpha + base.red * (255 - alpha)) / 255
        val g = (fg.green * alpha + base.green * (255 - alpha)) / 255
        val b = (fg.blue * alpha + base.blue * (255 - alpha)) / 255
        return java.awt.Color(r, g, b)
    }

    /**
     * 主题化文字胶囊按钮（自绘圆角底 + 边框，文字仍由 LaF 用 foreground 绘制）：
     * LaF 的 JButton 背景跟随 IDE 主题而非 webview 生效主题，自由尺寸等按钮用它替代。
     */
    private inner class ThemePillButton(text: String, tip: String, action: () -> Unit) : JButton(text) {
        private var hover = false

        init {
            toolTipText = tip
            isBorderPainted = false
            isFocusPainted = false
            isContentAreaFilled = false
            isFocusable = false
            isOpaque = false
            margin = JBUI.insets(0, 0)
            font = font.deriveFont(java.awt.Font.PLAIN, JBUIScale.scale(12f))
            cursor = java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR)
            addActionListener { action() }
            addMouseListener(object : MouseAdapter() {
                override fun mouseEntered(e: MouseEvent?) { hover = true; repaint() }
                override fun mouseExited(e: MouseEvent?) { hover = false; repaint() }
            })
        }

        override fun getPreferredSize(): java.awt.Dimension {
            val fm = getFontMetrics(font)
            return java.awt.Dimension(fm.stringWidth(text) + JBUI.scale(24), JBUI.scale(24))
        }

        override fun paintComponent(g: java.awt.Graphics) {
            val g2 = g as? java.awt.Graphics2D ?: return
            g2.setRenderingHint(
                java.awt.RenderingHints.KEY_ANTIALIASING, java.awt.RenderingHints.VALUE_ANTIALIAS_ON,
            )
            g2.setRenderingHint(
                java.awt.RenderingHints.KEY_TEXT_ANTIALIASING,
                // LCD 子像素抗锯齿（Windows 桌面默认档，比灰度抗锯齿细腻无毛刺）
                java.awt.RenderingHints.VALUE_TEXT_ANTIALIAS_LCD_HRGB,
            )
            val t = panelTheme()
            val w = width - 1
            val h = height - 1
            val arc = JBUI.scale(10)
            val fill = if (hover) overlay(t.fieldBg, t.fg, t.tabHoverAlpha) else t.fieldBg
            g2.color = fill
            g2.fillRoundRect(0, 0, w, h, arc, arc)
            g2.color = overlay(t.bg, t.fgMuted, 0x99)
            g2.drawRoundRect(0, 0, w, h, arc, arc)
            // 文字自绘：不调 super（断开 LaF 绘制链）——LaF 文字色跟 IDE 主题走，
            // IDE 暗色 + webview 覆盖浅色时会白字配白底不可读
            g2.font = font
            val fm = g2.fontMetrics
            g2.color = t.fg
            g2.drawString(text, (width - fm.stringWidth(text)) / 2, (height - fm.height) / 2 + fm.ascent)
        }
    }

    /** 主题化图标按钮（自绘符号 + hover 圆底）：新建 tab 的"+"等 */
    private inner class ThemeIconButton(
        tip: String,
        private val symbol: String, // 目前支持 "+"
        action: () -> Unit,
    ) : JButton() {
        private var hover = false

        init {
            toolTipText = tip
            isBorderPainted = false
            isFocusPainted = false
            isContentAreaFilled = false
            isFocusable = false
            isOpaque = false
            preferredSize = java.awt.Dimension(JBUI.scale(26), JBUI.scale(24))
            cursor = java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR)
            addActionListener { action() }
            addMouseListener(object : MouseAdapter() {
                override fun mouseEntered(e: MouseEvent?) { hover = true; repaint() }
                override fun mouseExited(e: MouseEvent?) { hover = false; repaint() }
            })
        }

        override fun paintComponent(g: java.awt.Graphics) {
            val g2 = g as? java.awt.Graphics2D ?: return
            g2.setRenderingHint(
                java.awt.RenderingHints.KEY_ANTIALIASING, java.awt.RenderingHints.VALUE_ANTIALIAS_ON,
            )
            val t = panelTheme()
            if (hover) {
                val s = JBUI.scale(18)
                g2.color = overlay(t.bg, t.fg, t.tabHoverAlpha)
                g2.fillOval((width - s) / 2, (height - s) / 2, s, s)
            }
            // "+"：两条线段自绘（圆头端点防毛刺），颜色完全受控（不依赖随 LaF 走的 IDE 图标色板）
            g2.color = t.fg
            g2.stroke = java.awt.BasicStroke(
                JBUIScale.scale(1.6f), java.awt.BasicStroke.CAP_ROUND, java.awt.BasicStroke.JOIN_ROUND,
            )
            val len = JBUI.scale(9)
            val cx = width / 2f
            val cy = height / 2f
            g2.drawLine((cx - len / 2).toInt(), cy.toInt(), (cx + len / 2).toInt(), cy.toInt())
            g2.drawLine(cx.toInt(), (cy - len / 2).toInt(), cx.toInt(), (cy + len / 2).toInt())
        }
    }

    private fun buildTabButton(tab: BrowserTab): JComponent = TabCard(tab)

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

            /**
             * 浏览器层 console 消息兜底采集：console API 已被页内 __zcodeDebug 补丁
             * 全量记录，这里只留非 console API 类（source=network 的 "Failed to load
             * resource: 404" 资源加载失败、CSP/security 等）——页内 JS 看不到这些。
             * 容量 200 行，取走式消费（drainBrowserConsoleLines）。
             */
            override fun onConsoleMessage(
                browser: CefBrowser?, level: org.cef.CefSettings.LogSeverity?,
                message: String?, source: String?, line: Int,
            ): Boolean {
                if (message.isNullOrBlank()) return false
                if (source == "console-api") return false // 页内补丁已记录，避免重复
                synchronized(tab.browserConsoleLines) {
                    tab.browserConsoleLines.add(formatBrowserConsoleLine(level, message, source, line))
                    while (tab.browserConsoleLines.size > 200) tab.browserConsoleLines.removeAt(0)
                }
                return false
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
        log.info("[browser-use] JS dialog pending (tab=$tabId type=$type): ${pending.message.take(80)}")
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
                        log.info("[browser-use] dialog auto-dismissed on timeout (tab=${d.tabId} type=${d.type})")
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
            log.warn("[browser-use] free-size unavailable: browser executor not initialized")
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
        log.info("[browser-use] enter free-size: ${viewportState.width}x${viewportState.height} @${viewportState.scalePct}%")
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
        log.info("[browser-use] viewport size: ${viewportState.width}x${viewportState.height}")
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
        log.info("[browser-use] exit free-size")
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
        val t = panelTheme()
        val menu = javax.swing.JPopupMenu()
        menu.background = t.stripBg
        menu.border = javax.swing.BorderFactory.createCompoundBorder(
            javax.swing.BorderFactory.createLineBorder(overlay(t.stripBg, t.fgMuted, 0x80), 1),
            JBUI.Borders.empty(4),
        )
        fun item(text: String, action: () -> Unit) = javax.swing.JMenuItem(text).apply {
            isOpaque = true
            background = t.stripBg
            foreground = t.fg
            font = font.deriveFont(java.awt.Font.PLAIN, JBUIScale.scale(12f))
            addActionListener { action() }
        }

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

    /** 视口尺寸对话框（宽/高输入，持久化）。自绘 JDialog：跟随 webview 生效主题
     *  （DialogWrapper 走 IDE LaF，webview 显式覆盖主题时观感割裂）*/
    private fun promptViewportSize() {
        val t = panelTheme()
        val parent = SwingUtilities.getWindowAncestor(this)
        val dlg = javax.swing.JDialog(parent, "视口尺寸", java.awt.Dialog.ModalityType.APPLICATION_MODAL)
        var result: Pair<Int, Int>? = null

        val fieldFont = JTextField().font.deriveFont(java.awt.Font.PLAIN, JBUIScale.scale(13f))
        fun themedField(initial: Int) = JTextField(initial.toString(), 8).apply {
            background = t.fieldBg
            foreground = t.fieldFg
            caretColor = t.fieldFg
            font = fieldFont
            border = JBUI.Borders.empty(4, 6)
        }
        val wField = themedField(viewportState.width)
        val hField = themedField(viewportState.height)

        fun tryConfirm() {
            val w = wField.text.trim().toIntOrNull() ?: return
            val h = hField.text.trim().toIntOrNull() ?: return
            result = w to h
            dlg.dispose()
        }

        val okBtn = ThemePillButton("确定", "应用视口尺寸") { tryConfirm() }
        val cancelBtn = ThemePillButton("取消", "放弃修改") { dlg.dispose() }

        fun label(text: String) = JLabel(text).apply {
            foreground = t.fg
            font = font.deriveFont(java.awt.Font.PLAIN, JBUIScale.scale(12f))
        }

        val content = JPanel(java.awt.GridBagLayout()).apply {
            background = t.bg
            val gbc = java.awt.GridBagConstraints().apply {
                insets = JBUI.insets(4, 6)
                anchor = java.awt.GridBagConstraints.WEST
                fill = java.awt.GridBagConstraints.HORIZONTAL
            }
            gbc.gridx = 0; gbc.gridy = 0; add(label("宽 (320-3840)："), gbc)
            gbc.gridx = 1; add(wField, gbc)
            gbc.gridx = 0; gbc.gridy = 1; add(label("高 (320-2160)："), gbc)
            gbc.gridx = 1; add(hField, gbc)
            gbc.gridx = 0; gbc.gridy = 2; gbc.gridwidth = 2
            gbc.anchor = java.awt.GridBagConstraints.EAST
            add(javax.swing.Box.createHorizontalBox().apply {
                add(okBtn)
                add(javax.swing.Box.createHorizontalStrut(JBUI.scale(6)))
                add(cancelBtn)
            }, gbc)
        }

        // Enter 确认 / Esc 取消（对齐 DialogWrapper 键盘语义）
        fun bind(key: Int, name: String, act: () -> Unit) {
            content.inputMap.put(javax.swing.KeyStroke.getKeyStroke(key, 0), name)
            content.actionMap.put(name, object : javax.swing.AbstractAction() {
                override fun actionPerformed(e: java.awt.event.ActionEvent?) = act()
            })
        }
        bind(java.awt.event.KeyEvent.VK_ENTER, "confirm") { tryConfirm() }
        bind(java.awt.event.KeyEvent.VK_ESCAPE, "cancel") { dlg.dispose() }

        dlg.contentPane = content
        dlg.isUndecorated = false // 保留系统标题栏（可拖动/关闭）
        dlg.pack()
        dlg.setLocationRelativeTo(parent)
        dlg.isVisible = true

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

    /** 空态欢迎页（按 webview 生效主题着色的静态快照；文案对齐 ZCode 客户端浏览器面板）*/
    private fun buildWelcomeHtml(): String {
        val dark = ZCodeAppearanceStore.effectiveTheme() == "dark"
        val bg = if (dark) "#1e1f22" else "#ffffff"
        val fg = if (dark) "#b6b9bd" else "#42464d"
        return """
            <html><head><meta charset="utf-8"></head>
            <body style="margin:0;background:$bg;color:$fg;font-family:'Segoe UI',system-ui,sans-serif">
            <div style="display:flex;height:100vh;align-items:center;justify-content:center;flex-direction:column;gap:8px">
              <div style="font-size:15px">${message("browser.welcome.hint")}</div>
              <div style="font-size:12px;opacity:.6">${message("browser.welcome.example")}</div>
            </div></body></html>
        """.trimIndent()
    }

    private fun createUnsupportedPanel(): JComponent {
        val label = JLabel(message("browser.unsupported"))
        label.foreground = JBColor.foreground()
        label.horizontalAlignment = SwingConstants.CENTER
        val wrapper = JPanel(BorderLayout())
        wrapper.background = JBColor.background()
        wrapper.add(label, BorderLayout.CENTER)
        return wrapper
    }

    /** Content 销毁时释放 JCEF 资源（content.setDisposer(panel) 绑定）*/
    override fun dispose() {
        try { lafConn?.dispose() } catch (_: Exception) {}
        lafConn = null
        for (tab in tabs) {
            pendingDialogs.remove(tab.id)
            try {
                Disposer.dispose(tab.browser)
            } catch (e: Exception) {
                log.warn("Failed to release JCEF of browser tab ${tab.id}: ${e.message}")
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

    /**
     * 取走 tab 的浏览器层 console 消息（网络资源加载失败等非 console API 类），
     * 供 executor 在 AI 读取 __zcodeDebug 时合入页面缓冲 browserMsgs。取走即清空。
     */
    internal fun drainBrowserConsoleLines(tabId: String?): List<String> {
        val tab = if (tabId != null) tabs.firstOrNull { it.id == tabId } ?: return emptyList()
        else activeTab ?: tabs.firstOrNull() ?: return emptyList()
        synchronized(tab.browserConsoleLines) {
            val out = ArrayList(tab.browserConsoleLines)
            tab.browserConsoleLines.clear()
            return out
        }
    }

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
            log.info("[browser-use] dialog handled (tab=${dialog.tabId} accept=$accept)")
            true
        } catch (e: Exception) {
            log.warn("[browser-use] dialog callback failed: ${e.message}")
            true // callback 已从挂起表移除，语义上已处置
        }
    }
}
