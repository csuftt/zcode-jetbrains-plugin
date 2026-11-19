package com.zcode.ideaplugin.worktree

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project
import com.zcode.ideaplugin.ui.ZCodeLinkedWorkspaces
import com.zcode.ideaplugin.zCodeService
import java.nio.file.Path
import kotlin.io.path.exists

/**
 * worktree 项目态持有（0.4.6）：门控探测结果 + 托管 worktree 快照，全部后台线程计算、
 * ProjectView 树构建（EDT）只读缓存——绝不阻塞 EDT（git 子命令/RPC 都不允许进树构建）。
 *
 * 生命周期：webview 待命条首次 worktreeState 拉取（ getClient 懒建后）触发 [probeAsync]；
 * 探测完成即 [refreshAsync] 并刷新 ProjectView。支持态为进程级结论（client 实例缓存）。
 */
@Service(Service.Level.PROJECT)
class WorktreeProjectState(private val project: Project) {

    data class Entry(
        val root: Path,
        val sourceDir: Path,
        val bucket: String,
        val name: String,
        val headSha: String?,
        val branchName: String?,
        val dirty: Boolean?,
        val state: String,
        val origin: String,
        val startRef: String?,
        val startSha: String?,
        /**
         * 起点以来变更（提交+未提交两段，2026-11-14 树内展开；快照后台现算）。
         * null = 无法确定起点或查询失败——节点不渲染计数、不展开子树。
         */
        val changes: GitWorktreeCli.ChangesSince? = null,
        /**
         * 相对起点分支的未合并提交 sha 集（2026-11-14 已合并标识；patch 等价口径，
         * cherry-pick/rebase 落地也算已合并）。null = 无法判断（无起点分支/起点为
         * HEAD/查询失败）——节点不渲染合并标识。
         */
        val unmergedShas: Set<String>? = null,
        /**
         * worktree 根目录文件系统修改时间（2026-11-14 反馈：节点尾部相对时间，样式同
         * 提交行）——副本最近在根层级有过文件增删/创建时刻的粗粒度参考；missing=null。
         */
        val mtimeMs: Long? = null,
        /**
         * 推断创建起点 sha（2026-11-16：worktree 专属 HEAD reflog 首条，全零 from 校验，
         * 见 [GitWorktreeCli.creationBaseSha]）。注册表 startSha 缺失（桌面端建的副本/
         * 自愈补登记条目）时「基于 xxx」的展示数据源；null=reflog 缺失或非创建条目，
         * 维持起点未知不显示。只供展示，不进变更列表口径（游离口径不受影响，四轮教训保持）。
         */
        val inferredBaseSha: String? = null,
    )

    data class SourceGroup(val name: String, val dir: Path, val entries: List<Entry>)

    /** null = 未探测；探测完成前 ProjectView 不渲染 ZCGUIWorktrees 节点 */
    @Volatile
    var supported: Boolean? = null
        private set

    @Volatile
    var groups: List<SourceGroup> = emptyList()
        private set

    @Volatile
    private var polling = false

    companion object {
        /** 变更快照轮询间隔（15s；每 wt 约 4 条并行 git，后台无感。30s 太慢——2026-11-15
         *  反馈「盯 AI 干活」计数跟不上；事件驱动覆盖回合尾，轮询兜底回合中落盘的提交） */
        private const val POLL_INTERVAL_MS = 15_000L

        fun getInstance(project: Project): WorktreeProjectState =
            project.getService(WorktreeProjectState::class.java)
    }

    fun isSupported(): Boolean = supported == true

    /** 后台探测门控（client 实例级缓存，重复调用零 RPC）；完成自动刷新快照 + ProjectView + 轮询 */
    fun probeAsync() {
        if (supported != null) {
            if (supported == true && groups.isEmpty()) refreshAsync()
            return
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            val ok = runCatching { project.zCodeService().getClient().isWorktreeSupported() }.getOrDefault(false)
            supported = ok
            if (ok) refreshAsync() else fireProjectViewRefresh()
        }
    }

