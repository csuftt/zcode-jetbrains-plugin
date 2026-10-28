/**
 * InputBox @ 文件补全交互测试（issue #14③④，2026-09-15）
 *
 * 锁定行为变更：
 * 1. @ 补全数据来自 Java listFiles 响应（onMessage 推送），下拉渲染文件与文件夹条目
 * 2. 选中条目 → 删 @query 触发文本 + 光标处插内联 file chip（不再进顶部 chip 栏），
 *    引用与正文的位置关系保留在文本流中
 * 3. 文件夹条目（尾 / 标记）用 folder 图标，chip data-path 带尾 /，序列化保留 @path/
 * 4. 发送序列化 @路径 随正文走（CLI 解析），与 fileRefs 前缀无关
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup, act } from '@testing-library/react'

const sentRequests: Array<Record<string, unknown>> = []
const messageHandlers: Array<(msg: Record<string, unknown>) => void> = []

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getTabWorkspacePath: () => '',
  getInitialSessionId: () => '',
  onMessage: (h: (msg: Record<string, unknown>) => void) => {
    messageHandlers.push(h)
    return () => {}
  },
  onStreamEvent: () => {},
  onStreamBatch: () => {},
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import '@/i18n/config'
import { useStore } from '@/store/useStore'
import { InputBox } from '@/components/InputBox'

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

beforeEach(() => {
  sentRequests.length = 0
  messageHandlers.length = 0
  storage.clear()
  if (!('innerText' in HTMLDivElement.prototype)) {
    Object.defineProperty(HTMLDivElement.prototype, 'innerText', {
      configurable: true,
      get(this: HTMLDivElement) { return this.textContent ?? '' },
      set(this: HTMLDivElement, v: string) { this.textContent = v },
    })
  }
  // jsdom 不实现 execCommand（调用即抛 Not implemented）。stub：焦点在
  // contenteditable 上时追加文本/HTML 并把光标移到末尾（inputbox-sessref 同款；
  // insertHTML 服务粘贴折叠内联 chip，issue #22②）
  document.execCommand = ((cmd: string, _ui: unknown, value = '') => {
    if (cmd === 'insertText' || cmd === 'insertHTML') {
      const el = document.activeElement as HTMLElement | null
      if (el && (el.isContentEditable || el.getAttribute('contenteditable') !== null)) {
        if (cmd === 'insertHTML') {
          const tpl = document.createElement('template')
          tpl.innerHTML = value
          while (tpl.content.firstChild) el.appendChild(tpl.content.firstChild)
        } else {
          el.textContent = (el.textContent ?? '') + value
        }
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
  // jsdom 不实现 Selection.modify（removeMentionTriggerText 的精确删除依赖），
  // 缺失会走 textContent 全量替换降级、selection 收敛到 (el,0)，chip 位置失真。
  // polyfill 只实现调用点用到的 extend backward character：光标（collapsed start）
  // 在文本节点内逐字符前移
  if (!('modify' in Selection.prototype)) {
    Object.defineProperty(Selection.prototype, 'modify', {
      configurable: true,
      writable: true,
      value(this: Selection, alter: string, direction: string, granularity: string) {
        if (alter !== 'extend' || direction !== 'backward' || granularity !== 'character') return
        if (this.rangeCount === 0) return
        const range = this.getRangeAt(0)
        const node = range.startContainer
        if (node.nodeType === Node.TEXT_NODE && range.startOffset >= 1) {
          range.setStart(node, range.startOffset - 1)
          this.removeAllRanges()
          this.addRange(range)
        }
      },
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
  const sendBtn = (Array.from(container.querySelectorAll('button')).find(
    (b) => b.className.includes('submit-button') && !b.className.includes('stop-button'),
  ) ?? container.querySelector('.submit-button')) as HTMLButtonElement
  return { container, editor, sendBtn, onSend }
}

function type(editor: HTMLElement, text: string) {
  editor.textContent = text
  editor.focus()
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

/** 模拟 Java 侧 listFiles 响应推送（所有已注册 handler 全量派发）*/
function pushFiles(files: string[]) {
  act(() => {
    for (const h of [...messageHandlers]) h({ op: 'files', files })
  })
}

/** @ 触发 → 等防抖 → 派发文件列表（真定时器等待宏任务）*/
async function openMention(editor: HTMLElement, files: string[]) {
  type(editor, '@')
  await new Promise((r) => setTimeout(r, 260)) // listFiles 防抖 200ms
  expect(sentRequests.some((r) => r.op === 'listFiles')).toBe(true)
  pushFiles(files)
}

