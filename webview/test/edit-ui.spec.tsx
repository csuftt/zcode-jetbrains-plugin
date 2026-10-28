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
  getTabWorkspacePath: () => '',
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
    editViaV4: null,
  })
})
afterEach(cleanup)

function renderUser(msg: ZCodeMessage, editable: boolean) {
  return render(<MessageBubble message={msg} editable={editable} />)
}

describe('用户消息操作区', () => {
  it('所有 user 消息有复制按钮，编辑/重发按钮仅 editable 消息有，无分叉按钮', () => {
    const r1 = renderUser(u1, false)
    expect(r1.container.querySelectorAll('.msg__action-btn').length).toBe(1) // 仅复制
    expect(r1.container.querySelector('.codicon-git-branch')).toBeNull() // 分叉入口在 assistant 回复 footer
    cleanup()
    const r2 = renderUser(u2, true)
    expect(r2.container.querySelectorAll('.msg__action-btn').length).toBe(3) // 复制 + 编辑 + 重发
    expect(r2.container.querySelector('.codicon-edit')).not.toBeNull()
    expect(r2.container.querySelector('.codicon-debug-restart')).not.toBeNull() // 重发
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
    expect(useStore.getState().editReplay).toEqual({ targetMsgId: 'u2', text: '第二条（修改）', rewound: false, via: 'v4', ackPending: true })
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

describe('带图消息编辑（v4 editUserQuery 附件保留）', () => {
  const uImg: ZCodeMessage = {
    info: { role: 'user', time: { created: 4 }, id: 'u_img', sessionID: SID },
    parts: [
      { type: 'file', mime: 'image/png', url: 'http://127.0.0.1:9/zcode-image/sess_ui/image-x.png', filename: 'shot.png' } as never,
      { type: 'text', text: '看图' },
    ],
  }

  beforeEach(() => {
    // startEdit 从 store.messages 取最后一条可编辑消息：uImg 必须在列
    useStore.setState({ messages: [u1, a1, uImg] })
  })

  it('编辑器渲染原消息图片 chips，移除后提交带全量清单（删除语义=保留其余）', () => {
    const r = renderUser(uImg, true)
    fireEvent.click(r.container.querySelector('.codicon-edit')!.closest('button')!)
    // 原消息图片渲染为 chip
    expect(r.container.querySelectorAll('.msg__edit-image').length).toBe(1)
    // 移除 chip
    fireEvent.click(r.container.querySelector('.msg__edit-image-remove')!)
    expect(r.container.querySelectorAll('.msg__edit-image').length).toBe(0)
    // 提交：无剩余图片 → 显式空数组（原消息带图被删光 = 清空附件）
    fireEvent.change(r.container.querySelector('.msg__edit-textarea')!, { target: { value: '删图重问' } })
    fireEvent.keyDown(r.container.querySelector('.msg__edit-textarea')!, { key: 'Enter' })
    const replay = useStore.getState().editReplay
    expect(replay).toMatchObject({ targetMsgId: 'u_img', text: '删图重问', via: 'v4' })
    expect(replay?.attachments).toEqual([])
  })

  it('保留原图提交：cache 来源条目随清单透传', () => {
    const r = renderUser(uImg, true)
    fireEvent.click(r.container.querySelector('.codicon-edit')!.closest('button')!)
    fireEvent.change(r.container.querySelector('.msg__edit-textarea')!, { target: { value: '看图（改）' } })
    fireEvent.keyDown(r.container.querySelector('.msg__edit-textarea')!, { key: 'Enter' })
    const replay = useStore.getState().editReplay
    expect(replay?.attachments).toEqual([
      { source: 'cache', url: 'http://127.0.0.1:9/zcode-image/sess_ui/image-x.png', mime: 'image/png', fileName: 'shot.png' },
    ])
  })

  it('空文本 + 图片保留可提交（纯图编辑补文字场景的镜像）', () => {
    const r = renderUser(uImg, true)
    fireEvent.click(r.container.querySelector('.codicon-edit')!.closest('button')!)
    fireEvent.change(r.container.querySelector('.msg__edit-textarea')!, { target: { value: '' } })
    const submitBtn = Array.from(r.container.querySelectorAll('.msg__edit-btn'))
      .find((b) => b.textContent?.includes('重新生成')) as HTMLButtonElement
    expect(submitBtn.disabled).toBe(false)
    fireEvent.click(submitBtn)
    expect(useStore.getState().editReplay).toMatchObject({ targetMsgId: 'u_img', text: '', via: 'v4' })
    expect(useStore.getState().editReplay?.attachments).toHaveLength(1)
  })

  it('chip 点击放大（ImagePreview 打在 body），✕ 移除不误触预览', () => {
    const r = renderUser(uImg, true)
    fireEvent.click(r.container.querySelector('.codicon-edit')!.closest('button')!)
    // chip 本体点击 → 预览打开（portal 挂 body），src 为 chip 的 url
    fireEvent.click(r.container.querySelector('.msg__edit-image')!)
    const overlay = document.body.querySelector('.image-preview-overlay')
    expect(overlay).not.toBeNull()
    expect(overlay!.querySelector('img')!.getAttribute('src'))
      .toBe('http://127.0.0.1:9/zcode-image/sess_ui/image-x.png')
    // 预览里左右切换（单图禁用）
    expect(document.body.querySelector('.image-preview-nav--prev')).toBeNull()
    // 关预览
    fireEvent.click(overlay!)
    expect(document.body.querySelector('.image-preview-overlay')).toBeNull()
    // ✕ 移除按钮 stopPropagation：chip 减少且不打开预览
    fireEvent.click(r.container.querySelector('.msg__edit-image-remove')!)
    expect(r.container.querySelectorAll('.msg__edit-image').length).toBe(0)
    expect(document.body.querySelector('.image-preview-overlay')).toBeNull()
  })

  it('预览打开时 Esc 只关预览，不连带取消编辑（Esc 逐层让位）', () => {
    const r = renderUser(uImg, true)
    fireEvent.click(r.container.querySelector('.codicon-edit')!.closest('button')!)
    fireEvent.click(r.container.querySelector('.msg__edit-image')!)
    expect(document.body.querySelector('.image-preview-overlay')).not.toBeNull()
    const ta = r.container.querySelector('.msg__edit-textarea') as HTMLTextAreaElement
    fireEvent.keyDown(ta, { key: 'Escape' })
    // 预览关闭（document 级监听），编辑器仍在
    expect(document.body.querySelector('.image-preview-overlay')).toBeNull()
    expect(r.container.querySelector('.msg__edit-textarea')).not.toBeNull()
    // 预览已关后再 Esc → 取消编辑还原气泡
    fireEvent.keyDown(ta, { key: 'Escape' })
    expect(r.container.querySelector('.msg__edit-textarea')).toBeNull()
    expect(useStore.getState().editingMessageId).toBeNull()
  })

  it('无图消息编辑器不渲染 chips 区，提交不带 attachments 字段', () => {
    useStore.setState({ messages: [u1, a1, u2] })
    const r = renderUser(u2, true)
    fireEvent.click(r.container.querySelector('.codicon-edit')!.closest('button')!)
    expect(r.container.querySelector('.msg__edit-images')).toBeNull()
    fireEvent.change(r.container.querySelector('.msg__edit-textarea')!, { target: { value: '第二条（修改）' } })
    fireEvent.keyDown(r.container.querySelector('.msg__edit-textarea')!, { key: 'Enter' })
    expect(useStore.getState().editReplay?.attachments).toBeUndefined()
  })
})

describe('回合中编辑门控（v4 通道开放 / legacy 关闭）', () => {
  it('v4 通道：流式中可进入编辑（服务端 abort+重发）', () => {
    useStore.setState({ streaming: true, editViaV4: true })
    act(() => { useStore.getState().startEdit() })
    expect(useStore.getState().editingMessageId).toBe('u2')
  })

  it('legacy 通道：流式中 startEdit 拒绝', () => {
    useStore.setState({ streaming: true, editViaV4: false })
    act(() => { useStore.getState().startEdit() })
    expect(useStore.getState().editingMessageId).toBeNull()
  })

  it('审批弹窗挂着时不开放编辑（abort 挂着反向请求的回合有弹窗残留风险）', () => {
    useStore.setState({ streaming: true, editViaV4: true, permissionRequest: { requestId: 'r1' } as never })
    act(() => { useStore.getState().startEdit() })
    expect(useStore.getState().editingMessageId).toBeNull()
  })
})
