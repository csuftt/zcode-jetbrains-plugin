package com.zcode.ideaplugin.kb

import com.intellij.icons.AllIcons
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.ui.JBColor
import com.intellij.ui.awt.RelativePoint
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.JBUI
import com.zcode.ideaplugin.ZCodeBundle
import com.zcode.kb.core.KbEntry
import com.zcode.kb.core.KbExtractor
import com.zcode.kb.core.KbFileStore
import com.zcode.kb.core.KbHeuristics
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.Insets
import java.awt.RenderingHints
import java.nio.file.Path
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel

/**
 * 收录确认弹窗（issue#54：不静默收录——预填启发式推断值，用户确认才入库）。
 *
 * - 单文件/编辑：标题可改 + 源文件只读行；多文件：公共字段一次填，标题逐文件按文件名默认
 *   （只读清单展示）；
 * - 目录（2026-11-21 树改版）：可编辑 combo（既有目录展示路径 `信创适配/中间件` + 根级；
 *   自由输入新路径 `a/b/c` 由调用方 ensureFolderPath 逐级建）；
 * - 标签：下拉框形态多选（复用目录 combo 视觉）——中央=已选色块 chips（点 ✕ 移除），
 *   右端 ▾ 弹选择菜单（勾选态✓+注册色块，底部「新建标签…」即建即选；用户拍板：
 *   菜单与选中展示都要带色块）。
 *
 * [titleValue]/[folderPathValue]/[tagsValue]/[notesValue] 在 doValidate 前（即 OK 后）读取。
 */
