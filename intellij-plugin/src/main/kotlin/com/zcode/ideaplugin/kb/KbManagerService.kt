package com.zcode.ideaplugin.kb

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.Disposable
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.zcode.ideaplugin.ZCodeBundle
import com.zcode.kb.core.KbContent
import com.zcode.kb.core.KbEntry
import com.zcode.kb.core.KbExtractor
import com.zcode.kb.core.KbFolder
import com.zcode.kb.core.KbTagMeta
import com.zcode.kb.core.KbFilter
import com.zcode.kb.core.KbGitCli
import com.zcode.kb.core.KbHit
import com.zcode.kb.core.KbPaths
import com.zcode.kb.core.KbFileStore
import com.zcode.kb.core.KbSync
import git4idea.config.GitExecutableManager
import java.nio.file.Files
import java.nio.file.Path

/**
 * 知识库应用级服务：私有库连接的持有者 + 收录/摘除/重新链接 + 轮询对账（sweep）+ 同步 + 库位置。
 *
 * - 收录：文件留原地，提取文本进检索缓存，同时落一份文档快照（源文件原始字节，见
 *   [KbContent]）；git 仓内的文件顺带取仓根名作 project；
 * - sweep：10 秒一轮（库内无文件监听，沿用轮询惯例）——按内容哈希对账，源文件变了就
 *   重提取并覆盖文档快照；源文件不在的条目退到文档快照，回来后自动改回读源文件；
 * - 同步：整个库目录是一个 git 仓库，[syncNow] 提交并推送；对账与同步互斥；
 * - 库位置：[changeLocation] 整体搬迁，系统盘的入口路径不变；
 * - 全库红线：只碰知识库目录，绝不读写 zcode 的 db.sqlite/tasks-index.sqlite。
 *
 * 锁：本服务实例锁管库连接的建立与库位置迁移（迁移期间不让任何人拿到旧连接）；
 * [ioLock] 管对账与同步的互斥。持有 ioLock 时不调本服务的 synchronized 方法（否则与
 * 迁移形成锁序反转）：连接先取，再进 ioLock。
 */
@Service(Service.Level.APP)
class KbManagerService : Disposable {

    private val log = Logger.getInstance(KbManagerService::class.java)

    @Volatile
    private var store: KbFileStore? = null

    @Volatile
    private var sweepStarted = false

    @Volatile
    private var disposed = false

    /** 对账与同步互斥（同步执行期间对账不写盘）；改库位置也要拿它 */
    private val ioLock = Any()

    /** 最近一次解析到的 git 可执行路径（项目里可能配了自定义 git）；无项目上下文的调用沿用它 */
    @Volatile
    private var gitExe: String = "git"

    init {
        // 知识库开关实时同步工具窗可用性（缺陷HW-2/HW续二轮）：订阅挂 APP 级服务而非
        // ProjectActivity——动态插件重载不重跑 ProjectActivity，服务重建会重跑 init；
        // 遍历 openProjects 兜覆盖「窗口从未实例化」的项目（无面板订阅者按钮会残留）。
        // setAvailable 是 Swing 状态必须 EDT（第一轮 pooled 直调静默失败真机实证）。
        ApplicationManager.getApplication().messageBus.connect(this).subscribe(
            KbTopics.KB_SWITCHED,
            object : KbSwitchListener {
                override fun kbSwitched(enabled: Boolean) {
                    if (disposed) return
                    ApplicationManager.getApplication().invokeLater {
                        for (p in ProjectManager.getInstanceIfCreated()?.openProjects ?: emptyArray()) {
                            runCatching {
                                ToolWindowManager.getInstance(p)
                                    .getToolWindow(KbFeature.TOOLWINDOW_ID)
                                    ?.setAvailable(enabled, null)
                            }
                        }
                    }
                }
            },
        )
        // skill 启动对齐（默认开 + 存量升级没人调 setEnabled）：开=幂等重装（随包刷新
        // 内容）、关=清除；APP 级单点，不挂 ProjectActivity（动态重载不重跑且多项目重复）
        runCatching { KbFeature.syncSkillOnStartup() }
            .onFailure { log.warn("Knowledge Base: skill sync failed: ${it.message}") }
        // 入口对齐：库位置自定义后入口是指向库目录的联接，联接被删 / 指针文件缺失时在这里修复
        runCatching { KbPaths.ensureEntry() }
            .onSuccess { if (KbPaths.isCustomized()) log.info("Knowledge Base: library at $it") }
            .onFailure { log.warn("Knowledge Base: entry alignment failed: ${it.message}") }
        // 库目录文件监听（MCP server/外部进程写 → 面板秒级刷新，不再等 sweep）；
        // 同为 APP 级单点（多项目重复注册 watcher 会多路广播）
        runCatching { startWatcher() }
            .onFailure { log.warn("Knowledge Base: watcher start failed: ${it.message}") }
    }

