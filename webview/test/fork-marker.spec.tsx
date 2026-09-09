/**
 * 分叉标记与分叉入口测试（2026-09-05，B2 回退体系一期；同日迭代：入口移至 assistant
 * 回复 footer「已工作」行 + ConfirmDialog 二次确认）
 *
 * 协议事实（diag-fork2.py 实测）：session/fork 的新会话里，服务端插一条 assistant
 * 空消息，唯一 part 是 timeline（timelineType=session_fork，带 parentSessionId/
 * targetMessageId）；另有 synthetic fork_notice 用户消息（uiVisibility=hidden）由
 * isHiddenSyntheticMessage 既有过滤隐藏，不进消息流。
 *
 * 入口定案（用户反馈）：fork 锚点是已完成的回复（保留到该回复含），入口在 assistant
 * 消息 footer 行；user 消息无分叉按钮；点击走 ConfirmDialog 二次确认防误点。
 *
 * 覆盖：
 * 1. session_fork timeline part → 专卡渲染（git-branch 图标 + 「已从父会话分叉」）
 * 2. synthetic fork_notice 用户消息判隐藏（isHiddenSyntheticMessage）
 * 3. assistant 完成回复：footer 有分叉按钮 → 点击弹确认 → 确认后 forkBusy 置位
 * 4. 流式中/乐观 assistant 消息：无分叉按钮
 * 5. user 消息：无分叉按钮（入口不在用户消息上）
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getInitialSessionId: () => '',
  onMessage: () => {},
  onStreamEvent: () => {},
  onStreamBatch: () => {},
  sendToJava: () => {},
}))

import '@/i18n/config'
import { MessageBubble } from '@/components/MessageBubble'
import { isHiddenSyntheticMessage } from '@/utils/parseNotification'
import { useStore } from '@/store/useStore'
import type { ZCodeMessage } from '@/types/messages'

Object.defineProperty(window, 'localStorage', {
  value: {
    getItem: () => null, setItem: () => {}, removeItem: () => {},
    clear: () => {}, get length() { return 0 }, key: () => null,
  },
  configurable: true,
  writable: true,
})

const SID = 'sess_fork_ui'
const PARENT = 'sess_parent_12345678'

// diag-fork2.py ① 抓包同构：fork 新会话快照里的分叉标记消息
const forkSeparator: ZCodeMessage = {
  info: {
    role: 'assistant', time: { created: 10, completed: 10 }, id: 'msg_fork_marker', sessionID: SID,
    semantics: { origin: 'system', kind: 'timeline_event' } as never,
  },
  parts: [{
    type: 'timeline', timelineType: 'session_fork', display: 'separator', status: 'completed',
    parentSessionId: PARENT, targetMessageId: 'msg_target_b', restoredFileCount: 0,
    id: 'part_fork_timeline', messageID: 'msg_fork_marker',
  } as never],
}
const forkNotice: ZCodeMessage = {
  info: {
    role: 'user', time: { created: 11 }, id: 'msg_fork_notice', sessionID: SID,
    synthetic: true, source: 'fork', visibility: 'model-only',
  },
  parts: [{ type: 'text', text: 'This session was forked from a previous session message.' }],
}
const danglingUser: ZCodeMessage = {
  info: { role: 'user', time: { created: 9 }, id: 'msg_target_b', sessionID: SID },
  parts: [{ type: 'text', text: '只回复 B' }],
}
// 已完成的 assistant 回复（分叉锚点）
const completedReply: ZCodeMessage = {
  info: {
    role: 'assistant', time: { created: 20, completed: 21 }, id: 'msg_reply_b', sessionID: SID,
    tokens: { input: 100, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
  },
  parts: [{ type: 'text', text: 'B' }],
}

beforeEach(() => {
  vi.clearAllMocks()
  useStore.getState().init()
  useStore.setState({ currentSessionId: SID, streaming: false, forkBusy: false })
})
afterEach(cleanup)

describe('分叉标记渲染', () => {
  it('session_fork timeline part 渲染专卡（不走中性兜底）', () => {
    const r = render(<MessageBubble message={forkSeparator} />)
    expect(r.container.querySelector('.codicon-git-branch')).not.toBeNull()
    expect(r.container.textContent).toContain('已从父会话分叉')
    expect(r.container.textContent).not.toContain('时间线事件')
  })

  it('synthetic fork_notice 消息判隐藏（isHiddenSyntheticMessage，store 管线应用）', () => {
    expect(isHiddenSyntheticMessage(forkNotice.info)).toBe(true)
    // 对照：真实用户消息不被隐藏
    expect(isHiddenSyntheticMessage(danglingUser.info)).toBe(false)
  })
})

describe('分叉入口（assistant 回复 footer）', () => {
  it('完成的回复 footer 有分叉按钮；点击弹确认，确认后 forkBusy 置位', () => {
    const r = render(<MessageBubble message={completedReply} />)
    const forkBtn = r.container.querySelector('.msg__footer-fork') as HTMLButtonElement
    expect(forkBtn).not.toBeNull()
    expect(useStore.getState().forkBusy).toBe(false)
    // 二次确认：先弹窗，不直接分叉
    fireEvent.click(forkBtn)
    expect(r.container.querySelector('.modal-overlay')).not.toBeNull()
    expect(useStore.getState().forkBusy).toBe(false)
    // 确认 → forkFromMessage → forkBusy 置位（sendToJava 已 mock）
    const confirmBtn = Array.from(r.container.querySelectorAll('.modal-actions .modal-btn'))
      .find((b) => b.textContent === '分叉') as HTMLButtonElement
    expect(confirmBtn).toBeDefined()
    fireEvent.click(confirmBtn)
    expect(useStore.getState().forkBusy).toBe(true)
  })

  it('流式中的回复无分叉按钮', () => {
    const r = render(<MessageBubble message={completedReply} streaming />)
    expect(r.container.querySelector('.msg__footer-fork')).toBeNull()
  })

  it('乐观 assistant 消息（stream_local_/local_ 前缀）无分叉按钮', () => {
    const local: ZCodeMessage = {
      info: { role: 'assistant', time: { created: 30, completed: 31 }, id: 'stream_local_1', sessionID: SID },
      parts: [{ type: 'text', text: '乐观' }],
    }
    const r = render(<MessageBubble message={local} />)
    expect(r.container.querySelector('.msg__footer-fork')).toBeNull()
  })

  it('user 消息无分叉按钮（入口不在用户消息上）', () => {
    const r = render(<MessageBubble message={danglingUser} editable />)
    expect(r.container.querySelector('.codicon-git-branch')).toBeNull()
  })

  it('forkSupported=false（老 CLI 无 v4 面）隐藏分叉入口', () => {
    useStore.setState({ forkSupported: false })
    const r = render(<MessageBubble message={completedReply} />)
    expect(r.container.querySelector('.msg__footer-fork')).toBeNull()
  })
})

describe('守卫消息级（diag-fork29 定案：回合中历史轮可分叉）', () => {
  it('会话 streaming 中，历史完成回复的分叉仍放行（store 消息级守卫）', () => {
    useStore.setState({ streaming: true, streamingMessageId: 'msg_reply_other' })
    useStore.getState().forkFromMessage(SID, 'msg_reply_b')
    expect(useStore.getState().forkBusy).toBe(true)
  })

  it('目标消息本身在流式 → 拒绝并提示（双保险兜底）', () => {
    useStore.setState({ streaming: true, streamingMessageId: 'msg_reply_b' })
    useStore.getState().forkFromMessage(SID, 'msg_reply_b')
    expect(useStore.getState().forkBusy).toBe(false)
    expect(useStore.getState().lastError).toContain('无法分叉')
  })

  it('编辑重放期 → 拒绝（rewind 截断历史中，分叉目标可能被截）', () => {
    useStore.setState({ streaming: false, editReplay: { targetMsgId: 'msg_x', text: 'x', rewound: true } })
    useStore.getState().forkFromMessage(SID, 'msg_reply_b')
    expect(useStore.getState().forkBusy).toBe(false)
  })
})

describe('历史列表 fork 会话徽标', () => {
  it('sessionKind=fork 的列表条目渲染分支图标徽标', async () => {
    const { SessionItem } = await import('@/components/SessionItem')
    const s = {
      sessionId: 'sess_fork_1', title: 'Fork of 调研', status: 'idle', mode: 'build',
      workspacePath: 'G:\mock', createdAt: 1, updatedAt: 2, sessionKind: 'fork',
    }
    const r = render(<SessionItem session={s as never} active={false} onSelect={() => {}} />)
    const badge = r.container.querySelector('.session-item__fork-badge')
    expect(badge).not.toBeNull()
    expect(badge!.classList.contains('codicon-git-branch')).toBe(true)
  })

  it('goalTarget 会话渲染 target 图标徽标（可与 fork 并存）', async () => {
    const { SessionItem } = await import('@/components/SessionItem')
    const base = {
      sessionId: 'sess_goal_1', title: '目标会话', status: 'idle', mode: 'build',
      workspacePath: 'G:\mock', createdAt: 1, updatedAt: 2,
    }
    const g = render(<SessionItem session={{ ...base, goalTarget: true } as never} active={false} onSelect={() => {}} />)
    const gb = g.container.querySelector('.session-item__fork-badge.codicon-target')
    expect(gb).not.toBeNull()
    const fg = render(<SessionItem session={{ ...base, sessionKind: 'fork', goalTarget: true } as never} active={false} onSelect={() => {}} />)
    expect(fg.container.querySelector('.codicon-git-branch')).not.toBeNull()
    expect(fg.container.querySelector('.codicon-target')).not.toBeNull()
  })

  it('普通会话（无 sessionKind）不渲染徽标', async () => {
    const { SessionItem } = await import('@/components/SessionItem')
    const s = {
      sessionId: 'sess_normal', title: '普通会话', status: 'idle', mode: 'build',
      workspacePath: 'G:\mock', createdAt: 1, updatedAt: 2,
    }
    const r = render(<SessionItem session={s as never} active={false} onSelect={() => {}} />)
    expect(r.container.querySelector('.session-item__fork-badge')).toBeNull()
  })
})
