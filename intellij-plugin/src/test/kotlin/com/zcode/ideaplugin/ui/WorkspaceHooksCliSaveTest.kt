package com.zcode.ideaplugin.ui

// 钩子保存（新建/编辑一体）：userSave 走临时 home 全链路（文件 IO，无 CLI）；
// saveToConfig 直测覆盖根开关补写（工作区入口 save 会跑 CLI status，单测不可达）

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path

class WorkspaceHooksCliSaveTest {

    @TempDir
    lateinit var home: Path

    private val configPath: Path get() = home.resolve(".zcode/cli/config.json")

    private fun writeConfig(json: String) {
        Files.createDirectories(configPath.parent)
        Files.writeString(configPath, json)
    }

    private fun readConfig(): JsonObject =
        Json.parseToJsonElement(Files.readString(configPath)).let { it as JsonObject }

    /** 最小合法载荷（command 型） */
    private fun payload(
        event: String = "PreToolUse",
        type: String = "command",
        command: String = "bash hook.sh",
        matcher: String? = null,
        shell: String? = null,
        async: Boolean? = null,
        timeout: Double? = null,
        timeoutMs: Double? = null,
        args: List<String>? = null,
    ): JsonObject = buildJsonObject {
        put("event", event)
        put("type", type)
        put("command", command)
        if (matcher != null) put("matcher", matcher)
        if (shell != null) put("shell", shell)
        if (async == true) put("async", true)
        if (timeout != null) put("timeout", timeout)
        if (timeoutMs != null) put("timeoutMs", timeoutMs)
        if (args != null) put("args", JsonArray(args.map { kotlinx.serialization.json.JsonPrimitive(it) }))
    }

    private fun events(): JsonObject = readConfig()["hooks"]!!.jsonObject["events"]!!.jsonObject

    private fun hookAt(event: String, groupIdx: Int, hookIdx: Int): JsonObject =
        events()[event]!!.jsonArray[groupIdx].jsonObject["hooks"]!!.jsonArray[hookIdx].jsonObject

    // ============ 新建 ============

    @Test
    fun `create into missing file builds minimal structure`() {
        val status = WorkspaceHooksCli.userSave(payload(command = "echo hi"), null, null, home)

        assertTrue(Files.isRegularFile(configPath))
        assertEquals(1, status["items"]!!.jsonArray.size)
        val hook = hookAt("PreToolUse", 0, 0)
        assertEquals("command", hook["type"]!!.jsonPrimitive.content)
        assertEquals("echo hi", hook["command"]!!.jsonPrimitive.content)
        assertFalse(hook.containsKey("enabled")) // 新建缺省启用
    }

    @Test
    fun `create with process type serializes args and rejects shell fields`() {
        WorkspaceHooksCli.userSave(payload(type = "process", command = "node", args = listOf("a.js", "--b"), timeoutMs = 5000.0), null, null, home)
        val hook = hookAt("PreToolUse", 0, 0)
        assertEquals("process", hook["type"]!!.jsonPrimitive.content)
        assertEquals("node", hook["command"]!!.jsonPrimitive.content)
        assertEquals("a.js", hook["args"]!!.jsonArray[0].jsonPrimitive.content)
        assertEquals(5000, hook["timeoutMs"]!!.jsonPrimitive.content.toInt())

        assertThrows(IllegalStateException::class.java) {
            WorkspaceHooksCli.userSave(payload(type = "process", shell = "bash"), null, null, home)
        }
        assertThrows(IllegalStateException::class.java) {
            WorkspaceHooksCli.userSave(payload(type = "command", args = listOf("x")), null, null, home)
        }
    }

