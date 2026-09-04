/**
 * 子代理弹窗 timeline marker 消息渲染回归测试（2026-09-02 缺陷）
 *
 * 现象：完成后权威快照（resume + session/messages）首条是 CLI 创建子会话时
 * 写入的 timeline marker（model_change 仅 toModel 无 fromModel，"以模型 X 开始"
 * 固有标记）；v4 实时流不含它——弹窗渲染该消息时只剩空 "AI" 角色行（timeline
 * part 不被 Transcript 认识），live 与快照两源不一致。
 *
 * 修复：Transcript 消息级分流（对齐主界面 MessageBubble）——
 *   1. 无 fromModel 的 model_change（创建固有标记）→ 整条跳过（与 live 一致）
 *   2. 其余 timeline（context_compaction / 带 from 的真实切换）→ TimelineSeparator 横线卡
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

const CHILD_SID = 'sess_subagent_agent_tl'

/** 完成态快照：首条 = 创建固有 model_change 标记（无 fromModel），中途 = 压缩标记 */
const SNAPSHOT_MSGS: ZCodeMessage[] = [
  {
    info: { id: 'm0', sessionID: CHILD_SID, role: 'assistant', time: { created: 1788148526000 } },
    parts: [{
      type: 'timeline',
      timelineType: 'model_change',
      toModel: { modelId: 'GLM-5.3-Flash', label: 'builtin:bigmodel-coding-plan/GLM-5.3-Flash' },
    }],
  },
  {
    info: { id: 'm1', sessionID: CHILD_SID, role: 'user', time: { created: 1788148526001 } },
    parts: [{ type: 'text', text: '读取 sample.txt 并转告' }],
  },
  {
    info: { id: 'm2', sessionID: CHILD_SID, role: 'assistant', time: { created: 1788148526100 } },
    parts: [{ type: 'text', text: '文件内容是 **hello**' }],
  },
  {
    info: { id: 'm3', sessionID: CHILD_SID, role: 'assistant', time: { created: 1788148530000 } },
    parts: [{
      type: 'timeline',
      timelineType: 'context_compaction',
      preCompactTokenCount: 287247,
      truePostCompactTokenCount: 15751,
    }],
  },
]

beforeEach(() => {
  useStore.setState({
    subagentDetail: 'call_tl',
    agents: [{ callID: 'call_tl', childSessionId: CHILD_SID, status: 'completed', description: '测试任务' }],
    subagentActivities: [],
    subagents: [],
    childMessages: { [CHILD_SID]: SNAPSHOT_MSGS },
    childLiveMessages: {},
    childMessagesLoading: false,
    childMessagesError: null,
    messages: [],
  })
})
afterEach(() => cleanup())

describe('子代理弹窗 timeline marker 分流', () => {
  it('创建固有的 model_change 标记（无 fromModel）不渲染：无空 AI 行', () => {
    const { container } = render(<SubagentDetailDialog />)
    // 首条整条跳过：只剩 user「任务」+ assistant 一条 → 两条角色行，第一条是「任务」
    const roles = [...container.querySelectorAll('.subagent-detail-msg-role')].map((el) => el.textContent)
    expect(roles).toHaveLength(2)
    expect(roles[0]).not.toBe('AI')
  })

  it('中途 context_compaction 渲染为横线分隔卡（过程信息不丢）', () => {
    const { container } = render(<SubagentDetailDialog />)
    const seps = container.querySelectorAll('.tl-sep')
    expect(seps).toHaveLength(1)
  })

  it('带 fromModel 的真实模型切换渲染横线卡并显示 from → to', () => {
    useStore.setState({
      childMessages: {
        [CHILD_SID]: [
          ...SNAPSHOT_MSGS,
          {
            info: { id: 'm4', sessionID: CHILD_SID, role: 'assistant', time: { created: 1788148540000 } },
            parts: [{
              type: 'timeline',
              timelineType: 'model_change',
              fromModel: { modelId: 'GLM-5.3-Flash', label: 'builtin/GLM-5.3-Flash' },
              toModel: { modelId: 'GLM-5.2', label: 'builtin/GLM-5.2' },
            }],
          },
        ],
      },
    })
    const { container } = render(<SubagentDetailDialog />)
    const metas = [...container.querySelectorAll('.tl-sep__meta')].map((el) => el.textContent)
    expect(metas).toContain('GLM-5.3-Flash → GLM-5.2')
  })
})
