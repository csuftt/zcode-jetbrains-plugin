package com.zcode.ideaplugin.worktree

import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.project.Project

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
