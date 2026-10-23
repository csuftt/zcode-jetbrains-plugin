package com.zcode.ideaplugin.env

import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * ZCodeEnvChecker 单元测试
 *
 * 纯逻辑部分（版本解析/状态判定/JSON 契约/存储注入）全环境可跑；
 * check()/resolveForStart() 真机验证（前置：本机 PATH 有 node ≥18、ZCode 已安装），
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
        ZCodeEnvChecker.setBrowserHostProbe(null)
        ZCodeEnvChecker.setCdpEndpointProbe(null)
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

    @Test
    fun `allOk node cli 齐备才为真`() {
        assertTrue(EnvStatus(okNode(), okCli()).allOk)
        assertFalse(EnvStatus(okNode().copy(found = false), okCli()).allOk)
        assertFalse(EnvStatus(okNode(), okCli().copy(found = false)).allOk)
        // 版本过低 = node 不可用
        assertFalse(EnvStatus(okNode().copy(version = "v16.20.2", versionTooLow = true), okCli()).allOk)
    }

    // ============ browserHost（非阻断宿主检查） ============

    @Test
    fun `browserHost 异常不影响 allOk`() {
        val hostDown = EnvStatus(okNode(), okCli(), BrowserHostStatus(false, "CDP 不可达", "browserHostCefDown"))
        assertTrue(hostDown.allOk, "宿主故障只是建议性告警，不阻断 app-server 启动")
    }

    @Test
    fun `statusJson browserHost 序列化与 null 省略`() {
        // 探针缺席（未初始化）：JSON 不含 browserHost 节点（旧前端兼容）
        val absent = ZCodeEnvChecker.statusJson(EnvStatus(okNode(), okCli()))
        assertTrue("browserHost" !in absent, "null browserHost 应省略节点")

        // 健康：ok=true，无 code
        val ok = ZCodeEnvChecker.statusJson(
            EnvStatus(okNode(), okCli(), BrowserHostStatus(true, null)),
        )
        assertTrue(ok["browserHost"]!!.jsonObject["ok"]!!.jsonPrimitive.content.toBoolean())
        assertTrue("code" !in ok["browserHost"]!!.jsonObject)

        // 故障：ok=false + 机器可读 code
        val down = ZCodeEnvChecker.statusJson(
            EnvStatus(okNode(), okCli(), BrowserHostStatus(false, "CDP 不可达", "browserHostCefDown")),
        )
        val bh = down["browserHost"]!!.jsonObject
        assertEquals(false, bh["ok"]!!.jsonPrimitive.content.toBoolean())
        assertEquals("browserHostCefDown", bh["code"]!!.jsonPrimitive.content)
    }

    @Test
    fun `check 组装宿主探针且探针异常不炸检测`() {
        ZCodeEnvChecker.setStoreForTest(WritableStore())
        // 环境三件套齐备时探针被调用；抛异常按未探测处理（null）
        ZCodeEnvChecker.setBrowserHostProbe { throw IllegalStateException("probe boom") }
        kotlin.runCatching { ZCodeEnvChecker.check(force = true) }
            .onFailure { fail("探针异常不应导致 check 抛错: ${it.message}") }
        ZCodeEnvChecker.setBrowserHostProbe { BrowserHostStatus(true, null) }
        val s = ZCodeEnvChecker.check(force = true)
        // 三件套不满足时（真机差异）宿主不评判，两种结果都合法
        assertTrue(s.browserHost == null || s.browserHost!!.ok, "探针健康或未探测均合法，实际: ${s.browserHost}")
    }

    @Test
    fun `statusJson cdpActive 序列化与缺席省略`() {
        val absent = ZCodeEnvChecker.statusJson(EnvStatus(okNode(), okCli()))
        assertTrue("cdpActiveFile" !in absent, "探针缺席应省略 cdpActiveFile")

        val shown = ZCodeEnvChecker.statusJson(
            EnvStatus(okNode(), okCli(), cdpActive = CdpEndpointStatus("/s/jcef_cache/DevToolsActivePort", 63520)),
        )
        assertEquals("/s/jcef_cache/DevToolsActivePort", shown["cdpActiveFile"]!!.jsonPrimitive.content)
        assertEquals(63520, shown["cdpActivePort"]!!.jsonPrimitive.content.toInt())
    }

    @Test
    fun `check 组装 cdp 端点探针且探针异常不炸检测`() {
        ZCodeEnvChecker.setStoreForTest(WritableStore())
        // 探针异常按缺席处理（纯展示项，不能拖垮 check）
        ZCodeEnvChecker.setCdpEndpointProbe { throw IllegalStateException("probe boom") }
        kotlin.runCatching { ZCodeEnvChecker.check(force = true) }
            .onFailure { fail("cdp 探针异常不应导致 check 抛错: ${it.message}") }
        // 注入桩后 check 携带端点（与 node/cli 健康无关，两分支都挂）
        ZCodeEnvChecker.setCdpEndpointProbe { CdpEndpointStatus("C:/x/jcef_cache/DevToolsActivePort", 9222) }
        val s = ZCodeEnvChecker.check(force = true)
        assertEquals("C:/x/jcef_cache/DevToolsActivePort", s.cdpActive?.file)
        assertEquals(9222, s.cdpActive?.port)
    }

    @Test
    fun `firstProblem 按优先级给出可读原因`() {
        val nodeMissing = EnvStatus(
            okNode().copy(found = false, error = "未在系统 PATH 中找到 Node.js"), okCli(),
        )
        assertTrue(ZCodeEnvChecker.firstProblem(nodeMissing).contains("Node.js 不可用"))

        val tooLow = EnvStatus(
            okNode().copy(version = "v16.20.2", versionTooLow = true), okCli(),
        )
        val msg = ZCodeEnvChecker.firstProblem(tooLow)
        assertTrue(msg.contains("版本过低") && msg.contains("v16.20.2"), "应含版本号: $msg")

        val cliMissing = EnvStatus(okNode(), okCli().copy(found = false, error = "zcode.cjs 不存在"))
        assertTrue(ZCodeEnvChecker.firstProblem(cliMissing).contains("ZCode CLI"))

        // firstProblem 不评凭证：凭证失败不构成启动问题（0.3.8 撤出凭证状态展示）
        val envOkButOdd = EnvStatus(okNode(), okCli())
        assertEquals("环境异常", ZCodeEnvChecker.firstProblem(envOkButOdd))
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

    @Test
    fun `cdp 端口文件配置保存读取与清空`() {
        val store = WritableStore()
        ZCodeEnvChecker.setStoreForTest(store)

        ZCodeEnvChecker.saveCdpPortFile("  D:\\idea\\system\\jcef_cache\\DevToolsActivePort  ")
        assertEquals(
            "D:\\idea\\system\\jcef_cache\\DevToolsActivePort",
            ZCodeEnvChecker.configuredCdpPortFile(),
            "应去除首尾空白",
        )

        ZCodeEnvChecker.saveCdpPortFile("")
        assertEquals(null, ZCodeEnvChecker.configuredCdpPortFile(), "空串视为未配置")

        ZCodeEnvChecker.saveCdpPortFile("D:\\cdp\\DevToolsActivePort")
        ZCodeEnvChecker.clearCdpPortFile()
        assertEquals(null, ZCodeEnvChecker.configuredCdpPortFile())
    }

    @Test
    fun `statusJson cdpPortFile 顶层回显未配置省略`() {
        val store = WritableStore()
        ZCodeEnvChecker.setStoreForTest(store)

        val absent = ZCodeEnvChecker.statusJson(EnvStatus(okNode(), okCli()))
        assertTrue("cdpPortFile" !in absent, "未配置时应省略 cdpPortFile")

        store.set(ZCodeEnvChecker.KEY_CDP_PORT_FILE, "D:\\idea\\system\\jcef_cache\\DevToolsActivePort")
        val shown = ZCodeEnvChecker.statusJson(EnvStatus(okNode(), okCli()))
        assertEquals(
            "D:\\idea\\system\\jcef_cache\\DevToolsActivePort",
            shown["cdpPortFile"]!!.jsonPrimitive.content,
            "配置值应在 EnvStatus 顶层回显（不挂 browserHost）",
        )
    }

    // ============ 路径验证（不依赖本机环境） ============

    @Test
    fun `verifyNodePath 不存在路径直接失败`() {
        val probe = ZCodeEnvChecker.verifyNodePath("Z:\\definitely\\not\\exist\\node.exe")
        assertFalse(probe.found)
        assertNotNull(probe.error)
        assertTrue(probe.error!!.contains("文件不存在"), "错误信息应含原因: ${probe.error}")
    }

    // ============ 路径语义校验（防填错文件，不依赖本机环境） ============

    /** 建临时文件后执行断言，结束时清理整个临时目录 */
    private fun withTempFile(fileName: String, content: String = "", block: (java.io.File) -> Unit) {
        val dir = java.nio.file.Files.createTempDirectory("envcheck-test")
        try {
            val f = dir.resolve(fileName).toFile()
            f.writeText(content)
            block(f)
        } finally {
            dir.toFile().deleteRecursively()
        }
    }

    @Test
    fun `verifyCliPath node 可执行文件填到 cli 框被拒绝`() {
        withTempFile("node.exe") { f ->
            val probe = ZCodeEnvChecker.verifyCliPath(f.absolutePath)
            assertFalse(probe.found)
            assertTrue(probe.error!!.contains("Node.js"), "应提示填反了框: ${probe.error}")
        }
    }

    @Test
    fun `verifyCliPath 标准 zcode-cjs 文件名直接放行`() {
        withTempFile("zcode.cjs") { f ->
            // 内容为空也应放行：标准文件名即信任（bundle 内容校验只针对非标准名）
            assertTrue(ZCodeEnvChecker.verifyCliPath(f.absolutePath).found)
        }
    }

    @Test
    fun `verifyCliPath 非脚本扩展名被拒绝`() {
        withTempFile("readme.txt", "zcode zcode zcode") { f ->
            val probe = ZCodeEnvChecker.verifyCliPath(f.absolutePath)
            assertFalse(probe.found)
            assertTrue(probe.error!!.contains("不是"), "应说明不是脚本文件: ${probe.error}")
        }
    }

    @Test
    fun `verifyCliPath 无 zcode 特征的 JS 文件被拒绝`() {
        withTempFile("my-cli.cjs", "console.log('hello world')") { f ->
            val probe = ZCodeEnvChecker.verifyCliPath(f.absolutePath)
            assertFalse(probe.found)
            assertTrue(probe.error!!.contains("特征"), "应提示缺少 ZCode 特征: ${probe.error}")
        }
    }

    @Test
    fun `verifyCliPath 含 zcode 特征的自定义 JS 放行`() {
        withTempFile("zcode-wrapper.js", "#!/usr/bin/env node\nrequire('zcode')") { f ->
            assertTrue(ZCodeEnvChecker.verifyCliPath(f.absolutePath).found)
        }
    }

    @Test
    fun `verifyNodePath JS 脚本填到 node 框被预检拒绝`() {
        withTempFile("zcode.cjs", "#!/usr/bin/env node") { f ->
            val probe = ZCodeEnvChecker.verifyNodePath(f.absolutePath)
            assertFalse(probe.found)
            assertTrue(probe.error!!.contains("JS 脚本"), "应提示是脚本非可执行文件: ${probe.error}")
        }
    }

    @Test
    fun `verifyNodePath 包管理器被预检拒绝`() {
        withTempFile("npm.cmd") { f ->
            val probe = ZCodeEnvChecker.verifyNodePath(f.absolutePath)
            assertFalse(probe.found)
            assertTrue(probe.error!!.contains("包管理器"), "应提示是包管理器: ${probe.error}")
        }
    }

    // ============ check 全流程（真机前置） ============

    // ============ resolvePaths（CLI 子进程取路径；真机前置） ============

    @Test
    fun `resolvePaths 路径健在即复用缓存不再重扫`() {
        // 前置：本机 PATH 有 node、ZCode 标准位置安装。
        // 注意 setBrowserHostProbe 会顺带 invalidate，探针须在填缓存前注入，
        // 断言看 resolvePaths 前后的计数增量（全量重扫时探针必被调用）
        ZCodeEnvChecker.setStoreForTest(WritableStore())
        var probed = 0
        ZCodeEnvChecker.setBrowserHostProbe { probed++; null }
        val full = ZCodeEnvChecker.check(force = true)
        assertTrue(full.allOk, "真机前置环境应齐备: node=${full.node.error} cli=${full.cli.error}")
        val before = probed
        val s = ZCodeEnvChecker.resolvePaths()
        assertEquals(before, probed, "路径复用不应连坐运行态探测（CDP 多候选最坏 ~10s）")
        assertEquals(full.node.path, s.node.path)
        assertEquals(full.cli.path, s.cli.path)
    }

    @Test
    fun `resolvePaths 缓存清空后回落全量检测`() {
        ZCodeEnvChecker.setStoreForTest(WritableStore())
        var probed = 0
        ZCodeEnvChecker.setBrowserHostProbe { probed++; null }
        ZCodeEnvChecker.check(force = true) // 填缓存
        ZCodeEnvChecker.invalidate()
        val s = ZCodeEnvChecker.resolvePaths()
        assertTrue(s.allOk, "回落全量后真机环境应齐备")
        assertTrue(probed > 0, "全量检测应包含 browserHost 探测（证明真的重扫了）")
    }

    @Test
    fun `check 自动探测环境 node 与 cli`() {
        // 前置：本机 PATH 有 node、ZCode 标准位置安装
        ZCodeEnvChecker.setStoreForTest(WritableStore())
        val s = ZCodeEnvChecker.check(force = true)
        println("✅ 环境检测: allOk=${s.allOk}, node=${s.node.path} ${s.node.version}, cli=${s.cli.path} ${s.cli.version}")

        assertTrue(s.node.found, "本机 PATH 应有 node（否则请先安装）: ${s.node.error}")
        assertTrue(s.node.versionTooLow.not(), "本机 node 应 ≥ 18: ${s.node.version}")
        assertTrue(s.cli.found, "本机应有标准位置 ZCode: ${s.cli.error}")
        assertTrue(!s.cli.version.isNullOrBlank() && Regex("""\d+\.\d+\.\d+""").matches(s.cli.version!!),
            "CLI 版本应探测成功且形如 N.N.N: ${s.cli.version}")
        // 判代标识恒有值（fail-soft 总有结果），且取值合法
        assertTrue(s.cli.generation in listOf("v1", "v2"), "generation 应为 v1/v2: ${s.cli.generation}")
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
        val cli = okCli().copy(version = "0.16.5", generation = "v2")
        val json = ZCodeEnvChecker.statusJson(EnvStatus(okNode(), cli))
        val node = json["node"]!!.jsonObject
        assertEquals("/usr/bin/node", node["path"]!!.jsonPrimitive.content)
        assertEquals("v20.11.1", node["version"]!!.jsonPrimitive.content)
        assertEquals(18, node["minVersion"]!!.jsonPrimitive.content.toInt())
        assertEquals("0.16.5", json["cli"]!!.jsonObject["version"]!!.jsonPrimitive.content)
        assertEquals("v2", json["cli"]!!.jsonObject["generation"]!!.jsonPrimitive.content)
        assertEquals(true, json["allOk"]!!.jsonPrimitive.content.toBoolean())
        assertTrue("credentials" !in json, "凭证状态已撤出，JSON 不应再含 credentials 节点")

        // null 字段应省略（putOrNull）
        val bad = ZCodeEnvChecker.statusJson(
            EnvStatus(
                NodeStatus(true, null, false, null, false, 18, "文件不存在"),
                CliStatus(false, null, false, "未找到"),
            ),
        )
        assertTrue("path" !in bad["node"]!!.jsonObject, "null path 应省略")
        assertTrue("version" !in bad["node"]!!.jsonObject)
        assertTrue("version" !in bad["cli"]!!.jsonObject, "探测失败的 cli version 应省略")
        assertFalse(bad["allOk"]!!.jsonPrimitive.content.toBoolean())
    }
    // ============ resolveCliPathForOps（2026-09-18 模型管理链路缺陷修复） ============

    @Test
    fun `resolveCliPathForOps 手动配置优先于自动探测`() {
        val store = WritableStore()
        ZCodeEnvChecker.setStoreForTest(store)
        // 本机 detect() 通常可命中（Windows 开发机装着客户端），配置一个内容正确的假文件应压过它
        val fake = kotlin.io.path.createTempFile(prefix = "fake-cli", suffix = ".cjs")
        try {
            fake.toFile().writeText("// zcode bundle marker")
            store.set(ZCodeEnvChecker.KEY_CLI_PATH, fake.toString())
            assertEquals(fake, ZCodeEnvChecker.resolveCliPathForOps())
        } finally {
            fake.toFile().delete()
        }
    }

    @Test
    fun `resolveCliPathForOps 配置文件已删除时回退自动探测`() {
        val store = WritableStore()
        ZCodeEnvChecker.setStoreForTest(store)
        store.set(ZCodeEnvChecker.KEY_CLI_PATH, "Z:/not-exist/dir/zcode.cjs")
        // 不抛异常：配置失效 → 走 detect()（命中与否随测试机而定），只验证不炸且类型正确
        ZCodeEnvChecker.resolveCliPathForOps()
    }

    @Test
    fun `resolveCliPathForOps 空白配置等价未配置`() {
        val store = WritableStore()
        ZCodeEnvChecker.setStoreForTest(store)
        store.set(ZCodeEnvChecker.KEY_CLI_PATH, "   ")
        ZCodeEnvChecker.resolveCliPathForOps()
    }
}