class KbIngestDialog(
    private val files: List<Path>,
    folderOptions: List<FolderOption>,
    tagNames: List<String>,
    editOf: KbEntry? = null,
    defaultFolderId: String = "",
) : DialogWrapper(true) {

    /** 目录下拉项：id + 派生展示路径（"" = 根级，恒为首项） */
    data class FolderOption(val id: String, val path: String, val name: String)

    private val titleField: JBTextField
    private val folderCombo: JComboBox<String>
    private val tagChips: JPanel
    private val tagCombo: JComponent
    private val notesArea: JBTextArea
    private val centerPanel: JComponent

    /** 已选标签（保序；初值=编辑条目现有标签 / heuristics 建议） */
    private val selectedTags = linkedSetOf<String>()
    /** 标签 → 注册色 hex（未注册回退灰；新建标签后 refreshTagColors 重读） */
    private var tagColorHex: Map<String, String> = emptyMap()

    /** path → id（预设项映射；自由输入不在此表，由调用方 ensureFolderPath 落库） */
    private val pathToId: Map<String, String> = folderOptions.associate { it.path to it.id }
    private val uncategorizedLabel = ZCodeBundle.message("kb.tw.uncategorized")

    init {
        title = when {
            editOf != null -> ZCodeBundle.message("kb.dialog.title.edit")
            files.size == 1 -> ZCodeBundle.message("kb.dialog.title.single", files[0].fileName.toString())
            else -> ZCodeBundle.message("kb.dialog.title.batch", files.size)
        }

        val firstText = files.firstOrNull()?.let { runCatching { KbExtractor.extract(it) }.getOrNull() }
        val suggestion = editOf?.let {
            KbHeuristics.Suggestion(it.title, "", it.tags)
        } ?: runCatching {
            KbHeuristics.suggest(files.first(), firstText, folderOptions.map { it.name }, tagNames)
        }.getOrDefault(KbHeuristics.Suggestion(files.firstOrNull()?.fileName?.toString() ?: "", "", emptyList()))

        // 内容左起点统一 6px（真机反馈：各输入框/下拉/文本起点不齐；label 6、combo UI 内置≈6）
        titleField = JBTextField(suggestion.title).apply { margin = JBUI.insets(2, 6, 2, 6) }
        // 预选优先级：编辑条目=原目录；heuristics 推断目录名命中；上次收录目录；根级
        val preselect = when {
            editOf != null -> folderOptions.firstOrNull { it.id == editOf.folderId }?.path ?: uncategorizedLabel
            suggestion.folderName.isNotEmpty() ->
                folderOptions.firstOrNull { opt -> opt.path == suggestion.folderName || opt.name == suggestion.folderName }?.path
                    ?: (folderOptions.firstOrNull { it.id == defaultFolderId && defaultFolderId.isNotEmpty() }?.path ?: uncategorizedLabel)
            defaultFolderId.isNotEmpty() -> folderOptions.firstOrNull { it.id == defaultFolderId }?.path ?: uncategorizedLabel
            else -> uncategorizedLabel
        }
        val items = arrayOf(uncategorizedLabel) + folderOptions.map { it.path }
        folderCombo = JComboBox(items).apply { isEditable = true; selectedItem = preselect }
        selectedTags.addAll(editOf?.tags ?: suggestion.tags)
        refreshTagColors()
        tagChips = JPanel(FlowWrap(4, 3, 360))
        tagCombo = buildTagCombo()
        notesArea = JBTextArea(3, 30).apply {
            text = editOf?.notes ?: ""
            lineWrap = true
            // 17+scroll 框线 1=18px：与带框线控件文字起点对齐（真机反馈起点不齐）
            border = JBUI.Borders.empty(2, 17, 2, 11)
        }

        centerPanel = JPanel(GridBagLayout()).apply {
            val c = GridBagConstraints().apply {
                insets = Insets(6, 10, 6, 10)
                anchor = GridBagConstraints.WEST
            }
            var row = 0
            if (files.size > 1) {
                val fileList = JBTextArea(files.size + 2, 6).apply {
                    text = files.joinToString("\n") { it.fileName.toString() }
                    isEditable = false
                    lineWrap = false
                }
                c.gridx = 0; c.gridy = row++; c.gridwidth = 2; c.fill = GridBagConstraints.HORIZONTAL; c.weightx = 1.0
                add(JBScrollPane(fileList).apply { preferredSize = Dimension(420, 100) }, c)
                c.gridwidth = 1; c.weightx = 0.0
            }
            // doc 等无正文提取路径的格式：收录前明示「仅标题检索」，避免收录后搜不到内容（缺陷记录见 bugs-regressions）
            if (files.any { !KbExtractor.hasTextPath(it.fileName.toString()) }) {
                c.gridx = 0; c.gridy = row++; c.gridwidth = 2; c.fill = GridBagConstraints.HORIZONTAL; c.weightx = 1.0
                add(JBLabel(ZCodeBundle.message("kb.dialog.unsearchableHint")).apply { icon = AllIcons.General.Warning }, c)
                c.gridwidth = 1; c.weightx = 0.0
            }
            // 源文件只读行放第一行（真机反馈：插在中间突兀；纯文本 HTML 限宽自动换行，
            // 左内边距 6px 与输入框文字起点对齐）
            (editOf?.sourcePath ?: files.singleOrNull())?.let { src ->
                c.gridx = 0; c.gridy = row
                add(JBLabel(ZCodeBundle.message("kb.dialog.sourceLabel")), c)
                c.gridx = 1; c.fill = GridBagConstraints.HORIZONTAL; c.weightx = 1.0
                add(JBLabel(htmlWrapped(KbFileStore.displayPath(src.toString()))).apply {
                    // 像素实测 -10：与 field 文字起点对齐
                    border = JBUI.Borders.empty(0, 8)
                }, c)
                c.weightx = 0.0
                row++
            }
            if (files.size == 1 || editOf != null) {
                c.gridx = 0; c.gridy = row
                add(JBLabel(ZCodeBundle.message("kb.dialog.titleLabel")), c)
                c.gridx = 1; c.fill = GridBagConstraints.HORIZONTAL; c.weightx = 1.0
                add(titleField, c)
                c.weightx = 0.0
                row++
            }
            c.gridx = 0; c.gridy = row
            add(JBLabel(ZCodeBundle.message("kb.dialog.folderLabel")), c)
            c.gridx = 1; c.fill = GridBagConstraints.HORIZONTAL; c.weightx = 1.0
            add(folderCombo, c)
            c.weightx = 0.0
            row++
            c.gridx = 0; c.gridy = row
            add(JBLabel(ZCodeBundle.message("kb.dialog.tagsLabel")), c)
            c.gridx = 1; c.fill = GridBagConstraints.HORIZONTAL; c.weightx = 1.0
            add(tagCombo.apply { tagChips.rebuildChips() }, c)
            c.weightx = 0.0
            row++
            c.gridx = 0; c.gridy = row; c.anchor = GridBagConstraints.NORTHWEST
            add(JBLabel(ZCodeBundle.message("kb.dialog.notesLabel")), c)
            c.gridx = 1; c.fill = GridBagConstraints.BOTH; c.weightx = 1.0
            c.weighty = 1.0 // 唯一 weighty 行：chip 增删引发的剩余/不足空间全部由备注吸收，其它行高锁定不重排（真机反馈备注高度跳变）
            add(JBScrollPane(notesArea).apply { preferredSize = Dimension(420, 64) }, c)
            c.weighty = 0.0
        }

        init()
    }

    val titleValue: String get() = titleField.text.trim()

    /**
     * 目录归属：预设项 = 已有目录 id；自由输入 = 空串（调用方拿 [folderPathValue] 走
     * ensureFolderPath 建目录得 id）；根级/无法解析 = ""（根级直放）。
     */
    val folderValue: String
        get() {
            val v = (folderCombo.selectedItem as? String ?: "").trim()
            return pathToId[v] ?: ""
        }

    /** 用户输入的目录路径原文（含预设项 path；「根级」归 ""）——自由输入时供 ensureFolderPath */
    val folderPathValue: String
        get() {
            val v = (folderCombo.selectedItem as? String ?: "").trim()
            return if (v == uncategorizedLabel) "" else v
        }

    val tagsValue: List<String> get() = selectedTags.toList()
    val notesValue: String get() = notesArea.text.trim()

    // ───────────────────────── 标签多选（下拉形态：chips 显示区+▾ 弹出选择，用户拍板） ─────────────────────────

    /** 弹出选择菜单的哨兵项（列表末尾「新建标签…」，普通标签不可能与之撞名） */
    private val newTagItem = "\u0001__new_tag__"

    /** 标签注册色 hex；未注册（heuristics 建议的新标签）回退灰 */
    private fun colorOf(tag: String): String =
        tagColorHex[tag] ?: KbFileStore.TAG_PALETTE.last()

    private fun refreshTagColors() {
        tagColorHex = runCatching {
            KbManagerService.instance.tagMetas().associate { it.name to it.color }
        }.getOrDefault(emptyMap())
    }

    /**
     * 下拉框形态的多选标签行（复用目录 combo 视觉）：中央=已选 chips 流，右端=▾；
     * 点 ▾（或行内空白）弹选择菜单（既有标签色块+勾选态✓+底部「新建标签…」）。
     */
    private fun buildTagCombo(): JComponent {
        val arrow = JBLabel(AllIcons.General.ChevronDown).apply { border = JBUI.Borders.emptyLeft(6) }
        arrow.addMouseListener(object : java.awt.event.MouseAdapter() {
            override fun mouseClicked(e: java.awt.event.MouseEvent) = showTagChooser()
        })
        return JPanel(BorderLayout()).apply {
            border = javax.swing.BorderFactory.createCompoundBorder(
                javax.swing.BorderFactory.createLineBorder(JBColor.border()),
                JBUI.Borders.empty(3, 1), // 像素实测 -16：chip 胶囊起点与 field 文字对齐；上下 3px 防 CJK 裁切
            )
            add(tagChips, BorderLayout.CENTER)
            add(arrow, BorderLayout.EAST)
            addMouseListener(object : java.awt.event.MouseAdapter() {
                override fun mouseClicked(e: java.awt.event.MouseEvent) = showTagChooser()
            })
        }
    }

    /** 重渲染已选 chips（增删后调用；▾ 在外层不受影响）；空选集显示灰色占位避免下拉框塌陷 */
    private fun JPanel.rebuildChips() {
        removeAll()
        if (selectedTags.isEmpty()) {
            add(JBLabel(ZCodeBundle.message("kb.dialog.tagsHint")).apply {
                foreground = com.intellij.util.ui.UIUtil.getContextHelpForeground()
            })
        } else {
            for (t in selectedTags) add(ChipLabel(t))
        }
        revalidate()
        repaint()
    }

    /** 长路径只读展示：HTML 限宽 400px 自动换行（撑不爆弹窗，转义防注入标签） */
    private fun htmlWrapped(path: String): String {
        val esc = path.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        return "<html><body style='width:400px'>$esc</body></html>"
    }

    /** 已注册标签选择菜单：色块+勾选态✓；点已选项=取消；底部「新建标签…」即建即选 */
    private fun showTagChooser() {
        val registered = runCatching { KbManagerService.instance.tags() }.getOrDefault(emptyList()).sorted()
        val items = registered + listOf(newTagItem)
        val builder = JBPopupFactory.getInstance().createPopupChooserBuilder(items)
        builder.setRenderer(javax.swing.ListCellRenderer<String> { _, value, _, isSelected, _ ->
            JLabel().apply {
                if (value == newTagItem) {
                    text = ZCodeBundle.message("kb.tw.tags.new")
                    icon = AllIcons.General.Add
                } else {
                    text = if (value in selectedTags) "$value  ✓" else value
                    icon = ColorIcon(runCatching { Color.decode(colorOf(value)) }.getOrDefault(Color(0x8A919C)))
                }
                border = JBUI.Borders.empty(2, 6)
                if (isSelected) {
                    background = com.intellij.util.ui.UIUtil.getListSelectionBackground(true)
                    foreground = com.intellij.util.ui.UIUtil.getListSelectionForeground(true)
                    isOpaque = true
                }
            }
        })
        builder.setItemChosenCallback(com.intellij.util.Consumer<String> { value ->
            if (value == newTagItem) {
                newTagAndSelect()
            } else {
                if (value in selectedTags) selectedTags.remove(value) else selectedTags.add(value)
                tagChips.rebuildChips()
            }
        })
        builder.createPopup().show(RelativePoint(tagCombo, java.awt.Point(0, tagCombo.height + 2)))
    }

    /** 输入 → 注册表登记（自动配色）→ 加入已选并刷新（KbTagsDialog.createTag 同款链路） */
    private fun newTagAndSelect() {
        val name = KbDialogs.input(ZCodeBundle.message("kb.tw.tags.newPrompt")) ?: return
        val clean = KbManagerService.sanitizeTags(listOf(name))
        if (clean.isEmpty()) return
        runCatching { KbManagerService.instance.createTag(clean.first()) }
        selectedTags.add(clean.first())
        refreshTagColors()
        tagChips.rebuildChips()
    }

    /** 已选标签胶囊（正常尺寸）：标签色圆角底+黑/白字，尾部「✕」点击移除 */
    private inner class ChipLabel(private val tag: String) : JBLabel("$tag ✕") {
        private val bg: Color = runCatching { Color.decode(colorOf(tag)) }.getOrDefault(Color(0x8A919C))

        init {
            font = JBUI.Fonts.label(11f)
            border = JBUI.Borders.empty(2, 6) // 上下 2px：CJK 字形超出 fontMetrics preferred 时不贴边被裁
            foreground = if (luminance(bg) > 0.55) Color(0x1E1E1E) else Color.WHITE
            isOpaque = false
            addMouseListener(object : java.awt.event.MouseAdapter() {
                override fun mouseClicked(e: java.awt.event.MouseEvent) {
                    if (e.x > width - 16) { // 命中尾部 ✕ 区
                        selectedTags.remove(tag)
                        tagChips.rebuildChips()
                    }
                }
            })
        }

        override fun paintComponent(g: Graphics) {
            val g2 = g.create() as Graphics2D
            try {
                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
                g2.color = bg
                g2.fillRoundRect(0, 0, width - 1, height - 1, height - 1, height - 1)
            } finally {
                g2.dispose()
            }
            super.paintComponent(g)
        }

        private fun luminance(c: Color): Double =
            (0.299 * c.red + 0.587 * c.green + 0.114 * c.blue) / 255.0
    }

    override fun createCenterPanel(): JComponent = JPanel(BorderLayout()).apply {
        add(centerPanel, BorderLayout.CENTER)
    }
}

