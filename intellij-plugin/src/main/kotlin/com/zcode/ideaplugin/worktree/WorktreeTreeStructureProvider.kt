package com.zcode.ideaplugin.worktree

import com.intellij.ide.projectView.PresentationData
import com.intellij.ide.projectView.ProjectViewNode
import com.intellij.ide.projectView.TreeStructureProvider
import com.intellij.ide.projectView.ViewSettings
import com.intellij.ide.util.treeView.AbstractTreeNode
import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.DataKey
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.project.Project
import com.intellij.ui.SimpleTextAttributes
import com.zcode.ideaplugin.ZCodeBundle
import java.nio.file.Path

/**
 * ProjectView 的 ZCGUIWorktrees 专属目录（0.4.6，spec #52）。
 *
 * 注入方式 = `com.intellij.treeStructureProvider` EP（233 存在性 spike 已过：Scratch
 * 树提供者同款）。**虚拟节点**：不挂 content root、不进索引；子树数据全部来自
 * [WorktreeProjectState] 后台快照（树构建在 EDT，绝不现场跑 git/RPC）。
 *
 * 层级：ZCGUIWorktrees → [本目录, 各关联目录] → worktree 子节点（`仓库名 · 桶`，
 * 起点短标识 + 脏/缺失角标）。叶节点单击 = 新窗口打开副本（执行根即项目根）。
 *
 * **树元素稳定身份（2026-11-15 反馈：刷新整簇折叠）**：ProjectView.refresh() 走
 * updateFromRoot 增量更新，靠元素 equals 匹配保留展开态——2023.3 AbstractTreeNode.equals
 * = getClass() 相同 + Comparing.equal(value)（javap 实锤）。节点必须传**稳定键**作 value
 * （root Path / sha / 文件路径），数据对象（Entry/CommitChange 等内容每轮重建都变）绝不能
 * 直接当 value——一变匹配失败，展开全丢。新实例携带新快照，匹配成功=展开保留+内容照常刷新，
 * 平台自动只增删改变化的行。
 *
 * **子树排序锁（2026-11-15 反馈：提交/节点顺序被 ProjectView 排序器打乱）**：裸
 * AbstractTreeNode 会被 ProjectView 的排序比较器按展示文本排（真机实锤=按 sha 字母序，
 * 时间序全毁）。节点升级为 [ProjectViewNode] 并全量覆写排序钩子（getSortKey /
 * getTypeSortWeight / getManualOrderKey / getTimeSortKey）= 兄弟序号——无论用户开哪种
 * 排序模式，呈现顺序都锁死为快照组装序（提交=严格时间降序、节点=最近活跃降序）。
 */
class WorktreeTreeStructureProvider : TreeStructureProvider {

    override fun modify(
        parent: AbstractTreeNode<*>,
        children: MutableCollection<out AbstractTreeNode<*>>,
        settings: ViewSettings,
    ): Collection<AbstractTreeNode<*>> {
        val project = parent.project ?: return children
        if (parent.value !is Project) return children
        // 门控：未探测/不支持 → 整个节点不出现（老 CLI 零侵入）
        val state = WorktreeProjectState.getInstance(project)
        if (!state.isSupported()) return children
        // 空 worktree 的分组（乃至整个根节点）不渲染（2026-11-13 反馈）
        val groups = state.groups.filter { it.entries.isNotEmpty() }
        if (groups.isEmpty()) return children
        return children + WorktreesRootNode(project, groups, settings)
    }

    /** 给右键动作供数据：选中的 worktree 叶节点条目 */
    override fun getData(selected: MutableCollection<out AbstractTreeNode<*>>, dataId: String): Any? {
        if (dataId != WorktreeDataKeys.SELECTED_ENTRIES_ID) return null
        val items = selected.filterIsInstance<WorktreeEntryNode>().map { it.entry }
        return if (items.isEmpty()) null else items
    }
}

object WorktreeDataKeys {
    /** ProjectView 右键：选中的 worktree 条目（WorktreeProjectState.Entry 列表）。
     *  供给侧（[WorktreeTreeStructureProvider.getData]）按平台协议收字符串 id，常量保留；消费侧
     *  统一走 [SELECTED_ENTRIES] 的 DataKey 公开通道——`DataContext.getData(String)` 是
     *  @ApiStatus.Internal，Marketplace verifier 报 Problem（0.4.6 实踩 2 处）。 */
    const val SELECTED_ENTRIES_ID = "zcode.worktree.selectedEntries"

