/**
 * 命中率闪 0 修复 + GLM 额度定时刷新测试
 *
 * 缺陷一（命中率闪 0）：服务端 hitRate 可为 null（新 turn 首次模型调用完成前
 * 聚合器为空），Kotlin 此前把 null 解析成 0.0，前端无条件覆盖 → 悬浮栏在
 * 「0.0% ↔ 正常值」间闪烁。修复后 null 不输出字段，前端存 null 显示"—"。
 *
 * 缺陷二（额度刷新不联动）：quota 纯懒加载（hover/打开用量页/手动），时间戳
 * 长期不动。修复后 60s 定时轮询，仅 GLM 套餐模型拉取，在途请求防重入。
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

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

import { useStore, GLM_PLAN_PROVIDER } from '@/store/useStore'

const SID = 'sess_hr_1'
const GLM_MODEL = { modelId: 'glm-5.3', providerId: GLM_PLAN_PROVIDER }
const OTHER_MODEL = { modelId: 'deepseek-v3', providerId: 'builtin:deepseek' }

/** 注入一条 usage 响应（模拟 Kotlin getUsage 回包）*/
function pushUsage(opts: { hitRate?: number; used?: number }): void {
  messageHandler!({
    op: 'usage', sessionId: SID, used: opts.used ?? 10000, size: 200000,
    ...(opts.hitRate !== undefined ? { hitRate: opts.hitRate } : {}),
  })
}

// fake timers 整文件只装一次：quota 轮询定时器在首次 init() 注册（防重入），
// 若每个用例重装会重置 fake 环境，已注册的 interval 引用悬空不再触发
beforeAll(() => {
  vi.useFakeTimers()
})

beforeEach(() => {
  storage.clear()
  sentRequests.length = 0
  useStore.setState({
    currentSessionId: SID,
    currentModel: null,
    contextUsage: null,
    contextBreakdown: null,
    quota: null,
    quotaLoading: false,
    quotaFetchedAt: 0,
    streaming: false,
  })
  useStore.getState().init() // 注册桥接回调 + 启动额度轮询定时器
})

describe('命中率 null 语义（不再闪 0）', () => {
  it('usage 缺 hitRate 字段 → contextUsage.hitRate 为 null（不落 0）', () => {
    pushUsage({}) // 服务端暂无统计：Kotlin 不输出该字段
    expect(useStore.getState().contextUsage).toEqual({ used: 10000, size: 200000, hitRate: null })
  })

  it('hitRate=0 的真实零命中与缺字段区分开：0 透传，缺失为 null', () => {
    pushUsage({ hitRate: 0 })
    expect(useStore.getState().contextUsage?.hitRate).toBe(0)
  })

  it('有统计时正常透传', () => {
    pushUsage({ hitRate: 0.876 })
    expect(useStore.getState().contextUsage?.hitRate).toBe(0.876)
  })
})

describe('GLM 额度 60s 定时刷新', () => {
  it('当前模型为 GLM 套餐 → 每 60s 发一次 getQuota', () => {
    useStore.setState({ currentModel: GLM_MODEL })
    expect(sentRequests.filter((r) => r.op === 'getQuota')).toHaveLength(0)

    vi.advanceTimersByTime(60_000)
    expect(sentRequests.filter((r) => r.op === 'getQuota')).toHaveLength(1)

    vi.advanceTimersByTime(60_000)
    // 上一轮 quotaLoading 仍为 true（无响应回来）→ 本轮防重入跳过
    expect(sentRequests.filter((r) => r.op === 'getQuota')).toHaveLength(1)
  })

  it('上一轮响应到达后（quotaLoading 复位）下一轮继续拉', () => {
    useStore.setState({ currentModel: GLM_MODEL })
    vi.advanceTimersByTime(60_000)
    // 模拟 Kotlin 回包（成功，清除 loading 并记录时间戳）
    messageHandler!({ op: 'quota', data: { level: 'Max', limits: [] } })
    expect(useStore.getState().quotaFetchedAt).toBeGreaterThan(0)

    vi.advanceTimersByTime(60_000)
    expect(sentRequests.filter((r) => r.op === 'getQuota')).toHaveLength(2)
  })

  it('当前模型非 GLM 套餐 → 不拉取', () => {
    useStore.setState({ currentModel: OTHER_MODEL })
    vi.advanceTimersByTime(180_000)
    expect(sentRequests.filter((r) => r.op === 'getQuota')).toHaveLength(0)
  })

  it('模型未就绪（null）→ 不拉取，切到 GLM 后恢复', () => {
    vi.advanceTimersByTime(120_000)
    expect(sentRequests.filter((r) => r.op === 'getQuota')).toHaveLength(0)

    useStore.setState({ currentModel: GLM_MODEL })
    vi.advanceTimersByTime(60_000)
    expect(sentRequests.filter((r) => r.op === 'getQuota')).toHaveLength(1)
  })
})
