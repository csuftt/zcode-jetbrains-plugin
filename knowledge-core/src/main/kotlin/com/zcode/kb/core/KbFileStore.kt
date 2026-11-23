package com.zcode.kb.core

import com.zcode.kb.text.KbTokenizer
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption

/**
 * 知识库纯文件存储（IDE 进程内的读写入口；库根目录即库目录所在位置）：
 *
 * ```
 * config.json          # 目录树（folders 有序）+ 标签注册表
 * entries/<id>.json    # 每条目一份元数据（KbEntry 序列化，文本可读）
 * text/<id>.txt        # 检索缓存（提取文本；可重建，不进版本历史）
 * snapshots/<id>/...   # 文档快照（源文件原始字节）
 * ```
 *
 * 条目、检索缓存与文档快照的内容读写规则只有一份实现（[KbContent]，IDE 与 MCP server
 * 共用）；本类只管元数据与目录树、标签的增删改，内容对账的结果经 [confirmContent] 落盘。
 * 文档快照与检索缓存由 [KbContent] 按 id 落在库根下，摘除条目时一并清掉。
 *
 * 目录树（2026-11-21 改版）：模块/项目分组层退役，用户自建嵌套目录（层级不限），
 * 条目挂 folderId（"" = 根级垫底）。目录用 id 引用而非路径：重命名/移动不改子条目，
 * 展示路径实时派生（[folderPath]）。旧版 config（version 1 modules 清单）反序列化时
 * folders 缺省空表 → 自然视为空目录树（不迁移，旧测试数据允许失效）。
 *
 * 为什么去 SQLite：sqlite-jdbc 单 jar ~13.5MB（全平台 native，无瘦身手段）占了插件
 * zip 的一半；千条以内规模纯文件 + 内存扫描毫秒级。
 *
 * 并发模型：IDE 进程读写（本类）、MCP server 进程读写同一布局（KbServerStore）。写一律
 * 临时文件 + ATOMIC_MOVE（读侧永远看到完整旧文件或完整新文件，无撕裂）；进程内单锁
 * 串行；跨进程对同条目的并发写=后写覆盖（同源数据，内容一致，无害）。
 * 条目文件名必须匹配 [ID_SAFE]，损坏 JSON / 非法文件名直接跳过（隔离，不炸全库）。
 * 读取端忽略未知键；已退役的字段（status、git 锚点、indexed 时间与大小）存量文件里
 * 还有的话，下次写盘即被丢弃。
 *
 * 红线：本文件及整个 knowledge-core 不出现 zcode 会话库（db.sqlite/tasks-index.sqlite）
 * 的任何路径引用。
 */
class KbFileStore(private val root: Path) : AutoCloseable {

    private val lock = Any()
    private val entriesDir = root.resolve(KbContent.ENTRIES_DIR)
    private val configFile = root.resolve("config.json")
    private val textDir = root.resolve(KbContent.TEXT_DIR)

    /** 库位置迁移后旧连接作废：之后的写入一律拒绝，不再在旧路径上建目录 */
    @Volatile
    private var closed = false

    init {
        Files.createDirectories(entriesDir)
        Files.createDirectories(textDir)
        Files.createDirectories(root.resolve(KbContent.SNAPSHOTS_DIR))
    }

    /** 库根目录（[KbContent] 的 root 参数） */
    fun root(): Path = root

    // ───────────────────────── 条目 CRUD ─────────────────────────

    /** 条目数与 [allEntries] 同口径（损坏文件不计入；注入门控 `entryCount<=0` 依赖这一点） */
    fun entryCount(): Int = synchronized(lock) { allEntriesLocked().size }

    fun getEntry(id: String): KbEntry? = synchronized(lock) { readEntry(id) }

    /** 按源路径判重（normPath 键，扫描比对——千条以内毫秒级） */
    fun findBySource(path: String): KbEntry? = synchronized(lock) {
        val key = normPath(path)
        allEntriesLocked().firstOrNull { normPath(it.sourcePath) == key }
    }

