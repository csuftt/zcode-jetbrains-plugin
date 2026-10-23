/**
 * 输入框点击空白处聚焦编辑器（issue#45-2）
 *
 * 缺陷：contenteditable 只有点到文字区才命中焦点，点顶栏/footer 空白与卡片
 * 留白无响应，用户必须瞄准文字才能开始输入。
 *
 * 锁定行为（handleCardMouseDown 容器级兜底）：
 * 1. 点卡片容器/顶栏等空白区 → 编辑器获得焦点
 * 2. 点 chip（.file-ref）→ 不劫持，交给 chip 自身交互（hover tooltip/右键等）
 * 3. 点按钮 → 不劫持
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getInitialSessionId: () => '',
  onMessage: () => () => {},
  onStreamEvent: () => {},
  onStreamBatch: () => {},
  sendToJava: () => {},
}))

import '@/i18n/config'
import { useStore } from '@/store/useStore'
import { InputBox } from '@/components/InputBox'

const storage = new Map<string, string>()
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => { storage.set(k, v) },
    removeItem: (k: string) => { storage.delete(k) },
    key: (i: number) => Array.from(storage.keys())[i] ?? null,
    get length() { return storage.size },
    clear: () => storage.clear(),
  },
})

beforeEach(() => {
  storage.clear()
  if (!('innerText' in HTMLDivElement.prototype)) {
    Object.defineProperty(HTMLDivElement.prototype, 'innerText', {
      configurable: true,
      get(this: HTMLDivElement) { return this.textContent ?? '' },
      set(this: HTMLDivElement, v: string) { this.textContent = v },
    })
  }
  useStore.getState().init()
  useStore.setState({
    currentSessionId: 'sess_cur',
    currentModel: { modelId: 'GLM-5.2', providerId: 'builtin:bigmodel-coding-plan' },
    currentWorkspacePath: 'G:\\mock',
    streaming: false,
    messages: [],
    goal: null,
    selectedAgent: null,
    queuedMessages: [],
    sessions: [],
  })
})
afterEach(cleanup)

function setup() {
  const onSend = vi.fn()
  const { container } = render(
    <InputBox
      onSend={onSend}
      currentModel={{ modelId: 'GLM-5.2', providerId: 'p1' }}
      onModelSelect={() => {}}
    />,
  )
  const editor = container.querySelector('.input-editable') as HTMLElement
  const card = container.querySelector('.chat-input-box') as HTMLElement
  return { container, editor, card }
}

describe('输入框点击空白聚焦', () => {
  it('点卡片容器留白：编辑器获得焦点', () => {
    const { editor, card } = setup()
    const spy = vi.spyOn(editor, 'focus')
    fireEvent.mouseDown(card)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('点顶栏空白：编辑器获得焦点', () => {
    const { container, editor } = setup()
    const topbar = container.querySelector('.input-box-topbar') as HTMLElement
    expect(topbar).not.toBeNull()
    fireEvent.mouseDown(topbar)
    expect(document.activeElement).toBe(editor)
  })

  it('点 chip：不劫持焦点', () => {
    const { editor } = setup()
    const chip = document.createElement('span')
    chip.className = 'file-ref--inline'
    editor.appendChild(chip)
    const spy = vi.spyOn(editor, 'focus')
    fireEvent.mouseDown(chip)
    expect(spy).not.toHaveBeenCalled()
  })

  it('点按钮：不劫持焦点', () => {
    const { container, editor } = setup()
    const btn = container.querySelector('.context-tool-btn') as HTMLButtonElement
    expect(btn).not.toBeNull()
    const spy = vi.spyOn(editor, 'focus')
    fireEvent.mouseDown(btn)
    expect(spy).not.toHaveBeenCalled()
  })

  it('点编辑器本身（文字区）：原生行为，不重复转发', () => {
    const { editor } = setup()
    const spy = vi.spyOn(editor, 'focus')
    fireEvent.mouseDown(editor)
    expect(spy).not.toHaveBeenCalled()
  })
})