    /**
     * 30s 轮询循环（2026-11-14 树内变更计数/列表定案 Q2=B）：「盯 AI 干活」要求计数活着，
     * Commit 工具窗同款自动刷新心智。单线程 sleep 循环（project 关闭/门控失效即退出），
     * rebuild 幂等、与显式 refreshAsync 并发重入无害（快照整体替换）。
     */
    private fun ensurePolling() {
        if (polling) return
        synchronized(this) {
            if (polling) return
            polling = true
            ApplicationManager.getApplication().executeOnPooledThread {
                try {
                    while (!project.isDisposed && supported == true) {
                        Thread.sleep(POLL_INTERVAL_MS)
                        if (project.isDisposed || supported != true) break
                        runCatching { rebuild() }.onFailure {
                            println("[WorktreeProjectState] poll refresh failed: ${it.message}")
                        }
                    }
                } finally {
                    polling = false
                }
            }
        }
    }

    /** 后台重建快照：本项目 + 关联目录各扫一遍托管 worktree（git worktree list ∩ 托管根）；顺带确保轮询在跑 */
    fun refreshAsync() {
        ensurePolling()
        ApplicationManager.getApplication().executeOnPooledThread {
            runCatching { rebuild() }.onFailure {
                println("[WorktreeProjectState] refresh failed: ${it.message}")
            }
        }
    }

    @Volatile
    private var eventRebuildWaiting = false

