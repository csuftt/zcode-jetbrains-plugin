package com.zcode.kb.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.Base64
import java.util.concurrent.TimeUnit

/**
 * 知识库的库位置（单根模型）。
 *
 * 固定入口是用户目录下的 `.zcgui/knowledge`。未自定义时入口就是库目录；自定义后库目录
 * （git 仓库根）在用户所选位置，入口是指向它的目录联接（Windows）或符号链接
 * （macOS / Linux）。MCP server 与外部脚本只用入口路径，对库位置无感知。
 *
 * 指针文件 `.zcgui/knowledge.location.json`（内容是库目录的真实位置）与入口并存：入口联接
 * 本身就是唯一的指向记录，被删后插件无从得知库在哪，所以另留指针文件用于重建入口
 * （[ensureEntry]，每次启动对齐）。
 *
 * 与 zcode CLI 的 ~/.zcode 全然无关——红线：绝不读写 zcode 的 db.sqlite / tasks-index.sqlite。
 *
 * 几条实现约束（Windows 真机实测）：
 * - 搬移和删除只对真实路径做——穿过入口做递归删除会删光库的实际内容；入口只在确为联接时
 *   非递归删除；
 * - JDK 17 上目录联接不被当作符号链接（isSymbolicLink 为假、readSymbolicLink 抛异常），
 *   判联接看 reparse point 属性位，取真实位置用 toRealPath；
 * - 跨盘搬移是「复制 → 校验 → 删源」，删源前先去掉 git 对象文件的只读属性，否则停在半途；
 * - 路径是否相同一律用解析后的真实路径判断（git 报告的仓库根是真实路径而不是入口路径）；
 * - 目录联接只能指向本机卷，网络路径不支持——目标在动盘之前先探一次。
 */
object KbPaths {

    private val json = Json { ignoreUnknownKeys = true }

    private val IS_WINDOWS = System.getProperty("os.name", "").lowercase().contains("windows")

    /** FILE_ATTRIBUTE_REPARSE_POINT：目录联接与符号链接都带这一位 */
    private const val REPARSE_POINT = 0x400

    private const val RENAME_RETRIES = 3

    private val STAMP: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss")

    // ───────────────────────── 位置解析 ─────────────────────────

    private fun homeOf(home: String?): Path = Path.of(home ?: System.getProperty("user.home") ?: ".")

    /** 固定入口（系统盘；自定义库位置后是指向库目录的联接或符号链接） */
    fun entryDir(home: String? = null): Path = homeOf(home).resolve(".zcgui").resolve("knowledge")

    /** 指针文件：记录库目录的真实位置，入口缺失时据此重建 */
    fun pointerFile(home: String? = null): Path = entryDir(home).resolveSibling("knowledge.location.json")

    /**
     * 库目录的真实位置。入口在（含联接）就用入口解析出的真实路径；入口缺失时指针文件记的
     * 目录还在就用它；否则是入口路径本身（默认位置，首次使用时才创建）。
     */
    fun rootDir(home: String? = null): Path {
        val entry = entryDir(home)
        if (Files.isDirectory(entry, LinkOption.NOFOLLOW_LINKS)) {
            try {
                return entry.toRealPath()
            } catch (e: IOException) {
                // 入口是联接但目标不可达（盘没挂上）：落到下面按指针找
            }
        }
        pointerRoot(home)?.let { if (Files.isDirectory(it, LinkOption.NOFOLLOW_LINKS)) return it }
        return entry
    }

    fun isCustomized(home: String? = null): Boolean {
        val entry = entryDir(home)
        if (SystemLinkOps.isLink(entry)) return true
        return !Files.exists(entry, LinkOption.NOFOLLOW_LINKS) &&
            pointerRoot(home)?.let { Files.isDirectory(it, LinkOption.NOFOLLOW_LINKS) } == true
    }

    fun configFile(home: String? = null): Path = rootDir(home).resolve("config.json")

