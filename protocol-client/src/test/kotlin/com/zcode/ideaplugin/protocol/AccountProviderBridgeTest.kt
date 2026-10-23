package com.zcode.ideaplugin.protocol

import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.*
import java.nio.file.Files
import java.nio.file.Path

/**
 * AccountProviderBridge 单元测试——裸 app-server 账号渠道供给链（updateAccountConfig
 * 推送构造 + requestProviderRuntimeHeaders 应答）。
 *
 * schema 依据（2026-09-21 开源源码）：
 * - providers 值 strict 只允许 {access:{type:"zhipu-account",entitled}, builtinModelIds?}
 * - entitled=true 渠道 states 必须带 boolean current
 * - builtin revision = "zcode-builtin:<json revision>:<sha256-hex(绝对路径)>"
 *
 * 激活判据（2026-09-21 真机教训后收紧；2026-10-23 team 放开为同模板本地键）：目录条目 ×
 * mode 判定（off-peak 排除 / team 同模板键在即激活）×端点门控（zcode-plan 网关）×
 * 凭证材料——start-plan 的 JWT 存在只说明登录过，不等于有套餐，且其端点是滑块门控网关。
 * team 放开依据：GLM Coding Max 个人档的 key 被新客户端落在本地 team 键名下（键模板
 * 与 individual 同构、端点同 open.bigmodel.cn/api/anthropic），键缺（老团队远端解析）
 * 维持 fail-closed 向后兼容。
 */
class AccountProviderBridgeTest {

    /** 官方 zcode-builtin.json 同构样本：6 个 zhipu-account 条目（zai/bigmodel 各三档 + off-peak） */
    private fun builtinFile(revision: Any = 30): Path {
        fun acc(pid: String, mode: String, url: String) =
            """{"providerId":"$pid","providerName":"$pid-name","config":{"access":{"type":"zhipu-account","mode":"$mode"},"api":{"type":"anthropic-messages","baseUrl":"$url"},"builtinModelIds":["GLM-5.3","GLM-5.3-Flash"]}}"""
        val content = """
        {"revision": $revision, "config": {"providerConfigRules": {"providerRules": [
          ${acc("account:zai-individual-coding-plan", "individual-coding-plan", "https://api.z.ai/api/anthropic")},
          ${acc("account:zai-team-coding-plan", "team-coding-plan", "https://api.z.ai/api/anthropic")},
          ${acc("account:zai-start-plan", "start-plan", "https://zcode.z.ai/api/v1/zcode-plan/anthropic")},
          ${acc("account:bigmodel-individual-coding-plan", "individual-coding-plan", "https://open.bigmodel.cn/api/anthropic")},
          ${acc("account:bigmodel-team-coding-plan", "team-coding-plan", "https://open.bigmodel.cn/api/anthropic")},
          ${acc("account:bigmodel-start-plan", "start-plan", "https://zcode.z.ai/api/v1/zcode-plan/anthropic")},
          ${acc("account:bigmodel-offpeak-idle-plan", "off-peak", "https://zcode.z.ai/api/v1/off-peak/anthropic")}
        ]}}}
        """.trimIndent()
        val f = Files.createTempFile("zcode-builtin", ".json")
        Files.writeString(f, content)
        return f
    }

    /** 全凭证齐备的 credentials 表（zai + bigmodel 各 individual/start） */
    private fun fullEntries(): Map<String, String> = mapOf(
        "oauth:zai:user_info" to """{"id":"user-zai-01","name":"tester"}""",
        "oauth:bigmodel:user_info" to """{"id":"user-bigmodel-01","name":"tester"}""",
        "zcodejwttoken" to "jwt-token-value",
        "account-provider:coding-plan:account:zai-individual-coding-plan:account:user-zai-01:api-key" to "zai-plan-key",
        "account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:user-bigmodel-01:api-key" to "bigmodel-plan-key",
    )

    // ===== requestAuthApiKey（反向请求应答判据）=====

