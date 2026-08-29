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

/**
 * 对话结束系统通知（仅系统消息，无提示音、无焦点门控——开启即始终弹，默认关闭）：
 *
 * 触发：ZCodeServiceImpl 全局事件监听器收到 turn.completed / turn.failed（非手动 stop）。
 * 形式：IDE 原生气泡（NotificationGroup "ZCode"，点击/按钮聚焦 ZCode 工具窗），
 * turn.completed 走 payload.response 预览正文，turn.failed 走 error.message。
 *
 * 配置存储：复用 webview kv 通道（PropertiesComponent KEY_WEBVIEW_KV）的
 * `zcode.notify.config` 键——前端设置页经 persist.ts 写入，本服务在触发时即时解析。
 */
object ZCodeNotifyService {

    /** kv 通道里的通知配置键（前端 utils/notifyConfig.ts 同源）*/
    const val KV_KEY = "zcode.notify.config"

    /** 提醒配置（前端 JSON 持久化镜像；字段缺席时走这里的默认值——默认关闭）*/
    data class NotifyConfig(
        val notifyEnabled: Boolean = false,
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
        )
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
        if (!readConfig().notifyEnabled) return
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val title = ZCodeBundle.message(
                    if (failed) "notify.turn.failed.title" else "notify.turn.completed.title"
                )
                val content = body?.trim()?.take(120)?.ifEmpty { null }
                    ?: ZCodeBundle.message(
                        if (failed) "notify.turn.failed.body" else "notify.turn.completed.body"
                    )
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
            } catch (e: Exception) {
                com.intellij.openapi.diagnostic.Logger.getInstance("ZCodePlugin")
                    .warn("Turn-end notification failed: ${e.message}")
            }
        }
    }

    /** 显示工具窗并激活会话所在标签（多标签下精准定位；标签已关时仅显示工具窗）*/
    private fun openConversationTab(project: Project, sessionId: String?) {
        val tw = ToolWindowManager.getInstance(project).getToolWindow("ZCode") ?: return
        tw.show()
        if (sessionId == null) return
        val panel = project.zCodeService().findPanelForSession(sessionId) ?: return
        panel.activateContent()
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