    /**
     * 回合结束事件驱动的重建请求（2026-11-15 反馈：提交刷新太慢）：提交通常落在回合尾，
     * worktree 会话回合结束即刻重建，计数/列表秒级跟上。1.5s 合流窗口把多标签同事件/
     * 连环回合的触发并成一发尾随重建——窗口关闭时刻晚于最后一个提交（提交先于其回合
     * 结束事件），常发场景零漏；极端竞态（提交恰落在在途 rebuild 的 git 扫描中间）由
     * 15s 轮询兜底。全量 rebuild 对多面板重复触发天然幂等，此门只防 git 子进程浪费。
     */
    fun requestEventRebuild() {
        synchronized(this) {
            if (eventRebuildWaiting) return
            eventRebuildWaiting = true
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                Thread.sleep(1_500)
            } catch (_: InterruptedException) {
                return@executeOnPooledThread
            }
            synchronized(this) { eventRebuildWaiting = false }
            if (project.isDisposed || supported != true) return@executeOnPooledThread
            runCatching { rebuild() }.onFailure {
                println("[WorktreeProjectState] event rebuild failed: ${it.message}")
            }
        }
    }

    private fun rebuild() {
        val cli = GitWorktreeCli(gitExe = WorktreeGits.executablePath(project), timeoutMs = 20_000L)
        val dataBase = cli.dataBaseDir()
        val registry = WorktreeRegistry(project)
        val sources = linkedMapOf<String, Path>()
        // 本项目分组名=真实目录名（2026-11-13 反馈：不要「本目录」这种相对叫法）
        project.basePath?.let {
            sources[Path.of(it).fileName?.toString() ?: it] = Path.of(it)
        }
        for (ws in runCatching { ZCodeLinkedWorkspaces.read(project) }.getOrDefault(emptyList())) {
            if (sources.values.none { sameDir(it, ws) }) sources[Path.of(ws).fileName?.toString() ?: ws] = Path.of(ws)
        }
        // 第一遍：基础快照（worktree list ∩ 托管根 + 注册表合并），变更占位
        data class Draft(val group: String, val dir: Path, val regStartSha: String?, val entry: Entry)
        val drafts = mutableListOf<Draft>()
        // 注册表一次读全（此前每个 worktree 都 list() 一遍，JSON 重复解析）
        val regEntries = registry.list()
        for ((name, dir) in sources) {
            if (!dir.exists()) continue
            for (e in cli.listManagedWorktrees(dir, dataBase)) {
                val normRoot = WorktreeRegistry.normalize(e.path.toString())
                val reg = regEntries.firstOrNull { WorktreeRegistry.normalize(it.worktreeRoot) == normRoot }
                drafts.add(
                    Draft(
                        name, dir, reg?.startSha?.takeIf { it.isNotEmpty() },
                        Entry(
                            root = e.path,
                            sourceDir = dir,
                            bucket = e.bucket,
                            name = e.name,
                            headSha = e.headSha,
                            branchName = e.branchName,
                            dirty = e.dirty,
                            state = e.state,
                            origin = if (reg != null) "plugin" else "desktop",
                            startRef = reg?.startRef,
                            startSha = reg?.startSha,
                            mtimeMs = if (e.state == "ok") runCatching {
                                java.nio.file.Files.getLastModifiedTime(e.path).toMillis()
                            }.getOrNull() else null,
                        ),
                    )
                )
            }
        }
        // 注册表自愈（2026-11-16 真机：旧版「删除 worktree 清注册表」清掉的条目救不回来，
        // 会话页/归档页/右键菜单等全部注册表消费点断供）——任务索引托管行解析仓库名命中
        // 本项目源目录名集合且注册表缺条目时补登记（归属=同目录名源目录；启发式，同仓库
        // 名跨项目误归属仅影响显示归位不损数据；新包删除已不清注册表，只救历史孤儿）
        healRegistry(sources, registry, dataBase)

        // 空桶清扫（2026-11-15 反馈）：删除时目录被 IDE 句柄占用实时删不掉，残留空桶干扰        // 托管根——每次 rebuild 顺带扫一遍：非活跃桶且整树无任何文件（纯空目录壳）才自底
        // 向上移除；活跃 worktree 的桶必含文件（至少 .git 指针）天然跳过。锁释放后（含
        // 重启后首次 rebuild）一个轮询周期内自动收走，无需重启或手动清理
        val managedRoot = cli.managedRoot(dataBase)
        val liveBuckets = drafts.mapNotNull { d ->
            runCatching { managedRoot.relativize(d.entry.root).getName(0).toString().lowercase() }.getOrNull()
        }.toSet()
        val swept = runCatching { sweepEmptyWorktreeBuckets(managedRoot, liveBuckets) }.getOrDefault(emptyList())
        if (swept.isNotEmpty()) {
            println("[WorktreeProjectState] swept empty buckets: ${swept.joinToString { it.fileName.toString() }}")
        }
        // 第二遍：变更查询并行（2026-11-14 反馈：串行每 wt 4 条 git 命令，十几个副本
        // 全量 rebuild 要十几秒，删除后树迟迟不收敛）——worktree list 已给 headSha，
        // 复用传入省一条 rev-parse
        val latch = java.util.concurrent.CountDownLatch(drafts.size)
        val changesByRoot = java.util.concurrent.ConcurrentHashMap<Path, GitWorktreeCli.ChangesSince?>()
        val unmergedByRoot = java.util.concurrent.ConcurrentHashMap<Path, Set<String>>()
        val baseByRoot = java.util.concurrent.ConcurrentHashMap<Path, String>()
        for (draft in drafts) {
            ApplicationManager.getApplication().executeOnPooledThread {
                val changes = if (draft.entry.state == "ok") {
                    runCatching {
                        cli.listChangesSince(draft.entry.root, draft.regStartSha, knownHeadSha = draft.entry.headSha)
                    }.getOrNull()
                } else {
                    null
                }
                // CHM 不允许 null value（删除中的 worktree 查询失败=null 会 NPE）；缺失键查找侧本就返回 null，语义不变
                if (changes != null) changesByRoot[draft.entry.root] = changes
                // 未合并集（已合并标识）：起点须是真实分支（"HEAD" 游离无从比对），一条 cherry 顺带逐提交结论
                val startRef = draft.entry.startRef?.takeIf { it.isNotBlank() && it != "HEAD" }
                val unmerged = if (draft.entry.state == "ok" && startRef != null && draft.entry.headSha != null) {
                    runCatching {
                        cli.unmergedCommitShas(draft.entry.root, startRef, draft.entry.headSha)
                    }.getOrNull()
                } else {
                    null
                }
                if (unmerged != null) unmergedByRoot[draft.entry.root] = unmerged
                // 创建起点推断（2026-11-16）：注册表无 startSha 的条目（桌面端建的副本）
                // 读 worktree 专属 HEAD reflog 首条；一次文件读，搭既有并行批次零额外轮次
                if (draft.regStartSha == null && draft.entry.state == "ok") {
                    runCatching { cli.creationBaseSha(draft.entry.root) }.getOrNull()
                        ?.let { baseByRoot[draft.entry.root] = it }
                }
                latch.countDown()
            }
        }
        latch.await(30, java.util.concurrent.TimeUnit.SECONDS)
        val out = drafts.groupBy { it.group }.map { (name, list) ->
            // 节点从新到旧（2026-11-15 反馈）：最近活跃=最近提交时间（committer，%ct）∪
            // 根目录 mtime（AI 改文件不动根 mtime、新副本无提交，两取其大）；都缺排最后
            SourceGroup(name, list.first().dir, list.map { d ->
                d.entry.copy(
                    changes = changesByRoot[d.entry.root],
                    unmergedShas = unmergedByRoot[d.entry.root],
                    inferredBaseSha = baseByRoot[d.entry.root],
                )
            }.sortedByDescending { e ->
                maxOf(e.mtimeMs ?: 0L, e.changes?.commits?.maxOfOrNull { it.time } ?: 0L)
            })
        }
        groups = out
        // 变更文件拉进 VFS（2026-11-14 图标定案）：托管根在项目外（<dataBaseDir>/.zcode/worktrees），
        // 窗口 VFS 默认不知晓，而提交面板同款图标链（VcsUtil.getIcon→IconUtil→FileIconProvider，
        // PyCharm 下 .kt 的 TextMate 兜底紫色 K 就在 provider 里）需要 VFS 真文件才走得到——
        // 此处异步批量刷新；VFS 事件自动重绘树补图标；已收录路径跳过，收敛后此处零刷新。
        // 'D' 状态文件磁盘已无，refresh 无效走按名兜底，可接受
        val lfs = com.intellij.openapi.vfs.LocalFileSystem.getInstance()
        val candidates = LinkedHashSet<java.io.File>()
        for (d in drafts) {
            val ch = changesByRoot[d.entry.root] ?: continue
            val root = d.entry.root
            for (f in ch.uncommitted) candidates.add(root.resolve(f.path).toFile())
            for (c in ch.commits) for (f in c.files) candidates.add(root.resolve(f.path).toFile())
        }
        val missing = candidates.filter {
            java.nio.file.Files.exists(it.toPath()) && lfs.findFileByNioFile(it.toPath()) == null
        }
        if (missing.isNotEmpty()) {
            runCatching { lfs.refreshIoFiles(missing, true, false, null) }
                .onFailure { println("[WorktreeProjectState] vfs refresh failed: ${it.message}") }
        }
        fireProjectViewRefresh()
    }

    /**
     * 删除/清理后的乐观移除（2026-11-14 反馈：全量 rebuild 带变更查询要十几秒，
     * 树迟迟不移除）：直接从快照摘除并刷树，后台 rebuild 照常校准。
     */
    fun removeEntry(worktreeRoot: String) {
        val norm = WorktreeRegistry.normalize(worktreeRoot)
        groups = groups.mapNotNull { g ->
            val kept = g.entries.filter { WorktreeRegistry.normalize(it.root.toString()) != norm }
            if (kept.isEmpty()) null else SourceGroup(g.name, g.dir, kept)
        }
        fireProjectViewRefresh()
    }

    private fun fireProjectViewRefresh() {
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            runCatching {
                com.intellij.ide.projectView.ProjectView.getInstance(project).refresh()
            }
        }
    }

    /** 注册表自愈：任务索引托管行（wr 非空）仓库名命中源目录名且注册表缺条目 → 补登记 */
    private fun healRegistry(sources: Map<String, Path>, registry: WorktreeRegistry, dataBase: Path) {
        val client = runCatching { project.zCodeService().getClient() }.getOrNull() ?: return
        val rows = runCatching { client.taskIndex.listWorktreeTasks() }.getOrDefault(emptyList())
        if (rows.isEmpty()) return
        val cli = GitWorktreeCli(gitExe = WorktreeGits.executablePath(project), timeoutMs = 8_000L)
        for (row in rows) {
            val wr = row.worktreeRoot ?: continue
            if (registry.findBySession(row.taskId) != null) continue
            val parsed = runCatching { cli.parseManagedWorktreePath(dataBase, Path.of(wr)) }.getOrNull() ?: continue
            val source = sources[parsed.name] ?: continue
            // 缺陷HU：注册表已全局化，按目录名猜写会让同名仓库的条目跨项目扩散——
            // git 反解必须确认副本属于当前源目录所在仓库才登记（同名克隆不互认）
            val resolved = runCatching { registry.resolveSourceWorkspace(wr) }.getOrNull() ?: continue
            val sourceTop = runCatching { cli.toplevel(source) }.getOrNull() ?: continue
            if (WorktreeRegistry.normalize(resolved) != WorktreeRegistry.normalize(sourceTop.toString())) continue
            registry.upsert(
                WorktreeRegistryStore.WorktreeSessionInfo(
                    sessionId = row.taskId,
                    worktreeRoot = wr,
                    cwd = row.rootPath ?: row.workspacePath,
                    sourceWorkspace = source.toString(),
                    startRef = "", startSha = "",
                    bucket = parsed.bucket,
                    createdAt = row.updatedAt,
                ),
            )
        }
    }

    private fun sameDir(a: Path, b: String): Boolean = sameDir(a, Path.of(b))

    private fun sameDir(a: Path, b: Path): Boolean {
        val an = a.toAbsolutePath().normalize().toString()
        val bn = b.toAbsolutePath().normalize().toString()
        val win = System.getProperty("os.name").lowercase().contains("windows")
        return if (win) an.equals(bn, ignoreCase = true) else an == bn
    }
}