    /** 与 [SELECTED_ENTRIES_ID] 同串名：DataKey.getData(context) 平台内部仍按字符串 id 解析，供给链不变 */
    val SELECTED_ENTRIES: DataKey<List<WorktreeProjectState.Entry>> = DataKey.create(SELECTED_ENTRIES_ID)
}

/** 分组节点稳定身份键（树元素 equals=类+value；同父下两段互异即可，跨父链不相遇） */
private const val GROUP_KEY_COMMITS = "commits"
private const val GROUP_KEY_UNCOMMITTED = "uncommitted"

/** 已合并绿勾（2026-11-15 压缩定案）：IDEA 语义绿，亮暗主题同色可读 */
private val MERGED_ATTRIBUTES =
    SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, com.intellij.ui.JBColor(0x499C54, 0x499C54))

/**
 * 排序锁基类：兄弟序号 → 全部排序钩子（见文件头「子树排序锁」）。虚拟节点不承载
 * 文件匹配（contains=false）；VIRTUAL_FILE 仅 EntryNode 覆写供给右键通路。
 */
abstract class WorktreeNodeBase<V : Any>(
    project: Project,
    value: V,
    viewSettings: ViewSettings,
    private val order: Int,
) : ProjectViewNode<V>(project, value, viewSettings) {

    override fun contains(file: com.intellij.openapi.vfs.VirtualFile): Boolean = false

    override fun getSortKey(): Comparable<*> = order

    override fun getTypeSortWeight(sortByType: Boolean): Int = 0

    override fun getManualOrderKey(): Comparable<*> = order

    override fun getTimeSortKey(): Comparable<*> = order
}

/** ZCGUIWorktrees 根节点（虚拟容器） */
class WorktreesRootNode(
    project: Project,
    private val groups: List<WorktreeProjectState.SourceGroup>,
    private val viewSettings: ViewSettings,
) : WorktreeNodeBase<String>(project, "worktrees-root", viewSettings, 0) {

    override fun update(presentation: PresentationData) {
        presentation.presentableText = "ZCGUIWorktrees"
        presentation.setIcon(AllIcons.Nodes.Folder)
    }

    override fun getChildren(): MutableCollection<out AbstractTreeNode<*>> =
        groups.mapIndexed { i, g -> WorktreeSourceGroupNode(project!!, g, viewSettings, i) }.toMutableList()

    override fun canNavigate(): Boolean = false
}

/** 源工作区分组节点（本目录 / 各关联目录）；value=目录 Path（稳定键，见文件头身份契约） */
class WorktreeSourceGroupNode(
    project: Project,
    val group: WorktreeProjectState.SourceGroup,
    private val viewSettings: ViewSettings,
    order: Int,
) : WorktreeNodeBase<Path>(project, group.dir, viewSettings, order) {

    override fun update(presentation: PresentationData) {
        presentation.presentableText = group.name
        presentation.setIcon(AllIcons.Nodes.Module)
    }

    override fun getChildren(): MutableCollection<out AbstractTreeNode<*>> =
        group.entries.mapIndexed { i, e -> WorktreeEntryNode(project!!, e, viewSettings, i) }.toMutableList()

    override fun canNavigate(): Boolean = false
}

/**
 * worktree 节点：`仓库名 · 桶 · 基于 起点` + 变更计数（2026-11-14 定案 Q8=A：灰字后缀，
 * 零变更不显示）；**可展开容器**（Q1'：提交组 + 未提交组两段；Q7=A：单击交给平台展开
 * 收起，新窗口打开走右键菜单第二项——原「单击开窗」随容器化退役）。
 * 子树数据全读快照 [WorktreeProjectState.Entry.changes]（15s 轮询 + 回合结束事件驱动，
 * 后台现查），EDT 零 git。value=worktree 根 Path（稳定键，见文件头身份契约——Entry 数据
 * 对象每轮重建都变，直接当 value 会令展开态匹配失败整簇折叠）。
 */
