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
}
