package com.zcode.ideaplugin.kb

import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.JBUI
import com.zcode.ideaplugin.ZCodeBundle
import java.awt.Color
import java.awt.Component
import java.awt.Graphics
import javax.swing.JComponent

/**
 * 知识库弹窗统一封装：
 * - [show]：显示 DialogWrapper（**平台默认屏幕居中**——贴鼠标定位两轮真机仍偶发
 *   「先居中再跳鼠标」闪动，用户拍板弃用，弹窗一律屏幕中间，勿再回改）；
 * - [input]：单行输入对话框（替代 Messages.showInputDialog）；
 * - [confirm]：确认对话框（替代 Messages.showYesNoDialog）。
 */
internal object KbDialogs {

    /** 显示 DialogWrapper 并等待（定位走平台默认=屏幕居中） */
    fun show(dialog: DialogWrapper): Boolean = dialog.showAndGet()

    /** 单行输入对话框。@return 输入文本（trim）；取消返回 null */
    fun input(title: String, initial: String = ""): String? {
        val dialog = object : DialogWrapper(true) {
            val field = JBTextField(initial)
            var value: String? = null

            init {
                setTitle(title)
                setOKButtonText(ZCodeBundle.message("kb.common.ok"))
                setCancelButtonText(ZCodeBundle.message("kb.common.cancel"))
                init()
            }

            override fun createCenterPanel(): JComponent = JPanelLike.grid(field)

            override fun doOKAction() {
                value = field.text.trim()
                super.doOKAction()
            }
        }
        return if (show(dialog)) dialog.value else null
    }

    /** 确认对话框（Yes 语义）。@return true=确认 */
    fun confirm(message: String, title: String): Boolean {
        val dialog = object : DialogWrapper(true) {
            init {
                setTitle(title)
                setOKButtonText(ZCodeBundle.message("kb.common.ok"))
                setCancelButtonText(ZCodeBundle.message("kb.common.cancel"))
                init()
            }

            override fun createCenterPanel(): JComponent =
                JBLabel(message).apply { border = JBUI.Borders.empty(8, 16) }
        }
        return show(dialog)
    }
}

/** 内部小工具：GridBag 单字段布局（避免在匿名 DialogWrapper 里写长布局代码） */
private object JPanelLike {
    fun grid(field: JBTextField): JComponent =
        javax.swing.JPanel(java.awt.GridBagLayout()).apply {
            val c = java.awt.GridBagConstraints().apply {
                insets = JBUI.insets(10, 14)
                fill = java.awt.GridBagConstraints.HORIZONTAL
                weightx = 1.0
                gridx = 0
                gridy = 0
            }
            add(field.apply { preferredSize = JBUI.size(320, field.preferredSize.height) }, c)
        }
}

/** 圆角色块图标（标签列表/菜单项/色板共用，kb 用户要求菜单项带标签色块） */
internal class ColorIcon(private val color: Color) : javax.swing.Icon {
    override fun getIconWidth(): Int = 14
    override fun getIconHeight(): Int = 14

    override fun paintIcon(c: Component?, g: Graphics, x: Int, y: Int) {
        val g2 = g.create() as Graphics
        try {
            g2.color = color
            g2.fillRoundRect(x, y, 14, 14, 6, 6)
        } finally {
            g2.dispose()
        }
    }
}
