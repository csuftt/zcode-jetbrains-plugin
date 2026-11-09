package com.zcode.ideaplugin.protocol

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path

/**
 * PATH 逐段扫描坏段隔离（issue#47 回归）：
 * 中文用户名被 ANSI 代码页毒化成 `????` 的段必须跳过，而不是让 Path.of 抛
 * InvalidPathException 炸掉整条探测链（原实现 .map 急切求值，毒段在任何位置都致命）。
 */
class PathEnvScanTest {

    @TempDir
    lateinit var tempDir: Path

    /** PATH 段是「含可执行文件的目录」：tempDir 即段，node 是段内假可执行文件 */
    private fun makeFakeNode() {
        Files.write(tempDir.resolve("node"), byteArrayOf())
    }

    @Test
    fun `毒段夹在中间不影响找到其余段中的 node`() {
        makeFakeNode()
        val pathEnv = "C:\\x\\a;C:\\Users\\????\\.dbx\\bin;$tempDir"
        assertEquals(tempDir.resolve("node").toString(), PathEnvScan.findExecutable(pathEnv, ";", listOf("node")))
    }

    @Test
    fun `毒段在首位也跳过继续扫描`() {
        makeFakeNode()
        val pathEnv = "C:\\Users\\????\\.dbx\\bin;$tempDir;C:\\Windows\\System32"
        assertEquals(tempDir.resolve("node").toString(), PathEnvScan.findExecutable(pathEnv, ";", listOf("node")))
    }

    @Test
    fun `只有毒段时不抛异常返回null`() {
        assertNull(PathEnvScan.findExecutable("C:\\Users\\????\\.dbx\\bin", ";", listOf("node")))
    }

    @Test
    fun `毒段后正常段无命中返回null`() {
        val emptyDir = tempDir.resolve("empty").also { Files.createDirectories(it) }
        val pathEnv = "C:\\Users\\????\\.dbx\\bin;$emptyDir"
        assertNull(PathEnvScan.findExecutable(pathEnv, ";", listOf("node")))
    }

    @Test
    fun `正常PATH基础功能不回归`() {
        makeFakeNode()
        assertEquals(tempDir.resolve("node").toString(), PathEnvScan.findExecutable("$tempDir;C:\\Windows", ";", listOf("node")))
    }

    @Test
    fun `空PATH返回null`() {
        assertNull(PathEnvScan.findExecutable("", ";", listOf("node")))
    }
}
