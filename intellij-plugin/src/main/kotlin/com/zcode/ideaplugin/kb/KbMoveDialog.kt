package com.zcode.ideaplugin.kb

import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.components.JBLabel
import com.zcode.ideaplugin.ZCodeBundle
import com.zcode.kb.core.KbFolder
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.Insets
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * 「移动到…」目录选择弹窗（条目/目录移动的拖拽兜底通道）。
 *
 * 首版用 DialogWrapper+Tree 真机渲染出全黑空壳（深色主题空树区域+无 project 上下文，
 * 只能 Esc 关闭），改用与收录弹窗一致的**可编辑目录路径下拉**实现：
 * - 预设项 = 根级 + 全部目录展示路径（排除 [excludeIds]——移动目录时=自身及子孙）；
 * - 自由输入新路径 = ensureFolderPath 逐级建目录（移动即建挂载点）；
 * - 数据层 moveFolder 防环二次校验兜底。
 */
class KbMoveDialog(
    folderOptions: List<KbIngestDialog.FolderOption>,
    excludeIds: Set<String>,
    currentFolderId: String,
) : DialogWrapper(true) {

    private val pathToId: Map<String, String> =
        folderOptions.filter { !excludeIds.contains(it.id) }.associate { it.path to it.id }
    private val uncategorizedLabel = ZCodeBundle.message("kb.tw.uncategorized")
    private val folderCombo: JComboBox<String>

    init {
        setTitle(ZCodeBundle.message("kb.tw.btn.move"))
        val items = arrayOf(uncategorizedLabel) + pathToId.keys.toTypedArray()
        // 预选当前目录；被排除（自身子树）时落根级
        val preselect = folderOptions.firstOrNull { it.id == currentFolderId && !excludeIds.contains(it.id) }
            ?.path ?: uncategorizedLabel
        folderCombo = JComboBox(items).apply { isEditable = true; selectedItem = preselect }

        setOKButtonText(ZCodeBundle.message("kb.tw.moveHere"))
        init()
    }

    /** 目录归属：预设项=已有目录 id；根级/自由输入=""（调用方拿 [folderPathValue] 走 ensureFolderPath） */
    val folderValue: String
        get() {
            val v = (folderCombo.selectedItem as? String ?: "").trim()
            return pathToId[v] ?: ""
        }

    /** 目录路径原文（含预设项 path；「根级」归 ""） */
    val folderPathValue: String
        get() {
            val v = (folderCombo.selectedItem as? String ?: "").trim()
            return if (v == uncategorizedLabel) "" else v
        }

    /** @return 目标（id 或路径由两 getter 语义区分）；取消返回 null */
    fun selectedFolderId(): String? = if (isOK) folderValue else null

    override fun createCenterPanel(): JComponent = JPanel(GridBagLayout()).apply {
        val c = GridBagConstraints().apply {
            insets = Insets(10, 12, 10, 12)
            anchor = GridBagConstraints.WEST
            fill = GridBagConstraints.HORIZONTAL
            weightx = 1.0
        }
        c.gridx = 0; c.gridy = 0; c.weightx = 0.0
        add(JBLabel(ZCodeBundle.message("kb.dialog.folderLabel")), c)
        c.gridx = 1; c.weightx = 1.0
        add(folderCombo, c)
    }
}
