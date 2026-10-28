/**
 * 缺陷BI 回归测试（issue #9，2026-09-11 修复）：模型记忆按会话存 + 推送补会话守卫
 *
 * 修复前（复现档案）：模型记忆是全局单值 zcode.currentModel（跨会话/跨标签共享），
 * applyModelIfReady 单槽守卫切走再切回即失效 → 切回会话 1 时把别的会话选过的模型
 * 重放 setModel 到会话 1（回合中则转延迟切换真切，即 issue 现象）；modelSetPending/
 * modelSetFailed 无会话守卫，他人会话的挂起提示与报错落到当前会话。
 *
 * 修复后行为（本文件断言）：
 *   1. 会话级记忆 zcode.modelMemory：切回已有会话只重放它自己的选择（无记忆则不
 *      重放，显示由消息快照推断）；绝不带入别的会话选过的模型。
 *   2. 全局 zcode.currentModel 仅作为新建会话的默认（新会话跟随上次选择的既有体验）。
 *   3. 已应用守卫改为 Set：切走再切回不重发 setModel。
 *   4. modelSetPending / modelSetFailed 带 sessionId 守卫，他人会话的不落当前会话；
 *      切换失败回滚会话级记忆（防重启重放已知失败目标）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- mock localStorage（node 环境无实现）----
const storage = new Map<string, string>()
const lsMock = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => { storage.set(k, v) },
  removeItem: (k: string) => { storage.delete(k) },
  key: (i: number) => Array.from(storage.keys())[i] ?? null,
  get length() { return storage.size },
  clear: () => { storage.clear() },
}
vi.stubGlobal('localStorage', lsMock)
vi.stubGlobal('window', { localStorage: lsMock, dispatchEvent: () => {}, __ZCODE_KVSTORE__: null })

// ---- mock 桥接层：捕获 sendToJava，手动注入事件/响应 ----
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

import { useStore, scheduleModelApplyAfterSubscribe } from '@/store/useStore'

const SID1 = 'sess_issue9_1'
const SID2 = 'sess_issue9_2'
const SID_NEW = 'sess_issue9_new'
const GLM = { modelId: 'GLM-5.3', providerId: 'builtin:bigmodel-coding-plan' }
const KIMI = { modelId: 'kimi-k3', providerId: 'kimi' }

function pushResponse(msg: Record<string, unknown>): void {
  messageHandler!(msg)
}

function setModelMemory(map: Record<string, { modelId: string; providerId: string }>): void {
  storage.set('zcode.modelMemory', JSON.stringify(map))
}

function readMemoryEntry(sid: string): { modelId: string; providerId: string } | null {
  const raw = storage.get('zcode.modelMemory')
  if (!raw) return null
  const e = (JSON.parse(raw) as Record<string, { modelId: string; providerId: string; t?: number }>)[sid]
  if (!e) return null
  return { modelId: e.modelId, providerId: e.providerId } // 不比 t（LRU 时间戳）
}

function setModelReqs(sid?: string): Array<Record<string, unknown>> {
  return sentRequests.filter((r) => r.op === 'setModel' && (!sid || r.sessionId === sid))
}

function lastSetModelReq(): Record<string, unknown> | undefined {
  return [...sentRequests].reverse().find((r) => r.op === 'setModel')
}

beforeEach(() => {
  storage.clear()
  sentRequests.length = 0
  useStore.getState().init()
  // 初始：会话 1 在用 GLM-5.3（已应用 + 会话级记忆），全局默认也是 GLM；
  // 模型列表含两个 provider 的模型
  storage.set('zcode.currentModel', JSON.stringify(GLM))
  setModelMemory({ [SID1]: GLM })
  useStore.setState({
    currentSessionId: SID1,
    currentModel: { ...GLM },
    modelInvalidated: false,
    models: [
      { ...GLM, label: 'GLM-5.3' },
      { ...KIMI, label: 'Kimi K3' },
    ],
    modelAppliedSessions: new Map<string, number>([[SID1, Date.now()]]),
    modelAckSessions: new Set<string>(),
    createdSessionIds: new Set(),
    modelSwitchInFlightAt: null,
    modelPendingSwitch: null,
    modelSwitchPrevModel: null,
    lastNotice: null,
    lastError: null,
  })
})

describe('缺陷BI：会话级模型记忆（issue #9 修复）', () => {
  it('会话 2 选 kimi 后切回会话 1：不再重放，显示回到会话 1 自己的模型', () => {
    useStore.getState().selectSession({ sessionId: SID2, workspacePath: 'G:\\mock' })
    // 存量会话无会话级记忆：切入不下发任何 setModel（服务端本就持有其模型）
    expect(setModelReqs(SID2)).toEqual([])

    useStore.getState().setModel(KIMI.modelId, KIMI.providerId)
    pushResponse({ op: 'modelSet', sessionId: SID2, ...KIMI })
    expect(useStore.getState().currentModel).toEqual(KIMI)

    // 切回会话 1：无污染重放（修复点），显示取会话 1 自己的记忆
    useStore.getState().selectSession({ sessionId: SID1, workspacePath: 'G:\\mock' })
    expect(setModelReqs(SID1)).toEqual([]) // 修复前这里会发出 setModel(会话1, kimi)
    expect(useStore.getState().currentModel).toEqual(GLM)
  })

  it('选择写入两级记忆：全局默认 + 会话自己的', () => {
    useStore.getState().selectSession({ sessionId: SID2, workspacePath: 'G:\\mock' })
    useStore.getState().setModel(KIMI.modelId, KIMI.providerId)
    expect(JSON.parse(storage.get('zcode.currentModel')!)).toEqual(KIMI)
    expect(readMemoryEntry(SID2)).toEqual(KIMI)
    // 会话 1 的记忆不受影响
    expect(readMemoryEntry(SID1)).toEqual(GLM)
  })

  it('首见会话重放它自己的记忆（重启恢复场景）：各会话互不串', () => {
    // 模拟新 webview（重启/新标签）：已应用集合与回执集合都为空
    useStore.setState({ modelAppliedSessions: new Map(), modelAckSessions: new Set() })
    setModelMemory({ [SID1]: GLM, [SID2]: KIMI })
    // 切到会话 2：显示取会话 2 自己的 kimi——记忆=显示的同值重放被缺陷CU 守卫跳过
    //（send 恒带模型兜正服务端漂移），不再是 subscribed 后重放 kimi
    useStore.getState().selectSession({ sessionId: SID2, workspacePath: 'G:\\mock' })
    expect(setModelReqs(SID2)).toEqual([])
    pushResponse({ op: 'subscribed', sessionId: SID2 })
    expect(setModelReqs(SID2)).toEqual([])
    expect(useStore.getState().modelAckSessions.has(SID2)).toBe(true)
    expect(useStore.getState().currentModel).toEqual(KIMI)
    // 切回会话 1：显示取会话 1 自己的 GLM（修复前（全局记忆）这里会把 kimi 切给会话 1）
    useStore.getState().selectSession({ sessionId: SID1, workspacePath: 'G:\\mock' })
    pushResponse({ op: 'subscribed', sessionId: SID1 })
    expect(setModelReqs()).toEqual([])
    expect(useStore.getState().currentModel).toEqual(GLM)
    // Set 守卫：再切回会话 2 不重发（首见才下发）
    sentRequests.length = 0
    useStore.getState().selectSession({ sessionId: SID2, workspacePath: 'G:\\mock' })
    pushResponse({ op: 'subscribed', sessionId: SID2 })
    expect(setModelReqs()).toEqual([])
  })

  it('新建会话仍回退全局默认（新会话跟随上次选择的既有体验）', () => {
    // 标签 2 选过 kimi → 全局默认 = kimi；标签 1 新建会话（懒创建落定）
    storage.set('zcode.currentModel', JSON.stringify(KIMI))
    useStore.setState({
      currentSessionId: SID_NEW,
      currentModel: null,
      modelAppliedSessions: new Map(),
      modelAckSessions: new Set(),
      createdSessionIds: new Set([SID_NEW]),
    })
    // 懒创建落定后 createSession 路径挂 subscribed 错峰；本用例 setState 短路了
    // createSession，手动补挂起保持与真实链路一致（导出函数=测试同款入口）
    scheduleModelApplyAfterSubscribe(SID_NEW, true)
    pushResponse({
      op: 'models',
      models: [
        { ...GLM, label: 'GLM-5.3' },
        { ...KIMI, label: 'Kimi K3' },
      ],
    })
    // 新会话同样挂 subscribed 回执错峰（十五轮）；回执未到前不下发
    expect(setModelReqs(SID_NEW)).toEqual([])
    pushResponse({ op: 'subscribed', sessionId: SID_NEW })
    expect(lastSetModelReq()).toMatchObject({ sessionId: SID_NEW, ...KIMI })
    expect(useStore.getState().currentModel).toEqual(KIMI)
  })

  it('重启恢复：全局默认是别的会话选的 kimi 时，存量会话 1 不中招（切自己的记忆）', () => {
    // 双标签变体：标签 2（独立 webview）选过 kimi 写进共享全局记忆；本标签重启恢复会话 1
    storage.set('zcode.currentModel', JSON.stringify(KIMI))
    useStore.setState({
      currentSessionId: SID1,
      currentModel: null,
      modelAppliedSessions: new Map(), // 新 webview：恢复时首见
      modelAckSessions: new Set(),
      createdSessionIds: new Set(),
    })
    pushResponse({
      op: 'models',
      models: [
        { ...GLM, label: 'GLM-5.3' },
        { ...KIMI, label: 'Kimi K3' },
      ],
    })
    // 修复前：setModel(会话1, kimi)（11:25:59 真机日志现场）；修复后：重放会话 1 自己的 GLM
    pushResponse({ op: 'subscribed', sessionId: SID1 })
    expect(lastSetModelReq()).toMatchObject({ sessionId: SID1, ...GLM })
    expect(useStore.getState().currentModel).toEqual(GLM)
  })

  it('待命态兜底：全局默认被禁用时新建标签不空占位，兜底生效套餐首选并回写', () => {
    // 用户最后选的模型（全局默认）的 provider 被禁用 → 新建标签（待命态）models 到达：
    // 选择器直接显示兜底模型（用户反馈"新建标签会话的模型是空的，需要手动选"）
    storage.set('zcode.currentModel', JSON.stringify(KIMI)) // kimi 已不在清单
    useStore.setState({ currentSessionId: null, currentModel: null })
    pushResponse({
      op: 'models',
      models: [
        { ...GLM, label: 'GLM-5.3', plan: 'personal' },
        { modelId: 'qwen3.8-max', providerId: 'aliyun', label: 'qwen3.8-max' },
      ],
    })
    const s = useStore.getState()
    expect(s.currentModel).toEqual(GLM) // plan='personal' 优先
    expect(JSON.parse(storage.get('zcode.currentModel')!)).toEqual(GLM) // 回写全局默认（新会话一致跟随）
    // 无全局记忆（失效清除/全新安装）：同样兜底预选并回写——不空占位（真机二轮反馈定案）
    storage.delete('zcode.currentModel')
    useStore.setState({ currentModel: null })
    pushResponse({
      op: 'models',
      models: [
        { ...GLM, label: 'GLM-5.3', plan: 'personal' },
        { modelId: 'qwen3.8-max', providerId: 'aliyun', label: 'qwen3.8-max' },
      ],
    })
    expect(useStore.getState().currentModel).toEqual(GLM)
    expect(JSON.parse(storage.get('zcode.currentModel')!)).toEqual(GLM)
  })

  it('待命态正显示的模型被禁用：显示兜底到生效套餐首选而非清空（真机实测场景）', () => {
    // 新建标签待命态显示着 kimi → 设置页禁用 kimi provider → models 广播到达：
    // 失效清除会把显示清成 null（待命态无消息可推断），恢复块须用回写的全局填回
    storage.set('zcode.currentModel', JSON.stringify(KIMI))
    useStore.setState({ currentSessionId: null, currentModel: { ...KIMI } })
    pushResponse({
      op: 'models',
      models: [
        { ...GLM, label: 'GLM-5.3', plan: 'personal' },
        { modelId: 'qwen3.8-max', providerId: 'aliyun', label: 'qwen3.8-max' },
      ],
    })
    const s = useStore.getState()
    // 修复前：currentModel 被失效清除置 null，恢复块因全局被删而跳过 → 空占位
    expect(s.currentModel).toEqual(GLM)
    expect(JSON.parse(storage.get('zcode.currentModel')!)).toEqual(GLM)
  })
})

describe('缺陷BI：推送会话守卫（modelSetPending / modelSetFailed）', () => {
  it('别的会话的 modelSetPending 不落当前会话：无提示、无挂起、显示不动', () => {
    useStore.getState().selectSession({ sessionId: SID2, workspacePath: 'G:\\mock' })
    useStore.getState().setModel(KIMI.modelId, KIMI.providerId)
    // 用户切回会话 1 后，会话 2 的切换才被 Java 挂起（迟到回执）
    useStore.getState().selectSession({ sessionId: SID1, workspacePath: 'G:\\mock' })
    pushResponse({ op: 'modelSetPending', sessionId: SID2, ...KIMI })
    const s = useStore.getState()
    expect(s.modelPendingSwitch).toBeNull() // 修复前被写成会话 2 的挂起
    expect(s.lastNotice).toBeNull()
    expect(s.currentModel).toEqual(GLM)
  })

  it('别的会话的 modelSetFailed 不落当前会话：无报错', () => {
    pushResponse({
      op: 'modelSetFailed', sessionId: SID2, ...KIMI,
      message: 'Model switch failed: [-32603] Unsupported model',
    })
    expect(useStore.getState().lastError).toBeNull() // 修复前写入他人会话的报错
  })

  it('本会话切换失败：报错展示 + 会话级记忆回滚到切换前模型', () => {
    useStore.getState().setModel(KIMI.modelId, KIMI.providerId)
    pushResponse({ op: 'modelSetPending', sessionId: SID1, ...KIMI })
    expect(readMemoryEntry(SID1)).toEqual(KIMI) // 选择时已写目标
    pushResponse({
      op: 'modelSetFailed', sessionId: SID1, ...KIMI,
      message: 'Model switch failed: [-32603] Unsupported model',
    })
    const s = useStore.getState()
    expect(s.lastError).toContain('Unsupported model')
    expect(s.currentModel).toEqual(GLM)
    // 记忆回滚：重启恢复不再重放已知失败的目标
    expect(readMemoryEntry(SID1)).toEqual(GLM)
  })

  it('迟到失败（用户已切走）：毒目标记忆被删除，显示不受污染（code-review Spec#1）', () => {
    // 会话 2 挂起 kimi 切换（记忆已写 kimi）→ 用户切走 → 回合结束补发失败迟到数分钟。
    // 修复前：显示守卫 break 连记忆修复一起跳过 → kimi 留存记忆，重启重放毒目标
    setModelMemory({ [SID2]: KIMI })
    useStore.setState({ modelPendingSwitch: null, modelSwitchPrevModel: null }) // 挂起信息已随切会话清除
    pushResponse({
      op: 'modelSetFailed', sessionId: SID2, ...KIMI,
      message: 'Model switch failed: [-32603] Unsupported model',
    })
    expect(readMemoryEntry(SID2)).toBeNull() // 记忆修复不守卫：删除毒目标（无记忆=重启不重放）
    expect(useStore.getState().lastError).toBeNull() // 显示守卫保留：不落当前会话
  })

  it('迟到失败但期间已改选别的模型：不误删新记忆', () => {
    // 失败目标 kimi 的迟到报错到达时，会话 2 的记忆已是后来改选的 GLM → 不动
    setModelMemory({ [SID2]: GLM })
    useStore.setState({ modelPendingSwitch: null, modelSwitchPrevModel: null })
    pushResponse({
      op: 'modelSetFailed', sessionId: SID2, ...KIMI,
      message: 'Model switch failed: [-32603] Unsupported model',
    })
    expect(readMemoryEntry(SID2)).toEqual(GLM)
    expect(useStore.getState().lastError).toBeNull()
  })
})