    @Test
    fun `create merges into same-matcher group and appends new group otherwise`() {
        writeConfig(
            """
            { "hooks": { "events": { "PreToolUse": [
              { "matcher": "Bash", "hooks": [ { "type": "command", "command": "a.sh" } ] }
            ] } } }
            """.trimIndent(),
        )

        // 同 matcher（含双方都无 matcher）→ 合并进现有组
        WorkspaceHooksCli.userSave(payload(command = "b.sh", matcher = "Bash"), null, null, home)
        assertEquals(2, events()["PreToolUse"]!!.jsonArray[0].jsonObject["hooks"]!!.jsonArray.size)

        // 无 matcher → 尾部追加新组
        WorkspaceHooksCli.userSave(payload(event = "Stop", command = "c.sh"), null, null, home)
        assertEquals(1, events()["Stop"]!!.jsonArray.size)
        assertNull(events()["Stop"]!!.jsonArray[0].jsonObject["matcher"])
    }

    // ============ 编辑 ============

    @Test
    fun `update replaces in place and preserves enabled false`() {
        writeConfig(
            """
            { "hooks": { "events": { "Stop": [
              { "hooks": [ { "type": "command", "command": "old.sh", "enabled": false } ] }
            ] } } }
            """.trimIndent(),
        )

        WorkspaceHooksCli.userSave(payload(event = "Stop", command = "new.sh"), "user-hook-0-Stop-0-0", configPath.toString(), home)
        val hook = hookAt("Stop", 0, 0)
        assertEquals("new.sh", hook["command"]!!.jsonPrimitive.content)
        assertEquals(false, hook["enabled"]!!.jsonPrimitive.content.toBoolean()) // 沿用原启停状态
    }

    @Test
    fun `update matcher change rewrites single-hook group in place`() {
        writeConfig(
            """
            { "hooks": { "events": { "PreToolUse": [
              { "matcher": "Bash", "hooks": [ { "type": "command", "command": "a.sh" } ] }
            ] } } }
            """.trimIndent(),
        )

        WorkspaceHooksCli.userSave(payload(command = "a.sh", matcher = "Write"), "user-hook-0-PreToolUse-0-0", configPath.toString(), home)
        val groups = events()["PreToolUse"]!!.jsonArray
        assertEquals(1, groups.size)
        assertEquals("Write", groups[0].jsonObject["matcher"]!!.jsonPrimitive.content)
    }

    @Test
    fun `update matcher change on multi-hook group splits to trailing group`() {
        writeConfig(
            """
            { "hooks": { "events": { "PreToolUse": [
              { "matcher": "Bash", "hooks": [
                { "type": "command", "command": "a.sh" },
                { "type": "command", "command": "b.sh" }
              ] }
            ] } } }
            """.trimIndent(),
        )

        WorkspaceHooksCli.userSave(payload(command = "a.sh", matcher = "Write"), "user-hook-0-PreToolUse-0-0", configPath.toString(), home)
        val groups = events()["PreToolUse"]!!.jsonArray
        assertEquals(2, groups.size)
        // 原组保留兄弟钩子
        val remain = groups[0].jsonObject
        assertEquals("Bash", remain["matcher"]!!.jsonPrimitive.content)
        assertEquals("b.sh", remain["hooks"]!!.jsonArray[0].jsonObject["command"]!!.jsonPrimitive.content)
        // 尾部新组携带编辑后的钩子
        val split = groups[1].jsonObject
        assertEquals("Write", split["matcher"]!!.jsonPrimitive.content)
        assertEquals("a.sh", split["hooks"]!!.jsonArray[0].jsonObject["command"]!!.jsonPrimitive.content)
    }

    @Test
    fun `update to another event moves with pruning`() {
        writeConfig(
            """
            { "skills": {}, "hooks": { "events": {
              "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "a.sh" } ] } ]
            } } }
            """.trimIndent(),
        )

        WorkspaceHooksCli.userSave(payload(event = "Stop", command = "a.sh", matcher = null), "user-hook-0-PreToolUse-0-0", configPath.toString(), home)
        // 原事件剪枝删除，新事件建组；其余顶层段保留
        assertFalse(events().containsKey("PreToolUse"))
        assertEquals("a.sh", hookAt("Stop", 0, 0)["command"]!!.jsonPrimitive.content)
        assertTrue(readConfig().containsKey("skills"))
    }

