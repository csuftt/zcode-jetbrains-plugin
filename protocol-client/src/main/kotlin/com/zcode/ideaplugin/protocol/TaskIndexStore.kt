package com.zcode.ideaplugin.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import java.nio.file.Files
import java.nio.file.Path

/**
 * ZCode 客户端任务索引（~/.zcode/v2/tasks-index.sqlite）读写器
 *
 * 归档/恢复与 ZCode 桌面客户端共用同一数据源（tasks.archived 位），实现两端列表一致：
 * - 插件归档 → 客户端列表（下次重读库时）同步隐藏；客户端归档（含自动归档）→ 插件同步隐藏
 * - 客户端归档后会话在其侧无恢复入口，插件的「已归档」列表成为唯一恢复出口
 *
 * 实测依据（2026-08-23，客户端 0.16.x app.asar + 实库分析）：
 * - tasks 表复合主键 (workspace_key, task_id)；本地任务 workspace_key = workspace_path
 * - 客户端写库为逐行 UPSERT（INSERT ... ON CONFLICT DO UPDATE），对行操作前重读库值
 *   再 patch 未指定字段——插件并发直写不会被客户端内存态回滚，可安全共写
 * - WAL 模式无文件监听：插件恢复的会话要等客户端重启/切项目/刷新才重新出现
 * - tasks 索引不含插件创建的会话（客户端只索引自己开过的），归档时须补 UPSERT 行
 *
 * 兼容既有用户：老版本插件归档位（session.time_archived）不迁移不改写——已归档列表
 * 双源合并查询（见 ZCodeProtocolClient.listArchivedSessions），恢复时两处归档位一并清除。
 *
 * schema fail-soft：tasks-index 是客户端私有库，无兼容承诺。启动后首次访问校验关键列，
 * 缺列则本进程内禁用（列表过滤跳过、归档操作报错），客户端升级修复后重启 IDE 恢复。
 *
 * 实现沿用 deleteSessionFromDb 的 node:sqlite 内联脚本模式（Node 22+ 内置，
 * 无 JVM sqlite 依赖）；参数经环境变量传（Windows node -e 命令行参数坑）。
 */
class TaskIndexStore(
    private val nodePath: String,
    private val dbPath: Path,
) {

    /** tasks 表行投影（全量仅数百行，Kotlin 侧过滤） */
    data class TaskRow(
        val taskId: String,
        val workspacePath: String,
        val archived: Boolean,
        val deleted: Boolean,
        val updatedAt: Long,
    )

    /** schema 不兼容标记（进程级；exit code 2 置位）。置位后 listTasks 返回空、写入抛异常 */
    @Volatile
    private var unavailable = false

    // 读缓存：db 指纹（主库+WAL 的 mtime:size）→ 行列表，客户端任何写入都会改变指纹
    @Volatile
    private var cache: Pair<String, List<TaskRow>>? = null

    /** 列出全部任务行（含归档/软删）。库不存在（客户端未装）返回空；命中缓存免 node 进程 */
    fun listTasks(): List<TaskRow> {
        if (unavailable) return emptyList()
        if (!Files.exists(dbPath)) return emptyList()
        val fp = fingerprint()
        cache?.let { (k, v) -> if (k == fp) return v }
        val out = runNode(TASKS_LIST_JS, onSchemaMismatch = { unavailable = true })
        if (unavailable) return emptyList()
        val rows = Json.parseToJsonElement(out.trim()).jsonArray.map { e ->
            val o = e.jsonObject
            TaskRow(
                taskId = o["task_id"]!!.jsonPrimitive.content,
                workspacePath = o["workspace_path"]!!.jsonPrimitive.content,
                archived = o["archived"]!!.jsonPrimitive.long == 1L,
                deleted = o["deleted"]!!.jsonPrimitive.long == 1L,
                updatedAt = o["updated_at"]!!.jsonPrimitive.long,
            )
        }
        cache = fp to rows
        return rows
    }

    /**
     * 归档/恢复会话：读 db.sqlite session 行取 meta（title/时间/工作区），UPSERT 进 tasks 表。
     *
     * 会话在 tasks 无行（插件创建、客户端未索引）时补全字段的 INSERT；已有行仅动
     * archived/updated_at（同客户端 UPSERT 语义，不覆盖 title/pinned 等）。
     * workspace_key 防御：已存在行沿用其 key（避免 path 分隔符形态差异产生重复行）。
     *
     * restore 时无条件清 session.time_archived（旧插件机制归档位）——老版本归档的
     * 既有用户会话靠这一步真正恢复；值本就 NULL 时是幂等空操作。
     */
    fun setArchived(sessionId: String, sessionDbPath: Path, archive: Boolean) {
        checkAvailable()
        if (!Files.exists(sessionDbPath)) throw IllegalStateException("db.sqlite 不存在: $sessionDbPath")
        if (!Files.exists(dbPath)) throw IllegalStateException("tasks-index.sqlite 不存在（ZCode 客户端未初始化）: $dbPath")
        runNode(TASKS_UPSERT_JS, mapOf(
            "ZCODE_TASKS_SID" to sessionId,
            "ZCODE_TASKS_MODE" to if (archive) "archive" else "restore",
            "ZCODE_SESS_DB" to sessionDbPath.toString(),
        ), onSchemaMismatch = { unavailable = true })
        checkAvailable() // schema 不兼容时转为统一异常（写入不允许静默失败）
        cache = null
    }

    private fun checkAvailable() {
        if (unavailable) {
            throw IllegalStateException("ZCode 客户端任务索引 schema 不兼容，归档功能已禁用（重启 IDE 可重试）")
        }
    }

    /** 主库 + WAL 双文件指纹；wal 不存在（库刚 checkpoint/测试临时库）用 absent 占位 */
    private fun fingerprint(): String {
        val wal = dbPath.resolveSibling(dbPath.fileName.toString() + "-wal")
        return listOf(dbPath, wal).joinToString("|") { p ->
            if (!Files.exists(p)) "absent"
            else {
                val attr = Files.readAttributes(p, java.nio.file.attribute.BasicFileAttributes::class.java)
                "${attr.lastModifiedTime().toMillis()}:${attr.size()}"
            }
        }
    }

    /**
     * 通用 node 执行器。exit 0 返回 stdout；exit 2（schema 不兼容）触发 onSchemaMismatch
     * 后返回空串（调用方按 unavailable 语义降级或抛错）；其他非 0 抛业务错误。
     */
    private fun runNode(
        script: String,
        extraEnv: Map<String, String> = emptyMap(),
        onSchemaMismatch: () -> Unit = {},
    ): String {
        val pb = ProcessBuilder(nodePath, "-e", script)
        pb.environment()["ZCODE_TASKS_DB"] = dbPath.toString()
        extraEnv.forEach { (k, v) -> pb.environment()[k] = v }
        // 统一执行器：stdout 并发读 + stderr 异步 drain（先 waitFor 后读输出会因
        // 管道缓冲死锁——getSessionStats/stderr 4KB 两次实踩的同型坑）
        val r = SubprocessUtil.runForOutput(pb, 15, "tasks-index 操作超时")
        if (r.exitValue == 2) {
            onSchemaMismatch()
            return ""
        }
        if (r.exitValue != 0) {
            throw IllegalStateException("tasks-index 操作失败: ${r.err.ifBlank { r.out }}")
        }
        return r.out
    }
}

