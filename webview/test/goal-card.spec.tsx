/**
 * GoalCard 组件渲染测试（2026-09-03）
 *
 * 锁定：无目标不渲染；有目标渲染状态/统计/操作钮；pause 按钮点击发 goalManage；
 * complete 态隐藏 pause、clear 常驻。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { GoalCard } from '@/components/GoalCard'

const sentRequests: Array<Record<string, unknown>> = []

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getInitialSessionId: () => '',
  onMessage: () => {},
  onStreamEvent: () => {},
  onStreamBatch: () => {},
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import { useStore } from '@/store/useStore'
import i18n from '@/i18n/config'

const GOAL = {
  targetId: 't1',
  objective: '重构登录页并保持测试通过',
  status: 'active',
  tokensUsed: 12300,
  timeUsedSeconds: 95,
  iterationCount: 2,
}

describe('GoalCard', () => {
  beforeEach(() => {
    sentRequests.length = 0
    useStore.setState({ currentSessionId: 'sess_g', goal: null, streaming: false })
  })

  it('无目标时不渲染', () => {
    const { container } = render(<GoalCard />)
    expect(container.querySelector('.goal-card')).toBeNull()
  })

  it('有目标时渲染目标文本与统计', () => {
    useStore.setState({ goal: GOAL as never })
    const { container } = render(<GoalCard />)
    const card = container.querySelector('.goal-card')
    expect(card).not.toBeNull()
    expect(container.querySelector('.goal-card__objective')?.textContent).toBe('重构登录页并保持测试通过')
    expect(container.querySelector('.goal-card__stats')?.textContent).toContain('2')
  })

  it('active 态显示 pause 按钮，点击发 goalManage pause', () => {
    useStore.setState({ goal: GOAL as never })
    const { container } = render(<GoalCard />)
    const pauseBtn = container.querySelector('.goal-card__btn:not(.goal-card__btn--clear)') as HTMLButtonElement
    expect(pauseBtn).not.toBeNull()
    fireEvent.click(pauseBtn)
    expect(sentRequests.some((r) => r.op === 'goalManage' && r.action === 'pause')).toBe(true)
  })

  it('paused 态显示 resume 按钮', () => {
    useStore.setState({ goal: { ...GOAL, status: 'paused' } as never })
    const { container } = render(<GoalCard />)
    expect(container.querySelector('.goal-card--paused')).not.toBeNull()
    const resumeBtn = container.querySelector('.goal-card__btn:not(.goal-card__btn--clear)') as HTMLButtonElement
    expect(resumeBtn).not.toBeNull()
  })

  it('complete 态隐藏 pause/resume，clear 常驻', () => {
    useStore.setState({ goal: { ...GOAL, status: 'complete' } as never })
    const { container } = render(<GoalCard />)
    const btns = Array.from(container.querySelectorAll('.goal-card__btn'))
    expect(btns).toHaveLength(1)
    expect(btns[0].classList.contains('goal-card__btn--clear')).toBe(true)
  })

  it('verifying 态显示"校验中"指示（独立一行，不与轮次统计共排）', () => {
    useStore.setState({ goal: { ...GOAL, verifying: true } as never })
    const { container } = render(<GoalCard />)
    const verify = container.querySelector('.goal-card__verify')
    expect(verify).not.toBeNull()
    expect(verify?.textContent).toContain('校验中')
    // 0.3.2 真机反馈：与统计同行会把卡片顶宽——校验行与统计行须各自独立成行
    const main = container.querySelector('.goal-card__main')
    expect(main?.querySelector(':scope > .goal-card__verify')).not.toBeNull()
    expect(main?.querySelector(':scope > .goal-card__stats')).not.toBeNull()
  })

  it('非 verifying 态不显示校验指示', () => {
    useStore.setState({ goal: GOAL as never })
    const { container } = render(<GoalCard />)
    expect(container.querySelector('.goal-card__verify')).toBeNull()
  })

  it('active 态本地走秒：syncedAt 基准上递增显示', () => {
    // 服务端值 95s，syncedAt 在 5s 前 → 显示 100s（1m40s）
    useStore.setState({ goal: { ...GOAL, syncedAt: Date.now() - 5000 } as never })
    const { container } = render(<GoalCard />)
    expect(container.querySelector('.goal-card__stats')?.textContent).toContain('1m40s')
  })

  it('paused 态冻结走秒（显示服务端值）', () => {
    useStore.setState({ goal: { ...GOAL, status: 'paused', syncedAt: Date.now() - 5000 } as never })
    const { container } = render(<GoalCard />)
    expect(container.querySelector('.goal-card__stats')?.textContent).toContain('1m35s')
  })

  it('i18n 文案存在（zh）', () => {
    expect(i18n.t('chat.goal.status.active', { lng: 'zh' })).toBe('目标进行中')
    expect(i18n.t('chat.goal.usageHint', { lng: 'zh' })).toContain('/goal')
    expect(i18n.t('chat.timeline.goalPassed', { lng: 'zh' })).toBe('目标校验通过')
  })
})
