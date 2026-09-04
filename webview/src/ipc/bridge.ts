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

import type { JavaRequest, JavaResponse, StreamEvent, EnvStatus, ZCodeMessage } from '@/types/messages'

/** 仓库地址（「打开仓库」展示/复制/mock 打开共用；生产 openExternal 由 Java 侧
 *  硬编码常量权威决定，不由前端传参——零注入面，改地址须两侧同步）*/
export const GITHUB_REPO_URL = 'https://github.com/csuftt/zcode-jetbrains-plugin'

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
    /** Java 推送环境状态变化的回调（envSave 保存后 IDE 广播多标签同步）*/
    onEnvStatusChanged?: (status: EnvStatus) => void
    /** Java 推送模型 provider 启用/禁用变更的回调（modelToggleProvider 写回后广播多标签同步）*/
    onModelsChanged?: (changes: { providerId: string; enabled: boolean }[]) => void
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

/** 流式通道异常上报（console.error 不被 JCEF 转发，走 __jsLog 进 idea.log）*/
function reportStreamError(channel: string, sessionId: string, type: string, err: unknown) {
  console.error('[bridge] stream listener 抛错', err)
  const w = typeof window === 'undefined' ? undefined : window as unknown as Record<string, unknown>
  if (typeof w?.__ZCODE_CEF_QUERY__ !== 'function' && typeof w?.sendToJava !== 'function') return
  try {
    const text = err instanceof Error ? `${err.name}: ${err.message}\n${String(err.stack ?? '').slice(0, 400)}` : String(err).slice(0, 200)
    sendToJava({ op: '__jsLog', level: 'warn', text: `[stream-err] ${channel} sid=${sessionId.slice(-8)} type=${type} ${text}` })
  } catch { /* 上报不设障 */ }
}

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
  // 全局异常钩子（子会话实时流停更追查）：console.error 不被 JCEF 转发，
  // 未捕获异常默认无迹可寻——转发到 idea.log（__jsLog 通道）
  if (!(window as unknown as { __zcodeErrHooked?: boolean }).__zcodeErrHooked) {
    ;(window as unknown as { __zcodeErrHooked?: boolean }).__zcodeErrHooked = true
    const report = (label: string, e: unknown) => {
      try {
        const text = e instanceof Error ? `${e.name}: ${e.message}\n${String(e.stack ?? '').slice(0, 500)}` : String(e).slice(0, 300)
        sendToJava({ op: '__jsLog', level: 'warn', text: `[webview-error] ${label} ${text}` })
      } catch { /* 钩子自身不设障 */ }
    }
    window.addEventListener('error', (ev) => report('uncaught', ev.error ?? ev.message))
    window.addEventListener('unhandledrejection', (ev) => report('rejection', ev.reason))
  }
  window.zcodeBridge = {
    onMessage: (raw: unknown) => {
      let msg: JavaResponse
      try {
        msg = (typeof raw === 'string' ? JSON.parse(raw) : raw) as JavaResponse
      } catch (e) {
        console.error('[bridge] onMessage 解析失败', e, raw)
        return
      }
      // 诊断：addDiag 进内存环形缓冲（生产保留，getDiagLog 可导出排查流问题）；
      // console 输出仅 dev——JCEF 不转发 console（实测定论），生产打印无落点还白做
      // 每批次的事件类型数组拼接（流式期间每 16ms 一批），用 DEV 分支让构建裁掉
      if (msg.op === 'streamEvent') {
        const kind = 'kind' in msg.event.payload ? msg.event.payload.kind : ''
        addDiag('streamEvent', `${msg.event.type} ${kind}`)
        if (import.meta.env.DEV) console.log('[bridge] ← streamEvent', msg.event.type, kind)
      } else if (msg.op === 'streamBatch') {
        if (import.meta.env.DEV) {
          const types = msg.events.map((e) => e.type + ('kind' in e.payload ? `(${e.payload.kind})` : ''))
          addDiag('streamBatch', `${msg.events.length}条: ${types.slice(0, 5).join(',')}`)
          console.log('[bridge] ← streamBatch', msg.events.length, 'events:', types.join(','))
        } else {
          addDiag('streamBatch', `${msg.events.length}条`)
        }
      } else {
        addDiag(msg.op, '')
        if (import.meta.env.DEV) console.log('[bridge] ←', msg.op)
      }
      // 流式事件走独立通道（单个或批量）
      if (msg.op === 'streamEvent') {
        streamListeners.forEach((fn) => {
          try {
            fn(msg.sessionId, msg.event)
          } catch (err) {
            reportStreamError('streamEvent', msg.sessionId, msg.event.type, err)
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
              reportStreamError('streamBatch', msg.sessionId, msg.events.map((e) => e.type).slice(0, 5).join(','), err)
            }
          })
        } else {
          // 兜底：没有 batch 监听器时逐个推
          for (const evt of msg.events) {
            streamListeners.forEach((fn) => {
              try { fn(msg.sessionId, evt) } catch (err) { reportStreamError('streamEvent-fallback', msg.sessionId, evt.type, err) }
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

/** 外链协议白名单（与 Java 端 handleOpenExternal 同口径）：非 http(s) 一律拒绝，
 *  防 file:/javascript: 等注入面（markdown/搜索结果里的链接不可信）*/
const EXTERNAL_URL_SAFE = /^https?:\/\//i

/**
 * 调系统浏览器打开外部网页（网页工具卡 🌐 按钮、WebSearch 来源条目、markdown 链接点击）。
 * 前端先过协议白名单，Java 侧二次校验后 BrowserUtil.browse。
 */
export function openExternalUrl(url: string): void {
  const trimmed = url.trim()
  if (!EXTERNAL_URL_SAFE.test(trimmed)) return
  sendToJava({ op: 'openExternal', url: trimmed })
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

// #longuser 演示开关：send "#longuser" 置位后，messages 响应追加长用户消息
let mockLongUserDemo = false
let mockCompactDemo = false

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

// 已归档会话 mock（回收站视图验收用）
const mockArchivedSessions = [
  {
    sessionId: 'sess_mock_archived_1',
    title: '（mock·已归档）旧版本登录模块重构',
    status: 'idle',
    mode: 'build',
    workspacePath: 'G:\\mock',
    workspaceKey: 'G:\\mock',
    createdAt: Date.now() - 10 * 86400_000,
    updatedAt: Date.now() - 9 * 86400_000,
    archivedAt: Date.now() - 8 * 86400_000,
  },
  {
    sessionId: 'sess_mock_archived_2',
    title: '（mock·已归档）数据库连接池调参',
    status: 'idle',
    mode: 'yolo',
    workspacePath: 'G:\\mock',
    workspaceKey: 'G:\\mock',
    createdAt: Date.now() - 20 * 86400_000,
    updatedAt: Date.now() - 19 * 86400_000,
    archivedAt: Date.now() - 18 * 86400_000,
  },
]

function mockRespond(req: JavaRequest): void {
  console.log('[bridge:mock] 收到请求', req.op)

  // send 文本 "#plan"：模拟 plan 模式下 ExitPlanMode 审批弹窗（验收 PlanApprovalDialog）
  if (req.op === 'send' && req.text.trim() === '#plan') {
    setTimeout(() => {
      listeners.forEach((fn) =>
        fn({
          op: 'exitPlanApproval',
          requestId: `mock_plan_${Date.now()}`,
          plan: '## 实施计划（mock）\n\n1. 第一步：读取配置文件\n2. 第二步：修改 provider 节点\n3. 第三步：验证并提交',
        }),
      )
    }, 300)
    return
  }

  // send 文本 "#fail"：模拟 turn.failed（验收失败回合的顶栏错误提示）
  if (req.op === 'send' && req.text.trim() === '#fail') {
    const turnId = `turn_fail_${Date.now()}`
    const mk = (type: string, payload: Record<string, unknown>) =>
      ({ type, seq: 0, sessionId: req.sessionId, turnId, timestamp: Date.now(), payload })
    setTimeout(() => {
      streamListeners.forEach((fn) => fn(req.sessionId, mk('turn.started', { turnNumber: 1, messageId: `msg_fail_${Date.now()}` }) as unknown as StreamEvent))
    }, 300)
    setTimeout(() => {
      streamListeners.forEach((fn) => fn(req.sessionId, mk('turn.failed', {
        error: { type: 'api_error', code: 'internal_error', message: 'Error code: 500 - {\'error\': {\'message\': \'mock 内部错误\'}}' },
      }) as unknown as StreamEvent))
    }, 900)
    return
  }

  // send 文本 "#quota"：模拟 429 配额超限（stderr 兜底通道 backendError + turn 持续重试不终止，
  // 验收"转圈中顶栏出现配额提示"）
  if (req.op === 'send' && req.text.trim() === '#quota') {
    const turnId = `turn_quota_${Date.now()}`
    setTimeout(() => {
      streamListeners.forEach((fn) => fn(req.sessionId, {
        type: 'turn.started', seq: 0, sessionId: req.sessionId, turnId, timestamp: Date.now(),
        payload: { turnNumber: 1, messageId: `msg_quota_${Date.now()}` },
      } as unknown as StreamEvent))
    }, 300)
    setTimeout(() => {
      listeners.forEach((fn) => fn({
        op: 'backendError',
        statusCode: 429,
        code: 'token_quota_exceeded',
        message: 'Token Plan Person monthly quota limit exceeded',
      }))
    }, 900)
    // 不推 turn.failed：模拟 app-server 对 429 按可重试分类持续退避（转圈不停止）
    return
  }

  // send 文本 "#write"：模拟大文件 Write 的工具输入流（tool_input_start/delta → tool_call），
  // 验收"正在写入 + 已生成 N 行"实时累计、尾部预览与完成态衔接
  if (req.op === 'send' && req.text.trim() === '#write') {
    const turnId = `turn_write_${Date.now()}`
    const msgId = `msg_write_${Date.now()}`
    const callId = `call_write_${Date.now()}`
    let seq = 0
    const push = (type: string, payload: Record<string, unknown>) => {
      streamListeners.forEach((fn) =>
        fn(req.sessionId, { type, seq: seq++, sessionId: req.sessionId, turnId, timestamp: Date.now(), payload } as unknown as StreamEvent))
    }
    const fileContent = `${Array.from({ length: 60 }, (_, i) =>
      i % 2 === 0
        ? `// 第 ${i + 1} 行：示例模块代码（流式写入演示）`
        : `const value${i + 1} = compute(${i + 1}); // 计算第 ${i + 1} 个值`,
    ).join('\n')}\n`
    const fullJson = JSON.stringify({ content: fileContent, file_path: 'src/demo/LargeModule.ts' })
    // 真实行为（[tis] 诊断实测）：delta 被 zcode.cjs 聚合成大块一次性下发，
    // 流式窗口约 1 秒内完成——前端靠渐进揭示回放呈现累计动画
    setTimeout(() => push('turn.started', { turnNumber: 1, messageId: msgId }), 200)
    setTimeout(() => push('model.streaming', { kind: 'tool_input_start', toolCallId: callId, toolName: 'Write' }), 500)
    setTimeout(() => push('model.streaming', { kind: 'tool_input_delta', toolCallId: callId, delta: fullJson }), 1100)
    const doneAt = 2600
    setTimeout(() => push('model.streaming', {
      kind: 'tool_call', toolCallId: callId, toolName: 'Write',
      input: { file_path: 'src/demo/LargeModule.ts', content: fileContent },
    }), doneAt)
    setTimeout(() => push('tool.updated', { kind: 'started', toolCallId: callId, toolName: 'Write', startedAt: Date.now() }), doneAt + 100)
    setTimeout(() => push('tool.updated', {
      kind: 'result', toolCallId: callId, toolName: 'Write',
      result: { success: true, content: '已写入 60 行（mock）' },
    }), doneAt + 400)
    setTimeout(() => push('turn.completed', { response: '大文件写入演示完成' }), doneAt + 600)
    return
  }

  // send 文本 "#batch"：模拟连续两个 Write（diag-batch-write-stream.py 抓包同构序列：
  // 每工具独立 assistantMessageId、第二个工具无 text/reasoning 前导），
  // 验收组卡流式行数累计（第二个工具写入期间组内行应实时累计）
  if (req.op === 'send' && req.text.trim() === '#batch') {
    const turnId = `turn_batch_${Date.now()}`
    let seq = 0
    const push = (type: string, payload: Record<string, unknown>) => {
      streamListeners.forEach((fn) =>
        fn(req.sessionId, { type, seq: seq++, sessionId: req.sessionId, turnId, timestamp: Date.now(), payload } as unknown as StreamEvent))
    }
    const fileA = `${Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0 ? `// 文件A 第 ${i + 1} 行` : `const a${i + 1} = ${i + 1};`).join('\n')}\n`
    const fileB = `${Array.from({ length: 35 }, (_, i) =>
      i % 2 === 0 ? `// 文件B 第 ${i + 1} 行` : `const b${i + 1} = ${i + 1};`).join('\n')}\n`
    const m1 = `msg_batch_m1_${Date.now()}`
    const m2 = `msg_batch_m2_${Date.now()}`
    const callA = `call_batch_a_${Date.now()}`
    const callB = `call_batch_b_${Date.now()}`
    const streamTool = (msgId: string, callId: string, file: string, path: string, t0: number) => {
      const fullJson = JSON.stringify({ content: file, file_path: path })
      setTimeout(() => push('model.streaming', { kind: 'tool_input_start', toolCallId: callId, toolName: 'Write', assistantMessageId: msgId }), t0)
      // 大块聚合 delta（真实形态）：start 后 0.6s 整块到达
      setTimeout(() => push('model.streaming', { kind: 'tool_input_delta', toolCallId: callId, delta: fullJson, assistantMessageId: msgId }), t0 + 600)
      const done = t0 + 700
      setTimeout(() => push('model.streaming', { kind: 'tool_input_end', toolCallId: callId, assistantMessageId: msgId }), done)
      setTimeout(() => push('model.streaming', {
        kind: 'tool_call', toolCallId: callId, toolName: 'Write', assistantMessageId: msgId,
        input: { file_path: path, content: file },
      }), done + 50)
      setTimeout(() => push('tool.updated', { kind: 'scheduled', toolCallId: callId, toolName: 'Write', inputOmitted: true }), done + 150)
      setTimeout(() => push('tool.updated', { kind: 'started', toolCallId: callId, toolName: 'Write' }), done + 250)
      setTimeout(() => push('tool.updated', {
        kind: 'result', toolCallId: callId,
        result: { success: true, content: 'done (mock)' },
      }), done + 500)
      setTimeout(() => push('tool.updated', { kind: 'batch', toolCallIds: [callId], successCount: 1, errorCount: 0 }), done + 550)
      return done + 600
    }
    setTimeout(() => push('turn.started', { turnNumber: 1, messageId: m1 }), 200)
    // 第一轮：短思考 + 工具A（挂 m1）
    setTimeout(() => push('model.streaming', { kind: 'reasoning_delta', delta: '准备写入文件A。', assistantMessageId: m1 }), 400)
    const tA = 500
    const doneA = streamTool(m1, callA, fileA, 'src/demo/BatchFileA.ts', tA)
    // 第二轮：GLM-5.3 真实序列——工具B前有思考（m2），随后 tool_input_start(m2)；
    // 前端 streamingMessageId 不随 assistantMessageId 切换，全部落同一流式消息
    const tThink = doneA + 100
    setTimeout(() => push('model.streaming', { kind: 'reasoning_delta', delta: '文件A写完，接下来准备文件B的内容，直接连续调用工具。', assistantMessageId: m2 }), tThink)
    setTimeout(() => push('model.streaming', { kind: 'reasoning_delta', delta: '保持两次写入之间无正文输出。', assistantMessageId: m2 }), tThink + 150)
    const doneB = streamTool(m2, callB, fileB, 'src/demo/BatchFileB.ts', doneA + 300)
    setTimeout(() => push('model.streaming', { kind: 'text_delta', delta: '两个文件已写入（mock）。', assistantMessageId: m2 }), doneB + 200)
    setTimeout(() => push('turn.completed', { response: 'ok' }), doneB + 400)
    return
  }

  // send 文本 "#web"：模拟 WebSearch + WebFetch（含 404 错误形态），验收网页工具卡
  //（头部 🌐/📖 按钮、来源链接列表、无链接回退预览、弹窗全文渲染）
  if (req.op === 'send' && req.text.trim() === '#web') {
    const turnId = `turn_web_${Date.now()}`
    const m1 = `msg_web_m1_${Date.now()}`
    let seq = 0
    const push = (type: string, payload: Record<string, unknown>) => {
      streamListeners.forEach((fn) =>
        fn(req.sessionId, { type, seq: seq++, sessionId: req.sessionId, turnId, timestamp: Date.now(), payload } as unknown as StreamEvent))
    }
    const runTool = (
      msgId: string, callId: string, toolName: string,
      input: Record<string, unknown>, resultContent: string, t0: number,
    ) => {
      const fullJson = JSON.stringify(input)
      setTimeout(() => push('model.streaming', { kind: 'tool_input_start', toolCallId: callId, toolName, assistantMessageId: msgId }), t0)
      setTimeout(() => push('model.streaming', { kind: 'tool_input_delta', toolCallId: callId, delta: fullJson, assistantMessageId: msgId }), t0 + 400)
      setTimeout(() => push('model.streaming', { kind: 'tool_call', toolCallId: callId, toolName, assistantMessageId: msgId, input }), t0 + 700)
      setTimeout(() => push('tool.updated', { kind: 'started', toolCallId: callId, toolName }), t0 + 800)
      setTimeout(() => push('tool.updated', {
        kind: 'result', toolCallId: callId,
        result: { success: true, content: resultContent },
      }), t0 + 1600)
      return t0 + 1700
    }
    // 真实形态输出（rollout 实抓同构）：上游 trace 转储 + 整理后结果列表 + Sources
    const searchOut = [
      'Web search results for query: "IntelliJ JCEF plugin open external link"',
      '',
      'Summary:',
      '**🌐 Z.ai Built-in Tool: web_search_prime**',
      '',
      '**Input:**',
      '```json',
      '{"content_size":"medium","location":"cn","search_query":"IntelliJ JCEF plugin open external link"}',
      '```',
      '*Executing on server...*',
      '',
      'Here are the search results for your query:',
      '',
      '1. **[Plugin implemented using JCEF API - How to open hyperlinks in an external browser](https://intellij-support.jetbrains.com/hc/en-us/community/posts/360009678839)** (JetBrains Support)',
      '   - A developer with a JCEF-based plugin asks how to open hyperlinks in an external browser.',
      '',
      '2. **[Embedded Browser (JCEF) | IntelliJ Platform Plugin SDK](https://plugins.jetbrains.com/docs/intellij/embedded-browser-jcef.html)** (Official Docs)',
      '   - Covers intercepting navigation via CefDisplayHandler.onAddressChange().',
      '',
      '3. **[JCEF reference guide (jcef.md) on GitHub](https://github.com/hltj/intellij/blob/master/reference_guide/jcef.md?plain=1)**',
      '',
      'Sources:',
      '- [Embedded Browser (JCEF)](https://plugins.jetbrains.com/docs/intellij/embedded-browser-jcef.html)',
      '- [JetBrains Support](https://intellij-support.jetbrains.com/hc/en-us/community/posts/360009678839)',
    ].join('\n')
    const fetchOut = [
      '## 直接回答',
      '',
      '**没有**。该指南中不存在任何禁止插件在其自身 UI 内打开外部网站的条款。',
      '',
      '相关条款（针对 Marketplace 页面，非插件 UI）：',
      '- 1.7 外链须有效且与插件相关',
      '- 3.3 开源插件须提供源码链接',
      '',
      '详见 [审核指南](https://plugins.jetbrains.com/docs/marketplace/jetbrains-marketplace-approval-guidelines.html)。',
    ].join('\n')
    const fetchErr = 'The server returned HTTP 404 Not Found.\n\nThe response body was not retrieved. If this URL requires authentication, use an authenticated MCP tool or `gh` for GitHub instead of WebFetch.'
    const c1 = `call_web_search_${Date.now()}`
    const c2 = `call_web_fetch_${Date.now()}`
    const c3 = `call_web_404_${Date.now()}`
    const c4 = `call_web_search_empty_${Date.now()}`
    setTimeout(() => push('turn.started', { turnNumber: 1, messageId: m1 }), 200)
    setTimeout(() => push('model.streaming', { kind: 'reasoning_delta', delta: '需要先搜索再抓取文档确认。', assistantMessageId: m1 }), 400)
    const d1 = runTool(m1, c1, 'WebSearch', { query: 'IntelliJ JCEF plugin open external link' }, searchOut, 600)
    setTimeout(() => push('model.streaming', { kind: 'reasoning_delta', delta: '找到官方文档了，抓取全文。', assistantMessageId: m1 }), d1 + 100)
    const d2 = runTool(m1, c2, 'WebFetch', {
      url: 'https://plugins.jetbrains.com/docs/marketplace/jetbrains-marketplace-approval-guidelines.html',
      prompt: '有没有禁止插件 UI 内打开外部链接的条款？',
    }, fetchOut, d1 + 300)
    const d3 = runTool(m1, c3, 'WebFetch', {
      url: 'https://plugins.jetbrains.com/docs/marketplace/plugins-guidelines.html',
      prompt: '检查这个页面的条款。',
    }, fetchErr, d2 + 300)
    // 无来源回退态：搜索输出无 markdown 链接（提取 0 条 → 3 行短预览兜底）
    const d4 = runTool(m1, c4, 'WebSearch', { query: '一个必然没有结果演示的查询词' },
      'Web search results for query: "一个必然没有结果演示的查询词"\n\nNo results found.\nTry different keywords.', d3 + 300)
    setTimeout(() => push('model.streaming', { kind: 'text_delta', delta: '搜索与抓取完成（mock）：来源列表可点击、📖 弹窗可读全文。', assistantMessageId: m1 }), d4 + 200)
    // completed 相对 result 多留 1.5s：给 dev 浏览器验收留出展开查看窗口
    //（mock 环境回合完成后流式消息即被重置，窗口太窄没法看完成态卡片）
    setTimeout(() => push('turn.completed', { response: 'ok' }), d4 + 1700)
    return
  }

  // send 文本 "#compactdemo"：模拟 /compact 压缩完成场景——回合结束后重拉历史时
  // 注入时间线分隔卡 + 压缩摘要消息，验收摘要卡书本图标 + 弹窗全文形态
  if (req.op === 'send' && req.text.trim() === '#compactdemo') {
    mockCompactDemo = true
    const turnId = `turn_compact_${Date.now()}`
    const msgId = `msg_compact_${Date.now()}`
    let seq = 0
    const push = (type: string, payload: Record<string, unknown>) => {
      streamListeners.forEach((fn) =>
        fn(req.sessionId, { type, seq: seq++, sessionId: req.sessionId, turnId, timestamp: Date.now(), payload } as unknown as StreamEvent))
    }
    setTimeout(() => push('turn.started', { turnNumber: 1, messageId: msgId }), 150)
    setTimeout(() => push('model.streaming', { kind: 'text_delta', delta: '上下文已压缩（mock）。', assistantMessageId: msgId }), 400)
    setTimeout(() => push('turn.completed', { response: 'ok' }), 600)
    return
  }

  // send 文本 "#longuser"：模拟"用户粘贴大段内容"场景——回合结束后重拉历史时
  // 注入一条长用户消息（45 行），验收聊天区长用户消息默认折叠 + 弹窗全文
  if (req.op === 'send' && req.text.trim() === '#longuser') {
    mockLongUserDemo = true
    const turnId = `turn_longuser_${Date.now()}`
    const msgId = `msg_longuser_${Date.now()}`
    let seq = 0
    const push = (type: string, payload: Record<string, unknown>) => {
      streamListeners.forEach((fn) =>
        fn(req.sessionId, { type, seq: seq++, sessionId: req.sessionId, turnId, timestamp: Date.now(), payload } as unknown as StreamEvent))
    }
    setTimeout(() => push('turn.started', { turnNumber: 1, messageId: msgId }), 150)
    setTimeout(() => push('model.streaming', { kind: 'text_delta', delta: '收到，内容已展开确认（mock）。', assistantMessageId: msgId }), 400)
    setTimeout(() => push('turn.completed', { response: 'ok' }), 600)
    return
  }

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

/** 模型管理 mock 状态（可变）：模拟 config.json 的 provider 注册表，切换写回后就地翻转 enabled */
let _mockProviders: import('../types/messages').ModelManageProvider[] | null = null
function mockModelProviders(): import('../types/messages').ModelManageProvider[] {
  if (!_mockProviders) {
    _mockProviders = [
      {
        providerId: 'builtin:bigmodel-coding-plan',
        providerName: 'BigModel - Coding Plan',
        plan: 'personal',
        via: 'selected',
        baseURL: 'https://open.bigmodel.cn/api/anthropic',
        enabled: true,
        models: [
          { modelId: 'GLM-5.3', modelName: 'GLM-5.3', contextWindow: 1000000, maxOutput: 128000 },
          { modelId: 'GLM-5-Turbo', modelName: 'glm-5-turbo', contextWindow: 204800, maxOutput: 128000 },
        ],
      },
      {
        providerId: 'builtin:bigmodel-start-plan',
        providerName: 'BigModel - Coding Plan',
        plan: 'trial',
        baseURL: 'https://zcode.z.ai/api/v1/zcode-plan/anthropic',
        enabled: false,
        models: [
          { modelId: 'glm-5.3', modelName: 'glm-5.3', contextWindow: 1000000, maxOutput: 128000 },
          { modelId: 'glm-5-turbo', modelName: 'glm-5-turbo', contextWindow: 204800, maxOutput: 128000 },
        ],
      },
      {
        providerId: '27d2ecde-5da2-43bd-b2d8-dae985bfaf8f',
        providerName: 'DeepSeek',
        baseURL: 'https://api.deepseek.com/anthropic',
        enabled: true,
        models: [
          { modelId: 'deepseek-v4-flash', modelName: 'deepseek-v4-flash', contextWindow: 1000000, maxOutput: 384000 },
        ],
      },
    ]
  }
  return _mockProviders
}

function mockResponse(req: JavaRequest): JavaResponse | null {
  switch (req.op) {
    case 'listSessions':
      return { op: 'listSessions', sessions: mockSessions }
    case 'listArchivedSessions':
      return { op: 'archivedSessions', sessions: mockArchivedSessions }
    case 'archiveSession':
      return { op: 'sessionArchived', sessionId: req.sessionId }
    case 'restoreSession':
      return { op: 'sessionRestored', sessionId: req.sessionId }
    case 'locateSession':
      // mock：固定无宿主标签，让「覆盖当前标签页 / 新标签页打开」弹窗在 dev 可验收
      return { op: 'sessionTabLocated', sessionId: req.sessionId, found: false }
    case 'copyImage':
      // mock：模拟 Java 系统剪贴板写入成功
      return { op: 'imageCopied', ok: true }
    case 'openExternal':
      // mock：生产走 Java BrowserUtil 调系统浏览器，dev 浏览器环境退化为新标签页打开
      window.open(req.url || GITHUB_REPO_URL, '_blank')
      return { op: 'externalOpened' }
    case 'listModels':
      // 模拟 ~/.zcode/v2/config.json 的 provider 注册表（验收模型下拉用；内置套餐带 plan 标记；
      // limit.context/output 与生产 handleListModels 同口径，悬停 tooltip 可验上下文窗口行）
      return {
        op: 'models',
        models: [
          { providerId: 'builtin:bigmodel-coding-plan', providerName: 'BigModel - Coding Plan', plan: 'personal', modelId: 'GLM-5.3', modelName: 'GLM-5.3', contextWindow: 1000000, maxOutput: 128000 },
          { providerId: 'builtin:bigmodel-coding-plan', providerName: 'BigModel - Coding Plan', plan: 'personal', modelId: 'GLM-5-Turbo', modelName: 'glm-5-turbo', contextWindow: 204800, maxOutput: 128000 },
          { providerId: 'builtin:bigmodel-start-plan', providerName: 'BigModel - Coding Plan', plan: 'trial', modelId: 'glm-5.3', modelName: 'glm-5.3', contextWindow: 1000000, maxOutput: 128000 },
          { providerId: '27d2ecde-5da2-43bd-b2d8-dae985bfaf8f', providerName: 'DeepSeek', modelId: 'deepseek-v4-flash', modelName: 'deepseek-v4-flash', contextWindow: 1000000, maxOutput: 384000 },
        ],
      }
    case 'modelToggleProvider': {
      // mock：与生产同口径——内置渠道只读（启停以 ZCode 客户端为准），拒绝写回；
      // 第三方/自定义就地翻转（模拟 config.json 写回后的读取结果）
      if (req.providerId.startsWith('builtin:')) {
        return { op: 'error', message: '内置渠道以 ZCode 客户端配置为准，请在客户端切换后回来刷新' }
      }
      const changes: { providerId: string; enabled: boolean }[] = [
        { providerId: req.providerId, enabled: req.enabled },
      ]
      mockModelProviders().forEach((p) => {
        const c = changes.find((x) => x.providerId === p.providerId)
        if (c) p.enabled = c.enabled
      })
      return { op: 'modelToggled', changes }
    }
    case 'modelManageList':
      // 模拟设置页「模型管理」结构（与生产同口径：内置渠道只返回生效的，第三方含
      // disabled 标记；mockModelProviders 可变，第三方切换写回后重新读取反映变更）
      return {
        op: 'modelManage',
        configPath: 'C:\\Users\\dev\\.zcode\\v2\\config.json',
        providers: JSON.parse(
          JSON.stringify(mockModelProviders().filter((p) => !p.providerId.startsWith('builtin:') || p.enabled)),
        ),
      }
    case 'getUsage':
      // mock：27.9% 上下文使用率（与真实场景接近）
      return { op: 'usage', sessionId: req.sessionId, used: 278937, size: 1000000, hitRate: 0.988 }
    case 'getQuota':
      // mock：额度数据（5小时 86% / 每周 64%）；provider* 模拟订阅渠道凭证提示
      return {
        op: 'quota',
        providerId: 'builtin:bigmodel-coding-plan',
        providerName: 'BigModel - Coding Plan',
        data: {
          level: 'Max',
          limits: [
            { type: 'TOKENS_LIMIT', unit: 3, percentage: 86, currentValue: 430000, usage: 500000, nextResetTime: Date.now() + 3 * 3600 * 1000 },
            { type: 'TOKENS_LIMIT', unit: 6, percentage: 64, currentValue: 1280000, usage: 2000000, nextResetTime: Date.now() + 5 * 24 * 3600 * 1000 },
          ],
        },
      }
    case 'getAppUsage': {
      // mock：应用用量（usage/stats 本地聚合；含第三方模型，验证徽章与曲线对齐）
      return {
        op: 'appUsage',
        data: {
          range: req.range,
          source: 'agent-db',
          generatedAt: Date.now(),
          summary: {
            totalTokens: 2856000, inputTokens: 2712000, outputTokens: 144000,
            cacheHitRate: 0.962, totalSessions: 18, totalTurns: 142,
            toolCallCount: 556, activeDays: 7,
          },
          models: [
            { modelId: 'GLM-5.2', totalTokens: 1980000, inputTokens: 1880000, outputTokens: 100000, requestCount: 96, share: 0.693 },
            { modelId: 'deepseek-v4-flash', totalTokens: 876000, inputTokens: 832000, outputTokens: 44000, requestCount: 46, share: 0.307 },
          ],
          tools: [
            { toolName: 'Bash', callCount: 148, errorCount: 3, errorRate: 0.02 },
            { toolName: 'Read', callCount: 312, errorCount: 0, errorRate: 0 },
            { toolName: 'Edit', callCount: 96, errorCount: 2, errorRate: 0.021 },
          ],
          dailyModelUsage: [
            { date: '2026-08-21', models: [{ modelId: 'GLM-5.2', totalTokens: 420000 }, { modelId: 'deepseek-v4-flash', totalTokens: 130000 }] },
            { date: '2026-08-22', models: [{ modelId: 'GLM-5.2', totalTokens: 510000 }] },
            { date: '2026-08-23', models: [{ modelId: 'GLM-5.2', totalTokens: 380000 }, { modelId: 'deepseek-v4-flash', totalTokens: 260000 }] },
            { date: '2026-08-24', models: [{ modelId: 'GLM-5.2', totalTokens: 670000 }, { modelId: 'deepseek-v4-flash', totalTokens: 486000 }] },
          ],
        },
      }
    }
    case 'getModelUsage': {
      // mock：模型用量曲线（2 模型 × 8 时间点）
      const xt = ['2026-08-13 09:00', '2026-08-13 12:00', '2026-08-13 15:00', '2026-08-13 18:00', '2026-08-13 21:00', '2026-08-14 00:00', '2026-08-14 09:00', '2026-08-14 12:00']
      return {
        op: 'modelUsage',
        providerId: 'builtin:bigmodel-coding-plan',
        providerName: 'BigModel - Coding Plan',
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
        providerId: 'builtin:bigmodel-coding-plan',
        providerName: 'BigModel - Coding Plan',
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
    case 'cancelModelSwitch':
      // mock：回取消回执（本地状态已先行清理）
      return { op: 'modelSwitchCancelled', sessionId: req.sessionId }
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
    case 'goalManage':
      // mock：show 回 active 目标全量；clear 回无 target；其余动作状态翻转
      if (req.action === 'show' || req.action === 'set' || req.action === 'replace' || req.action === 'pause' || req.action === 'resume') {
        return {
          op: 'goalManaged', sessionId: req.sessionId, action: req.action,
          target: {
            targetID: 'target_mock', objective: 'mock：把登录页重构为组合式 API 并保持测试通过',
            status: req.action === 'pause' ? 'paused' : 'active', tokensUsed: 18320, timeUsedSeconds: 96, tokenBudget: null,
          },
          goalStats: { iterationCount: 2, tokensUsed: 18320, timeUsedSeconds: 96, tokenBudget: null, contextUsed: 18320, contextWindow: 1000000, toolCallCount: 7 },
        } as any
      }
      return { op: 'goalManaged', sessionId: req.sessionId, action: req.action } as any
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
    case 'messages': {
      const mockMessages: ZCodeMessage[] = [
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
      ]
      // #longuser 演示：注入"用户粘贴大段内容"的长用户消息 + 简短回复，
      // 验收聊天区长用户消息默认折叠 + 查看全文弹窗
      if (mockLongUserDemo) {
        const longPasted = [
          '下面是我们生产环境的部署配置和报错日志，帮我分析一下：',
          '',
          '=== application.yml（生产）===',
          ...Array.from({ length: 18 }, (_, i) =>
            `server:\n  port: 808${i % 10}\nspring:\n  application:\n    name: order-service-${i + 1}`),
          '',
          '=== 报错日志（最近 30 分钟）===',
          ...Array.from({ length: 12 }, (_, i) =>
            `2026-08-22 10:${String(i + 10).padStart(2, '0')}:33 WARN  [order-service] Retry attempt ${i + 1} failed: connect timeout to nacos:8848`),
          '',
          '=== 问题 ===',
          '1. 为什么 Nacos 连接一直超时？',
          '2. 配置里有没有明显的坑？',
        ].join('\n')
        mockMessages.push(
          {
            info: {
              role: 'user',
              time: { created: Date.now() - 5000 },
              id: 'msg_mock_longuser',
              sessionID: req.sessionId,
            },
            parts: [{ type: 'text', text: longPasted }],
          },
          {
            info: {
              role: 'assistant',
              time: { created: Date.now() - 4500, completed: Date.now() - 3000 },
              modelID: 'GLM-5.2',
              providerID: 'anthropic',
              id: 'msg_mock_longuser_a',
              sessionID: req.sessionId,
            },
            parts: [
              { type: 'step-start' },
              { type: 'text', text: '已收到完整配置与日志（mock）。从粘贴内容看，Nacos 超时大概率是网络段不通或 namespace 未配置，详见上文分析。' },
              { type: 'step-finish', reason: 'stop', cost: 0.001, tokens: { total: 8100, input: 8000, output: 100, reasoning: 0 } },
            ],
          },
        )
      }
      // #compactdemo 演示：注入压缩 marker 分隔卡 + 压缩摘要消息
      //（结构同 compact-render.spec.tsx 的 RPC 实测样例），验收弹窗全文形态
      if (mockCompactDemo) {
        const compactAt = Date.now() - 20000
        mockMessages.push(
          {
            info: {
              role: 'assistant',
              time: { created: compactAt - 500, completed: compactAt },
              semantics: { origin: 'system', kind: 'timeline_event', uiVisibility: 'visible' },
              id: 'msg_mock_compact_marker',
              sessionID: req.sessionId,
            },
            parts: [
              { type: 'timeline', timelineType: 'context_compaction', display: 'separator', status: 'completed', preCompactTokenCount: 287247, truePostCompactTokenCount: 15751 },
              { type: 'compaction', auto: false, trigger: 'manual' },
            ],
          },
          {
            info: {
              role: 'user',
              time: { created: compactAt },
              id: 'msg_mock_compact_summary',
              sessionID: req.sessionId,
              summary: {
                title: 'Compact summary',
                body: [
                  '## 会话摘要',
                  '',
                  '本段对话完成了 ZC-GUI 0.2.3 迭代的两项主功能：',
                  '',
                  '1. **提示词润色**：输入框发送按钮左侧新增润色按钮，调用当前模型生成增强版提示词，对比弹窗确认后回填。',
                  '2. **子智能体配置**：设置页新增子智能体管理（用户/项目两级作用域），与 ZCode 客户端 `~/.zcode/agents/` 数据互通；发送时经输入框顶部选择器指定子代理，消息自动加 `@name` 前缀。',
                  '',
                  '### 遗留事项',
                  '',
                  '- Mac 平台 Node 自动探测待真机验证',
                  '- 第三方 provider 窗口虚报问题（autocompact 报错）持续观察',
                ].join('\n'),
              },
            },
            parts: [
              { type: 'text', text: 'This session is being continued from a previous conversation…', synthetic: true },
              { type: 'compaction', auto: false, trigger: 'manual', compactBoundary: { summarizedMessageCount: 473, keptMessageCount: 0 } },
            ],
          },
        )
      }
      return { op: 'messages', sessionId: req.sessionId, messages: mockMessages }
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
    case 'askUserResponse':
      // mock：无服务端可应答，仅回执关闭弹窗
      return { op: 'askUserAck' }
    case 'checkEnv':
    case 'envSave':
      // mock：环境恒健康（dev 浏览器无 IDE 侧检测；banner UI 验收可临时改 allOk 为 false）
      return {
        op: 'envStatus',
        status: {
          node: { configured: false, path: '/usr/local/bin/node', found: true, version: 'v20.11.1', versionTooLow: false, minVersion: 18 },
          cli: { configured: false, path: 'C:\\Users\\mock\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs', found: true },
          credentials: { ok: true, model: 'glm-4.7' },
          allOk: true,
        } satisfies EnvStatus,
      }
    case 'listFiles':
      return { op: 'files', files: ['README.md', 'package.json', 'src/main.tsx'] }
    case 'listCommands':
      // mock：技能 + 命令混合列表（skill/command 两种 kind，builtin=CLI 内置命令）
      return {
        op: 'commands',
        commands: [
          { name: 'code-review', description: '按标准和规格评审代码改动', kind: 'skill', source: 'user' },
          { name: 'git-commit-format', description: '规范化 Git 提交信息格式', kind: 'skill', source: 'user' },
          { name: 'handoff', description: '压缩会话生成交接文档', kind: 'skill', source: 'user' },
          { name: 'research', description: '调研问题并落盘 Markdown 发现', kind: 'skill', source: 'user' },
          { name: 'diagnosing-bugs', description: '硬 bug 与性能回归的诊断循环', kind: 'skill', source: 'user' },
          { name: 'init', description: 'Create or update workspace AGENTS.md instructions.', kind: 'command', source: 'builtin' },
          { name: 'compact', description: '压缩当前会话上下文', kind: 'command', source: 'builtin' },
          { name: 'browser-use:control-browser', description: '浏览器自动化（插件贡献，带前缀）', kind: 'skill', source: 'plugin' },
          { name: 'review:code', description: '评审代码（嵌套目录命令）', kind: 'command', source: 'user' },
        ],
      }
    case 'listMemoryFiles':
      // mock：全局存在 + 项目未创建 + 两条自动记忆（验收三种形态的条目）
      return {
        op: 'memoryFiles',
        memoryEnabled: true,
        memorySettingPath: 'C:\\Users\\mock\\.zcode\\v2\\setting.json',
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
            title: '用户偏好用 Ctrl+F 做会话内搜索',
          },
          {
            name: 'no-heading-fact.md',
            scope: 'project',
            kind: 'auto',
            path: 'C:\\Users\\mock\\.zcode\\cli\\memories\\projects\\mock-abc123\\memory\\no-heading-fact.md',
            exists: true,
            sizeBytes: 640,
            lastModified: Date.now() - 10800_000,
            description: '',
          },
        ],
      }
    case 'createMemoryFile':
      return { op: 'memoryFileCreated', path: req.path }
    case 'setMemoryEnabled':
      return { op: 'memoryEnabledChanged', enabled: req.enabled }
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
    case 'enhancePrompt':
      // mock：同步返回（外层 200ms 延迟已能验收弹窗 loading 态）
      return {
        op: 'enhancePromptResult',
        original: req.text,
        text: `【润色】${req.text}\n\n（mock 结果：请补充目标产物的具体要求，例如输出格式、篇幅与读者对象。）`,
      }
    case 'listAgents':
      // mock：user/project 两作用域 + 颜色/工具/模型各形态
      return {
        op: 'agents',
        agents: [
          { name: 'code-explorer', description: '只读探索代码库结构并输出调研报告', color: 'cyan', tools: [], disallowedTools: [], injectAgentsMd: false, mcpServers: [], systemPrompt: '你是代码库调研专家，只读不改。', path: 'C:\\Users\\mock\\.zcode\\agents\\code-explorer.md', scope: 'user' },
          { name: 'deploy-guard', description: '检查部署清单与端口占用（mock 项目级）', color: 'orange', model: 'GLM-5-Turbo', tools: ['Bash', 'Read'], disallowedTools: [], injectAgentsMd: true, mcpServers: [], systemPrompt: '你是部署检查员。', path: 'G:\\mock\\project\\.zcode\\agents\\deploy-guard.md', scope: 'project' },
        ],
      }
    case 'saveAgent':
      return { op: 'agentSaved', name: req.agent.name, scope: req.scope }
    case 'deleteAgent':
      return { op: 'agentDeleted', name: req.name, scope: req.scope }
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
      // mock：子会话订阅 ack（无真实事件流，弹窗实时数据走 mock 消息/转发事件）。
      // v4:false = 前端三态守卫走降级轮询（配合 subagentMessages mock 分支）
      return { op: 'subscribedChild', sessionId: req.sessionId, v4: false }
    case 'unsubscribeChild':
      // mock：子代理终点退订 ack（无真实订阅可清）
      return { op: 'unsubscribedChild', sessionId: req.sessionId }
    case '__jsLog':
      // 诊断日志：桥未就绪期落 mock 时静默吞掉（mock 分支缺失会弹"mock 不支持 op"）
      return { op: '__jsLogAck' }
    default:
      return { op: 'error', message: `mock 不支持 op: ${(req as { op: string }).op}` }
  }
}
