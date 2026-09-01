/**
 * /compact 压缩消息渲染分流回归测试（2026-08-21 缺陷 C2/C3）
 *
 * 复现缺陷（RPC 实测结构）：
 *   - 摘要消息（role=user + info.summary，消息级无 synthetic）穿透
 *     isHiddenSyntheticMessage → 整段 8k+ 字符渲染成右对齐用户气泡
 *   - marker 消息（assistant + timeline/compaction part）的 part 类型不被
 *     PartRenderer 识别 → 空壳气泡（只有 footer 时间/耗时）
 *
 * 断言：
 *   1. 摘要消息 → CompactionSummaryCard（单行卡，非用户气泡），点击弹窗看正文
 *   2. marker 消息 → TimelineSeparator（context_compaction 带 token 收缩文案）
 *   3. model_change marker → 模型切换分隔卡（顺带修复的空壳场景）
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('@/ipc/bridge', () => ({
  sendToJava: () => {},
}))

import '@/i18n/config'
import { MessageBubble } from '@/components/MessageBubble'
import type { ZCodeMessage } from '@/types/messages'

const SUMMARY_MSG: ZCodeMessage = {
  info: {
    id: 'm_sum', sessionID: 's1', role: 'user', time: { created: 1787283860314 },
    summary: { title: 'Compact summary', body: '## 摘要正文\n之前的对话完成了 0.2.2 发布。' },
  },
  parts: [
    { type: 'text', text: 'This session is being continued…', synthetic: true },
    { type: 'compaction', auto: false, trigger: 'manual', compactBoundary: { summarizedMessageCount: 473, keptMessageCount: 0 } },
  ],
}

const COMPACT_MARKER_MSG: ZCodeMessage = {
  info: {
    id: 'm_marker', sessionID: 's1', role: 'assistant',
    time: { created: 1787283795052, completed: 1787283860400 },
    semantics: { origin: 'system', kind: 'timeline_event', uiVisibility: 'visible' },
  },
  parts: [
    { type: 'timeline', timelineType: 'context_compaction', display: 'separator', status: 'completed', preCompactTokenCount: 287247, truePostCompactTokenCount: 15751 },
    { type: 'compaction', auto: false, trigger: 'manual' },
  ],
}

const MODEL_MARKER_MSG: ZCodeMessage = {
  info: { id: 'm_model', sessionID: 's1', role: 'assistant', time: { created: 1 }, semantics: { kind: 'timeline_event' } },
  parts: [
    { type: 'timeline', timelineType: 'model_change', display: 'separator', fromModel: { label: 'GLM-5.3' }, toModel: { label: 'GLM-5.3', variant: 'max' } },
  ],
}

beforeEach(() => { vi.useRealTimers() })
afterEach(() => cleanup())

describe('压缩摘要消息渲染（缺陷 C2）', () => {
  it('渲染为单行卡而非用户气泡：标题 + 被摘要消息数，正文默认不渲染', () => {
    const { container } = render(<MessageBubble message={SUMMARY_MSG} />)
    // 折叠卡类名（非 msg--user 用户气泡）
    expect(container.querySelector('.compact-card')).toBeTruthy()
    expect(container.querySelector('.msg--user')).toBeFalsy()
    // 标题与元信息（boundary.summarizedMessageCount）
    expect(screen.getByText('上下文已压缩')).toBeTruthy()
    expect(screen.getByText('473 条消息已摘要')).toBeTruthy()
    // 正文默认折叠
    expect(screen.queryByText(/摘要正文/)).toBeNull()
  })

  it('点击头部弹出全文弹窗（markdown 渲染，Esc 关闭）', () => {
    render(<MessageBubble message={SUMMARY_MSG} />)
    fireEvent.click(screen.getByRole('button'))
    // 弹窗（portal 挂 body）出现，正文在弹窗内 markdown 渲染
    expect(document.querySelector('.subagent-detail-overlay')).toBeTruthy()
    expect(screen.getByText(/之前的对话完成了 0.2.2 发布/)).toBeTruthy()
    // Esc 关闭，正文随之消失
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.querySelector('.subagent-detail-overlay')).toBeFalsy()
    expect(screen.queryByText(/之前的对话完成了 0.2.2 发布/)).toBeNull()
  })
})

describe('时间线分隔卡渲染（缺陷 C3）', () => {
  it('context_compaction marker → 分隔卡带 token 收缩，不再空壳', () => {
    const { container } = render(<MessageBubble message={COMPACT_MARKER_MSG} />)
    expect(container.querySelector('.tl-sep')).toBeTruthy()
    // 空壳气泡的 footer（耗时行）不应出现
    expect(container.querySelector('.msg__footer')).toBeFalsy()
    expect(screen.getByText(/287\.2k → 15\.8k tokens/)).toBeTruthy()
  })

  it('model_change marker → 模型切换分隔卡', () => {
    render(<MessageBubble message={MODEL_MARKER_MSG} />)
    expect(screen.getByText('模型已切换')).toBeTruthy()
    expect(screen.getByText(/GLM-5.3 → GLM-5.3/)).toBeTruthy()
  })
})
