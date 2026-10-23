package com.zcode.ideaplugin.ui

import com.intellij.openapi.Disposable
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.FrameWrapper
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.WindowStateService
import com.intellij.util.ui.JBUI
import com.zcode.ideaplugin.ZCodeBundle.message
import java.awt.Dimension
import java.awt.Window

/**
 * 浏览器独立窗口：把共享 [ZCodeBrowserPanel] 整体搬到独立原生窗口（工具条「弹出」按钮）。
 *
 * 承载用平台 [FrameWrapper]（查找用法「在新窗口打开」同款）而非 DialogWrapper：出的是标准
 * 独立窗口——原生细边框 + 最小化/最大化/关闭三件套，内容边贴边无对话框那圈内边距；Esc 天然
 * 不绑关窗语义（FrameWrapper 的 closeOnEsc 是可选项，不调即直落页面——退出全屏/停表单/关
 * 弹层都是页面高频快捷键）。关窗只认标题栏 × 与浏览器工具条「收起」。
 *
 * 核心仍是「搬运」而非重建：面板组件从侧栏分栏摘出后 add 进本窗口，JCEF 的 windowed
 * browser 在 removeNotify/addNotify 时经上游 reparent 支持重挂新窗口句柄——页面进程
 * 与 CDP target 全程不销毁，AI 的 browser-use 操作（走 CDP）零中断，SPA 状态/登录态
 * /滚动位置原样保留。窗口任何路径关闭后由 Service 层把面板挂回侧栏。
 *
 * 实现约束（0.4.1 真机实炸教训）：FrameWrapper 不能从 Kotlin 直接构造或继承——带默认参的
 * 构造器经 Kotlin 编译必然解析到携带 kotlinx.coroutines.CoroutineScope 形参的全参合成
 * 构造器，插件 lib 自带的 coroutines 副本与平台副本跨类加载器同名不同类 → LinkageError。
 * 构造必须经 [BrowserDetachWindowFactory]（Java 桥，详见其类注），本类组合持用而非继承；
 * 其余成员方法签名只含 JDK/平台类型，Kotlin 侧直接调用安全。
 */
class BrowserDetachWindow private constructor(
    private val project: Project,
    browserPanel: ZCodeBrowserPanel,
    /** 窗口任何路径关闭后的回调（经 Disposer 触发；Service 层负责收回侧栏） */
    onClosed: () -> Unit,
) : Disposable {

    companion object {
        private val log = Logger.getInstance("ZCodePlugin")

        /** 窗口尺寸/位置记忆键：沿用旧弹窗版本的键，用户已调好的尺寸位置无缝继承 */
        private const val DIMENSION_KEY = "zcode.browser.detachDialog"

        /** 首次打开（无记忆尺寸）时的默认大小 */
        private val DEFAULT_SIZE = Dimension(JBUI.scale(1100), JBUI.scale(760))

        /**
         * 打开窗口（EDT；由 Service 层编排，保证同一时刻至多一个实例）。
         */
        fun showWindow(
            project: Project,
            panel: ZCodeBrowserPanel,
            onClosed: () -> Unit,
        ): BrowserDetachWindow {
            val window = BrowserDetachWindow(project, panel, onClosed)
            val hadSavedSize = WindowStateService.getInstance(project).getSize(DIMENSION_KEY) != null
            window.show()
            if (!hadSavedSize) {
                // show() 对无记忆态走 IdeFrame 建议边界（近乎全屏大小），按旧弹窗的默认档显式设一次
                window.setSize(DEFAULT_SIZE)
            }
            log.info("Browser detach window shown")
            return window
        }
    }

    /** 平台独立窗口骨架（细边框+最小化/最大化/关闭三件套）；构造必须经 Java 工厂，见类注 */
    private val frameWrapper: FrameWrapper = BrowserDetachWindowFactory.create(project, DIMENSION_KEY)

    init {
        // title/component 是 Kotlin 合成属性（Kotlin 侧 setter 不暴露为 setTitle/setComponent 方法）
        frameWrapper.title = message("browser.detach.title")
        frameWrapper.component = browserPanel
        // 关闭回调挂 Disposer：标题栏 ×（windowClosing → close → Disposer.dispose）/ 项目关闭
        // （FrameWrapper 自带 ProjectCloseListener → close）/ [dispose] 外部处置，任何路径都触发
        Disposer.register(frameWrapper) {
            try {
                onClosed()
            } catch (e: Exception) {
                log.warn("Browser detach window onClosed failed: ${e.message}")
            }
        }
    }

    val isDisposed: Boolean
        get() = frameWrapper.isDisposed

    fun getFrame(): Window? = if (isDisposed) null else frameWrapper.getFrame()

    fun show() {
        frameWrapper.show()
    }

    fun setSize(size: Dimension) {
        frameWrapper.setSize(size)
    }

    /** 窗口置顶（WS_EX_TOPMOST）：JDK 标准 Window API，无平台/跨加载器依赖 */
    fun setAlwaysOnTop(enabled: Boolean) {
        if (!isDisposed) frameWrapper.getFrame()?.setAlwaysOnTop(enabled)
    }

    fun isAlwaysOnTop(): Boolean = !isDisposed && frameWrapper.getFrame()?.isAlwaysOnTop == true

    /** Service 层收回侧栏前主动关窗：dispose 骨架窗口，挂在其上的 onClosed 回调随之触发 */
    override fun dispose() {
        if (!isDisposed) {
            Disposer.dispose(frameWrapper)
        }
    }
}
