package com.zcode.ideaplugin.protocol

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.*

/**
 * OfficialMcpAuth 单元测试——官方 MCP 鉴权反向请求（requestOfficialMcpAuthHeaders）的
 * 宿主侧应答。
 *
 * 契约依据（zcode.cjs 0.17.1 / 桌面 asar 逆向，2026-11-18）：
 * - 应答 strict discriminatedUnion("ok")：ok:true 只带 headers，ok:false 只带 reason；
 * - reason 枚举：official_auth_unavailable / official_auth_plan_required /
 *   official_mcp_origin_untrusted；
 * - 头集合与桌面 buildOfficialMcpAuthHeaders 逐字对齐：Authorization、
 *   X-Bigmodel-Authorization、Bigmodel-Target-Type（TEAM 加 org/project）；
 * - 材料：credentials 的 zcodejwttoken + 套餐 access_token（bigmodel 家族回退
 *   oauth:linked_bigmodel.accessToken）。
 */
class OfficialMcpAuthTest {

    private val origin = OfficialMcpAuth.DEFAULT_PRODUCTION_ORIGIN
    private val pluginId = "video-generation@zcode-plugins-official"

    private fun creds(vararg extra: Pair<String, String>): Map<String, String> =
        mapOf("zcodejwttoken" to "jwt-1", *extra)

    private fun reply(
        entries: Map<String, String> = creds("oauth:zai_cn:access_token" to "plan-1"),
        selection: ProjectAccessTokenClient.Selection? = null,
        consumer: String? = null,
        targetOrigin: String? = origin,
        id: String? = pluginId,
    ) = OfficialMcpAuth.reply(id, consumer, targetOrigin, origin, entries, selection)

    // ============ origin 解析/归一 ============

    @Test
    fun resolveOriginDefaultsToProduction() {
        assertEquals(origin, OfficialMcpAuth.resolveOrigin(emptyMap()))
    }

    @Test
    fun resolveOriginEnvPriorityAndOriginOnly() {
        assertEquals(
            "https://staging.example.com",
            OfficialMcpAuth.resolveOrigin(mapOf("ZCODE_BASE_URL" to "https://staging.example.com/api/v1")),
        )
        assertEquals(
            "https://endpoint.example.com",
            OfficialMcpAuth.resolveOrigin(mapOf("ZCODE_ENDPOINT_ORIGIN" to "https://endpoint.example.com/")),
        )
    }

    @Test
    fun resolveOriginTestEnv() {
        assertEquals(
            OfficialMcpAuth.DEFAULT_TEST_ORIGIN,
            OfficialMcpAuth.resolveOrigin(mapOf("ZCODE_ENV" to "test")),
        )
        assertEquals(
            "https://test.example.com",
            OfficialMcpAuth.resolveOrigin(
                mapOf("ZCODE_ENV" to "TEST", "ZCODE_TEST_BASE_URL" to "https://test.example.com/"),
            ),
        )
    }

    @Test
    fun resolveOriginInvalidFallsBack() {
        assertEquals(origin, OfficialMcpAuth.resolveOrigin(mapOf("ZCODE_BASE_URL" to "not a url")))
        assertEquals(origin, OfficialMcpAuth.resolveOrigin(mapOf("ZCODE_BASE_URL" to "ftp://zcode.z.ai")))
    }

    @Test
    fun normalizeOriginRules() {
        assertEquals("https://zcode.z.ai", OfficialMcpAuth.normalizeOrigin("https://zcode.z.ai:443/x"))
        assertEquals("https://zcode.z.ai", OfficialMcpAuth.normalizeOrigin("  HTTPS://ZCODE.Z.AI  "))
        assertNull(OfficialMcpAuth.normalizeOrigin("http://example.com"))
        assertEquals("http://127.0.0.1:8080", OfficialMcpAuth.normalizeOrigin("http://127.0.0.1:8080/"))
        assertNull(OfficialMcpAuth.normalizeOrigin("https://user:pw@zcode.z.ai"))
        assertNull(OfficialMcpAuth.normalizeOrigin(null))
        assertNull(OfficialMcpAuth.normalizeOrigin(""))
    }

    // ============ 应答主路径 ============

    @Test
    fun replyPersonalHeaders() {
        val r = reply()
        assertTrue(r.ok)
        assertEquals("Bearer jwt-1", r.headers["Authorization"])
        assertEquals("Bearer plan-1", r.headers["X-Bigmodel-Authorization"])
        assertEquals("PERSONAL", r.headers["Bigmodel-Target-Type"])
        assertNull(r.headers["Bigmodel-Organization"])
        assertNull(r.headers["Bigmodel-Project"])
    }

    @Test
    fun replyPrefersSelectedFamilyToken() {
        val r = reply(
            entries = creds(
                "oauth:zai_cn:access_token" to "plan-zai_cn",
                "oauth:bigmodel:access_token" to "plan-bigmodel",
            ),
            selection = ProjectAccessTokenClient.Selection("bigmodel", "individual-coding-plan", null, null),
        )
        assertTrue(r.ok)
        assertEquals("Bearer plan-bigmodel", r.headers["X-Bigmodel-Authorization"])
    }