class WorktreeEntryNode(
    project: Project,
    val entry: WorktreeProjectState.Entry,
    private val viewSettings: ViewSettings,
    order: Int,
) : WorktreeNodeBase<Path>(project, entry.root, viewSettings, order) {

    override fun update(presentation: PresentationData) {
        // 显式分段渲染（fragments 非空时渲染器走 colored 路径替代 presentableText）：
        // 统一走 fragments，避免「角标 fragment 反而顶掉整行文本」的隐患
        presentation.clearText()
        // 桶名即可（2026-11-14 真机反馈：项目名与父分组重复）
        presentation.addText(entry.bucket, SimpleTextAttributes.REGULAR_ATTRIBUTES)
        // 「基于 分支@提交」（起点语义优先 startRef（注册表落的创建时刻分支名，游离为
        // HEAD），worktree list 的 branchName 作桌面端建副本的兜底；sha 取起点短位——
        // 游离提交不在分支上时 sha 才是唯一可辨来源。注册表无记录（桌面端建的 detached
        // 副本）回退 inferredBaseSha=worktree HEAD reflog 首条（2026-11-16 排查定案：
        // worktree add 落笔的历史事实，主分支其后 rebase 也不失真）；都取不到不显示，
        // 误导性兜底（merge-base 动态推算）已删）
        val refName = entry.startRef?.takeIf { it.isNotEmpty() && it != "HEAD" }
            ?: entry.branchName
            ?: entry.startRef?.takeIf { it.isNotEmpty() }
        val start = buildString {
            if (!refName.isNullOrEmpty()) append(refName)
            entry.startSha?.takeIf { it.isNotEmpty() }?.let {
                if (isNotEmpty()) append('@')
                append(it.take(7))
            }
        }.takeIf { it.isNotEmpty() }
            ?: entry.inferredBaseSha?.takeIf { it.isNotEmpty() }?.let { it.take(7) }
        if (start != null) {
            presentation.addText(" · ", SimpleTextAttributes.GRAYED_ATTRIBUTES)
            presentation.addText(ZCodeBundle.message("worktree.node.basedOn", start), SimpleTextAttributes.GRAYED_ATTRIBUTES)
        }
        // 变更计数（Q8=A；2026-11-15 反馈压缩：零值省略）——只提交→「N 提交」，只未提交
        // →「M 未提交」，两者都有才双段；都空整段消失
        val changes = entry.changes
        if (changes != null && (changes.commits.isNotEmpty() || changes.uncommitted.isNotEmpty())) {
            presentation.addText(" · ", SimpleTextAttributes.GRAYED_ATTRIBUTES)
            if (changes.commits.isNotEmpty()) {
                presentation.addText(
                    ZCodeBundle.message("worktree.changes.node.commits", changes.commits.size),
                    SimpleTextAttributes.GRAYED_ATTRIBUTES,
                )
                if (changes.uncommitted.isNotEmpty()) presentation.addText(" · ", SimpleTextAttributes.GRAYED_ATTRIBUTES)
            }
            if (changes.uncommitted.isNotEmpty()) {
                presentation.addText(
                    ZCodeBundle.message("worktree.changes.node.uncommitted", changes.uncommitted.size),
                    SimpleTextAttributes.GRAYED_ATTRIBUTES,
                )
            }
        }
        // 已合并标识 → 绿勾 + 悬浮说明（2026-11-15 反馈压缩定案：文字换字形，去向与口径
        // 进 tooltip；patch 等价口径，unmergedShas 非 null 才可判：全合并=✓，部分合并 ✓n/m）
        val commits = changes?.commits.orEmpty()
        val unmerged = entry.unmergedShas
        if (commits.isNotEmpty() && unmerged != null) {
            val mergedCount = commits.count { it.sha !in unmerged }
            if (mergedCount == commits.size) {
                presentation.addText("  ✓", MERGED_ATTRIBUTES)
                presentation.setTooltip(ZCodeBundle.message("worktree.merge.tooltip", refName ?: "HEAD"))
            } else if (mergedCount > 0) {
                presentation.addText("  ✓$mergedCount/${commits.size}", MERGED_ATTRIBUTES)
                presentation.setTooltip(
                    ZCodeBundle.message("worktree.merge.partial.tooltip", mergedCount, commits.size, refName ?: "HEAD"),
                )
            }
        }
        // 目录修改时间（2026-11-14 反馈：样式同提交行相对时间）——副本最近在根层级
        // 有过文件增删的粗粒度参考，两空格灰字缀在行尾（状态角标之前）
        entry.mtimeMs?.let {
            presentation.addText("  " + worktreeRelTime(it / 1000), SimpleTextAttributes.GRAYED_ATTRIBUTES)
        }
        presentation.setIcon(AllIcons.Nodes.Folder)
        if (entry.state != "ok") {
            presentation.addText(" ⚠", SimpleTextAttributes.ERROR_ATTRIBUTES)
        } else if (entry.dirty == true) {
            presentation.addText(" •", SimpleTextAttributes.GRAYED_ATTRIBUTES)
        }
    }

    /** 展开子树：提交组 + 未提交组（两段皆空 = 叶子，不渲染空组） */
    override fun getChildren(): MutableCollection<out AbstractTreeNode<*>> {
        val changes = entry.changes ?: return mutableListOf()
        val out = mutableListOf<AbstractTreeNode<*>>()
        if (changes.commits.isNotEmpty()) {
            out.add(WorktreeCommitGroupNode(project!!, entry, viewSettings, out.size))
        }
        if (changes.uncommitted.isNotEmpty()) {
            out.add(WorktreeUncommittedGroupNode(project!!, entry, viewSettings, out.size))
        }
        return out
    }

    /**
     * 暴露虚拟文件：ProjectView 选择数据 → VIRTUAL_FILE 通路，右键动作的可靠数据源。
     * （负结论 2026-11-14：试图不供文件让平台「新建/剪切」整簇隐藏——实测藏不掉，
     * 菜单数据上下文另有供给源，白丢 selectedEntries 的 ③ 兜底，已回退。）
     */
    override fun getVirtualFile(): com.intellij.openapi.vfs.VirtualFile? =
        com.intellij.openapi.vfs.LocalFileSystem.getInstance().findFileByNioFile(entry.root)

    /** Q7=A：单击交给平台展开/收起；「在新窗口打开」走右键菜单 */
    override fun canNavigate(): Boolean = false
}

