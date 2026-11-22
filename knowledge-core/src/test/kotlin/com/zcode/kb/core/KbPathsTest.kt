package com.zcode.kb.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path

/**
 * 双根位置解析与旧 pointer 迁移：snapshotDir 三分支（缺省/自定义/损坏）、
 * migrateLegacyPointer（元数据回位/快照留原地/冲突放弃/残留清理）、moveDirectory。
 */
class KbPathsTest {

    @TempDir
    lateinit var home: Path

    private fun pointer(): Path = home.resolve(".zcgui/knowledge.location.json")

    private fun writeJson(path: Path, content: String) {
        Files.createDirectories(path.parent)
        Files.writeString(path, content)
    }

    private fun jsonEscape(p: Path): String = p.toString().replace("\\", "\\\\")

    @Test
    fun `snapshotDir defaults to metadata root when config missing or field empty`() {
        val root = KbPaths.rootDir(home.toString())
        assertEquals(root, KbPaths.snapshotDir(home.toString())) // 无 config
        writeJson(KbPaths.configFile(home.toString()), """{"version":2,"snapshotDir":""}""")
        assertEquals(root, KbPaths.snapshotDir(home.toString())) // 空字段
        // 派生目录随默认根
        assertEquals(root.resolve("text"), KbPaths.textDir(home.toString()))
        assertEquals(root.resolve("restored"), KbPaths.restoredDir(home.toString()))
    }

    @Test
    fun `snapshotDir honors config field and falls back on corrupt or invalid`() {
        val custom = home.resolve("d-drive/kb-snap")
        writeJson(KbPaths.configFile(home.toString()), """{"version":2,"snapshotDir":"${jsonEscape(custom)}"}""")
        assertEquals(custom, KbPaths.snapshotDir(home.toString()))
        assertEquals(custom.resolve("text"), KbPaths.textDir(home.toString()))
        assertEquals(custom.resolve("restored"), KbPaths.restoredDir(home.toString()))
        writeJson(KbPaths.configFile(home.toString()), "{broken json")
        assertEquals(KbPaths.rootDir(home.toString()), KbPaths.snapshotDir(home.toString())) // 损坏回默认
        writeJson(KbPaths.configFile(home.toString()), """{"snapshotDir":"relative/no-absolute"}""")
        assertEquals(KbPaths.rootDir(home.toString()), KbPaths.snapshotDir(home.toString())) // 相对路径回默认
    }

    @Test
    fun `migrateLegacyPointer moves metadata back and keeps snapshots in place`() {
        val custom = home.resolve("custom-kb")
        // 旧布局：整库在 custom（entries + config + text）
        Files.createDirectories(custom.resolve("entries"))
        writeJson(custom.resolve("config.json"), """{"version":2,"folders":[]}""")
        writeJson(custom.resolve("entries/kb-1.json"), """{"id":"kb-1","sourcePath":"x"}""")
        writeJson(custom.resolve("text/kb-1.txt"), "缓存正文")
        writeJson(pointer(), """{"root":"${jsonEscape(custom)}"}""")

        assertTrue(KbPaths.migrateLegacyPointer(home.toString()))

        // 元数据回默认根
        assertTrue(Files.exists(KbPaths.entriesDir(home.toString()).resolve("kb-1.json")))
        assertTrue(Files.exists(KbPaths.configFile(home.toString())))
        assertFalse(Files.exists(custom.resolve("entries"))) // 整目录搬走
        // 快照留原地 + config 记快照根
        assertEquals("缓存正文", Files.readString(custom.resolve("text/kb-1.txt")))
        assertEquals(custom, KbPaths.snapshotDir(home.toString()))
        // pointer 清除，二次调用幂等（无 pointer = 无动作）
        assertFalse(Files.exists(pointer()))
        assertFalse(KbPaths.migrateLegacyPointer(home.toString()))
    }

    @Test
    fun `migrateLegacyPointer gives up on conflicting default root`() {
        val custom = home.resolve("custom-kb")
        Files.createDirectories(custom.resolve("entries"))
        writeJson(custom.resolve("entries/kb-1.json"), """{"id":"kb-1"}""")
        // 默认根已有元数据（写死路径——entriesDir(home) 此刻会被已写入的 pointer 解析到 custom）
        writeJson(home.resolve(".zcgui/knowledge/entries/kb-9.json"), """{"id":"kb-9"}""")
        writeJson(pointer(), """{"root":"${jsonEscape(custom)}"}""")

        assertFalse(KbPaths.migrateLegacyPointer(home.toString())) // 保守放弃
        // pointer 保留（下次重试），两侧数据均未动
        assertTrue(Files.exists(pointer()))
        assertTrue(Files.exists(custom.resolve("entries/kb-1.json")))
        // 断言同样写死路径（entriesDir(home) 被 pointer 污染解析到 custom）
        assertTrue(Files.exists(home.resolve(".zcgui/knowledge/entries/kb-9.json")))
    }

    @Test
    fun `migrateLegacyPointer removes stale pointer only`() {
        writeJson(pointer(), """{"root":"${jsonEscape(home.resolve("not-a-real-dir"))}"}""")
        assertFalse(KbPaths.migrateLegacyPointer(home.toString())) // 库不存在：仅清 pointer
        assertFalse(Files.exists(pointer()))
        writeJson(pointer(), "{broken")
        assertFalse(KbPaths.migrateLegacyPointer(home.toString())) // 损坏：仅清 pointer
        assertFalse(Files.exists(pointer()))
    }

    @Test
    fun `moveDirectory relocates tree and removes source`() {
        val src = home.resolve("a/text")
        Files.createDirectories(src.resolve("sub"))
        Files.writeString(src.resolve("f.txt"), "x")
        Files.writeString(src.resolve("sub/g.txt"), "y")
        val dst = home.resolve("b/text")
        KbPaths.moveDirectory(src, dst)
        assertFalse(Files.exists(src))
        assertEquals("x", Files.readString(dst.resolve("f.txt")))
        assertEquals("y", Files.readString(dst.resolve("sub/g.txt")))
    }
}