/** 全量读 tasks 表（task_id 全局唯一，Kotlin 侧按需过滤）。库缺失输出空数组（客户端未装） */
private val TASKS_LIST_JS = """
    const {DatabaseSync} = require('node:sqlite');
    const fs = require('fs');
    const p = process.env.ZCODE_TASKS_DB;
    if (!fs.existsSync(p)) { console.log('[]'); process.exit(0); }
    const db = new DatabaseSync(p);
    db.exec('PRAGMA busy_timeout = 5000');
    const need = ['task_id','workspace_path','archived','deleted','updated_at'];
    const cols = db.prepare('PRAGMA table_info(tasks)').all().map(c => c.name);
    const missing = need.filter(c => !cols.includes(c));
    if (missing.length) { console.error('ERR:SCHEMA:' + missing.join(',')); process.exit(2); }
    const rows = db.prepare('SELECT task_id, workspace_path, archived, deleted, updated_at FROM tasks').all();
    console.log(JSON.stringify(rows));
""".trimIndent()

/**
 * 归档/恢复：session 表读 meta → tasks 表 UPSERT。
 * NOT NULL 列全覆盖（task_status='completed'/mode='build'/meta_json 最小化），
 * 已有行仅更新 archived/updated_at。
 */
private val TASKS_UPSERT_JS = """
    const {DatabaseSync} = require('node:sqlite');
    const sid = process.env.ZCODE_TASKS_SID;
    const archive = process.env.ZCODE_TASKS_MODE === 'archive' ? 1 : 0;
    const sessDb = new DatabaseSync(process.env.ZCODE_SESS_DB);
    sessDb.exec('PRAGMA busy_timeout = 5000');
    const tdb = new DatabaseSync(process.env.ZCODE_TASKS_DB);
    tdb.exec('PRAGMA busy_timeout = 15000');
    const need = ['workspace_key','workspace_path','task_id','title','mode','created_at','updated_at','last_unread_at','pinned','archived','deleted','title_overridden','searchable_text','meta_json'];
    const cols = tdb.prepare('PRAGMA table_info(tasks)').all().map(c => c.name);
    const missing = need.filter(c => !cols.includes(c));
    if (missing.length) { console.error('ERR:SCHEMA:' + missing.join(',')); process.exit(2); }
    const s = sessDb.prepare('SELECT id, title, path, time_created, time_updated FROM session WHERE id = ?').get(sid);
    if (!s) { console.error('ERR: session not found: ' + sid); process.exit(1); }
    const existing = tdb.prepare('SELECT workspace_key FROM tasks WHERE task_id = ?').get(sid);
    const wsKey = existing ? existing.workspace_key : s.path;
    tdb.exec('BEGIN IMMEDIATE');
    try {
      tdb.prepare(`INSERT INTO tasks (
          workspace_key, workspace_path, task_id, title, task_status, mode,
          created_at, updated_at, last_unread_at, pinned, archived, deleted,
          title_overridden, searchable_text, meta_json
        ) VALUES (?, ?, ?, ?, 'completed', 'build', ?, ?, 0, 0, ?, 0, 0, '', ?)
        ON CONFLICT(workspace_key, task_id) DO UPDATE SET
          archived = excluded.archived,
          updated_at = excluded.updated_at
      `).run(wsKey, s.path, sid, s.title || '(未命名会话)', s.time_created ?? Date.now(), Date.now(), archive, JSON.stringify({taskId: sid}));
      tdb.exec('COMMIT');
      // restore：清旧插件机制归档位（time_archived；NULL 时幂等空操作）
      if (archive === 0) sessDb.prepare('UPDATE session SET time_archived = NULL WHERE id = ?').run(sid);
      console.log('ok');
    } catch (e) {
      try { tdb.exec('ROLLBACK'); } catch(_){}
      console.error('ERR: ' + e.message); process.exit(1);
    }
""".trimIndent()

