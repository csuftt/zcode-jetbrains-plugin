package com.zcode.ideaplugin.protocol

import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * TaskIndexStore 单元测试：临时目录造 tasks-index + cli db 双库，真实 node:sqlite 进程执行
 *
 * 覆盖：归档补 UPSERT / 已有行仅动 archived（title/pinned 保留）/ 恢复（含清旧机制
 * time_archived）/ 软删（deleted=1 且 archived 位保留，对齐客户端实库语义；无行补删 +
 * 清旧机制位）/ listTasks / schema 不兼容 fail-soft
 */
class TaskIndexStoreTest {

    @TempDir
    lateinit var tmp: Path

    private lateinit var tasksDb: Path
    private lateinit var sessDb: Path
    private lateinit var store: TaskIndexStore

    // ============ 建库/查询工具（测试自身直跑 node，不经过被测代码） ============

    private fun node(vararg args: String, env: Map<String, String> = emptyMap()): String {
        val pb = ProcessBuilder("node", *args)
        env.forEach { (k, v) -> pb.environment()[k] = v }
        val p = pb.start()
        val out = p.inputStream.bufferedReader().readText()
        val err = p.errorStream.bufferedReader().readText()
        assertTrue(p.waitFor(30, TimeUnit.SECONDS), "node 超时: $err")
        assertEquals(0, p.exitValue(), "node 失败: $out$err")
        return out
    }

    /** 建表脚本：复刻真实 schema 投影（NOT NULL/主键约束与实库一致） */
    private fun createDbs() {
        tasksDb = tmp.resolve("tasks-index.sqlite")
        sessDb = tmp.resolve("db.sqlite")
        node("-e", """
            const {DatabaseSync} = require('node:sqlite');
            const t = new DatabaseSync(process.env.T);
            t.exec(`CREATE TABLE tasks (
              workspace_key TEXT NOT NULL,
              workspace_path TEXT NOT NULL,
              workspace_identity TEXT,
              task_id TEXT NOT NULL,
              title TEXT NOT NULL DEFAULT '',
              task_status TEXT,
              provider TEXT,
              mode TEXT NOT NULL DEFAULT 'build',
              model TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              unread_at INTEGER,
              last_unread_at INTEGER NOT NULL DEFAULT 0,
              pinned INTEGER NOT NULL DEFAULT 0,
              archived INTEGER NOT NULL DEFAULT 0,
              deleted INTEGER NOT NULL DEFAULT 0,
              title_overridden INTEGER NOT NULL DEFAULT 0,
              searchable_text TEXT NOT NULL DEFAULT '',
              meta_json TEXT NOT NULL DEFAULT '{}',
              PRIMARY KEY (workspace_key, task_id))`);
            const s = new DatabaseSync(process.env.S);
            s.exec(`CREATE TABLE session (
              id TEXT PRIMARY KEY,
              path TEXT,
              title TEXT,
              time_created INTEGER,
              time_updated INTEGER,
              time_archived INTEGER)`);
            s.prepare('INSERT INTO session (id, path, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?)')
              .run('sess_test-1', 'G:/proj/demo', '测试会话', 1000, 2000);
        """.trimIndent(), env = mapOf("T" to tasksDb.toString(), "S" to sessDb.toString()))
        store = TaskIndexStore("node", tasksDb)
    }

    /** 查 tasks 行（JSON）；无行返回 null */
    private fun taskRow(taskId: String): String? = node("-e", """
        const {DatabaseSync} = require('node:sqlite');
        const t = new DatabaseSync(process.env.T);
        const r = t.prepare('SELECT * FROM tasks WHERE task_id = ?').get(process.env.ID);
        console.log(r ? JSON.stringify(r) : 'null');
    """.trimIndent(), env = mapOf("T" to tasksDb.toString(), "ID" to taskId)).trim()

    /** 查 session.time_archived */
    private fun timeArchived(sessionId: String): String? = node("-e", """
        const {DatabaseSync} = require('node:sqlite');
        const s = new DatabaseSync(process.env.S);
        console.log(s.prepare('SELECT time_archived FROM session WHERE id = ?').get(process.env.ID).time_archived);
    """.trimIndent(), env = mapOf("S" to sessDb.toString(), "ID" to sessionId)).trim()

    // ============ 用例 ============

    @Test
    fun `archive upserts missing row with session meta`() {
        createDbs()
        store.setArchived("sess_test-1", sessDb, archive = true)
        val row = taskRow("sess_test-1")!!
        assertTrue("\"archived\":1" in row, "应补行且 archived=1: $row")
        assertTrue("\"title\":\"测试会话\"" in row, "补行 title 取自 session: $row")
        assertTrue("\"workspace_path\":\"G:/proj/demo\"" in row, "补行 workspace 取自 session.path: $row")
        assertTrue("\"meta_json\":\"{\\\"taskId\\\":\\\"sess_test-1\\\"}\"" in row, "meta_json 最小化: $row")
    }

