package com.zcode.ideaplugin.ui

import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.zcode.ideaplugin.ZCodeBundle
import com.zcode.ideaplugin.protocol.model.Workspace
import com.zcode.ideaplugin.protocol.ZCodeProtocolException
import com.zcode.ideaplugin.zCodeService
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.time.DateTimeException
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * 会话内定时消息（B1 改判形态，2026-08-29）：用户给提示词指定执行时间，到点自动发出。
 *
 * 典型动机=额度经济（高峰倍率/额度刷新点后执行，不用掐点等）。纯客户端调度，零协议新依赖。
 *
 * 架构：
 *  - 权威待发列表在本服务（PropertiesComponent 持久化，跨 IDE 重启不丢），webview 只做镜像渲染；
 *  - 到点分派优先走 webview 准入路径（推 scheduledDue 给会话所在标签 → 前端 sendMessage：
 *    回合活跃入队尾/空闲直接发，与手动 Enter 同一段代码）；推送后 15s 无 ack 重推一轮
 *    （标签刚打开时前端 boot 未就绪），仍无 ack 降级本服务直发；
 *  - 标签不在/懒加载未激活：先开标签、不直发——直发会让回合跑在无人订阅的窗口里，
 *    标签打开后流式接不上（要等回合完成才看到内容，实测）；开标签每个 item 限一次，
 *    开过仍等不到就绪面板（webview 启动异常等）即记录失败并放弃自动分派，防标签风暴；
 *  - 绑定会话已不存在（「在新会话中执行」的空会话未落库即关 IDE、会话被删等）：开标签
 *    永远等不到就绪面板，分派时先验存在性，不存在直接按任务语义**新建会话补发**并打开
 *    新会话标签（gotoSession 点击死任务卡同样兜底，缺陷AH）；
 *  - 直发兜底（两轮推送均无 ack/面板中途消失）：client.send + 冷会话 -32004 resume 重试 +
 *    悬挂回合 -32010 延迟重扫（绝不 stop——定时消息不许打断正在跑的回合），成功后系统通知；
 *  - 错过策略：到点后 [GRACE_MS]（默认 30min）内扫到即补发；超宽限保持待发但卡片呈
 *    「已过期」，由用户决定立即执行/重新定时（避免 9 点高峰替用户跑 6 点想省倍率的单）；
 *  - 切会话回退例外：带定时标记的排队消息在切会话丢弃时经 scheduledRequeue 回到本服务
 *    （hold=true 不自动发，用户切回来再决定）。
 */
@Service(Service.Level.PROJECT)
class ZCodeScheduledMessageService(private val project: Project) : Disposable {

