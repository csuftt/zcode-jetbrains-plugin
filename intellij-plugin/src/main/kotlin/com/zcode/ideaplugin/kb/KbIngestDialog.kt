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
import com.intellij.util.ui.UIUtil
import com.zcode.ideaplugin.ZCodeBundle
import com.zcode.kb.core.KbContent
import com.zcode.kb.core.KbEntry
import com.zcode.kb.core.KbExtractor
import com.zcode.kb.core.KbFileStore
import com.zcode.kb.core.KbGitCli
import com.zcode.kb.core.KbHeuristics
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
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
import java.nio.file.Files
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
 *   菜单与选中展示都要带色块）。单行排布、超宽收「+N」胶囊，行高锁定=目录 combo
 *   preferred 高（选/未选同高，不挤备注行）；框线对齐靠离屏试画标定原生 border 的
 *   真实绘制偏移/色号再补偿（原生 border 带组件类型门控不可复用），框线与标题/
 *   目录/备注左右同列（缺陷HX）；
 * - 源文件下方一行（2026-11-23 用户要求）：源文件在时显示该文件自己的最近提交（哈希/日期/
 *   标题，仅 git 管理的文件出现；未提交的新文件、被 .gitignore 忽略、有未提交修改各有
 *   文案）。源文件不在时这一行改为显示文档快照的信息（知识库里的存档副本；没有快照则
 *   明示没有内容），源文件行同步标注「源文件在本机不存在」。git 子进程与解析都在后台
 *   线程做——行先隐藏，查到再显示并重排弹窗。多文件收录不查（清单里每行一个提交既挤又慢）。
 *
 * [titleValue]/[folderPathValue]/[tagsValue]/[notesValue] 在 doValidate 前（即 OK 后）读取。
 */