    /** 全量条目（sweep/重建用；ingested_at 倒序，与旧库行为一致） */
    fun allEntries(): List<KbEntry> = synchronized(lock) { allEntriesLocked() }

    /** 过滤列表（无查询词；搜索走 [search]）。层内手动序：order 升序，并列（0=未拖过）按 ingestedAt 倒序 */
    fun listEntries(f: KbFilter = KbFilter(), limit: Int = 1000): List<KbEntry> = synchronized(lock) {
        allEntriesLocked()
            .filter { matchesFilter(it, f) }
            .sortedWith(compareBy({ it.order }, { -it.ingestedAt })) // 稳定排序，同键按落盘序
            .take(limit)
    }

    /** 新条目入库（id 不得与现存重复；正文缓存一并写入） */
    fun insert(e: KbEntry, text: String) = synchronized(lock) {
        writeEntry(e)
        writeText(e.id, text)
    }

    /** 更新元数据；text 非空时同步刷新提取文本缓存 */
    fun update(e: KbEntry, text: String?) = synchronized(lock) {
        writeEntry(e)
        if (text != null) writeText(e.id, text)
    }

    /**
     * 只改标签：锁内读最新条目 → transform → 写回，其余字段原样保留（调用方手里的条目
     * 可能是过期快照，不能拿它整条覆盖）。transform 的返回值原样写入——去重/清洗由调用方
     * （KbManagerService.updateEntryTags）套在外面。@return 是否写盘（条目不存在或标签无变化 = false）
     */
    fun updateTags(id: String, transform: (List<String>) -> List<String>): Boolean = synchronized(lock) {
        val e = readEntry(id) ?: return@synchronized false
        val tags = transform(e.tags)
        if (tags == e.tags) return@synchronized false
        writeEntry(e.copy(tags = tags, updatedAt = System.currentTimeMillis()))
        true
    }

    /**
     * 摘除条目：删登记、检索缓存与文档快照，绝不动源文件（安全语义）。已同步过的内容
     * 仍留在 git 历史里。
     */
    fun removeEntry(id: String) = synchronized(lock) {
        if (!id.matches(ID_SAFE)) return@synchronized
        Files.deleteIfExists(entriesDir.resolve("$id.json"))
        Files.deleteIfExists(textDir.resolve("$id.txt"))
        KbContent.deleteSnapshot(root, id)
    }

    fun readText(id: String): String? = synchronized(lock) {
        if (!id.matches(ID_SAFE)) return@synchronized null
        val f = textDir.resolve("$id.txt")
        if (!Files.isRegularFile(f)) return@synchronized null
        runCatching { Files.readString(f) }.getOrNull()
    }

    /**
     * 锁内读最新条目 → transform → 写回。调用方手里的条目可能是过期快照，不能拿它整条覆盖
     * （会冲掉期间别的入口改的字段）；transform 作用在库里的最新条目上。
     *
     * @param text 非空时同步刷新检索缓存
     * @return 写回后的条目；条目不存在返回 null（不写盘）
     */
    fun transformEntry(id: String, text: String? = null, transform: (KbEntry) -> KbEntry): KbEntry? = synchronized(lock) {
        val e = readEntry(id) ?: return@synchronized null
        val next = transform(e)
        writeEntry(next)
        if (text != null) writeText(id, text)
        next
    }

    /**
     * 内容对账落盘（[KbContent.ContentSink] 的 IDE 侧实现）：锁内读最新条目，只改内容
     * 字段（contentHash / sizeBytes），别的字段原样保留——对账线程手里的条目视图是开轮
     * 时的快照，拿它整条覆盖会冲掉期间改的标题、目录、标签。
     *
     * 不动 updatedAt：同一处源文件的变化常被两台电脑各自对账到，两边写下的条目文件必须
     * 逐字节相同，后同步的那台才不会撞上冲突。updatedAt 只跟随收录与整理这类元数据编辑。
     *
     * @return 是否写盘（条目不存在或字段已是目标值 = false）
     */
    fun confirmContent(id: String, hash: String, size: Long): Boolean = synchronized(lock) {
        val e = readEntry(id) ?: return@synchronized false
        if (e.contentHash == hash && e.sizeBytes == size) return@synchronized false
        writeEntry(e.copy(contentHash = hash, sizeBytes = size))
        true
    }

