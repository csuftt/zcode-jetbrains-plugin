/**
 * modelSet 即时切换分隔卡测试（2026-09-02）
 *
 * 背景（协议实测）：服务端 model_change marker 在下一次 send 才落库、不走流式事件
 * 推送——切换成功瞬间界面无反馈，直到"再发一条消息+回合结束重拉"才浮现。修复：
 * modelSet 应答到达（含延迟补发路径补推）时本地合成一条 timeline 消息插入消息流
 * 尾部；任何历史重拉整包替换后由服务端真身无缝接管。
 *
 * 覆盖：
 * 1. 切换成功（非流式）：消息流尾部出现 model_change 合成分隔卡，from=切换前模型、
 *    to=目标模型；currentModel 翻转
 * 2. 历史重拉（op:messages 全量）落地后：合成卡被服务端数据整包替换（不双条）
 * 3. 流式期间到达的延迟补发：不插入（插入点会错到流式消息之后，交给回合结束重拉）
 * 4. 非当前会话的迟到补发：丢弃，不污染当前会话
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

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

import { useStore } from '@/store/useStore'

const SID = 'sess_test_1'

function timelineCards() {
  return useStore.getState().messages.filter(
    (m) => m.info.role === 'assistant' && m.parts.some((p) => p.type === 'timeline'),
  )
}

beforeEach(() => {
  sentRequests.length = 0
  useStore.getState().init()
  sentRequests.length = 0
  useStore.setState({
    currentSessionId: SID,
    streaming: false,
    syntheticModelChanges: {},
    currentModel: { modelId: 'GLM-5.3', providerId: 'builtin:bigmodel-coding-plan' },
    modelSwitchPrevModel: { modelId: 'GLM-5.3', providerId: 'builtin:bigmodel-coding-plan' },
    messages: [
      { info: { role: 'user', id: 'u1', time: { created: 1 } }, parts: [{ type: 'text', text: 'hi' }] },
      { info: { role: 'assistant', id: 'a1', time: { created: 2 } }, parts: [{ type: 'text', text: 'hello' }] },
    ],
  })
})
afterEach(cleanup)

describe('modelSet 合成切换分隔卡', () => {
  it('非流式切换成功：尾部插入 model_change 卡，from/to 正确', () => {
    messageHandler!({
      op: 'modelSet',
      sessionId: SID,
      modelId: 'GLM-5.3-Flash',
      providerId: 'builtin:bigmodel-coding-plan',
    })
    const s = useStore.getState()
    expect(s.currentModel).toEqual({ modelId: 'GLM-5.3-Flash', providerId: 'builtin:bigmodel-coding-plan' })
    const cards = timelineCards()
    expect(cards).toHaveLength(1)
    expect(s.messages[s.messages.length - 1].info.id).toMatch(/^synthetic-model-change-/)
    const part = cards[0].parts.find((p) => p.type === 'timeline') as {
      timelineType?: string
      fromModel?: { modelId?: string }
      toModel?: { modelId?: string }
    }
    expect(part.timelineType).toBe('model_change')
    expect(part.fromModel?.modelId).toBe('GLM-5.3')
    expect(part.toModel?.modelId).toBe('GLM-5.3-Flash')
  })

  it('历史重拉落地：合成卡被整包替换（服务端真身接管，不双条）', () => {
    messageHandler!({
      op: 'modelSet',
      sessionId: SID,
      modelId: 'GLM-5.3-Flash',
      providerId: 'builtin:bigmodel-coding-plan',
    })
    expect(timelineCards()).toHaveLength(1)
    // 回合结束重拉：服务端返回（marker 真身 + 原有消息）
    messageHandler!({
      op: 'messages',
      sessionId: SID,
      messages: [
        { info: { role: 'user', id: 'u1', time: { created: 1 } }, parts: [{ type: 'text', text: 'hi' }] },
        {
          info: { role: 'assistant', id: 'm_real', time: { created: 2 } },
          parts: [{ type: 'timeline', timelineType: 'model_change', fromModel: { modelId: 'GLM-5.3' }, toModel: { modelId: 'GLM-5.3-Flash' } }],
        },
        { info: { role: 'assistant', id: 'a1', time: { created: 3 } }, parts: [{ type: 'text', text: 'hello' }] },
      ],
    })
    const cards = timelineCards()
    expect(cards).toHaveLength(1)
    expect(cards[0].info.id).toBe('m_real')
    expect(useStore.getState().messages.some((m) => String(m.info.id).startsWith('synthetic-model-change-'))).toBe(false)
  })

  it('流式期间到达（延迟补发恰逢下一回合已开跑）：不插入', () => {
    useStore.setState({ streaming: true })
    messageHandler!({
      op: 'modelSet',
      sessionId: SID,
      modelId: 'GLM-5.3-Flash',
      providerId: 'builtin:bigmodel-coding-plan',
    })
    expect(timelineCards()).toHaveLength(0)
    // 状态翻转照常（仅跳过分隔卡插入）
    expect(useStore.getState().currentModel?.modelId).toBe('GLM-5.3-Flash')
  })

  it('非当前会话的迟到补发：丢弃', () => {
    messageHandler!({
      op: 'modelSet',
      sessionId: 'sess_other',
      modelId: 'GLM-5.3-Flash',
      providerId: 'builtin:bigmodel-coding-plan',
    })
    expect(timelineCards()).toHaveLength(0)
    expect(useStore.getState().currentModel?.modelId).toBe('GLM-5.3')
  })

  it('延迟切换：回合结束重拉快照无 marker，合成卡被顶掉后补挂回来', () => {
    messageHandler!({
      op: 'modelSet',
      sessionId: SID,
      modelId: 'GLM-5.3-Flash',
      providerId: 'builtin:bigmodel-coding-plan',
    })
    expect(timelineCards()).toHaveLength(1)
    // 回合结束重拉：服务端 marker 下次 send 才落库，快照里没有 model_change
    messageHandler!({
      op: 'messages',
      sessionId: SID,
      messages: [
        { info: { role: 'user', id: 'u1', time: { created: 1 } }, parts: [{ type: 'text', text: 'hi' }] },
        { info: { role: 'assistant', id: 'a1', time: { created: 2 } }, parts: [{ type: 'text', text: 'hello' }] },
      ],
    })
    const cards = timelineCards()
    expect(cards).toHaveLength(1)
    expect(cards[0].info.id).toMatch(/^synthetic-model-change-/)
    expect(useStore.getState().messages[useStore.getState().messages.length - 1].info.id)
      .toMatch(/^synthetic-model-change-/)
    // 暂存保留，等下一次重拉出现真身后摘除
    expect(useStore.getState().syntheticModelChanges[SID]).toHaveLength(1)
  })

  it('后续重拉出现服务端 marker 真身：合成卡摘除，不双条', () => {
    messageHandler!({
      op: 'modelSet',
      sessionId: SID,
      modelId: 'GLM-5.3-Flash',
      providerId: 'builtin:bigmodel-coding-plan',
    })
    // 首次重拉无 marker → 补挂
    messageHandler!({
      op: 'messages',
      sessionId: SID,
      messages: [
        { info: { role: 'user', id: 'u1', time: { created: 1 } }, parts: [{ type: 'text', text: 'hi' }] },
      ],
    })
    expect(timelineCards()).toHaveLength(1)
    // 下一次 send 后 marker 落库，回合结束重拉带真身
    messageHandler!({
      op: 'messages',
      sessionId: SID,
      messages: [
        { info: { role: 'user', id: 'u2', time: { created: 3 } }, parts: [{ type: 'text', text: 'next' }] },
        {
          info: { role: 'assistant', id: 'm_real', time: { created: 4 } },
          parts: [{ type: 'timeline', timelineType: 'model_change', toModel: { modelId: 'GLM-5.3-Flash' } }],
        },
        { info: { role: 'assistant', id: 'a2', time: { created: 5 } }, parts: [{ type: 'text', text: 'ok' }] },
      ],
    })
    const cards = timelineCards()
    expect(cards).toHaveLength(1)
    expect(cards[0].info.id).toBe('m_real')
    expect(useStore.getState().syntheticModelChanges[SID]).toHaveLength(0)
  })

  it('连续切换折叠：A→B 后再 B→C，只留一张卡，from 锚定起点 to 最新', () => {
    messageHandler!({
      op: 'modelSet',
      sessionId: SID,
      modelId: 'GLM-5.3-Flash',
      providerId: 'builtin:bigmodel-coding-plan',
    })
    messageHandler!({
      op: 'modelSet',
      sessionId: SID,
      modelId: 'GLM-5-Turbo',
      providerId: 'builtin:bigmodel-coding-plan',
    })
    const cards = timelineCards()
    expect(cards).toHaveLength(1)
    const part = cards[0].parts.find((p) => p.type === 'timeline') as {
      fromModel?: { modelId?: string }
      toModel?: { modelId?: string }
    }
    expect(part.fromModel?.modelId).toBe('GLM-5.3')
    expect(part.toModel?.modelId).toBe('GLM-5-Turbo')
    expect(useStore.getState().syntheticModelChanges[SID]).toHaveLength(1)
  })

  it('连续切换切回起点：净变化为零，卡整体隐藏', () => {
    messageHandler!({
      op: 'modelSet',
      sessionId: SID,
      modelId: 'GLM-5.3-Flash',
      providerId: 'builtin:bigmodel-coding-plan',
    })
    expect(timelineCards()).toHaveLength(1)
    messageHandler!({
      op: 'modelSet',
      sessionId: SID,
      modelId: 'GLM-5.3',
      providerId: 'builtin:bigmodel-coding-plan',
    })
    expect(timelineCards()).toHaveLength(0)
    expect(useStore.getState().syntheticModelChanges[SID]).toHaveLength(0)
    expect(useStore.getState().messages.some((m) => String(m.info.id).startsWith('synthetic-model-change-'))).toBe(false)
  })

  it('两次切换之间发过消息（尾部非合成卡）：不折叠，追加新卡锚定新起点', () => {
    messageHandler!({
      op: 'modelSet',
      sessionId: SID,
      modelId: 'GLM-5.3-Flash',
      providerId: 'builtin:bigmodel-coding-plan',
    })
    // 模拟之间发生了 send：快照无 marker 落地补挂 A→B 后，又有新消息进流
    messageHandler!({
      op: 'messages',
      sessionId: SID,
      messages: [
        { info: { role: 'user', id: 'u1', time: { created: 1 } }, parts: [{ type: 'text', text: 'hi' }] },
        { info: { role: 'assistant', id: 'a1', time: { created: 2 } }, parts: [{ type: 'text', text: 'hello' }] },
      ],
    })
    useStore.setState({
      messages: [
        ...useStore.getState().messages,
        { info: { role: 'user', id: 'u9', time: { created: 9 } }, parts: [{ type: 'text', text: 'next q' }] },
      ],
    })
    messageHandler!({
      op: 'modelSet',
      sessionId: SID,
      modelId: 'GLM-5-Turbo',
      providerId: 'builtin:bigmodel-coding-plan',
    })
    const cards = timelineCards()
    expect(cards).toHaveLength(2)
    const part = cards[1].parts.find((p) => p.type === 'timeline') as {
      fromModel?: { modelId?: string }
      toModel?: { modelId?: string }
    }
    expect(part.fromModel?.modelId).toBe('GLM-5.3-Flash')
    expect(part.toModel?.modelId).toBe('GLM-5-Turbo')
    expect(useStore.getState().syntheticModelChanges[SID]).toHaveLength(2)
  })

  it('初始注册（prev==目标，如 applyModelIfReady 自动下发）不合成卡', () => {
    // applyModelIfReady 先置 currentModel=目标再发 setModel → 应答时 prev==to（A→A）
    useStore.setState({ modelSwitchPrevModel: null })
    messageHandler!({
      op: 'modelSet',
      sessionId: SID,
      modelId: 'GLM-5.3',
      providerId: 'builtin:bigmodel-coding-plan',
    })
    expect(timelineCards()).toHaveLength(0)
    expect(useStore.getState().syntheticModelChanges[SID] ?? []).toHaveLength(0)
    // currentModel 等状态翻转照常
    expect(useStore.getState().currentModel?.modelId).toBe('GLM-5.3')
  })

  it('服务端无 fromModel 的初始注册 marker（会话置顶）：主界面整条隐藏', async () => {
    const { MessageBubble } = await import('@/components/MessageBubble')
    const { render } = await import('@testing-library/react')
    const { container } = render(
      <MessageBubble
        message={{
          info: { role: 'assistant', id: 'm_init', sessionID: SID, time: { created: 5 } },
          parts: [{
            type: 'timeline',
            timelineType: 'model_change',
            toModel: { modelId: 'GLM-5.3', label: 'builtin:bigmodel-coding-plan/GLM-5.3' },
          }],
        }}
      />,
    )
    expect(container.querySelectorAll('.tl-sep')).toHaveLength(0)
    expect(container.textContent).toBe('')
  })

  it('快照置顶带 fromModel 的注册 marker（新 CLI 形态）被剔除，中间真实切换保留', () => {
    // 新 CLI 实测（2026-09-03 db.sqlite）：置顶 marker 带 fromModel（默认→注册），
    // 「无 fromModel」判据失效，须按位置剔除
    messageHandler!({
      op: 'messages',
      sessionId: SID,
      messages: [
        {
          info: { role: 'assistant', id: 'm_reg', time: { created: 1 } },
          parts: [{
            type: 'timeline',
            timelineType: 'model_change',
            fromModel: { modelId: 'GLM-5.3', label: 'builtin:bigmodel-coding-plan/GLM-5.3' },
            toModel: { modelId: 'GLM-5.3-Flash', label: 'builtin:bigmodel-coding-plan/GLM-5.3-Flash' },
          }],
        },
        { info: { role: 'user', id: 'u1', time: { created: 2 } }, parts: [{ type: 'text', text: 'hi' }] },
        { info: { role: 'assistant', id: 'a1', time: { created: 3 } }, parts: [{ type: 'text', text: 'hello' }] },
      ],
    })
    // 置顶注册 marker 被剔除
    expect(timelineCards()).toHaveLength(0)
    expect(useStore.getState().messages[0].info.id).toBe('u1')
    // 中间真实切换（首条消息之后）保留
    messageHandler!({
      op: 'messages',
      sessionId: SID,
      messages: [
        { info: { role: 'user', id: 'u1', time: { created: 2 } }, parts: [{ type: 'text', text: 'hi' }] },
        {
          info: { role: 'assistant', id: 'm_mid', time: { created: 3 } },
          parts: [{
            type: 'timeline',
            timelineType: 'model_change',
            fromModel: { modelId: 'GLM-5.3-Flash' },
            toModel: { modelId: 'GLM-5-Turbo' },
          }],
        },
        { info: { role: 'assistant', id: 'a1', time: { created: 4 } }, parts: [{ type: 'text', text: 'hello' }] },
      ],
    })
    const cards = timelineCards()
    expect(cards).toHaveLength(1)
    expect(cards[0].info.id).toBe('m_mid')
  })

  it('from==to 的净零 marker（服务端连相同模型注册重放也记）：渲染层隐藏', async () => {
    const { MessageBubble } = await import('@/components/MessageBubble')
    const { render } = await import('@testing-library/react')
    const { container } = render(
      <MessageBubble
        message={{
          info: { role: 'assistant', id: 'm_zero', sessionID: SID, time: { created: 6 } },
          parts: [{
            type: 'timeline',
            timelineType: 'model_change',
            fromModel: { modelId: 'GLM-5.3-Flash', label: 'builtin/GLM-5.3-Flash' },
            toModel: { modelId: 'GLM-5.3-Flash', label: 'builtin/GLM-5.3-Flash' },
          }],
        }}
      />,
    )
    expect(container.querySelectorAll('.tl-sep')).toHaveLength(0)
  })
})

describe('model_change 供应商维度（2026-09-14：跨供应商切换带供应名 + 净零判定含 provider）', () => {
  // 供应名映射数据源（config.json 注册表形态）
  const MODELS = [
    { providerId: 'builtin:bigmodel-coding-plan', providerName: 'BigModel - Coding Plan', modelId: 'GLM-5.3', modelName: 'GLM-5.3' },
    { providerId: '3556624f-b163-4731-905c-9ec6f6a7a7e2', providerName: '千问', modelId: 'qwen3.8-max', modelName: 'qwen3.8-max' },
    { providerId: 'anthropic', providerName: 'Anthropic', modelId: 'GLM-5.3', modelName: 'GLM-5.3' },
    // 两个内置套餐 providerId 不同、name 相同（真实 config.json 实测形态）
    { providerId: 'builtin:zai-coding-plan', providerName: 'Z.ai - Coding Plan', modelId: 'GLM-5.3', modelName: 'GLM-5.3' },
    { providerId: 'builtin:zai-start-plan', providerName: 'Z.ai - Coding Plan', modelId: 'GLM-5.3-Flash', modelName: 'GLM-5.3-Flash' },
  ]

  beforeEach(() => {
    sentRequests.length = 0
    useStore.getState().init()
    sentRequests.length = 0
    useStore.setState({
      currentSessionId: SID,
      streaming: false,
      syntheticModelChanges: {},
      models: MODELS as never,
      currentModel: { modelId: 'GLM-5.3', providerId: 'builtin:bigmodel-coding-plan' },
      modelSwitchPrevModel: { modelId: 'GLM-5.3', providerId: 'builtin:bigmodel-coding-plan' },
      messages: [
        { info: { role: 'user', id: 'u1', time: { created: 1 } }, parts: [{ type: 'text', text: 'hi' }] },
      ],
    })
  })
  afterEach(cleanup)

  it('跨供应商切换：合成卡 from/to 带 providerID', () => {
    messageHandler!({
      op: 'modelSet',
      sessionId: SID,
      modelId: 'qwen3.8-max',
      providerId: '3556624f-b163-4731-905c-9ec6f6a7a7e2',
    })
    const cards = timelineCards()
    expect(cards).toHaveLength(1)
    const part = cards[0].parts.find((p) => p.type === 'timeline') as {
      fromModel?: { modelId?: string; providerID?: string }
      toModel?: { modelId?: string; providerID?: string }
    }
    expect(part.fromModel?.modelId).toBe('GLM-5.3')
    expect(part.fromModel?.providerID).toBe('builtin:bigmodel-coding-plan')
    expect(part.toModel?.modelId).toBe('qwen3.8-max')
    expect(part.toModel?.providerID).toBe('3556624f-b163-4731-905c-9ec6f6a7a7e2')
  })

  it('同名模型跨供应商切换：门禁不吞（prev 与目标同名不同供应商是真切换）', () => {
    messageHandler!({
      op: 'modelSet',
      sessionId: SID,
      modelId: 'GLM-5.3',
      providerId: 'anthropic',
    })
    const cards = timelineCards()
    expect(cards).toHaveLength(1)
    const part = cards[0].parts.find((p) => p.type === 'timeline') as {
      fromModel?: { providerID?: string }
      toModel?: { providerID?: string }
    }
    expect(part.fromModel?.providerID).toBe('builtin:bigmodel-coding-plan')
    expect(part.toModel?.providerID).toBe('anthropic')
  })

  it('同名跨供应商折叠链：A@p1 → A@p2 不折叠隐藏，再切回 A@p1 才净零', () => {
    messageHandler!({ op: 'modelSet', sessionId: SID, modelId: 'GLM-5.3', providerId: 'anthropic' })
    expect(timelineCards()).toHaveLength(1)
    messageHandler!({ op: 'modelSet', sessionId: SID, modelId: 'GLM-5.3', providerId: 'builtin:bigmodel-coding-plan' })
    expect(timelineCards()).toHaveLength(0)
    expect(useStore.getState().syntheticModelChanges[SID]).toHaveLength(0)
  })

  it('供应商变化渲染：meta 两端带供应名（服务端 marker 带 providerID）', async () => {
    const { MessageBubble } = await import('@/components/MessageBubble')
    const { render } = await import('@testing-library/react')
    const { container } = render(
      <MessageBubble
        message={{
          info: { role: 'assistant', id: 'm_prov', sessionID: SID, time: { created: 7 } },
          parts: [{
            type: 'timeline',
            timelineType: 'model_change',
            fromModel: { modelId: 'GLM-5.3', providerID: 'builtin:bigmodel-coding-plan', label: 'builtin:bigmodel-coding-plan/GLM-5.3' },
            toModel: { modelId: 'qwen3.8-max', providerID: '3556624f-b163-4731-905c-9ec6f6a7a7e2', label: '3556624f-b163-4731-905c-9ec6f6a7a7e2/qwen3.8-max' },
          }],
        }}
      />,
    )
    const meta = container.querySelector('.tl-sep__meta')
    expect(meta?.textContent).toBe('GLM-5.3 (BigModel - Coding Plan) → qwen3.8-max (千问)')
  })

  it('供应商相同：尾部只带一个供应名（不两端重复）', async () => {
    const { MessageBubble } = await import('@/components/MessageBubble')
    const { render } = await import('@testing-library/react')
    const { container } = render(
      <MessageBubble
        message={{
          info: { role: 'assistant', id: 'm_same', sessionID: SID, time: { created: 8 } },
          parts: [{
            type: 'timeline',
            timelineType: 'model_change',
            fromModel: { modelId: 'GLM-5.3', providerID: 'builtin:bigmodel-coding-plan', label: 'builtin:bigmodel-coding-plan/GLM-5.3' },
            toModel: { modelId: 'GLM-5.3-Flash', providerID: 'builtin:bigmodel-coding-plan', label: 'builtin:bigmodel-coding-plan/GLM-5.3-Flash' },
          }],
        }}
      />,
    )
    const meta = container.querySelector('.tl-sep__meta')
    expect(meta?.textContent).toBe('GLM-5.3 → GLM-5.3-Flash (BigModel - Coding Plan)')
  })

  it('同名跨供应商净零 marker：不再被隐藏（渲染层净零判定含 provider）', async () => {
    const { MessageBubble } = await import('@/components/MessageBubble')
    const { render } = await import('@testing-library/react')
    const { container } = render(
      <MessageBubble
        message={{
          info: { role: 'assistant', id: 'm_xprov', sessionID: SID, time: { created: 9 } },
          parts: [{
            type: 'timeline',
            timelineType: 'model_change',
            fromModel: { modelId: 'GLM-5.3', providerID: 'builtin:bigmodel-coding-plan', label: 'builtin:bigmodel-coding-plan/GLM-5.3' },
            toModel: { modelId: 'GLM-5.3', providerID: 'anthropic', label: 'anthropic/GLM-5.3' },
          }],
        }}
      />,
    )
    expect(container.querySelectorAll('.tl-sep')).toHaveLength(1)
    const meta = container.querySelector('.tl-sep__meta')
    expect(meta?.textContent).toBe('GLM-5.3 (BigModel - Coding Plan) → GLM-5.3 (Anthropic)')
  })

  it('供应名映射未命中（渠道已删的历史会话）：回退剥 builtin: 前缀 / UUID 原样', async () => {
    useStore.setState({ models: [] as never })
    const { MessageBubble } = await import('@/components/MessageBubble')
    const { render } = await import('@testing-library/react')
    const { container } = render(
      <MessageBubble
        message={{
          info: { role: 'assistant', id: 'm_fallback', sessionID: SID, time: { created: 10 } },
          parts: [{
            type: 'timeline',
            timelineType: 'model_change',
            fromModel: { modelId: 'GLM-5.3', providerID: 'builtin:bigmodel' },
            toModel: { modelId: 'GLM-5.3', providerID: '27d2ecde-5da2-43bd-b2d8-dae985bfaf8f' },
          }],
        }}
      />,
    )
    const meta = container.querySelector('.tl-sep__meta')
    expect(meta?.textContent).toBe('GLM-5.3 (bigmodel) → GLM-5.3 (27d2ecde-5da2-43bd-b2d8-dae985bfaf8f)')
  })

  it('供应商变了但显示名相同（个人/团队内置套餐同 name）：只在尾部显示一个供应名', async () => {
    // 两个内置套餐 providerId 不同、config.json name 相同（types 注释实测）
    const { MessageBubble } = await import('@/components/MessageBubble')
    const { render } = await import('@testing-library/react')
    const { container } = render(
      <MessageBubble
        message={{
          info: { role: 'assistant', id: 'm_dupname', sessionID: SID, time: { created: 12 } },
          parts: [{
            type: 'timeline',
            timelineType: 'model_change',
            fromModel: { modelId: 'GLM-5.3', providerID: 'builtin:zai-coding-plan', label: 'builtin:zai-coding-plan/GLM-5.3' },
            toModel: { modelId: 'GLM-5.3-Flash', providerID: 'builtin:zai-start-plan', label: 'builtin:zai-start-plan/GLM-5.3-Flash' },
          }],
        }}
      />,
    )
    expect(container.querySelectorAll('.tl-sep')).toHaveLength(1)
    const meta = container.querySelector('.tl-sep__meta')
    expect(meta?.textContent).toBe('GLM-5.3 → GLM-5.3-Flash (Z.ai - Coding Plan)')
  })

  it('老 marker 无 providerID：保持原行为（净零判定 provider 缺失视为相同）', async () => {
    const { MessageBubble } = await import('@/components/MessageBubble')
    const { render } = await import('@testing-library/react')
    const { container } = render(
      <MessageBubble
        message={{
          info: { role: 'assistant', id: 'm_old', sessionID: SID, time: { created: 11 } },
          parts: [{
            type: 'timeline',
            timelineType: 'model_change',
            fromModel: { modelId: 'GLM-5.3-Flash' },
            toModel: { modelId: 'GLM-5.3-Flash' },
          }],
        }}
      />,
    )
    expect(container.querySelectorAll('.tl-sep')).toHaveLength(0)
  })
})
