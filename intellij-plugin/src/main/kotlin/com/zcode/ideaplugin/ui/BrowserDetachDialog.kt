package com.zcode.ideaplugin.ui

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.util.Disposer
import com.intellij.util.ui.JBUI
import com.zcode.ideaplugin.ZCodeBundle.message
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.event.ActionListener
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * 浏览器弹窗：把共享 [ZCodeBrowserPanel] 整体搬到独立非模态窗口（工具条「弹出」按钮）。
 *
 * 核心是「搬运」而非重建：面板组件从侧栏分栏摘出后 add 进本窗口，JCEF 的 windowed
 * browser 在 removeNotify/addNotify 时经上游 reparent 支持重挂新窗口句柄——页面进程
 * 与 CDP target 全程不销毁，AI 的 browser-use 操作（走 CDP）零中断，SPA 状态/登录态
 * /滚动位置原样保留。窗口关闭（仅标题栏 ×，Esc 有意不关——它是页面高频快捷键）后由
 * Service 层把面板挂回侧栏。
 *
 * 形态参照逐轮审查弹窗（非模态 DialogWrapper，可边看边操作）；尺寸/位置由平台的
 * [getDimensionServiceKey] 记忆与恢复。
 */
class BrowserDetachDialog private constructor(
    project: com.intellij.openapi.project.Project,
    private val browserPanel: ZCodeBrowserPanel,
    /** 窗口任何路径关闭后的回调（经 Disposer 触发；Service 层负责收回侧栏） */
    onClosed: () -> Unit,
) : DialogWrapper(project, null, true, IdeModalityType.MODELESS, false) {

    companion object {
        private val log = Logger.getInstance("ZCodePlugin")

        /** 弹窗尺寸/位置记忆键（平台 DimensionService）*/
        private const val DIMENSION_KEY = "zcode.browser.detachDialog"

        /**
         * 打开弹窗（EDT；由 Service 层编排，保证同一时刻至多一个实例）。
         * 首次打开给个默认尺寸（此后由 DimensionService 记忆接管）。
         */
        fun showWindow(
            project: com.intellij.openapi.project.Project,
            panel: ZCodeBrowserPanel,
            onClosed: () -> Unit,
        ): BrowserDetachDialog {
            val dialog = BrowserDetachDialog(project, panel, onClosed)
            dialog.show()
            log.info("Browser detach dialog shown")
            return dialog
        }
    }

    init {
        title = message("browser.detach.title")
        init()
        // 关闭回调挂 Disposer：标题栏 × / 程序关闭 / 外部 dispose 任何路径都触发
        Disposer.register(myDisposable) {
            try {
                onClosed()
            } catch (e: Exception) {
                log.warn("Browser detach dialog onClosed failed: ${e.message}")
            }
        }
    }

    override fun getDimensionServiceKey(): String = DIMENSION_KEY

    /**
     * Esc 不关窗：浏览器页面里 Esc 是高频页面快捷键（退出全屏/停表单/关弹层），
     * 关窗只认标题栏 × 与浏览器工具条「收起」。返回 null 是平台官方的「忽略 Esc」扩展点。
     */
    override fun createCancelAction(): ActionListener? = null

    /** 包装层只负责给首次打开提供默认尺寸（面板本体 preferredSize 不动，回侧栏布局不受影响） */
    override fun createCenterPanel(): JComponent {
        val wrapper = JPanel(BorderLayout())
        wrapper.add(browserPanel, BorderLayout.CENTER)
        wrapper.preferredSize = Dimension(JBUI.scale(1100), JBUI.scale(760))
        return wrapper
    }

    /** 无按钮栏：导航/视口/收起等控件全在浏览器面板自己的工具条里 */
    override fun createSouthPanel(): JComponent = JPanel().apply {
        isOpaque = false
        border = JBUI.Borders.empty()
    }
}
