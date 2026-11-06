package com.zcode.ideaplugin.remote

import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/**
 * parseArtifactRef 附件引用解析与路径穿越校验（0.4.3 审查回归锁）：
 * sid 段原漏校验，zcode-artifact://../config.json 会把目录逃逸到 ~/.zcode/cli 层，
 * 可读该层任意文件（含 config.json 活配置）。段判据 + normalize 子树包含双防线，
 * 穿越矩阵全拒、正常引用放行。
 */
class ParseArtifactRefTest {

    companion object {
        private val REAL_HOME: String = System.getProperty("user.home")
    }

    @TempDir
    lateinit var tmp: Path

    @BeforeEach
    fun pointHomeToTmp() {
        System.setProperty("user.home", tmp.toString())
    }

    @AfterEach
    fun restoreHome() {
        System.setProperty("user.home", REAL_HOME)
    }

    @Test
    fun `正常引用解析出 sid 子目录与文件名`() {
        val artifacts = tmp.resolve(".zcode/cli/artifacts/sess_abc")
        Files.createDirectories(artifacts)
        val ref = assertNotNull(parseArtifactRef("zcode-artifact://sess_abc/img0001.png"))
        assertEquals(artifacts.toAbsolutePath().normalize(), ref.dir.toAbsolutePath().normalize())
        assertEquals("img0001.png", ref.name)
    }

    @Test
    fun `sid 段一级穿越拒绝`() {
        assertNull(parseArtifactRef("zcode-artifact://../config.json"), ".. 逃逸 artifacts 必拒")
    }

    @Test
    fun `sid 段反斜杠分隔拒绝`() {
        assertNull(parseArtifactRef("zcode-artifact://..\\evil/name"), "Windows 反斜杠分隔必拒")
    }

    @Test
    fun `name 段穿越与反斜杠拒绝`() {
        assertNull(parseArtifactRef("zcode-artifact://sess_abc/../secret"), "name 段 .. 必拒")
        assertNull(parseArtifactRef("zcode-artifact://sess_abc/a\\b"), "name 段反斜杠必拒")
    }

    @Test
    fun `缺前缀缺斜杠空 sid 拒绝`() {
        assertNull(parseArtifactRef("file:///etc/passwd"), "前缀不符必拒")
        assertNull(parseArtifactRef("zcode-artifact://noslash"), "无斜杠无 name 必拒")
        assertNull(parseArtifactRef("zcode-artifact:///root.png"), "空 sid 必拒")
    }
}
