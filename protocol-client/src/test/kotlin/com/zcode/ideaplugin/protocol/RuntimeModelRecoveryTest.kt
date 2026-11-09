package com.zcode.ideaplugin.protocol

import kotlinx.serialization.json.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path
import kotlin.io.path.writeText
import kotlin.test.assertEquals

/**
 * -32031（restoreWarning）恢复路径回归测试 —— 假 app-server 驱动，确定性、无真实模型调用：
 *
 * 假服务器行为：
 *   - 不带 runtimeModel 的 session/send → 回 -32031「历史任务使用的模型已不可用」
 *   - 带 runtimeModel 的 session/send    → 回 accepted + 回显 runtimeModel 内容
 *   - 其余方法 → 回空 result
 *   - 以 `-p` 参数启动（CLI 模式）→ 输出 {"response":"cli-ok"}
 *
 * 场景1：send 遇 -32031 后应带 runtimeModel 重试并被接受（而不是落 CLI --resume）
 * 场景2：runtimeModel 构造不出（factory 返回 null）时才落 CLI --resume 兜底
 */
class RuntimeModelRecoveryTest {

    @TempDir
    lateinit var tempDir: Path

    private val fakeServerJs = """
        import readline from 'node:readline';
        if (process.argv.includes('--version')) {
            process.stdout.write('0.16.5\n');
            process.exit(0);
        }
        if (process.argv.includes('-p')) {
            process.stdout.write(JSON.stringify({ response: 'cli-ok' }) + '\n');
            process.exit(0);
        }
        const rl = readline.createInterface({ input: process.stdin });
        rl.on('line', line => {
            let m; try { m = JSON.parse(line); } catch { return; }
            if (m.id === undefined || !m.method) return;
            if (m.method === 'session/send') {
                if (m.params?.runtimeModel) {
                    process.stdout.write(JSON.stringify({ id: m.id, result: {
                        accepted: true, usedRuntimeModel: true,
                        modelId: m.params.runtimeModel.model?.modelId,
                        providerId: m.params.runtimeModel.provider?.providerId
                    } }) + '\n');
                } else {
                    process.stdout.write(JSON.stringify({ id: m.id, error: { code: -32031, message: '历史任务使用的模型已不可用' } }) + '\n');
                }
            } else {
                process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\n');
            }
        });
    """.trimIndent()

    private fun startFakeClient(factory: (() -> JsonObject?)? = null): ZCodeProtocolClient {
        val script = tempDir.resolve("fake-app-server.mjs").also { it.writeText(fakeServerJs) }
        val client = ZCodeProtocolClient.start(
            zcodePath = script,
            credentials = ZCodeCredentials("test-model", "http://127.0.0.1:9", "test-key")
        )
        if (factory != null) client.runtimeModelFactory = factory
        return client
    }

    private val fakeRuntimeModel: JsonObject = buildJsonObject {
        put("revision", "0")
        put("model", buildJsonObject {
            put("providerId", "test-provider")
            put("modelId", "GLM-9.9")
        })
    }

    @Test
    fun `send 遇到 -32031 时带 runtimeModel 重试而非 CLI fallback`() {
        startFakeClient(factory = { fakeRuntimeModel }).use { client ->
            val r = client.send("sess_fake", "你好")
            assertEquals("true", r["usedRuntimeModel"]?.jsonPrimitive?.content, "应通过 runtimeModel 重试被接受")
            assertEquals("GLM-9.9", r["modelId"]?.jsonPrimitive?.content, "runtimeModel 应原样送达服务端")
        }
    }

    @Test
    fun `runtimeModel 构造失败时落 CLI --resume 兜底`() {
        startFakeClient(factory = { null }).use { client ->
            val r = client.send("sess_fake", "你好")
            assertEquals("cli-ok", r["cliResponse"]?.jsonPrimitive?.content, "无 runtimeModel 可用时走 CLI fallback")
        }
    }

    @Test
    fun `send 带 providerId 时 -32031 恢复优先用指定 provider 而非默认 factory`() {
        // providerId 指向 config.json 里不存在的 provider → buildRuntimeModel 返回 null → 回退 factory
        // 验证回退逻辑：factory 仍被调用，不会因 buildRuntimeModel 失败而整体失败
        startFakeClient(factory = { fakeRuntimeModel }).use { client ->
            val r = client.send("sess_fake", "你好", providerId = "nonexistent-provider", modelId = "x")
            assertEquals("true", r["usedRuntimeModel"]?.jsonPrimitive?.content, "buildRuntimeModel 失败应回退 factory")
            assertEquals("GLM-9.9", r["modelId"]?.jsonPrimitive?.content, "回退 factory 的 runtimeModel 应被采用")
        }
    }

