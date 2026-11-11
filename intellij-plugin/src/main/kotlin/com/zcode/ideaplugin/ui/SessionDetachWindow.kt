package com.zcode.ideaplugin.ui

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.WindowStateService
import com.intellij.ui.ScreenUtil
import com.intellij.ui.content.Content
import com.intellij.ui.content.ContentManager
import com.intellij.util.ui.JBUI
import com.zcode.ideaplugin.ZCodeBundle.message
import com.zcode.ideaplugin.zCodeService
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.awt.Dimension
import java.awt.Rectangle
import java.awt.Toolkit
import java.awt.Window
import java.util.concurrent.ConcurrentHashMap
import javax.swing.SwingUtilities

/**
 * 会话标签独立窗口（IDEA 集成面调研 ⑧，搬运式）：把主窗工具窗里的某个会话标签
 * 整体搬进独立 OS 窗口，供双屏监督（左屏代码被 AI 改、右屏对话监督）。
 *
 * 拍板（2026-11-10，用户未答按调研推荐执行）：**搬运式**——弹出的就是原标签的
 * [ZCodeToolWindowPanel]（独立 JCEF 实例原样保留，浏览器弹窗同款 reparent 通道），
 * 同一会话全程只有一处承载：无双订阅、不占双份 v4 槽位、流式事件单路。关闭独立
 * 窗口（标题栏 ×）即自动搬回主窗工具窗，「收回」无需额外入口。
 *
 * 搬运编排（EDT）：
 * 1. 先置 `panel.markDetachedToWindow(true)`——ContentManager 监听按它豁免
 *    unregisterPanel（弹窗期间标签必须继续收事件流）与关闭确认框（removeContent
 *    会触发 contentRemoveQuery，不该弹「确定关闭吗」）；
 * 2. `cm.removeContent(content, false)`（不销毁 Content/panel）——contentRemoved
 *    正常走 persistTabs（弹出标签暂不入 TabState，IDE 退出则其绑定从恢复链缺席，
 *    会话仍可从历史列表重开）+ 聊天标签清零时自动补待命标签（入口常在）；
 * 3. FrameWrapper 装载 panel（构造必须走 Java 桥，见 BrowserDetachWindowFactory 类注
 *    的跨加载器 LinkageError 教训）；注册回 ZCodeService 面板表与 activePanel 不动——
 *    面板从未 unregister，事件订阅照旧。
 *
 * 同一会话的外部跳转（通知/定时补发/任务列表）经 [focusDetachedSession] 兜底聚焦
 * 独立窗口，避免在主窗对同一会话开出第二个面板（并行双订阅正是要避免的形态）。
 * v1 限制：每项目同时至多一个弹出窗口。
 */
