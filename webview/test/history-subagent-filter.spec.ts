/**
 * 历史列表子代理会话过滤回归测试：
 * app-server session/list 的内存活跃会话补列不排除 subagent_child（CLI 侧缺陷），
 * 子代理回合结束后驻留内存期间会被持续补列进响应（IDEA 重启才消失）。
 * 覆盖两条防线：服务端快照直传过滤 + staleLocal 补插路径过滤（防复活）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let messageHandler: ((msg: unknown) => void) | null = null

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: unknown) => void) => { messageHandler = fn },
  onStreamEvent: () => {},
  onStreamBatch: () => {},
  sendToJava: () => {},
}))

import { useStore } from '@/store/useStore'

const SUB_SID = 'sess_subagent_agent_78d4b027-7ad8-4e52-bc6f-f9cc81559dab'
const NORMAL_SID = 'sess_normal_1'
const LOCAL_SID = 'sess_local_only'

function makeSession(sessionId: string, title: string) {
  return {
    sessionId,
    title,
    status: 'idle',
    mode: 'build',
    workspacePath: 'G:\\mock',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  }
}

function pushListSessions(sessions: unknown[]): void {
  messageHandler!({ op: 'listSessions', sessions })
}

beforeEach(() => {
  useStore.getState().init()
  useStore.setState({
    connectionStatus: 'mock',
    currentSessionId: null,
    currentWorkspacePath: 'G:\\mock',
    sessions: [],
    provisionalTitles: {},
  })
})

describe('历史列表子代理会话过滤', () => {
  it('服务端快照里的 sess_subagent_* 不进历史列表', () => {
    pushListSessions([makeSession(NORMAL_SID, '正常会话'), makeSession(SUB_SID, '子代理')])
    const ids = useStore.getState().sessions.map((s) => s.sessionId)
    expect(ids).toContain(NORMAL_SID)
    expect(ids).not.toContain(SUB_SID)
  })

  it('已混入本地列表的子代理会话不会经 staleLocal 补插复活', () => {
    // 模拟被污染的本地列表：内存里残留子代理会话（补列响应曾把它带进来）
    useStore.setState({
      sessions: [makeSession(SUB_SID, '子代理'), makeSession(LOCAL_SID, '本地乐观新建')],
    })
    // 后续刷新的服务端快照只含正常会话：本地乐观新建应保留（staleLocal 机制），
    // 子代理条目不得借同一机制复活
    pushListSessions([makeSession(NORMAL_SID, '正常会话')])
    const ids = useStore.getState().sessions.map((s) => s.sessionId)
    expect(ids).toContain(LOCAL_SID)
    expect(ids).not.toContain(SUB_SID)
  })
})
