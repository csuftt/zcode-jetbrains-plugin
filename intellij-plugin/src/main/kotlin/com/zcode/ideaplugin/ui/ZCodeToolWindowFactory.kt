package com.zcode.ideaplugin.ui

import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.content.Content
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.content.ContentManager
import com.intellij.ui.content.ContentManagerEvent
import com.intellij.ui.content.ContentManagerListener
import com.zcode.ideaplugin.ZCodeBundle.message
import com.zcode.ideaplugin.zCodeService

/**
 * ZCode ToolWindow 工厂（多标签页，对齐 cc-gui ContentManager 方案）
 *
 * 每个标签 = 一个 Content = 一个 ZCodeToolWindowPanel（独立 JCEF + React 实例），
 * 会话状态天然隔离、互不影响。标签状态（名字 + 绑定 sessionId）持久化到
 * ZCodeTabState，重启后按 sessionId 懒加载恢复。
 *
 * - 新建标签：前端「新标签页」按钮 → op:createTab → createNewTab（EDT）
 * - 关闭标签：原生 Content 关闭按钮；仅剩 1 个时禁关
 * - 切换标签：selectionChanged → 更新 Service 的激活面板 + 持久化 activeIndex
 */
class ZCodeToolWindowFactory : ToolWindowFactory, DumbAware {

    companion object {
        const val TOOL_WINDOW_ID = "ZCode"

        /** 标签名静态前缀（tab.name.format 中 {0} 之前的部分，用于编号正则匹配；随语言变化）*/
        private fun tabNamePrefix(): String =
            message("tab.name.format").substringBefore("{0}")

        /** 匹配「会话1」「Session 1」「会话1 ●」等，取数字部分 */
        private fun tabNamePattern(): Regex =
            Regex("^${Regex.escape(tabNamePrefix())}\\s*(\\d+)")

        fun getToolWindow(project: Project): ToolWindow? =
            ToolWindowManager.getInstance(project).getToolWindow(TOOL_WINDOW_ID)

        /** 新建一个标签页（须在 EDT 调用；新标签 = 新会话，不继承旧会话）*/
        fun createNewTab(project: Project, toolWindow: ToolWindow): Content? {
            val cm = toolWindow.contentManager
            val tabName = getNextTabName(cm)
            val content = addTabContent(project, toolWindow, null, tabName)
            toolWindow.show(null)
            return content
        }

        /** 生成下一个标签名：取现有「会话N」最大编号 + 1 */
        private fun getNextTabName(cm: ContentManager): String {
            var max = 0
            val pattern = tabNamePattern()
            for (c in cm.contents) {
                val m = pattern.find(c.displayName ?: "") ?: continue
                max = maxOf(max, m.groupValues[1].toIntOrNull() ?: 0)
            }
            return message("tab.name.format", max + 1)
        }

        /**
         * 创建标签内容并注册（须在 EDT 调用）
         *
         * @param initialSessionId 重启恢复时绑定的会话 id；null 表示新标签（前端自动建会话）
         * @param lazy 懒加载：不立即创建 JCEF（占位 UI），首次切到本标签时激活。
         *        重启恢复的非激活标签用，避免启动风暴并发拉起多个渲染进程；懒加载不自动选中
         */
        private fun addTabContent(
            project: Project,
            toolWindow: ToolWindow,
            initialSessionId: String?,
            tabName: String,
            lazy: Boolean = false,
        ): Content {
            val panel = ZCodeToolWindowPanel(project, initialSessionId, lazyStart = lazy)
            val content = ContentFactory.getInstance().createContent(panel, tabName, false)
            content.isCloseable = true
            // 标签关闭/销毁时释放 panel（JCEF 资源）
            content.setDisposer(panel)
            panel.attachContent(content)
            toolWindow.contentManager.addContent(content)
            project.zCodeService().registerPanel(panel)
            if (!lazy) toolWindow.contentManager.setSelectedContent(content)
            return content
        }

        /** 把当前标签布局全量写入 TabState（名字 + sessionId + activeIndex）*/
        fun persistTabs(project: Project, cm: ContentManager) {
            val state = ZCodeTabState.getInstance(project).state
            state.tabs = cm.contents.mapNotNull { c ->
                val panel = c.component as? ZCodeToolWindowPanel ?: return@mapNotNull null
                ZCodeTabState.TabInfo(
                    name = panel.getBaseTabTitle().ifBlank { c.displayName ?: "" },
                    sessionId = panel.getCurrentSessionIdForPersist(),
                )
            }.toMutableList()
            val selected = cm.selectedContent
            state.activeIndex = if (selected != null) {
                // 浏览器标签不计入 tabs，activeIndex 须换算成「聊天标签列表」内的索引：
                // 取选中标签（含自身）之前有多少个聊天标签（选中的是浏览器标签 → 指向其前一个聊天标签）
                val idx = cm.getIndexOfContent(selected)
                if (idx < 0) 0
                else (cm.contents.take(idx + 1).count { it.component is ZCodeToolWindowPanel } - 1)
                    .coerceAtLeast(0)
            } else 0
        }

        /**
         * 新建「浏览器」标签页（前端 Header「浏览器」按钮 → op:openBrowserTab）。
         * 独立 Content：不绑定会话、不持久化（persistTabs 只收集聊天面板）、始终可关闭。
         * 已有浏览器标签时复用并激活（避免堆积；当前单页形态，需要多站点时开多个标签即可）。
         */
        fun createBrowserTab(project: Project, toolWindow: ToolWindow): Content? {
            val cm = toolWindow.contentManager
            cm.contents.firstOrNull { it.component is ZCodeBrowserPanel }?.let {
                cm.setSelectedContent(it)
                toolWindow.show(null)
                return it
            }
            val panel = ZCodeBrowserPanel(project)
            val content = ContentFactory.getInstance().createContent(panel, message("browser.tab.name"), false)
            content.isCloseable = true
            content.description = message("browser.tab.description")
            content.setDisposer(panel)
            cm.addContent(content)
            toolWindow.show(null)
            cm.setSelectedContent(content)
            return content
        }
    }

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        // 侧边栏标签显示名（id 保持 "ZCode" 供 getToolWindow 查找，显示名改为 ZC GUI）
        toolWindow.stripeTitle = "ZC GUI"
        toolWindow.show(null) // TODO 临时：截图实验用，实验后移除
        ensureCdpPortForBrowserUse()
        val cm = toolWindow.contentManager