    companion object {
        val instance: KbManagerService
            get() = ApplicationManager.getApplication().getService(KbManagerService::class.java)

        /** 收录时的标签清洗：去逗号/引号/首尾空白，去重，丢空 */
        fun sanitizeTags(tags: List<String>): List<String> = tags
            .map { it.trim().replace(',', ' ').replace('"', ' ').replace('，', ' ').trim() }
            .filter { it.isNotEmpty() }
            .distinct()
            .take(20)

        /** IDE 侧的文本提取（对账、重建检索缓存用），与收录同一个提取器 */
        private val EXTRACTOR = KbContent.TextExtractor { KbExtractor.extract(it) }
    }

    @Synchronized
    fun store(): KbFileStore {
        store?.let { return it }
        val s = KbFileStore(KbPaths.rootDir())
        store = s
        Disposer.register(this) { runCatching { s.close() } }
        return s
    }

    /** 注入门控用：空库不注入（懒开连接，毫秒级） */
    fun entryCount(): Int = try {
        store().entryCount()
    } catch (e: Exception) {
        log.warn("Knowledge Base: entryCount failed: ${e.message}")
        0
    }

    // ───────────────────────── 收录 / 摘除 ─────────────────────────

    /** 单文件收录（弹窗确认后调用）。返回入库条目；提取失败仍收录（仅元数据参与检索）。 */
    fun ingest(
        file: Path,
        title: String,
        folderId: String,
        tags: List<String>,
        notes: String,
        project: Project? = null,
    ): KbEntry? {
        if (!Files.isRegularFile(file)) return null
        val s = store()
        val display = KbFileStore.displayPath(file.toString())
        s.findBySource(display)?.let { existing ->
            // 重复收录 = 更新元数据（title/folder/tags/notes）+ 重新确认内容
            updateMeta(existing.id, title.ifBlank { existing.title }, folderId, tags, notes)
            captureQuietly(s, existing.id, file)?.let { s.confirmContent(existing.id, it.hash, it.size) }
            return s.getEntry(existing.id)
        }
        val text = KbExtractor.extract(file)
        val projectName = KbGitCli(gitExe = resolveGitExe(project)).repoRoot(file)?.fileName?.toString()
            ?: file.parent?.fileName?.toString() ?: ""
        val now = System.currentTimeMillis()
        // 确定性 id=路径指纹：摘除重加 id 恒定，外部引用稳定；taken=防 2^-40 碰撞的确定性派生
        val id = KbFileStore.newId(display, taken = s.allEntries().map { it.id }.toSet())
        // 收录即落文档快照；写不成不拦收录（contentHash 留空，对账首轮补齐）
        val captured = captureQuietly(s, id, file)
        val entry = KbEntry(
            id = id,
            sourcePath = display,
            title = title.ifBlank { file.fileName.toString() },
            folderId = folderId,
            tags = sanitizeTags(tags),
            notes = notes,
            project = projectName,
            fileExt = fileExtOf(file),
            sizeBytes = captured?.size ?: runCatching { Files.size(file) }.getOrDefault(0),
            contentHash = captured?.hash ?: "",
            ingestedAt = now,
            updatedAt = now,
        )
        s.insert(entry, text ?: "")
        log.info("Knowledge Base: ingested ${entry.id} <- $display (extract=${text != null}, snapshot=${captured != null})")
        KbTopics.publish(project)
        return entry
    }

