/**
 * 当前文件 chip 发送链路测试（《当前文件chip-发送链路实现.md》5 条验收标准）
 *
 * 首要原则：任何时刻"chip 显示的" == "下一条消息会携带的"。两条硬约束：
 *   单一数据源——发送取值表达式 = chip 显示表达式（enabled && currentFileRef）；
 *   唯一拼点——InputBox doSend 一处派生（本文件全部断言都落在 onSend 的参数）。
 *
 * 隐式通道（2026-10-07 ZCode-main 源码坐实后定稿）：上下文不拼进消息文本，
 * 派生为 kind:'currentFile' 附件描述放 attachments 首位，Java 读文件切片内容
 * 转 zcode.cjs kind:'file'+textContent 附件——模型收到内容，user bubble 不显示。
 * 因此断言分两路：text 必须等于用户原文（无前缀），attachments 首位必须是
 * 按 chip 显示值派生的描述（path + 行号区间）。
 *
 * doSend 层不区分新会话/继续对话：取值与会话 id 无关（跟随 IDE 选区），懒创建
 * 路径由 store.sendMessage 原样透传 text+attachments（pendingFirst*），所以验收 1
 * （新会话首条）与验收 2（继续对话）在 InputBox 层是同一条断言。
 *
 * 发完即关（2026-10-08 拍板）：doSend 发送成功即自动取消勾选——勾选只管下一条
 * 消息，附件全文经 history 持久化留在会话里，后续轮次无需每轮重发；原验收 3
 * （发送后不漂移）语义反转为"发送后自动关闭"，验收 4 收敛为"勾选不随切会话
 * 清零"；localStorage 持久化整体移除（发完即清零，无意义）。
 *
 * 新会话自动启用设置（2026-10-08，默认关）：勾选态随之从 InputBox 局部 state
 * 抬入 store——「新建会话」按钮（resetToNewSession）按 utils/currentFileConfig
 * 初始化勾选态，是唯一应用手势（切会话/删当前会话/Java 自动 newSession 不应用）；
 * 点亮也只影响首条消息（发完即关不变）。对应断言在文末 describe 块。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup, act } from '@testing-library/react'

const sentRequests: Array<Record<string, unknown>> = []
/** onMessage 注册集合：store init 全模块只注册一次（bridgeInitialized 守卫），
 *  InputBox 每次挂载另注册自己的——推送须广播到全部注册方，不能只记最后一个 */
const messageHandlers = new Set<(msg: unknown) => void>()
/** 标签注入的初始会话 id（Kotlin buildBridgeJs 注入形态）：'' = 新标签无绑定 */
let mockInitialSessionId = ''

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getTabWorkspacePath: () => '',
  getInitialSessionId: () => mockInitialSessionId,
  onMessage: (fn: (msg: unknown) => void) => {
    messageHandlers.add(fn)
    return () => { messageHandlers.delete(fn) }
  },
  onStreamEvent: () => {},
  onStreamBatch: () => {},
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import '@/i18n/config'
import { useStore } from '@/store/useStore'
import { InputBox } from '@/components/InputBox'
import type { SendAttachmentInput } from '@/types/messages'

// jsdom 的 localStorage 是无 clear 的普通对象（inputbox-goal.spec 同款 mock），
// 输入历史 persist 通道落在上面；chip 勾选态自发完即关起不再持久化（见头注释）
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

/** 带行号区间的 ref（与 EditorContextTracker 推送同形态：`@path#L10-20`，自带 @ 前缀）*/
const REF = '@E:/proj/src/App.ts#L10-20'

beforeEach(() => {
  sentRequests.length = 0
  storage.clear()
  mockInitialSessionId = ''
  // jsdom 不实现 innerText（InputBox 幽灵补全/历史回填读写），polyfill 成 textContent
  if (!('innerText' in HTMLDivElement.prototype)) {
    Object.defineProperty(HTMLDivElement.prototype, 'innerText', {
      configurable: true,
      get(this: HTMLDivElement) { return this.textContent ?? '' },
      set(this: HTMLDivElement, v: string) { this.textContent = v },
    })
  }
  document.execCommand = (() => false) as typeof document.execCommand
  useStore.getState().init()
  sentRequests.length = 0
  useStore.setState({
    currentSessionId: 'sess_a',
    // 门控态跨用例复位：同文件前序用例调 resetToNewSession 会置 true，
    // 文末「重启恢复绑定会话」用例需要 boot 态
    skipInitialSessionRestore: false,
    currentModel: { modelId: 'GLM-5.2', providerId: 'builtin:bigmodel-coding-plan' },
    currentWorkspacePath: 'G:\\mock',
    streaming: false,
    messages: [],
    goal: null,
    selectedAgent: null,
    queuedMessages: [],
    // 勾选态 2026-10-08 抬入 store（设置初始化需要跨组件写入点）：跨用例复位
    // 防泄漏（/goal 用例不发消息，会把勾选态留在 store 里）
    currentFileEnabled: false,
  })
})
afterEach(cleanup)