    @Test
    fun `archive preserves existing row title and pinned`() {
        createDbs()
        // 预置客户端写入的行：自定义 title + pinned=1
        node("-e", """
            const {DatabaseSync} = require('node:sqlite');
            const t = new DatabaseSync(process.env.T);
            t.prepare(`INSERT INTO tasks (workspace_key, workspace_path, task_id, title, created_at, updated_at, pinned, meta_json)
              VALUES (?, ?, ?, '客户端起的标题', 100, 200, 1, '{}')`).run('G:/proj/demo', 'G:/proj/demo', 'sess_test-1');
        """.trimIndent(), env = mapOf("T" to tasksDb.toString()))
        store.setArchived("sess_test-1", sessDb, archive = true)
        val row = taskRow("sess_test-1")!!
        assertTrue("\"archived\":1" in row)
        assertTrue("\"title\":\"客户端起的标题\"" in row, "已有行 title 不被覆盖: $row")
        assertTrue("\"pinned\":1" in row, "已有行 pinned 不被覆盖: $row")
    }

    @Test
    fun `restore clears archived and legacy time_archived`() {
        createDbs()
        // 旧插件机制归档位（老版本用户升级场景：会话两个归档位可能同时在）
        node("-e", """
            const {DatabaseSync} = require('node:sqlite');
            const s = new DatabaseSync(process.env.S);
            s.prepare('UPDATE session SET time_archived = 999 WHERE id = ?').run('sess_test-1');
        """.trimIndent(), env = mapOf("S" to sessDb.toString()))

        store.setArchived("sess_test-1", sessDb, archive = true)
        store.setArchived("sess_test-1", sessDb, archive = false)

        val row = taskRow("sess_test-1")!!
        assertTrue("\"archived\":0" in row)
        assertEquals("null", timeArchived("sess_test-1"), "恢复应顺带清旧机制归档位 time_archived")
    }

    @Test
    fun `archive unknown session fails`() {
        createDbs()
        assertFailsWith<IllegalStateException> { store.setArchived("sess_missing", sessDb, archive = true) }
    }

    @Test
    fun `delete soft-deletes existing row keeping archived and title`() {
        createDbs()
        // 对齐客户端实库语义（2026-09-08）：删除归档会话只置 deleted=1，archived/title 不动
        store.setArchived("sess_test-1", sessDb, archive = true)
        store.setDeleted("sess_test-1", sessDb)
        val row = taskRow("sess_test-1")!!
        assertTrue("\"deleted\":1" in row, "删除应置 deleted=1: $row")
        assertTrue("\"archived\":1" in row, "客户端删除不清 archived 位: $row")
        assertTrue("\"title\":\"测试会话\"" in row, "删除不动 title: $row")
        assertTrue(!store.listTasks()[0].let { it.archived && !it.deleted }, "listArchived 口径（archived&&!deleted）应滤除已删行")
    }

    @Test
    fun `delete upserts missing row and clears legacy time_archived`() {
        createDbs()
        // 老版本插件归档的会话：tasks 无行 + time_archived 有值——删除必须双清，
        // 否则 listArchivedSessions 双源合并的旧机制分支仍会命中（删除不生效）
        node("-e", """
            const {DatabaseSync} = require('node:sqlite');
            const s = new DatabaseSync(process.env.S);
            s.prepare('UPDATE session SET time_archived = 999 WHERE id = ?').run('sess_test-1');
        """.trimIndent(), env = mapOf("S" to sessDb.toString()))

        store.setDeleted("sess_test-1", sessDb)

        val row = taskRow("sess_test-1")!!
        assertTrue("\"deleted\":1" in row, "无行应补删除行: $row")
        assertTrue("\"archived\":0" in row, "补删行 archived=0（旧机制位已清，归档态由 deleted 承载）: $row")
        assertEquals("null", timeArchived("sess_test-1"), "删除应顺带清旧机制归档位 time_archived")
    }

    @Test
    fun `autoArchive archives stale rows and backfills unindexed sessions`() {
        createDbs()
        // tasks 预置三行：过期 completed（应归档）/ pinned（豁免）/ 未过期（豁免）
        node("-e", """
            const {DatabaseSync} = require('node:sqlite');
            const t = new DatabaseSync(process.env.T);
            const ins = t.prepare(`INSERT INTO tasks (workspace_key, workspace_path, task_id, title, task_status, created_at, updated_at, pinned, meta_json)
              VALUES ('G:/proj/demo', 'G:/proj/demo', ?, ?, 'completed', 0, ?, ?, '{}')`);
            ins.run('sess_stale', '过期会话', 1000, 0);          // 过期 → 归档
            ins.run('sess_pinned', '置顶会话', 1000, 1);          // pinned → 豁免
            ins.run('sess_fresh', '新会话', Date.now() + 999999, 0); // 未过期 → 豁免
            const s = new DatabaseSync(process.env.S);
            // 基线行推到未来，避免混入补归档结果；再插入客户端未索引的插件会话（补行归档对象）
            s.prepare('UPDATE session SET time_updated = ? WHERE id = ?').run(Date.now() + 999999, 'sess_test-1');
            s.prepare('INSERT INTO session (id, path, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?)')
              .run('sess_backfill', 'G:/proj/demo', '补行会话', 1000, 1000);
        """.trimIndent(), env = mapOf("T" to tasksDb.toString(), "S" to sessDb.toString()))

        val archived = store.autoArchiveStale(sessDb, "G:\\proj\\demo", 7)

        // 双形态工作区匹配 + 两段合并：tasks 行 1 条 + 补行 1 条
        assertEquals(listOf("sess_stale", "sess_backfill"), archived.map { it.id }, "应归档过期行与补行，豁免 pinned/未过期: $archived")
        assertEquals(listOf("过期会话", "补行会话"), archived.map { it.title }, "条目应带标题")
        assertTrue("\"archived\":1" in taskRow("sess_stale")!!, "过期 completed 行应置 archived=1")
        assertTrue("\"archived\":0" in taskRow("sess_pinned")!!, "pinned 行豁免")
        assertTrue("\"archived\":0" in taskRow("sess_fresh")!!, "未过期行豁免")
        val backfill = taskRow("sess_backfill")!!
        assertTrue("\"archived\":1" in backfill, "无行会话应补行归档: $backfill")
        assertTrue("\"deleted\":0" in backfill, "补归档行非软删")
    }

