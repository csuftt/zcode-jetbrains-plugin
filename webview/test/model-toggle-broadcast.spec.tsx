/**
 * 模型 provider 启用/禁用多标签同步测试
 *
 * 链路：标签 A 切 provider → Kotlin 写回 config.json → ①modelToggled 应答回 A
 * （合并 changes + 清 modelTogglingId + 重拉下拉）→ ②broadcastModelChanges 向所有
 * 已开标签推 window.onModelsChanged（其他标签就地合并 + 重拉下拉；A 再收一次幂等）。
 *
 * 覆盖：
 * 1. modelToggled 应答（发起标签）：按 changes（含内置套餐互斥联动）更新 modelProviders、
 *    清 modelTogglingId、重拉输入框下拉（listModels）
 * 2. window.onModelsChanged 广播（其他已开标签）：同样合并 changes + 重拉下拉；
 *    不碰 modelTogglingId（由本标签自己的应答清除）；幂等（发起标签再收一次无害）
 * 3. 未加载过模型管理页的标签（modelProviders=null）收到广播：不初始化列表、仍重拉下拉
 * 4. 容错：changes 含未知 providerId 不报错不影响已知项；多 changes（联动项）一次合并
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

let messageHandler: ((msg: unknown) => void) | null = null
const sentRequests: Array<Record<string, unknown>> = []

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getTabWorkspacePath: () => '',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: unknown) => void) => { messageHandler = fn },
  onStreamEvent: () => {},
  onStreamBatch: () => {},
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import { useStore } from '@/store/useStore'
import type { ModelManageProvider } from '@/types/messages'

const provider = (over: Partial<ModelManageProvider> = {}): ModelManageProvider => ({
  providerId: 'builtin:bigmodel-coding-plan',
  providerName: 'BigModel',
  enabled: true,
  models: [],
  ...over,
})

/** 种子状态（beforeEach init() 后重置；init 里注册 window.onModelsChanged 广播入口）*/
function seed() {
  useStore.setState({
    modelProviders: [
      provider(),
      provider({ providerId: 'builtin:bigmodel-lite', providerName: 'Lite' }),
      provider({ providerId: 'custom:my', providerName: '自定义' }),
    ],
    modelTogglingId: null,
  })
}

beforeEach(() => {
  sentRequests.length = 0
  useStore.getState().init()
  sentRequests.length = 0
  seed()
})
afterEach(cleanup)

describe('modelToggled 应答（发起标签）', () => {
  it('合并互斥联动项、清 toggling、重拉下拉', () => {
    useStore.setState({ modelTogglingId: 'builtin:bigmodel-lite' })
    messageHandler!({
      op: 'modelToggled',
      changes: [
        { providerId: 'builtin:bigmodel-lite', enabled: true },
        { providerId: 'builtin:bigmodel-coding-plan', enabled: false },
      ],
    })
    const s = useStore.getState()
    expect(s.modelTogglingId).toBeNull()
    const byId = new Map(s.modelProviders!.map((p) => [p.providerId, p.enabled]))
    expect(byId.get('builtin:bigmodel-lite')).toBe(true)
    expect(byId.get('builtin:bigmodel-coding-plan')).toBe(false)
    expect(byId.get('custom:my')).toBe(true) // 未涉及项不动
    expect(sentRequests.some((r) => r.op === 'listModels')).toBe(true)
  })
})