    /** 元数据更新（title/folder/tags/notes） */
    fun updateMeta(id: String, title: String, folderId: String, tags: List<String>, notes: String): Boolean {
        val updated = store().transformEntry(id) { e ->
            e.copy(
                title = title.ifBlank { e.title },
                folderId = folderId,
                tags = sanitizeTags(tags),
                notes = notes,
                updatedAt = System.currentTimeMillis(),
            )
        }
        if (updated != null) KbTopics.publish(null)
        return updated != null
    }

    /**
     * 只改条目标签（标签子菜单增删标签用）：库锁内读最新条目再套 transform，调用方手里的
     * KbEntry 是菜单弹出时的快照——拿快照整条 updateMeta 会覆盖别的字段，或把连续点击刚
     * 加上的标签冲掉。@return 是否写盘（条目不存在 / 标签无变化 = false）
     */
    fun updateEntryTags(id: String, transform: (List<String>) -> List<String>): Boolean {
        val changed = store().updateTags(id) { sanitizeTags(transform(it)) }
        if (changed) KbTopics.publish(null)
        return changed
    }

    /** 源文件自己的提交状态（收录弹窗「Git 提交」行；后台线程调用——git 子进程不进 EDT）；文件不在返回 null */
    fun fileHistory(file: Path, project: Project? = null): KbGitCli.FileHistory? =
        runCatching { KbGitCli(gitExe = resolveGitExe(project)).historyOf(file) }.getOrNull()

    /** 摘除：删登记、检索缓存与文档快照，绝不动源文件 */
    fun remove(id: String): Boolean {
        store().removeEntry(id)
        log.info("Knowledge Base: removed $id")
        KbTopics.publish(null)
        return true
    }

    /** 条目改指新路径（重新链接）：以新源文件为准——重提取、重新落文档快照（随之改名）；id 不变 */
    fun relink(id: String, newPath: Path): KbEntry? {
        if (!Files.isRegularFile(newPath)) return null
        val s = store()
        val text = KbExtractor.extract(newPath)
        val captured = captureQuietly(s, id, newPath)
        val updated = s.transformEntry(id, text ?: "") { e ->
            e.copy(
                sourcePath = KbFileStore.displayPath(newPath.toString()),
                sizeBytes = captured?.size ?: runCatching { Files.size(newPath) }.getOrDefault(0),
                contentHash = captured?.hash ?: "",
                fileExt = fileExtOf(newPath),
                updatedAt = System.currentTimeMillis(),
            )
        }
        if (updated != null) KbTopics.publish(null)
        return updated
    }

    // ───────────────────────── 查询（供 UI / bridge ops） ─────────────────────────

    fun get(id: String): KbEntry? = store().getEntry(id)

    fun list(f: KbFilter = KbFilter()): List<KbEntry> = store().listEntries(f)

    fun folders(): List<KbFolder> = store().folders()

    fun folderPath(folderId: String): String = store().folderPath(folderId)

    fun tags(): List<String> = store().allTags()

    /** 标签注册表（名字+颜色） */
    fun tagMetas(): List<KbTagMeta> = store().tagMetas()

    /** 标签使用计数（管理对话框；含注册表无主标签 count=0） */
    fun tagCounts(): Map<String, Int> = store().tagCounts()

    /** 新建标签（注册表登记 + 自动分配颜色，优先未占用的色板色）。@return 颜色 */
    fun createTag(name: String): String {
        val s = store()
        val color = KbFileStore.pickTagColor(s.tagMetas())
        s.ensureTagMeta(name, color)
        return color
    }

    fun setTagColor(name: String, color: String) {
        store().setTagColor(name, color)
        KbTopics.publish(null)
    }

    /** 全局重命名标签。@return 改写条目数 */
    fun renameTag(from: String, to: String): Int = store().renameTag(from, to).also { if (it > 0) KbTopics.publish(null) }

