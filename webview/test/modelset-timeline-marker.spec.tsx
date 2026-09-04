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
})
