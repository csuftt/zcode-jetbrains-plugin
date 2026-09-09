package com.zcode.ideaplugin.ui

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.io.TempDir

/**
 * ZCodeClientSettingStore（~/.zcode/v2/setting.json 读写）单元测试
 *
 * 临时目录替代用户 home，验证：默认值、字段读取、只改 memoryEnabled
 * 其余键原样保留、文件缺失/损坏时的降级行为
 */
class ZCodeClientSettingStoreTest {

    @TempDir
    lateinit var home: File

    private fun writeSetting(content: String) {
        val f = ZCodeClientSettingStore.settingPath(home.absolutePath)
        f.parentFile!!.mkdirs()
        f.writeText(content, Charsets.UTF_8)
    }

    @Test
    fun `文件缺失时读默认值（对齐 CLI schema：memory 关、native 开）`() {
        val prefs = ZCodeClientSettingStore.readRuntimePrefs(home.absolutePath)
        assertFalse(prefs.memoryEnabled)
        assertTrue(prefs.nativeSearchEnhancementsEnabled)
    }

    @Test
    fun `读取客户端写出的两项开关（askUser 自动继续等无关键忽略）`() {
        writeSetting(
            """
            {
              "locale": "zh-CN",
              "memoryEnabled": true,
              "nativeSearchEnhancementsEnabled": false,
              "askUserQuestionAutoResolutionEnabled": false
            }
            """.trimIndent()
        )
        val prefs = ZCodeClientSettingStore.readRuntimePrefs(home.absolutePath)
        assertTrue(prefs.memoryEnabled)
        assertFalse(prefs.nativeSearchEnhancementsEnabled)
    }

    @Test
    fun `写 memoryEnabled 只改目标字段，其余键（含嵌套对象）原样保留`() {
        writeSetting(
            """
            {
              "locale": "zh-CN",
              "desktopWindowSize": { "width": 1200, "height": 800 },
              "memoryEnabled": false,
              "lastActiveTabIndex": 0
            }
            """.trimIndent()
        )
        assertTrue(ZCodeClientSettingStore.writeMemoryEnabled(true, home.absolutePath))

        val root = Json.parseToJsonElement(
            ZCodeClientSettingStore.settingPath(home.absolutePath).readText(Charsets.UTF_8)
        ).jsonObject
        assertEquals("true", root["memoryEnabled"]?.jsonPrimitive?.content)
        assertEquals("zh-CN", root["locale"]?.jsonPrimitive?.content)
        assertEquals("0", root["lastActiveTabIndex"]?.jsonPrimitive?.content)
        assertEquals(
            """{"width":1200,"height":800}""",
            root["desktopWindowSize"].toString()
        )
        assertTrue(ZCodeClientSettingStore.readRuntimePrefs(home.absolutePath).memoryEnabled)
    }

    @Test
    fun `文件缺失时写入最小片段，可再读回`() {
        assertTrue(ZCodeClientSettingStore.writeMemoryEnabled(true, home.absolutePath))
        val f = ZCodeClientSettingStore.settingPath(home.absolutePath)
        assertTrue(f.isFile, "应创建 setting.json")
        assertTrue(ZCodeClientSettingStore.readRuntimePrefs(home.absolutePath).memoryEnabled)
        // 关回去
        assertTrue(ZCodeClientSettingStore.writeMemoryEnabled(false, home.absolutePath))
        assertFalse(ZCodeClientSettingStore.readRuntimePrefs(home.absolutePath).memoryEnabled)
    }

    @Test
    fun `文件损坏（非法 JSON）时读默认值，写入降级为最小片段`() {
        writeSetting("{ not valid json !!")
        val prefs = ZCodeClientSettingStore.readRuntimePrefs(home.absolutePath)
        assertFalse(prefs.memoryEnabled)
        assertTrue(ZCodeClientSettingStore.writeMemoryEnabled(true, home.absolutePath))
        assertTrue(ZCodeClientSettingStore.readRuntimePrefs(home.absolutePath).memoryEnabled)
    }
}
