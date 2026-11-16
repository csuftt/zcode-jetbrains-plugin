package com.zcode.ideaplugin.worktree

import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.project.Project
import java.nio.file.Path

/**
 * worktree 注册表的 project 级 kv 薄封装（0.4.6，GLOSSARY「worktree 注册表」）。
 *
 * 持久化在 PropertiesComponent（key [WorktreeRegistryStore.KEY]，模式同
 * ZCodeLinkedWorkspaces），JSON 编解码委托 [WorktreeRegistryStore] 纯函数层。
 * 只承载插件自建的 worktree 会话；桌面端建的从任务索引只读现查，两源在列表层合并。
 */
class WorktreeRegistry(private val project: Project) {

    private val props get() = PropertiesComponent.getInstance(project)

    fun list(): List<WorktreeRegistryStore.WorktreeSessionInfo> =
        WorktreeRegistryStore.parse(props.getValue(WorktreeRegistryStore.KEY))

    fun findBySession(sessionId: String): WorktreeRegistryStore.WorktreeSessionInfo? =
        list().firstOrNull { it.sessionId == sessionId }

    /** 源工作区（本项目/关联目录）下的全部注册条目；路径归一比较（分隔符/尾分隔符/Win 大小写） */
    fun bySourceWorkspace(workspacePath: String): List<WorktreeRegistryStore.WorktreeSessionInfo> {
        val norm = normalize(workspacePath)
        return list().filter { normalize(it.sourceWorkspace) == norm }
    }

    fun upsert(info: WorktreeRegistryStore.WorktreeSessionInfo) {
        props.setValue(WorktreeRegistryStore.KEY, WorktreeRegistryStore.serialize(WorktreeRegistryStore.upsert(list(), info)))
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

    /** git 反解缓存：键=归一路径。null 结果也缓存（Optional 包装——CHM 禁 null value，
     *  缺陷六轮同纪律），副本已删/非副本免反复起进程；桶名随机不复用，进程级缓存无失效面 */
    private val sourceResolveCache = java.util.concurrent.ConcurrentHashMap<String, java.util.Optional<String>>()

    /**
     * 托管根副本路径 → 源工作区：注册表反查优先；桌面端建的副本无注册条目，落 git 反解
     * 兜底（[GitWorktreeCli.resolveSourceWorkspace]，worktree 的 --git-common-dir 指回
     * 主仓工作树，权威且免疫仓库名改名/挪位）。仅托管根路径才起 git（非托管路径不可能
     * 命中，省一次 rev-parse 进程），结果进程级缓存（色块刷新/worktreeState 高频调用位）；
     * 副本已删/git 失败 fail-soft 返回 null，调用方原样保留。
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
        props.setValue(WorktreeRegistryStore.KEY, WorktreeRegistryStore.serialize(WorktreeRegistryStore.remove(list(), sessionId)))
    }

    companion object {
        fun normalize(p: String): String {
            val base = p.replace('\\', '/').trimEnd('/')
            return if (System.getProperty("os.name").lowercase().contains("windows")) base.lowercase() else base
        }
    }
}
