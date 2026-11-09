package com.zcode.ideaplugin.protocol

import kotlinx.serialization.json.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.nio.file.Path
import kotlin.io.path.writeText
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * 钩子信任 RPC 回归测试 —— 假 app-server 回显请求字段，无真实模型调用：
 *   - workspaceHooksTrustGrant：workspace 双键归一原生分隔符（与 createSession 同款，
 *     服务端按 workspaceKey 匹配会话触发会话级重载，形态不一致则退化为新会话才生效）
 *   - reloadWorkspaceHookTrust：v4/command 信封（type/commandId/clientId/issuedAt）与空 payload
 *   - accepted=false 走 result 透传而非 JSON-RPC error，由调用方按 reasonCode 分支
 */
class WorkspaceHookTrustGrantTest {

    @TempDir
    lateinit var tempDir: Path

    private val fakeServerJs = """
        import readline from 'node:readline';
        if (process.argv.includes('--version')) {
            process.stdout.write('0.16.5\n');
            process.exit(0);
        }
        const rl = readline.createInterface({ input: process.stdin });
        rl.on('line', line => {
            let m; try { m = JSON.parse(line); } catch { return; }
            if (m.id === undefined || !m.method) return;
            if (m.method === 'workspace/hooks/trustGrant') {
                const p = m.params || {};
                const w = p.workspace || {};
                process.stdout.write(JSON.stringify({ id: m.id, result: {
                    accepted: true,
                    echoWorkspacePath: w.workspacePath,
                    echoWorkspaceKey: w.workspaceKey,
                    echoBundle: p.bundleDigest,
                    echoHookDigest: p.hookDeclarationDigest
                } }) + '\n');
            } else if (m.method === 'v4/command') {
                const p = m.params || {};
                const pl = p.payload || {};
                process.stdout.write(JSON.stringify({ id: m.id, result: {
                    status: 'accepted',
                    echoType: p.type,
                    echoSessionId: p.sessionId,
                    payloadEmpty: Object.keys(pl).length === 0,
                    hasCommandId: typeof p.commandId === 'string' && p.commandId.length > 0,
                    clientId: p.clientId,
                    hasIssuedAt: typeof p.issuedAt === 'number'
                } }) + '\n');
            } else {
                process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\n');
            }
        });
    """.trimIndent()

    private fun startFakeClient(): ZCodeProtocolClient {
        val script = tempDir.resolve("fake-hook-trust.mjs").also { it.writeText(fakeServerJs) }
        return ZCodeProtocolClient.start(
            zcodePath = script,
            credentials = ZCodeCredentials("test-model", "http://127.0.0.1:9", "test-key")
        )
    }

    @Test
    fun `trustGrant 参数双键归一原生分隔符`() {
        startFakeClient().use { client ->
            val r = client.workspaceHooksTrustGrant(
                workspacePath = "G:/ws/project",
                bundleDigest = "b1".padEnd(64, '0'),
                hookDeclarationDigest = "h1".padEnd(64, '0'),
            )
            assertEquals("true", r["accepted"]?.jsonPrimitive?.content)
            val sep = File.separatorChar.toString()
            // 双键 = identity 缺省规则（key = path 原样），且与 createSession 同款归一
            assertEquals("G:${sep}ws${sep}project", r["echoWorkspacePath"]?.jsonPrimitive?.content)
            assertEquals("G:${sep}ws${sep}project", r["echoWorkspaceKey"]?.jsonPrimitive?.content)
            assertEquals("b1".padEnd(64, '0'), r["echoBundle"]?.jsonPrimitive?.content)
            assertEquals("h1".padEnd(64, '0'), r["echoHookDigest"]?.jsonPrimitive?.content)
        }
    }

    @Test
    fun `reload 命令信封字段正确`() {
        startFakeClient().use { client ->
            val r = client.reloadWorkspaceHookTrust("sess_fake")
            assertEquals("accepted", r["status"]?.jsonPrimitive?.content)
            assertEquals("reloadWorkspaceHookTrust", r["echoType"]?.jsonPrimitive?.content)
            assertEquals("sess_fake", r["echoSessionId"]?.jsonPrimitive?.content)
            assertEquals("true", r["payloadEmpty"]?.jsonPrimitive?.content)
            assertEquals("zcode-idea-plugin", r["clientId"]?.jsonPrimitive?.content)
            assertEquals("true", r["hasCommandId"]?.jsonPrimitive?.content)
            assertEquals("true", r["hasIssuedAt"]?.jsonPrimitive?.content)
        }
    }

    @Test
    fun `accepted 为 false 时结果透传不抛`() {
        // 服务端拒绝（bundle_changed 等）走 result={accepted:false,reasonCode}，
        // JSON-RPC 层无 error——requireOk 不拦，调用方按 reasonCode 提示后回退
        val script = tempDir.resolve("fake-hook-trust-reject.mjs").also {
            it.writeText("""
                import readline from 'node:readline';
                if (process.argv.includes('--version')) {
                    process.stdout.write('0.16.5\n');
                    process.exit(0);
                }
                const rl = readline.createInterface({ input: process.stdin });
                rl.on('line', line => {
                    let m; try { m = JSON.parse(line); } catch { return; }
                    if (m.id === undefined || !m.method) return;
                    process.stdout.write(JSON.stringify({ id: m.id, result: {
                        accepted: false, reasonCode: 'workspace_hooks_bundle_changed'
                    } }) + '\n');
                });
            """.trimIndent())
        }
        ZCodeProtocolClient.start(
            zcodePath = script,
            credentials = ZCodeCredentials("test-model", "http://127.0.0.1:9", "test-key")
        ).use { client ->
            val r = client.workspaceHooksTrustGrant("G:/ws", "b".padEnd(64, '0'), "h".padEnd(64, '0'))
            assertEquals("false", r["accepted"]?.jsonPrimitive?.content)
            assertEquals("workspace_hooks_bundle_changed", r["reasonCode"]?.jsonPrimitive?.content)
            assertTrue(true)
        }
    }
}
