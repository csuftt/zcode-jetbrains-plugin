package com.zcode.ideaplugin.worktree

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * worktree 注册表纯 JSON 层测试：round-trip / 损坏 fail-soft / 缺必填字段按条丢弃 /
 * upsert 覆盖同 id / remove。持久化载体（project kv）在 intellij-plugin 薄封装，不在此测。
 */
class WorktreeRegistryStoreTest {

    private fun info(
        sessionId: String = "sess_1",
        worktreeRoot: String = "C:/u/.zcode/worktrees/ab12/repo",
        cwd: String = worktreeRoot,
        sourceWorkspace: String = "G:/proj/demo",
        startRef: String = "feat/x",
        startSha: String = "26199ca",
        bucket: String = "ab12",
        createdAt: Long = 100L,
    ) = WorktreeRegistryStore.WorktreeSessionInfo(
        sessionId, worktreeRoot, cwd, sourceWorkspace, startRef, startSha, bucket, createdAt,
    )

    @Test
    fun `serialize parse round trip`() {
        val list = listOf(info(), info(sessionId = "sess_2", bucket = "cd34", createdAt = 200L))
        val parsed = WorktreeRegistryStore.parse(WorktreeRegistryStore.serialize(list))
        assertEquals(list, parsed)
    }

    @Test
    fun `parse corrupted json returns empty`() {
        assertTrue(WorktreeRegistryStore.parse(null).isEmpty())
        assertTrue(WorktreeRegistryStore.parse("").isEmpty())
        assertTrue(WorktreeRegistryStore.parse("{not-json").isEmpty())
        assertTrue(WorktreeRegistryStore.parse("{\"a\":1}").isEmpty(), "对象而非数组 → 空")
    }

    @Test
    fun `parseStrict distinguishes corrupt from empty`() {
        assertEquals(emptyList<WorktreeRegistryStore.WorktreeSessionInfo>(), WorktreeRegistryStore.parseStrict(null))
        assertEquals(emptyList<WorktreeRegistryStore.WorktreeSessionInfo>(), WorktreeRegistryStore.parseStrict(""))
        assertNull(WorktreeRegistryStore.parseStrict("{not-json"), "整体非法 → null（不能当空表覆盖）")
        assertNull(WorktreeRegistryStore.parseStrict("{\"a\":1}"))
        assertNotNull(WorktreeRegistryStore.parseStrict(WorktreeRegistryStore.serialize(listOf(info()))))
    }

    @Test
    fun `mergeById primary wins and secondary only fills missing`() {
        val global = listOf(info(startRef = "global"), info(sessionId = "sess_2"))
        val legacy = listOf(
            info(startRef = "legacy", createdAt = 999L), // 同 id：全局优先
            info(sessionId = "sess_3", createdAt = 300L), // 缺失：旧 kv 补入
        )
        val merged = WorktreeRegistryStore.mergeById(global, legacy)
        assertEquals(listOf("sess_1", "sess_2", "sess_3"), merged.map { it.sessionId })
        assertEquals("global", merged.first { it.sessionId == "sess_1" }.startRef)
        assertTrue(WorktreeRegistryStore.mergeById(global, emptyList()) === global)
    }

    @Test
    fun `capByCreatedAt keeps newest entries`() {
        val list = (1..5).map { info(sessionId = "sess_$it", createdAt = it.toLong()) }
        val capped = WorktreeRegistryStore.capByCreatedAt(list, 3)
        assertEquals(3, capped.size)
        assertEquals(setOf("sess_3", "sess_4", "sess_5"), capped.map { it.sessionId }.toSet())
        assertEquals(list, WorktreeRegistryStore.capByCreatedAt(list, 10), "未超限原样返回")
    }

    @Test
    fun `parse drops entries missing required fields`() {
        val raw = """[
            {"sessionId":"sess_ok","worktreeRoot":"C:/wt","cwd":"C:/wt","sourceWorkspace":"G:/p"},
            {"sessionId":"sess_missing_cwd","worktreeRoot":"C:/wt","sourceWorkspace":"G:/p"},
            {"worktreeRoot":"C:/wt","cwd":"C:/wt","sourceWorkspace":"G:/p"},
            "not-an-object"
        ]"""
        val parsed = WorktreeRegistryStore.parse(raw)
        assertEquals(1, parsed.size, "缺 cwd / 缺 sessionId / 非对象都按条丢弃")
        assertEquals("sess_ok", parsed[0].sessionId)
        assertEquals("", parsed[0].startRef, "可选字段缺省空串")
        assertEquals(0L, parsed[0].createdAt)
    }

    @Test
    fun `upsert replaces same sessionId and appends new`() {
        val list = listOf(info(), info(sessionId = "sess_2"))
        val updated = list.map { it.copy(startRef = "HEAD", startSha = "fff1") }.first()
        val out = WorktreeRegistryStore.upsert(list, updated)
        assertEquals(2, out.size, "覆盖不新增条目")
        val entry = out.first { it.sessionId == "sess_1" }
        assertEquals("HEAD", entry.startRef)
        assertEquals("fff1", entry.startSha)
        val added = WorktreeRegistryStore.upsert(out, info(sessionId = "sess_3"))
        assertEquals(3, added.size)
        assertEquals("sess_3", added.last().sessionId, "新增条目追加在尾部")
    }

    @Test
    fun `remove by sessionId`() {
        val list = listOf(info(), info(sessionId = "sess_2"), info(sessionId = "sess_3"))
        val out = WorktreeRegistryStore.remove(list, "sess_2")
        assertEquals(listOf("sess_1", "sess_3"), out.map { it.sessionId })
        assertEquals(list, WorktreeRegistryStore.remove(list, "sess_none"), "不存在时原样返回")
    }
}