/**
 * 固定宽度感知的 FlowLayout：GridBag 行高按组件 preferred 计算，原生 FlowLayout 的
 * preferred 是**单行总宽**——标签多时会撑爆弹窗宽度/裁掉换行后的第二行；按给定宽度
 * 模拟换行重算 preferred（实际布局仍用容器真实宽度，行为不变）。
 */
private class FlowWrap(hgap: Int, vgap: Int, private val wrapWidth: Int) : FlowLayout(FlowLayout.LEFT, hgap, vgap) {
    override fun preferredLayoutSize(target: java.awt.Container): Dimension {
        synchronized(target.treeLock) {
            var x = 0
            var rowH = 0
            var totalH = 0
            var maxRowW = 0
            for (i in 0 until target.componentCount) {
                val d = target.getComponent(i).preferredSize
                if (x > 0 && x + hgap + d.width > wrapWidth) {
                    totalH += rowH + vgap
                    x = 0
                    rowH = 0
                }
                if (x > 0) x += hgap
                x += d.width
                rowH = maxOf(rowH, d.height) + 2 // 每行 2px 余量：CJK 字形渲染超出 preferred 时不被裁
                maxRowW = maxOf(maxRowW, x)
            }
            totalH += rowH
            val ins = target.insets
            return Dimension(maxRowW + ins.left + ins.right, totalH + ins.top + ins.bottom)
        }
    }
}
