/**
 * 自动归档关联的 store 回归（2026-09-08 实踩三连）：
 *   1. 归档会话不得经 staleLocal 复活——扫描归档后服务端快照不含它们，本地上一帧的
 *      旧条目若无限保留，会话列表数字不减（实测 45 条显示成 202）
 *   2. currentSessionId 缺失于快照仍保留（乐观/时序防御只收窄到"当前会话+5 分钟窗口"）
 *   3. autoArchiveRan skipped=disabled（未启用终门禁言）→ 不刷列表、提示未执行
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let messageHandler: ((msg: unknown) => void) | null = null
const sentRequests: Array<Record<string, unknown>> = []

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: unknown) => void) => { messageHandler = fn },
  onStreamEvent: () => {},
  onStreamBatch: () => {},
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import { useStore } from '@/store/useStore'

function pushResponse(msg: Record<string, unknown>): void {
  messageHandler!(msg)
}

function session(id: string, updatedAt: number): Record<string, unknown> {
  return {
    sessionId: id, title: id, status: 'idle', mode: 'yolo',
    workspacePath: 'G:\\mock', createdAt: updatedAt, updatedAt,
  }
}

beforeEach(() => {
  vi.useRealTimers()
  sentRequests.length = 0
  useStore.getState().init()
  sentRequests.length = 0
  useStore.setState({
    connectionStatus: 'mock',
    currentSessionId: null,
    sessions: [],
    provisionalTitles: {},
    autoArchiveConfigLoaded: true,
    autoArchiveEnabled: true,
    autoArchiveRunning: false,
    autoArchiveLastRunCount: null,
    autoArchiveLastRunSkipped: false,
    autoArchiveLastSweepAt: null,
  })
})

describe('listSessions staleLocal 收窄', () => {
  it('归档后快照缺失的旧会话不复活；快照命中项正常刷新', () => {
    const now = Date.now()
    // 上一帧：1 条活跃 + 2 条随后被归档的旧会话
    useStore.setState({
      sessions: [
        session('sess_keep', now) as never,
        session('sess_arch1', now - 30 * 60_000) as never,
        session('sess_arch2', now - 2 * 3600_000) as never,
      ],
    })
    // 归档扫描后刷新：服务端权威快照只含未归档的
    pushResponse({ op: 'listSessions', sessions: [session('sess_keep', now)] })
    expect(useStore.getState().sessions.map((s) => s.sessionId)).toEqual(['sess_keep'])
  })

  it('当前打开的会话即使缺失于快照也保留（时序防御不回归）', () => {
    useStore.setState({
      currentSessionId: 'sess_cur',
      sessions: [session('sess_cur', Date.now() - 3600_000) as never],
    })
    pushResponse({ op: 'listSessions', sessions: [session('sess_other', Date.now())] })
    expect(useStore.getState().sessions.map((s) => s.sessionId)).toContain('sess_cur')
  })

  it('5 分钟窗口内的乐观新建仍保留（provisional 时序防御不回归）', () => {
    useStore.setState({ sessions: [session('sess_new', Date.now() - 10_000) as never] })
    pushResponse({ op: 'listSessions', sessions: [session('sess_old', Date.now() - 3600_000)] })
    expect(useStore.getState().sessions.map((s) => s.sessionId)).toContain('sess_new')
  })
})

describe('autoArchiveRan skipped', () => {
  it('skipped=disabled：不动 lastRunCount/lastSweepAt、置 skipped、不刷新会话列表', () => {
    useStore.setState({ autoArchiveLastSweepAt: 11111 })
    const before = sentRequests.filter((r) => r.op === 'listSessions').length
    pushResponse({ op: 'autoArchiveRan', count: 0, skipped: 'disabled', lastSweepAt: 11111, records: [] })
    expect(useStore.getState().autoArchiveLastRunSkipped).toBe(true)
    expect(useStore.getState().autoArchiveLastRunCount).toBeNull()
    expect(useStore.getState().autoArchiveLastSweepAt).toBe(11111)
    expect(sentRequests.filter((r) => r.op === 'listSessions').length).toBe(before)
  })

  it('正常轮：落 count/lastSweepAt、清 skipped、触发列表刷新', () => {
    pushResponse({ op: 'autoArchiveRan', count: 3, lastSweepAt: 22222, records: [] })
    expect(useStore.getState().autoArchiveLastRunCount).toBe(3)
    expect(useStore.getState().autoArchiveLastRunSkipped).toBe(false)
    expect(useStore.getState().autoArchiveLastSweepAt).toBe(22222)
    expect(sentRequests.some((r) => r.op === 'listSessions')).toBe(true)
  })

  it('autoArchiveConfig：落 lastSweepAt（0=从未 → null）', () => {
    pushResponse({ op: 'autoArchiveConfig', enabled: false, olderThanDays: 7, lastSweepAt: 33333 })
    expect(useStore.getState().autoArchiveLastSweepAt).toBe(33333)
    pushResponse({ op: 'autoArchiveConfig', enabled: false, olderThanDays: 7, lastSweepAt: 0 })
    expect(useStore.getState().autoArchiveLastSweepAt).toBeNull()
  })

  it('未启用时 runAutoArchiveNow 不发起 op', () => {
    useStore.setState({ autoArchiveEnabled: false })
    useStore.getState().runAutoArchiveNow()
    expect(sentRequests.some((r) => r.op === 'runAutoArchiveNow')).toBe(false)
    expect(useStore.getState().autoArchiveRunning).toBe(false)
  })
})
