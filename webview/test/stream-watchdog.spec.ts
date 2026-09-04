/**
 * 流式静默对账看门狗 + 冷会话 send 错误提示的回归测试
 *
 * 复现缺陷（2026-08-19，idea.log + cli jsonl 时序证据）：
 *   ZCode 桌面端自动更新 taskkill 掉插件赖以工作的 app-server → 插件自动重启
 *   新进程 → 会话 resume 恢复后的回合以 background turn 在服务端真实执行完毕
 *   （工具调用全部落地），但 session/event 零下发——前端只认终止帧收尾，
 *   无限转圈；恢复完成前的第一次 send 还会撞 -32004 Session is not active。
 *
 * 断言：
 *   1. -32004 错误信息追加人话提示（引导从历史列表重开）
 *   2. streaming 静默 60s 触发对账探测（messages + reconcile 标记）
 *   3. 快照末尾是完整 assistant 回复 → 回合判定已结束，收尾 + 落地，不报错
 *   4. 快照连续多轮无进展（尾部始终没有 assistant 内容）→ 判定流丢失，收尾 + 提示
 *   5. 事件正常流动时心跳刷新静默计时，不探测；mock 连接不探测
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- mock 桥接层：捕获 sendToJava，手动注入事件/响应 ----
let streamEventHandler: ((sid: string, event: unknown) => void) | null = null
let streamBatchHandler: ((sid: string, events: unknown[]) => void) | null = null
let messageHandler: ((msg: unknown) => void) | null = null
const sentRequests: Array<Record<string, unknown>> = []

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: unknown) => void) => { messageHandler = fn },
  onStreamEvent: (fn: (sid: string, event: unknown) => void) => { streamEventHandler = fn },
  onStreamBatch: (fn: (sid: string, events: unknown[]) => void) => { streamBatchHandler = fn },
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import { useStore } from '@/store/useStore'
import type { ZCodeMessage } from '@/types/messages'

const SID = 'sess_watchdog_1'

/** 注入一条 tool.updated 事件（单推路径）*/
function pushToolUpdated(payload: Record<string, unknown>): void {
  streamEventHandler!(SID, {
    type: 'tool.updated', seq: 200, sessionId: SID, turnId: 'turn_t', timestamp: Date.now(), payload,
  })
}

function mkMsg(role: 'user' | 'assistant', text: string, id: string): ZCodeMessage {
  return {
    info: { role, id, time: { created: 1 }, sessionID: SID },
    parts: [{ type: 'text', text }],
  } as ZCodeMessage
}

function reconcileRequests(): Array<Record<string, unknown>> {
  return sentRequests.filter((r) => r.op === 'messages' && r.reconcile === true)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllTimers()
  sentRequests.length = 0
  useStore.getState().init()
  sentRequests.length = 0
  useStore.setState({
    connectionStatus: 'connected',
    currentSessionId: SID,
    currentWorkspacePath: 'G:\\mock',
    messages: [],
    streaming: false,
    streamingMessageId: null,
    waitingSince: null,
    queuedMessages: [],
    lastError: null,
    currentModel: { modelId: 'GLM-5.3', providerId: 'builtin' },
  })
  // 重置看门狗的服务端活跃信号（模块级，用例间共享）——无 activeTurnId 字段
  // 的 usage 响应 = 服务端无活跃回合（或旧 CLI 不上报），所有用例默认基线
  messageHandler!({ op: 'usage', sessionId: SID, used: 0, size: 0 })
})