    /** 从全部条目移除标签 + 注册表删除。@return 影响条目数 */
    fun deleteTag(name: String): Int = store().deleteTag(name).also { if (it > 0) KbTopics.publish(null) }

    fun projects(): List<String> = store().allProjects()

    fun createFolder(parentId: String?, name: String): String =
        store().createFolder(parentId, name).also { KbTopics.publish(null) }

    fun ensureFolderPath(path: String): String = store().ensureFolderPath(path) // 弹窗确认前建目录，不广播

    fun renameFolder(id: String, newName: String) {
        store().renameFolder(id, newName)
        KbTopics.publish(null)
    }

    /** @return false = 防环拒绝（目标在自身子树内） */
    fun moveFolder(id: String, newParentId: String?, insertIndex: Int = Int.MAX_VALUE): Boolean =
        store().moveFolder(id, newParentId, insertIndex).also { if (it) KbTopics.publish(null) }

    /** @return 移入根级的条目数（确认框文案用） */
    fun deleteFolder(id: String): Int =
        store().deleteFolder(id).also { if (it >= 0) KbTopics.publish(null) }

    /** 条目移动到目录尾部（右键「移动到…」用；拖拽精细落位走 [reorderEntries]） */
    fun moveEntries(ids: List<String>, targetFolderId: String) = reorderEntries(ids, targetFolderId)

    /** 条目拖拽移动 + 层内插位重排（insertIndex 默认尾部） */
    fun reorderEntries(ids: List<String>, targetFolderId: String, insertIndex: Int = Int.MAX_VALUE) {
        store().reorderEntries(ids, targetFolderId, insertIndex)
        KbTopics.publish(null)
    }

    fun search(query: String, f: KbFilter = KbFilter(), limit: Int = 50): List<KbHit> =
        store().search(query, f, limit)

    fun readText(id: String): String? = store().readText(id)

    // ───────────────────────── 解析（现在读哪个文件） ─────────────────────────

    /**
     * 解析规则（[KbContent.resolve]，IDE 侧所有读取出口共用）：源文件是普通文件读源文件；
     * 否则有文档快照读文档快照；否则失效。状态读取时现算。
     */
    fun resolve(e: KbEntry): KbContent.Resolved = resolveAll(listOf(e)).getValue(e.id)

    fun resolveAll(entries: List<KbEntry>): Map<String, KbContent.Resolved> {
        val root = store().root()
        return entries.associate { it.id to KbContent.resolve(root, it.id, it.sourcePath) }
    }

    // ───────────────────────── 库目录监听 ─────────────────────────

    private var watcherStarted = false
    private var watcher: java.nio.file.WatchService? = null

    /**
     * 库根文件监听（幂等）：MCP server 管理写（kb_add/kb_entry/kb_folder/kb_tag，独立
     * fork 进程无 MessageBus 可达）落盘 ATOMIC_MOVE 后秒级广播 KB_CHANGED 刷新面板。
     * IDE 自己的写也会触发（双广播，面板刷新幂等无害）；500ms 防抖聚合批量写。
     * 监听挂在库目录的真实路径上（入口联接后面那个目录）。
     */
    @Synchronized
    fun startWatcher() {
        if (watcherStarted || disposed) return
        val root = KbPaths.rootDir()
        val ws = runCatching { java.nio.file.FileSystems.getDefault().newWatchService() }.getOrNull() ?: return
        val kinds = arrayOf(
            java.nio.file.StandardWatchEventKinds.ENTRY_CREATE,
            java.nio.file.StandardWatchEventKinds.ENTRY_MODIFY,
            java.nio.file.StandardWatchEventKinds.ENTRY_DELETE,
        )
        runCatching {
            java.nio.file.Files.createDirectories(root.resolve(KbContent.ENTRIES_DIR))
            java.nio.file.Files.createDirectories(root.resolve(KbContent.TEXT_DIR))
            root.register(ws, *kinds)
            root.resolve(KbContent.ENTRIES_DIR).register(ws, *kinds)
            root.resolve(KbContent.TEXT_DIR).register(ws, *kinds)
        }.onFailure {
            runCatching { ws.close() }
            log.warn("Knowledge Base: watcher register failed: ${it.message}")
            return
        }
        watcher = ws
        watcherStarted = true
        ApplicationManager.getApplication().executeOnPooledThread {
            while (!disposed) {
                val key = runCatching { ws.take() }.getOrNull() ?: break
                var dirty = key.pollEvents().any {
                    it.kind() !== java.nio.file.StandardWatchEventKinds.OVERFLOW
                }
                runCatching { key.reset() }
                if (!dirty) continue
                // 防抖：批量收录/MCP 连环写聚合（静默 500ms 才广播一次）
                var quiet = false
                while (!quiet && !disposed) {
                    try {
                        Thread.sleep(500)
                    } catch (e: InterruptedException) {
                        return@executeOnPooledThread
                    }
                    val next = runCatching { ws.poll() }.getOrNull()
                    quiet = next == null
                    next?.let { runCatching { it.reset() } }
                }
                if (disposed) break
                try {
                    log.info("Knowledge Base: watcher fs change -> refresh")
                    KbTopics.publish(null)
                } catch (e: Exception) {
                    log.warn("Knowledge Base: watcher publish failed: ${e.message}")
                }
            }
        }
        log.info("Knowledge Base: library watcher started")
    }

