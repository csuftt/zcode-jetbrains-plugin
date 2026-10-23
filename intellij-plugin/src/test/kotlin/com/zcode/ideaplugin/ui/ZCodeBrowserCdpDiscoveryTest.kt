package com.zcode.ideaplugin.ui

import com.intellij.openapi.application.PathManager
import com.zcode.ideaplugin.env.ZCodeEnvChecker
import org.junit.jupiter.api.Assumptions.assumeTrue
import java.io.File
import java.net.ServerSocket
import java.nio.file.Files
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * CDP 端点发现逻辑单测：
 * - probePortFile：真实监听端口命中 / 死端口与损坏内容返回 null
 * - findDevToolsActivePortFiles：显式配置钉首位、不存在被跳过、
 *   PathManager system 目录零配置兜底、配置与自动发现重合时 canonical 去重
 */
class ZCodeBrowserCdpDiscoveryTest {

    private class MemStore : ZCodeEnvChecker.EnvStore {
        val map = mutableMapOf<String, String>()
        override fun get(key: String): String? = map[key]
        override fun set(key: String, value: String?) {
            if (value == null) map.remove(key) else map[key] = value
        }
    }

    private val tempDirs = mutableListOf<File>()

    private fun tempDir(): File =
        Files.createTempDirectory("cdp-discovery-test").toFile().also { tempDirs.add(it) }

    /** 按 CEF 格式写 DevToolsActivePort（首行端口、次行 browser ws 路径） */
    private fun writePortFile(dir: File, port: Int, name: String = "DevToolsActivePort"): File {
        dir.mkdirs()
        return File(dir, name).apply { writeText("$port\n/devtools/browser/cdp-unit-test\n") }
    }

    @AfterTest
    fun cleanup() {
        // 恢复无注入存储（其他用例的 env 状态不被本类污染）
        ZCodeEnvChecker.setStoreForTest(MemStore())
        tempDirs.forEach { it.deleteRecursively() }
    }

    // ============ probePortFile ============

    @Test
    fun `probePortFile 真实监听端口命中`() {
        ServerSocket(0).use { ss ->
            val f = writePortFile(tempDir(), ss.localPort)
            assertEquals(ss.localPort, ZCodeBrowserExecutor.probePortFile(f))
        }
    }

    @Test
    fun `probePortFile 死端口返回 null`() {
        val ss = ServerSocket(0)
        val deadPort = ss.localPort
        ss.close()
        val f = writePortFile(tempDir(), deadPort)
        assertNull(ZCodeBrowserExecutor.probePortFile(f), "无监听端口应判不可达")
    }

    @Test
    fun `probePortFile 损坏内容返回 null`() {
        ServerSocket(0).use { ss ->
            val f = writePortFile(tempDir(), ss.localPort).apply { writeText("not-a-port\n") }
            assertNull(ZCodeBrowserExecutor.probePortFile(f))
        }
    }

    @Test
    fun `probePortFile 缺失文件返回 null`() {
        assertNull(ZCodeBrowserExecutor.probePortFile(File(tempDir(), "missing/DevToolsActivePort")))
    }

    // ============ findDevToolsActivePortFiles 候选优先级 ============

    @Test
    fun `配置文件恒为候选首位不被 mtime 挤下`() {
        val store = MemStore()
        ZCodeEnvChecker.setStoreForTest(store)
        ServerSocket(0).use { ss ->
            val configured = writePortFile(tempDir(), ss.localPort)
            configured.setLastModified(0L) // 比机器上任何自动发现候选都旧
            store.set(ZCodeEnvChecker.KEY_CDP_PORT_FILE, configured.absolutePath)

            val found = ZCodeBrowserExecutor.findDevToolsActivePortFiles()
            assertTrue(found.isNotEmpty(), "显式配置的活端口文件必须出现在候选中")
            assertEquals(
                configured.canonicalPath, found.first().canonicalPath,
                "配置项钉首位，不参与 mtime 排序",
            )
        }
    }

    @Test
    fun `配置指向不存在文件被跳过`() {
        val store = MemStore()
        ZCodeEnvChecker.setStoreForTest(store)
        val missing = File(tempDir(), "nope/DevToolsActivePort")
        store.set(ZCodeEnvChecker.KEY_CDP_PORT_FILE, missing.absolutePath)

        val found = ZCodeBrowserExecutor.findDevToolsActivePortFiles()
        assertFalse(
            found.any { it.absolutePath == missing.absolutePath },
            "isFile=false 的配置值不得进候选：$found",
        )
    }

    @Test
    fun `PathManager system 目录 jcef_cache 变体零配置发现`() {
        val store = MemStore()
        ZCodeEnvChecker.setStoreForTest(store)
        // 测试沙箱 system 目录可能不可写（非常规启动配置）——不可写时跳过而非失败
        val variant = File(PathManager.getSystemDir().toFile(), "jcef_cache-cdp-unit-test")
        assumeTrue(variant.mkdirs() || variant.isDirectory, "测试 system 目录不可写：$variant")
        ServerSocket(0).use { ss ->
            val f = writePortFile(variant, ss.localPort)
            try {
                val found = ZCodeBrowserExecutor.findDevToolsActivePortFiles()
                assertTrue(
                    found.any { it.canonicalPath == f.canonicalPath },
                    "system 目录下 jcef_cache-* 变体应被零配置发现：${found.map { it.path }}",
                )
            } finally {
                variant.deleteRecursively()
            }
        }
    }

    @Test
    fun `activeCdpEndpoint 配置的活端口文件命中`() {
        val store = MemStore()
        ZCodeEnvChecker.setStoreForTest(store)
        ServerSocket(0).use { ss ->
            val configured = writePortFile(tempDir(), ss.localPort)
            store.set(ZCodeEnvChecker.KEY_CDP_PORT_FILE, configured.absolutePath)
            val hit = ZCodeBrowserExecutor.activeCdpEndpoint()
            assertNotNull(hit, "配置钉首位的活端口文件必须命中")
            assertEquals(configured.canonicalPath, hit.first.canonicalPath)
            assertEquals(ss.localPort, hit.second)
        }
    }

    @Test
    fun `配置路径与自动发现重合时 canonical 去重且居首`() {
        val store = MemStore()
        ZCodeEnvChecker.setStoreForTest(store)
        val variant = File(PathManager.getSystemDir().toFile(), "jcef_cache-cdp-unit-test")
        assumeTrue(variant.mkdirs() || variant.isDirectory, "测试 system 目录不可写：$variant")
        ServerSocket(0).use { ss ->
            val f = writePortFile(variant, ss.localPort)
            store.set(ZCodeEnvChecker.KEY_CDP_PORT_FILE, f.absolutePath)
            try {
                val found = ZCodeBrowserExecutor.findDevToolsActivePortFiles()
                val same = found.filter { it.canonicalPath == f.canonicalPath }
                assertEquals(1, same.size, "配置与自动发现同一份文件时候选不得重复：$found")
                assertEquals(f.canonicalPath, found.first().canonicalPath, "去重后仍居首位")
            } finally {
                variant.deleteRecursively()
            }
        }
    }
}
