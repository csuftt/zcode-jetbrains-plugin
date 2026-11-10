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
import java.security.MessageDigest
import java.time.Duration
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicReference
import java.io.IOException

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
 * - 插件侧缓存（2026-11-10 加固）：PAT 内存缓存至锚点前 120s；项目定位结果
 *   org/project 另缓存 30min——命中即整条换发链零 HTTP。旧实现每个模型请求都要先
 *   GET getCustomerInfo（一次网络抖动就让当回合失败，且每请求多一次 TLS 往返）。
 */
object ProjectAccessTokenClient {

    private val json = Json { ignoreUnknownKeys = true }

    /** HTTP 可注入（单测传 fake；生产 java.net.http） */
    fun interface Http {
        /** @return status to body */
        fun send(method: String, url: String, headers: Map<String, String>, body: String?): Pair<Int, String>
    }

    /**
     * 共享 HttpClient：连接池复用。旧实现每次 send 都 new 一个 client，管理面小接口
     * 白付一次 TCP+TLS 握手；CLI 每个 attempt 同步等材料，这笔开销直接叠在回合延迟上。
     * 连接超时压到 5s（小 JSON 接口，10s 太久）；请求整体 10s。
     */
    private val sharedClient: HttpClient by lazy {
        HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()
    }

    private val http: Http by lazy {
        Http { method, url, headers, body ->
            try {
                val rb = HttpRequest.newBuilder().uri(URI.create(url)).timeout(Duration.ofSeconds(10))
                for ((k, v) in headers) rb.header(k, v)
                if (method == "POST") rb.POST(HttpRequest.BodyPublishers.ofString(body ?: "", Charsets.UTF_8))
                else rb.GET()
                val resp = sharedClient.send(rb.build(), HttpResponse.BodyHandlers.ofString())
                resp.statusCode() to resp.body()
            } catch (e: IOException) {
                // 网络族失败（SSL/连接/超时，VPN/代理切换是高频诱因）：合成 -1 响应走
                // envelope 失败路径，兑现 resolve「任一步失败返回 Failed」契约
                -1 to "network: ${e.javaClass.simpleName}: ${e.message}"
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                -1 to "network: ${e.javaClass.simpleName}"
            }
        }
    }

    /** 最近一次管理面网络失败（时刻 to 简述）；任一次成功应答即清除 */
    private val lastNetworkFailure = AtomicReference<Pair<Long, String>?>(null)

    /** 供 UI 判定新鲜度：调用前快照，之后 [networkFailureSince] 非 null 即本次调用期间发生过网络失败 */
    val lastNetworkFailureMillis: Long get() = lastNetworkFailure.get()?.first ?: 0L

    /** [stamp] 之后发生的网络失败简述（如 "SSLHandshakeException: …"），无则 null */
    fun networkFailureSince(stamp: Long): String? =
        lastNetworkFailure.get()?.takeIf { it.first > stamp }?.second

    private fun recordNetworkFailure(reason: String) {
        lastNetworkFailure.set(System.currentTimeMillis() to reason)
        println("[PAT] network failure: $reason")
    }

    data class Pat(val token: String, val expiresAtMs: Long)

    /** setting.json 连接选择（providerFamilyConnectionSelections[domain]） */
    data class Selection(val domain: String, val kind: String, val organizationId: String?, val projectId: String?)

    data class ProjectRef(val organizationId: String, val projectId: String, val team: Boolean)

    /** 换发失败分类（上层出用户文案；detail 保留原始线索——异常类名/HTTP 状态/code） */
    enum class FailKind {
        NETWORK, UNAUTHORIZED, NOT_FOUND, SERVER, BAD_RESPONSE,
        NO_PROJECT, EMPTY_TOKEN, SELECTION_MISSING, NEGATIVE_CACHE, UNSUPPORTED, UNEXPECTED,
    }

