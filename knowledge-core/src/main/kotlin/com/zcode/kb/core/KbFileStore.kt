package com.zcode.kb.core

import com.zcode.kb.text.KbTokenizer
import kotlinx.serialization.Serializable
import java.nio.file.Files
import java.nio.file.Path
import java.util.function.Consumer

/**
 * 知识库存储的 IDE 侧入口。条目、目录树、标签的增删改查与收录一律转给 [KbMetaStore]——元数据
 * 读写只有那一份实现，MCP server 侧（KbServerStore）用的也是它，两边写出的文件逐字节同形。
 * 本类只做两件事：把数据类换进换出（界面代码继续用 [KbEntry]、[KbFolder]），以及检索
 * （[search]，只读）。
 *
 * ```
 * config.json          目录树（folders 有序）+ 标签注册表
 * entries/<id>.json    每条目一份元数据
 * text/<id>.txt        检索缓存（提取文本；可重建，不进版本历史）
 * snapshots/<id>/...   文档快照（源文件原始字节）
 * ```
 *
 * 内容（文档快照、检索缓存、三态读取、对账）的规则在 [KbContent]，同样与 MCP server 共用；
 * 对账的结果经 [confirmContent] 落盘。
 *
 * 目录树：用户自建嵌套目录（层级不限），条目挂 folderId（"" = 根级）。目录用 id 引用而非路径：
 * 重命名、移动不改子条目，展示路径实时派生（[folderPath]）。
 *
 * 并发模型见 [KbMetaStore]：写一律临时文件 + ATOMIC_MOVE，进程内单锁，跨进程对同条目的并发写
 * = 后写覆盖。关库（库位置迁移）后写入一律拒绝。
 *
 * 红线：本文件及整个 knowledge-core 不出现 zcode 会话库（db.sqlite / tasks-index.sqlite）的任何路径引用。
 */
class KbFileStore(private val root: Path) : AutoCloseable {

    private val core = KbMetaStore(root)

    init {
        core.ensureDirectories()
    }

    /** 库根目录（[KbContent] 的 root 参数） */
    fun root(): Path = root

    // ───────────────────────── 条目 ─────────────────────────

    /** 条目数与 [allEntries] 同口径（损坏文件不计入；注入门控 `entryCount<=0` 依赖这一点） */
    fun entryCount(): Int = core.entries().size

    fun getEntry(id: String): KbEntry? = core.entry(id)?.let(::toEntry)

    /** 按源路径判重（normPath 键，扫描比对——千条以内毫秒级） */
    fun findBySource(path: String): KbEntry? = core.findBySource(path)?.let(::toEntry)

    /** 全量条目（sweep、重建用；按 id 排序） */
    fun allEntries(): List<KbEntry> = core.entries().map(::toEntry)

    /** 过滤列表（无查询词；搜索走 [search]）。层内手动序：order 升序，并列（0=未拖过）按 ingestedAt 倒序 */
    fun listEntries(f: KbFilter = KbFilter(), limit: Int = 1000): List<KbEntry> =
        core.list(f.toFilter(), limit).map(::toEntry)

    /** 新条目入库（正文缓存一并写入） */
    fun insert(e: KbEntry, text: String) = core.insert(e.toRecord(), text)

    /** 整条覆盖写入；text 非空时同步刷新提取文本缓存 */
    fun update(e: KbEntry, text: String?) = core.update(e.toRecord(), text)

    /**
     * 只改标签：锁内读最新条目 → transform → 写回，其余字段原样保留（调用方手里的条目
     * 可能是过期快照，不能拿它整条覆盖）。去重与清洗由调用方套在外面。
     * @return 是否写盘（条目不存在或标签无变化 = false）
     */
    fun updateTags(id: String, transform: (List<String>) -> List<String>): Boolean =
        core.updateTags(id) { transform(it) }

    /** 摘除条目：删登记、检索缓存与文档快照，绝不动源文件。已同步过的内容仍留在 git 历史里 */
    fun removeEntry(id: String) = core.removeEntry(id)

    fun readText(id: String): String? = core.readText(id)

    /**
     * 锁内读最新条目 → transform → 写回。调用方手里的条目可能是过期快照，不能拿它整条覆盖
     * （会冲掉期间别的入口改的字段）；transform 作用在库里的最新条目上。
     *
     * @param text 非空时同步刷新检索缓存
     * @return 写回后的条目；条目不存在返回 null（不写盘）
     */
    fun transformEntry(id: String, text: String? = null, transform: (KbEntry) -> KbEntry): KbEntry? =
        core.transform(id, text) { r -> transform(toEntry(r)).toRecord() }?.let(::toEntry)

