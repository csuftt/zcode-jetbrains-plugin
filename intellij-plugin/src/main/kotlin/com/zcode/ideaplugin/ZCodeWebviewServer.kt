package com.zcode.ideaplugin

import com.intellij.openapi.diagnostic.Logger
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import com.zcode.ideaplugin.protocol.ImageArtifactMapper
import com.zcode.ideaplugin.viz.VisualizeFileRegistry
import java.io.File
import java.net.InetSocketAddress
import java.net.URLDecoder
import java.util.concurrent.Executors

/**
 * 内置 webview 静态资源 server（方案 C）
 *
 * 用 JDK 自带 HttpServer（零第三方依赖）把插件 classpath 的 webview 目录下多文件构建
 * 产物（index.html + assets 里的 js、css 与 sourcemap）serve 到 127.0.0.1 随机端口，
 * JCEF 侧 loadURL 此地址——生产模式也拥有真实 origin + sourcemap，DevTools 可直接
 * 看 TS/TSX 源码断点，外部浏览器亦可打开同地址配合 mock 桥调试。
 *
 * - 仅绑定 127.0.0.1（不暴露网络）；首次生产加载时懒启动，进程级单例
 * - daemon 线程池，随 IDE 进程退出回收，无需显式 stop
 * - 路径穿越防护：拒绝含 ".." 的路径；classpath 无 /webview 多文件产物时返回 -1，
 *   调用方（ZCodeToolWindowPanel.loadWebview）降级 singlefile loadHTML 加载
 *
 * 缓存策略统一 no-store：本地回环无性能负担，避免插件升级后 CEF 磁盘缓存里的
 * 旧 index.html 引用已不存在的 hash 资源导致白屏。
 */
object ZCodeWebviewServer {

    private val log = Logger.getInstance("ZCodePlugin")

    @Volatile
    private var server: HttpServer? = null

    @Volatile
    private var port: Int = -1

    /** base URL（如 http://127.0.0.1:53712）；启动失败或无多文件产物返回 null */
    fun baseUrl(): String? {
        val p = ensureStarted()
        return if (p > 0) "http://127.0.0.1:$p" else null
    }

    /** 懒启动（幂等）：返回监听端口，失败返回 -1 */
    @Synchronized
    fun ensureStarted(): Int {
        if (port > 0) return port
        if (javaClass.getResource("/webview/index.html") == null) {
            log.info("No /webview multi-file artifact on classpath, skipping built-in server (degrade to singlefile)")
            return -1
        }
        return try {
            val s = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
            s.createContext("/") { exchange -> serve(exchange) }
            s.executor = Executors.newCachedThreadPool { r ->
                Thread(r, "zcode-webview-http").apply { isDaemon = true }
            }
            s.start()
            server = s
            port = s.address.port
            log.info("Built-in webview server started: http://127.0.0.1:$port")
            port
        } catch (e: Exception) {
            log.warn("Built-in webview server start failed (degrade to singlefile): ${e.message}")
            -1
        }
    }

    private fun serve(exchange: HttpExchange) {
        try {
            val decoded = URLDecoder.decode(exchange.requestURI.path ?: "/", Charsets.UTF_8)
            if (decoded.contains("..")) {
                respond(exchange, 403, "forbidden".toByteArray(), "text/plain; charset=utf-8")
                return
            }
            // 用户消息图片（image-cache 落盘文件，zcode-artifact:// 的可渲染出口，
            // 见 ImageArtifactMapper）：/zcode-image/<sessionId>/image-<hash>.<ext>
            if (decoded.startsWith("/zcode-image/")) {
                serveImageCache(exchange, decoded.removePrefix("/zcode-image/"))
                return
            }
            // ::visualize 内联可视化（token 间接引用，白名单校验在 VisualizeFileRegistry）：
            // /viz/<token>?theme=dark|light
            if (decoded.startsWith("/viz/")) {
                serveViz(exchange, decoded.removePrefix("/viz/"))
                return
            }
            val rel = decoded.removePrefix("/").ifEmpty { "index.html" }
            val bytes = javaClass.getResourceAsStream("/webview/$rel")?.use { it.readBytes() }
            if (bytes == null) {
                respond(exchange, 404, "not found: $rel".toByteArray(), "text/plain; charset=utf-8")
            } else {
                respond(exchange, 200, bytes, mimeOf(rel))
            }
        } catch (e: Exception) {
            log.warn("webview server request handling failed: ${e.message}")
        } finally {
            exchange.close()
        }
    }

    /** image-cache 根目录（zcode.cjs 的 cliStorageRoot 下，见 vOt/imageCacheRootDir）*/
    internal val imageCacheRoot: File
        get() = File(File(System.getProperty("user.home"), ".zcode"), "cli/image-cache")

    /**
     * v4 编辑 inline 新图的临时目录（handleEditUserQuery 写、serveImageCache 兜底读）。
     * zcode.cjs 不为编辑 ref 重发的图写 image-cache，读回换算靠 part.filename 命中
     * 这里的同名文件（内容 hash 确定性命名，见 writeEditTempAttachment）。
     */
    internal val editAttachmentsRoot: File
        get() = File(System.getProperty("java.io.tmpdir"), "zcode-gui-edit-att")

