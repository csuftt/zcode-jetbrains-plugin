package com.zcode.ideaplugin.ui

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindowManager
import com.zcode.ideaplugin.ZCodeBundle
import com.zcode.ideaplugin.zCodeService
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull

/**
 * 对话结束系统通知（仅系统消息，无提示音、无焦点门控——开启即始终弹，默认关闭）：
 *
 * 触发：ZCodeServiceImpl 全局事件监听器收到 turn.completed / turn.failed（非手动 stop）。
 * 形式：两条独立通道，可各自开关——IDE 原生气泡（NotificationGroup "ZCode"，
 * 点击/按钮聚焦 ZCode 工具窗，切走窗口不可见）+ 自绘悬浮提醒弹窗
 * （ZCodePopupNotifier，仅 IDE 主窗口非激活时发，切走窗口可见，全平台）。
 * 气泡通道正文：turn.completed 走 payload.response 预览，turn.failed 走 error.message；
 * 弹窗通道正文（2026-10-09 拍板）：统一 = 「会话标题」一行，弹窗职责是路由不是阅读，
 * 标题缺失回退气泡同款正文（见 popupNotificationContent）。
 *
 * 配置存储：复用 webview kv 通道（PropertiesComponent KEY_WEBVIEW_KV）的
 * `zcode.notify.config` 键——前端设置页经 persist.ts 写入，本服务在触发时即时解析。
 */
object ZCodeNotifyService {

    /** kv 通道里的通知配置键（前端 utils/notifyConfig.ts 同源）*/
    const val KV_KEY = "zcode.notify.config"

    private val LOG = com.intellij.openapi.diagnostic.Logger.getInstance("ZCodePlugin")

    /**
     * 子代理会话判据（sess_subagent_* 前缀，与 remote 推送/会话列表过滤同款）：
     * 子代理是主回合内的执行单元，它的 turn.completed 不是「任务完成」——主回合
     * 还在跑，单独弹完成通知是误报（缺陷DZ）
     */
    internal fun isSubagentSession(sessionId: String?): Boolean =
        sessionId != null && sessionId.startsWith("sess_subagent")

    /** 等待用户输入的通知形态（issue #24：AI 停下等选择时系统级提醒）*/
    enum class PendingInputKind {
        /** AskUserQuestion 提问 */
        ASK_USER,
        /** ExitPlanMode 计划审批（规划完成等执行选择）*/
        PLAN_APPROVAL,
        /** 工具权限审批（requestPermission）*/
        PERMISSION,
    }

    /** 提醒配置（前端 JSON 持久化镜像；字段缺席时走这里的默认值——默认关闭）*/
    data class NotifyConfig(
        /** IDE 内气泡通知（切走窗口不可见）*/
        val notifyEnabled: Boolean = false,
        /** 自绘悬浮提醒弹窗（全局置顶，全平台；时长 popupDurationSec 秒，0=常驻）*/
        val popupNotifyEnabled: Boolean = false,
        /** 悬浮弹窗时长（秒；0=常驻直到点击/关闭；缺省 10）*/
        val popupDurationSec: Int = 10,
        /** 悬浮弹窗位置（缺省右上角，距顶 50px）*/
        val popupPosition: ZCodePopupNotifier.PopupPosition = ZCodePopupNotifier.PopupPosition.TOP_RIGHT,
    )

    /** 从 kv store 解析配置（缺失/损坏回默认值，绝不因配置问题抛异常）*/
    fun readConfig(): NotifyConfig = try {
        parseConfig(
            com.intellij.ide.util.PropertiesComponent.getInstance()
                .getValue(ZCodeLanguageService.KEY_WEBVIEW_KV)
        )
    } catch (_: Exception) {
        NotifyConfig()
    }