    /** 对账入参：全部条目的内容视图（锁内一次性快照） */
    fun contentSources(): List<KbContent.Source> = synchronized(lock) {
        allEntriesLocked().map { KbContent.Source(it.id, it.sourcePath, it.contentHash) }
    }

    /** 清空检索缓存（设置页「重建索引」第一步；之后的重提取走 KbContent.rebuildText） */
    fun clearIndex() = synchronized(lock) {
        for (f in listRegularFiles(textDir)) Files.deleteIfExists(f)
    }

    // ───────────────────────── 目录树 ─────────────────────────

    /** 目录全表（config 存储序；UI 按 parentId+order 组树，空目录也返回） */
    fun folders(): List<KbFolder> = synchronized(lock) { readConfig().folders }

    /** 展示路径派生（`信创适配/中间件`）；未知 id 与根级返回 ""（根级同形） */
    fun folderPath(folderId: String): String = synchronized(lock) {
        val idx = readConfig().folders.associateBy { it.id }
        val cur = idx[folderId] ?: return@synchronized ""
        val parts = ArrayDeque<String>()
        var node: KbFolder? = cur
        val seen = HashSet<String>()
        while (node != null && seen.add(node.id)) {
            parts.addFirst(node.name)
            node = node.parentId?.let { idx[it] } // 断链父引用即止，环防御
        }
        parts.joinToString("/")
    }

    /** 新建目录。同层重名允许（id 区分）；@return 新目录 id */
    fun createFolder(parentId: String?, name: String): String = synchronized(lock) {
        val clean = name.trim()
        require(clean.isNotEmpty()) { "folder name is empty" }
        val cfg = readConfig()
        val siblings = cfg.folders.filter { it.parentId == parentId }
        val folder = KbFolder(
            id = newFolderId(),
            name = clean,
            parentId = parentId?.takeIf { it.isNotEmpty() },
            order = (siblings.maxOfOrNull { it.order } ?: -1) + 1,
        )
        writeConfig(cfg.copy(folders = cfg.folders + folder))
        folder.id
    }

    /** 按路径逐级确保目录存在（`a/b/c`，缺哪级建哪级）。@return 最末级目录 id */
    fun ensureFolderPath(path: String): String = synchronized(lock) {
        val cfg = readConfig()
        val folders = cfg.folders.toMutableList()
        var parentId: String? = null
        for (seg in path.split('/').map { it.trim() }.filter { it.isNotEmpty() }) {
            val existing = folders.firstOrNull { it.parentId == parentId && it.name == seg }
            if (existing != null) {
                parentId = existing.id
            } else {
                val siblings = folders.filter { it.parentId == parentId }
                val f = KbFolder(
                    id = newFolderId(),
                    name = seg,
                    parentId = parentId,
                    order = (siblings.maxOfOrNull { it.order } ?: -1) + 1,
                )
                folders.add(f)
                parentId = f.id
            }
        }
        if (folders != cfg.folders) writeConfig(cfg.copy(folders = folders))
        parentId ?: ""
    }

    fun renameFolder(id: String, newName: String) = synchronized(lock) {
        val clean = newName.trim()
        if (clean.isEmpty()) return@synchronized
        val cfg = readConfig()
        val idx = cfg.folders.indexOfFirst { it.id == id }
        if (idx >= 0) writeConfig(cfg.copy(folders = cfg.folders.toMutableList().also { it[idx] = it[idx].copy(name = clean) }))
    }