describe('modelToggled 模型级 change（单模型开关，2026-10-12）', () => {
  it('只改对应 models 元素的 enabled、清 modelTogglingKey、渠道 enabled 不动', () => {
    useStore.setState({
      modelProviders: [
        provider({
          providerId: 'custom:ds',
          providerName: 'DeepSeek',
          enabled: true,
          models: [
            { modelId: 'm1', modelName: 'm1', enabled: true },
            { modelId: 'm2', modelName: 'm2', enabled: true },
          ],
        }),
      ],
      modelTogglingKey: 'custom:ds|m2',
    })
    messageHandler!({
      op: 'modelToggled',
      changes: [{ providerId: 'custom:ds', modelId: 'm2', enabled: false }],
    })
    const s = useStore.getState()
    const p = s.modelProviders![0]
    expect(p.enabled).toBe(true)
    expect(p.models.map((m) => m.enabled)).toEqual([true, false])
    expect(s.modelTogglingKey).toBeNull()
    expect(sentRequests.some((r) => r.op === 'listModels')).toBe(true)
  })

  it('广播模型级 change 时不碰本标签 toggling 态', () => {
    useStore.setState({
      modelProviders: [
        provider({
          providerId: 'custom:ds',
          models: [{ modelId: 'm1', modelName: 'm1', enabled: true }],
        }),
      ],
      modelTogglingKey: 'custom:ds|m1',
    })
    window.onModelsChanged!([{ providerId: 'custom:ds', modelId: 'm1', enabled: false }])
    expect(useStore.getState().modelProviders![0].models[0].enabled).toBe(false)
    expect(useStore.getState().modelTogglingKey).toBe('custom:ds|m1')
  })
})

describe('onModelsChanged 广播（其他已开标签）', () => {
  it('合并 changes + 重拉下拉，不动 modelTogglingId', () => {
    useStore.setState({ modelTogglingId: 'custom:my' }) // 本标签自己的切换进行中（异常并发场景）
    window.onModelsChanged!([{ providerId: 'custom:my', enabled: false }])
    const s = useStore.getState()
    const byId = new Map(s.modelProviders!.map((p) => [p.providerId, p.enabled]))
    expect(byId.get('custom:my')).toBe(false)
    expect(sentRequests.some((r) => r.op === 'listModels')).toBe(true)
    // toggling 由本标签自己的 modelToggled 应答清除，广播不碰
    expect(s.modelTogglingId).toBe('custom:my')
  })

  it('modelProviders 未加载（null）时只重拉下拉、不初始化列表', () => {
    useStore.setState({ modelProviders: null })
    window.onModelsChanged!([{ providerId: 'custom:my', enabled: false }])
    expect(useStore.getState().modelProviders).toBeNull()
    expect(sentRequests.some((r) => r.op === 'listModels')).toBe(true)
  })

  it('重复推送幂等（发起标签应答后广播再达，状态不变）', () => {
    const changes = [{ providerId: 'custom:my' as const, enabled: false }]
    messageHandler!({ op: 'modelToggled', changes })
    const after1 = useStore.getState().modelProviders
    window.onModelsChanged!(changes)
    expect(useStore.getState().modelProviders).toEqual(after1)
    expect(sentRequests.filter((r) => r.op === 'listModels')).toHaveLength(2)
  })

  it('多 changes（含内置套餐互斥联动项）一次合并到位', () => {
    window.onModelsChanged!([
      { providerId: 'builtin:bigmodel-lite', enabled: true },
      { providerId: 'builtin:bigmodel-coding-plan', enabled: false },
    ])
    const byId = new Map(useStore.getState().modelProviders!.map((p) => [p.providerId, p.enabled]))
    expect(byId.get('builtin:bigmodel-lite')).toBe(true)
    expect(byId.get('builtin:bigmodel-coding-plan')).toBe(false)
    expect(byId.get('custom:my')).toBe(true)
  })

  it('changes 含未知 providerId：容错跳过，不影响已知项', () => {
    expect(() =>
      window.onModelsChanged!([
        { providerId: 'custom:ghost', enabled: false },
        { providerId: 'custom:my', enabled: false },
      ]),
    ).not.toThrow()
    const byId = new Map(useStore.getState().modelProviders!.map((p) => [p.providerId, p.enabled]))
    expect(byId.get('custom:my')).toBe(false)
    expect(useStore.getState().modelProviders!.some((p) => p.providerId === 'custom:ghost')).toBe(false)
    expect(sentRequests.some((r) => r.op === 'listModels')).toBe(true)
  })

  it('空 changes 数组：不改动列表，仍重拉下拉（广播通道心跳语义）', () => {
    const before = useStore.getState().modelProviders
    window.onModelsChanged!([])
    expect(useStore.getState().modelProviders).toEqual(before)
    expect(sentRequests.some((r) => r.op === 'listModels')).toBe(true)
  })
})
