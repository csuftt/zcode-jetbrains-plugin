/**
 * 主布局（cc-gui 风格：无侧边栏，Header 视图切换）
 *
 * currentView: 'chat' | 'history' | 'settings'
 *   - chat：常驻挂载（切走时 display:none，保留滚动位置与输入草稿）
 *   - history：历史会话列表（条件渲染）
 *   - settings：设置视图（左侧导航 + 用量查询/记忆，条件渲染）
 *
 * Header 按钮：新会话/历史/设置已实现；新Tab→createTab op；搜索→会话内搜索面板
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore, peekSessionTitle } from '@/store/useStore'
import { useTheme } from '@/hooks/useTheme'
import { ChatHeader } from '@/components/ChatHeader'
import { TrajectoryDialog } from '@/components/TrajectoryDialog'
import { ChatView } from '@/components/ChatView'
import { StatusPanel } from '@/components/StatusPanel'
import { QuotaBanner } from '@/components/QuotaBanner'
import { HistoryView } from '@/components/HistoryView'
import { SettingsView } from '@/components/SettingsView'
import { InputBox } from '@/components/InputBox'
import { AskUserDialog } from '@/components/AskUserDialog'
import { WorkspaceHookAdmissionBanner } from '@/components/WorkspaceHookAdmissionBanner'
import { PlanApprovalDialog } from '@/components/PlanApprovalDialog'
import { PermissionApprovalDialog } from '@/components/PermissionApprovalDialog'
import { SubagentDetailDialog } from '@/components/SubagentDetailDialog'
import { SubagentReportDialog } from '@/components/SubagentReportDialog'
import { MarkdownPreviewDialog } from '@/components/MarkdownPreviewDialog'
import { AskUserReviewDialog } from '@/components/AskUserReviewDialog'
import { TurnFileChangesDialog } from '@/components/TurnFileChangesDialog'
import { PairingDialog } from '@/components/PairingDialog'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { ChangelogDialog, CHANGELOG_LAST_SEEN_KEY } from '@/components/ChangelogDialog'
import { EnvBanner } from '@/components/EnvBanner'
import { ZoomIndicator } from '@/components/ZoomIndicator'
import { sendToJava, isInJcef } from '@/ipc/bridge'
import { getPersisted, setPersisted, isKvHydrated, KV_HYDRATED_EVENT, KV_DISABLED_EVENT } from '@/utils/persist'
import { readNewSessionConfig } from '@/utils/newSessionConfig'
import { extractTitleExcerpt } from '@/utils/titleExcerpt'
import { APP_VERSION } from '@/version/version'
import './styles/global.less'
import './styles/buttons.less'

type View = 'chat' | 'history' | 'settings'

export default function App() {
  const { t } = useTranslation()
  // 逐字段 selector（勿合并成对象返回——useSyncExternalStore 对新建对象严格判等
  // 会死循环白屏）。整仓 useStore() 会让任意 store 字段变化（skillsLoading、
  // quotaPollTimer 等无关字段）都重渲染 App 根组件，流式期间放大整树 diff
  const sessions = useStore((s) => s.sessions)
  // 切目录加载态（多目录会话：清空旧列表 + 加载动画）
  const sessionsLoading = useStore((s) => s.sessionsLoading)
  const currentSessionId = useStore((s) => s.currentSessionId)
  const messages = useStore((s) => s.messages)
  const loadingMessages = useStore((s) => s.loadingMessages)
  const streaming = useStore((s) => s.streaming)
  const streamingMessageId = useStore((s) => s.streamingMessageId)
  const waitingSince = useStore((s) => s.waitingSince)
  const lastError = useStore((s) => s.lastError)
  const lastNotice = useStore((s) => s.lastNotice)
  const compacting = useStore((s) => s.compacting)
  const askUser = useStore((s) => s.askUser)
  const exitPlanApproval = useStore((s) => s.exitPlanApproval)
  const permissionRequest = useStore((s) => s.permissionRequest)
  const currentModel = useStore((s) => s.currentModel)
  const archivedSessions = useStore((s) => s.archivedSessions)
  const archivedLoading = useStore((s) => s.archivedLoading)
  const currentFileRef = useStore((s) => s.currentFileRef)
  // action 引用稳定，单独取不触发重渲染
  const init = useStore((s) => s.init)
  const loadSessions = useStore((s) => s.loadSessions)
  // 多目录会话·变体A：关联目录 chips（历史页）
  const linkedWorkspaces = useStore((s) => s.linkedWorkspaces)
  const linkedActiveWorkspacePath = useStore((s) => s.activeWorkspacePath)
  const currentWorkspacePath = useStore((s) => s.currentWorkspacePath)
  const projectPath = useStore((s) => s.projectPath)
  const switchWorkspace = useStore((s) => s.setActiveWorkspace)
  const addLinkedWorkspace = useStore((s) => s.addLinkedWorkspace)
  const removeLinkedWorkspace = useStore((s) => s.removeLinkedWorkspace)
  const selectSession = useStore((s) => s.selectSession)
  const resetToNewSession = useStore((s) => s.resetToNewSession)
  const stopStreaming = useStore((s) => s.stopStreaming)
  const sendMessage = useStore((s) => s.sendMessage)
  const clearError = useStore((s) => s.clearError)
  const clearNotice = useStore((s) => s.clearNotice)
  const renameSession = useStore((s) => s.renameSession)
  const titleRegeneratingSessionId = useStore((s) => s.titleRegeneratingSessionId)
  const sessionTitleRegenError = useStore((s) => s.sessionTitleRegenError)
  const regenerateSessionTitle = useStore((s) => s.regenerateSessionTitle)
  const clearSessionTitleRegenError = useStore((s) => s.clearSessionTitleRegenError)
  const setModel = useStore((s) => s.setModel)
  const loadArchivedSessions = useStore((s) => s.loadArchivedSessions)
  const archiveSession = useStore((s) => s.archiveSession)
  const toggleSessionPin = useStore((s) => s.toggleSessionPin)
  const pinnedSessionIds = useStore((s) => s.pinnedSessionIds)
  const unreadSessionIds = useStore((s) => s.unreadSessionIds)
  const restoreSession = useStore((s) => s.restoreSession)
  const deleteArchivedSession = useStore((s) => s.deleteArchivedSession)
  const locateSessionTab = useStore((s) => s.locateSessionTab)
  const listOpenTabs = useStore((s) => s.listOpenTabs)
  const openSessionNewTab = useStore((s) => s.openSessionNewTab)
  const setPendingSettingsSection = useStore((s) => s.setPendingSettingsSection)
  const changelogOpen = useStore((s) => s.changelogOpen)
  const openChangelog = useStore((s) => s.openChangelog)
  const closeChangelog = useStore((s) => s.closeChangelog)

  // IDE 主题同步
  useTheme()

  // 视图切换（dev 辅助：浏览器 mock 验收可带 #settings/#basic/#other/#skills/#mcp/#usage 直达，
  // 前缀需与 SettingsView 的页签 hash 白名单一致；#mcp/<服务器名> 直达并自动展开该卡片；
  // JCEF 内 hash 恒空不影响生产）
  const settingsHashes = ['#settings', '#basic', '#models', '#other', '#skills', '#agents', '#mcp', '#usage']
  const isSettingsHash = settingsHashes.some(
    (h) => window.location.hash === h || window.location.hash.startsWith(h + '/'),
  )
  const [currentView, setCurrentView] = useState<View>(
    !isInJcef() && isSettingsHash ? 'settings' : 'chat',
  )

  // 会话内搜索面板（仅 chat 视图）
  const [searchOpen, setSearchOpen] = useState(false)

  // 模型调用轨迹弹窗（读 CLI 落盘 model-io，仅 chat 视图顶栏入口）
  const [trajectoryOpen, setTrajectoryOpen] = useState(false)

  // 离开 chat 视图自动关闭搜索（清理由面板卸载 effect 兜底）
  useEffect(() => {
    if (currentView !== 'chat') setSearchOpen(false)
  }, [currentView])

  // 手机远程状态初始拉取：入口图标颜色随 relay 状态联动，面板打开时要先取到
  // 当前态（重启自动恢复连接发生在面板打开之前，Kotlin 广播无人接收，须主动拉）；
  // 后续状态翻转由 Kotlin 侧 broadcastState 推送
  useEffect(() => {
    useStore.getState().refreshRemoteState()
  }, [])

  // Ctrl+F / Cmd+F 打开会话内搜索（capture 阶段拦截；跳过 IME 组合态）
  useEffect(() => {
    if (currentView !== 'chat') return
    const handler = (e: KeyboardEvent) => {
      if (e.isComposing) return
      const isMac = navigator.platform.toLowerCase().includes('mac')
      const key = e.key.toLowerCase()
      if ((isMac ? e.metaKey : e.ctrlKey) && key === 'f') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [currentView])

  // 全局拦 OS 文件拖入：避免 Chromium 默认行为把文件当 navigation 加载导致 webview 跳走
  // IDE 侧 AWT DropTarget（ZCodeToolWindowPanel.registerFileDropTarget）已消费 OS 事件，
  // 此处只补 webview 端"拖到非 InputBox 区域"的兜底
  useEffect(() => {
    const block = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      e.stopPropagation()
    }
    document.addEventListener('dragover', block)
    document.addEventListener('drop', block)
    return () => {
      document.removeEventListener('dragover', block)
      document.removeEventListener('drop', block)
    }
  }, [])

  // 轻量 toast（暂未支持提示）
  const [toast, setToast] = useState<string | null>(null)
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 2000)
    return () => clearTimeout(timer)
  }, [toast])

  // 驻留水位提醒（缺陷BA）：停留久一些让用户读到引导文案，14s 自动消失
  const residentPoolNotice = useStore((s) => s.residentPoolNotice)
  const clearResidentPoolNotice = useStore((s) => s.clearResidentPoolNotice)
  useEffect(() => {
    if (!residentPoolNotice) return
    const timer = setTimeout(clearResidentPoolNotice, 14000)
    return () => clearTimeout(timer)
  }, [residentPoolNotice, clearResidentPoolNotice])

  useEffect(() => {
    init()
    // 电脑控制主开关启动加载：入口 chip（InputBox）显示条件含 cuaEnabled===true，
    // 但此前只有进设置页（ComputerSettingsView mount）才拉——启动后 store 停在 null，
    // 开关明明开着入口却不出现，直到用户逛过一次设置页（2026-10-10 真机反馈）。
    // 幂等轻请求（Java 读 PropertiesComponent 同步回包），随 init 一起全局跑一次
    useStore.getState().loadCuaEnabled()
  }, [init])

  // 定时任务镜像自愈：Java→JS 广播无端到端确认，后台唤起窗口丢一条 remove 快照，
  // 卡片就永久残留「待执行（即将补发）」、fired 历史缺记录（2026-08-30 实测）。
  // 回到前台的瞬间重拉全量快照对账（节流 5s，防 focus 抖动高频请求）
  useEffect(() => {
    let last = 0
    const refresh = () => {
      const now = Date.now()
      if (now - last < 5000) return
      last = now
      useStore.getState().refreshScheduledList()
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  // 升级后首次打开自动弹「版本更新」：已读标记走 persist kv 通道（IDE 侧持久——
  // 内置 server 随机端口致 localStorage 跨重启失效）。JCEF 内等权威 kv 水合完成再比对
  // （注入兜底失败时 persist 停用，本会话宁可不弹不误弹）。桥注入时序不稳（可能晚于
  // React 挂载到达），启动判定不得按「未见桥 = dev/mock」直读 localStorage——生产空
  // origin 下会读到空值，每次重启误弹。统一等 persist 的终止信号：水合完成事件（权威
  // kv 已写回）或放弃事件（dev/mock，localStorage 即权威源）
  useEffect(() => {
    const check = () => {
      if (getPersisted(CHANGELOG_LAST_SEEN_KEY) !== APP_VERSION) openChangelog()
    }
    if (isKvHydrated()) {
      check()
      return
    }
    window.addEventListener(KV_HYDRATED_EVENT, check, { once: true })
    window.addEventListener(KV_DISABLED_EVENT, check, { once: true })
    return () => {
      window.removeEventListener(KV_HYDRATED_EVENT, check)
      window.removeEventListener(KV_DISABLED_EVENT, check)
    }
  }, [openChangelog])

  const currentSession = sessions.find((s) => s.sessionId === currentSessionId)

  // 当前是否处于"空会话"（无消息可丢）：无会话（懒创建待命态，发首条消息即建会话）
  // 或已绑定会话但无对话历史。空会话时置灰 + 拦截「新会话」——再建只会堆积无意义的空会话
  const currentSessionEmpty = !loadingMessages && messages.length === 0

  // 新建会话二次确认（避免误触切走正在进行的对话）
  const [confirmNewSession, setConfirmNewSession] = useState(false)

  const handleNewSession = () => {
    if (currentSessionEmpty) return // 按钮已置灰，此处兜底（无会话待命态 = 隐式新会话，无需再建）
    // 行为设置「直接覆盖当前标签页」开启时免确认（utils/newSessionConfig.ts，默认关）。
    // 只影响本按钮；历史列表的「覆盖 / 新标签页」选择弹窗（HistoryView）不走这里
    if (readNewSessionConfig().directOverwrite) {
      resetToNewSession() // = 确认弹窗 onConfirm 路径：重置待命态，首条消息懒创建
      return
    }
    setConfirmNewSession(true)
  }

  // 标题：列表里的标题（CLI 会随对话更新）→ 会话 id 前缀（列表尚未刷新时）→ 空
  // 标题 fallback 链：列表内标题 > 手动改名持久化 > 最后已知标题缓存（跨目录浏览，
  // 多目录会话切目录后当前会话不在列表里）> sessionId 前缀。
  // 后两层兜"切目录浏览"场景（多目录会话）：sessions 随激活目录全量替换后当前会话
  // 不在新目录列表里，没有兜底层标题会闪回 sess_ 前缀（真机 2026-10-27 实测）
  const sessionTitle =
    currentSession?.title ??
    (currentSessionId ? getPersisted(`zcode.sessionTitle.${currentSessionId}`) : null) ??
    (currentSessionId ? peekSessionTitle(currentSessionId) : null) ??
    (currentSessionId ? currentSessionId.slice(0, 12) : '')

  // 目录徽标（多目录会话·变体A·方案A）：语义两态——有会话=会话归属目录（不随 chips
  // 漂移），待命=落位目录（随 chips 切换）；=本项目（或空）不显示
  const wsBadgeDir = useMemo(() => {
    const dir = currentSessionId ? currentWorkspacePath : linkedActiveWorkspacePath
    if (!dir) return null
    if (
      dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() ===
      projectPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    ) {
      return null
    }
    return dir
  }, [currentSessionId, currentWorkspacePath, linkedActiveWorkspacePath, projectPath])

  // AI 重新生成标题：有真实用户消息才可生成；失败提示 6s 自动消失
  const canRegenerateTitle = useMemo(() => extractTitleExcerpt(messages) !== null, [messages])
  useEffect(() => {
    if (!sessionTitleRegenError) return
    const timer = setTimeout(clearSessionTitleRegenError, 6000)
    return () => clearTimeout(timer)
  }, [sessionTitleRegenError, clearSessionTitleRegenError])

  // 会话标题推给 Java 作标签 tooltip（悬停显示会话名；标签本身保持「会话N」编号）。
  // 变化时防抖 500ms；只在本 webview 连接 Java 时发送（mock 模式静默丢弃）
  const lastPushedTitleRef = useRef('')
  useEffect(() => {
    const effective = sessionTitle || (currentSessionId ? currentSessionId.slice(0, 12) : '')
    // 待命态（无会话）时复位已推标记：否则新会话标题与旧会话相同时会被去重跳过
    if (!effective) {
      lastPushedTitleRef.current = ''
      return
    }
    if (effective === lastPushedTitleRef.current) return
    const timer = setTimeout(() => {
      lastPushedTitleRef.current = effective
      sendToJava({ op: 'setTabTitle', title: effective.slice(0, 50), sessionId: currentSessionId ?? undefined })
    }, 500)
    return () => clearTimeout(timer)
  }, [sessionTitle, currentSessionId])

  return (
    <div className="app">
      <ChatHeader
        currentView={currentView}
        sessionTitle={sessionTitle}
        wsBadgeDir={wsBadgeDir}
        onBack={() => setCurrentView('chat')}
        newSessionDisabled={currentSessionEmpty}
        onNewSession={handleNewSession}
        onNewTab={() => sendToJava({ op: 'createTab' })}
        onOpenBrowser={() => sendToJava({ op: 'toggleBrowserPane' })}
        onOpenTrajectory={() => setTrajectoryOpen(true)}
        trajectoryDisabled={!currentSessionId}
        onSearch={() => setSearchOpen(true)}
        onHistory={() => setCurrentView('history')}
        onSettings={() => setCurrentView('settings')}
        onTitleChange={(t) => {
          if (currentSessionId) renameSession(currentSessionId, t)
        }}
        onRegenerateTitle={() => {
          if (currentSessionId) regenerateSessionTitle(currentSessionId)
        }}
        canRegenerateTitle={canRegenerateTitle}
        regeneratingTitle={!!currentSessionId && titleRegeneratingSessionId === currentSessionId}
      />
      {/* 环境提醒条：仅 node/zcode.cjs 阻断异常时显示；browserHost 降级不上横幅
          （用户反馈扰民），收敛到 设置→浏览器 控制卡常驻提示 + 左栏图标置灰 */}
      <EnvBanner
        onGoSettings={() => {
          setPendingSettingsSection('env')
          setCurrentView('settings')
        }}
      />
      {trajectoryOpen && <TrajectoryDialog sessionId={currentSessionId} onClose={() => setTrajectoryOpen(false)} />}

      <div className="app__body">
        {/* chat 视图常驻挂载（切历史/设置时 display:none，保留消息滚动位置与输入草稿——
            InputBox 正文存于 contenteditable DOM，卸载即丢）*/}
        <div
          style={
            currentView === 'chat'
              ? { display: 'flex', flex: 1, minHeight: 0, flexDirection: 'column', overflow: 'hidden' }
              : { display: 'none' }
          }
        >
          <ChatView
            messages={messages}
            // 待命态（无会话）不渲染加载圈（缺陷FH 兜底）：loadingMessages 只应由
            // selectSession 在有会话时置位，若再漏清也只冻结欢迎页不冻结整标签
            loading={loadingMessages && !!currentSessionId}
            waiting={streaming}
            waitingSince={waitingSince ?? undefined}
            streamingMessageId={streamingMessageId}
            compacting={compacting}
            searchOpen={searchOpen}
            onSearchClose={() => setSearchOpen(false)}
          />
          <StatusPanel />
          {/* 会话额度横幅（耗尽/并发/服务商边界/限频/低额提醒）：错误触发 + 60s 额度轮询派生，
              窗口恢复或用户关闭后消失；只占 chat 列，错误详情仍在底部 lastError 条 */}
          <QuotaBanner />
          <InputBox
            onSend={(text, _filePaths, attachments) => sendMessage(text, attachments)}
            isStreaming={streaming}
            onStop={stopStreaming}
            currentModel={currentModel}
            onModelSelect={(modelId, providerId) => setModel(modelId, providerId)}
            onOpenAgentSettings={() => {
              setPendingSettingsSection('agents')
              setCurrentView('settings')
            }}
            onOpenModelSettings={() => {
              setPendingSettingsSection('models')
              setCurrentView('settings')
            }}
            currentFileRef={currentFileRef}
          />
        </div>

        {currentView === 'history' && (
          <HistoryView
            sessions={sessions}
            sessionsLoading={sessionsLoading}
            archivedSessions={archivedSessions}
            archivedLoading={archivedLoading}
            currentSessionId={currentSessionId}
            onLocate={locateSessionTab}
            onLoadOpenTabs={listOpenTabs}
            onOpenNewTab={openSessionNewTab}
            onSelect={selectSession}
            onBack={() => setCurrentView('chat')}
            onArchive={archiveSession}
            onRestore={restoreSession}
            onDeleteArchived={deleteArchivedSession}
            onTogglePin={toggleSessionPin}
            pinnedSessionIds={pinnedSessionIds}
            unreadSessionIds={unreadSessionIds}
            onRefresh={loadSessions}
            onLoadArchived={loadArchivedSessions}
            linkedWorkspaces={linkedWorkspaces}
            activeWorkspacePath={linkedActiveWorkspacePath}
            projectWorkspacePath={projectPath}
            onSwitchWorkspace={switchWorkspace}
            onAddWorkspace={addLinkedWorkspace}
            onRemoveWorkspace={removeLinkedWorkspace}
            onNewSession={() => {
              if (currentSessionId) {
                // 当前标签有会话：开新标签落位到浏览目录，不覆盖现有会话
                sendToJava({ op: 'createTab', workspacePath: linkedActiveWorkspacePath || projectPath })
              } else {
                // 当前标签已在待命态：就地进待命（落位=浏览目录），首条消息懒创建
                resetToNewSession()
                setCurrentView('chat')
              }
            }}
          />
        )}

        {currentView === 'settings' && <SettingsView onBack={() => setCurrentView('chat')} />}
      </div>

      {lastNotice && (
        <div className="app__notice-bar">
          <span>⏳ {lastNotice}</span>
          <button className="app__error-close" onClick={clearNotice} aria-label={t('app.errorCloseAria')}>
            <span className="codicon codicon-close" />
          </button>
        </div>
      )}

      {lastError && (
        <div className="app__error-bar">
          <span>⚠️ {lastError}</span>
          <button className="app__error-close" onClick={clearError} title={t('app.errorClose')} aria-label={t('app.errorCloseAria')}>
            <span className="codicon codicon-close" />
          </button>
        </div>
      )}

      {/* 轻量 toast */}
      {toast && <div className="app__toast">{toast}</div>}

      {/* 浏览器缩放指示器（Ctrl+滚轮缩放时的百分比胶囊，点击/Ctrl+0 重置） */}
      <ZoomIndicator />

      {/* 驻留水位提醒（缺陷BA）：通栏信息条（与 notice-bar 同构）——悬浮 toast 在窄
          面板下被挤成窄卡多行且关闭钮悬空（六轮用户反馈），通栏能用满面板宽度；
          停留 14s 自动消失（上方 useEffect）*/}
      {residentPoolNotice && (
        <div className="app__notice-bar">
          <span>⚠️ {residentPoolNotice}</span>
          <button className="app__error-close" onClick={clearResidentPoolNotice} aria-label={t('app.errorCloseAria')}>
            <span className="codicon codicon-close" />
          </button>
        </div>
      )}

      {/* AI 标题重生成失败提示：6s 自动消失（上方 useEffect），可手动关闭 */}
      {sessionTitleRegenError && (
        <div className="app__notice-bar">
          <span>⚠️ {sessionTitleRegenError}</span>
          <button className="app__error-close" onClick={clearSessionTitleRegenError} aria-label={t('app.errorCloseAria')}>
            <span className="codicon codicon-close" />
          </button>
        </div>
      )}

      {/* 新建会话确认（issue #21）：当前标签已有会话时三选——覆盖当前标签 / 新标签页打开 / 取消。
          新标签页与 Header 新标签按钮同路径（op:createTab → Java 新 Content，原标签不动）*/}
      {confirmNewSession && (
        <ConfirmDialog
          title={t('app.newSession.title')}
          message={t('app.newSession.message')}
          confirmText={t('app.newSession.confirm')}
          extraText={t('app.newSession.newTab')}
          onConfirm={() => {
            setConfirmNewSession(false)
            resetToNewSession() // 延迟创建：先重置为待命态，首条消息触发建会话
          }}
          onExtra={() => {
            setConfirmNewSession(false)
            sendToJava({ op: 'createTab' })
          }}
          onCancel={() => setConfirmNewSession(false)}
        />
      )}

      {/* AskUserQuestion 弹窗 */}
      {askUser && (
        <AskUserDialog
          requestId={askUser.requestId}
          toolName={askUser.toolName}
          questions={askUser.questions}
          deadlineMs={askUser.deadlineMs}
          askedAt={askUser.askedAt}
          onClose={() => useStore.setState({ askUser: null })}
        />
      )}

      {/* 工作区钩子准入横幅（官方同款，v4 workspaceHookAdmission 投影；仅 chat 视图渲染） */}
      <WorkspaceHookAdmissionBanner
        visible={currentView === 'chat'}
        onGoReview={() => {
          setPendingSettingsSection('hooks')
          setCurrentView('settings')
        }}
      />

      {/* ExitPlanMode 计划审批面板（底部停靠，无超时等待） */}
      {exitPlanApproval && (
        <PlanApprovalDialog
          requestId={exitPlanApproval.requestId}
          plan={exitPlanApproval.plan}
          deadlineMs={exitPlanApproval.deadlineMs}
          askedAt={exitPlanApproval.askedAt}
          onClose={() => useStore.setState({ exitPlanApproval: null })}
        />
      )}

      {/* 工具权限审批弹窗（「变更前询问」模式，interaction/requestPermission）*/}
      {permissionRequest && (
        <PermissionApprovalDialog
          requestId={permissionRequest.requestId}
          toolName={permissionRequest.toolName}
          reason={permissionRequest.reason}
          options={permissionRequest.options}
          input={permissionRequest.input}
          riskLevel={permissionRequest.riskLevel}
          deadlineMs={permissionRequest.deadlineMs}
          onClose={() => useStore.setState({ permissionRequest: null })}
        />
      )}

      {/* 子代理详情弹窗（底部子代理栏 / Agent 工具卡点击打开，store 自管理开关）*/}
      <SubagentDetailDialog />
      {/* 子代理报告弹窗（与详情弹窗互斥切换：过程↔结论 来回切）*/}
      <SubagentReportDialog />
      {/* 通用 Markdown 预览弹窗（工具卡输出全文阅读，如 Skill 文档/网页工具结果；
          叠在详情弹窗之上的阅读层，关闭后详情仍在）*/}
      <MarkdownPreviewDialog />
      {/* AskUserQuestion 回看弹窗（消息流「询问用户」工具卡点击，只读回看问题与已选答案）*/}
      <AskUserReviewDialog />
      {/* 逐轮文件更改弹窗（B2 回合产物：更改条点击打开，含撤销该轮文件改动）*/}
      <TurnFileChangesDialog />
      {/* 手机远程配对弹窗（Header 手机图标打开，store 自管理开关）*/}
      <PairingDialog />
      {/* 版本更新弹窗（条件渲染：每次打开从最新版页开始；关闭即记已读当前版本）*/}
      {changelogOpen && (
        <ChangelogDialog
          onClose={() => {
            closeChangelog()
            setPersisted(CHANGELOG_LAST_SEEN_KEY, APP_VERSION)
          }}
        />
      )}
    </div>
  )
}