class KbIngestDialog(
    private val files: List<Path>,
    folderOptions: List<FolderOption>,
    editOf: KbEntry? = null,
    defaultFolderId: String = "",
    /** 只用于解析 git 可执行路径（项目里配了自定义 git 时取项目里那个）；null = PATH 上的 git */
    private val project: com.intellij.openapi.project.Project? = null,
) : DialogWrapper(true) {

    /** 目录下拉项：id + 派生展示路径（"" = 根级，恒为首项） */
    data class FolderOption(val id: String, val path: String, val name: String)

    private val titleField: JBTextField
    private val folderCombo: JComboBox<String>
    private val tagChips: JPanel
    private val tagCombo: JComponent
    private val notesArea: JBTextArea
    private val centerPanel: JComponent

    /** 源文件只读行（源文件不在时追加灰色标注） */
    private val sourceLabel = JBLabel()

    /** 源文件下方那一行（Git 提交，或源文件不在时的文档快照信息）：初值隐藏，后台查到才显示；左内边距与源文件行同值（文字起点对齐） */
    private val commitCaption = JBLabel(ZCodeBundle.message("kb.dialog.commitLabel")).apply { isVisible = false }
    private val commitLabel = JBLabel().apply {
        isVisible = false
        border = JBUI.Borders.empty(0, 8)
    }

    /** 「Git 提交」行要查的文件（仅单文件收录/编辑有源文件行；多文件收录不查） */
    private var gitSource: Path? = null

    /** 已选标签（保序；初值=编辑条目现有标签；收录默认空，用户自选） */
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
        // 2026-11-23 用户拍板：只预填标题（heuristics 推断），标签/目录一律不预填——
        // 标签让用户自己选，目录默认根级（Suggestion 的 folderName/tags 不再消费）
        val suggestion = editOf?.let {
            KbHeuristics.Suggestion(it.title, "", emptyList())
        } ?: runCatching {
            KbHeuristics.suggest(files.first(), firstText, folderOptions.map { it.name }, emptyList())
        }.getOrDefault(KbHeuristics.Suggestion(files.firstOrNull()?.fileName?.toString() ?: "", "", emptyList()))

        // 内容左起点统一 6px（真机反馈：各输入框/下拉/文本起点不齐；label 6、combo UI 内置≈6）
        titleField = JBTextField(suggestion.title).apply { margin = JBUI.insets(2, 6, 2, 6) }
        // 预选优先级：编辑条目=原目录；拖放/右键落点（defaultFolderId=用户显式意图）；根级
        val preselect = when {
            editOf != null -> folderOptions.firstOrNull { it.id == editOf.folderId }?.path ?: uncategorizedLabel
            defaultFolderId.isNotEmpty() -> folderOptions.firstOrNull { it.id == defaultFolderId }?.path ?: uncategorizedLabel
            else -> uncategorizedLabel
        }
        val items = arrayOf(uncategorizedLabel) + folderOptions.map { it.path }
        folderCombo = JComboBox(items).apply { isEditable = true; selectedItem = preselect }
        // 框线对齐靠离屏试画标定：原生 border 的 paint 带组件类型门控（rounded/search
        // 分支强转 JTextComponent、editor 分支见 parent=JComboBox 直接 return），复用到
        // JPanel/scrollpane 上会抛异常或空画→整框消失；改试画扫像素拿真实绘制偏移/色号，
        // 自绘框按偏移补偿，任何 LAF/DPI 自适应（缺陷HX）
        val comboProbe = probeBorder(folderCombo.border, folderCombo)
        val comboInsets = folderCombo.border.getBorderInsets(folderCombo)
        selectedTags.addAll(editOf?.tags ?: emptyList()) // 编辑态带出原标签；收录默认空（2026-11-23 拍板）
        refreshTagColors()
        tagChips = JPanel(FlowRow(4, 2, 360))
        // 弹窗拉伸后按真实宽度重算「+N」收纳
        tagChips.addComponentListener(object : java.awt.event.ComponentAdapter() {
            override fun componentResized(e: java.awt.event.ComponentEvent) = tagChips.rebuildChips()
        })
        tagCombo = buildTagCombo(comboProbe, comboInsets, folderCombo.preferredSize.height)
        notesArea = JBTextArea(3, 30).apply {
            text = editOf?.notes ?: ""
            lineWrap = true
            // 17+scroll 框线 1=18px：与带框线控件文字起点对齐（真机反馈起点不齐）
            border = JBUI.Borders.empty(2, 17, 2, 11)
        }
        val notesScroll = JBScrollPane(notesArea).apply { preferredSize = Dimension(420, 64) }
        // 备注保留原生 scroll 边框，外圈空边框补「combo 框线偏移 - scroll 框线偏移」差值，
        // 框线落到与目录下拉同一竖线；差值同步从文本内边距减回保持文字起点（缺陷HX）
        val notesBorder = notesScroll.border
        val notesProbe = probeBorder(notesBorder, notesScroll)
        val notesInsets = notesBorder.getBorderInsets(notesScroll)
        val dLeft = maxOf(0, (comboProbe?.left ?: comboInsets.left) - (notesProbe?.left ?: notesInsets.left))
        val dTop = maxOf(0, (comboProbe?.top ?: comboInsets.top) - (notesProbe?.top ?: notesInsets.top))
        val dRight = maxOf(0, (comboProbe?.right ?: comboInsets.right) - (notesProbe?.right ?: notesInsets.right))
        val dBottom = maxOf(0, (comboProbe?.bottom ?: comboInsets.bottom) - (notesProbe?.bottom ?: notesInsets.bottom))
        notesScroll.border = javax.swing.BorderFactory.createCompoundBorder(
            JBUI.Borders.empty(dLeft, dTop, dRight, dBottom),
            notesBorder,
        )
        notesArea.border = JBUI.Borders.empty(maxOf(0, 2 - dTop), maxOf(0, 17 - dLeft), maxOf(0, 2 - dBottom), maxOf(0, 11 - dRight))

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
                add(sourceLabel.apply {
                    text = htmlWrapped(KbFileStore.displayPath(src.toString()))
                    // 像素实测 -10：与 field 文字起点对齐
                    border = JBUI.Borders.empty(0, 8)
                }, c)
                c.weightx = 0.0
                row++
                // Git 提交行紧随源文件下方；隐藏行在 GridBag 里不占位（JDK 17 实测），非 git 文件不留空隙
                c.gridx = 0; c.gridy = row
                add(commitCaption, c)
                c.gridx = 1; c.fill = GridBagConstraints.HORIZONTAL; c.weightx = 1.0
                add(commitLabel, c)
                c.weightx = 0.0
                row++
                gitSource = runCatching { Path.of(src.toString()) }.getOrNull()
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
            add(notesScroll, c)
            c.weighty = 0.0
        }

        init()
        gitSource?.let { loadContentRow(it, editOf) }
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

    /** hex → Color；非法/缺失回退灰（与未注册同兜底） */
    private fun decodeColor(hex: String): Color =
        runCatching { Color.decode(hex) }.getOrDefault(Color(0x8A919C))

    private fun refreshTagColors() {
        tagColorHex = runCatching {
            KbManagerService.instance.tagMetas().associate { it.name to it.color }
        }.getOrDefault(emptyMap())
    }

    /**
     * 下拉框形态的多选标签行（复用目录 combo 视觉）：中央=已选 chips 流，右端=▾；
     * 点 ▾（或行内空白）弹选择菜单（既有标签色块+勾选态✓+底部「新建标签…」）。
     */
    private fun buildTagCombo(probe: BorderProbe?, comboInsets: Insets, fixedHeight: Int): JComponent {
        val arrow = JBLabel(AllIcons.General.ChevronDown).apply { border = JBUI.Borders.emptyLeft(6) }
        arrow.addMouseListener(object : java.awt.event.MouseAdapter() {
            override fun mouseClicked(e: java.awt.event.MouseEvent) = showTagChooser()
        })
        return JPanel(BorderLayout()).apply {
            // 外圈空边框=试画扫出的原生框线绘制偏移，LineBorder 才与标题/目录框线同列
            // 同色（自绘贴边界画会左右各凸出几像素）；内圈左 6 与 field 文字 margin
            // 同值，胶囊/占位文案起点对齐标题文字；试画失败回退 insets 补偿（缺陷HX）
            val outer = if (probe != null) {
                JBUI.Borders.empty(probe.left, probe.top, probe.right, probe.bottom)
            } else {
                JBUI.Borders.empty(comboInsets)
            }
            val lineColor = probe?.color ?: JBColor.border()
            border = javax.swing.BorderFactory.createCompoundBorder(
                outer,
                javax.swing.BorderFactory.createCompoundBorder(
                    javax.swing.BorderFactory.createLineBorder(lineColor),
                    JBUI.Borders.empty(1, 6, 1, 6),
                ),
            )
            add(tagChips, BorderLayout.CENTER)
            add(arrow, BorderLayout.EAST)
            addMouseListener(object : java.awt.event.MouseAdapter() {
                override fun mouseClicked(e: java.awt.event.MouseEvent) = showTagChooser()
            })
            // 行高锁定=目录 combo preferred 高：选/未选同高，chips 不再撑行挤备注出滚动条（缺陷HX）
            preferredSize = Dimension(preferredSize.width, fixedHeight)
            minimumSize = Dimension(0, fixedHeight)
            maximumSize = Dimension(Int.MAX_VALUE, fixedHeight)
        }
    }

    /**
     * 重渲染已选 chips（增删后调用；▾ 在外层不受影响）；空选集显示灰色占位避免下拉框塌陷。
     * 单行排布：超可用宽收「+N」胶囊（点击弹选择菜单），行高恒定（缺陷HX）。
     */
    private fun JPanel.rebuildChips() {
        removeAll()
        if (selectedTags.isEmpty()) {
            add(JBLabel(ZCodeBundle.message("kb.dialog.tagsHint")).apply {
                foreground = com.intellij.util.ui.UIUtil.getContextHelpForeground()
            })
        } else {
            val chips = selectedTags.map { ChipLabel(it, decodeColor(colorOf(it))) }
            val gap = 4 // 与 FlowRow hgap 一致
            val widths = chips.map { it.preferredSize.width + gap }
            val avail = width.takeIf { it > 0 } ?: 360
            val overflowW = 40 // 「+N」胶囊预留宽
            val budget = if (widths.sum() <= avail) avail else avail - overflowW
            var used = 0
            var shown = 0
            for (i in chips.indices) {
                if (shown > 0 && used + widths[i] > budget) break
                add(chips[i])
                used += widths[i]
                shown++
            }
            if (shown < chips.size) {
                add(ChipLabel("+${chips.size - shown}", decodeColor(KbFileStore.TAG_PALETTE.last()), removable = false))
            }
        }
        revalidate()
        repaint()
    }

    /** 长路径只读展示：HTML 限宽 400px 自动换行（撑不爆弹窗，转义防注入标签） */
    private fun htmlWrapped(path: String): String {
        val esc = path.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        return "<html><body style='width:400px'>$esc</body></html>"
    }

    /**
     * 后台填源文件下方那一行：源文件在 = 它自己的提交状态（不在 git 仓内或查询失败 = 行保持
     * 隐藏）；源文件不在 = 文档快照的信息（没有快照则明示没有内容），源文件行同步标注。
     * 回填须 ModalityState.any()——默认 modality 的 invokeLater 在模态弹窗开着时不执行，
     * 不加的话行要等弹窗关了才冒出来。
     */
    private fun loadContentRow(file: Path, entry: KbEntry?) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val service = KbManagerService.instance
            val resolved = entry?.let { runCatching { service.resolve(it) }.getOrNull() }
            val history = if (resolved == null || resolved.state == KbContent.State.SOURCE) {
                service.fileHistory(file, project)
            } else {
                null
            }
            ApplicationManager.getApplication().invokeLater({
                if (isDisposed) return@invokeLater
                val state = resolved?.state
                if (state == KbContent.State.SNAPSHOT || state == KbContent.State.MISSING) {
                    sourceLabel.text = htmlWrapped(KbFileStore.displayPath(file.toString())) +
                        " <span style='color:${noteColor()}'>" +
                        escapeHtml(ZCodeBundle.message("kb.dialog.sourceMissingNote")) + "</span>"
                }
                val text = when {
                    history != null -> commitHtml(history)
                    state == KbContent.State.SNAPSHOT -> snapshotHtml(resolved!!.path)
                    state == KbContent.State.MISSING -> "<html><body style='width:400px'>" +
                        gray(escapeHtml(ZCodeBundle.message("kb.dialog.noContent"))) + "</body></html>"
                    else -> return@invokeLater // 非 git 文件：这一行不显示
                }
                commitCaption.text = if (history != null) ZCodeBundle.message("kb.dialog.commitLabel")
                else ZCodeBundle.message("kb.dialog.snapshotLabel")
                commitLabel.text = text
                commitCaption.isVisible = true
                commitLabel.isVisible = true
                centerPanel.revalidate()
                pack() // 弹窗已按「无此行」定好尺寸：按新内容重排（左上角不动，向下长高）
            }, ModalityState.any())
        }
    }

    /** 文档快照行 HTML：存档副本的大小 + 「源文件在本机不存在」的说明 */
    private fun snapshotHtml(snapshot: java.nio.file.Path?): String {
        val size = snapshot?.let { runCatching { Files.size(it) }.getOrDefault(0L) } ?: 0L
        val body = escapeHtml(humanBytes(size)) + "  " +
            gray(escapeHtml(ZCodeBundle.message("kb.dialog.snapshotInfo")))
        return "<html><body style='width:400px'>$body</body></html>"
    }

    private fun humanBytes(n: Long): String = when {
        n >= 1024L * 1024 * 1024 -> "%.1f GB".format(n / 1024.0 / 1024 / 1024)
        n >= 1024L * 1024 -> "%.1f MB".format(n / 1024.0 / 1024)
        n >= 1024L -> "%.1f KB".format(n / 1024.0)
        else -> "$n B"
    }

    /** 提交行 HTML：`a1b2c3d  2026-11-20  标题`，日期与各种标注用灰字 */
    private fun commitHtml(h: KbGitCli.FileHistory): String {
        val body = when {
            h.commit == null && h.ignored -> gray(ZCodeBundle.message("kb.dialog.commit.ignored"))
            h.commit == null -> gray(ZCodeBundle.message("kb.dialog.commit.uncommitted"))
            else -> {
                val c = h.commit!!
                val subject = c.subject.let { if (it.length > COMMIT_SUBJECT_MAX) it.take(COMMIT_SUBJECT_MAX - 1) + "…" else it }
                escapeHtml(c.hash) + "  " + gray(escapeHtml(c.date)) + "  " + escapeHtml(subject) +
                    (if (h.dirty) "  " + gray(ZCodeBundle.message("kb.dialog.commit.dirty")) else "")
            }
        }
        return "<html><body style='width:400px'>$body</body></html>"
    }

    /** 次要信息灰（跟随主题深浅，与树行的路径灰同色系） */
    private fun noteColor(): String = if (UIUtil.isUnderDarcula()) "#8a8f98" else "#6c707e"

    private fun gray(html: String): String = "<span style='color:${noteColor()}'>$html</span>"

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
                    icon = ColorIcon(decodeColor(colorOf(value)))
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

    /**
     * 已选标签胶囊（正常尺寸）：标签色圆角底+黑/白字，尾部「✕」点击移除；
     * removable=false 为「+N」溢出胶囊，整块点击弹选择菜单。
     */
    private inner class ChipLabel(
        private val tag: String,
        private val bg: Color,
        private val removable: Boolean = true,
    ) : JBLabel(if (removable) "$tag ✕" else tag) {
        init {
            font = JBUI.Fonts.label(11f)
            border = JBUI.Borders.empty(2, 6) // 上下 2px：CJK 字形超出 fontMetrics preferred 时不贴边被裁
            foreground = if (luminance(bg) > 0.55) Color(0x1E1E1E) else Color.WHITE
            isOpaque = false
            addMouseListener(object : java.awt.event.MouseAdapter() {
                override fun mouseClicked(e: java.awt.event.MouseEvent) {
                    if (!removable) {
                        showTagChooser()
                    } else if (e.x > width - 16) { // 命中尾部 ✕ 区
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

    companion object {
        /** 提交标题行展示上限（字符）：超长截断防把弹窗撑高 */
        private const val COMMIT_SUBJECT_MAX = 200
    }
}

private fun escapeHtml(s: String): String =
    s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

/** 原生框线真实绘制偏移（距组件边界四边距离）+ 框线色号 */
private data class BorderProbe(val left: Int, val top: Int, val right: Int, val bottom: Int, val color: Color)

/**
 * 离屏试画标定：拿真实组件把原生 border 画到透明画布一次，四边扫首个不透明像素得
 * 框线真实绘制偏移并取该点色号。原生 border 的 paint 带组件类型门控不能复用到自绘
 * 控件上，但试画传组件本身、与活体绘制同行为；跨 LAF/DPI 不用猜像素。失败返 null
 * （调用方回退 insets 补偿）。
 */
private fun probeBorder(border: javax.swing.border.Border, comp: JComponent): BorderProbe? = runCatching {
    val size = 64
    val img = java.awt.image.BufferedImage(size, size, java.awt.image.BufferedImage.TYPE_INT_ARGB)
    val g = img.createGraphics()
    try {
        border.paintBorder(comp, g, 0, 0, size, size)
    } finally {
        g.dispose()
    }
    fun opaque(x: Int, y: Int): Boolean = (img.getRGB(x, y) ushr 24) > 128
    val mid = size / 2
    val left = (0 until mid).firstOrNull { opaque(it, mid) } ?: return null
    val right = (size - 1 downTo mid).firstOrNull { opaque(it, mid) } ?: return null
    val top = (0 until mid).firstOrNull { opaque(mid, it) } ?: return null
    val bottom = (size - 1 downTo mid).firstOrNull { opaque(mid, it) } ?: return null
    BorderProbe(left, top, size - 1 - right, size - 1 - bottom, Color(img.getRGB(left, mid) and 0xFFFFFF))
}.getOrNull()

/**
 * 单行 FlowLayout：preferred 宽封顶 wrapWidth（原生 FlowLayout 的 preferred 是单行总宽，
 * 标签多时会撑爆弹窗宽度）；高=单行行高。超宽 chips 由 rebuildChips 收「+N」，
 * 保证实际布局不出现第二行（外层行高锁定，第二行会被裁）。
 */
private class FlowRow(hgap: Int, vgap: Int, private val wrapWidth: Int) : FlowLayout(FlowLayout.LEFT, hgap, vgap) {
    override fun preferredLayoutSize(target: java.awt.Container): Dimension {
        synchronized(target.treeLock) {
            var w = 0
            var rowH = 0
            for (i in 0 until target.componentCount) {
                val d = target.getComponent(i).preferredSize
                if (w > 0) w += hgap
                w += d.width
                rowH = maxOf(rowH, d.height)
            }
            val ins = target.insets
            return Dimension(minOf(w, wrapWidth) + ins.left + ins.right, rowH + ins.top + ins.bottom)
        }
    }
}
