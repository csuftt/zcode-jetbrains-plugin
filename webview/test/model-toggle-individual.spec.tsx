/**
 * 单模型启用/停用开关（2026-10-12，对齐 ZCode 客户端的模型级 enabled）：
 * - NEW 代自定义渠道：每个模型行渲染开关，点击发 modelToggleModel（provider/model/enabled）
 * - 内置/账号渠道：模型行无开关（只读，M1 写侧不开放账号渠道）
 * - OLD 代 CLI：不渲染模型开关（无 provider_config.json 能力）
 * - 停用模型：「已停用」徽章 + 开关 title 切启用；停用渠道下开关禁用
 * - applyModelToggleChanges：provider 级与模型级 changes 合并语义
 */

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'

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

import '@/i18n/config'
import { useStore, applyModelToggleChanges } from '@/store/useStore'
import { ModelListView } from '@/components/ModelListView'
import type { ModelManageProvider } from '@/types/messages'

const provider = (over: Partial<ModelManageProvider>): ModelManageProvider => ({
  providerName: over.providerId ?? 'p',
  enabled: true,
  models: [],
  ...over,
})

const SEED: ModelManageProvider[] = [
  provider({
    providerId: 'account:zai-individual-coding-plan',
    providerName: 'BigModel 个人',
    plan: 'personal',
    enabled: true,
    models: [
      { modelId: 'GLM-5.3', modelName: 'GLM-5.3', enabled: true },
      { modelId: 'GLM-5.3-Flash', modelName: 'GLM-5.3-Flash', enabled: false },
    ],
  }),
  provider({
    providerId: 'uuid-deepseek',
    providerName: 'DeepSeek',
    kind: 'anthropic',
    baseURL: 'https://api.deepseek.com/anthropic',
    enabled: true,
    models: [
      { modelId: 'deepseek-v4-pro', modelName: 'deepseek-v4-pro', enabled: true },
      { modelId: 'deepseek-v4-flash', modelName: 'deepseek-v4-flash', enabled: false },
    ],
  }),
  provider({
    providerId: 'uuid-disabled-prov',
    providerName: '停用渠道',
    kind: 'anthropic',
    enabled: false,
    models: [
      { modelId: 'some-model', modelName: 'some-model', enabled: true },
    ],
  }),
]

beforeEach(() => {
  sentRequests.length = 0
  messageHandler = null
  useStore.getState().init()
  useStore.setState({
    modelProviders: SEED.map((p) => structuredClone(p)),
    modelManageLoading: false,
    modelManageNewCli: true,
    modelTogglingId: null,
    modelTogglingKey: null,
  })
})

afterEach(cleanup)

describe('单模型开关渲染', () => {
  it('NEW 代自定义渠道每个启用模型有停用开关；账号渠道无模型开关', () => {
    render(<ModelListView />)
    // DeepSeek 启用模型一个停用开关；账号渠道两个模型都不渲染模型开关
    const disableTitles = screen.getAllByTitle('禁用该模型（写回 provider_config.json，聊天模型下拉立即同步隐藏）')
    expect(disableTitles).toHaveLength(2) // deepseek-v4-pro + 停用渠道的 some-model
    // 停用模型（DeepSeek 的 flash）显示启用开关
    expect(screen.getAllByTitle('启用该模型（写回 provider_config.json，聊天模型下拉立即可选）')).toHaveLength(1)
  })

  it('停用模型的测试按钮隐藏但保留占位（disabled+透明，删除按钮不横跳）；停用渠道不渲染', () => {
    render(<ModelListView />)
    // 启用模型 2 个（账号 GLM-5.3 + DeepSeek v4-pro）可点
    const enabledTests = screen.getAllByTitle('测试该模型连通性（真发一次最小请求）')
    expect(enabledTests).toHaveLength(2)
    enabledTests.forEach((b) => expect((b as HTMLButtonElement).disabled).toBe(false))
    // 停用模型 2 个（账号 flash + DeepSeek flash）：按钮 DOM 保留（占位）但禁用+透明 class
    const placeholders = document.querySelectorAll('.model-list-view__model-test.is-hidden-placeholder')
    expect(placeholders).toHaveLength(2)
    placeholders.forEach((b) => {
      expect((b as HTMLButtonElement).disabled).toBe(true)
    })
    // 停用渠道整卡不可测：无测试按钮（该卡唯一模型不出现在上面两组里，总数=4 已覆盖）
  })

  it('OLD 代（modelManageNewCli=false）不渲染模型开关', () => {
    useStore.setState({ modelManageNewCli: false })
    render(<ModelListView />)
    expect(screen.queryAllByTitle(/^禁用该模型/)).toHaveLength(0)
    expect(screen.queryAllByTitle(/^启用该模型/)).toHaveLength(0)
  })

  it('停用模型行显示「已停用」徽章（仅个人渠道——账号卡在管理页也显停用态）', () => {
    render(<ModelListView />)
    // 账号 GLM-5.3-Flash 与 DeepSeek flash 两条停用模型
    expect(screen.getAllByText('已停用')).toHaveLength(2)
  })

  it('渠道停用时其模型开关禁用', () => {
    render(<ModelListView />)
    const btn = screen.getAllByTitle('禁用该模型（写回 provider_config.json，聊天模型下拉立即同步隐藏）')[0] as HTMLButtonElement
    // 第一个命中的是 DeepSeek（启用渠道）可点；停用渠道的开关单独断言 disabled
    const toggles = document.querySelectorAll('.model-list-view__model-toggle')
    const disabledProvToggle = Array.from(toggles).find((b) =>
      (b.closest('.model-list-view__provider') as HTMLElement)?.classList.contains('disabled'),
    ) as HTMLButtonElement
    expect(disabledProvToggle).toBeTruthy()
    expect(disabledProvToggle.disabled).toBe(true)
    expect(btn.disabled).toBe(false)
  })
})

