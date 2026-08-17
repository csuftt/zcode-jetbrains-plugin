/**
 * IPC 桥：React ↔ Java(JCEF) 通信
 *
 * 架构（沿用 Java 端 ZCodeToolWindowPanel.kt 已定义的协议）：
 *   React → Java:  window.sendToJava(jsonStr)  → JBCefJSQuery → handleJsMessage
 *   Java → React:  executeJavaScript("window.zcodeBridge.onMessage(obj)")
 *
 * JCEF 环境检测：
 *   Java 端加载 HTML 时注入 window.__ZCODE_CEF_QUERY__（指向 JBCefJSQuery 动态函数）。
 *   该函数名运行时生成（如 cefQuery_1015760238_1），不能硬编码，
 *   所以 Java 端在注入时把它赋给一个固定全局变量。
 *
 * 开发模式（localhost:5173，无 JCEF）：
 *   走 mock 响应，方便纯前端调试。
 */

import type { JavaRequest, JavaResponse, StreamEvent } from '@/types/messages'

// ============ 全局类型声明 ============

declare global {
  interface Window {
    /** Java 注入：JBCefJSQuery 动态函数（发送消息到 Java） */
    __ZCODE_CEF_QUERY__?: (args: {
      request: string
      persistent?: boolean
      onSuccess?: (r: string) => void
      onFailure?: (e: string) => void
    }) => void
    /** 兼容：旧版直接挂到 window 上的 sendToJava（buildInitialHtml 路径） */
    sendToJava?: (msg: unknown) => void
    /** Java → JS 回调入口 */
    zcodeBridge?: { onMessage: (msg: unknown) => void }
    /** Java 启动注入的初始主题 */
    __INITIAL_IDE_THEME__?: 'light' | 'dark'
    /** Java 推送主题变化的回调（阶段 2.6 注册） */
    onIdeThemeChanged?: (isDark: boolean) => void
    /** Java 注入的当前项目 workspacePath（用于 listSessions 过滤） */
    __ZCODE_WORKSPACE__?: string
    /** Java 注入的多标签初始会话 id（标签恢复绑定；空串表示新标签自动建会话） */
    __ZCODE_INITIAL_SESSION__?: string
  }
}

// ============ 响应监听 ============

type ResponseHandler = (msg: JavaResponse) => void
type StreamHandler = (sessionId: string, event: StreamEvent) => void
type StreamBatchHandler = (sessionId: string, events: StreamEvent[]) => void

const listeners = new Set<ResponseHandler>()
const streamListeners = new Set<StreamHandler>()
const streamBatchListeners = new Set<StreamBatchHandler>()

/**
 * 订阅 Java → JS 的普通响应（listSessions/messages 等）。
 * @returns 取消订阅函数
 */
export function onMessage(handler: ResponseHandler): () => void {
  listeners.add(handler)
  return () => listeners.delete(handler)
}

/**
 * 订阅流式事件（session/event 透传，高频）。
 * 和普通响应分开，避免每个 delta 都经过响应处理逻辑。
 * @returns 取消订阅函数
 */
export function onStreamEvent(handler: StreamHandler): () => void {
  streamListeners.add(handler)
  return () => streamListeners.delete(handler)
}

/**
 * 订阅批量流式事件（Java 端节流合并后的批次，每 16ms 一批）。
 * store 用这个：一次处理整批事件，只 set 一次，避免每个 delta 单独重渲染。
 * @returns 取消订阅函数
 */
export function onStreamBatch(handler: StreamBatchHandler): () => void {
  streamBatchListeners.add(handler)
  return () => streamBatchListeners.delete(handler)
}

/**
 * 初始化 Java → JS 回调入口。
 * 必须在 React mount 前调用一次，把 window.zcodeBridge.onMessage 接上。
 */
// ============ 诊断日志（页面可见，排查流式用）============
export interface DiagEntry { time: string; op: string; detail: string }
const diagLog: DiagEntry[] = []
const diagListeners = new Set<(entries: DiagEntry[]) => void>()

function addDiag(op: string, detail: string) {
  const entry = { time: new Date().toLocaleTimeString(), op, detail }
  diagLog.push(entry)
  if (diagLog.length > 100) diagLog.shift()
  diagListeners.forEach((fn) => fn([...diagLog]))
}

/** 订阅诊断日志变化（App 的诊断面板用）*/
export function onDiagLog(handler: (entries: DiagEntry[]) => void): () => void {
  diagListeners.add(handler)
  return () => diagListeners.delete(handler)
}

export function getDiagLog(): DiagEntry[] {
  return [...diagLog]
}

export function initBridge(): void {
  window.zcodeBridge = {
    onMessage: (raw: unknown) => {
      let msg: JavaResponse
      try {
        msg = (typeof raw === 'string' ? JSON.parse(raw) : raw) as JavaResponse
      } catch (e) {
        console.error('[bridge] onMessage 解析失败', e, raw)
        return
      }
      // 诊断：打印收到的消息类型
      if (msg.op === 'streamEvent') {
        const kind = 'kind' in msg.event.payload ? msg.event.payload.kind : ''
        addDiag('streamEvent', `${msg.event.type} ${kind}`)
        console.log('[bridge] ← streamEvent', msg.event.type, kind)
      } else if (msg.op === 'streamBatch') {
        const types = msg.events.map((e) => e.type + ('kind' in e.payload ? `(${e.payload.kind})` : ''))
        addDiag('streamBatch', `${msg.events.length}条: ${types.slice(0, 5).join(',')}`)
        console.log('[bridge] ← streamBatch', msg.events.length, 'events:', types.join(','))
      } else {
        addDiag(msg.op, '')
        console.log('[bridge] ←', msg.op)
      }
      // 流式事件走独立通道（单个或批量）
      if (msg.op === 'streamEvent') {
        streamListeners.forEach((fn) => {
          try {
            fn(msg.sessionId, msg.event)
          } catch (err) {
            console.error('[bridge] stream listener 抛错', err)
          }
        })
        return
      }
      if (msg.op === 'streamBatch') {
        // 批量事件：优先走 batch 通道（store 一次处理整批，只 set 一次）
        if (streamBatchListeners.size > 0) {
          streamBatchListeners.forEach((fn) => {
            try {
              fn(msg.sessionId, msg.events)
            } catch (err) {
              console.error('[bridge] stream batch listener 抛错', err)
            }
          })
        } else {
          // 兜底：没有 batch 监听器时逐个推
          for (const evt of msg.events) {
            streamListeners.forEach((fn) => {
              try { fn(msg.sessionId, evt) } catch (err) { console.error('[bridge] stream listener 抛错', err) }
            })
          }
        }
        return
      }
      // 普通响应
      listeners.forEach((fn) => {
        try {
          fn(msg)
        } catch (err) {
          console.error('[bridge] listener 抛错', err)
        }
      })
    },
  }
}

// ============ 发送（React → Java）============

