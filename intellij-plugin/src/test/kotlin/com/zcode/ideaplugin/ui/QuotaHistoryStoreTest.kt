package com.zcode.ideaplugin.ui

import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.nio.file.Path
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * 额度历史采样存储测试（用量页「额度趋势」数据源）。
 *
 * 关注三条硬规则：60s 同内容去重、providerId 变化照记、60 天保留窗口；
 * 以及跨 IDE 共享存储（~/.zcgui）的旧数据整合迁移与 sidecar 锁竞争语义。
 * IO 全部走临时文件，时钟由参数注入，不依赖真实时间；
 * 锁竞争以注入 lockRunner 模拟（FileLock 同进程语义跨平台不一致，不能真锁自测）。
 */
class QuotaHistoryStoreTest {

    @TempDir
    lateinit var tmp: Path

    @BeforeEach
    fun reset() = QuotaHistoryStore.resetForTest()

    private fun file() = tmp.resolve("quota-history.jsonl").toFile()

    /** 伪 system 根目录 + 造一个旧版产品隔离位置的采样文件（0.4.5 布局） */
    private fun legacyFile(sysRoot: Path, product: String, vararg samples: QuotaHistoryStore.Sample): File {
        val f = sysRoot.resolve("$product/zcode-quota/quota-history.jsonl").toFile()
        f.parentFile.mkdirs()
        samples.forEach { f.appendText(QuotaHistoryStore.encode(it) + "\n") }
        return f
    }

    /** quota/limit 应答 data 段的最小形态 */
    private fun data(vararg limits: Triple<String, Int, Double>) = buildJsonObject {
        put(
            "limits",
            buildJsonArray {
                limits.forEach { (type, unit, pct) ->
                    add(
                        buildJsonObject {
                            put("type", type)
                            put("unit", unit)
                            put("percentage", pct)
                            put("nextResetTime", 1_760_000_000_000L)
                        }
                    )
                }
            },
        )
    }

    /** 从 load 结果里取第 idx 个样本的第 limitIdx 个百分比 */
    private fun pctAt(line: kotlinx.serialization.json.JsonElement, limitIdx: Int = 0): Double =
        line.jsonObject["limits"]!!.jsonArray[limitIdx].jsonObject["percentage"]!!.jsonPrimitive.double

    @Test
    fun `解析只保留带数值百分比的窗口`() {
        val data = buildJsonObject {
            put(
                "limits",
                buildJsonArray {
                    add(buildJsonObject { put("type", "TOKENS_LIMIT"); put("unit", 6); put("percentage", 42.5); put("nextResetTime", 1_760_000_000_000L) })
                    add(buildJsonObject { put("type", "TIME_LIMIT"); put("unit", 5) }) // 无 percentage → 丢
                    add(buildJsonObject { put("unit", 3); put("percentage", "错误类型") }) // 非数值 → 丢
                },
            )
        }
        val limits = QuotaHistoryStore.parseLimits(data)
        assertEquals(1, limits.size)
        assertEquals("TOKENS_LIMIT", limits[0].type)
        assertEquals(6, limits[0].unit)
        assertEquals(42.5, limits[0].percentage)
        assertEquals(1_760_000_000_000L, limits[0].nextResetTime)
    }

    @Test
    fun `同内容心跳窗口内去重_内容或provider变化照记`() {
        val s1 = QuotaHistoryStore.Sample(1000L, "p", listOf(QuotaHistoryStore.Limit("TOKENS_LIMIT", 6, 40.0, null)))
        val same = s1.copy(ts = 30_000L, limits = listOf(QuotaHistoryStore.Limit("TOKENS_LIMIT", 6, 40.0, null)))
        val changed = s1.copy(ts = 30_000L, limits = listOf(QuotaHistoryStore.Limit("TOKENS_LIMIT", 6, 41.0, null)))
        val otherProvider = s1.copy(ts = 30_000L, providerId = "q")

        assertTrue(QuotaHistoryStore.shouldAppend(null, s1)) // 首条
        assertFalse(QuotaHistoryStore.shouldAppend(s1, same)) // 心跳窗口内同内容
        assertTrue(QuotaHistoryStore.shouldAppend(s1, changed)) // 百分比变了立即落
        assertTrue(QuotaHistoryStore.shouldAppend(s1, otherProvider)) // 换渠道
        assertFalse(QuotaHistoryStore.shouldAppend(s1, s1.copy(ts = 500L))) // 时钟回拨
        assertFalse(QuotaHistoryStore.shouldAppend(s1, same.copy(ts = 2 * 60_000L))) // 仍在心跳窗口内
        assertTrue(QuotaHistoryStore.shouldAppend(s1, same.copy(ts = 6 * 60_000L))) // 超出心跳窗口
    }

