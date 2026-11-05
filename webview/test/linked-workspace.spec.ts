/**
 * 多目录会话（变体A：历史页目录 chips）store 链路回归测试
 *
 * 覆盖：
 * 1. linkedWorkspaces 应答：added=新增目录 → 自动切换激活目录并以该目录重拉列表
 * 2. 切换激活目录：归档列表缓存清空（拉取式缓存不得残留旧目录数据）
 * 3. 移除激活目录：应答列表不含它 → 自动回退本项目
 * 4. listSessions 应答的 staleLocal 补插按列表作用域过滤——切到关联目录后，
 *    本项目"刚活跃"的会话不得残留进关联目录列表（sessionsWorkspace 作用域）
 * 5. createSession 请求携带激活目录（新会话落位）
 * 6. 会话标签 init 落位随标签目录（用户定稿 2026-11-05）：boot 恢复后作用域不切回、
 *    目录被移出关联列表时 linkedWorkspaces 守卫兜底回本项目
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const sentRequests: Array<Record<string, unknown>> = []

/** 模拟 Java 注入的本项目 workspace（__ZCODE_WORKSPACE__；竞态用例临时置空模拟未注入）*/
let workspaceInjected = 'G:/mock-project'

/** 模拟 Java 注入的标签初始目录（跨目录会话新标签打开/重启恢复路径）*/
let tabWorkspaceInjected = ''

/** 模拟标签绑定的初始会话（非空=会话标签走 boot 恢复链；空=「新建会话」空标签）*/
let tabInitialSessionId = ''

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => workspaceInjected,
  getTabWorkspacePath: () => tabWorkspaceInjected,
  getInitialSessionId: () => tabInitialSessionId,
  onMessage: () => {},
  onStreamEvent: () => {},
  onStreamBatch: () => {},
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import { useStore, handleResponse, peekSessionTitle } from '@/store/useStore'

const WS_PROJECT = 'G:/mock-project'
const WS_OTHER = 'E:/work/other-project'

/** SessionInfo 最小形态（handleResponse 只读用到的字段，其余 as any 顶替）*/
function sess(id: string, ws: string, updatedAt = Date.now()) {
  return { sessionId: id, workspacePath: ws, workspaceKey: ws, title: id, updatedAt, status: 'idle' }
}

beforeEach(() => {
  sentRequests.length = 0
  workspaceInjected = 'G:/mock-project'
  tabWorkspaceInjected = ''
  tabInitialSessionId = ''
  useStore.setState({
    projectPath: WS_PROJECT,
    linkedWorkspaces: [],
    activeWorkspacePath: '',
    sessionsWorkspace: '',
    sessions: [],
    archivedSessions: [],
    currentSessionId: null,
    skipInitialSessionRestore: true, // 关掉 boot 恢复分支对本测试的干扰
  })
})

describe('关联目录应答与激活目录切换', () => {
  it('added → 自动切换激活目录并按新目录重拉会话列表', () => {
    handleResponse(
      { op: 'linkedWorkspaces', workspaces: [WS_OTHER], added: WS_OTHER } as never,
      useStore.setState, useStore.getState,
    )
    const s = useStore.getState()
    expect(s.linkedWorkspaces).toEqual([WS_OTHER])
    expect(s.activeWorkspacePath).toBe(WS_OTHER)
    // 重拉请求落在激活目录上（原生分隔符差异也要归一到同一目标：传的就是原值）
    const listReq = sentRequests.find((r) => r.op === 'listSessions')
    expect(listReq?.workspacePath).toBe(WS_OTHER)
    expect(s.sessionsWorkspace).toBe(WS_OTHER)
  })

  it('切换激活目录清空归档缓存（拉取式缓存不残留旧目录）', () => {
    useStore.setState({ archivedSessions: [sess('arch_old', WS_PROJECT)] as never, activeWorkspacePath: '' })
    useStore.getState().setActiveWorkspace(WS_OTHER)
    expect(useStore.getState().archivedSessions).toEqual([])
  })

  it('移除的是激活目录 → 自动回退本项目', () => {
    useStore.setState({ activeWorkspacePath: WS_OTHER, linkedWorkspaces: [WS_OTHER] })
    handleResponse(
      { op: 'linkedWorkspaces', workspaces: [] } as never,
      useStore.setState, useStore.getState,
    )
    expect(useStore.getState().activeWorkspacePath).toBe(WS_PROJECT)
  })

  it('幂等切换：目标即当前列表作用域时不重拉（仅对齐落位）', () => {
    useStore.setState({ activeWorkspacePath: '', sessionsWorkspace: WS_OTHER })
    useStore.getState().setActiveWorkspace(WS_OTHER) // 目标 = 当前列表作用域（chips 原值重击）
    const listReqs = sentRequests.filter((r) => r.op === 'listSessions')
    expect(listReqs).toHaveLength(0) // 列表已在该目录，早退（仅落位对齐）
    expect(useStore.getState().activeWorkspacePath).toBe(WS_OTHER)
  })
})

