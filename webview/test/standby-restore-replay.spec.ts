/**
 * 待命态被 listSessions 重放 boot 恢复的回归测试
 *
 * 缺陷（2026-10-13 真机反馈）：标签注入的 __ZCODE_INITIAL_SESSION__ 运行期不更新，
 * 而 case 'listSessions' 的「恢复标签绑定会话」分支没有门控——待命态
 * （currentSessionId=null）下每次列表响应都会尝试选回注入会话。旧会话回合结束的
 * sessionTurnPhase 全局广播（300ms 防抖 loadSessions，无 currentSessionId 守卫）等
 * 后台刷新于是把用户主动新建后的待命态无声切回旧会话，输入框草稿随 scope 切换消失。
 * 修复 = store 字段 skipInitialSessionRestore：boot 初值 false，用户主动进入待命态
 * （resetToNewSession / 删除当前会话）置 true。
 *
 * 断言：
 *   1. boot 正常恢复：listSessions 含注入会话 → 选中并 subscribe
 *   2. boot 首帧快照缺注入会话 → 不提前撤防，后续帧仍可恢复（慢快照容错保留）
 *   3. 主动新建（resetToNewSession）后：再推含旧绑定会话的列表也不选回、不 subscribe
 *   4. 首次列表返回前就主动新建：在途慢响应到达后同样不选回
 *   5. 删除当前会话后：滞后快照仍带该会话也不选回
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// resetModules + 动态 import 让每个用例都拿到全新的 store 初值
// （skipInitialSessionRestore=false、currentSessionId=null）
const bridge = vi.hoisted(() => ({
  handler: null as ((msg: unknown) => void) | null,
  sent: [] as Array<Record<string, unknown>>,
  initialId: 'sess_A',
}))

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getTabWorkspacePath: () => '',
  getInitialSessionId: () => bridge.initialId,
  onMessage: (fn: (msg: unknown) => void) => { bridge.handler = fn },
  onStreamEvent: () => {},
  onStreamBatch: () => {},
  sendToJava: (req: Record<string, unknown>) => { bridge.sent.push(req) },
}))

let useStore: typeof import('@/store/useStore').useStore

function push(msg: Record<string, unknown>): void {
  bridge.handler!(msg)
}

function sentOps(): string[] {
  return bridge.sent.map((r) => r.op as string)
}

function sessionRow(id: string): Record<string, unknown> {
  return { sessionId: id, title: id, status: 'idle', mode: 'yolo', workspacePath: 'G:\\mock', createdAt: 1, updatedAt: 1 }
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  bridge.handler = null
  bridge.sent.length = 0
  bridge.initialId = 'sess_A'
  ;({ useStore } = await import('@/store/useStore'))
  useStore.getState().init() // 注册 onMessage；init 自身发出的 listSessions 不进桥（无响应）
  bridge.sent.length = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('boot 会话恢复门控', () => {
  it('listSessions 含注入会话：自动恢复选中并订阅', () => {
    push({ op: 'listSessions', sessions: [sessionRow('sess_A')] })

    expect(useStore.getState().currentSessionId).toBe('sess_A')
    expect(sentOps()).toContain('subscribe')
  })

  it('首帧快照缺注入会话：后续帧仍可恢复（慢快照不提前撤防）', () => {
    push({ op: 'listSessions', sessions: [sessionRow('sess_other')] })
    expect(useStore.getState().currentSessionId).toBeNull()

    push({ op: 'listSessions', sessions: [sessionRow('sess_other'), sessionRow('sess_A')] })
    expect(useStore.getState().currentSessionId).toBe('sess_A')
  })

  it('主动新建会话后：后续列表仍含旧绑定会话也不选回', () => {
    push({ op: 'listSessions', sessions: [sessionRow('sess_A')] })
    expect(useStore.getState().currentSessionId).toBe('sess_A')
    bridge.sent.length = 0

    useStore.getState().resetToNewSession()
    expect(useStore.getState().currentSessionId).toBeNull()

    // 旧会话回合结束等后台事件触发的列表刷新，快照仍含旧会话
    push({ op: 'listSessions', sessions: [sessionRow('sess_A')] })
    expect(useStore.getState().currentSessionId).toBeNull()
    expect(sentOps()).not.toContain('subscribe')
  })

  it('首次列表返回前主动新建：在途慢响应到达后不选回', () => {
    useStore.getState().resetToNewSession()

    push({ op: 'listSessions', sessions: [sessionRow('sess_A')] })
    expect(useStore.getState().currentSessionId).toBeNull()
    expect(sentOps()).not.toContain('subscribe')
  })

  it('删除当前会话后：滞后快照仍带该会话也不选回', () => {
    push({ op: 'listSessions', sessions: [sessionRow('sess_A')] })
    bridge.sent.length = 0

    push({ op: 'sessionDeleted', sessionId: 'sess_A' })
    expect(useStore.getState().currentSessionId).toBeNull()

    // 删除是乐观的，服务端快照可能滞后仍带该会话
    push({ op: 'listSessions', sessions: [sessionRow('sess_A')] })
    expect(useStore.getState().currentSessionId).toBeNull()
    expect(sentOps()).not.toContain('subscribe')
  })
})
