package com.zcode.ideaplugin

import com.intellij.openapi.diagnostic.Logger
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
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
            log.info("classpath 无 /webview 多文件产物，跳过内置 server（降级 singlefile）")
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
            log.info("内置 webview server 已启动：http://127.0.0.1:$port")
            port
        } catch (e: Exception) {
            log.warn("内置 webview server 启动失败（降级 singlefile 加载）: ${e.message}")
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
            val rel = decoded.removePrefix("/").ifEmpty { "index.html" }
            val bytes = javaClass.getResourceAsStream("/webview/$rel")?.use { it.readBytes() }
            if (bytes == null) {
                respond(exchange, 404, "not found: $rel".toByteArray(), "text/plain; charset=utf-8")
            } else {
                respond(exchange, 200, bytes, mimeOf(rel))
            }
        } catch (e: Exception) {
            log.warn("webview server 处理请求失败: ${e.message}")
        } finally {
            exchange.close()
        }
    }

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
        "ico" -> "image/x-icon"
        "woff" -> "font/woff"
        "woff2" -> "font/woff2"
        "ttf" -> "font/ttf"
        else -> "application/octet-stream"
    }
}
