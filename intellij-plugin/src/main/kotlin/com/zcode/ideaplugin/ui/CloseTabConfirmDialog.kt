package com.zcode.ideaplugin.ui

import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.ui.components.JBLabel
import java.awt.BorderLayout
import java.awt.MouseInfo
import javax.swing.Action
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * 关闭标签二次确认（DialogWrapper 自建版，替代平台 Messages.showYesNoDialog）：
 * 平台静态弹窗恒居中于屏幕，离标签行「×」点击处太远（用户反馈 2026-11-10，希望就近弹出）。
 * init 后 show 前按鼠标当前位置定位——弹窗出现在点击处左下方（不盖鼠标、不盖标签行）；
 * 取不到鼠标（无头/远程环境异常）时静默回退平台默认定位（父窗口居中）。
 * 按钮文案沿用平台本地化 是(Y)/否(N)（Messages.getYesButton/getNoButton），图标沿用
 * 问号，观感与原 Messages 弹窗一致；Esc=否、Enter=是（默认 OK 聚焦不变）。
 */
class CloseTabConfirmDialog(
    project: Project,
    private val messageText: String,
    dialogTitle: String,
) : DialogWrapper(project, true) {

    init {
        title = dialogTitle
        init()
        okAction.putValue(Action.NAME, Messages.getYesButton())
        cancelAction.putValue(Action.NAME, Messages.getNoButton())
        // 初始位置必须走 DialogWrapper.setLocation（置 myUserLocationSet/myUserBounds）：
        // 平台 peer.show() 的取位链 = DimensionServiceKey 存档 → getInitialLocation()（读
        // myUserLocationSet）→ 兜底 setLocationRelativeTo(owner) 居中；本对话框无 dimension
        // key，直接 window.setLocation 不置标志会被平台居中覆盖（真机实锤 2026-11-10）。
        // 偏移 = 弹窗左上角贴鼠标左侧 60px / 下方 28px——视觉上从点击处（标签 ×）右下
        // 就地弹出（首版 x-400 左移过远，弹窗跑到相邻窗口上方，真机否决）；弹窗宽约
        // 440 超出屏幕右缘时平台 autoAdjustable fitToScreen 自动收回。无鼠标环境（无头）
        // 保持 null → 平台默认居中
        try {
            MouseInfo.getPointerInfo()?.location?.let { pt ->
                setLocation(pt.x - 60, pt.y + 28)
            }
        } catch (_: Throwable) {
            // 无鼠标环境回退默认定位
        }
    }

    /** 问号图标 + 纯文本（对齐原 Messages.showYesNoDialog 观感）*/
    override fun createCenterPanel(): JComponent = JPanel(BorderLayout()).apply {
        add(JBLabel(Messages.getQuestionIcon()), BorderLayout.WEST)
        add(JBLabel(messageText), BorderLayout.CENTER)
    }
}