    data class Failure(val kind: FailKind, val detail: String) {
        /** 用户可读单行原因：requestProviderRuntimeHeaders 的 errorMessage 追加此句 */
        fun describe(): String = when (kind) {
            FailKind.NETWORK -> "访问 bigmodel.cn 管理面网络失败（$detail），若刚切换过 VPN/代理请检查后重试"
            FailKind.UNAUTHORIZED -> "bigmodel.cn 登录态失效（$detail），请在 ZCode 中重新登录账号"
            FailKind.NOT_FOUND -> "管理面资源不存在（$detail），项目或 key 可能已变更"
            FailKind.SERVER -> "管理面服务异常（$detail）"
            FailKind.BAD_RESPONSE -> "管理面响应异常（$detail）"
            FailKind.NO_PROJECT -> "账号下没有可用的个人项目（$detail）"
            FailKind.EMPTY_TOKEN -> "管理面未返回 accessToken（$detail）"
            FailKind.SELECTION_MISSING -> "团队连接缺少组织/项目（$detail）"
            FailKind.NEGATIVE_CACHE -> "刚换发失败，短暂退避中（$detail）"
            FailKind.UNSUPPORTED -> detail
            FailKind.UNEXPECTED -> "凭证换发异常（$detail）"
        }
    }

    sealed interface ResolveResult {
        data class Ok(val token: String) : ResolveResult
        data class Failed(val failure: Failure) : ResolveResult
    }

    /** 单次调用链的失败记录点：各步骤只在失败处 note，resolve 统一取"最后一个失败"作理由 */
    private class Trail {
        var failure: Failure? = null
        fun note(kind: FailKind, detail: String) {
            failure = Failure(kind, detail)
        }
    }

    private data class CachedRef(val ref: ProjectRef, val expiresAtMs: Long)

    private const val ORIGIN = "https://bigmodel.cn"
    private const val REFRESH_AHEAD_MS = 120_000L

    /** PAT 缓存（org/project → 令牌） */
    private val cache = ConcurrentHashMap<String, Pat>()

    /**
     * 项目定位缓存（access_token 摘要 → org/project，TTL 30min）。PAT 有效期内模型请求
     * 完全不打管理面；PAT 过期也只多一次 getCustomerInfo，不再每请求一次。
     */
    private val projectRefs = ConcurrentHashMap<String, CachedRef>()
    private const val REF_TTL_MS = 30L * 60_000L

    /** 换发失败负缓存（cacheKey → 失败屏蔽截止时刻）：防 attempt 风暴打爆管理面 */
    private val failedUntil = ConcurrentHashMap<String, Long>()

    private const val NEGATIVE_CACHE_MS = 60_000L