    /**
     * 移动目录到新父（null/"" = 根级）。防环：newParent 不得是自身或其子孙。
     * insertIndex = 目标层摘出前视觉位次（UI 插入线换算值，同 [reorderEntries] 语义；
     * 默认尾部），同层自拖的摘出偏移内部校正，目标层 order 全量重写。
     * @return false = 防环拒绝
     */
    fun moveFolder(id: String, newParentId: String?, insertIndex: Int = Int.MAX_VALUE): Boolean = synchronized(lock) {
        val cfg = readConfig()
        if (cfg.folders.none { it.id == id }) return@synchronized false
        val parent = newParentId?.takeIf { it.isNotEmpty() }
        if (parent != null && isDescendantLocked(cfg.folders, ancestor = id, node = parent)) return@synchronized false
        val layer = cfg.folders.filter { it.parentId == parent }.sortedBy { it.order }
        val at = insertIndex.coerceAtMost(layer.size)
        val corrected = at - layer.take(at).count { it.id == id } // 同层自拖：摘出偏移校正（跨层时 0）
        val siblings = layer.filter { it.id != id } // 原位摘出（同层重排/跨层同形）
        reorderLocked(cfg, id, parent, siblings, corrected)
        true
    }

    /**
     * 删目录：子目录连带删除，其下条目一律退回根级（""，不丢数据）。
     * @return 移入根级的条目数（确认框文案用）
     */
    fun deleteFolder(id: String): Int = synchronized(lock) {
        val cfg = readConfig()
        val doomed = collectSubtreeLocked(cfg.folders, id)
        if (doomed.isEmpty()) return@synchronized 0
        var moved = 0
        for (e in allEntriesLocked()) {
            if (doomed.contains(e.folderId)) {
                writeEntry(e.copy(folderId = "", updatedAt = System.currentTimeMillis()))
                moved++
            }
        }
        writeConfig(cfg.copy(folders = cfg.folders.filter { !doomed.contains(it.id) }))
        moved
    }

    /**
     * 移动/重排条目（拖拽落位统一入口）：ids 依次移入目标目录（"" = 根级/根级直放；目标
     * 目录不存在断链容错回根级），并插到目标层条目序列 insertIndex 位次（默认尾部）。
     * 层内序见 [listEntries]；落位后目标层全量重写 order（0..n-1），跨层拖入时原层也
     * 重写（收拢空洞）。同层自拖的 insertIndex 按「摘出前位次」传入即可，摘出偏移内部校正。
     * order 变更不刷 updatedAt（纯排序无内容变化），仅 folderId 变化才刷。
     */
    fun reorderEntries(ids: List<String>, targetFolderId: String, insertIndex: Int = Int.MAX_VALUE) = synchronized(lock) {
        if (ids.isEmpty()) return@synchronized
        val cfg = readConfig()
        val known = cfg.folders.map { it.id }.toHashSet()
        val target = if (targetFolderId.isEmpty() || known.contains(targetFolderId)) targetFolderId else ""
        val idSet = ids.toSet()
        val moving = ids.mapNotNull { readEntry(it) }.distinctBy { it.id }
        // 目标层现状（摘出前）：同层自拖的条目先摘出，插入位次按摘出偏移校正
        val layer = allEntriesLocked()
            .filter { it.folderId == target }
            .sortedWith(compareBy({ it.order }, { -it.ingestedAt }))
        val at = insertIndex.coerceAtMost(layer.size)
        val rebuilt = ArrayList(layer.filterNot { it.id in idSet })
        val insertAt = (at - layer.take(at).count { it.id in idSet }).coerceIn(0, rebuilt.size)
        moving.forEachIndexed { k, e -> rebuilt.add(insertAt + k, e) }
        for ((i, e) in rebuilt.withIndex()) {
            if (e.folderId != target) {
                writeEntry(e.copy(folderId = target, order = i, updatedAt = System.currentTimeMillis()))
            } else if (e.order != i) {
                writeEntry(e.copy(order = i))
            }
        }
        // 跨层拖入：原层剩余条目重写 order 收拢空洞
        for (origin in moving.map { it.folderId }.filter { it != target }.distinct()) {
            allEntriesLocked()
                .filter { it.folderId == origin && it.id !in idSet }
                .sortedWith(compareBy({ it.order }, { -it.ingestedAt }))
                .forEachIndexed { i, e -> if (e.order != i) writeEntry(e.copy(order = i)) }
        }
    }

    // ───────────────────────── 标签 / 项目 ─────────────────────────