class SessionDetachWindow private constructor(
    private val project: Project,
    /** 被搬走的原标签（搬回主窗时原样 re-add） */
    private val content: Content,
    private val panel: ZCodeToolWindowPanel,
    /** 弹出前面板在工具窗里的尺寸（弹窗初始尺寸=它，2026-11-11 用户定稿） */
    private val preSize: Dimension,
    /** 弹出前面板所在的原生窗口（IDE 主窗）：初始位置对齐其左上角（尽量靠左） */
    private val ideWindow: Window?,
) {

    companion object {
        private val log = Logger.getInstance("ZCodePlugin")

        /** 窗口尺寸/位置记忆键（独立于浏览器弹窗的键，两窗口互不干扰；FrameWrapper 内部走它持久化） */
        private const val DIMENSION_KEY = "zcode.session.detachWindow"

        /** 首次几何的下限（面板宽过小/屏高异常时兜底，避免弹出一个不可用的窄条） */
        private val MIN_SIZE = Dimension(JBUI.scale(360), JBUI.scale(280))

        /** 每项目至多一个弹出窗口（v1）；项目关闭随 FrameWrapper 的 ProjectCloseListener 自动清 */
        private val ACTIVE = ConcurrentHashMap<Project, SessionDetachWindow>()

        fun isDetached(project: Project): Boolean = ACTIVE.containsKey(project)

        /** 当前弹窗实例（webview toggleDetachPin 处理器取用；无弹窗返回 null） */
        fun activeWindow(project: Project): SessionDetachWindow? = ACTIVE[project]

        /** webview 就绪补推（页面在弹窗期重载丢态）：恢复 ChatHeader 置顶按钮的显隐/态 */
        fun pushDetachStateIfActive(project: Project, panel: ZCodeToolWindowPanel) {
            val w = ACTIVE[project] ?: return
            if (w.panel === panel) w.pushDetachState()
        }

        /** 该会话当前是否在弹出窗口里（openSessionTab 等跳转入口先问这里） */
        fun isSessionDetached(project: Project, sessionId: String): Boolean {
            if (sessionId.isBlank()) return false
            val w = ACTIVE[project] ?: return false
            return w.panel.getCurrentSessionIdForPersist() == sessionId
        }

        /** 聚焦该会话所在的弹出窗口；返回 true 表示会话已在弹窗、调用方不必再开标签 */
        fun focusDetachedSession(project: Project, sessionId: String): Boolean {
            if (!isSessionDetached(project, sessionId)) return false
            val w = ACTIVE[project] ?: return false
            val frame = w.frameWrapper.getFrame()
            if (frame != null) {
                frame.toFront()
                frame.requestFocus()
            }
            return true
        }

        /**
         * 把标签弹出为独立窗口（须 EDT）。已有弹窗时气泡提示并忽略（不做多弹窗队列）。
         */
        fun detach(project: Project, content: Content) {
            if (ACTIVE.containsKey(project)) {
                NotificationGroupManager.getInstance()
                    .getNotificationGroup("ZCode")
                    .createNotification(message("action.detachTab.text"), message("session.detach.oneWindowOnly"), NotificationType.WARNING)
                    .notify(project)
                return
            }
            val panel = content.component as? ZCodeToolWindowPanel ?: return
            val cm: ContentManager = content.manager ?: return
            // 几何快照（removeContent 前取，此刻面板还带着工具窗里的有效布局）：
            // 尺寸=面板当前尺寸（用户定稿：弹窗跟弹出前一致），位置基准=IDE 主窗左上（尽量靠左）
            val preSize = panel.size
            val ideWindow = SwingUtilities.getWindowAncestor(panel)
            panel.ensureJcefCreated() // 右键菜单可触达非选中懒加载标签：弹出前先激活 JCEF
            // 顺序关键：先置 detached 标志再 removeContent——contentRemoved/contentRemoveQuery
            // 监听按标志豁免 unregisterPanel 与关闭确认框
            panel.markDetachedToWindow(true)
            cm.removeContent(content, false)
            val window = SessionDetachWindow(project, content, panel, preSize, ideWindow)
            ACTIVE[project] = window
            window.show()
            project.zCodeService().setActivePanel(panel)
            log.info("Session tab detached to window (session=${panel.getCurrentSessionIdForPersist()})")
        }
    }

    /** 平台独立窗口骨架；构造必须经 Java 工厂（跨加载器 LinkageError，0.4.1 实炸教训） */
    private val frameWrapper = BrowserDetachWindowFactory.create(project, DIMENSION_KEY)

    init {
        val title = panel.getBaseTabTitle().ifBlank { content.displayName ?: "" }
        frameWrapper.title = message("session.detach.title", title)
        frameWrapper.component = panel
        // 窗口任何路径关闭（标题栏 × / 项目关闭）→ 搬回主窗；回调随 Disposer 触发
        Disposer.register(frameWrapper) {
            try {
                onWindowClosed()
            } catch (e: Exception) {
                log.warn("Session detach window onClosed failed: ${e.message}")
            }
        }
    }

    private fun show() {
        // 记忆判定先于 show：FrameWrapper.show() 平台会按 DIMENSION_KEY 恢复上次边界
        // （关闭时自动 store，WindowStateService 同键）——有记忆即尊重用户上次的位置大小
        // （2026-11-11 用户定稿），本方法只在首次（无记忆）摆初始几何
        val hadSaved = WindowStateService.getInstance(project).getSize(DIMENSION_KEY) != null
        frameWrapper.show()
        if (!hadSaved) applyFirstRunGeometry()
        setPinned(true) // 每次弹出默认置顶（2026-11-11 用户定稿），可在头部按钮切换
    }

    /**
     * 首次弹出几何（2026-11-11 用户定稿：尽量铺满、尽量靠左）：
     * 宽度=弹出前面板宽度（「跟弹出前一致」），高度=屏幕可用高度铺满（减任务栏
     * insets，弹窗下方不留白）；位置=IDE 主窗左上角对齐（双屏跟随主窗所在屏），
     * 横向钳制屏内保证标题栏可见。之后边界记忆由平台键接管（关闭时 store）。
     */
    private fun applyFirstRunGeometry() {
        val frame = frameWrapper.getFrame() ?: return
        val anchor = ideWindow ?: frame
        val screen = ScreenUtil.getScreenRectangle(anchor)
        val insets = Toolkit.getDefaultToolkit().getScreenInsets(anchor.graphicsConfiguration)
        val width = maxOf(preSize.width, MIN_SIZE.width)
        val height = (screen.height - insets.top - insets.bottom).coerceAtLeast(MIN_SIZE.height)
        frame.bounds = Rectangle(
            (ideWindow?.x ?: screen.x).coerceIn(screen.x, (screen.x + screen.width - width).coerceAtLeast(screen.x)),
            screen.y + insets.top,
            width,
            height,
        )
    }

    // ============ 窗口置顶（WS_EX_TOPMOST，JDK 标准 Window API，浏览器弹窗同款）============

    private var pinned = false

    fun isPinned(): Boolean = pinned

    /** 头部置顶按钮切换入口（webview toggleDetachPin） */
    fun togglePin() = setPinned(!pinned)

    private fun setPinned(value: Boolean) {
        pinned = value
        frameWrapper.getFrame()?.isAlwaysOnTop = value
        pushDetachState()
    }

    /** 弹窗态推给 webview（ChatHeader 置顶按钮的显隐与态；搬回时 detached=false 收按钮） */
    private fun pushDetachState() {
        panel.pushToWebview(
            buildJsonObject {
                put("op", "detachWindowState")
                put("detached", true)
                put("pinned", pinned)
            }
        )
    }

    /**
     * 独立窗口关闭 → 搬回主窗工具窗。项目已关闭时无主窗可回：释放面板资源收尾。
     */
    private fun onWindowClosed() {
        ACTIVE.remove(project)
        if (project.isDisposed) {
            log.info("Project closing with detached session tab; disposing panel")
            Disposer.dispose(panel)
            return
        }
        val toolWindow = ZCodeToolWindowFactory.getToolWindow(project)
        if (toolWindow == null) {
            log.warn("ZCode tool window missing on restore; disposing panel")
            Disposer.dispose(panel)
            return
        }
        panel.markDetachedToWindow(false)
        // 弹窗态撤销推送：ChatHeader 置顶按钮随 detached=false 收起（推送先于搬回，
        // 窗口还在时 executeJavaScript 必达）
        panel.pushToWebview(
            buildJsonObject {
                put("op", "detachWindowState")
                put("detached", false)
                put("pinned", false)
            }
        )
        toolWindow.contentManager.addContent(content) // contentAdded → persistTabs/标题栏刷新
        toolWindow.contentManager.setSelectedContent(content) // selectionChanged → activePanel/JCEF
        toolWindow.show(null)
        project.zCodeService().setActivePanel(panel)
        // 标题栏弹出按钮兜底重挂：搬回路径 selectionChanged 的触发时机存在变体
        // （addContent 自动选中等），refreshTitleToolbar 现含 DetachTabAction，显式补刷
        // 保证搬回后按钮必在（2026-11-11 真机：搬回后按钮消失）
        ZCodeToolWindowFactory.refreshTitleToolbar(project)
        log.info("Session tab restored from detach window (session=${panel.getCurrentSessionIdForPersist()})")
    }
}
