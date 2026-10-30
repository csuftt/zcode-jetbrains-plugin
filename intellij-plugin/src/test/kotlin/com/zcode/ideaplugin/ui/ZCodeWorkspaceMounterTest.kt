package com.zcode.ideaplugin.ui

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * ZCodeWorkspaceMounter 纯逻辑单测（不依赖 Project）：
 * reconcile 差集——补挂/摘除/幂等、项目根及子目录剔除、分隔符与大小写归一、去重
 */
class ZCodeWorkspaceMounterTest {

    @Test
    fun `new dirs are added and stale roots removed`() {
        val (add, remove) = ZCodeWorkspaceMounter.computeDiff(
            currentRootPaths = listOf("G:/old-ws", "G:/keep-ws"),
            desired = listOf("G:\\keep-ws", "G:/new-ws"),
            baseKey = "g:/proj",
        )
        assertEquals(listOf("G:/new-ws"), add, "不在模块里的 desired 目录补挂")
        assertEquals(listOf("G:/old-ws"), remove, "不在 kv 里的存量根摘除")
    }

    @Test
    fun `identical lists produce empty diff regardless of separator and case`() {
        val (add, remove) = ZCodeWorkspaceMounter.computeDiff(
            currentRootPaths = listOf("G:/Dir/SubWs"),
            desired = listOf("g:\\dir\\subws\\"),
            baseKey = null,
        )
        assertTrue(add.isEmpty() && remove.isEmpty(), "归一后同目录 = 幂等空差集")
    }

    @Test
    fun `paths inside project base are excluded from mounting`() {
        val (add, _) = ZCodeWorkspaceMounter.computeDiff(
            currentRootPaths = emptyList(),
            desired = listOf("G:/proj", "G:/proj/sub", "G:/other-ws"),
            baseKey = "g:/proj",
        )
        assertEquals(listOf("G:/other-ws"), add, "项目根自身与其子目录不挂（项目树已可见）")
    }

    @Test
    fun `nested linked dirs all mount`() {
        val (add, _) = ZCodeWorkspaceMounter.computeDiff(
            currentRootPaths = emptyList(),
            desired = listOf("G:/parent-ws", "G:/parent-ws/child-ws"),
            baseKey = "g:/proj",
        )
        assertEquals(listOf("G:/parent-ws", "G:/parent-ws/child-ws"), add, "关联目录互嵌都挂（IDEA 原生嵌套根）")
    }

    @Test
    fun `duplicate desired paths dedupe by normalized key`() {
        val (add, _) = ZCodeWorkspaceMounter.computeDiff(
            currentRootPaths = emptyList(),
            desired = listOf("G:/a-ws", "g:/a-ws/", "G:\\a-ws"),
            baseKey = null,
        )
        assertEquals(listOf("G:/a-ws"), add, "同目录多形态只挂一次")
    }

    @Test
    fun `empty desired removes all current roots`() {
        val (_, remove) = ZCodeWorkspaceMounter.computeDiff(
            currentRootPaths = listOf("G:/a-ws", "G:/b-ws"),
            desired = emptyList(),
            baseKey = "g:/proj",
        )
        assertEquals(listOf("G:/a-ws", "G:/b-ws"), remove, "kv 清空 = 全部摘除")
    }

    @Test
    fun `wsKey normalizes separators trailing slash and case`() {
        assertEquals(ZCodeLinkedWorkspaces.wsKey("G:\\AI\\Ws\\"), ZCodeLinkedWorkspaces.wsKey("g:/ai/ws"))
        assertTrue(ZCodeLinkedWorkspaces.wsKey("G:/ai/ws/").endsWith("/ws"), "内部路径前缀判定依赖去尾")
    }

    // ---- normalizeActive（readActive 纯函数核，手机远程工作区外露口径）----

    private val onDisk = setOf("G:/proj", "G:/ws-a", "G:/ws-b", "G:/proj/sub-ws")

    private fun normalize(raw: List<String>, basePath: String?) =
        ZCodeLinkedWorkspaces.normalizeActive(raw, basePath) { it in onDisk }

    @Test
    fun `normalizeActive keeps existing linked dirs in forward slash form`() {
        assertEquals(
            listOf("G:/ws-a", "G:/ws-b"),
            normalize(listOf("G:\\ws-a", "G:/ws-b/"), "G:/proj"),
            "正斜杠统一 + 失效目录过滤",
        )
    }

    @Test
    fun `normalizeActive drops missing dirs and duplicates`() {
        assertEquals(
            listOf("G:/ws-a"),
            normalize(listOf("G:/gone", "G:/ws-a", "G:\\WS-A"), "G:/proj"),
            "盘上已删目录不外露；同目录多形态只出一行",
        )
    }

    @Test
    fun `normalizeActive excludes exact project root but keeps subdirs`() {
        assertEquals(
            listOf("G:/proj/sub-ws"),
            normalize(listOf("G:/proj", "G:/proj/sub-ws"), "G:/proj"),
            "项目根自身不重复外露；子目录是合法独立工作区（chips 同语义）",
        )
    }

    @Test
    fun `normalizeActive returns empty without base path or raw list`() {
        assertTrue(normalize(listOf("G:/ws-a"), null).isEmpty(), "无项目根无法承载")
        assertTrue(normalize(emptyList(), "G:/proj").isEmpty(), "未挂载=零外露")
    }
}
