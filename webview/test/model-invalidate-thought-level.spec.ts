/**
 * 模型失效与思考深度联动测试（store 级，2026-08-26）
 *
 * 背景：模型列表刷新（case 'models'）后当前模型被禁/删 → 只清 currentModel 会留下
 * 两个断点：① thoughtLevel 残留旧模型的级别集（off/high/max ↔ enabled/off 因模型
 * 而异），选择器在兜底模型上展示/下发非法级别（-32603）；② 下拉无勾选、按钮文字
 * 靠消息推断显示新模型名，用户看到"显示了 GLM 但没选中"的割裂状态。
 *
 * 锁定：
 * 1. 模型失效 + 消息可推断兜底：自动选中消息权威模型（下拉有勾），thoughtLevel 联动
 *    清空，有会话时补拉 settings 重建级别集
 * 2. 模型失效 + 推不出（无消息/旧模型消息）：保持清空占位，thoughtLevel 联动清空
 * 3. 模型健在：thoughtLevel 不受 models 响应影响
 * 4. refreshModels：置 modelsRefreshing 转圈标记，models 响应复位；防重复点击
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

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
import type { ZCodeMessage } from '@/types/messages'

function dispatch(msg: Record<string, unknown>) {
  messageHandler?.(msg)
}

const GLM = { providerId: 'p1', providerName: 'P1', modelId: 'glm', modelName: 'GLM' }

function assistantMsg(modelId: string, providerId: string): ZCodeMessage {
  return {
    info: { role: 'assistant', time: { created: 1 }, id: 'm1', modelID: modelId, providerID: providerId },
    parts: [{ type: 'text', text: 'hi' }],
  } as unknown as ZCodeMessage
}

function seed(messages: ZCodeMessage[]) {
  useStore.setState({
    currentSessionId: 'sess_live',
    models: [{ providerId: 'pq', providerName: 'Q', modelId: 'qwen', modelName: 'Qwen' }],
    currentModel: { modelId: 'qwen', providerId: 'pq' },
    modelInvalidated: false,
    messages,
    thoughtLevel: {
      available: [
        { label: 'off', value: 'off' },
        { label: 'high', value: 'high' },
      ],
      defaultLevel: 'high',
      current: 'high',
    },
    thoughtLevelAppliedForSession: 'sess_live',
    modelsRefreshing: false,
  })
}

beforeEach(() => {
  sentRequests.length = 0
  useStore.getState().init()
  seed([])
})

describe('模型失效与思考深度联动', () => {
  it('失效 + 消息可推断（服务端已回退 GLM）：兜底选中 GLM，thoughtLevel 清空并下发 setModel', () => {
    seed([assistantMsg('glm', 'p1')])
    dispatch({ op: 'models', models: [GLM] })
    const s = useStore.getState()
    // 下拉勾选恢复：currentModel = 消息权威模型
    expect(s.currentModel).toEqual({ modelId: 'glm', providerId: 'p1' })
    expect(s.modelInvalidated).toBe(true)
    // 级别集联动失效（等切换落定后的 settings 重建），applied 门控同步复位
    expect(s.thoughtLevel).toBeNull()
    expect(s.thoughtLevelAppliedForSession).toBeNull()
    // 有会话：补齐显式切换（服务端 settings 仍是旧模型档位，直接补拉会污染缓存）
    expect(
      sentRequests.some(
        (r) => r.op === 'setModel' && r.sessionId === 'sess_live' && r.modelId === 'glm' && r.providerId === 'p1',
      ),
    ).toBe(true)
    expect(s.modelSwitchInFlightAt).not.toBeNull()
  })

  it('失效 + 推不出（消息都是旧模型的）：保持清空占位，thoughtLevel 联动清空', () => {
    seed([assistantMsg('qwen', 'pq')])
    dispatch({ op: 'models', models: [GLM] })
    const s = useStore.getState()
    expect(s.currentModel).toBeNull()
    expect(s.modelInvalidated).toBe(true)
    expect(s.thoughtLevel).toBeNull()
    expect(s.thoughtLevelAppliedForSession).toBeNull()
  })

  it('失效 + 同名跨渠道（API Key 渠道切订阅套餐）：迁移到新渠道同名模型并下发 setModel', () => {
    // 客户端切渠道后旧 provider（p-old）整体下架，模型名 glm 不变：消息推断按旧
    // providerID 匹配不到 → 按 modelId 迁移到新渠道（p-new），否则下拉空占位、
    // 思考深度消失须手动重选（0.2.6 渠道切换实测反馈）
    seed([assistantMsg('glm', 'p-old')])
    dispatch({
      op: 'models',
      models: [{ providerId: 'p-new', providerName: 'NewPlan', modelId: 'glm', modelName: 'GLM' }],
    })
    const s = useStore.getState()
    expect(s.currentModel).toEqual({ modelId: 'glm', providerId: 'p-new' })
    expect(s.modelInvalidated).toBe(true)
    expect(s.thoughtLevel).toBeNull()
    expect(
      sentRequests.some(
        (r) => r.op === 'setModel' && r.modelId === 'glm' && r.providerId === 'p-new',
      ),
    ).toBe(true)
  })

  it('模型健在：thoughtLevel 不受 models 响应影响', () => {
    seed([assistantMsg('qwen', 'pq')])
    dispatch({ op: 'models', models: [{ providerId: 'pq', providerName: 'Q', modelId: 'qwen', modelName: 'Qwen' }] })
    const s = useStore.getState()
    expect(s.currentModel).toEqual({ modelId: 'qwen', providerId: 'pq' })
    expect(s.thoughtLevel?.available.length).toBe(2)
    expect(s.thoughtLevelAppliedForSession).toBe('sess_live')
  })

  it('refreshModels：置转圈标记，models 响应复位；防重复点击', () => {
    useStore.getState().refreshModels()
    useStore.getState().refreshModels()
    expect(useStore.getState().modelsRefreshing).toBe(true)
    expect(sentRequests.filter((r) => r.op === 'listModels').length).toBe(1)
    dispatch({ op: 'models', models: [GLM] })
    expect(useStore.getState().modelsRefreshing).toBe(false)
  })
})