        // 恢复持久化的标签（或首个默认标签）
        val saved = ZCodeTabState.getInstance(project).state.tabs
        if (saved.isEmpty()) {
            addTabContent(project, toolWindow, null, message("tab.name.format", 1))
        } else {
            // 激活索引先算好：只有激活标签立即创建 JCEF，其余懒加载（切到时才建）。
            // 2026-08-15 白屏故障：重启恢复 3 个标签 → 启动瞬间并发拉起 3 个渲染进程全部失败 → UI 空白
            val activeIdx = ZCodeTabState.getInstance(project).state.activeIndex
                .coerceIn(0, saved.size - 1)
            for ((i, info) in saved.withIndex()) {
                val sid = info.sessionId?.takeIf { it.isNotBlank() }
                addTabContent(
                    project, toolWindow, sid, info.name.ifBlank { message("tab.name.untitled") },
                    lazy = i != activeIdx,
                )
            }
            // 恢复激活索引
            if (cm.contentCount > 0) cm.setSelectedContent(cm.contents[activeIdx])
        }

        cm.addContentManagerListener(object : ContentManagerListener {
            override fun contentAdded(event: ContentManagerEvent) {
                updateCloseable(cm)
                persistTabs(project, cm)
            }

            override fun selectionChanged(event: ContentManagerEvent) {
                if (cm.selectedContent !== event.content) return
                val panel = event.content.component as? ZCodeToolWindowPanel ?: return
                panel.ensureJcefCreated() // 懒加载标签激活（已激活时为 no-op）
                project.zCodeService().setActivePanel(panel)
                // 内嵌浏览器全局共享：展开状态下随标签切换迁移挂载（宽度延续）——
                // 修复「切到新标签后聊天独占被浏览器拉宽的 TW、主界面特别大」
                panel.adoptEmbeddedBrowserIfDisplayed()
                persistTabs(project, cm)
            }

            /** 关闭二次确认：移除前弹确认框，取消则拦截关闭（event.consume）；浏览器标签直接关 */
            override fun contentRemoveQuery(event: ContentManagerEvent) {
                val content = event.content
                if (content.component is ZCodeBrowserPanel) return
                val panel = content.component as? ZCodeToolWindowPanel
                val tabName = content.displayName ?: message("tab.fallbackName")
                val streaming = panel?.isTabStreaming() == true
                val dialogMessage = if (streaming) {
                    message("dialog.closeTab.streaming", tabName)
                } else {
                    message("dialog.closeTab.normal", tabName)
                }
                val result = com.intellij.openapi.ui.Messages.showYesNoDialog(
                    project,
                    dialogMessage,
                    message("dialog.closeTab.title"),
                    com.intellij.openapi.ui.Messages.getQuestionIcon(),
                )
                if (result != com.intellij.openapi.ui.Messages.YES) {
                    event.consume()
                }
            }

            override fun contentRemoved(event: ContentManagerEvent) {
                updateCloseable(cm)
                val panel = event.content.component as? ZCodeToolWindowPanel
                if (panel != null) project.zCodeService().unregisterPanel(panel)
                // 聊天标签全部关闭后（含「只剩浏览器标签又关掉浏览器」）自动补一个，保证会话入口常在
                if (cm.contents.none { it.component is ZCodeToolWindowPanel }) {
                    addTabContent(project, toolWindow, null, getNextTabName(cm))
                    return
                }
                persistTabs(project, cm)
                // panel 的 JCEF 资源由 content.setDisposer(panel) 释放
            }
        })

