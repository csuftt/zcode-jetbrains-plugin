/**
 * InputBox # 会话引用交互测试（2026-09-10）
 *
 * 锁定：
 * 1. `#` 触发近期会话补全下拉（store sessions 数据源，排除当前会话）
 * 2. 无匹配不渲染面板（# 可能是其他用途，弹空态成骚扰）；行号模式 #L10 不误触发；@ 命中时 # 下拉关闭（互斥）
 * 3. 选中条目插内联 chip，发送序列化 [#标题](#sess_id)（模型侧 ReadSessionContext 协议）
 * 4. 粘贴 markdown 链接文本自动转 chip，发送保留引用形态
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'

const sentRequests: Array<Record<string, unknown>> = []

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getTabWorkspacePath: () => '',
  getInitialSessionId: () => '',
  onMessage: () => {},
  onStreamEvent: () => {},
  onStreamBatch: () => {},
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import '@/i18n/config'
import { useStore } from '@/store/useStore'
import { InputBox } from '@/components/InputBox'
import type { SessionInfo } from '@/types/messages'

// jsdom 的 localStorage 是无 clear 的普通对象（inputbox-goal.spec 同款 mock）
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

function mkSession(id: string, title: string, updatedAt: number): SessionInfo {
  return {
    sessionId: id,
    title,
    status: 'completed',
    mode: 'yolo',
    workspacePath: 'G:\\mock',
    createdAt: updatedAt - 1000,
    updatedAt,
    messageCount: 5,
  }
}

const CUR = 'sess_current'

beforeEach(() => {
  sentRequests.length = 0
  storage.clear()
  if (!('innerText' in HTMLDivElement.prototype)) {
    Object.defineProperty(HTMLDivElement.prototype, 'innerText', {
      configurable: true,
      get(this: HTMLDivElement) { return this.textContent ?? '' },
      set(this: HTMLDivElement, v: string) { this.textContent = v },
    })
  }
  // jsdom 不实现 execCommand（调用即抛 Not implemented）——粘贴路径的纯文本插入
  // 会挂死。stub：焦点在 contenteditable 上时追加文本并把光标移到末尾。
  document.execCommand = ((cmd: string, _ui: unknown, value = '') => {
    if (cmd === 'insertText') {
      const el = document.activeElement as HTMLElement | null
      if (el?.isContentEditable) {
        el.textContent = (el.textContent ?? '') + value
        const range = document.createRange()
        range.selectNodeContents(el)
        range.collapse(false)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
        return true
      }
    }
    return false
  }) as typeof document.execCommand
  useStore.getState().init()
  useStore.setState({
    currentSessionId: CUR,
    currentModel: { modelId: 'GLM-5.2', providerId: 'builtin:bigmodel-coding-plan' },
    currentWorkspacePath: 'G:\\mock',
    streaming: false,
    messages: [],
    goal: null,
    selectedAgent: null,
    queuedMessages: [],
    sessions: [
      mkSession(CUR, '当前会话', 3000),
      mkSession('sess_aaa', '暗号测试会话', 2000),
      mkSession('sess_bbb', '修复登录 bug', 1000),
    ],
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
  const sendBtn = (Array.from(container.querySelectorAll('button')).find(
    (b) => b.className.includes('submit-button') && !b.className.includes('stop-button'),
  ) ?? container.querySelector('.submit-button')) as HTMLButtonElement
  return { container, editor, sendBtn, onSend }
}

function type(editor: HTMLElement, text: string) {
  editor.textContent = text
  editor.focus()
  // jsdom 无真实光标且 focus() 会重置 Selection——先 focus 再把光标放进文本节点
  // 末尾（触发检测的 textBeforeCaret 假设光标在 TEXT_NODE 内、offset 为字符数）
  const textNode = editor.firstChild
  const range = document.createRange()
  if (textNode) {
    range.setStart(textNode, (textNode.textContent ?? '').length)
  } else {
    range.selectNodeContents(editor)
  }
  range.collapse(true)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
  fireEvent.input(editor)
}

describe('InputBox # 会话引用', () => {
  it('`#` 触发会话补全：列出近期会话（排除当前会话），相对时间与消息数展示', () => {
    const { container, editor } = setup()
    type(editor, '#')
    const items = container.querySelectorAll('.input-box__sess-item')
    expect(items.length).toBe(2)
    expect(items[0].textContent).toContain('暗号测试会话') // updatedAt 倒序
    expect(items[0].textContent).toContain('5')
    expect(items[1].textContent).toContain('修复登录 bug')
  })

  it('`#关键词` 过滤；无匹配整个面板不渲染（# 可能是其他用途），改回有匹配重新出现', () => {
    const { container, editor } = setup()
    type(editor, '#暗号')
    const items = container.querySelectorAll('.input-box__sess-item')
    expect(items.length).toBe(1)
    expect(items[0].textContent).toContain('暗号测试会话')

    type(editor, '#不存在的关键词')
    expect(container.querySelector('.input-box__sess')).toBeNull()

    type(editor, '#暗号')
    expect(container.querySelectorAll('.input-box__sess-item').length).toBe(1)
  })

  it('行号模式 #L10 不触发（文件 chip 行号引用防误判）；## 连续井号不触发', () => {
    const { container, editor } = setup()
    type(editor, '#L10')
    expect(container.querySelector('.input-box__sess')).toBeNull()
    type(editor, '## 标题')
    expect(container.querySelector('.input-box__sess')).toBeNull()
  })

  it('@ 命中时 # 下拉关闭（互斥，防双下拉）', () => {
    const { container, editor } = setup()
    type(editor, '#暗')
    expect(container.querySelector('.input-box__sess')).not.toBeNull()
    type(editor, '参考 @G:\\')
    expect(container.querySelector('.input-box__sess')).toBeNull()
  })

  it('Enter 选中条目：删触发文本 + 插内联会话 chip；发送序列化 [#标题](#sess_id)', () => {
    const { container, editor, sendBtn, onSend } = setup()
    type(editor, '参考 #暗号')
    fireEvent.keyDown(editor, { key: 'Enter' })
    const chip = container.querySelector('.sess-ref--inline')
    expect(chip).not.toBeNull()
    expect(chip!.getAttribute('data-sess')).toBe('sess_aaa')
    expect(editor.textContent).not.toContain('#暗号') // 触发文本已删
    fireEvent.click(sendBtn)
    expect(onSend).toHaveBeenCalled()
    const text = onSend.mock.calls[0][0] as string
    expect(text).toContain('[#暗号测试会话](#sess_aaa)')
  })

  it('粘贴含 markdown 链接的文本自动转 chip，发送保留引用', () => {
    const { container, editor, sendBtn, onSend } = setup()
    editor.focus() // execCommand stub 依赖 activeElement
    fireEvent.paste(editor, {
      clipboardData: {
        items: [],
        getData: (type: string) =>
          type === 'text/plain' ? '接着 [#暗号测试会话](#sess_aaa) 继续' : '',
      },
    })
    // setTimeout 后转换——vitest 真定时器下需等待微任务后宏任务
    return new Promise<void>((resolve) => setTimeout(() => {
      const chip = container.querySelector('.sess-ref--inline')
      expect(chip).not.toBeNull()
      expect(chip!.getAttribute('data-sess')).toBe('sess_aaa')
      expect(chip!.getAttribute('data-title')).toBe('暗号测试会话')
      fireEvent.click(sendBtn)
      expect(onSend).toHaveBeenCalled()
      const text = onSend.mock.calls[0][0] as string
      expect(text).toContain('[#暗号测试会话](#sess_aaa)')
      resolve()
    }, 20))
  })

  it('裸 token #sess_xxx 粘贴转换并经 resolver 反查标题', () => {
    const { container, editor, sendBtn, onSend } = setup()
    editor.focus() // execCommand stub 依赖 activeElement
    fireEvent.paste(editor, {
      clipboardData: {
        items: [],
        getData: (type: string) => (type === 'text/plain' ? '见 #sess_bbb 详情' : ''),
      },
    })
    return new Promise<void>((resolve) => setTimeout(() => {
      const chip = container.querySelector('.sess-ref--inline')
      expect(chip).not.toBeNull()
      expect(chip!.getAttribute('data-title')).toBe('修复登录 bug')
      fireEvent.click(sendBtn)
      const text = onSend.mock.calls[0][0] as string
      expect(text).toContain('[#修复登录 bug](#sess_bbb)')
      resolve()
    }, 20))
  })
})
