package com.zcode.ideaplugin.action

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * 控制台「最近错误段」提取纯函数回归（IDEA 集成面调研 ④）。
 * 动作挂点/控制台取文属集成面，由真机验证承担。
 */
class RecentErrorExtractorTest {

    @Test
    fun `空输入返回空串`() {
        assertEquals("", RecentErrorExtractor.extract(""))
        assertEquals("", RecentErrorExtractor.extract("   \n  \t "))
    }

    @Test
    fun `Java 异常锚点：从异常行截到末尾`() {
        val text = """
            2026-11-10 10:00:00 INFO  App started
            2026-11-10 10:00:01 INFO  doing something
            java.lang.NullPointerException: Cannot invoke method on null
            	at com.example.Foo.bar(Foo.java:42)
            	at com.example.App.main(App.java:10)
        """.trimIndent()
        val seg = RecentErrorExtractor.extract(text)
        assertTrue(seg.startsWith("java.lang.NullPointerException"), "应从异常锚点行开始:\n$seg")
        assertTrue(seg.contains("at com.example.App.main"))
        assertFalse(seg.contains("App started"), "锚点前的普通日志不进错误段")
    }

    @Test
    fun `Caused by 锚点生效（多层包装取最后一段）`() {
        val text = """
            org.springframework.beans.factory.BeanCreationException: Error creating bean
            	at org.springframework.context.support.AbstractApplicationContext.refresh
            Caused by: java.net.ConnectException: Connection refused
            	at java.net.PlainSocketImpl.socketConnect
        """.trimIndent()
        val seg = RecentErrorExtractor.extract(text)
        assertTrue(seg.contains("Caused by: java.net.ConnectException"))
        // 锚点取"最后一个"：Caused by 在后，前段的外层异常行不作为起点——
        // 但整段从 Caused by 起截，外层异常行只会在其之前被丢弃
        assertTrue(seg.contains("at java.net.PlainSocketImpl.socketConnect"))
    }

    @Test
    fun `裸 Exception 类名（无词根前缀）也命中锚点`() {
        // 正则曾要求异常类名带词根前缀（[\w$]+(Exception|...)），裸 java.lang.Exception
        // 恒不命中 → 锚点全空退化取尾部（2026-11-11 单测实锤后修正为前缀可选）
        val text = "log line before\njava.lang.Exception: deep boom\n\tat com.example.Foo.bar(Foo.java:1)\n"
        val seg = RecentErrorExtractor.extract(text)
        assertTrue(seg.startsWith("java.lang.Exception: deep boom"), "实际首行: ${seg.lineSequence().first()}")
    }

    @Test
    fun `英文普通单词不含误报（Errors 结尾、Exceptional 词内）`() {
        val text = (1..60).joinToString("\n") { i -> if (i == 30) "0 errors, all good, Exceptional run $i" else "plain $i" }
        val seg = RecentErrorExtractor.extract(text)
        // 无锚点：退化取尾部 40 行（含第 30 行），不因单词误报提前截断
        assertTrue(seg.startsWith("plain 21"), "退化窗口首行: ${seg.lineSequence().first()}")
    }

    @Test
    fun `Gradle 构建失败横幅作为锚点`() {
        val text = """
            > Task :app:test
            FAILURE: Build failed with an exception.
            * What went wrong:
            Execution failed for task ':app:test'.
        """.trimIndent()
        val seg = RecentErrorExtractor.extract(text)
        assertTrue(seg.startsWith("FAILURE: Build failed with an exception."))
    }

    @Test
    fun `Spring Boot 启动失败横幅作为锚点`() {
        val text = """
            ***************************
            APPLICATION FAILED TO START
            ***************************
            Description: Port 8080 was already in use.
        """.trimIndent()
        val seg = RecentErrorExtractor.extract(text)
        assertTrue(seg.contains("APPLICATION FAILED TO START"))
    }

    @Test
    fun `Surefire 失败汇总行作为锚点`() {
        val text = """
            Running com.example.FooTest
            Tests run: 3, Failures: 1, Errors: 0, Skipped: 0
        """.trimIndent()
        val seg = RecentErrorExtractor.extract(text)
        assertTrue(seg.startsWith("Tests run: 3, Failures: 1"))
    }

    @Test
    fun `无锚点退化为尾部最近输出`() {
        val text = (1..200).joinToString("\n") { "plain log line $it" }
        val seg = RecentErrorExtractor.extract(text)
        assertTrue(seg.startsWith("plain log line 161"), "无锚点取尾部 40 行,实际首行: ${seg.lineSequence().first()}")
        assertTrue(seg.contains("plain log line 200"))
        assertFalse(seg.contains("plain log line 160\n"))
    }

    @Test
    fun `CRLF 归一处理`() {
        val text = "INFO start\r\njava.lang.IllegalStateException: boom\r\n\tat Foo.bar\r\n"
        val seg = RecentErrorExtractor.extract(text)
        assertTrue(seg.startsWith("java.lang.IllegalStateException: boom"))
        assertFalse(seg.contains('\r'))
    }

    @Test
    fun `超长堆栈按行数与字符预算截断`() {
        val stack = (1..300).joinToString("\n") { i -> "\tat com.example.Frame$i(Frame.java:$i)" }
        val text = "java.lang.Exception: deep\n$stack\n"
        // 截断标记由调用方注入（用户文案走 ZCodeBundle），测试用哨兵验证缀尾与预算
        val seg = RecentErrorExtractor.extract(text, "... (TRUNCATED)")
        val lines = seg.split('\n')
        val markerIdx = lines.indexOfFirst { it.startsWith("... (TRUNCATED)") }
        val bodyLines = if (markerIdx >= 0) markerIdx else lines.size
        assertTrue(bodyLines <= RecentErrorExtractor.MAX_ERROR_LINES, "行数钳制: $bodyLines")
        assertTrue(seg.length <= RecentErrorExtractor.MAX_ERROR_CHARS + 64, "字符预算: ${seg.length}")
        assertTrue(seg.contains("at com.example.Frame1("), "异常头紧邻的首帧保留")
    }

    @Test
    fun `锚点在搜索窗之外时仍退化取尾部窗口`() {
        val far = (1..600).joinToString("\n") { "noise $it" }
        val text = "java.lang.Exception: old boom\n$far\nlatest output\n"
        val seg = RecentErrorExtractor.extract(text)
        assertTrue(seg.startsWith("noise "), "600 行噪音把锚点挤出搜索窗，退化取尾部 40 行")
        assertTrue(seg.contains("latest output"))
    }
}
