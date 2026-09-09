package com.zcode.ideaplugin.ui

import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.zcode.ideaplugin.protocol.TaskIndexStore
import com.zcode.ideaplugin.zCodeService
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * 自动归档旧任务（对齐 ZCode 桌面客户端「设置→任务」同名功能，2026-09-08 asar 实证）
 *
 * - 配置与客户端共享：~/.zcode/v2/setting.json 的 taskAutoArchiveEnabled /
 *   taskAutoArchiveOlderThanDays（[ZCodeClientSettingStore]，客户端改了插件生效、反之亦然）
 * - 定时扫描本工作区（[TaskIndexStore.autoArchiveStale]：客户端同款判据 + 插件会话补行）；
 *   客户端不跑时自动归档依然由插件执行，两端写同一份 tasks-index 无冲突
 * - 归档记录落 project 级 PropertiesComponent（不上 webview localStorage：多标签同 origin
 *   串台坑），仅记录归档数 > 0 的轮次，供历史视图「自动归档」tab 展示与展开详情
 */
@Service(Service.Level.PROJECT)
class ZCodeAutoArchiveService(private val project: Project) : Disposable {

    /** 一轮扫描的归档条目（id + 当时标题，记录详情展示用） */
    data class ArchivedSessionRef(val sessionId: String, val title: String)

    /** 一轮扫描的归档记录（mode: auto=定时轮 / manual=手动触发；仅归档数>0 时落） */
    data class ArchiveRecord(
        val ts: Long,
        val mode: String,
        val days: Int,
        val count: Int,
        val sessions: List<ArchivedSessionRef>,
    )

