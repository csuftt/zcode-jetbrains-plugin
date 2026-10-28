/**
 * 提示词润色 + 子智能体功能测试
 *
 * 覆盖：
 * 1. store 润色状态机：enhancePrompt 请求发起到 enhancePromptResult 落地（成功/失败/超时兜底）
 * 2. PromptEnhancerDialog：loading/错误/结果三态渲染、Enter=使用、Esc=关闭
 * 3. 子智能体：agents 响应落地、agentDeleted 清选中、AgentSelect 下拉选择/取消
 * 4. InputBox 发送拼装：选中子智能体时消息前置 @<name>（协议实测格式）
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'

let messageHandler: ((msg: unknown) => void) | null = null
const sentRequests: Array<Record<string, unknown>> = []

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getTabWorkspacePath: () => '',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: unknown) => void) => { messageHandler = fn },
  onStreamEvent: () => {},
  onStreamBatch: () => {},
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import '@/i18n/config'
import { useStore, handleResponse } from '@/store/useStore'
import { PromptEnhancerDialog } from '@/components/PromptEnhancerDialog'
import { AgentSelect } from '@/components/AgentSelect'
import { InputBox } from '@/components/InputBox'
import { writeEnhanceConfig } from '@/utils/enhanceConfig'
import type { AgentDef } from '@/types/messages'

// jsdom 29 的 window.localStorage 是空壳（setItem 等方法缺失）：Map 实现替换，
// 供润色开关（persist kv）读写（breakdown-cache.spec 同款手法）
const storage = new Map<string, string>()
const lsMock = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => { storage.set(k, v) },
  removeItem: (k: string) => { storage.delete(k) },
  key: (i: number) => Array.from(storage.keys())[i] ?? null,
  get length() { return storage.size },
  clear: () => storage.clear(),
}
Object.defineProperty(window, 'localStorage', { configurable: true, value: lsMock })

const agentDef = (over: Partial<AgentDef> = {}): AgentDef => ({
  name: 'test-agent',
  description: '测试子智能体',
  color: 'yellow',
  tools: [],
  disallowedTools: [],
  injectAgentsMd: true,
  mcpServers: [],
  systemPrompt: '你好，我是测试的子智能体',
  path: 'C:/users/.zcode/agents/test-agent.md',
  scope: 'user',
  ...over,
})

beforeEach(() => {
  sentRequests.length = 0
  storage.clear()
  // 润色按钮默认关闭（设置→行为开关）：既有 InputBox 用例统一预置开启
  storage.set('zcode.enhance.config', JSON.stringify({ enhanceEnabled: true }))
  // jsdom 不实现 innerText（InputBox 幽灵补全读取），polyfill 成 textContent
  if (!('innerText' in HTMLDivElement.prototype)) {
    Object.defineProperty(HTMLDivElement.prototype, 'innerText', {
      configurable: true,
      get(this: HTMLDivElement) {
        return this.textContent ?? ''
      },
      set(this: HTMLDivElement, v: string) {
        this.textContent = v
      },
    })
  }
  // jsdom 未实现 execCommand（调用即抛 TypeError）：垫恒 false 桩，令 insertPlainText /
  // insertPasteChipAtCursor 走手动 range 兜底——与真实环境 execCommand 失效时同路径
  if (typeof document.execCommand !== 'function') {
    ;(document as unknown as { execCommand: () => boolean }).execCommand = () => false
  }
  useStore.getState().init()
  sentRequests.length = 0
  useStore.setState({
    subagentDefs: null,
    selectedAgent: null,
    enhancing: false,
    enhanceResult: null,
    currentSessionId: 'sess_t1',
    currentModel: { modelId: 'GLM-5.2', providerId: 'builtin:bigmodel-coding-plan' },
    currentWorkspacePath: 'G:\\mock',
    streaming: false,
    messages: [],
  })
})
afterEach(cleanup)

describe('润色状态机（store）', () => {
  it('enhancePrompt 发请求带当前模型，置 enhancing + 弹窗占位（含模型徽标占位）', () => {
    useStore.getState().enhancePrompt('帮我写个函数')
    const req = sentRequests.find((r) => r.op === 'enhancePrompt')
    expect(req).toBeTruthy()
    expect(req).toMatchObject({
      text: '帮我写个函数',
      providerId: 'builtin:bigmodel-coding-plan',
      modelId: 'GLM-5.2',
    })
    expect(useStore.getState().enhancing).toBe(true)
    expect(useStore.getState().enhanceResult).toEqual({ original: '帮我写个函数', model: 'GLM-5.2' })
  })

  it('配置润色专用模型：请求优先带专用模型而非会话模型', () => {
    storage.set(
      'zcode.enhance.config',
      JSON.stringify({ enhanceEnabled: true, enhanceModel: { providerId: 'p-other', modelId: 'GLM-4.7' } }),
    )
    useStore.getState().enhancePrompt('用专用模型润色')
    const req = sentRequests.find((r) => r.op === 'enhancePrompt')
    expect(req).toMatchObject({ providerId: 'p-other', modelId: 'GLM-4.7' })
    expect(useStore.getState().enhanceResult?.model).toBe('GLM-4.7')
    // 专用模型格式坏（缺 providerId）：按未配置处理回退会话模型
    messageHandler!({ op: 'enhancePromptResult', seq: lastEnhanceSeq(), original: '用专用模型润色', text: 'ok' })
    storage.set('zcode.enhance.config', JSON.stringify({ enhanceEnabled: true, enhanceModel: { modelId: 'GLM-4.7' } }))
    useStore.getState().enhancePrompt('坏配置回退')
    const req2 = sentRequests.find((r) => r.op === 'enhancePrompt' && (r as any).text === '坏配置回退')
    expect(req2).toMatchObject({ providerId: 'builtin:bigmodel-coding-plan', modelId: 'GLM-5.2' })
  })

  it('空文本不触发请求；在途中改文再点=新请求（latest-wins）', () => {
    useStore.getState().enhancePrompt('   ')
    expect(sentRequests.filter((r) => r.op === 'enhancePrompt')).toHaveLength(0)
    useStore.getState().enhancePrompt('第一条')
    // 在途中点不同文本：开新请求顶掉旧代，而非复用
    useStore.getState().enhancePrompt('第二条')
    const reqs = sentRequests.filter((r) => r.op === 'enhancePrompt')
    expect(reqs).toHaveLength(2)
    expect(useStore.getState().enhanceResult?.original).toBe('第二条')
  })

  it('enhancePromptResult 成功落地：model 覆盖占位（后端兜底回退时徽标更新）', () => {
    useStore.getState().enhancePrompt('原文')
    const seq = lastEnhanceSeq()
    messageHandler!({ op: 'enhancePromptResult', seq, original: '原文', text: '润色后', model: 'GLM-5.3' })
    const s = useStore.getState()
    expect(s.enhancing).toBe(false)
    expect(s.enhanceResult).toEqual({ original: '原文', text: '润色后', model: 'GLM-5.3' })
  })

  it('enhancePromptResult 失败落地（错误态，model 保留占位；原文不丢）', () => {
    useStore.getState().enhancePrompt('原文')
    messageHandler!({ op: 'enhancePromptResult', seq: lastEnhanceSeq(), error: 'CLI 超时' })
    const s = useStore.getState()
    expect(s.enhancing).toBe(false)
    expect(s.enhanceResult?.error).toBe('CLI 超时')
    expect(s.enhanceResult?.original).toBe('原文')
    expect(s.enhanceResult?.model).toBe('GLM-5.2')
  })

  it('clearEnhanceResult 整体重置（关弹窗+弃结果+作废代际）', () => {
    useStore.getState().enhancePrompt('原文')
    messageHandler!({ op: 'enhancePromptResult', seq: lastEnhanceSeq(), original: '原文', text: '润色后' })
    useStore.getState().clearEnhanceResult()
    expect(useStore.getState().enhanceResult).toBeNull()
    expect(useStore.getState().enhancing).toBe(false)
    expect(useStore.getState().enhanceDialogOpen).toBe(false)
  })
})

/** 最近一次 enhancePrompt 请求的代际（Kotlin 回包按此透传 seq）*/
function lastEnhanceSeq(): number {
  const req = sentRequests.filter((r) => r.op === 'enhancePrompt').pop() as { seq?: number }
  return req.seq ?? -1
}

