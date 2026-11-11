package com.zcode.ideaplugin.ui

import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.content.Content
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.content.ContentManager
import com.intellij.ui.content.ContentManagerEvent
import com.intellij.ui.content.ContentManagerListener
import com.zcode.ideaplugin.ZCodeBundle.message
import com.zcode.ideaplugin.action.CloseEmptyTabsAction
import com.zcode.ideaplugin.action.DetachTabAction
import com.zcode.ideaplugin.action.RenameTabAction
import com.zcode.ideaplugin.action.pushRefs
import com.zcode.ideaplugin.zCodeService
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.SwingConstants
import javax.swing.SwingUtilities

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

        /**
         * 标题栏独立按钮清单（唯一出处）：只剩「批量关闭空标签」——它有自己的显影逻辑
         * （有空白标签才显示），2026-11-12 用户定稿保持独立不并入菜单。
         *
         * 重命名 + 弹出独立窗口已收进平台标题栏 ⋮ 菜单（[buildGearActions]，曾为独立
         * 按钮三连排布，用户嫌挤折叠）。各挂载点一律走这两个唯一清单——曾因清单四处
         * 手写互不一致，refreshTitleToolbar 漏挂弹出按钮把它顶掉（2026-11-11 真机）。
         */
        fun buildTitleActions(project: Project) = listOf(CloseEmptyTabsAction(project))

        /** 平台标题栏 ⋮（Options）菜单的追加动作组：重命名 + 弹出独立窗口（无参构造，现取选中标签） */
        fun buildGearActions(project: Project) =
            DefaultActionGroup(RenameTabAction(), DetachTabAction(project))

        /**
         * 强制刷新工具窗标题栏（「关闭全部空标签」按钮的显隐依赖它）。
         * action update 只由 IDE 事件驱动：重启恢复后无事件时按钮冻结在初始 presentation，
         * 出现「存在空标签但按钮不显示，点一下标签才恢复」的体感（2026-11-02 真机）。
         *
         * 刷新通道三连实证（真机三连教训）：updateActionsImmediately 靠 Swing 树找 toolbar
         * 全部落空——新 UI 的标题栏 header 画在 ToolWindowPane 层，不在 toolWindow.component
         * 子树内，找到的只是无关 toolbar。真机唯一实证有效的通道是 selectionChanged 里的
         * **setTitleActions(全新实例)**：header 拿新实例重建按钮并重跑 update（铅笔按钮随
         * 标签切换换实例就是这条链）。故此处复刻该通道：按当前选中标签重设 title actions。
         * 空标签集合的变化点（标签出生/会话落位/清空待命/懒加载 boot 完成）都调它。
         * EDT 安全：invokeLater；项目关闭即停。
         */
        fun refreshTitleToolbar(project: Project) {
            val toolWindow = getToolWindow(project) ?: return
            SwingUtilities.invokeLater {
                if (project.isDisposed || toolWindow.isDisposed) return@invokeLater
                val cm = toolWindow.contentManager
                val content = cm.selectedContent ?: return@invokeLater
                val panel = content.component as? ZCodeToolWindowPanel ?: return@invokeLater
                // 全新实例重设：旧实例 presentation 已被上轮 update 污染（visible=false 冻结），
                // 新实例默认 visible，header 重建按钮后立即重跑 update 按实时状态收敛
                toolWindow.setTitleActions(buildTitleActions(project))
                // ⋮ 菜单的动作组是工具窗级（无标签实例绑定，菜单弹出时现取选中标签），
                // 重复 set 幂等；放同一汇点保证初始化/恢复/搬回各路径都有
                toolWindow.setAdditionalGearActions(buildGearActions(project))
            }
        }

        /** 新建一个标签页（须在 EDT 调用；新标签 = 新会话，不继承旧会话）。
         *  initialWorkspace：标签初始落位目录（多目录会话，缺省本项目）*/
        fun createNewTab(project: Project, toolWindow: ToolWindow, initialWorkspace: String? = null): Content? {
            val cm = toolWindow.contentManager
            val tabName = getNextTabName(cm)
            val content = addTabContent(project, toolWindow, null, tabName, initialWorkspace = initialWorkspace)
            toolWindow.show(null)
            return content
        }

        /**
         * 激活已绑定指定会话的标签（须在 EDT 调用）；没有绑定标签时返回 false（由调用方决定兜底行为）。
         * 定时消息后台补发（补发后须有标签可见）与任务列表跳转（优先去已开的标签）共用。
         */
        fun activateSessionTab(project: Project, sessionId: String): Boolean {
            if (sessionId.isBlank()) return false
            // 该会话已在弹出独立窗口：聚焦窗口本身，不在主窗开第二个面板（搬运式语义，
            // 同会话双面板=双订阅是要避免的形态）
            if (SessionDetachWindow.focusDetachedSession(project, sessionId)) return true
            val toolWindow = getToolWindow(project) ?: return false
            val cm = toolWindow.contentManager
            val existing = cm.contents.firstOrNull {
                (it.component as? ZCodeToolWindowPanel)?.getCurrentSessionIdForPersist() == sessionId
            } ?: return false
            toolWindow.show(null)
            if (cm.selectedContent !== existing) cm.setSelectedContent(existing)
            // 已是选中标签时 setSelectedContent 不触发 selectionChanged，懒加载场景需手动激活；
            // 外部跳转（定时补发/任务列表）带到已选中标签 = 可见即清「回合结束待查看」标记
            else (existing.component as? ZCodeToolWindowPanel)?.let {
                it.ensureJcefCreated()
                it.clearTabTurnFinished()
            }
            return true
        }

        /**
         * 打开绑定指定会话的标签并激活（须在 EDT 调用）——定时消息后台补发后恢复实时交互：
         * 已有绑定该会话的标签则选中（含懒加载标签激活）；没有则新建标签按该会话恢复
         * （前端 boot 按 initialSessionId selectSession + subscribe，与重启恢复同路径）。
         * workspacePath（多目录会话）：会话所属目录，随标签注入——新标签 boot 首拉列表
         * 按它过滤，跨目录会话才能被恢复；null = 本项目（旧调用方缺省）。
         */
        fun openSessionTab(project: Project, sessionId: String, workspacePath: String? = null) {
            if (sessionId.isBlank()) return
            val toolWindow = getToolWindow(project) ?: return
            if (activateSessionTab(project, sessionId)) return
            addTabContent(project, toolWindow, sessionId, getNextTabName(toolWindow.contentManager), initialWorkspace = workspacePath)
            toolWindow.show(null)
        }

        /**
         * 右键「发送到工作区标签」投递入口（须在 EDT 调用）：**恒新开标签**（待命态落位
         * 该目录；用户裁定撤出复用路径——子项文案「新开标签（目录名）」即行为承诺）。
         * 引用走 panel 待投递通道（[ZCodeToolWindowPanel.offerPendingInputRefs]）：
         * 已就绪直推，未就绪（新标签页面加载窗口）等首条消息后补投。
         * ToolWindow 不存在 → 退化既有 [pushRefs]（推激活面板）。
         */
        fun sendToWorkspaceTab(project: Project, workspacePath: String, refs: List<String>) {
            val toolWindow = getToolWindow(project)
            if (toolWindow == null) {
                pushRefs(project, refs)
                return
            }
            val content = createNewTab(project, toolWindow, workspacePath)
            (content?.component as? ZCodeToolWindowPanel)?.offerPendingInputRefs(refs)
        }

        /**
         * 当前各聊天标签已绑定的会话（只读快照，供历史列表标注「已在会话N打开」）：
         * 返回 sessionId → 标签名。浏览器标签与待命态（无绑定）不计入。
         */
        fun listOpenSessions(project: Project): List<Pair<String, String>> {
            val toolWindow = getToolWindow(project) ?: return emptyList()
            return toolWindow.contentManager.contents.mapNotNull { c ->
                val p = c.component as? ZCodeToolWindowPanel ?: return@mapNotNull null
                val sid = p.getCurrentSessionIdForPersist() ?: return@mapNotNull null
                sid to p.getBaseTabTitle().ifBlank { c.displayName ?: "" }
            }
        }

        /** 生成下一个标签名：从 1 起取最小未被占用的编号（最后一个标签禁关、编号只增不减，故不复用 max+1）*/
        private fun getNextTabName(cm: ContentManager): String {
            val pattern = tabNamePattern()
            val used = cm.contents.mapNotNullTo(mutableSetOf()) { c ->
                pattern.find(c.displayName ?: "")?.groupValues?.get(1)?.toIntOrNull()
            }
            var next = 1
            while (next in used) next++
            return message("tab.name.format", next)
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
            /** 标签初始目录（多目录会话）：与 initialSessionId 配对，随 bridge 注入（见 panel 注释）*/
            initialWorkspace: String? = null,
        ): Content {
            val panel: JComponent = try {
                ZCodeToolWindowPanel(project, initialSessionId, lazyStart = lazy, initialWorkspace = initialWorkspace)
            } catch (t: Throwable) {
                // 工具窗创建的最后一道兜底：面板构造异常炸穿=Cannot init toolwindow，
                // 整个工具窗死透+标签恢复断链（2026-10-19 JCEF 基础设施死亡、2026-09-17 缺陷BT
                // 两次实锤）。降级为错误占位标签：工具窗保活、其余标签恢复不受影响
                com.intellij.openapi.diagnostic.Logger.getInstance("ZCodePlugin")
                    .error("ZCode panel creation failed, degrading tab to error placeholder", t)
                buildPanelErrorPlaceholder(t)
            }
            val content = ContentFactory.getInstance().createContent(panel, tabName, false)
            content.isCloseable = true
            if (panel is ZCodeToolWindowPanel) {
                // 标签右键菜单：重命名标签（issue #18/#21；改名与持久化封装在 panel.renameTab）
                // + 批量关闭无会话空标签（判据 panel.isStandbyUnbound；新 UI 下此菜单不渲染，
                // 可靠入口是上面 setTitleActions 的标题栏按钮——同 RenameTabAction 双入口原因）
                // + 弹出独立窗口（搬运式标签弹窗 ⑧：双屏监督，关窗自动搬回）
                content.setActions(
                    DefaultActionGroup(RenameTabAction(panel), CloseEmptyTabsAction(project), DetachTabAction(project, content)),
                    ActionPlaces.TOOLWINDOW_CONTENT,
                    panel,
                )
                // 标签关闭/销毁时释放 panel（JCEF 资源）
                content.setDisposer(panel)
                panel.attachContent(content)
                project.zCodeService().registerPanel(panel)
            }
            toolWindow.contentManager.addContent(content)
            if (!lazy) toolWindow.contentManager.setSelectedContent(content)
            return content
        }

        /** 面板构造失败的最小占位（工厂层兜底；panel 未能建成无法原地重试，建议重启 IDE）*/
        private fun buildPanelErrorPlaceholder(t: Throwable): JComponent {
            val summary = (t.message ?: t.javaClass.simpleName).take(200)
                .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            val label = JLabel(message("panel.initFailed.html", summary))
            label.verticalAlignment = SwingConstants.CENTER
            label.horizontalAlignment = SwingConstants.CENTER
            return label
        }

        /** 把当前标签布局全量写入 TabState（名字 + sessionId + workspacePath + activeIndex）*/
        fun persistTabs(project: Project, cm: ContentManager) {
            val state = ZCodeTabState.getInstance(project).state
            state.tabs = cm.contents.mapNotNull { c ->
                val panel = c.component as? ZCodeToolWindowPanel ?: return@mapNotNull null
                ZCodeTabState.TabInfo(
                    name = panel.getBaseTabTitle().ifBlank { c.displayName ?: "" },
                    sessionId = panel.getCurrentSessionIdForPersist(),
                    workspacePath = panel.getCurrentWorkspacePathForPersist(),
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
                    initialWorkspace = info.workspacePath,
                )
            }
            // 恢复激活索引
            if (cm.contentCount > 0) cm.setSelectedContent(cm.contents[activeIdx])
        }

        cm.addContentManagerListener(object : ContentManagerListener {
            override fun contentAdded(event: ContentManagerEvent) {
                updateCloseable(cm)
                persistTabs(project, cm)
                refreshTitleToolbar(project) // 空标签数量变化（新标签/恢复标签入列），标题栏按钮显隐重算
            }

            override fun selectionChanged(event: ContentManagerEvent) {
                if (cm.selectedContent !== event.content) return
                val panel = event.content.component as? ZCodeToolWindowPanel
                if (panel == null) {
                    // 非聊天标签（浏览器）无标签重命名语义，标题栏不留重命名按钮
                    toolWindow.setTitleActions(emptyList())
                    return
                }
                // 标题栏按钮随选中标签切换实例（Run 面板 Stop 同机制；右键菜单无插件扩展点，见 #18/#21）。
                // 两动作保持独立按钮（曾试合并单「⋮」popup：平台标题栏本就有 ⋮，重复不适合，真机否决）；
                // 平台标题栏按钮尺寸不受插件 icon 控制（12px 缩图标真机无效），大小随平台默认。
                // 批量关闭空标签不随标签切换（全局动作，持 project 遍历全部标签）；
                // 重命名/弹出在 ⋮ 菜单（现取选中标签，不随切换重挂）
                toolWindow.setTitleActions(buildTitleActions(project))
                panel.ensureJcefCreated() // 懒加载标签激活（已激活时为 no-op）
                panel.clearTabTurnFinished() // 点进标签即清「回合结束待查看」标记
                project.zCodeService().setActivePanel(panel)
                // 内嵌浏览器全局共享：展开状态下随标签切换迁移挂载（宽度延续）——
                // 修复「切到新标签后聊天独占被浏览器拉宽的 TW、主界面特别大」
                panel.adoptEmbeddedBrowserIfDisplayed()
                persistTabs(project, cm)
            }

            /** 关闭二次确认：移除前弹确认框，取消则拦截关闭（event.consume）；浏览器标签直接关；
             *  无会话空标签（待命态）也无东西可丢，直接关（CloseEmptyTabsAction 批量关闭同依赖此豁免）；
             *  弹出独立窗口的搬运式 removeContent 也豁免（那是搬走不是关闭，弹确认框就错了） */
            override fun contentRemoveQuery(event: ContentManagerEvent) {
                val content = event.content
                if (content.component is ZCodeBrowserPanel) return
                val panel = content.component as? ZCodeToolWindowPanel
                if (panel?.isStandbyUnbound() == true) return
                if (panel?.isDetachedToWindow() == true) return
                val tabName = content.displayName ?: message("tab.fallbackName")
                val streaming = panel?.isTabStreaming() == true
                val dialogMessage = if (streaming) {
                    message("dialog.closeTab.streaming", tabName)
                } else {
                    message("dialog.closeTab.normal", tabName)
                }
                // 自建对话框替代平台 Messages.showYesNoDialog（恒居中）：定位到点击处附近（见类注释）
                val dialog = CloseTabConfirmDialog(project, dialogMessage, message("dialog.closeTab.title"))
                if (!dialog.showAndGet()) {
                    event.consume()
                }
            }

            override fun contentRemoved(event: ContentManagerEvent) {
                updateCloseable(cm)
                val panel = event.content.component as? ZCodeToolWindowPanel
                // 弹出独立窗口的搬运式移除不反注册：面板仍在独立窗口收事件流、
                // 继续作为 pushToWebview 目标（注册表去留由弹窗关闭路径接管）
                if (panel != null && !panel.isDetachedToWindow()) project.zCodeService().unregisterPanel(panel)
                // 聊天标签全部关闭后（含「只剩浏览器标签又关掉浏览器」）自动补一个，保证会话入口常在
                if (cm.contents.none { it.component is ZCodeToolWindowPanel }) {
                    addTabContent(project, toolWindow, null, getNextTabName(cm))
                    return
                }
                persistTabs(project, cm)
                refreshTitleToolbar(project) // 空标签数量变化（关标签后可能不再值得批量关），标题栏按钮显隐重算
                // panel 的 JCEF 资源由 content.setDisposer(panel) 释放
            }
        })

        updateCloseable(cm)

        // 初始激活面板（外部推送目标）
        (cm.selectedContent?.component as? ZCodeToolWindowPanel)?.let {
            it.ensureJcefCreated() // 兜底：选中项若为懒加载则激活（正常路径激活标签已立即创建）
            project.zCodeService().setActivePanel(it)
            // 标题栏按钮初始挂载（清单统一走 buildTitleActions；⋮ 菜单组随 refreshTitleToolbar 挂）
            cm.selectedContent?.let { content ->
                (content.component as? ZCodeToolWindowPanel)?.let {
                    toolWindow.setTitleActions(buildTitleActions(project))
                }
            }
        }

        // 恢复完成后延时补刷一次标题栏：header 懒构建时序不可控（真机三连——恢复期的
        // contentAdded/selectionChanged 触发的刷新可能早于 header 构建），等 UI 首帧落位后
        // 重设 title actions，确保重启恢复后「关闭全部空标签」按钮显隐即正确
        javax.swing.Timer(TITLE_TOOLBAR_LATE_REFRESH_MS, {
            if (!project.isDisposed && !toolWindow.isDisposed) refreshTitleToolbar(project)
        }).apply { isRepeats = false; start() }
    }

    /** 恢复完成后标题栏补刷的延时（ms）：等首帧渲染与 header 构建落位 */
    private val TITLE_TOOLBAR_LATE_REFRESH_MS = 1500

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
            if (current != 0) {
                @Suppress("DEPRECATION")
                com.intellij.openapi.util.registry.Registry.get("ide.browser.jcef.debug.port").setValue(0)
                com.intellij.openapi.diagnostic.Logger.getInstance("ZCodePlugin")
                    .warn("[browser-use] 已设置 ide.browser.jcef.debug.port=0（随机端口，经 DevToolsActivePort 发现）")
            }
            restartStaleCefServerIfNeeded()
        } catch (e: Exception) {
            com.intellij.openapi.diagnostic.Logger.getInstance("ZCodePlugin")
                .warn("[browser-use] 设置 CDP 调试端口失败: ${e.message}")
        }
    }

    /**
     * Mac 自动清理未带调试端口的历史 cef_server（2026.1 remote JCEF 架构专属坑）：
     *
     * Mac 上 CEF 跑在独立常驻的 cef_server 进程里，IDE 重启不会杀它——若它启动早于
     * 本插件的 debug.port registry 配置，则远程调试永远关着（不写 DevToolsActivePort、
     * 9222 也不通），browser-use 全废，此前只能手动 pkill。这里在面板创建前自动兜底：
     *
     * 1. 本 IDE 会话尚未初始化 CEF（JBCefApp 未起）——否则杀进程会弄死现有 webview；
     * 2. 已有 DevToolsActivePort 则当前 server 正常，无需处理；
     * 3. 通过 Helper 进程的 --user-data-dir 归属到本产品缓存目录，只杀本产品
     *    cef_server 主进程（Helper 的父进程），绝不误伤并存的 JetBrains 产品；
     * 4. 结束后由后续 JBCefBrowser 创建自动拉起带调试端口的新 server，用户无感。
     */
    private fun restartStaleCefServerIfNeeded() {
        if (!com.intellij.openapi.util.SystemInfo.isMac) return
        val log = com.intellij.openapi.diagnostic.Logger.getInstance("ZCodePlugin")
        try {
            if (com.intellij.ui.jcef.JBCefApp.isStarted()) return
            // 端口文件存在 ≠ 健康：server 被强杀后文件可能残留（端口已死），只认端口可达
            if (ZCodeBrowserExecutor.hasReachableCdpEndpoint()) {
                log.info("[browser-use] CDP endpoint healthy (DevToolsActivePort port reachable), no cef_server cleanup needed")
                return
            }
            log.info("[browser-use] No reachable CDP endpoint, checking for stale cef_server without debug port...")
            val ps = ProcessBuilder("ps", "ax", "-o", "pid=,ppid=,command=")
                .redirectErrorStream(true).start()
            val out = try {
                // 输出与等待并发：ps ax 输出可超管道缓冲，先 waitFor 后读会互等死锁
                // （ps 阻塞在写、这边在等退出）→ 5s 超时静默 return，清理永不生效
                val outFuture = java.util.concurrent.CompletableFuture.supplyAsync {
                    runCatching { ps.inputStream.bufferedReader().readText() }.getOrDefault("")
                }
                if (!ps.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)) return
                outFuture.get(2, java.util.concurrent.TimeUnit.SECONDS)
            } finally {
                ps.destroyForcibly()
            }
            // 本产品 jcef_cache 下的 Helper → 其父进程即本产品 cef_server 主进程
            val cacheDir = com.intellij.openapi.application.PathManager.getSystemDir()
                .resolve("jcef_cache").toString()
            val serverPids = out.lineSequence()
                .filter { it.contains("cef_server Helper") && it.contains(cacheDir) }
                .mapNotNull { Regex("""^\s*(\d+)\s+(\d+)\s""").find(it)?.groupValues?.get(2)?.toIntOrNull() }
                .toSet()
            if (serverPids.isEmpty()) return
            val mains = out.lineSequence()
                .filter { Regex("""^\s*(\d+)\s""").find(it)?.groupValues?.get(1)?.toIntOrNull() in serverPids }
                .filter { it.contains("cef_server") && it.contains("--params=") }
                .toList()
            for (line in mains) {
                val pid = Regex("""^\s*(\d+)\s""").find(line)?.groupValues?.get(1) ?: continue
                try {
                    ProcessBuilder("kill", pid).start().waitFor(5, java.util.concurrent.TimeUnit.SECONDS)
                    log.warn("[browser-use] Stale cef_server without debug port terminated (pid=$pid, Mac remote JCEF daemon survives IDE restart); a new one with debug port will start on panel creation")
                } catch (e: Exception) {
                    log.warn("[browser-use] Failed to terminate stale cef_server (pid=$pid): ${e.message}")
                }
            }
        } catch (e: Exception) {
            log.warn("[browser-use] Stale cef_server detect/cleanup failed: ${e.message}")
        }
    }
}