    fun entriesDir(home: String? = null): Path = rootDir(home).resolve(KbContent.ENTRIES_DIR)

    /** 检索缓存目录（每条目一份文本；可重建，不进版本历史） */
    fun textDir(home: String? = null): Path = rootDir(home).resolve(KbContent.TEXT_DIR)

    /** 文档快照目录（每条目一个子目录） */
    fun snapshotsDir(home: String? = null): Path = rootDir(home).resolve(KbContent.SNAPSHOTS_DIR)

    /**
     * 启动对齐（幂等）：保证入口可用并返回库目录的真实位置。
     * 自定义态补写指针文件（联接在、指针丢了的情形）；默认态清掉残留指针；入口缺失而指针
     * 记的目录还在就重建入口。入口是坏联接（目标不可达）时抛 IOException。
     */
    fun ensureEntry(home: String? = null): Path {
        val entry = entryDir(home)
        Files.createDirectories(entry.parent)
        if (Files.isDirectory(entry, LinkOption.NOFOLLOW_LINKS)) {
            val real = try {
                entry.toRealPath()
            } catch (e: IOException) {
                throw IOException("knowledge base entry is a broken link: $entry", e)
            }
            if (SystemLinkOps.isLink(entry)) {
                // 指针与联接并存：联接在而指针丢了（或指的不是这里）就补写
                val recorded = pointerRoot(home)
                if (recorded == null || !samePath(recorded, real)) writePointer(home, real)
                return real
            }
            deletePointer(home)
            return real
        }
        val target = pointerRoot(home)
        if (target != null && Files.isDirectory(target, LinkOption.NOFOLLOW_LINKS)) {
            SystemLinkOps.create(entry, target)
            return target
        }
        return entry
    }

    // ───────────────────────── 改库位置 ─────────────────────────

    enum class RejectReason {
        NOT_ABSOLUTE,
        NETWORK_PATH,
        INSIDE_LIBRARY,
        LIBRARY_INSIDE_TARGET,
        TARGET_OCCUPIED,
        CURRENT_NOT_EMPTY,
        LINK_UNSUPPORTED,
        MOVE_FAILED,
    }

    sealed class Relocate {
        class Done(val root: Path) : Relocate()

        class Rejected(val reason: RejectReason, val detail: String? = null) : Relocate()
    }

    /**
     * 把库位置改到 target；target 传入口路径即恢复默认。调用方须先释放目录监听、关闭库
     * 连接，完成后再重挂——Windows 上监听句柄会锁住目录。任一步失败回滚到原状。
     *
     * 目标已经是知识库仓库（自行克隆好的）且当前库为空时直接接入，不搬不覆盖。
     */
    fun relocate(targetRaw: Path, home: String? = null): Relocate = relocate(targetRaw, home, SystemLinkOps)

