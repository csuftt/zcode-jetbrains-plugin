package com.zcode.ideaplugin.worktree

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * 托管根空桶清扫测试（2026-11-15 反馈）：删除 worktree 时目录被 IDE 句柄占用实时删不掉，
 * 桶目录残留。规则矩阵：空桶删 / 多层空目录壳删 / 含文件（如残留 .git 指针）不删 /
 * 符号链接不删 / 活跃桶跳过（连空桶也不动）/ 非 4 位 hex 名与托管根散文件不动。
 */
class WorktreeBucketSweepTest {

    @TempDir
    lateinit var tmp: Path

    private val managedRoot: Path get() = tmp.resolve("worktrees")

    /** 在托管根下建多层目录并返回桶路径 */
    private fun dir(vararg segs: String): Path {
        var p = managedRoot
        for (s in segs) p = p.resolve(s)
        Files.createDirectories(p)
        return p
    }

    private fun file(vararg segs: String): Path {
        var p = managedRoot
        for (i in segs.indices) {
            p = p.resolve(segs[i])
            if (i < segs.size - 1) Files.createDirectories(p)
        }
        return Files.write(p, byteArrayOf(1))
    }

    @Test
    fun `空桶与多层空目录壳被移除`() {
        dir("b55d")                          // 直下空桶（IDE 占用释放后的最常见残留）
        dir("f1c5", "repoA", "src", "main")  // 纯空目录壳（多层）
        val removed = sweepEmptyWorktreeBuckets(managedRoot, emptySet())
        assertEquals(listOf("b55d", "f1c5"), removed.map { it.fileName.toString() }.sorted())
        assertFalse(Files.exists(managedRoot.resolve("b55d")))
        assertFalse(Files.exists(managedRoot.resolve("f1c5")))
    }

    @Test
    fun `含文件或符号链接的桶整体保留`() {
        dir("9de2", "repoB", "src")
        file("9de2", "repoB", ".git")        // 残留 .git 指针文件——不是空壳，保守保留
        dir("aaaa", "repoC")
        file("aaaa", "repoC", "A.kt")
        // 符号链接桶：Windows 需开发者模式/管理员，创建失败则该分支无桶可断言
        val linkTarget = dir("linkTarget")
        val link = managedRoot.resolve("ccdd")
        val linked = runCatching { Files.createSymbolicLink(link, linkTarget) }.isSuccess

        val removed = sweepEmptyWorktreeBuckets(managedRoot, emptySet())
        assertEquals(emptyList(), removed)
        assertTrue(Files.exists(managedRoot.resolve("9de2")))
        assertTrue(Files.exists(managedRoot.resolve("aaaa")))
        if (linked) assertTrue(Files.exists(managedRoot.resolve("ccdd")))
    }

    @Test
    fun `活跃桶跳过且非桶名条目不动`() {
        dir("dddd")                            // 活跃桶（快照现存 worktree），即便此刻为空也不动
        dir("misc")                            // 非 4 位 hex 名——不在清扫范围
        file(".metadata_never_index")          // 托管根散文件——绝不动

        val removed = sweepEmptyWorktreeBuckets(managedRoot, liveBuckets = setOf("dddd"))
        assertEquals(emptyList(), removed)
        assertTrue(Files.exists(managedRoot.resolve("dddd")))
        assertTrue(Files.exists(managedRoot.resolve("misc")))
        assertTrue(Files.exists(managedRoot.resolve(".metadata_never_index")))
    }

    @Test
    fun `托管根不存在时静默返回`() {
        assertEquals(emptyList(), sweepEmptyWorktreeBuckets(managedRoot.resolve("nope"), emptySet()))
    }
}
