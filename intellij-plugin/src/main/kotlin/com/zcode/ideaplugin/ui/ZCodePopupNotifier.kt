package com.zcode.ideaplugin.ui

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.IconLoader
import com.intellij.openapi.util.text.StringUtil
import com.intellij.openapi.wm.WindowManager
import com.intellij.ui.JBColor
import com.intellij.util.IconUtil
import java.awt.BasicStroke
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Cursor
import java.awt.Dimension
import java.awt.Font
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.GraphicsDevice
import java.awt.GraphicsEnvironment
import java.awt.RenderingHints
import java.awt.Toolkit
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.awt.geom.RoundRectangle2D
import java.awt.image.BufferedImage
import java.awt.image.ConvolveOp
import java.awt.image.FilteredImageSource
import java.awt.image.Kernel
import java.awt.image.RGBImageFilter
import javax.swing.BorderFactory
import javax.swing.Icon
import javax.swing.ImageIcon
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JWindow
import javax.swing.SwingUtilities
import javax.swing.Timer

/**
 * 自绘悬浮提醒弹窗（全局置顶 JWindow，纯 Swing 全平台可用——Windows/macOS/Linux 一套代码）：
 *
 * - 时长可配（秒；0=常驻直到点击/关闭）；位置可配（右上/右下，见 [PopupPosition]）；
 * - 点击卡片 → 回 IDE 前台并定位会话：点击是直接投喂本进程的用户输入，
 *   Windows 前台锁不适用（前台权随输入自动获得），不依赖 shell 渲染的通知通道；
 * - 单实例：新弹窗替换旧弹窗（审批与完成连发不叠罗汉）；
 * - 触发方仅在 IDE 主窗口非激活时调用（人在 IDE 内时有 webview 对话框可见）；
 * - 视觉（样式 v1）：透明通道下绕卡片绘柔和投影；标题行带插件 logo；
 *   卡片 hover 提亮、× 按钮 hover 底圈——纯视觉反馈，不改任何点击行为。
 */
object ZCodePopupNotifier {

    /** 圆角弧度（直径像素）*/
    private const val CORNER_ARC = 12

    /** 弹窗水平边距与右下角垂直边距（像素）*/
    private const val MARGIN = 16

    /** 右上角位置距屏幕工作区顶部的距离（像素）*/
    private const val TOP_MARGIN = 50

    /** 投影带宽度（像素）：透明通道下窗口比卡片大出的边距，定位时按卡片边缘折算；要容下模糊裙边 */
    private const val SHADOW_PAD = 24

    /** 投影向下偏移（像素），模拟自然光源 */
    private const val SHADOW_DY = 4

    /** 投影源形填充透明度（0-255）：经三重盒式模糊后摊薄为柔和裙边 */
    private const val SHADOW_ALPHA = 92

    /** 盒式模糊核半径（像素）：水平/垂直各 3 趟 ≈ 高斯 */
    private const val SHADOW_BLUR = 10

    private val log = Logger.getInstance("ZCodePlugin")

    /** 卡片 hover 提亮遮罩（深色主题叠白、浅色主题叠黑，alpha 小剂量）*/
    private val hoverOverlay: Color
        get() = JBColor(Color(0, 0, 0, 12), Color(255, 255, 255, 20))

    /** × 按钮 hover 底圈 */
    private val closeHoverBg: Color
        get() = JBColor(Color(0, 0, 0, 28), Color(255, 255, 255, 40))

    /** × 静态前景（平台 Close 图标默认色在暗底上对比不足，自绘 × 亮一档）*/
    private val closeForeground: Color
        get() = JBColor(Color(0x5A5E62), Color(0xB4B8BD))

    /** × hover 前景 */
    private val closeHoverForeground: Color
        get() = JBColor(Color(0x1D1F21), Color(0xE8EAEC))

    /** 标题前景（比主题默认 label 亮一档）*/
    private val titleForeground: Color
        get() = JBColor(Color(0x14171A), Color(0xF2F3F4))

    /** 正文前景（比主题默认 label 亮一档）*/
    private val bodyForeground: Color
        get() = JBColor(Color(0x3C3F41), Color(0xDFE1E4))