describe('projectPath 注入空串兜底（重启初期 basePath 未就绪）', () => {
  it('ensureProjectPath：projectPath 空串时发 getProjectPath，非空时不发', () => {
    useStore.setState({ projectPath: '' })
    useStore.getState().ensureProjectPath()
    expect(sentRequests.some((r) => r.op === 'getProjectPath')).toBe(true)

    sentRequests.length = 0
    useStore.setState({ projectPath: WS_PROJECT })
    useStore.getState().ensureProjectPath()
    expect(sentRequests.some((r) => r.op === 'getProjectPath')).toBe(false)
  })

  it('projectPath 应答：写回 store（空串应答不落，防覆盖已注入的正确值）', () => {
    useStore.setState({ projectPath: '' })
    handleResponse(
      { op: 'projectPath', workspacePath: 'G:/real-project' } as never,
      useStore.setState, useStore.getState,
    )
    expect(useStore.getState().projectPath).toBe('G:/real-project')

    handleResponse(
      { op: 'projectPath', workspacePath: '' } as never,
      useStore.setState, useStore.getState,
    )
    expect(useStore.getState().projectPath).toBe('G:/real-project')
  })
})

describe('listSessions 应答合并的目录作用域', () => {
  it('激活目录=关联目录时，本项目的活跃会话不补插残留', () => {
    // 切到关联目录后收到关联目录列表：本项目刚活跃的 S_A 不得经 staleLocal 混入
    useStore.setState({
      activeWorkspacePath: WS_OTHER,
      sessionsWorkspace: WS_OTHER,
      sessions: [sess('S_A', WS_PROJECT)] as never,
    })
    handleResponse(
      { op: 'listSessions', sessions: [sess('S_B', WS_OTHER)] } as never,
      useStore.setState, useStore.getState,
    )
    const ids = useStore.getState().sessions.map((x) => x.sessionId)
    expect(ids).toEqual(['S_B'])
  })

  it('本项目列表（作用域=本项目）内活跃会话仍正常补插', () => {
    useStore.setState({
      activeWorkspacePath: '',
      sessionsWorkspace: WS_PROJECT,
      sessions: [sess('S_A', WS_PROJECT)] as never,
    })
    handleResponse(
      { op: 'listSessions', sessions: [sess('S_B', WS_PROJECT)] } as never,
      useStore.setState, useStore.getState,
    )
    const ids = useStore.getState().sessions.map((x) => x.sessionId)
    expect(ids).toContain('S_A')
    expect(ids).toContain('S_B')
  })
})

