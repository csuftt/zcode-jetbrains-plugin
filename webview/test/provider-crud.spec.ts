/**
 * 自定义渠道 CRUD store 链路测试（2026-09-16，design-research/自定义模型渠道CRUD实现方案）
 *
 * 覆盖：
 * 1. addModelProvider/updateModelProvider/removeModelProvider 请求载荷（draft 原样透传）
 *    与 providerSaving 防重入（保存中再触发被忽略）。
 * 2. case 'modelProviderSaved'：失败留 providerSaveError（弹窗内提示）；成功清态并
 *    全量重拉 modelManageList（应答自带 loadModels 联动）。
 * 3. window.onModelManageChanged 广播（其他标签渠道结构变更）→ 本标签重拉 modelManageList。
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
  getTabWorkspacePath: () => '',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: unknown) => void) => { messageHandler = fn },
  onStreamEvent: () => {},
  onStreamBatch: () => {},
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import { useStore } from '@/store/useStore'
import type { ProviderSaveDraft } from '@/types/messages'

const draft = (over: Partial<ProviderSaveDraft> = {}): ProviderSaveDraft => ({
  name: 'DeepSeek',
  kind: 'anthropic',
  baseURL: 'https://api.deepseek.com/anthropic',
  apiKey: 'sk-new',
  models: [{ modelId: 'deepseek-chat', context: 128000 }],
  ...over,
})

function pushResponse(msg: Record<string, unknown>): void {
  messageHandler!(msg)
}

beforeEach(() => {
  sentRequests.length = 0
  useStore.getState().init() // 注册 messageHandler / window.onModelManageChanged
  sentRequests.length = 0
  useStore.setState({
    providerSaving: false,
    providerSaveError: null,
    modelProviders: null,
  })
})

describe('CRUD 请求发送', () => {
  it('addModelProvider 透传 draft', () => {
    useStore.getState().addModelProvider(draft())
    expect(sentRequests).toEqual([
      { op: 'modelAddProvider', draft: draft() },
    ])
    expect(useStore.getState().providerSaving).toBe(true)
  })

  it('updateModelProvider 带 providerId（apiKey null=不变透传）', () => {
    useStore.getState().updateModelProvider('uuid-1', draft({ apiKey: null }))
    expect(sentRequests).toEqual([
      { op: 'modelUpdateProvider', providerId: 'uuid-1', draft: draft({ apiKey: null }) },
    ])
  })

  it('removeModelProvider 带 providerId', () => {
    useStore.getState().removeModelProvider('uuid-1')
    expect(sentRequests).toEqual([{ op: 'modelRemoveProvider', providerId: 'uuid-1' }])
  })

  it('providerSaving 防重入：保存中后续动作被忽略', () => {
    useStore.setState({ providerSaving: true })
    useStore.getState().addModelProvider(draft())
    useStore.getState().removeModelProvider('uuid-1')
    expect(sentRequests).toEqual([])
  })
})

describe('modelProviderSaved 应答', () => {
  it('失败：providerSaveError 留存（弹窗内提示），saving 复位', () => {
    useStore.setState({ providerSaving: true })
    pushResponse({ op: 'modelProviderSaved', ok: false, action: 'add', providerId: 'uuid-1', error: '渠道名称不能为空' })
    const s = useStore.getState()
    expect(s.providerSaving).toBe(false)
    expect(s.providerSaveError).toBe('渠道名称不能为空')
  })

  it('成功：清态并全量重拉模型管理页', () => {
    useStore.setState({ providerSaving: true, providerSaveError: '旧错误' })
    sentRequests.length = 0
    pushResponse({ op: 'modelProviderSaved', ok: true, action: 'update', providerId: 'uuid-1' })
    const s = useStore.getState()
    expect(s.providerSaving).toBe(false)
    expect(s.providerSaveError).toBeNull()
    expect(sentRequests.some((r) => r.op === 'modelManageList')).toBe(true)
  })
})

describe('onModelManageChanged 多标签广播', () => {
  it('收到广播重拉模型管理页（结构变更无法就地合并）', () => {
    sentRequests.length = 0
    window.onModelManageChanged!()
    expect(sentRequests.some((r) => r.op === 'modelManageList')).toBe(true)
  })
})
