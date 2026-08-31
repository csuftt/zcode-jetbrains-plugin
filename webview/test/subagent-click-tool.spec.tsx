/**
 * 子代理弹窗"点击工具后变空"复现测试（2026-08-31 用户实测缺陷）
 *
 * 用户操作：弹窗实时刷（v4 live）→ 点击一个工具卡展开 → 内容变空。
 * 本测试渲染弹窗（live 数据源，WebSearch 带真实量级搜索结果 output），
 * 执行点击展开动作，断言弹窗内容仍在（不白屏/不清空）。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

vi.mock('@/ipc/bridge', () => ({
  sendToJava: vi.fn(),
  onStreamBatch: () => () => {},
  onStreamEvent: () => () => {},
  onMessage: () => () => {},
  onDiagLog: () => () => {},
  getDiagLog: () => [],
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
}))

import '@/i18n/config'
import { SubagentDetailDialog } from '@/components/SubagentDetailDialog'
import { useStore } from '@/store/useStore'
import type { ZCodeMessage } from '@/types/messages'

const CHILD = 'sess_subagent_agent_test'

/** v4 归约形态的 live 消息：turn.started 建的 assistant 消息（id=服务端消息 id），工具带 inputRaw 流式残留 */
const LIVE_MSGS: ZCodeMessage[] = [
  {
    info: { id: 'msg_t1', sessionID: CHILD, role: 'assistant', time: { created: 1788151693000 } },
    parts: [
      { type: 'reasoning', text: '用户要 AI 新闻，先并行搜索两个角度', time: { start: 1, end: 2 } },
      { type: 'tool', callID: 'c1', tool: 'WebSearch', state: { status: 'completed', output: '搜索结果：1. [AI 模型发布](https://example.com/a?id=1&ref=x) …\n```json\n{"results": [1,2]}\n```', inputRaw: '{"query":"AI news 2026"}', time: { start: 1, end: 2 } } },
      { type: 'tool', callID: 'c2', tool: 'WebSearch', state: { status: 'completed', output: '结果2 <script>alert(1)</script> **加粗** _斜体_ | 表格 | 符号 |', input: { query: 'AI' }, time: { start: 1, end: 2 } } },
      { type: 'text', text: '以下是 3 条 AI 要闻：……（实时流累积的长文）' },
    ],
  },
]

beforeEach(() => {
  useStore.setState({
    subagentDetail: 'call_x1',
    agents: [{ callID: 'call_x1', childSessionId: CHILD, status: 'completed', description: '搜索任务' }],
    subagentActivities: [],
    subagents: [],
    childMessages: {},
    childLiveMessages: { [CHILD]: LIVE_MSGS },
    childMessagesLoading: false,
    childMessagesError: null,
    messages: [],
  })
})
afterEach(() => cleanup())

