package com.zcode.ideaplugin.kb

import com.intellij.icons.AllIcons
import com.intellij.ide.browsers.actions.WebPreviewVirtualFile
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.ActionToolbar
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.actionSystem.Toggleable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptor
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.ui.ColoredTreeCellRenderer
import com.intellij.ui.JBColor
import com.intellij.ui.SearchTextField
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.awt.RelativePoint
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.treeStructure.Tree
import com.intellij.util.Urls
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import com.zcode.ideaplugin.ZCodeBundle
import com.zcode.ideaplugin.ZCodeIcons
import com.zcode.ideaplugin.action.pushRefs
import com.zcode.kb.core.KbEntry
import com.zcode.kb.core.KbExtractor
import com.zcode.kb.core.KbFileStore
import com.zcode.kb.core.KbFilter
import com.zcode.kb.core.KbFolder
import com.zcode.kb.core.KbHit
import com.zcode.kb.text.KbTokenizer
import java.awt.BorderLayout
import java.awt.FlowLayout
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.RenderingHints
import java.awt.datatransfer.DataFlavor
import java.awt.datatransfer.Transferable
import java.awt.datatransfer.UnsupportedFlavorException
import java.awt.dnd.DnDConstants
import java.awt.dnd.DropTarget
import java.awt.dnd.DropTargetAdapter
import java.awt.dnd.DropTargetDragEvent
import java.awt.dnd.DropTargetDropEvent
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.util.Collections
import javax.swing.BoxLayout
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.SwingUtilities
import javax.swing.event.TreeExpansionEvent
import javax.swing.event.TreeExpansionListener
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeModel
import javax.swing.tree.TreePath
import javax.swing.tree.TreeSelectionModel
import javax.swing.tree.TreeNode

/**
 * 知识库 ToolWindow 面板（Swing，2026-11-21 目录树改版）——**用户自建目录树 + 条目
 * 标签 chip**（模块/项目分组层退役：目录完全用户自建、层级不限、空目录也上树；条目
 * 可放根级=垫底「根级」；git 项目维度降级为条目 tooltip）。打开行为不变：IDE 可
 * 编辑格式走 IDE 编辑器，html 内置预览，其余交 IDE 自选编辑器。
 *
 *   ┌───────────────────────────────┐
 *   │ [🔍 搜索……]      [⊕收录 ⟳ ⟲] │  顶行（模块/项目过滤行已废）
 *   │ ▾ 📁 信创适配            3    │
 *   │   ▾ 📁 中间件            2    │  树：用户目录（递归） → 条目
 *   │     · 📄 Redis 部署 ⟨部署⟩…   │  条目行 = 标题 + 标签 chip（最多 2 个 + 省略号）
 *   │ · 📄 未归组条目               │  根级直放条目 = 根级（垫底）
 *   └───────────────────────────────┘
 *
 * 树行为：搜索有词时退化为平铺命中列表（命中标签 chip 提前第一位并金黄高亮）；
 * 展开态/选中态跨刷新记忆（key 字符串对齐）；目录管理/条目动作全在右键。
 * 拖拽：条目（支持多选）拖入目录=移入、拖到根=根级；目录拖到目录=成为子目录
 * （防环：拒绝拖入自身子孙，canImport 拒绝 + 数据层二次校验）；精细同层排序一期不做
 * （目录 order 字段已留）。「发送到 ZC GUI 输入框」= 条目右键第一组（品牌图标置顶）。
 *
 * 刷新：订阅 KB_CHANGED 广播（KbManagerService 变更点收口发布）。
 * 线程纪律：store 查询/提取一律 pooled 线程，EDT 只回填 UI。
 */
class KnowledgeToolWindowPanel(private val project: Project) : JPanel(BorderLayout()), Disposable {

    private val log = Logger.getInstance(KnowledgeToolWindowPanel::class.java)

    // ── 搜索状态（EDT 读写，refresh 时快照给后台线程） ──
    private var searchText: String = ""
    /** 标签过滤态（工具条漏斗入口）：多选勾选集（空=未过滤）+ 组合模式（true=AND 全部包含 / false=OR 任一包含）；搜索词优先于它 */
    private var filterTags: LinkedHashSet<String> = LinkedHashSet()
    private var filterMatchAll: Boolean = false

    private val searchField = SearchTextField(false)

    // ── 树（用户目录递归 → 条目；搜索词非空退化为平铺） ──
    private val treeModel = DefaultTreeModel(DefaultMutableTreeNode("root"))
    private val tree = Tree(treeModel)
    private val expandedKeys = HashSet<String>()

    // ── 数据缓存（rebuild 后常驻，canImport 防环 / 删除确认计数 / chip 颜色用） ──
    private var foldersCache: List<KbFolder> = emptyList()
    private var entriesCache: List<KbEntry> = emptyList()
    private var tagColorMap: Map<String, String> = emptyMap() // 标签名 → 颜色 hex（注册表）

    // ── 搜索态上下文（仿记忆搜索：命中条目两行渲染=标题+处数 / 片段关键词高亮） ──
    private var searchHits: Map<String, KbHit> = emptyMap()
    private var searchTokens: List<String> = emptyList()

    private lateinit var toolbar: ActionToolbar

    /** 刷新在飞标志；期间到来的刷新请求记 [pendingRefresh]，回填后立即重跑（不吞查询） */
    private val refreshing = java.util.concurrent.atomic.AtomicBoolean(false)
    private val pendingRefresh = java.util.concurrent.atomic.AtomicBoolean(false)

    /**
     * 搜索防抖（300ms）：SearchTextField 每个 keystroke 都触发 DocumentListener，
     * 不防抖时输入中途的旧查询（如 "s"）会在后台晚完成并覆盖最终查询（"saa"）的
     * 回填——真机实证「两次输入结果不一样」「实际只搜了第一个字」即此竞态。
     */
    private val searchDebounce = javax.swing.Timer(300) { refreshAsync() }.apply { isRepeats = false }

    init {
        border = JBUI.Borders.empty(6)

        searchField.textEditor.emptyText.text = ZCodeBundle.message("kb.tw.searchHint")
        searchField.addDocumentListener(object : javax.swing.event.DocumentListener {
            override fun insertUpdate(e: javax.swing.event.DocumentEvent) = onSearchChanged()
            override fun removeUpdate(e: javax.swing.event.DocumentEvent) = onSearchChanged()
            override fun changedUpdate(e: javax.swing.event.DocumentEvent) = onSearchChanged()
        })

        // 树基础形态：原生外观 + 空态提示 + 多选
        tree.isRootVisible = false
        tree.showsRootHandles = true
        tree.rowHeight = 0
        tree.selectionModel.selectionMode = TreeSelectionModel.DISCONTIGUOUS_TREE_SELECTION
        tree.emptyText.text = ZCodeBundle.message("kb.tw.emptyHint")
        tree.cellRenderer = renderer()
        // 拖拽移动（条目多选移入目录 / 目录拖为子目录）：JTree 原生 DnD + 自定义 TransferHandler
        tree.dragEnabled = true
        tree.transferHandler = KbTransferHandler()

        tree.addTreeExpansionListener(object : TreeExpansionListener {
            override fun treeExpanded(e: TreeExpansionEvent) = trackExpansion(e.path, true)
            override fun treeCollapsed(e: TreeExpansionEvent) = trackExpansion(e.path, false)
        })
        // 多选快照：JDK BasicTreeUI 对右键 pressed 无条件重置为落点单选（真机实证：Ctrl 多选
        // 后一点右键就丢），快照在 size>1 时持续更新，右键点在集合内即恢复、点在集合外清除
        var multiSelectionSnapshot: Array<TreePath>? = null
        tree.selectionModel.addTreeSelectionListener { _ ->
            val paths = tree.selectionModel.selectionPaths ?: return@addTreeSelectionListener
            if (paths.size > 1) multiSelectionSnapshot = paths
        }
        tree.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (SwingUtilities.isLeftMouseButton(e) && e.clickCount == 2) {
                    (nodeAt(e)?.userObject as? NodeData.Entry)?.let { openEntry(it.entry) }
                }
            }

            override fun mousePressed(e: MouseEvent) {
                // 左键=显式重选意图：旧多选快照作废（真机 bug：多选→右键不操作→单选→右键仍弹多选菜单）
                if (SwingUtilities.isLeftMouseButton(e)) multiSelectionSnapshot = null
                restoreMultiSelection(e)
                maybeShowPopup(e)
            }
            override fun mouseReleased(e: MouseEvent) {
                if (SwingUtilities.isLeftMouseButton(e)) multiSelectionSnapshot = null
                restoreMultiSelection(e)
                maybeShowPopup(e)
            }