    @Test
    fun `写入后按时间升序读回_窗口外过滤`() {
        val f = file()
        val now = 1_800_000_000_000L
        val day = 24L * 60 * 60 * 1000
        QuotaHistoryStore.record(data(Triple("TOKENS_LIMIT", 6, 10.0)), "p", now - 3 * day, f)
        QuotaHistoryStore.record(data(Triple("TOKENS_LIMIT", 6, 12.0)), "p", now - 2 * day, f)
        QuotaHistoryStore.record(data(Triple("TOKENS_LIMIT", 6, 13.0)), "p", now, f)

        val seven = QuotaHistoryStore.load(7, now, f)
        assertEquals(3, seven.size)
        assertEquals(10.0, pctAt(seven[0]))
        assertEquals(12.0, pctAt(seven[1]))
        assertEquals(13.0, pctAt(seven[2]))

        // 窗口：只留最近 1 天
        val one = QuotaHistoryStore.load(1, now, f)
        assertEquals(1, one.size)
        assertEquals(13.0, pctAt(one[0]))
    }

    @Test
    fun `心跳窗口内重复record只落一行`() {
        val f = file()
        val now = 1_800_000_000_000L
        repeat(3) { i ->
            QuotaHistoryStore.record(data(Triple("TOKENS_LIMIT", 6, 50.0)), "p", now + i * 1_000L, f)
        }
        // 手动刷新与多标签轮询各来一次：内容相同、间隔 < 60s → 只留第一条
        assertEquals(1, QuotaHistoryStore.load(7, now + 10_000L, f).size)
    }

    @Test
    fun `保留窗口外的行被剪掉_坏行丢弃`() {
        val now = 1_800_000_000_000L
        val day = 24L * 60 * 60 * 1000
        val fresh = QuotaHistoryStore.encode(
            QuotaHistoryStore.Sample(now - day, "p", listOf(QuotaHistoryStore.Limit("TOKENS_LIMIT", 6, 20.0, null)))
        )
        val stale = QuotaHistoryStore.encode(
            QuotaHistoryStore.Sample(now - 61 * day, "p", listOf(QuotaHistoryStore.Limit("TOKENS_LIMIT", 6, 20.0, null)))
        )
        val kept = QuotaHistoryStore.pruneLines(listOf(fresh, "not json", "", stale), now)
        assertEquals(listOf(fresh), kept)
    }

    @Test
    fun `超过行数硬顶裁到最新_maxLines条`() {
        val now = 1_800_000_000_000L
        val lines = (1..5).map { i ->
            QuotaHistoryStore.encode(
                QuotaHistoryStore.Sample(now - (6 - i) * 1_000L, "p", listOf(QuotaHistoryStore.Limit("TOKENS_LIMIT", 6, i * 10.0, null)))
            )
        }
        // 窗口内 5 行、硬顶 3 → 留最新 3 行
        val kept = QuotaHistoryStore.pruneLines(lines, now, maxLines = 3)
        assertEquals(3, kept.size)
        assertEquals(lines.takeLast(3), kept)
    }

