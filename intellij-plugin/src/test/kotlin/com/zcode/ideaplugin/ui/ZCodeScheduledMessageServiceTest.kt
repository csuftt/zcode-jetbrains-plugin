package com.zcode.ideaplugin.ui

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * 定时消息纯逻辑测试：宽限窗自动分派判定 + 存储序列化回环。
 *
 * 分派规则（设计文档第五节）：到点且在宽限窗（30min）内才自动发；
 * 超宽限保持待发呈「已过期」卡等用户手动决定；hold（切会话回退挂起）永不自动。
 */
class ZCodeScheduledMessageServiceTest {

    private fun item(fireAt: Long, hold: Boolean = false) = ZCodeScheduledMessageService.Item(
        id = "s1",
        sessionId = "sess_1",
        workspacePath = "G:\\mock",
        text = "定时任务",
        fireAt = fireAt,
        createdAt = 0,
        hold = hold,
    )

    @Test
    fun `未到点不自动分派`() {
        val now = 1_000_000L
        assertFalse(ZCodeScheduledMessageService.shouldAutoFire(item(fireAt = now + 1), now))
    }

    @Test
    fun `到点在宽限窗内自动分派`() {
        val fireAt = 1_000_000L
        // 恰到点 / 到点后 29min59s
        assertTrue(ZCodeScheduledMessageService.shouldAutoFire(item(fireAt), fireAt))
        assertTrue(ZCodeScheduledMessageService.shouldAutoFire(item(fireAt), fireAt + 29 * 60_000 + 59_999))
    }

    @Test
    fun `超宽限窗不再自动分派（转已过期等手动决定）`() {
        val fireAt = 1_000_000L
        // 恰好 30min 边界仍在窗内（now - fireAt <= grace，与 webview 过期判定对齐），
        // 再多 1ms 即超窗
        assertTrue(ZCodeScheduledMessageService.shouldAutoFire(item(fireAt), fireAt + ZCodeScheduledMessageService.GRACE_MS))
        assertFalse(ZCodeScheduledMessageService.shouldAutoFire(item(fireAt), fireAt + ZCodeScheduledMessageService.GRACE_MS + 1))
        assertFalse(ZCodeScheduledMessageService.shouldAutoFire(item(fireAt), fireAt + 2 * 60 * 60_000))
    }

    @Test
    fun `hold 挂起项任何时刻都不自动分派`() {
        val fireAt = 1_000_000L
        assertFalse(ZCodeScheduledMessageService.shouldAutoFire(item(fireAt, hold = true), fireAt + 1000))
    }

    @Test
    fun `序列化回环保留全部字段`() {
        val src = listOf(
            ZCodeScheduledMessageService.Item("a", "sess", "G:\\p", "文本\n多行", 123L, 456L, hold = true, providerId = "p1", modelId = "glm-5.3"),
            ZCodeScheduledMessageService.Item("b", "sess2", "", "", -1L, 0L, hold = false),
        )
        val json = ZCodeScheduledMessageService.itemsToJson(src).toString()
        val parsed = ZCodeScheduledMessageService.parseItems(json)
        assertEquals(src, parsed)
    }

    @Test
    fun `损坏或空存储解析回空列表不抛异常`() {
        assertTrue(ZCodeScheduledMessageService.parseItems(null).isEmpty())
        assertTrue(ZCodeScheduledMessageService.parseItems("").isEmpty())
        assertTrue(ZCodeScheduledMessageService.parseItems("not json {").isEmpty())
        assertTrue(ZCodeScheduledMessageService.parseItems("[{\"id\":1}]").isEmpty()) // 缺字段条目被跳过
    }


    @Test
    fun `旧存储无模型字段解析为空（跟随会话）`() {
        val raw = "[{\"id\": \"a\", \"sessionId\": \"s\", \"workspacePath\": \"\", \"text\": \"x\", \"fireAt\": 1, \"createdAt\": 2, \"hold\": false}]"
        val parsed = ZCodeScheduledMessageService.parseItems(raw)
        assertEquals(1, parsed.size)
        assertEquals(null, parsed[0].providerId)
        assertEquals(null, parsed[0].modelId)
    }
    @Test
    fun `已发记录序列化回环保留全部字段`() {
        val src = listOf(
            ZCodeScheduledMessageService.FireRecord("sess", "定时任务", 123L, 789L),
            ZCodeScheduledMessageService.FireRecord("sess2", "", -1L, 0L),
        )
        val json = ZCodeScheduledMessageService.firedToJson(src).toString()
        assertEquals(src, ZCodeScheduledMessageService.parseFired(json))
    }

    @Test
    fun `已发记录损坏或空存储解析回空列表不抛异常`() {
        assertTrue(ZCodeScheduledMessageService.parseFired(null).isEmpty())
        assertTrue(ZCodeScheduledMessageService.parseFired("").isEmpty())
        assertTrue(ZCodeScheduledMessageService.parseFired("not json {").isEmpty())
        assertTrue(ZCodeScheduledMessageService.parseFired("[{\"text\":\"x\"}]").isEmpty()) // 缺字段条目被跳过
    }
}