describe('跨目录会话新标签打开（标签初始目录注入）', () => {
  it('gotoSession 请求携带会话自身目录', () => {
    useStore.getState().openSessionNewTab('sess_x', WS_OTHER)
    const req = sentRequests.find((r) => r.op === 'gotoSession')
    expect(req?.workspacePath).toBe(WS_OTHER)
  })

  it('会话标签 init：落位随标签目录（历史页默认选中它）+ boot 目录服务绑定会话恢复', () => {
    tabWorkspaceInjected = WS_OTHER
    tabInitialSessionId = 'sess_bound' // 有绑定会话=会话标签，走 boot 链
    useStore.setState({ activeWorkspacePath: '' })
    void useStore.getState().init()
    // 首拉按注入目录（绑定会话在列表里可恢复）；init 同步链内即消费（bootWorkspace 清空）
    const req = sentRequests.find((r) => r.op === 'listSessions')
    expect(req?.workspacePath).toBe(WS_OTHER)
    expect(useStore.getState().activeWorkspacePath).toBe(WS_OTHER) // 落位=标签目录（用户定稿 2026-11-05）
    expect(useStore.getState().bootWorkspace).toBe('') // 一次性已消费
    // boot 消费后例行刷新延续落位目录（标签目录），不再回落本项目
    sentRequests.length = 0
    useStore.getState().loadSessions()
    expect(sentRequests.find((r) => r.op === 'listSessions')?.workspacePath).toBe(WS_OTHER)
  })

  it('bootWorkspace 一次性（空标签/守卫已消费的 init）：loadSessions 回落激活目录', () => {
    tabWorkspaceInjected = WS_OTHER
    tabInitialSessionId = 'sess_bound'
    useStore.setState({ activeWorkspacePath: '' })
    void useStore.getState().init() // bridgeInitialized 已被前用例消费，此处空转
    sentRequests.length = 0
    useStore.getState().loadSessions()
    const req = sentRequests.find((r) => r.op === 'listSessions')
    expect(req?.workspacePath).toBe(WS_PROJECT) // 落位空串 → 回落本项目
    expect(useStore.getState().bootWorkspace).toBe('')
  })

  it('「新建会话」空标签 init：落位=标签目录（徽标/chips/列表全按它走），不进 boot 恢复链', async () => {
    // init 有 bridgeInitialized 一次性守卫（前面用例已消费）——重置模块拿全新实例
    vi.resetModules()
    const { useStore: freshStore } = await import('@/store/useStore')
    tabWorkspaceInjected = WS_OTHER
    tabInitialSessionId = '' // 无绑定会话=「新建会话」入口
    freshStore.setState({ projectPath: WS_PROJECT, activeWorkspacePath: '', bootWorkspace: '', bootRestorePending: false, sessionsWorkspace: '' })
    void freshStore.getState().init()
    const s = freshStore.getState()
    expect(s.activeWorkspacePath).toBe(WS_OTHER) // 落位即标签目录（待命态徽标由此显示）
    expect(s.bootWorkspace).toBe('')
    expect(s.bootRestorePending).toBe(false) // 无恢复需求，收尾不触发不二次重拉
  })

  it('会话标签 boot 首拉响应后作用域不切回（落位已随标签目录，chips 与列表天然一致）', async () => {
    vi.resetModules()
    const { useStore: freshStore, handleResponse: freshHandle } = await import('@/store/useStore')
    tabWorkspaceInjected = WS_OTHER
    tabInitialSessionId = 'sess_bound'
    freshStore.setState({
      projectPath: WS_PROJECT,
      linkedWorkspaces: [WS_OTHER],
      activeWorkspacePath: '',
      bootWorkspace: '',
      bootRestorePending: false,
      sessionsWorkspace: '',
      skipInitialSessionRestore: false,
    })
    void freshStore.getState().init()
    // boot 首拉响应（回显=标签目录），绑定会话在列表中 → 正常恢复
    freshHandle(
      { op: 'listSessions', sessions: [sess('sess_bound', WS_OTHER)], workspacePath: WS_OTHER } as never,
      freshStore.setState, freshStore.getState,
    )
    const s = freshStore.getState()
    expect(s.currentSessionId).toBe('sess_bound') // 绑定会话恢复不受影响
    expect(s.bootRestorePending).toBe(false)
    expect(s.sessionsWorkspace).toBe(WS_OTHER) // 作用域=标签目录，不再静默切回
    // 全程只有 boot 那一次 listSessions（收尾空转，无第二拉）
    expect(sentRequests.filter((r) => r.op === 'listSessions')).toHaveLength(1)
  })

  it('极端情况：标签目录已被移出关联列表 → linkedWorkspaces 守卫兜底回本项目（第一个 chip）', async () => {
    vi.resetModules()
    const { useStore: freshStore, handleResponse: freshHandle } = await import('@/store/useStore')
    tabWorkspaceInjected = WS_OTHER
    tabInitialSessionId = 'sess_bound'
    freshStore.setState({
      projectPath: WS_PROJECT,
      linkedWorkspaces: [],
      activeWorkspacePath: '',
      bootWorkspace: '',
      bootRestorePending: false,
      sessionsWorkspace: '',
    })
    void freshStore.getState().init() // 落位=WS_OTHER（已不在关联列表）
    expect(freshStore.getState().activeWorkspacePath).toBe(WS_OTHER)
    sentRequests.length = 0
    freshHandle(
      { op: 'linkedWorkspaces', workspaces: [] } as never,
      freshStore.setState, freshStore.getState,
    )
    const s = freshStore.getState()
    expect(s.activeWorkspacePath).toBe(WS_PROJECT) // 兜底回本项目
    expect(s.sessionsWorkspace).toBe(WS_PROJECT)
    expect(sentRequests.find((r) => r.op === 'listSessions')?.workspacePath).toBe(WS_PROJECT) // 按兜底目录重拉
  })
})

