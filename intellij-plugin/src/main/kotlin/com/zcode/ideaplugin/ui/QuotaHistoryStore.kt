package com.zcode.ideaplugin.ui

import com.intellij.openapi.application.PathManager
import com.intellij.openapi.diagnostic.Logger
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.io.File

/**
 * GLM 额度历史采样（用量页「额度趋势」数据源）
 *
 * 背景：`quota/limit` 只在悬停上下文圆环 / 打开用量页时拉一次，展示完即丢，
 * 周额度的变化过程无从回看。本对象把每次成功的额度应答落成 JSONL 一行，
 * 由前端按时间轴画曲线、算每日消耗与「每 1% ≈ 多少 Token」。
 *
 * 存储：`PathManager.getSystemDir()/zcode-quota/quota-history.jsonl`
 * （system 目录按 IDE 产品隔离，跨项目共享；写失败 fail-soft，不影响额度查询本身）
 * 行格式：
 * `{"ts":1750000000000,"providerId":"builtin:bigmodel-coding-plan",
 *   "limits":[{"type":"TOKENS_LIMIT","unit":6,"percentage":42,"nextResetTime":...}]}`
 *
 * 三条硬规则：
 *  - 内容相同的心跳样本每 5 分钟才落一条（前端 startQuotaPolling 每 60s 轮询一次；
 *    多标签并发轮询也由这条规则合并），百分比一变立即落盘；
 *  - providerId 变化照记——凭证回退链可能落到别家 key，前端按 provider 分段，
 *    避免把两个账号的百分比接成一条曲线（接起来会被误判成"重置"）；
 *  - 负差值（周额度重置）不在存储层处理，交给前端统计时归零。
 *
 * 保留 60 天：写入时按「每进程最多 prune 一次」重写过滤，坏行顺带清掉。
 */
object QuotaHistoryStore {
    private val log = Logger.getInstance(QuotaHistoryStore::class.java)

    /** 保留天数（用户 2026-11-12 定：60 天） */
    const val RETENTION_DAYS = 60

    /**
     * 相同内容的最小落盘间隔：webview 每 60s 轮询一次额度（startQuotaPolling），
     * 数值没变时每 5 分钟留一条心跳即可（曲线/日消耗算法只关心变化点与覆盖时间）；
     * 值一变立即落盘，不影响分辨率。多标签同时轮询也由这条规则合并。
     */
    const val SAME_CONTENT_INTERVAL_MS = 5 * 60_000L

    /** 单次读取上限（防御性：坏文件/时钟乱跳导致的超大窗口） */
    private const val MAX_SAMPLES = 30_000

    /** 单样本 limits 上限（官方三窗口，留余量） */
    private const val MAX_LIMITS = 8

    private const val DAY_MS = 24L * 60 * 60 * 1000

    /** 本进程最近一次 prune 的日期（yyyy-MM-dd，避免每次 record 都重写整个文件）*/
    private var lastPruneDay: String = ""