/** 提交组（Q1' 两段式上半）：提交行 = hash + 标题 + 相对时间，双击开整提交 diff。
 *  value=固定键（稳定身份；同父下与未提交组互异即可，跨父链不相遇） */
class WorktreeCommitGroupNode(
    project: Project,
    private val entry: WorktreeProjectState.Entry,
    private val viewSettings: ViewSettings,
    order: Int,
) : WorktreeNodeBase<String>(project, GROUP_KEY_COMMITS, viewSettings, order) {

    private val commits get() = entry.changes?.commits.orEmpty()

    override fun update(presentation: PresentationData) {
        presentation.presentableText = ZCodeBundle.message("worktree.changes.commits.group", commits.size)
    }

    override fun getChildren(): MutableCollection<out AbstractTreeNode<*>> =
        commits.mapIndexed { i, c -> WorktreeCommitNode(project!!, entry, c, viewSettings, i) }.toMutableList()

    override fun canNavigate(): Boolean = false
}

/** 未提交改动组（Q1' 两段式下半）：文件行 = 状态前缀 + 路径，双击开 HEAD→工作区 diff */
class WorktreeUncommittedGroupNode(
    project: Project,
    private val entry: WorktreeProjectState.Entry,
    private val viewSettings: ViewSettings,
    order: Int,
) : WorktreeNodeBase<String>(project, GROUP_KEY_UNCOMMITTED, viewSettings, order) {

    private val uncommitted get() = entry.changes?.uncommitted.orEmpty()

    override fun update(presentation: PresentationData) {
        presentation.presentableText = ZCodeBundle.message("worktree.changes.uncommitted.group", uncommitted.size)
    }

    override fun getChildren(): MutableCollection<out AbstractTreeNode<*>> =
        uncommitted.mapIndexed { i, f -> WorktreeFileNode(project!!, entry, f, viewSettings, i) }.toMutableList()

    override fun canNavigate(): Boolean = false
}

/**
 * 提交行（可展开，2026-11-14 真机反馈：一次提交多文件，双击直开 diff 不合理——
 * 展开显示文件列表，再点单个文件看该文件 diff）；展开 = 该提交的文件行
 * （WorktreeFileNode 带 commit 上下文，旧侧=父提交）。
 */
class WorktreeCommitNode(
    project: Project,
    private val entry: WorktreeProjectState.Entry,
    val commit: GitWorktreeCli.CommitChange,
    private val viewSettings: ViewSettings,
    order: Int,
) : WorktreeNodeBase<String>(project, commit.sha, viewSettings, order) {

    override fun update(presentation: PresentationData) {
        presentation.clearText()
        presentation.addText(commit.sha.take(7) + "  ", SimpleTextAttributes.GRAYED_ATTRIBUTES)
        presentation.addText(commit.subject, SimpleTextAttributes.REGULAR_ATTRIBUTES)
        presentation.addText("  " + worktreeRelTime(commit.time), SimpleTextAttributes.GRAYED_ATTRIBUTES)
        // 已合并标识 → 绿勾 + 悬浮说明（2026-11-15 反馈压缩定案）：sha 不在未合并集 =
        // 已含于起点分支（含 patch 等价/上游可达）；未知（null）不标
        val unmerged = entry.unmergedShas
        if (unmerged != null && commit.sha !in unmerged) {
            presentation.addText("  ✓", MERGED_ATTRIBUTES)
            val target = entry.startRef?.takeIf { it.isNotEmpty() && it != "HEAD" }
                ?: entry.branchName ?: "HEAD"
            presentation.setTooltip(ZCodeBundle.message("worktree.merge.tooltip", target))
        }
    }

    override fun getChildren(): MutableCollection<out AbstractTreeNode<*>> =
        commit.files.mapIndexed { i, f -> WorktreeFileNode(project!!, entry, f, viewSettings, i, commit) }.toMutableList()

    override fun canNavigate(): Boolean = false
}