    /** 标题行插件 logo（16px；原 SVG 偏暗（#1E293B→#312E81），暗色卡片上发闷，渲染时提亮一档）*/
    private val pluginIcon: Icon by lazy {
        val raw = IconLoader.getIcon("/META-INF/pluginIcon.svg", ZCodePopupNotifier::class.java)
        brighten(IconUtil.scale(raw, null, 16f / raw.iconWidth))
    }

    /** 纯 JDK 提亮：RGB 线性放大 + 抬底，alpha 通道不动（只用于弹窗内 logo，不改共享图标资源）*/
    private fun brighten(icon: Icon): Icon {
        val img = BufferedImage(icon.iconWidth, icon.iconHeight, BufferedImage.TYPE_INT_ARGB)
        val g = img.createGraphics()
        icon.paintIcon(JPanel(), g, 0, 0)
        g.dispose()
        val filter = object : RGBImageFilter() {
            override fun filterRGB(x: Int, y: Int, rgb: Int): Int {
                val a = rgb shr 24 and 0xFF
                val r = ((rgb shr 16 and 0xFF) * 1.35f + 24).toInt().coerceAtMost(255)
                val gg = ((rgb shr 8 and 0xFF) * 1.35f + 24).toInt().coerceAtMost(255)
                val b = ((rgb and 0xFF) * 1.35f + 24).toInt().coerceAtMost(255)
                return (a shl 24) or (r shl 16) or (gg shl 8) or b
            }
        }
        return ImageIcon(Toolkit.getDefaultToolkit().createImage(FilteredImageSource(img.source, filter)))
    }