    @Test
    fun `buildRuntimeModel 携带模型 limit 与 modalities 防止服务端模型属性被覆盖残缺`() {
        // 缺陷回归（2026-08-26）：只传 modelId 会让服务端覆盖完整模型定义 → contextWindow 归零
        // → autocompact 阈值=0 每请求必压缩。完整定义（limit/modalities）必须随 runtimeModel 送达。
        val config = tempDir.resolve("config.json").also { it.writeText("""
            {
              "provider": {
                "p-qwen": {
                  "enabled": true, "kind": "anthropic", "name": "千问", "source": "custom",
                  "options": { "baseURL": "https://qwen.example/anthropic", "apiKey": "sk-qwen" },
                  "models": {
                    "qwen3.7-plus": {
                      "limit": { "context": 200000, "output": 128000 },
                      "modalities": { "input": ["text", "image"], "output": ["text"] }
                    },
                    "plain-model": {}
                  }
                }
              }
            }
        """.trimIndent()) }
        val rt = RuntimeModels.buildRuntimeModel("p-qwen", "qwen3.7-plus", config)
        val models = rt?.get("provider")?.jsonObject?.get("models")?.jsonArray!!
        assertEquals(2, models.size, "provider 全部模型都注册")

        val qwen = models.first { it.jsonObject["modelId"]?.jsonPrimitive?.content == "qwen3.7-plus" }.jsonObject
        assertEquals(200000, qwen["contextWindow"]?.jsonPrimitive?.contentOrNull?.toIntOrNull(),
            "limit.context 必须映射为 contextWindow（否则 autocompact 阈值=0 每请求必压缩）")
        assertEquals(128000, qwen["maxOutputTokens"]?.jsonPrimitive?.contentOrNull?.toIntOrNull(),
            "limit.output 必须映射为 maxOutputTokens")
        assertEquals("true", qwen["supportsImages"]?.jsonPrimitive?.content,
            "modalities.input 含 image 必须映射为 supportsImages=true")

        // 无 limit 的模型保持最小定义（兼容旧配置）
        val plain = models.first { it.jsonObject["modelId"]?.jsonPrimitive?.content == "plain-model" }.jsonObject
        assertEquals(null, plain["contextWindow"], "无 limit 的模型不携带 contextWindow")
        assertEquals(null, plain["supportsImages"], "无 modalities 的模型不携带 supportsImages")
    }

    @Test
    fun `buildRuntimeModel 按 providerId 从 config 构造指定 provider 的完整定义`() {
        // hermetic：注入临时 config（两个 enabled provider，验证 buildRuntimeModel 取的是指定 provider 而非第一个）
        val config = tempDir.resolve("config.json").also { it.writeText("""
            {
              "provider": {
                "p-default": {
                  "enabled": true, "kind": "anthropic", "name": "默认套餐", "source": "builtin",
                  "options": { "baseURL": "https://default.api/v1", "apiKey": "sk-default" },
                  "models": { "GLM-DEFAULT": {} }
                },
                "p-baidu": {
                  "enabled": true, "kind": "anthropic", "name": "百度千帆", "source": "custom",
                  "options": { "baseURL": "https://qianfan.baidubce.com/anthropic", "apiKey": "bce-v3-key" },
                  "models": { "glm-5.2": {} }
                }
              }
            }
        """.trimIndent()) }
        // 按 providerId 构造：指定百度千帆（排第二），验证不是默认套餐（排第一）
        val rt = RuntimeModels.buildRuntimeModel("p-baidu", "glm-5.2", config)
        assertEquals("glm-5.2", rt?.get("model")?.jsonObject?.get("modelId")?.jsonPrimitive?.content, "应取指定 provider 的模型")
        assertEquals("p-baidu", rt?.get("model")?.jsonObject?.get("providerId")?.jsonPrimitive?.content, "应取指定 provider 而非第一个")
        val provider = rt?.get("provider")?.jsonObject!!
        assertEquals("百度千帆", provider["label"]?.jsonPrimitive?.content)
        assertEquals("https://qianfan.baidubce.com/anthropic", provider["baseURL"]?.jsonPrimitive?.content)
        assertEquals("bce-v3-key", provider["apiKey"]?.jsonObject?.get("value")?.jsonPrimitive?.content)
        assertEquals("custom", provider["source"]?.jsonPrimitive?.content)

        // providerId 不存在 → null（调用方走 factory 回退）
        assertEquals(null, RuntimeModels.buildRuntimeModel("no-such-provider", "x", config))
    }

    @Test
    fun `defaultRuntimeModel 从 config 构造完整 provider 定义`() {
        // hermetic：注入临时 config（enabled anthropic provider + 两个模型）
        val config = tempDir.resolve("config.json").also { it.writeText("""
            {
              "provider": {
                "disabled-one": { "enabled": false, "kind": "anthropic", "options": {}, "models": {"X": {}} },
                "p1": {
                  "enabled": true, "kind": "anthropic", "name": "测试Provider", "source": "builtin",
                  "options": { "baseURL": "https://api.test/v1", "apiKey": "sk-test" },
                  "models": { "GLM-9.9": {}, "GLM-8.8": {} }
                }
              }
            }
        """.trimIndent()) }
        val rt = RuntimeModels.defaultRuntimeModel(config)
        assertEquals("GLM-9.9", rt?.get("model")?.jsonObject?.get("modelId")?.jsonPrimitive?.content, "取第一个 enabled provider 的第一个模型")
        assertEquals("p1", rt?.get("model")?.jsonObject?.get("providerId")?.jsonPrimitive?.content)
        val provider = rt?.get("provider")?.jsonObject!!
        assertEquals("https://api.test/v1", provider["baseURL"]?.jsonPrimitive?.content)
        assertEquals("inline", provider["apiKey"]?.jsonObject?.get("source")?.jsonPrimitive?.content)
        assertEquals(2, provider["models"]?.jsonArray?.size, "provider 全部模型都注册")
        assertEquals("0", rt["revision"]?.jsonPrimitive?.content)

        // 空 provider 表 → null（调用方走 CLI 兜底）
        val emptyConfig = tempDir.resolve("empty.json").also { it.writeText("""{"provider": {}}""") }
        assertEquals(null, RuntimeModels.defaultRuntimeModel(emptyConfig))
    }
}