describe('跨目录浏览标题兜底', () => {
  it('listSessions 喂入最后已知标题缓存；切目录后当前会话标题仍可查（header fallback 层）', () => {
    useStore.setState({ activeWorkspacePath: '', sessionsWorkspace: WS_PROJECT })
    handleResponse(
      { op: 'listSessions', sessions: [sess('S_A', WS_PROJECT, 1)] } as never,
      useStore.setState, useStore.getState,
    )
    // 用非占位标题喂入（sess() 的 title=id 是占位形态，须真标题才进缓存）
    handleResponse(
      { op: 'listSessions', sessions: [{ ...sess('S_A', WS_PROJECT, 2), title: '修复 MetricsManager' }] } as never,
      useStore.setState, useStore.getState,
    )
    expect(peekSessionTitle('S_A')).toBe('修复 MetricsManager')
    // 切到关联目录（列表替换为空）后缓存仍在
    useStore.setState({ activeWorkspacePath: WS_OTHER, sessionsWorkspace: WS_OTHER })
    handleResponse({ op: 'listSessions', sessions: [] } as never, useStore.setState, useStore.getState)
    expect(peekSessionTitle('S_A')).toBe('修复 MetricsManager')
  })

  it('sessionStatsPatch 同时合并会话列表与归档列表（归档 tab stats 异步化）', () => {
    useStore.setState({
      sessions: [sess('S_main', WS_PROJECT)] as never,
      archivedSessions: [sess('S_arch', WS_PROJECT)] as never,
    })
    handleResponse(
      { op: 'sessionStatsPatch', items: [
        { sessionId: 'S_main', messageCount: 11, sizeBytes: 2200 },
        { sessionId: 'S_arch', messageCount: 7, sizeBytes: 900 },
      ] } as never,
      useStore.setState, useStore.getState,
    )
    const st = useStore.getState()
    expect(st.sessions[0].messageCount).toBe(11)
    expect(st.archivedSessions[0].messageCount).toBe(7)
    expect(st.archivedSessions[0].sizeBytes).toBe(900)
  })

  it('占位标题（sessionId 前缀）不进缓存', () => {
    handleResponse(
      { op: 'listSessions', sessions: [sess('sess_abc', WS_PROJECT, 3)] } as never,
      useStore.setState, useStore.getState,
    )
    expect(peekSessionTitle('sess_abc')).toBeNull()
  })
})