    @Test
    fun `individual 模式按 identity 取 plan key`() {
        assertEquals(
            "zai-plan-key",
            AccountProviderBridge.requestAuthApiKey("account:zai-individual-coding-plan", "individual-coding-plan", fullEntries()),
        )
        assertEquals(
            "bigmodel-plan-key",
            AccountProviderBridge.requestAuthApiKey("account:bigmodel-individual-coding-plan", "individual-coding-plan", fullEntries()),
        )
    }

    @Test
    fun `start-plan 模式取 zcodejwttoken`() {
        assertEquals(
            "jwt-token-value",
            AccountProviderBridge.requestAuthApiKey("account:zai-start-plan", "start-plan", fullEntries()),
        )
    }

    @Test
    fun `team 静态键不供给（实机 1004 死路）走 PAT 链供给`() {
        // 历史 team 静态键即使存在也不供给——实机调 anthropic 端点必得 [1004]
        val legacy = fullEntries() + mapOf(
            "account-provider:coding-plan:account:zai-team-coding-plan:account:user-zai-01:api-key" to "zai-team-key",
        )
        assertNull(AccountProviderBridge.requestAuthApiKey("account:zai-team-coding-plan", "team-coding-plan", legacy))
        // team 无 selection org/project 或无 oauth token → PAT 链无法换发 → null
        assertNull(
            AccountProviderBridge.requestAuthApiKey(
                "account:bigmodel-team-coding-plan", "team-coding-plan", fullEntries(),
                ProjectAccessTokenClient.Selection("bigmodel", "team-coding-plan", "o", "p"),
            ),
        )
        assertNull(AccountProviderBridge.requestAuthApiKey("account:zai-individual-coding-plan", null, fullEntries()))
    }

    // ===== PAT 换发链（2026-10-23 材料链对齐官方）=====

    /** PAT 全链 fake：getCustomerInfo → api_keys 列表 → access_tokens 三段响应 */
    private fun patHttp(team: Boolean): ProjectAccessTokenClient.Http {
        fun env(data: String) = """{"code":200,"data":$data}"""
        val listBody = if (team) """{"api_keys":[{"apiKey":"key-9","name":"zcode-team-api-key","keyType":2}]}"""
        else """{"api_keys":[{"apiKey":"key-1","name":"zcode-api-key"}]}"""
        return ProjectAccessTokenClient.Http { method, url, _, _ ->
            when {
                url.endsWith("/getCustomerInfo") -> 200 to env(
                    """{"organizations":[{"organizationId":"org-1","projects":[{"projectId":"proj-1","projectType":"1"}]}]}""",
                )
                url.endsWith("/api_keys") && method == "GET" -> 200 to env(listBody)
                url.endsWith("/access_tokens") && method == "POST" -> 200 to env(
                    """{"accessToken":"pat-token","tokenType":"Bearer","expiresIn":600}""",
                )
                else -> 404 to """{"code":404}"""
            }
        }
    }

    private fun patEntries(): Map<String, String> = mapOf(
        "oauth:bigmodel:user_info" to """{"id":"user-bigmodel-01"}""",
        "oauth:bigmodel:access_token" to "oauth-access-token",
    )

    @Test
    fun `individual 新客户端无静态键走 PAT 换发供给`() {
        val sel = ProjectAccessTokenClient.Selection("bigmodel", "individual-coding-plan", null, null)
        assertEquals(
            "pat-token",
            AccountProviderBridge.requestAuthApiKey(
                "account:bigmodel-individual-coding-plan", "individual-coding-plan",
                patEntries(), sel, http = patHttp(team = false),
            ),
        )
    }

