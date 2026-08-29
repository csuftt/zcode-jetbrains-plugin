/**
 * 思考级别 × 模型切换竞态回归测试（-32603 Unsupported reasoning effort）
 *
 * 实测根因（idea.log 2026-08-26 17:17/17:54 两种形态）：级别集因模型而异
 * （GLM=off/high/max、qwen3.8-max=enabled/disabled），服务端按「当前模型」校验
 * setThoughtLevel。懒创建首条消息时 createSession 响应会并发发出 setModel +
 * setThoughtLevel / 或采信计算于旧模型的 settings 响应，导致级别被旧模型
 * （或已切换的新模型）拒绝：
 *   竞态1：createSession 级别补发与 setModel 并发 → 旧模型校验拒绝（enabled 被拒）
 *   竞态2：切换在途到达的 settings 响应（计算于旧模型）被采信 → 发出非法级别（max 被拒）
 *          且 writeThoughtLevelCache 会把旧级别集污染进新模型缓存
 *
 * 修复：setModel 发出 → modelSet 回包期间视为「切换在途」——
 *   a. createSession 级别补发暂存（不直发、不占 applied 门控），切换落定后由权威
 *      settings 响应校验下发；合法才发、非法静默跳过（防缓存污染放行非法值）
 *   b. 在途 settings 响应只同步 mode（与模型无关），级别部分丢弃，缓存不写
 *
 * 断言：
 *   1. 竞态1：createSession 响应只发 setModel 不发级别；切换落定后权威 settings
 *      校准：合法级别（enabled）补发、非法（如切回 GLM 的 enabled）静默跳过
 *   2. 竞态2：在途 settings 的级别集不入 store、不发级别、不写模型缓存；
 *      modelSet + 500ms 重拉 settings 后按新模型级别集校准（非法 saved 不下发）
 *   3. 无切换在途：settings 正常生效，saved 级别照常下发（回归守卫）
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
  clear: () => storage.clear(),
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

const NEW_SID = 'sess_race_1'
const QWEN = { modelId: 'qwen3.8-max', providerId: '3556624f' }
/** qwen3.8-max 服务端真实级别集（state.updated reason=model_changed 抓包）*/
const QWEN_LEVELS = { enabled: true, available: [{ label: 'enabled', value: 'enabled' }, { label: 'disabled', value: 'disabled' }], current: 'enabled', defaultLevel: 'enabled' }
/** 会话默认模型（GLM 系）的级别集：不含 enabled——竞态1 的拒绝方*/
const GLM_LEVELS = { enabled: true, available: [{ label: 'off', value: 'off' }, { label: 'high', value: 'high' }, { label: 'max', value: 'max' }], current: 'high', defaultLevel: 'high' }

function pushResponse(msg: Record<string, unknown>): void {
  messageHandler!(msg)
}

function sentOps(): string[] {
  return sentRequests.map((r) => r.op as string)
}

function lastOp(op: string): Record<string, unknown> | undefined {
  return [...sentRequests].reverse().find((r) => r.op === op)
}

/** 预置待命态：记住模型 qwen + 级别 savedLevel；models 就绪 */
function resetStandby(opts: { savedLevel: string; withQwenCache: boolean }): void {
  useStore.setState({
    connectionStatus: 'mock',
    currentSessionId: null,
    currentWorkspacePath: 'G:\\mock',
    creatingSession: false,
    pendingFirstMessage: null,
    messages: [],
    loadingMessages: false,
    streaming: false,
    streamingMessageId: null,
    waitingSince: null,
    queuedMessages: [],
    sessions: [],
    provisionalTitles: {},
    lastError: null,
    thoughtLevel: null,
    currentMode: null,
    thoughtLevelAppliedForSession: null,
    modelAppliedForSession: null,
    modelSwitchInFlightAt: null,
    pendingThoughtLevel: null,
    models: [{ providerId: QWEN.providerId, providerName: '千帆', modelId: QWEN.modelId, modelName: 'qwen3.8-max' }],
  })
  storage.set('zcode.thoughtLevel', opts.savedLevel)
  if (opts.withQwenCache) {
    storage.set(`zcode.thoughtLevelInfo.${QWEN.modelId}`, JSON.stringify({
      enabled: true,
      available: QWEN_LEVELS.available,
      defaultLevel: QWEN_LEVELS.defaultLevel,
    }))
  } else {
    storage.delete(`zcode.thoughtLevelInfo.${QWEN.modelId}`)
  }
  // 待命态切模型（真实路径：persist + currentModel + 按缓存 hydrate，无 sid 不发协议）
  useStore.getState().setModel(QWEN.modelId, QWEN.providerId)
}