describe('切目录加载态与乱序丢弃', () => {
  it('切换激活目录清空 sessions 并置 loading；匹配目录的响应解除', () => {
    useStore.setState({ activeWorkspacePath: '', sessionsWorkspace: '' })
    useStore.setState({ sessions: [sess('S_old', WS_PROJECT)] as never })
    useStore.getState().setActiveWorkspace(WS_OTHER)
    const s = useStore.getState()
    expect(s.sessions).toEqual([]) // 旧目录列表立即清空
    expect(s.sessionsLoading).toBe(true)
    handleResponse(
      { op: 'listSessions', sessions: [sess('S_B', WS_OTHER)], workspacePath: WS_OTHER } as never,
      useStore.setState, useStore.getState,
    )
    expect(useStore.getState().sessionsLoading).toBe(false)
    expect(useStore.getState().sessions.map((x) => x.sessionId)).toEqual(['S_B'])
  })

  it('乱序晚到的旧目录响应被丢弃（不覆盖新目录列表，不清 loading）', () => {
    useStore.setState({ activeWorkspacePath: WS_OTHER, sessionsWorkspace: WS_OTHER, sessionsLoading: true })
    handleResponse(
      { op: 'listSessions', sessions: [sess('S_old', WS_PROJECT)], workspacePath: WS_PROJECT } as never,
      useStore.setState, useStore.getState,
    )
    const s = useStore.getState()
    expect(s.sessions).toEqual([]) // 旧响应未落地
    expect(s.sessionsLoading).toBe(true) // 新请求仍在途
  })

  it('无回显的响应（旧 Java 包）不误丢，向后兼容', () => {
    useStore.setState({ activeWorkspacePath: WS_OTHER, sessionsWorkspace: WS_OTHER, sessionsLoading: true })
    handleResponse(
      { op: 'listSessions', sessions: [sess('S_B', WS_OTHER)] } as never,
      useStore.setState, useStore.getState,
    )
    expect(useStore.getState().sessionsLoading).toBe(false)
  })
})

describe('boot 场景作用域（真机 2026-10-28：高亮本项目但列表停在关联目录）', () => {
  // init 有一次性守卫（bridgeInitialized）且已被本文件前部用例消费——这里直接构造
  // "boot 首拉完成"后的状态：sessionsWorkspace=标签初始目录、落位仍空（本项目）、
  // bootWorkspace 已消费。落位随标签目录后（2026-11-05）常规路径落位=标签目录、
  // 收尾空转（见前部新用例）——本组保留的是竞态保险：boot 期间落位被守卫回退等
  // 场景下，收尾仍须把列表对齐落位目录。init 首拉行为由前部用例覆盖
  function bootConsumedIntoOther() {
    useStore.setState({ activeWorkspacePath: '', bootWorkspace: '', sessionsWorkspace: WS_OTHER })
    sentRequests.length = 0
  }

  it('boot 恢复收尾：首拉响应处理后作用域静默切回落位目录并重拉（chips 高亮与列表一致）', () => {
    // 模拟 init 首拉已发出（bootWorkspace 已消费置空）+ bootRestorePending 在途
    useStore.setState({
      bootWorkspace: '',
      bootRestorePending: true,
      activeWorkspacePath: '', // 落位=本项目
      sessionsWorkspace: WS_OTHER,
      sessions: [sess('S_suiteng', WS_OTHER)] as never,
    })
    handleResponse(
      { op: 'listSessions', sessions: [sess('S_suiteng', WS_OTHER)], workspacePath: WS_OTHER } as never,
      useStore.setState, useStore.getState,
    )
    const s = useStore.getState()
    expect(s.bootRestorePending).toBe(false) // 标志消费
    expect(s.sessions).toEqual([]) // 切回时清空（boot 首拉列表不残留）
    expect(s.sessionsWorkspace).toBe(WS_PROJECT) // 作用域回落位目录
    expect(s.sessionsLoading).toBe(true)
    const reReq = sentRequests.find((r) => r.op === 'listSessions')
    expect(reReq?.workspacePath).toBe(WS_PROJECT) // 重拉本项目
  })

  it('boot 恢复收尾：作用域已等于落位目录时不重拉（防循环）', () => {
    useStore.setState({
      bootWorkspace: WS_PROJECT,
      bootRestorePending: true,
      activeWorkspacePath: '',
      sessionsWorkspace: WS_PROJECT,
    })
    handleResponse(
      { op: 'listSessions', sessions: [], workspacePath: WS_PROJECT } as never,
      useStore.setState, useStore.getState,
    )
    expect(useStore.getState().bootRestorePending).toBe(false)
    expect(sentRequests.filter((r) => r.op === 'listSessions')).toHaveLength(0) // 无第二拉
  })
})

