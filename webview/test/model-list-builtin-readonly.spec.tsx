/**
 * 内置渠道只读回归测试（2026-09-17 用户反馈：内置渠道模型行出现了删除按钮）
 *
 * 自定义渠道 CRUD 上线时 ModelRow 的删除按钮没按 builtin 区分——内置模型行也渲染
 * 垃圾桶（Kotlin 端 builtin 拒绝守卫兜底不会真写，但按钮暗示可删，纯误导）。
 * 修复后：内置渠道模型行无删除按钮、卡片无编辑/删除渠道入口；自定义渠道齐全。
 */

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

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
import { useStore } from '@/store/useStore'
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
    providerId: 'builtin:bigmodel-coding-plan',
    providerName: 'BigModel - Coding Plan',
    plan: 'personal',
    via: 'selected',
    enabled: true,
    models: [
      { modelId: 'GLM-5.3', modelName: 'GLM-5.3', contextWindow: 1000000, maxOutput: 128000 },
      { modelId: 'GLM-5.3-Flash', modelName: 'GLM-5.3-Flash', contextWindow: 1000000, maxOutput: 128000, supportsImages: true },
    ],
  }),
  provider({
    providerId: 'uuid-deepseek',
    providerName: 'DeepSeek',
    kind: 'anthropic',
    baseURL: 'https://api.deepseek.com/anthropic',
    enabled: true,
    models: [
      { modelId: 'deepseek-v4-pro', modelName: 'deepseek-v4-pro', contextWindow: 128000, maxOutput: 8192 },
      { modelId: 'deepseek-v4-flash', modelName: 'deepseek-v4-flash', contextWindow: 128000, maxOutput: 8192 },
    ],
  }),
  provider({
    providerId: 'uuid-qwen',
    providerName: '千问',
    kind: 'anthropic',
    baseURL: 'https://x.maas.aliyuncs.com/apps/anthropic',
    enabled: true,
    models: [
      { modelId: 'deepseek-v4.1-flash', modelName: 'deepseek-v4.1-flash', contextWindow: 1000000 },
    ],
  }),
]

beforeEach(() => {
  sentRequests.length = 0
  useStore.getState().init()
  useStore.setState({ modelProviders: SEED.map((p) => structuredClone(p)), modelManageLoading: false })
})

afterEach(cleanup)

describe('内置渠道只读', () => {
  it('内置模型行无删除按钮，多模型自定义渠道可删（2 个）', () => {
    render(<ModelListView />)
    // DeepSeek 2 个模型 → 2 个可用删除按钮；内置 2 个模型不渲染
    const delBtns = screen.getAllByTitle('删除模型')
    expect(delBtns).toHaveLength(2)
    delBtns.forEach((b) => expect((b as HTMLButtonElement).disabled).toBe(false))
    // GLM-5.3 / deepseek-v4-pro 名称与 ID 同文 → getAllByText
    expect(screen.getAllByText('GLM-5.3').length).toBeGreaterThan(0)
    expect(screen.getAllByText('deepseek-v4-pro').length).toBeGreaterThan(0)
  })

  it('渠道最后一个模型删除可点但转弹窗提醒（2026-09-17 用户反馈：disabled 无反馈像坏了）', () => {
    const { fireEvent } = require('@testing-library/react')
    render(<ModelListView />)
    // 千问只剩 1 个模型 → 按钮可点，title 换为拦截说明
    const lastDel = screen.getByTitle(/最后一个模型不可删除/) as HTMLButtonElement
    expect(lastDel.disabled).toBe(false)
    // 该模型的 ID 行仍正常展示
    expect(screen.getAllByText('deepseek-v4.1-flash').length).toBeGreaterThan(0)
    // 点击 → 弹信息窗（单按钮「知道了」，含模型名与渠道名，无删除动作）
    fireEvent.click(lastDel)
    expect(screen.getByRole('heading', { name: '最后一个模型不可删除' })).toBeTruthy()
    expect(screen.getByText(/deepseek-v4.1-flash.*千问|千问.*deepseek-v4.1-flash/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '知道了' }))
    expect(screen.queryByRole('heading', { name: '最后一个模型不可删除' })).toBeNull()
  })

  it('内置卡片无编辑/删除渠道入口，自定义卡片有', () => {
    render(<ModelListView />)
    expect(screen.getAllByTitle('编辑自定义渠道')).toHaveLength(2)
    expect(screen.getAllByTitle('删除渠道（含全部模型）')).toHaveLength(2)
    // 启停开关：内置是只读徽章（pass-filled），仅自定义渲染 toggle 按钮（title 是完整句）
    expect(screen.getAllByTitle(/禁用该供应商/)).toHaveLength(2)
  })
})