describe('store：-32004 冷会话错误提示', () => {
  it('Session is not active 错误追加恢复提示（指引前置、原文在括号内）', () => {
    messageHandler!({ op: 'error', message: '发送失败: [-32004] Session is not active: sess_x' })
    const lastError = useStore.getState().lastError || ''
    expect(lastError).toContain('Session is not active')
    expect(lastError).toContain('槽位') // 提示解释服务端会话槽位上限语义（缺陷BA）
    expect(lastError.indexOf('槽位')).toBeLessThan(lastError.indexOf('Session is not active')) // 指引在句首（缺陷BA 四轮）
  })

  it('Session not found 变体同样追加槽位指引（新建会话撞槽位满，缺陷BA 五轮）', () => {
    messageHandler!({ op: 'error', message: '发送失败: [-32004] Session not found: sess_y' })
    const lastError = useStore.getState().lastError || ''
    expect(lastError).toContain('Session not found')
    expect(lastError).toContain('槽位')
  })

  it('普通错误不追加提示，原样展示', () => {
    messageHandler!({ op: 'error', message: '其他错误' })
    expect(useStore.getState().lastError).toBe('其他错误')
  })
})

describe('store：流式静默对账看门狗', () => {
  it('事件正常流动时不探测（心跳刷新静默计时）', () => {
    useStore.setState({ streaming: true })
    vi.advanceTimersByTime(30_000)
    // 当前会话有任何事件到达 = 回合活着
    streamEventHandler!(SID, {
      type: 'turn.started', seq: 1, sessionId: SID, turnId: 't', timestamp: Date.now(), payload: {},
    })
    vi.advanceTimersByTime(50_000)
    expect(reconcileRequests()).toHaveLength(0)
    // 此后彻底静默 60s+ → 才开始探测。首探后响应一直不来（测试不回），
    // 30s 未回放行重探 → 61s 窗口内共 2 次（防响应丢失卡死看门狗）
    vi.advanceTimersByTime(61_000)
    expect(reconcileRequests()).toHaveLength(2)
  })

  it('mock 连接不探测（mock 数据源无对账意义）', () => {
    useStore.setState({ connectionStatus: 'mock', streaming: true })
    vi.advanceTimersByTime(120_000)
    expect(reconcileRequests()).toHaveLength(0)
  })

  it('对账快照末尾为完整 assistant 回复 → 收尾并落地，不报错', () => {
    useStore.setState({ streaming: true })
    vi.advanceTimersByTime(61_000)
    expect(reconcileRequests()).toHaveLength(1)
    messageHandler!({
      op: 'messages',
      sessionId: SID,
      reconcile: true,
      messages: [mkMsg('user', '继续', 'm1'), mkMsg('assistant', '已完成合并与推送', 'm2')],
    })
    const st = useStore.getState()
    expect(st.streaming).toBe(false)
    expect(st.waitingSince).toBeNull()
    expect(st.lastError).toBeNull() // 正常完成路径不弹错误
    const last = st.messages[st.messages.length - 1]
    expect(last?.info.role).toBe('assistant')
    expect(JSON.stringify(last?.parts)).toContain('已完成合并与推送')
  })

  it('对账快照仍在推进（尾部是工具步骤）→ 不打扰，继续等待', () => {
    useStore.setState({ streaming: true })
    vi.advanceTimersByTime(61_000)
    // 尾部是 user（本轮输入），但快照每轮都有变化（服务端在产出）→ progress
    messageHandler!({ op: 'messages', sessionId: SID, reconcile: true, messages: [mkMsg('user', '继续', 'm1')] })
    expect(useStore.getState().streaming).toBe(true)
    // 快照推进（追加了一条工具消息）→ 仍 progress
    messageHandler!({
      op: 'messages', sessionId: SID, reconcile: true,
      messages: [mkMsg('user', '继续', 'm1'), { info: { role: 'assistant', id: 'm3', time: { created: 2 }, sessionID: SID }, parts: [{ type: 'tool', name: 'Bash' }] } as ZCodeMessage],
    })
    expect(useStore.getState().streaming).toBe(true)
    expect(useStore.getState().messages).toHaveLength(0) // progress 不落地
  })

  it('快照连续多轮无进展 → 判定流丢失，收尾并提示', () => {
    useStore.setState({ streaming: true })
    const snapshot = [mkMsg('user', '继续', 'm1')]
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(61_000)
      messageHandler!({ op: 'messages', sessionId: SID, reconcile: true, messages: snapshot })
      if (i < 3) expect(useStore.getState().streaming).toBe(true)
    }
    const st = useStore.getState()
    expect(st.streaming).toBe(false)
    expect(st.lastError).toBeTruthy()
  })

  it('服务端回合活跃（usage activeTurnId 有值）→ 快照无进展也不判死，继续等待', () => {
    useStore.setState({ streaming: true })
    // usage 轮询确认回合活跃（如后台任务等待段：事件流静默但 turn 挂起）
    messageHandler!({ op: 'usage', sessionId: SID, activeTurnId: 'turn_active', activeTurnKind: 'regular', used: 0, size: 0 })
    const snapshot = [mkMsg('user', '继续', 'm1')]
    // 超过 STREAM_DEAD_PROBES 轮无进展（9 轮 > 8）
    for (let i = 0; i < 9; i++) {
      vi.advanceTimersByTime(61_000)
      messageHandler!({ op: 'messages', sessionId: SID, reconcile: true, messages: snapshot })
      expect(useStore.getState().streaming).toBe(true)
    }
    expect(useStore.getState().lastError).toBeNull()
  })

  it('服务端回合活跃时末条带文本的 assistant 快照不判结束（前台子代理静默段）', () => {
    // 2026-08-31 实测缺陷：主代理先输出"派一个子代理去搜索…"再等 Agent 工具返回，
    // 静默 60s 后对账快照末条 = 带正文的流式消息 → 被判"回合已结束"收尾清掉
    // streamingMessageId → 子代理完成后主代理续写 delta 全被丢弃，主界面实时流
    // 丢失、回合结束权威重拉才一次性渲染。服务端回合活跃（activeTurnId）必须豁免
    useStore.setState({ streaming: true, streamingMessageId: 'm2' })
    messageHandler!({ op: 'usage', sessionId: SID, activeTurnId: 'turn_active', activeTurnKind: 'regular', used: 0, size: 0 })
    vi.advanceTimersByTime(61_000)
    const snapshot = [mkMsg('user', '搜索国外政府新闻', 'm1'), mkMsg('assistant', '好，派一个子代理去搜索', 'm2')]
    messageHandler!({ op: 'messages', sessionId: SID, reconcile: true, messages: snapshot })
    // 不收尾：流式挂载点保住（子代理完成后的续写依赖它）
    const st = useStore.getState()
    expect(st.streaming).toBe(true)
    expect(st.streamingMessageId).toBe('m2')

    // 活跃信号消失（回合真结束/服务端无进展）→ 下一轮探测照常判 ended 收尾
    messageHandler!({ op: 'usage', sessionId: SID, used: 0, size: 0 })
    vi.advanceTimersByTime(61_000)
    messageHandler!({ op: 'messages', sessionId: SID, reconcile: true, messages: snapshot })
    expect(useStore.getState().streaming).toBe(false)
    expect(useStore.getState().lastError).toBeNull() // ended 是正常收尾不报错
  })

  it('usage activeTurnId 是滞后读数（=== lastCompletedTurnId）→ 不算活跃，照旧判死', () => {
    useStore.setState({ streaming: true })
    // 回合结束（记录已完成 turnId），随后 usage 读到服务端未清算的滞后读数
    streamEventHandler!(SID, {
      type: 'turn.completed', seq: 1, sessionId: SID, turnId: 'turn_done', timestamp: Date.now(), payload: {},
    })
    useStore.setState({ streaming: true }) // turn.completed 已收尾，重新开启流式模拟下一回合
    messageHandler!({ op: 'usage', sessionId: SID, activeTurnId: 'turn_done', activeTurnKind: 'regular', used: 0, size: 0 })
    const snapshot = [mkMsg('user', '继续', 'm1')]
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(61_000)
      messageHandler!({ op: 'messages', sessionId: SID, reconcile: true, messages: snapshot })
      if (i < 3) expect(useStore.getState().streaming).toBe(true)
    }
    const st = useStore.getState()
    expect(st.streaming).toBe(false)
    expect(st.lastError).toBeTruthy()
  })

  it('usage 不上报 activeTurnId（旧 CLI）→ 维持旧行为：无进展照旧判死', () => {
    useStore.setState({ streaming: true })
    messageHandler!({ op: 'usage', sessionId: SID, used: 0, size: 0 }) // 字段缺失
    const snapshot = [mkMsg('user', '继续', 'm1')]
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(61_000)
      messageHandler!({ op: 'messages', sessionId: SID, reconcile: true, messages: snapshot })
      if (i < 3) expect(useStore.getState().streaming).toBe(true)
    }
    expect(useStore.getState().streaming).toBe(false)
    expect(useStore.getState().lastError).toBeTruthy()
  })

  it('服务端活跃时无进展计数清零：活跃段过后再判死需重新累计 4 轮', () => {
    useStore.setState({ streaming: true })
    const snapshot = [mkMsg('user', '继续', 'm1')]
    // 先无信号 3 轮（计数累计到 3）
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(61_000)
      messageHandler!({ op: 'messages', sessionId: SID, reconcile: true, messages: snapshot })
    }
    expect(useStore.getState().streaming).toBe(true)
    // 服务端确认回合活跃（工具执行中）→ 计数清零
    messageHandler!({ op: 'usage', sessionId: SID, activeTurnId: 'turn_active', activeTurnKind: 'regular', used: 0, size: 0 })
    vi.advanceTimersByTime(61_000)
    messageHandler!({ op: 'messages', sessionId: SID, reconcile: true, messages: snapshot })
    expect(useStore.getState().streaming).toBe(true)
    // 活跃信号消失（回合结束清算/断流）→ 需重新累计 8 轮才判死
    messageHandler!({ op: 'usage', sessionId: SID, used: 0, size: 0 })
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(61_000)
      messageHandler!({ op: 'messages', sessionId: SID, reconcile: true, messages: snapshot })
      if (i < 3) expect(useStore.getState().streaming).toBe(true)
    }
    expect(useStore.getState().streaming).toBe(false)
    expect(useStore.getState().lastError).toBeTruthy()
  })
})

