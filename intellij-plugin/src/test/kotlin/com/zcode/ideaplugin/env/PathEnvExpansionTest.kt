package com.zcode.ideaplugin.env

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * 环境变量占位符路径展开（缺陷 GY）单元测试。
 *
 * System.getenv 测试进程内不可注入，真实变量用例按平台条件断言（TEMP/TMP Windows、
 * TMPDIR/HOME Unix）；~ 展开走 System.getProperty("user.home")，测试内可注入。
 */
class PathEnvExpansionTest {

    private val isWindows = System.getProperty("os.name").lowercase().contains("windows")

    @Test
    fun `无占位符原样返回`() {
        val raw = if (isWindows) "C:\\Users\\demo\\report.md" else "/tmp/report.md"
        assertEquals(raw, PathEnvExpansion.expand(raw))
        assertEquals("", PathEnvExpansion.expand(""))
    }

    @Test
    fun `未知变量三种形态都原样保留`() {
        assertEquals(
            "%ZCODE_NO_SUCH_VAR_D09F%\\x.md",
            PathEnvExpansion.expand("%ZCODE_NO_SUCH_VAR_D09F%\\x.md"),
        )
        assertEquals(
            "\$ZCODE_NO_SUCH_VAR_D09F/x.md",
            PathEnvExpansion.expand("\$ZCODE_NO_SUCH_VAR_D09F/x.md"),
        )
        assertEquals(
            "\${ZCODE_NO_SUCH_VAR_D09F}/x.md",
            PathEnvExpansion.expand("\${ZCODE_NO_SUCH_VAR_D09F}/x.md"),
        )
    }

    @Test
    fun `Windows占位符展开后不含百分号`() {
        if (System.getenv("TEMP") == null) return
        val expanded = PathEnvExpansion.expand("%TEMP%\\handoff-db-adapt-guides.md")
        assertFalse(expanded.contains('%'))
        assertTrue(expanded.endsWith("handoff-db-adapt-guides.md"))
        // TEMP 原值可能是 ADMINI~1 短名，展开后经 canonical 化≠原串——用前缀目录存在性判定
        assertTrue(File(expanded).parentFile?.exists() == true, "展开前缀目录应真实存在（含短名归真）")
    }

    @Test
    fun `Unix占位符展开`() {
        if (isWindows) return
        if (System.getenv("TMPDIR") != null) {
            val expanded = PathEnvExpansion.expand("\${TMPDIR}/x.md")
            assertFalse(expanded.contains('$'))
            assertTrue(expanded.endsWith("x.md"))
        }
        val home = System.getenv("HOME")
        if (home != null) {
            assertEquals("$home/notes.md", PathEnvExpansion.expand("\$HOME/notes.md"))
        }
    }

    @Test
    fun `相邻组合变量一轮到到位`() {
        val drive = System.getenv("HOMEDRIVE")
        val homePath = System.getenv("HOMEPATH")
        if (drive == null || homePath == null) return
        val expanded = PathEnvExpansion.expand("%HOMEDRIVE%%HOMEPATH%\\x.md")
        assertFalse(expanded.contains('%'))
        assertTrue(expanded.endsWith("x.md"))
    }

    @Test
    fun `波浪线展开到userHome且测试内可注入`() {
        val original = System.getProperty("user.home")
        try {
            System.setProperty("user.home", "/home/zcode")
            assertEquals("/home/zcode", PathEnvExpansion.expand("~"))
            assertEquals("/home/zcode/notes.md", PathEnvExpansion.expand("~/notes.md"))
            assertEquals("/home/zcode\\notes.md", PathEnvExpansion.expand("~\\notes.md"))
        } finally {
            if (original != null) System.setProperty("user.home", original)
        }
    }

    @Test
    fun `波浪线中缀不展开`() {
        assertEquals("/a/~b/x.md", PathEnvExpansion.expand("/a/~b/x.md"))
        assertEquals("~user/x.md", PathEnvExpansion.expand("~user/x.md"))
    }

    @Test
    fun `pathEnvVars键全在白名单内且HOME必有`() {
        val vars = PathEnvExpansion.pathEnvVars()
        val allowed = setOf(
            "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
            "APPDATA", "LOCALAPPDATA", "ALLUSERSPROFILE", "PROGRAMDATA", "PUBLIC",
        )
        assertTrue(vars.keys.all { it in allowed })
        assertTrue(vars.containsKey("HOME"))
        assertTrue(vars.values.all { it.isNotBlank() })
    }

    @Test
    fun `pathEnvVars存在路径已归真`() {
        val vars = PathEnvExpansion.pathEnvVars()
        for ((key, value) in vars) {
            val raw = System.getenv(key) ?: continue
            // 「C:」盘相对形态刻意不 canonical 化（canonicalPath 会落到该盘当前目录，
            // 语义被污染）；展开场景 %HOMEDRIVE%%HOMEPATH% 拼接后语义仍正确
            if (raw.length == 2 && raw[1] == ':') {
                assertEquals(raw, value, "$key 盘相对形态应原样保留")
                continue
            }
            if (File(raw).exists()) {
                assertEquals(File(raw).canonicalPath, value, "$key 应 canonical 化为真实长路径")
            }
        }
    }
}
