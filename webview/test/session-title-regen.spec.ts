/**
 * AI 重新生成会话标题（regenerateSessionTitle）流程测试
 *
 * 覆盖三段：
 * 1. extractTitleExcerpt 摘录口径：全会话多轮摘录（User/AI 标签多行、时序排列），
 *    偏向最新内容（预算超限时优先保留最新轮次）；过滤合成消息（info 级 / part 级
 *    synthetic）、/compact 摘要消息、model-only；单条 1000 截断；空内容返回 null。
 * 2. 发起：携带摘录发 op；全局单飞（进行中忽略重复调用）；空内容置错误不发请求。
 * 3. 回包：成功经 renameSession 应用标题（sessions 更新）并清进行中标记；
 *    失败清标记 + 置通栏错误。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- mock 桥接层：捕获 sendToJava，手动注入响应 ----
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
import {
  extractTitleExcerpt,
  TITLE_EXCERPT_MAX_MESSAGES,
  TITLE_EXCERPT_MSG_MAX,
  TITLE_EXCERPT_TOTAL_MAX,
} from '@/utils/titleExcerpt'
import type { ZCodeMessage, MessageInfo, MessagePart } from '@/types/messages'

const SID = 'sess_regen-1111-2222-3333-444444444444'

function msg(role: 'user' | 'assistant', text: string, opts: { synthetic?: boolean; partSynthetic?: boolean; summary?: boolean; visibility?: string } = {}): ZCodeMessage {
  const info: MessageInfo = {
    role,
    time: { created: 1 },
    id: `msg-${role}-${text.slice(0, 8)}-${Math.random()}`,
    sessionID: SID,
    ...(opts.visibility ? { visibility: opts.visibility } : {}),
    ...(opts.synthetic ? { synthetic: true as const } : {}),
    ...(opts.summary ? { summary: { title: 'Compact summary', body: '摘要全文' } } : {}),
  }
  const parts: MessagePart[] = [
    { type: 'text', text: opts.summary ? '摘要正文，不应作为标题素材' : text, ...(opts.partSynthetic ? { synthetic: true } : {}) },
  ]
  return { info, parts }
}

beforeEach(() => {
  sentRequests.length = 0
  useStore.getState().init()
  sentRequests.length = 0 // 清掉 init 触发的 listSessions/listModels
  useStore.setState({
    connectionStatus: 'mock',
    currentSessionId: SID,
    messages: [],
    titleRegeneratingSessionId: null,
    sessionTitleRegenError: null,
    sessions: [
      {
        sessionId: SID,
        title: '旧标题',
        status: 'idle',
        mode: 'yolo',
        workspacePath: 'G:\\mock',
        workspaceKey: 'G:\\mock',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  })
})

describe('extractTitleExcerpt 摘录口径', () => {
  it('多轮对话按时序输出 User/AI 标签多行', () => {
    const excerpt = extractTitleExcerpt([
      msg('user', '先做登录页'),
      msg('assistant', '好的，登录页完成'),
      msg('user', '接下来把首页改造成仪表盘'),
    ])
    expect(excerpt).toBe('User: 先做登录页\nAI: 好的，登录页完成\nUser: 接下来把首页改造成仪表盘')
  })

  it('过滤合成消息/压缩摘要/model-only 与文本 part 之外的噪声', () => {
    const excerpt = extractTitleExcerpt([
      msg('user', '系统注入', { synthetic: true }),
      msg('user', '压缩摘要', { summary: true }),
      msg('assistant', 'model-only 回复', { visibility: 'model-only' }),
      msg('user', '通知文本', { partSynthetic: true }),
      msg('user', '真实提问'),
    ])
    expect(excerpt).toBe('User: 真实提问')
  })

  it('偏好最新内容：预算超限时丢旧留新（主题漂移场景）', () => {
    const filler = 'x'.repeat(2000)
    const messages: ZCodeMessage[] = [msg('user', '最初的主题：数据库调优')]
    for (let i = 0; i < 10; i++) messages.push(msg('assistant', filler), msg('user', filler))
    messages.push(msg('user', '最新主题：首页仪表盘改造'))
    const excerpt = extractTitleExcerpt(messages)!
    expect(excerpt).toContain('首页仪表盘改造')
    expect(excerpt).not.toContain('数据库调优')
    // 摘录控制在总预算内
    expect(excerpt.length).toBeLessThanOrEqual(TITLE_EXCERPT_TOTAL_MAX)
  })

  it('条数上限：最多收录 16 条（从最新往回）', () => {
    const messages: ZCodeMessage[] = []
    for (let i = 0; i < 30; i++) messages.push(msg('user', `m${i}`), msg('assistant', `a${i}`))
    const excerpt = extractTitleExcerpt(messages)!
    const lines = excerpt.split('\n')
    expect(lines.length).toBe(TITLE_EXCERPT_MAX_MESSAGES)
    // 最新两条在末尾
    expect(lines.at(-2)).toBe('User: m29')
    expect(lines.at(-1)).toBe('AI: a29')
    // 最早被挤出的不在
    expect(excerpt).not.toContain('m0')
  })

  it('单条消息截断到 1000 字符', () => {
    const long = 'a'.repeat(TITLE_EXCERPT_MSG_MAX + 500)
    const excerpt = extractTitleExcerpt([msg('user', long)])!
    expect(excerpt).toBe(`User: ${'a'.repeat(TITLE_EXCERPT_MSG_MAX)}`)
  })

  it('无可用对话文本返回 null；纯 AI 回复也是有效素材', () => {
    expect(extractTitleExcerpt([msg('user', '合成', { synthetic: true })])).toBeNull()
    expect(extractTitleExcerpt([])).toBeNull()
    // 最新 AI 回复是当前主题的最强信号，仅剩 AI 文本也可生成
    expect(extractTitleExcerpt([msg('user', '合成', { synthetic: true }), msg('assistant', '只剩 AI 的回答')]))
      .toBe('AI: 只剩 AI 的回答')
  })
})

describe('regenerateSessionTitle 发起', () => {
  it('携带摘录发 op 并置进行中标记', () => {
    useStore.setState({ messages: [msg('user', '修复会话标题的缺陷')] })
    useStore.getState().regenerateSessionTitle(SID)
    expect(sentRequests).toEqual([
      { op: 'regenerateSessionTitle', sessionId: SID, excerpt: 'User: 修复会话标题的缺陷' },
    ])
    expect(useStore.getState().titleRegeneratingSessionId).toBe(SID)
  })

  it('透传 currentModel（generateText 跟随会话模型，避免选中未注册渠道）', () => {
    useStore.setState({
      messages: [msg('user', '第一条')],
      currentModel: { providerId: 'builtin:bigmodel-coding-plan', modelId: 'GLM-5.3' },
    })
    useStore.getState().regenerateSessionTitle(SID)
    expect(sentRequests[0]).toEqual({
      op: 'regenerateSessionTitle',
      sessionId: SID,
      excerpt: 'User: 第一条',
      providerId: 'builtin:bigmodel-coding-plan',
      modelId: 'GLM-5.3',
    })
  })

  it('进行中忽略重复调用（全局单飞）', () => {
    useStore.setState({ messages: [msg('user', '第一条')] })
    useStore.getState().regenerateSessionTitle(SID)
    useStore.getState().regenerateSessionTitle(SID)
    expect(sentRequests.length).toBe(1)
  })

  it('空会话置错误提示且不发请求', () => {
    useStore.setState({ messages: [] })
    useStore.getState().regenerateSessionTitle(SID)
    expect(sentRequests.length).toBe(0)
    expect(useStore.getState().titleRegeneratingSessionId).toBeNull()
    expect(useStore.getState().sessionTitleRegenError).toBeTruthy()
  })
})

describe('sessionTitleRegenerated 回包', () => {
  it('成功：标题应用（sessions 更新 + persist 写入）+ 清进行中标记', () => {
    useStore.setState({ messages: [msg('user', '第一条')], titleRegeneratingSessionId: SID })
    useStore.getState().regenerateSessionTitle(SID)
    messageHandler!({ op: 'sessionTitleRegenerated', sessionId: SID, title: 'AI 新标题' })
    const st = useStore.getState()
    expect(st.titleRegeneratingSessionId).toBeNull()
    expect(st.sessions.find((s) => s.sessionId === SID)?.title).toBe('AI 新标题')
  })

  it('失败：清进行中标记 + 置通栏错误', () => {
    useStore.setState({ titleRegeneratingSessionId: SID })
    messageHandler!({ op: 'sessionTitleRegenerated', sessionId: SID, error: '标题生成失败: 超时' })
    const st = useStore.getState()
    expect(st.titleRegeneratingSessionId).toBeNull()
    expect(st.sessionTitleRegenError).toContain('超时')
    // 旧标题不被破坏
    expect(st.sessions.find((s) => s.sessionId === SID)?.title).toBe('旧标题')
  })
})
