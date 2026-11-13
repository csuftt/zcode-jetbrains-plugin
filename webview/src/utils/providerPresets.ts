/**
 * 预设供应商表（添加渠道 → 选预设自动填充 baseURL/协议/模型列表，用户只填 API Key）
 *
 * 数据源：ZCode 客户端 config/provider/zcode-builtin.json 的 providerConfigRules.templateRules
 * （官方「添加供应商」预设卡同一份注册表；客户端设置页为远程 H5，本地资源里只有这份权威拷贝）。
 * 模型上下文/输出/视觉位按 models.dev（https://models.dev/api.json）官方源条目校准；
 * 客户端 templateRules 只给 modelId 列表，不带 limit。
 *
 * 收录口径（对齐客户端 rev-44 的 34 条模板，共 31 张卡）：
 * - OpenCode Go/Zen 的 6 条（各 3 个协议变体）折叠为 2 张卡：同一 baseURL 三种协议，
 *   判重按 baseURL、一 URL 只能一张卡，取 openai-chat-completions 变体（模型目录最全），
 *   需要 Anthropic/Responses 协议进编辑器手改即可；
 * - openai-responses 格式（OpenAI/xAI）降级 openai-compatible（Kotlin 写端 KINDS 仅两种，
 *   同 baseUrl 走 chat completions 官方端点均兼容）；
 * - 智谱族 4 条照收（对齐客户端「智谱」分组——用户显式配 API key/coding plan key 的场景，
 *   与内置渠道区并存）；
 * - 「千问 Token Plan（个人版）」为插件侧增补条：客户端只有「阿里云百炼 Token Plan 团队版」
 *   走 aliyuncs 端点，千问 AI 平台个人版端点 token-plan.maas.qianwenaiapi.com 未收录，
 *   按官网文档「Token Plan 个人版」端点与套餐模型清单自建；
 * - OpenRouter 70 模型、Z.ai API / BigModel API 24~25 模型同口径精选跨家主流款
 *   （limit 在 models.dev 有实锤的子集）。
 * 少数新快照模型（doubao-seed-2-1-pro/lite-260915 等）models.dev 尚未收录，limit 取同族
 * 上一版条目值，注释标注。
 */

export interface ProviderPresetModel {
  modelId: string
  context: number
  output?: number
  images?: boolean
}

/** 预设分组（对齐客户端「智谱」/「其他」两段；zhipu 组恒在前）*/
export type ProviderPresetGroup = 'zhipu' | 'other'

export interface ProviderPreset {
  /** 客户端 templateId，保留同名便于对表 */
  id: string
  /** 显示名（客户端 templateNameMap 同款双语） */
  name: { zh: string; en: string }
  group: ProviderPresetGroup
  kind: 'anthropic' | 'openai-compatible'
  baseURL: string
  /** 控制台 API Key 管理页（弹窗内一键直达） */
  keyUrl?: string
  /** 头像底色（品牌近似色，避免引入图片资源） */
  accent: string
  /** 头像短字 */
  badge: string
  models: ProviderPresetModel[]
}

/** Z.ai API / BigModel API 共用的 12 模型精选（模板 builtinModelIds 24~25 个中 models.dev 有 limit 实锤的主流子集，ID 按官方大写）*/
const GLM_API_MODELS: ProviderPresetModel[] = [
  { modelId: 'GLM-5.3', context: 1_000_000, output: 131_072 },
  { modelId: 'GLM-5.3-Flash', context: 1_000_000, output: 131_072, images: true },
  { modelId: 'GLM-5V-Turbo', context: 200_000, output: 131_072, images: true },
  { modelId: 'GLM-5.1', context: 200_000, output: 131_072 },
  { modelId: 'GLM-5', context: 204_800, output: 131_072 },
  { modelId: 'GLM-5-Turbo', context: 200_000, output: 131_072 },
  { modelId: 'GLM-4.7', context: 204_800, output: 131_072 },
  { modelId: 'GLM-4.7-Flash', context: 200_000, output: 131_072 },
  { modelId: 'GLM-4.6', context: 204_800, output: 131_072 },
  { modelId: 'GLM-4.6V', context: 128_000, output: 32_768, images: true },
  { modelId: 'GLM-4.5-Air', context: 131_072, output: 98_304 },
  { modelId: 'GLM-4.5', context: 131_072, output: 98_304 },
]

