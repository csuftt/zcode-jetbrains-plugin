package com.zcode.ideaplugin.protocol

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Disabled
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * 真机验证（仅本机手跑，默认禁用不入 CI）：真实登录态（credentials.json v2 解密）→
 * 官方 MCP 鉴权头组装。覆盖 zai_cn 登录 + linked_bigmodel 关联材料的家族回退。
 *
 * 依赖：本机 ZCode 已登录、凭据管理器有条目。手跑：去掉 @Disabled 或 IDE 单测执行。
 */
@Disabled("真机专属：依赖本机登录态与凭据管理器")
class OfficialMcpAuthRealMachineTest {

    @Test
    fun `真实登录态组装视频插件鉴权头`() {
        val origin = OfficialMcpAuth.resolveOrigin()
        val params = buildJsonObject {
            put("pluginId", "video-generation@zcode-plugins-official")
            put("targetOrigin", origin)
            put("mcpKey", "video_generation")
        }
        val reply = OfficialMcpAuth.resolveReply(params, origin)
        assertTrue(reply.ok, "真实登录态应能组装官方 MCP 鉴权头（reason=${reply.reason}）")
        assertTrue(
            reply.headers["Authorization"]?.startsWith("Bearer eyJ") == true,
            "Authorization 应为 Bearer <zcode jwt>",
        )
        val plan = reply.headers["X-Bigmodel-Authorization"]
        assertTrue(
            plan != null && plan.startsWith("Bearer eyJ"),
            "X-Bigmodel-Authorization 应解出套餐 access_token JWT（当前原因=${reply.reason}）",
        )
        assertEquals("PERSONAL", reply.headers["Bigmodel-Target-Type"])
        // 只打头名，不打值
        println("OfficialMcpAuth 真机链路 PASS headers=${reply.headers.keys}")
    }
}