    /** 纯解析（单测覆盖）：kvstore JSON 原文 → NotifyConfig */
    internal fun parseConfig(kvStoreRaw: String?): NotifyConfig {
        val root = try {
            kotlinx.serialization.json.Json.parseToJsonElement(kvStoreRaw ?: return NotifyConfig())
                as? kotlinx.serialization.json.JsonObject ?: return NotifyConfig()
        } catch (_: Exception) {
            return NotifyConfig()
        }
        val conf = try {
            (root[KV_KEY] as? JsonPrimitive)?.content ?: return NotifyConfig()
        } catch (_: Exception) {
            return NotifyConfig()
        }
        val obj = try {
            kotlinx.serialization.json.Json.parseToJsonElement(conf) as? kotlinx.serialization.json.JsonObject
                ?: return NotifyConfig()
        } catch (_: Exception) {
            return NotifyConfig()
        }
        return NotifyConfig(
            notifyEnabled = obj.boolOr("notifyEnabled", false),
            popupNotifyEnabled = obj.boolOr("popupNotifyEnabled", false),
            popupDurationSec = obj.intOr("popupDurationSec", 10),
            popupPosition = obj.popupPositionOr("popupPosition", ZCodePopupNotifier.PopupPosition.TOP_RIGHT),
        )
    }

    /** 弹窗位置字段解析（只认枚举名字符串，其余回默认）*/
    private fun kotlinx.serialization.json.JsonObject.popupPositionOr(
        key: String,
        def: ZCodePopupNotifier.PopupPosition,
    ): ZCodePopupNotifier.PopupPosition {
        val p = this[key] as? JsonPrimitive ?: return def
        if (!p.isString) return def
        return runCatching { ZCodePopupNotifier.PopupPosition.valueOf(p.content) }.getOrDefault(def)
    }

    /** 整数字段解析（同 boolOr 纪律：只认 JSON 数字字面量，其余回默认）*/
    private fun kotlinx.serialization.json.JsonObject.intOr(key: String, def: Int): Int {
        val p = this[key] as? JsonPrimitive ?: return def
        if (p.isString) return def
        return p.intOrNull ?: def
    }

    /** 布尔字段解析（对齐前端 TS 语义：只认 JSON 布尔字面量；字符串 "false" 等回默认）*/
    private fun kotlinx.serialization.json.JsonObject.boolOr(key: String, def: Boolean): Boolean {
        val p = this[key] as? JsonPrimitive ?: return def
        if (p.isString) return def
        return p.booleanOrNull ?: def
    }