    fun allTags(): List<String> = synchronized(lock) {
        (allEntriesLocked().flatMap { it.tags }.toSet() + readConfig().tags.map { it.name }).sorted()
    }

    /**
     * 标签使用计数（管理对话框列表）：条目聚合 + 注册表（含无主标签 count=0——先建
     * 体系后挂条目的用法）。
     */
    fun tagCounts(): Map<String, Int> = synchronized(lock) {
        val counts = HashMap<String, Int>()
        for (e in allEntriesLocked()) for (t in e.tags) counts.merge(t, 1, Int::plus)
        for (meta in readConfig().tags) counts.putIfAbsent(meta.name, 0)
        counts
    }

    /** 标签注册表（名字+颜色；条目 tags 仍存名字数组，颜色在此一层） */
    fun tagMetas(): List<KbTagMeta> = synchronized(lock) { readConfig().tags }

    /** 注册标签（已存在仅保留原色）。@return 标签颜色 */
    fun ensureTagMeta(name: String, color: String): String = synchronized(lock) {
        val clean = sanitizeTag(name)
        if (clean.isEmpty()) return@synchronized color
        val cfg = readConfig()
        val existing = cfg.tags.firstOrNull { it.name == clean }
        if (existing != null) return@synchronized existing.color
        writeConfig(cfg.copy(tags = cfg.tags + KbTagMeta(clean, color)))
        color
    }

    fun setTagColor(name: String, color: String) = synchronized(lock) {
        val cfg = readConfig()
        val idx = cfg.tags.indexOfFirst { it.name == name }
        if (idx >= 0) {
            writeConfig(cfg.copy(tags = cfg.tags.toMutableList().also { it[idx] = it[idx].copy(color = color) }))
        } else if (name.isNotEmpty()) {
            writeConfig(cfg.copy(tags = cfg.tags + KbTagMeta(name, color)))
        }
    }

    /** 全局重命名标签（改写全部含该标签的条目 + 注册表）。@return 改写条目数 */
    fun renameTag(from: String, to: String): Int = synchronized(lock) {
        val clean = sanitizeTag(to)
        if (from.isEmpty() || clean.isEmpty()) return@synchronized 0
        var n = 0
        for (e in allEntriesLocked()) {
            if (e.tags.contains(from)) {
                writeEntry(e.copy(tags = e.tags.map { if (it == from) clean else it }.distinct(), updatedAt = System.currentTimeMillis()))
                n++
            }
        }
        val cfg = readConfig()
        val metas = cfg.tags.map { if (it.name == from) it.copy(name = clean) else it }
        if (metas != cfg.tags) writeConfig(cfg.copy(tags = metas))
        n
    }

    /** 从全部条目移除标签 + 注册表删除。@return 影响条目数 */
    fun deleteTag(name: String): Int = synchronized(lock) {
        if (name.isEmpty()) return@synchronized 0
        var n = 0
        for (e in allEntriesLocked()) {
            if (e.tags.contains(name)) {
                writeEntry(e.copy(tags = e.tags.filter { it != name }, updatedAt = System.currentTimeMillis()))
                n++
            }
        }
        val cfg = readConfig()
        if (cfg.tags.any { it.name == name }) writeConfig(cfg.copy(tags = cfg.tags.filter { it.name != name }))
        n
    }

    fun allProjects(): List<String> = synchronized(lock) {
        allEntriesLocked().map { it.project }.filter { it.isNotEmpty() }.distinct().sorted()
    }

    // ───────────────────────── 检索 ─────────────────────────