    @Test
    fun `team 渠道 selection 带组织项目走 PAT 换发供给`() {
        val sel = ProjectAccessTokenClient.Selection("bigmodel", "team-coding-plan", "org-9", "proj-9")
        var sawOrgHeader = false
        var sawProjectHeader = false
        val http = ProjectAccessTokenClient.Http { method, url, headers, _ ->
            if (url.endsWith("/api_keys") && method == "GET") {
                sawOrgHeader = headers.containsKey("bigmodel-organization")
                sawProjectHeader = headers.containsKey("bigmodel-project")
                200 to """{"code":200,"data":{"api_keys":[{"apiKey":"key-9","name":"zcode-team-api-key","keyType":2}]}}"""
            } else if (url.endsWith("/access_tokens")) {
                200 to """{"code":200,"data":{"accessToken":"team-pat","expiresIn":600}}"""
            } else 404 to """{"code":404}"""
        }
        assertEquals(
            "team-pat",
            AccountProviderBridge.requestAuthApiKey(
                "account:bigmodel-team-coding-plan", "team-coding-plan",
                patEntries(), sel, http = http,
            ),
        )
        assertTrue(sawOrgHeader && sawProjectHeader)
    }

    @Test
    fun `access_token 误存 zcode JWT 拒绝走 PAT`() {
        val entries = patEntries() + mapOf(
            "oauth:bigmodel:access_token" to "jwt-token-value",
            "zcodejwttoken" to "jwt-token-value",
        )
        val sel = ProjectAccessTokenClient.Selection("bigmodel", "team-coding-plan", "o", "p")
        assertNull(
            AccountProviderBridge.requestAuthApiKey(
                "account:bigmodel-team-coding-plan", "team-coding-plan", entries, sel,
                http = patHttp(team = true),
            ),
        )
    }

    @Test
    fun `凭证缺失不供给`() {
        // 无 plan key
        assertNull(AccountProviderBridge.requestAuthApiKey("account:zai-individual-coding-plan", "individual-coding-plan", emptyMap()))
        // 有 key 无 identity
        val noIdentity = mapOf(
            "account-provider:coding-plan:account:zai-individual-coding-plan:account:user-zai-01:api-key" to "k",
        )
        assertNull(AccountProviderBridge.requestAuthApiKey("account:zai-individual-coding-plan", "individual-coding-plan", noIdentity))
        // identity 坏 JSON
        val badIdentity = mapOf("oauth:zai:user_info" to "{not-json")
        assertNull(AccountProviderBridge.requestAuthApiKey("account:zai-individual-coding-plan", "individual-coding-plan", badIdentity))
    }

    // ===== buildAccountOverlay（推送构造）=====