function setup(opts?: { ref?: string | null; enabled?: boolean }) {
  const onSend = vi.fn()
  const { container } = render(
    <InputBox
      onSend={onSend}
      currentModel={{ modelId: 'GLM-5.2', providerId: 'p1' }}
      onModelSelect={() => {}}
      currentFileRef={opts?.ref ?? null}
    />,
  )
  const editor = container.querySelector('.input-editable') as HTMLElement
  const sendBtn = (Array.from(container.querySelectorAll('button')).find(
    (b) => b.className.includes('submit-button') && !b.className.includes('stop-button'),
  ) ?? container.querySelector('.submit-button')) as HTMLButtonElement
  const chip = container.querySelector('[data-testid="current-file-chip"]') as HTMLElement
  // 发完即关后勾选态不读 localStorage：enabled 只能走真实点击（与用户操作
  // 同路径——单源 state 在 InputBox，chip 是 prop-driven 纯展示）
  if (opts?.enabled) fireEvent.click(chip)
  return { container, editor, sendBtn, chip, onSend }
}

/** 模拟键入正文（handleInput 读 textContent；打字后光标落在编辑器末尾，模拟真实输入）*/
function type(editor: HTMLElement, text: string) {
  editor.textContent = text
  fireEvent.input(editor)
  const sel = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(editor)
  range.collapse(false)
  sel?.removeAllRanges()
  sel?.addRange(range)
}

/** onSend 第 n 次调用的第 1 参（发送文本）与第 3 参（附件数组）*/
const sentText = (onSend: ReturnType<typeof vi.fn>, n = 0) => onSend.mock.calls[n][0] as string
const sentAttachments = (onSend: ReturnType<typeof vi.fn>, n = 0) =>
  onSend.mock.calls[n][2] as SendAttachmentInput[]

