package com.zcode.ideaplugin.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.net.URI

/**
 * 官方 MCP 鉴权头解析：反向请求 `interaction/requestOfficialMcpAuthHeaders` 的宿主侧实现。
 *
 * 链路（zcode.cjs 0.17.1 / 桌面 asar 逆向实证）：
 * - 官方插件（市场 id `zcode-plugins-official`）的 MCP server 在 plugin.json 里声明
 *   `auth: {type: "zcode_official", provider: "jwt_token"}`；CLI 每次 tools/call 前向宿主
 *   反向取身份头，塞进 `params._meta["com.zcode/official-mcp-auth"]`，server 再带着它调
 *   `${ZCODE_BASE_URL}/api/v1/toolhub/...`。
 * - 应答契约 strict `discriminatedUnion("ok")`：`{ok:true, headers:{...}}` 或
 *   `{ok:false, reason}`；reason 枚举仅 `official_auth_unavailable` /
 *   `official_auth_plan_required` / `official_mcp_origin_untrusted`。
 * - CLI 侧已做一次 targetOrigin 信任校验（必须等于它解析出的服务 origin）；宿主侧再校一次
 *   （origin 相等 + 插件来自官方市场），身份头不会流向第三方 origin。
 *
 * 身份材料来源（桌面 resolveOfficialMcpCredentials / buildOfficialMcpAuthHeaders 同源）：
 * - `Authorization: Bearer <credentials.zcodejwttoken>`
 * - `X-Bigmodel-Authorization: Bearer <套餐 access_token>`（v2 加密，[CredentialCipher] 解密）
 * - `Bigmodel-Target-Type: PERSONAL|TEAM`（team 连接再加 org/project）
 *
 * MCP server 消费方要求套餐（无套餐回 plan_required）；plugin-command 消费方套餐可选
 * （桌面 `plan-optional` 语义，只发身份头）。
 */
object OfficialMcpAuth {

    /** 官方插件市场 id（config.json enabledPlugins 键后缀，CLI sC 常量同值） */
    const val OFFICIAL_MARKETPLACE_SUFFIX = "@zcode-plugins-official"

    /** 生产服务 origin（zcode.cjs MJ 常量；ZCODE_PRODUCTION_BASE_URL 缺省值） */
    const val DEFAULT_PRODUCTION_ORIGIN = "https://zcode.z.ai"

    /** 测试服务 origin（zcode.cjs Psn 常量；ZCODE_TEST_BASE_URL 缺省值） */
    const val DEFAULT_TEST_ORIGIN = "https://zcode.chatglm.site"

    /** 应答 reason（CLI Tln 枚举全集） */
    const val REASON_UNAVAILABLE = "official_auth_unavailable"
    const val REASON_PLAN_REQUIRED = "official_auth_plan_required"
    const val REASON_ORIGIN_UNTRUSTED = "official_mcp_origin_untrusted"

    /** 宿主应答结果（headers 只在 ok=true 时有效；reason 只在 ok=false 时有效） */
    data class Reply(
        val ok: Boolean,
        val headers: Map<String, String> = emptyMap(),
        val reason: String? = null,
    )

    /**
     * 解析 ZCode 服务 origin（桌面 buildAgentEndpointOriginEnv + zcode.cjs px() 同口径）：
     * `ZCODE_BASE_URL` → `ZCODE_ENDPOINT_ORIGIN` → `ZCODE_PRODUCTION_BASE_URL`（test 环境为
     * `ZCODE_TEST_BASE_URL`）→ 内置默认。非法值 fail-soft 回默认（宁可指错也别崩启动）。
     */
    fun resolveOrigin(env: Map<String, String> = System.getenv()): String {
        val test = env["ZCODE_ENV"]?.trim()?.lowercase() == "test"
        val fallback = if (test) DEFAULT_TEST_ORIGIN else DEFAULT_PRODUCTION_ORIGIN
        val raw = if (test) {
            env["ZCODE_TEST_BASE_URL"]
        } else {
            env["ZCODE_BASE_URL"] ?: env["ZCODE_ENDPOINT_ORIGIN"] ?: env["ZCODE_PRODUCTION_BASE_URL"]
        }
        return normalizeOrigin(raw) ?: fallback
    }

