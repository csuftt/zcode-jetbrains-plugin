package com.zcode.ideaplugin

import com.intellij.openapi.project.Project
import com.zcode.ideaplugin.protocol.ZCodeProtocolClient
import com.zcode.ideaplugin.ui.ZCodeToolWindowPanel
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * ZCode 项目级服务
 *
 * 管理该项目对应的 ZCodeProtocolClient 实例与多个 ToolWindow 面板（多标签页）。
 * 通过 Service Manager 获取：`project.service<ZCodeService>()`
 *
 * 多标签页架构（对齐 cc-gui）：
 *   - 每个标签 = 一个 Content = 一个 ZCodeToolWindowPanel（独立 JCEF + React 实例）
 *   - 协议客户端全局一个（app-server 单进程），按 sessionId 路由，多会话并发
 *   - askUser/ExitPlanMode 反向请求在 Service 层统一协调（协议客户端 handler 是单例，
 *     不能让多个 panel 互相覆盖），弹窗按 sessionId 路由到对应 panel，无 sessionId 时
 *     fallback 推给当前激活的 panel（应答按 requestId 全局匹配，不会丢）
 */
interface ZCodeService {
    /** 获取协议客户端（懒启动） */
    fun getClient(): ZCodeProtocolClient

    /** 客户端是否已启动 */
    fun isStarted(): Boolean

    /** 关闭客户端 */
    fun shutdown()

    /** 注册面板实例（ToolWindowFactory 创建标签时调用） */
    fun registerPanel(panel: ZCodeToolWindowPanel)

    /** 注销面板实例（标签关闭时调用） */
    fun unregisterPanel(panel: ZCodeToolWindowPanel)

    /** 设置当前激活的面板（标签切换时调用，外部推送与弹窗 fallback 的目标） */
    fun setActivePanel(panel: ZCodeToolWindowPanel)

    /** 查找订阅了指定会话的面板（askUser 弹窗精确路由用） */
    fun findPanelForSession(sessionId: String): ZCodeToolWindowPanel?

    /**
     * 从 IDE 外部（右键菜单等）推送消息到当前激活标签的 webview。
     * 无面板时丢弃（调用方应先 show ToolWindow）。
     */
    fun pushToWebview(msg: JsonObject)

    /** 广播消息到全部标签的 webview（多标签全局状态同步，如定时消息列表） */
    fun broadcastToWebviews(msg: JsonObject)

    /** 当前激活会话面板（browser-use 内嵌浏览器宿主定位用）*/
    fun getActivePanel(): ZCodeToolWindowPanel?

    /**
     * 全局共享内嵌浏览器面板（跨会话标签，对应协议单一 idea-iab 实例；未创建为 null）。
     * 实例常驻（收起也保留页面），项目关闭时统一释放。
     */
    fun getSharedBrowserPanel(): com.zcode.ideaplugin.ui.ZCodeBrowserPanel?

    /** 创建共享浏览器面板（幂等）*/
    fun getOrCreateSharedBrowserPanel(): com.zcode.ideaplugin.ui.ZCodeBrowserPanel?

    /** 浏览器当前挂载（分栏展开）的会话面板；收起或未挂载为 null */
    fun getEmbeddedBrowserOwner(): ZCodeToolWindowPanel?

    fun setEmbeddedBrowserOwner(panel: ZCodeToolWindowPanel?)

    /**
     * 注册 interaction/requestUserInput 协调器（幂等，多面板共享一个协议 handler）。
     * 第一个 panel 初始化时调用。
     */
    fun ensureUserInputHandler()

    /**
     * 注册 browser-use 宿主反向请求 handler（幂等）：interaction/browserList +
     * interaction/browserExecute → ZCodeBrowserExecutor（AI 的浏览器工具落到 JCEF 面板）。
     * 第一个 panel 初始化时调用。
     */
    fun ensureBrowserExecutor()

    /** browser-use 执行器（UI 层复用其 CDP 通道，如自由尺寸 viewport；未初始化为 null）*/
    fun getBrowserExecutor(): com.zcode.ideaplugin.ui.ZCodeBrowserExecutor?

    /**
     * 前端 askUserResponse 应答：complete 对应 future 并清理重试 id，
     * 返回 {op:"askUserAck"} 响应。
     *
     * 同一通道也承载 interaction/requestPermission（工具权限审批）弹窗的应答：
     * action="accept" + answer=<optionId>（如 allow_once / allow_project / deny），
     * action="decline" 一律拒绝；宿主按 optionId 回填服务端给定的选项 response。
     *
     * @param answer 单问题答案（原始值：字符串或数组；ExitPlanMode 为 "approve"/意见文本；
     *   权限审批为 optionId）
     * @param answers 多问题答案（问题文本 → 值），与 answer 二选一
     */
    fun completeUserInput(
        requestId: String,
        action: String,
        answer: JsonElement?,
        answers: JsonObject?,
    ): JsonObject

    /**
     * 回合被外力打断（-32010 自愈的 session/stop、回合终止事件）时废弃待应答弹窗：
     * 移除 pendingUserInputs 并 complete 废弃哨兵（协议层改发 JSON-RPC error，
     * 请求失败语义——杜绝向已死请求发迟到 decline 污染服务端权限状态机，
     * 2026-08-20 实测缺陷P2/P3），并推 askUserAck 让前端立即关窗。
     *
     * @param sessionId 只废弃该会话的挂起请求（双会话并发互不误伤）；null = 全部
     * @param turnId 只废弃该回合的挂起请求（同会话旧回合终止事件晚到时不误杀
     * 新回合刚弹出的弹窗）；null = 该会话全部（手动 stop 语义）
     */
    fun abortPendingUserInputs(sessionId: String? = null, turnId: String? = null)

    /**
     * 向指定面板同步反向请求挂起状态（webview init 时拉取）：存在挂起请求则推
     * {op:"askUserPending", active:true}——新开标签/页面重载错过广播的看门狗豁免兜底。
     */
    fun pushAskUserPendingState(panel: ZCodeToolWindowPanel)

    /**
     * 标记某会话被用户手动 stop（对话结束提醒据此跳过：手动打断不提醒，
     * 对齐 cc-gui isManuallyInterrupted 语义）。handleStop 成功后调用。
     */
    fun markManualStop(sessionId: String)
}
