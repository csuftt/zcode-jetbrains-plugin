package com.zcode.ideaplugin.cua

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.awt.Color
import java.awt.image.BufferedImage
import java.io.File
import javax.imageio.ImageIO

/**
 * ToolResultMediaEnricher：普通 MCP 工具结果图片恢复（输出文本落盘路径 → display.media）。
 * 图片 fixture 用 ImageIO 现生成；白名单根用 @TempDir；CuaMediaStore 落盘侧效应
 * 写真实存储根（sessionId 测试专用前缀，@AfterEach 清理）。
 */
class ToolResultMediaEnricherTest {

    @TempDir
    lateinit var tempDir: File

    private val sid = "sess_toolmedia_test_${System.currentTimeMillis()}"

    @AfterEach
    fun cleanupStore() {
        File(CuaMediaStore.root(), sid).deleteRecursively()
    }

    private fun writePng(file: File, w: Int, h: Int): File {
        val img = BufferedImage(w, h, BufferedImage.TYPE_INT_RGB)
        val g = img.createGraphics()
        g.color = Color.WHITE
        g.fillRect(0, 0, w, h)
        g.dispose()
        ImageIO.write(img, "png", file)
        return file
    }

    /**
     * BMP 无压缩，文件体积恒为 w*h*3+头——确定性超直传上限；平滑渐变内容
     * JPEG 压缩后远小于回填上限（噪点类 fixture 降采样后仍会超限，不可用）。
     */
    private fun writeGradientBmp(file: File, w: Int, h: Int): File {
        val img = BufferedImage(w, h, BufferedImage.TYPE_INT_RGB)
        for (y in 0 until h) for (x in 0 until w) {
            img.setRGB(x, y, ((x * 255 / w) shl 16) or ((y * 255 / h) shl 8) or ((x + y) * 255 / (w + h)))
        }
        ImageIO.write(img, "bmp", file)
        return file
    }

    private fun writeGif(file: File): File {
        val img = BufferedImage(10, 10, BufferedImage.TYPE_INT_RGB)
        val g = img.createGraphics()
        g.color = Color.RED
        g.fillRect(0, 0, 10, 10)
        g.dispose()
        ImageIO.write(img, "gif", file)
        return file
    }

    private fun resultPayload(callId: String, content: String): JsonObject = buildJsonObject {
        put("kind", "result")
        put("toolCallId", callId)
        put("toolName", "mcp__node_repl__js")
        put("result", buildJsonObject {
            put("success", true)
            put("content", content)
        })
    }

    @Test
    fun `synthesizes media from whitelisted artifact path and strips placeholder`() {
        val png = writePng(File(tempDir, "call_1-tool-result.png"), 60, 40)
        val payload = resultPayload(
            "call_t1",
            "[Attached image/jpeg: MCP image]\n\nBrowser screenshot saved to: ${png.absolutePath}",
        )
        val out = ToolResultMediaEnricher.enrichWithRoots(sid, payload, listOf(tempDir))

        val result = out["result"]!!.jsonObject
        val media = result["display"]!!.jsonObject["media"]!!.jsonArray
        assertEquals(1, media.size)
        assertEquals("image/png", media[0].jsonObject["mimeType"]!!.jsonPrimitive.content)
        val content = result["content"]!!.jsonPrimitive.content
        assertFalse(content.contains("[Attached image/"), "占位行应被清理")
        assertTrue(content.contains("Browser screenshot saved to:"), "其余文本应保留")
        // persist 侧效应：会话重载回填的数据源
        assertTrue(File(File(CuaMediaStore.root(), sid), "call_t1.json").isFile)
    }

    @Test
    fun `rejects path outside whitelist roots`() {
        val outside = writePng(File(tempDir.parentFile, "outside_${System.nanoTime()}.png"), 20, 20)
        val payload = resultPayload("call_t2", "saved to: ${outside.absolutePath}")
        val out = ToolResultMediaEnricher.enrichWithRoots(sid, payload, listOf(tempDir))
        assertSame(payload, out, "白名单外路径不应注入")
    }

    @Test
    fun `missing file leaves payload unchanged`() {
        val payload = resultPayload(
            "call_t3",
            "saved to: ${File(tempDir, "nonexistent_${System.nanoTime()}.png").absolutePath}",
        )
        val out = ToolResultMediaEnricher.enrichWithRoots(sid, payload, listOf(tempDir))
        assertSame(payload, out)
    }