    /** 同上；入口联接的实现可替换（测试用它注入失败，验证回滚） */
    internal fun relocate(
        targetRaw: Path,
        home: String?,
        links: LinkOps,
    ): Relocate {
        if (!targetRaw.isAbsolute) return Relocate.Rejected(RejectReason.NOT_ABSOLUTE)
        val entry = entryDir(home).toAbsolutePath().normalize()
        val target = targetRaw.toAbsolutePath().normalize()
        if (isNetworkPath(target)) return Relocate.Rejected(RejectReason.NETWORK_PATH)
        // 目标是个文件（或别的非目录）：先拒绝，否则 move 会把它替换掉
        if (Files.exists(target, LinkOption.NOFOLLOW_LINKS) && !Files.isDirectory(target, LinkOption.NOFOLLOW_LINKS)) {
            return Relocate.Rejected(RejectReason.TARGET_OCCUPIED, "not a directory: $target")
        }

        val entryIsLink = links.isLink(entry)
        val pointerDir = pointerRoot(home)?.takeIf { Files.isDirectory(it, LinkOption.NOFOLLOW_LINKS) }
        val custom = entryIsLink ||
            (!Files.exists(entry, LinkOption.NOFOLLOW_LINKS) && pointerDir != null)
        val current: Path = when {
            Files.isDirectory(entry, LinkOption.NOFOLLOW_LINKS) ->
                realOrNull(entry)
                    ?: return Relocate.Rejected(RejectReason.MOVE_FAILED, "knowledge base entry is a broken link: $entry")
            entryIsLink -> pointerDir // 入口是联接而目录项读不到：按指针找
                ?: return Relocate.Rejected(RejectReason.MOVE_FAILED, "knowledge base entry is a broken link: $entry")
            pointerDir != null -> pointerDir
            else -> entry
        }

        // ── 恢复默认：摘掉入口联接 → 库搬回入口路径 → 删指针 ──
        if (samePath(target, entry)) {
            if (!custom) return Relocate.Done(current)
            if (!Files.isDirectory(current, LinkOption.NOFOLLOW_LINKS)) {
                return Relocate.Rejected(RejectReason.MOVE_FAILED, "library directory is unavailable: $current")
            }
            try {
                if (entryIsLink) links.remove(entry)
                moveTree(current, entry)
                deletePointer(home)
                return Relocate.Done(entry)
            } catch (e: Exception) {
                runCatching { links.create(entry, current) } // 源由 moveTree 保住，入口与指针原样恢复
                return Relocate.Rejected(RejectReason.MOVE_FAILED, e.toString())
            }
        }

        // ── 目标校验 ──
        val targetReal = if (Files.isDirectory(target, LinkOption.NOFOLLOW_LINKS)) realOrNull(target) else null
        val curReal = realOrNull(current) ?: current
        val newRoot = targetReal ?: target
        if (samePath(newRoot, curReal)) return Relocate.Done(current) // 幂等
        if (isUnder(newRoot, curReal)) return Relocate.Rejected(RejectReason.INSIDE_LIBRARY)
        if (isUnder(curReal, newRoot)) return Relocate.Rejected(RejectReason.LIBRARY_INSIDE_TARGET)
        val currentHasContent = hasLibraryContent(current)
        var adoptExisting = false
        if (targetReal != null) {
            if (!Files.isDirectory(target, LinkOption.NOFOLLOW_LINKS)) {
                return Relocate.Rejected(RejectReason.TARGET_OCCUPIED, "not a directory: $target")
            }
            adoptExisting = KbSync.looksLikeLibrary(target)
            if (adoptExisting) {
                if (currentHasContent) return Relocate.Rejected(RejectReason.CURRENT_NOT_EMPTY)
            } else if (!isEmptyDir(target)) {
                return Relocate.Rejected(RejectReason.TARGET_OCCUPIED)
            }
        }
        if (!links.supported(newRoot)) return Relocate.Rejected(RejectReason.LINK_UNSUPPORTED)

        return if (adoptExisting) {
            adopt(entry, newRoot, custom, current, links, home)
        } else {
            moveLibrary(entry, current, newRoot, custom, links, home)
        }
    }

    /** 接入一个已存在的知识库仓库：当前库让出入口（自定义态摘联接，默认态目录改名保留），入口指向目标 */
    private fun adopt(
        entry: Path,
        target: Path,
        custom: Boolean,
        current: Path,
        links: LinkOps,
        home: String?,
    ): Relocate {
        var aside: Path? = null
        try {
            if (custom) {
                links.remove(entry)
            } else if (Files.exists(entry, LinkOption.NOFOLLOW_LINKS)) {
                // 默认位置的空库目录：改名让位，不删（里面可能还有检索缓存之类的残留）
                val moved = entry.resolveSibling(entry.fileName.toString() + ".pre-adopt-" + STAMP.format(LocalDateTime.now()))
                Files.move(entry, moved)
                aside = moved
            }
        } catch (e: Exception) {
            return Relocate.Rejected(RejectReason.MOVE_FAILED, e.toString())
        }
        val pointerOk = writePointer(home, target)
        if (pointerOk) {
            try {
                links.create(entry, target)
                return Relocate.Done(target)
            } catch (e: Exception) {
                runCatching { links.remove(entry) }
            }
        }
        // 回滚：入口与指针恢复原样
        if (custom) runCatching { links.create(entry, current) } else aside?.let { runCatching { Files.move(it, entry) } }
        if (custom) writePointer(home, current) else deletePointer(home)
        return Relocate.Rejected(RejectReason.MOVE_FAILED, "could not create the entry link at $entry")
    }

