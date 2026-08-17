package com.zcode.ideaplugin.protocol

import java.nio.file.Files
import kotlin.io.path.isRegularFile
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * 凭证路径解析（dataBaseDir 自动跟随）单元测试
 *
 * 场景来自 ZCode 客户端数据目录迁移的实测：
 * - 入口 setting.json 恒在 user home，dataBaseDir 指向新数据根
 * - 配置后 v2 数据（含凭证 config.json）只在新位置演进
 * - 迁移中途/异常（新位置文件缺失）须回退旧位置
 */
class CredentialsPathTest {

    private val home = Files.createTempDirectory("cred-path-test")

    @AfterTest
    fun cleanup() {
        home.toFile().deleteRecursively()
    }

    /** 在 home 下放置 setting.json（写 dataBaseDir 字段则同时建新位置 config.json） */
    private fun givenSetting(dataBaseDir: String?, configInNewLocation: Boolean = false, content: String? = null) {
        Files.createDirectories(home.resolve(".zcode/v2"))
        val setting = buildString {
            append("{")
            if (dataBaseDir != null) append("\"dataBaseDir\": \"${dataBaseDir.replace("\\", "\\\\")}\"")
            append("}")
        }
        home.resolve(".zcode/v2/setting.json").toFile().writeText(content ?: setting)
        if (dataBaseDir != null && configInNewLocation) {
            val newConfig = home.resolve("newroot/.zcode/v2/config.json")
            Files.createDirectories(newConfig.parent)
            newConfig.toFile().writeText("{}")
        }
    }

    @Test
    fun `未配置 dataBaseDir 时走默认旧位置`() {
        givenSetting(dataBaseDir = null)
        assertEquals(
            home.resolve(".zcode/v2/config.json"),
            Credentials.configPathFor(home.toString()),
        )
    }

    @Test
    fun `setting 文件不存在时走默认旧位置`() {
        assertEquals(
            home.resolve(".zcode/v2/config.json"),
            Credentials.configPathFor(home.toString()),
        )
    }

    @Test
    fun `配置 dataBaseDir 且新位置存在时跟随新位置`() {
        givenSetting(dataBaseDir = home.resolve("newroot").toString(), configInNewLocation = true)
        assertEquals(
            home.resolve("newroot/.zcode/v2/config.json"),
            Credentials.configPathFor(home.toString()),
        )
    }

    @Test
    fun `配置 dataBaseDir 但新位置文件缺失时回退旧位置`() {
        // 迁移中途：setting 已指向新位置但拷贝未完成
        givenSetting(dataBaseDir = home.resolve("newroot").toString(), configInNewLocation = false)
        assertEquals(
            home.resolve(".zcode/v2/config.json"),
            Credentials.configPathFor(home.toString()),
        )
    }

    @Test
    fun `setting 文件损坏时按未配置处理`() {
        givenSetting(dataBaseDir = null, content = "{\"dataBaseDir\": \"F:\\\\Zcode\", broken")
        assertEquals(
            home.resolve(".zcode/v2/config.json"),
            Credentials.configPathFor(home.toString()),
        )
    }

    @Test
    fun `dataBaseDir 为空白串时按未配置处理`() {
        givenSetting(dataBaseDir = null, content = "{\"dataBaseDir\": \"  \"}")
        assertEquals(
            home.resolve(".zcode/v2/config.json"),
            Credentials.configPathFor(home.toString()),
        )
    }

    @Test
    fun `defaultConfigPath 真机解析到存在的文件`() {
        // 前置：本机已登录 ZCode（与 EnvChecker 真机测试同风格）
        val p = Credentials.defaultConfigPath()
        assertTrue(p.isRegularFile(), "应解析到存在的 config.json: $p（跟随 dataBaseDir 或默认位置）")
    }
}