    /** sessionId 目录名白名单（zcode.cjs sj 净化规则：非 [A-Za-z0-9._-] 替换 _、截 120）*/
    internal val sidPattern = Regex("""^[A-Za-z0-9._-]{1,120}$""")

    /** 落盘文件名白名单（image-<sha256(uri) 前 32 hex>.<ext>）——唯一定义在 ImageArtifactMapper.EDIT_REF_NAME_PATTERN */
    internal val imageFilePattern = ImageArtifactMapper.EDIT_REF_NAME_PATTERN

    /**
     * 用户消息图片的可渲染 URL（ImageArtifactMapper 调用）：把 image-cache 落盘文件
     * 映射为内置 server 的 /zcode-image/ 端点。server 起不来返回 null（调用方保持
     * 原样 fail-soft）。<img> 标签不受 CORS 限制，singlefile/data: origin 也能加载。
     */
    fun imageUrl(sessionId: String, fileName: String): String? {
        if (!sidPattern.matches(sessionId) || !imageFilePattern.matches(fileName)) return null
        val base = baseUrl() ?: return null
        return "$base/zcode-image/$sessionId/$fileName"
    }

    private fun serveImageCache(exchange: HttpExchange, rel: String) {
        val segs = rel.trim('/').split('/')
        if (segs.size != 2 || !sidPattern.matches(segs[0]) || !imageFilePattern.matches(segs[1])) {
            respond(exchange, 404, "not found".toByteArray(), "text/plain; charset=utf-8")
            return
        }
        // 先查 zcode.cjs 的 image-cache，未命中回退编辑 inline 图临时目录（同一套
        // 受控命名——读回换算兜底链的取数端，见 editAttachmentsRoot 注释）
        var f = File(File(imageCacheRoot, segs[0]), segs[1])
        if (!f.isFile) f = File(editAttachmentsRoot, segs[1])
        if (!f.isFile) {
            respond(exchange, 404, "not found".toByteArray(), "text/plain; charset=utf-8")
            return
        }
        respond(exchange, 200, f.readBytes(), mimeOf(f.name))
    }

    /**
     * ::visualize 可视化的可渲染 URL（handleVizOpen 调用）：token 由 VisualizeFileRegistry
     * 登记发放，URL 不含磁盘路径。server 起不来返回 null（调用方降级 srcdoc 直出）。
     */
    fun vizUrl(token: String, theme: String): String? {
        if (!VisualizeFileRegistry.tokenPattern.matches(token)) return null
        val base = baseUrl() ?: return null
        return "$base/viz/$token?theme=${if (theme == "light") "light" else "dark"}"
    }

    private fun serveViz(exchange: HttpExchange, tokenSeg: String) {
        val token = tokenSeg.trim('/').substringBefore('?')
        val query = exchange.requestURI.rawQuery ?: ""
        val theme = if (query.contains("theme=light")) "light" else "dark"
        val file = VisualizeFileRegistry.resolve(token)
        if (file == null) {
            // token 非法/文件已被轮转删除：iframe 内展示主题化错误页（沙箱内可正常渲染）
            respond(exchange, 404, vizErrorPage(theme, "可视化文件不存在或已被清理").toByteArray(), "text/html; charset=utf-8")
            return
        }
        // raw=1：复制源码按钮取原始文件（不带注入的宿主基线）
        if (query.contains("raw=1")) {
            respond(exchange, 200, file.readBytes(), "text/html; charset=utf-8")
            return
        }
        val html = try {
            VisualizeFileRegistry.decorate(file.readText(), theme)
        } catch (e: Exception) {
            log.warn("viz read failed: ${e.message}")
            respond(exchange, 500, vizErrorPage(theme, "读取可视化文件失败").toByteArray(), "text/html; charset=utf-8")
            return
        }
        respond(exchange, 200, html.toByteArray(Charsets.UTF_8), "text/html; charset=utf-8")
    }

    private fun vizErrorPage(theme: String, message: String): String =
        VisualizeFileRegistry.decorate(
            "<div style=\"padding:24px;color:var(--muted-foreground);font-size:13px\">$message</div>",
            theme,
        )

    private fun respond(exchange: HttpExchange, code: Int, bytes: ByteArray, mime: String) {
        exchange.responseHeaders.add("Content-Type", mime)
        exchange.responseHeaders.add("Cache-Control", "no-store")
        exchange.sendResponseHeaders(code, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }

    private fun mimeOf(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
        "html" -> "text/html; charset=utf-8"
        "js", "mjs" -> "text/javascript; charset=utf-8"
        "css" -> "text/css; charset=utf-8"
        "json", "map" -> "application/json; charset=utf-8"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "gif" -> "image/gif"
        "webp" -> "image/webp"
        "ico" -> "image/x-icon"
        "woff" -> "font/woff"
        "woff2" -> "font/woff2"
        "ttf" -> "font/ttf"
        else -> "application/octet-stream"
    }
}
