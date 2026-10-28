/**
 * 后台子代理通知卡交互测试：点击头部 → 通用 Markdown 阅读弹窗显示成果全文
 *
 * 2026-09-18 交互改造：通知卡不再原地展开正文（长 result 刷屏），改为点击
 * 整行走 openMarkdownPreview（与工具卡 📖 预览同通道，离线快照无需轮询）。
 * 覆盖：卡内无正文 / 点击写入 markdownPreview（标题取 summary 引号内容、
 * 正文经实体反转义）/ 无 result 时不可点（--static 且点击无效）。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'

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
  getTabWorkspacePath: () => '',
}))

import '@/i18n/config'
import { AgentNotificationCard } from '@/components/AgentNotificationCard'
import { useStore } from '@/store/useStore'
import type { ZCodeMessage } from '@/types/messages'

/** 仿 2026-09-18 sess_d4a6aee0 实测形态：source=background_task + result 带 HTML 实体编码 */
function notifMessage(overrides: {
  result?: string
  summary?: string
  tokens?: string
  durationMs?: string
}): ZCodeMessage {
  const usage =
    overrides.tokens || overrides.durationMs
      ? `<usage>${overrides.tokens ? `<subagent_tokens>${overrides.tokens}</subagent_tokens>` : ''}${overrides.durationMs ? `<duration_ms>${overrides.durationMs}</duration_ms>` : ''}</usage>`
      : ''
  const result = overrides.result ? `<result>${overrides.result}</result>` : ''
  return {
    info: {
      id: 'msg_n1',
      sessionID: 'sess_main',
      role: 'user',
      synthetic: true,
      source: 'background_task',
      semantics: { origin: 'agent_runtime', kind: 'background_notification', uiVisibility: 'hidden' },
      time: { created: 1789729692000 },
    },
    parts: [
      {
        type: 'text',
        synthetic: true,
        text: `<task-notification><task-id>agent_abc123</task-id><status>completed</status><summary>${overrides.summary ?? 'Agent judge task &quot;目检 0001 帧图 1-11 页&quot; completed.'}</summary>${result}${usage}</task-notification>`,
      },
    ],
  } as unknown as ZCodeMessage
}

beforeEach(() => {
  useStore.setState({ markdownPreview: null })
})
afterEach(() => cleanup())

describe('通知卡点击弹窗交互', () => {
  it('卡片只保留摘要行，正文不在卡内 DOM（不原地展开）', () => {
    const { container } = render(
      <AgentNotificationCard message={notifMessage({ result: '验收结论正文' })} time="18:48" />,
    )
    expect(container.querySelector('.notif-card__header')).toBeTruthy()
    expect(container.querySelector('.notif-card__body')).toBeNull()
    expect(container.textContent).not.toContain('验收结论正文')
    // 有正文 → 尾部箭头 + data-tip
    expect(container.querySelector('.notif-card__toggle')).toBeTruthy()
  })

  it('点击头部打开阅读弹窗：标题取 summary 引号内容、正文反转义、meta 带状态/耗时/tokens', () => {
    const { container } = render(
      <AgentNotificationCard
        message={notifMessage({
          result: '结论：&quot;logo 条底边&quot; 裁切 --&gt; 修复后复核通过',
          tokens: '75558',
          durationMs: '8462000',
        })}
        time="18:48"
      />,
    )
    fireEvent.click(container.querySelector('.notif-card__header')!)
    const pv = useStore.getState().markdownPreview
    expect(pv).toBeTruthy()
    expect(pv!.title).toBe('目检 0001 帧图 1-11 页')
    expect(pv!.markdown).toContain('"logo 条底边" 裁切 --> 修复后复核通过')
    // meta：状态 · 耗时(140分22秒?8462000ms=141分2秒) · tokens(75558→75.6k)
    expect(pv!.meta).toContain('75.6k tokens')
    expect(pv!.meta).toMatch(/完成|Done/)
  })

  it('无 result 的通知（后台命令被杀）：--static 不可点，点击不开弹窗', () => {
    const { container } = render(
      <AgentNotificationCard
        message={notifMessage({ summary: 'Background command &quot;后台启动 Nacos&quot; was stopped' })}
        time="18:48"
      />,
    )
    expect(container.querySelector('.notif-card__header--static')).toBeTruthy()
    expect(container.querySelector('.notif-card__toggle')).toBeNull()
    fireEvent.click(container.querySelector('.notif-card__header')!)
    expect(useStore.getState().markdownPreview).toBeNull()
  })
})