            private fun restoreMultiSelection(e: MouseEvent) {
                if (!SwingUtilities.isRightMouseButton(e)) return
                val snap = multiSelectionSnapshot ?: return
                if (snap.size < 2) return
                val path = tree.getPathForLocation(e.x, e.y) ?: return
                if (snap.contains(path)) {
                    tree.selectionPaths = snap
                } else {
                    multiSelectionSnapshot = null // 点在集合外：改选语义，清除快照
                }
            }

            private fun maybeShowPopup(e: MouseEvent) {
                if (!e.isPopupTrigger) return
                val node = nodeAt(e)
                // 右键落点即选中（树默认只认左键选中）；但落点已在选择集合（含多选恢复后）不重置
                if (node != null) {
                    val path = TreePath(node.path)
                    if (tree.selectionPaths?.contains(path) != true) tree.selectionPath = path
                }
                showContextMenu(node, e)
            }
        })

        // 顶行工具条：⊕ 收录 + ⟳ 刷新 + 标签管理（用户拍板从空白右键挪顶上）+ 库级重建索引
        val group = DefaultActionGroup().apply {
            add(action(ZCodeBundle.message("kb.action.add.text"), AllIcons.General.Add) { ingestFromChooser() })
            add(action(ZCodeBundle.message("kb.tw.btn.refresh"), AllIcons.Actions.Refresh) { refreshAsync() })
            add(object : AnAction(
                ZCodeBundle.message("kb.tw.filterByTag"),
                ZCodeBundle.message("kb.tw.filterByTag"),
                AllIcons.General.Filter,
            ) {
                override fun update(e: AnActionEvent) {
                    // 过滤态高亮（Toggleable 按压背景），标签变动后工具条重绘由 update 周期刷新
                    Toggleable.setSelected(e.presentation, filterTags.isNotEmpty())
                }

                override fun actionPerformed(e: AnActionEvent) {
                    // CONTEXT_COMPONENT 拿到的是整个面板（真机：弹层跑到面板左下角），锚点用点击源=按钮本身
                    showTagFilterPopup(e.inputEvent?.source as? java.awt.Component)
                }
            })
            add(action(ZCodeBundle.message("kb.tw.tags.manage"), AllIcons.Nodes.Tag) { KbDialogs.show(KbTagsDialog()) })
            // 重建索引已挪设置页（2026-11-22：库级数据动作与快照位置设置同区，工具窗只留日常操作）
        }
        toolbar = com.intellij.openapi.actionSystem.ActionManager.getInstance()
            .createActionToolbar("ZCode.KnowledgeToolbar", group, true).apply {
                targetComponent = this@KnowledgeToolWindowPanel
            }

        val topRow = JPanel(BorderLayout()).apply {
            border = JBUI.Borders.emptyBottom(4)
            add(searchField, BorderLayout.CENTER)
            add(toolbar.component, BorderLayout.EAST)
        }
        add(topRow, BorderLayout.NORTH)
        add(JBScrollPane(tree), BorderLayout.CENTER)

        registerFileDropTarget()
        // 数据变更跟随（收录/摘除/sweep 由 service 侧收口发布）
        project.messageBus.connect(this).subscribe(KbTopics.KB_CHANGED, object : KbChangedListener {
            override fun kbChanged() = refreshAsync()
        })
        // 兜底：面板每次显示都刷（MCP 写盘的 watcher 广播若被竞态吞掉，切回面板也能看到最新）
        addComponentListener(object : java.awt.event.ComponentAdapter() {
            override fun componentShown(e: java.awt.event.ComponentEvent) = refreshAsync()
        })
        refreshAsync()
    }

    private fun onSearchChanged() {
        val newQ = searchField.text.trim()
        if (newQ != searchText) {
            searchText = newQ
            searchDebounce.restart() // 防抖：停手 300ms 才查（期间更新缓存 searchText 供最终查询取最新值）
        }
    }

    /** 菜单/工具条 action 工厂：无条件启用（目录管理项落在目录节点上，树选中态不适用） */
    private fun action(text: String, icon: javax.swing.Icon, run: () -> Unit): AnAction =
        object : AnAction(text, text, icon) {
            override fun actionPerformed(e: AnActionEvent) = run()
        }

    /** 右键菜单专用：动作锁定捕获的条目，不依赖树选中态 */
    /** gate 非空 = 按条目状态门控可见性（update 在 ActionPopupMenu 弹出时调用） */
    private fun entryAction(text: String, icon: javax.swing.Icon, entry: KbEntry, gate: ((KbEntry) -> Boolean)? = null, run: (KbEntry) -> Unit): AnAction =
        object : AnAction(text, text, icon) {
            override fun update(e: AnActionEvent) {
                if (gate != null) e.presentation.isVisible = gate(entry)
            }

            override fun actionPerformed(e: AnActionEvent) = run(entry)
        }

    private fun selected(): KbEntry? =
        ((tree.lastSelectedPathComponent as? DefaultMutableTreeNode)?.userObject as? NodeData.Entry)?.entry

    /** 选中路径里的全部条目（多选摘除/批量发送用；单选场景 size=1） */
    private fun selectedEntries(): List<KbEntry> =
        tree.selectionPaths
            ?.mapNotNull { (it.lastPathComponent as? DefaultMutableTreeNode)?.userObject as? NodeData.Entry }
            ?.map { it.entry }
            .orEmpty()

    // ───────────────────────── 数据加载 ─────────────────────────

    /** 全量刷新（条目/目录/标签），后台读取 EDT 回填；在飞期间的新请求记 pending，回填后重跑。
     *  pending 用 AtomicBoolean getAndSet 消费：布尔版存在「EDT 读 pending 与 watcher 设
     *  pending 交错悬挂」的吞刷新窗口（MCP 变更后面板不自刷的根因），CAS 穷尽交错无丢失 */
    fun refreshAsync() {
        if (!refreshing.compareAndSet(false, true)) {
            pendingRefresh.set(true)
            return
        }
        val q = searchText
        val tags = filterTags.toSet() // 快照给后台线程（EDT 侧弹层勾选可变）
        val matchAll = filterMatchAll
        ApplicationManager.getApplication().executeOnPooledThread {
            val service = KbManagerService.instance
            val folders = runCatching { service.folders() }.getOrDefault(emptyList())
            val tagMetas = runCatching { service.tagMetas() }.getOrDefault(emptyList())
            val entries: List<KbEntry>
            val hits: List<KbHit>
            when {
                q.isNotEmpty() -> { // 搜索词优先于标签过滤态
                    hits = runCatching { service.search(q, KbFilter()) }.getOrDefault(emptyList())
                    entries = hits.map { it.entry }
                }
                tags.isNotEmpty() -> { // 标签过滤（下沉 core 同 KbFilter 语义：AND 全含 / OR 任一）
                    entries = runCatching { service.list(KbFilter(tags = tags, tagMatchAll = matchAll)) }
                        .getOrDefault(emptyList())
                    hits = emptyList()
                }
                else -> {
                    entries = runCatching { service.list(KbFilter()) }.getOrDefault(emptyList())
                    hits = emptyList()
                }
            }
            ApplicationManager.getApplication().invokeLater {
                foldersCache = folders
                entriesCache = entries
                tagColorMap = tagMetas.associate { it.name to it.color }
                if (q.isNotEmpty()) {
                    searchTokens = KbTokenizer.tokens(q)
                    searchHits = hits.associateBy { it.entry.id }
                } else {
                    searchTokens = emptyList()
                    searchHits = emptyMap()
                }
                // 标签过滤态走正常目录树（entries 已是过滤子集）——层级保留只筛条目（真机反馈：平铺丢层级）
                rebuildTree(entries, folders, searching = q.isNotEmpty())
                refreshing.set(false)
                if (pendingRefresh.getAndSet(false)) {
                    refreshAsync()
                }
            }
        }
    }

    /**
     * 工具条漏斗弹层：多选标签过滤（色块+计数灰字+勾选✓；点击切换勾选，弹层不关、
     * 每次变化即时生效走 refreshAsync；组合模式一行横排置标签行之前，切换即刷新）。
     * 清除项常驻置顶（无勾选置灰；一键清空勾选，不清组合模式记忆）。
     * popupChooserBuilder 是单选体系（选即关），多选需持久弹层 → 自建组件弹层。
     */
    private fun showTagFilterPopup(anchor: java.awt.Component?) {
        val counts = runCatching { KbManagerService.instance.tagCounts() }.getOrDefault(emptyMap())
        if (counts.isEmpty()) return // 无标签无从过滤（入口=「管理标签」弹窗创建）
        val names = counts.keys.sorted()
        val listPanel = JPanel().apply { layout = BoxLayout(this, javax.swing.BoxLayout.Y_AXIS) }
        val rowByName = LinkedHashMap<String, JLabel>()

        fun refreshRow(name: String) {
            val row = rowByName.getValue(name)
            val mark = if (name in filterTags) "✓ " else ""
            row.text = "<html>$mark$name <span style='color:${metaColor()}'>(${counts[name] ?: 0})</span></html>"
            row.icon = ColorIcon(
                runCatching { java.awt.Color.decode(tagColorMap[name] ?: "#8A919C") }
                    .getOrDefault(java.awt.Color(0x8A919C)),
            )
        }

        // 清除项常驻置顶（真机反馈：仅初始化有勾选才渲染→弹层内勾选后无从取消）；
        // 无勾选置灰、勾选后点亮，一键清空勾选、不清组合模式记忆
        val clear = JLabel(ZCodeBundle.message("kb.tw.filterClear")).apply {
            icon = AllIcons.Actions.Undo
            border = JBUI.Borders.empty(2, 8)
            // BoxLayout 纵排默认居中（JLabel alignmentX=CENTER），弹层有宽度下限后会整体居中漂移，显式左对齐
            alignmentX = java.awt.Component.LEFT_ALIGNMENT
        }
        fun refreshClear() {
            val active = filterTags.isNotEmpty()
            clear.isEnabled = active
            clear.foreground = if (active) com.intellij.util.ui.UIUtil.getLabelForeground()
            else com.intellij.util.ui.UIUtil.getContextHelpForeground()
        }
        clear.addMouseListener(object : java.awt.event.MouseAdapter() {
            override fun mouseClicked(e: java.awt.event.MouseEvent) {
                if (filterTags.isEmpty()) return
                filterTags.clear()
                names.forEach(::refreshRow)
                refreshClear()
                refreshAsync()
            }
        })
        refreshClear()
        listPanel.add(clear)

        // 组合模式一行横排、置标签行之前（真机反馈：竖排两行不必要、别放最后）；hgap=0+按钮左内距 8，
        // 单选图标起点与清除项/标签行色块同列（对齐后再加间距会错位，间距放进按钮右内距）
        val modePanel = JPanel(java.awt.FlowLayout(java.awt.FlowLayout.LEFT, 0, 0)).apply {
            alignmentX = java.awt.Component.LEFT_ALIGNMENT
        }
        val anyBtn = javax.swing.JRadioButton(ZCodeBundle.message("kb.tw.filterMatchAny"))
        val allBtn = javax.swing.JRadioButton(ZCodeBundle.message("kb.tw.filterMatchAll"))
        javax.swing.ButtonGroup().apply { add(anyBtn); add(allBtn) }
        (if (filterMatchAll) allBtn else anyBtn).isSelected = true
        for (btn in listOf(anyBtn, allBtn)) {
            btn.border = JBUI.Borders.empty(1, 8)
            btn.addActionListener {
                val want = btn === allBtn
                if (filterMatchAll != want) {
                    filterMatchAll = want
                    refreshAsync()
                }
            }
            modePanel.add(btn)
        }
        modePanel.border = javax.swing.BorderFactory.createCompoundBorder(
            javax.swing.BorderFactory.createMatteBorder(0, 0, 1, 0, com.intellij.ui.JBColor.border()),
            javax.swing.BorderFactory.createEmptyBorder(2, 0, 2, 0),
        )
        listPanel.add(modePanel)

        for (name in names) {
            val row = JLabel().apply {
                border = JBUI.Borders.empty(2, 8)
                alignmentX = java.awt.Component.LEFT_ALIGNMENT
            }
            rowByName[name] = row
            refreshRow(name)
            row.addMouseListener(object : java.awt.event.MouseAdapter() {
                override fun mouseClicked(e: java.awt.event.MouseEvent) {
                    if (name in filterTags) filterTags.remove(name) else filterTags.add(name)
                    refreshRow(name)
                    refreshClear()
                    refreshAsync()
                }
            })
            listPanel.add(row)
        }

        val panel = JPanel(java.awt.BorderLayout())
        panel.add(listPanel, java.awt.BorderLayout.CENTER)
        // 宽度下限：组合行竖排后内容宽缩水、弹层显挤（真机反馈太窄）；长标签名仍自动撑宽
        val pref = panel.preferredSize
        panel.preferredSize = java.awt.Dimension(maxOf(pref.width, JBUI.scale(190)), pref.height)
        val host = anchor ?: this
        JBPopupFactory.getInstance()
            .createComponentPopupBuilder(panel, listPanel)
            .setRequestFocus(true)
            .setCancelOnClickOutside(true)
            .createPopup()
            .show(RelativePoint(host, java.awt.Point(0, host.height + 2)))
    }

    // ───────────────────────── 树构建 ─────────────────────────

    /** 树节点用户对象；key 是稳定字符串，供展开/选中态跨重建（新对象）恢复 */
    private sealed class NodeData {
        abstract val key: String

        class Folder(val folder: KbFolder, val count: Int) : NodeData() {
            override val key = "F\u0001${folder.id}"
        }

        class Entry(val entry: KbEntry) : NodeData() {
            override val key = "E\u0001${entry.id}"
        }
    }

    /**
     * 全量重建：用户目录树（层级不限，空目录也上树）→ 条目挂 folderId；根级/断链
     * 条目垫底（根级）；搜索词非空退化为根下平铺命中条目。
     */
    private fun rebuildTree(entries: List<KbEntry>, folders: List<KbFolder>, searching: Boolean) {
        val selectedId = selected()?.id
        val root = DefaultMutableTreeNode("root")
        if (searching) {
            entries.forEach { root.add(DefaultMutableTreeNode(NodeData.Entry(it))) }
        } else {
            // 目录递归计数 = 子树条目合计（含子目录内）
            val directCount = entries.groupingBy { it.folderId }.eachCount()
            val subtreeCount = HashMap<String, Int>()
            val childrenOf = folders.groupBy { it.parentId ?: "" }
            val entriesByFolder = entries.groupBy { it.folderId } // 条目挂目录节点（拖拽/移动的展示主体）
            fun countWith(folderId: String): Int {
                if (subtreeCount.containsKey(folderId)) return subtreeCount[folderId]!!
                var n = directCount[folderId] ?: 0
                for (c in childrenOf[folderId].orEmpty()) n += countWith(c.id)
                subtreeCount[folderId] = n
                return n
            }
            fun build(parentNode: DefaultMutableTreeNode, parentKey: String) {
                for (f in (childrenOf[parentKey].orEmpty()).sortedWith(compareBy({ it.order }, { it.name }))) {
                    val n = DefaultMutableTreeNode(NodeData.Folder(f, countWith(f.id)))
                    parentNode.add(n)
                    build(n, f.id)
                    // 条目挂到目录节点下（ingestedAt 倒序=entries 现序；漏挂则目录无子节点永远无法展开）
                    for (e in entriesByFolder[f.id].orEmpty()) {
                        n.add(DefaultMutableTreeNode(NodeData.Entry(e)))
                    }
                }
            }
            build(root, "")
            // 根级垫底：根级直放条目 + folderId 指向不存在目录的断链条目（容错归根级）
            for (e in entries) {
                if (!foldersCache.any { it.id == e.folderId }) {
                    root.add(DefaultMutableTreeNode(NodeData.Entry(e)))
                }
            }
        }
        treeModel.setRoot(root)
        treeModel.reload()
        restoreExpansion(root)
        restoreSelection(root, selectedId)
        // 空态分流：搜索无命中≠空库（缺陷HV真机误导：搜不到时显示「暂无条目」让用户以为条目丢了）
        tree.emptyText.text = if (searching && root.childCount == 0) {
            ZCodeBundle.message("kb.tw.searchNoHit")
        } else {
            ZCodeBundle.message("kb.tw.emptyHint")
        }
    }

    /** 展开态恢复：按 key 对齐；首次加载（无记忆）展开全部目录层 */
    private fun restoreExpansion(root: DefaultMutableTreeNode) {
        val firstLoad = expandedKeys.isEmpty()
        val e = root.depthFirstEnumeration()
        while (e.hasMoreElements()) {
            val n = e.nextElement() as DefaultMutableTreeNode
            val d = n.userObject as? NodeData ?: continue
            if (d is NodeData.Folder && (firstLoad || expandedKeys.contains(d.key))) {
                tree.expandPath(TreePath(n.path))
            }
        }
    }

    /** 选中态恢复：原选中条目还在树上就保持 */
    private fun restoreSelection(root: DefaultMutableTreeNode, selectedId: String?) {
        if (selectedId == null) return
        val target = Collections.list<TreeNode>(root.depthFirstEnumeration())
            .map { it as DefaultMutableTreeNode }
            .firstOrNull { (it.userObject as? NodeData.Entry)?.entry?.id == selectedId }
            ?: return
        tree.selectionPath = TreePath(target.path)
    }

    private fun trackExpansion(path: TreePath, expanded: Boolean) {
        val d = (path.lastPathComponent as? DefaultMutableTreeNode)?.userObject as? NodeData ?: return
        if (expanded) expandedKeys.add(d.key) else expandedKeys.remove(d.key)
    }

    private fun nodeAt(e: MouseEvent): DefaultMutableTreeNode? {
        val path = tree.getClosestPathForLocation(e.x, e.y) ?: return null
        val row = tree.getRowForPath(path)
        val bounds = tree.getRowBounds(row) ?: return null
        if (e.y < bounds.minY || e.y > bounds.maxY) return null
        return path.lastPathComponent as? DefaultMutableTreeNode
    }

    // ───────────────────────── 右键菜单 ─────────────────────────

    /**
     * 菜单按落点节点类型分派：条目=发送置顶+动作全集；目录=目录管理；空白=新建。
     * 「发送到 ZC GUI 输入框」品牌图标置顶（用户拍板：与编辑器右键同视觉位）。
     */
    private fun showContextMenu(node: DefaultMutableTreeNode?, e: MouseEvent) {
        val group = DefaultActionGroup()
        when (val d = node?.userObject as? NodeData) {
            is NodeData.Entry -> {
                val entries = selectedEntries()
                if (entries.size > 1) {
                    group.add(sendToInputAction(ZCodeBundle.message("kb.tw.sendBatch", entries.size), entries))
                    group.add(tagsSubmenu(entries)) // 批量加/移标签（真机反馈：多选批量为文档加标签）
                    group.addSeparator()
                    group.add(entryAction(
                        ZCodeBundle.message("kb.tw.removeBatch", entries.size),
                        AllIcons.Actions.GC,
                        entries.last(),
                    ) { removeEntriesBatch(entries) })
                } else {
                    val entry = d.entry
                    group.add(sendToInputAction(ZCodeBundle.message("action.sendFileToInput.text"), listOf(entry)))
                    group.addSeparator()
                    group.add(tagsSubmenu(listOf(entry))) // 勾选式标签子菜单
                    group.add(entryAction(ZCodeBundle.message("kb.tw.btn.edit"), AllIcons.Actions.Edit, entry) { editEntry(it) })
                    group.add(entryAction(ZCodeBundle.message("kb.tw.btn.move"), AllIcons.Actions.MoveToTopRight, entry) { moveEntryTo(it) })
                    group.add(entryAction(ZCodeBundle.message("kb.tw.btn.relink"), AllIcons.Actions.Replace, entry) { relinkEntry(it) })
                    // 「打开」与双击行重复（2026-11-23 反馈），菜单位让给资源管理器定位，排在重新指定路径后
                    group.add(entryAction(ZCodeBundle.message("kb.tw.btn.reveal"), AllIcons.Nodes.Folder, entry) { revealEntry(it) })
                    // 仅失联且有 git 锚点的条目可见：正常条目误点会把源路径改指收录时点
                    // 历史副本（内容回退 + 脱离 sweep 对账）；hasBlob 是 git 子进程调用，
                    // update 里太重，blob 已不存在由 restoreFailed 提示兜底
                    group.add(entryAction(
                        ZCodeBundle.message("kb.tw.btn.restoreGit"), AllIcons.Actions.Undo, entry,
                        gate = { it.status == KbEntry.STATUS_MISSING && it.gitCommit != null },
                    ) { restoreEntry(it) })
                    group.addSeparator()
                    group.add(entryAction(ZCodeBundle.message("kb.tw.btn.remove"), AllIcons.Actions.GC, entry) { removeEntry(it) })
                }
            }
            is NodeData.Folder -> folderMenu(d.folder, group)
            else -> blankMenu(group)
        }
        // Swing 菜单体系（ActionPopupMenu）：子菜单=JMenu，hover 即展开——
        // 之前走 JBPopupFactory.createActionGroupPopup 是 ListPopup 自绘体系，子菜单只能点击
        // 展开（真机反馈标签子菜单不便）；视觉=JBPopupMenu 原生右键菜单样式。
        ActionManager.getInstance()
            .createActionPopupMenu(ActionPlaces.EDITOR_POPUP, group)
            .apply { setTargetComponent(tree) }
            .component
            .show(tree, e.x, e.y)
    }

    /** 发送到 ZC GUI 输入框（品牌图标；条目文件引用，AI 拿到路径即可读原文） */
    private fun sendToInputAction(text: String, entries: List<KbEntry>): AnAction =
        object : AnAction(text, text, ZCodeIcons.ZcGui) {
            override fun actionPerformed(e: AnActionEvent) {
                val refs = entries.map { "@" + it.sourcePath }
                if (refs.isNotEmpty()) pushRefs(project, refs)
            }
        }

    /**
     * 条目标签子菜单（单选=勾选式切换；多选=toggle 批量：全部已打→点击批量移除，否则
     * 批量添加）+ 新建标签（批量挂到选中条目）。标签项带注册表色块（用户拍板）。
     * 右键菜单走 Swing 菜单体系：嵌套 DefaultActionGroup=JMenu 子菜单，hover 即展开
     * （真机反馈 ListPopup 体系子菜单要点点击，不便）。
     */
    private fun tagsSubmenu(entries: List<KbEntry>): DefaultActionGroup {
        // DefaultActionGroup 作子菜单时默认无图标（真机反馈补位）：update 里补品牌同位图标
        val sub = object : DefaultActionGroup(ZCodeBundle.message("kb.tw.tags.label"), true) {
            override fun update(e: AnActionEvent) {
                e.presentation.icon = AllIcons.Nodes.Tag
            }
        }
        for (tag in KbManagerService.instance.tags()) {
            val allHave = entries.all { it.tags.contains(tag) }
            sub.add(object : AnAction(tag) {
                override fun update(e: AnActionEvent) {
                    Toggleable.setSelected(e.presentation, allHave)
                    // 已选标签文字前加 ✓（用户拍板：色块保留，勾选态用文字前缀，平台 toggled 视觉不可靠）
                    e.presentation.text = if (allHave) "✓ $tag" else tag
                    // 标签色块（无注册色的回退灰）
                    e.presentation.icon = ColorIcon(
                        runCatching { java.awt.Color.decode(tagColorMap[tag] ?: "#8A919C") }.getOrDefault(java.awt.Color(0x8A919C)),
                    )
                }
                override fun actionPerformed(e: AnActionEvent) {
                    ApplicationManager.getApplication().executeOnPooledThread {
                        runCatching {
                            for (e in entries) {
                                val newTags =
                                    if (allHave) e.tags.filter { it != tag }
                                    else (e.tags + tag).distinct()
                                KbManagerService.instance.updateMeta(e.id, e.title, e.folderId, newTags, e.notes)
                            }
                        }
                    }
                }
            })
        }
        sub.addSeparator()
        sub.add(entryAction(ZCodeBundle.message("kb.tw.tags.new"), AllIcons.General.Add, entries.first()) { tagCreate(entries) })
        return sub
    }

    /** 新建标签：输入 → 注册表登记（自动分配颜色）→ 批量追加到选中条目 */
    private fun tagCreate(entries: List<KbEntry>) {
        val name = KbDialogs.input(ZCodeBundle.message("kb.tw.tags.newPrompt")) ?: return
        val clean = KbManagerService.sanitizeTags(listOf(name))
        if (clean.isEmpty()) return
        runCatching { KbManagerService.instance.createTag(clean.first()) }
        ApplicationManager.getApplication().executeOnPooledThread {
            runCatching {
                for (e in entries) {
                    KbManagerService.instance.updateMeta(e.id, e.title, e.folderId, (e.tags + clean).distinct(), e.notes)
                }
            }
        }
    }

    /** 目录右键：新建子目录 / 收录到此目录 / 移动到… / 重命名 / 删除 */
    private fun folderMenu(f: KbFolder, group: DefaultActionGroup) {
        group.add(action(ZCodeBundle.message("kb.tw.folder.newSub"), AllIcons.Nodes.Folder) { folderCreate(f.id) })
        group.add(action(ZCodeBundle.message("kb.tw.folder.ingestHere"), AllIcons.General.Add) { ingestFromChooser(f.id) })
        group.add(action(ZCodeBundle.message("kb.tw.btn.move"), AllIcons.Actions.MoveToTopRight) { moveFolderTo(f) })
        group.addSeparator()
        group.add(action(ZCodeBundle.message("kb.tw.folder.rename"), AllIcons.Actions.Edit) { folderRename(f) })
        group.add(action(ZCodeBundle.message("kb.tw.folder.delete"), AllIcons.Actions.GC) { folderDelete(f) })
    }

    /** 空白右键：只留新建根级目录（收录在顶部有 ⊕、管理标签在顶部有入口，重复项已删） */
    private fun blankMenu(group: DefaultActionGroup) {
        group.add(action(ZCodeBundle.message("kb.tw.folder.new"), AllIcons.Nodes.Folder) { folderCreate(null) })
    }

    private fun folderCreate(parentId: String?) {
        val name = KbDialogs.input(ZCodeBundle.message("kb.tw.folder.newPrompt"))
        if (!name.isNullOrBlank()) {
            ApplicationManager.getApplication().executeOnPooledThread {
                runCatching { KbManagerService.instance.createFolder(parentId, name.trim()) }
            }
        }
    }

    private fun folderRename(f: KbFolder) {
        val name = KbDialogs.input(ZCodeBundle.message("kb.tw.folder.renamePrompt", f.name), f.name)
        if (!name.isNullOrBlank() && name.trim() != f.name) {
            ApplicationManager.getApplication().executeOnPooledThread {
                runCatching { KbManagerService.instance.renameFolder(f.id, name.trim()) }
            }
        }
    }

    private fun folderDelete(f: KbFolder) {
        // 确认文案带影响面（子树条目数），UI 缓存现算（数据层 deleteFolder 二次权威）
        val doomed = subtreeIds(foldersCache, f.id)
        val moved = entriesCache.count { doomed.contains(it.folderId) }
        val confirmed = KbDialogs.confirm(
            ZCodeBundle.message("kb.tw.folder.deleteConfirm", f.name, moved),
            ZCodeBundle.message("kb.tw.folder.delete"),
        )
        if (!confirmed) return
        ApplicationManager.getApplication().executeOnPooledThread {
            runCatching { KbManagerService.instance.deleteFolder(f.id) }
        }
    }

    private fun moveEntryTo(e: KbEntry) {
        val service = KbManagerService.instance
        val dialog = KbMoveDialog(folderOptions(), emptySet(), e.folderId)
        if (!KbDialogs.show(dialog)) return
        val target = if (dialog.folderValue.isNotEmpty()) dialog.folderValue
        else service.ensureFolderPath(dialog.folderPathValue)
        ApplicationManager.getApplication().executeOnPooledThread {
            runCatching { service.moveEntries(listOf(e.id), target) }
        }
    }

    private fun moveFolderTo(f: KbFolder) {
        val service = KbManagerService.instance
        // 排除自身及子孙（防环；数据层 moveFolder 二次校验兜底）
        val dialog = KbMoveDialog(folderOptions(), subtreeIds(foldersCache, f.id), f.parentId ?: "")
        if (!KbDialogs.show(dialog)) return
        val target = if (dialog.folderValue.isNotEmpty()) dialog.folderValue
        else service.ensureFolderPath(dialog.folderPathValue)
        ApplicationManager.getApplication().executeOnPooledThread {
            runCatching { service.moveFolder(f.id, target.ifEmpty { null }) }
        }
    }

    /** 目录 id 的子树集合（含自身；foldersCache 断链容错） */
    private fun subtreeIds(folders: List<KbFolder>, id: String): Set<String> {
        val children = folders.groupBy { it.parentId ?: "" }
        val out = LinkedHashSet<String>()
        fun walk(x: String) {
            out.add(x)
            for (c in children[x].orEmpty()) walk(c.id)
        }
        walk(id)
        return out
    }

    // ───────────────────────── 动作 ─────────────────────────

    /** 工具条 ⊕：文件选择器（黑名单扩展隐藏，其余全显示——py/java/Makefile 可见可选）→ 选后嗅探分流 → 收录弹窗（默认上次目录） */
    private fun ingestFromChooser(preselectFolderId: String? = null) {
        val descriptor = FileChooserDescriptor(true, false, false, false, false, true)
            .withFileFilter { vf -> !KbExtractor.isDeniedBinary(vf.name) }
        val chosen = FileChooser.chooseFiles(descriptor, project, null)
        if (chosen.isEmpty()) return
        val (files, skipped) = KbIngestHelper.partitionIngestable(
            chosen.map { Path.of(it.path) }.filter { Files.isRegularFile(it) },
        )
        KbIngestHelper.notifySkipped(project, skipped)
        if (files.isNotEmpty()) ingestWithDialog(files, preselectFolderId)
    }

    /**
     * 打开分流：html→IDE 内置预览（用户指定）；其余先 `openFile` 交给 IDE 自选编辑器
     * （word/pdf 插件生态），**返回空编辑器（如未装 excel 插件的 xls——真机：静默无反应）
     * 兜底落系统默认应用**；VFS 找不到文件同样落系统应用。
     */
    private fun openEntry(e: KbEntry) {
        val f = File(e.sourcePath)
        if (!f.isFile) {
            Messages.showInfoMessage(ZCodeBundle.message("kb.tw.sourceMissing"), e.title)
            return
        }
        ApplicationManager.getApplication().invokeLater {
            val vf = LocalFileSystem.getInstance().refreshAndFindFileByIoFile(f)
            if (vf == null) {
                openWithSystemApp(f, e.title)
                return@invokeLater
            }
            if (e.fileExt.lowercase() in HTML_EXTS) {
                openHtmlPreview(vf)
                return@invokeLater
            }
            val editors = runCatching { FileEditorManager.getInstance(project).openFile(vf, true) }
                .getOrDefault(emptyArray())
            if (editors.isEmpty()) openWithSystemApp(f, e.title)
        }
    }

    /** 系统默认应用打开（IDE 无对应编辑器的格式兜底）；无关联程序时气泡提示 */
    private fun openWithSystemApp(f: File, title: String) {
        val ok = runCatching { java.awt.Desktop.getDesktop().open(f) }.isSuccess
        if (!ok) {
            NotificationGroupManager.getInstance().getNotificationGroup("ZCode")
                .createNotification(
                    ZCodeBundle.message("kb.notify.groupTitle"),
                    ZCodeBundle.message("kb.tw.systemOpenFailed", title),
                    NotificationType.WARNING,
                )
                .notify(project)
        }
    }

    /**
     * IDE 内置预览（Browser Preview，JCEF 渲染 + 右上角浏览器切换）：复刻包私有
     * OpenHtmlInEmbeddedBrowserAction 的路径——WebPreviewVirtualFile(wrap 原文件 +
     * file:// Url) 交给 FileEditorManager，WebPreviewEditorProvider（editorTypeId=
     * web-preview-editor）负责创建编辑器，tab 标题自动带「的预览」。构造失败降级
     * 源码打开（provider 缺席的精简发行版仍可用）。
     */
    private fun openHtmlPreview(vf: com.intellij.openapi.vfs.VirtualFile) {
        try {
            val previewFile = WebPreviewVirtualFile(vf, Urls.newLocalFileUrl(vf))
            FileEditorManager.getInstance(project).openFile(previewFile, true)
        } catch (ex: Exception) {
            log.warn("Knowledge Base: html preview open failed, fallback to source: ${ex.message}")
            FileEditorManager.getInstance(project).openFile(vf, true)
        }
    }

    /**
     * 在系统文件管理器定位源文件：Windows `explorer /select` 选中文件，macOS `open -R`，
     * Linux 开父目录。只 start 不等退出——explorer 成功也返回非 0 退出码，等待退出会误判失败
     * （同主面板 turnfile 的 reveal 兜底）。启动失败降级系统默认应用打开。
     */
    private fun revealEntry(e: KbEntry) {
        val f = File(e.sourcePath)
        if (!f.isFile) {
            Messages.showInfoMessage(ZCodeBundle.message("kb.tw.sourceMissing"), e.title)
            return
        }
        val os = System.getProperty("os.name")?.lowercase() ?: ""
        val ok = runCatching {
            when {
                os.contains("win") -> ProcessBuilder("explorer.exe", "/select,${f.absolutePath}").start()
                os.contains("mac") || os.contains("darwin") -> ProcessBuilder("open", "-R", f.absolutePath).start()
                else -> ProcessBuilder("xdg-open", f.parentFile?.absolutePath ?: f.absolutePath).start()
            }
            true
        }.getOrDefault(false)
        if (!ok) openWithSystemApp(f, e.title)
    }

    private fun editEntry(e: KbEntry) {
        val service = KbManagerService.instance
        val dialog = KbIngestDialog(
            emptyList(),
            folderOptions(),
            service.tags(),
            editOf = e,
            defaultFolderId = e.folderId,
        )
        if (!KbDialogs.show(dialog)) return
        ApplicationManager.getApplication().executeOnPooledThread {
            runCatching {
                val folderId = resolveFolderChoice(service, dialog)
                service.updateMeta(e.id, dialog.titleValue, folderId, dialog.tagsValue, dialog.notesValue)
            }
        }
    }

    /** 目录选择统一落库：预设项=已有 id；自由输入路径=ensureFolderPath 逐级建；根级="" */
    private fun resolveFolderChoice(service: KbManagerService, dialog: KbIngestDialog): String {
        if (dialog.folderValue.isNotEmpty()) return dialog.folderValue // 预设已有目录
        val path = dialog.folderPathValue
        return if (path.isEmpty()) "" else service.ensureFolderPath(path) // 自由输入逐级建
    }

    private fun relinkEntry(e: KbEntry) {
        val descriptor = FileChooserDescriptorFactory.createSingleFileDescriptor()
            .withTitle(ZCodeBundle.message("kb.tw.relinkChooserTitle"))
        val vf = FileChooser.chooseFile(descriptor, project, null) ?: return
        ApplicationManager.getApplication().executeOnPooledThread {
            runCatching { KbManagerService.instance.relink(e.id, Path.of(vf.path)) }
        }
    }

    private fun restoreEntry(e: KbEntry) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val result = runCatching { KbManagerService.instance.restoreFromGit(e.id) }.getOrNull()
            ApplicationManager.getApplication().invokeLater {
                if (result != null) {
                    Messages.showInfoMessage(ZCodeBundle.message("kb.tw.restored", result.toString()), e.title)
                } else {
                    Messages.showErrorDialog(project, ZCodeBundle.message("kb.tw.restoreFailed"), "ZCode")
                }
            }
        }
    }

    /** 批量摘除（多选 Ctrl/Shift 后右键）：逐条 remove，完成气泡回执 */
    private fun removeEntriesBatch(entries: List<KbEntry>) {
        val confirmed = KbDialogs.confirm(
            ZCodeBundle.message("kb.tw.removeBatchConfirm", entries.size),
            ZCodeBundle.message("kb.tw.removeTitle"),
        )
        if (!confirmed) return
        ApplicationManager.getApplication().executeOnPooledThread {
            var ok = 0
            for (e in entries) {
                if (runCatching { KbManagerService.instance.remove(e.id) }.getOrDefault(false)) ok++
            }
            ApplicationManager.getApplication().invokeLater {
                NotificationGroupManager.getInstance().getNotificationGroup("ZCode")
                    .createNotification(
                        ZCodeBundle.message("kb.notify.groupTitle"),
                        ZCodeBundle.message("kb.notify.removedBatch", ok),
                        NotificationType.INFORMATION,
                    )
                    .notify(project)
            }
        }
    }

    private fun removeEntry(e: KbEntry) {
        val confirmed = KbDialogs.confirm(
            ZCodeBundle.message("kb.tw.removeConfirm", e.title),
            ZCodeBundle.message("kb.tw.removeTitle"),
        )
        if (!confirmed) return
        ApplicationManager.getApplication().executeOnPooledThread {
            runCatching { KbManagerService.instance.remove(e.id) }
        }
    }

    // ───────────────────────── 收录 ─────────────────────────

    /** 目录下拉选项（id + 派生路径 + 末级名） */
    private fun folderOptions(): List<KbIngestDialog.FolderOption> {
        val service = KbManagerService.instance
        return service.folders().map { f ->
            KbIngestDialog.FolderOption(f.id, service.folderPath(f.id), f.name)
        }
    }

    /** 拖拽/复用收录入口：弹窗确认 → 后台 ingest（service 侧广播刷新面板） */
    fun ingestWithDialog(files: List<Path>, preselectFolderId: String? = null) {
        val service = KbManagerService.instance
        val defaultFolderId = preselectFolderId?.takeIf { it.isNotEmpty() } ?: runCatching { service.lastFolderId() }.getOrDefault("")
        val dialog = KbIngestDialog(files, folderOptions(), service.tags(), defaultFolderId = defaultFolderId)
        if (!KbDialogs.show(dialog)) return
        ApplicationManager.getApplication().executeOnPooledThread {
            val folderId = resolveFolderChoice(service, dialog)
            for (f in files) {
                val perFileTitle = if (files.size == 1) dialog.titleValue else f.fileName.toString().substringBeforeLast('.')
                runCatching { service.ingest(f, perFileTitle, folderId, dialog.tagsValue, dialog.notesValue, project) }
            }
        }
    }

    // ───────────────────────── DnD（树内拖拽移动 + 外部文件拖入收录） ─────────────────────────

    private var dropTarget: DropTarget? = null

    /** 拖外部文件进面板收录（树区域拖入走 [KbTransferHandler] 的文件 flavor 分流） */
    private fun registerFileDropTarget() {
        dropTarget = DropTarget(this, object : DropTargetAdapter() {
            // 悬停必须 acceptDrag，否则 Windows 拖拽光标恒为「禁止」、部分场景 drop 不投递（真机实测）
            override fun dragEnter(dtde: DropTargetDragEvent) = acceptIfFiles(dtde)
            override fun dragOver(dtde: DropTargetDragEvent) = acceptIfFiles(dtde)

            private fun acceptIfFiles(dtde: DropTargetDragEvent) {
                if (dtde.isDataFlavorSupported(DataFlavor.javaFileListFlavor)) {
                    dtde.acceptDrag(DnDConstants.ACTION_COPY)
                } else {
                    dtde.rejectDrag()
                }
            }

            override fun drop(dtde: DropTargetDropEvent) {
                dtde.acceptDrop(dtde.dropAction)
                val transferable = dtde.transferable
                val files: List<File>? = if (transferable.isDataFlavorSupported(DataFlavor.javaFileListFlavor)) {
                    runCatching {
                        @Suppress("UNCHECKED_CAST")
                        transferable.getTransferData(DataFlavor.javaFileListFlavor) as List<File>
                    }.getOrNull()
                } else null
                dtde.dropComplete(true) // 空列表也 complete（防 Finder 残影）
                val (supported, skipped) = KbIngestHelper.partitionIngestable(
                    (files ?: emptyList()).map { it.toPath() },
                )
                KbIngestHelper.notifySkipped(project, skipped)
                if (supported.isNotEmpty()) {
                    SwingUtilities.invokeLater { ingestWithDialog(supported) }
                }
            }
        })
    }

    /**
     * 树内拖拽：条目（支持多选，拖到目录=移入、拖到条目=移入其父目录、拖到根=根级）
     * 与目录（拖到目录=成为子目录；防环拒绝自身子孙）。精细同层排序一期不做。
     */
    private inner class KbTransferHandler : javax.swing.TransferHandler() {

        override fun getSourceActions(c: JComponent): Int = MOVE

        override fun createTransferable(c: JComponent): Transferable? {
            val paths = tree.selectionPaths ?: return null
            val entries = paths.mapNotNull { (it.lastPathComponent as? DefaultMutableTreeNode)?.userObject as? NodeData.Entry }
            if (entries.isNotEmpty()) return KbTransferable("E:" + entries.joinToString(",") { it.entry.id })
            val folder = paths.singleOrNull()?.let {
                (it.lastPathComponent as? DefaultMutableTreeNode)?.userObject as? NodeData.Folder
            } ?: return null
            return KbTransferable("F:" + folder.folder.id)
        }

        override fun canImport(support: TransferSupport): Boolean {
            // 外部文件拖入树区=收录（不走树内移动语义，搜索/过滤平铺态也放行——收录不涉误移）
            if (support.isDataFlavorSupported(DataFlavor.javaFileListFlavor)) return true
            if (!support.isDataFlavorSupported(KbTransferable.FLAVOR)) return false
            if (searchHits.isNotEmpty() || filterTags.isNotEmpty()) return false // 搜索/标签过滤平铺态禁拖（落点语义不明，防误移入根级）
            val loc = support.dropLocation as? javax.swing.JTree.DropLocation ?: return false
            val path = loc.path ?: return false
            val payload = runCatching {
                support.transferable.getTransferData(KbTransferable.FLAVOR) as? String
            }.getOrNull() ?: return false
            val node = path.lastPathComponent as? DefaultMutableTreeNode ?: return false
            return when {
                payload.startsWith("F:") -> {
                    // 目录落点：目录节点（非自身/子孙）或根行；条目行不算目录落点
                    val target = node.userObject as? NodeData.Folder
                    when {
                        target != null -> target.folder.id != payload.substring(2) &&
                            !isAncestor(payload.substring(2), target.folder.id)
                        node.userObject is String -> true // 根行 = 根级
                        else -> false
                    }
                }
                payload.startsWith("E:") -> true // 条目落目录行/条目行/根行均可（importData 解析）
                else -> false
            }
        }

        override fun importData(support: TransferSupport): Boolean {
            // 外部文件拖入树区=收录（与面板空白区 DropTarget 同流；importData 在 EDT，弹窗可直接调）
            if (support.isDataFlavorSupported(DataFlavor.javaFileListFlavor)) {
                val files = runCatching {
                    @Suppress("UNCHECKED_CAST")
                    support.transferable.getTransferData(DataFlavor.javaFileListFlavor) as List<File>
                }.getOrNull() ?: return false
                val (supported, skipped) = KbIngestHelper.partitionIngestable(files.map { it.toPath() })
                KbIngestHelper.notifySkipped(project, skipped)
                if (supported.isNotEmpty()) {
                    // 弹窗目录预选=拖入落点（2026-11-23 反馈：拖到目录行却还预填上次收录目录）：
                    // 目录行取该目录、条目行取其所属目录，根行/未知传空回落「上次收录目录」
                    val node = (support.dropLocation as? javax.swing.JTree.DropLocation)
                        ?.path?.lastPathComponent as? DefaultMutableTreeNode
                    val preselectFolder = when (val d = node?.userObject) {
                        is NodeData.Folder -> d.folder.id
                        is NodeData.Entry -> d.entry.folderId
                        else -> null
                    }
                    ingestWithDialog(supported, preselectFolder)
                }
                return true
            }
            val loc = support.dropLocation as? javax.swing.JTree.DropLocation ?: return false
            val path = loc.path ?: return false
            val payload = runCatching {
                support.transferable.getTransferData(KbTransferable.FLAVOR) as? String
            }.getOrNull() ?: return false
            val node = path.lastPathComponent as? DefaultMutableTreeNode ?: return false
            val service = KbManagerService.instance
            return when {
                payload.startsWith("E:") -> {
                    val ids = payload.substring(2).split(',').filter { it.isNotEmpty() }
                    val target = when (val d = node.userObject) {
                        is NodeData.Folder -> d.folder.id
                        is NodeData.Entry -> parentFolderIdOf(node) // 拖到条目行=移入其父目录
                        else -> "" // 根行 = 根级
                    }
                    val ids2 = ids.filter { id -> entriesCache.any { it.id == id } }
                    if (ids2.isEmpty()) return false
                    if (target.isNotEmpty()) expandedKeys.add("F\u0001$target") // 落点目录自动展开（刷新后生效）
                    ApplicationManager.getApplication().executeOnPooledThread {
                        runCatching { service.moveEntries(ids2, target) }
                    }
                    true
                }
                payload.startsWith("F:") -> {
                    val draggedId = payload.substring(2)
                    val target = (node.userObject as? NodeData.Folder)?.folder?.id
                    if ((node.userObject as? NodeData.Folder)?.folder?.id == draggedId) return false
                    ApplicationManager.getApplication().executeOnPooledThread {
                        runCatching { service.moveFolder(draggedId, target) }
                    }
                    true
                }
                else -> false
            }
        }

        /** 条目节点的父目录 id（父是目录节点取其 id；父是根/根级=""） */
        private fun parentFolderIdOf(entryNode: DefaultMutableTreeNode): String =
            (entryNode.parent as? DefaultMutableTreeNode)?.userObject?.let { (it as? NodeData.Folder)?.folder?.id } ?: ""

        /** dragged 是否是 candidate 的祖先（canImport 防环：拒绝拖入自身子孙） */
        private fun isAncestor(dragged: String, candidate: String): Boolean {
            if (dragged == candidate) return true
            val idx = foldersCache.associateBy { it.id }
            var cur = idx[candidate]
            val seen = HashSet<String>()
            while (cur != null && seen.add(cur.id)) {
                if (cur.id == dragged) return true
                cur = cur.parentId?.let { idx[it] }
            }
            return false
        }
    }

    private class KbTransferable(private val payload: String) : Transferable {
        override fun getTransferDataFlavors(): Array<DataFlavor> = arrayOf(FLAVOR)
        override fun isDataFlavorSupported(flavor: DataFlavor): Boolean = flavor == FLAVOR
        override fun getTransferData(flavor: DataFlavor): Any =
            if (flavor == FLAVOR) payload else throw UnsupportedFlavorException(flavor)

        companion object {
            val FLAVOR = DataFlavor("application/x-zcode-kb-dnd; class=java.lang.String", "ZCode KB drag")
        }
    }

    // ───────────────────────── renderer ─────────────────────────

    /**
     * 条目图标。办公文档四类（doc·docx/xls·xlsx/pdf/mhtml）**无条件用插件维护的矢量
     * 徽标**（SVG，任意缩放锐利）——真机五版实证：word 插件把 docx 判成 icon 为三横线
     * 样式的类型（独立资源 icon），判型/实例比较/引用比较均不可靠。其余扩展名走平台/
     * 插件判型（md→Markdown 等，与项目视图一致）。判型必须用**源文件名**（带扩展名，
     * 标题不带——首版坑）。
     */
    private fun iconFor(e: KbEntry): javax.swing.Icon {
        return when (e.fileExt.lowercase()) {
            ".docx", ".doc" -> kbIcon("kb-docx.svg")
            ".xls", ".xlsx" -> kbIcon("kb-xls.svg")
            ".pdf" -> kbIcon("kb-pdf.svg")
            ".mhtml", ".mht" -> AllIcons.FileTypes.Html
            else -> {
                val fileName = e.sourcePath.substringAfterLast('/').substringAfterLast('\\')
                val ft = runCatching { FileTypeManager.getInstance().getFileTypeByFileName(fileName) }.getOrNull()
                ft?.icon ?: AllIcons.FileTypes.Text
            }
        }
    }

    /** 知识库内置矢量徽标（IconLoader 按 path 缓存；SVG 矢量 HiDPI 任意缩放锐利） */
    private fun kbIcon(name: String): javax.swing.Icon =
        com.intellij.openapi.util.IconLoader.getIcon("/icons/" + name, KnowledgeToolWindowPanel::class.java.classLoader)

    /** 标签 chip 显示上限：最多 2 个 + 「…」，悬停 tooltip 看全量（用户拍板） */
    private fun visibleTags(entry: KbEntry, goldIds: Set<String>): List<Pair<String, Boolean>> {
        val tags = entry.tags
        val hitFirst = tags.filter { goldIds.contains(it) } + tags.filter { !goldIds.contains(it) }
        val shown = hitFirst.take(TAG_CHIPS_MAX).map { it to goldIds.contains(it) }
        return if (tags.size > TAG_CHIPS_MAX) shown + listOf("\u2026" to false) else shown
    }

    /**
     * 树渲染分派：目录节点走 ColoredTreeCellRenderer（原生外观）；条目行走组件行
     * （标题 + 标签 chip 圆角自绘 + 搜索态片段/处数，HTML 不支持 border-radius）。
     */
    private fun renderer(): javax.swing.tree.TreeCellRenderer {
        val colored = object : ColoredTreeCellRenderer() {
            override fun customizeCellRenderer(
                tree: javax.swing.JTree,
                value: Any,
                selected: Boolean,
                expanded: Boolean,
                leaf: Boolean,
                row: Int,
                hasFocus: Boolean,
            ) {
                val d = (value as? DefaultMutableTreeNode)?.userObject as? NodeData ?: return
                when (d) {
                    is NodeData.Folder -> {
                        icon = AllIcons.Nodes.Folder
                        append(d.folder.name, SimpleTextAttributes.REGULAR_ATTRIBUTES)
                        if (d.count > 0) append("  ${d.count}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    }
                    is NodeData.Entry -> {
                        // 兜底（组件行不可用时）：无 chip 的纯标题行
                        icon = iconFor(d.entry)
                        append(d.entry.title, SimpleTextAttributes.REGULAR_ATTRIBUTES)
                        if (d.entry.status == KbEntry.STATUS_MISSING) {
                            append(" " + ZCodeBundle.message("kb.tw.missingMark"), SimpleTextAttributes.ERROR_ATTRIBUTES)
                        }
                    }
                }
            }
        }
        val rowPanel = EntryRowPanel()
        return javax.swing.tree.TreeCellRenderer { tree, value, selected, expanded, leaf, row, focus ->
            val d = (value as? DefaultMutableTreeNode)?.userObject as? NodeData
            if (d is NodeData.Entry) {
                configureEntryRow(rowPanel, tree, d, selected)
                rowPanel
            } else {
                colored.getTreeCellRendererComponent(tree, value, selected, expanded, leaf, row, focus)
            }
        }
    }

    /** 命中标签集（任一搜索词元小写包含于标签）——命中 chip 提前第一位并金黄；
     *  标签过滤态不套用：chip 恒注册色（真机反馈：过滤时标签变色困惑） */
    private fun hitTagIds(entry: KbEntry): Set<String> {
        if (searchTokens.isEmpty()) return emptySet()
        return entry.tags.filterTo(HashSet()) { t ->
            val lower = t.lowercase()
            searchTokens.any { lower.contains(it) }
        }
    }

    private fun configureEntryRow(row: EntryRowPanel, tree: javax.swing.JTree, d: NodeData.Entry, selected: Boolean) {
        val entry = d.entry
        val hit = searchHits[entry.id]
        val gold = hitTagIds(entry)

        row.title.icon = iconFor(entry)
        val missing = entry.status == KbEntry.STATUS_MISSING
        // 源文件已移除：标题灰色+删除线（真机反馈：目录里零标识，点开才弹气泡才知道失效）
        row.title.text = if (missing) "<html><strike>${escapeHtml(entry.title)}</strike></html>" else entry.title
        val fg = if (selected) UIUtil.getTreeSelectionForeground(true) else tree.foreground
        // git diff 样式：文件名用链接色（双击打开语义一致），选中态反白；失效条目降灰
        row.title.foreground = when {
            selected -> fg
            missing -> UIUtil.getContextHelpForeground()
            else -> JBUI.CurrentTheme.Link.Foreground.ENABLED
        }

        row.chips.removeAll()
        for ((tag, isGold) in visibleTags(entry, gold)) {
            row.chips.add(KbChip(tag, isGold, tagColorMap[tag]))
        }
        row.count.text = if (hit != null) ZCodeBundle.message("kb.tw.hitCount", hit.matchCount) else ""
        row.count.isVisible = hit != null // 空时隐藏，避免占位扩大标题与路径间距（真机反馈间隔过大）
        row.count.foreground = if (selected) fg else UIUtil.getContextHelpForeground()

        // 行尾灰色源文件全路径（标题≠文件名时可定位原文件；用户拍板）
        row.path.text = KbFileStore.displayPath(entry.sourcePath)
        row.path.foreground = if (selected) fg else UIUtil.getContextHelpForeground()

        if (hit != null) {
            row.snippets.text = searchRowHtml(entry, hit)
            row.snippets.isVisible = true
        } else {
            row.snippets.isVisible = false
        }

        row.background = if (selected) UIUtil.getTreeSelectionBackground(true) else tree.background
        row.isOpaque = true
        row.toolTipText = null // 悬浮提示整体取消（用户拍板）

        // CellRendererPane 绘制 renderer 组件时不执行布局：每次配置后手动级联 doLayout
        // （真机：标题与路径间出现大块空隙即布局停留在旧宽度）
        row.chips.doLayout()
        row.line.doLayout()
        row.doLayout()
    }

    /** 条目行组件（git diff 样式）：标题链接色+chips+行尾灰色路径；垂直留白行距（用户反馈拥挤）；搜索态追加片段行 */
    private class EntryRowPanel : JPanel(BorderLayout()) {
        val line = JPanel(FlowLayout(FlowLayout.LEFT, 0, 0))
        val title = JBLabel()
        val chips = JPanel(FlowLayout(FlowLayout.LEFT, 3, 0))
        val count = JBLabel()
        val path = JBLabel()
        val snippets = JBLabel()

        init {
            isOpaque = false
            line.isOpaque = false
            chips.isOpaque = false
            count.border = JBUI.Borders.emptyLeft(6)
            path.border = JBUI.Borders.emptyLeft(8)
            border = JBUI.Borders.empty(3, 0) // 行距留白（git diff 同款宽松密度）
            snippets.verticalAlignment = javax.swing.SwingConstants.TOP
            snippets.border = JBUI.Borders.empty(1, 0, 2, 0)
            line.add(title)
            line.add(chips)
            line.add(count)
            line.add(path)
            add(line, BorderLayout.NORTH)
            add(snippets, BorderLayout.CENTER)
        }
    }

    /**
     * 圆角标签 chip（Swing HTML 不支持 border-radius，自绘胶囊底）。颜色优先级：
     * 搜索命中金黄 > 标签注册表色 > 默认灰；字色按底色亮度自适配黑白（深浅主题通用）。
     */
    private class KbChip(text: String, gold: Boolean, colorHex: String? = null) : JBLabel(text) {
        private val bg: java.awt.Color = when {
            gold -> CHIP_BG_HIT
            colorHex != null -> runCatching { java.awt.Color.decode(colorHex) }.getOrDefault(CHIP_BG as java.awt.Color)
            else -> CHIP_BG as java.awt.Color
        }
        private val fg: java.awt.Color = when {
            gold -> CHIP_FG_HIT
            bg.luminance() > 0.55 -> java.awt.Color(0x1E1E1E)
            else -> java.awt.Color(0xFFFFFF)
        }

        init {
            font = JBUI.Fonts.label(10f) // 小一号（真机反馈 chip 偏大）
            border = JBUI.Borders.empty(0, 5)
            foreground = fg
            isOpaque = false
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
    }

    /** 搜索态片段 HTML：上下文片段每片段一行（关键词金黄高亮，最多 3 行） */
    private fun searchRowHtml(entry: KbEntry, hit: KbHit): String {
        val gray = metaColor()
        val snippetRows = hit.snippets
            .take(3)
            .joinToString("<br>") { s -> "<span style=\"color:$gray\">${highlightedHtml(s, searchTokens)}</span>" }
        return "<html><body style=\"margin:0;padding:0\">$snippetRows</body></html>"
    }

    /** 关键词高亮：在原文上算命中掩码再分段转义（先 escape 再替换会被 &amp; 这类转义串误命中） */
    private fun highlightedHtml(text: String, tokens: List<String>): String {
        if (text.isEmpty()) return ""
        val lower = text.lowercase()
        val mask = BooleanArray(text.length)
        for (t in tokens) {
            if (t.isEmpty()) continue
            var idx = 0
            while (true) {
                idx = lower.indexOf(t, idx)
                if (idx < 0) break
                for (i in idx until minOf(idx + t.length, mask.size)) mask[i] = true
                idx += t.length
            }
        }
        val sb = StringBuilder(text.length + 64)
        var i = 0
        while (i < text.length) {
            val m = mask[i]
            val start = i
            while (i < text.length && mask[i] == m) i++
            val seg = escapeHtml(text.substring(start, i))
            if (m) sb.append("<span style=\"background:#e8b339;color:#1e1e1e\">").append(seg).append("</span>")
            else sb.append(seg)
        }
        return sb.toString()
    }

    private fun escapeHtml(s: String): String =
        s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    /** 元信息灰色（跟随主题深浅） */
    private fun metaColor(): String =
        if (UIUtil.isUnderDarcula()) "#8a8f98" else "#6c707e"

    override fun dispose() {
        searchDebounce.stop()
        dropTarget = null
    }

    companion object {
        /** chip 上限：最多显示 2 个 + 省略号（用户拍板） */
        private const val TAG_CHIPS_MAX = 2

        /** chip 默认配色（无注册色标签回退）；金黄=搜索命中标签（与片段高亮同色系） */
        private val CHIP_BG: java.awt.Color = JBColor(0xe7e9ec, 0x36383c)
        private val CHIP_BG_HIT = java.awt.Color(0xe8b339)
        private val CHIP_FG_HIT = java.awt.Color(0x1e1e1e)

        /** 底色亮度（0~1）：亮底黑字 / 深底白字，保证彩色 chip 可读 */
        private fun java.awt.Color.luminance(): Double =
            (0.299 * red + 0.587 * green + 0.114 * blue) / 255.0

        /** html 分流到 IDE 内置预览（WebPreview/JCEF 渲染），不进默认编辑器 */
        private val HTML_EXTS = setOf(".html", ".htm")
    }
}