    /**
     * origin 归一（WHATWG URL.origin 同口径）：只留 scheme://host[:port]，默认端口省略，
     * 拒账号信息；https 之外只允许回环 http（开发自测）。解析失败返回 null。
     */
    fun normalizeOrigin(raw: String?): String? {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return null
        return try {
            val uri = URI(text)
            if (uri.rawUserInfo != null) return null
            val scheme = uri.scheme?.lowercase() ?: return null
            if (scheme != "https" && scheme != "http") return null
            val host = uri.host?.lowercase()?.takeIf { it.isNotBlank() } ?: return null
            val loopback = host == "127.0.0.1" || host == "localhost" || host == "[::1]"
            if (scheme == "http" && !loopback) return null
            val port = when {
                uri.port != -1 -> uri.port
                scheme == "https" -> 443
                else -> 80
            }
            val defaultPort = (scheme == "https" && port == 443) || (scheme == "http" && port == 80)
            "$scheme://" + if (defaultPort) host else "$host:$port"
        } catch (_: Exception) {
            null
        }
    }

    /** 官方市场插件判定（pluginId = `<name>@<marketplace>`）；非官方插件不发身份头 */
    fun isOfficialPluginId(pluginId: String?): Boolean =
        pluginId?.trim()?.endsWith(OFFICIAL_MARKETPLACE_SUFFIX) == true

    /**
     * 反向请求主入口：解析 params 并组装应答（凭据/连接选择按需读取，异常 fail-closed）。
     *
     * @param params CLI 请求参数 `{mcpKey, pluginId, targetOrigin, consumer?, workspace?}`
     * @param officialOrigin spawn 时注入 app-server 的同一 origin（信任锚）
     */
    fun resolveReply(
        params: JsonObject,
        officialOrigin: String,
        entriesProvider: () -> Map<String, String> = { AccountProviderBridge.readCredentialEntries() },
        selectionProvider: () -> ProjectAccessTokenClient.Selection? = { AccountProviderBridge.connectionSelection() },
    ): Reply {
        val pluginId = params["pluginId"]?.jsonPrimitive?.contentOrNull
        val consumer = params["consumer"]?.jsonPrimitive?.contentOrNull
        val targetOrigin = params["targetOrigin"]?.jsonPrimitive?.contentOrNull
        return try {
            reply(
                pluginId = pluginId,
                consumer = consumer,
                targetOrigin = targetOrigin,
                officialOrigin = officialOrigin,
                entries = entriesProvider(),
                selection = selectionProvider(),
            )
        } catch (_: Exception) {
            Reply(false, reason = REASON_UNAVAILABLE)
        }
    }

    /**
     * 纯函数版鉴权头组装（单测入口，不做 IO）。
     *
     * @param consumer "mcp-server"（缺省，套餐必填）/ "plugin-command"（套餐可选）
     */
    fun reply(
        pluginId: String?,
        consumer: String?,
        targetOrigin: String?,
        officialOrigin: String,
        entries: Map<String, String>,
        selection: ProjectAccessTokenClient.Selection?,
    ): Reply {
        val expected = normalizeOrigin(officialOrigin) ?: return Reply(false, reason = REASON_ORIGIN_UNTRUSTED)
        if (normalizeOrigin(targetOrigin) != expected) return Reply(false, reason = REASON_ORIGIN_UNTRUSTED)
        if (!isOfficialPluginId(pluginId)) return Reply(false, reason = REASON_ORIGIN_UNTRUSTED)

        val jwt = entries["zcodejwttoken"]?.trim().orEmpty()
        if (jwt.isEmpty()) return Reply(false, reason = REASON_UNAVAILABLE)

        val planOptional = consumer == "plugin-command"
        val codingPlan = planAccessToken(entries, selection)
        if (codingPlan == null && !planOptional) return Reply(false, reason = REASON_PLAN_REQUIRED)

        val team = teamScope(entries, selection)
        val headers = buildMap {
            put("Authorization", "Bearer $jwt")
            codingPlan?.let { put("X-Bigmodel-Authorization", "Bearer $it") }
            put("Bigmodel-Target-Type", if (team != null) "TEAM" else "PERSONAL")
            team?.let {
                put("Bigmodel-Organization", it.first)
                put("Bigmodel-Project", it.second)
            }
        }
        return Reply(true, headers = headers)
    }

