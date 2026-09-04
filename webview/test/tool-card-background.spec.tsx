/**
 * 工具卡后台任务标识（缺陷Y 体验增强）：Bash 工具卡在 backgroundTasks 匹配时
 * 显示「后台运行中」徽标 + 真实运行时间（秒级跳动，不受回合结束影响）
 *
 * 行为（2026-08-25）：
 *   - backgroundTasks[卡片 callID] 存在且 tool=Bash → 显示后台徽标 + 运行时间
 *   - callID 不匹配 → 普通状态徽标（✓/⟳/✗）
 *   - 非 Bash 工具卡不显示后台标识（后台化只有 Bash 产出）
 *   - 并发多任务：各卡片按各自 callID 独立匹配
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('@/ipc/bridge', () => ({
  sendToJava: () => {},
}))

import '@/i18n/config'
import { useStore } from '@/store/useStore'
import { ToolCallCard } from '@/components/ToolCallCard'
import type { ToolPart } from '@/types/messages'

function bashPart(callID: string, status: 'pending' | 'running' | 'completed' | 'error' = 'completed'): ToolPart {
  return {
    type: 'tool',
    callID,
    tool: 'Bash',
    state: {
      status,
      input: { command: 'sleep 90' },
      output: '',
      time: { start: 1787283860000, end: 1787283860600 },
    },
  }
}

beforeEach(() => {
  useStore.setState({ backgroundTasks: {} })
})

afterEach(() => cleanup())

describe('ToolCallCard 后台任务标识', () => {
  it('toolCallId 匹配 → 显示「后台运行中」徽标 + 运行时间', () => {
    const startedAt = Date.now() - 45000 // 已运行 45 秒
    useStore.setState({ backgroundTasks: { call_bg_1: { id: 'exec_bg_1', startedAt } } })
    render(<ToolCallCard part={bashPart('call_bg_1')} />)
    expect(screen.getByText('后台运行中')).toBeTruthy()
    // 45 秒运行时间（formatToolDuration 秒格式：{{count}} 秒）；
    // 小数位放宽（render 与 Date.now 间的毫秒差，慢机不误伤）
    expect(screen.getByText(/45\.\d+ 秒/)).toBeTruthy()
  })

  it('toolCallId 不匹配 → 不显示后台徽标（普通状态徽标）', () => {
    useStore.setState({ backgroundTasks: { call_other: { id: 'exec_bg_1', startedAt: Date.now() } } })
    render(<ToolCallCard part={bashPart('call_bg_1')} />)
    expect(screen.queryByText('后台运行中')).toBeNull()
    // 完成态显示 ✓ 徽标
    expect(screen.getByText('✓')).toBeTruthy()
  })

  it('无后台任务状态 → 普通徽标', () => {
    render(<ToolCallCard part={bashPart('call_bg_1', 'running')} />)
    expect(screen.queryByText('后台运行中')).toBeNull()
    expect(screen.getByText('⟳')).toBeTruthy()
  })

  it('非 Bash 工具卡（toolCallId 相同）→ 不显示后台标识', () => {
    useStore.setState({ backgroundTasks: { call_bg_1: { id: 'exec_bg_1', startedAt: Date.now() } } })
    const readPart: ToolPart = {
      type: 'tool',
      callID: 'call_bg_1',
      tool: 'Read',
      state: { status: 'completed', input: { file_path: 'a.txt' }, output: '', time: { start: 1, end: 2 } },
    }
    render(<ToolCallCard part={readPart} />)
    expect(screen.queryByText('后台运行中')).toBeNull()
  })

  it('并发双任务：两张卡片各自匹配自己的任务 → 都显示后台徽标', () => {
    const now = Date.now()
    useStore.setState({
      backgroundTasks: {
        call_sleep_75: { id: 'exec_d1c1ab12-efa3-4dd7-a2ad-507ce573d029', startedAt: now - 30000 },
        call_sleep_90: { id: 'exec_c23b0a69-fd83-4f56-b519-366d89a13e5b', startedAt: now - 60000 },
      },
    })
    render(
      <>
        <ToolCallCard part={bashPart('call_sleep_75')} />
        <ToolCallCard part={bashPart('call_sleep_90')} />
      </>,
    )
    // 两张卡片各自显示「后台运行中」，计时各不相同（30 秒 / 60 秒→分钟格式）
    expect(screen.getAllByText('后台运行中')).toHaveLength(2)
    expect(screen.getByText(/30\.0 秒/)).toBeTruthy()
    expect(screen.getByText(/1 分 0 秒/)).toBeTruthy()
  })

  it('任务已完成（endedAt）→ 保留「后台完成」标识 + 定格耗时（不再跳动）', () => {
    const now = Date.now()
    // 已运行 90 秒后完成：定格显示 1 分 0 秒（60s 耗时）
    useStore.setState({
      backgroundTasks: {
        call_bg_1: { id: 'exec_bg_1', startedAt: now - 90000, endedAt: now - 30000 },
      },
    })
    render(<ToolCallCard part={bashPart('call_bg_1')} />)
    expect(screen.getByText('后台完成')).toBeTruthy()
    expect(screen.getByText(/1 分 0 秒/)).toBeTruthy()
    expect(screen.queryByText('后台运行中')).toBeNull()
  })

  it('历史消息（账本为空）：输出含官方后台化确认 → 静态「后台完成」徽标（无耗时）', () => {
    // 会话重载/重装后账本为空（2026-08-26 持久化标识需求），从 part 输出静态识别
    const part = bashPart('call_hist_1')
    part.state.output = 'Command running in background with ID: exec_9b4d2e6f-1a3c-4e5b-8f7a-2c6d0e1f3a5b. Output is being written to: C:\\Users\\...\\stdout.log. You will be notified when it completes.'
    render(<ToolCallCard part={part} />)
    expect(screen.getByText('后台完成')).toBeTruthy()
    expect(screen.queryByText('后台运行中')).toBeNull()
    // 静态标识不计时（startedAt 不可考）：无耗时文本
    expect(screen.queryByText(/秒|分/)).toBeNull()
  })

  it('历史消息：输出含注释形态（exec_xxx 占位）→ 不显示后台标识（缺陷Z 变体防御）', () => {
    const part = bashPart('call_hist_2')
    part.state.output = '2505: *  `Command running in background with ID: exec_xxx.` /'
    render(<ToolCallCard part={part} />)
    expect(screen.queryByText('后台完成')).toBeNull()
    expect(screen.queryByText('后台运行中')).toBeNull()
    expect(screen.getByText('✓')).toBeTruthy()
  })

  it('账本与历史静态并存：账本优先（运行中 → 跳秒，不显示静态完成）', () => {
    const part = bashPart('call_hist_3')
    part.state.output = 'Command running in background with ID: exec_9b4d2e6f-1a3c-4e5b-8f7a-2c6d0e1f3a5b. You will be notified when it completes.'
    useStore.setState({
      backgroundTasks: { call_hist_3: { id: 'exec_9b4d2e6f-1a3c-4e5b-8f7a-2c6d0e1f3a5b', startedAt: Date.now() - 30000 } },
    })
    render(<ToolCallCard part={part} />)
    expect(screen.getByText('后台运行中')).toBeTruthy()
    expect(screen.queryByText('后台完成')).toBeNull()
  })
})