beforeEach(() => {
  vi.useFakeTimers()
  storage.clear()
  sentRequests.length = 0
  useStore.getState().init() // 注册桥接回调（onMessage）
  sentRequests.length = 0 // 清掉 init 触发的 listSessions/listModels
})

describe('竞态1：createSession 级别补发须等权威 settings 校验', () => {
  it('合法级别：懒创建不发独立 setModel（模型由首条 send runtimeModel 承担），级别由权威 settings 校准下发', () => {
    resetStandby({ savedLevel: 'enabled', withQwenCache: true })

    useStore.getState().sendMessage('首条消息')
    pushResponse({ op: 'createSession', sessionId: NEW_SID })

    // 懒创建首条消息在途：不再独立下发 setModel（与首回合在服务端赛跑会撞
    // -32603 Unsupported，08-29 定时触发实测），模型由首条 send 的 runtimeModel 承担；
    // 级别块整块跳过（setThoughtLevel 先于 send 到达会撞默认模型级别集）
    expect(sentOps()).not.toContain('setModel')
    expect(sentOps()).not.toContain('setThoughtLevel')
    expect(sentOps()).toContain('send')
    const st = useStore.getState()
    expect(st.pendingThoughtLevel).toBeNull()
    expect(st.modelSwitchInFlightAt).toBeNull()
    // 仅标记已应用：防 messages/models 刷新重发 setModel
    expect(st.modelAppliedForSession).toBe(NEW_SID)

    // 权威 settings（qwen=enabled/disabled）到达 → 合法级别校准补发
    // （current=disabled ≠ saved → 需要下发；current 已等于 saved 时服务端无需变更，不下发）
    pushResponse({ op: 'settings', sessionId: NEW_SID, mode: { current: 'yolo' }, thoughtLevel: { ...QWEN_LEVELS, current: 'disabled' } })

    expect(lastOp('setThoughtLevel')).toMatchObject({ sessionId: NEW_SID, thoughtLevel: 'enabled' })
    expect(useStore.getState().pendingThoughtLevel).toBeNull()
    expect(useStore.getState().thoughtLevelAppliedForSession).toBe(NEW_SID)
  })

  it('非法级别（切回旧模型）：权威校验静默跳过，不产生 -32603', () => {
    // 记忆级别 enabled（qwen 上选的），但当前记住的模型是 GLM（只认 off/high/max）。
    // 缓存被污染成含 enabled → 本地校验放行，直发必被服务端拒绝；权威校验须拦下
    useStore.setState({
      connectionStatus: 'mock',
      currentSessionId: null,
      currentWorkspacePath: 'G:\\mock',
      creatingSession: false,
      pendingFirstMessage: null,
      messages: [],
      loadingMessages: false,
      streaming: false,
      queuedMessages: [],
      sessions: [],
      provisionalTitles: {},
      lastError: null,
      thoughtLevel: null,
      currentMode: null,
      thoughtLevelAppliedForSession: null,
      modelAppliedForSession: null,
      modelSwitchInFlightAt: null,
      pendingThoughtLevel: null,
      models: [{ providerId: 'builtin', providerName: '智谱', modelId: 'GLM-5.3', modelName: 'GLM-5.3' }],
    })
    storage.set('zcode.thoughtLevel', 'enabled')
    // 污染缓存：GLM 的真实级别集是 off/high/max，这里混入了 enabled
    storage.set('zcode.thoughtLevelInfo.GLM-5.3', JSON.stringify({
      enabled: true,
      available: [{ label: 'enabled', value: 'enabled' }, { label: 'off', value: 'off' }],
      defaultLevel: 'off',
    }))
    useStore.getState().setModel('GLM-5.3', 'builtin')

    useStore.getState().sendMessage('首条消息')
    pushResponse({ op: 'createSession', sessionId: NEW_SID })
    // 懒创建不再发独立 setModel、级别块跳过（污染缓存不放行）
    expect(sentOps()).not.toContain('setModel')
    expect(sentOps()).not.toContain('setThoughtLevel')
    expect(useStore.getState().pendingThoughtLevel).toBeNull()

    // 权威 settings：GLM 真实级别集 off/high/max → enabled 非法 → 静默跳过
    pushResponse({ op: 'settings', sessionId: NEW_SID, mode: { current: 'yolo' }, thoughtLevel: GLM_LEVELS })

    expect(sentOps()).not.toContain('setThoughtLevel')
    expect(useStore.getState().pendingThoughtLevel).toBeNull()
    // 污染缓存也被权威响应治愈（写回真实级别集：available 不再含 enabled 选项）
    expect(localStorage.getItem('zcode.thoughtLevelInfo.GLM-5.3')).not.toContain('"value":"enabled"')
  })
})

