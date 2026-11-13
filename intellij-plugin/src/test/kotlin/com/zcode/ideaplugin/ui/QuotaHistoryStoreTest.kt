package com.zcode.ideaplugin.ui

import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
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
 * IO 全部走临时文件，时钟由参数注入，不依赖真实时间。
 */
class QuotaHistoryStoreTest {

    @TempDir
    lateinit var tmp: Path

    private fun file() = tmp.resolve("quota-history.jsonl").toFile()

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
}