describe('润色弹窗复用（issue #22 交互：关弹窗不弃请求，再点按钮复现）', () => {
  it('润色中关弹窗：仅藏弹窗不弃请求；迟到回包静默落地且弹窗不复活', () => {
    useStore.getState().enhancePrompt('原文')
    const seq = lastEnhanceSeq()
    // loading 中点「保留原始」/Esc/点空白关闭（润色继续在途）
    useStore.getState().closeEnhanceDialog()
    expect(useStore.getState().enhanceDialogOpen).toBe(false)
    expect(useStore.getState().enhancing).toBe(true)
    // 迟到回包落地进状态（供复现），弹窗不自动顶出来
    messageHandler!({ op: 'enhancePromptResult', seq, original: '原文', text: '迟到的结果' })
    const s = useStore.getState()
    expect(s.enhancing).toBe(false)
    expect(s.enhanceDialogOpen).toBe(false)
    expect(s.enhanceResult?.text).toBe('迟到的结果')
  })

  it('润色中再点按钮：复用在途请求重开弹窗，不重发', () => {
    useStore.getState().enhancePrompt('原文')
    const seq = lastEnhanceSeq()
    useStore.getState().closeEnhanceDialog()
    useStore.getState().enhancePrompt('原文')
    expect(sentRequests.filter((r) => r.op === 'enhancePrompt')).toHaveLength(1)
    const s = useStore.getState()
    expect(s.enhanceDialogOpen).toBe(true)
    expect(s.enhancing).toBe(true)
    // 在途回包照常落到重开的弹窗
    messageHandler!({ op: 'enhancePromptResult', seq, original: '原文', text: '结果' })
    expect(useStore.getState().enhanceResult?.text).toBe('结果')
  })

  it('同文本已有完整结果再点：直接复用展示，不重烧模型', () => {
    useStore.getState().enhancePrompt('原文')
    messageHandler!({ op: 'enhancePromptResult', seq: lastEnhanceSeq(), original: '原文', text: '旧结果' })
    useStore.getState().closeEnhanceDialog()
    useStore.getState().enhancePrompt('原文')
    expect(sentRequests.filter((r) => r.op === 'enhancePrompt')).toHaveLength(1)
    const s = useStore.getState()
    expect(s.enhanceDialogOpen).toBe(true)
    expect(s.enhancing).toBe(false)
    expect(s.enhanceResult?.text).toBe('旧结果')
  })

  it('同文本但上次是失败态再点：重新发起', () => {
    useStore.getState().enhancePrompt('原文')
    messageHandler!({ op: 'enhancePromptResult', seq: lastEnhanceSeq(), error: '润色失败' })
    useStore.getState().closeEnhanceDialog()
    useStore.getState().enhancePrompt('原文')
    expect(sentRequests.filter((r) => r.op === 'enhancePrompt')).toHaveLength(2)
    expect(useStore.getState().enhancing).toBe(true)
  })

  it('在途中点不同文本：新请求顶掉旧代，旧回包不覆盖新 loading 态', () => {
    useStore.getState().enhancePrompt('第一次')
    const seq1 = lastEnhanceSeq()
    useStore.getState().enhancePrompt('第二次')
    const seq2 = lastEnhanceSeq()
    expect(seq2).not.toBe(seq1)
    // 旧代回包：不碰新请求的 loading/占位，也不误杀其超时兜底
    messageHandler!({ op: 'enhancePromptResult', seq: seq1, text: '旧结果' })
    let s = useStore.getState()
    expect(s.enhancing).toBe(true)
    expect(s.enhanceResult?.original).toBe('第二次')
    expect(s.enhanceResult?.text).toBeUndefined()
    // 新代回包正常落地
    messageHandler!({ op: 'enhancePromptResult', seq: seq2, original: '第二次', text: '新结果' })
    s = useStore.getState()
    expect(s.enhancing).toBe(false)
    expect(s.enhanceResult?.text).toBe('新结果')
  })

  it('无 seq 回包（异常帧）丢弃，loading 不受影响', () => {
    useStore.getState().enhancePrompt('原文')
    messageHandler!({ op: 'enhancePromptResult', text: '无代际' })
    expect(useStore.getState().enhancing).toBe(true)
  })

  it('取消润色：通知后端中止 + 本地即刻清场，迟到回包被代际守卫丢弃', () => {
    useStore.getState().enhancePrompt('原文')
    const seq = lastEnhanceSeq()
    useStore.getState().cancelEnhance()
    // 通知后端带活动代际；本地全部复位
    expect(sentRequests.some((r) => r.op === 'cancelEnhancePrompt' && (r as any).seq === seq)).toBe(true)
    const s = useStore.getState()
    expect(s.enhancing).toBe(false)
    expect(s.enhanceDialogOpen).toBe(false)
    expect(s.enhanceResult).toBeNull()
    // 中止后的错误回包（已取消）不再复活任何状态
    messageHandler!({ op: 'enhancePromptResult', seq, error: '已取消' })
    expect(useStore.getState().enhanceResult).toBeNull()
    expect(useStore.getState().enhancing).toBe(false)
    // 取消后同文再点 = 全新请求
    useStore.getState().enhancePrompt('原文')
    expect(sentRequests.filter((r) => r.op === 'enhancePrompt')).toHaveLength(2)
  })

  it('busy/异常错误回包不带 original：保留弹窗原文不落空串', () => {
    useStore.getState().enhancePrompt('第二次')
    const seq = lastEnhanceSeq()
    messageHandler!({ op: 'enhancePromptResult', seq, error: '润色进行中，请稍候' })
    const s = useStore.getState()
    expect(s.enhancing).toBe(false)
    expect(s.enhanceResult?.error).toBe('润色进行中，请稍候')
    expect(s.enhanceResult?.original).toBe('第二次')
  })
})

