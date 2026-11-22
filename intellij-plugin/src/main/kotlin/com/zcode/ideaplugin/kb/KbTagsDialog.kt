package com.zcode.ideaplugin.kb

import com.intellij.icons.AllIcons
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.util.ui.JBUI
import com.zcode.ideaplugin.ZCodeBundle
import com.zcode.kb.core.KbFileStore
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Component
import java.awt.Dimension
import java.awt.Graphics
import javax.swing.Box
import javax.swing.DefaultListModel
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.JScrollPane
import javax.swing.ListSelectionModel

/**
 * 标签管理对话框：标签名+使用计数+色块列表，操作=新建/重命名/删除/改色，即时生效。
 *
 * 标签注册表在 config.json（KbTagMeta name+color）：新建=登记+自动轮转分配颜色（可
 * 随后改色）；重命名=全局改写条目+注册表；删除=从全部条目摘除+注册表删除。
 * 无主标签（count=0）合法——先建体系后挂条目。
 */
class KbTagsDialog : DialogWrapper(true) {

    private val listModel = DefaultListModel<Array<String>>() // [name, count, color]
    private val list = JList(listModel)
    private val newBtn = JButton(ZCodeBundle.message("kb.tw.tags.new")).apply { icon = AllIcons.General.Add }
    private val renameBtn = JButton(ZCodeBundle.message("kb.tw.tags.rename")).apply { icon = AllIcons.Actions.Edit }
    private val colorBtn = JButton(ZCodeBundle.message("kb.tw.tags.color")).apply { icon = AllIcons.Actions.MoveToTopRight }
    private val deleteBtn = JButton(ZCodeBundle.message("kb.tw.tags.delete")).apply { icon = AllIcons.Actions.GC }

    init {
        setTitle(ZCodeBundle.message("kb.tw.tags.manage"))
        list.selectionMode = ListSelectionModel.SINGLE_SELECTION
        list.addListSelectionListener { syncButtons() }
        list.cellRenderer = javax.swing.ListCellRenderer<Array<String>> { _, value, _, isSelected, _ ->
            JLabel(value[0] + "  " + ZCodeBundle.message("kb.tw.tags.count", value[1].toInt())).apply {
                icon = ColorIcon(runCatching { Color.decode(value[2]) }.getOrDefault(Color(0x8A919C)))
                border = JBUI.Borders.empty(2, 4)
                if (isSelected) {
                    background = list.selectionBackground
                    foreground = list.selectionForeground
                    isOpaque = true
                }
            }
        }
        reload()

        newBtn.addActionListener { createTag() }
        renameBtn.addActionListener { renameSelected() }
        colorBtn.addActionListener { colorSelected() }
        deleteBtn.addActionListener { deleteSelected() }

        setOKButtonText(ZCodeBundle.message("kb.tw.tags.close"))
        init()
    }

    private fun selectedTag(): String? = list.selectedValue?.get(0)

    private fun syncButtons() {
        val has = selectedTag() != null
        renameBtn.isEnabled = has
        colorBtn.isEnabled = has
        deleteBtn.isEnabled = has
    }

    private fun reload() {
        listModel.clear()
        for ((name, count) in KbManagerService.instance.tagCounts().toList().sortedBy { it.first }) {
            val color = KbManagerService.instance.tagMetas().firstOrNull { it.name == name }?.color
                ?: KbFileStore.TAG_PALETTE.last()
            listModel.addElement(arrayOf(name, count.toString(), color))
        }
        syncButtons()
    }

    private fun createTag() {
        val name = KbDialogs.input(ZCodeBundle.message("kb.tw.tags.newPrompt")) ?: return
        val clean = KbManagerService.sanitizeTags(listOf(name))
        if (clean.isEmpty()) return
        runCatching { KbManagerService.instance.createTag(clean.first()) }
        reload()
    }

    private fun renameSelected() {
        val from = selectedTag() ?: return
        val to = KbDialogs.input(ZCodeBundle.message("kb.tw.tags.renamePrompt", from), from)?.trim()
        if (to.isNullOrBlank() || to == from) return
        KbManagerService.instance.renameTag(from, to)
        reload()
    }

    /** 改色：色板 popup（8 色圆角方块）选中即生效（服务层 publish 刷新树 chip）并刷新本列表色块 */
    private fun colorSelected() {
        val name = selectedTag() ?: return
        val builder = JBPopupFactory.getInstance().createPopupChooserBuilder(KbFileStore.TAG_PALETTE)
        builder.setRenderer(javax.swing.ListCellRenderer<String> { _, value, _, isSelected, _ ->
            JLabel(value).apply {
                icon = ColorIcon(runCatching { Color.decode(value) }.getOrDefault(Color.GRAY))
                border = JBUI.Borders.empty(2, 6)
                if (isSelected) {
                    background = list.selectionBackground
                    foreground = list.selectionForeground
                    isOpaque = true
                }
            }
        })
        builder.setItemChosenCallback(com.intellij.util.Consumer<String> { value ->
            KbManagerService.instance.setTagColor(name, value)
            reload() // 列表色块实时同步（真机反馈：改色后左侧颜色不动）
        })
        val popup = builder.createPopup()
        popup.show(com.intellij.ui.awt.RelativePoint(colorBtn, java.awt.Point(0, colorBtn.height + 2)))
    }

    // 列表/色板色块用共享 ColorIcon（KbDialogs.kt），本地实现已移除

    private fun deleteSelected() {
        val name = selectedTag() ?: return
        val affected = KbManagerService.instance.tagCounts()[name] ?: 0
        val confirmed = KbDialogs.confirm(
            ZCodeBundle.message("kb.tw.tags.deleteConfirm", name, affected),
            ZCodeBundle.message("kb.tw.tags.delete"),
        )
        if (!confirmed) return
        KbManagerService.instance.deleteTag(name)
        reload()
    }

    override fun createCenterPanel(): JComponent = JPanel(BorderLayout()).apply {
        add(JScrollPane(list).apply { preferredSize = Dimension(320, 300) }, BorderLayout.CENTER)
        add(buttonColumn(), BorderLayout.EAST)
    }

    /** 按钮列（用户拍板：内容居中，短文字尾部填空格到等宽=图标起点对齐，按钮本身统一宽度居中排列） */
    private fun buttonColumn(): JComponent {
        val buttons = listOf(newBtn, renameBtn, colorBtn, deleteBtn)
        // 空格填充：内容（图标+文字）总宽补到与最宽按钮一致，居中后图标起点才严格对齐
        val targetW = buttons.maxOf { it.preferredSize.width }
        buttons.forEach { b ->
            var guard = 0
            while (b.preferredSize.width < targetW && guard++ < 24) b.text = "${b.text} "
        }
        val maxW = buttons.maxOf { it.preferredSize.width }
        val maxH = buttons.maxOf { it.preferredSize.height }
        buttons.forEach { b ->
            b.horizontalAlignment = javax.swing.SwingConstants.CENTER
            b.preferredSize = Dimension(maxW, maxH) // 填充后的实际宽度统一（空格粒度导致的±1px归零）
        }
        val column = Box.createVerticalBox().apply { border = JBUI.Borders.emptyLeft(10) }
        buttons.forEachIndexed { i, b ->
            b.alignmentX = java.awt.Component.CENTER_ALIGNMENT
            b.maximumSize = Dimension(maxW + 2, maxH)
            column.add(b)
            if (i < buttons.lastIndex) column.add(Box.createVerticalStrut(6))
        }
        column.add(Box.createVerticalGlue())
        return column
    }
}