/** 千问 Token Plan 系（个人版/团队版同后端）共用的对话模型目录：官方套餐文档清单剔图像/视频/语音类 */
const QWEN_TOKEN_PLAN_MODELS: ProviderPresetModel[] = [
  { modelId: 'qwen3.8-max', context: 1_000_000, output: 131_072, images: true },
  { modelId: 'qwen3.8-flash', context: 1_000_000, output: 131_072, images: true },
  { modelId: 'qwen3.7-max', context: 1_000_000, output: 131_072 },
  { modelId: 'qwen3.7-plus', context: 1_000_000, output: 65_536, images: true },
  { modelId: 'qwen3.6-flash', context: 1_000_000, output: 65_536, images: true },
  { modelId: 'glm-5.3', context: 1_000_000, output: 131_072 },
  { modelId: 'glm-5.2', context: 1_000_000, output: 131_072 },
  { modelId: 'deepseek-v4-pro', context: 1_000_000, output: 384_000 },
  { modelId: 'deepseek-v4.1-flash', context: 1_000_000, output: 384_000, images: true },
  { modelId: 'deepseek-v4-flash-0731', context: 1_000_000, output: 384_000 },
]

/** Kimi Code 订阅（国内/国际同目录，仅域名不同）*/
const KIMI_CODE_MODELS: ProviderPresetModel[] = [
  { modelId: 'k3.1-pro', context: 1_048_576, output: 131_072, images: true },
  { modelId: 'k3.1-pro-highspeed', context: 1_048_576, output: 131_072, images: true },
  { modelId: 'k3', context: 1_048_576, output: 131_072, images: true },
  { modelId: 'k3-256k', context: 262_144, output: 131_072, images: true },
  { modelId: 'kimi-for-coding', context: 1_048_576, output: 32_768, images: true },
  { modelId: 'kimi-for-coding-highspeed', context: 262_144, output: 32_768, images: true },
]

/** 腾讯 TokenHub 混元系（广州/新加坡同目录）*/
const TENCENT_TOKENHUB_MODELS: ProviderPresetModel[] = [
  { modelId: 'hy3', context: 256_000, output: 128_000 },
  { modelId: 'hy4-preview', context: 1_024_000, output: 64_000 },
]

/** 阶跃星辰 API / Step Plan 同目录 */
const STEPFUN_MODELS: ProviderPresetModel[] = [
  { modelId: 'step-5-preview', context: 1_000_000, output: 65_536, images: true },
  { modelId: 'step-3.7-flash', context: 256_000, output: 256_000, images: true },
]

