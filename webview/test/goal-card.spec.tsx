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

/* ---- localStorage mock：本 vitest jsdom 的 localStorage 是无 clear 的普通对象
 *（getOwnPropertyNames 实测），折叠/位置 persist 记忆断言需要完整实现 ---- */
function makeLocalStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
    get length() { return store.size },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
  }
}
const lsMock = makeLocalStorage()
Object.defineProperty(window, 'localStorage', { value: lsMock, configurable: true, writable: true })

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
    lsMock.clear() // 折叠/位置记忆（persist kv）防串用例
    useStore.setState({ currentSessionId: 'sess_g', goal: null, streaming: false })
  })

  it('无目标时不渲染', () => {
    const { container } = render(<GoalCard />)
    expect(container.querySelector('.goal-card')).toBeNull()
  })

  it('有目标时渲染靶子图标（兼承状态）、目标文本与统计', () => {
    useStore.setState({ goal: GOAL as never })
    const { container } = render(<GoalCard />)
    const card = container.querySelector('.goal-card')
    expect(card).not.toBeNull()
    // 靶子图标与 /goal 命令 chip 呼应（0.3.2 融合定案：唯一图标，颜色兼承状态），
    // 状态徽标（play-circle 等）不再单独渲染
    expect(container.querySelector('.goal-card__target .codicon-target')).not.toBeNull()
    expect(container.querySelector('.goal-card__status')).toBeNull()
    expect(container.querySelector('.goal-card__objective')?.textContent).toBe('重构登录页并保持测试通过')
    expect(container.querySelector('.goal-card__stats')?.textContent).toContain('2')
  })

  it('active 态显示 pause 按钮，点击发 goalManage pause', () => {
    useStore.setState({ goal: GOAL as never })
    const { container } = render(<GoalCard />)
    // actions 区常驻折叠钮，按图标精确定位 pause（0.3.2 新增折叠钮后不再"第一个非 clear"）
    const pauseBtn = container.querySelector('.goal-card__btn .codicon-debug-pause')?.closest('button') as HTMLButtonElement
    expect(pauseBtn).not.toBeNull()
    fireEvent.click(pauseBtn)
    expect(sentRequests.some((r) => r.op === 'goalManage' && r.action === 'pause')).toBe(true)
  })

  it('paused 态显示 resume 按钮', () => {
    useStore.setState({ goal: { ...GOAL, status: 'paused' } as never })
    const { container } = render(<GoalCard />)
    expect(container.querySelector('.goal-card--paused')).not.toBeNull()
    const resumeBtn = container.querySelector('.goal-card__btn .codicon-play')?.closest('button') as HTMLButtonElement
    expect(resumeBtn).not.toBeNull()
  })

  it('complete 态隐藏 pause/resume，clear 常驻（折叠钮常驻）', () => {
    useStore.setState({ goal: { ...GOAL, status: 'complete' } as never })
    const { container } = render(<GoalCard />)
    const btns = Array.from(container.querySelectorAll('.goal-card__btn'))
    expect(btns).toHaveLength(2)
    expect(btns.some((b) => b.classList.contains('goal-card__btn--clear'))).toBe(true)
  })

  it('verifying 态显示"校验中"指示（独立一行，置于卡片最后一行）', () => {
    useStore.setState({ goal: { ...GOAL, verifying: true } as never })
    const { container } = render(<GoalCard />)
    const verify = container.querySelector('.goal-card__verify')
    expect(verify).not.toBeNull()
    expect(verify?.textContent).toContain('校验中')
    // 校验行是主区最后一个子元素（不插在目标与统计中间，0.3.2 真机反馈）
    const main = container.querySelector('.goal-card__main')
    expect(main?.lastElementChild).toBe(verify)
  })

  it('非 verifying 态不显示校验指示', () => {
    useStore.setState({ goal: GOAL as never })
    const { container } = render(<GoalCard />)
    expect(container.querySelector('.goal-card__verify')).toBeNull()
  })

  it('轮中 token 加流式输出估算增量（active 且非校验间隙）', () => {
    // 服务端轮中零推送（diag 实测），本地按流式字符量粗估增量与耗时走秒对齐
    useStore.setState({
      goal: { ...GOAL, tokensUsed: 10000 } as never,
      streaming: true,
      streamingMessageId: 'm_stream',
      messages: [{
        info: { role: 'assistant', id: 'm_stream', time: { created: 1 } } as never,
        parts: [
          { type: 'text', text: 'a'.repeat(600) },
          { type: 'reasoning', text: 'b'.repeat(300) },
          { type: 'tool', callID: 'c1', tool: 'Read', state: { inputRaw: 'c'.repeat(600) } } as never,
        ],
      }],
    })
    const { container } = render(<GoalCard />)
    // (600 + 300 + 600/2) / 3 = 400 估算 → 10000 + 400 = 10.4k
    expect(container.querySelector('.goal-card__stats')?.textContent).toContain('10.4k')
  })

  it('校验间隙（verifying）不加估算（权威值已含本轮输出，避免双计）', () => {
    useStore.setState({
      goal: { ...GOAL, tokensUsed: 10000, verifying: true } as never,
      streaming: true,
      streamingMessageId: 'm_stream',
      messages: [{
        info: { role: 'assistant', id: 'm_stream', time: { created: 1 } } as never,
        parts: [{ type: 'text', text: 'a'.repeat(600) }],
      }],
    })
    const { container } = render(<GoalCard />)
    expect(container.querySelector('.goal-card__stats')?.textContent).toContain('10k')
    expect(container.querySelector('.goal-card__stats')?.textContent).not.toContain('10.2k')
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

  /* ============ 折叠（0.3.2 真机反馈：展开遮挡主界面消息；拖动因难控位置已移除） ============ */

  it('折叠钮收起为迷你条（靶子图标 + 轮次·用时），记忆走 persist', () => {
    useStore.setState({ goal: GOAL as never })
    const { container } = render(<GoalCard />)
    const collapseBtn = container.querySelector('.goal-card__btn .codicon-chevron-up')?.closest('button') as HTMLButtonElement
    expect(collapseBtn).not.toBeNull()
    fireEvent.click(collapseBtn)
    expect(container.querySelector('.goal-card--collapsed')).not.toBeNull()
    // 目标文本/统计/操作钮不再渲染；迷你条保留轮次与用时（GOAL: 2 轮 / 95s）
    expect(container.querySelector('.goal-card__objective')).toBeNull()
    expect(container.querySelector('.goal-card__actions')).toBeNull()
    const mini = container.querySelector('.goal-card__mini')
    expect(mini?.textContent).toContain('第 2 轮')
    expect(mini?.textContent).toContain('1m35s')
    expect(container.querySelector('.goal-card__target .codicon-target')).not.toBeNull()
    expect(window.localStorage.getItem('zcode.goalCardCollapsed')).toBe('1')
  })

  it('折叠态点击整条展开（记忆翻转）', () => {
    useStore.setState({ goal: GOAL as never })
    window.localStorage.setItem('zcode.goalCardCollapsed', '1')
    const { container } = render(<GoalCard />)
    expect(container.querySelector('.goal-card--collapsed')).not.toBeNull() // 记忆恢复折叠
    fireEvent.click(container.querySelector('.goal-card--collapsed') as HTMLElement)
    expect(container.querySelector('.goal-card--collapsed')).toBeNull()
    expect(container.querySelector('.goal-card__objective')).not.toBeNull()
    expect(window.localStorage.getItem('zcode.goalCardCollapsed')).toBe('0')
  })

  it('belowSearch 时悬浮容器下移避让搜索浮层', () => {
    useStore.setState({ goal: GOAL as never })
    const first = render(<GoalCard />)
    expect(first.container.querySelector('.goal-card-float--below-search')).toBeNull()
    first.unmount()
    const second = render(<GoalCard belowSearch />)
    expect(second.container.querySelector('.goal-card-float--below-search')).not.toBeNull()
  })

  it('i18n 文案存在（zh）', () => {
    expect(i18n.t('chat.goal.status.active', { lng: 'zh' })).toBe('目标进行中')
    expect(i18n.t('chat.goal.usageHint', { lng: 'zh' })).toContain('/goal')
    expect(i18n.t('chat.timeline.goalPassed', { lng: 'zh' })).toBe('目标校验通过')
  })
})