    @Test
    fun `编码解码往返`() {
        val sample = QuotaHistoryStore.Sample(
            ts = 1_800_000_000_000L,
            providerId = "builtin:bigmodel-coding-plan",
            limits = listOf(
                QuotaHistoryStore.Limit("TOKENS_LIMIT", 6, 42.5, 1_760_000_000_000L),
                QuotaHistoryStore.Limit("TIME_LIMIT", 5, 10.0, null),
            ),
        )
        val decoded = QuotaHistoryStore.decode(QuotaHistoryStore.encode(sample))
        assertNotNull(decoded)
        assertEquals(sample, decoded)
        assertNull(QuotaHistoryStore.decode("garbage"))
        assertNull(QuotaHistoryStore.decode("""{"ts":0,"limits":[]}"""))
    }

    // ============ 跨 IDE 共享存储与旧数据整合 ============

    @Test
    fun `globalFile落在zcgui目录_home注入`() {
        assertEquals(File("/home/u", ".zcgui/quota-history.jsonl"), QuotaHistoryStore.globalFile("/home/u"))
        assertNull(QuotaHistoryStore.globalFile(""))
    }

    @Test
    fun `迁移合并全局与旧文件_排序去重_旧文件改名migrated`() {
        val now = 1_800_000_000_000L
        val day = 24L * 60 * 60 * 1000
        val sysRoot = tmp.resolve("JetBrains")
        // 本产品旧文件：3 天前 20%、坏行、2 天前 30%
        val own = legacyFile(
            sysRoot, "IntelliJIdea2026.2",
            QuotaHistoryStore.Sample(now - 3 * day, "p", listOf(QuotaHistoryStore.Limit("TOKENS_LIMIT", 6, 20.0, null))),
            QuotaHistoryStore.Sample(now - 2 * day, "p", listOf(QuotaHistoryStore.Limit("TOKENS_LIMIT", 6, 30.0, null))),
        )
        own.appendText("broken line\n")
        // 全局：已含与旧文件重叠的 2 天前 30%、及 1 天前 40%
        val global = tmp.resolve("global").resolve("quota-history.jsonl").toFile()
        global.parentFile.mkdirs()
        global.appendText(QuotaHistoryStore.encode(QuotaHistoryStore.Sample(now - 2 * day, "p", listOf(QuotaHistoryStore.Limit("TOKENS_LIMIT", 6, 30.0, null)))) + "\n")
        global.appendText(QuotaHistoryStore.encode(QuotaHistoryStore.Sample(now - day, "p", listOf(QuotaHistoryStore.Limit("TOKENS_LIMIT", 6, 40.0, null)))) + "\n")

        QuotaHistoryStore.ensureMigrated(global, now, systemDir = sysRoot.resolve("IntelliJIdea2026.2").toFile())

        // 合并后按 ts 升序去重：20% → 30%（只一份）→ 40%
        assertEquals(listOf(20.0, 30.0, 40.0), QuotaHistoryStore.load(7, now, global).map { pctAt(it) })
        // 旧文件改名保留现场，原文件不再存在
        assertTrue(File(own.parentFile, "quota-history.jsonl.migrated").isFile)
        assertFalse(own.isFile)

        // 完成标志已置位：再调不再触发任何锁动作
        QuotaHistoryStore.lockRunner = { _, _ -> throw AssertionError("迁移完成后不应再触发") }
        QuotaHistoryStore.ensureMigrated(global, now, systemDir = sysRoot.resolve("IntelliJIdea2026.2").toFile())
    }

    @Test
    fun `迁移拾取兄弟产品目录_无本产品旧文件也收口`() {
        val now = 1_800_000_000_000L
        val sysRoot = tmp.resolve("JetBrains")
        // 只有 PyCharm 旧文件（模拟在 IDEA 里一次归拢 PyCharm 存量）
        val sibling = legacyFile(
            sysRoot, "PyCharm2026.2",
            QuotaHistoryStore.Sample(now - 1_000L, "p", listOf(QuotaHistoryStore.Limit("TOKENS_LIMIT", 6, 55.0, null))),
        )
        val global = tmp.resolve("global").resolve("quota-history.jsonl").toFile()
        global.parentFile.mkdirs()

        QuotaHistoryStore.ensureMigrated(global, now, systemDir = sysRoot.resolve("IntelliJIdea2026.2").toFile())

        assertEquals(1, QuotaHistoryStore.load(7, now, global).size)
        assertEquals(55.0, pctAt(QuotaHistoryStore.load(7, now, global)[0]))
        assertTrue(File(sibling.parentFile, "quota-history.jsonl.migrated").isFile)
    }