    /** 把整个库目录搬到 newRoot，入口改（建）为指向它的联接，指针同步 */
    private fun moveLibrary(
        entry: Path,
        current: Path,
        newRoot: Path,
        custom: Boolean,
        links: LinkOps,
        home: String?,
    ): Relocate {
        if (custom) {
            if (!Files.isDirectory(current, LinkOption.NOFOLLOW_LINKS)) {
                return Relocate.Rejected(RejectReason.MOVE_FAILED, "library directory is unavailable: $current")
            }
            val oldRoot = realOrNull(current) ?: current
            try {
                links.remove(entry) // 指针仍记着旧位置
            } catch (e: Exception) {
                return Relocate.Rejected(RejectReason.MOVE_FAILED, e.toString())
            }
            try {
                moveTree(oldRoot, newRoot)
            } catch (e: Exception) {
                runCatching { links.create(entry, oldRoot) } // 源由 moveTree 保住
                return Relocate.Rejected(RejectReason.MOVE_FAILED, e.toString())
            }
            // 指针写不进去不算失败：下次启动 ensureEntry 会按入口联接补写
            writePointer(home, newRoot)
            return try {
                Files.createDirectories(newRoot)
                links.create(entry, newRoot)
                Relocate.Done(newRoot)
            } catch (e: Exception) {
                val rollbackFailure = rollback(links, entry, newRoot, oldRoot)
                runCatching { links.create(entry, oldRoot) }
                writePointer(home, oldRoot)
                Relocate.Rejected(RejectReason.MOVE_FAILED, (rollbackFailure ?: e).toString())
            }
        }
        // 默认态：入口目录整体搬到新位置，入口路径再建为联接
        try {
            moveTree(entry, newRoot)
        } catch (e: Exception) {
            return Relocate.Rejected(RejectReason.MOVE_FAILED, e.toString())
        }
        writePointer(home, newRoot)
        return try {
            Files.createDirectories(newRoot)
            links.create(entry, newRoot)
            Relocate.Done(newRoot)
        } catch (e: Exception) {
            val rollbackFailure = rollback(links, entry, newRoot, entry)
            deletePointer(home)
            Relocate.Rejected(RejectReason.MOVE_FAILED, (rollbackFailure ?: e).toString())
        }
    }

    /**
     * 建入口联接失败的回滚：先摘掉可能残留的入口，再把已经搬到 from 的库搬回 to。
     * @return 回滚本身失败时的异常（此时库在 from，调用方要把位置报给用户）；回滚成功返回 null
     */
    private fun rollback(links: LinkOps, entry: Path, from: Path, to: Path): Throwable? {
        runCatching { links.remove(entry) }
        return runCatching { moveTree(from, to) }.exceptionOrNull()
    }

    // ───────────────────────── 目录搬移 ─────────────────────────

