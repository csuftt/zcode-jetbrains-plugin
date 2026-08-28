package com.zcode.ideaplugin.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import org.cef.CefSettings.LogSeverity

/**
 * 页面调试采集（__zcodeDebug）配套测试：
 * - debug-capture.js 资源可加载且关键结构齐备（幂等 guard / console / fetch / XHR / dump / browserMsgs）
 * - 浏览器层 console 消息格式化（onConsoleMessage 兜底采集，非 console API 类）
 */
class ZCodeBrowserDebugCaptureTest {

    private fun captureScript(): String {
        val stream = javaClass.getResourceAsStream("/debug-capture.js")
        assertNotNull(stream, "debug-capture.js 应打进插件资源")
        return stream.readBytes().toString(Charsets.UTF_8)
    }

    @Test
    fun `采集脚本关键结构齐备`() {
        val js = captureScript()
        // 幂等 guard：重复注入（addScript + 立即注入双通道）不得二次 patch
        assertTrue(js.contains("__zcodeDebug.v === 1"), "幂等 guard")
        assertTrue(js.contains("consoleBuf.push"), "console 补丁记录")
        assertTrue(js.contains("orig.apply(console, arguments)"), "console 透传原实现")
        assertTrue(js.contains("window.fetch ="), "fetch 补丁")
        assertTrue(js.contains("XMLHttpRequest.prototype.send ="), "XHR 补丁")
        assertTrue(js.contains("unhandledrejection"), "未处理 rejection 采集")
        assertTrue(js.contains("window.addEventListener('error'"), "未捕获异常采集")
        assertTrue(js.contains("function dump(opts)"), "dump() 读取入口")
        assertTrue(js.contains("browserMsgs"), "浏览器层消息缓冲（executor 合入）")
        assertTrue(js.contains("event-stream"), "SSE 响应不采 body 的豁免存在")
    }

    @Test
    fun `采集脚本容量裁剪存在`() {
        val js = captureScript()
        assertTrue(js.contains("while (a.length > max) a.shift();"), "环形裁剪")
    }

    @Test
    fun `浏览器层 console 消息格式化（级别映射与 source 附加）`() {
        assertEquals(
            "[error] Failed to load resource: the server responded with a status of 404 (http://x/a) (network)",
            ZCodeBrowserPanel.formatBrowserConsoleLine(
                LogSeverity.LOGSEVERITY_ERROR,
                "Failed to load resource: the server responded with a status of 404 (http://x/a)",
                "network", 0,
            ),
        )
        assertEquals(
            "[warn] something odd",
            ZCodeBrowserPanel.formatBrowserConsoleLine(LogSeverity.LOGSEVERITY_WARNING, "something odd", "", 0),
            "空 source 不附加括号",
        )
        assertEquals(
            "[info] js message (javascript:12)",
            ZCodeBrowserPanel.formatBrowserConsoleLine(LogSeverity.LOGSEVERITY_INFO, "js message", "javascript", 12),
        )
    }
}
