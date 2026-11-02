package com.zcode.ideaplugin.ui

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * WorkspaceSendTargets 纯逻辑单测（不依赖 Project）：
 * 右键多工作区目标计算——子树匹配、挂载可达、多选交集、当前排除与置顶、归一与去重
 */
class WorkspaceSendTargetsTest {

    private val proj = "G:/proj"
    private val wsB = "G:/other/ws-b"
    private val wsC = "G:/other/ws-c"

    @Test
    fun `file in linked workspace shows project first then the workspace`() {
        val targets = WorkspaceSendTargets.compute(
            filePaths = listOf("$wsB/src/A.kt"),
            basePath = proj,
            projectDisplayName = "MyProj",
            linkedWorkspaces = listOf(wsB),
            currentWorkspace = proj,
        )
        assertEquals(listOf(proj, wsB), targets.map { it.workspacePath })
        assertEquals(listOf("MyProj", "ws-b"), targets.map { it.displayName })
        assertTrue(targets[0].isCurrent)
        assertFalse(targets[1].isCurrent)
    }

    @Test
    fun `file in current linked workspace offers project root instead`() {
        val targets = WorkspaceSendTargets.compute(
            filePaths = listOf("$wsB/src/A.kt"),
            basePath = proj,
            projectDisplayName = "MyProj",
            linkedWorkspaces = listOf(wsB),
            currentWorkspace = wsB,
        )
        assertEquals(listOf(wsB, proj), targets.map { it.workspacePath })
        assertEquals(listOf("ws-b", "MyProj"), targets.map { it.displayName })
        assertTrue(targets[0].isCurrent)
        assertFalse(targets[1].isCurrent)
    }

    @Test
    fun `project file with project tab yields single target`() {
        val targets = WorkspaceSendTargets.compute(
            filePaths = listOf("$proj/src/A.kt"),
            basePath = proj,
            projectDisplayName = "MyProj",
            linkedWorkspaces = listOf(wsB),
            currentWorkspace = proj,
        )
        assertEquals(1, targets.size)
        assertTrue(targets[0].isCurrent)
        assertEquals(proj, targets[0].workspacePath)
    }

    @Test
    fun `external file outside all workspaces yields single target`() {
        val targets = WorkspaceSendTargets.compute(
            filePaths = listOf("G:/random/elsewhere.txt"),
            basePath = proj,
            projectDisplayName = "MyProj",
            linkedWorkspaces = listOf(wsB, wsC),
            currentWorkspace = proj,
        )
        assertEquals(1, targets.size)
        assertTrue(targets[0].isCurrent)
    }

    @Test
    fun `nested linked workspaces all count as candidates`() {
        val nested = "$wsB/nested-c"
        val targets = WorkspaceSendTargets.compute(
            filePaths = listOf("$nested/x.py"),
            basePath = proj,
            projectDisplayName = "MyProj",
            linkedWorkspaces = listOf(wsB, nested),
            currentWorkspace = proj,
        )
        assertEquals(listOf(proj, wsB, nested), targets.map { it.workspacePath })
        assertEquals(listOf("MyProj", "ws-b", "nested-c"), targets.map { it.displayName })
    }

    @Test
    fun `multi-select intersection keeps workspaces containing all files`() {
        // 两文件同在 wsB 子树 → wsB 出
        val same = WorkspaceSendTargets.compute(
            filePaths = listOf("$wsB/a.py", "$wsB/sub/b.py"),
            basePath = proj,
            projectDisplayName = "MyProj",
            linkedWorkspaces = listOf(wsB, wsC),
            currentWorkspace = proj,
        )
        assertEquals(listOf(proj, wsB), same.map { it.workspacePath })

        // 两文件分属不相交的 wsB/wsC → 关联目录都不出；项目根经挂载可达照出
        val disjoint = WorkspaceSendTargets.compute(
            filePaths = listOf("$wsB/a.py", "$wsC/b.py"),
            basePath = proj,
            projectDisplayName = "MyProj",
            linkedWorkspaces = listOf(wsB, wsC),
            currentWorkspace = proj,
        )
        assertEquals(listOf(proj), disjoint.map { it.workspacePath })
    }

    @Test
    fun `right-clicked directory matching a linked root itself counts`() {
        val targets = WorkspaceSendTargets.compute(
            filePaths = listOf(wsB),
            basePath = proj,
            projectDisplayName = "MyProj",
            linkedWorkspaces = listOf(wsB),
            currentWorkspace = proj,
        )
        assertEquals(listOf(proj, wsB), targets.map { it.workspacePath })
    }

    @Test
    fun `separator case and trailing slash are normalized`() {
        val targets = WorkspaceSendTargets.compute(
            filePaths = listOf("g:/other/ws-b/a.txt"),
            basePath = "G:/Proj",
            projectDisplayName = "MyProj",
            linkedWorkspaces = listOf("G:\\OTHER\\WS-B\\"),
            currentWorkspace = "g:/proj",
        )
        // 大小写/分隔符变体的当前目录与项目根按归一键匹配（仍只出一个当前项，
        // 且按项目名显示），关联目录命中且显示 basename
        assertEquals(2, targets.size)
        assertTrue(targets[0].isCurrent)
        assertEquals("g:/proj", targets[0].workspacePath)
        assertEquals("MyProj", targets[0].displayName)
        assertEquals("G:\\OTHER\\WS-B\\", targets[1].workspacePath)
        assertEquals("WS-B", targets[1].displayName)
    }

    @Test
    fun `current workspace is never duplicated in candidates`() {
        val targets = WorkspaceSendTargets.compute(
            filePaths = listOf("$wsB/a.py"),
            basePath = proj,
            projectDisplayName = "MyProj",
            linkedWorkspaces = listOf(wsB, proj), // 手工 kv 撞车项目根：去重兜底
            currentWorkspace = proj,
        )
        assertEquals(listOf(proj, wsB), targets.map { it.workspacePath })
        assertEquals(2, targets.size)
    }

    @Test
    fun `no base path and no current workspace yields others without current`() {
        val targets = WorkspaceSendTargets.compute(
            filePaths = listOf("$wsB/a.py"),
            basePath = null,
            projectDisplayName = "MyProj",
            linkedWorkspaces = listOf(wsB),
            currentWorkspace = null,
        )
        assertEquals(listOf(wsB), targets.map { it.workspacePath })
        assertTrue(targets.none { it.isCurrent })
    }
}