    /**
     * 释放监听（改库位置前必须调用：Windows 上 WatchService 句柄锁目录，不释放则搬不动）。
     * close() 的底层句柄释放是异步的，调用方动盘前要留出窗口。
     */
    @Synchronized
    private fun stopWatcher() {
        runCatching { watcher?.close() }
        watcher = null
        watcherStarted = false
    }

    // ───────────────────────── sweep / 重建 ─────────────────────────

    /** 启动挂钩调用（幂等）：常驻轮询线程，项目全部关闭后随 dispose 退出 */
    @Synchronized
    fun startSweep() {
        if (sweepStarted || disposed) return
        sweepStarted = true
        ApplicationManager.getApplication().executeOnPooledThread {
            while (!disposed) {
                try {
                    sweepOnce()
                } catch (e: Exception) {
                    log.warn("Knowledge Base: sweep failed: ${e.message}")
                }
                try {
                    Thread.sleep(10_000) // 对账轻（命中本机缓存的条目只做几次 stat），10s 一轮兜底 watcher 丢事件
                } catch (e: InterruptedException) {
                    break
                }
            }
        }
        log.info("Knowledge Base: sweep loop started")
    }

    /** 结构指纹基线（watcher 丢事件的兜底对账：config/entries 任何外部写盘→广播刷新） */
    @Volatile
    private var lastStoreFingerprint: String? = null

    /** 上一轮各条目的解析状态（源文件回来/消失要刷新面板的标识） */
    @Volatile
    private var lastStates: Map<String, KbContent.State> = emptyMap()

    /** 库结构指纹：config.json 与 entries 目录全部 json 的 mtime:size 集合（目录树/条目增删改全感知） */
    private fun storeFingerprint(): String {
        val root = KbPaths.rootDir()
        fun sig(p: Path): String = try {
            "${Files.getLastModifiedTime(p).toMillis()}:${Files.size(p)}"
        } catch (e: Exception) {
            "gone"
        }
        val cfgSig = sig(root.resolve("config.json"))
        val entrySigs = try {
            Files.list(root.resolve(KbContent.ENTRIES_DIR)).use { st ->
                st.filter { Files.isRegularFile(it) }
                    .map { "${it.fileName}:${sig(it)}" }
                    .sorted()
                    .toList()
            }
        } catch (e: Exception) {
            emptyList<String>()
        }
        return cfgSig + "|" + entrySigs.joinToString(",")
    }