    @Test
    fun `autoArchive does not archive non-completed or recently active sessions`() {
        createDbs()
        node("-e", """
            const {DatabaseSync} = require('node:sqlite');
            const t = new DatabaseSync(process.env.T);
            const ins = t.prepare(`INSERT INTO tasks (workspace_key, workspace_path, task_id, title, task_status, created_at, updated_at, pinned, meta_json)
              VALUES ('G:/proj/demo', 'G:/proj/demo', ?, ?, ?, 0, ?, 0, '{}')`);
            ins.run('sess_running', '进行中', 'running', 1000);      // 非 completed → 豁免
            ins.run('sess_deleted', '已删', 'completed', 1000);       // 需单独置 deleted=1
            t.prepare('UPDATE tasks SET deleted = 1 WHERE task_id = ?').run('sess_deleted');
            // 基线行推到未来，避免混入补归档结果
            const s = new DatabaseSync(process.env.S);
            s.prepare('UPDATE session SET time_updated = ? WHERE id = ?').run(Date.now() + 999999, 'sess_test-1');
        """.trimIndent(), env = mapOf("T" to tasksDb.toString(), "S" to sessDb.toString()))

        val archived = store.autoArchiveStale(sessDb, "G:/proj/demo", 7)

        assertTrue(archived.isEmpty(), "running/deleted 行都不应归档: $archived")
    }

    @Test
    fun `listTasks reads back rows and caches by fingerprint`() {
        createDbs()
        assertTrue(store.listTasks().isEmpty(), "初始空")
        store.setArchived("sess_test-1", sessDb, archive = true)
        val rows = store.listTasks()
        assertEquals(1, rows.size)
        assertEquals("sess_test-1", rows[0].taskId)
        assertTrue(rows[0].archived)
        assertTrue(!rows[0].deleted)
        assertEquals("G:/proj/demo", rows[0].workspacePath)
        // 写操作主动失效缓存 + 指纹缓存命中
        store.setArchived("sess_test-1", sessDb, archive = false)
        assertTrue(!store.listTasks()[0].archived, "缓存应已失效并读到新值")
    }

    @Test
    fun `listTasks on missing db returns empty`() {
        createDbs()
        Files.delete(tasksDb)
        assertTrue(store.listTasks().isEmpty(), "客户端未装（库缺失）应返回空")
    }

    @Test
    fun `schema mismatch disables store fail-soft`() {
        // 造缺列库（无 pinned/deleted 列）
        tasksDb = tmp.resolve("bad-tasks.sqlite")
        sessDb = tmp.resolve("db2.sqlite")
        node("-e", """
            const {DatabaseSync} = require('node:sqlite');
            const t = new DatabaseSync(process.env.T);
            t.exec('CREATE TABLE tasks (task_id TEXT, workspace_path TEXT, archived INTEGER, updated_at INTEGER)');
            const s = new DatabaseSync(process.env.S);
            s.exec('CREATE TABLE session (id TEXT PRIMARY KEY, path TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)');
        """.trimIndent(), env = mapOf("T" to tasksDb.toString(), "S" to sessDb.toString()))
        store = TaskIndexStore("node", tasksDb)

        assertTrue(store.listTasks().isEmpty(), "schema 不兼容 listTasks 降级为空")
        assertFailsWith<IllegalStateException>("schema 不兼容归档应报错") {
            store.setArchived("sess_x", sessDb, archive = true)
        }
    }

    companion object {
        @JvmStatic
        @BeforeAll
        fun requireNode() {
            val ok = try {
                val p = ProcessBuilder("node", "--version").start()
                p.waitFor(10, TimeUnit.SECONDS) && p.exitValue() == 0
            } catch (e: Exception) { false }
            assumeTrue(ok, "node 不在 PATH，跳过 TaskIndexStore 测试")
        }
    }
}
