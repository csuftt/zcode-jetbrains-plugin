package com.zcode.ideaplugin.ui

import com.zcode.ideaplugin.protocol.ZCodeProtocolException
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * getSettings 冷会话自愈失败的收尾决策测试（2026-11-13 PyCharm 冷启动窗口案例）。
 *
 * 真机时间线：12:32 重启 PyCharm → 新 app-server ready 后启动恢复 775 条重会话，
 * 服务端冷启动载入约 100s；getSettings 先撞 -32004（冷会话），自愈 resume 超时 15s、
 * 重读超时 10s，e2 只 log 不重试（自愈链断头），最终外层 -32004 原样抛前端被
 * 一刀切套上「会话槽位已满：重启 IDE 释放槽位」——而新进程槽位是空的，指引自相矛盾。
 *
 * 决策两维独立：
 * - retryBusy：e2 是真超时 → 会话在服务端忙窗口排队，应调度 settings busy-retry
 *   待就绪补推（12:34:15 服务端就绪后即可自愈，用户无需任何操作）；
 * - coldBoot：驻留账本水位 < 上限 → 服务端不可能因占满拒绝会话，外层 -32004
 *   必为冷启动载入问题，下发 reason=coldBoot 让前端走「载入中」文案而非「重启 IDE」。
 */
class SettingsFallbackAfterColdResumeTest {

    private fun timeoutEx() = ZCodeProtocolException("请求超时: session/read (10000ms)")

    private fun inactiveEx() = ZCodeProtocolException("[-32004] Session is not active: sess_f210e9fc")

    @Test
    fun `冷启动窗口的超时自愈失败要调度busy-retry并归类coldBoot`() {
        // 案例主场景：刚重启（账本水位 0~3），重读撞忙窗口超时
        val fb = ZCodeToolWindowPanel.settingsFallbackAfterColdResume(timeoutEx(), activeCount = 3)
        assertTrue(fb.retryBusy, "e2 超时应调度 busy-retry（此前只 log，自愈链断头）")
        assertTrue(fb.coldBoot, "水位未满时 -32004 是冷启动载入问题，非槽位满")
    }

    @Test
    fun `水位已达上限的超时不归类coldBoot但仍调度重试`() {
        // 真槽位满 + 忙窗口：重试照调（超时是独立维度），文案回归旧槽位指引
        val fb = ZCodeToolWindowPanel.settingsFallbackAfterColdResume(timeoutEx(), activeCount = 16)
        assertTrue(fb.retryBusy)
        assertFalse(fb.coldBoot, "水位达上限时不得否认槽位满，旧文案兜底成立")
    }

    @Test
    fun `非超时的自愈失败不调度重试`() {
        // resume 后重读仍 -32004（resume 真失败）——重试无意义，只归类
        val fb = ZCodeToolWindowPanel.settingsFallbackAfterColdResume(inactiveEx(), activeCount = 0)
        assertFalse(fb.retryBusy, "e2 非超时不调度 busy-retry")
        assertTrue(fb.coldBoot)
    }

    @Test
    fun `coldBoot判定以水位阈值16为界`() {
        // 15 < 16 → coldBoot；16 ≥ 16 → 非 coldBoot（边界即 highWater 本身）
        assertTrue(ZCodeToolWindowPanel.settingsFallbackAfterColdResume(inactiveEx(), activeCount = 15).coldBoot)
        assertFalse(ZCodeToolWindowPanel.settingsFallbackAfterColdResume(inactiveEx(), activeCount = 16).coldBoot)
        // 显式阈值可覆盖（服务端上限语义变化时同步）
        assertFalse(ZCodeToolWindowPanel.settingsFallbackAfterColdResume(inactiveEx(), activeCount = 16, highWater = 16).coldBoot)
        assertTrue(ZCodeToolWindowPanel.settingsFallbackAfterColdResume(inactiveEx(), activeCount = 16, highWater = 20).coldBoot)
    }
}