describe('InputBox @ 文件补全（issue #14③④）', () => {
  it('选中条目 → 删触发文本 + 插内联 file chip；发送序列化 @路径 保留位置关系', async () => {
    const { container, editor, sendBtn, onSend } = setup()
    await openMention(editor, ['src/utils/inlineFileTags.ts'])
    const items = container.querySelectorAll('.input-box__mention-item')
    expect(items.length).toBe(1)
    expect(items[0].querySelector('.input-box__mention-path')!.textContent).toBe('src/utils/inlineFileTags.ts')

    type(editor, '看看 @src') // 带正文的触发
    await new Promise((r) => setTimeout(r, 260))
    pushFiles(['src/utils/inlineFileTags.ts'])
    fireEvent.keyDown(editor, { key: 'Enter' })

    const chip = container.querySelector('.file-ref--inline')
    expect(chip).not.toBeNull()
    expect(chip!.getAttribute('data-path')).toBe('src/utils/inlineFileTags.ts')
    expect(editor.textContent).not.toContain('@src') // 触发文本已删

    fireEvent.click(sendBtn)
    expect(onSend).toHaveBeenCalled()
    const text = onSend.mock.calls[0][0] as string
    expect(text).toContain('看看 @src/utils/inlineFileTags.ts') // 正文在前、引用在其位
  })

  it('文件夹条目（尾 /）用 folder 图标，选中后 chip 序列化保留 @path/', async () => {
    const { container, editor, sendBtn, onSend } = setup()
    await openMention(editor, ['src/components/', 'src/App.tsx'])
    const items = container.querySelectorAll('.input-box__mention-item')
    expect(items.length).toBe(2)
    // 文件夹优先排前（Java 侧已排序），图标区分
    expect(items[0].querySelector('.input-box__mention-icon')!.className).toContain('codicon-folder')
    expect(items[1].querySelector('.input-box__mention-icon')!.className).toContain('codicon-file')

    fireEvent.mouseDown(items[0]) // 选中文件夹
    const chip = container.querySelector('.file-ref--inline')
    expect(chip).not.toBeNull()
    expect(chip!.getAttribute('data-path')).toBe('src/components/')
    expect(chip!.querySelector('.file-ref__name')!.textContent).toBe('components')

    fireEvent.click(sendBtn)
    expect(onSend).toHaveBeenCalled()
    const text = onSend.mock.calls[0][0] as string
    expect(text).toContain('@src/components/')
  })

  it('键盘导航 Enter 选中文件条目后 chip 在光标处，继续可输入', async () => {
    const { container, editor } = setup()
    await openMention(editor, ['a.ts', 'b.ts'])
    fireEvent.keyDown(editor, { key: 'ArrowDown' }) // index 0 → 1
    fireEvent.keyDown(editor, { key: 'Enter' })
    const chip = container.querySelector('.file-ref--inline')
    expect(chip).not.toBeNull()
    expect(chip!.getAttribute('data-path')).toBe('b.ts')
  })
})

describe('InputBox filesToInput 来源分流（issue #14③ 补充）', () => {
  function pushRefs(source: string | undefined, refs: string[]) {
    act(() => {
      for (const h of [...messageHandlers]) {
        h({ op: 'filesToInput', refs, ...(source ? { source } : {}) })
      }
    })
  }

  it('右键菜单（menu）空输入框也内联 chip，不进顶部附件栏', () => {
    const { container, editor } = setup()
    pushRefs('menu', ['G:\\proj\\src\\App.tsx'])
    expect(container.querySelector('.file-ref--inline')).not.toBeNull()
    expect(container.querySelector('.file-ref--inline')!.getAttribute('data-path')).toBe('G:\\proj\\src\\App.tsx')
    expect(container.querySelector('.input-box__refs')).toBeNull() // 顶部栏未出现
    expect(editor.querySelector('.file-ref--inline')).not.toBeNull()
  })

  it('附件按钮（picker）选中进顶部附件栏，不入正文文本流', () => {
    const { container, editor } = setup()
    pushRefs('picker', ['G:\\proj\\README.md'])
    expect(container.querySelector('.file-ref--inline')).toBeNull()
    const topbar = container.querySelector('.input-box__refs')
    expect(topbar).not.toBeNull()
    expect(topbar!.querySelector('.file-ref:not(.file-ref--inline)')).not.toBeNull()
    expect(editor.querySelector('.file-ref')).toBeNull()
  })

  it('OS 拖拽（drag）保持内联；无 source 兜底内联（旧版本 Kotlin 侧兼容）', () => {
    const { container, editor } = setup()
    pushRefs('drag', ['G:\\proj\\a.txt'])
    expect(container.querySelector('.file-ref--inline')).not.toBeNull()
    pushRefs(undefined, ['G:\\proj\\b.txt'])
    expect(container.querySelectorAll('.file-ref--inline').length).toBe(2)
  })
})

describe('InputBox textToInput（控制台日志，走粘贴折叠逻辑）', () => {
  function pushText(text: string) {
    act(() => {
      for (const h of [...messageHandlers]) h({ op: 'textToInput', text })
    })
  }

  it('长日志（>500 字符）折叠为光标处内联粘贴 chip，不顶满输入框；发送按位展开', () => {
    const { container, editor, sendBtn, onSend } = setup()
    // 先写正文再推送日志（issue #22② 主场景：描述在前、粘贴跟在光标处）
    type(editor, '看下这个报错')
    const longLog = Array.from({ length: 30 }, (_, i) => `2026-09-15 20:00:00.${i} ERROR com.example.Service line-${i}`).join('\n')
    pushText(longLog)
    // 正文不含日志全文，光标处出现内联粘贴 chip（顶部折叠栏已随内联化退场）
    expect(editor.textContent).not.toContain('ERROR com.example.Service')
    expect(editor.querySelector('.paste-ref--inline')).not.toBeNull()
    expect(container.querySelector('.input-box__refs')).toBeNull()

    fireEvent.click(sendBtn)
    expect(onSend).toHaveBeenCalled()
    const text = onSend.mock.calls[0][0] as string
    expect(text).toContain('看下这个报错')
    expect(text).toContain('ERROR com.example.Service') // 日志原文在 chip 位置展开
    // 位置关系保留：描述在前、日志原文在后（旧实现恒拼整条消息末尾）
    expect(text.indexOf('看下这个报错')).toBeLessThan(text.indexOf('ERROR com.example.Service'))
  })

  it('短文本直接插进正文，多次推送追加不互顶', () => {
    const { editor } = setup()
    pushText('first log line')
    pushText('second log line')
    expect(editor.textContent).toContain('first log line')
    expect(editor.textContent).toContain('second log line')
  })
})
