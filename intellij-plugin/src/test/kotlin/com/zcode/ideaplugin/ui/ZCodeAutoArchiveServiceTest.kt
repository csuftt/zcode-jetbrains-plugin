package com.zcode.ideaplugin.ui

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * ZCodeAutoArchiveService 纯逻辑单测（不依赖 Project）：
 * 归档记录的追加规则（仅 >0 落 / 插头部 / 双上限截断）与 JSON 往返解析（损坏降级空表）
 */
class ZCodeAutoArchiveServiceTest {

    private fun record(ts: Long, count: Int, titles: Int = count) = ZCodeAutoArchiveService.ArchiveRecord(
        ts = ts,
        mode = "auto",
        days = 7,
        count = count,
        sessions = (1..titles).map { ZCodeAutoArchiveService.ArchivedSessionRef("sess_$it", "会话 $it") },
    )

    @Test
    fun `zero-count rounds are not recorded`() {
        val records = listOf(record(1, 2))
        assertTrue(ZCodeAutoArchiveService.appendRecord(records, record(2, 0)) === records, "count=0 不落记录（原列表原样返回）")
    }

    @Test
    fun `new record prepends and list caps at max`() {
        var records = (1..ZCodeAutoArchiveService.RECORDS_MAX).map { record(it.toLong(), 1) }
        records = ZCodeAutoArchiveService.appendRecord(records, record(999, 3))
        assertEquals(ZCodeAutoArchiveService.RECORDS_MAX, records.size, "超限丢尾")
        assertEquals(999, records.first().ts, "新记录插头部")
    }

    @Test
    fun `sessions are capped and titles truncated`() {
        val longTitle = "长".repeat(500)
        val big = ZCodeAutoArchiveService.ArchiveRecord(
            ts = 1, mode = "manual", days = 7, count = 999,
            sessions = (1..500).map { ZCodeAutoArchiveService.ArchivedSessionRef("s$it", longTitle) },
        )
        val appended = ZCodeAutoArchiveService.appendRecord(emptyList(), big).single()
        assertEquals(200, appended.sessions.size, "单记录会话条目截断")
        assertTrue(appended.sessions.all { it.title.length == 80 }, "标题截断")
        assertEquals(999, appended.count, "count 保留实际值（不随展示截断改变）")
    }

    @Test
    fun `parse degrades to empty on corrupt json`() {
        assertTrue(ZCodeAutoArchiveService.parseRecords(null).isEmpty())
        assertTrue(ZCodeAutoArchiveService.parseRecords("").isEmpty())
        assertTrue(ZCodeAutoArchiveService.parseRecords("not-json{{{").isEmpty())
        val ok = ZCodeAutoArchiveService.parseRecords(
            """[{"ts":7,"mode":"auto","days":7,"count":1,"sessions":[{"sessionId":"a","title":"标题"}]}]""",
        )
        assertEquals(1, ok.size)
        assertEquals(7, ok[0].ts)
        assertEquals("标题", ok[0].sessions.single().title)
    }
}