    companion object {
        private val log = Logger.getInstance(ZCodeAutoArchiveService::class.java)

        /** 归档记录存储 key（project 级，JSON 数组，新记录插头部） */
        const val STORAGE_KEY = "zcode.autoArchiveRecords.v1"

        /** 最近成功扫描时间 key（独立于归档记录：大多数轮次归档 0 条不落记录，但时间要记） */
        const val LAST_SWEEP_KEY = "zcode.autoArchive.lastSweep.v1"

        /** 记录上限（超出丢最旧）；单轮归档条目上限（防御性：极端项目一次归档数百条） */
        const val RECORDS_MAX = 50
        private const val SESSIONS_MAX_PER_RECORD = 200
        private const val TITLE_MAX = 80

        /** 扫描周期与首轮延迟（归档是 7 天粒度的低频事务，30min 足够新鲜） */
        private const val SWEEP_PERIOD_MIN = 30L
        private const val FIRST_SWEEP_DELAY_MIN = 2L

        fun getInstance(project: Project): ZCodeAutoArchiveService =
            project.getService(ZCodeAutoArchiveService::class.java)

        // ============ 纯逻辑（单测直接覆盖，不依赖 Project） ============

        /** 新记录插头部 + 仅 >0 落 + 双上限截断；返回新列表（原列表超限丢尾） */
        fun appendRecord(records: List<ArchiveRecord>, record: ArchiveRecord): List<ArchiveRecord> {
            if (record.count <= 0) return records
            val trimmed = record.copy(
                sessions = record.sessions.take(SESSIONS_MAX_PER_RECORD).map {
                    it.copy(title = it.title.take(TITLE_MAX))
                },
            )
            return (listOf(trimmed) + records).take(RECORDS_MAX)
        }

        /** PropertiesComponent 存储形状：记录数组 → JSON（手写组装，模块无 serialization 编译插件） */
        fun recordsToJson(list: List<ArchiveRecord>): JsonArray = buildJsonArray {
            list.forEach { r ->
                add(buildJsonObject {
                    put("ts", r.ts)
                    put("mode", r.mode)
                    put("days", r.days)
                    put("count", r.count)
                    put("sessions", buildJsonArray {
                        r.sessions.forEach { s ->
                            add(buildJsonObject {
                                put("sessionId", s.sessionId)
                                put("title", s.title)
                            })
                        }
                    })
                })
            }
        }

        /** JSON → 记录列表（损坏/缺字段行丢弃，整体损坏降级空表，不阻塞展示） */
        fun parseRecords(raw: String?): List<ArchiveRecord> {
            if (raw.isNullOrBlank()) return emptyList()
            return try {
                Json.parseToJsonElement(raw).jsonArray.mapNotNull { el ->
                    val o = el as? kotlinx.serialization.json.JsonObject ?: return@mapNotNull null
                    val ts = o["ts"]?.jsonPrimitive?.longOrNull ?: return@mapNotNull null
                    val count = o["count"]?.jsonPrimitive?.intOrNull ?: return@mapNotNull null
                    ArchiveRecord(
                        ts = ts,
                        mode = o["mode"]?.jsonPrimitive?.contentOrNull ?: "auto",
                        days = o["days"]?.jsonPrimitive?.intOrNull ?: 7,
                        count = count,
                        sessions = (o["sessions"] as? JsonArray ?: JsonArray(emptyList())).mapNotNull { s ->
                            val so = s as? kotlinx.serialization.json.JsonObject ?: return@mapNotNull null
                            val sid = so["sessionId"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                            ArchivedSessionRef(sid, so["title"]?.jsonPrimitive?.contentOrNull ?: "")
                        },
                    )
                }
            } catch (_: Exception) {
                emptyList()
            }
        }
    }

    private val executor = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "ZCode-AutoArchive").apply { isDaemon = true }
    }

    init {
        executor.scheduleWithFixedDelay(
            { sweepSafely("auto") },
            FIRST_SWEEP_DELAY_MIN,
            SWEEP_PERIOD_MIN,
            TimeUnit.MINUTES,
        )
        log.info("[auto-archive] service initialized")
    }

    /** 读取全部归档记录（损坏降级空表，不阻塞展示） */
    fun loadRecords(): List<ArchiveRecord> = parseRecords(PropertiesComponent.getInstance(project).getValue(STORAGE_KEY))

    /** 最近一次成功扫描的时间戳（无论有无归档；0=从未扫过）。失败轮不更新。
     *  存字符串——241 平台 PropertiesComponent 无 long 存取重载 */
    fun lastSweepAt(): Long = PropertiesComponent.getInstance(project).getValue(LAST_SWEEP_KEY)?.toLongOrNull() ?: 0L

    /**
     * 单轮扫描（mode: auto=定时 / manual=手动触发）。
     * **两种模式都受共享开关约束**（用户定案 2026-09-08：未启用时手动扫描也不生效——
     * 「自动归档」tab 的立即扫描是提前触发定时轮，不是独立归档器）。
     * 返回本轮记录；未启用/无可归档/环境不可用/扫描失败返回 null（不落记录）。
     */
    fun runSweep(mode: String): ArchiveRecord? {
        val cfg = ZCodeClientSettingStore.readAutoArchiveConfig()
        if (!cfg.enabled) return null
        val basePath = project.basePath?.takeIf { it.isNotBlank() } ?: return null
        val client = try {
            project.zCodeService().getClient()
        } catch (e: Exception) {
            log.warn("[auto-archive] client unavailable, skip: ${e.message}"); return null
        }
        val archived: List<TaskIndexStore.ArchiveRef> = try {
            client.autoArchiveStaleSessions(basePath, cfg.olderThanDays)
        } catch (e: Exception) {
            log.warn("[auto-archive] sweep failed: ${e.message}"); return null
        }
        // 成功跑完就记最近扫描时间（无论归档 0 条还是 N 条——"最近扫描"是调度健康度信号，
        // 放在 isEmpty 判定之前；失败轮不更新，保持上一次成功值）
        PropertiesComponent.getInstance(project).setValue(LAST_SWEEP_KEY, System.currentTimeMillis().toString())
        if (archived.isEmpty()) return null
        val record = ArchiveRecord(
            ts = System.currentTimeMillis(),
            mode = mode,
            days = cfg.olderThanDays,
            count = archived.size,
            sessions = archived.map { ArchivedSessionRef(it.id, it.title) },
        )
        persistRecord(record)
        // 归档会话连带丢弃待发定时消息（对齐手动归档语义）；已发记录保留（历史徽标无害）
        val scheduled = ZCodeScheduledMessageService.getInstance(project)
        archived.forEach { scheduled.dropForSession(it.id) }
        log.info("[auto-archive] mode=$mode archived=${archived.size} days=${cfg.olderThanDays} workspace=$basePath")
        return record
    }

    /** 定时轮：异常吞掉（调度线程抛异常会静默停摆后续轮次） */
    private fun sweepSafely(mode: String) {
        try {
            runSweep(mode)
        } catch (e: Exception) {
            log.warn("[auto-archive] sweep error: ${e.message}")
        }
    }

    /** 记录落 PropertiesComponent（JSON；写入失败静默放弃——记录是锦上添花，不影响归档本体） */
    private fun persistRecord(record: ArchiveRecord) {
        try {
            val next = appendRecord(loadRecords(), record)
            PropertiesComponent.getInstance(project)
                .setValue(STORAGE_KEY, Json.encodeToString(JsonArray.serializer(), recordsToJson(next)))
        } catch (e: Exception) {
            log.warn("[auto-archive] persist record failed: ${e.message}")
        }
    }

    override fun dispose() {
        executor.shutdownNow()
    }
}