    /**
     * 目录整体搬移：同卷改名（瞬时句柄占用退避重试）；跨卷是复制 → 校验 → 删源。
     * 抛异常时源目录完整、目标已清掉（个别的恢复失败会带上两处位置说明数据在哪）。
     * Files.move 跨卷对非空目录不可用（DirectoryNotEmptyException），所以跨卷不走 move。
     */
    internal fun moveTree(src: Path, dst: Path) {
        if (!Files.exists(src, LinkOption.NOFOLLOW_LINKS) || samePath(src, dst)) return
        Files.createDirectories(dst.parent)
        if (Files.isDirectory(dst, LinkOption.NOFOLLOW_LINKS) && isEmptyDir(dst)) Files.delete(dst)
        var last: IOException? = null
        for (attempt in 0 until RENAME_RETRIES) {
            try {
                Files.move(src, dst, StandardCopyOption.ATOMIC_MOVE)
                return
            } catch (e: AtomicMoveNotSupportedException) {
                crossVolumeMove(src, dst)
                return
            } catch (e: IOException) {
                last = e // 目录被别的进程占着：退避后重试
                try {
                    Thread.sleep(200L * (attempt + 1))
                } catch (ie: InterruptedException) {
                    Thread.currentThread().interrupt()
                    throw e
                }
            }
        }
        throw last ?: IOException("move failed: $src -> $dst")
    }

    private fun crossVolumeMove(src: Path, dst: Path) {
        try {
            copyTree(src, dst)
        } catch (e: IOException) {
            runCatching { deleteTreeQuietly(dst) }
            throw e
        }
        if (!treeMatches(src, dst)) {
            runCatching { deleteTreeQuietly(dst) }
            throw IOException("copy verification failed: $src -> $dst")
        }
        try {
            deleteTree(src)
        } catch (e: IOException) {
            // 源删了一半：从完整的目标副本补回源，再清目标
            val restored = runCatching { copyTree(dst, src); treeMatches(src, dst) }.getOrDefault(false)
            if (restored) runCatching { deleteTreeQuietly(dst) }
            throw if (restored) {
                e
            } else {
                IOException("move interrupted: complete copy at $dst, source partially removed: $src", e)
            }
        }
    }

    /** 递归复制；带时间戳与只读属性（git 对象文件）。库里的联接/符号链接不穿透、不复制 */
    private fun copyTree(src: Path, dst: Path) {
        if (SystemLinkOps.isLink(src)) return
        if (Files.isDirectory(src, LinkOption.NOFOLLOW_LINKS)) {
            Files.createDirectories(dst)
            for (c in children(src)) copyTree(c, dst.resolve(c.fileName.toString()))
            return
        }
        if (Files.exists(dst) && !Files.isWritable(dst)) dst.toFile().setWritable(true)
        Files.copy(src, dst, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.COPY_ATTRIBUTES)
    }

    /** 递归删除；只读文件先去只读。删不掉的抛出，不动联接指向的内容 */
    private fun deleteTree(p: Path) {
        var failure: IOException? = null
        if (Files.isDirectory(p, LinkOption.NOFOLLOW_LINKS) && !SystemLinkOps.isLink(p)) {
            for (c in children(p)) {
                try {
                    deleteTree(c)
                } catch (e: IOException) {
                    failure = e
                }
            }
        }
        try {
            if (IS_WINDOWS && Files.exists(p, LinkOption.NOFOLLOW_LINKS)) p.toFile().setWritable(true)
            Files.deleteIfExists(p)
        } catch (e: IOException) {
            failure = e
        }
        failure?.let { throw it }
    }

    private fun deleteTreeQuietly(p: Path) {
        runCatching { deleteTree(p) }
    }

    private fun children(dir: Path): List<Path> =
        Files.newDirectoryStream(dir).use { s -> s.toList() }

    /** 两处目录的文件清单与大小逐一对得上 */
    private fun treeMatches(a: Path, b: Path): Boolean = fileSizes(a) == fileSizes(b)

    private fun fileSizes(root: Path): Map<String, Long> {
        val out = HashMap<String, Long>()
        fun walk(p: Path) {
            if (SystemLinkOps.isLink(p)) return
            if (Files.isDirectory(p, LinkOption.NOFOLLOW_LINKS)) {
                for (c in children(p)) walk(c)
            } else {
                out[root.relativize(p).toString()] = Files.size(p)
            }
        }
        if (Files.exists(root, LinkOption.NOFOLLOW_LINKS)) walk(root)
        return out
    }