    /** 应答 JSON（strict schema：ok:true 只带 headers；ok:false 只带 reason） */
    fun toJson(reply: Reply): JsonObject = buildJsonObject {
        put("ok", reply.ok)
        if (reply.ok) {
            put("headers", buildJsonObject { reply.headers.forEach { (k, v) -> put(k, v) } })
        } else {
            put("reason", reply.reason ?: REASON_UNAVAILABLE)
        }
    }

    // ============ 身份材料解析 ============

    private val json = Json { ignoreUnknownKeys = true }

    /** 当前登录 provider（credentials 的 oauth:active_provider，值域 zai/zai_cn/bigmodel） */
    private fun activeProvider(entries: Map<String, String>): String? =
        entries["oauth:active_provider"]?.trim()?.lowercase()?.takeIf {
            it == "zai" || it == "zai_cn" || it == "bigmodel"
        }

    /**
     * 套餐凭证候选家族序：setting.json 连接选择 domain 优先（用户当下选中的档位），
     * 其次登录 provider，最后按已知家族兜底（任一有材料即可，服务端按 token 判定）。
     */
    private fun candidateFamilies(
        entries: Map<String, String>,
        selection: ProjectAccessTokenClient.Selection? = null,
    ): List<String> = buildList {
        selection?.domain?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }?.let(::add)
        activeProvider(entries)?.let(::add)
        add("bigmodel")
        add("zai_cn")
        add("zai")
    }.distinct()

    /**
     * 套餐 access_token：家族直登键 `oauth:<family>:access_token` 优先；bigmodel 家族
     * 在 zai_cn 登录态下回退 `oauth:linked_bigmodel` 的 accessToken（桌面
     * materialFromSnapshot 同款）。与 zcode JWT 同值视为误存，跳过。
     */
    private fun planAccessToken(
        entries: Map<String, String>,
        selection: ProjectAccessTokenClient.Selection? = null,
    ): String? {
        val jwt = entries["zcodejwttoken"]?.trim()
        for (family in candidateFamilies(entries, selection)) {
            val token = when (family) {
                "bigmodel" -> entries["oauth:bigmodel:access_token"]?.takeIf { it.isNotBlank() }
                    ?: linkedBigModelAccessToken(entries)
                else -> entries["oauth:$family:access_token"]?.takeIf { it.isNotBlank() }
            }
            if (!token.isNullOrBlank() && token != jwt) return token.trim()
        }
        return null
    }

    /** oauth:linked_bigmodel 关联材料里的 accessToken（JSON 字符串，解析失败按缺失） */
    private fun linkedBigModelAccessToken(entries: Map<String, String>): String? = try {
        entries[AccountProviderBridge.KEY_LINKED_BIGMODEL]
            ?.takeIf { it.isNotBlank() }
            ?.let { json.parseToJsonElement(it).jsonObject["accessToken"]?.jsonPrimitive?.contentOrNull }
            ?.takeIf { it.isNotBlank() }
    } catch (_: Exception) {
        null
    }

    /**
     * team 连接作用域：setting.json 选择 kind=team-coding-plan 且 org/project 齐备才回
     * TEAM（CLI/桌面 wireScope 同语义）；选择的家族与当前登录材料对不上按 PERSONAL。
     */
    private fun teamScope(
        entries: Map<String, String>,
        selection: ProjectAccessTokenClient.Selection?,
    ): Pair<String, String>? {
        val sel = selection ?: return null
        if (sel.kind.trim().lowercase() != "team-coding-plan") return null
        val domain = sel.domain.trim().lowercase()
        if (domain.isNotEmpty() && domain !in candidateFamilies(entries)) return null
        val org = sel.organizationId?.trim().orEmpty()
        val project = sel.projectId?.trim().orEmpty()
        return if (org.isNotEmpty() && project.isNotEmpty()) org to project else null
    }
}