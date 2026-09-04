/**
 * 用户消息编辑/复制操作区 UI 测试（2026-09-04）
 *
 * 锁定：
 * - 所有 user 消息 hover 操作区有复制按钮；仅 editable（最后一轮）消息有编辑按钮
 * - 点编辑 → 气泡替换为行内编辑器（预填原文、聚焦）
 * - Enter 提交 → store.editReplay 建立且 editingMessageId 清空；Esc 取消还原气泡
 * - 空文本提交被禁用
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, act } from '@testing-library/react'

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
import { useStore } from '@/store/useStore'
import { MessageBubble } from '@/components/MessageBubble'
import type { ZCodeMessage } from '@/types/messages'

Object.defineProperty(window, 'localStorage', {
  value: {
    getItem: () => null, setItem: () => {}, removeItem: () => {},
    clear: () => {}, get length() { return 0 }, key: () => null,
  },
  configurable: true,
  writable: true,
})

const SID = 'sess_ui'
const u1: ZCodeMessage = { info: { role: 'user', time: { created: 1 }, id: 'u1', sessionID: SID }, parts: [{ type: 'text', text: '第一条' }] }
const a1: ZCodeMessage = { info: { role: 'assistant', time: { created: 2, completed: 3 }, id: 'a1', sessionID: SID }, parts: [{ type: 'text', text: '回答一' }] }
const u2: ZCodeMessage = { info: { role: 'user', time: { created: 4 }, id: 'u2', sessionID: SID }, parts: [{ type: 'text', text: '第二条' }] }
const a2: ZCodeMessage = { info: { role: 'assistant', time: { created: 5, completed: 6 }, id: 'a2', sessionID: SID }, parts: [{ type: 'text', text: '回答二' }] }

beforeEach(() => {
  useStore.getState().init()
  useStore.setState({
    currentSessionId: SID,
    messages: [u1, a1, u2, a2],
    streaming: false,
    streamingMessageId: null,
    queuedMessages: [],
    editingMessageId: null,
    editReplay: null,
  })
})
afterEach(cleanup)

function renderUser(msg: ZCodeMessage, editable: boolean) {
  return render(<MessageBubble message={msg} editable={editable} />)
}

describe('用户消息操作区', () => {
  it('所有 user 消息有复制按钮，编辑按钮仅 editable 消息有', () => {
    const r1 = renderUser(u1, false)
    expect(r1.container.querySelectorAll('.msg__action-btn').length).toBe(1) // 仅复制
    cleanup()
    const r2 = renderUser(u2, true)
    expect(r2.container.querySelectorAll('.msg__action-btn').length).toBe(2) // 复制 + 编辑
    expect(r2.container.querySelector('.codicon-edit')).not.toBeNull()
  })

  it('点编辑 → 行内编辑器（预填原文），Esc 取消还原', () => {
    const r = renderUser(u2, true)
    fireEvent.click(r.container.querySelector('.codicon-edit')!.closest('button')!)
    const ta = r.container.querySelector('.msg__edit-textarea') as HTMLTextAreaElement
    expect(ta).not.toBeNull()
    expect(ta.value).toBe('第二条')
    expect(useStore.getState().editingMessageId).toBe('u2')
    // Esc 取消：编辑器消失、气泡还原
    fireEvent.keyDown(ta, { key: 'Escape' })
    expect(useStore.getState().editingMessageId).toBeNull()
    expect(r.container.querySelector('.msg__edit-textarea')).toBeNull()
    expect(r.container.querySelector('.msg__bubble')).not.toBeNull()
  })

  it('Enter 提交 → submitEdit 编排（editReplay 建立 + 编辑态退出）', () => {
    const r = renderUser(u2, true)
    fireEvent.click(r.container.querySelector('.codicon-edit')!.closest('button')!)
    const ta = r.container.querySelector('.msg__edit-textarea') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '第二条（修改）' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(useStore.getState().editReplay).toEqual({ targetMsgId: 'u2', text: '第二条（修改）', rewound: false })
    expect(useStore.getState().editingMessageId).toBeNull()
    // 提交后编辑器消失（消息气泡恢复渲染，重发由编排接管）
    expect(r.container.querySelector('.msg__edit-textarea')).toBeNull()
  })

  it('Shift+Enter 不提交（换行），空文本禁用提交按钮', () => {
    const r = renderUser(u2, true)
    fireEvent.click(r.container.querySelector('.codicon-edit')!.closest('button')!)
    const ta = r.container.querySelector('.msg__edit-textarea') as HTMLTextAreaElement
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true })
    expect(useStore.getState().editReplay).toBeNull() // 未提交
    // 清空文本 → 提交按钮禁用
    fireEvent.change(ta, { target: { value: '' } })
    const submitBtn = Array.from(r.container.querySelectorAll('.msg__edit-btn'))
      .find((b) => b.textContent?.includes('重新生成')) as HTMLButtonElement
    expect(submitBtn.disabled).toBe(true)
  })
})