    /**
     * 内容对账落盘：只改内容哈希与大小，别的字段原样保留；不动 updatedAt（两台电脑各自对账到
     * 同一处变化时写下的条目文件要逐字节相同）。详见 [KbMetaStore.confirmContent]。
     *
     * @return 是否写盘（条目不存在或字段已是目标值 = false）
     */
    fun confirmContent(id: String, hash: String, size: Long): Boolean = core.confirmContent(id, hash, size)

    /** 对账入参：全部条目的内容视图 */
    fun contentSources(): List<KbContent.Source> = core.contentSources()

    /** 清空检索缓存（设置页「重建索引」第一步；之后的重提取走 KbContent.rebuildText） */
    fun clearIndex() = core.clearIndex()

    // ───────────────────────── 收录与元数据编辑 ─────────────────────────

    /**
     * 收录（新收录或同一源文件再次收录），落库规则只有 [KbMetaStore.ingest] 一份。
     * onError：提取正文、落文档快照、查 git 失败时回调，这些失败都不拦收录。
     */
    fun ingest(
        file: Path,
        title: String?,
        folderId: String?,
        tags: List<String>?,
        notes: String?,
        extractor: KbContent.TextExtractor,
        gitExe: String?,
        onError: Consumer<Exception>? = null,
    ): KbMetaStore.Ingested = core.ingest(file, title, folderId, tags, notes, extractor, gitExe, onError)

    /** 编辑元数据（标题、目录、标签、备注）；null = 不动，标题空白 = 保留原标题。条目不存在返回 null */
    fun edit(id: String, title: String?, folderId: String?, tags: List<String>?, notes: String?): KbEntry? {
        val edit = KbMetaStore.Edit()
        edit.title = title
        edit.folderId = folderId
        edit.tags = tags
        edit.notes = notes
        return core.edit(id, edit, null)?.let(::toEntry)
    }

    /** 条目改指新的源文件（重新链接）：text 是新源文件的检索缓存文本。条目不存在返回 null */
    fun relink(id: String, newFile: Path, text: String?): KbEntry? {
        val edit = KbMetaStore.Edit()
        edit.newFile = newFile
        edit.text = text ?: ""
        return core.edit(id, edit, null)?.let(::toEntry)
    }

    // ───────────────────────── 目录树 ─────────────────────────

    /** 目录全表（config 存储序；界面按 parentId+order 组树，空目录也返回） */
    fun folders(): List<KbFolder> = core.folders().map { toFolder(it) }

    /** 展示路径派生（`信创适配/中间件`）；未知 id 与根级返回 ""（根级同形） */
    fun folderPath(folderId: String): String = core.folderPath(folderId)

    /** 新建目录。同层重名允许（id 区分）；@return 新目录 id */
    fun createFolder(parentId: String?, name: String): String = core.createFolder(parentId, name)

    /** 按路径逐级确保目录存在（`a/b/c`，缺哪级建哪级）。@return 最末级目录 id */
    fun ensureFolderPath(path: String): String = core.ensureFolderPath(path)

    fun renameFolder(id: String, newName: String) = core.renameFolder(id, newName)

    /**
     * 移动目录到新父（null/"" = 根级）。防环：newParent 不得是自身或其子孙。
     * insertIndex = 目标层摘出前位次（界面插入线换算值，同 [reorderEntries] 语义；默认尾部）。
     * @return false = 防环拒绝
     */
    fun moveFolder(id: String, newParentId: String?, insertIndex: Int = Int.MAX_VALUE): Boolean =
        core.moveFolder(id, newParentId, insertIndex)

    /**
     * 删目录：子目录连带删除，其下条目一律退回根级（""，不丢数据）。
     * @return 移入根级的条目数（确认框文案用）
     */
    fun deleteFolder(id: String): Int = core.deleteFolder(id)

    /**
     * 移动、重排条目（拖拽落位的统一入口）：insertIndex 是目标层摘出前的位次（默认尾部），
     * 同层自拖的摘出偏移内部校正。order 变更不刷 updatedAt，仅 folderId 变化才刷。
     * 详见 [KbMetaStore.reorderEntries]。
     */
    fun reorderEntries(ids: List<String>, targetFolderId: String, insertIndex: Int = Int.MAX_VALUE) =
        core.reorderEntries(ids, targetFolderId, insertIndex)

    // ───────────────────────── 标签 / 项目 ─────────────────────────

    fun allTags(): List<String> = core.allTags()

    /** 标签使用计数（管理对话框列表）：条目聚合 + 注册表（含无主标签 count=0） */
    fun tagCounts(): Map<String, Int> = core.tagCounts()

    /** 标签注册表（名字+颜色；条目 tags 仍存名字数组，颜色在此一层） */
    fun tagMetas(): List<KbTagMeta> = core.tagMetas().map { KbTagMeta(it.name, it.color) }

