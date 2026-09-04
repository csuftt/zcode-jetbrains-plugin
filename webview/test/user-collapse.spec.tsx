/**
 * 用户消息长文折叠回归测试
 *
 * 行为（MessageBubble UserBubble，2026-08-22）：
 *   - 阈值对齐 InputBox 粘贴折叠：≥10 行或 ≥500 字符 → 默认折叠
 *   - 折叠是纯视觉（max-height 裁剪）：全文文本节点仍完整在 DOM，
 *     会话内搜索 TreeWalker 才能扫到被折叠部分
 *   - 点击"查看全文"→ portal 弹窗（挂 body，脱离搜索容器）显示全文
 *   - searchActive（搜索面板打开）→ 强制展开，保 mark 高亮/定位
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

function userMsg(text: string): ZCodeMessage {
  return {
    info: {
      id: 'm_u1', sessionID: 's1', role: 'user', time: { created: 1787283860314 },
    },
    parts: [{ type: 'text', text }],
  }
}

const SHORT = '你好，帮我写个函数'
const LONG_12_LINES = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行：粘贴的长文本内容示例`).join('\n')
const LONG_1LINE_600CHARS = 'x'.repeat(600)

function bubble(): HTMLElement {
  return document.querySelector('.msg__bubble') as HTMLElement
}

describe('用户消息长文折叠', () => {
  beforeEach(() => {
    window.HTMLElement.prototype.scrollIntoView = () => {}
  })
  afterEach(cleanup)

  /** 「查看全文」展开按钮（用户消息 hover 操作区另有复制/编辑按钮，须按类名定位）*/
  function expandBtn(): HTMLElement | null {
    return document.querySelector('.msg__expand')
  }

  it('≥10 行的长消息默认折叠：加折叠类 + 展开按钮 + 全文仍在 DOM', () => {
    render(<MessageBubble message={userMsg(LONG_12_LINES)} />)
    expect(bubble().className).toContain('msg__bubble--collapsed')
    const btn = expandBtn()
    expect(btn).not.toBeNull()
    expect(btn!.textContent).toContain('12')
    // 折叠不截断 DOM：尾部行文本节点必须存在（搜索 TreeWalker 依赖）
    expect(bubble().textContent).toContain('第 12 行')
  })

  it('单行超 500 字符也折叠（行长维度阈值）', () => {
    render(<MessageBubble message={userMsg(LONG_1LINE_600CHARS)} />)
    expect(bubble().className).toContain('msg__bubble--collapsed')
  })

  it('短消息不折叠、无展开按钮', () => {
    render(<MessageBubble message={userMsg(SHORT)} />)
    expect(bubble().className).not.toContain('msg__bubble--collapsed')
    expect(expandBtn()).toBeNull()
  })

  it('searchActive 强制展开（搜索面板打开时）', () => {
    render(<MessageBubble message={userMsg(LONG_12_LINES)} searchActive />)
    expect(bubble().className).not.toContain('msg__bubble--collapsed')
    expect(expandBtn()).toBeNull()
  })

  it('点击查看全文 → body 下出现全文弹窗，Escape 关闭', () => {
    render(<MessageBubble message={userMsg(LONG_12_LINES)} />)
    fireEvent.click(expandBtn()!)
    // portal 挂 body：弹窗不在消息树内
    const dialog = document.body.querySelector('.msg-fulltext') as HTMLElement
    expect(dialog).not.toBeNull()
    expect(dialog.querySelector('.msg-fulltext__body')!.textContent).toContain('第 12 行')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.body.querySelector('.msg-fulltext')).toBeNull()
  })
})