    /**
     * 回合结束提醒入口（协议事件线程调用）：
     * [failed]=turn.failed（正文取 error.message），否则 turn.completed（正文取 payload.response）。
     * [sessionId] 用于点击通知时精准定位会话所在的标签（找不到/已关闭则仅显示工具窗）。
     */
    fun notifyTurnEnd(project: Project, sessionId: String?, body: String?, failed: Boolean) {
        val config = readConfig()
        LOG.info("[DIAG-Notify] turnEnd entry: notifyEnabled=${config.notifyEnabled} popupEnabled=${config.popupNotifyEnabled} dur=${config.popupDurationSec} pos=${config.popupPosition} failed=$failed sid=$sessionId")
        if (!config.notifyEnabled && !config.popupNotifyEnabled) return
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val title = ZCodeBundle.message(
                    if (failed) "notify.turn.failed.title" else "notify.turn.completed.title"
                )
                val fallbackBody = ZCodeBundle.message(
                    if (failed) "notify.turn.failed.body" else "notify.turn.completed.body"
                )
                // 会话名前缀（缺陷DZ）：多会话先后完成时两条气泡可分辨；
                // 缓存未命中（会话从未出现在历史列表/标题事件）回退纯正文
                val sessionTitle = lookupSessionTitle(project, sessionId)
                val content = turnEndNotificationContent(sessionTitle, body, fallbackBody)
                val frame = com.intellij.openapi.wm.WindowManager.getInstance().getFrame(project)
                val inactive = ZCodePopupNotifier.isIdeFrameInactive(project)
                LOG.info("[DIAG-Notify] turnEnd gate: frameNull=${frame == null} frameActive=${frame?.isActive} iconified=${frame?.let { (it.extendedState and java.awt.Frame.ICONIFIED) != 0 }} inactive=$inactive -> popup=${config.popupNotifyEnabled && inactive}")
                if (config.popupNotifyEnabled && inactive) {
                    ZCodePopupNotifier.showPopup(project, title, popupNotificationContent(sessionTitle, content), config.popupDurationSec, config.popupPosition) {
                        openConversationTab(project, sessionId)
                    }
                }
                if (config.notifyEnabled) {
                    val notification = NotificationGroupManager.getInstance()
                        .getNotificationGroup("ZCode")
                        .createNotification(title, content, if (failed) NotificationType.WARNING else NotificationType.INFORMATION)
                    notification.addAction(object : com.intellij.openapi.actionSystem.AnAction(
                        ZCodeBundle.message("notify.turn.openToolWindow")
                    ) {
                        override fun actionPerformed(e: com.intellij.openapi.actionSystem.AnActionEvent) {
                            openConversationTab(project, sessionId)
                            notification.expire()
                        }
                    })
                    com.intellij.notification.Notifications.Bus.notify(notification, project)
                }
            } catch (e: Exception) {
                com.intellij.openapi.diagnostic.Logger.getInstance("ZCodePlugin")
                    .warn("Turn-end notification failed: ${e.message}")
            }
        }
    }

    /**
     * 轮末通知正文组装（纯函数，单测覆盖，缺陷DZ）：带会话标题前缀——后台多会话
     * 先后完成时两条气泡可分辨；标题未知/空白回退纯正文或兜底文案。
     * 标题截 30 字、正文截 120 字（总组成上限 152 字，有界）。
     */
    internal fun turnEndNotificationContent(sessionTitle: String?, body: String?, fallbackBody: String): String {
        val bodyPart = body?.trim()?.take(120)?.ifEmpty { null } ?: fallbackBody
        val prefix = sessionTitle?.trim()?.takeIf { it.isNotEmpty() }?.let { "「${it.take(30)}」" } ?: ""
        return prefix + bodyPart
    }

    /** 会话标题查询（缓存未命中/异常一律回 null——标题是锦上添花，绝不因它阻断通知）*/
    private fun lookupSessionTitle(project: Project, sessionId: String?): String? = runCatching {
        project.zCodeService().sessionTitleCache[sessionId]
    }.getOrNull()

    /**
     * 悬浮弹窗通道正文组装（纯函数，单测覆盖，2026-10-09 拍板）：弹窗职责是路由不是
     * 阅读——完成/失败/提问/审批正文统一 = 「会话标题」一行（截 30 字），详情点回会话
     * 再看；标题缺失/空白回退 [fallback]（各场景现状预览/兜底文案，行为不退化）。
     * IDE 气泡通道不走本函数，文案保持原样。
     */
    internal fun popupNotificationContent(sessionTitle: String?, fallback: String): String =
        sessionTitle?.trim()?.takeIf { it.isNotEmpty() }?.let { "「${it.take(30)}」" } ?: fallback

    /** 显示工具窗并激活会话所在标签（多标签下精准定位；标签已关时仅显示工具窗）*/
    private fun openConversationTab(project: Project, sessionId: String?) {
        val tw = ToolWindowManager.getInstance(project).getToolWindow("ZCode") ?: return
        tw.show()
        if (sessionId == null) return
        val panel = project.zCodeService().findPanelForSession(sessionId) ?: return
        panel.activateContent()
    }

    /**
     * 等待用户输入提醒入口（反向请求挂起点调用，issue #24）：
     * AskUserQuestion 提问 / ExitPlanMode 计划审批 / 权限审批弹出的同时系统级提醒——
     * 用户切走了不知道 AI 停下在等，是比"任务完成"更强的打扰理由。
     * [body] 传问题/计划/工具摘要，空则回 bundle 兜底文案；受通知总开关门控。
     */
    fun notifyPendingInput(project: Project, sessionId: String?, kind: PendingInputKind, body: String?) {
        val config = readConfig()
        LOG.info("[DIAG-Notify] pendingInput entry: kind=$kind notifyEnabled=${config.notifyEnabled} popupEnabled=${config.popupNotifyEnabled} dur=${config.popupDurationSec} pos=${config.popupPosition} sid=$sessionId")
        if (!config.notifyEnabled && !config.popupNotifyEnabled) return
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val (titleKey, bodyKey) = when (kind) {
                    PendingInputKind.ASK_USER -> "notify.pending.askUser.title" to "notify.pending.askUser.body"
                    PendingInputKind.PLAN_APPROVAL -> "notify.pending.planApproval.title" to "notify.pending.planApproval.body"
                    PendingInputKind.PERMISSION -> "notify.pending.permission.title" to "notify.pending.permission.body"
                }
                val title = ZCodeBundle.message(titleKey)
                val content = body?.trim()?.take(120)?.ifEmpty { null }
                    ?: ZCodeBundle.message(bodyKey)
                // 弹窗通道统一只带会话标题（2026-10-09 拍板，同时补上多会话挂起可分辨）；气泡通道保持摘要正文
                val sessionTitle = lookupSessionTitle(project, sessionId)
                val frame = com.intellij.openapi.wm.WindowManager.getInstance().getFrame(project)
                val inactive = ZCodePopupNotifier.isIdeFrameInactive(project)
                LOG.info("[DIAG-Notify] pendingInput gate: frameNull=${frame == null} frameActive=${frame?.isActive} iconified=${frame?.let { (it.extendedState and java.awt.Frame.ICONIFIED) != 0 }} inactive=$inactive -> popup=${config.popupNotifyEnabled && inactive}")
                if (config.popupNotifyEnabled && inactive) {
                    ZCodePopupNotifier.showPopup(project, title, popupNotificationContent(sessionTitle, content), config.popupDurationSec, config.popupPosition) {
                        openConversationTab(project, sessionId)
                    }
                }
                if (config.notifyEnabled) {
                    val notification = NotificationGroupManager.getInstance()
                        .getNotificationGroup("ZCode")
                        .createNotification(title, content, NotificationType.INFORMATION)
                    notification.addAction(object : com.intellij.openapi.actionSystem.AnAction(
                        ZCodeBundle.message("notify.turn.openToolWindow")
                    ) {
                        override fun actionPerformed(e: com.intellij.openapi.actionSystem.AnActionEvent) {
                            openConversationTab(project, sessionId)
                            notification.expire()
                        }
                    })
                    com.intellij.notification.Notifications.Bus.notify(notification, project)
                }
            } catch (e: Exception) {
                com.intellij.openapi.diagnostic.Logger.getInstance("ZCodePlugin")
                    .warn("Pending-input notification failed: ${e.message}")
            }
        }
    }

    /**
     * 定时消息直发通知（标签已关/懒加载未激活时后台发出，用户需要知道提示词已执行）。
     * webview 准入路径发出的（标签开着能看到）不通知，避免重复打扰。
     */
    fun notifyScheduledFired(project: Project, sessionId: String, preview: String) {
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val title = ZCodeBundle.message("notify.scheduled.fired.title")
                val content = preview.trim().take(120).ifEmpty {
                    ZCodeBundle.message("notify.scheduled.fired.body")
                }
                val notification = NotificationGroupManager.getInstance()
                    .getNotificationGroup("ZCode")
                    .createNotification(title, content, NotificationType.INFORMATION)
                notification.addAction(object : com.intellij.openapi.actionSystem.AnAction(
                    ZCodeBundle.message("notify.turn.openToolWindow")
                ) {
                    override fun actionPerformed(e: com.intellij.openapi.actionSystem.AnActionEvent) {
                        openConversationTab(project, sessionId)
                        notification.expire()
                    }
                })
                com.intellij.notification.Notifications.Bus.notify(notification, project)
            } catch (e: Exception) {
                com.intellij.openapi.diagnostic.Logger.getInstance("ZCodePlugin")
                    .warn("Scheduled-fire notification failed: ${e.message}")
            }
        }
    }
}
