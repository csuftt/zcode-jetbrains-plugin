/**
 * 缺陷BO 回归测试（2026-09-14 修复）：回执已到的会话不再被 applyModelIfReady 重放
 *
 * 修复前（复现档案）：a8a4776 给 modelAppliedSessions 登记 60s TTL 用于「回执丢失防
 * 锁死」，但 TTL 过期无法区分「回执丢失（该重发）」与「回执已到（重发多余）」——
 * 会话创建分钟级后任何 models 刷新（设置页模型管理挂载 → case 'modelManage' 连带
 * loadModels、provider 启停、重连初始化）都会重放 setModel；回合中被 Java 挂起成
 * 幽灵「本轮结束后生效」横幅（目标=当前已在用的模型，idea.log 实锤：modelManageList
 * returned 后 3~6ms 跟 Model switch deferred，与刚落定的模型相同）。
 *
 * 修复后行为（本文件断言）：
 *   1. modelSet / modelSetPending 到达即登记 modelAckSessions，applyModelIfReady 见之
 *      跳过（挂起也是回执——Java 已接管回合结束补发）。
 *   2. modelSetFailed 清除回执标记（与登记解锁同语义，失败后仍可重试）。
 *   3. 用户 setModel 动作清除回执标记（新切换回执若丢失，TTL 过期后追发链路保持可用）。
 *   4. 真回执丢失场景保留：无 ack 且登记超 TTL → 下次触发仍重发（TTL 语义不回退）。
 *      「真」= 重放目标 ≠ 当前显示模型（服务端可能漂移在旧模型上）；目标 = 当前显示
 *      模型的重放属纯多余，由缺陷 CU 守卫统一跳过（见下方 CU 用例）。
 *
 * 缺陷CU（2026-09-20 修复）：BO 守卫的建立前提是「初始化时 applyModelIfReady 已成功
 * 发出 setModel 并拿到回执」。虚机实锤（09:12:51 日志指纹与 BO 同款）：webview 启动后
 * models 一直为空（多标签页各自拉清单，本 webview 视角响应丢失/未达）→ 会话订阅后的
 * 12s 兜底恢复在 models 空分支静默 return——不发、不登记、acked 建立不起来 → 此后第一
 * 次 models 就绪（用户点模型列表 → 设置页模型管理联动 loadModels）补出这笔迟到的首次
 * 下发，目标=当前在用模型，回合中被 Java 挂起成幽灵横幅。修复：applyModelIfReady 中
 * 重放目标=当前显示模型（sameModel 命中）时直接登记 acked 跳过——send 恒带模型每回合
 * 兜正服务端漂移，该重放无正向价值。
 *
 * 独立文件原因：不与 selectSession 用例混跑——selectSession 会给会话挂
 * pendingModelApplyAfterSubscribe（12s 真表计时器，条目常驻本测试进程），case 'models'
 * 的触发口被它拦住，混文件会让本文件的「应发送」用例空转失败、「应跳过」用例空转
 * 通过（均为伪验证）。
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

import { useStore } from '@/store/useStore'

const SID1 = 'sess_bo_1'
const GLM = { modelId: 'GLM-5.3', providerId: 'builtin:bigmodel-coding-plan' }
const KIMI = { modelId: 'kimi-k3', providerId: 'kimi' }

function pushResponse(msg: Record<string, unknown>): void {
  messageHandler!(msg)
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
  // 初始：会话 1 在用 GLM（会话级记忆 + 登记=很旧，模拟创建已超 60s TTL）
  storage.set('zcode.currentModel', JSON.stringify(GLM))
  storage.set('zcode.modelMemory', JSON.stringify({ [SID1]: GLM }))
  useStore.setState({
    currentSessionId: SID1,
    currentModel: { ...GLM },
    modelInvalidated: false,
    models: [
      { ...GLM, label: 'GLM-5.3' },
      { ...KIMI, label: 'Kimi K3' },
    ],
    modelAppliedSessions: new Map<string, number>(),
    modelAckSessions: new Set<string>(),
    createdSessionIds: new Set(),
    modelSettledSessions: new Set(),
    modelSwitchInFlightAt: null,
    modelPendingSwitch: null,
    modelSwitchPrevModel: null,
    lastNotice: null,
    lastError: null,
  })
})

describe('缺陷BO：回执已到的会话不再被 applyModelIfReady 重放（幽灵挂起横幅）', () => {
  /** 复现链路尾部：设置页模型管理 → case 'modelManage' 连带 loadModels → models 到达
   *  触发 applyModelIfReady */
  function pushManageAndModels(): void {
    pushResponse({ op: 'modelManage', providers: [], configPath: 'G:\\mock\\config.json' })
    pushResponse({
      op: 'models',
      models: [
        { ...GLM, label: 'GLM-5.3' },
        { ...KIMI, label: 'Kimi K3' },
      ],
    })
  }

  /** 登记做旧越过 60s TTL（TTL 守卫放行场景）*/
  function expireRegistration(sid: string): void {
    useStore.setState({ modelAppliedSessions: new Map([[sid, Date.now() - 120_000]]) })
  }

  it('主场景：modelSet 落定后 TTL 过期，设置页链路不再重发 setModel、无幽灵横幅', () => {
    pushResponse({ op: 'modelSet', sessionId: SID1, ...GLM }) // 切换落定（回执）
    expireRegistration(SID1)
    sentRequests.length = 0
    pushManageAndModels()
    expect(setModelReqs()).toEqual([]) // 修复前：TTL 过期放行重发，回合中被挂起成幽灵横幅
    expect(useStore.getState().lastNotice).toBeNull()
  })

  it('modelSetPending（挂起）也是回执：Java 已接管补发，models 刷新不重放', () => {
    pushResponse({ op: 'modelSetPending', sessionId: SID1, ...KIMI })
    expireRegistration(SID1)
    sentRequests.length = 0
    pushManageAndModels()
    expect(setModelReqs()).toEqual([])
  })

  it('modelSetFailed 清回执：目标=显示模型的失败不重放（CU）；目标≠显示模型按记忆重试（BO 语义保留）', () => {
    pushResponse({ op: 'modelSet', sessionId: SID1, ...GLM }) // 先落定
    // prev=切换前生效模型（GLM）：failed 的记忆修复分支据此把会话记忆回滚留存（prev 空 → 删记忆）
    useStore.setState({ modelSwitchPrevModel: { ...GLM } })
    pushResponse({ op: 'modelSetFailed', sessionId: SID1, ...GLM, message: 'Model switch failed: [-32603] Unsupported model' })
    useStore.setState({ modelAppliedSessions: new Map() }) // 失败解锁已清登记
    sentRequests.length = 0
    pushManageAndModels()
    // 失败目标=当前显示模型（GLM）：服务端本就在用，重放纯多余（缺陷CU 守卫跳过并登记 acked）
    expect(setModelReqs(SID1)).toEqual([])
    expect(useStore.getState().modelAckSessions.has(SID1)).toBe(true)

    // 真可重试场景：用户失败后改选 KIMI（记忆留存新目标），显示仍在 GLM——目标≠显示
    storage.set('zcode.modelMemory', JSON.stringify({ [SID1]: KIMI }))
    useStore.setState({ modelAckSessions: new Set() })
    pushManageAndModels()
    expect(lastSetModelReq()).toMatchObject({ sessionId: SID1, ...KIMI })
  })

  it('用户 setModel 清回执：目标=显示模型的在途切换不因回执丢失而追发（CU，漂移由 send 恒带模型兜正）', () => {
    pushResponse({ op: 'modelSet', sessionId: SID1, ...GLM }) // 旧切换的回执
    useStore.getState().setModel(KIMI.modelId, KIMI.providerId) // 新切换在途（清 ack、显示翻转 KIMI、写记忆 kimi）
    // 回执丢失：不推 modelSet/Pending/Failed —— 登记做旧越过 TTL
    expireRegistration(SID1)
    sentRequests.length = 0
    pushManageAndModels()
    // 重放目标 KIMI = 当前显示模型：纯多余，跳过（修复前按记忆目标追发——回合中即幽灵横幅）
    expect(setModelReqs(SID1)).toEqual([])
    expect(useStore.getState().modelAckSessions.has(SID1)).toBe(true)
  })

  it('真回执丢失场景保留（TTL 语义不回退）：无 ack 且登记超 TTL、目标≠显示模型 → models 刷新重发', () => {
    // 服务端漂移场景：显示停在 KIMI（上次切换失败回滚不彻底/别端切走），会话记忆指向 GLM
    useStore.setState({ currentModel: { ...KIMI } })
    expireRegistration(SID1)
    sentRequests.length = 0
    pushManageAndModels()
    expect(setModelReqs(SID1).length).toBe(1)
    expect(lastSetModelReq()).toMatchObject({ sessionId: SID1, ...GLM })
  })
})

