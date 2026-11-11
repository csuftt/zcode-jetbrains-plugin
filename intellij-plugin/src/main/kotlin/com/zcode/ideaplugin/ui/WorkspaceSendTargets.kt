package com.zcode.ideaplugin.ui

/**
 * 「发送到 ZC GUI 输入框」多工作区目标计算（纯函数核，单测锚点）。
 *
 * 右键文件/目录时除当前标签通道外，还能投递到哪些工作区标签：
 * - 关联目录：子树包含**全部**选中文件的目录（嵌套关联都算；多选取交集）
 * - 项目根：全部选中文件都在项目子树内，**或**都经关联目录挂载可达——挂载是
 *   全有全无的投影，任一文件落在某关联目录子树内，项目会话即可达该文件
 *   （「用本项目会话操作其他目录文件」的通路）
 *
 * 归一比较沿 [ZCodeLinkedWorkspaces.wsKey] 口径（正斜杠 + 去尾 + 小写折叠）。
 */
object WorkspaceSendTargets {

    /** 一个可投递目标（文件引用 refs 与目标无关，由调用方统一构造，不在此处） */
    data class Target(
        val workspacePath: String,
        /** 菜单显示名：项目根用项目名，关联目录用 basename */
        val displayName: String,
        /** 当前激活标签所在工作区（菜单「（当前）」置顶项） */
        val isCurrent: Boolean,
        /** 当前项即弹窗中的标签（activePanel 获焦抢占态）：菜单文案加「·独立窗口」徽标让去向可预判 */
        val isCurrentDetached: Boolean = false,
    )

    /**
     * 目标清单。首个元素恒为当前标签工作区（[currentWorkspace] 空缺时缺位，调用方
     * 以 isCurrent 判别：无当前项时调用方应整组隐藏=退化平铺现状），其余为其他候选
     * （按归一键排除当前、去重）：项目根在前，关联目录按 kv 顺序随后。
     * [filePaths] 为空返回空表。[currentIsDetached] 只影响 current 项的徽标位，
     * 不参与匹配与去重。
     */
    fun compute(
        filePaths: List<String>,
        basePath: String?,
        projectDisplayName: String,
        linkedWorkspaces: List<String>,
        currentWorkspace: String?,
        currentIsDetached: Boolean = false,
    ): List<Target> {
        if (filePaths.isEmpty()) return emptyList()
        val linkedKeys = linkedWorkspaces.map { normKey(it) }
        val rootKey = basePath?.let { normKey(it) }

        fun contains(wsKey: String, file: String): Boolean {
            val fk = normKey(file)
            return fk == wsKey || fk.startsWith("$wsKey/")
        }

        val candidates = ArrayList<Target>()
        if (rootKey != null && filePaths.all { f -> contains(rootKey, f) || linkedKeys.any { contains(it, f) } }) {
            candidates += Target(basePath, projectDisplayName, false)
        }
        linkedWorkspaces.forEachIndexed { i, ws ->
            if (filePaths.all { contains(linkedKeys[i], it) }) {
                candidates += Target(ws, basename(ws), false)
            }
        }

        val currentPath = currentWorkspace?.takeIf { it.isNotBlank() } ?: basePath
        val current = currentPath?.let { cp ->
            val display = if (rootKey != null && normKey(cp) == rootKey) projectDisplayName else basename(cp)
            Target(cp, display, true, currentIsDetached)
        }
        // 候选按归一键去重（项目根与关联目录理论上 kv 侧已互异，仍防手工 kv 撞车）+ 排除当前
        val seen = HashSet<String>()
        val others = candidates.filter { seen.add(normKey(it.workspacePath)) }
        if (current == null) return others
        val currentKey = normKey(current.workspacePath)
        return buildList {
            add(current)
            others.forEach { if (normKey(it.workspacePath) != currentKey) add(it) }
        }
    }

    private fun normKey(p: String): String = p.replace('\\', '/').trimEnd('/').lowercase()

    /** 菜单显示名：目录 basename（兼容正/反斜杠；保留原大小写，归一只用于比较） */
    private fun basename(p: String): String =
        p.trimEnd('/', '\\').substringAfterLast('/').substringAfterLast('\\')
}