    @Test
    fun `无旧数据时迁移一次收口_不再扫描`() {
        val sysRoot = tmp.resolve("JetBrains") // 目录不存在 → legacyFiles 空
        val global = tmp.resolve("global").resolve("quota-history.jsonl").toFile()
        global.parentFile.mkdirs()

        QuotaHistoryStore.ensureMigrated(global, 1_800_000_000_000L, systemDir = sysRoot.resolve("IntelliJIdea2026.2").toFile())

        QuotaHistoryStore.lockRunner = { _, _ -> throw AssertionError("无旧数据应直接收口") }
        QuotaHistoryStore.ensureMigrated(global, 1_800_000_000_000L, systemDir = sysRoot.resolve("IntelliJIdea2026.2").toFile())
    }

    @Test
    fun `锁被占时迁移推迟不置完成标志_恢复后补跑`() {
        val now = 1_800_000_000_000L
        val sysRoot = tmp.resolve("JetBrains")
        val own = legacyFile(
            sysRoot, "IntelliJIdea2026.2",
            QuotaHistoryStore.Sample(now - 1_000L, "p", listOf(QuotaHistoryStore.Limit("TOKENS_LIMIT", 6, 50.0, null))),
        )
        val global = tmp.resolve("global").resolve("quota-history.jsonl").toFile()
        global.parentFile.mkdirs()

        QuotaHistoryStore.lockRunner = { _, _ -> QuotaHistoryStore.LockOutcome.BUSY }
        QuotaHistoryStore.ensureMigrated(global, now, systemDir = sysRoot.resolve("IntelliJIdea2026.2").toFile())
        // 什么都没动：全局空、旧文件原位、完成标志未置位（表现为下次还会重试）
        assertEquals(0, QuotaHistoryStore.load(7, now, global).size)
        assertTrue(own.isFile)

        QuotaHistoryStore.resetForTest() // 恢复默认锁
        QuotaHistoryStore.ensureMigrated(global, now, systemDir = sysRoot.resolve("IntelliJIdea2026.2").toFile())
        assertEquals(1, QuotaHistoryStore.load(7, now, global).size)
        assertFalse(own.isFile)
    }

    @Test
    fun `锁被占时record跳过本拍样本`() {
        val f = file()
        QuotaHistoryStore.lockRunner = { _, _ -> QuotaHistoryStore.LockOutcome.BUSY }
        QuotaHistoryStore.record(data(Triple("TOKENS_LIMIT", 6, 10.0)), "p", 1_800_000_000_000L, f)
        assertEquals(0, QuotaHistoryStore.load(7, 1_800_000_000_000L, f).size)
    }

    @Test
    fun `连续合并失败达上限后本进程放弃`() {
        val now = 1_800_000_000_000L
        val sysRoot = tmp.resolve("JetBrains")
        legacyFile(
            sysRoot, "IntelliJIdea2026.2",
            QuotaHistoryStore.Sample(now - 1_000L, "p", listOf(QuotaHistoryStore.Limit("TOKENS_LIMIT", 6, 50.0, null))),
        )
        val global = tmp.resolve("global").resolve("quota-history.jsonl").toFile()
        global.parentFile.mkdirs()

        var attempts = 0
        QuotaHistoryStore.lockRunner = { _, _ -> attempts++; QuotaHistoryStore.LockOutcome.FAILED }
        repeat(5) { QuotaHistoryStore.ensureMigrated(global, now, systemDir = sysRoot.resolve("IntelliJIdea2026.2").toFile()) }
        // 第 3 次失败后置放弃标志，第 4/5 次不再触发
        assertEquals(3, attempts)
    }
}