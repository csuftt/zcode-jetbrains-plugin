package com.zcode.kb.core

import com.zcode.kb.text.KbTokenizer
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption

/**
 * 知识库纯文件存储（`~/.zcgui/knowledge/` 下，根目录即库根）：
 *
 * ```
 * config.json          # 目录树（folders 有序）+ 收录默认目录
 * entries/<id>.json    # 每条目一份元数据（KbEntry 序列化，文本可读）
 * text/<id>.txt        # 提取文本缓存（检索与预览的语料）
 * ```
 *
 * 目录树（2026-11-21 改版）：模块/项目分组层退役，用户自建嵌套目录（层级不限），
 * 条目挂 folderId（"" = 根级垫底）。目录用 id 引用而非路径：重命名/移动不改子条目，
 * 展示路径实时派生（[folderPath]）。旧版 config（version 1 modules 清单）反序列化时
 * folders 缺省空表 → 自然视为空目录树（不迁移，旧测试数据允许失效）。
 *
 * 为什么去 SQLite：sqlite-jdbc 单 jar ~13.5MB（全平台 native，无瘦身手段）占了插件
 * zip 的一半；千条以内规模纯文件 + 内存扫描毫秒级。
 *
 * 并发模型：IDE 进程读写（本类）、MCP server 进程只读（KbServerStore）。写一律
 * 临时文件 + ATOMIC_MOVE（读侧永远看到完整旧文件或完整新文件，无撕裂）；进程内
 * 单锁串行；跨 IDE 窗口对同条目的并发写=后写覆盖（同源数据，内容一致，无害）。
 * 条目文件名必须匹配 [ID_SAFE]，损坏 JSON / 非法文件名直接跳过（隔离，不炸全库）。
 *
 * 红线：本文件及整个 knowledge-core 不出现 zcode 会话库（db.sqlite/tasks-index.sqlite）
 * 的任何路径引用。
 */
class KbFileStore(private val root: Path) : AutoCloseable {

    private val lock = Any()
    private val entriesDir = root.resolve("entries")
    private val textDir = root.resolve("text")
    private val configFile = root.resolve("config.json")

    init {
        Files.createDirectories(entriesDir)
        Files.createDirectories(textDir)
    }

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

    /** 过滤列表（无查询词；搜索走 [search]） */
    fun listEntries(f: KbFilter = KbFilter(), limit: Int = 1000): List<KbEntry> = synchronized(lock) {
        allEntriesLocked()
            .filter { matchesFilter(it, f) }
            .sortedByDescending { it.ingestedAt } // sortedByDescending 稳定排序，同刻按落盘序
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

    /** 摘除条目（只删登记与缓存，绝不动源文件——安全语义） */
    fun removeEntry(id: String) = synchronized(lock) {
        Files.deleteIfExists(entriesDir.resolve("$id.json"))
        Files.deleteIfExists(textDir.resolve("$id.txt"))
    }

    fun setStatus(id: String, status: String) = synchronized(lock) {
        val e = readEntry(id) ?: return@synchronized
        writeEntry(e.copy(status = status, updatedAt = System.currentTimeMillis()))
    }

    fun readText(id: String): String? = synchronized(lock) {
        if (!id.matches(ID_SAFE)) return@synchronized null
        val f = textDir.resolve("$id.txt")
        if (!Files.isRegularFile(f)) return@synchronized null
        runCatching { Files.readString(f) }.getOrNull()
    }

    /** 清空提取文本缓存并复位对账 stat（设置页「重建索引」第一步） */
    fun clearIndex() = synchronized(lock) {
        for (f in listRegularFiles(textDir)) Files.deleteIfExists(f)
        for (e in allEntriesLocked()) writeEntry(e.copy(indexedMtime = 0, indexedSize = 0))
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
     * afterId 非空 = 插到目标层该兄弟之后（null = 追加尾部），目标层 order 全量重写。
     * @return false = 防环拒绝
     */
    fun moveFolder(id: String, newParentId: String?, afterId: String? = null): Boolean = synchronized(lock) {
        val cfg = readConfig()
        if (cfg.folders.none { it.id == id }) return@synchronized false
        val parent = newParentId?.takeIf { it.isNotEmpty() }
        if (parent != null && isDescendantLocked(cfg.folders, ancestor = id, node = parent)) return@synchronized false
        val siblings = cfg.folders.filter { it.parentId == parent && it.id != id } // 原位摘出（同层重排/跨层同形）
        reorderLocked(cfg, id, parent, siblings, afterId)
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

    /** 收录默认目录记忆（弹窗预选），"" = 根级 */
    fun lastFolderId(): String = synchronized(lock) { readConfig().lastFolderId }

    fun setLastFolderId(id: String) = synchronized(lock) {
        writeConfig(readConfig().copy(lastFolderId = id))
    }

    /**
     * 移动条目到目标目录（"" = 根级/根级直放）。目标目录不存在（断链/损坏）容错回根级。
     * 条目同层精细排序一期不做（无 order 字段，层内视觉序=ingestedAt），目录层排序见 [moveFolder]。
     */
    fun moveEntries(ids: List<String>, targetFolderId: String) = synchronized(lock) {
        if (ids.isEmpty()) return@synchronized
        val cfg = readConfig()
        val known = cfg.folders.map { it.id }.toHashSet()
        val target = if (targetFolderId.isEmpty() || known.contains(targetFolderId)) targetFolderId else ""
        for (id in ids) {
            val e = readEntry(id) ?: continue
            if (e.folderId != target) {
                writeEntry(e.copy(folderId = target, updatedAt = System.currentTimeMillis()))
            }
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
     * 目录同层/跨层移动落位：从旧位置摘出（跨层时父指针已由调用方语义决定），目标层
     * 兄弟按 afterId 插位后全量重写 order（0..n-1），移动目录本身 parentId 同步改。
     */
    private fun reorderLocked(cfg: KbConfigFile, id: String, parent: String?, siblings: List<KbFolder>, afterId: String?) {
        val moving = cfg.folders.first { it.id == id }
        val insertAt = if (afterId == null) siblings.size
        else siblings.indexOfFirst { it.id == afterId }.let { if (it < 0) siblings.size else it + 1 }
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

    /** 无持久连接，仅为 `use {}`/Disposer 形面保留 */
    override fun close() {
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
 * config.json（version 2）：目录树 + 标签注册表 + 收录默认目录记忆。
 * 旧版 version 1（modules 字符串清单）读取时 folders/tags 缺省空表——不迁移，自然重置。
 */
@Serializable
data class KbConfigFile(
    val version: Int = 2,
    val folders: List<KbFolder> = emptyList(),
    val tags: List<KbTagMeta> = emptyList(),
    val lastFolderId: String = "",
)

/** 标签注册表条目：名字 + 颜色（hex，如 #4A9EFF）。条目 tags 只存名字，颜色在此一层。 */
@Serializable
data class KbTagMeta(
    val name: String,
    val color: String,
)