describe('store：后台任务运行中指示器（缺陷Y 体验增强）', () => {
  it('Bash result 内容带任务 ID → backgroundTasks 置位', () => {
    useStore.setState({ streaming: true, backgroundTasks: {} })
    // 真实形状（2026-08-25 dump）：kind=result 事件不带 toolName 字段
    pushToolUpdated({
      kind: 'result',
      toolCallId: 'call_bg_1',
      result: { success: true, content: 'Command running in background with ID: exec_0f2c1b7a-9e44-4f6d-b1a3-c8e2d5f0a9b1. Output is being written to: C:\\Users\\...\\call_bg_1-stdout.log. You will be notified when it completes.' },
    })
    const bt = useStore.getState().backgroundTasks['call_bg_1']
    expect(bt).toBeTruthy()
    expect(bt?.id).toBe('exec_0f2c1b7a-9e44-4f6d-b1a3-c8e2d5f0a9b1')
    expect(bt?.startedAt).toBeGreaterThan(0)
  })

  it('真实完整 payload（含 perf/artifactPath 等冗余字段）→ 同样置位', () => {
    useStore.setState({ streaming: true, backgroundTasks: {} })
    pushToolUpdated({
      toolCallId: 'call_00_zYidy4fnw1vcNl4TmEHp2543',
      result: {
        success: true,
        content: 'Command running in background with ID: exec_a4911e0f-0601-4bd7-9e6e-db75c40745b8. Output is being written to: C:\\Users\\Administrator\\.zcode\\cli\\exec\\sess_x\\call_00_zYidy4fnw1vcNl4TmEHp2543-stdout.log. You will be notified when it completes. To check interim output, use Read on that file path.',
        perf: { totalMs: 601, detail: { kind: 'command', command: { category: 'other', count: 1, name: 'other', status: 'backgrounded', hash: '72816f2f42798fad' } } },
        truncated: false, originalBytes: 328, returnedBytes: 328, budgetStrategy: 'artifact',
        artifactPath: 'C:\\Users\\Administrator\\.zcode\\cli\\exec\\sess_x\\call_00_zYidy4fnw1vcNl4TmEHp2543-stdout.log',
      },
      duration: 597,
      kind: 'result',
    })
    expect(useStore.getState().backgroundTasks['call_00_zYidy4fnw1vcNl4TmEHp2543']?.id)
      .toBe('exec_a4911e0f-0601-4bd7-9e6e-db75c40745b8')
  })

  it('手动后台化（manually backgrounded）同样识别', () => {
    useStore.setState({ streaming: true, backgroundTasks: {} })
    pushToolUpdated({
      kind: 'result',
      toolCallId: 'call_bg_2',
      result: { success: true, content: 'Command was manually backgrounded by user with ID: exec_5b3a9f1e-2d84-4c7b-9a6e-1f0d8c2b4a77. To check interim output, use ...' },
    })
    expect(useStore.getState().backgroundTasks['call_bg_2']?.id).toBe('exec_5b3a9f1e-2d84-4c7b-9a6e-1f0d8c2b4a77')
  })

  it('普通工具结果（无任务 ID）→ 不置位', () => {
    useStore.setState({ streaming: true, backgroundTasks: {} })
    pushToolUpdated({
      kind: 'result',
      toolCallId: 'call_ok_1',
      result: { success: true, content: 'exit code: 0' },
    })
    expect(useStore.getState().backgroundTasks).toEqual({})
  })

  it('任务查询类 result（无后台化文案）→ 不置位', () => {
    useStore.setState({ streaming: true, backgroundTasks: {} })
    // Task 工具查询状态的结果：content 是任务状态，不含 "with ID" 后台化文案
    pushToolUpdated({
      kind: 'result',
      toolCallId: 'call_task_1',
      result: { success: true, content: 'Task exec_0f2c1b7a-9e44-4f6d-b1a3-c8e2d5f0a9b1 is still running. Check again later or use /tasks to list all.' },
    })
    expect(useStore.getState().backgroundTasks).toEqual({})
  })

  it('误报防御：代码注释含「background + with ID」但无 Command 动作前缀 → 不置位（缺陷Z）', () => {
    useStore.setState({ streaming: true, backgroundTasks: {} })
    // 真机误报场景：git diff/grep 输出恰好包含源码注释 "moved to the background with ID: xxx"
    pushToolUpdated({
      kind: 'result',
      toolCallId: 'call_grep_1',
      result: { success: true, content: '+   * result 内容带任务 ID（"moved to the background with ID: xxx"），等待段\n+  backgroundTasks: {}' },
    })
    expect(useStore.getState().backgroundTasks).toEqual({})
  })

  it('误报防御：有 Command 前缀但 ID 非 exec_ → 不置位（缺陷Z）', () => {
    useStore.setState({ streaming: true, backgroundTasks: {} })
    pushToolUpdated({
      kind: 'result',
      toolCallId: 'call_fake_1',
      result: { success: true, content: 'Command was moved to the background with ID: mytask_7. Just a log line.' },
    })
    expect(useStore.getState().backgroundTasks).toEqual({})
  })

  it('误报防御：源码注释完整引用官方句子 + exec_ 占位 ID → 不置位（缺陷Z 变体）', () => {
    useStore.setState({ streaming: true, backgroundTasks: {} })
    // 2026-08-26 真机：grep 源码注释输出恰好同时含 Command 动作前缀 + "exec_xxx" 占位
    // （旧注释逐字引用了 zcode.cjs 官方句子），双判据第一层命中、第二层被 UUID 形态拒绝
    pushToolUpdated({
      kind: 'result',
      toolCallId: 'call_grep_2',
      result: {
        success: true,
        content: '2505: *  `Command running in background with ID: exec_xxx.` /\n2506: *  `Command was moved to the background with ID: exec_xxx.` /\n2507: *  `Command was manually backgrounded by user with ID: exec_xxx.`',
      },
    })
    expect(useStore.getState().backgroundTasks).toEqual({})
  })

  it('误报防御：有 Command 前缀 + exec_ 开头但非标准 UUID（短 ID/无连字符）→ 不置位', () => {
    useStore.setState({ streaming: true, backgroundTasks: {} })
    pushToolUpdated({
      kind: 'result',
      toolCallId: 'call_fake_2',
      result: { success: true, content: 'Command running in background with ID: exec_abc123. Output is being written to: ...' },
    })
    expect(useStore.getState().backgroundTasks).toEqual({})
  })

  it('批量路径（真实链路：Java 16ms flusher → onStreamBatch）同样置位', () => {
    useStore.setState({ streaming: true, backgroundTasks: {} })
    streamBatchHandler!(SID, [{
      type: 'tool.updated',
      seq: 19,
      sessionId: SID,
      turnId: 'turn_bg_batch',
      timestamp: Date.now(),
      // 真实形状：result 事件无 toolName 字段（2026-08-25 dump 实测）
      payload: {
        toolCallId: 'call_batch_1',
        result: {
          success: true,
          content: 'Command running in background with ID: exec_7c1e9d3a-4f2b-4a8d-b6c5-9e1f3a5b7c9d. Output is being written to: C:\\Users\\...\\call_batch_1-stdout.log. You will be notified when it completes.',
          perf: { totalMs: 601, detail: { kind: 'command', command: { status: 'backgrounded' } } },
          truncated: false, originalBytes: 328, returnedBytes: 328, budgetStrategy: 'artifact',
        },
        duration: 597,
        kind: 'result',
      },
    }])
    expect(useStore.getState().backgroundTasks['call_batch_1']?.id).toBe('exec_7c1e9d3a-4f2b-4a8d-b6c5-9e1f3a5b7c9d')
  })

  it('并发双任务（同批两个 result）→ 各自独立置位互不覆盖', () => {
    useStore.setState({ streaming: true, backgroundTasks: {} })
    streamBatchHandler!(SID, [
      {
        type: 'tool.updated', seq: 31, sessionId: SID, turnId: 'turn_bg_multi', timestamp: Date.now(),
        payload: {
          toolCallId: 'call_sleep_75',
          result: { success: true, content: 'Command running in background with ID: exec_d1c1ab12-efa3-4dd7-a2ad-507ce573d029. You will be notified when it completes.' },
          duration: 42, kind: 'result',
        },
      },
      {
        type: 'tool.updated', seq: 32, sessionId: SID, turnId: 'turn_bg_multi', timestamp: Date.now(),
        payload: {
          toolCallId: 'call_sleep_90',
          result: { success: true, content: 'Command running in background with ID: exec_c23b0a69-fd83-4f56-b519-366d89a13e5b. You will be notified when it completes.' },
          duration: 41, kind: 'result',
        },
      },
    ])
    const tasks = useStore.getState().backgroundTasks
    expect(tasks['call_sleep_75']?.id).toBe('exec_d1c1ab12-efa3-4dd7-a2ad-507ce573d029')
    expect(tasks['call_sleep_90']?.id).toBe('exec_c23b0a69-fd83-4f56-b519-366d89a13e5b')
  })

  it('turn.completed 不清指示器（行为B：后台化确认后回合立即结束，任务仍在后台跑）', () => {
    useStore.setState({ streaming: true, backgroundTasks: {} })
    pushToolUpdated({
      kind: 'result',
      toolCallId: 'call_bg_3',
      result: { success: true, content: 'Command was moved to the background with ID: exec_9b4d2e6f-1a3c-4e5b-8f7a-2c6d0e1f3a5b' },
    })
    expect(useStore.getState().backgroundTasks['call_bg_3']?.id).toBe('exec_9b4d2e6f-1a3c-4e5b-8f7a-2c6d0e1f3a5b')
    streamEventHandler!(SID, {
      type: 'turn.completed', seq: 201, sessionId: SID, turnId: 'turn_1', timestamp: Date.now(), payload: {},
    })
    // 回合结束不再清除——卡片（工具卡上的后台标识）保持显示直到任务完成通知
    expect(useStore.getState().backgroundTasks['call_bg_3']?.id).toBe('exec_9b4d2e6f-1a3c-4e5b-8f7a-2c6d0e1f3a5b')
  })

  it('任务完成通知（session.updated taskId+toolCallId + status=completed）→ 该项标记 endedAt（保留后台完成标识）', () => {
    useStore.setState({ streaming: true, backgroundTasks: { call_bg_3: { id: 'exec_9b4d2e6f-1a3c-4e5b-8f7a-2c6d0e1f3a5b', startedAt: Date.now() } } })
    streamEventHandler!(SID, {
      type: 'session.updated', seq: 202, sessionId: SID, turnId: 'turn_1', timestamp: Date.now(),
      payload: {
        taskId: 'exec_9b4d2e6f-1a3c-4e5b-8f7a-2c6d0e1f3a5b', toolCallId: 'call_bg_3', toolName: 'Bash', taskKind: 'bash',
        command: 'sleep 90', status: 'completed', pid: 1234, startedAt: '2026-08-25T00:00:00.000Z', completedAt: '2026-08-25T00:01:30.000Z',
      },
    })
    // 完成通知标记 endedAt 而非删除：UI 保留「后台完成」标识与定格耗时
    const bt = useStore.getState().backgroundTasks['call_bg_3']
    expect(bt?.id).toBe('exec_9b4d2e6f-1a3c-4e5b-8f7a-2c6d0e1f3a5b')
    expect(bt?.endedAt).toBeGreaterThan(0)
    expect(bt!.endedAt!).toBeGreaterThanOrEqual(bt!.startedAt)
  })

  it('running 状态通知不清除（任务进行中）', () => {
    useStore.setState({ streaming: true, backgroundTasks: { call_bg_4: { id: 'exec_2a8c4e6f-5b1d-4f3a-9c7e-0d2b4a6c8e1f', startedAt: Date.now() } } })
    streamEventHandler!(SID, {
      type: 'session.updated', seq: 203, sessionId: SID, turnId: 'turn_1', timestamp: Date.now(),
      payload: { taskId: 'exec_2a8c4e6f-5b1d-4f3a-9c7e-0d2b4a6c8e1f', toolCallId: 'call_bg_4', toolName: 'Bash', status: 'running', pid: 5678 },
    })
    expect(useStore.getState().backgroundTasks['call_bg_4']?.id).toBe('exec_2a8c4e6f-5b1d-4f3a-9c7e-0d2b4a6c8e1f')
  })

  it('非匹配 taskId 的完成通知不影响当前指示器', () => {
    useStore.setState({ streaming: true, backgroundTasks: { call_a: { id: 'exec_3f6a1b2c-7d4e-4b8a-9c5d-1e3f7a9b2c4d', startedAt: Date.now() } } })
    streamEventHandler!(SID, {
      type: 'session.updated', seq: 204, sessionId: SID, turnId: 'turn_1', timestamp: Date.now(),
      payload: { taskId: 'exec_6d1e9f3a-2b4c-4e7f-8a5d-9c3b1f7e5a2d', status: 'completed' },
    })
    expect(useStore.getState().backgroundTasks['call_a']?.id).toBe('exec_3f6a1b2c-7d4e-4b8a-9c5d-1e3f7a9b2c4d')
  })

  it('批量路径：任务完成通知（session.updated taskId+completed）→ 标记 endedAt', () => {
    useStore.setState({ streaming: true, backgroundTasks: { call_batch_1: { id: 'exec_7c1e9d3a-4f2b-4a8d-b6c5-9e1f3a5b7c9d', startedAt: Date.now() } } })
    streamBatchHandler!(SID, [{
      type: 'session.updated',
      seq: 205,
      sessionId: SID,
      turnId: 'turn_bg_batch',
      timestamp: Date.now(),
      payload: { taskId: 'exec_7c1e9d3a-4f2b-4a8d-b6c5-9e1f3a5b7c9d', toolCallId: 'call_batch_1', toolName: 'Bash', status: 'completed' },
    }])
    const bt = useStore.getState().backgroundTasks['call_batch_1']
    expect(bt?.id).toBe('exec_7c1e9d3a-4f2b-4a8d-b6c5-9e1f3a5b7c9d')
    expect(bt?.endedAt).toBeGreaterThan(0)
  })

  it('并发双任务：完成通知精确标记其中一个，另一个保持运行', () => {
    useStore.setState({
      streaming: true,
      backgroundTasks: {
        call_sleep_75: { id: 'exec_d1c1ab12-efa3-4dd7-a2ad-507ce573d029', startedAt: Date.now() },
        call_sleep_90: { id: 'exec_c23b0a69-fd83-4f56-b519-366d89a13e5b', startedAt: Date.now() },
      },
    })
    // sleep 75 先完成：只标记它自己的项
    streamEventHandler!(SID, {
      type: 'session.updated', seq: 206, sessionId: SID, turnId: 'turn_bg_multi', timestamp: Date.now(),
      payload: { taskId: 'exec_d1c1ab12-efa3-4dd7-a2ad-507ce573d029', toolCallId: 'call_sleep_75', status: 'completed' },
    })
    let tasks = useStore.getState().backgroundTasks
    expect(tasks['call_sleep_75']?.endedAt).toBeGreaterThan(0)
    expect(tasks['call_sleep_90']?.id).toBe('exec_c23b0a69-fd83-4f56-b519-366d89a13e5b')
    expect(tasks['call_sleep_90']?.endedAt).toBeUndefined() // 仍在运行
    // sleep 90 完成：也标记
    streamEventHandler!(SID, {
      type: 'session.updated', seq: 207, sessionId: SID, turnId: 'turn_bg_multi', timestamp: Date.now(),
      payload: { taskId: 'exec_c23b0a69-fd83-4f56-b519-366d89a13e5b', toolCallId: 'call_sleep_90', status: 'completed' },
    })
    tasks = useStore.getState().backgroundTasks
    expect(tasks['call_sleep_90']?.endedAt).toBeGreaterThan(0)
  })

  it('完成通知只带 taskId（无 toolCallId）→ taskId 反查精确标记', () => {
    useStore.setState({
      streaming: true,
      backgroundTasks: {
        call_x: { id: 'exec_x', startedAt: Date.now() },
        call_y: { id: 'exec_y', startedAt: Date.now() },
      },
    })
    streamEventHandler!(SID, {
      type: 'session.updated', seq: 208, sessionId: SID, turnId: 'turn_1', timestamp: Date.now(),
      payload: { taskId: 'exec_y', status: 'completed' },
    })
    const tasks = useStore.getState().backgroundTasks
    expect(tasks['call_x']?.id).toBe('exec_x')
    expect(tasks['call_x']?.endedAt).toBeUndefined()
    expect(tasks['call_y']?.endedAt).toBeGreaterThan(0)
  })
})
