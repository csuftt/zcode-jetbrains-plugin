package com.zcode.ideaplugin.kb

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.Disposable
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.zcode.kb.core.KbEntry
import com.zcode.kb.core.KbExtractor
import com.zcode.kb.core.KbFolder
import com.zcode.kb.core.KbTagMeta
import com.zcode.kb.core.KbFilter
import com.zcode.kb.core.KbGitCli
import com.zcode.kb.core.KbHit
import com.zcode.kb.core.KbPaths
import com.zcode.kb.core.KbFileStore
import git4idea.config.GitExecutableManager
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption

/**
 * 知识库应用级服务：私有库连接的持有者 + 收录/摘除/失联恢复/重建 + 轮询对账（sweep）。
 *
 * - 收录（指针模型）：文件留原地，提取文本进缓存；git 仓内文件顺带捕获锚点
 *   （仓根/HEAD commit/相对路径），源失联时可按 commit 从历史捞回；
 * - sweep：仓库无文件监听先例，沿用轮询惯例（20s）——stat 源文件，(mtime,size) 漂移
 *   即重提取重索引，文件消失落 missing（检索仍命中缓存文本），文件回归自动复位；
 * - 全库红线：只碰 ~/.zcgui/knowledge/，绝不读写 zcode 的 db.sqlite/tasks-index.sqlite。
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
        // 库目录文件监听（MCP server/外部进程写 → 面板秒级刷新，不再等 20s sweep）；
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
            // 重复收录 = 更新元数据（title/folder/tags/notes）
            return updateMeta(existing.id, title.ifBlank { existing.title }, folderId, tags, notes)
                .let { s.getEntry(existing.id) }
        }
        val text = KbExtractor.extract(file)
        val cli = KbGitCli(gitExe = resolveGitExe(project))
        val anchor = runCatching { cli.anchor(file) }.getOrNull()
        val projectName = anchor?.repoRoot?.fileName?.toString()
            ?: file.parent?.fileName?.toString() ?: ""
        val now = System.currentTimeMillis()
        val entry = KbEntry(
            // 确定性 id=路径指纹：摘除重加 id 恒定，外部引用稳定；taken=防 2^-40 碰撞的确定性派生
                    id = KbFileStore.newId(display, taken = s.allEntries().map { it.id }.toSet()),
            sourcePath = display,
            title = title.ifBlank { file.fileName.toString() },
            folderId = folderId,
            tags = sanitizeTags(tags),
            notes = notes,
            project = projectName,
            fileExt = "." + file.fileName.toString().substringAfterLast('.', "").lowercase(),
            sizeBytes = runCatching { Files.size(file) }.getOrDefault(0),
            gitRepo = anchor?.repoRoot?.toString(),
            gitCommit = anchor?.commit,
            gitRel = anchor?.relPath,
            status = if (Files.exists(file)) KbEntry.STATUS_OK else KbEntry.STATUS_MISSING,
            ingestedAt = now,
            updatedAt = now,
            indexedMtime = runCatching { Files.getLastModifiedTime(file).toMillis() }.getOrDefault(0),
            indexedSize = runCatching { Files.size(file) }.getOrDefault(0),
        )
        s.insert(entry, text ?: "")
        s.setLastFolderId(folderId) // 收录默认目录记忆（下次弹窗预选）
        log.info("Knowledge Base: ingested ${entry.id} <- $display (extract=${text != null}, git=${anchor != null})")
        KbTopics.publish(project)
        return entry
    }

    /** 元数据更新（title/folder/tags/notes） */
    fun updateMeta(id: String, title: String, folderId: String, tags: List<String>, notes: String): Boolean {
        val s = store()
        val e = s.getEntry(id) ?: return false
        s.update(
            e.copy(
                title = title.ifBlank { e.title },
                folderId = folderId,
                tags = sanitizeTags(tags),
                notes = notes,
                updatedAt = System.currentTimeMillis(),
            ),
            null,
        )
        KbTopics.publish(null)
        return true
    }

    /** 摘除：只删登记与缓存，绝不动源文件 */
    fun remove(id: String): Boolean {
        store().removeEntry(id)
        log.info("Knowledge Base: removed $id")
        KbTopics.publish(null)
        return true
    }

    /** 失联条目改指新路径（重链接）：换源后立即重提取 */
    fun relink(id: String, newPath: Path): KbEntry? {
        val s = store()
        val e = s.getEntry(id) ?: return null
        if (!Files.isRegularFile(newPath)) return null
        val text = KbExtractor.extract(newPath)
        val now = System.currentTimeMillis()
        val updated = e.copy(
            sourcePath = KbFileStore.displayPath(newPath.toString()),
            status = KbEntry.STATUS_OK,
            sizeBytes = runCatching { Files.size(newPath) }.getOrDefault(0),
            updatedAt = now,
            indexedMtime = runCatching { Files.getLastModifiedTime(newPath).toMillis() }.getOrDefault(0),
            indexedSize = runCatching { Files.size(newPath) }.getOrDefault(0),
        )
        s.update(updated, text ?: "")
        KbTopics.publish(null)
        return updated
    }

    /**
     * git 历史恢复：按收录时点锚点把 blob 落到 `<库>/restored/<id>--<文件名>` 并把条目
     * 改指过去（写入仓库工作区会与用户当前分支打架，故不回写源位置）。
     *
     * @return 恢复后的新源路径；锚点缺失/blob 不存在/写盘失败返回 null
     */
    fun restoreFromGit(id: String): Path? {
        val s = store()
        val e = s.getEntry(id) ?: return null
        val repo = e.gitRepo ?: return null
        val commit = e.gitCommit ?: return null
        val rel = e.gitRel ?: return null
        val cli = KbGitCli()
        if (!cli.hasBlob(repo, commit, rel)) return null
        val target = KbPaths.restoredDir().resolve("$id--${e.sourcePath.substringAfterLast('/')}")
        if (!cli.restoreBlob(repo, commit, rel, target)) return null
        return relink(id, target)?.let { target } // relink 内已广播
    }

    // ───────────────────────── 查询（供 UI / bridge ops） ─────────────────────────

    fun get(id: String): KbEntry? = store().getEntry(id)

    fun list(f: KbFilter = KbFilter()): List<KbEntry> = store().listEntries(f)

    fun folders(): List<KbFolder> = store().folders()

    fun folderPath(folderId: String): String = store().folderPath(folderId)

    fun lastFolderId(): String = store().lastFolderId()

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
    fun moveFolder(id: String, newParentId: String?, afterId: String? = null): Boolean =
        store().moveFolder(id, newParentId, afterId).also { if (it) KbTopics.publish(null) }

    /** @return 移入根级的条目数（确认框文案用） */
    fun deleteFolder(id: String): Int =
        store().deleteFolder(id).also { if (it >= 0) KbTopics.publish(null) }

    fun moveEntries(ids: List<String>, targetFolderId: String) {
        store().moveEntries(ids, targetFolderId)
        KbTopics.publish(null)
    }

    fun search(query: String, f: KbFilter = KbFilter(), limit: Int = 50): List<KbHit> =
        store().search(query, f, limit)

    fun readText(id: String): String? = store().readText(id)

    // ───────────────────────── 库目录监听 ─────────────────────────

    private var watcherStarted = false
    private var watcher: java.nio.file.WatchService? = null

    /**
     * 库根文件监听（幂等）：MCP server 管理写（kb_add/kb_entry/kb_folder/kb_tag，独立
     * fork 进程无 MessageBus 可达）落盘 ATOMIC_MOVE 后秒级广播 KB_CHANGED 刷新面板。
     * IDE 自己的写也会触发（双广播，面板刷新幂等无害）；500ms 防抖聚合批量写。
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
            java.nio.file.Files.createDirectories(root.resolve("entries"))
            java.nio.file.Files.createDirectories(root.resolve("text"))
            root.register(ws, *kinds)
            root.resolve("entries").register(ws, *kinds)
            root.resolve("text").register(ws, *kinds)
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
                    Thread.sleep(10_000) // 对账轻（目录指纹毫秒级），10s 一轮兜底 watcher 丢事件
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

    /** 库结构指纹：config.json 与 entries 目录全部 json 的 mtime:size 集合（目录树/条目增删改全感知） */
    private fun storeFingerprint(): String {
        val root = KbPaths.rootDir()
        fun sig(p: java.nio.file.Path): String = try {
            "${Files.getLastModifiedTime(p).toMillis()}:${Files.size(p)}"
        } catch (e: Exception) {
            "gone"
        }
        val cfgSig = sig(root.resolve("config.json"))
        val entrySigs = try {
            Files.list(root.resolve("entries")).use { st ->
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

    /** 单轮对账：源漂移→重提取重索引；消失→missing；回归→ok。返回本轮变更条数。 */
    fun sweepOnce(): Int {
        // 结构对账兜底：MCP server（独立进程）写盘若被 watcher 丢事件，本轮指纹对比必发现并广播
        val fp = storeFingerprint()
        if (lastStoreFingerprint != null && fp != lastStoreFingerprint) {
            log.info("Knowledge Base: structural change detected by sweep -> refresh")
            KbTopics.publish(null)
        }
        lastStoreFingerprint = fp
        val s = store()
        var changed = 0
        for (e in s.allEntries()) {
            val p = try {
                Path.of(e.sourcePath)
            } catch (ex: Exception) {
                continue
            }
            if (!Files.isRegularFile(p)) {
                if (e.status != KbEntry.STATUS_MISSING) {
                    s.setStatus(e.id, KbEntry.STATUS_MISSING)
                    changed++
                }
                continue
            }
            val mtime = runCatching { Files.getLastModifiedTime(p).toMillis() }.getOrDefault(0)
            val size = runCatching { Files.size(p) }.getOrDefault(0)
            if (e.status == KbEntry.STATUS_MISSING || mtime != e.indexedMtime || size != e.indexedSize) {
                val text = KbExtractor.extract(p)
                // 提取失败但文件在（占用/瞬时读错误）：传 null 保留旧缓存文本只更新 stat
                // （否则一次读失败就把正文缓存抹掉）
                val newText = when {
                    text != null -> text
                    Files.isRegularFile(p) -> null
                    else -> ""
                }
                s.update(
                    e.copy(
                        status = KbEntry.STATUS_OK,
                        sizeBytes = size,
                        indexedMtime = mtime,
                        indexedSize = size,
                        updatedAt = System.currentTimeMillis(),
                    ),
                    newText,
                )
                changed++
            }
        }
        if (changed > 0) {
            log.info("Knowledge Base: sweep refreshed $changed entries")
            KbTopics.publish(null)
        }
        // sweep 自写（setStatus/update）也动 entries——重算基线，下轮不自误报
        lastStoreFingerprint = storeFingerprint()
        return changed
    }

    /** 全库重建（设置页入口）：清缓存重提取 */
    fun reindexAll(): Int {
        val s = store()
        s.clearIndex()
        var ok = 0
        for (e in s.allEntries()) {
            val p = runCatching { Path.of(e.sourcePath) }.getOrNull() ?: continue
            val text = if (Files.isRegularFile(p)) KbExtractor.extract(p) else null
            val mtime = runCatching { Files.getLastModifiedTime(p).toMillis() }.getOrDefault(0)
            val size = runCatching { Files.size(p) }.getOrDefault(0)
            s.update(
                e.copy(
                    status = if (text != null || Files.isRegularFile(p)) KbEntry.STATUS_OK else KbEntry.STATUS_MISSING,
                    indexedMtime = mtime,
                    indexedSize = size,
                    updatedAt = System.currentTimeMillis(),
                ),
                text ?: "",
            )
            ok++
        }
        log.info("Knowledge Base: reindexed $ok entries")
        KbTopics.publish(null)
        return ok
    }

    /** 设置页改库位置：关连接 → 搬目录 → 写 pointer（失败回滚搬动） */
    fun changeRoot(newRoot: Path): Boolean {
        if (!newRoot.isAbsolute) return false
        if (newRoot.toAbsolutePath().normalize() == KbPaths.rootDir().toAbsolutePath().normalize()) return true
        val old = KbPaths.rootDir()
        val s = store
        s?.close()
        store = null
        return try {
            if (Files.isDirectory(old)) {
                Files.createDirectories(newRoot.parent)
                if (Files.exists(newRoot)) return false // 目标已存在不覆盖
                Files.move(old, newRoot, StandardCopyOption.ATOMIC_MOVE)
            }
            if (!KbPaths.setCustomRoot(newRoot.toString())) throw IllegalStateException("pointer write failed")
            true
        } catch (e: Exception) {
            log.warn("Knowledge Base: changeRoot failed: ${e.message}")
            false
        }
    }

    /** 设置页存储占用（bytes） */
    fun storageBytes(): Long = try {
        Files.walk(KbPaths.rootDir()).use { stream -> stream.mapToLong { Files.size(it) }.sum() }
    } catch (e: Exception) {
        0
    }

    private fun resolveGitExe(project: Project?): String = try {
        if (project != null) GitExecutableManager.getInstance().getPathToGit(project) else "git"
    } catch (e: Exception) {
        "git"
    }

    override fun dispose() {
        disposed = true
        runCatching { watcher?.close() }
        watcher = null
        store?.let { runCatching { it.close() } }
        store = null
    }
}