    @Test
    fun `全凭证齐备时只激活 individual 渠道（start-plan 网关门控与 team、off-peak 模式均排除）`() {
        val overlay = AccountProviderBridge.buildAccountOverlay(builtinFile(), fullEntries(), selection = null)!!
        assertEquals(
            setOf(
                "account:zai-individual-coding-plan",
                "account:bigmodel-individual-coding-plan",
            ),
            overlay.providers.keys,
        )
        // providers 值 strict 形状：只有 access 节
        val zai = overlay.providers["account:zai-individual-coding-plan"]!!.jsonObject
        assertEquals(setOf("access"), zai.keys)
        assertEquals(setOf("type", "entitled"), zai["access"]!!.jsonObject.keys)
        // states：entitled=true 渠道必须带 boolean current（official CLI 硬校验）
        val state = overlay.states["account:zai-individual-coding-plan"]!!.jsonObject
        assertTrue(state.keys.containsAll(setOf("availability", "entitled", "current")))
        assertEquals(true, state["entitled"]!!.jsonPrimitive.boolean)
        assertEquals(true, state["current"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun `team 渠道 selection 带组织项目且 oauth token 在即激活（PAT 链）`() {
        val sel = ProjectAccessTokenClient.Selection("bigmodel", "team-coding-plan", "org-1", "proj-1")
        val overlay = AccountProviderBridge.buildAccountOverlay(builtinFile(), patEntries(), sel)!!
        assertTrue("account:bigmodel-team-coding-plan" in overlay.providers.keys)
        // 历史 team 静态键不再是激活依据（实机 1004）
        val legacy = fullEntries() + mapOf(
            "account-provider:coding-plan:account:bigmodel-team-coding-plan:account:user-bigmodel-01:api-key" to "bigmodel-max-key",
        )
        assertNull(AccountProviderBridge.buildAccountOverlay(builtinFile(), legacy, sel)?.providers?.get("account:bigmodel-team-coding-plan"))
    }

    @Test
    fun `individual 渠道静态键缺失但 selection 匹配且 oauth token 在即激活（新客户端形态）`() {
        val sel = ProjectAccessTokenClient.Selection("bigmodel", "individual-coding-plan", null, null)
        val overlay = AccountProviderBridge.buildAccountOverlay(builtinFile(), patEntries(), sel)!!
        assertEquals(setOf("account:bigmodel-individual-coding-plan"), overlay.providers.keys)
    }

    @Test
    fun `无凭证时返回 null 不推送`() {
        assertNull(AccountProviderBridge.buildAccountOverlay(builtinFile(), emptyMap()))
        // 只有 identity 没有 key 同样不推
        assertNull(
            AccountProviderBridge.buildAccountOverlay(
                builtinFile(),
                mapOf("oauth:zai:user_info" to """{"id":"u1"}"""),
                selection = null,
            ),
        )
        // 只有 JWT（start-plan 材料）没有 individual key：start-plan 被门控排除 → 无可激活
        assertNull(
            AccountProviderBridge.buildAccountOverlay(
                builtinFile(),
                mapOf(
                    "oauth:bigmodel:user_info" to """{"id":"u1"}""",
                    "zcodejwttoken" to "jwt",
                ),
                selection = null,
            ),
        )
    }

    @Test
    fun `revision 内容寻址且 basedOn 逐字符对齐 builtin 文件`() {
        val f = builtinFile(30)
        val overlay = AccountProviderBridge.buildAccountOverlay(f, fullEntries())!!
        val expectedBasedOn = AccountProviderBridge.builtinRevision(f)!!
        assertEquals(expectedBasedOn, overlay.basedOnZCodeBuiltinRevision)
        assertTrue(expectedBasedOn.startsWith("zcode-builtin:30:"))
        // 同输入 revision 稳定（receivedRevision 去重依赖）
        assertEquals(
            overlay.revision,
            AccountProviderBridge.buildAccountOverlay(f, fullEntries())!!.revision,
        )
        // Built-in revision 变化 → basedOn 变化（CLI 端不匹配则 Registry 不发布）
        val f2 = builtinFile(31)
        assertTrue(AccountProviderBridge.builtinRevision(f2)!!.startsWith("zcode-builtin:31:"))
    }

    @Test
    fun `builtin 文件缺失或无 revision 返回 null`() {
        assertNull(AccountProviderBridge.builtinRevision(Path.of("definitely/not/exist.json")))
        val noRev = Files.createTempFile("no-rev", ".json")
        Files.writeString(noRev, """{"providerTemplates": {}}""")
        assertNull(AccountProviderBridge.builtinRevision(noRev))
    }

    // ===== individualPlanKey（官方 credential key 形状）=====

    @Test
    fun `plan key 形状与 identity 转义`() {
        assertEquals(
            "account-provider:coding-plan:account:zai-individual-coding-plan:account:user-01:api-key",
            AccountProviderBridge.individualPlanKey("account:zai-individual-coding-plan", "user-01"),
        )
        // 需转义字符走 JS encodeURIComponent 语义（空格 %20 而非 +）
        assertEquals(
            "account-provider:coding-plan:account:zai-individual-coding-plan:account:u%20id%2F1:api-key",
            AccountProviderBridge.individualPlanKey("account:zai-individual-coding-plan", "u id/1"),
        )
    }

    // ===== selectedAccountCredential（额度凭证：setting.json 选中账号渠道）=====

    /** 临时 home：setting.json 写激活态，zcode-builtin.json 落 runtime/provider（目录候选①） */
    private fun homeWithSetting(settingJson: String): String {
        val home = Files.createTempDirectory("acct-home")
        val v2 = Files.createDirectories(home.resolve(".zcode/v2"))
        Files.writeString(v2.resolve("setting.json"), settingJson)
        val runtime = Files.createDirectories(v2.resolve("runtime/provider"))
        Files.copy(builtinFile(), runtime.resolve("zcode-builtin.json"),
            java.nio.file.StandardCopyOption.REPLACE_EXISTING)
        return home.toString()
    }

    @Test
    fun `选中 individual 账号渠道返回解密 key 凭证`() {
        val home = homeWithSetting(
            """{"providerFamilyConnectionSelections":{"bigmodel":{"kind":"individual-coding-plan"}},
               "providerFamilyDomain":"bigmodel"}""",
        )
        val c = AccountProviderBridge.selectedAccountCredential(null, home.toString(), fullEntries())!!
        assertEquals("account:bigmodel-individual-coding-plan", c.providerId)
        assertEquals("account:bigmodel-individual-coding-plan-name", c.providerName)
        assertEquals("https://open.bigmodel.cn/api/anthropic", c.baseUrl)
        assertEquals("bigmodel-plan-key", c.apiKey)
    }

    @Test
    fun `providerFamilyDomain 缺省取首个 selection 键`() {
        val home = homeWithSetting(
            """{"providerFamilyConnectionSelections":{"zai":{"kind":"individual-coding-plan"}}}""",
        )
        assertEquals(
            "zai-plan-key",
            AccountProviderBridge.selectedAccountCredential(null, home.toString(), fullEntries())!!.apiKey,
        )
    }

    @Test
    fun `选择非账号渠道或 kind 漂移返回 null`() {
        // 客户端选中自定义供应商（kind 非账号三档）
        assertNull(
            AccountProviderBridge.selectedAccountCredential(
                null,
                homeWithSetting("""{"providerFamilyConnectionSelections":{"bigmodel":{"kind":"api-key"}},"providerFamilyDomain":"bigmodel"}"""),
                fullEntries(),
            ),
        )
        // 未知 kind（形状漂移）
        assertNull(
            AccountProviderBridge.selectedAccountCredential(
                null,
                homeWithSetting("""{"providerFamilyConnectionSelections":{"bigmodel":{"kind":"future-mode"}},"providerFamilyDomain":"bigmodel"}"""),
                fullEntries(),
            ),
        )
    }

    @Test
    fun `team 无材料与 start-plan 网关门控返回 null`() {
        assertNull(
            AccountProviderBridge.selectedAccountCredential(
                null,
                homeWithSetting("""{"providerFamilyConnectionSelections":{"bigmodel":{"kind":"team-coding-plan"}},"providerFamilyDomain":"bigmodel"}"""),
                fullEntries(),
            ),
        )
        assertNull(
            AccountProviderBridge.selectedAccountCredential(
                null,
                homeWithSetting("""{"providerFamilyConnectionSelections":{"zai":{"kind":"start-plan"}},"providerFamilyDomain":"zai"}"""),
                fullEntries(),
            ),
        )
    }

    @Test
    fun `team 选中且 oauth token 在走 PAT 返回凭证（2026-10-23 材料链）`() {
        val sel = ProjectAccessTokenClient.Selection("bigmodel", "team-coding-plan", "org-1", "proj-1")
        val c = AccountProviderBridge.selectedAccountCredential(
            null,
            homeWithSetting("""{"providerFamilyConnectionSelections":{"bigmodel":{"kind":"team-coding-plan"}},"providerFamilyDomain":"bigmodel"}"""),
            patEntries(),
            sel,
            patHttp(team = true),
        )!!
        assertEquals("account:bigmodel-team-coding-plan", c.providerId)
        assertEquals("https://open.bigmodel.cn/api/anthropic", c.baseUrl)
        assertEquals("pat-token", c.apiKey)
    }

    @Test
    fun `setting 缺失或凭证材料缺失返回 null`() {
        // 无 setting.json
        val emptyHome = Files.createTempDirectory("acct-empty")
        assertNull(AccountProviderBridge.selectedAccountCredential(null, emptyHome.toString(), fullEntries()))
        // setting 在但 credentials 无 individual 材料
        assertNull(
            AccountProviderBridge.selectedAccountCredential(
                null,
                homeWithSetting("""{"providerFamilyConnectionSelections":{"bigmodel":{"kind":"individual-coding-plan"}},"providerFamilyDomain":"bigmodel"}"""),
                emptyMap(),
            ),
        )
    }

    @Test
    fun `brandOf 派生品牌短名`() {
        assertEquals("BigModel", AccountProviderBridge.brandOf("account:bigmodel-individual-coding-plan", "x"))
        assertEquals("BigModel", AccountProviderBridge.brandOf("account:bigmodel-offpeak-idle-plan", "x"))
        assertEquals("Z.ai", AccountProviderBridge.brandOf("account:zai-team-coding-plan", "x"))
        // 非账号渠道回退原名（自定义渠道显示用户命名）
        assertEquals("千问", AccountProviderBridge.brandOf("3556624f-xxx", "千问"))
    }

    @Test
    fun `accessModeOf 派生官方 mode 枚举`() {
        assertEquals("individual-coding-plan", AccountProviderBridge.accessModeOf("account:bigmodel-individual-coding-plan"))
        assertEquals("team-coding-plan", AccountProviderBridge.accessModeOf("account:zai-team-coding-plan"))
        assertEquals("start-plan", AccountProviderBridge.accessModeOf("account:bigmodel-start-plan"))
        assertEquals("off-peak", AccountProviderBridge.accessModeOf("account:bigmodel-offpeak-idle-plan"))
        // 非账号渠道无 mode（H5 投影不伪装账号身份）
        assertNull(AccountProviderBridge.accessModeOf("builtin:bigmodel-coding-plan"))
        assertNull(AccountProviderBridge.accessModeOf("3556624f-xxx"))
    }

    // ===== overlayModelIds（账号渠道 personal 覆盖合并，2026-09-24 渠道重复修复）=====

    /** provider_config.json account:* 规则 config 节同构样本 */
    private fun ruleConfig(json: String): kotlinx.serialization.json.JsonObject =
        kotlinx.serialization.json.Json.parseToJsonElement(json).jsonObject

    @Test
    fun `无覆盖规则返回目录 builtinModelIds 原序`() {
        val builtin = listOf("GLM-5.3", "GLM-5.3-Flash")
        assertEquals(builtin, AccountProviderBridge.overlayModelIds(null, builtin))
        assertEquals(builtin, AccountProviderBridge.overlayModelIds(ruleConfig("{}"), builtin))
    }

    @Test
    fun `modelOrder 完整序当权威（真机客户端写入形态）`() {
        // 客户端新增 flashx 后写入的完整序：合并结果恰为 3 条、无重复
        assertEquals(
            listOf("GLM-5.3", "GLM-5.3-Flash", "glm-5.3-flashx"),
            AccountProviderBridge.overlayModelIds(
                ruleConfig("""{"personalModelIds":["glm-5.3-flashx"],"modelOrder":["GLM-5.3","GLM-5.3-Flash","glm-5.3-flashx"]}"""),
                listOf("GLM-5.3", "GLM-5.3-Flash"),
            ),
        )
    }

    @Test
    fun `modelOrder 缺省退化为 builtin 加 personal 追加`() {
        assertEquals(
            listOf("GLM-5.3", "GLM-5.3-Flash", "glm-5.3-flashx"),
            AccountProviderBridge.overlayModelIds(
                ruleConfig("""{"personalModelIds":["glm-5.3-flashx"]}"""),
                listOf("GLM-5.3", "GLM-5.3-Flash"),
            ),
        )
    }

    @Test
    fun `modelOrder 漏项时未收录模型按序补尾且去重`() {
        assertEquals(
            listOf("glm-5.3-flashx", "GLM-5.3", "GLM-5.3-Flash"),
            AccountProviderBridge.overlayModelIds(
                ruleConfig("""{"modelOrder":["glm-5.3-flashx"],"personalModelIds":["glm-5.3-flashx"]}"""),
                listOf("GLM-5.3", "GLM-5.3-Flash"),
            ),
        )
    }

    @Test
    fun `空白条目过滤`() {
        assertEquals(
            listOf("GLM-5.3"),
            AccountProviderBridge.overlayModelIds(
                ruleConfig("""{"personalModelIds":["","  "],"modelOrder":["GLM-5.3"]}"""),
                emptyList(),
            ),
        )
    }
}