    private val json = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }

    /** 一个额度窗口的采样值（字段来源见 quota/limit → data.limits[]） */
    data class Limit(
        val type: String?,
        val unit: Int?,
        val percentage: Double?,
        val nextResetTime: Long?,
    )

    /** 一次额度应答的采样（providerId = 查询凭证所属渠道，前端据此分段） */
    data class Sample(
        val ts: Long,
        val providerId: String?,
        val limits: List<Limit>,
    )

    /** 默认存储文件；PathManager 不可用（异常启动/单测）时返回 null（记录与读取均关闭）*/
    fun defaultFile(): File? = try {
        PathManager.getSystemDir().resolve("zcode-quota").resolve("quota-history.jsonl").toFile()
    } catch (e: Exception) {
        log.warn("quota history dir unavailable: ${e.javaClass.simpleName}: ${e.message}")
        null
    }

    /**
     * 从 quota/limit 应答的 data 段解析窗口采样。
     * 只保留 percentage 为数值的条目（曲线/统计的唯一必需字段），其余字段可缺省。
     */
    fun parseLimits(data: JsonObject?): List<Limit> {
        val arr = data?.get("limits") as? JsonArray ?: return emptyList()
        val out = ArrayList<Limit>()
        for (el in arr) {
            val obj = try {
                el.jsonObject
            } catch (_: Exception) {
                continue
            }
            val pct = obj["percentage"]?.jsonPrimitive?.doubleOrNull ?: continue
            // NaN/Infinity 无法进 JSON，防御性丢弃
            if (pct.isNaN() || pct.isInfinite()) continue
            out.add(
                Limit(
                    type = obj["type"]?.jsonPrimitive?.contentOrNull,
                    unit = obj["unit"]?.jsonPrimitive?.intOrNull,
                    percentage = pct,
                    nextResetTime = obj["nextResetTime"]?.jsonPrimitive?.longOrNull,
                )
            )
            if (out.size >= MAX_LIMITS) break
        }
        return out
    }

    /**
     * 落一条采样。data = quota/limit 应答的 data 段；providerId = 实际取 key 的渠道。
     * 解析不到任何数值窗口 / 与上一条重复 / 写盘失败 → 静默跳过（额度查询本身不受影响）。
     */
    @Synchronized
    fun record(
        data: JsonObject?,
        providerId: String?,
        now: Long = System.currentTimeMillis(),
        file: File? = defaultFile(),
    ) {
        val limits = parseLimits(data)
        if (limits.isEmpty()) return
        val target = file ?: return
        try {
            val sample = Sample(now, providerId, limits)
            if (!shouldAppend(readLast(target), sample)) return
            target.parentFile?.mkdirs()
            // appendText 默认 UTF-8；单行写入远小于一次系统调用上限，进程崩溃最多丢最后一行
            target.appendText(encode(sample) + "\n", Charsets.UTF_8)
            maybePrune(target, now)
        } catch (e: Exception) {
            log.warn("quota history record failed: ${e.javaClass.simpleName}: ${e.message}")
        }
    }

    /**
     * 读取最近 [days] 天的采样（升序）。days ≤ 0 按 1 处理，上限 [RETENTION_DAYS]。
     * 坏行跳过；文件不存在返回空数组。
     */
    @Synchronized
    fun load(
        days: Int,
        now: Long = System.currentTimeMillis(),
        file: File? = defaultFile(),
    ): JsonArray {
        val target = file ?: return buildJsonArray {}
        if (!target.isFile) return buildJsonArray {}
        val windowDays = days.coerceIn(1, RETENTION_DAYS)
        val cutoff = now - windowDays * DAY_MS
        return try {
            val samples = ArrayList<Sample>()
            target.forEachLine(Charsets.UTF_8) { line ->
                if (samples.size >= MAX_SAMPLES) return@forEachLine
                decode(line)?.let { if (it.ts >= cutoff) samples.add(it) }
            }
            samples.sortBy { it.ts }
            buildJsonArray { samples.forEach { add(encodeObject(it)) } }
        } catch (e: Exception) {
            log.warn("quota history load failed: ${e.javaClass.simpleName}: ${e.message}")
            buildJsonArray {}
        }
    }

    // ============ 纯逻辑（单测直接覆盖） ============

    /** 与上一条比较：provider/内容相同且间隔小于去重窗口 → 不落盘（时钟回拨同样跳过）*/
    internal fun shouldAppend(prev: Sample?, next: Sample, sameContentIntervalMs: Long = SAME_CONTENT_INTERVAL_MS): Boolean {
        if (prev == null) return true
        if (prev.providerId != next.providerId) return true
        if (next.ts <= prev.ts) return false
        if (next.ts - prev.ts >= sameContentIntervalMs) return true
        return prev.limits != next.limits
    }

    /** 编码一行 JSON（字段顺序固定，便于人工查看） */
    internal fun encode(sample: Sample): String = encodeObject(sample).toString()

    internal fun decode(line: String): Sample? {
        val trimmed = line.trim()
        if (trimmed.isEmpty() || !trimmed.startsWith("{")) return null
        return try {
            val obj = json.parseToJsonElement(trimmed).jsonObject
            val ts = obj["ts"]?.jsonPrimitive?.longOrNull ?: return null
            if (ts <= 0) return null
            val arr = obj["limits"] as? JsonArray ?: return null
            val limits = ArrayList<Limit>()
            for (el in arr) {
                val lo = try {
                    el.jsonObject
                } catch (_: Exception) {
                    continue
                }
                val pct = lo["percentage"]?.jsonPrimitive?.doubleOrNull ?: continue
                if (pct.isNaN() || pct.isInfinite()) continue
                limits.add(
                    Limit(
                        type = lo["type"]?.jsonPrimitive?.contentOrNull,
                        unit = lo["unit"]?.jsonPrimitive?.intOrNull,
                        percentage = pct,
                        nextResetTime = lo["nextResetTime"]?.jsonPrimitive?.longOrNull,
                    )
                )
            }
            if (limits.isEmpty()) return null
            Sample(ts, obj["providerId"]?.jsonPrimitive?.contentOrNull, limits)
        } catch (_: Exception) {
            null
        }
    }

    /** 过滤出保留窗口内的合法行（保留原行，避免重编码引入格式漂移）*/
    internal fun pruneLines(lines: List<String>, now: Long, retentionDays: Int = RETENTION_DAYS): List<String> {
        val cutoff = now - retentionDays * DAY_MS
        return lines.filter { line ->
            val sample = decode(line) ?: return@filter false
            sample.ts >= cutoff
        }
    }

    // ============ 内部 IO ============

    private fun encodeObject(sample: Sample): JsonObject = buildJsonObject {
        put("ts", sample.ts)
        sample.providerId?.let { put("providerId", it) }
        put(
            "limits",
            buildJsonArray {
                sample.limits.forEach { l ->
                    add(
                        buildJsonObject {
                            l.type?.let { put("type", it) }
                            l.unit?.let { put("unit", it) }
                            l.percentage?.let { put("percentage", it) }
                            l.nextResetTime?.let { put("nextResetTime", it) }
                        }
                    )
                }
            },
        )
    }

    /** 读最后一行（大文件用 tail 式读取，避免每次 record 全量扫描） */
    private fun readLast(file: File): Sample? {
        if (!file.isFile) return null
        return try {
            java.io.RandomAccessFile(file, "r").use { raf ->
                var pos = raf.length() - 1
                if (pos < 0) return null
                // 跳过末尾换行
                while (pos > 0) {
                    raf.seek(pos)
                    if (raf.readByte() != '\n'.code.toByte()) break
                    pos--
                }
                val end = pos + 1
                while (pos > 0) {
                    raf.seek(pos - 1)
                    if (raf.readByte() == '\n'.code.toByte()) break
                    pos--
                }
                val len = (end - pos).toInt()
                if (len <= 0 || len > 64 * 1024) return null
                val bytes = ByteArray(len)
                raf.seek(pos)
                raf.readFully(bytes)
                decode(String(bytes, Charsets.UTF_8))
            }
        } catch (_: Exception) {
            null
        }
    }

    /** 每天最多重写一次：清掉超过 60 天的行与坏行 */
    private fun maybePrune(file: File, now: Long) {
        val day = java.time.LocalDate.now().toString()
        if (day == lastPruneDay) return
        lastPruneDay = day
        try {
            val lines = file.readLines(Charsets.UTF_8)
            val kept = pruneLines(lines, now)
            if (kept.size == lines.size) return
            val tmp = File(file.parentFile, file.name + ".tmp")
            tmp.writeText(kept.joinToString("\n", postfix = if (kept.isEmpty()) "" else "\n"), Charsets.UTF_8)
            if (!tmp.renameTo(file)) {
                // Windows 上目标存在时 renameTo 可能失败：退回直接覆盖
                file.writeText(kept.joinToString("\n", postfix = if (kept.isEmpty()) "" else "\n"), Charsets.UTF_8)
                tmp.delete()
            }
            log.info("quota history pruned: ${lines.size} → ${kept.size} lines")
        } catch (e: Exception) {
            log.warn("quota history prune failed: ${e.javaClass.simpleName}: ${e.message}")
        }
    }
}