describe('缺陷CU：models 迟到就绪前静默跳过的会话，models 就绪后不再补发同值重放（幽灵横幅根因）', () => {
  /** 复现链路尾部：设置页模型管理 → case 'modelManage' 连带 loadModels → models 到达
   *  触发 applyModelIfReady */
  function pushManageAndModels(): void {
    pushResponse({ op: 'modelManage', providers: [], configPath: 'G:\\mock\\config.json' })
    pushResponse({
      op: 'models',
      models: [
        { ...GLM, label: 'GLM-5.3' },
        { ...KIMI, label: 'Kimi K3' },
      ],
    })
  }

  it('主场景：models 空期间静默跳过（acked 建立不起来），models 就绪后同值重放被挡', () => {
    // 虚机时序：本 webview 的 models 一直为空（清单响应丢失/未达），会话记忆已恢复、
    // 显示=记忆（selectSession/待命水合同值）
    useStore.setState({ models: [] })
    useStore.getState().applyModelIfReady(SID1) // 订阅回执/12s 兜底触发：models 空分支静默 return
    expect(setModelReqs()).toEqual([]) // 不发（models 未就绪）
    expect(useStore.getState().modelAckSessions.has(SID1)).toBe(false) // 回执守卫建立不起来（盲区本源）
    // 用户点模型列表 → 联动 loadModels → models 首次就绪
    pushManageAndModels()
    // 修复前：补发 setModel（目标=当前在用模型 GLM）→ 回合中被挂起 → 幽灵「本轮结束后生效」横幅
    // 修复后：重放目标=当前显示模型 → 登记 acked 跳过
    expect(setModelReqs()).toEqual([])
    expect(useStore.getState().modelAckSessions.has(SID1)).toBe(true)
    expect(useStore.getState().lastNotice).toBeNull()
  })

  it('models 就绪后目标≠显示模型仍正常下发（新守卫不挡真切换）', () => {
    useStore.setState({ models: [], currentModel: { ...KIMI } }) // 显示与记忆漂移（GLM≠KIMI）
    useStore.getState().applyModelIfReady(SID1)
    expect(setModelReqs()).toEqual([]) // models 空：仍静默
    pushManageAndModels()
    expect(setModelReqs(SID1).length).toBe(1)
    expect(useStore.getState().modelAckSessions.has(SID1)).toBe(false) // 下发在途，等回执登记
  })
})