    /**
     * 单轮对账：源文件内容变了 → 重提取、覆盖文档快照、更新条目的内容哈希；检索缓存缺了
     * → 按解析规则重建；清孤儿快照与缓存。有实际动作或条目状态变了才广播，一轮只广播一次。
     * @return 本轮有实际动作的条目数
     */
    fun sweepOnce(): Int {
        // 结构对账兜底：MCP server（独立进程）写盘若被 watcher 丢事件，本轮指纹对比必发现并广播
        var published = false
        fun publish() {
            published = true
            KbTopics.publish(null)
        }
        val fp = storeFingerprint()
        if (lastStoreFingerprint != null && fp != lastStoreFingerprint) {
            log.info("Knowledge Base: structural change detected by sweep -> refresh")
            publish()
        }
        lastStoreFingerprint = fp
        val s = store() // 连接先取，再进 ioLock（见类注释的锁序）
        val activity = try {
            synchronized(ioLock) { reconcileLocked(s) { publish() } }
        } catch (e: Exception) {
            log.warn("Knowledge Base: reconcile failed: ${e.message}")
            0
        }
        // 对账自己也会写 entries 与文档快照——重算基线，下轮不自误报
        lastStoreFingerprint = storeFingerprint()
        // 「待同步」角标兜底：另一个 IDE 同步过、远端地址在别处改过——这些没有库文件事件可听，
        // 按指纹发现状态变了才重算；本轮已经广播过刷新的不重复（那次刷新会重算）
        val flipped = runCatching { pendingCache.flippedIfChanged(s.root(), gitExe) }.getOrDefault(false)
        if (!published && flipped) {
            log.info("Knowledge Base: sync pending changed -> refresh")
            publish()
        }
        return activity
    }

    /**
     * 对账一轮（调用方持 [ioLock]，且不能用拿到的连接再调本服务的 synchronized 方法）。
     * 有实际动作或条目状态变了调 [onChanged]（广播由调用方决定）。
     */
    private fun reconcileLocked(s: KbFileStore, onChanged: () -> Unit): Int {
        val root = s.root()
        val activity = KbContent.reconcile(
            root,
            s.contentSources(),
            EXTRACTOR,
        ) { id, hash, size -> s.confirmContent(id, hash, size) }
        val states = s.allEntries().associate { it.id to KbContent.resolve(root, it.id, it.sourcePath).state }
        val statesChanged = states != lastStates
        lastStates = states
        if (activity > 0 || statesChanged) {
            log.info("Knowledge Base: reconcile activity=$activity statesChanged=$statesChanged")
            onChanged()
        }
        return activity
    }

    /**
     * 全库重建检索缓存（设置页入口）：清空后按解析规则全量重提取——源文件在从源文件建，
     * 不在从文档快照建；失效条目清掉残留缓存。条目不动。
     * @return 重建出内容的条目数
     */
    fun reindexAll(): Int {
        val s = store()
        var ok = 0
        synchronized(ioLock) {
            s.clearIndex()
            for (src in s.contentSources()) {
                if (KbContent.rebuildText(s.root(), src.id, src.sourcePath, EXTRACTOR) != null) ok++
            }
        }
        log.info("Knowledge Base: reindexed $ok entries")
        KbTopics.publish(null)
        return ok
    }

    // ───────────────────────── 同步 ─────────────────────────

    /**
     * 执行一次同步（提交并推送整个知识库；拉取后立即对账，补齐检索缓存与文档快照）。
     * 失败抛 [KbSync.SyncException]，由调用方按 [KbSync.Failure] 出提示。
     */
    fun syncNow(project: Project?): KbSync.Result {
        val s = store()
        val result = synchronized(ioLock) { KbSync.sync(s.root(), resolveGitExe(project)) }
        if (result.pulled) {
            // 同步收尾统一广播一次（见下），这里的对账不单独广播
            runCatching { synchronized(ioLock) { reconcileLocked(s) { } } }
                .onFailure { log.warn("Knowledge Base: post-sync reconcile failed: ${it.message}") }
        }
        KbTopics.publish(null)
        return result
    }

    /**
     * 同步成功的结果文案。取回过远端变化时要说出来：只拉没推的那一次，目录树里多了东西，
     * 不能提示「没有需要同步的变化」。
     */
    fun syncResultMessage(r: KbSync.Result): String = when {
        r.outcome != KbSync.Outcome.PUSHED && r.pulled -> ZCodeBundle.message("kb.sync.pulled")
        r.outcome != KbSync.Outcome.PUSHED -> ZCodeBundle.message("kb.sync.upToDate")
        r.pulled -> ZCodeBundle.message("kb.sync.pulledAndPushed", r.pushedCommits)
        else -> ZCodeBundle.message("kb.sync.pushed", r.pushedCommits)
    }