    /**
     * 取 PAT（项目定位缓存 + PAT 内存缓存优先，提前 120s 刷新）。
     * 任一步失败返回 [ResolveResult.Failed]（带分类与原始线索，供 errorMessage 诊断），
     * 恒不外抛；网络异常由默认 Http 合成 -1 响应/此处兜底异常，行为与材料缺失同型。
     */
    fun resolve(
        family: String,
        mode: String,
        accessToken: String,
        selection: Selection?,
        clientVersion: String = "0.0.0",
        http: Http? = null,
    ): ResolveResult {
        // zai 换发端点/鉴权形态不同，未实现
        if (family != "bigmodel") return ResolveResult.Failed(Failure(FailKind.UNSUPPORTED, "渠道 $family 的 PAT 换发未实现"))
        val send = http ?: this.http
        return try {
            val now = System.currentTimeMillis()
            val key = refKey(family, mode, accessToken)
            val trail = Trail()
            val cachedRef = projectRefs[key]?.takeIf { now < it.expiresAtMs }?.ref
            val ref = cachedRef ?: locateProject(mode, selection, accessToken, send, trail)
            if (ref == null) {
                val f = trail.failure ?: Failure(FailKind.UNEXPECTED, "定位项目失败")
                println("[PAT] locateProject failed (mode=$mode): ${f.kind} ${f.detail}")
                return ResolveResult.Failed(f)
            }
            if (cachedRef == null) projectRefs[key] = CachedRef(ref, now + REF_TTL_MS)
            val cacheKey = "${family}:${mode}:${ref.organizationId}:${ref.projectId}"
            cache[cacheKey]?.let { if (now < it.expiresAtMs) return ResolveResult.Ok(it.token) }
            // 负缓存：换发刚失败过，60s 内不再打管理面（CLI 每次 attempt 都会来要材料，
            // 无负缓存时失败即重试风暴，会加剧管理面限流）
            failedUntil[cacheKey]?.let {
                if (now < it) {
                    return ResolveResult.Failed(Failure(FailKind.NEGATIVE_CACHE, "剩余 ${(it - now) / 1000}s"))
                }
            }
            // 失败重试 1 次（跨瞬时抖动；间隔 800ms）
            var pat = issueAccessToken(ref, accessToken, clientVersion, send, trail)
            if (pat == null) {
                Thread.sleep(800)
                trail.failure = null
                pat = issueAccessToken(ref, accessToken, clientVersion, send, trail)
            }
            if (pat == null) {
                val f = trail.failure ?: Failure(FailKind.UNEXPECTED, "签发失败")
                println("[PAT] issue failed twice (org=${ref.organizationId}, project=${ref.projectId}): ${f.kind} ${f.detail}, negative-cache ${NEGATIVE_CACHE_MS / 1000}s")
                failedUntil[cacheKey] = System.currentTimeMillis() + NEGATIVE_CACHE_MS
                // 项目/key 已不存在：丢掉定位缓存，退避期后重新 getCustomerInfo 自愈
                if (f.kind == FailKind.NOT_FOUND) projectRefs.remove(key)
                return ResolveResult.Failed(f)
            }
            failedUntil.remove(cacheKey)
            cache[cacheKey] = pat
            ResolveResult.Ok(pat.token)
        } catch (e: Exception) {
            if (e is InterruptedException) Thread.currentThread().interrupt()
            // 兜底同样留档（注入 Http 抛异常/合成响应前的意外路径，UI 新鲜度判定依赖此处）
            val detail = "${e.javaClass.simpleName}: ${e.message ?: "网络不可达"}"
            recordNetworkFailure(detail)
            ResolveResult.Failed(Failure(if (e is IOException) FailKind.NETWORK else FailKind.UNEXPECTED, detail))
        }
    }

