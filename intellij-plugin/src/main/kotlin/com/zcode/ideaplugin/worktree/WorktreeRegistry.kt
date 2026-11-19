package com.zcode.ideaplugin.worktree

import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.project.Project
import java.nio.file.Path

/**
 * worktree 注册表门面（0.4.6，GLOSSARY「worktree 注册表」）。
 *
 * 持久化已从 project 级 kv 升级为全局文件 [WorktreeSessionStore]（`~/.zcgui/`，
 * 缺陷HU）：换项目/换 IDE 关联同一源目录都能看到同一批归属元数据。JSON 编解码
 * 委托 [WorktreeRegistryStore] 纯函数层。
 *
 * 旧 project kv（[WorktreeRegistryStore.KEY]）保留只读兼容：[list] 在迁移完成前
 * 做「全局 ∪ 旧 kv」双读，[migrateLegacyOnce] 在项目打开时导入全局后清除旧 key。
 * 只承载插件自建的 worktree 会话；桌面端建的从任务索引只读现查，两源在列表层合并。
 */
class WorktreeRegistry(private val project: Project) {

    private fun propertiesComponent() = PropertiesComponent.getInstance(project)

    private fun legacyEntries(): List<WorktreeRegistryStore.WorktreeSessionInfo> =
        WorktreeRegistryStore.parse(propertiesComponent().getValue(WorktreeRegistryStore.KEY))

    fun list(): List<WorktreeRegistryStore.WorktreeSessionInfo> =
        WorktreeRegistryStore.mergeById(WorktreeSessionStore.list(), legacyEntries())

    fun findBySession(sessionId: String): WorktreeRegistryStore.WorktreeSessionInfo? =
        list().firstOrNull { it.sessionId == sessionId }

    /** 源工作区（本项目/关联目录）下的全部注册条目；路径归一比较（分隔符/尾分隔符/Win 大小写） */
    fun bySourceWorkspace(workspacePath: String): List<WorktreeRegistryStore.WorktreeSessionInfo> {
        val norm = normalize(workspacePath)
        return list().filter { normalize(it.sourceWorkspace) == norm }
    }

    fun upsert(info: WorktreeRegistryStore.WorktreeSessionInfo) {
        val ok = WorktreeSessionStore.mutate { current ->
            WorktreeRegistryStore.upsert(current, info)
        }
        // 新副本登记 = 发现缓存可能缺这一条；失败无妨，发现腿与 TTL 会兜住
        if (ok) WorktreeRepoScan.bumpGeneration()
    }

    /**
     * worktree 执行根/副本根 → 源工作区（色块、归属用）；未登记（桌面端建的）返回 null。
     * 命中范围：cwd 精确、cwd 在副本根下、副本根精确。
     */
    fun sourceWorkspaceOf(path: String): String? {
        val norm = normalize(path)
        return list().firstOrNull { info ->
            val root = normalize(info.worktreeRoot)
            val cwd = normalize(info.cwd)
            cwd == norm || root == norm || cwd.startsWith("$root/")
        }?.sourceWorkspace
    }

    /**
     * 托管根副本路径 → 源工作区：注册表反查优先；桌面端建的副本无注册条目，落 git 反解
     * 兜底（[GitWorktreeCli.resolveSourceWorkspace]，worktree 的 --git-common-dir 指回
     * 主仓工作树，权威且免疫仓库名改名/挪位）。仅托管根路径才起 git（非托管路径不可能
     * 命中，省一次 rev-parse 进程）；副本已删/git 失败 fail-soft 返回 null，调用方原样保留。
     */
    fun resolveSourceWorkspace(path: String): String? {
        sourceWorkspaceOf(path)?.let { return it }
        val norm = normalize(path)
        val resolved = sourceResolveCache.computeIfAbsent(norm) {
            val p = Path.of(path)
            // git 用 IDE 配置的路径（git4idea 设置/默认 "git"，与 gitOk 检查同源），
            // 防 IDE 环境 PATH 缺 git 时反解静默失败
            val cli = GitWorktreeCli(gitExe = WorktreeGits.executablePath(project), timeoutMs = 10_000L)
            val managed = runCatching { cli.parseManagedWorktreePath(cli.dataBaseDir(), p) }.getOrNull()
            java.util.Optional.ofNullable(
                if (managed == null) null
                else runCatching { cli.resolveSourceWorkspace(p)?.toString() }.getOrNull(),
            )
        }
        return resolved.orElse(null)
    }

    fun remove(sessionId: String) {
        WorktreeSessionStore.mutate { current -> WorktreeRegistryStore.remove(current, sessionId) }
        // 迁移完成前旧 kv 仍是 list() 的来源之一：同步摘除，避免删除后又被旧值复活
        val legacy = legacyEntries()
        if (legacy.any { it.sessionId == sessionId }) {
            propertiesComponent().setValue(
                WorktreeRegistryStore.KEY,
                WorktreeRegistryStore.serialize(WorktreeRegistryStore.remove(legacy, sessionId)),
            )
        }
    }

    /**
     * 旧 project kv → 全局文件一次性迁移（幂等）。全局同 id 优先，旧 kv 只补缺失；
     * 全局写入失败则保留旧 key 与标记缺失，下次启动重试（双读期间可见性不受影响）。
     */
    fun migrateLegacyOnce() {
        val props = propertiesComponent()
        if (props.getValue(MIGRATED_KEY) != null) return
        val legacy = WorktreeRegistryStore.parse(props.getValue(WorktreeRegistryStore.KEY))
        if (legacy.isNotEmpty()) {
            val ok = WorktreeSessionStore.mutate { current ->
                WorktreeRegistryStore.mergeById(current, legacy)
            }
            if (!ok) return
        }
        props.setValue(MIGRATED_KEY, System.currentTimeMillis().toString())
        props.unsetValue(WorktreeRegistryStore.KEY)
        WorktreeRepoScan.bumpGeneration()
    }

    companion object {
        /** 本项目旧 kv 已完成全局迁移的标记（epoch ms，字符串存储同自动归档先例） */
        private const val MIGRATED_KEY = "zcode.worktreeSessions.migratedAt.v1"

        /**
         * git 反解缓存：键=归一路径。null 结果也缓存（Optional 包装——CHM 禁 null value，
         * 缺陷六轮同纪律），副本已删/非副本免反复起进程；桶名随机不复用，进程级缓存无失效面。
         * 挂在 companion：面板/色块/标签/生命周期各自 new [WorktreeRegistry] 也共享同一份
         * （此前是实例字段，注释写「进程级」实际每次新建都落空）。
         */
        private val sourceResolveCache =
            java.util.concurrent.ConcurrentHashMap<String, java.util.Optional<String>>()

        fun normalize(p: String): String {
            val base = p.replace('\\', '/').trimEnd('/')
            return if (System.getProperty("os.name").lowercase().contains("windows")) base.lowercase() else base
        }
    }
}
