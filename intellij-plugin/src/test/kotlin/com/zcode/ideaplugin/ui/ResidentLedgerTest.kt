package com.zcode.ideaplugin.ui

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * 驻留水位账本测试（缺陷BA 缓解）。
 *
 * 语义定案（zcode.cjs isEligible 源码）：被 legacy subscribe 的会话永久占坑
 * （无退订 RPC、不参与空闲清理），坑位仅进程重启清零——账本即"已打开会话集合"，
 * 只增不减。
 */
class ResidentLedgerTest {

    @Test
    fun `同会话重复记账只算一个坑位`() {
        val ledger = ResidentLedger()
        ledger.touch("a")
        ledger.touch("a")
        ledger.touch("b")
        assertEquals(2, ledger.activeCount())
    }

    @Test
    fun `占坑不过期——订阅钉死的会话不参与空闲清理`() {
        var now = 0L
        val ledger = ResidentLedger(now = { now })
        ledger.touch("a")
        now += 3_600_000 // 1 小时后：不存在"10 分钟自动释放"
        assertEquals(1, ledger.activeCount())
    }

    @Test
    fun `预计水位越过阈值时提醒且只提醒一次`() {
        val ledger = ResidentLedger(warnThreshold = 3)
        ledger.touch("a")
        ledger.touch("b")
        // 打开已占坑会话：不新增，预计 2 < 3，不提醒
        assertFalse(ledger.checkBeforeOpen("a"))
        // 打开新会话：预计 3 ≥ 3，提醒一次
        assertTrue(ledger.checkBeforeOpen("c"))
        // 同水位不重复提醒
        assertFalse(ledger.checkBeforeOpen("d"))
    }

    @Test
    fun `换代重置账本与提醒状态`() {
        val ledger = ResidentLedger(warnThreshold = 2)
        ledger.touch("a")
        assertTrue(ledger.checkBeforeOpen("b"))
        ledger.invalidateAll()
        assertEquals(0, ledger.activeCount())
        // 重置后同水位重新提醒（新进程从零积累）
        ledger.touch("x")
        assertTrue(ledger.checkBeforeOpen("y"))
    }
}