    companion object {
        private val log = Logger.getInstance(ZCodeScheduledMessageService::class.java)

        /** PropertiesComponent 存储 key（project 级，JSON 数组） */
        const val STORAGE_KEY = "zcode.scheduledMessages.v1"

        /** 已发记录存储 key（project 级，JSON 数组）——持久「定时执行」徽标数据源 */
        const val FIRED_STORAGE_KEY = "zcode.scheduledFiredHistory.v1"

        /** 已发记录上限（新记录插头部，超出丢最旧）——仅服务于徽标匹配与列表尾页，按用户要求只留最新 5 条 */
        const val FIRED_MAX = 5

        /** 到点后自动补发的宽限窗：超过则转「已过期」卡等用户手动决定 */
        const val GRACE_MS: Long = 30 * 60_000L

        /** scheduledDue 推送后等待 webview ack 的时长，超时降级直发 */
        private const val DUE_ACK_TIMEOUT_MS = 15_000L

        /** scheduledDue 最大推送轮次：标签刚打开时前端 boot 未就绪（currentSessionId 未到位），
         *  第一轮推送会被忽略，给第二轮机会；仍无 ack 才直发兜底 */
        private const val DUE_MAX_PUSH_ATTEMPTS = 2

        /** 扫描周期（墙钟判定，抗系统睡眠：醒来后按实际时间补判） */
        private const val SWEEP_PERIOD_MS = 20_000L

        /** 开标签后的快速探测间隔/次数：JCEF boot 数秒即绪，等下轮 20s 扫描太久；
         * 就绪即分派，探测用尽交还常规扫描兜底 */
        private const val ACCEL_PROBE_INTERVAL_MS = 2_000L
        private const val ACCEL_PROBES = 10

        fun getInstance(project: Project): ZCodeScheduledMessageService = project.getService(ZCodeScheduledMessageService::class.java)

        // ============ 纯逻辑（单测直接覆盖，不依赖 Project） ============

        /**
         * /goal 命令文本解析（与 webview utils/goalCommand.ts 同一语义）。
         * 定时文本若是 /goal 命令，直发兜底须转 session/goal RPC——普通 send 会把
         * 命令原文发给模型当 user 消息，goal 引擎不触发、目标卡不出现。
         * 非命令文本返回 null。
         */
        fun parseGoalCommand(text: String): GoalCommand? {
            val m = Regex("^/goal(?:\\s+([\\s\\S]+))?$").find(text.trimEnd()) ?: return null
            val arg = m.groupValues[1].trim()
            return when {
                arg.isEmpty() -> GoalCommand("show", null)
                arg.equals("pause", ignoreCase = true) -> GoalCommand("pause", null)
                arg.equals("resume", ignoreCase = true) -> GoalCommand("resume", null)
                arg.equals("clear", ignoreCase = true) -> GoalCommand("clear", null)
                else -> GoalCommand("set", arg)
            }
        }

        /** 到点且在宽限窗内才自动分派；hold（切会话回退挂起）永不自动 */
        fun shouldAutoFire(item: Item, now: Long, graceMs: Long = GRACE_MS): Boolean =
            !item.hold && item.fireAt <= now && now - item.fireAt <= graceMs

        /**
         * 自动分派候选：到点在宽限窗内、未挂起、且未被放弃。
         * giveUp = 开过一次标签仍等不到就绪面板的项（会话多半已不存在），转手动决定，
         * 不再参与自动分派（防每轮 sweep 重复开标签的标签风暴，实测缺陷）。
         */
        fun autoDispatchCandidates(
            items: List<Item>,
            now: Long,
            graceMs: Long = GRACE_MS,
            giveUp: Set<String> = emptySet(),
        ): List<Item> = items.filter { it.id !in giveUp && shouldAutoFire(it, now, graceMs) }

        fun itemsToJson(list: List<Item>): JsonArray = buildJsonArray {
            list.forEach { it ->
                add(
                    buildJsonObject {
                        put("id", it.id)
                        put("sessionId", it.sessionId)
                        put("workspacePath", it.workspacePath)
                        put("text", it.text)
                        put("fireAt", it.fireAt)
                        put("createdAt", it.createdAt)
                        put("hold", it.hold)
                        // 执行模型（可空=跟随会话当前模型）；条件 put 防 null 重载歧义
                        it.providerId?.let { v -> put("providerId", v) }
                        it.modelId?.let { v -> put("modelId", v) }
                        it.title?.let { v -> put("title", v) }
                    }
                )
            }
        }

        fun parseItems(raw: String?): List<Item> {
            if (raw.isNullOrBlank()) return emptyList()
            return try {
                Json.parseToJsonElement(raw).jsonArray.mapNotNull { el ->
                    val o = el as? JsonObject ?: return@mapNotNull null
                    val id = o["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                    val sessionId = o["sessionId"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                    val text = o["text"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                    val fireAt = o["fireAt"]?.jsonPrimitive?.longOrNull ?: return@mapNotNull null
                    Item(
                        id = id,
                        sessionId = sessionId,
                        workspacePath = o["workspacePath"]?.jsonPrimitive?.contentOrNull ?: "",
                        text = text,
                        fireAt = fireAt,
                        createdAt = o["createdAt"]?.jsonPrimitive?.longOrNull ?: 0L,
                        hold = o["hold"]?.jsonPrimitive?.booleanOrNull ?: false,
                        providerId = o["providerId"]?.jsonPrimitive?.contentOrNull,
                        modelId = o["modelId"]?.jsonPrimitive?.contentOrNull,
                        title = o["title"]?.jsonPrimitive?.contentOrNull,
                    )
                }
            } catch (_: Exception) {
                emptyList()
            }
        }

        fun firedToJson(list: List<FireRecord>): JsonArray = buildJsonArray {
            list.forEach { f ->
                add(
                    buildJsonObject {
                        put("sessionId", f.sessionId)
                        put("text", f.text)
                        put("fireAt", f.fireAt)
                        put("firedAt", f.firedAt)
                    }
                )
            }
        }

        fun parseFired(raw: String?): List<FireRecord> {
            if (raw.isNullOrBlank()) return emptyList()
            return try {
                Json.parseToJsonElement(raw).jsonArray.mapNotNull { el ->
                    val o = el as? JsonObject ?: return@mapNotNull null
                    FireRecord(
                        sessionId = o["sessionId"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null,
                        text = o["text"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null,
                        fireAt = o["fireAt"]?.jsonPrimitive?.longOrNull ?: return@mapNotNull null,
                        firedAt = o["firedAt"]?.jsonPrimitive?.longOrNull ?: 0L,
                    )
                }
            } catch (_: Exception) {
                emptyList()
            }
        }

        // ============ automation/* 宿主反向请求的纯映射（AI 的 Cron* 工具落点） ============

        /** 官方一次性 cron 形状（app.asar zSe）：四个纯数字字段 + 星期 *，如 "0 9 30 7 *" */
        private val PINNED_ONE_SHOT_CRON = Regex("""^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\*$""")

        /** 一次性任务「刚错过」窗口（官方 USe=60s）：窗口内视为立即执行 */
        private const val RUN_NOW_WINDOW_MS = 60_000L

        /** 第一期不支持的计划形状统一话术（模型可读，随 -32603 回给 app-server） */
        const val UNSUPPORTED_SCHEDULE_MSG =
            "插件当前版本仅支持一次性定时任务（相对延时或指定未来时刻），暂不支持周期性/多次运行任务"

        /**
         * 解析一次性 cron（"分 时 日 月 *"，本地时区）为触发时刻，过期语义对齐官方
         * computeInitialAutomationNextRunAt：最近一次过去触发在宽限窗（30min=GRACE_MS）
         * 内且下次触发在宽限窗外——错过不足 60s 立即执行（返回 now），否则抛过期错误；
         * 其余取下次未来触发（年度翻转，覆盖「明年1月」类跨年目标）。
         */
        fun pinnedOneShotFireAt(cronExpr: String, now: Long): Long {
            val m = PINNED_ONE_SHOT_CRON.find(cronExpr.trim())
                ?: throw AutomationHostError(
                    "cronExpr 形态暂不支持：仅支持 \"分 时 日 月 *\" 的绝对时刻一次性表达式（周期/区间/步进将在后续版本支持）",
                )
            val (minute, hour, dom, month) = m.destructured
            val min = minute.toInt(); val hr = hour.toInt(); val day = dom.toInt(); val mon = month.toInt()
            if (min !in 0..59 || hr !in 0..23 || day !in 1..31 || mon !in 1..12) {
                throw AutomationHostError("cronExpr 时间字段超范围：分 0-59、时 0-23、日 1-31、月 1-12")
            }
            val zone = ZoneId.systemDefault()
            val year = Instant.ofEpochMilli(now).atZone(zone).year
            // 年度触发点取本年/前后一年三个候选（2/29 等非常规日期跳过无效年份）
            val occurrences = (year - 1..year + 1).mapNotNull { y ->
                try {
                    ZonedDateTime.of(y, mon, day, hr, min, 0, 0, zone).toInstant().toEpochMilli()
                } catch (_: DateTimeException) {
                    null
                }
            }
            val next = occurrences.filter { it >= now }.minOrNull()
                ?: throw AutomationHostError("cronExpr 日期无效（如 2 月 30 日）或超出可调度范围")
            val prev = occurrences.filter { it <= now }.maxOrNull()
            val missedBy = prev?.let { if (now >= it && now - it <= GRACE_MS) now - it else null }
            if (missedBy != null && (next - now) > GRACE_MS) {
                if (missedBy < RUN_NOW_WINDOW_MS) return now
                throw AutomationHostError(
                    "一次性定时任务的目标时间（${formatLocal(prev)}）已过去；相对时间请使用 delayMinutes，绝对时间请确认未来时刻后重试",
                )
            }
            return next
        }

        /** 一次性 cron 显示形态（与官方 buildRelativeDelaySchedule 一致）：fireAt → "分 时 日 月 *" */
        fun oneShotCronFromFireAt(fireAt: Long): String {
            val t = Instant.ofEpochMilli(fireAt).atZone(ZoneId.systemDefault())
            return "${t.minute} ${t.hour} ${t.dayOfMonth} ${t.monthValue} *"
        }

        private fun formatLocal(epochMs: Long): String =
            Instant.ofEpochMilli(epochMs).atZone(ZoneId.systemDefault())
                .format(java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm"))

        /** 标题缺省派生：提示词首行截 24 字（官方 CronCreate 必带 title，此为兜底） */
        fun deriveTitle(text: String): String {
            val firstLine = text.trim().lineSequence().firstOrNull() ?: ""
            return if (firstLine.length <= 24) firstLine else firstLine.take(24) + "…"
        }

        /**
         * automation/create 参数校验与触发时刻计算（第一期仅一次性）。
         * 不合形状一律抛 [AutomationHostError]——message 即模型可见的工具错误。
         */
        fun automationCreateToSpec(params: JsonObject, now: Long): AutomationCreateSpec {
            val prompt = params["prompt"]?.jsonPrimitive?.contentOrNull?.trim()
            if (prompt.isNullOrEmpty()) throw AutomationHostError("缺少 prompt（定时任务要发送的提示词）")
            val targetTaskId = params["targetTaskId"]?.jsonPrimitive?.contentOrNull?.trim()
            if (targetTaskId.isNullOrEmpty()) {
                throw AutomationHostError("缺少 targetTaskId（目标会话）：请在已有会话中创建定时任务")
            }
            val hasInterval = params["intervalUnit"] != null || params["interval"] != null
            val recurring = params["recurring"]?.jsonPrimitive?.booleanOrNull ?: true
            val maxRuns = params["maxRuns"]?.jsonPrimitive?.longOrNull
            if (hasInterval || recurring || (maxRuns != null && maxRuns > 1)) {
                throw AutomationHostError(UNSUPPORTED_SCHEDULE_MSG)
            }
            // CronCreate 的延时形态带占位 cron "* * * * *"，以 relativeDelayMinutes 为准
            val delayMin = params["relativeDelayMinutes"]?.jsonPrimitive?.longOrNull
            val fireAt = if (delayMin != null) {
                if (delayMin < 1 || delayMin > 525_600) {
                    throw AutomationHostError("relativeDelayMinutes 无效：须为 1~525600 的整数分钟")
                }
                now + delayMin * 60_000
            } else {
                val cronExpr = params["cronExpr"]?.jsonPrimitive?.contentOrNull
                if (cronExpr.isNullOrBlank()) {
                    throw AutomationHostError("缺少触发时间：relativeDelayMinutes 与 cronExpr 至少提供一项")
                }
                pinnedOneShotFireAt(cronExpr, now)
            }
            val title = params["title"]?.jsonPrimitive?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }
                ?: deriveTitle(prompt)
            return AutomationCreateSpec(prompt = prompt, targetTaskId = targetTaskId, fireAt = fireAt, title = title)
        }

        /**
         * 待发 Item → automation/list|create|update 应答条目。字段集严格对齐 zcode.cjs
         * 的 $je schema（strict，多余字段校验失败直接打断工具调用）：必填八项 +
         * 可选 nextRunAt/targetTaskId；model/provider/mode/thoughtLevel 不回填——
         * 插件执行侧本就跟随会话模型。
         */
        fun itemToAutomation(item: Item): JsonObject = buildJsonObject {
            put("automationId", item.id)
            put("title", item.title ?: deriveTitle(item.text))
            put("cronExpr", oneShotCronFromFireAt(item.fireAt))
            put("prompt", item.text)
            put("enabled", true)
            put("lifecycleStatus", "active")
            put("nextRunAt", item.fireAt)
            put("runCount", 0)
            put("recurring", false)
            if (item.sessionId.isNotBlank()) put("targetTaskId", item.sessionId)
        }
    }

    /** /goal 命令解析结果：action ∈ set/pause/resume/clear/show；仅 set 带 objective */
    data class GoalCommand(val action: String, val objective: String?)

    /** automation/create 校验后的落库参数（第一期仅一次性任务） */
    data class AutomationCreateSpec(
        val prompt: String,
        val targetTaskId: String,
        val fireAt: Long,
        val title: String,
    )

    /** automation 反向请求的业务性拒绝（message 面向模型可读，随 -32603 回给 app-server） */
    class AutomationHostError(message: String) : RuntimeException(message)

    /** 待发定时消息（FIRED/CANCELLED 即时移除不保留——发出后的消息本身就是记录） */
    data class Item(
        val id: String,
        val sessionId: String,
        val workspacePath: String,
        val text: String,
        val fireAt: Long,
        val createdAt: Long,
        /** 切会话回退的挂起项：永不自动发，只呈「已过期」式卡片等用户手动决定 */
        val hold: Boolean = false,
        /** 执行模型（可空=跟随会话当前模型）；执行时模型不在清单则默认兜底 */
        val providerId: String? = null,
        val modelId: String? = null,
        /** 任务标题（AI 经 automation/create 创建时携带；用户手工建的可空=按提示词派生） */
        val title: String? = null,
    )

    /**
     * 已发定时消息记录：消息真正发出后留存（sessionId+text 匹配），供 webview 渲染
     * 「定时执行」徽标——后台直发/历史重拉/IDE 重启后，服务端消息本身不带任何定时标记，
     * 只能靠这条本地映射还原。webview 真发（sendMessage）与 Java 直发两条路径都上报。
     */
    data class FireRecord(
        val sessionId: String,
        val text: String,
        val fireAt: Long,
        val firedAt: Long,
    )

    private val items = CopyOnWriteArrayList<Item>()

    private val fired = CopyOnWriteArrayList<FireRecord>()

    /** 已推送 scheduledDue、等待 webview ack 的 id（超时降级直发） */
    private val awaitingAck = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    /** 已为该 item 自动开过会话标签（每个 item 只开一次，面板仍未就绪不再重复开） */
    private val tabOpenedFor = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    /** 自动分派已放弃的 item（开标签一次仍不就绪=会话多半已不存在），等用户手动决定 */
    private val autoGiveUp = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    /** 已在「过期」日志播报过的 id（防扫看日志风暴） */
    private val expiredLogged = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    private val executor = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "ZCode-ScheduledMessage-Sweep").apply { isDaemon = true }
    }

    init {
        loadFromStorage()
        loadFired()
        Disposer.register(this) { executor.shutdownNow() }
        executor.scheduleWithFixedDelay({ sweepSafely() }, SWEEP_PERIOD_MS / 2, SWEEP_PERIOD_MS, TimeUnit.MILLISECONDS)
        log.info("[scheduled] service initialized, pending=${items.size} fired=${fired.size}")
    }

    // ============ 对 webview 的 op 入口（ZCodeToolWindowPanel 分发） ============

    /** op:scheduledCreate——新建定时消息（fireAt 过早时钳到 +10s；可指定执行模型，空=跟随会话） */
    fun create(
        sessionId: String,
        workspacePath: String,
        text: String,
        fireAt: Long,
        providerId: String? = null,
        modelId: String? = null,
        title: String? = null,
    ): Item? {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return null
        val now = System.currentTimeMillis()
        val item = Item(
            id = "sched_${now}_${(100..999).random()}",
            sessionId = sessionId,
            workspacePath = workspacePath,
            text = trimmed,
            fireAt = maxOf(fireAt, now + 10_000),
            createdAt = now,
            providerId = providerId?.takeIf { it.isNotBlank() },
            modelId = modelId?.takeIf { it.isNotBlank() },
            title = title?.takeIf { it.isNotBlank() },
        )
        items.add(item)
        persistAndBroadcast()
        log.info("[scheduled] created id=${item.id} session=$sessionId fireAt=${item.fireAt}")
        return item
    }

    fun cancel(id: String): Boolean = removeById(id, "cancel")

    /**
     * op:scheduledReschedule——改时间（可同时改提示词/标题）并解除挂起（重定时间=重新参与自动分派）。
     * updateModel=true 时一并更新执行模型（modelId/providerId 空串=清空改回跟随会话）。
     */
    fun reschedule(
        id: String,
        fireAt: Long,
        text: String? = null,
        providerId: String? = null,
        modelId: String? = null,
        updateModel: Boolean = false,
        title: String? = null,
    ): Boolean {
        val idx = items.indexOfFirst { it.id == id }
        if (idx < 0) return false
        val old = items[idx]
        val newText = text?.trim().takeUnless { it.isNullOrEmpty() } ?: old.text
        val newTitle = title?.trim().takeUnless { it.isNullOrEmpty() } ?: old.title
        items[idx] = if (updateModel) {
            old.copy(
                text = newText,
                fireAt = maxOf(fireAt, System.currentTimeMillis() + 10_000),
                hold = false,
                providerId = providerId?.takeIf { it.isNotBlank() },
                modelId = modelId?.takeIf { it.isNotBlank() },
                title = newTitle,
            )
        } else {
            old.copy(
                text = newText,
                fireAt = maxOf(fireAt, System.currentTimeMillis() + 10_000),
                hold = false,
                title = newTitle,
            )
        }
        expiredLogged.remove(id)
        // 重新定时=重新获得自动分派资格（含开标签一次的机会）
        autoGiveUp.remove(id)
        tabOpenedFor.remove(id)
        persistAndBroadcast()
        log.info("[scheduled] rescheduled id=$id fireAt=${items[idx].fireAt} (textEdited=${newText != old.text})")
        return true
    }

    /** op:scheduledSendNow——立即执行（走与到点一致的准入分派；挂起项同样放行）。
     *  项不存在时静默成功：webview 镜像可能滞后（乐观移除已发生/广播在途），报错只会误导。
     *  手动执行不受「开标签限一次」约束：清掉自动分派失败态，允许再开一次标签 */
    fun sendNow(id: String): Boolean {
        val item = items.firstOrNull { it.id == id } ?: return true
        autoGiveUp.remove(id)
        tabOpenedFor.remove(id)
        dispatch(item)
        return true
    }

    /** op:scheduledRequeue——切会话丢弃队列时，定时来源的消息回退挂起（不自动发；执行模型随行保留） */
    fun requeueOnSessionLeave(
        sessionId: String,
        workspacePath: String,
        text: String,
        fireAt: Long,
        providerId: String? = null,
        modelId: String? = null,
    ) {
        val trimmed = text.trim()
        if (sessionId.isBlank() || trimmed.isEmpty()) return
        val now = System.currentTimeMillis()
        items.add(
            Item(
                id = "sched_${now}_${(100..999).random()}",
                sessionId = sessionId,
                workspacePath = workspacePath,
                text = trimmed,
                fireAt = fireAt,
                createdAt = now,
                hold = true,
                providerId = providerId?.takeIf { it.isNotBlank() },
                modelId = modelId?.takeIf { it.isNotBlank() },
            )
        )
        persistAndBroadcast()
        log.info("[scheduled] requeued (hold) session=$sessionId fireAt=$fireAt")
    }

    /** op:scheduledDueAck——webview 已受理到点消息（入队或已发），移除并广播 */
    fun onDueAck(id: String) {
        if (awaitingAck.remove(id)) {
            log.info("[scheduled] due ack received id=$id")
        }
        removeById(id, "fired-ack")
    }

    /** op:scheduledFired——webview 真发定时消息上报（sendMessage 真发点；直发路径服务端自记） */
    fun onFiredReport(sessionId: String, text: String, fireAt: Long) {
        recordFired(sessionId, text, fireAt)
    }

    /** 记录一条已发定时消息（同 sessionId+text+fireAt 幂等；随 scheduledList 广播给全部面板） */
    private fun recordFired(sessionId: String, text: String, fireAt: Long) {
        if (sessionId.isBlank() || text.isBlank()) return
        if (fired.any { it.sessionId == sessionId && it.text == text && it.fireAt == fireAt }) return
        fired.add(0, FireRecord(sessionId, text, fireAt, System.currentTimeMillis()))
        while (fired.size > FIRED_MAX) fired.removeAt(fired.size - 1)
        persistFired()
        broadcastList()
        log.info("[scheduled] fired recorded session=$sessionId fireAt=$fireAt total=${fired.size}")
    }

    /** op:scheduledList——webview 初始化水合：把全量列表推给请求面板 */
    fun pushListTo(panel: ZCodeToolWindowPanel) {
        panel.pushToWebview(buildListMessage())
    }

    /** 会话删除/归档：丢弃该会话的全部待发消息与已发记录 */
    fun dropForSession(sessionId: String) {
        val removed = items.removeIf { it.sessionId == sessionId }
        val removedFired = fired.removeIf { it.sessionId == sessionId }
        if (removed || removedFired) {
            if (removedFired) persistFired()
            persistAndBroadcast()
            log.info("[scheduled] dropped all for session=$sessionId (fired=$removedFired)")
        }
    }

    // ============ automation/* 宿主反向请求（AI 的 Cron* 工具落点） ============

    /**
     * automation/create|update|list|delete|checkTaskBinding 统一入口。app-server 把模型的
     * CronCreate/CronUpdate/CronList/CronDelete 工具调用中继成 stdio 反向请求落到宿主，
     * 插件以既有待发列表为宿主任务存储（官方为 Electron 独立 sqlite，互不共写）。
     * 业务拒绝抛 [AutomationHostError]，由协议客户端转 -32603（message=模型可读的错误）。
     * 在反向请求线程调用（本地存储读写，勿在 EDT）。
     */
    fun handleAutomationRequest(method: String, params: JsonObject): JsonObject = when (method) {
        "automation/create" -> handleAutomationCreate(params)
        "automation/list" -> buildJsonObject {
            put("automations", buildJsonArray {
                // 用户手工建与 AI 建的待发项统一呈现（已发/过期历史不进 CronList，第一期从简）
                items.sortedBy { it.fireAt }.forEach { add(itemToAutomation(it)) }
            })
        }
        "automation/delete" -> {
            val id = params.requiredString("automationId")
            buildJsonObject { put("deleted", cancel(id)) }
        }
        "automation/update" -> handleAutomationUpdate(params)
        "automation/checkTaskBinding" -> {
            // 官方语义=目标会话已有绑定任务则禁止再建（CronCreate 前置校验）。
            // 只看待发项：已发记录有 LRU 淘汰，拿它当绑定依据会不稳定
            val target = params.requiredString("targetTaskId")
            buildJsonObject { put("bound", items.any { it.sessionId == target }) }
        }
        else -> throw AutomationHostError("未实现的 automation 方法: $method")
    }

    private fun JsonObject.requiredString(key: String): String =
        this[key]?.jsonPrimitive?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }
            ?: throw AutomationHostError("缺少 $key 参数")

