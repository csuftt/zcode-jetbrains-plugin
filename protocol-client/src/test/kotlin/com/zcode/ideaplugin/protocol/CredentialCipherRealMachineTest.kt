package com.zcode.ideaplugin.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Disabled
import org.junit.jupiter.api.Test
import kotlin.test.assertTrue

/**
 * 真机验证（仅本机手跑，默认禁用不入 CI）：生产链路 readCredentialEntries →
 * WindowsCredentialManagerReader(CredRead) → v2 解密 → 账号渠道 overlay 构建。
 *
 * 登录态双形态兼容断言（2026-11-13 zai_cn 排障后收口）：
 * - 老直登（≤3.17 客户端 / 直登 bigmodel）：oauth:bigmodel:{access_token,user_info}；
 * - zai_cn 登录（3.18.2+ Z.ai CN 登录流）：oauth:zai_cn:* + oauth:linked_bigmodel
 *   （BigModel 关联材料 {userId,customerId,accessToken}）。
 * 依赖：本机 ZCode 已登录、凭据管理器有条目、runtime 目录在位。
 * 手跑：去掉 @Disabled 或 IDE 里单测执行。
 */
@Disabled("真机专属：依赖本机登录态与凭据管理器")
class CredentialCipherRealMachineTest {

    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `真实 credentials_json v2 全量解密（双登录态口径）`() {
        val entries = AccountProviderBridge.readCredentialEntries()
        println("解出条目数: ${entries.size} / 键: ${entries.keys.map { it.take(40) }}")
        assertTrue(entries.isNotEmpty(), "真实凭证表解出为空——密钥环链路未通")
        val directToken = entries["oauth:bigmodel:access_token"]
        val linkedToken = entries[AccountProviderBridge.KEY_LINKED_BIGMODEL]?.let {
            runCatching {
                json.parseToJsonElement(it).jsonObject["accessToken"]?.jsonPrimitive?.content
            }.getOrNull()
        }
        val token = directToken ?: linkedToken
        assertTrue(token != null && token.startsWith("eyJ"), "PAT 材料 access_token 应解出 JWT（直登键或 linked_bigmodel 其一）")
        val userInfo = entries["oauth:bigmodel:user_info"]
        if (userInfo != null) {
            assertTrue(userInfo.trim().startsWith("{"), "直登 user_info 应解出 JSON")
        } else {
            val identity = AccountProviderBridge.identityOf(entries, "bigmodel")
            assertTrue(!identity.isNullOrBlank(), "无直登键时应从 linked_bigmodel 解出 bigmodel 身份")
        }
        println("真机链路 PASS（形态=${if (directToken != null) "bigmodel直登" else "zai_cn+linked_bigmodel"}，token=${token!!.length} chars JWT）")
    }

    @Test
    fun `真实 builtin 文件构建账号渠道 overlay`() {
        // 取 runtime 缓存最新 builtin（与 BuiltinModelCatalog 读序一致）
        val runtime = java.nio.file.Path.of(
            System.getProperty("user.home"), ".zcode", "v2", "runtime", "provider",
        )
        val builtin = java.nio.file.Files.walk(runtime, 6).use { stream ->
            stream.filter { it.fileName.toString() == "zcode-builtin.json" && java.nio.file.Files.isRegularFile(it) }
                .max(java.util.Comparator.comparingLong { p ->
                    runCatching { java.nio.file.Files.getLastModifiedTime(p).toMillis() }.getOrDefault(0L)
                })
                .orElse(null)
        }
        assertTrue(builtin != null, "runtime 缓存无 zcode-builtin.json")
        println("builtin = $builtin")
        val overlay = AccountProviderBridge.buildAccountOverlay(builtin)
        println("overlay = ${overlay != null}")
        overlay?.let {
            println("providers: ${it.providers.keys}")
            println("states: ${it.states.keys}")
        }
        assertTrue(overlay != null, "overlay 构建为 null——账号渠道仍 fail-closed")
    }
}
