package com.zcode.ideaplugin.cua

import com.intellij.openapi.diagnostic.Logger
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.awt.RenderingHints
import java.awt.image.BufferedImage
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Base64
import javax.imageio.IIOImage
import javax.imageio.ImageIO
import javax.imageio.ImageWriteParam
import javax.imageio.stream.ImageOutputStream

/**
 * 普通 MCP 工具结果的图片恢复：把服务端压平的 "[Attached image/...]" 占位还原成
 * 可渲染的 display.media（与 CUA 原生侧信道同形）。
 *
 * 背景（2026-10-16）：core 服务端把 MCP 工具结果的 image 内容块压成占位文本，
 * 插件实时/历史两侧都拿不到图片字节；但浏览器截图（node_repl emitImage）等工具的
 * 输出文本自带落盘路径（~/.zcode/cli/artifacts、~/.zcode/cli/image-cache）。
 * 下游链路（webview reducer 并入 state.media → ToolCallCard 头部缩略图 → 点击
 * ImagePreview 放大 → CuaMediaStore 落盘 + 历史回填）对任意工具通用且不筛工具名，
 * 所以只需在此读文件合成 media 注入，webview 零改动。
 *
 * 两个入口：
 *   - enrich：pushStreamEvent 实时帧（tool.updated kind=result）——原生 display.media
 *     （CUA）照旧 persist 后原样返回；否则按输出文本路径现场读图合成注入并 persist。
 *   - enrichMessages：resumeAndReadMessages 历史装配——对无 media 的 tool part 按
 *     state.output 路径现场读图注入（兜底未走 persist 的老会话）。
 *
 * 安全/尺寸约束：路径必须在白名单根下（canonicalPath 前缀校验防 ..\ 穿越）；
 * 二进制 ≤290KB 直接 base64 透传（≈386k 字符 < CuaMediaStore 回填上限 400k），
 * 超限降采样（最长边 1280 / JPEG 0.82，同 imageAttachment.ts 参数）；GIF 保动画、
 * WebP 无法重编码，二者超限即跳过；任何异常 fail-soft 返回原样，不阻塞帧。
 */
object ToolResultMediaEnricher {

    private val log = Logger.getInstance(ToolResultMediaEnricher::class.java)

    private const val MAX_INLINE_BYTES = 290 * 1024
    private const val MAX_READ_BYTES = 8L * 1024 * 1024
    private const val MAX_DIMENSION = 1280
    private const val JPEG_QUALITY = 0.82f
    private const val MAX_MEDIA_ITEMS = 3

    /** base64 长度硬上限，对齐 CuaMediaStore.load 的回填上限 */
    private const val MAX_ITEM_BASE64_CHARS = 400_000

    private val PATH_REGEX = Regex(
        "(?:[A-Za-z]:[\\\\/]|~/|/)[^\\s\"'<>|*?\u0000-\u001f]{0,400}?\\.(?:png|jpe?g|webp|gif|bmp)",
        RegexOption.IGNORE_CASE,
    )

    /** 整行都是占位文本的形态：[Attached image/jpeg: MCP image] */
    private val ATTACHED_PLACEHOLDER_LINE = Regex("(?m)^\\s*\\[Attached image/[^\\]\\r\\n]*]\\s*\\r?\\n?")

    private val MIME_BY_EXT = mapOf(
        "png" to "image/png",
        "jpg" to "image/jpeg",
        "jpeg" to "image/jpeg",
        "webp" to "image/webp",
        "gif" to "image/gif",
        "bmp" to "image/bmp",
    )

    /** 允许读图的白名单根：MCP 宿主（browser-use 等）落 artifact、CLI 图片缓存的固定区 */
    fun artifactRoots(): List<File> = listOf(
        File(File(System.getProperty("user.home"), ".zcode"), "cli/artifacts"),
        File(File(System.getProperty("user.home"), ".zcode"), "cli/image-cache"),
    )

