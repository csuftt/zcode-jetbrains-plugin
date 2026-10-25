package com.zcode.ideaplugin.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.concurrent.ConcurrentHashMap

/**
 * 套餐项目访问令牌（PAT）换发客户端——coding-plan 账号渠道模型请求的官方正宗材料。
 *
 * 协议事实（2026-10-23 开源源码勘查：packages/shared/src/project-access-token-client.ts、
 * packages/services/src/model-provider/accountProviderTeamPlanRequestKey.ts）：
 * - 官方客户端对 coding-plan 渠道的模型请求【从不使用】本地 credentials 的静态
 *   account-provider:...:api-key 键（v1 遗留，现行写入路径已移除）——每次请求用
 *   oauth access_token 向 bigmodel.cn 管理面换发短期 PAT（三段式），内存缓存提前
 *   120s 刷新，PAT 绝不落盘。
 * - open.bigmodel.cn/api/anthropic 端点校验的就是 PAT：静态两段式 key 调用必得
 *   [1004] Authentication Token 验证失败（2026-10-23 实机），即"渠道激活了但
 *   Provider authentication failed"的根因。
 * - 换发链（管理面 origin=bigmodel.cn，注意非 open.bigmodel.cn）：
 *   1. GET /api/biz/customer/getCustomerInfo，Authorization: <access_token>（裸 token
 *      无 Bearer，zai 才用 Bearer），定位 organizations/projects；
 *   2. individual：选第一个 projectType!=="2" 的非团队项目；team：selection 指定的
 *      organizationId/projectId（官方 schema team 连接必带 org/project）；
 *   3. GET /api/biz/v1/organization/{org}/projects/{project}/api_keys（team 额外带
 *      bigmodel-organization/bigmodel-project 头），找 name=zcode-api-key（个人，无
 *      keyType 约束）/zcode-team-api-key（团队，keyType===2），没有则 POST 创建
 *      （usageScene=1=CODING_PLAN）；
 *   4. POST .../api_keys/{keyId}/access_tokens，Authorization: Bearer <access_token>，
 *      body {clientType:"zcode", clientVersion} → data.accessToken 即 PAT。
 * - 模型请求头由 CLI 派生（x-api-key + Authorization 双发），不加 projectId 头；
 *   open.bigmodel.cn 的模型请求由 CLI 网关路由改写到 zcode.z.ai ultra（入口默认装配）。
 */
object ProjectAccessTokenClient {

    private val json = Json { ignoreUnknownKeys = true }

    /** HTTP 可注入（单测传 fake；生产 java.net.http） */
    fun interface Http {
        /** @return status to body */
        fun send(method: String, url: String, headers: Map<String, String>, body: String?): Pair<Int, String>
    }

    private val http: Http by lazy {
        Http { method, url, headers, body ->
            val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()
            val rb = HttpRequest.newBuilder().uri(URI.create(url)).timeout(Duration.ofSeconds(15))
            for ((k, v) in headers) rb.header(k, v)
            if (method == "POST") rb.POST(HttpRequest.BodyPublishers.ofString(body ?: "", Charsets.UTF_8))
            else rb.GET()
            val resp = client.send(rb.build(), HttpResponse.BodyHandlers.ofString())
            resp.statusCode() to resp.body()
        }
    }

    data class Pat(val token: String, val expiresAtMs: Long)

    /** setting.json 连接选择（providerFamilyConnectionSelections[domain]） */
    data class Selection(val domain: String, val kind: String, val organizationId: String?, val projectId: String?)

    data class ProjectRef(val organizationId: String, val projectId: String, val team: Boolean)

    private const val ORIGIN = "https://bigmodel.cn"
    private const val REFRESH_AHEAD_MS = 120_000L

    private val cache = ConcurrentHashMap<String, Pat>()

    /** 换发失败负缓存（cacheKey → 失败屏蔽截止时刻）：防 attempt 风暴打爆管理面 */
    private val failedUntil = ConcurrentHashMap<String, Long>()

    private const val NEGATIVE_CACHE_MS = 60_000L

