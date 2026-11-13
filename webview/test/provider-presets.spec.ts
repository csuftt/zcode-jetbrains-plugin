/**
 * 预设供应商表测试（纯数据 + 纯函数，node 环境零依赖）
 *
 * 覆盖：每条预设的结构合法性（kind 枚举/https baseURL/模型行必填位/无重复 modelId/
 *       context-output 正数）——预设预填值直接进 config.json（喂 autocompact 阈值），
 *       脏数据会静默写坏渠道；baseURL 与 id 全局唯一（判重按 baseURL，重复预设会互相置灰）；
 *       normalizeBaseURL/isPresetAdded 尾斜杠归一口径；客户端 rev-44 新增渠道的端点与协议口径。
 */

import { describe, it, expect } from 'vitest'
import { PROVIDER_PRESETS, normalizeBaseURL, isPresetAdded, type ProviderPreset } from '../src/utils/providerPresets'

const KINDS = new Set(['anthropic', 'openai-compatible'])
const GROUPS = new Set(['zhipu', 'other'])

function assertPresetShape(p: ProviderPreset) {
  expect(p.id, p.id).toBeTruthy()
  expect(p.name.zh.trim(), p.id).toBeTruthy()
  expect(p.name.en.trim(), p.id).toBeTruthy()
  expect(KINDS.has(p.kind), `${p.id} kind=${p.kind}`).toBe(true)
  expect(GROUPS.has(p.group), `${p.id} group=${p.group}`).toBe(true)
  expect(p.baseURL, p.id).toMatch(/^https:\/\//)
  if (p.keyUrl) expect(p.keyUrl, p.id).toMatch(/^https:\/\//)
  expect(p.accent, p.id).toMatch(/^#[0-9a-fA-F]{3,8}$/)
  expect(p.badge.trim(), p.id).toBeTruthy()
  expect(p.models.length, p.id).toBeGreaterThan(0)
}

describe('providerPresets 数据完整性', () => {
  it('预设表非空且结构合法', () => {
    expect(PROVIDER_PRESETS.length).toBeGreaterThanOrEqual(31)
    for (const p of PROVIDER_PRESETS) assertPresetShape(p)
  })

  it('预设 id 唯一（对表客户端 templateId，协议折叠/插件增补不得撞名）', () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('分组口径：智谱组恰为 4 条（Coding Plan/API × BigModel/Z.ai）且排在最前', () => {
    const zhipu = PROVIDER_PRESETS.filter((p) => p.group === 'zhipu')
    expect(zhipu.map((p) => p.id)).toEqual(['bigmodel-api', 'zai-api', 'bigmodel-standard-api', 'zai-standard-api'])
  })

  it('每条预设模型行无重复 modelId，context/output 为正数', () => {
    for (const p of PROVIDER_PRESETS) {
      const ids = p.models.map((m) => m.modelId)
      expect(new Set(ids).size, p.id).toBe(ids.length)
      for (const m of p.models) {
        expect(m.modelId.trim(), p.id).toBeTruthy()
        expect(Number.isInteger(m.context) && m.context > 0, `${p.id}/${m.modelId} context`).toBe(true)
        if (m.output != null) {
          expect(Number.isInteger(m.output) && m.output > 0, `${p.id}/${m.modelId} output`).toBe(true)
        }
      }
    }
  })

  it('baseURL 全局唯一（判重按 baseURL，重复预设会互相置灰）', () => {
    const urls = PROVIDER_PRESETS.map((p) => normalizeBaseURL(p.baseURL))
    expect(new Set(urls).size).toBe(urls.length)
  })

  it('关键预设口径抽查（官方 templateRules 对齐：Kimi/DeepSeek/百炼中国/智谱族）', () => {
    const kimi = PROVIDER_PRESETS.find((p) => p.id === 'moonshot-kimi')
    expect(kimi?.baseURL).toBe('https://api.moonshot.cn/anthropic')
    expect(kimi?.kind).toBe('anthropic')
    const deepseek = PROVIDER_PRESETS.find((p) => p.id === 'deepseek')
    // 客户端实拍：第三方默认 anthropic 协议 + /anthropic 兼容端点
    expect(deepseek?.baseURL).toBe('https://api.deepseek.com/anthropic')
    const qwenCn = PROVIDER_PRESETS.find((p) => p.id === 'qwen-alibaba-model-studio-cn')
    expect(qwenCn?.kind).toBe('anthropic')
    expect(qwenCn?.baseURL).toBe('https://dashscope.aliyuncs.com/apps/anthropic')
    // 国际站官方走 openai-chat-completions（无 anthropic 兼容端点）
    const qwenIntl = PROVIDER_PRESETS.find((p) => p.id === 'qwen-alibaba-model-studio-intl')
    expect(qwenIntl?.kind).toBe('openai-compatible')
    // 千问 Token Plan 个人版（插件侧增补条）：千问 AI 平台域名 + anthropic 兼容端点
    const qwenTokenPlan = PROVIDER_PRESETS.find((p) => p.id === 'qwen-token-plan-personal-cn')
    expect(qwenTokenPlan?.kind).toBe('anthropic')
    expect(qwenTokenPlan?.baseURL).toBe('https://token-plan.maas.qianwenaiapi.com/apps/anthropic')
    expect(qwenTokenPlan?.keyUrl).toBe('https://platform.qianwenaiapi.com/home/api-keys?target=individual')
    // 智谱族：Coding Plan = anthropic-messages 端点；标准 API = openai-chat-completions 端点
    const bigmodelPlan = PROVIDER_PRESETS.find((p) => p.id === 'bigmodel-api')
    expect(bigmodelPlan?.kind).toBe('anthropic')
    expect(bigmodelPlan?.baseURL).toBe('https://open.bigmodel.cn/api/anthropic')
    const zaiStd = PROVIDER_PRESETS.find((p) => p.id === 'zai-standard-api')
    expect(zaiStd?.kind).toBe('openai-compatible')
    expect(zaiStd?.baseURL).toBe('https://api.z.ai/api/paas/v4')
  })
})

describe('rev-44 对齐：新增渠道与协议折叠', () => {
  const byId = (id: string) => PROVIDER_PRESETS.find((p) => p.id === id)

  it('订阅类各走自家订阅端点（Coding Plan / Token Plan / Step Plan 不复用标准 API 域名）', () => {
    expect(byId('kimi-code-cn')?.baseURL).toBe('https://api.kimi.com/coding/v1')
    expect(byId('kimi-code-cn')?.kind).toBe('openai-compatible')
    expect(byId('kimi-code-intl')?.baseURL).toBe('https://api.kimi.ai/coding/v1')
    expect(byId('minimax-m-plan-cn')?.baseURL).toBe('https://api.minimax.cn/anthropic')
    expect(byId('xiaomi-mimo-token-plan')?.baseURL).toBe('https://token-plan-cn.xiaomimimo.com/anthropic')
    expect(byId('volcengine-coding-plan')?.baseURL).toBe('https://ark.cn-beijing.volces.com/api/coding')
    expect(byId('volcengine-agent-plan')?.baseURL).toBe('https://ark.cn-beijing.volces.com/api/plan')
    expect(byId('stepfun-step-plan')?.baseURL).toBe('https://api.stepfun.com/step_plan')
    expect(byId('qwen-coding-plan-cn')?.baseURL).toBe('https://coding.dashscope.aliyuncs.com/v1')
    expect(byId('qwen-token-plan-team-cn')?.baseURL).toBe(
      'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    )
  })

  it('OpenCode Go/Zen：同端点三协议变体折叠为一张卡（判重按 baseURL），取 chat 目录', () => {
    const oc = PROVIDER_PRESETS.filter((p) => p.id.startsWith('opencode'))
    expect(oc.map((p) => p.id)).toEqual(['opencode-go', 'opencode-zen'])
    for (const p of oc) expect(p.kind).toBe('openai-compatible')
  })

  it('协议口径：混合路由网关走 openai-compatible，自家 Anthropic 端点走 anthropic', () => {
    expect(byId('tencent-tokenhub-cn')?.kind).toBe('openai-compatible')
    expect(byId('siliconflow-cn')?.kind).toBe('openai-compatible')
    expect(byId('volcengine-ark')?.kind).toBe('anthropic')
    expect(byId('stepfun')?.kind).toBe('anthropic')
  })

  it('千问 Token Plan 个人版目录含跨家模型（不止 Qwen 自家）', () => {
    const ids = byId('qwen-token-plan-personal-cn')?.models.map((m) => m.modelId) || []
    expect(ids).toEqual(expect.arrayContaining(['qwen3.8-max', 'glm-5.3', 'deepseek-v4-pro']))
  })
})

describe('normalizeBaseURL / isPresetAdded', () => {
  it('尾斜杠归一', () => {
    expect(normalizeBaseURL('https://api.example.com/')).toBe('https://api.example.com')
    expect(normalizeBaseURL(' https://api.example.com/// ')).toBe('https://api.example.com')
    expect(normalizeBaseURL('https://api.example.com')).toBe('https://api.example.com')
  })

  it('isPresetAdded 按归一后的 baseURL 精确匹配', () => {
    const preset = PROVIDER_PRESETS[0]
    expect(isPresetAdded(preset, [preset.baseURL + '/'])).toBe(true)
    expect(isPresetAdded(preset, ['https://other.example.com'])).toBe(false)
    expect(isPresetAdded(preset, [])).toBe(false)
  })
})