        updateCloseable(cm)

        // 初始激活面板（外部推送目标）
        (cm.selectedContent?.component as? ZCodeToolWindowPanel)?.let {
            it.ensureJcefCreated() // 兜底：选中项若为懒加载则激活（正常路径激活标签已立即创建）
            project.zCodeService().setActivePanel(it)
        }
    }

    /**
     * 仅剩 1 个聊天标签时禁用其关闭按钮（浏览器标签始终可关：无会话状态可丢，
     * 且不占用「最后一个标签」名额——聊天标签被清空时由 contentRemoved 自动补）
     */
    private fun updateCloseable(cm: ContentManager) {
        val chatCount = cm.contents.count { it.component is ZCodeToolWindowPanel }
        cm.contents.forEach {
            it.isCloseable = it.component is ZCodeBrowserPanel || chatCount > 1
        }
    }

    /**
     * 开启 JCEF remote debugging（browser-use 宿主执行器的 CDP 通道依赖）。
     *
     * 实测 2026.1 正式 IDE：registry `ide.browser.jcef.debug.port` 默认 -1（不加任何
     * 调试参数，remote debugging 完全关闭；官方文档「默认 9222 active」与实际不符，
     * 见 SettingsHelper.getRemoteDebugPort 反汇编）。
     *
     * 端口策略：固定 9222 会撞两种坑——①被其他进程占用时 CEF 静默 bind 失败（DevTools
     * 服务不启动，无任何报错，实测 Windows TCP 僵尸 LISTENING 条目即可触发）；②与并存的
     * JetBrains IDE 冲突。故设 0（随机端口）：CEF 自动选空闲端口并写入 jcef_cache 的
     * DevToolsActivePort 文件（首行端口号），executor 侧读文件发现（见
     * ZCodeBrowserExecutor.findCdpPortFromCache）。
     * 必须在 JBCefApp 首次初始化前设置才当次生效——本方法在 createToolWindowContent
     * 开头调用，先于任何 panel 的 JBCefBrowser 创建；若 CEF 已起（如插件热更新场景）
     * 则写入 registry 等下次重启生效。
     */
    private fun ensureCdpPortForBrowserUse() {
        try {
            @Suppress("DEPRECATION")
            val current = com.intellij.openapi.util.registry.Registry.intValue("ide.browser.jcef.debug.port", -1)
            if (current == 0) return
            @Suppress("DEPRECATION")
            com.intellij.openapi.util.registry.Registry.get("ide.browser.jcef.debug.port").setValue(0)
            com.intellij.openapi.diagnostic.Logger.getInstance("ZCodePlugin")
                .warn("[browser-use] 已设置 ide.browser.jcef.debug.port=0（随机端口，经 DevToolsActivePort 发现；若 CEF 已启动则重启 IDE 后生效）")
        } catch (e: Exception) {
            com.intellij.openapi.diagnostic.Logger.getInstance("ZCodePlugin")
                .warn("[browser-use] 设置 CDP 调试端口失败: ${e.message}")
        }
    }
}
