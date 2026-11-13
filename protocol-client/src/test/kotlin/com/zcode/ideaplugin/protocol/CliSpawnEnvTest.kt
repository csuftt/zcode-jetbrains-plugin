package com.zcode.ideaplugin.protocol

import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import org.junit.jupiter.api.io.TempDir

/**
 * CLI 子进程数据根环境注入（issue #50）。
 *
 * zcode.cjs 解析数据根只认 env `ZCODE_DATA_BASE_DIR`（缺省 homedir），不读
 * setting.json；数据目录重定向用户下，润色专用 app-server / CLI 一次性调用
 * 必须显式下发，否则子进程读 home 的旧 provider_config.json。
 */
class CliSpawnEnvTest {

    @TempDir
    lateinit var temp: Path

    private val home: Path get() = temp.resolve("home")

    /** 写 home/.zcode/v2/setting.json；null = 不建文件（未配置） */
    private fun givenSetting(dataBaseDir: String? = null, createFile: Boolean = true) {
        if (!createFile) return
        Files.createDirectories(home.resolve(".zcode/v2"))
        val body = if (dataBaseDir == null) "{}"
        else """{"dataBaseDir":"${dataBaseDir.replace("\\", "\\\\")}"}"""
        home.resolve(".zcode/v2/setting.json").toFile().writeText(body)
    }

    private fun absoluteDataDir(): String = temp.resolve("data").toAbsolutePath().toString()

    @Test
    fun `配置 dataBaseDir 时注入 ZCODE_DATA_BASE_DIR`() {
        val dir = absoluteDataDir()
        givenSetting(dir)
        assertEquals(mapOf(CliSpawnEnv.DATA_BASE_DIR to dir), CliSpawnEnv.extraEnv(home.toString()))
    }

    @Test
    fun `withDataBaseDir 保留既有 env 键且覆盖同名旧值`() {
        val dir = absoluteDataDir()
        givenSetting(dir)
        val merged = CliSpawnEnv.withDataBaseDir(
            mapOf(
                "ZCODE_MODEL" to "glm-5.3",
                "ANTHROPIC_API_KEY" to "k",
                CliSpawnEnv.DATA_BASE_DIR to "stale-inherited",
            ),
            home.toString(),
        )
        assertEquals("glm-5.3", merged["ZCODE_MODEL"])
        assertEquals("k", merged["ANTHROPIC_API_KEY"])
        assertEquals(dir, merged[CliSpawnEnv.DATA_BASE_DIR], "客户端设置是数据根的权威，覆盖继承旧值")
    }

    @Test
    fun `配置值两侧空白被 trim（合法绝对路径仍注入）`() {
        val dir = absoluteDataDir()
        givenSetting("   $dir   ")
        assertEquals(mapOf(CliSpawnEnv.DATA_BASE_DIR to dir), CliSpawnEnv.extraEnv(home.toString()))
    }

    @Test
    fun `未配置 dataBaseDir 不注入且不改动既有 env`() {
        givenSetting(dataBaseDir = null)
        assertEquals(emptyMap(), CliSpawnEnv.extraEnv(home.toString()))
        val base = mapOf("ZCODE_MODEL" to "glm-5.3")
        assertEquals(base, CliSpawnEnv.withDataBaseDir(base, home.toString()))
    }

    @Test
    fun `setting 文件缺失不注入`() {
        givenSetting(createFile = false)
        assertEquals(emptyMap(), CliSpawnEnv.extraEnv(home.toString()))
    }
}
