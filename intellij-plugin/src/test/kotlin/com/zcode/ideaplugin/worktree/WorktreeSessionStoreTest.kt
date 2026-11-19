package com.zcode.ideaplugin.worktree

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * 全局注册表文件存储测试（缺陷HU）：round-trip / 读改写合并 / 损坏回退备份并隔离 /
 * 条数硬顶 / 备份轮转。纯临时目录，不碰用户真实 `~/.zcgui`。
 */
class WorktreeSessionStoreTest {

    @TempDir
    lateinit var home: Path

    private fun info(
        sessionId: String,
        createdAt: Long = 1L,
        source: String = "E:/proj/src",
    ) = WorktreeRegistryStore.WorktreeSessionInfo(
        sessionId = sessionId,
        worktreeRoot = "E:/wt/$sessionId/repo",
        cwd = "E:/wt/$sessionId/repo",
        sourceWorkspace = source,
        startRef = "main",
        startSha = "abc123",
        bucket = "ab12",
        createdAt = createdAt,
    )

    @Test
    fun `文件缺失返回空表`() {
        assertTrue(WorktreeSessionStore.list(home).isEmpty())
        assertFalse(Files.exists(WorktreeSessionStore.file(home)))
    }

    @Test
    fun `upsert remove 读改写 跨调用读同一份`() {
        assertTrue(WorktreeSessionStore.mutate(home) { WorktreeRegistryStore.upsert(it, info("s1")) })
        assertTrue(WorktreeSessionStore.mutate(home) { WorktreeRegistryStore.upsert(it, info("s2")) })
        // 同 id 覆盖不重复（新值替换旧值）
        assertTrue(
            WorktreeSessionStore.mutate(home) {
                WorktreeRegistryStore.upsert(it, info("s1", createdAt = 9L))
            },
        )
        val list = WorktreeSessionStore.list(home)
        assertEquals(listOf("s2", "s1"), list.map { it.sessionId })
        assertEquals(9L, list.first { it.sessionId == "s1" }.createdAt)

        assertTrue(WorktreeSessionStore.mutate(home) { WorktreeRegistryStore.remove(it, "s1") })
        assertEquals(listOf("s2"), WorktreeSessionStore.list(home).map { it.sessionId })
        assertTrue(Files.isRegularFile(WorktreeSessionStore.file(home)))
        assertTrue(
            Files.isRegularFile(WorktreeSessionStore.file(home).resolveSibling("${WorktreeSessionStore.FILE_NAME}.bak.1")),
            "二次写入应轮转备份",
        )
    }

    @Test
    fun `损坏主文件读时回退备份 写时隔离坏文件`() {
        assertTrue(WorktreeSessionStore.mutate(home) { listOf(info("s1")) })
        val file = WorktreeSessionStore.file(home)
        Files.copy(file, file.resolveSibling("${file.fileName}.bak.1"), StandardCopyOption.REPLACE_EXISTING)
        Files.writeString(file, "{not-json")

        // 读：主文件整体非法 → 回退 .bak.1，不当空表
        assertEquals(listOf("s1"), WorktreeSessionStore.list(home).map { it.sessionId })

        // 写：以备份为底稿合并，坏文件留档 .corrupt-*
        assertTrue(
            WorktreeSessionStore.mutate(home) {
                WorktreeRegistryStore.upsert(it, info("s2"))
            },
        )
        assertEquals(setOf("s1", "s2"), WorktreeSessionStore.list(home).map { it.sessionId }.toSet())
        val corrupted = Files.list(file.parent).use { stream ->
            stream.anyMatch { it.fileName.toString().contains(".corrupt-") }
        }
        assertTrue(corrupted, "损坏主文件应被隔离而非静默覆盖消失")
    }

    @Test
    fun `条数硬顶按创建时间保留最新`() {
        assertTrue(
            WorktreeSessionStore.mutate(home) {
                (1..WorktreeSessionStore.MAX_ENTRIES + 2).map { info("s$it", createdAt = it.toLong()) }
            },
        )
        val list = WorktreeSessionStore.list(home)
        assertEquals(WorktreeSessionStore.MAX_ENTRIES, list.size)
        assertTrue(list.none { it.sessionId == "s1" || it.sessionId == "s2" }, "最旧条目被淘汰")
        assertTrue(list.any { it.sessionId == "s${WorktreeSessionStore.MAX_ENTRIES + 2}" })
    }
}