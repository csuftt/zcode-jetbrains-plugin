package com.zcode.ideaplugin.protocol

import kotlinx.serialization.json.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path
import java.util.concurrent.TimeUnit
import kotlin.io.path.writeText
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * fork 会话 sqlite 补查脚本回归（fork24 定案的转义坑回归锁）：
 * Windows 上 Java ProcessBuilder 传 `-e` 脚本参数的转义链会把 JS **双引号**弄坏
 * （Java→CreateProcess→node argv 解析），node 收到残缺脚本 SyntaxError exit 1、
 * 零输出——真实机故障形态为「补查静默失效」（fail-soft 吞掉，列表少 fork 会话）。
 * 本测试用临时 sqlite 库跑真实 node + 真实 [FORK_SESSIONS_JS]，锁三件事：
 * ①脚本在 ProcessBuilder 传参下可执行（exit=0 有输出，双引号回归即挂此处）；
 * ②task_type='fork' 过滤正确（subagent_child/普通行不混入）；
 * ③directory 双形态（反斜杠/正斜杠）都命中。
 *
 * node 依赖与 ForkSessionTest 假服务器同源（PATH），无新增环境要求。
 */
class ForkSessionsQueryTest {

    @TempDir
    lateinit var tempDir: Path

    /** 造最小 session 表：2 个 fork（双形态目录）+1 个 subagent_child+1 个普通，跑真实脚本 */
    @Test
    fun `fork query script runs via ProcessBuilder and filters correctly`() {
        val dbFile = tempDir.resolve("fake-cli.sqlite")
        val setupJs = """
            const {DatabaseSync} = require('node:sqlite');
            const db = new DatabaseSync(process.env.SETUP_DB);
            db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, task_type TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)`);
            const ins = db.prepare(`INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)`);
            ins.run('sess_fork_a', 'sess_root', 'G:\\proj', 'fork', 'Fork of A', 1, 10);
            ins.run('sess_fork_b', 'sess_root', 'G:/proj', 'fork', 'Fork of B', 2, 20);
            ins.run('sess_sub', 'sess_root', 'G:\\proj', 'subagent_child', 'sub', 3, 30);
            ins.run('sess_normal', null, 'G:\\proj', 'interactive', 'N', 4, 40);
            ins.run('sess_fork_other', 'sess_root', 'G:\\other', 'fork', 'other proj', 5, 50);
            ins.run('sess_goal_a', null, 'G:\\proj', 'interactive', 'Goal A', 6, 60);
            db.exec(`CREATE TABLE session_target (session_id TEXT, target_id TEXT, objective TEXT, status TEXT, time_updated INTEGER)`);
            const insT = db.prepare(`INSERT INTO session_target VALUES (?, ?, ?, ?, ?)`);
            insT.run('sess_goal_a', 'tgt1', 'obj', 'complete', 1);
            insT.run('sess_fork_a', 'tgt2', 'obj', 'active', 2);
            insT.run('sess_goal_other', 'tgt3', 'obj', 'complete', 3);
        """.trimIndent()
        runNode(setupJs, mapOf("SETUP_DB" to dbFile.toString()))
        assertTrue(java.nio.file.Files.exists(dbFile), "临时库应创建成功")

        // 真实脚本 + 双形态目录参数（复刻 queryForkSessionsFromDb 的调用形态）
        val out = runNode(SESSION_LIST_EXTRAS_JS, mapOf(
            "ZCODE_FORK_DB" to dbFile.toString(),
            "ZCODE_FORK_DIR_NATIVE" to "G:\\proj",
            "ZCODE_FORK_DIR_ALT" to "G:/proj",
        ))
        val o = Json.parseToJsonElement(out.trim()).jsonObject
        val rows = o["forks"]!!.jsonArray.map { it.jsonObject }
        assertEquals(2, rows.size, "应恰好命中两个 fork（双形态各一），排除 subagent/普通/他项目：$rows")
        val ids = rows.map { it["id"]!!.jsonPrimitive.content }.toSet()
        assertEquals(setOf("sess_fork_a", "sess_fork_b"), ids, "双形态 directory 都应命中")
        assertTrue(rows.all { it["title"]!!.jsonPrimitive.content.startsWith("Fork of") }, "title 应带出")
        // goal 补查：session_target 有行即算（active/complete 都标），限定本工作区双形态
        val goals = o["goalIds"]!!.jsonArray.map { it.jsonPrimitive.content }.toSet()
        assertEquals(setOf("sess_goal_a", "sess_fork_a"), goals, "goal 会话 id 集（含 fork+goal 复合），排除他项目")
    }

    private fun runNode(script: String, env: Map<String, String>): String {
        val pb = ProcessBuilder(findNodeInPath(), "-e", script)
        pb.environment().putAll(env)
        pb.redirectError(ProcessBuilder.Redirect.INHERIT)
        val p = pb.start()
        val out = p.inputStream.bufferedReader().readText()
        assertTrue(p.waitFor(30, TimeUnit.SECONDS), "node 脚本应正常退出")
        assertEquals(0, p.exitValue(), "node 脚本 exit=0（非零多为 -e 脚本被 ProcessBuilder 转义弄坏 → SyntaxError）：out=$out")
        return out
    }

    private fun findNodeInPath(): String {
        val names = listOf("node.exe", "node")
        System.getenv("PATH")?.split(";")?.forEach { dir ->
            names.forEach { n ->
                val f = Path.of(dir).resolve(n).toFile()
                if (f.exists()) return f.toString()
            }
        }
        throw IllegalStateException("PATH 中找不到 node（测试环境需与 ForkSessionTest 一致的 node）")
    }
}
