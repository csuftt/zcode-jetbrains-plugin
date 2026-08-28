/**
 * 回合中延迟切模型（缺陷AC + -32603 变体，2026-08-28）前端状态机回归测试
 *
 * 实测根因：回合流式期间 session/setModel ①立即生效会 dispose 旧签名器，在途回合
 * 下一轮请求即死；②该窗口内服务端不消费 runtimeModel 注册，切到未注册模型直接
 * -32603 Unsupported model。Java 侧改为挂起等回合结束补发（modelSetPending 应答），
 * 前端配合回滚选中态并提示。
 *
 * 断言：
 *   1. setModel 发出时暂存翻转前模型（modelSwitchPrevModel）
 *   2. modelSetPending：选中态回滚到切换前模型（显示=服务端实际在用），挂起目标 +
 *      信息条就位，切换在途标记清除（期间 settings 计算于旧模型＝显示模型，可信）
 *   3. 补发落定 modelSet：选中态翻转到目标模型，挂起/提示全部清除
 *   4. 补发失败 modelSetFailed：挂起/提示清除，走 lastError 展示
 *   5. 补发晚到且用户已切走会话：modelSet 丢弃（不污染当前会话显示与级别缓存）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- mock localStorage（node 环境无实现）----
const storage = new Map<string, string>()
const lsMock = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => { storage.set(k, v) },
  removeItem: (k: string) => { storage.delete(k) },
  key: (i: number) => Array.from(storage.keys())[i] ?? null,
  get length() { return storage.size },
  clear: () => { storage.clear() },
}
vi.stubGlobal('localStorage', lsMock)
vi.stubGlobal('window', { localStorage: lsMock, dispatchEvent: () => {}, __ZCODE_KVSTORE__: null })

// ---- mock 桥接层：捕获 sendToJava，手动注入事件/响应 ----
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

const SID = 'sess_defer_1'
const GLM = { modelId: 'GLM-5.3', providerId: 'builtin:bigmodel-coding-plan' }
const FLASH = { modelId: 'GLM-5.3-Flash', providerId: 'builtin:bigmodel-coding-plan' }

function pushResponse(msg: Record<string, unknown>): void {
  messageHandler!(msg)
}

beforeEach(() => {
  storage.clear()
  sentRequests.length = 0
  useStore.getState().init() // 注册桥接回调（onMessage）
  useStore.setState({
    currentSessionId: SID,
    currentModel: { ...GLM },
    modelInvalidated: false,
    modelSwitchInFlightAt: null,
    modelPendingSwitch: null,
    modelSwitchPrevModel: null,
    lastNotice: null,
    lastError: null,
  })
})

describe('回合中延迟切模型（缺陷AC）', () => {
  it('setModel 发出时暂存翻转前模型', () => {
    useStore.getState().setModel(FLASH.modelId, FLASH.providerId)
    // 乐观翻转已发生 + 暂存旧模型
    expect(useStore.getState().currentModel).toEqual(FLASH)
    expect(useStore.getState().modelSwitchPrevModel).toEqual(GLM)
    // 下发了 setModel
    const req = sentRequests.find((r) => r.op === 'setModel')
    expect(req).toMatchObject({ sessionId: SID, ...FLASH })
  })

  it('modelSetPending：选中态回滚 + 挂起目标与提示就位 + 在途标记清除', () => {
    useStore.getState().setModel(FLASH.modelId, FLASH.providerId)
    expect(useStore.getState().modelSwitchInFlightAt).not.toBeNull()
    pushResponse({ op: 'modelSetPending', sessionId: SID, ...FLASH })
    const s = useStore.getState()
    // 显示回滚到服务端实际在用的模型
    expect(s.currentModel).toEqual(GLM)
    expect(s.modelPendingSwitch).toEqual({ sessionId: SID, ...FLASH })
    expect(s.modelSwitchPrevModel).toEqual(GLM)
    expect(s.lastNotice).toBeTruthy()
    // 在途标记清除：期间 settings 计算于旧模型＝显示模型，级别可信
    expect(s.modelSwitchInFlightAt).toBeNull()
  })

  it('补发落定 modelSet：选中态翻转到目标，挂起与提示清除', () => {
    useStore.getState().setModel(FLASH.modelId, FLASH.providerId)
    pushResponse({ op: 'modelSetPending', sessionId: SID, ...FLASH })
    pushResponse({ op: 'modelSet', sessionId: SID, ...FLASH })
    const s = useStore.getState()
    expect(s.currentModel).toEqual(FLASH)
    expect(s.modelPendingSwitch).toBeNull()
    expect(s.modelSwitchPrevModel).toBeNull()
    expect(s.lastNotice).toBeNull()
  })

  it('补发失败 modelSetFailed：挂起与提示清除，走 lastError 展示', () => {
    useStore.getState().setModel(FLASH.modelId, FLASH.providerId)
    pushResponse({ op: 'modelSetPending', sessionId: SID, ...FLASH })
    pushResponse({
      op: 'modelSetFailed', sessionId: SID, ...FLASH,
      message: 'Model switch failed: [-32603] Unsupported model',
    })
    const s = useStore.getState()
    expect(s.modelPendingSwitch).toBeNull()
    expect(s.modelSwitchPrevModel).toBeNull()
    expect(s.lastNotice).toBeNull()
    expect(s.lastError).toContain('Unsupported model')
    // 显示保持旧模型（未落定不翻转）
    expect(s.currentModel).toEqual(GLM)
  })

  it('补发晚到且已切走会话：modelSet 丢弃，不污染当前会话', () => {
    useStore.getState().setModel(FLASH.modelId, FLASH.providerId)
    pushResponse({ op: 'modelSetPending', sessionId: SID, ...FLASH })
    // 用户切到别的会话（挂起提示随切会话清除）
    useStore.setState({ currentSessionId: 'sess_other', currentModel: { modelId: 'qwen3.7-plus', providerId: 'p2' } })
    pushResponse({ op: 'modelSet', sessionId: SID, ...FLASH })
    const s = useStore.getState()
    expect(s.currentModel).toEqual({ modelId: 'qwen3.7-plus', providerId: 'p2' })
  })
})