describe('竞态2：切换在途的 settings 响应级别部分不可信', () => {
  it('在途响应只同步 mode；级别不入 store、不下发、不污染模型缓存', () => {
    // saved=max（旧模型所选，对 qwen 非法）；qwen 无缓存（首用）。
    // 在途切换改为手动置位（既有会话回合中 setModel 的 modelSetPending 形态，
    // 与懒创建是否发独立 setModel 解耦——守卫本身不受影响）
    resetStandby({ savedLevel: 'max', withQwenCache: false })
    // 已有会话 + 手动置在途标记（模拟回合中 setModel 的 modelSetPending 形态）
    useStore.setState({ currentSessionId: NEW_SID, modelSwitchInFlightAt: Date.now() })

    // 旧模型（GLM 系）的 settings 响应晚到：max ∈ [off,high,max]，
    // 修复前 applyThoughtLevelIfReady 会照发 max → 服务端已切 qwen → -32603
    pushResponse({ op: 'settings', sessionId: NEW_SID, mode: { current: 'yolo' }, thoughtLevel: GLM_LEVELS })

    const st = useStore.getState()
    expect(st.currentMode).toBe('yolo') // mode 与模型无关，照常同步
    expect(st.thoughtLevel).toBeNull() // 旧级别集不入 store
    expect(sentOps()).not.toContain('setThoughtLevel')
    // 旧级别集不得写进 qwen 的按模型缓存（污染会让下拉出现 qwen 不支持的选项）
    expect(localStorage.getItem(`zcode.thoughtLevelInfo.${QWEN.modelId}`)).toBeNull()

    // 切换落定 + 500ms 后的重拉 settings（modelSet 处理触发）按新模型校准
    pushResponse({ op: 'modelSet', sessionId: NEW_SID, ...QWEN })
    vi.advanceTimersByTime(600)
    expect(sentOps()).toContain('getSettings')
    pushResponse({ op: 'settings', sessionId: NEW_SID, mode: { current: 'yolo' }, thoughtLevel: QWEN_LEVELS })

    const st2 = useStore.getState()
    expect(st2.thoughtLevel?.available.map((a) => a.value)).toEqual(['enabled', 'disabled'])
    // saved=max 对 qwen 非法 → 不下发（显示服务端真实 current，不报错）
    expect(sentOps()).not.toContain('setThoughtLevel')
  })
})

describe('回归守卫：无切换在途时行为不变', () => {
  it('settings 正常生效：级别集入 store、写缓存、saved 合法即下发', () => {
    useStore.setState({
      connectionStatus: 'mock',
      currentSessionId: 'sess_calm',
      currentWorkspacePath: 'G:\\mock',
      currentMode: null,
      thoughtLevel: null,
      thoughtLevelAppliedForSession: null,
      modelSwitchInFlightAt: null,
      pendingThoughtLevel: null,
    })
    storage.set('zcode.thoughtLevel', 'enabled')
    storage.delete(`zcode.thoughtLevelInfo.${QWEN.modelId}`)

    pushResponse({ op: 'settings', sessionId: 'sess_calm', mode: { current: 'yolo' }, thoughtLevel: { ...QWEN_LEVELS, current: 'disabled' } })

    expect(useStore.getState().thoughtLevel?.available).toHaveLength(2)
    expect(storage.get(`zcode.thoughtLevelInfo.${QWEN.modelId}`)).toContain('enabled')
    // saved=enabled 合法且 current=disabled ≠ saved → 照常下发
    expect(lastOp('setThoughtLevel')).toMatchObject({ sessionId: 'sess_calm', thoughtLevel: 'enabled' })
  })
})