/**
 * 托管根空桶清扫（2026-11-15 反馈）：删除 worktree 时目录被 IDE 句柄占用实时删不掉，
 * 桶目录（4 位 hex）残留。规则：
 * - 只动 [managedRoot] 直下名字为 4 位 hex 的目录（防误伤 .metadata_never_index 等无关物）；
 * - 活跃桶（[liveBuckets]，快照里现存 worktree 的桶）直接跳过，省得白走大目录树；
 * - 桶内整树**无任何文件**（纯空目录壳，含多层空目录）才自底向上移除；任何一层有文件
 *   或删除失败（占用/权限）整体放弃并保留现场——保守口径，绝不碰含文件的桶。
 *
 * @return 实际移除的桶目录列表（调用方仅用于日志）
 */
internal fun sweepEmptyWorktreeBuckets(managedRoot: Path, liveBuckets: Set<String>): List<Path> {
    if (!java.nio.file.Files.isDirectory(managedRoot)) return emptyList()
    val removed = mutableListOf<Path>()
    runCatching {
        java.nio.file.Files.list(managedRoot).use { stream ->
            for (bucket in stream.filter { java.nio.file.Files.isDirectory(it) }.toList()) {
                val name = bucket.fileName.toString()
                if (!name.matches(Regex("^[0-9a-f]{4}$"))) continue
                if (name in liveBuckets) continue
                if (removeIfEmptyTree(bucket)) removed.add(bucket)
            }
        }
    }
    return removed
}

/** 自底向上删纯目录树：桶/子项自身是符号链接直接放弃（isDirectory 跟随链接，空目标会被误判为空壳）；遇文件即放弃 */
private fun removeIfEmptyTree(dir: Path): Boolean {
    if (java.nio.file.Files.isSymbolicLink(dir)) return false
    val children = runCatching { java.nio.file.Files.list(dir).use { it.toList() } }.getOrNull() ?: return false
    for (c in children) {
        if (java.nio.file.Files.isSymbolicLink(c)) return false
        if (java.nio.file.Files.isDirectory(c)) {
            if (!removeIfEmptyTree(c)) return false
        } else {
            return false
        }
    }
    return runCatching { java.nio.file.Files.deleteIfExists(dir) }.getOrDefault(false)
}
