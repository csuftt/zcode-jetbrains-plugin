/**
 * 批量命令组卡的后台任务标识（缺陷Y 体验增强）：连续 Bash 命令聚组渲染
 * BashCommandGroupCard（不走 ToolCallCard 单卡），组内每个后台任务行独立
 * 显示「后台运行中」徽标 + 真实运行时间；头部后台计数；doneCount 排除后台项
 *
 * 行为（2026-08-25）：
 *   - backgroundTasks[行 callID] 存在 → 该行徽标 + 计时，节点强调色
 *   - 头部显示「后台运行中 N 个」（覆盖「全部完成」误导）
 *   - 无后台任务 → 原 ✓/⟳/✗ 行角标与进度摘要
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('@/ipc/bridge', () => ({
  sendToJava: () => {},
}))

import '@/i18n/config'
import { useStore } from '@/store/useStore'
import { BashCommandGroupCard } from '@/components/BashCommandGroupCard'
import type { ToolPart } from '@/types/messages'

function bashPart(callID: string, command: string, status: ToolPart['state']['status'] = 'completed'): ToolPart {
  return {
    type: 'tool',
    callID,
    tool: 'Bash',
    state: {
      status,
      input: { command },
      output: '',
      time: { start: 1787283860000, end: 1787283860600 },
    },
  }
}

beforeEach(() => {
  useStore.setState({ backgroundTasks: {} })
})

afterEach(() => cleanup())

describe('BashCommandGroupCard 后台任务标识', () => {
  it('组内两行都匹配后台任务 → 各自徽标 + 独立计时 + 头部计数', () => {
    const now = Date.now()
    useStore.setState({
      backgroundTasks: {
        call_75: { id: 'exec_75', startedAt: now - 30000 },
        call_90: { id: 'exec_90', startedAt: now - 60000 },
      },
    })
    render(
      <BashCommandGroupCard
        parts={[bashPart('call_75', 'sleep 75'), bashPart('call_90', 'sleep 90')]}
      />,
    )
    // 头部：后台运行中 2 个
    expect(screen.getByText('后台运行中 2 个')).toBeTruthy()
    // 两行各自的徽标 + 独立计时（30 秒 / 60 秒→分钟格式；徽标与时间同一 span）。
    // 耗时按真实时间计算，setState 到渲染间流逝几十毫秒会把 30.0 变 30.x——按正则匹配
    expect(screen.getByText(/^后台运行中 30\.\d 秒$/)).toBeTruthy()
    expect(screen.getByText(/^后台运行中 1 分 0 秒$/)).toBeTruthy()
  })

  it('只一行匹配 → 该行徽标 + 计时，另一行保持 ✓，头部计数 1', () => {
    useStore.setState({
      backgroundTasks: { call_75: { id: 'exec_75', startedAt: Date.now() - 10000 } },
    })
    render(
      <BashCommandGroupCard
        parts={[bashPart('call_75', 'sleep 75'), bashPart('call_ok', 'echo done')]}
      />,
    )
    expect(screen.getByText('后台运行中 1 个')).toBeTruthy()
    expect(screen.getByText(/^后台运行中 10\.\d 秒$/)).toBeTruthy()
    expect(screen.getByText('✓')).toBeTruthy()
  })

  it('无后台任务 → 无徽标，正常进度摘要（全部完成）', () => {
    render(
      <BashCommandGroupCard
        parts={[bashPart('call_a', 'sleep 1'), bashPart('call_b', 'echo hi')]}
      />,
    )
    expect(screen.queryByText('后台运行中')).toBeNull()
    expect(screen.getByText('全部完成')).toBeTruthy()
  })

  it('后台任务完成通知（store 清除）→ 徽标消失、恢复 ✓ 与全部完成', () => {
    const now = Date.now()
    useStore.setState({
      backgroundTasks: { call_75: { id: 'exec_75', startedAt: now - 30000 } },
    })
    const { rerender } = render(
      <BashCommandGroupCard parts={[bashPart('call_75', 'sleep 75')]} />,
    )
    expect(screen.getByText('后台运行中 1 个')).toBeTruthy()
    // 任务完成：完成通知清除 store → 行恢复 ✓ + 全部完成
    useStore.setState({ backgroundTasks: {} })
    rerender(<BashCommandGroupCard parts={[bashPart('call_75', 'sleep 75')]} />)
    expect(screen.queryByText('后台运行中')).toBeNull()
    expect(screen.getByText('✓')).toBeTruthy()
    expect(screen.getByText('全部完成')).toBeTruthy()
  })

  it('part 已 completed 但后台任务存在 → 头部不显示「全部完成」（防误导）', () => {
    useStore.setState({
      backgroundTasks: { call_90: { id: 'exec_90', startedAt: Date.now() - 5000 } },
    })
    render(
      <BashCommandGroupCard
        parts={[bashPart('call_75', 'sleep 75'), bashPart('call_90', 'sleep 90', 'completed')]}
      />,
    )
    // 后台化确认 result 已回（part=completed）但任务仍在后台跑：头部显示后台计数而非全部完成
    expect(screen.getByText('后台运行中 1 个')).toBeTruthy()
    expect(screen.queryByText('全部完成')).toBeNull()
  })

  it('任务已完成（endedAt）→ 行内「后台完成」定格耗时 + 头部计数消失 + 恢复全部完成', () => {
    const now = Date.now()
    useStore.setState({
      backgroundTasks: { call_90: { id: 'exec_90', startedAt: now - 90000, endedAt: now - 30000 } },
    })
    render(
      <BashCommandGroupCard
        parts={[bashPart('call_75', 'sleep 75'), bashPart('call_90', 'sleep 90', 'completed')]}
      />,
    )
    // 已完成：行内显示「后台完成 1 分 0 秒」定格耗时（60s）
    expect(screen.getByText('后台完成 1 分 0 秒')).toBeTruthy()
    expect(screen.queryByText('后台运行中')).toBeNull()
    // 头部：不再有后台计数；doneCount 算上已完成的后台任务 → 全部完成
    expect(screen.queryByText('后台运行中 1 个')).toBeNull()
    expect(screen.getByText('全部完成')).toBeTruthy()
  })

  it('历史消息（账本为空）：行输出含官方后台化确认 → 行内静态「后台完成」徽标（无耗时）', () => {
    // 会话重载/重装后账本为空（2026-08-26 持久化标识需求），从行输出静态识别
    const parts = [bashPart('call_g_1', 'sleep 60'), bashPart('call_g_2', 'echo done')]
    parts[0].state.output = 'Command running in background with ID: exec_9b4d2e6f-1a3c-4e5b-8f7a-2c6d0e1f3a5b. Output is being written to: C:\\Users\\...\\stdout.log. You will be notified when it completes.'
    render(<BashCommandGroupCard parts={parts} />)
    // 行内静态徽标（无耗时）
    expect(screen.getByText('后台完成')).toBeTruthy()
    expect(screen.queryByText(/秒|分/)).toBeNull()
    // 头部不出现「后台运行中 N 个」（静态已完成任务不计运行中）；全部完成摘要正常
    expect(screen.queryByText(/后台运行中 \d+ 个/)).toBeNull()
    expect(screen.getByText('全部完成')).toBeTruthy()
    // 非后台行正常 ✓
    expect(screen.getAllByText('✓').length).toBeGreaterThanOrEqual(1)
  })

  it('历史消息：行输出含注释形态（exec_xxx 占位）→ 不显示后台标识（缺陷Z 变体防御）', () => {
    const parts = [bashPart('call_g_3', 'grep useStore'), bashPart('call_g_4', 'echo ok')]
    parts[0].state.output = '2505: *  `Command running in background with ID: exec_xxx.` /'
    render(<BashCommandGroupCard parts={parts} />)
    expect(screen.queryByText('后台完成')).toBeNull()
    expect(screen.queryByText(/后台运行中/)).toBeNull()
  })
})