describe('新会话落位', () => {
  it('createSession 请求携带激活目录', () => {
    useStore.setState({ activeWorkspacePath: WS_OTHER, creatingSession: false })
    useStore.getState().createSession()
    const req = sentRequests.find((r) => r.op === 'createSession')
    expect(req?.workspacePath).toBe(WS_OTHER)
  })

  it('createSession 应答把 currentWorkspacePath 落到激活目录', () => {
    useStore.setState({ activeWorkspacePath: WS_OTHER, creatingSession: true, pendingFirstMessage: null })
    handleResponse(
      { op: 'createSession', sessionId: 'sess_new' } as never,
      useStore.setState, useStore.getState,
    )
    expect(useStore.getState().currentSessionId).toBe('sess_new')
    expect(useStore.getState().currentWorkspacePath).toBe(WS_OTHER)
  })
})

describe('冷启动竞态补齐（真机 2026-11-05：新标签落位跳变）', () => {
  // 竞态现场：URL 加载路径（生产内置 HttpServer）的桥变量由 executeJavaScript 异步注入，
  // React init 先跑读到空串 → 同步段落位丢失、发消息 createSession 回退 projectPath 跨目录
  // 落错。CEF_QUERY 与注入变量同一脚本块——轮询到 CEF_QUERY 即注入已完成，onBridgeReady 的
  // initFromInjection 重读必得值。vitest 默认走 mock 分支不进轮询，stubEnv('VITEST','') 绕过
  // + fake timers 推进 waitForBridge 模拟冷启动
  function setBridgeQuery() {
    // node 环境（本 spec 非 jsdom）无 window——stubGlobal 供 waitForBridge 判定桥就绪
    vi.stubGlobal('window', { __ZCODE_CEF_QUERY__: () => {} })
  }
  function cleanup() {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  }

  it('空标签竞态：init 时注入未达（读空），桥就绪后重读补落位，首拉按标签目录', async () => {
    vi.useFakeTimers()
    vi.stubEnv('VITEST', '')
    workspaceInjected = '' // 竞态窗口：executeJavaScript 尚未执行
    tabWorkspaceInjected = ''
    vi.resetModules()
    const { useStore: freshStore } = await import('@/store/useStore')
    void freshStore.getState().init() // 同步段读空，落位丢失（缺陷现场）
    expect(freshStore.getState().activeWorkspacePath).toBe('')
    // 注入随后到达（executeJavaScript 补执行）
    workspaceInjected = WS_PROJECT
    tabWorkspaceInjected = WS_OTHER
    setBridgeQuery()
    await vi.advanceTimersByTimeAsync(100) // 推进 50ms 轮询 → onBridgeReady
    const s = freshStore.getState()
    expect(s.activeWorkspacePath).toBe(WS_OTHER) // 落位补齐（跳变根因修复点）
    expect(s.projectPath).toBe(WS_PROJECT) // projectPath 补齐
    const listReq = sentRequests.filter((r) => r.op === 'listSessions').pop()
    expect(listReq?.workspacePath).toBe(WS_OTHER) // 首拉即按标签目录（无二次拉取）
    expect(s.sessionsWorkspace).toBe(WS_OTHER)
    expect(s.bootRestorePending).toBe(false) // 空标签不进 boot 链
    cleanup()
  })

  it('会话标签竞态：bootWorkspace/bootRestorePending 补齐，绑定会话恢复链不丢', async () => {
    vi.useFakeTimers()
    vi.stubEnv('VITEST', '')
    workspaceInjected = ''
    tabWorkspaceInjected = ''
    vi.resetModules()
    const { useStore: freshStore } = await import('@/store/useStore')
    void freshStore.getState().init()
    workspaceInjected = WS_PROJECT
    tabWorkspaceInjected = WS_OTHER
    tabInitialSessionId = 'sess_bound' // 会话标签（重启恢复/gotoSession「新标签页打开」）
    setBridgeQuery()
    await vi.advanceTimersByTimeAsync(100)
    const s = freshStore.getState()
    expect(s.bootRestorePending).toBe(true) // initFromInjection 会话标签分支已执行
    const listReq = sentRequests.filter((r) => r.op === 'listSessions').pop()
    // 首拉按 bootWorkspace（恢复作用域）——bootWorkspace 本身已被 loadSessions 一次性
    // 消费清空（设计内），两个断言合起来证明 boot 补齐链路完整：置位 → 按它首拉 → 消费
    expect(listReq?.workspacePath).toBe(WS_OTHER)
    cleanup()
  })
})
