package com.zcode.ideaplugin.env

import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * ZCodeEnvChecker 单元测试
 *
 * 纯逻辑部分（版本解析/状态判定/JSON 契约/存储注入）全环境可跑；
 * check()/resolveForStart() 真机验证（前置：本机 PATH 有 node ≥18、ZCode 已安装、已登录），
 * 与 SkillScannerTest 同风格。
 */
class ZCodeEnvCheckerTest {

    /** 可写内存存储 */
    private class WritableStore : ZCodeEnvChecker.EnvStore {
        val map = mutableMapOf<String, String>()
        override fun get(key: String): String? = map[key]
        override fun set(key: String, value: String?) {
            if (value == null) map.remove(key) else map[key] = value
        }
    }

    @AfterTest
    fun cleanup() {
        ZCodeEnvChecker.setStoreForTest(WritableStore()) // 清理测试注入，恢复无副作用状态
    }

    // ============ 版本解析 ============

    @Test
    fun `parseMajorVersion 各形态解析`() {
        assertEquals(20, ZCodeEnvChecker.parseMajorVersion("v20.11.1"))
        assertEquals(18, ZCodeEnvChecker.parseMajorVersion("18.20.0"))
        assertEquals(16, ZCodeEnvChecker.parseMajorVersion("v16.20.2"))
        assertEquals(null, ZCodeEnvChecker.parseMajorVersion(null))
        assertEquals(null, ZCodeEnvChecker.parseMajorVersion(""))
        assertEquals(null, ZCodeEnvChecker.parseMajorVersion("abc"))
        assertEquals(null, ZCodeEnvChecker.parseMajorVersion("node"))
    }

    // ============ 状态判定 ============

    private fun okNode() = NodeStatus(
        configured = false, path = "/usr/bin/node", found = true,
        version = "v20.11.1", versionTooLow = false, minVersion = 18, error = null,
    )

    private fun okCli() = CliStatus(configured = false, path = "/opt/zcode.cjs", found = true, error = null)

    private fun okCred() = CredentialStatus(ok = true, model = "glm-4.7", error = null)

    @Test
    fun `allOk 三件套齐备才为真`() {
        assertTrue(EnvStatus(okNode(), okCli(), okCred()).allOk)
        assertFalse(EnvStatus(okNode().copy(found = false), okCli(), okCred()).allOk)
        assertFalse(EnvStatus(okNode(), okCli().copy(found = false), okCred()).allOk)
        assertFalse(EnvStatus(okNode(), okCli(), okCred().copy(ok = false)).allOk)
        // 版本过低 = node 不可用
        assertFalse(EnvStatus(okNode().copy(version = "v16.20.2", versionTooLow = true), okCli(), okCred()).allOk)
    }

    @Test
    fun `firstProblem 按优先级给出可读原因`() {
        val nodeMissing = EnvStatus(
            okNode().copy(found = false, error = "未在系统 PATH 中找到 Node.js"), okCli(), okCred(),
        )
        assertTrue(ZCodeEnvChecker.firstProblem(nodeMissing).contains("Node.js 不可用"))

        val tooLow = EnvStatus(
            okNode().copy(version = "v16.20.2", versionTooLow = true), okCli(), okCred(),
        )
        val msg = ZCodeEnvChecker.firstProblem(tooLow)
        assertTrue(msg.contains("版本过低") && msg.contains("v16.20.2"), "应含版本号: $msg")

        val cliMissing = EnvStatus(okNode(), okCli().copy(found = false, error = "zcode.cjs 不存在"), okCred())
        assertTrue(ZCodeEnvChecker.firstProblem(cliMissing).contains("ZCode CLI"))

        val credBad = EnvStatus(okNode(), okCli(), okCred().copy(ok = false, error = "配置文件不存在"))
        assertTrue(ZCodeEnvChecker.firstProblem(credBad).contains("凭证"))
    }

    // ============ 存储注入 ============

