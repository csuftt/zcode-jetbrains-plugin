package com.zcode.ideaplugin.remote

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import java.util.concurrent.ConcurrentHashMap.newKeySet

/**
 * 缺陷FV（2026-11-04 手机 HAR 定案）：官方 H5 恢复链 resyncConversationV4 只带
 * {workspacePath?, subscriptionId, base, forceSnapshot} 不带 sessionId——此前硬性
 * 要求 sessionId 回 "sessionId required"，恢复链必死=点大会话恒「重新连接」。
 * 本测试钉死 BridgeV4Context.sessionIdForSubscription 反查语义：
 * ① conversation 订阅按 subscriptionId 命中并剥出 sessionId；
 * ② sessions-index 订阅不参与（topic 尾段不是 sessionId）；
 * ③ 未注册/空查值不命中（订阅先占坑期 subscriptionId 为占位空串）。
 */
class ResyncSessionLookupTest {

    @Test
    fun `conversation 订阅按 subscriptionId 反查命中`() {
        val ctx = RemoteChannelHandlers.BridgeV4Context("conn-1")
        ctx.subscriptions["conversation/sess_6484f362-5df6"] =
            RemoteChannelHandlers.V4Subscription("conversation/sess_6484f362-5df6", "sub-mw1kw238-gst8ptk5-10", newKeySet())
        ctx.subscriptions["sessions-index/G:/AI-Agent/suiteng-ai-agent"] =
            RemoteChannelHandlers.V4Subscription("sessions-index/G:/AI-Agent/suiteng-ai-agent", "sub-idx-1", newKeySet())

        assertEquals("sess_6484f362-5df6", ctx.sessionIdForSubscription("sub-mw1kw238-gst8ptk5-10"))
        assertNull(ctx.sessionIdForSubscription("sub-idx-1"), "sessions-index 订阅不得误判为 sessionId")
        assertNull(ctx.sessionIdForSubscription("sub-unknown"))
    }

    @Test
    fun `空 subscriptionId 不命中占位空串订阅`() {
        val ctx = RemoteChannelHandlers.BridgeV4Context("conn-1")
        ctx.subscriptions["conversation/sess_x"] =
            RemoteChannelHandlers.V4Subscription("conversation/sess_x", "", newKeySet())
        assertNull(ctx.sessionIdForSubscription(""))
    }
}