    @Test
    fun `native display media passes through and persists`() {
        val payload = buildJsonObject {
            put("kind", "result")
            put("toolCallId", "call_native")
            put("result", buildJsonObject {
                put("content", "ok")
                put("display", buildJsonObject {
                    put("media", buildJsonArray {
                        add(buildJsonObject { put("mimeType", "image/jpeg"); put("data", "/9j/4AAQSkZJRg") })
                    })
                })
            })
        }
        val out = ToolResultMediaEnricher.enrichWithRoots(sid, payload, listOf(tempDir))
        assertSame(payload, out, "CUA 原生 media 不改写")
        assertTrue(File(File(CuaMediaStore.root(), sid), "call_native.json").isFile, "原生 media 仍要落盘")
    }

    @Test
    fun `non result kind returns unchanged`() {
        val payload = buildJsonObject {
            put("kind", "started")
            put("toolCallId", "call_t4")
        }
        val out = ToolResultMediaEnricher.enrichWithRoots(sid, payload, listOf(tempDir))
        assertSame(payload, out)
    }

    @Test
    fun `oversized image downscales to jpeg`() {
        val big = writeGradientBmp(File(tempDir, "big.bmp"), 1200, 900)
        assertTrue(big.length() > 290 * 1024, "fixture 应超直传上限，实际 ${big.length()}")
        val payload = resultPayload("call_t5", "saved to: ${big.absolutePath}")
        val out = ToolResultMediaEnricher.enrichWithRoots(sid, payload, listOf(tempDir))
        val media = out["result"]!!.jsonObject["display"]!!.jsonObject["media"]!!.jsonArray
        assertEquals(1, media.size)
        assertEquals("image/jpeg", media[0].jsonObject["mimeType"]!!.jsonPrimitive.content)
        assertTrue(
            media[0].jsonObject["data"]!!.jsonPrimitive.content.length <= 400_000,
            "降采样后仍须满足回填上限",
        )
    }

    @Test
    fun `small gif passes through as gif`() {
        val gif = writeGif(File(tempDir, "anim.gif"))
        val payload = resultPayload("call_t6", "saved: ${gif.absolutePath}")
        val out = ToolResultMediaEnricher.enrichWithRoots(sid, payload, listOf(tempDir))
        val media = out["result"]!!.jsonObject["display"]!!.jsonObject["media"]!!.jsonArray
        assertEquals("image/gif", media[0].jsonObject["mimeType"]!!.jsonPrimitive.content)
    }

    @Test
    fun `enrichMessages injects media and strips output placeholder`() {
        val png = writePng(File(tempDir, "call_m-tool-result.png"), 60, 40)
        val messages = JsonArray(listOf(buildJsonObject {
            put("parts", buildJsonArray {
                add(buildJsonObject {
                    put("type", "text"); put("text", "hi")
                })
                add(buildJsonObject {
                    put("type", "tool"); put("callID", "call_m1"); put("tool", "mcp__node_repl__js")
                    put("state", buildJsonObject {
                        put("status", "completed")
                        put("output", "[Attached image/png: MCP image] shot ${png.absolutePath}")
                    })
                })
            })
        }))
        val out = ToolResultMediaEnricher.enrichMessagesWithRoots(sid, messages, listOf(tempDir))

        val state = out[0].jsonObject["parts"]!!.jsonArray[1].jsonObject["state"]!!.jsonObject
        assertEquals("image/png", state["media"]!!.jsonArray[0].jsonObject["mimeType"]!!.jsonPrimitive.content)
        assertFalse(state["output"]!!.jsonPrimitive.content.contains("[Attached image/"))
    }

    @Test
    fun `enrichMessages skips part with existing media`() {
        val messages = JsonArray(listOf(buildJsonObject {
            put("parts", buildJsonArray {
                add(buildJsonObject {
                    put("type", "tool"); put("callID", "call_m2"); put("tool", "mcp__zcgui-computer-use__get_app_state")
                    put("state", buildJsonObject {
                        put("status", "completed")
                        put("output", "whatever ${File(tempDir, "x.png").absolutePath}")
                        put("media", buildJsonArray {
                            add(buildJsonObject { put("mimeType", "image/jpeg"); put("data", "aa") })
                        })
                    })
                })
            })
        }))
        val out = ToolResultMediaEnricher.enrichMessagesWithRoots(sid, messages, listOf(tempDir))
        assertSame(messages, out, "已有 media 的 part 不动")
    }
}
