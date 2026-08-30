/**
 * 切模型后发送时序 + 切换后首回合零输出提示 回归测试（2026-08-30 定时 flush 挂死事故）
 *
 * 实测（另一台测试机 idea.log 全量分析）：定时消息在回合中入队，回合结束 flush 时
 * setModel+send 背靠背发出（相距毫秒级、紧贴上一回合 turn.completed），把该会话新模型
 * （GLM-5.3-Flash）的运行时状态在服务端写坏并随会话记录落盘——此后该会话所有 flash
 * 回合 turn.started 后零输出零完成零报错（无声挂死），同会话切回 5.3 正常、新会话
 * flash 正常、重启 IDEA 不愈。session.updated 心跳不断重置静默看门狗计时 + usage
 * 确认回合活跃，既有看门狗对本故障结构性失明。
 *
 * 断言：
 *   1. 切换在途时 sendMessage 推迟 send op：setModel 先行，modelSet ack 落定
 *      （+500ms 缓冲）后 send 才发出，且带目标模型与定时上报
 *   2. 无切换在途：send 立即发出（行为不变）
 *   3. 等待上限 6s：ack 迟迟不回也放行发送（不阻塞）
 *   4. 切换落定 20s 内开始的回合，60s 零模型输出 → lastNotice 挂死提示
 *   5. 已有模型输出 / 非切换窗口内的回合 → 不提示
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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

// ---- mock 桥接层：捕获 sendToJava / onMessage / onStreamBatch ----
let messageHandler: ((msg: unknown) => void) | null = null
let batchHandler: ((sid: string, events: unknown[]) => void) | null = null
const sentRequests: Array<Record<string, unknown>> = []

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: unknown) => void) => { messageHandler = fn },
  onStreamEvent: () => {},
  onStreamBatch: (fn: (sid: string, events: unknown[]) => void) => { batchHandler = fn },
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import { useStore } from '@/store/useStore'
import type { ModelOption } from '@/types/messages'

const SID = 'sess_race_1'
const GLM = { modelId: 'GLM-5.3', providerId: 'builtin:bigmodel-coding-plan' }
const FLASH = { modelId: 'GLM-5.3-Flash', providerId: 'builtin:bigmodel-coding-plan' }
const MODELS = [GLM, FLASH].map((m) =>
  ({ providerId: m.providerId, providerName: 'BigModel', modelId: m.modelId, modelName: m.modelId }) as ModelOption,
)

function pushResponse(msg: Record<string, unknown>): void {
  messageHandler!(msg)
}

function turnStartedEvent() {
  return { type: 'turn.started', seq: 1, sessionId: SID, turnId: 't1', timestamp: Date.now(), payload: {} }
}
function textDeltaEvent() {
  return { type: 'model.streaming', seq: 2, sessionId: SID, turnId: 't1', timestamp: Date.now(), payload: { kind: 'text_delta', delta: 'hello' } }
}

beforeEach(() => {
  vi.useFakeTimers()
  storage.clear()
  sentRequests.length = 0
  useStore.getState().init() // 注册桥接回调（onMessage / onStreamBatch）
  useStore.setState({
    currentSessionId: SID,
    currentWorkspacePath: 'G:\\mock',
    models: [...MODELS],
    currentModel: { ...GLM },
    modelSwitchInFlightAt: null,
    lastNotice: null,
    lastError: null,
    queuedMessages: [],
    messages: [],
    streaming: false,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('切模型后发送时序（setModel+send 背靠背撞清算窗口）', () => {
  it('切换在途：send 推迟到 modelSet ack + 缓冲后才发出', async () => {
    // 模拟 flush 场景：setModel 刚发出、ack 未回（sendMessage 内部走 setModel 亦同）
    useStore.getState().setModel(FLASH.modelId, FLASH.providerId)
    sentRequests.length = 0

    useStore.getState().sendMessage('你好', undefined, {
      scheduledFireAt: 1788099844474,
      scheduledProviderId: FLASH.providerId,
      scheduledModelId: FLASH.modelId,
    })

    // 乐观 UI 已就位、streaming 已置位，但 send 未发
    expect(useStore.getState().streaming).toBe(true)
    expect(useStore.getState().messages.some((m) => m.info.role === 'user')).toBe(true)
    expect(sentRequests.filter((r) => r.op === 'send')).toHaveLength(0)

    // ack 落定 → 轮询间隔(100ms) + 缓冲(500ms) 后 send 放行
    pushResponse({ op: 'modelSet', sessionId: SID, ...FLASH })
    await vi.advanceTimersByTimeAsync(700)

    const send = sentRequests.find((r) => r.op === 'send')
    expect(send).toBeDefined()
    expect(send).toMatchObject({ sessionId: SID, text: '你好', modelId: FLASH.modelId, providerId: FLASH.providerId })
    // 定时上报与 send 配对发出
    expect(sentRequests.find((r) => r.op === 'scheduledFired')).toMatchObject({ sessionId: SID, fireAt: 1788099844474 })
  })

  it('无切换在途：send 立即发出（行为不变）', () => {
    useStore.getState().sendMessage('普通消息')
    const send = sentRequests.find((r) => r.op === 'send')
    expect(send).toBeDefined()
    expect(send).toMatchObject({ text: '普通消息', modelId: GLM.modelId })
  })

  it('ack 迟迟不回：等待上限 6s 后放行发送（不阻塞）', async () => {
    useStore.getState().setModel(FLASH.modelId, FLASH.providerId)
    sentRequests.length = 0
    useStore.getState().sendMessage('超时兜底')
    expect(sentRequests.filter((r) => r.op === 'send')).toHaveLength(0)

    // 5s 在途过期 + 6s 等待上限内不再推进……直接推到上限之后
    await vi.advanceTimersByTimeAsync(6100)
    expect(sentRequests.find((r) => r.op === 'send')).toMatchObject({ text: '超时兜底' })
  })
})

describe('切换模型后首回合零输出提示', () => {
  it('modelSet 落定后 20s 内开始的回合，60s 零输出 → 提示', async () => {
    pushResponse({ op: 'modelSet', sessionId: SID, ...FLASH })
    batchHandler!(SID, [turnStartedEvent()])
    expect(useStore.getState().streaming).toBe(true)

    await vi.advanceTimersByTimeAsync(60_100)
    expect(useStore.getState().lastNotice).toBeTruthy()
    expect(useStore.getState().lastNotice).toContain('模型')
  })

  it('回合已有模型输出：不提示', async () => {
    pushResponse({ op: 'modelSet', sessionId: SID, ...FLASH })
    batchHandler!(SID, [turnStartedEvent(), textDeltaEvent()])
    await vi.advanceTimersByTimeAsync(60_100)
    expect(useStore.getState().lastNotice).toBeNull()
  })

  it('非切换窗口内的回合（落定超 20s 才开始）：不提示', async () => {
    pushResponse({ op: 'modelSet', sessionId: SID, ...FLASH })
    await vi.advanceTimersByTimeAsync(30_000) // 窗口（20s）已过
    batchHandler!(SID, [turnStartedEvent()])
    await vi.advanceTimersByTimeAsync(60_100)
    expect(useStore.getState().lastNotice).toBeNull()
  })

  it('回合正常结束：提示定时器撤销，之后再推进时间不弹提示', async () => {
    pushResponse({ op: 'modelSet', sessionId: SID, ...FLASH })
    batchHandler!(SID, [turnStartedEvent()])
    // 30s 后回合结束（带正文 assistant 回复 → turnEnded）
    await vi.advanceTimersByTimeAsync(30_000)
    batchHandler!(SID, [{
      type: 'turn.completed', seq: 3, sessionId: SID, turnId: 't1', timestamp: Date.now(), payload: {},
    }])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(useStore.getState().lastNotice).toBeNull()
  })

  it('切换会话：旧会话的提示定时器一并撤销', async () => {
    pushResponse({ op: 'modelSet', sessionId: SID, ...FLASH })
    batchHandler!(SID, [turnStartedEvent()])
    useStore.setState({ currentSessionId: 'sess_other' })
    useStore.getState().selectSession({ sessionId: 'sess_other', title: 'x' } as never)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(useStore.getState().lastNotice).toBeNull()
  })
})