    /**
     * 「待同步」：库里有未提交或未推送的变化（不是仓库 / 未配置远端 = false）。结果缓存 3 秒，
     * 但库内容或仓库状态一变就作废（[KbSync.PendingCache]）：刚同步完、刚改完条目的那次刷新
     * 不能再读到变化之前的旧结果，否则角标该灭不灭、该亮不亮。
     */
    private val pendingCache = KbSync.PendingCache(3_000)

    fun hasUnsyncedChanges(): Boolean = pendingCache.get(store().root(), gitExe)

    /** 同步失败的原因（给界面用的本地化文案）；conflicts 已并入文案 */
    fun syncFailureMessage(e: KbSync.SyncException): String = when (e.failure) {
        KbSync.Failure.NO_REMOTE -> ZCodeBundle.message("kb.sync.noRemote")
        KbSync.Failure.GIT_UNAVAILABLE -> ZCodeBundle.message("kb.sync.gitUnavailable")
        KbSync.Failure.WORKTREE_DIRTY -> ZCodeBundle.message("kb.sync.dirty")
        KbSync.Failure.CONFLICT ->
            if (e.conflicts.isEmpty()) {
                ZCodeBundle.message("kb.sync.conflictNoFiles")
            } else {
                ZCodeBundle.message(
                    "kb.sync.conflict",
                    e.conflicts.take(5).joinToString(", ") + if (e.conflicts.size > 5) "…" else "",
                )
            }
        KbSync.Failure.UNRELATED_HISTORIES -> ZCodeBundle.message("kb.sync.unrelated")
        KbSync.Failure.IDENTITY_MISSING -> ZCodeBundle.message("kb.sync.identity")
        else -> ZCodeBundle.message("kb.sync.failed", e.detail.ifBlank { e.toString() })
    }

    fun remoteUrl(): String? = runCatching { KbSync.remoteUrl(store().root(), gitExe) }.getOrNull()

    /** 库目录是否已经是 git 仓库（配置过远端或同步过） */
    fun isRepository(): Boolean = runCatching { KbSync.isRepository(store().root()) }.getOrDefault(false)

    /** 设置远端地址（空 = 清除）。@return null = 成功；非空 = 原因 */
    fun setRemoteUrl(url: String): String? = runCatching { KbSync.setRemoteUrl(store().root(), gitExe, url) }.getOrNull()

    // ───────────────────────── 库位置 ─────────────────────────

    /**
     * 把库位置改到 newDir（传入口路径 = 恢复默认）：关连接 → 释放目录监听 → 整体搬移 /
     * 接入既有仓库 → 入口重建 → 重挂监听。任一步失败回滚到原状。
     * 失败原因文案是消息键 kb.settings.location.fail 加原因后缀。
     *
     * @return null=成功；非空=给界面用的原因
     */
    @Synchronized
    fun changeLocation(newDir: Path): String? {
        val s = store()
        return synchronized(ioLock) {
            // 先关连接、再释放 watcher（句柄锁目录），然后才动盘
            s.close()
            store = null
            stopWatcher()
            try {
                // WatchService.close() 的底层目录句柄释放是异步的（Windows IOCP 线程退出+
                // CancelIo 有窗口），立即改名仍会撞锁（真机实证）——小睡等句柄落地
                Thread.sleep(300)
                when (val r = runCatching { KbPaths.relocate(newDir) }.getOrElse { e ->
                    KbPaths.Relocate.Rejected(KbPaths.RejectReason.MOVE_FAILED, e.toString())
                }) {
                    is KbPaths.Relocate.Done -> {
                        log.info("Knowledge Base: library location -> ${r.root}")
                        null
                    }
                    is KbPaths.Relocate.Rejected -> {
                        log.warn("Knowledge Base: relocate rejected: ${r.reason} ${r.detail ?: ""}")
                        rejectMessage(r)
                    }
                }
            } finally {
                // 成功失败 alike：按（可能已变的）当前位置重挂监听，面板重读
                runCatching { startWatcher() }
                    .onFailure { log.warn("Knowledge Base: watcher restart failed: ${it.message}") }
                lastStates = emptyMap()
                lastStoreFingerprint = null
                KbTopics.publish(null)
            }
        }
    }