describe('当前文件 chip 发送链路（隐式附件通道）', () => {
  it('验收1/2：勾选 + chip 显示 ref → 附件首位携带同一 ref 的行号区间，文本保持用户原文', () => {
    const { editor, sendBtn, chip, onSend } = setup({ ref: REF, enabled: true })
    // chip 显示值 = basename + 行号（对照基准：携带值必须与它同源）
    expect(chip.textContent).toContain('App.ts')
    expect(chip.textContent).toContain('L10-20')
    type(editor, '你好')
    fireEvent.click(sendBtn)
    // 隐式：文本不拼任何前缀
    expect(sentText(onSend)).toBe('你好')
    // 附件首位 = chip 显示值派生的描述（"顺序靠前"在我方可控范围内）
    expect(sentAttachments(onSend)[0]).toEqual({
      kind: 'currentFile',
      path: 'E:/proj/src/App.ts',
      lineStart: 10,
      lineEnd: 20,
    })
  })

  it('单行 ref（@path#L7）→ lineStart=lineEnd=7', () => {
    const { editor, sendBtn, onSend } = setup({ ref: '@E:/proj/src/App.ts#L7', enabled: true })
    type(editor, '你好')
    fireEvent.click(sendBtn)
    expect(sentAttachments(onSend)[0]).toEqual({
      kind: 'currentFile',
      path: 'E:/proj/src/App.ts',
      lineStart: 7,
      lineEnd: 7,
    })
  })

  it('无行号 ref（@path）→ 描述不带行号字段（整文件语义）', () => {
    const { editor, sendBtn, onSend } = setup({ ref: '@E:/proj/src/App.ts', enabled: true })
    type(editor, '你好')
    fireEvent.click(sendBtn)
    expect(sentAttachments(onSend)[0]).toEqual({
      kind: 'currentFile',
      path: 'E:/proj/src/App.ts',
    })
  })

  it('验收5：未勾选 → 不携带任何上下文附件，文本原样', () => {
    const { editor, sendBtn, onSend } = setup({ ref: REF, enabled: false })
    type(editor, '你好')
    fireEvent.click(sendBtn)
    expect(sentText(onSend)).toBe('你好')
    expect(sentAttachments(onSend)).toEqual([])
  })

  it('勾选但 ref=null（IDE 无打开文件）→ 不携带，文本原样', () => {
    const { editor, sendBtn, onSend } = setup({ ref: null, enabled: true })
    type(editor, '你好')
    fireEvent.click(sendBtn)
    expect(sentText(onSend)).toBe('你好')
    expect(sentAttachments(onSend)).toEqual([])
  })

  it('验收3（发完即关）：发送成功即自动取消勾选——chip 回未勾选，再发不携带；重新勾选恢复携带', () => {
    const { editor, sendBtn, chip, onSend } = setup({ ref: REF, enabled: true })
    type(editor, '第一条')
    fireEvent.click(sendBtn)
    // 前置：本条确实携带上下文发出（否则后续"不再携带"断言无意义）
    expect(sentAttachments(onSend)[0]).toMatchObject({ kind: 'currentFile' })
    // 发完即关：chip 回未勾选态文字标签（勾选灭 = 附件已带走的回执）
    expect(chip.getAttribute('aria-pressed')).toBe('false')
    expect(chip.textContent).toContain('文件上下文')
    type(editor, '第二条')
    fireEvent.click(sendBtn)
    expect(sentText(onSend, 1)).toBe('第二条')
    expect(sentAttachments(onSend, 1)).toEqual([])
    // 重新勾选：下一条立即恢复携带（chip 实时跟随当前文件/选区，点一下即可）
    fireEvent.click(chip)
    type(editor, '第三条')
    fireEvent.click(sendBtn)
    expect(sentAttachments(onSend, 2)[0]).toEqual({
      kind: 'currentFile',
      path: 'E:/proj/src/App.ts',
      lineStart: 10,
      lineEnd: 20,
    })
  })

  it('验收4：勾选不随切会话清零——勾选后切会话再发送仍携带 chip 显示值', () => {
    const { editor, sendBtn, onSend } = setup({ ref: REF, enabled: true })
    act(() => useStore.setState({ currentSessionId: 'sess_b' }))
    type(editor, '会话B')
    fireEvent.click(sendBtn)
    expect(sentAttachments(onSend)[0]).toEqual({
      kind: 'currentFile',
      path: 'E:/proj/src/App.ts',
      lineStart: 10,
      lineEnd: 20,
    })
  })

  it('/goal 拦截不受上下文影响（拼点在 goal 拦截之后，目标模式不携带）', () => {
    const { editor, sendBtn, chip, onSend } = setup({ ref: REF, enabled: true })
    type(editor, '/goal 重构登录页')
    fireEvent.click(sendBtn)
    // 勾选态下 /goal 仍命中控制意图：转 goalManage，不带上下文进消息流
    expect(sentRequests.find((r) => r.op === 'goalManage')).toMatchObject({
      action: 'set',
      objective: '重构登录页',
    })
    expect(onSend).not.toHaveBeenCalled()
    // goal 是控制意图不算消息：早退路径不触发发完即关，勾选留给真正的下一条
    expect(chip.getAttribute('aria-pressed')).toBe('true')
  })

  it('chip 点击切换即时生效：勾选带、发送后自动取消（勾选态不再落 localStorage）', () => {
    const { editor, sendBtn, chip, onSend } = setup({ ref: REF })
    // 初始未勾选：不带
    type(editor, '一')
    fireEvent.click(sendBtn)
    expect(sentAttachments(onSend)).toEqual([])
    // 点击勾选：下一条立即携带（发送取值与 chip 显示同一表达式，无中间态）
    fireEvent.click(chip)
    type(editor, '二')
    fireEvent.click(sendBtn)
    expect(sentAttachments(onSend, 1)[0]).toMatchObject({ kind: 'currentFile', path: 'E:/proj/src/App.ts' })
    // 发完即关：无需手动再点取消，下一条自动恢复不带
    type(editor, '三')
    fireEvent.click(sendBtn)
    expect(sentAttachments(onSend, 2)).toEqual([])
    // 全程不写 localStorage（持久化已随发完即关移除）
    expect(storage.get('zcode.currentFile.enabled')).toBeUndefined()
  })

  it('输入历史只记用户内容：发送后 ArrowUp 回填为用户原文', () => {
    const { editor, sendBtn, onSend } = setup({ ref: REF, enabled: true })
    type(editor, '你好')
    fireEvent.click(sendBtn)
    // 前置确认：本条确实携带着上下文附件发出（否则回填断言无意义）
    expect(sentAttachments(onSend)[0]).toMatchObject({ kind: 'currentFile' })
    // 发送后输入框已清空，ArrowUp 回溯最近一条历史
    expect(editor.textContent ?? '').toBe('')
    fireEvent.keyDown(editor, { key: 'ArrowUp' })
    // 回填的是用户内容（上下文走附件通道本就不进文本，历史条目天然干净）
    expect(editor.textContent).toBe('你好')
  })
})

