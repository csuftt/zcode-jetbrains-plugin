/**
 * 划词引用发送后回读渲染回归（真机反馈两轮 2026-11-11）：
 * ① 首轮只剥块不渲染 → 发出后用户消息看不到引用了什么；
 * ② 二轮卡片直出全文太长 → 定稿=气泡下只出「N 条对话引用」pill（SelectionRefChip
 *    只读态复用），点击弹 .convsel-pop 逐条看原文（与输入框引用条同一交互）。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('@/ipc/bridge', () => ({
  sendToJava: () => {},
  isInJcef: () => false,
  onMessage: () => () => {},
}))

import '@/i18n/config'
import { MessageBubble } from '@/components/MessageBubble'
import type { ZCodeMessage } from '@/types/messages'

const NEW_BLOCK =
  '# userselect:\n```userselect\n[{"text":"报错再补的堆栈片段"},{"text":"第二条引用"}]\n```'
const OLD_BLOCK =
  '# Conversation selections:\n```zcode-conversation-selections\n[{"text":"旧格式引用文本"}]\n```'

function userMsg(text: string): ZCodeMessage {
  return {
    info: { id: 'u1', sessionID: 's1', role: 'user', time: { created: 1787283860314 } },
    parts: [{ type: 'text', text }],
  }
}

describe('发送后用户气泡的划词引用 pill', () => {
  afterEach(() => cleanup())

  it('新格式块：正文渲染、块不出现、只出引用 pill', () => {
    render(<MessageBubble message={userMsg(`这个怎么解释\n\n${NEW_BLOCK}`)} />)
    expect(screen.getByText('这个怎么解释')).not.toBeNull()
    // 块协议文本不进 DOM（剥块）；引用原文也不直出（真机二轮反馈：全文太长）
    expect(document.body.textContent).not.toContain('# userselect:')
    expect(document.body.textContent).not.toContain('报错再补的堆栈片段')
    // pill：计数文案 + 关闭态无 popover
    expect(document.querySelector('.msg__selrefs .convsel-chip')).not.toBeNull()
    expect(screen.getByText('2 条对话引用')).not.toBeNull()
    expect(document.querySelector('.convsel-pop')).toBeNull()
  })

  it('点击 pill 弹 popover 逐条看原文；只读态无移除钮', () => {
    render(<MessageBubble message={userMsg(`看\n\n${NEW_BLOCK}`)} />)
    fireEvent.click(screen.getByText('2 条对话引用'))
    expect(document.querySelectorAll('.convsel-pop__item')).toHaveLength(2)
    expect(screen.getByText('报错再补的堆栈片段')).not.toBeNull()
    expect(screen.getByText('第二条引用')).not.toBeNull()
    // 只读态：无单条移除钮、无移除全部圆钮、无来源脚注
    expect(document.querySelector('.convsel-pop__remove')).toBeNull()
    expect(document.querySelector('.convsel-chip__clear')).toBeNull()
    expect(document.querySelector('.convsel-pop__meta')).toBeNull()
    // 点击外部收起
    fireEvent.mouseDown(document.body)
    expect(document.querySelector('.convsel-pop')).toBeNull()
  })

  it('pill 贴视口右缘时弹层右对齐翻转（真机三反馈：弹层伸出主界面右侧）', () => {
    const { container } = render(<MessageBubble message={userMsg(`看\n\n${NEW_BLOCK}`)} />)
    const chip = container.querySelector('.convsel-chip') as HTMLElement
    // jsdom rect 恒 0；桩到「右缘几乎贴视口」模拟消息 pill 右对齐的真实位置
    chip.getBoundingClientRect = () =>
      ({ left: 700, right: 1010, top: 100, bottom: 130, width: 310, height: 30, x: 700, y: 100, toJSON: () => ({}) }) as DOMRect
    fireEvent.click(screen.getByText('2 条对话引用'))
    const pop = document.querySelector('.convsel-pop') as HTMLElement
    expect(pop).not.toBeNull()
    expect(pop.className).toContain('convsel-pop--right')
    expect(pop.className).not.toContain('convsel-pop--up') // 上方空间足够时不纵翻
  })

  it('旧格式围栏（官方旧版）同样回读出 pill', () => {
    render(<MessageBubble message={userMsg(`旧格式\n\n${OLD_BLOCK}`)} />)
    expect(document.body.textContent).not.toContain('# Conversation selections:')
    expect(screen.getByText('1 条对话引用')).not.toBeNull()
  })

  it('fail-open：块 JSON 损坏 → 整段原文展示、无引用 pill', () => {
    const broken = '# userselect:\n```userselect\n[{"text": 截断的非法JSON\n```'
    render(<MessageBubble message={userMsg(`看\n\n${broken}`)} />)
    expect(document.querySelector('.msg__selrefs')).toBeNull()
    // 整段原文（含未剥掉的块）fail-open 展示，消息不吞
    expect(document.body.textContent).toContain('看')
  })

  it('无引用普通消息零差异：不渲染引用 pill', () => {
    render(<MessageBubble message={userMsg('普通消息')} />)
    expect(document.querySelector('.msg__selrefs')).toBeNull()
    expect(document.querySelector('.convsel-chip')).toBeNull()
  })
})