    @Test
    fun replyLinkedBigmodelFallback() {
        val r = reply(
            entries = creds(
                "oauth:linked_bigmodel" to """{"userId":"u1","customerId":"c1","accessToken":"plan-linked"}""",
            ),
            selection = ProjectAccessTokenClient.Selection("bigmodel", "individual-coding-plan", null, null),
        )
        assertTrue(r.ok)
        assertEquals("Bearer plan-linked", r.headers["X-Bigmodel-Authorization"])
    }

    @Test
    fun replyTeamScope() {
        val r = reply(
            selection = ProjectAccessTokenClient.Selection("bigmodel", "team-coding-plan", "org-1", "proj-1"),
        )
        assertTrue(r.ok)
        assertEquals("TEAM", r.headers["Bigmodel-Target-Type"])
        assertEquals("org-1", r.headers["Bigmodel-Organization"])
        assertEquals("proj-1", r.headers["Bigmodel-Project"])
    }

    @Test
    fun replyTeamWithoutOrgProjectFallsBackPersonal() {
        val r = reply(
            selection = ProjectAccessTokenClient.Selection("bigmodel", "team-coding-plan", null, null),
        )
        assertTrue(r.ok)
        assertEquals("PERSONAL", r.headers["Bigmodel-Target-Type"])
    }

    // ============ 失败路径 ============

    @Test
    fun replyNoPlanIsPlanRequiredForMcpServer() {
        val r = reply(entries = creds())
        assertFalse(r.ok)
        assertEquals(OfficialMcpAuth.REASON_PLAN_REQUIRED, r.reason)
    }

    @Test
    fun replyNoPlanAllowedForPluginCommand() {
        val r = reply(entries = creds(), consumer = "plugin-command")
        assertTrue(r.ok)
        assertEquals("Bearer jwt-1", r.headers["Authorization"])
        assertNull(r.headers["X-Bigmodel-Authorization"])
        assertEquals("PERSONAL", r.headers["Bigmodel-Target-Type"])
    }

    @Test
    fun replyNoJwtIsUnavailable() {
        val r = reply(entries = mapOf("oauth:zai_cn:access_token" to "plan-1"))
        assertFalse(r.ok)
        assertEquals(OfficialMcpAuth.REASON_UNAVAILABLE, r.reason)
    }

    @Test
    fun replyStoredJwtAsPlanTokenIsRejected() {
        val r = reply(entries = mapOf("zcodejwttoken" to "same", "oauth:zai_cn:access_token" to "same"))
        assertFalse(r.ok)
        assertEquals(OfficialMcpAuth.REASON_PLAN_REQUIRED, r.reason)
    }

    @Test
    fun replyOriginMismatchIsUntrusted() {
        val r = reply(targetOrigin = "https://evil.example.com")
        assertFalse(r.ok)
        assertEquals(OfficialMcpAuth.REASON_ORIGIN_UNTRUSTED, r.reason)
    }

    @Test
    fun replyNonOfficialPluginIsUntrusted() {
        val r = reply(id = "third-party-plugin@some-marketplace")
        assertFalse(r.ok)
        assertEquals(OfficialMcpAuth.REASON_ORIGIN_UNTRUSTED, r.reason)
    }

    // ============ params 解析与应答 JSON ============

    @Test
    fun resolveReplyParsesParams() {
        val params = buildJsonObject {
            put("pluginId", pluginId)
            put("targetOrigin", origin)
            put("mcpKey", "video_generation")
        }
        val r = OfficialMcpAuth.resolveReply(
            params,
            origin,
            entriesProvider = { creds("oauth:zai_cn:access_token" to "plan-1") },
            selectionProvider = { null },
        )
        assertTrue(r.ok)
        assertEquals("Bearer plan-1", r.headers["X-Bigmodel-Authorization"])
    }

    @Test
    fun resolveReplyProviderFailureIsUnavailable() {
        val params = buildJsonObject {
            put("pluginId", pluginId)
            put("targetOrigin", origin)
        }
        val r = OfficialMcpAuth.resolveReply(
            params,
            origin,
            entriesProvider = { error("credentials.json unreadable") },
        )
        assertFalse(r.ok)
        assertEquals(OfficialMcpAuth.REASON_UNAVAILABLE, r.reason)
    }

    @Test
    fun toJsonMatchesStrictSchema() {
        val ok = OfficialMcpAuth.toJson(OfficialMcpAuth.Reply(true, headers = mapOf("Authorization" to "Bearer x")))
        assertEquals(setOf("ok", "headers"), ok.keys)
        assertEquals("Bearer x", ok["headers"]!!.jsonObject["Authorization"]!!.jsonPrimitive.content)

        val fail = OfficialMcpAuth.toJson(OfficialMcpAuth.Reply(false, reason = OfficialMcpAuth.REASON_UNAVAILABLE))
        assertEquals(setOf("ok", "reason"), fail.keys)
        assertEquals(OfficialMcpAuth.REASON_UNAVAILABLE, fail["reason"]!!.jsonPrimitive.content)
    }
}