    /** 注册标签（已存在仅保留原色）。@return 标签颜色 */
    fun ensureTagMeta(name: String, color: String): String = core.ensureTagMeta(name, color)

    fun setTagColor(name: String, color: String) = core.setTagColor(name, color)

    /** 全局重命名标签（改写全部含该标签的条目 + 注册表）。@return 改写条目数 */
    fun renameTag(from: String, to: String): Int = core.renameTag(from, to)

    /** 从全部条目移除标签 + 注册表删除。@return 影响条目数 */
    fun deleteTag(name: String): Int = core.deleteTag(name)

    fun allProjects(): List<String> = core.allProjects()

    // ───────────────────────── 检索（只读） ─────────────────────────

    /**
     * 全文检索：内存扫描 text/ 缓存。分词用 [KbTokenizer]（latin 词元 + CJK bigram），
     * 命中判据 = 每个词元都出现在 标题/标签/正文 任一渠道（小写包含，AND 语义）；
     * 打分按计次加权（标题 4 : 标签 2 : 正文 1）；摘要取命中点前后窗口。
     * 文本缓存缺失的条目仍可按标题/标签命中（预览/读全文自然降级）。
     */
    fun search(rawQuery: String, f: KbFilter = KbFilter(), limit: Int = 50): List<KbHit> {
        val tokens = KbTokenizer.tokens(rawQuery)
        if (tokens.isEmpty()) return emptyList()
        val hits = ArrayList<KbHit>()
        for (e in allEntries()) {
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
    override fun close() = core.close()

    companion object {
        /** 公共实现的条目 → 界面用的数据类 */
        fun toEntry(r: KbMetaStore.Entry): KbEntry = KbEntry(
            id = r.id,
            sourcePath = r.sourcePath,
            title = r.title,
            folderId = r.folderId,
            tags = r.tags,
            notes = r.notes,
            project = r.project,
            fileExt = r.fileExt,
            sizeBytes = r.sizeBytes,
            contentHash = r.contentHash,
            ingestedAt = r.ingestedAt,
            updatedAt = r.updatedAt,
            order = r.order,
        )

        private fun toFolder(f: KbMetaStore.Folder): KbFolder = KbFolder(
            id = f.id,
            name = f.name,
            parentId = f.parentId,
            order = f.order,
        )

        private fun KbEntry.toRecord(): KbMetaStore.Entry = KbMetaStore.Entry().also {
            it.id = id
            it.sourcePath = sourcePath
            it.title = title
            it.folderId = folderId
            it.tags = tags
            it.notes = notes
            it.project = project
            it.fileExt = fileExt
            it.sizeBytes = sizeBytes
            it.contentHash = contentHash
            it.ingestedAt = ingestedAt
            it.updatedAt = updatedAt
            it.order = order
        }

        private fun KbFilter.toFilter(): KbMetaStore.Filter =
            KbMetaStore.Filter(folderId, tags, tagMatchAll, project)

        /** 收录时的标签清洗：去逗号/引号/首尾空白，去空项、去重保序，最多 20 个（规则在 [KbMetaStore]） */
        fun sanitizeTags(tags: List<String>): List<String> = KbMetaStore.sanitizeTags(tags)

        /** 判重键：反斜杠归一正斜杠 + Windows 下小写（不区分大小写盘） */
        fun normPath(p: String): String = KbMetaStore.normPath(p)

        /** 展示态路径：反斜杠归一正斜杠，保留大小写 */
        fun displayPath(p: String): String = KbMetaStore.displayPath(p)

        /** 条目 id = 源路径的确定性哈希，详见 [KbMetaStore.newId] */
        fun newId(sourcePath: String, taken: Set<String> = emptySet()): String =
            KbMetaStore.newId(sourcePath, taken)

        /** 目录 id：f- 前缀与条目 id 区分（同白名单字符集） */
        fun newFolderId(): String = KbMetaStore.newFolderId()

        /** 标签自动分配色板（8 色轮转）；chip 字色按亮度自适配黑白（界面侧判定） */
        val TAG_PALETTE: List<String> = KbMetaStore.TAG_PALETTE

        /**
         * 新建标签自动分配：优先取未被占用的色板色（按色板顺序取第一个空闲）；
         * 色板用尽才取占用最少的颜色重复（用户拍板：颜色尽量不重复，不够了才重复）。
         */
        fun pickTagColor(existing: List<KbTagMeta>): String =
            KbMetaStore.pickTagColor(existing.map { KbMetaStore.Tag(it.name, it.color) })
    }
}

/** 标签注册表条目：名字 + 颜色（hex，如 #4A9EFF）。条目 tags 只存名字，颜色在此一层。 */
@Serializable
data class KbTagMeta(
    val name: String,
    val color: String,
)