    /** 实时帧入口：非 result 帧原样返回；见类注释两条路径。 */
    fun enrich(sessionId: String, payload: JsonObject): JsonObject =
        enrichWithRoots(sessionId, payload, artifactRoots())

    internal fun enrichWithRoots(sessionId: String, payload: JsonObject, roots: List<File>): JsonObject {
        return try {
            if (payload["kind"]?.jsonPrimitive?.contentOrNull != "result") return payload
            val callId = payload["toolCallId"]?.jsonPrimitive?.contentOrNull ?: return payload
            val result = payload["result"] as? JsonObject ?: return payload

            val nativeMedia = result["display"]?.jsonObject?.get("media") as? JsonArray
            if (nativeMedia != null && nativeMedia.isNotEmpty()) {
                // CUA 原生链路：persist 是会话重载回填的唯一数据源（原 pushStreamEvent 职责）
                CuaMediaStore.persist(sessionId, callId, nativeMedia)
                return payload
            }

            val content = result["content"]?.jsonPrimitive?.contentOrNull ?: return payload
            val media = loadMediaArray(content, roots)
            if (media.isEmpty()) return payload

            val cleaned = stripAttachedImagePlaceholders(content)
            val newResult = buildJsonObject {
                result.forEach { (k, v) ->
                    when (k) {
                        "content" -> put("content", cleaned)
                        "display" -> {}
                        else -> put(k, v)
                    }
                }
                put("display", buildJsonObject {
                    result["display"]?.jsonObject?.forEach { (k, v) -> if (k != "media") put(k, v) }
                    put("media", media)
                })
            }
            CuaMediaStore.persist(sessionId, callId, media)
            buildJsonObject {
                payload.forEach { (k, v) -> if (k == "result") put("result", newResult) else put(k, v) }
            }
        } catch (e: Exception) {
            log.warn("ToolResultMediaEnricher enrich failed: ${e.message}")
            payload
        }
    }

    /** 历史装配入口：给输出文本带图片路径且无 media 的 tool part 现场注入。 */
    fun enrichMessages(sessionId: String, messages: JsonArray): JsonArray =
        enrichMessagesWithRoots(sessionId, messages, artifactRoots())

    internal fun enrichMessagesWithRoots(sessionId: String, messages: JsonArray, roots: List<File>): JsonArray {
        return try {
            var changed = false
            val out = JsonArray(messages.map { msgEl ->
                val msg = msgEl as? JsonObject ?: return@map msgEl
                val parts = msg["parts"] as? JsonArray ?: return@map msgEl
                var msgChanged = false
                val newParts = JsonArray(parts.map { partEl ->
                    val part = partEl as? JsonObject ?: return@map partEl
                    if (part["type"]?.jsonPrimitive?.contentOrNull != "tool") return@map partEl
                    val state = part["state"] as? JsonObject ?: return@map partEl
                    if (state.containsKey("media")) return@map partEl
                    val output = state["output"]?.jsonPrimitive?.contentOrNull ?: return@map partEl
                    val media = loadMediaArray(output, roots)
                    if (media.isEmpty()) return@map partEl
                    msgChanged = true
                    changed = true
                    buildJsonObject {
                        part.forEach { (k, v) -> put(k, v) }
                        put("state", buildJsonObject {
                            state.forEach { (k, v) -> put(k, v) }
                            put("media", media)
                            val cleaned = stripAttachedImagePlaceholders(output)
                            if (cleaned != output) put("output", cleaned)
                        })
                    }
                })
                if (!msgChanged) return@map msgEl
                buildJsonObject {
                    msg.forEach { (k, v) -> if (k == "parts") put("parts", newParts) else put(k, v) }
                }
            })
            if (changed) out else messages
        } catch (e: Exception) {
            log.warn("ToolResultMediaEnricher enrichMessages failed: ${e.message}")
            messages
        }
    }