    /**
     * 取 PAT（内存缓存优先，提前 120s 刷新）。任一步失败返回 null——调用方
     * headersApplied:false 快速失败，行为与材料缺失同型。
     */
    fun resolve(
        family: String,
        mode: String,
        accessToken: String,
        selection: Selection?,
        clientVersion: String = "0.0.0",
        http: Http? = null,
    ): String? {
        if (family != "bigmodel") return null // zai 换发端点/鉴权形态不同，未实现
        val send = http ?: this.http
        val ref = locateProject(mode, selection, accessToken, send)
        if (ref == null) {
            println("[PAT] locateProject failed (mode=$mode: getCustomerInfo bad/401 or no non-team project)")
            return null
        }
        val cacheKey = "${family}:${mode}:${ref.organizationId}:${ref.projectId}"
        val now = System.currentTimeMillis()
        cache[cacheKey]?.let { if (now < it.expiresAtMs) return it.token }
        // 负缓存：换发刚失败过，60s 内不再打管理面（CLI 每次 attempt 都会来要材料，
        // 无负缓存时失败即重试风暴，会加剧管理面限流）
        failedUntil[cacheKey]?.let { if (now < it) return null }
        // 失败重试 1 次（跨瞬时抖动；间隔 800ms）
        var pat = issueAccessToken(ref, accessToken, clientVersion, send)
        if (pat == null) {
            Thread.sleep(800)
            pat = issueAccessToken(ref, accessToken, clientVersion, send)
        }
        if (pat == null) {
            println("[PAT] issue failed twice (org=${ref.organizationId}, project=${ref.projectId}), negative-cache ${NEGATIVE_CACHE_MS / 1000}s")
            failedUntil[cacheKey] = now + NEGATIVE_CACHE_MS
            return null
        }
        failedUntil.remove(cacheKey)
        cache[cacheKey] = pat
        return pat.token
    }

    /** 测试/换账号清理（换账号串号防御由 cacheKey 含 org/project 兜底，此处供主动废弃） */
    fun invalidate() = cache.clear()

    private fun locateProject(mode: String, selection: Selection?, accessToken: String, http: Http): ProjectRef? {
        if (mode == "team-coding-plan") {
            val org = selection?.organizationId?.takeIf { it.isNotBlank() } ?: return null
            val project = selection.projectId?.takeIf { it.isNotBlank() } ?: return null
            return ProjectRef(org, project, team = true)
        }
        // individual：从非团队项目解析（projectType!=="2"，官方"个人 Key 只能从非团队项目解析"）；
        // org/project 均优先"默认机构/默认项目"命名（官方 pickOrgAndProject 同款偏好）
        val data = envelope(get("$ORIGIN/api/biz/customer/getCustomerInfo", mapOf("Authorization" to accessToken), http)) ?: return null
        val orgs = data["organizations"]?.jsonArray ?: return null
        var fallback: ProjectRef? = null
        for (org in orgs) {
            val o = org as? JsonObject ?: continue
            val orgId = o["organizationId"]?.jsonPrimitive?.contentOrNull ?: continue
            val orgName = o["organizationName"]?.jsonPrimitive?.contentOrNull ?: ""
            for (p in o["projects"]?.jsonArray ?: continue) {
                val po = p as? JsonObject ?: continue
                val pid = po["projectId"]?.jsonPrimitive?.contentOrNull ?: continue
                val type = po["projectType"]?.jsonPrimitive?.contentOrNull
                if (type == "2") continue
                val projName = po["projectName"]?.jsonPrimitive?.contentOrNull ?: ""
                val ref = ProjectRef(orgId, pid, team = false)
                if (orgName.contains("默认机构") && projName.contains("默认项目")) return ref
                if (fallback == null) fallback = ref
            }
        }
        return fallback
    }

