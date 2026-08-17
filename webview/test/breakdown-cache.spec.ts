/**
 * 上下文构成持久化回归测试（历史会话恢复兜底）
 *
 * 背景：构成明细（runtime.breakdown）只挂在 CLI 内存 eventStore 的
 * ModelComplete 事件上，不随消息落盘——会话 resume 到新进程后
 * session/read 不再返回，悬浮栏「上下文构成」丢失。
 *
 * 修复：case 'usage' 收到 breakdown 时按会话写 localStorage；
 * 服务端无 breakdown 且当前无数据时，used 与缓存一致才兜底恢复。
 *
 * 断言：
 *   1. usage 带 breakdown → localStorage 落缓存（含 used）
 *   2. 恢复场景（contextBreakdown=null）收到无 breakdown 的 usage：
 *      used 一致 → 缓存兜底；used 不一致（别处对话/compact过）→ 不兜底
 *   3. 会话内已有数据时不被无 breakdown 的响应覆盖
 *   4. LRU：超过 30 个会话缓存时最旧的被淘汰
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- mock localStorage（node 环境无实现）----
const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => { storage.set(k, v) },
  removeItem: (k: string) => { storage.delete(k) },
  key: (i: number) => Array.from(storage.keys())[i] ?? null,
  get length() { return storage.size },
  clear: () => storage.clear(),
})

// ---- mock 桥接层：捕获 sendToJava，手动注入响应 ----
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
import type { ContextBreakdownItem } from '@/types/messages'

const SID = 'sess_bd_1'
const PREFIX = 'zcode.ctxBreakdown.'

const BD: ContextBreakdownItem[] = [
  { source: 'messages', chars: 5000 },
  { source: 'system_tool_schemas', chars: 3000 },
  { source: 'skills', chars: 2000 },
]

/** 注入一条 usage 响应（模拟 Kotlin getUsage 回包）*/
function pushUsage(used: number, breakdown?: ContextBreakdownItem[], sessionId = SID): void {
  messageHandler!({
    op: 'usage', sessionId, used, size: 200000, hitRate: 0.5,
    ...(breakdown ? { breakdown } : {}),
  })
}

/** 重置为「刚打开历史会话」状态：有 currentSessionId、无构成数据 */
function resetToRestoredSession(sid = SID): void {
  useStore.setState({
    currentSessionId: sid,
    contextUsage: null,
    contextBreakdown: null,
    streaming: false,
  })
}

beforeEach(() => {
  storage.clear()
  sentRequests.length = 0
  useStore.getState().init() // 注册桥接回调（onMessage）
})

describe('上下文构成持久化', () => {
  it('usage 带 breakdown 时写入 localStorage（含 used）', () => {
    resetToRestoredSession()
    pushUsage(10000, BD)

    const raw = storage.get(PREFIX + SID)
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!) as { breakdown: ContextBreakdownItem[]; used: number }
    expect(parsed.breakdown).toEqual(BD)
    expect(parsed.used).toBe(10000)
    expect(useStore.getState().contextBreakdown).toEqual(BD)
  })

  it('历史会话恢复：服务端无 breakdown、used 与缓存一致 → 兜底显示', () => {
    resetToRestoredSession()
    pushUsage(10000, BD) // 对话过一轮，缓存落盘

    // 模拟 IDE 重启后重新打开该会话：store 重置，服务端不再返回 breakdown
    resetToRestoredSession()
    pushUsage(10000) // used 不变（消息未变）

    expect(useStore.getState().contextBreakdown).toEqual(BD)
  })

  it('used 不一致（别处对话/compact 过）→ 缓存过期不采用', () => {
    resetToRestoredSession()
    pushUsage(10000, BD)

    resetToRestoredSession()
    pushUsage(4000) // compact 后 used 骤降

    expect(useStore.getState().contextBreakdown).toBeNull()
  })

  it('会话内已有构成数据时，无 breakdown 的响应不覆盖也不清空', () => {
    resetToRestoredSession()
    pushUsage(10000, BD)

    // 同会话再次轮询无 breakdown（理论上少见，防御语义）：保持现有数据
    pushUsage(10000)
    expect(useStore.getState().contextBreakdown).toEqual(BD)
  })

  it('无缓存的历史会话：无 breakdown 时维持无数据（不报错）', () => {
    resetToRestoredSession('sess_never_seen')
    pushUsage(8000, undefined, 'sess_never_seen')
    expect(useStore.getState().contextBreakdown).toBeNull()
  })

  it('LRU：超过 30 个会话缓存时淘汰最旧条目', () => {
    // 预填 30 个旧会话缓存（savedAt 递增）
    for (let i = 0; i < 30; i++) {
      storage.set(`${PREFIX}sess_old_${i}`, JSON.stringify({ breakdown: BD, used: 1, savedAt: 1000 + i }))
    }
    resetToRestoredSession()
    pushUsage(10000, BD) // 第 31 个 → 淘汰 savedAt 最小的 sess_old_0

    expect(storage.has(PREFIX + 'sess_old_0')).toBe(false)
    expect(storage.has(PREFIX + 'sess_old_1')).toBe(true)
    expect(storage.has(PREFIX + SID)).toBe(true)
    // 总量收敛到 30
    let count = 0
    for (const k of storage.keys()) if (k.startsWith(PREFIX)) count++
    expect(count).toBe(30)
  })

  it('切会话竞态：迟到响应不污染新会话（兜底也不生效）', () => {
    resetToRestoredSession(SID)
    pushUsage(10000, BD)

    // 切到新会话后，旧会话的迟到 usage 到达
    resetToRestoredSession('sess_bd_2')
    messageHandler!({ op: 'usage', sessionId: SID, used: 10000, size: 200000, hitRate: 0.5 })

    expect(useStore.getState().contextBreakdown).toBeNull()
    expect(useStore.getState().currentSessionId).toBe('sess_bd_2')
  })
})
