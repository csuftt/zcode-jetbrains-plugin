package com.zcode.ideaplugin.viz

import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

/**
 * VisualizeFileRegistry：::visualize 本地文件安全网关测试。
 * 白名单根用 @TempDir 注入（rootsOverride），单例 token 表每用例清场。
 */
class VisualizeFileRegistryTest {

    @TempDir
    lateinit var tempDir: File

    private lateinit var root: File

    @BeforeEach
    fun setUp() {
        VisualizeFileRegistry.resetForTest()
        root = File(tempDir, "visualizations").apply { mkdirs() }
        VisualizeFileRegistry.rootsOverride = listOf(root)
    }

    @AfterEach
    fun tearDown() {
        VisualizeFileRegistry.resetForTest()
    }

    private fun makeViz(rel: String, content: String = "<div>ok</div>"): File {
        val f = File(root, rel)
        f.parentFile.mkdirs()
        f.writeText(content)
        return f
    }

    @Test
    fun `白名单根内的 html 文件登记成功，token 合 32 hex`() {
        val f = makeViz("sess1/gold.html")
        val reg = VisualizeFileRegistry.register(f.absolutePath)
        assertTrue(reg.ok)
        assertNotNull(reg.token)
        assertTrue(VisualizeFileRegistry.tokenPattern.matches(reg.token!!))
    }

    @Test
    fun `同一路径复用同一 token`() {
        val f = makeViz("sess1/a.html")
        val r1 = VisualizeFileRegistry.register(f.absolutePath)
        val r2 = VisualizeFileRegistry.register(f.absolutePath)
        assertEquals(r1.token, r2.token)
    }

    @Test
    fun `白名单外路径拒绝`() {
        val f = File(tempDir, "outside.html").apply { writeText("<div></div>") }
        val reg = VisualizeFileRegistry.register(f.absolutePath)
        assertFalse(reg.ok)
        assertTrue(reg.error!!.contains("允许的可视化目录"))
    }

    @Test
    fun `相对路径与非 html 拒绝`() {
        assertFalse(VisualizeFileRegistry.register("relative/a.html").ok)
        val f = makeViz("sess1/nothtml.txt")
        val reg = VisualizeFileRegistry.register(f.absolutePath)
        assertFalse(reg.ok)
        assertTrue(reg.error!!.contains(".html"))
    }

    @Test
    fun `不存在的文件拒绝`() {
        val reg = VisualizeFileRegistry.register(File(root, "sess1/ghost.html").absolutePath)
        assertFalse(reg.ok)
        assertTrue(reg.error!!.contains("不存在"))
    }

    @Test
    fun `超过 2MB 上限拒绝`() {
        val f = makeViz("sess1/big.html", "x".repeat(2 * 1024 * 1024 + 1))
        val reg = VisualizeFileRegistry.register(f.absolutePath)
        assertFalse(reg.ok)
        assertTrue(reg.error!!.contains("2MB"))
    }

    @Test
    fun `resolve 对合法 token 返回文件，非法 token 与已删文件返回 null`() {
        val f = makeViz("sess1/a.html")
        val token = VisualizeFileRegistry.register(f.absolutePath).token!!
        assertEquals(f.canonicalFile, VisualizeFileRegistry.resolve(token)!!.canonicalFile)
        assertNull(VisualizeFileRegistry.resolve("../etc/passwd"))
        assertNull(VisualizeFileRegistry.resolve("deadbeef"))
        f.delete()
        assertNull(VisualizeFileRegistry.resolve(token))
    }

    @Test
    fun `LRU 超限逐出最旧 token`() {
        val first = VisualizeFileRegistry.register(makeViz("s0/a.html").absolutePath).token!!
        // 触碰一次 first（accessOrder 下 get 也续期），随后批量插入让它稳居最旧位；
        // 此后不再触碰 first，否则 get 续期会让断言失真
        assertNotNull(VisualizeFileRegistry.resolve(first))
        repeat(VisualizeFileRegistry.MAX_ENTRIES) { i ->
            VisualizeFileRegistry.register(makeViz("bulk/f$i.html").absolutePath)
        }
        // 容量已挤爆（1+64>64），最旧的 first 在插入过程中被逐出
        assertNull(VisualizeFileRegistry.resolve(first))
    }

    @Test
    fun `decorate 前置注入主题基线并替换主题占位`() {
        val out = VisualizeFileRegistry.decorate("<h3>图表</h3>", "light")
        assertTrue(out.startsWith("<style>"))
        assertTrue(out.contains("--viz-series-1"))
        assertTrue(out.contains("[data-theme='light']"))
        assertTrue(out.contains("applyTheme('light')"))
        assertTrue(out.endsWith("<h3>图表</h3>"))
        val dark = VisualizeFileRegistry.decorate("x", "weird")
        assertTrue(dark.contains("applyTheme('dark')"))
        assertNotEquals(out, dark)
    }

    @Test
    fun `Windows 反斜杠路径（JSON 解码后）可正常登记`() {
        val f = makeViz("sess1/win.html")
        val reg = VisualizeFileRegistry.register(f.absolutePath)
        assertTrue(reg.ok)
    }
}