    // ───────────────────────── 库形态判定 ─────────────────────────

    private fun isEmptyDir(p: Path): Boolean =
        !Files.exists(p, LinkOption.NOFOLLOW_LINKS) ||
            (Files.isDirectory(p, LinkOption.NOFOLLOW_LINKS) && children(p).isEmpty())

    /** 库里有没有内容：有版本历史、有条目、有文档快照，或 config 里有目录/标签 */
    fun hasLibraryContent(dir: Path): Boolean {
        if (!Files.isDirectory(dir, LinkOption.NOFOLLOW_LINKS)) return false
        if (Files.isDirectory(dir.resolve(".git"))) return true
        dir.resolve(KbContent.ENTRIES_DIR).takeIf { Files.isDirectory(it) }
            ?.let { if (children(it).any { f -> Files.isRegularFile(f) }) return true }
        dir.resolve(KbContent.SNAPSHOTS_DIR).takeIf { Files.isDirectory(it) }
            ?.let { if (children(it).isNotEmpty()) return true }
        val config = dir.resolve("config.json")
        if (Files.isRegularFile(config)) {
            val text = runCatching { Files.readString(config) }.getOrDefault("")
            val noFolders = Regex("\"folders\"\\s*:\\s*\\[\\s*\\]").containsMatchIn(text)
            val noTags = Regex("\"tags\"\\s*:\\s*\\[\\s*\\]").containsMatchIn(text)
            if (!(noFolders && noTags)) return true
        }
        return false
    }

    // ───────────────────────── 内部工具 ─────────────────────────

    private fun isNetworkPath(p: Path): Boolean {
        if (!IS_WINDOWS) return false
        val s = p.toString()
        return s.startsWith("\\\\") || s.startsWith("//")
    }

    private fun realOrNull(p: Path): Path? = try {
        p.toRealPath()
    } catch (e: IOException) {
        null
    }

    /** 路径判等：解析不了真实路径的按字面比；Windows 不分大小写 */
    private fun samePath(a: Path, b: Path): Boolean {
        val ra = realOrNull(a)
        val rb = realOrNull(b)
        if (ra != null && rb != null) return sameText(ra, rb)
        return sameText(a.toAbsolutePath().normalize(), b.toAbsolutePath().normalize())
    }

    private fun sameText(a: Path, b: Path): Boolean {
        val x = a.toAbsolutePath().normalize().toString()
        val y = b.toAbsolutePath().normalize().toString()
        return if (IS_WINDOWS) x.equals(y, ignoreCase = true) else x == y
    }

    /** child 是否在 parent 之内（不含相等） */
    private fun isUnder(child: Path, parent: Path): Boolean =
        !samePath(child, parent) && child.toAbsolutePath().normalize().startsWith(parent.toAbsolutePath().normalize())

    private fun pointerRoot(home: String?): Path? {
        val f = pointerFile(home)
        if (!Files.isRegularFile(f)) return null
        return try {
            json.parseToJsonElement(Files.readString(f)).jsonObject["root"]?.jsonPrimitive?.content?.trim()
                ?.takeIf { it.isNotEmpty() }?.let { Path.of(it).toAbsolutePath().normalize() }
        } catch (e: Exception) {
            null // 损坏/非法路径按没有处理
        }
    }