/** 火山方舟 Coding Plan / Agent Plan 同目录（2.1 新快照 models.dev 未收录，limit 取同族 2.1-turbo / 2.0-lite）*/
const VOLCENGINE_PLAN_MODELS: ProviderPresetModel[] = [
  { modelId: 'doubao-seed-2.1-pro', context: 256_000, output: 256_000, images: true },
  { modelId: 'doubao-seed-2.1-lite', context: 256_000, output: 131_072, images: true },
]

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'bigmodel-api',
    name: { zh: 'BigModel Coding Plan', en: 'BigModel Coding Plan' },
    group: 'zhipu',
    kind: 'anthropic',
    baseURL: 'https://open.bigmodel.cn/api/anthropic',
    keyUrl: 'https://bigmodel.cn/coding-plan/personal/overview',
    accent: '#4e5bff',
    badge: 'B',
    models: [
      { modelId: 'GLM-5.3', context: 1_000_000, output: 131_072 },
      { modelId: 'GLM-5.3-Flash', context: 1_000_000, output: 131_072, images: true },
    ],
  },
  {
    id: 'zai-api',
    name: { zh: 'Z.ai Coding Plan', en: 'Z.ai Coding Plan' },
    group: 'zhipu',
    kind: 'anthropic',
    baseURL: 'https://api.z.ai/api/anthropic',
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    accent: '#000000',
    badge: 'Z',
    models: [
      { modelId: 'GLM-5.3', context: 1_000_000, output: 131_072 },
      { modelId: 'GLM-5.3-Flash', context: 1_000_000, output: 131_072, images: true },
    ],
  },
  {
    id: 'bigmodel-standard-api',
    name: { zh: 'BigModel API', en: 'BigModel API' },
    group: 'zhipu',
    kind: 'openai-compatible',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    accent: '#4e5bff',
    badge: 'B',
    models: GLM_API_MODELS,
  },
  {
    id: 'zai-standard-api',
    name: { zh: 'Z.ai API', en: 'Z.ai API' },
    group: 'zhipu',
    kind: 'openai-compatible',
    baseURL: 'https://api.z.ai/api/paas/v4',
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    accent: '#000000',
    badge: 'Z',
    models: GLM_API_MODELS,
  },
  {
    id: 'moonshot-kimi',
    name: { zh: 'Kimi', en: 'Kimi' },
    group: 'other',
    kind: 'anthropic',
    baseURL: 'https://api.moonshot.cn/anthropic',
    keyUrl: 'https://platform.kimi.com/console/api-keys',
    accent: '#111318',
    badge: 'K',
    models: [
      { modelId: 'kimi-k3.1-pro', context: 1_048_576, output: 1_048_576, images: true },
      { modelId: 'kimi-k3.1-pro-highspeed', context: 1_048_576, output: 1_048_576, images: true },
      { modelId: 'kimi-k3', context: 1_048_576, output: 1_048_576, images: true },
      { modelId: 'kimi-k2.7-code', context: 262_144, output: 262_144, images: true },
      { modelId: 'kimi-k2.7-code-highspeed', context: 262_144, output: 262_144, images: true },
      { modelId: 'kimi-k2.6', context: 262_144, output: 262_144, images: true },
      { modelId: 'k3', context: 1_048_576, output: 1_048_576, images: true },
      { modelId: 'k3-256k', context: 262_144, output: 1_048_576, images: true },
    ],
  },
  {
    id: 'kimi-code-cn',
    name: { zh: 'Kimi Code（国内）', en: 'Kimi Code (China)' },
    group: 'other',
    kind: 'openai-compatible',
    baseURL: 'https://api.kimi.com/coding/v1',
    keyUrl: 'https://www.kimi.com/code/console',
    accent: '#111318',
    badge: 'KC',
    models: KIMI_CODE_MODELS,
  },
  {
    id: 'kimi-code-intl',
    name: { zh: 'Kimi Code（国际）', en: 'Kimi Code (International)' },
    group: 'other',
    kind: 'openai-compatible',
    baseURL: 'https://api.kimi.ai/coding/v1',
    keyUrl: 'https://www.kimi.com/code/console',
    accent: '#111318',
    badge: 'KC',
    models: KIMI_CODE_MODELS,
  },
  {
    id: 'minimax',
    name: { zh: 'MiniMax', en: 'MiniMax' },
    group: 'other',
    kind: 'anthropic',
    baseURL: 'https://api.minimaxi.com/anthropic',
    keyUrl: 'https://platform.minimaxi.com/console/access?tab=api-keys',
    accent: '#e23c3c',
    badge: 'M',
    models: [
      { modelId: 'MiniMax-M3.1-Flash', context: 1_000_000, output: 524_288, images: true },
      { modelId: 'MiniMax-M3', context: 1_000_000, output: 524_288, images: true },
      { modelId: 'MiniMax-M2.7', context: 204_800, output: 131_072 },
      { modelId: 'MiniMax-M2.7-highspeed', context: 204_800, output: 131_072 },
      { modelId: 'MiniMax-M2.5', context: 204_800, output: 131_072 },
      { modelId: 'MiniMax-M2.5-highspeed', context: 204_800, output: 131_072 },
    ],
  },
  {
    id: 'minimax-m-plan-cn',
    name: { zh: 'MiniMax M Plan（中国）', en: 'MiniMax M Plan (China)' },
    group: 'other',
    kind: 'anthropic',
    baseURL: 'https://api.minimax.cn/anthropic',
    keyUrl: 'https://platform.minimax.cn/console/plan',
    accent: '#e23c3c',
    badge: 'MP',
    models: [
      { modelId: 'MiniMax-M3.1-Flash', context: 1_000_000, output: 524_288, images: true },
      { modelId: 'MiniMax-M3.1-Flash-Preview', context: 1_000_000, output: 512_000, images: true },
    ],
  },
  {
    id: 'deepseek',
    name: { zh: 'DeepSeek', en: 'DeepSeek' },
    group: 'other',
    kind: 'anthropic',
    baseURL: 'https://api.deepseek.com/anthropic',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    accent: '#4d6bfe',
    badge: 'D',
    models: [
      { modelId: 'deepseek-flash', context: 1_048_576, output: 393_216, images: true },
      { modelId: 'deepseek-v4-pro', context: 1_048_576, output: 393_216 },
    ],
  },
  {
    id: 'qwen-alibaba-model-studio-cn',
    name: { zh: '阿里云百炼（中国）', en: 'Alibaba Model Studio (CN)' },
    group: 'other',
    kind: 'anthropic',
    baseURL: 'https://dashscope.aliyuncs.com/apps/anthropic',
    keyUrl: 'https://bailian.console.aliyun.com/cn-beijing?tab=model',
    accent: '#ff6a00',
    badge: '千',
    models: [
      { modelId: 'qwen3.8-max', context: 1_000_000, output: 131_072, images: true },
      { modelId: 'qwen3.8-flash', context: 1_000_000, output: 131_072, images: true },
      { modelId: 'qwen3.7-max', context: 1_000_000, output: 131_072 },
      { modelId: 'qwen3.7-plus', context: 1_000_000, output: 64_000, images: true },
      { modelId: 'qwen3.7-flash', context: 1_000_000, output: 131_072, images: true },
      { modelId: 'qwen3.6-plus', context: 1_000_000, output: 65_536, images: true },
      { modelId: 'qwen3.6-flash', context: 1_000_000, output: 65_536, images: true },
      { modelId: 'qwen3.5-plus', context: 1_000_000, output: 65_536, images: true },
      { modelId: 'qwen3.5-flash', context: 1_000_000, output: 65_536, images: true },
      { modelId: 'qwen3-max', context: 262_144, output: 65_536 },
      { modelId: 'qwen-plus', context: 1_000_000, output: 32_768 },
      { modelId: 'qwen-flash', context: 1_000_000, output: 32_768 },
      { modelId: 'qwen3-vl-plus', context: 262_144, output: 32_768, images: true },
    ],
  },
  {
    id: 'qwen-alibaba-model-studio-intl',
    name: { zh: '阿里云百炼（国际）', en: 'Alibaba Model Studio (Intl)' },
    group: 'other',
    kind: 'openai-compatible',
    baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    keyUrl: 'https://modelstudio.console.aliyun.com/ap-southeast-1?tab=dashboard',
    accent: '#ff6a00',
    badge: '千',
    models: [
      { modelId: 'qwen3.8-max', context: 1_000_000, output: 131_072, images: true },
      { modelId: 'qwen3.8-flash', context: 1_000_000, output: 131_072, images: true },
      { modelId: 'qwen3.8-omni-flash', context: 1_000_000, output: 131_072, images: true },
      { modelId: 'qwen3.7-max', context: 1_000_000, output: 131_072 },
      { modelId: 'qwen3.7-plus', context: 1_000_000, output: 131_072, images: true },
      { modelId: 'qwen3.7-flash', context: 1_000_000, output: 131_072, images: true },
      { modelId: 'qwen3.6-plus', context: 1_000_000, output: 65_536, images: true },
      { modelId: 'qwen3.6-flash', context: 1_000_000, output: 65_536, images: true },
      { modelId: 'qwen3.5-plus', context: 1_000_000, output: 65_536, images: true },
      { modelId: 'qwen3.5-flash', context: 1_000_000, output: 65_536, images: true },
      { modelId: 'qwen3-max', context: 262_144, output: 65_536 },
      { modelId: 'qwen-plus', context: 1_000_000, output: 32_768 },
      { modelId: 'qwen-flash', context: 1_000_000, output: 32_768 },
      { modelId: 'qwen3-vl-plus', context: 262_144, output: 32_768, images: true },
    ],
  },
  {
    id: 'qwen-coding-plan-cn',
    name: { zh: '阿里云百炼 Coding Plan（中国）', en: 'Alibaba Coding Plan (China)' },
    group: 'other',
    kind: 'openai-compatible',
    baseURL: 'https://coding.dashscope.aliyuncs.com/v1',
    keyUrl: 'https://bailian.console.aliyun.com/cn-beijing/?tab=coding-plan',
    accent: '#ff6a00',
    badge: '千',
    models: [
      { modelId: 'qwen3.7-plus', context: 1_000_000, output: 64_000, images: true },
    ],
  },
  {
    id: 'qwen-token-plan-team-cn',
    name: { zh: '阿里云百炼 Token Plan 团队版（中国）', en: 'Alibaba Token Plan Team (China)' },
    group: 'other',
    kind: 'openai-compatible',
    baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    keyUrl: 'https://bailian.console.aliyun.com/',
    accent: '#ff6a00',
    badge: 'TP',
    // 模板只预置 2 个（团队版按席位开通，模型目录同个人版，可在渠道里自行补齐）
    models: [
      { modelId: 'qwen3.8-max', context: 1_000_000, output: 131_072, images: true },
      { modelId: 'qwen3.8-flash', context: 1_000_000, output: 131_072, images: true },
    ],
  },
  {
    id: 'qwen-token-plan-personal-cn',
    name: { zh: '千问 Token Plan（个人版）', en: 'Qwen Token Plan (Personal)' },
    group: 'other',
    kind: 'anthropic',
    baseURL: 'https://token-plan.maas.qianwenaiapi.com/apps/anthropic',
    keyUrl: 'https://platform.qianwenaiapi.com/home/api-keys?target=individual',
    accent: '#615ced',
    badge: '千',
    // 套餐按 Credits 统一计量，官方文档「Token Plan 个人版概述」列出的对话模型子集（剔图像/视频/语音类）
    models: QWEN_TOKEN_PLAN_MODELS,
  },
  {
    id: 'xiaomi-mimo',
    name: { zh: 'Xiaomi MiMo API', en: 'Xiaomi MiMo API' },
    group: 'other',
    kind: 'anthropic',
    baseURL: 'https://api.xiaomimimo.com/anthropic',
    keyUrl: 'https://platform.xiaomimimo.com/',
    accent: '#ff6900',
    badge: 'Mi',
    models: [
      { modelId: 'mimo-v2.6-pro', context: 1_048_576, output: 131_072, images: true },
      { modelId: 'mimo-v2.6-flash', context: 1_048_576, output: 131_072, images: true },
      { modelId: 'mimo-v2.5-pro', context: 1_048_576, output: 131_072 },
      { modelId: 'mimo-v2.5', context: 1_048_576, output: 131_072, images: true },
    ],
  },
  {
    id: 'xiaomi-mimo-token-plan',
    name: { zh: 'Xiaomi MiMo Token Plan', en: 'Xiaomi MiMo Token Plan' },
    group: 'other',
    kind: 'anthropic',
    baseURL: 'https://token-plan-cn.xiaomimimo.com/anthropic',
    keyUrl: 'https://platform.xiaomimimo.com/',
    accent: '#ff6900',
    badge: 'Mi',
    models: [
      { modelId: 'mimo-v2.6-pro', context: 1_048_576, output: 131_072, images: true },
      { modelId: 'mimo-v2.6-flash', context: 1_048_576, output: 131_072, images: true },
    ],
  },
  {
    id: 'tencent-tokenhub-cn',
    name: { zh: '腾讯 TokenHub 广州 API（中国站）', en: 'Tencent TokenHub Guangzhou API' },
    group: 'other',
    kind: 'openai-compatible',
    baseURL: 'https://tokenhub.tencentmaas.com/v1',
    keyUrl: 'https://console.cloud.tencent.com/tokenhub',
    accent: '#2b7cff',
    badge: 'T',
    models: TENCENT_TOKENHUB_MODELS,
  },
  {
    id: 'tencent-tokenhub-intl',
    name: { zh: '腾讯 TokenHub 新加坡 API（中国站）', en: 'Tencent TokenHub Singapore API' },
    group: 'other',
    kind: 'openai-compatible',
    baseURL: 'https://tokenhub-intl.tencentmaas.com/v1',
    keyUrl: 'https://console.cloud.tencent.com/tokenhub',
    accent: '#2b7cff',
    badge: 'T',
    models: TENCENT_TOKENHUB_MODELS,
  },
  {
    id: 'volcengine-ark',
    name: { zh: '火山方舟 API', en: 'Volcano Ark API' },
    group: 'other',
    kind: 'anthropic',
    baseURL: 'https://ark.cn-beijing.volces.com/api/compatible',
    keyUrl: 'https://ark.volcengine.com/region:cn-beijing/apikey',
    accent: '#1a3ec8',
    badge: '火',
    models: [
      { modelId: 'doubao-seed-evolving', context: 256_000, output: 256_000, images: true },
      // 260915 新快照 models.dev 未收录，limit 取同族 260628（pro）/ 260428（lite）
      { modelId: 'doubao-seed-2-1-pro-260915', context: 256_000, output: 256_000, images: true },
      { modelId: 'doubao-seed-2-1-lite-260915', context: 256_000, output: 131_072, images: true },
      { modelId: 'doubao-seed-2-1-turbo-260628', context: 256_000, output: 256_000, images: true },
    ],
  },
  {
    id: 'volcengine-coding-plan',
    name: { zh: '火山方舟 Coding Plan', en: 'Volcano Ark Coding Plan' },
    group: 'other',
    kind: 'anthropic',
    baseURL: 'https://ark.cn-beijing.volces.com/api/coding',
    keyUrl: 'https://ark.volcengine.com/region:cn-beijing',
    accent: '#1a3ec8',
    badge: '火',
    models: VOLCENGINE_PLAN_MODELS,
  },
  {
    id: 'volcengine-agent-plan',
    name: { zh: '火山方舟 Agent Plan', en: 'Volcano Ark Agent Plan' },
    group: 'other',
    kind: 'anthropic',
    baseURL: 'https://ark.cn-beijing.volces.com/api/plan',
    keyUrl: 'https://ark.volcengine.com/region:cn-beijing',
    accent: '#1a3ec8',
    badge: '火',
    models: VOLCENGINE_PLAN_MODELS,
  },
  {
    id: 'stepfun',
    name: { zh: '阶跃星辰 API', en: 'StepFun API' },
    group: 'other',
    kind: 'anthropic',
    baseURL: 'https://api.stepfun.com',
    keyUrl: 'https://platform.stepfun.com/interface-key',
    accent: '#0ea5e9',
    badge: '阶',
    models: STEPFUN_MODELS,
  },
  {
    id: 'stepfun-step-plan',
    name: { zh: '阶跃星辰 Step Plan', en: 'StepFun Step Plan' },
    group: 'other',
    kind: 'anthropic',
    baseURL: 'https://api.stepfun.com/step_plan',
    keyUrl: 'https://platform.stepfun.com/interface-key',
    accent: '#0ea5e9',
    badge: '阶',
    models: STEPFUN_MODELS,
  },
  {
    id: 'openai',
    name: { zh: 'OpenAI', en: 'OpenAI' },
    group: 'other',
    kind: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    accent: '#10a37f',
    badge: 'O',
    models: [
      { modelId: 'gpt-6-astra', context: 1_050_000, output: 128_000, images: true },
      { modelId: 'gpt-6.1-sol', context: 1_050_000, output: 128_000, images: true },
      { modelId: 'gpt-6.1-terra', context: 1_050_000, output: 128_000, images: true },
      { modelId: 'gpt-6-luna', context: 1_050_000, output: 128_000, images: true },
      { modelId: 'gpt-5.6-sol', context: 1_050_000, output: 128_000, images: true },
      { modelId: 'gpt-5.6-terra', context: 1_050_000, output: 128_000, images: true },
      { modelId: 'gpt-5.6-luna', context: 1_050_000, output: 128_000, images: true },
      { modelId: 'gpt-5.6', context: 1_050_000, output: 128_000, images: true },
      { modelId: 'gpt-5.4', context: 1_050_000, output: 128_000, images: true },
      { modelId: 'gpt-5.4-pro', context: 1_050_000, output: 128_000, images: true },
      { modelId: 'gpt-5.4-mini', context: 400_000, output: 128_000, images: true },
      { modelId: 'gpt-5.4-nano', context: 400_000, output: 128_000, images: true },
      { modelId: 'gpt-5.3-codex', context: 400_000, output: 128_000, images: true },
    ],
  },
  {
    id: 'anthropic',
    name: { zh: 'Anthropic', en: 'Anthropic' },
    group: 'other',
    kind: 'anthropic',
    baseURL: 'https://api.anthropic.com/v1',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    accent: '#d97757',
    badge: 'A',
    models: [
      { modelId: 'claude-fable-5-1', context: 1_000_000, output: 128_000, images: true },
      { modelId: 'claude-opus-5-5', context: 1_000_000, output: 128_000, images: true },
      { modelId: 'claude-sonnet-5-5', context: 1_000_000, output: 128_000, images: true },
      { modelId: 'claude-haiku-5-5', context: 1_000_000, output: 128_000, images: true },
      { modelId: 'claude-fable-5', context: 1_000_000, output: 128_000, images: true },
      { modelId: 'claude-opus-5', context: 1_000_000, output: 128_000, images: true },
      { modelId: 'claude-sonnet-5', context: 1_000_000, output: 128_000, images: true },
      { modelId: 'claude-haiku-4-5-20251001', context: 200_000, output: 64_000, images: true },
    ],
  },
  {
    id: 'xai',
    name: { zh: 'xAI', en: 'xAI' },
    group: 'other',
    kind: 'openai-compatible',
    baseURL: 'https://api.x.ai/v1',
    keyUrl: 'https://console.x.ai',
    accent: '#000000',
    badge: 'X',
    models: [
      { modelId: 'grok-4.7', context: 500_000, output: 500_000, images: true },
      { modelId: 'grok-4.6', context: 500_000, output: 500_000, images: true },
      { modelId: 'grok-build-0.1', context: 256_000, output: 256_000, images: true },
      { modelId: 'grok-4.3', context: 1_000_000, output: 30_000, images: true },
    ],
  },
  {
    id: 'siliconflow-cn',
    name: { zh: '硅基流动 API（中国）', en: 'SiliconFlow API (China)' },
    group: 'other',
    kind: 'openai-compatible',
    baseURL: 'https://api.siliconflow.cn/v1',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    accent: '#7c3aed',
    badge: 'SF',
    models: [
      { modelId: 'zai-org/GLM-5.3', context: 1_048_576, output: 131_072 },
      { modelId: 'deepseek-ai/DeepSeek-V4-Flash', context: 1_000_000, output: 384_000 },
      // models.dev 未收录该 ID，limit 取上游 Kimi K2.7 Code 条目
      { modelId: 'moonshotai/Kimi-K2.7-Code', context: 262_144, output: 262_144, images: true },
    ],
  },
  {
    id: 'openrouter',
    name: { zh: 'OpenRouter', en: 'OpenRouter' },
    group: 'other',
    kind: 'anthropic',
    baseURL: 'https://openrouter.ai/api',
    keyUrl: 'https://openrouter.ai/keys',
    accent: '#6f6af8',
    badge: 'OR',
    models: [
      { modelId: 'anthropic/claude-fable-5.1', context: 1_000_000, output: 128_000, images: true },
      { modelId: 'openai/gpt-6-astra', context: 1_050_000, output: 128_000, images: true },
      { modelId: 'openai/gpt-6.1-sol', context: 1_050_000, output: 128_000, images: true },
      { modelId: 'anthropic/claude-opus-5', context: 1_000_000, output: 128_000, images: true },
      { modelId: 'moonshotai/kimi-k3.1-pro', context: 1_048_576, output: 943_718, images: true },
      { modelId: 'deepseek/deepseek-v4-pro', context: 1_048_576, output: 384_000 },
      { modelId: 'z-ai/glm-5.3', context: 1_048_576, output: 131_072 },
      { modelId: 'z-ai/glm-5.3-flash', context: 1_048_576, output: 131_072, images: true },
      { modelId: 'qwen/qwen3.8-max', context: 1_000_000, output: 131_072, images: true },
      { modelId: 'minimax/minimax-m3.1-flash', context: 1_048_576, output: 524_288, images: true },
      { modelId: 'xiaomi/mimo-v2.5-pro', context: 1_050_000, output: 131_072 },
      { modelId: 'x-ai/grok-4.7', context: 500_000, output: 450_000, images: true },
      { modelId: 'deepseek/deepseek-v4.1-flash', context: 1_048_576, output: 384_000, images: true },
    ],
  },
  {
    id: 'opencode-go',
    name: { zh: 'OpenCode Go', en: 'OpenCode Go' },
    group: 'other',
    kind: 'openai-compatible',
    baseURL: 'https://opencode.ai/zen/go/v1',
    keyUrl: 'https://opencode.ai/auth',
    accent: '#334155',
    badge: 'OC',
    models: [
      { modelId: 'minimax-m3.1-flash', context: 1_000_000, output: 512_000, images: true },
      { modelId: 'kimi-k3.1-pro', context: 1_048_576, output: 131_072, images: true },
      { modelId: 'kimi-k3', context: 1_048_576, output: 131_072, images: true },
      { modelId: 'kimi-k2.7-code', context: 262_144, output: 262_144, images: true },
      { modelId: 'kimi-k2.6', context: 262_144, output: 65_536, images: true },
      { modelId: 'glm-5.3-flash', context: 1_000_000, output: 131_072, images: true },
      { modelId: 'glm-5.3', context: 1_000_000, output: 131_072 },
      { modelId: 'glm-5.2', context: 1_000_000, output: 131_072 },
      { modelId: 'glm-5.1', context: 204_800, output: 131_072 },
      { modelId: 'deepseek-v4.1-flash', context: 1_000_000, output: 384_000, images: true },
      { modelId: 'deepseek-v4-pro', context: 1_000_000, output: 384_000 },
      { modelId: 'deepseek-v4-flash', context: 1_000_000, output: 384_000 },
      { modelId: 'mimo-v2.6-pro', context: 1_048_576, output: 131_072, images: true },
      { modelId: 'mimo-v2.6-flash', context: 1_048_576, output: 131_072, images: true },
      { modelId: 'mimo-v2.5', context: 1_000_000, output: 128_000, images: true },
      { modelId: 'mimo-v2.5-pro', context: 1_048_576, output: 128_000 },
      { modelId: 'hy4-preview', context: 1_024_000, output: 64_000 },
      { modelId: 'hy3', context: 256_000, output: 128_000 },
    ],
  },
  {
    id: 'opencode-zen',
    name: { zh: 'OpenCode Zen', en: 'OpenCode Zen' },
    group: 'other',
    kind: 'openai-compatible',
    baseURL: 'https://opencode.ai/zen/v1',
    keyUrl: 'https://opencode.ai/auth',
    accent: '#0f172a',
    badge: 'OC',
    models: [
      { modelId: 'kimi-k3', context: 1_048_576, output: 131_072, images: true },
      { modelId: 'minimax-m3', context: 512_000, output: 128_000, images: true },
      { modelId: 'minimax-m2.7', context: 204_800, output: 131_072 },
      { modelId: 'deepseek-v4-pro', context: 1_000_000, output: 384_000 },
      { modelId: 'deepseek-v4-flash', context: 1_000_000, output: 384_000 },
      { modelId: 'glm-5.2', context: 1_000_000, output: 131_072 },
      { modelId: 'glm-5.1', context: 204_800, output: 131_072 },
      { modelId: 'nemotron-3.5-lightning-free', context: 262_144, output: 262_144 },
      { modelId: 'muse-spark-1.2-contributor-free', context: 1_048_576, output: 131_072, images: true },
    ],
  },
]

/** baseURL 归一（判重口径）：去尾斜杠 + 小写 host 不敏感处理（仅去尾斜杠即可，预设值恒 https）*/
export function normalizeBaseURL(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/** 预设是否已添加过：与现有自定义渠道 baseURL 精确匹配（改名不影响，改 baseURL 视为新渠道）*/
export function isPresetAdded(preset: ProviderPreset, existingBaseURLs: Iterable<string>): boolean {
  const target = normalizeBaseURL(preset.baseURL)
  for (const u of existingBaseURLs) {
    if (normalizeBaseURL(u) === target) return true
  }
  return false
}