    /**
     * 真·柔和投影：离屏填圆角矩形源形 → 水平/垂直盒式模糊各 3 趟（≈高斯，含 alpha 通道）。
     * 逐圈描 1px 圆角矩形的做法会在卡片底边露出一条硬线（"透视的线"），模糊贴图无此问题。
     */
    private fun renderShadow(w: Int, h: Int): BufferedImage {
        val src = BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB)
        val sg = src.createGraphics()
        sg.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
        sg.color = Color(0, 0, 0, SHADOW_ALPHA)
        sg.fillRoundRect(SHADOW_PAD, SHADOW_PAD, w - SHADOW_PAD * 2, h - SHADOW_PAD * 2, CORNER_ARC, CORNER_ARC)
        sg.dispose()
        val k = 1f / (2 * SHADOW_BLUR + 1)
        val kernelH = Kernel(2 * SHADOW_BLUR + 1, 1, FloatArray(2 * SHADOW_BLUR + 1) { k })
        val kernelV = Kernel(1, 2 * SHADOW_BLUR + 1, FloatArray(2 * SHADOW_BLUR + 1) { k })
        var img = src
        repeat(3) {
            img = ConvolveOp(kernelH, ConvolveOp.EDGE_ZERO_FILL, null).filter(img, null)
            img = ConvolveOp(kernelV, ConvolveOp.EDGE_ZERO_FILL, null).filter(img, null)
        }
        return img
    }

    /** 弹窗位置（与前端 utils/notifyConfig.ts 的 PopupPosition 同源，按枚举名字符串存储）*/
    enum class PopupPosition {
        /** 右上角（距顶 50px）*/
        TOP_RIGHT,

        /** 右下角（贴系统 toast 位）*/
        BOTTOM_RIGHT,
    }

    @Volatile
    private var current: JWindow? = null

    @Volatile
    private var autoCloseTimer: Timer? = null

    /**
     * 弹卡片（任意线程可调，内部转 EDT）。[durationSec] 秒数，0=常驻；[onClick]
     * 在点击卡片后于 EDT 执行（本对象先关窗并把 IDE 抬回前台）。
     */
    fun showPopup(
        project: Project,
        title: String,
        body: String,
        durationSec: Int,
        position: PopupPosition,
        onClick: () -> Unit,
    ) {
        if (GraphicsEnvironment.isHeadless()) {
            log.warn("[DIAG-Notify] showPopup skipped: headless")
            return
        }
        log.info("[DIAG-Notify] showPopup requested: dur=${durationSec}s pos=$position title=$title")
        ApplicationManager.getApplication().invokeLater {
            try {
                showOnEdt(project, title, body, durationSec, position, onClick)
                log.info("[DIAG-Notify] showPopup shown")
            } catch (e: Exception) {
                log.warn("Popup notify failed: ${e.message}")
            }
        }
    }

    /** 关闭当前弹窗（若有）并停掉自动关闭计时器（EDT 调用）*/
    fun dismiss() {
        autoCloseTimer?.stop()
        autoCloseTimer = null
        current?.let {
            it.isVisible = false
            it.dispose()
        }
        current = null
    }

    /** 目标 project 的 IDE 主窗口非激活（用户切走/最小化）——通知的发送条件 */
    internal fun isIdeFrameInactive(project: Project): Boolean =
        WindowManager.getInstance().getFrame(project)?.isActive != true

    /** 把 IDE 主窗口拉回前台（最小化先还原）；点击弹窗时与定位会话配套使用 */
    internal fun bringIdeToFront(project: Project) {
        val frame = WindowManager.getInstance().getFrame(project) ?: return
        if (frame.extendedState and java.awt.Frame.ICONIFIED != 0) {
            frame.extendedState = frame.extendedState and java.awt.Frame.ICONIFIED.inv()
        }
        frame.isVisible = true
        forceForeground(frame)
    }

    /**
     * Windows 前台锁规避（2026-10-08 [DIAG-OSNOTIFY] 沙箱实测收敛，Win11 23H2）：
     * 前台锁下一切"激活"手段均被系统拒绝——纯 AWT toFront()、平台
     * AppIcon.requestFocus（内部同样是裸 SetForegroundWindow）、AttachThreadInput
     * （attach 本身被拒）、SendInput 注入输入（不再授予前台权）。
     * 唯一有效 = TOPMOST 切换：SetWindowPos 不需要前台权，先抬到最上层再取消置顶，
     * 视觉上 IDE 回到最前；随后补一次 SetForegroundWindow 尝试真激活
     * （有前台权的环境生效，被拒无害——窗口已可见）。
     */
    private fun forceForeground(window: java.awt.Window) {
        try {
            val id = com.sun.jna.Native.getComponentID(window)
            if (id == 0L) return
            val hwnd = com.sun.jna.platform.win32.WinDef.HWND(com.sun.jna.Pointer(id))
            val u = com.sun.jna.platform.win32.User32.INSTANCE
            val topmost = com.sun.jna.platform.win32.WinDef.HWND(com.sun.jna.Pointer(-1))
            val notopmost = com.sun.jna.platform.win32.WinDef.HWND(com.sun.jna.Pointer(-2))
            u.SetWindowPos(hwnd, topmost, 0, 0, 0, 0, 0x13) // SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE
            u.SetWindowPos(hwnd, notopmost, 0, 0, 0, 0, 0x13)
            u.SetForegroundWindow(hwnd)
        } catch (e: Throwable) {
            log.warn("Force foreground failed: ${e.message}")
            runCatching { com.intellij.ui.AppIcon.getInstance().requestFocus(window) }
        }
    }

    private fun showOnEdt(
        project: Project,
        title: String,
        body: String,
        durationSec: Int,
        position: PopupPosition,
        onClick: () -> Unit,
    ) {
        dismiss()
        val frame = WindowManager.getInstance().getFrame(project)
        val win = JWindow(frame)
        win.isAlwaysOnTop = true

        val hand = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
        val activate: () -> Unit = {
            dismiss()
            bringIdeToFront(project)
            onClick()
        }
        val clickHandler = object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) = activate()
        }

        // 文本清晰度：文字落在不透明卡片填充上，LCD 子像素 AA 可安全使用（横向 3 倍分辨率）；
        // 关闭分数字距让字形原点对齐整像素（首字不再因分数 x 发虚）
        val titleLabel = object : JLabel(StringUtil.escapeXmlEntities(title)) {
            override fun paintComponent(g: Graphics) {
                (g as Graphics2D).apply {
                    setRenderingHint(
                        RenderingHints.KEY_TEXT_ANTIALIASING,
                        RenderingHints.VALUE_TEXT_ANTIALIAS_LCD_HRGB,
                    )
                    setRenderingHint(
                        RenderingHints.KEY_FRACTIONALMETRICS,
                        RenderingHints.VALUE_FRACTIONALMETRICS_OFF,
                    )
                }
                super.paintComponent(g)
            }
        }.apply {
            font = font.deriveFont(Font.BOLD, font.size + 1f)
            foreground = titleForeground
            cursor = hand
            addMouseListener(clickHandler)
        }
        val iconLabel = object : JComponent() {
            override fun getPreferredSize(): Dimension = Dimension(16, 16)
            override fun paintComponent(g: Graphics) {
                pluginIcon.paintIcon(this, g, 0, (height - pluginIcon.iconHeight) / 2)
            }
        }.apply {
            cursor = hand
            addMouseListener(clickHandler)
        }
        // × 只关不跳（与卡片点击语义严格区分）；hover 底圈是纯视觉反馈
        val closeButton = object : JComponent() {
            var hover = false

            override fun getPreferredSize(): Dimension = Dimension(20, 20)
            override fun paintComponent(g: Graphics) {
                val g2 = g.create() as Graphics2D
                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
                if (hover) {
                    g2.color = closeHoverBg
                    g2.fillOval(0, 0, width, height)
                }
                g2.color = if (hover) closeHoverForeground else closeForeground
                g2.stroke = BasicStroke(1.4f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND)
                val cx = width / 2
                val cy = height / 2
                val r = 4
                g2.drawLine(cx - r, cy - r, cx + r, cy + r)
                g2.drawLine(cx + r, cy - r, cx - r, cy + r)
                g2.dispose()
            }
        }
        closeButton.apply {
            cursor = hand
            addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) = dismiss()
                override fun mouseEntered(e: MouseEvent) {
                    hover = true
                    repaint()
                }
                override fun mouseExited(e: MouseEvent) {
                    hover = false
                    repaint()
                }
            })
        }
        val bodyLabel = object : JLabel(
            "<html><div style='width:300px'>${StringUtil.escapeXmlEntities(body)}</div></html>"
        ) {
            override fun paintComponent(g: Graphics) {
                (g as Graphics2D).apply {
                    setRenderingHint(
                        RenderingHints.KEY_TEXT_ANTIALIASING,
                        RenderingHints.VALUE_TEXT_ANTIALIAS_LCD_HRGB,
                    )
                    setRenderingHint(
                        RenderingHints.KEY_FRACTIONALMETRICS,
                        RenderingHints.VALUE_FRACTIONALMETRICS_OFF,
                    )
                }
                super.paintComponent(g)
            }
        }.apply {
            font = font.deriveFont(font.size + 1f)
            foreground = bodyForeground
            cursor = hand
            addMouseListener(clickHandler)
        }

        val titleWrap = JPanel(BorderLayout(6, 0)).apply {
            isOpaque = false
            add(iconLabel, BorderLayout.WEST)
            add(titleLabel, BorderLayout.CENTER)
        }
        val topRow = JPanel(BorderLayout()).apply {
            isOpaque = false
            add(titleWrap, BorderLayout.CENTER)
            add(closeButton, BorderLayout.EAST)
        }
        // 正文缩进与标题文字对齐（图标 16 + 间距 6）
        val bodyWrap = JPanel(BorderLayout()).apply {
            isOpaque = false
            border = BorderFactory.createEmptyBorder(0, 22, 0, 0)
            add(bodyLabel, BorderLayout.CENTER)
        }

        // 圆角卡片：优先「逐像素透明窗 + 自绘圆角面板 + 柔和投影」（边角真透明、抗锯齿）；
        // 平台不支持透明时降级 setShape 裁圆角（无边框角略钝、无投影），再不行退回直角
        val gc = frame?.graphicsConfiguration
            ?: GraphicsEnvironment.getLocalGraphicsEnvironment().defaultScreenDevice.defaultConfiguration
        val translucentOk = try {
            gc.device.isWindowTranslucencySupported(GraphicsDevice.WindowTranslucency.PERPIXEL_TRANSPARENT)
        } catch (_: Throwable) {
            false
        }
        // 阴影带的窗外边距：透明通道为 SHADOW_PAD（定位按卡片边缘折算），降级通道无投影为 0
        val pad: Int
        val content: JPanel
        if (translucentOk) {
            pad = SHADOW_PAD
            win.background = Color(0, 0, 0, 0)
            val card = object : JPanel(BorderLayout(0, 5)) {
                var hover = false

                override fun paintComponent(g: Graphics) {
                    val g2 = g.create() as Graphics2D
                    g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
                    g2.color = background
                    g2.fillRoundRect(0, 0, width, height, CORNER_ARC, CORNER_ARC)
                    if (hover) {
                        g2.color = hoverOverlay
                        g2.fillRoundRect(0, 0, width, height, CORNER_ARC, CORNER_ARC)
                    }
                    g2.color = JBColor.border()
                    g2.drawRoundRect(0, 0, width - 1, height - 1, CORNER_ARC, CORNER_ARC)
                    g2.dispose()
                }
            }
            card.apply {
                isOpaque = false
                background = JBColor.PanelBackground
                border = BorderFactory.createEmptyBorder(12, 14, 13, 14)
                cursor = hand
                addMouseListener(clickHandler)
            }
            // hover 提亮：子组件进出都要保持卡片态；离开以坐标是否仍在卡片矩形内判定
            val hoverTracker = object : MouseAdapter() {
                override fun mouseEntered(e: MouseEvent) {
                    card.hover = true
                    card.repaint()
                }
                override fun mouseExited(e: MouseEvent) {
                    val p = SwingUtilities.convertPoint(e.component, e.point, card)
                    if (!card.contains(p)) {
                        card.hover = false
                        card.repaint()
                    }
                }
            }
            card.addMouseListener(hoverTracker)
            titleLabel.addMouseListener(hoverTracker)
            iconLabel.addMouseListener(hoverTracker)
            bodyLabel.addMouseListener(hoverTracker)
            closeButton.addMouseListener(hoverTracker)
            card.add(topRow, BorderLayout.NORTH)
            card.add(bodyWrap, BorderLayout.CENTER)

            // 柔和投影：模糊贴图按尺寸缓存（弹窗尺寸 pack 后不变，只算一次）
            content = object : JPanel(BorderLayout()) {
                private var cachedW = -1
                private var cachedH = -1
                private var shadowImg: BufferedImage? = null

                override fun paintComponent(g: Graphics) {
                    if (width != cachedW || height != cachedH) {
                        cachedW = width
                        cachedH = height
                        shadowImg = renderShadow(width, height)
                    }
                    shadowImg?.let { g.drawImage(it, 0, SHADOW_DY, null) }
                }
            }.apply {
                isOpaque = false
                border = BorderFactory.createEmptyBorder(SHADOW_PAD, SHADOW_PAD, SHADOW_PAD, SHADOW_PAD)
                add(card, BorderLayout.CENTER)
            }
        } else {
            pad = 0
            content = JPanel(BorderLayout(0, 6)).apply {
                border = BorderFactory.createCompoundBorder(
                    BorderFactory.createLineBorder(JBColor.border(), 1),
                    BorderFactory.createEmptyBorder(10, 12, 10, 12),
                )
                background = JBColor.PanelBackground
                cursor = hand
                addMouseListener(clickHandler)
                add(topRow, BorderLayout.NORTH)
                add(bodyWrap, BorderLayout.CENTER)
            }
        }
        win.contentPane.add(content)
        win.pack()
        if (!translucentOk) {
            runCatching {
                win.shape = RoundRectangle2D.Double(
                    0.0, 0.0, win.width.toDouble(), win.height.toDouble(),
                    CORNER_ARC.toDouble(), CORNER_ARC.toDouble(),
                )
            }
        }

        // 按配置定位到 IDE 所在屏幕的角落（含任务栏 insets）；透明通道按卡片边缘（扣除阴影带）对齐
        val b = gc.bounds
        val insets = Toolkit.getDefaultToolkit().getScreenInsets(gc)
        val x = b.x + b.width - insets.right - MARGIN - (win.width - pad)
        val y = when (position) {
            PopupPosition.TOP_RIGHT -> b.y + insets.top + TOP_MARGIN - pad
            PopupPosition.BOTTOM_RIGHT -> b.y + b.height - insets.bottom - MARGIN - (win.height - pad)
        }
        win.setLocation(x, y)
        win.isVisible = true
        current = win
        val ownerIconified = frame != null && (frame.extendedState and java.awt.Frame.ICONIFIED) != 0
        log.info("[DIAG-Notify] popup geometry: loc=($x,$y) size=${win.width}x${win.height} pad=$pad gcBounds=$b insets=$insets screens=${GraphicsEnvironment.getLocalGraphicsEnvironment().screenDevices.size} ownerIconified=$ownerIconified showing=${win.isShowing}")

        if (durationSec > 0) {
            val t = Timer(durationSec.coerceAtMost(3600) * 1000) { dismiss() }
            t.isRepeats = false
            t.start()
            autoCloseTimer = t
        }
    }
}