/**
 * 发请求到 Java 端（通过 JBCefJSQuery）。
 * 在 JCEF 环境调用 window.__ZCODE_CEF_QUERY__；非 JCEF 环境（dev/单测）走 mock。
 */
export function sendToJava(req: JavaRequest): void {
  // 优先用 Java 注入的 CEF_QUERY 函数
  if (typeof window.__ZCODE_CEF_QUERY__ === 'function') {
    try {
      window.__ZCODE_CEF_QUERY__({
        request: JSON.stringify(req),
        persistent: false,
        onSuccess: () => {},
        onFailure: (err: string) => console.error('[bridge] CEF_QUERY 失败', err),
      })
      return
    } catch (e) {
      console.error('[bridge] __ZCODE_CEF_QUERY__ 调用异常', e)
    }
  }

  // 兼容旧版（buildInitialHtml 路径直接挂 sendToJava）
  if (typeof window.sendToJava === 'function') {
    window.sendToJava(req)
    return
  }

  // 非 JCEF 环境：mock（方便前端独立开发）
  mockRespond(req)
}

// ============ 环境检测 ============

/** 是否在 JCEF 环境中（Java 端注入了桥） */
export function isInJcef(): boolean {
  return typeof window.__ZCODE_CEF_QUERY__ === 'function' ||
    typeof window.sendToJava === 'function'
}

/** 当前项目的 workspacePath（Java 注入，mock 模式返回固定值） */
export function getWorkspacePath(): string {
  return window.__ZCODE_WORKSPACE__ ?? ''
}

/** 多标签恢复绑定的初始会话 id（Java 注入；空串/未注入表示走常规恢复逻辑） */
export function getInitialSessionId(): string {
  return window.__ZCODE_INITIAL_SESSION__ ?? ''
}

// ============ Mock（纯前端开发用）============

const mockSessions = [
  {
    sessionId: 'sess_mock_1',
    title: '（mock）计算一加一',
    status: 'idle',
    mode: 'yolo',
    workspacePath: 'G:\\mock',
    workspaceKey: 'G:\\mock',
    createdAt: Date.now() - 3600_000,
    updatedAt: Date.now() - 120_000,
  },
  {
    sessionId: 'sess_mock_2',
    title: '（mock）分析移动端 Bridge 设计',
    status: 'idle',
    mode: 'build',
    workspacePath: 'G:\\mock',
    workspaceKey: 'G:\\mock',
    createdAt: Date.now() - 86400_000,
    updatedAt: Date.now() - 86400_000,
  },
]

function mockRespond(req: JavaRequest): void {
  console.log('[bridge:mock] 收到请求', req.op)

  // send：触发流式事件模拟（验收阶段 2.4 用）
  if (req.op === 'send') {
    // 先回 sendAccepted
    setTimeout(() => {
      listeners.forEach((fn) => fn({ op: 'sendAccepted', sessionId: req.sessionId, accepted: 'true' }))
    }, 100)
    // 然后推流式事件
    mockStreamTurn(req.sessionId)
    return
  }

  // subscribe：直接回 subscribed
  if (req.op === 'subscribe') {
    setTimeout(() => {
      listeners.forEach((fn) => fn({ op: 'subscribed', sessionId: req.sessionId }))
    }, 100)
    return
  }

  // stop：回 stopped
  if (req.op === 'stop') {
    setTimeout(() => {
      listeners.forEach((fn) => fn({ op: 'stopped', sessionId: req.sessionId }))
    }, 100)
    return
  }

  // mcpServerTools：延迟 1.2s 响应（浏览器验收 loading spin 态）
  if (req.op === 'mcpServerTools') {
    setTimeout(() => {
      const resp = mockResponse(req)
      if (resp) listeners.forEach((fn) => fn(resp))
    }, 1200)
    return
  }

  // 其他 op 走标准 mock 响应
  setTimeout(() => {
    const resp = mockResponse(req)
    if (resp) {
      listeners.forEach((fn) => fn(resp))
    }
  }, 200)
}

/**
 * 模拟一个完整的流式 turn（验收阶段 2.4 流式渲染用）
 * 事件序列：turn.started → reasoning_delta×N → tool.updated(scheduled→result)
 *           → text_delta×N → turn.completed
 */