    private fun rejectMessage(r: KbPaths.Relocate.Rejected): String = when (r.reason) {
        KbPaths.RejectReason.NOT_ABSOLUTE -> ZCodeBundle.message("kb.settings.location.fail.notAbsolute")
        KbPaths.RejectReason.NETWORK_PATH -> ZCodeBundle.message("kb.settings.location.fail.network")
        KbPaths.RejectReason.INSIDE_LIBRARY -> ZCodeBundle.message("kb.settings.location.fail.inside")
        KbPaths.RejectReason.LIBRARY_INSIDE_TARGET -> ZCodeBundle.message("kb.settings.location.fail.contains")
        KbPaths.RejectReason.TARGET_OCCUPIED -> ZCodeBundle.message("kb.settings.location.fail.occupied")
        KbPaths.RejectReason.CURRENT_NOT_EMPTY -> ZCodeBundle.message("kb.settings.location.fail.currentNotEmpty")
        KbPaths.RejectReason.LINK_UNSUPPORTED -> ZCodeBundle.message("kb.settings.location.fail.link")
        KbPaths.RejectReason.MOVE_FAILED -> ZCodeBundle.message(
            "kb.settings.location.fail.move",
            r.detail?.take(300) ?: "",
        )
    }

    /** 存储占用（bytes）：条目与配置 + 文档快照 + 检索缓存（不含版本历史） */
    fun storageBytes(): Long = metaBytes() + snapshotsBytes() + cacheBytes()

    /** 元数据占用：entries/ + config.json */
    fun metaBytes(): Long = dirBytes(KbPaths.entriesDir()) + fileBytes(KbPaths.configFile())

    /** 文档快照占用（设置页库位置行展示） */
    fun snapshotsBytes(): Long = dirBytes(KbPaths.snapshotsDir())

    /** 检索缓存占用（可重建） */
    fun cacheBytes(): Long = dirBytes(KbPaths.textDir())

    private fun dirBytes(dir: Path): Long = try {
        if (Files.isDirectory(dir)) {
            Files.walk(dir).use { stream -> stream.filter { Files.isRegularFile(it) }.mapToLong { Files.size(it) }.sum() }
        } else 0
    } catch (e: Exception) {
        0
    }

    private fun fileBytes(f: Path): Long = try {
        if (Files.isRegularFile(f)) Files.size(f) else 0
    } catch (e: Exception) {
        0
    }

    // ───────────────────────── 内部 ─────────────────────────

    /** 落文档快照（收录、重新链接、再次收录共用）；失败返回 null 并记日志，不拦业务 */
    private fun captureQuietly(s: KbFileStore, id: String, file: Path): KbContent.Captured? =
        runCatching { KbContent.capture(s.root(), id, KbFileStore.displayPath(file.toString())) }
            .onFailure { log.warn("Knowledge Base: snapshot capture failed ($id, $file): ${it.message}") }
            .getOrNull()

    private fun fileExtOf(file: Path): String = "." + file.fileName.toString().substringAfterLast('.', "").lowercase()

    /** 解析项目里的 git 路径（项目配了自定义 git 时与「Git 提交」行取同一个），并记住供无项目上下文的调用沿用 */
    private fun resolveGitExe(project: Project?): String {
        if (project != null) {
            runCatching { GitExecutableManager.getInstance().getPathToGit(project) }
                .getOrNull()
                ?.takeIf { it.isNotBlank() }
                ?.let { gitExe = it }
        }
        return gitExe
    }

    override fun dispose() {
        disposed = true
        runCatching { watcher?.close() }
        watcher = null
        store?.let { runCatching { it.close() } }
        store = null
    }
}