    @Test
    fun `配置路径保存读取与清空`() {
        val store = WritableStore()
        ZCodeEnvChecker.setStoreForTest(store)

        ZCodeEnvChecker.saveNodePath("  C:\\nvm\\node.exe  ")
        assertEquals("C:\\nvm\\node.exe", ZCodeEnvChecker.configuredNodePath(), "应去除首尾空白")

        ZCodeEnvChecker.saveNodePath("")
        assertEquals(null, ZCodeEnvChecker.configuredNodePath(), "空串视为未配置")

        ZCodeEnvChecker.saveCliPath("D:\\zcode.cjs")
        assertEquals("D:\\zcode.cjs", ZCodeEnvChecker.configuredCliPath())
        ZCodeEnvChecker.clearCliPath()
        assertEquals(null, ZCodeEnvChecker.configuredCliPath())
    }

    // ============ 路径验证（不依赖本机环境） ============

    @Test
    fun `verifyNodePath 不存在路径直接失败`() {
        val probe = ZCodeEnvChecker.verifyNodePath("Z:\\definitely\\not\\exist\\node.exe")
        assertFalse(probe.found)
        assertNotNull(probe.error)
        assertTrue(probe.error!!.contains("文件不存在"), "错误信息应含原因: ${probe.error}")
    }

    // ============ check 全流程（真机前置） ============

    @Test
    fun `check 自动探测环境三件套`() {
        // 前置：本机 PATH 有 node、ZCode 标准位置安装、~/.zcode/v2/config.json 已登录
        ZCodeEnvChecker.setStoreForTest(WritableStore())
        val s = ZCodeEnvChecker.check(force = true)
        println("✅ 环境检测: allOk=${s.allOk}, node=${s.node.path} ${s.node.version}, cli=${s.cli.path}, cred=${s.credentials.model}")

        assertTrue(s.node.found, "本机 PATH 应有 node（否则请先安装）: ${s.node.error}")
        assertTrue(s.node.versionTooLow.not(), "本机 node 应 ≥ 18: ${s.node.version}")
        assertTrue(s.cli.found, "本机应有标准位置 ZCode: ${s.cli.error}")
        assertTrue(s.credentials.ok, "本机应已登录 ZCode: ${s.credentials.error}")
        assertTrue(s.allOk)
    }

    @Test
    fun `check 配置无效 cli 路径不回退且 allOk 为假`() {
        val store = WritableStore()
        store.map[ZCodeEnvChecker.KEY_CLI_PATH] = "Z:\\not\\exist\\zcode.cjs"
        ZCodeEnvChecker.setStoreForTest(store)

        val s = ZCodeEnvChecker.check(force = true)
        assertFalse(s.cli.found, "配置路径无效应 found=false")
        assertTrue(s.cli.configured, "应标记为用户配置过")
        assertFalse(s.allOk)

        val ex = kotlin.runCatching { ZCodeEnvChecker.resolveForStart() }.exceptionOrNull()
        assertTrue(ex is EnvCheckException, "resolveForStart 应抛 EnvCheckException")
        assertEquals(false, (ex as EnvCheckException).status.allOk)
        assertTrue(ex.message!!.contains("ZCode CLI"), "异常消息应指向 CLI 问题: ${ex.message}")
    }

    // ============ JSON 契约 ============

    @Test
    fun `statusJson 字段结构与前端契约对齐`() {
        val json = ZCodeEnvChecker.statusJson(EnvStatus(okNode(), okCli(), okCred()))
        val node = json["node"]!!.jsonObject
        assertEquals("/usr/bin/node", node["path"]!!.jsonPrimitive.content)
        assertEquals("v20.11.1", node["version"]!!.jsonPrimitive.content)
        assertEquals(18, node["minVersion"]!!.jsonPrimitive.content.toInt())
        val cred = json["credentials"]!!.jsonObject
        assertEquals("glm-4.7", cred["model"]!!.jsonPrimitive.content)
        assertEquals(true, json["allOk"]!!.jsonPrimitive.content.toBoolean())

        // null 字段应省略（putOrNull）
        val bad = ZCodeEnvChecker.statusJson(
            EnvStatus(
                NodeStatus(true, null, false, null, false, 18, "文件不存在"),
                CliStatus(false, null, false, "未找到"),
                CredentialStatus(false, null, "未登录"),
            ),
        )
        assertTrue("path" !in bad["node"]!!.jsonObject, "null path 应省略")
        assertTrue("version" !in bad["node"]!!.jsonObject)
        assertFalse(bad["allOk"]!!.jsonPrimitive.content.toBoolean())
    }
}