describe('弹窗点击工具后不变空', () => {
  it('live 源完成态不折叠正文（2026-08-31 变空缺陷回归）：text 与工具卡同屏', () => {
    const { container } = render(<SubagentDetailDialog />)
    // live 是单条大 assistant 消息：完成态（running=false）不得触发末条报告折叠
    expect(container.textContent).toContain('以下是 3 条 AI 要闻')
    // 工具卡也在（聚组/单卡与正文共存）
    expect(container.querySelectorAll('.tool-card').length).toBeGreaterThan(0)
  })

  it('展开 WebSearch 工具卡（含链接/json/HTML 片段的搜索 output）后内容仍在', () => {
    const { container } = render(<SubagentDetailDialog />)
    const before = container.textContent?.length ?? 0
    expect(before).toBeGreaterThan(50)

    // 点击第一个工具卡头部展开（用户操作："点击一个工具"）
    const cards = container.querySelectorAll('.tool-card__header')
    expect(cards.length).toBeGreaterThan(0)
    fireEvent.click(cards[0])

    // 展开后正文/其他工具卡仍在（React 渲染崩溃会整树卸载 → textContent 清零）
    const after = container.textContent?.length ?? 0
    expect(after).toBeGreaterThan(50)
    expect(container.textContent).toContain('以下是 3 条 AI 要闻')
  })

  it('live→transcript 源切换（合成收尾后拉权威转录）期间内容不闪空', () => {
    // 先渲染 live 源
    const { container, rerender } = render(<SubagentDetailDialog />)
    expect(container.textContent).toContain('以下是 3 条 AI 要闻')

    // 模拟 loading=true（拉权威转录中）+ display 仍走 live
    useStore.setState({ childMessagesLoading: true })
    rerender(<SubagentDetailDialog />)
    expect(container.textContent).toContain('以下是 3 条 AI 要闻')

    // 权威转录到达（真实结构：timeline + user + assistant 合并消息），display 切源
    const transcript: ZCodeMessage[] = [
      { info: { id: 'p1', sessionID: CHILD, role: 'assistant', time: { created: 1 } }, parts: [{ type: 'timeline', timelineType: 'session_start', display: 'separator' }] },
      { info: { id: 'u1', sessionID: CHILD, role: 'user', time: { created: 2 } }, parts: [{ type: 'text', text: '搜索 AI 新闻' }] },
      { info: { id: 'msg_t1', sessionID: CHILD, role: 'assistant', time: { created: 3, completed: 4 } }, parts: [
        { type: 'tool', callID: 'c1', tool: 'WebSearch', state: { status: 'completed', output: '结果1', time: { start: 1, end: 2 } } },
        { type: 'text', text: '以下是 3 条 AI 要闻（权威版）' },
      ] },
    ]
    useStore.setState({ childMessages: { [CHILD]: transcript }, childMessagesLoading: false })
    rerender(<SubagentDetailDialog />)
    // 切源后：弹窗不空——权威末条按产品规则折叠为报告入口行，工具卡仍在
    expect((container.textContent?.length ?? 0)).toBeGreaterThan(30)
    expect(container.textContent).toContain('网页搜索')
    expect(container.querySelectorAll('.tool-card').length).toBeGreaterThan(0)
  })

  it('权威转录完成态保留末条报告折叠（产品行为不变）', () => {
    const transcript: ZCodeMessage[] = [
      { info: { id: 'u1', sessionID: CHILD, role: 'user', time: { created: 2 } }, parts: [{ type: 'text', text: '搜索 AI 新闻' }] },
      { info: { id: 'msg_final', sessionID: CHILD, role: 'assistant', time: { created: 3 } }, parts: [
        { type: 'text', text: '最终报告全文内容很长'.repeat(20) },
      ] },
    ]
    useStore.setState({ childLiveMessages: {}, childMessages: { [CHILD]: transcript } })
    const { container } = render(<SubagentDetailDialog />)
    // 末条正文折叠为入口行（transcript 源 + 非运行中 → 折叠生效）
    expect(container.textContent).not.toContain('最终报告全文内容很长')
    expect(container.textContent).toContain('最终报告')
  })

  it('live 空壳消息不接管显示（中途打开弹窗防源跳变闪烁）', () => {
    // 场景：中途打开弹窗——transcript 快照（历史进度）在场，live 只有
    // turn.started 建的空壳 assistant 消息 → display 保持 transcript（不闪空）
    const transcript: ZCodeMessage[] = [
      { info: { id: 'u1', sessionID: CHILD, role: 'user', time: { created: 2 } }, parts: [{ type: 'text', text: '历史快照user输入标记' }] },
      { info: { id: 'a1', sessionID: CHILD, role: 'assistant', time: { created: 3 } }, parts: [
        { type: 'tool', callID: 'c0', tool: 'WebSearch', state: { status: 'completed', output: '已完成的部分', time: { start: 1, end: 2 } } },
      ] },
    ]
    const liveEmptyShell: ZCodeMessage[] = [
      { info: { id: 'msg_t1', sessionID: CHILD, role: 'assistant', time: { created: 99 } }, parts: [] },
    ]
    useStore.setState({
      agents: [{ callID: 'call_x1', childSessionId: CHILD, status: 'running', description: '搜索任务' }],
      childMessages: { [CHILD]: transcript },
      childLiveMessages: { [CHILD]: liveEmptyShell },
    })
    const { container } = render(<SubagentDetailDialog />)
    // 快照内容在场（未被空壳 live 顶掉）——user 气泡文本是 transcript 特有标记
    expect(container.textContent).toContain('历史快照user输入标记')

    // live 长出实质内容后接管（act 触发 zustand 订阅重渲染）：transcript 的
    // user 标记消失（display 已切到 live 源），live 的工具卡在场
    const liveGrowing: ZCodeMessage[] = [
      { info: { id: 'msg_t1', sessionID: CHILD, role: 'assistant', time: { created: 99 } }, parts: [
        { type: 'tool', callID: 'c1', tool: 'WebSearch', state: { status: 'running', time: { start: 99 } } },
      ] },
    ]
    act(() => {
      useStore.setState({ childLiveMessages: { [CHILD]: liveGrowing } })
    })
    expect(container.textContent).not.toContain('历史快照user输入标记')
    expect(container.querySelectorAll('.tool-card').length).toBeGreaterThan(0)
  })

  it('running→结束翻转自动重拉权威转录（结尾假转圈缺陷回归）', async () => {
    // 场景：v4 模式下快照只在打开时拉过一次，回合结束后旧快照里的工具卡
    // 停在 running（用户实测：标题"已完成"但列表假转圈，手动刷新才恢复）
    const { sendToJava } = await import('@/ipc/bridge')
    const sendMock = sendToJava as unknown as ReturnType<typeof vi.fn>
    vi.useFakeTimers()
    try {
      sendMock.mockClear()
      useStore.setState({
        agents: [{ callID: 'call_x1', childSessionId: CHILD, status: 'running', description: '搜索任务' }],
        childMessages: { [CHILD]: [{ info: { id: 'a1', sessionID: CHILD, role: 'assistant', time: { created: 3 } }, parts: [
          { type: 'tool', callID: 'c0', tool: 'WebSearch', state: { status: 'running', time: { start: 1 } } },
        ] }] },
        childLiveMessages: {},
      })
      const { rerender } = render(<SubagentDetailDialog />)
      // 打开时（running）的初始快照拉取先清零，只观测翻转行为
      sendMock.mockClear()

      // 翻转：running → completed（父会话收尾）
      act(() => {
        useStore.setState({ agents: [{ callID: 'call_x1', childSessionId: CHILD, status: 'completed', description: '搜索任务' }] })
      })
      rerender(<SubagentDetailDialog />)

      // 翻转沿立即重拉一次（非静默）
      let calls = sendMock.mock.calls.filter((c) => (c[0] as { op: string }).op === 'subagentMessages')
      expect(calls.length).toBe(1)

      // 1.5s 后静默补拉一次（服务端回合清算落库滞后，首拉可能拿到倒数第二步）
      act(() => { vi.advanceTimersByTime(1600) })
      calls = sendMock.mock.calls.filter((c) => (c[0] as { op: string }).op === 'subagentMessages')
      expect(calls.length).toBe(2)
      expect((calls[1][0] as { sessionId?: string }).sessionId).toBe(CHILD)
    } finally {
      vi.useRealTimers()
    }
  })

  it('滚动跳转按钮：滚轮显向、点击置顶/置底、内容不满一屏不显示', () => {
    // 长内容（溢出滚动场景）：几十个工具卡的过程列表
    const longLive: ZCodeMessage[] = [{
      info: { id: 'msg_t1', sessionID: CHILD, role: 'assistant', time: { created: 1 } },
      parts: [{ type: 'text', text: '过程内容'.repeat(200) }],
    }]
    useStore.setState({
      agents: [{ callID: 'call_x1', childSessionId: CHILD, status: 'running', description: '搜索任务' }],
      childLiveMessages: { [CHILD]: longLive },
      childMessages: {},
    })
    const { container } = render(<SubagentDetailDialog />)
    const body = container.querySelector<HTMLElement>('.subagent-detail-body')!
    expect(body).toBeTruthy()
    const scrollTo = vi.fn()
    Object.defineProperties(body, {
      scrollHeight: { value: 2000, configurable: true },
      clientHeight: { value: 500, configurable: true },
      scrollTop: { value: 0, writable: true, configurable: true },
    })
    Object.defineProperty(body, 'scrollTo', { value: scrollTo, configurable: true })

    const btn = () => container.querySelector<HTMLButtonElement>('.scroll-control-button')!
    expect(btn()).toBeTruthy()
    expect(btn().className).not.toContain('is-visible')

    // 滚轮下滑（远离底部）→ 显示 ↓ 置底按钮
    fireEvent.wheel(body, { deltaY: 120 })
    expect(btn().className).toContain('is-visible')
    expect(btn().querySelector('.codicon-arrow-down')).toBeTruthy()

    // 点击 → 置底 + 按钮隐藏
    fireEvent.click(btn())
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 2000 }))
    expect(btn().className).not.toContain('is-visible')

    // 滚轮上滑 → 显示 ↑ 置顶按钮；点击 → scrollTop=0
    fireEvent.wheel(body, { deltaY: -120 })
    expect(btn().querySelector('.codicon-arrow-up')).toBeTruthy()
    fireEvent.click(btn())
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }))

    // 内容不满一屏 → 滚轮不显示按钮
    Object.defineProperty(body, 'scrollHeight', { value: 400, configurable: true })
    fireEvent.wheel(body, { deltaY: 120 })
    expect(btn().className).not.toContain('is-visible')
  })

  it('在底部向上滑第一格即出 ↑ 按钮（wheel 先于 scroll 不被吞）', () => {
    const longLive: ZCodeMessage[] = [{
      info: { id: 'msg_t1', sessionID: CHILD, role: 'assistant', time: { created: 1 } },
      parts: [{ type: 'text', text: '长内容'.repeat(300) }],
    }]
    useStore.setState({
      agents: [{ callID: 'call_x1', childSessionId: CHILD, status: 'running', description: '搜索任务' }],
      childLiveMessages: { [CHILD]: longLive },
      childMessages: {},
    })
    const { container } = render(<SubagentDetailDialog />)
    const body = container.querySelector<HTMLElement>('.subagent-detail-body')!
    // 初始在底部（scrollTop = scrollHeight - clientHeight），第一格上滑就要出 ↑
    Object.defineProperties(body, {
      scrollHeight: { value: 2000, configurable: true },
      clientHeight: { value: 500, configurable: true },
      scrollTop: { value: 1500, writable: true, configurable: true },
    })
    const btn = () => container.querySelector<HTMLButtonElement>('.scroll-control-button')!
    fireEvent.wheel(body, { deltaY: -100 })
    expect(btn().className).toContain('is-visible')
    expect(btn().querySelector('.codicon-arrow-up')).toBeTruthy()
  })

  it('底部第一格上滑后的 scroll（离底仍 <80px）不打掉刚显示的 ↑', () => {
    const { container } = render(<SubagentDetailDialog />)
    const body = container.querySelector<HTMLElement>('.subagent-detail-body')!
    Object.defineProperties(body, {
      scrollHeight: { value: 2000, configurable: true },
      clientHeight: { value: 500, configurable: true },
      scrollTop: { value: 1500, writable: true, configurable: true },
    })
    const btn = () => container.querySelector<HTMLButtonElement>('.scroll-control-button')!
    // 滚轮上滑 → ↑ 显示
    fireEvent.wheel(body, { deltaY: -100 })
    expect(btn().className).toContain('is-visible')
    // 浏览器应用滚动：scrollTop 只减小 20px（离底 20px，仍在 80px 内）→ scroll 事件
    // 修复前：nb=true 会 setVisible(false) 把 ↑ 立即打掉（"出现即消失/滚几格才稳定"）
    body.scrollTop = 1480
    fireEvent.scroll(body)
    expect(btn().className).toContain('is-visible')
    expect(btn().querySelector('.codicon-arrow-up')).toBeTruthy()
  })

  it('上滑余震窗内的微抖下滑事件：不隐藏 ↑ 也不切向 ↓', () => {
    const { container } = render(<SubagentDetailDialog />)
    const body = container.querySelector<HTMLElement>('.subagent-detail-body')!
    Object.defineProperties(body, {
      scrollHeight: { value: 2000, configurable: true },
      clientHeight: { value: 500, configurable: true },
      scrollTop: { value: 1500, writable: true, configurable: true },
    })
    const btn = () => container.querySelector<HTMLButtonElement>('.scroll-control-button')!
    fireEvent.wheel(body, { deltaY: -100 })
    expect(btn().querySelector('.codicon-arrow-up')).toBeTruthy()
    // 触摸板/滚轮的惯性反向小事件（离底仍 <80px）
    // 修复前：setVisible(false) 隐藏 ↑；若不早退还会 setDirection('down') 把 ↑ 换成 ↓
    fireEvent.wheel(body, { deltaY: 40 })
    expect(btn().className).toContain('is-visible')
    expect(btn().querySelector('.codicon-arrow-up')).toBeTruthy()
  })

  it('失败收尾：末条残段不折叠为最终报告，显示失败提示条与错误详情', () => {
    const transcript: ZCodeMessage[] = [
      { info: { id: 'u1', sessionID: CHILD, role: 'user', time: { created: 2 } }, parts: [{ type: 'text', text: '搜索任务' }] },
      { info: { id: 'a1', sessionID: CHILD, role: 'assistant', time: { created: 3 } }, parts: [
        { type: 'text', text: '中断前的部分输出，不是最终报告' },
      ] },
    ]
    useStore.setState({
      agents: [{ callID: 'call_x1', childSessionId: CHILD, status: 'error', description: '搜索任务' }],
      childMessages: { [CHILD]: transcript },
      childLiveMessages: {},
      messages: [{
        info: { id: 'm1', sessionID: 'sess_main', role: 'assistant', time: { created: 1 } },
        parts: [{ type: 'tool', callID: 'call_x1', tool: 'Agent', state: { status: 'completed', output: 'Agent failed: 搜索超时退出' } }],
      } as never],
    })
    const { container } = render(<SubagentDetailDialog />)
    // 残段原样展示，不折叠成"最终报告已生成"（误报）
    expect(container.textContent).toContain('中断前的部分输出')
    expect(container.textContent).not.toContain('最终报告已生成')
    // 失败提示条 + Agent 工具 output 的错误详情
    expect(container.querySelector('.subagent-detail-failed')).toBeTruthy()
    expect(container.textContent).toContain('子代理执行失败')
    expect(container.textContent).toContain('搜索超时退出')
  })

  it('历史失败记录（无 childSessionId、part 只有 state.error 字符串）：失败条展示原因，不裸"暂无数据"', () => {
    // 2026-08-31 实测形态：失败的 Agent part status=error、无 output、只有 error 字符串
    //（[1301] 内容审查拦截）；session/subagents 的 ended 不收录失败子会话 →
    // childSessionId 无从获取 → 转录/工具列表全空，失败条是弹窗唯一内容
    useStore.setState({
      agents: [{ callID: 'call_x1', status: 'error', description: '搜索欧洲亚太政府新闻' }],
      childMessages: {},
      childLiveMessages: {},
      messages: [{
        info: { id: 'm1', sessionID: 'sess_main', role: 'assistant', time: { created: 1 } },
        parts: [{ type: 'tool', callID: 'call_x1', tool: 'Agent', state: { status: 'error', error: '[1301][系统检测到输入或生成内容可能包含不安全或敏感内容]' } }],
      } as never],
    })
    const { container } = render(<SubagentDetailDialog />)
    // 失败提示条 + state.error 的失败原因（历史读回字符串形态）
    expect(container.querySelector('.subagent-detail-failed')).toBeTruthy()
    expect(container.textContent).toContain('子代理执行失败')
    expect(container.textContent).toContain('1301')
    expect(container.textContent).toContain('不安全或敏感内容')
  })

  it('成功收尾保留末条报告折叠（产品行为不变）', () => {
    const transcript: ZCodeMessage[] = [
      { info: { id: 'u1', sessionID: CHILD, role: 'user', time: { created: 2 } }, parts: [{ type: 'text', text: '搜索任务' }] },
      { info: { id: 'a1', sessionID: CHILD, role: 'assistant', time: { created: 3 } }, parts: [
        { type: 'text', text: '这是完整的最终报告全文' },
      ] },
    ]
    useStore.setState({
      agents: [{ callID: 'call_x1', childSessionId: CHILD, status: 'completed', description: '搜索任务' }],
      childMessages: { [CHILD]: transcript },
      childLiveMessages: {},
      messages: [],
    })
    const { container } = render(<SubagentDetailDialog />)
    expect(container.textContent).not.toContain('这是完整的最终报告全文')
    expect(container.textContent).toContain('最终报告已生成')
    expect(container.querySelector('.subagent-detail-failed')).toBeNull()
  })
})
