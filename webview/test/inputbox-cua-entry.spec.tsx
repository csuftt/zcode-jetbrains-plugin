/**
 * InputBox 电脑操作入口 chip 测试（2026-10-10）
 *
 * 锁定行为：
 * 1. 显隐双开关：电脑控制启用（cuaEnabled=true，Kotlin 权威）+「在输入框显示
 *    电脑操作按钮」（cuaInputButton，persist kv）两者都开才渲染入口
 * 2. 点击插入 zcgui-computer-use 内联技能 chip（行为同 $ 面板选中），序列化
 *    [$zcgui-computer-use](路径) 随正文发送
 * 3. 技能清单懒加载兜底：slashItems 为空时点击直发 listCommands，commands
 *    响应到达后补插（不走 requestCommands 的防抖+缓存短路）
 * 4. 编辑器已有同名技能 chip 时连点不重复插
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup, act, waitFor } from '@testing-library/react'

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
import { InputBox, CUA_SKILL_NAME } from '@/components/InputBox'
import { serializeEditor } from '@/utils/inlineFileTags'
import { skillRefText } from '@/utils/skillRefPattern'

/** 模拟 Kotlin commands 响应：act 包裹确保 setState flush、点击闭包拿到最新 slashItems */
function deliverCommands(commands: unknown[]) {
  act(() => {
    for (const h of messageHandlers) h({ op: 'commands', commands })
  })
}

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
    cuaEnabled: null,
    cuaInputButton: false,
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
  return { container, editor, onSend }
}

const CUA_SKILL = {
  name: CUA_SKILL_NAME,
  description: '操作本机桌面',
  kind: 'skill' as const,
  source: 'user',
  path: 'C:\\Users\\t\\.zcode\\skills\\zcgui-computer-use\\SKILL.md',
}

describe('InputBox 电脑操作入口 chip', () => {
  it('双开关未开：入口不渲染', () => {
    const { container } = setup()
    expect(container.querySelector('.cua-entry')).toBeNull()
  })

  it('主开关开、显示开关关：入口不渲染', () => {
    useStore.setState({ cuaEnabled: true, cuaInputButton: false })
    const { container } = setup()
    expect(container.querySelector('.cua-entry')).toBeNull()
  })

  it('显示开关开、主开关未开（null）：入口不渲染（技能未安装）', () => {
    useStore.setState({ cuaEnabled: null, cuaInputButton: true })
    const { container } = setup()
    expect(container.querySelector('.cua-entry')).toBeNull()
  })

  it('双开：点击后清单未加载 → 直发 listCommands，响应到达补插技能 chip', () => {
    useStore.setState({ cuaEnabled: true, cuaInputButton: true })
    const { container, editor } = setup()
    const entry = container.querySelector('.cua-entry') as HTMLButtonElement
    expect(entry).not.toBeNull()

    fireEvent.click(entry)
    // 走直发通道（listCommands），不是缓存短路
    expect(sentRequests.some((r) => r.op === 'listCommands')).toBe(true)

    // 模拟 Kotlin 实时扫描回包（含 CUA 技能）
    deliverCommands([CUA_SKILL, { name: 'review', kind: 'command' }])

    const chip = editor.querySelector(`[data-skill="1"][data-cmd="${CUA_SKILL_NAME}"]`)
    expect(chip).not.toBeNull()
    // 序列化为 $ 技能提及协议带路径形态（路径经 markdown 链接转义 \ → \\；chip 后
    // 的尾随空格是 insertSkillChipAtCursor 的钉位设计，光标落空格后可继续输入）
    expect(serializeEditor(editor)).toBe(skillRefText(CUA_SKILL_NAME, CUA_SKILL.path) + ' ')
    // chip 出现即解锁输入态
    expect((chip as HTMLElement).getAttribute('data-path')).toBe(CUA_SKILL.path)
  })

  it('清单已在（缓存命中形态）：点击直接插 chip，不再发 listCommands', () => {
    useStore.setState({ cuaEnabled: true, cuaInputButton: true })
    const { container, editor } = setup()
    // 预热清单（模拟用户先开过 $ 面板）：直接走 commands 响应
    deliverCommands([CUA_SKILL])
    const before = sentRequests.length

    fireEvent.click(container.querySelector('.cua-entry') as HTMLButtonElement)

    expect(sentRequests.slice(before).some((r) => r.op === 'listCommands')).toBe(false)
    expect(editor.querySelector(`[data-skill="1"][data-cmd="${CUA_SKILL_NAME}"]`)).not.toBeNull()
  })

  it('编辑器已有同名技能 chip：连点不重复插', () => {
    useStore.setState({ cuaEnabled: true, cuaInputButton: true })
    const { container, editor } = setup()
    for (const h of messageHandlers) {
      h({ op: 'commands', commands: [CUA_SKILL] })
    }
    const entry = container.querySelector('.cua-entry') as HTMLButtonElement
    deliverCommands([CUA_SKILL])
    fireEvent.click(entry)
    fireEvent.click(entry)
    expect(editor.querySelectorAll(`[data-skill="1"][data-cmd="${CUA_SKILL_NAME}"]`).length).toBe(1)
  })

  it('清单响应里没有 CUA 技能（主开关刚关等）：不插 chip，不误插其他技能', () => {
    useStore.setState({ cuaEnabled: true, cuaInputButton: true })
    const { container, editor } = setup()
    fireEvent.click(container.querySelector('.cua-entry') as HTMLButtonElement)
    deliverCommands([{ name: 'review', kind: 'command' }])
    expect(editor.querySelector('[data-skill="1"]')).toBeNull()
    // pending 标记已消费，不会滞留影响下一次
    expect(editor.querySelectorAll('[data-cmd]').length).toBe(0)
  })
})