    private fun issueAccessToken(ref: ProjectRef, accessToken: String, clientVersion: String, http: Http): Pat? {
        val listBase = "$ORIGIN/api/biz/v1/organization/${ref.organizationId}/projects/${ref.projectId}/api_keys"
        val listHeaders = buildMap {
            put("Authorization", accessToken)
            if (ref.team) {
                put("bigmodel-organization", ref.organizationId)
                put("bigmodel-project", ref.projectId)
            }
        }
        val wantName = if (ref.team) "zcode-team-api-key" else "zcode-api-key"
        // 列表响应 envelope：{total, data:[...], code, msg}，data 直接是条目数组
        // （envelope 已取 data；再包一层防御 data 内含 api_keys 键的形态）
        val listResp = get(listBase, listHeaders, http)
        val env = envelope(listResp)
        if (env == null) {
            println("[PAT] list bad resp: ${describe(listResp)}")
            return null
        }
        val items = env["data"]?.jsonArray ?: env["api_keys"]?.jsonArray
        if (items == null) {
            println("[PAT] list no items: ${describe(200 to (env.toString()))}")
            return null
        }
        // 条目主键实机为 apiKey 字段（无 id/apiKeyId，2026-10-23 探针实证）；
        // 匹配 name（team 加 keyType==2），usageScene 不作过滤（老条目可能 -1）
        var keyId: String? = null
        for (item in items) {
            val o = item as? JsonObject ?: continue
            val name = o["name"]?.jsonPrimitive?.contentOrNull ?: continue
            val id = o["apiKey"]?.jsonPrimitive?.contentOrNull
                ?: o["id"]?.jsonPrimitive?.contentOrNull
                ?: o["apiKeyId"]?.jsonPrimitive?.contentOrNull
                ?: o["keyId"]?.jsonPrimitive?.contentOrNull
                ?: continue
            if (ref.team) {
                if (name == wantName && o["keyType"]?.jsonPrimitive?.intOrNull == 2) { keyId = id; break }
            } else if (name == wantName) { keyId = id; break }
        }
        if (keyId == null) {
            // 没有同名 key 才创建（官方懒创建语义）
            println("[PAT] $wantName not in list (items=${items.size}), creating")
            val createBody = if (ref.team) """{"name":"$wantName","keyType":2,"usageScene":1}"""
            else """{"name":"$wantName","usageScene":1}"""
            val createResp = http.send("POST", listBase, listHeaders + mapOf("Content-Type" to "application/json"), createBody)
            val created = envelope(createResp)
            if (created == null) {
                println("[PAT] create bad resp: ${describe(createResp)}")
                return null
            }
            keyId = created["apiKey"]?.jsonPrimitive?.contentOrNull
                ?: created["id"]?.jsonPrimitive?.contentOrNull
                ?: created["apiKeyId"]?.jsonPrimitive?.contentOrNull
                ?: return null
        }
        val resp = http.send(
            "POST", "$listBase/$keyId/access_tokens",
            mapOf("Authorization" to "Bearer $accessToken", "Content-Type" to "application/json"),
            """{"clientType":"zcode","clientVersion":"$clientVersion"}""",
        )
        val issueEnv = envelope(resp)
        if (issueEnv == null) {
            println("[PAT] issue bad resp (keyId tail=…${keyId.takeLast(6)}): ${describe(resp)}")
            return null
        }
        val token = issueEnv["accessToken"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }
        if (token == null) {
            println("[PAT] issue no accessToken: ${describe(200 to resp.second)}")
            return null
        }
        val expiresInSec = issueEnv["expiresIn"]?.jsonPrimitive?.intOrNull ?: 18000
        if (expiresInSec <= 0) return null
        // 过期时刻以服务端返回的绝对锚点 expiresAt（epoch 秒）为准——实机实证该锚点对
        // 同一 key 统一（多次签发 expiresIn 递减、expiresAt 不变）：PAT 锚点过期前
        // 120 秒内重签发时 expiresIn 剩余不足 120，若按 now+expiresIn-120s 相对计算
        // 会 <= now 而误拒有效 PAT——这正是「每 5 小时锚点前供给断约 40 秒+自愈」的
        // 根因（2026-10-25 实机日志规律定案）。锚点边界窗口内签出的 PAT 依然有效，
        // 缓存最短保活 30s 避免锚点前签发风暴；锚点过后服务端自然给出新锚点。
        val serverAnchorMs = issueEnv["expiresAt"]?.jsonPrimitive?.longOrNull?.times(1000L)
        val expiresAt = maxOf(
            serverAnchorMs?.minus(REFRESH_AHEAD_MS)
                ?: (System.currentTimeMillis() + expiresInSec * 1000L - REFRESH_AHEAD_MS),
            System.currentTimeMillis() + 30_000L,
        )
        return Pat(token, expiresAt)
    }

    /** 响应摘要（脱敏截断，供失败日志） */
    private fun describe(resp: Pair<Int, String>): String =
        "status=${resp.first} body=" + resp.second.replace(Regex("[A-Za-z0-9._-]{24,}"), "<R>").take(220)

    private fun get(url: String, headers: Map<String, String>, http: Http) = http.send("GET", url, headers, null)

    /** 管理面 envelope：{code:200|0, data:{...}}；data 为数组等非对象形态时包一层 {"data":...} */
    private fun envelope(resp: Pair<Int, String>): JsonObject? {
        if (resp.first !in 200..299) return null
        return try {
            val root = json.parseToJsonElement(resp.second).jsonObject
            val code = root["code"]?.jsonPrimitive?.intOrNull
                ?: root["code"]?.jsonPrimitive?.contentOrNull?.toIntOrNull()
                ?: return null
            if (code != 200 && code != 0) return null
            when (val data = root["data"]) {
                is JsonObject -> data
                null -> null
                else -> buildJsonObject { put("data", data) }
            }
        } catch (_: Exception) {
            null
        }
    }
}