function mockStreamTurn(sessionId: string): void {
  const turnId = `turn_mock_${Date.now()}`
  const msgId = `msg_stream_${Date.now()}`
  let seq = 0
  const ts = () => Date.now()

  const push = (type: string, payload: Record<string, unknown>) => {
    const event = { type, seq: seq++, sessionId, turnId, timestamp: ts(), payload }
    streamListeners.forEach((fn) => fn(sessionId, event as unknown as StreamEvent))
  }
  // 以指定会话 id 推事件（mock 子会话原生事件流，验证 childLiveMessages 实时归约）
  const pushAs = (sid: string, type: string, payload: Record<string, unknown>) => {
    const event = { type, seq: seq++, sessionId: sid, turnId, timestamp: ts(), payload }
    streamListeners.forEach((fn) => fn(sid, event as unknown as StreamEvent))
  }

  // turn.started
  setTimeout(() => push('turn.started', { turnNumber: 1, messageId: msgId }), 300)

  // ===== 子代理流式序列（验收子代理分流：主聊天只出 Agent 卡，工具进底部栏/详情弹窗）=====
  // 1) 父会话 Agent 工具调度/启动（普通事件 → 主聊天 Agent 卡 + parseAgents）
  const agentCallId = `call_sub_agent_${Date.now()}`
  setTimeout(() => push('tool.updated', {
    kind: 'scheduled',
    toolCallId: agentCallId,
    toolName: 'Agent',
    input: { description: '扫描 webview 组件依赖关系（mock 流式）', subagent_type: 'Explore', prompt: '读取 webview/src 下的组件，梳理依赖关系' },
  }), 800)
  // 1a) 生命周期通知（session.updated / kind=subagent.lifecycle）：spawned 携带
  //     childSessionId → 前端注册子会话，后续子会话原生事件流实时归约成完整对话
  const childSid = 'sess_mock_child_live'
  setTimeout(() => push('session.updated', {
    kind: 'subagent.lifecycle',
    phase: 'spawned',
    agentId: 'agent_mock_1',
    agentType: 'Explore',
    childSessionId: childSid,
    parentToolCallId: agentCallId,
    status: 'running',
  }), 850)
  setTimeout(() => push('tool.updated', { kind: 'started', toolCallId: agentCallId }), 900)
  // 1b) 子会话原生事件流（sessionId=子会话）：turn.started → AI 文本 → 工具 → turn.completed
  const childMsgId = `child_msg_${Date.now()}`
  setTimeout(() => pushAs(childSid, 'turn.started', { turnNumber: 1, messageId: childMsgId }), 950)
  const childText1 = '收到任务：梳理 webview 组件依赖。我先读取入口文件，再搜索 store 的使用位置。'
  for (let i = 0; i < 6; i++) {
    setTimeout(() => pushAs(childSid, 'model.streaming', {
      kind: 'text_delta',
      delta: childText1.slice(Math.floor(childText1.length / 6) * i, Math.floor(childText1.length / 6) * (i + 1)),
    }), 1000 + i * 90)
  }
  // 2) 子代理内部工具转发事件（source=subagent → 不进主聊天，聚合到 subagentActivities）
  //    同时推子会话原生 tool.updated（无 source 字段 → 归约进 childLiveMessages）
  const subTools = [
    { id: 'sub_read_1', name: 'Read', input: { file_path: 'webview/src/App.tsx' }, out: '（mock 子代理读取）import ChatHeader / ChatView / StatusPanel …' },
    { id: 'sub_grep_1', name: 'Grep', input: { pattern: 'useStore', path: 'webview/src' }, out: '（mock 子代理搜索）useStore.ts / StatusPanel.tsx / ToolCallCard.tsx …' },
    { id: 'sub_bash_1', name: 'Bash', input: { command: 'npm run build', description: '构建 webview 验证类型' }, out: '✓ built in 12.3s' },
  ]
  subTools.forEach((t, i) => {
    const base = 1100 + i * 550
    setTimeout(() => push('tool.updated', {
      kind: 'scheduled',
      toolCallId: `call_${t.id}`,
      toolName: t.name,
      input: t.input,
      source: 'subagent',
      parentToolCallId: agentCallId,
      agentId: 'agent_mock_1',
      agentType: 'Explore',
      childSessionId: childSid,
      childToolCallId: `child_${t.id}`,
      description: '扫描 webview 组件依赖关系（mock 流式）',
    }), base)
    setTimeout(() => pushAs(childSid, 'tool.updated', {
      kind: 'scheduled',
      toolCallId: `child_${t.id}`,
      toolName: t.name,
      input: t.input,
    }), base + 10)
    setTimeout(() => push('tool.updated', {
      kind: 'started', toolCallId: `call_${t.id}`, source: 'subagent', parentToolCallId: agentCallId,
      agentId: 'agent_mock_1', childSessionId: childSid,
    }), base + 80)
    setTimeout(() => pushAs(childSid, 'tool.updated', {
      kind: 'started', toolCallId: `child_${t.id}`,
    }), base + 90)
    setTimeout(() => push('tool.updated', {
      kind: 'result',
      toolCallId: `call_${t.id}`,
      result: { success: true, content: t.out },
      source: 'subagent',
      parentToolCallId: agentCallId,
      agentId: 'agent_mock_1',
      childSessionId: childSid,
    }), base + 380)
    setTimeout(() => pushAs(childSid, 'tool.updated', {
      kind: 'result',
      toolCallId: `child_${t.id}`,
      result: { success: true, content: t.out },
    }), base + 390)
  })
  // 2b) 子会话 AI 总结文本 + turn 结束
  const childText2 = '三个工具执行完毕：App.tsx 是组合根，StatusPanel/ToolCallCard 都直接订阅 useStore，无循环依赖。'
  for (let i = 0; i < 6; i++) {
    setTimeout(() => pushAs(childSid, 'model.streaming', {
      kind: 'text_delta',
      delta: childText2.slice(Math.floor(childText2.length / 6) * i, Math.floor(childText2.length / 6) * (i + 1)),
    }), 2800 + i * 90)
  }
  setTimeout(() => pushAs(childSid, 'turn.completed', {}), 3400)
  // 3) 父会话 Agent 工具收尾（普通事件 → 主聊天 Agent 卡完成 + 活动标记完成）
  setTimeout(() => push('tool.updated', {
    kind: 'result',
    toolCallId: agentCallId,
    result: { success: true, content: '## 子代理报告（mock 流式）\n\n扫描完成：共 3 个工具调用，组件依赖关系已梳理。' },
  }), 3600)
  // 3a) 生命周期通知：stopped（详情弹窗开着 → 自动拉权威全量替换实时流）
  setTimeout(() => push('session.updated', {
    kind: 'subagent.lifecycle',
    phase: 'stopped',
    agentId: 'agent_mock_1',
    agentType: 'Explore',
    childSessionId: childSid,
    parentToolCallId: agentCallId,
    status: 'completed',
  }), 3700)
  // ===== 子代理流式序列结束 =====

  // 模拟 ZCode 自动进计划模式（reasoning 期间推 state.updated → 验收 UI 模式跟随）
  setTimeout(() => push('state.updated', {
    reason: 'mode_changed',
    patch: { mode: { current: 'plan' } },
  }), 1200)

  // reasoning_delta（模拟思考，长文本验证流式时自动滚底）
  const reasoningText =
    '（mock 流式）用户问了一个问题，让我思考一下该怎么回答。' +
    '这个问题涉及多个方面：首先是技术选型，需要考虑生态成熟度、团队熟悉度和长期维护成本；' +
    '其次是架构设计，包括模块划分、接口定义和数据流方向，好的架构应该让变化点局部化；' +
    '然后是性能考量，从缓存策略、批量处理到异步化，每一步优化都要有数据支撑；' +
    '最后是测试策略，单元测试覆盖核心逻辑、集成测试验证模块协作、端到端测试保障关键路径。'.repeat(6)
  let rIdx = 0
  const reasoningTimer = setInterval(() => {
    if (rIdx >= reasoningText.length) {
      clearInterval(reasoningTimer)
      return
    }
    push('model.streaming', { kind: 'reasoning_delta', delta: reasoningText.slice(rIdx, rIdx + 3) })
    rIdx += 3
  }, 80)

  // text_delta（模拟正文，在 reasoning 后）
  const fullText = '## 这是流式回复\n\n我正在**逐字生成**这段回复，用来验收流式渲染效果。\n\n```typescript\nconst x: number = 42\n```\n\n- 列表项一\n- 列表项二\n'
  let tIdx = 0
  let textStarted = false
  const textTimer = setInterval(() => {
    if (!textStarted) {
      if (rIdx < reasoningText.length) return // 等 reasoning 结束
      textStarted = true
    }
    if (tIdx >= fullText.length) {
      clearInterval(textTimer)
      // 模拟计划完成自动退出计划模式（切回 yolo）
      setTimeout(() => push('state.updated', {
        reason: 'mode_changed',
        patch: { mode: { current: 'yolo' } },
      }), 150)
      // turn.completed
      setTimeout(() => push('turn.completed', {
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, cacheReadTokens: 0 },
      }), 400)
      return
    }
    push('model.streaming', { kind: 'text_delta', delta: fullText.slice(tIdx, tIdx + 2) })
    tIdx += 2
  }, 50)
}