/** 文件行（叶子）；双击 → 单文件 diff（编辑器 tab）。commit 上下文决定旧侧：提交内=父提交，未提交=HEAD/磁盘。
 *  value=文件路径（稳定键）：状态变化（M→D 等）同键匹配，行样式原地更新不折叠。
 *  entry/commit 公开（右键「打开原文件」动作按节点取上下文，WorktreeOpenFileAction） */
class WorktreeFileNode(
    project: Project,
    val entry: WorktreeProjectState.Entry,
    val file: GitWorktreeCli.FileChange,
    private val viewSettings: ViewSettings,
    order: Int,
    val commit: GitWorktreeCli.CommitChange? = null,
) : WorktreeNodeBase<String>(project, file.path, viewSettings, order) {

    override fun update(presentation: PresentationData) {
        // IDEA Commit 工具窗同款（2026-11-14 三轮反馈 Q1'）：文件类型图标 + VCS 状态色，
        // 删除走删除线；不做文字状态前缀。
        // 图标源 = 提交面板同一条链 VcsUtil.getIcon（2026-11-14 真机：PyCharm 无 Kotlin
        // 插件，.kt 靠 TextMate 兜底类型的 fileTypeDetector/fileIconProvider 识别——只认
        // 真实 VFS 文件，按名查 FileTypeManager 得 Unknown 问号）：VFS 真文件走
        // IconUtil→FileIconProvider 扩展链，未收录按名兜底；托管根文件的 VFS 拉取由
        // WorktreeProjectState.rebuild 后台 refreshIoFiles 负责，图标下一轮渲染补齐
        val fileName = displayPath(file).substringAfterLast('/')
        val icon = project?.let { p ->
            runCatching {
                com.intellij.vcsUtil.VcsUtil.getIcon(p, com.intellij.vcsUtil.VcsUtil.getFilePath(entry.root.resolve(file.path).toFile()))
            }.getOrNull()
        } ?: FileTypeManager.getInstance().getFileTypeByFileName(fileName).icon
        presentation.setIcon(icon)
        presentation.addText(displayPath(file), statusAttributes(file.status))
    }

    override fun getChildren(): MutableCollection<out AbstractTreeNode<*>> = mutableListOf()

    override fun canNavigate(): Boolean = true

    override fun navigate(requestFocus: Boolean) {
        val project = project ?: return
        WorktreeDiffOpener.openFileDiff(project, entry, file, commit)
    }

    private fun displayPath(f: GitWorktreeCli.FileChange): String =
        if (f.oldPath != null) ZCodeBundle.message("worktree.changes.rename", f.oldPath, f.path) else f.path

    /** IDEA VCS 状态色（平台维护、暗色主题自动适配）；删除同款删除线 */
    private fun statusAttributes(status: Char): SimpleTextAttributes = when (status) {
        'A' -> SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, com.intellij.openapi.vcs.FileStatus.ADDED.color)
        'D' -> SimpleTextAttributes(SimpleTextAttributes.STYLE_STRIKEOUT, com.intellij.openapi.vcs.FileStatus.DELETED.color)
        'M', 'R', 'C' -> SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, com.intellij.openapi.vcs.FileStatus.MODIFIED.color)
        else -> SimpleTextAttributes.GRAYED_ATTRIBUTES
    }
}

/** 相对时间（提交行/节点目录时间共用）：四档文案，超月落 yyyy/MM/dd 绝对日期 */
internal fun worktreeRelTime(unixSeconds: Long): String {
    val minutes = (System.currentTimeMillis() - unixSeconds * 1000) / 60_000
    return when {
        minutes < 1 -> ZCodeBundle.message("worktree.changes.time.justNow")
        minutes < 60 -> ZCodeBundle.message("worktree.changes.time.minutes", minutes)
        minutes < 60 * 24 -> ZCodeBundle.message("worktree.changes.time.hours", minutes / 60)
        minutes < 60L * 24 * 30 -> ZCodeBundle.message("worktree.changes.time.days", minutes / (60 * 24))
        else -> java.text.SimpleDateFormat("yyyy/MM/dd").format(java.util.Date(unixSeconds * 1000))
    }
}