describe('单模型开关交互', () => {
  it('点击发 modelToggleModel 且单飞：在途时其他模型点击不发请求', () => {
    render(<ModelListView />)
    const toggles = screen.getAllByTitle('禁用该模型（写回 provider_config.json，聊天模型下拉立即同步隐藏）')
    fireEvent.click(toggles[0])
    expect(sentRequests).toContainEqual({
      op: 'modelToggleModel',
      providerId: 'uuid-deepseek',
      modelId: 'deepseek-v4-pro',
      enabled: false,
    })
    // 在途（modelTogglingKey 已设）：再点停用渠道的开关不产生第二次请求
    fireEvent.click(toggles[1])
    expect(sentRequests.filter((r) => r.op === 'modelToggleModel')).toHaveLength(1)
  })

  it('停用模型开关点击发 enabled:true', () => {
    render(<ModelListView />)
    const enableBtn = screen.getByTitle('启用该模型（写回 provider_config.json，聊天模型下拉立即可选）')
    fireEvent.click(enableBtn)
    expect(sentRequests).toContainEqual({
      op: 'modelToggleModel',
      providerId: 'uuid-deepseek',
      modelId: 'deepseek-v4-flash',
      enabled: true,
    })
  })
})

describe('applyModelToggleChanges', () => {
  const base = (): ModelManageProvider[] => [
    provider({
      providerId: 'p1',
      enabled: true,
      models: [
        { modelId: 'm1', modelName: 'm1', enabled: true },
        { modelId: 'm2', modelName: 'm2', enabled: true },
      ],
    }),
    provider({ providerId: 'p2', enabled: true, models: [{ modelId: 'm3', modelName: 'm3' }] }),
  ]

  it('null providers 原样返回 null（未开管理页不凭空初始化）', () => {
    expect(applyModelToggleChanges(null, [{ providerId: 'p1', enabled: false }])).toBeNull()
  })

  it('模型级 change 只改对应 models 元素，渠道 enabled 不动', () => {
    const out = applyModelToggleChanges(base(), [
      { providerId: 'p1', modelId: 'm2', enabled: false },
    ])!
    expect(out[0].enabled).toBe(true)
    expect(out[0].models[0].enabled).toBe(true)
    expect(out[0].models[1].enabled).toBe(false)
    expect(out[1]).toEqual(base()[1])
  })

  it('渠道级 change 只改 provider.enabled；两级可同批', () => {
    const out = applyModelToggleChanges(base(), [
      { providerId: 'p1', enabled: false },
      { providerId: 'p2', modelId: 'm3', enabled: false },
    ])!
    expect(out[0].enabled).toBe(false)
    expect(out[0].models[0].enabled).toBe(true)
    expect(out[1].enabled).toBe(true)
    expect(out[1].models[0].enabled).toBe(false)
  })

  it('未知 provider/model 的 change 不产生影响', () => {
    const input = base()
    const out = applyModelToggleChanges(input, [
      { providerId: 'ghost', enabled: false },
      { providerId: 'p1', modelId: 'ghost-model', enabled: false },
    ])!
    expect(out).toEqual(input)
  })
})