describe('PromptEnhancerDialog 交互', () => {
  it('loading 态：spinner + 计时/走条/耐心提示 + 取消按钮（点击回调 onCancel）', () => {
    const onCancel = vi.fn()
    render(
      <PromptEnhancerDialog
        enhancing={true}
        result={{ original: '原文' }}
        onUse={() => {}}
        onClose={() => {}}
        onCancel={onCancel}
      />,
    )
    expect(document.querySelector('.prompt-enhancer__loading')).toBeTruthy()
    expect(document.querySelector('.prompt-enhancer__progress')).toBeTruthy()
    expect(document.querySelector('.prompt-enhancer__hint')?.textContent).toContain('10~30')
    expect(document.querySelector('.prompt-enhancer__elapsed')?.textContent).toMatch(/0/)
    expect((screen.getByRole('button', { name: /使用润色|Use enhanced/ }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /保留原始|Keep original/ }) as HTMLButtonElement).disabled).toBe(false)
    // 取消按钮仅 loading 态渲染
    fireEvent.click(screen.getByRole('button', { name: /取消润色|Cancel/ }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('非 loading 态不渲染取消按钮', () => {
    render(
      <PromptEnhancerDialog
        enhancing={false}
        result={{ original: '原文', error: 'boom' }}
        onUse={() => {}}
        onClose={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(screen.queryByRole('button', { name: /取消润色|Cancel/ })).toBeNull()
  })

  it('错误态：显示错误 + 只能关闭', () => {
    render(
      <PromptEnhancerDialog
        enhancing={false}
        result={{ original: '原文', error: 'boom' }}
        onUse={() => {}}
        onClose={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(document.querySelector('.prompt-enhancer__error')?.textContent).toContain('boom')
    expect((screen.getByRole('button', { name: /使用润色|Use enhanced/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('模型徽标：有 model 时标题行右侧渲染，无 model 不渲染', () => {
    const { rerender } = render(
      <PromptEnhancerDialog enhancing={false} result={{ original: '原文', text: '结果', model: 'GLM-5.3' }} onUse={() => {}} onClose={() => {}} onCancel={() => {}} />,
    )
    expect(document.querySelector('.prompt-enhancer__model')?.textContent).toBe('GLM-5.3')
    rerender(
      <PromptEnhancerDialog enhancing={false} result={{ original: '原文', text: '结果' }} onUse={() => {}} onClose={() => {}} onCancel={() => {}} />,
    )
    expect(document.querySelector('.prompt-enhancer__model')).toBeNull()
  })

  it('结果态：Enter=使用、Esc=关闭、点击「使用」回调带文本', () => {
    const onUse = vi.fn()
    const onClose = vi.fn()
    render(
      <PromptEnhancerDialog
        enhancing={false}
        result={{ original: '原文', text: '润色结果' }}
        onUse={onUse}
        onClose={onClose}
        onCancel={() => {}}
      />,
    )
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onUse).toHaveBeenCalledWith('润色结果')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: /使用润色|Use enhanced/ }))
    expect(onUse).toHaveBeenCalledTimes(2)
  })
})

describe('子智能体（store + AgentSelect）', () => {
  it('agents 响应落地 subagentDefs', () => {
    messageHandler!({ op: 'agents', agents: [agentDef(), agentDef({ name: 'b', scope: 'project' })] })
    expect(useStore.getState().subagentDefs).toHaveLength(2)
  })

  it('agentDeleted 响应清掉当前选中并重拉清单', () => {
    useStore.setState({ selectedAgent: agentDef(), subagentDefs: [agentDef()] })
    messageHandler!({ op: 'agentDeleted', name: 'test-agent', scope: 'user' })
    expect(useStore.getState().selectedAgent).toBeNull()
    expect(sentRequests.some((r) => r.op === 'listAgents')).toBe(true)
  })

  it('agentSaved 响应置保存完成信号（AgentEditDialog 监听关弹窗——保存超时假象的回归）', () => {
    messageHandler!({ op: 'agentSaved', name: 'my-agent', scope: 'user' })
    const signal = useStore.getState().agentSavedSignal
    expect(signal).toBeTruthy()
    expect(signal!.name).toBe('my-agent')
    expect(signal!.scope).toBe('user')
    expect(sentRequests.some((r) => r.op === 'listAgents')).toBe(true)
  })

  it('AgentSelect：点选中项=取消，点其他项=切换；管理入口回调', () => {
    useStore.setState({ subagentDefs: [agentDef(), agentDef({ name: 'reviewer', color: 'purple' })] })
    const onManage = vi.fn()
    const { container } = render(<AgentSelect onManage={onManage} />)
    fireEvent.click(container.querySelector('.agent-select-button')!)
    // 两项 + 管理入口
    expect(container.querySelectorAll('.selector-dropdown-item')).toHaveLength(2)
    fireEvent.click(container.querySelectorAll('.selector-dropdown-item')[0])
    expect(useStore.getState().selectedAgent?.name).toBe('test-agent')
    // 重新打开，点已选中项 = 取消
    fireEvent.click(container.querySelector('.agent-select-button')!)
    fireEvent.click(container.querySelectorAll('.selector-dropdown-item')[0])
    expect(useStore.getState().selectedAgent).toBeNull()
    // 管理入口
    fireEvent.click(container.querySelector('.agent-select-button')!)
    fireEvent.click(container.querySelector('.agent-select-manage')!)
    expect(onManage).toHaveBeenCalledTimes(1)
  })
})

describe('InputBox 发送拼装（@<name> 前缀）', () => {
  function setup(selected: AgentDef | null) {
    useStore.setState({ selectedAgent: selected })
    const onSend = vi.fn()
    render(
      <InputBox
        onSend={onSend}
        currentModel={{ modelId: 'GLM-5.2', providerId: 'p1' }}
        onModelSelect={() => {}}
      />,
    )
    const editor = document.querySelector('.input-editable') as HTMLDivElement
    editor.textContent = '帮我看看这段代码'
    fireEvent.input(editor)
    return { onSend, editor }
  }

  it('选中子智能体：发送文本前置 @test-agent', async () => {
    const { onSend } = setup(agentDef())
    fireEvent.click(screen.getByRole('button', { name: /^发送 \(Enter\)$/ }))
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect(onSend.mock.calls[0][0]).toBe('@test-agent\n帮我看看这段代码')
  })

  it('未选中：不带 @ 前缀', async () => {
    const { onSend } = setup(null)
    fireEvent.click(screen.getByRole('button', { name: /^发送 \(Enter\)$/ }))
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect(onSend.mock.calls[0][0]).toBe('帮我看看这段代码')
  })

  it('润色按钮：点击发 enhancePrompt 请求（带编辑器正文）', () => {
    const { editor } = setup(null)
    editor.textContent = '写一个排序函数'
    fireEvent.input(editor)
    fireEvent.click(document.querySelector('.enhance-prompt-button')!)
    const req = sentRequests.find((r) => r.op === 'enhancePrompt')
    expect(req).toMatchObject({ text: '写一个排序函数' })
  })

  it('使用润色结果（issue #22）：长结果折叠为内联粘贴 chip 不撑满输入框，发送时按位展开', async () => {
    const { onSend, editor } = setup(null)
    editor.textContent = '短原文'
    fireEvent.input(editor)
    fireEvent.click(document.querySelector('.enhance-prompt-button')!)
    // 超阈值结果（≥10 行）：沿用粘贴规则折叠为 chip。
    // （InputBox mount 会覆盖 mock 的 messageHandler，回包须直调 store 分发链路）
    const longText = Array.from({ length: 12 }, (_, i) => `润色结果第${i}行内容`).join('\n')
    act(() => {
      handleResponse(
        { op: 'enhancePromptResult', seq: lastEnhanceSeq(), original: '短原文', text: longText },
        useStore.setState,
        useStore.getState,
      )
    })
    fireEvent.click(screen.getByRole('button', { name: /使用润色|Use enhanced/ }))
    expect(editor.querySelector('.paste-ref--inline')).toBeTruthy()
    expect(editor.textContent).not.toContain('润色结果第3行内容')
    // 发送时序列化按位展开全文
    fireEvent.click(screen.getByRole('button', { name: /^发送 \(Enter\)$/ }))
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect(onSend.mock.calls[0][0]).toContain('润色结果第3行内容')
  })

  it('使用润色结果：短结果直接替换编辑器正文（不折叠）', () => {
    const { editor } = setup(null)
    editor.textContent = '原文'
    fireEvent.input(editor)
    fireEvent.click(document.querySelector('.enhance-prompt-button')!)
    act(() => {
      handleResponse(
        { op: 'enhancePromptResult', seq: lastEnhanceSeq(), original: '原文', text: '润色后的短结果' },
        useStore.setState,
        useStore.getState,
      )
    })
    fireEvent.click(screen.getByRole('button', { name: /使用润色|Use enhanced/ }))
    expect(editor.querySelector('.paste-ref--inline')).toBeNull()
    expect(editor.textContent).toContain('润色后的短结果')
  })

  it('润色按钮悬浮提示：有文本=功能说明（portal 信息卡，JCEF 无原生 title）', () => {
    const { } = setup(null)
    const btn = document.querySelector('.enhance-prompt-button') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    fireEvent.mouseEnter(btn)
    const tip = document.body.querySelector('.model-info-tip') as HTMLDivElement
    expect(tip).toBeTruthy()
    expect(tip.textContent).toBe('AI 润色：优化输入框内容，确认后替换')
    fireEvent.mouseLeave(btn)
    expect(document.body.querySelector('.model-info-tip')).toBeNull()
  })

  it('润色按钮悬浮提示：空输入禁用态=引导文案（pointer-events 保 hover 可达）', () => {
    // 直接渲染、从不填入文本：按钮初始即 disabled
    render(
      <InputBox
        onSend={() => {}}
        currentModel={{ modelId: 'GLM-5.2', providerId: 'p1' }}
        onModelSelect={() => {}}
      />,
    )
    const btn = document.querySelector('.enhance-prompt-button') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.mouseEnter(btn)
    const tip = document.body.querySelector('.model-info-tip') as HTMLDivElement
    expect(tip).toBeTruthy()
    expect(tip.textContent).toBe('AI 润色：输入内容后可用')
  })

  it('功能开关：默认关闭不渲染按钮；开启事件即时显示', async () => {
    storage.delete('zcode.enhance.config')
    render(
      <InputBox
        onSend={() => {}}
        currentModel={{ modelId: 'GLM-5.2', providerId: 'p1' }}
        onModelSelect={() => {}}
      />,
    )
    // 默认关闭：按钮与悬浮提示逻辑都不在 DOM
    expect(document.querySelector('.enhance-prompt-button')).toBeNull()
    // 设置页写入（dispatch 同标签变更事件）→ InputBox 重读即时显示
    writeEnhanceConfig({ enhanceEnabled: true })
    await waitFor(() => {
      expect(document.querySelector('.enhance-prompt-button')).toBeTruthy()
    })
  })
})
