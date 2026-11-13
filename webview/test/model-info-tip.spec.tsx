/**
 * 模型按钮悬停信息卡（ModelSelect）+ 思考级别图标类回归：
 * - 选中模型悬停 → body 挂 .model-info-tip 三行（供应商/模型名/上下文窗口千分位）
 * - 模型无 contextWindow → 省略窗口行；未选模型悬停不出卡；移开即消失
 * - 思考级别按钮图标带 thought-level-icon（字号由 less 控制，jsdom 不算 CSS 只断类名）；
 *   xhigh 及其别名必须落到本地化文案（漏映射就裸露英文原样显示）
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('@/ipc/bridge', () => ({
  sendToJava: () => {},
  isInJcef: () => false,
}))

import '@/i18n/config'
import { ModelSelect } from '@/components/ModelSelect'
import { ThoughtLevelSelect } from '@/components/ThoughtLevelSelect'
import { useStore } from '@/store/useStore'
import type { ModelOption } from '@/types/messages'

const MODELS: ModelOption[] = [
  {
    providerId: 'p1',
    providerName: 'BigModel - Coding Plan',
    plan: 'personal',
    modelId: 'GLM-5.3',
    modelName: 'GLM-5.3',
    contextWindow: 1000000,
    maxOutput: 128000,
  },
  { providerId: 'p2', providerName: 'DeepSeek', modelId: 'deepseek-v4-flash', modelName: 'deepseek-v4-flash' },
]

describe('模型按钮悬停信息卡', () => {
  beforeEach(() => {
    useStore.setState({ models: MODELS, messages: [] as never })
  })
  afterEach(cleanup)

  it('选中模型悬停显示三行信息卡，移开消失', () => {
    render(<ModelSelect currentModel={{ modelId: 'GLM-5.3', providerId: 'p1' }} onSelect={() => {}} />)
    expect(document.querySelector('.model-info-tip')).toBeNull()

    fireEvent.mouseEnter(screen.getByRole('button'))
    const tip = document.querySelector('.model-info-tip')
    expect(tip).toBeTruthy()
    expect(tip!.textContent).toContain('BigModel - Coding Plan')
    expect(tip!.textContent).toContain('GLM-5.3')
    // fmtTokens 紧凑格式（zh=100万 / en=1M），与上下文圆环同口径
    expect(tip!.textContent).toMatch(/100万 tokens|1M tokens/)

    fireEvent.mouseLeave(screen.getByRole('button'))
    expect(document.querySelector('.model-info-tip')).toBeNull()
  })

  it('模型未配 contextWindow 时省略窗口行', () => {
    render(<ModelSelect currentModel={{ modelId: 'deepseek-v4-flash', providerId: 'p2' }} onSelect={() => {}} />)
    fireEvent.mouseEnter(screen.getByRole('button'))
    const tip = document.querySelector('.model-info-tip')
    expect(tip).toBeTruthy()
    expect(tip!.textContent).toContain('DeepSeek')
    expect(tip!.textContent).not.toContain('tokens')
  })

  it('未选模型悬停不出卡', () => {
    render(<ModelSelect currentModel={null} onSelect={() => {}} />)
    fireEvent.mouseEnter(screen.getByRole('button'))
    expect(document.querySelector('.model-info-tip')).toBeNull()
  })
})

describe('思考级别选择器', () => {
  afterEach(cleanup)

  it('按钮图标带 thought-level-icon 尺寸类', () => {
    useStore.setState({
      thoughtLevel: {
        enabled: true,
        current: 'max',
        defaultLevel: 'high',
        available: [
          { label: 'off', value: 'off' },
          { label: 'high', value: 'high' },
          { label: 'max', value: 'max' },
        ],
      } as never,
      models: [] as never,
      messages: [] as never,
    })
    render(<ThoughtLevelSelect />)
    const icon = document.querySelector('.selector-button .thought-level-icon')
    expect(icon).toBeTruthy()
    expect(icon!.className).toContain('codicon-rocket')
  })

  it('xhigh 档本地化出中文标签 + 火焰图标（别名 extra-high 同档，不再裸露英文）', async () => {
    const i18n = (await import('i18next')).default
    await i18n.changeLanguage('zh')
    useStore.setState({
      thoughtLevel: {
        enabled: true,
        current: 'xhigh',
        defaultLevel: 'medium',
        available: [
          { label: 'low', value: 'low' },
          { label: 'medium', value: 'medium' },
          { label: 'xhigh', value: 'xhigh' },
          { label: 'extra-high', value: 'extra-high' },
        ],
      } as never,
      models: [] as never,
      messages: [] as never,
    })
    render(<ThoughtLevelSelect />)
    const btn = screen.getByRole('button')
    expect(btn.textContent).toBe('极高')
    expect(btn.querySelector('.thought-level-icon')!.className).toContain('codicon-flame')

    fireEvent.click(btn)
    const names = Array.from(document.querySelectorAll('.selector-dropdown-item-name')).map((n) => n.textContent)
    expect(names).toEqual(['低', '中', '极高', '极高'])
  })
})