    private fun handleAutomationCreate(params: JsonObject): JsonObject {
        val spec = automationCreateToSpec(params, System.currentTimeMillis())
        val item = create(
            sessionId = spec.targetTaskId,
            workspacePath = project.basePath ?: "",
            text = spec.prompt,
            fireAt = spec.fireAt,
            title = spec.title,
        ) ?: throw AutomationHostError("创建定时任务失败：提示词为空")
        log.info("[automation] created via AI id=${item.id} session=${item.sessionId} fireAt=${item.fireAt}")
        return buildJsonObject { put("automation", itemToAutomation(item)) }
    }

    private fun handleAutomationUpdate(params: JsonObject): JsonObject {
        val id = params.requiredString("automationId")
        val hasInterval = params["intervalUnit"] != null || params["interval"] != null
        val recurring = params["recurring"]?.jsonPrimitive?.booleanOrNull
        val maxRuns = params["maxRuns"]?.jsonPrimitive?.longOrNull
        if (hasInterval || recurring == true || (maxRuns != null && maxRuns > 1)) {
            throw AutomationHostError(UNSUPPORTED_SCHEDULE_MSG)
        }
        val old = items.firstOrNull { it.id == id }
            ?: throw AutomationHostError("Scheduled task not found in the current workspace.")
        val cronExpr = params["cronExpr"]?.jsonPrimitive?.contentOrNull
        val newFireAt = if (cronExpr.isNullOrBlank()) old.fireAt
        else pinnedOneShotFireAt(cronExpr, System.currentTimeMillis())
        val prompt = params["prompt"]?.jsonPrimitive?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }
        val title = params["title"]?.jsonPrimitive?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }
        if (!reschedule(id = id, fireAt = newFireAt, text = prompt, title = title)) {
            throw AutomationHostError("Scheduled task not found in the current workspace.")
        }
        log.info("[automation] updated via AI id=$id fireAt=${newFireAt}")
        return buildJsonObject { put("automation", itemToAutomation(items.first { it.id == id })) }
    }

    // ============ 扫描与分派 ============

    private fun sweepSafely() {
        try {
            sweep(System.currentTimeMillis())
        } catch (e: Exception) {
            log.warn("[scheduled] sweep failed: ${e.message}")
        }
    }

    internal fun sweep(now: Long) {
        val due = autoDispatchCandidates(items, now, giveUp = autoGiveUp)
        // 超宽限的播报一次（卡片由 webview 按 fireAt 自行呈「已过期」态）
        items.filter { !it.hold && it.fireAt <= now - GRACE_MS }
            .forEach { if (expiredLogged.add(it.id)) log.info("[scheduled] expired beyond grace, holding for manual decision id=${it.id}") }
        due.forEach { dispatch(it) }
    }

    /**
     * 分派单条：优先 webview 准入路径（回合活跃入队尾/空闲直接发，与手动发送同一段代码）。
     * 标签不在/懒加载未激活时**先开标签、不直发**——直发会让回合跑在无人订阅的窗口里，
     * 标签打开后流式接不上（只能等回合完成才看到内容，实测）；开标签后下轮扫描改走推送，
     * 消息由前端在订阅就绪后发出，流式全程在线。开标签每个 item 限一次（tabOpenedFor），
     * 再走不到就绪面板即放弃自动分派（autoGiveUp）。无会话项（sessionId 空）路由当前激活面板。
     */
    private fun dispatch(item: Item) {
        if (!awaitingAck.add(item.id)) return // 已在途，防重入
        val sessionless = item.sessionId.isBlank()
        val panelReady = if (sessionless) {
            project.zCodeService().getActivePanel()?.canPushToWebview() == true
        } else {
            project.zCodeService().findPanelForSession(item.sessionId)?.canPushToWebview() == true
        }
        if (panelReady) {
            pushDue(item, 1)
            return
        }
        awaitingAck.remove(item.id)
        if (sessionless) {
            log.info("[scheduled] no active panel for session-less item, will retry next sweep id=${item.id}")
            return
        }
        // 绑定会话已不存在（「在新会话中执行」的空会话未落库即关 IDE、会话被删等）：
        // 开标签永远等不到就绪面板，直接按任务语义新建会话补发，不再白开死标签（缺陷AH）
        if (!sessionExists(item)) {
            fallbackNewSessionSend(item)
            return
        }
        if (!tabOpenedFor.add(item.id)) {
            // 会话标签只自动开一次：开过（含加速探测 20s + 下轮扫描）仍无就绪面板
            // （webview 启动异常等），记录失败并放弃自动分派，项保持待发由用户手动决定
            autoGiveUp.add(item.id)
            log.warn("[scheduled] session tab opened once but panel never ready, giving up auto-dispatch (kept pending for manual decision) id=${item.id} session=${item.sessionId}")
            return
        }
        log.info("[scheduled] no ready panel, opening session tab first (accelerated probe after open) id=${item.id} session=${item.sessionId}")
        openSessionTabOnEdt(item.sessionId)
        accelerateAfterTabOpen(item.id, item.sessionId)
    }

    /**
     * 会话存在性校验：session/list（workspace 过滤，limit 放宽防大列表截断漏判）。
     * 查询失败按存在处理（fail-soft，宁可多走开标签路径也不误建新会话分叉）。
     * 含阻塞 RPC，勿在 EDT 调用。
     */
    private fun sessionExists(item: Item): Boolean = try {
        project.zCodeService().getClient()
            .listSessions(item.workspacePath.ifBlank { null }, limit = 1000)
            .any { it.sessionId == item.sessionId }
    } catch (e: Exception) {
        log.warn("[scheduled] session existence check failed, assume exists id=${item.id}: ${e.message}")
        true
    }

    /**
     * 会话已消失时的兜底补发：按任务语义新建会话发出消息（「在新会话中执行」的本意即
     * 新会话承载），成功即移除项、记录已发、系统通知并打开新会话标签。任何失败保持
     * 待发并放弃自动分派（防每轮 sweep 重复建会话的循环），由用户手动决定。
     */
    private fun fallbackNewSessionSend(item: Item) {
        if (!awaitingAck.add(item.id)) return // 防点击跳转与 sweep 并发双发
        log.info("[scheduled] bound session missing, falling back to fresh session send id=${item.id} session=${item.sessionId}")
        val newSid = try {
            val client = project.zCodeService().getClient()
            val sid = client.createSession(
                Workspace(item.workspacePath),
                com.zcode.ideaplugin.protocol.model.PermissionMode.YOLO,
            )
            try {
                client.send(sid, item.text, item.workspacePath, providerId = item.providerId, modelId = item.modelId)
            } catch (e: ZCodeProtocolException) {
                val unsupportedModel = (e.code == -32603 || e.message?.contains("-32603") == true) &&
                    e.message?.contains("Unsupported model", ignoreCase = true) == true
                if (unsupportedModel && item.modelId != null) {
                    log.info("[scheduled] specified model unavailable on fallback, retry default id=${item.id} model=${item.modelId}")
                    client.send(sid, item.text, item.workspacePath)
                } else {
                    throw e
                }
            }
            sid
        } catch (e: Exception) {
            log.warn("[scheduled] fallback fresh-session send failed, giving up auto-dispatch (kept pending) id=${item.id}: ${e.message}")
            autoGiveUp.add(item.id)
            awaitingAck.remove(item.id)
            return
        }
        removeById(item.id, "fired-fallback-new-session")
        recordFired(newSid, item.text, item.fireAt)
        ZCodeNotifyService.notifyScheduledFired(project, newSid, item.text)
        openSessionTabOnEdt(newSid)
        log.info("[scheduled] fallback fresh-session send succeeded id=${item.id} newSession=$newSid")
    }

    /**
     * gotoSession 点击兜底：该会话挂有待发定时任务且会话已不存在时，跳转只会白开死标签
     * （实测缺陷AH），转「新会话补发」执行任务并打开新会话标签。会话存在或无关联任务
     * 返回 false（调用方走正常跳转）。含阻塞 RPC，勿在 EDT 调用。
     */
    fun tryFallbackDeadSession(sessionId: String): Boolean {
        val item = items.firstOrNull { it.sessionId == sessionId && !it.hold } ?: return false
        if (sessionExists(item)) return false
        fallbackNewSessionSend(item)
        return true
    }

    /**
     * 开标签后快速探测推送：标签创建到 JCEF 可推送只差数秒，干等下轮 20s 扫描表现为
     * 「打开标签好久才发消息」。每 [ACCEL_PROBE_INTERVAL_MS] 探测一次面板就绪，
     * 就绪即 dispatch（防重入由 awaitingAck 保证，与常规扫描并发安全）。
     */
    private fun accelerateAfterTabOpen(id: String, sessionId: String) {
        repeat(ACCEL_PROBES) { i ->
            executor.schedule({
                if (project.isDisposed) return@schedule
                val item = items.firstOrNull { it.id == id } ?: return@schedule
                val ready = try {
                    project.zCodeService().findPanelForSession(sessionId)?.canPushToWebview() == true
                } catch (e: Exception) {
                    false
                }
                if (ready) dispatch(item)
            }, ACCEL_PROBE_INTERVAL_MS * (i + 1), TimeUnit.MILLISECONDS)
        }
    }

    /**
     * webview 准入推送（scheduledDue）：前端受理（入队或已发）即 ack。[DUE_MAX_PUSH_ATTEMPTS]
     * 轮无 ack 且面板仍就绪则重推（标签刚打开 boot 慢），面板不在或轮次用尽才直发兜底。
     */
    private fun pushDue(item: Item, attempt: Int) {
        val sessionless = item.sessionId.isBlank()
        val panel = if (sessionless) project.zCodeService().getActivePanel()
        else project.zCodeService().findPanelForSession(item.sessionId)
        if (panel == null || !panel.canPushToWebview()) {
            awaitingAck.remove(item.id)
            if (sessionless) {
                log.info("[scheduled] no active panel for session-less item, will retry next sweep id=${item.id}")
            } else {
                log.warn("[scheduled] panel gone before push, falling back to direct send id=${item.id}")
                directSend(item)
            }
            return
        }
        log.info("[scheduled] dispatch via webview (attempt=$attempt) id=${item.id} session=${item.sessionId.ifBlank { "<standby>" }}")
        panel.pushToWebview(
            buildJsonObject {
                put("op", "scheduledDue")
                put("id", item.id)
                put("sessionId", item.sessionId)
                put("text", item.text)
                put("scheduledFireAt", item.fireAt)
                item.providerId?.let { v -> put("providerId", v) }
                item.modelId?.let { v -> put("modelId", v) }
            }
        )
        executor.schedule({
            if (awaitingAck.remove(item.id)) {
                val stillReady = !sessionless &&
                    project.zCodeService().findPanelForSession(item.sessionId)?.canPushToWebview() == true
                if (attempt < DUE_MAX_PUSH_ATTEMPTS && stillReady) {
                    log.info("[scheduled] due ack timeout, webview likely still booting, retry push id=${item.id}")
                    pushDue(item, attempt + 1)
                } else if (sessionless) {
                    log.info("[scheduled] due ack timeout for session-less item, will retry next sweep id=${item.id}")
                } else {
                    log.warn("[scheduled] due ack timeout, falling back to direct send id=${item.id}")
                    directSend(item)
                }
            }
        }, DUE_ACK_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    }

    /**
     * 直发：冷会话 -32004 先 resume 再重试；-32010（prompt running）延迟重扫——
     * 定时消息绝不 stop 打断正在跑的回合；指定模型已下架（-32603 Unsupported model）
     * 按约定默认兜底（不带模型=会话当前/服务端默认）重试一次；其余错误保持待发下轮再试。
     * 成功即移除+记录已发+通知。
     */
    private fun directSend(item: Item) {
        // /goal 命令文本转 session/goal RPC（与 webview 受理路径同语义），不入对话流
        parseGoalCommand(item.text)?.let { directGoal(item, it); return }
        val sent = try {
            val client = project.zCodeService().getClient()
            try {
                client.send(item.sessionId, item.text, item.workspacePath, providerId = item.providerId, modelId = item.modelId)
                true
            } catch (e: ZCodeProtocolException) {
                val cold = ZCodeProtocolException.isSessionUnavailableText(e.message)
                val running = e.code == -32010 || e.message?.contains("-32010") == true
                val unsupportedModel = (e.code == -32603 || e.message?.contains("-32603") == true) &&
                    e.message?.contains("Unsupported model", ignoreCase = true) == true
                when {
                    unsupportedModel && item.modelId != null -> {
                        log.info("[scheduled] specified model unavailable, falling back to default id=${item.id} model=${item.modelId}")
                        client.send(item.sessionId, item.text, item.workspacePath)
                        true
                    }
                    cold -> {
                        client.resume(item.sessionId, Workspace(item.workspacePath))
                        client.send(item.sessionId, item.text, item.workspacePath, providerId = item.providerId, modelId = item.modelId)
                        true
                    }
                    running -> {
                        log.info("[scheduled] session busy (-32010), deferring id=${item.id}")
                        false
                    }
                    else -> {
                        log.warn("[scheduled] direct send failed (will retry next sweep) id=${item.id}: ${e.message}")
                        false
                    }
                }
            }
        } catch (e: Exception) {
            log.warn("[scheduled] direct send failed (client not ready? will retry) id=${item.id}: ${e.message}")
            false
        }
        if (sent) {
            removeById(item.id, "fired-direct")
            recordFired(item.sessionId, item.text, item.fireAt)
            ZCodeNotifyService.notifyScheduledFired(project, item.sessionId, item.text)
            openSessionTabOnEdt(item.sessionId)
        }
    }

    /**
     * 直发兜底的 /goal 变体：session/goal RPC（错误语义对齐 [directSend]——冷会话
     * -32004 resume 重试；-32010 悬挂回合延迟重扫；其余错误保持待发下轮再试，
     * 服务端拒绝（plan 模式等）最终随宽限过期转手动决定）。
     * 目标状态不经 goalManaged 回执（那走 webview op 通道）——由 session.updated
     * 事件载荷与开标签后 messages 首拉（session.target）在前端落地，出卡链路完整。
     */
    private fun directGoal(item: Item, cmd: GoalCommand) {
        val sent = try {
            val client = project.zCodeService().getClient()
            try {
                client.goal(item.sessionId, cmd.action, cmd.objective)
                true
            } catch (e: ZCodeProtocolException) {
                val cold = ZCodeProtocolException.isSessionUnavailableText(e.message)
                val running = e.code == -32010 || e.message?.contains("-32010") == true
                when {
                    cold -> {
                        client.resume(item.sessionId, Workspace(item.workspacePath))
                        client.goal(item.sessionId, cmd.action, cmd.objective)
                        true
                    }
                    running -> {
                        log.info("[scheduled] session busy (-32010), deferring goal id=${item.id}")
                        false
                    }
                    else -> {
                        log.warn("[scheduled] direct goal failed (will retry next sweep) id=${item.id}: ${e.message}")
                        false
                    }
                }
            }
        } catch (e: Exception) {
            log.warn("[scheduled] direct goal failed (client not ready? will retry) id=${item.id}: ${e.message}")
            false
        }
        if (sent) {
            removeById(item.id, "fired-direct")
            // set 落库 user 消息文本=objective（服务端剥 /goal 前缀），用它记录才能与
            // 历史消息对上「定时执行」徽标（webview 按 sessionId+text 匹配 fired）；
            // 其余动作不落库 user 消息，用原文本仅作已发历史展示
            recordFired(item.sessionId, if (cmd.action == "set") cmd.objective ?: item.text else item.text, item.fireAt)
            ZCodeNotifyService.notifyScheduledFired(project, item.sessionId, item.text)
            openSessionTabOnEdt(item.sessionId)
        }
    }

    /**
     * 直发成功后把对应会话标签打开到前台（实时交互可见）——标签已关/JCEF 未建时消息
     * 走了 Java 侧后台发送，回合在跑但用户无窗口可看；自动恢复标签让流式过程即时呈现。
     */
    private fun openSessionTabOnEdt(sessionId: String) {
        com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            try {
                ZCodeToolWindowFactory.openSessionTab(project, sessionId)
            } catch (e: Exception) {
                log.warn("[scheduled] open session tab failed: ${e.message}")
            }
        }
    }

    // ============ 存储与广播 ============

    private fun removeById(id: String, reason: String): Boolean {
        val removed = items.removeIf { it.id == id }
        if (removed) {
            awaitingAck.remove(id)
            autoGiveUp.remove(id)
            tabOpenedFor.remove(id)
            persistAndBroadcast()
            log.info("[scheduled] removed id=$id reason=$reason")
        }
        return removed
    }

    private fun persistAndBroadcast() {
        persist()
        broadcastList()
    }

    internal fun broadcastList() {
        val msg = buildListMessage()
        project.zCodeService().broadcastToWebviews(msg)
    }

    /**
     * 全量快照消息：ts=单调取号时间戳，webview 只应用比已应用更新（ts 更大）的快照——
     * 多线程广播（scheduledFired 上报与 scheduledDueAck 处理并发）到达顺序不保证，
     * 旧快照后到会把已移除的项「复活」回镜像（实测卡片残留根因之一）。
     */
    private fun buildListMessage(): JsonObject = buildJsonObject {
        put("op", "scheduledList")
        put("ts", System.currentTimeMillis())
        put("items", itemsToJson(items.sortedBy { it.fireAt }))
        put("fired", firedToJson(fired))
    }

    private fun persist() {
        try {
            PropertiesComponent.getInstance(project).setValue(STORAGE_KEY, Json.encodeToString(JsonArray.serializer(), itemsToJson(items)))
        } catch (e: Exception) {
            log.warn("[scheduled] persist failed: ${e.message}")
        }
    }

    private fun persistFired() {
        try {
            PropertiesComponent.getInstance(project).setValue(FIRED_STORAGE_KEY, Json.encodeToString(JsonArray.serializer(), firedToJson(fired)))
        } catch (e: Exception) {
            log.warn("[scheduled] persist fired failed: ${e.message}")
        }
    }

    private fun loadFromStorage() {
        try {
            val raw = PropertiesComponent.getInstance(project).getValue(STORAGE_KEY) ?: return
            items.addAll(parseItems(raw))
        } catch (e: Exception) {
            log.warn("[scheduled] load failed: ${e.message}")
        }
    }

    private fun loadFired() {
        try {
            val raw = PropertiesComponent.getInstance(project).getValue(FIRED_STORAGE_KEY) ?: return
            fired.addAll(parseFired(raw))
        } catch (e: Exception) {
            log.warn("[scheduled] load fired failed: ${e.message}")
        }
    }

    /** 测试/诊断用快照 */
    internal fun snapshot(): List<Item> = items.toList()

    override fun dispose() {
        // executor 的关闭在 init 里 Disposer.register（保证先于服务字段回收）
    }
}
