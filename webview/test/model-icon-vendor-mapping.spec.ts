/**
 * 厂商图标映射回归（新增渠道进来的模型短名/新域名必须落到正确品牌）
 *
 * 两类信号各自的判定口径：
 * - modelId 正则：短名系列（混元 hy3/hy4、Kimi Code 的 k3 系）不带厂商全名，靠专用规则兜住；
 * - baseUrl 正则：品牌信号优先于 modelId（混合网关也按渠道品牌显示图标），
 *   但纯聚合站（硅基流动/阶跃）刻意不映射——它们只转售别家模型，映射会把图标钉错。
 */

import { describe, it, expect } from 'vitest'
import { resolveModelVendor, resolveVendorFromBaseUrl } from '@/utils/modelIconMapping'

describe('resolveModelVendor 新增模型短名', () => {
  it.each([
    ['hy3', 'hunyuan'],
    ['hy4-preview', 'hunyuan'],
    ['k3', 'kimi'],
    ['k3-256k', 'kimi'],
    ['k3.1-pro', 'kimi'],
    ['k3.1-pro-highspeed', 'kimi'],
    ['kimi-for-coding', 'kimi'],
    ['doubao-seed-2.1-pro', 'doubao'],
    ['doubao-seed-2-1-turbo-260628', 'doubao'],
    ['mimo-v2.6-flash', 'xiaomi'],
    ['step-5-preview', null],
  ] as const)('%s → %s', (modelId, expected) => {
    expect(resolveModelVendor(modelId)).toBe(expected)
  })
})

describe('resolveVendorFromBaseUrl 新增渠道域名', () => {
  it.each([
    ['https://api.kimi.com/coding/v1', 'kimi'],
    ['https://api.kimi.ai/coding/v1', 'kimi'],
    ['https://api.minimax.cn/anthropic', 'minimax'],
    ['https://token-plan-cn.xiaomimimo.com/anthropic', 'xiaomi'],
    ['https://tokenhub.tencentmaas.com/v1', 'hunyuan'],
    ['https://tokenhub-intl.tencentmaas.com/v1', 'hunyuan'],
    ['https://ark.cn-beijing.volces.com/api/compatible', 'doubao'],
    ['https://ark.cn-beijing.volces.com/api/plan', 'doubao'],
    ['https://coding.dashscope.aliyuncs.com/v1', 'bailian'],
    ['https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', 'bailian'],
    ['https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'bailian'],
    ['https://token-plan.maas.qianwenaiapi.com/apps/anthropic', 'qwen'],
    ['https://api.siliconflow.cn/v1', null],
    ['https://api.stepfun.com/step_plan', null],
  ] as const)('%s → %s', (baseUrl, expected) => {
    expect(resolveVendorFromBaseUrl(baseUrl)).toBe(expected)
  })
})
