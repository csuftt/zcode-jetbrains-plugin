/**
 * 体验套餐(zcode-plan 网关) captcha 门控测试（store 级，2026-08-28）
 *
 * 背景：体验套餐渠道（builtin:bigmodel-start-plan 等 baseURL 含 zcode-plan）的模型
 * 请求强制阿里云滑块人机验证，插件宿主无法提供 verify param，回合必失败。定案方案：
 * Java 侧过滤该渠道（listModels）+ setModel 入口拦截（modelSetFailed reason=captchaGated）；
 * 前端负责本地化文案、选中态回滚、持久化记忆的兜底迁移。
 *
 * 锁定：
 * 1. modelSetFailed reason=captchaGated → lastError 走本地化文案（不透传英文原文）
 * 2. 即时切换失败回滚选中态到切换前模型（勾选与实际一致）
 * 3. applyModelIfReady：持久化记忆的模型不在列表（被过滤/已删）→ 兜底个人套餐首选
 *    并回写记忆 + 下发 setModel（不再静默跑服务端默认模型）
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

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
import i18n from '@/i18n/config'

function dispatch(msg: Record<string, unknown>) {
  messageHandler?.(msg)
}

const SID = 'sess_test'
const GLM = { modelId: 'GLM-5.3', providerId: 'builtin:bigmodel-coding-plan' }
const FLASH_GATED = { modelId: 'GLM-5.3-Flash', providerId: 'builtin:bigmodel-start-plan' }

beforeEach(() => {
  storage.clear()
  sentRequests.length = 0
  useStore.getState().init()
  useStore.setState({
    currentSessionId: SID,
    currentModel: { ...GLM },
    modelInvalidated: false,
    modelSwitchInFlightAt: null,
    modelPendingSwitch: null,
    modelSwitchPrevModel: null,
    lastNotice: null,
    lastError: null,
    modelAppliedForSession: null,
    models: [
      { providerId: 'builtin:bigmodel-coding-plan', providerName: 'BigModel - Coding Plan', plan: 'personal', modelId: 'GLM-5.3', modelName: 'GLM-5.3' },
      { providerId: 'p-other', providerName: 'Other', modelId: 'qwen3.7-plus', modelName: 'qwen3.7-plus' },
    ],
  })
})

describe('体验套餐 captcha 门控', () => {
  it('modelSetFailed reason=captchaGated → 本地化文案而非英文原文', () => {
    dispatch({
      op: 'modelSetFailed', sessionId: SID, ...FLASH_GATED,
      message: 'captcha-gated provider: builtin:bigmodel-start-plan (zcode-plan gateway requires human verification)',
      reason: 'captchaGated',
    })
    const s = useStore.getState()
    expect(s.lastError).toBe(i18n.t('app.modelCaptchaGated'))
    expect(s.lastError).not.toContain('captcha-gated provider')
  })

  it('reason 缺省仍走原始 message（其他切换失败不受影响）', () => {
    dispatch({
      op: 'modelSetFailed', sessionId: SID, ...FLASH_GATED,
      message: 'Model switch failed: [-32603] Unsupported model',
    })
    expect(useStore.getState().lastError).toContain('Unsupported model')
  })

  it('即时切换失败回滚选中态到切换前模型并清在途标记', () => {
    useStore.getState().setModel(FLASH_GATED.modelId, FLASH_GATED.providerId)
    expect(useStore.getState().currentModel).toEqual(FLASH_GATED) // 乐观选中
    dispatch({
      op: 'modelSetFailed', sessionId: SID, ...FLASH_GATED,
      message: 'captcha-gated provider', reason: 'captchaGated',
    })
    const s = useStore.getState()
    expect(s.currentModel).toEqual(GLM) // 回滚
    expect(s.modelSwitchInFlightAt).toBeNull()
    expect(s.modelSwitchPrevModel).toBeNull()
  })

  it('applyModelIfReady：记忆的模型被过滤 → 兜底个人套餐首选 + 回写记忆 + 下发 setModel', () => {
    storage.set('zcode.currentModel', JSON.stringify(FLASH_GATED))
    useStore.setState({ currentModel: null })
    useStore.getState().applyModelIfReady(SID)
    const s = useStore.getState()
    expect(s.currentModel).toEqual(GLM) // plan='personal' 优先
    expect(s.modelAppliedForSession).toBe(SID)
    expect(JSON.parse(storage.get('zcode.currentModel')!)).toEqual(GLM)
    const setModelReq = sentRequests.find((r) => r.op === 'setModel')
    expect(setModelReq).toMatchObject({ op: 'setModel', sessionId: SID, ...GLM })
  })

  it('applyModelIfReady：无个人套餐时兜底列表首个', () => {
    storage.set('zcode.currentModel', JSON.stringify(FLASH_GATED))
    useStore.setState({
      currentModel: null,
      models: [{ providerId: 'p-other', providerName: 'Other', modelId: 'qwen3.7-plus', modelName: 'qwen3.7-plus' }],
    })
    useStore.getState().applyModelIfReady(SID)
    expect(useStore.getState().currentModel).toEqual({ modelId: 'qwen3.7-plus', providerId: 'p-other' })
  })
})