    @Test
    fun `update rejects foreign source and bad locator`() {
        writeConfig("""{ "hooks": { "events": { "Stop": [ { "hooks": [ { "command": "a.sh" } ] } ] } } }""")
        assertThrows(IllegalStateException::class.java) {
            WorkspaceHooksCli.userSave(payload(event = "Stop"), "user-hook-0-Stop-0-0", "E:/elsewhere/config.json", home)
        }
        assertThrows(IllegalArgumentException::class.java) {
            WorkspaceHooksCli.userSave(payload(event = "Stop"), "bad-id", configPath.toString(), home)
        }
    }

    // ============ 载荷校验 ============

    @Test
    fun `payload validation rejects bad event empty command and unknown type`() {
        assertThrows(IllegalStateException::class.java) { WorkspaceHooksCli.parseSavePayload(payload(event = "NoSuchEvent")) }
        assertThrows(IllegalStateException::class.java) { WorkspaceHooksCli.parseSavePayload(payload(command = "  ")) }
        assertThrows(IllegalStateException::class.java) { WorkspaceHooksCli.parseSavePayload(payload(type = "shell")) }
        assertThrows(IllegalStateException::class.java) { WorkspaceHooksCli.parseSavePayload(payload(timeout = -1.0)) }
    }

    @Test
    fun `readRawHook returns raw entry with args`() {
        writeConfig(
            """
            { "hooks": { "events": { "PreToolUse": [
              { "matcher": "Bash", "hooks": [ { "type": "process", "command": "node", "args": ["a.js"] } ] }
            ] } } }
            """.trimIndent(),
        )
        val raw = WorkspaceHooksCli.userReadRawHook("user-hook-0-PreToolUse-0-0", configPath.toString(), home)
        assertEquals("node", raw["command"]!!.jsonPrimitive.content)
        assertEquals("a.js", raw["args"]!!.jsonArray[0].jsonPrimitive.content)
    }

    // ============ 根开关补写（工作区新建路径，saveToConfig 直测） ============

    @Test
    fun `workspace create ensures root enabled regardless of prior value`() {
        val wsDir = home.resolve("ws")
        val cfg = wsDir.resolve(".zcode/config.json")

        fun readAt(p: Path): JsonObject =
            Json.parseToJsonElement(Files.readString(p)).let { it as JsonObject }

        // 文件不存在 → 创建并补 true
        WorkspaceHooksCli.saveToConfig(cfg, payload(), null, ensureRootEnabled = true)
        assertEquals("true", readAt(cfg)["hooks"]!!.jsonObject["enabled"]!!.jsonPrimitive.content)

        // 显式 false → 新建路径一律补 true（用户拍板 2026-11-09）
        Files.createDirectories(cfg.parent)
        Files.writeString(cfg, """{ "hooks": { "enabled": false, "events": {} } }""")
        WorkspaceHooksCli.saveToConfig(cfg, payload(), null, ensureRootEnabled = true)
        assertEquals("true", readAt(cfg)["hooks"]!!.jsonObject["enabled"]!!.jsonPrimitive.content)

        // 更新路径不动根开关；用户级新建（ensureRootEnabled=false）也不写
        Files.writeString(cfg, """{ "hooks": { "enabled": false, "events": { "Stop": [ { "hooks": [ { "command": "a.sh" } ] } ] } } }""")
        WorkspaceHooksCli.saveToConfig(cfg, payload(event = "Stop", command = "b.sh"), "user-hook-0-Stop-0-0", ensureRootEnabled = false)
        assertEquals("false", readAt(cfg)["hooks"]!!.jsonObject["enabled"]!!.jsonPrimitive.content)
        WorkspaceHooksCli.saveToConfig(configPath, payload(), null, ensureRootEnabled = false)
        assertFalse(readAt(configPath)["hooks"]!!.jsonObject.containsKey("enabled"))
    }
}