describe('缺陷EF：新建豁免随首条 send 关闭（createdSessionIds 终身豁免的幽灵横幅余缝）', () => {
  /** 复现链路尾部：设置页模型管理 → case 'modelManage' 连带 loadModels → models 到达
   *  触发 applyModelIfReady（2026-09-30 实锤：创建 3 分钟后的清单刷新补出同值
   *  setModel，回合中被 Java 挂起成幽灵横幅——CU 守卫对 createdSessionIds 有意豁免，
   *  豁免却随实例存活终身有效）*/
  function pushManageAndModels(): void {
    pushResponse({ op: 'modelManage', providers: [], configPath: 'G:\\mock\\config.json' })
    pushResponse({
      op: 'models',
      models: [
        { ...GLM, label: 'GLM-5.3' },
        { ...KIMI, label: 'Kimi K3' },
      ],
    })
  }

  it('created 会话已发过消息：同值重放记 ack 不发（CU 守卫对它生效）', () => {
    useStore.setState({
      createdSessionIds: new Set([SID1]), // 本实例新建（豁免条件之一）
      modelSettledSessions: new Set([SID1]), // 但首条 send 已落地（豁免关闭）
    })
    pushManageAndModels()
    expect(setModelReqs(SID1)).toEqual([]) // 修复前：豁免放行 → 同值 setModel → 撞回合挂起
    expect(useStore.getState().modelAckSessions.has(SID1)).toBe(true)
    expect(useStore.getState().lastNotice).toBeNull()
  })

  it('created 会话已发过消息且无会话级记忆：按存量口径不重放（服务端本就持有其模型）', () => {
    storage.set('zcode.modelMemory', JSON.stringify({})) // own 缺失
    useStore.setState({
      createdSessionIds: new Set([SID1]),
      modelSettledSessions: new Set([SID1]),
    })
    pushManageAndModels()
    expect(setModelReqs(SID1)).toEqual([])
  })

  it('created 会话尚未发过消息：豁免仍在——同值也真切上去（首应用语义不回退）', () => {
    useStore.setState({ createdSessionIds: new Set([SID1]) }) // 无 settled 记录
    pushManageAndModels()
    expect(setModelReqs(SID1).length).toBe(1)
    expect(lastSetModelReq()).toMatchObject({ sessionId: SID1, ...GLM })
    expect(useStore.getState().modelAckSessions.has(SID1)).toBe(false)
  })
})