    /**
     * 全文检索：内存扫描 text/ 缓存。分词用 [KbTokenizer]（latin 词元 + CJK bigram），
     * 命中判据 = 每个词元都出现在 标题/标签/正文 任一渠道（小写包含，AND 语义）；
     * 打分按计次加权（标题 4 : 标签 2 : 正文 1）；摘要取首个词元命中点前后窗口。
     * 文本缓存缺失的条目仍可按标题/标签命中（预览/读全文自然降级）。
     */
    fun search(rawQuery: String, f: KbFilter = KbFilter(), limit: Int = 50): List<KbHit> {
        val tokens = KbTokenizer.tokens(rawQuery)
        if (tokens.isEmpty()) return emptyList()
        val hits = ArrayList<KbHit>()
        synchronized(lock) {
            for (e in allEntriesLocked()) {
                if (!matchesFilter(e, f)) continue
                val titleLower = e.title.lowercase()
                val tagsLower = e.tags.map { it.lowercase() }
                val content = readText(e.id) ?: ""
                val contentLower = content.lowercase()
                var matched = true
                var score = 0
                var matchCount = 0
                for (t in tokens) {
                    val inTitle = titleLower.contains(t)
                    val inBody = contentLower.contains(t)
                    val inTags = tagsLower.any { it.contains(t) }
                    if (!inTitle && !inBody && !inTags) {
                        matched = false
                        break
                    }
                    val titleN = countOf(titleLower, t)
                    val bodyN = countOf(contentLower, t)
                    val tagN = tagsLower.sumOf { countOf(it, t) }
                    matchCount += titleN + bodyN + tagN
                    score += 4 * titleN + 2 * tagN + bodyN
                }
                if (matched) hits.add(KbHit(e, score.toDouble(), snippetsOf(tokens, content), matchCount))
            }
        }
        return hits.sortedByDescending { it.score }.take(limit)
    }

    // ───────────────────────── 内部 ─────────────────────────

    private fun matchesFilter(e: KbEntry, f: KbFilter): Boolean {
        if (f.folderId != null && e.folderId != f.folderId) return false
        if (f.tags.isNotEmpty()) {
            val ok = if (f.tagMatchAll) f.tags.all { it in e.tags } else f.tags.any { it in e.tags }
            if (!ok) return false
        }
        if (f.project != null && e.project != f.project) return false
        return true
    }

    private fun allEntriesLocked(): List<KbEntry> = listEntryIds().mapNotNull { readEntry(it) }

    /** 合法条目 id（`.json` 剥除后校验，顺带把 `.tmp` 残留/异物挡在门外） */
    private fun listEntryIds(): List<String> =
        listRegularFiles(entriesDir)
            .map { it.fileName.toString().removeSuffix(".json") }
            .filter { it.matches(ID_SAFE) }
            .sorted()

    private fun readEntry(id: String): KbEntry? {
        if (!id.matches(ID_SAFE)) return null
        val f = entriesDir.resolve("$id.json")
        if (!Files.isRegularFile(f)) return null
        return try {
            json.decodeFromString(KbEntry.serializer(), Files.readString(f))
        } catch (e: Exception) {
            null // 单文件损坏只丢该条目，不炸全库
        }
    }

    private fun writeEntry(e: KbEntry) {
        atomicWrite(entriesDir.resolve("${e.id}.json")) { json.encodeToString(KbEntry.serializer(), e) }
    }

    private fun writeText(id: String, text: String) {
        atomicWrite(textDir.resolve("$id.txt")) { text }
    }

