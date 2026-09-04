/**
 * InputBox /goal 前缀拦截测试（0.3.2 真机反馈回归）
 *
 * 根因：长目标提示词触发粘贴折叠（≥10 行或 ≥500 字符不进正文、存 pastedTexts
 * chip 拼在正文后），旧拦截守卫要求 pastedTexts 为空 → /goal 走普通发送。
 * 锁定：正文 /goal、正文 /goal + 折叠粘贴文本（核心回归）、子命令、无参 show、
 * 普通消息不受影响。带图片不拦截的场景依赖剪贴板图片 mock，此处不覆盖。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'

const sentRequests: Array<Record<string, unknown>> = []

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getInitialSessionId: () => '',
  onMessage: () => {},
  onStreamEvent: () => {},
  onStreamBatch: () => {},
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import '@/i18n/config'
import { useStore } from '@/store/useStore'
import { InputBox } from '@/components/InputBox'

// jsdom 的 localStorage 是无 clear 的普通对象（goal-card.spec 同款 mock），
// 供润色开关等 persist kv 读写
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
  sentRequests.length = 0
  storage.clear()
  // jsdom 不实现 innerText（InputBox 幽灵补全读取），polyfill 成 textContent
  if (!('innerText' in HTMLDivElement.prototype)) {
    Object.defineProperty(HTMLDivElement.prototype, 'innerText', {
      configurable: true,
      get(this: HTMLDivElement) { return this.textContent ?? '' },
      set(this: HTMLDivElement, v: string) { this.textContent = v },
    })
  }
  useStore.getState().init()
  sentRequests.length = 0
  useStore.setState({
    currentSessionId: 'sess_g',
    currentModel: { modelId: 'GLM-5.2', providerId: 'builtin:bigmodel-coding-plan' },
    currentWorkspacePath: 'G:\\mock',
    streaming: false,
    messages: [],
    goal: null,
    selectedAgent: null,
    queuedMessages: [],
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

/** 模拟键入正文（handleInput 读 textContent）*/
function type(editor: HTMLElement, text: string) {
  editor.textContent = text
  fireEvent.input(editor)
}

/** 模拟粘贴纯文本（clipboardData.items 为空数组 = 无图，getData 返回文本）*/
function paste(editor: HTMLElement, text: string) {
  fireEvent.paste(editor, {
    clipboardData: {
      items: [],
      getData: (type: string) => (type === 'text/plain' ? text : ''),
    },
  })
}

const goalOp = () => sentRequests.find((r) => r.op === 'goalManage')

describe('InputBox /goal 拦截', () => {
  it('正文 /goal <目标>：转 goalManage set，不进消息流', () => {
    const { editor, sendBtn, onSend } = setup()
    type(editor, '/goal 重构登录页并保持测试通过')
    fireEvent.click(sendBtn)
    const op = goalOp()
    expect(op).toMatchObject({ action: 'set', objective: '重构登录页并保持测试通过' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('核心回归：长目标提示词粘贴折叠为 chip 后，/goal 仍触发 set（objective 含粘贴全文）', () => {
    const { editor, sendBtn, container, onSend } = setup()
    // 12 行且 >500 字符：行数与字符折叠阈值双命中
    const longText = Array.from({ length: 12 }, (_, i) =>
      `第${i + 1}步：创建模块 module_${i + 1}，为其编写完整实现与测试用例，并逐一运行验证输出正确性`).join('\n')
    expect(longText.split('\n')).toHaveLength(12)
    expect(longText.length).toBeGreaterThanOrEqual(500)
    type(editor, '/goal')
    paste(editor, longText)
    // 长文本被折叠为粘贴 chip，不进编辑器正文
    expect(container.querySelector('.input-editable')?.textContent).toBe('/goal')
    fireEvent.click(sendBtn)
    const op = goalOp()
    expect(op).toMatchObject({ action: 'set', objective: longText })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('子命令：/goal pause 转暂停（不进 set）', () => {
    const { editor, sendBtn } = setup()
    type(editor, '/goal pause')
    fireEvent.click(sendBtn)
    expect(goalOp()).toMatchObject({ action: 'pause' })
  })

  it('无参 /goal 转状态提示（show）：无目标时本地用法提示，不发请求', () => {
    const { editor, sendBtn, onSend } = setup()
    type(editor, '/goal')
    fireEvent.click(sendBtn)
    // goalManage('show') 无目标时复用 lastError 给用法提示（既有设计，不发 op）
    expect(useStore.getState().lastError).toContain('/goal')
    expect(goalOp()).toBeUndefined()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('普通消息不受拦截影响（走 sendMessage）', () => {
    const { editor, sendBtn, onSend } = setup()
    type(editor, '普通消息，不是 goal')
    fireEvent.click(sendBtn)
    expect(goalOp()).toBeUndefined()
    expect(onSend).toHaveBeenCalled()
  })
})