function mockResponse(req: JavaRequest): JavaResponse | null {
  switch (req.op) {
    case 'listSessions':
      return { op: 'listSessions', sessions: mockSessions }
    case 'listModels':
      // 模拟 ~/.zcode/v2/config.json 的 provider 注册表（验收模型下拉用）
      return {
        op: 'models',
        models: [
          { providerId: 'builtin:bigmodel-coding-plan', providerName: 'BigModel - Coding Plan', modelId: 'GLM-5.2', modelName: 'GLM-5.2' },
          { providerId: 'builtin:bigmodel-coding-plan', providerName: 'BigModel - Coding Plan', modelId: 'GLM-5-Turbo', modelName: 'glm-5-turbo' },
          { providerId: 'builtin:zai-coding-plan', providerName: 'ZAI - Coding Plan', modelId: 'glm-5.1', modelName: 'glm-5.1' },
          { providerId: '27d2ecde-5da2-43bd-b2d8-dae985bfaf8f', providerName: 'DeepSeek', modelId: 'deepseek-v4-flash', modelName: 'deepseek-v4-flash' },
          { providerId: '27d2ecde-5da2-43bd-b2d8-dae985bfaf8f', providerName: 'DeepSeek', modelId: 'deepseek-v3.2', modelName: 'deepseek-v3.2' },
        ],
      }
    case 'getUsage':
      // mock：27.9% 上下文使用率（与真实场景接近）
      return { op: 'usage', sessionId: req.sessionId, used: 278937, size: 1000000, hitRate: 0.988 }
    case 'getQuota':
      // mock：额度数据（5小时 86% / 每周 64%）
      return {
        op: 'quota',
        data: {
          level: 'Max',
          limits: [
            { type: 'TOKENS_LIMIT', unit: 3, percentage: 86, currentValue: 430000, usage: 500000, nextResetTime: Date.now() + 3 * 3600 * 1000 },
            { type: 'TOKENS_LIMIT', unit: 6, percentage: 64, currentValue: 1280000, usage: 2000000, nextResetTime: Date.now() + 5 * 24 * 3600 * 1000 },
          ],
        },
      }
    case 'getModelUsage': {
      // mock：模型用量曲线（2 模型 × 8 时间点）
      const xt = ['2026-08-13 09:00', '2026-08-13 12:00', '2026-08-13 15:00', '2026-08-13 18:00', '2026-08-13 21:00', '2026-08-14 00:00', '2026-08-14 09:00', '2026-08-14 12:00']
      return {
        op: 'modelUsage',
        data: {
          granularity: 'hourly',
          x_time: xt,
          totalUsage: { totalModelCallCount: 142, totalTokensUsage: 2856000 },
          modelSummaryList: [
            { modelName: 'GLM-5.2', totalTokens: 1980000 },
            { modelName: 'DeepSeek-V4', totalTokens: 876000 },
          ],
          modelDataList: [
            { modelName: 'GLM-5.2', totalTokens: 1980000, tokensUsage: [120000, 180000, 240000, 310000, 280000, 90000, 420000, 340000] },
            { modelName: 'DeepSeek-V4', totalTokens: 876000, tokensUsage: [40000, 60000, 110000, 150000, 130000, 36000, 200000, 114000] },
          ],
        },
      }
    }
    case 'getToolUsage': {
      // mock：工具用量曲线（3 工具 × 8 时间点）
      const xt = ['2026-08-13 09:00', '2026-08-13 12:00', '2026-08-13 15:00', '2026-08-13 18:00', '2026-08-13 21:00', '2026-08-14 00:00', '2026-08-14 09:00', '2026-08-14 12:00']
      return {
        op: 'toolUsage',
        data: {
          granularity: 'hourly',
          x_time: xt,
          toolSummaryList: [
            { toolName: '读取文件', totalUsageCount: 312 },
            { toolName: '运行命令', totalUsageCount: 148 },
            { toolName: '编辑文件', totalUsageCount: 96 },
          ],
          toolDataList: [
            { toolName: '读取文件', totalUsageCount: 312, usageCount: [40, 52, 48, 35, 20, 8, 70, 39] },
            { toolName: '运行命令', totalUsageCount: 148, usageCount: [18, 25, 22, 16, 10, 4, 35, 18] },
            { toolName: '编辑文件', totalUsageCount: 96, usageCount: [10, 18, 15, 12, 6, 2, 22, 11] },
          ],
        },
      }
    }
    case 'openFile':
      return { op: 'fileOpened' } as any
    case 'showDiff':
      return { op: 'diffShown' } as any
    case 'refreshFile':
      return { op: 'fileRefreshed' } as any
    case 'setModel':
      // mock：直接回 modelSet（store 更新 currentModel）
      return {
        op: 'modelSet',
        sessionId: req.sessionId,
        modelId: req.modelId,
        providerId: req.providerId,
      }
    case 'getSettings':
      // mock：GLM-5.2 三档 + yolo 模式（真实结构见 session/read → settings）
      return {
        op: 'settings',
        sessionId: req.sessionId,
        mode: { current: 'yolo' },
        thoughtLevel: {
          enabled: true,
          current: 'high',
          defaultLevel: 'max',
          available: [
            { label: 'off', value: 'off' },
            { label: 'high', value: 'high' },
            { label: 'max', value: 'max' },
          ],
        },
      } as any
    case 'setThoughtLevel':
      return { op: 'thoughtLevelSet', sessionId: req.sessionId, thoughtLevel: req.thoughtLevel } as any
    case 'setMode':
      return { op: 'modeSet', sessionId: req.sessionId, mode: req.mode } as any
    case 'pickFiles':
      // mock：模拟 FileChooser 选了 1 个文件（走 filesToInput 推送链路，InputBox 加 chip）
      return { op: 'filesToInput', refs: ['@mock/README.md'] } as any
    case 'createSession':
      return { op: 'createSession', sessionId: 'sess_mock_' + Date.now() }
    case 'clearTabSession':
      // mock：TabState 在 Java 侧，前端待命态无需处理，直接 ack
      return { op: 'tabSessionCleared' }
    case 'subagents':
      // mock：session/subagents RPC（历史 Agent 工具 → 权威子代理列表，含 childSessionId）
      return {
        op: 'subagents',
        sessionId: req.sessionId,
        data: {
          revision: 1,
          childSessionIds: ['sess_mock_child_1', 'sess_mock_child_2'],
          running: [
            {
              childSessionId: 'sess_mock_child_2',
              toolCallId: 'call_mock_agent2',
              subagentType: 'general-purpose',
              title: '分析 webview 流式渲染的 re-render 热点，输出优化建议',
              status: 'running',
              startedAt: Date.now() - 20000,
            },
          ],
          ended: {
            total: 1,
            items: [
              {
                childSessionId: 'sess_mock_child_1',
                toolCallId: 'call_mock_agent1',
                subagentType: 'Explore',
                title: '读取 README.md 并总结项目现状',
                status: 'completed',
                summary: '项目为三层架构：protocol-client（协议）/ intellij-plugin（IDE 主体）/ webview（React 前端）',
                startedAt: Date.now() - 52000,
                endedAt: Date.now() - 49000,
              },
            ],
          },
        },
      }
    case 'subagentMessages':
      // mock：子会话完整消息（详情弹窗"原始过程"）
      return {
        op: 'subagentMessages',
        sessionId: req.sessionId,
        messages: [
          {
            info: {
              role: 'user',
              time: { created: Date.now() - 52000 },
              id: 'msg_mock_child_u',
              sessionID: req.sessionId,
            },
            parts: [{
              type: 'text',
              text: '（mock 子会话）读取 README.md 并总结项目现状。要求：列出模块清单与各自职责，指出当前开发状态。',
            }],
          },
          {
            info: {
              role: 'assistant',
              time: { created: Date.now() - 51500, completed: Date.now() - 49500 },
              modelID: 'GLM-5.2',
              providerID: 'anthropic',
              id: 'msg_mock_child_a',
              sessionID: req.sessionId,
            },
            parts: [
              {
                type: 'tool',
                callID: 'call_child_read_1',
                tool: 'Read',
                state: {
                  status: 'completed',
                  input: { file_path: 'README.md' },
                  output: '1\t# ZCode IDEA 插件\n2\t（mock 子会话读取输出）…\n12\t| webview | 🚧 开发中 | React 前端 |',
                  time: { start: Date.now() - 51400, end: Date.now() - 51000 },
                },
              },
              {
                type: 'tool',
                callID: 'call_child_grep_1',
                tool: 'Grep',
                state: {
                  status: 'completed',
                  input: { pattern: 'JBCefJSQuery', path: 'intellij-plugin' },
                  output: '（mock 子会话搜索输出）ZCodeToolWindowPanel.kt:120: jsQuery = JBCefJSQuery.create(jbCefBrowser)',
                  time: { start: Date.now() - 50900, end: Date.now() - 50500 },
                },
              },
              {
                type: 'text',
                text: '## 子代理报告（mock）\n\n项目为**三层架构**：\n\n- `protocol-client`：Kotlin 协议客户端（JSON-RPC over stdio）\n- `intellij-plugin`：IDE 插件主体（JCEF webview 宿主）\n- `webview`：React 前端\n\n当前 webview 处于开发中阶段，流式渲染已通，正在对齐 cc-gui 视觉。',
              },
            ],
          },
        ],
      }
    case 'messages':
      return {
        op: 'messages',
        sessionId: req.sessionId,
        messages: [
          {
            info: {
              role: 'user',
              time: { created: Date.now() - 120000 },
              id: 'msg_mock_u0',
              sessionID: req.sessionId,
            },
            parts: [{ type: 'text', text: '（mock）早上好，帮我看看这个项目里有没有需要重构的地方。' }],
          },
          {
            info: {
              role: 'user',
              time: { created: Date.now() - 60000 },
              id: 'msg_mock_u1',
              sessionID: req.sessionId,
            },
            parts: [{ type: 'text', text: '（mock）请分析这个项目的结构，并给出优化建议。' }],
          },
          {
            info: {
              role: 'assistant',
              time: { created: Date.now() - 55000, completed: Date.now() - 50000 },
              modelID: 'GLM-5.2',
              providerID: 'anthropic',
              mode: 'yolo',
              tokens: { total: 1234, input: 1100, output: 134, reasoning: 0 },
              cost: 0.001,
              id: 'msg_mock_a1',
              sessionID: req.sessionId,
            },
            parts: [
              { type: 'step-start' },
              {
                type: 'reasoning',
                text:
                  '（mock）用户想分析项目结构。我先读一下 README.md 了解项目概况，再看看主要的源文件。' +
                  '这是一个多模块的 Gradle 项目，包含 protocol-client、intellij-plugin 和 webview 三个模块。' +
                  'protocol-client 负责与 ZCode CLI 的协议通信，intellij-plugin 是 IDE 插件主体（JCEF webview），' +
                  'webview 是 React 前端。三者通过 JSON-RPC 风格的桥接通信。'.repeat(14),
              },
              {
                type: 'tool',
                callID: 'call_mock_1',
                tool: 'Read',
                state: {
                  status: 'completed',
                  input: { file_path: 'README.md', limit: 10 },
                  output: '1\t# ZCode IDEA 插件\n2\t\n3\t在 IDEA / PyCharm 等 JetBrains IDE 里管理 ZCode 会话\n4\t\n5\t## 当前状态（2026-08-12）\n6\t\n7\t| 模块 | 状态 | 说明 |\n8\t|---|---|---|\n9\t| protocol-client | ✅ 完成 | Kotlin 协议客户端 |\n10\t| intellij-plugin | 🚧 开发中 | IDE 插件主体 |',
                  title: 'Read',
                  time: { start: Date.now() - 54000, end: Date.now() - 53500 },
                },
              },
              // （mock）Read —— 第二个读取（与上面 Read 聚成「批量读取文件」组）
              {
                type: 'tool',
                callID: 'call_mock_read2',
                tool: 'Read',
                state: {
                  status: 'completed',
                  input: { file_path: 'package.json', limit: 20 },
                  output: '{\n  "name": "zcode-webview",\n  "version": "0.1.0",\n  ...',
                  time: { start: Date.now() - 53400, end: Date.now() - 53300 },
                },
              },
              // （mock）Bash —— 运行命令样例
              {
                type: 'tool',
                callID: 'call_mock_bash',
                tool: 'Bash',
                state: {
                  status: 'completed',
                  input: { command: 'npm run build:single', description: '构建 webview 生产包' },
                  output: '> zcode-webview@0.1.0 build:single\n> tsc -b && vite build --config vite.singlefile.config.ts\n\n✓ built in 15.26s',
                  time: { start: Date.now() - 53800, end: Date.now() - 53600 },
                },
              },
              // （mock）Bash —— 连续命令样例（与上一条聚成「批量运行命令」组）
              {
                type: 'tool',
                callID: 'call_mock_bash2',
                tool: 'Bash',
                state: {
                  status: 'completed',
                  input: { command: './gradlew build -x test', description: '构建插件发行包' },
                  output: 'BUILD SUCCESSFUL in 42s\n3 actionable tasks: 3 executed',
                  time: { start: Date.now() - 53500, end: Date.now() - 53400 },
                },
              },
              {
                type: 'tool',
                callID: 'call_mock_bash3',
                tool: 'Bash',
                state: {
                  status: 'error',
                  input: { command: 'git push origin master', description: '推送构建产物' },
                  output: '',
                  error: { message: "fatal: Authentication failed for 'https://github.com/'" },
                  time: { start: Date.now() - 53400, end: Date.now() - 53300 },
                },
              },
              {
                type: 'step-finish',
                reason: 'tool-calls',
                cost: 0,
                tokens: { total: 1234, input: 1100, output: 134, reasoning: 0 },
              },
              // （mock）TodoWrite —— 状态面板「任务」数据源
              {
                type: 'tool',
                callID: 'call_mock_todo',
                tool: 'TodoWrite',
                state: {
                  status: 'completed',
                  input: {
                    todos: [
                      { content: '梳理项目三层架构', status: 'completed', priority: 'high' },
                      { content: '分析流式渲染性能瓶颈', status: 'completed', priority: 'high' },
                      { content: '优化 workspace 过滤逻辑', status: 'in_progress', priority: 'high' },
                      { content: '补充单元测试', status: 'pending', priority: 'medium' },
                    ],
                  },
                  time: { start: Date.now() - 53000, end: Date.now() - 52900 },
                },
              },
              // （mock）Agent —— 状态面板「Agent」数据源
              {
                type: 'tool',
                callID: 'call_mock_agent1',
                tool: 'Agent',
                state: {
                  status: 'completed',
                  input: { description: '读取 README.md 并总结项目现状', subagent_type: 'Explore' },
                  time: { start: Date.now() - 52000, end: Date.now() - 49000 },
                },
              },
              {
                type: 'tool',
                callID: 'call_mock_agent2',
                tool: 'Agent',
                state: {
                  status: 'running',
                  input: { description: '分析 webview 流式渲染的 re-render 热点，输出优化建议', subagent_type: 'general-purpose' },
                  time: { start: Date.now() - 20000 },
                },
              },
              // （mock）Edit —— 状态面板「文件」数据源
              {
                type: 'tool',
                callID: 'call_mock_edit',
                tool: 'Edit',
                state: {
                  status: 'completed',
                  input: {
                    file_path: 'G:/mock/src/App.tsx',
                    old_string: '// 旧逻辑\nconst a = 1',
                    new_string: '// 新逻辑\nconst a = 1\nconst b = 2',
                  },
                  time: { start: Date.now() - 15000, end: Date.now() - 14000 },
                },
              },
              {
                type: 'tool',
                callID: 'call_mock_write',
                tool: 'Write',
                state: {
                  status: 'completed',
                  input: { path: 'G:/mock/src/utils/format.ts', content: 'export function fmt(x: number): string {\n  return String(x)\n}\n' },
                  time: { start: Date.now() - 13000, end: Date.now() - 12000 },
                },
              },
              // （mock）Grep/Glob —— 与上面 Edit/Write 分别聚成「批量编辑」「批量搜索」组
              {
                type: 'tool',
                callID: 'call_mock_grep',
                tool: 'Grep',
                state: {
                  status: 'completed',
                  input: { pattern: 'sendToJava\\(', path: 'webview/src', output_mode: 'content' },
                  output: 'webview/src/App.tsx:95:  sendToJava({ op: \'setTabTitle\', ... })\nwebview/src/components/InputBox.tsx:364:      sendToJava({ op: \'listFiles\', query })',
                  time: { start: Date.now() - 11000, end: Date.now() - 10900 },
                },
              },
              {
                type: 'tool',
                callID: 'call_mock_glob',
                tool: 'Glob',
                state: {
                  status: 'running',
                  input: { pattern: '**/*.less', path: 'webview/src/styles' },
                  time: { start: Date.now() - 10000 },
                },
              },
            ],
          },
          // （mock）子代理 task-notification —— 验收 AgentNotificationCard 渲染
          // role 是 user 但带 synthetic 标记，前端应识别为通知卡片而非用户消息
          {
            info: {
              role: 'user',
              time: { created: Date.now() - 44000 },
              id: 'msg_mock_notif1',
              sessionID: req.sessionId,
              synthetic: true,
              source: 'background_task',
              visibility: 'model-only',
              semantics: { origin: 'agent_runtime', kind: 'background_notification', uiVisibility: 'hidden' },
              metadata: {
                originMeta: {
                  backgroundSource: 'subagent',
                  title: '审查 application.yml 配置安全性',
                  workId: 'agent_mock_1',
                },
              },
            },
            parts: [
              {
                type: 'text',
                synthetic: true,
                text:
                  '<task-notification>\n' +
                  '<task-id>agent_mock_1</task-id>\n' +
                  '<tool-use-id>call_mock_agent_notif</tool-use-id>\n' +
                  '<output-file>C:\\Users\\mock\\agent_mock_1\\output.txt</output-file>\n' +
                  '<status>completed</status>\n' +
                  '<summary>Agent general-purpose task &quot;审查 application.yml 配置安全性&quot; completed.</summary>\n' +
                  '<result>## 配置安全审查结果\n\n发现 **3 个中危** 问题：\n\n| 严重程度 | 问题 | 位置 |\n|---|---|---|\n| 中 | 日志级别写死 `debug` | application.yml:36 |\n| 中 | Nacos 缺少 namespace 隔离 | application.yml:10 |\n| 低 | Actuator 端点无认证 | application.yml:21 |\n\n**修复建议**：\n\n```yaml\nlogging:\n  level:\n    com.example: ${LOG_LEVEL:info}\n```\n\n> 生产环境务必关闭 import-check 强校验。</result>\n' +
                  '<usage><subagent_tokens>28025</subagent_tokens><tool_uses>1</tool_uses><duration_ms>36254</duration_ms></usage>\n' +
                  '</task-notification>',
              },
            ],
          },
          // （mock）后台 bash 命令 task-notification —— 与子代理共用 background_task
          // 通道，靠 task-id 前缀 / summary 区分，应渲染为"后台命令"而非"子代理"
          {
            info: {
              role: 'user',
              time: { created: Date.now() - 43500 },
              id: 'msg_mock_notif1b',
              sessionID: req.sessionId,
              synthetic: true,
              source: 'background_task',
              visibility: 'model-only',
              semantics: { origin: 'agent_runtime', kind: 'background_notification', uiVisibility: 'hidden' },
              metadata: {
                originMeta: {
                  title: '执行完整清理并重建插件',
                  workId: 'exec_mock_1',
                },
              },
            },
            parts: [
              {
                type: 'text',
                synthetic: true,
                text:
                  '<task-notification>\n' +
                  '<task-id>exec_mock_1</task-id>\n' +
                  '<tool-use-id>call_mock_bash_notif</tool-use-id>\n' +
                  '<output-file>C:\\Users\\mock\\.zcode\\exec\\sess_mock\\call_mock_bash_notif-stdout.log</output-file>\n' +
                  '<status>completed</status>\n' +
                  '<summary>Background command &quot;执行完整清理并重建插件&quot; completed (exit code 0)</summary>\n' +
                  '<result>✅ 构建完成：intellij-plugin/build/distributions/ZC-GUI-0.1.0.zip</result>\n' +
                  '</task-notification>',
              },
            ],
          },
          // （mock）子代理 subagent-message —— 同步子代理中途回消息
          {
            info: {
              role: 'user',
              time: { created: Date.now() - 43000 },
              id: 'msg_mock_notif2',
              sessionID: req.sessionId,
              synthetic: true,
              source: 'subagent_message',
              visibility: 'model-only',
              semantics: { origin: 'agent_runtime', kind: 'subagent_notification', uiVisibility: 'hidden' },
              metadata: {
                subagentMessage: {
                  agentId: 'agent_mock_2',
                  agentType: 'general-purpose',
                },
              },
            },
            parts: [
              {
                type: 'text',
                synthetic: true,
                text:
                  '<subagent-message>\n' +
                  '<agent-id>agent_mock_2</agent-id>\n' +
                  '<agent-type>general-purpose</agent-type>\n' +
                  '<summary>pom.xml 依赖版本分析完成，Spring Cloud 有更新可用</summary>\n' +
                  '<message>分析完成。pom.xml 核心依赖版本情况：\n\n- **Spring Boot 3.5.16** → 已是 3.5.x 最终版本\n- **Spring Cloud 2025.0.0** → 建议升级到 **2025.0.3**\n- **Spring Cloud Alibaba 2025.0.0.0** → 已是最新\n\n其他依赖由 BOM 管理，无需单独处理。</message>\n' +
                  '</subagent-message>',
              },
            ],
          },
          {
            info: {
              role: 'assistant',
              time: { created: Date.now() - 45000, completed: Date.now() - 30000 },
              modelID: 'GLM-5.2',
              providerID: 'anthropic',
              mode: 'yolo',
              tokens: { total: 18035, input: 17634, output: 401, reasoning: 0,
                        cache: { read: 17344, write: 0 } },
              cost: 0.002,
              finish: 'stop',
              id: 'msg_mock_a2',
              sessionID: req.sessionId,
            },
            parts: [
              { type: 'step-start' },
              {
                type: 'reasoning',
                text:
                  '（mock）我已经读了 README，现在整理分析结果。项目结构清晰，分三层：协议层、插件层、UI 层。主要优化点是 UI 的流式渲染性能和 workspace 过滤。' +
                  '流式渲染方面，消息增量推送经过 16ms 节流合并，React 端用 memo 隔离重渲染；' +
                  'workspace 过滤方面，会话列表按项目路径筛选，避免跨项目会话混杂。'.repeat(28),
              },
              {
                type: 'text',
                text: `## 项目结构分析

这是一个**三层架构**的 ZCode IDEA 插件项目：

| 模块 | 职责 | 技术栈 |
|---|---|---|
| \`protocol-client\` | ZCode 协议通信 | Kotlin + ktor |
| \`intellij-plugin\` | IDE 插件主体 | Kotlin + JCEF |
| \`webview\` | 前端 UI | React 19 + Vite |

### 优化建议

1. **流式渲染性能**：用 \`BlockSection\` 逐块 memo，避免整篇重渲染
2. **workspace 过滤**：会话列表按项目路径过滤（cc-gui 没做）
3. **IME 安全**：中文输入时 Enter 发送要做 100ms 防抖

### 关键代码示例

\`\`\`typescript
// 流式 markdown 安全补全
function makeStreamSafe(md: string): string {
  const lines = md.split('\\n')
  let inFence = false
  for (const line of lines) {
    if (line.match(/^\`\`\`/)) inFence = !inFence
  }
  return inFence ? md + '\\n\`\`\`' : md
}
\`\`\`

> **提示**：这段代码会在代码围栏未闭合时自动补全，避免流式渲染闪烁。

构建命令：

\`\`\`bash
cd webview && npm run build:single
\`\`\`

### 架构图（Mermaid 渲染示例）

\`\`\`mermaid
flowchart LR
    A[React webview] -->|JBCefJSQuery| B[JCEF 面板]
    B --> C[ZCodeProtocolClient]
    C -->|stdin/stdout JSON| D[app-server 子进程]
    D --> E[LLM API]
\`\`\`

详细规划见 \`docs/计划与里程碑/UI重构规划.md\`。`,
              },
              { type: 'step-finish', reason: 'stop', cost: 0.002,
                tokens: { total: 18035, input: 17634, output: 401, reasoning: 0,
                          cache: { read: 17344, write: 0 } } },
            ],
          },
        ],
      }
    case 'send':
      return { op: 'sendAccepted', sessionId: req.sessionId, accepted: 'true' }
    case 'getIdeTheme':
      return { op: 'ideTheme', isDark: true }
    case 'createTab':
      // 多标签由 IDE 原生 Content 管理，浏览器 mock 无标签概念
      return { op: 'tabCreating' }
    case 'toggleBrowserPane':
      // 分栏开关由 IDE 侧处理，mock 模式无意义，返回固定态
      return { op: 'browserPaneToggled', visible: false }
    case 'setTabTitle':
      return { op: 'tabTitleSet' }
    case 'appearanceSave':
      // mock 模式 localStorage 即权威源，保存仅回执
      return { op: 'appearanceSave' }
    case 'kvSave':
      return { op: 'kvSave' }
    case 'listFiles':
      return { op: 'files', files: ['README.md', 'package.json', 'src/main.tsx'] }
    case 'listCommands':
      // mock：技能 + 命令混合列表（skill/command 两种 kind）
      return {
        op: 'commands',
        commands: [
          { name: 'code-review', description: '按标准和规格评审代码改动', kind: 'skill', source: 'user' },
          { name: 'git-commit-format', description: '规范化 Git 提交信息格式', kind: 'skill', source: 'user' },
          { name: 'handoff', description: '压缩会话生成交接文档', kind: 'skill', source: 'user' },
          { name: 'research', description: '调研问题并落盘 Markdown 发现', kind: 'skill', source: 'user' },
          { name: 'diagnosing-bugs', description: '硬 bug 与性能回归的诊断循环', kind: 'skill', source: 'user' },
          { name: 'compact', description: '压缩当前会话上下文', kind: 'command', source: 'builtin' },
          { name: 'review:code', description: '评审代码（嵌套目录命令）', kind: 'command', source: 'user' },
        ],
      }
    case 'listMemoryFiles':
      // mock：全局存在 + 项目未创建 + 两条自动记忆（验收三种形态的条目）
      return {
        op: 'memoryFiles',
        files: [
          {
            name: 'AGENTS.md',
            scope: 'global',
            kind: 'instructions',
            path: 'C:\\Users\\mock\\.zcode\\AGENTS.md',
            exists: true,
            sizeBytes: 2048,
            lastModified: Date.now() - 86400_000,
            description: '所有项目的 ZCode 会话自动读取',
          },
          {
            name: 'AGENTS.md',
            scope: 'project',
            kind: 'instructions',
            path: 'G:\\mock\\AGENTS.md',
            exists: false,
            description: '当前项目的 ZCode 会话自动读取',
          },
          {
            name: 'MEMORY.md',
            scope: 'project',
            kind: 'auto',
            path: 'C:\\Users\\mock\\.zcode\\cli\\memories\\projects\\mock-abc123\\memory\\MEMORY.md',
            exists: true,
            sizeBytes: 512,
            lastModified: Date.now() - 3600_000,
            description: '记忆索引（每条记忆一行，指向同目录事实文件）',
          },
          {
            name: 'conversation-search-feature.md',
            scope: 'project',
            kind: 'auto',
            path: 'C:\\Users\\mock\\.zcode\\cli\\memories\\projects\\mock-abc123\\memory\\conversation-search-feature.md',
            exists: true,
            sizeBytes: 1180,
            lastModified: Date.now() - 7200_000,
            description: '自动记忆：用户偏好用 Ctrl+F 做会话内搜索',
          },
        ],
      }
    case 'createMemoryFile':
      return { op: 'memoryFileCreated', path: req.path }
    case 'listSkills':
      // mock：三来源 + 启用/禁用/插件名/whenToUse 各形态（浏览器验收用）
      return {
        op: 'skills',
        skills: [
          { name: 'code-review', description: '按标准和规格评审代码改动', whenToUse: '用户要求 review 变更时', path: 'C:\\Users\\mock\\.zcode\\skills\\code-review\\SKILL.md', directory: 'C:\\Users\\mock\\.zcode\\skills\\code-review', scope: 'user', source: 'zcode', enabled: true },
          { name: 'git-commit-format', description: '规范化 Git 提交信息格式', path: 'C:\\Users\\mock\\.zcode\\skills\\git-commit-format\\SKILL.md', directory: 'C:\\Users\\mock\\.zcode\\skills\\git-commit-format', scope: 'user', source: 'zcode', enabled: false },
          { name: 'deploy-helper', description: '项目部署辅助（mock 项目级技能）', path: 'G:\\mock\\project\\.zcode\\skills\\deploy-helper\\SKILL.md', directory: 'G:\\mock\\project\\.zcode\\skills\\deploy-helper', scope: 'project', source: 'zcode', enabled: true },
          { name: 'control-browser', description: '浏览器自动化主代理技能', path: 'C:\\Users\\mock\\.zcode\\cli\\plugins\\cache\\official\\browser-use\\0.2.1\\skills\\control-browser\\SKILL.md', directory: 'C:\\Users\\mock\\.zcode\\cli\\plugins\\cache\\official\\browser-use\\0.2.1\\skills\\control-browser', scope: 'plugin', source: 'plugin', pluginName: 'browser-use', enabled: true },
        ],
      }
    case 'toggleSkill':
      return { op: 'skillToggled', path: req.path, enabled: req.enabled }
    case 'listMcpServers':
      // mock：stdio/http、connected/failed/disconnected/disabled、runtime 来源各形态
      return {
        op: 'mcpServers',
        mode: req.mode ?? 'status',
        servers: [
          { name: 'context7', scope: 'user', transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'], envKeys: ['DEFAULT_MINIMUM_TOKENS'], enabled: true, configPath: 'C:\\Users\\mock\\.zcode\\cli\\config.json', status: 'connected', toolCount: 2, updatedAt: new Date().toISOString() },
          { name: 'web-reader', scope: 'user', transport: 'http', url: 'https://mcp.example.com/web-reader', enabled: true, configPath: 'C:\\Users\\mock\\.zcode\\cli\\config.json', status: 'failed', toolCount: 0, statusError: 'connect ETIMEDOUT 1.2.3.4:443', updatedAt: new Date().toISOString() },
          { name: 'legacy-search', scope: 'project', transport: 'sse', url: 'https://mcp.example.com/sse', enabled: false, configPath: 'G:\\mock\\project\\zcode.json', status: 'disabled', toolCount: 0, updatedAt: new Date().toISOString() },
          { name: 'browser-tools', scope: 'plugin', transport: 'stdio', command: 'node', args: ['server.js'], enabled: true, configPath: 'C:\\Users\\mock\\.zcode\\cli\\plugins\\cache\\official\\browser-use\\0.2.1\\.mcp.json', pluginName: 'browser-use', status: 'connected', toolCount: 0 },
          { name: 'rpc-count-stale', scope: 'user', transport: 'http', url: 'https://mcp.example.com/stale', enabled: true, configPath: 'C:\\Users\\mock\\.zcode\\cli\\config.json', status: 'connected', toolCount: 0 },
        ],
      }
    case 'mcpServerTools':
      // mock：context7 正常返回；browser-tools 已连接但 0 工具（黄色警告态）；其余报错
      if (req.name === 'context7') {
        return {
          op: 'mcpServerTools',
          name: req.name,
          toolCount: 2,
          tools: [
            { name: 'resolve-library-id', description: '将通用库/框架名称解析为 Context7 兼容的库 ID（支持模糊匹配）' },
            { name: 'get-library-docs', description: '按 Context7 库 ID 拉取最新文档片段，用于回答库/框架使用问题' },
          ],
        }
      }
      if (req.name === 'browser-tools') {
        return { op: 'mcpServerTools', name: req.name, toolCount: 0, tools: [] }
      }
      // RPC toolCount=0 但直连拿到 3 个（验收头部徽章数以直连为准）
      if (req.name === 'rpc-count-stale') {
        return {
          op: 'mcpServerTools',
          name: req.name,
          toolCount: 3,
          tools: [
            { name: 'fetch_page', description: '抓取指定 URL 的页面内容并转为 Markdown' },
            { name: 'search_web', description: '全网搜索，返回带摘要的结果列表。这条描述特别长，用来验收工具详情两行截断 + hover title 看全文的效果，超出部分应该被 line-clamp 裁掉而不撑开布局。' },
            { name: 'read_file', description: '读取服务器侧文件内容' },
          ],
        }
      }
      return { op: 'mcpServerTools', name: req.name, error: 'mock：连接超时（ETIMEDOUT 1.2.3.4:443）' }
    case 'getMcpLogs':
      // mock：完整连接生命周期样例（started→connected / failed 带 stderr / 启动汇总）
      return {
        op: 'mcpLogs',
        logs: [
          { timestamp: new Date(Date.now() - 90_000).toISOString(), level: 'info', event: 'mcp.server.connect.started', serverName: 'context7', message: '开始连接（stdio，超时 600000ms）' },
          { timestamp: new Date(Date.now() - 88_000).toISOString(), level: 'info', event: 'mcp.server.connected', serverName: 'context7', message: '连接成功 · 连接耗时 1520ms · 工具枚举 840ms · 2 个工具', durationMs: 2360 },
          { timestamp: new Date(Date.now() - 60_000).toISOString(), level: 'info', event: 'mcp.server.connect.started', serverName: 'web-reader', message: '开始连接（http，超时 600000ms）' },
          { timestamp: new Date(Date.now() - 57_000).toISOString(), level: 'warn', event: 'mcp.server.failed', serverName: 'web-reader', message: '连接失败 · connect ETIMEDOUT 1.2.3.4:443', durationMs: 3000 },
          { timestamp: new Date(Date.now() - 56_000).toISOString(), level: 'info', event: 'mcp.startup.completed', serverName: '', message: 'MCP 启动完成 · 2 台 · {"connected":1,"failed":1} · 共 2 个工具' },
        ],
      }
    case 'subscribeChild':
      // mock：子会话订阅 ack（无真实事件流，弹窗实时数据走 mock 消息/转发事件）
      return { op: 'subscribedChild', sessionId: req.sessionId }
    default:
      return { op: 'error', message: `mock 不支持 op: ${(req as { op: string }).op}` }
  }
}