    /** 临时文件 + ATOMIC_MOVE（ZcGuiConfig 同款；不支持原子移动的文件系统降级普通 move） */
    private fun atomicWrite(target: Path, content: () -> String) {
        check(!closed) { "knowledge base store is closed: $root" }
        Files.createDirectories(target.parent)
        val tmp = target.resolveSibling(target.fileName.toString() + ".tmp")
        Files.writeString(tmp, content())
        try {
            Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        } catch (e: java.nio.file.AtomicMoveNotSupportedException) {
            Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING)
        }
    }

    private fun readConfig(): KbConfigFile = try {
        if (Files.isRegularFile(configFile)) json.decodeFromString(KbConfigFile.serializer(), Files.readString(configFile))
        else KbConfigFile()
    } catch (e: Exception) {
        KbConfigFile()
    }

    private fun writeConfig(cfg: KbConfigFile) {
        atomicWrite(configFile) { json.encodeToString(KbConfigFile.serializer(), cfg) }
    }

    /** node 是否是 ancestor 的子孙（含自身；断链父引用按缺失处理，不死循环） */
    private fun isDescendantLocked(folders: List<KbFolder>, ancestor: String, node: String): Boolean {
        if (ancestor == node) return true
        val idx = folders.associateBy { it.id }
        var cur = idx[node] ?: return false
        val seen = HashSet<String>()
        while (cur.parentId != null) {
            if (cur.id == ancestor || !seen.add(cur.id)) return true // 命中祖先 / 环防御
            cur = idx[cur.parentId] ?: return false
        }
        return cur.id == ancestor
    }

    /** id 及其全部子孙 id 集合（删目录连带面） */
    private fun collectSubtreeLocked(folders: List<KbFolder>, id: String): Set<String> {
        val children = folders.groupBy { it.parentId }
        val out = LinkedHashSet<String>()
        fun walk(f: String) {
            out.add(f)
            for (c in children[f].orEmpty()) walk(c.id)
        }
        walk(id)
        return out
    }

    /**
     * 目录同层/跨层移动落位：目标层兄弟已按序摘出被移动目录，按 insertIndex 插位后
     * 全量重写 order（0..n-1），移动目录本身 parentId 同步改。
     */
    private fun reorderLocked(cfg: KbConfigFile, id: String, parent: String?, siblings: List<KbFolder>, insertIndex: Int) {
        val moving = cfg.folders.first { it.id == id }
        val insertAt = insertIndex.coerceIn(0, siblings.size)
        val rebuilt = ArrayList<KbFolder>(siblings.size + 1)
        siblings.forEachIndexed { i, f -> rebuilt.add(f.copy(order = if (i < insertAt) i else i + 1)) }
        rebuilt.add(insertAt, moving.copy(parentId = parent, order = insertAt))
        writeConfig(cfg.copy(folders = cfg.folders.map { f -> rebuilt.firstOrNull { it.id == f.id } ?: f }))
    }

    private fun listRegularFiles(dir: Path): List<Path> {
        if (!Files.isDirectory(dir)) return emptyList()
        return Files.list(dir).use { s -> s.filter { Files.isRegularFile(it) }.toList() }
    }

    /** 标签清洗（同 KbManagerService.sanitizeTags 单元素语义：去逗号/引号/空白） */
    private fun sanitizeTag(raw: String): String =
        raw.trim().replace(',', ' ').replace('"', ' ').replace('，', ' ').trim()

    private fun countOf(haystack: String, needle: String): Int {
        if (needle.isEmpty()) return 0
        var idx = 0
        var n = 0
        while (true) {
            idx = haystack.indexOf(needle, idx)
            if (idx < 0) break
            n++
            idx += needle.length
        }
        return n
    }

    /**
     * 命中片段（最多 [max] 个互不重叠窗口）：贪心吸收——窗口 [-40,+80)，落在当前窗口
     * 内的后续命中归入同窗延长；无命中退文头 80 字符。
     */
    private fun snippetsOf(tokens: List<String>, content: String, max: Int = 3): List<String> {
        val lower = content.lowercase()
        val positions = sortedSetOf<Int>()
        for (t in tokens) {
            if (t.isEmpty()) continue
            var idx = 0
            while (true) {
                idx = lower.indexOf(t, idx)
                if (idx < 0) break
                positions.add(idx)
                idx += t.length
            }
        }
        if (positions.isEmpty()) return listOf(content.take(80))
        val out = ArrayList<String>()
        val ats = positions.toList()
        var i = 0
        while (i < ats.size && out.size < max) {
            val start = (ats[i] - 40).coerceAtLeast(0)
            var end = (ats[i] + 80).coerceAtMost(content.length)
            var j = i + 1
            while (j < ats.size && ats[j] < end) {
                end = (ats[j] + 80).coerceAtMost(content.length)
                j++
            }
            out.add(
                (if (start > 0) "…" else "") + content.substring(start, end) +
                    (if (end < content.length) "…" else "")
            )
            i = j
        }
        return out
    }

    /** 关库：库位置迁移前调用，此后本连接的写入一律拒绝，不再在旧路径上建目录写文件 */
    override fun close() {
        closed = true
    }

    companion object {
        private val json = Json {
            encodeDefaults = true
            prettyPrint = true
            ignoreUnknownKeys = true // 新版插件写的字段不炸旧版读取（跨 IDE 版本混跑）
        }

        private val ID_SAFE = Regex("kb-[0-9a-f]+")

        private val IS_WINDOWS =
            System.getProperty("os.name", "").lowercase().contains("windows")

        /** 判重键：反斜杠归一正斜杠 + Windows 下小写（不区分大小写盘） */
        fun normPath(p: String): String {
            val s = p.trim().replace('\\', '/')
            return if (IS_WINDOWS) s.lowercase() else s
        }

        /** 展示态路径：反斜杠归一正斜杠，保留大小写 */
        fun displayPath(p: String): String = p.trim().replace('\\', '/')

        /**
         * 条目 id = [normPath] 的 SHA-256 前 5 字节 hex：**确定性 id**——同一源文件摘除重加
         * id 恒定，外部脚本/引用缓存 id 不失效（旧随机 id 每次重加都会换掉）。
         * 与 findBySource 判重键同源（normPath），同路径只会有一条条目。
         * id 语义=「初次收录路径指纹」：relink 换路径不改 id（外部 id 引用保持有效）。
         *
         * 40bit 碰撞概率日常可忽略（千条目 ~1/200 万），仍加**确定性防碰撞派生**兜底：
         * 原生 id 已被其它路径占用时按盐 "#"/"##"… 递增重哈希——同文件在相同占用状态下
         * 得到的派生 id 依然恒定，不引入随机性（纯随机兜底会破坏确定性）。
         */
        fun newId(sourcePath: String, taken: Set<String> = emptySet()): String {
            val norm = normPath(sourcePath)
            var salt = ""
            while (true) {
                val digest = java.security.MessageDigest.getInstance("SHA-256")
                    .digest((norm + salt).toByteArray(Charsets.UTF_8))
                val id = "kb-" + digest.take(5).joinToString("") { "%02x".format(it) }
                if (id !in taken) return id
                salt += "#" // 理论碰撞（~2^-40）时的确定性备用位
            }
        }

        /** 目录 id：f- 前缀与条目 id 区分（同白名单字符集） */
        fun newFolderId(): String {
            val rnd = java.security.SecureRandom()
            val bytes = ByteArray(4)
            rnd.nextBytes(bytes)
            return "f-" + bytes.joinToString("") { "%02x".format(it) }
        }

        /**
         * 标签自动分配色板（8 色轮转）：选中性饱和色，深浅主题通用，chip 字色按亮度
         * 自适配黑白（UI 侧 luminance 判定）。
         */
        val TAG_PALETTE = listOf(
            "#4A9EFF", // 蓝
            "#59C17C", // 绿
            "#E05F65", // 红
            "#B57EE0", // 紫
            "#59B0C9", // 青
            "#D98A4B", // 橙
            "#E8B339", // 金黄
            "#8A919C", // 灰
        )

        /**
         * 新建标签自动分配：优先取未被占用的色板色（按色板顺序取第一个空闲）；
         * 色板用尽才取占用最少的颜色重复（用户拍板：颜色尽量不重复，不够了才重复）。
         */
        fun pickTagColor(existing: List<KbTagMeta>): String {
            val counts = TAG_PALETTE.associateWith { hex -> existing.count { it.color == hex } }
            val min = counts.values.min()
            return counts.entries.first { it.value == min }.key
        }
    }
}

/**
 * config.json（version 2）：目录树 + 标签注册表。
 * 旧版 version 1（modules 字符串清单）读取时 folders/tags 缺省空表——不迁移，自然重置。
 * lastFolderId、snapshotDir 字段已废除；存量文件里的旧键由 ignoreUnknownKeys 无害忽略。
 */
@Serializable
data class KbConfigFile(
    val version: Int = 2,
    val folders: List<KbFolder> = emptyList(),
    val tags: List<KbTagMeta> = emptyList(),
)

/** 标签注册表条目：名字 + 颜色（hex，如 #4A9EFF）。条目 tags 只存名字，颜色在此一层。 */
@Serializable
data class KbTagMeta(
    val name: String,
    val color: String,
)
