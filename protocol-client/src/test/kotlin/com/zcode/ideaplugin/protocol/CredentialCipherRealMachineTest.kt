package com.zcode.ideaplugin.protocol

import org.junit.jupiter.api.Disabled
import org.junit.jupiter.api.Test
import kotlin.test.assertTrue

/**
 * 真机验证（仅本机手跑，默认禁用不入 CI）：生产链路 readCredentialEntries →
 * WindowsCredentialManagerReader(CredRead) → v2 解密 → access_token 应为 JWT，
 * 以及 3.18.0 builtin 文件 → 账号渠道 overlay 构建。
 * 依赖：本机 ZCode 已登录、凭据管理器有条目、runtime 3.18.0 目录在位。
 * 手跑：去掉 @Disabled 或 IDE 里单测执行。
 */
@Disabled("真机专属：依赖本机登录态与凭据管理器")
class CredentialCipherRealMachineTest {

    @Test
    fun `真实 credentials_json v2 全量解密`() {
        val entries = AccountProviderBridge.readCredentialEntries()
        println("解出条目数: ${entries.size} / 键: ${entries.keys.map { it.take(40) }}")
        assertTrue(entries.isNotEmpty(), "真实凭证表解出为空——密钥环链路未通")
        val token = entries["oauth:bigmodel:access_token"]
        assertTrue(token != null && token.startsWith("eyJ"), "access_token 应解出 JWT（eyJ 开头）")
        val userInfo = entries["oauth:bigmodel:user_info"]
        assertTrue(userInfo != null && userInfo.trim().startsWith("{"), "user_info 应解出 JSON")
        println("真机链路 PASS（access_token=${token!!.length} chars JWT）")
    }

    @Test
    fun `真实 builtin 文件构建账号渠道 overlay`() {
        val builtin = java.nio.file.Path.of(
            "C:\\Users\\Administrator\\.zcode\\v2\\runtime\\provider\\windows-x86_64\\3.18.0" +
                "\\endpoint-78d7c3bef4024722642626fe3669a799\\zcode-builtin.json"
        )
        val overlay = AccountProviderBridge.buildAccountOverlay(builtin)
        println("overlay = ${overlay != null}")
        overlay?.let {
            println("providers: ${it.providers.keys}")
            println("states: ${it.states.keys}")
        }
        assertTrue(overlay != null, "overlay 构建为 null——账号渠道仍 fail-closed")
    }
}
