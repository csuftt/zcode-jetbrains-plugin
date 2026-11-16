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
 * 存储：`~/.zcgui/quota-history.jsonl` —— 插件自有跨 IDE 目录（同 [com.zcode.ideaplugin.protocol.ZcGuiConfig]），
 * 同机 IDEA/PyCharm 等读写同一份，曲线合流；user.home 不可用时退回老位置
 * `PathManager.getSystemDir()/zcode-quota/quota-history.jsonl`（行为同 0.4.5）。写失败 fail-soft，不影响额度查询本身。
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
 * 跨 IDE 并发：写路径（append/prune/迁移）一律过 sidecar 文件锁（`withFileLock`，
 * tryLock 非阻塞，进程崩溃 OS 自动释放）；锁被别的 IDE 占有 → 跳过本拍
 * （记录下个 60s 轮询周期再来、prune 明天再来），绝不阻塞等待。读路径（load）不加锁，坏行本就跳过。
 *
 * 旧数据整合：0.4.5 及以前按 IDE 产品隔离存储，升级后进程内首次 record/load 把
 * 本产品旧位置 + 同根兄弟产品（systemDir 父目录下各产品子目录的 `zcode-quota` 目录，不认产品名、
 * 逐目录探测兜底，IDEA 一次就能把 PyCharm 等的存量全归拢）的采样合并进全局文件
 * （按 ts 排序 + 规范化行去重 + 保留窗过滤，原子重写），旧文件改名 `.migrated` 保留现场
 * （只认精确文件名，不会重复导入）。
 *
 * 保留 60 天 + 行数硬顶 3 万：写入时按「每进程最多 prune 一次」重写过滤（坏行顺带清掉、
 * 超出硬顶裁到最新），文件是滚动窗口不会无限增长（实测 ~300 行/天，稳态 ≈ 5MB）。
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

    /** 迁移连续失败上限：超过即本进程放弃（fail-soft），下次启动再试 */
    private const val MAX_MERGE_FAILURES = 3

    /** 本进程最近一次 prune 的日期（yyyy-MM-dd，避免每次 record 都重写整个文件）*/
    private var lastPruneDay: String = ""

    /** 旧数据整合是否已收口（含「无旧数据」；锁被占/失败时保持 false 等下拍重试） */
    @Volatile
    private var migrationDone = false

    private var migrationFailures = 0

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

    /** 锁执行结果：RAN=动作已执行成功；BUSY=锁不可得（跳过本拍）；FAILED=动作执行失败 */
    internal enum class LockOutcome { RAN, BUSY, FAILED }

    /** 默认锁执行器：sidecar 文件锁。可整体替换供单测模拟锁竞争（FileLock 同进程语义跨平台不一致，不能真锁自测） */
    internal var lockRunner: (File, action: () -> Boolean) -> LockOutcome = { target, action ->
        withFileLock(target) { if (action()) LockOutcome.RAN else LockOutcome.FAILED } ?: LockOutcome.BUSY
    }

    /**
     * 全局共享存储（`~/.zcgui/quota-history.jsonl`，同机所有 IDE 产品共用一份曲线）。
     * home 参数化便于单测；user.home 不可用时返回 null（由 [defaultFile] 兜底）。
     */
    fun globalFile(home: String? = null): File? {
        val h = home ?: System.getProperty("user.home")
        return if (h.isNullOrBlank()) null else File(h, ".zcgui/quota-history.jsonl")
    }

    /** 默认存储文件：全局共享位优先，user.home 不可用时退回老位置（行为同 0.4.5）；均不可用返回 null（记录与读取关闭）*/
    fun defaultFile(): File? = globalFile() ?: legacyFallbackFile()

    /** 老版按 IDE 产品隔离的位置（0.4.5 及以前；迁移数据源 + user.home 不可用时的兜底） */
    private fun legacyFallbackFile(): File? = try {
        PathManager.getSystemDir().resolve("zcode-quota").resolve("quota-history.jsonl").toFile()
    } catch (e: Exception) {
        log.warn("quota history dir unavailable: ${e.javaClass.simpleName}: ${e.message}")
        null
    }

    private fun realSystemDir(): File? = try {
        PathManager.getSystemDir().toFile()
    } catch (e: Exception) {
        null
    }

    /**
     * 跨进程写互斥：sidecar 锁文件 + FileChannel.tryLock（非阻塞）。
     * 锁被其他 IDE 占有 / 锁文件不可用 → 返回 null（调用方跳过本拍，绝不阻塞等待）；
     * 进程崩溃时 OS 自动释放，无死锁面。仅写路径使用，读路径（load）不加锁。
     */
    private fun <T> withFileLock(target: File, action: () -> T): T? = try {
        target.parentFile?.mkdirs()
        java.io.RandomAccessFile(File(target.parentFile, target.name + ".lock"), "rw").use { raf ->
            val lock = raf.channel.tryLock() ?: return null
            try {
                action()
            } finally {
                lock.release()
            }
        }
    } catch (e: Exception) {
        log.warn("quota history lock failed: ${e.javaClass.simpleName}: ${e.message}")
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
     * 解析不到任何数值窗口 / 与上一条重复 / 锁被占 / 写盘失败 → 静默跳过（额度查询本身不受影响）。
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
        // 目标是全局共享文件时先做一次旧数据整合（进程内仅一次；测试注入的临时文件判等不中，绝不触碰真实目录）
        if (target == globalFile()) ensureMigrated(target, now)
        try {
            val sample = Sample(now, providerId, limits)
            lockRunner(target) {
                if (!shouldAppend(readLast(target), sample)) return@lockRunner true
                target.parentFile?.mkdirs()
                // appendText 默认 UTF-8；单行写入远小于一次系统调用上限，进程崩溃最多丢最后一行
                target.appendText(encode(sample) + "\n", Charsets.UTF_8)
                maybePrune(target, now)
                true
            }
        } catch (e: Exception) {
            log.warn("quota history record failed: ${e.javaClass.simpleName}: ${e.message}")
        }
    }

    /**
     * 读取最近 [days] 天的采样（升序）。days ≤ 0 按 1 处理，上限 [RETENTION_DAYS]。
     * 坏行跳过；文件不存在返回空数组。读路径不加文件锁（撞上写入半行由 decode 跳过）。
     */
    @Synchronized
    fun load(
        days: Int,
        now: Long = System.currentTimeMillis(),
        file: File? = defaultFile(),
    ): JsonArray {
        val target = file ?: return buildJsonArray {}
        if (target == globalFile()) ensureMigrated(target, now)
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

    // ============ 旧数据整合（0.4.5 按 IDE 产品隔离 → 全局共享） ============

    /**
     * 进程内首次 record/load 且目标是全局共享文件时收口一次：
     * 无旧数据 → 置完成标志不再扫描；锁被占 → 保持未完成下拍重试（不计失败）；
     * 合并失败 → 计数，连败 [MAX_MERGE_FAILURES] 次放弃（下次启动再试）。
     * 整体兜底 try-catch：迁移只是采样曲线的补全，任何意外异常都不能外溢影响
     * record/load 主流程（额度查询/展示），此时放弃本进程迁移。
     * systemDir 注入供单测。
     */
    internal fun ensureMigrated(target: File, now: Long, systemDir: File? = realSystemDir()) {
        if (migrationDone) return
        try {
            val sources = legacyFiles(systemDir)
            if (sources.isEmpty()) {
                migrationDone = true
                return
            }
            when (lockRunner(target) { mergeLegacyInto(target, now, sources) }) {
                LockOutcome.RAN -> migrationDone = true
                LockOutcome.BUSY -> {} // 别的 IDE 正在写，下个轮询周期再试
                LockOutcome.FAILED -> {
                    migrationFailures++
                    if (migrationFailures >= MAX_MERGE_FAILURES) {
                        migrationDone = true
                        log.warn("quota history migration gave up after $migrationFailures failures")
                    }
                }
            }
        } catch (e: Exception) {
            log.warn("quota history migration aborted: ${e.javaClass.simpleName}: ${e.message}")
            migrationDone = true
        }
    }

    /**
     * 旧版按产品隔离的采样文件全集：本产品旧位置 + 同根兄弟产品目录
     * （三平台 JetBrains 产品 system 目录同父，glob 不认产品名；Java File 默认跟随 symlink，
     * Toolbox 式软链的 system 目录同样命中）。按绝对路径去重（本产品两条来源同文件）。
     */
    internal fun legacyFiles(systemDir: File?): List<File> {
        if (systemDir == null) return emptyList()
        val out = LinkedHashMap<String, File>()
        fun add(f: File) {
            if (f.isFile) out[f.absolutePath] = f
        }
        add(File(systemDir, "zcode-quota/quota-history.jsonl"))
        systemDir.parentFile?.listFiles()?.forEach { productDir ->
            if (productDir.isDirectory) add(File(productDir, "zcode-quota/quota-history.jsonl"))
        }
        return out.values.toList()
    }

    /**
     * 把旧文件采样合并进全局文件：全局现有行 + 各旧文件行统一按规范化行去重
     * （[encode] 字段顺序固定，可作去重键）、保留窗过滤、ts 排序后原子重写；
     * 成功后旧文件改名 `.migrated`（保留现场；glob 只认精确文件名不会重复导入；
     * 改名失败不阻塞收口——数据已在全局，余量等下次启动补迁）。
     */
    private fun mergeLegacyInto(target: File, now: Long, sources: List<File>): Boolean = try {
        val cutoff = now - RETENTION_DAYS * DAY_MS
        val seen = HashSet<String>()
        val samples = ArrayList<Sample>()
        val absorbed = HashSet<String>() // 完整读完的旧文件才允许改名（读一半丢行 = 白丢采样）
        fun absorb(file: File) {
            try {
                file.forEachLine(Charsets.UTF_8) { line ->
                    val s = decode(line) ?: return@forEachLine
                    if (s.ts < cutoff) return@forEachLine
                    if (!seen.add(encode(s))) return@forEachLine
                    samples.add(s)
                }
                absorbed.add(file.absolutePath)
            } catch (e: Exception) {
                // 单个旧文件读失败只跳过该文件（IO 抖动），其余照常合并；该文件下次启动补迁
                log.warn("quota history legacy read failed: ${file.name}: ${e.message}")
            }
        }
        if (target.isFile) absorb(target)
        sources.forEach { absorb(it) }
        atomicRewrite(target, samples.sortedBy { it.ts }.takeLast(MAX_SAMPLES).map { encode(it) })
        sources.forEach { src ->
            if (src.absolutePath !in absorbed) return@forEach
            val renamed = File(src.parentFile, src.name + ".migrated")
            if (src.renameTo(renamed)) {
                log.info("quota history legacy merged: ${src.path}")
            } else {
                log.warn("quota history legacy rename failed (retry next start): ${src.path}")
            }
        }
        true
    } catch (e: Exception) {
        log.warn("quota history merge failed: ${e.javaClass.simpleName}: ${e.message}")
        false
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

    /**
     * 过滤出保留窗口内的合法行（保留原行，避免重编码引入格式漂移），
     * 再按行数硬顶裁到最新 [maxLines] 行——60 天窗口在极端高频变化下仍可能堆积，
     * 而 load 本就只读前 [MAX_SAMPLES] 条，超出的行没有留存价值。
     */
    internal fun pruneLines(lines: List<String>, now: Long, retentionDays: Int = RETENTION_DAYS, maxLines: Int = MAX_SAMPLES): List<String> {
        val cutoff = now - retentionDays * DAY_MS
        val kept = lines.filter { line ->
            val sample = decode(line) ?: return@filter false
            sample.ts >= cutoff
        }
        // 文件按 ts 追加（迁移时也排过序），takeLast 即最新
        return if (kept.size > maxLines) kept.takeLast(maxLines) else kept
    }

    /** 单测复位进程内状态（迁移标志/失败计数/锁注入），用后必调 */
    internal fun resetForTest() {
        migrationDone = false
        migrationFailures = 0
        lastPruneDay = ""
        lockRunner = { target, action ->
            withFileLock(target) { if (action()) LockOutcome.RAN else LockOutcome.FAILED } ?: LockOutcome.BUSY
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

    /** 原子重写：tmp + rename，Windows 上 rename 失败（目标被占）退回直接覆盖（迁移/prune 共用）*/
    private fun atomicRewrite(file: File, lines: List<String>) {
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.writeText(lines.joinToString("\n", postfix = if (lines.isEmpty()) "" else "\n"), Charsets.UTF_8)
        if (!tmp.renameTo(file)) {
            file.writeText(lines.joinToString("\n", postfix = if (lines.isEmpty()) "" else "\n"), Charsets.UTF_8)
            tmp.delete()
        }
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

    /** 每天最多重写一次：清掉超过 60 天的行与坏行（调用方已持文件锁） */
    private fun maybePrune(file: File, now: Long) {
        val day = java.time.LocalDate.now().toString()
        if (day == lastPruneDay) return
        lastPruneDay = day
        try {
            val lines = file.readLines(Charsets.UTF_8)
            val kept = pruneLines(lines, now)
            if (kept.size == lines.size) return
            atomicRewrite(file, kept)
            log.info("quota history pruned: ${lines.size} → ${kept.size} lines")
        } catch (e: Exception) {
            log.warn("quota history prune failed: ${e.javaClass.simpleName}: ${e.message}")
        }
    }
}
