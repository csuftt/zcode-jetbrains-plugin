package com.zcode.ideaplugin.worktree

import java.nio.file.Path
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * 被列目录 → 所在仓库 → 该仓库的托管副本根（0.4.6 跨项目会话发现，缺陷HU）。
 *
 * 历史列表的 worktree 承接此前只覆盖「项目主目录 + 按目录名撞托管桶」：换一个
 * 项目关联同一源目录时，project 级注册表带不过去、任务索引又没有插件建会话的行，
 * 列表就空了。本类把发现依据换成 git 事实：任意被列目录先取 toplevel，再由
 * `git worktree list` 拿**该仓库自己**的托管副本集合——同名仓库克隆不会互相污染，
 * 非 git 目录直接返回空。
 *
 * 平台无关：toplevel/roots 由调用方注入（生产走 [GitWorktreeCli]，测试注入假
 * provider）；结果按归一路径做 TTL 缓存（含负缓存），插件创建/删除副本后经
 * [bumpGeneration] 让所有实例的缓存一起失效。
 */
class WorktreeRepoScan(
    private val toplevelOf: (Path) -> Path?,
    private val rootsOf: (Path) -> List<GitWorktreeCli.ManagedRootInfo>,
    private val ttlMs: Long = 30_000L,
    private val clock: () -> Long = System::currentTimeMillis,
) {

    /**
     * @param listedDir 被列目录（已绝对化归一）
     * @param repoRoot git toplevel；null = 非 git 目录
     * @param relativePath 被列目录在仓库内的相对路径（"." = 仓库根），恒为正斜杠形态
     * @param roots 该仓库的托管副本根（含已删除未 prune 的，exists 标记）
     */
    data class Result(
        val listedDir: Path,
        val repoRoot: Path?,
        val relativePath: String,
        val roots: List<GitWorktreeCli.ManagedRootInfo>,
    ) {
        val isRepository: Boolean get() = repoRoot != null

        /** 副本内与被列目录对应的执行根（会话 directory 落点，可能含子目录） */
        fun execRootFor(root: GitWorktreeCli.ManagedRootInfo): Path =
            if (relativePath == ".") root.root else root.root.resolve(relativePath)
    }

    private data class CacheEntry(val expiresAt: Long, val result: Result)

    private val cache = ConcurrentHashMap<String, CacheEntry>()
    private val seenGeneration = AtomicLong(generation.get())

    fun scan(listedDir: Path): Result {
        val gen = generation.get()
        if (seenGeneration.get() != gen) {
            cache.clear()
            seenGeneration.set(gen)
        }
        val dir = listedDir.toAbsolutePath().normalize()
        val key = WorktreeRegistry.normalize(dir.toString())
        cache[key]?.let { if (it.expiresAt > clock()) return it.result }
        val result = runCatching { compute(dir) }.getOrElse { empty(dir) }
        cache[key] = CacheEntry(clock() + ttlMs, result)
        return result
    }

    private fun compute(dir: Path): Result {
        val repo = toplevelOf(dir) ?: return empty(dir)
        // 理论不可达（toplevel 是 dir 的祖先）；防御性按非仓库处理，绝不猜归属
        val rel = relativeTo(repo, dir) ?: return empty(dir)
        return Result(dir, repo, rel, rootsOf(repo))
    }

    private fun empty(dir: Path) = Result(dir, null, ".", emptyList())

    companion object {
        /**
         * 进程级失效代数（插件创建/删除副本、或注册表迁移后调用）：各面板/标签
         * 各自持有 [WorktreeRepoScan] 实例，靠代数变化在下次 scan 时统一清缓存。
         */
        private val generation = AtomicLong(0L)

        fun bumpGeneration() {
            generation.incrementAndGet()
        }

        /** 被列目录在仓库内的相对路径（正斜杠、Windows 大小写折叠）；不在仓库下返回 null */
        internal fun relativeTo(repoRoot: Path, dir: Path): String? {
            val root = WorktreeRegistry.normalize(repoRoot.toAbsolutePath().normalize().toString())
            val target = WorktreeRegistry.normalize(dir.toAbsolutePath().normalize().toString())
            if (target == root) return "."
            if (!target.startsWith("$root/")) return null
            return target.substring(root.length + 1)
        }
    }
}