    /** access_token 摘要做定位缓存键（换账号即换 key，串号防御与 PAT cacheKey 同口径） */
    private fun refKey(family: String, mode: String, accessToken: String): String =
        "$family:$mode:" + MessageDigest.getInstance("SHA-256")
            .digest(accessToken.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
            .take(16)

    /** 测试/换账号清理（换账号串号防御由缓存键含 token 摘要兜底，此处供主动废弃） */
    fun invalidate() {
        cache.clear()
        projectRefs.clear()
    }

    /** 测试隔离：连负缓存、定位缓存与网络失败记录一起清（[invalidate] 只清正缓存） */
    fun resetForTest() {
        cache.clear()
        projectRefs.clear()
        failedUntil.clear()
        lastNetworkFailure.set(null)
    }

    private fun locateProject(
        mode: String,
        selection: Selection?,
        accessToken: String,
        http: Http,
        trail: Trail,
    ): ProjectRef? {
        if (mode == "team-coding-plan") {
            val org = selection?.organizationId?.takeIf { it.isNotBlank() }
            val project = selection?.projectId?.takeIf { it.isNotBlank() }
            if (org == null || project == null) {
                trail.note(FailKind.SELECTION_MISSING, "setting.json 的团队连接缺少 organizationId/projectId")
                return null
            }
            return ProjectRef(org, project, team = true)
        }
        // individual：从非团队项目解析（projectType!=="2"，官方"个人 Key 只能从非团队项目解析"）；
        // org/project 均优先"默认机构/默认项目"命名（官方 pickOrgAndProject 同款偏好）
        val data = envelope(get("$ORIGIN/api/biz/customer/getCustomerInfo", mapOf("Authorization" to accessToken), http), trail)
            ?: return null
        val orgs = data["organizations"]?.jsonArray
        if (orgs == null) {
            trail.note(FailKind.NO_PROJECT, "getCustomerInfo 响应无 organizations")
            return null
        }
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
        if (fallback == null) trail.note(FailKind.NO_PROJECT, "无非团队项目（projectType!=2）")
        return fallback
    }

    private fun issueAccessToken(ref: ProjectRef, accessToken: String, clientVersion: String, http: Http, trail: Trail): Pat? {
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
        val env = envelope(listResp, trail)
        if (env == null) {
            println("[PAT] list bad resp: ${describe(listResp)}")
            return null
        }
        val items = env["data"]?.jsonArray ?: env["api_keys"]?.jsonArray
        if (items == null) {
            println("[PAT] list no items: ${describe(200 to (env.toString()))}")
            trail.note(FailKind.BAD_RESPONSE, "api_keys 列表响应无 data 数组")
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
            val created = envelope(createResp, trail)
            if (created == null) {
                println("[PAT] create bad resp: ${describe(createResp)}")
                return null
            }
            keyId = created["apiKey"]?.jsonPrimitive?.contentOrNull
                ?: created["id"]?.jsonPrimitive?.contentOrNull
                ?: created["apiKeyId"]?.jsonPrimitive?.contentOrNull
            if (keyId == null) {
                trail.note(FailKind.BAD_RESPONSE, "创建 api_key 响应无 key 标识")
                return null
            }
        }
        val resp = http.send(
            "POST", "$listBase/$keyId/access_tokens",
            mapOf("Authorization" to "Bearer $accessToken", "Content-Type" to "application/json"),
            """{"clientType":"zcode","clientVersion":"$clientVersion"}""",
        )
        val issueEnv = envelope(resp, trail)
        if (issueEnv == null) {
            println("[PAT] issue bad resp (keyId tail=…${keyId.takeLast(6)}): ${describe(resp)}")
            return null
        }
        val token = issueEnv["accessToken"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }
        if (token == null) {
            println("[PAT] issue no accessToken: ${describe(200 to resp.second)}")
            trail.note(FailKind.EMPTY_TOKEN, "签发响应无 accessToken")
            return null
        }
        val expiresInSec = issueEnv["expiresIn"]?.jsonPrimitive?.intOrNull ?: 18000
        if (expiresInSec <= 0) {
            trail.note(FailKind.BAD_RESPONSE, "签发响应 expiresIn=$expiresInSec")
            return null
        }
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

    /** 管理面 envelope：{code:200|0, data:{...}}；data 为数组等非对象形态时包一层 {"data":...}。
     *  失败时在 [trail] 记分类与线索；-1 为默认 Http 的网络失败合成码，2xx 即清网络失败记录
     *  （注入 fake 同样过此关口） */
    private fun envelope(resp: Pair<Int, String>, trail: Trail): JsonObject? {
        if (resp.first == -1) {
            val detail = resp.second.removePrefix("network: ")
            recordNetworkFailure(detail)
            trail.note(FailKind.NETWORK, detail)
            return null
        }
        if (resp.first in 200..299) {
            lastNetworkFailure.set(null)
        } else {
            trail.note(
                when (resp.first) {
                    401, 403 -> FailKind.UNAUTHORIZED
                    404 -> FailKind.NOT_FOUND
                    else -> FailKind.SERVER
                },
                "HTTP ${resp.first}",
            )
            return null
        }
        return try {
            val root = json.parseToJsonElement(resp.second).jsonObject
            val code = root["code"]?.jsonPrimitive?.intOrNull
                ?: root["code"]?.jsonPrimitive?.contentOrNull?.toIntOrNull()
            if (code == null) {
                trail.note(FailKind.BAD_RESPONSE, "HTTP ${resp.first} 响应缺少 code")
                return null
            }
            if (code != 200 && code != 0) {
                val msg = root["msg"]?.jsonPrimitive?.contentOrNull?.take(80)
                trail.note(
                    if (code == 401 || code == 403) FailKind.UNAUTHORIZED else FailKind.BAD_RESPONSE,
                    "HTTP ${resp.first} code=$code" + (msg?.let { " msg=$it" } ?: ""),
                )
                return null
            }
            when (val data = root["data"]) {
                is JsonObject -> data
                null -> {
                    trail.note(FailKind.BAD_RESPONSE, "HTTP ${resp.first} 响应无 data")
                    null
                }
                else -> buildJsonObject { put("data", data) }
            }
        } catch (_: Exception) {
            trail.note(FailKind.BAD_RESPONSE, "HTTP ${resp.first} 响应非 JSON")
            null
        }
    }
}