describe('新会话自动启用设置（currentFileConfig.autoOnNewSession，默认关）', () => {
  it('设置开启：resetToNewSession 点亮勾选——首条携带、发完即关、第二条不携带', () => {
    storage.set('zcode.currentFile.config', JSON.stringify({ autoOnNewSession: true }))
    useStore.getState().resetToNewSession()
    const { editor, sendBtn, chip, onSend } = setup({ ref: REF })
    // chip 已被设置点亮（无需手动点击）
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    type(editor, '首条')
    fireEvent.click(sendBtn)
    expect(sentAttachments(onSend)[0]).toMatchObject({ kind: 'currentFile', path: 'E:/proj/src/App.ts' })
    // 发完即关不受设置影响：勾选自动取消，第二条恢复不携带
    expect(chip.getAttribute('aria-pressed')).toBe('false')
    type(editor, '第二条')
    fireEvent.click(sendBtn)
    expect(sentAttachments(onSend, 1)).toEqual([])
  })

  it('设置缺省（默认关）：resetToNewSession 不点亮', () => {
    useStore.getState().resetToNewSession()
    const { chip } = setup({ ref: REF })
    expect(chip.getAttribute('aria-pressed')).toBe('false')
  })

  it('设置开启但不走新建会话手势：初次渲染不点亮（应用点严格收口 resetToNewSession）', () => {
    storage.set('zcode.currentFile.config', JSON.stringify({ autoOnNewSession: true }))
    const { chip } = setup({ ref: REF })
    expect(chip.getAttribute('aria-pressed')).toBe('false')
  })

  it('设置开启 + ref=null（IDE 无打开文件）：点亮但不携带，发送后照常取消', () => {
    storage.set('zcode.currentFile.config', JSON.stringify({ autoOnNewSession: true }))
    useStore.getState().resetToNewSession()
    const { editor, sendBtn, chip, onSend } = setup({ ref: null })
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    type(editor, '首条')
    fireEvent.click(sendBtn)
    expect(sentAttachments(onSend)).toEqual([])
    expect(chip.getAttribute('aria-pressed')).toBe('false')
  })

  // ===== 新标签 boot 路径（2026-10-08 用户实测拍板"新建标签页=新建会话"）=====
  // store 级断言（不渲染 InputBox）：listSessions 响应里的恢复块是第二应用点

  /** 模拟 Kotlin→webview 的 listSessions 响应（广播到全部 onMessage 注册方）*/
  const pushListSessions = (sessions: Array<Record<string, unknown>>) =>
    messageHandlers.forEach((h) => h({ op: 'listSessions', sessions }))

  it('新标签 boot（无注入绑定）：listSessions 落定后点亮', () => {
    storage.set('zcode.currentFile.config', JSON.stringify({ autoOnNewSession: true }))
    useStore.setState({ currentSessionId: null })
    pushListSessions([])
    expect(useStore.getState().currentFileEnabled).toBe(true)
  })

  it('新标签 boot + 设置缺省：不点亮', () => {
    useStore.setState({ currentSessionId: null })
    pushListSessions([])
    expect(useStore.getState().currentFileEnabled).toBe(false)
  })

  it('重启恢复绑定会话（initialSessionId 命中）：走 selectSession 恢复，不点亮——恢复不是新会话', () => {
    storage.set('zcode.currentFile.config', JSON.stringify({ autoOnNewSession: true }))
    mockInitialSessionId = 'sess_old'
    useStore.setState({ currentSessionId: null })
    pushListSessions([
      { sessionId: 'sess_old', title: 'old', status: 'idle', mode: 'yolo', workspacePath: 'G:\\mock', createdAt: 1, updatedAt: Date.now() },
    ])
    expect(useStore.getState().currentSessionId).toBe('sess_old')
    expect(useStore.getState().currentFileEnabled).toBe(false)
  })

  it('绑定会话已被删除（initialSessionId 未命中）：待命态 = 新会话，点亮', () => {
    storage.set('zcode.currentFile.config', JSON.stringify({ autoOnNewSession: true }))
    mockInitialSessionId = 'sess_gone'
    useStore.setState({ currentSessionId: null })
    pushListSessions([])
    expect(useStore.getState().currentSessionId).toBeNull()
    expect(useStore.getState().currentFileEnabled).toBe(true)
  })

  it('新标签 boot + 用户已手动勾选 + 设置缺省：只点不灭，不抹掉往返窗口内的手动勾选', () => {
    useStore.setState({ currentSessionId: null, currentFileEnabled: true })
    pushListSessions([])
    expect(useStore.getState().currentFileEnabled).toBe(true)
  })
})