describe('InputBox 电脑操作入口常亮（会话已进电脑控制上下文）', () => {
  it('默认灰态：无 cua-entry--active', () => {
    useStore.setState({ cuaEnabled: true, cuaInputButton: true, messages: [] })
    const { container } = setup()
    const entry = container.querySelector('.cua-entry') as HTMLButtonElement
    expect(entry.className).not.toContain('cua-entry--active')
  })

  it('输入框插入 CUA 技能 chip 后常亮（MutationObserver 跟踪 DOM）', async () => {
    useStore.setState({ cuaEnabled: true, cuaInputButton: true, messages: [] })
    const { container, editor } = setup()
    const entry = container.querySelector('.cua-entry') as HTMLButtonElement
    deliverCommands([CUA_SKILL])
    fireEvent.click(entry)
    const chip = editor.querySelector(`[data-skill="1"][data-cmd="${CUA_SKILL_NAME}"]`)
    expect(chip).not.toBeNull()
    // chip 插入是 DOM 直改，Observer 回调异步——waitFor 等 React 提交
    await waitFor(() => expect(entry.className).toContain('cua-entry--active'))
  })

  it('AI 真实用过技能（Skill 工具调用）→ 常亮；用户文本提及不算', () => {
    useStore.setState({
      cuaEnabled: true,
      cuaInputButton: true,
      messages: [{
        info: { role: 'assistant', id: 'm2', sessionID: 'sess_cur' },
        parts: [{ type: 'tool', callID: 'c1', tool: 'Skill', state: { status: 'completed', input: { skill: CUA_SKILL_NAME } } }],
      }],
    })
    const { container } = setup()
    expect((container.querySelector('.cua-entry') as HTMLButtonElement).className).toContain('cua-entry--active')
  })

  it('用户消息只是文本提及技能名（bug 报告/标题引用）→ 不常亮', () => {
    useStore.setState({
      cuaEnabled: true,
      cuaInputButton: true,
      messages: [{
        info: { role: 'user', id: 'm1', sessionID: 'sess_cur' },
        parts: [{ type: 'text', text: `[$${CUA_SKILL_NAME}](C:\\s\\SKILL.md) 操作桌面` }],
      }],
    })
    const { container } = setup()
    expect((container.querySelector('.cua-entry') as HTMLButtonElement).className).not.toContain('cua-entry--active')
  })

  it('CUA 工具在会话中执行过（assistant tool part）→ 常亮', () => {
    useStore.setState({
      cuaEnabled: true,
      cuaInputButton: true,
      messages: [{
        info: { role: 'assistant', id: 'm2', sessionID: 'sess_cur' },
        parts: [{ type: 'tool', callID: 'c1', tool: `mcp__zcgui-computer-use__left_click`, state: { status: 'completed' } }],
      }],
    })
    const { container } = setup()
    expect((container.querySelector('.cua-entry') as HTMLButtonElement).className).toContain('cua-entry--active')
  })
})