    private fun loadMediaArray(text: String, roots: List<File>): JsonArray = buildJsonArray {
        val rootsReady = roots.filter { it.isDirectory }
        if (rootsReady.isEmpty()) return@buildJsonArray
        var taken = 0
        for (m in PATH_REGEX.findAll(text)) {
            if (taken >= MAX_MEDIA_ITEMS) break
            val item = loadMediaItem(m.value, rootsReady) ?: continue
            add(item)
            taken++
        }
    }

    private fun loadMediaItem(rawPath: String, roots: List<File>): JsonObject? {
        val file = resolvePath(rawPath) ?: return null
        if (!file.isFile || file.length() !in 1..MAX_READ_BYTES) return null
        if (!isUnderRoots(file, roots)) return null
        val mime = MIME_BY_EXT[file.extension.lowercase()] ?: return null
        val bytes = try {
            file.readBytes()
        } catch (e: Exception) {
            log.warn("ToolResultMediaEnricher read failed: ${file.path}: ${e.message}")
            return null
        }
        val keepOriginal = bytes.size <= MAX_INLINE_BYTES || mime == "image/gif" || mime == "image/webp"
        val (outBytes, outMime) = if (keepOriginal) {
            // GIF 保动画不重编码；WebP 无 ImageIO 写入器——超限只能放弃
            if (bytes.size > MAX_INLINE_BYTES) return null
            bytes to mime
        } else {
            val downscaled = downscaleToJpeg(bytes) ?: return null
            downscaled to "image/jpeg"
        }
        val b64 = Base64.getEncoder().encodeToString(outBytes)
        if (b64.length > MAX_ITEM_BASE64_CHARS) return null
        return buildJsonObject {
            put("mimeType", outMime)
            put("data", b64)
        }
    }

    private fun resolvePath(raw: String): File? {
        val expanded = if (raw.startsWith("~")) {
            File(System.getProperty("user.home"), raw.drop(1)).path
        } else {
            raw
        }
        return try {
            File(expanded)
        } catch (e: Exception) {
            null
        }
    }

    private fun isUnderRoots(file: File, roots: List<File>): Boolean {
        val canonical = try {
            file.canonicalFile
        } catch (e: Exception) {
            return false
        }
        return roots.any { root ->
            val rc = try {
                root.canonicalFile
            } catch (e: Exception) {
                return@any false
            }
            canonical.path.startsWith(rc.path + File.separator)
        }
    }

    private fun downscaleToJpeg(bytes: ByteArray): ByteArray? {
        return try {
            val src = ImageIO.read(ByteArrayInputStream(bytes)) ?: return null
            val scale = minOf(1f, MAX_DIMENSION.toFloat() / maxOf(src.width, src.height).coerceAtLeast(1))
            val w = maxOf(1, (src.width * scale).toInt())
            val h = maxOf(1, (src.height * scale).toInt())
            val dst = BufferedImage(w, h, BufferedImage.TYPE_INT_RGB)
            val g = dst.createGraphics()
            g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR)
            g.drawImage(src, 0, 0, w, h, java.awt.Color.WHITE, null)
            g.dispose()
            val out = ByteArrayOutputStream()
            val writer = ImageIO.getImageWritersByFormatName("jpg").next()
            val param = writer.defaultWriteParam
            param.compressionMode = ImageWriteParam.MODE_EXPLICIT
            param.compressionQuality = JPEG_QUALITY
            val ios: ImageOutputStream = ImageIO.createImageOutputStream(out)
            writer.output = ios
            writer.write(null as javax.imageio.metadata.IIOMetadata?, IIOImage(dst, null, null), param)
            writer.dispose()
            ios.close()
            out.toByteArray()
        } catch (e: Exception) {
            log.warn("ToolResultMediaEnricher downscale failed: ${e.message}")
            null
        }
    }

    private fun stripAttachedImagePlaceholders(text: String): String {
        val cleaned = ATTACHED_PLACEHOLDER_LINE.replace(text, "")
        return if (cleaned != text) cleaned.trimStart('\r', '\n') else text
    }
}
