/**
 * 编辑场景（Write/Edit 后重读）弹窗实时渲染复现测试（2026-09-01 用户实测）
 *
 * 用户场景：子代理执行 Write/Edit/Edit/Read（重读被拒后重试）文件任务，流式
 * 期间弹窗实时渲染显示"子代理执行失败"，子代理真正执行完后刷新为成功。
 *
 * 复现素材（diag-v4-subagent-*.py 四轮协议级复现 + idea.log 时间线还原）：
 * - v4 帧/转发流/RPC/rollout/权威 transcript 全部无活动级失败信号；
 * - 编辑场景特有：Write/Edit 后重读同一文件触发 zcode.cjs 拦截——重试链路上
 *   可能出现 error 工具（不落权威 transcript，实时流可见）与 "Wasted call"
 *   （success=true，落 transcript）两种形态；
 * - 本测试把两种形态都灌进 live 流与活动，锁定软化行为：running 期间组卡 error
 *   降级「↻ 重试中」（不再红色 ✗ 误导），活动收尾后恢复 ✗ 保留失败事实，
 *   权威转录替换后失败痕迹消失（与"执行完刷新为成功"的既有观感一致）。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

vi.mock('@/ipc/bridge', () => ({
  sendToJava: () => {},
}))

import '@/i18n/config'
import { SubagentDetailDialog } from '@/components/SubagentDetailDialog'
import { useStore } from '@/store/useStore'
import type { ZCodeMessage } from '@/types/messages'

const CHILD_SID = 'sess_subagent_agent_edit'

/** 编辑场景 live 流：Write → Edit×2 → Read#1(error) → Read#2(Wasted call) → 报告 */
const EDIT_LIVE: ZCodeMessage[] = [
  {
    info: { id: 'u1', sessionID: CHILD_SID, role: 'user', time: { created: 1 } },
    parts: [{ type: 'text', text: '创建并编辑 demo.txt' }],
  },
  {
    info: { id: 'a1', sessionID: CHILD_SID, role: 'assistant', time: { created: 2 } },
    parts: [
      { type: 'tool', callID: 'tw', tool: 'Write', state: { status: 'completed', output: 'File created', time: { start: 1, end: 2 } } },
      { type: 'tool', callID: 'te1', tool: 'Edit', state: { status: 'completed', output: 'updated', time: { start: 1, end: 2 } } },
      { type: 'tool', callID: 'te2', tool: 'Edit', state: { status: 'completed', output: 'updated', time: { start: 1, end: 2 } } },
      // Read#1：本地拦截/瞬时失败（error 形态——不落权威 transcript，live 可见）
      { type: 'tool', callID: 'tr1', tool: 'Read', state: { status: 'error', error: { message: 'file state is current' }, time: { start: 1, end: 2 } } },
      // Read#2：Wasted call（success 形态，落 transcript）
      { type: 'tool', callID: 'tr2', tool: 'Read', state: { status: 'completed', output: 'Wasted call — file unchanged', time: { start: 1, end: 2 } } },
      { type: 'text', text: '任务完成，报告文件内容。' },
    ],
  },
]

beforeEach(() => {
  useStore.setState({
    subagentDetail: 'call_edit',
    agents: [{ callID: 'call_edit', childSessionId: CHILD_SID, status: 'running', description: '编辑任务' }],
    subagentActivities: [],
    subagents: [],
    childMessages: {},
    childLiveMessages: { [CHILD_SID]: EDIT_LIVE },
    childMessagesLoading: false,
    childMessagesError: null,
    messages: [],
  })
})
afterEach(() => cleanup())

describe('编辑场景弹窗实时渲染（running 期间的失败痕迹软化）', () => {
  it('live 流含 error Read 且活动 running：组卡渲染 ↻ 重试中中性样式（不再红色 ✗）', () => {
    const { container } = render(<SubagentDetailDialog />)
    // Write/Edit/Read 全部进 file 组卡
    const fileGroup = container.querySelector('.file-group')
    expect(fileGroup).toBeTruthy()
    // 修复行为：running 期间 error 降级为 retry（静态 ↻，中性色），无红色 error 标记
    const retryMarks = container.querySelectorAll('.bash-group__status--retry')
    const errMarks = container.querySelectorAll('.bash-group__status--error')
    expect(retryMarks.length).toBe(1)
    expect(errMarks.length).toBe(0)
    expect(retryMarks[0]!.textContent?.trim()).toBe('↻')
  })

  it('活动收尾后（running=false）live 仍含 error Read：恢复红色 ✗ 保留失败事实', () => {
    // 活动已结束但 display 仍取 live（无权威转录时的窗口）——error 应恢复 ✗
    useStore.setState({
      agents: [{ callID: 'call_edit', childSessionId: CHILD_SID, status: 'completed', description: '编辑任务' }],
      childMessages: {},
    })
    const { container } = render(<SubagentDetailDialog />)
    expect(container.querySelectorAll('.bash-group__status--error').length).toBe(1)
    expect(container.querySelectorAll('.bash-group__status--retry').length).toBe(0)
  })

  it('活动级状态 running：失败提示条（.subagent-detail-failed）不得出现', () => {
    const { container } = render(<SubagentDetailDialog />)
    // 活动级仍 running——整任务失败条不应渲染
    expect(container.querySelector('.subagent-detail-failed')).toBeNull()
  })

  it('权威替换后（transcript 无 error Read）：失败痕迹消失（对应用户"执行完刷新为成功"）', () => {
    // 活动收尾 + 权威转录到达（只有成功的 4 工具，error Read 不落库）
    useStore.setState({
      agents: [{ callID: 'call_edit', childSessionId: CHILD_SID, status: 'completed', description: '编辑任务' }],
      childMessages: {
        [CHILD_SID]: [
          {
            info: { id: 'u1', sessionID: CHILD_SID, role: 'user', time: { created: 1 } },
            parts: [{ type: 'text', text: '创建并编辑 demo.txt' }],
          },
          {
            info: { id: 'a1', sessionID: CHILD_SID, role: 'assistant', time: { created: 2 } },
            parts: [
              { type: 'tool', callID: 'tw', tool: 'Write', state: { status: 'completed', output: 'File created', time: { start: 1, end: 2 } } },
              { type: 'tool', callID: 'te1', tool: 'Edit', state: { status: 'completed', output: 'updated', time: { start: 1, end: 2 } } },
              { type: 'tool', callID: 'te2', tool: 'Edit', state: { status: 'completed', output: 'updated', time: { start: 1, end: 2 } } },
              { type: 'tool', callID: 'tr2', tool: 'Read', state: { status: 'completed', output: 'ok', time: { start: 1, end: 2 } } },
              { type: 'text', text: '任务完成，报告文件内容。' },
            ],
          },
        ],
      },
    })
    const { container } = render(<SubagentDetailDialog />)
    const errMarks = container.querySelectorAll('[class*="status--error"], [class*="--error"]')
    expect(errMarks.length).toBe(0)
    expect(container.querySelector('.subagent-detail-failed')).toBeNull()
  })
})
