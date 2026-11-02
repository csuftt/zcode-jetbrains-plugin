package com.zcode.ideaplugin.ui

import org.junit.jupiter.api.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * 无会话空标签判据纯函数单测（不依赖 Project）：
 * 标签名「（空）」后缀 + 批量关闭 + 关闭免确认三处共用的 isStandbyUnbound。
 * 场景矩阵：出生待命 / 懒加载未恢复 / 落位 / 运行期清空 / 恢复失败
 */
class ZCodeStandbyTabTest {

    private val sid = "sess-abc123"

    @Test
    fun `new tab born standby is unbound immediately`() {
        // createNewTab 出生的标签：initialSessionId=null，webview 还没 boot 也直接标
        assertTrue(ZCodeToolWindowPanel.isStandbyUnbound(sessionId = null, initialSessionId = null, frontendReady = false))
        assertTrue(ZCodeToolWindowPanel.isStandbyUnbound(sessionId = null, initialSessionId = null, frontendReady = true))
    }

    @Test
    fun `lazy restored tab not marked before frontend boots`() {
        // 重启恢复的非激活标签（TabState 里有会话、懒加载 JCEF 未建）：不能标，等恢复
        assertFalse(ZCodeToolWindowPanel.isStandbyUnbound(sessionId = null, initialSessionId = sid, frontendReady = false))
    }

    @Test
    fun `restored tab whose session fails to resume is marked after boot`() {
        // 懒加载标签激活后 boot 完成（frontendReady=true）仍无绑定 = 恢复失败（会话已删）
        assertTrue(ZCodeToolWindowPanel.isStandbyUnbound(sessionId = null, initialSessionId = sid, frontendReady = true))
    }

    @Test
    fun `tab with bound session is never marked`() {
        // subscribe 落位（含 boot 前后、待命清空又重新绑定）一律不标
        assertFalse(ZCodeToolWindowPanel.isStandbyUnbound(sessionId = sid, initialSessionId = null, frontendReady = false))
        assertFalse(ZCodeToolWindowPanel.isStandbyUnbound(sessionId = sid, initialSessionId = sid, frontendReady = true))
    }

    @Test
    fun `cleared tab returns to standby and is marked again`() {
        // 「新建会话」按钮路径：曾有会话 → clearTabSession 清空 → 回到待命（boot 必已完成）
        assertTrue(ZCodeToolWindowPanel.isStandbyUnbound(sessionId = null, initialSessionId = sid, frontendReady = true))
    }
}
