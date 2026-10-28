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
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const sentRequests: Array<Record<string, unknown>> = []

/** 模拟 Java 注入的标签初始目录（跨目录会话新标签打开/重启恢复路径）*/
let tabWorkspaceInjected = ''

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:/mock-project',
  getTabWorkspacePath: () => tabWorkspaceInjected,
  getInitialSessionId: () => '',
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
  tabWorkspaceInjected = ''
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

  it('init 只落标签初始目录到 bootWorkspace（首拉用它恢复绑定会话），activeWorkspacePath 不被污染（落位恒本项目）', () => {
    tabWorkspaceInjected = WS_OTHER
    useStore.setState({ activeWorkspacePath: '' })
    void useStore.getState().init()
    // 首拉按注入目录（绑定会话在列表里可恢复）；init 同步链内即消费（bootWorkspace 清空）
    const req = sentRequests.find((r) => r.op === 'listSessions')
    expect(req?.workspacePath).toBe(WS_OTHER)
    expect(useStore.getState().activeWorkspacePath).toBe('') // 落位仍是本项目
    expect(useStore.getState().bootWorkspace).toBe('') // 一次性已消费
  })

  it('bootWorkspace 一次性：消费后再次 loadSessions 回落激活目录（本项目）', () => {
    tabWorkspaceInjected = WS_OTHER
    useStore.setState({ activeWorkspacePath: '' })
    void useStore.getState().init()
    sentRequests.length = 0
    useStore.getState().loadSessions()
    const req = sentRequests.find((r) => r.op === 'listSessions')
    expect(req?.workspacePath).toBe(WS_PROJECT)
    expect(useStore.getState().bootWorkspace).toBe('')
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
  // bootWorkspace 已消费。init 首拉行为由前部"init 落标签初始目录"用例覆盖
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