    private fun writePointer(home: String?, root: Path): Boolean = try {
        val pointer = pointerFile(home)
        Files.createDirectories(pointer.parent)
        val tmp = pointer.resolveSibling(pointer.fileName.toString() + ".tmp")
        val content = json.encodeToString(
            JsonObject.serializer(),
            buildJsonObject { put("root", root.toString()) },
        )
        Files.writeString(tmp, content)
        Files.move(tmp, pointer, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        true
    } catch (e: Exception) {
        false
    }

    private fun deletePointer(home: String?) {
        runCatching { Files.deleteIfExists(pointerFile(home)) }
    }

    // ───────────────────────── 入口联接 ─────────────────────────

    /** 入口联接/符号链接的操作面（搬迁与测试可替换实现） */
    internal interface LinkOps {
        fun isLink(p: Path): Boolean

        /** link 当前必须不存在；建完校验确实指到了 target，否则清掉并抛 IOException */
        fun create(link: Path, target: Path)

        /** 非递归删除，只摘链接本身；link 不是链接时抛 IOException（防把真实目录当入口删） */
        fun remove(link: Path)

        /** target 所在位置能否作为联接目标（目录联接只能指向本机卷） */
        fun supported(target: Path): Boolean
    }

    internal object SystemLinkOps : LinkOps {

        override fun isLink(p: Path): Boolean = try {
            if (IS_WINDOWS) {
                val attrs = Files.readAttributes(p, "dos:*", LinkOption.NOFOLLOW_LINKS)["attributes"] as? Int ?: 0
                attrs and REPARSE_POINT != 0
            } else {
                Files.isSymbolicLink(p)
            }
        } catch (e: Exception) {
            false
        }

        override fun create(link: Path, target: Path) {
            Files.createDirectories(link.parent)
            if (IS_WINDOWS) createJunction(link, target) else Files.createSymbolicLink(link, target)
            if (!sameText(link.toRealPath(), target.toRealPath())) {
                runCatching { Files.deleteIfExists(link) }
                throw IOException("entry link does not resolve to the library: $link -> $target")
            }
        }

        override fun remove(link: Path) {
            if (!Files.exists(link, LinkOption.NOFOLLOW_LINKS)) return
            if (!isLink(link)) throw IOException("not a link, refusing to delete: $link")
            Files.delete(link)
        }

        override fun supported(target: Path): Boolean {
            var anchor = target.toAbsolutePath().normalize()
            while (!Files.isDirectory(anchor)) {
                anchor = anchor.parent ?: return false
            }
            val probe = entryDir().parent.resolve(".knowledge-link-probe")
            return try {
                Files.deleteIfExists(probe) // 上次探针残留
                create(probe, anchor)
                remove(probe)
                true
            } catch (e: Exception) {
                runCatching { Files.deleteIfExists(probe) }
                false
            }
        }

        /**
         * Windows 目录联接：PowerShell New-Item -ItemType Junction。脚本体走 -EncodedCommand
         * （UTF-16LE Base64），中文、空格、& 等字符零转义；不需要管理员权限（符号链接需要）。
         */
        private fun createJunction(link: Path, target: Path) {
            val script = "\$ErrorActionPreference = 'Stop'; \$ProgressPreference = 'SilentlyContinue'; " +
                "New-Item -ItemType Junction -Path '" + psQuote(link) + "' -Target '" + psQuote(target) + "' | Out-Null"
            val encoded = Base64.getEncoder().encodeToString(script.toByteArray(StandardCharsets.UTF_16LE))
            val exe = System.getenv("SystemRoot")?.let {
                Path.of(it, "System32", "WindowsPowerShell", "v1.0", "powershell.exe").toString()
            } ?: "powershell.exe"
            val proc = ProcessBuilder(exe, "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded)
                .redirectErrorStream(true)
                .start()
            val output = proc.inputStream.readBytes()
            if (!proc.waitFor(60, TimeUnit.SECONDS)) {
                proc.destroyForcibly()
                throw IOException("junction creation timed out: $link")
            }
            if (proc.exitValue() != 0) {
                throw IOException(
                    "junction creation failed: " + String(output, StandardCharsets.UTF_8).trim().take(300),
                )
            }
        }

        private fun psQuote(p: Path): String = p.toString().replace("'", "''")
    }
}
