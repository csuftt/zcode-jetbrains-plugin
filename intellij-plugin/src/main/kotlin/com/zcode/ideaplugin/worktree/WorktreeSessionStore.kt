package com.zcode.ideaplugin.worktree

import java.nio.channels.FileChannel
import java.nio.charset.StandardCharsets
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption

/**
 * worktree 会话注册表的全局文件存储（缺陷HU，0.4.6）。
 *
 * 此前注册表落在 project 级 PropertiesComponent（`<项目>/.idea/workspace.xml`），
 * 「会话 ↔ 源目录」映射只在创建它的项目里可见：换一个项目关联同一目录，会话列表
 * 就查不到 worktree 会话。存储升级为插件自有跨 IDE 目录 `~/.zcgui/`（与额度历史
 * 同款口径），同机所有项目/IDE 读写同一份。
 *
 * 写入范式沿用仓库既有做法：进程内锁 + `.lock` sidecar 文件锁 + `.bak.1` 轮转 +
 * tmp/ATOMIC_MOVE 原子替换。解析失败（整体 JSON 非法）**拒绝当空表覆盖**：读时
 * 回退备份，写时把坏文件隔离为 `.corrupt-<epoch>` 后重建，避免一次损坏静默清空
 * 全部会话归属。单条缺字段仍按条丢弃（局部损坏不拖垮整表）。
 *
 * 纯 JVM（不依赖 IntelliJ），`home` 参数化便于临时目录单测。
 */
object WorktreeSessionStore {

    /** 文件格式版本由文件名承载（与旧 kv key `zcode.worktreeSessions.v1` 同代） */
    const val FILE_NAME = "worktree-sessions.v1.json"

    /** 条数硬顶：插件自建会话体量很小，纯粹防异常增长 */
    const val MAX_ENTRIES = 5_000

    private val PROCESS_LOCK = Any()

    private data class Snapshot(
        val file: Path,
        val modified: Long,
        val size: Long,
        val list: List<WorktreeRegistryStore.WorktreeSessionInfo>,
    )

    @Volatile
    private var snapshot: Snapshot? = null

    fun defaultHome(): Path =
        System.getProperty("user.home")?.takeIf { it.isNotBlank() }?.let { Path.of(it) }
            ?: Path.of(".").toAbsolutePath().normalize()

    fun file(home: Path = defaultHome()): Path = home.resolve(".zcgui").resolve(FILE_NAME)

    private fun backupFile(file: Path): Path = file.resolveSibling("${file.fileName}.bak.1")

    /**
     * 读取全局注册表快照。文件不存在/IO 失败返回空表（fail-soft）；整体损坏先读
     * `.bak.1`，两者都不可用才返回空表——调用方（[WorktreeRegistry]）还会并入
     * 项目旧 kv，可见性不会因一次损坏断崖。
     */
    fun list(home: Path = defaultHome()): List<WorktreeRegistryStore.WorktreeSessionInfo> {
        val file = file(home)
        val stat = runCatching {
            if (Files.isRegularFile(file)) {
                Files.getLastModifiedTime(file).toMillis() to Files.size(file)
            } else null
        }.getOrNull() ?: run {
            snapshot = null
            return emptyList()
        }
        snapshot?.takeIf { it.file == file && it.modified == stat.first && it.size == stat.second }
            ?.let { return it.list }
        val parsed = readStrict(file) ?: readStrict(backupFile(file))
        val list = parsed ?: emptyList()
        snapshot = Snapshot(file, stat.first, stat.second, list)
        return list
    }

    /**
     * 读改写（锁内重新读盘再 merge，防多实例丢更新）。
     * @return false = 写失败（只 warn，调用方不阻塞主流程；发现腿会兜住可见性）
     */
    fun mutate(
        home: Path = defaultHome(),
        transform: (List<WorktreeRegistryStore.WorktreeSessionInfo>) -> List<WorktreeRegistryStore.WorktreeSessionInfo>,
    ): Boolean = synchronized(PROCESS_LOCK) {
        val file = file(home)
        runCatching {
            Files.createDirectories(file.parent)
            val lockFile = file.resolveSibling("${file.fileName}.lock")
            FileChannel.open(lockFile, StandardOpenOption.CREATE, StandardOpenOption.WRITE).use { channel ->
                val lock = channel.lock()
                try {
                    var current = readStrict(file)
                    if (current == null) {
                        // 整体损坏：尽量从备份恢复底稿，坏文件留档后重建
                        current = readStrict(backupFile(file)) ?: emptyList()
                        quarantine(file)
                    }
                    val next = WorktreeRegistryStore.capByCreatedAt(transform(current), MAX_ENTRIES)
                    backup(file)
                    writeAtomically(file, WorktreeRegistryStore.serialize(next))
                    snapshot = Snapshot(
                        file,
                        Files.getLastModifiedTime(file).toMillis(),
                        Files.size(file),
                        next,
                    )
                    true
                } finally {
                    runCatching { lock.release() }
                }
            }
        }.getOrElse {
            System.err.println("[ZCodeWorktree] global session store write failed: ${it.message}")
            false
        }
    }

    /** 严格读：文件缺失 = 空表；整体格式非法 = null（与空表区分） */
    private fun readStrict(file: Path): List<WorktreeRegistryStore.WorktreeSessionInfo>? {
        if (!Files.isRegularFile(file)) return emptyList()
        val raw = runCatching { Files.readString(file, StandardCharsets.UTF_8) }.getOrNull() ?: return null
        return WorktreeRegistryStore.parseStrict(raw)
    }

    private fun backup(file: Path) {
        if (!Files.isRegularFile(file)) return
        runCatching {
            Files.copy(file, backupFile(file), StandardCopyOption.REPLACE_EXISTING)
        }
    }

    private fun quarantine(file: Path) {
        if (!Files.exists(file)) return
        val target = file.resolveSibling("${file.fileName}.corrupt-${System.currentTimeMillis()}")
        runCatching { Files.move(file, target, StandardCopyOption.REPLACE_EXISTING) }
    }

    private fun writeAtomically(file: Path, text: String) {
        val tmp = file.resolveSibling("${file.fileName}.tmp")
        Files.writeString(
            tmp, text, StandardCharsets.UTF_8,
            StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE,
        )
        try {
            Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        } catch (_: AtomicMoveNotSupportedException) {
            Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING)
        } catch (e: java.io.IOException) {
            // Windows 上目标被占用等场景：先试普通 move，仍失败则清理临时文件并上抛
            runCatching { Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING) }
                .getOrElse {
                    runCatching { Files.deleteIfExists(tmp) }
                    throw e
                }
        }
    }
}