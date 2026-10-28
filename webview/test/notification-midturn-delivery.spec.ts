/**
 * 后台任务/子代理完成通知卡实时不渲染（回合结束才出现）回归测试
 *
 * 用户症状（2026-09-20 截图实测）：后台子代理 0062 完成（09:37），通知卡在
 * 实时流过程中不出现，回合结束后（轮末 300ms 重拉落地）才渲染。
 *
 * 根因（两段，均在 store 接缝）：
 *   1. case 'messages' 守卫：streaming=true 期间全量快照整体丢弃
 *      （useStore.ts `if (get().streaming) break`，防断流/叠字）。转录注入的
 *      合成通知（task-notification / subagent-message）只能随快照落地，
 *      流式中到达即被丢——轮末重拉才补上。
 *   2. 无中途拉取触发：后台任务结束其实有实时信号（session.updated 携带
 *      {taskId,status≠running}），webview 只拿来点底部栏 endedAt，
 *      不触发转录重拉——长回合中通知即便注入了转录也无任何拉取动作。
 *
 * 断言：
 *   A. （红=复现）streaming 中快照含新通知卡：期望通知落地且流式气泡保留
 *      （合并语义）；现状整体丢弃 → 通知缺失
 *   B. （绿=对照）非 streaming 同一快照：通知照常落地
 *   C. （红=复现）streaming 中收到任务结束实时信号：期望去重后调度转录重拉；
 *   现状无任何 messages 请求
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- mock 桥接层：捕获 sendToJava，手动注入事件/响应 ----
let streamEventHandler: ((sid: string, event: unknown) => void) | null = null
let messageHandler: ((msg: unknown) => void) | null = null
const sentRequests: Array<Record<string, unknown>> = []

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getTabWorkspacePath: () => '',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: unknown) => void) => { messageHandler = fn },
  onStreamEvent: (fn: (sid: string, event: unknown) => void) => { streamEventHandler = fn },
  onStreamBatch: () => {},
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import { useStore, stopSubagentStatusPolling } from '@/store/useStore'
import type { MessageInfo, ZCodeMessage } from '@/types/messages'

const SID = 'sess_notif_live'

function pushEvent(type: string, payload: Record<string, unknown>): void {
  streamEventHandler!(SID, {
    type, seq: 100, sessionId: SID, turnId: 'turn_n1', timestamp: Date.now(), payload,
  })
}

function userMsg(id: string): ZCodeMessage {
  return {
    info: { id, sessionID: SID, role: 'user', time: { created: 1 } } as MessageInfo,
    parts: [{ type: 'text', text: '继续制作' }],
  }
}

function assistantMsg(id: string, text: string): ZCodeMessage {
  return {
    info: { id, sessionID: SID, role: 'assistant', time: { created: 2, completed: 3 } } as MessageInfo,
    parts: [{ type: 'text', text }],
  }
}

/** 转录注入的后台子代理完成通知（parseNotification 实测结构） */
function taskNotificationMsg(id: string): ZCodeMessage {
  return {
    info: {
      id,
      sessionID: SID,
      role: 'user',
      time: { created: Date.now() },
      synthetic: true,
      source: 'background_task',
      semantics: { origin: 'agent_runtime', kind: 'subagent_notification', uiVisibility: 'hidden' },
    } as unknown as MessageInfo,
    parts: [{
      type: 'text',
      text: '<task-notification><task-id>agent_0062</task-id><status>completed</status>'
        + '<summary>Agent general-purpose task "0062 Kafka 快速上手制作" completed.</summary>'
        + '<result>制作完成</result></task-notification>',
    }],
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  stopSubagentStatusPolling()
  sentRequests.length = 0
  useStore.getState().init()
  sentRequests.length = 0
  useStore.setState({
    connectionStatus: 'mock',
    currentSessionId: SID,
    currentWorkspacePath: 'G:\\mock',
    messages: [],
    streaming: false,
    streamingMessageId: null,
    waitingSince: null,
    compacting: false,
    queuedMessages: [],
    subagentActivities: [],
    subagents: [],
    childSessionKeys: {},
    backgroundTasks: {},
    sessions: [{ sessionId: SID, title: 'notif-test', status: 'idle', mode: 'yolo', workspacePath: 'G:\\mock', workspaceKey: 'G:\\mock', createdAt: 1, updatedAt: 1 }],
    provisionalTitles: {},
    currentModel: { modelId: 'GLM-5.3', providerId: 'builtin' },
  })
})

describe('通知卡实时落地（缺陷复现）', () => {
  it('A. streaming 中快照含新通知：通知落地且流式气泡保留', () => {
    // 流式中：本地时间线 = 用户消息 + 已完成 assistant + 流式 assistant（无通知）
    useStore.setState({
      streaming: true,
      streamingMessageId: 'asst_live',
      messages: [userMsg('u1'), assistantMsg('asst_done', '已派出验收员'), assistantMsg('asst_live', '正在生')],
    })
    // 轮末重拉/触发重拉的快照返回：已含通知合成消息（服务端转录已注入）
    messageHandler!({
      op: 'messages',
      sessionId: SID,
      messages: [
        userMsg('u1'),
        assistantMsg('asst_done', '已派出验收员'),
        taskNotificationMsg('notif_0062'),
        assistantMsg('asst_live', '正在生成中'),
      ],
    })
    const st = useStore.getState()
    const ids = st.messages.map((m) => m.info.id)
    // 流式气泡保留（守卫的本职不能回退：断流/叠字防护）
    expect(st.streaming).toBe(true)
    expect(ids).toContain('asst_live')
    // 通知卡随快照落地（现状：整体丢弃 → 缺失 → 红）
    expect(ids).toContain('notif_0062')
    // 通知在流式消息之前（时序正确，不插到流式尾部之后）
    expect(ids.indexOf('notif_0062')).toBeLessThan(ids.indexOf('asst_live'))
  })

  it('F. 回合中途到达（缺陷EG）：快照前驱=流式气泡本体 → 通知插到流式气泡之后', () => {
    // 2026-09-30 真机实锤：后台命令在回合跑着时完成，转录 [.., 在途回合, 通知]——
    // 原实现恒插流式气泡之前，卡片被顶到整条在途回合上方（时序倒挂）。
    // 快照里通知的前驱就是在飞的流式消息 → 应插其后（时序位）
    useStore.setState({
      streaming: true,
      streamingMessageId: 'asst_live',
      messages: [userMsg('u1'), assistantMsg('asst_live', '正在生成中')],
    })
    messageHandler!({
      op: 'messages',
      sessionId: SID,
      messages: [userMsg('u1'), assistantMsg('asst_live', '正在生成中'), taskNotificationMsg('notif_0062')],
    })
    const ids = useStore.getState().messages.map((m) => m.info.id)
    expect(ids).toContain('notif_0062')
    expect(ids.indexOf('notif_0062')).toBeGreaterThan(ids.indexOf('asst_live'))
  })

  it('B. 非 streaming 同一快照：通知照常落地（对照，现状应过）', () => {
    useStore.setState({ streaming: false, streamingMessageId: null, messages: [] })
    messageHandler!({
      op: 'messages',
      sessionId: SID,
      messages: [userMsg('u1'), taskNotificationMsg('notif_0062'), assistantMsg('asst_done', '继续处理')],
    })
    const ids = useStore.getState().messages.map((m) => m.info.id)
    expect(ids).toContain('notif_0062')
  })

  it('C. streaming 中任务结束实时信号：调度转录重拉', () => {
    useStore.setState({
      streaming: true,
      streamingMessageId: 'asst_live',
      backgroundTasks: { tool_1: { id: 'agent_0062', startedAt: 1 } },
    })
    sentRequests.length = 0
    // 后台任务结束的实时信号（session.updated 携带状态迁移）
    pushEvent('session.updated', { taskId: 'agent_0062', toolCallId: 'tool_1', status: 'completed' })
    // endedAt 标记（现状已有行为）
    expect(useStore.getState().backgroundTasks['tool_1']?.endedAt).toBeTruthy()
    // 触发转录重拉（现状：无任何 messages 请求 → 红）
    vi.advanceTimersByTime(2000)
    const pulls = sentRequests.filter((r) => r.op === 'messages' && r.sessionId === SID && !r.reconcile)
    expect(pulls.length).toBeGreaterThan(0)
  })

  it('D. 轮开始（wake 轮）：调度转录重拉（轮界注入已落地的可靠信号）', () => {
    // 实验实证（diag-notification-injection-timing.py）：任务结束事件在完成时刻发
    //（t+28s），转录注入拖到轮界（t+55s）——完成时刻拉转录必空；wake 轮的
    // turn.started 才是「注入已落地」的信号
    useStore.setState({ streaming: false, streamingMessageId: null, messages: [] })
    sentRequests.length = 0
    pushEvent('turn.started', {})
    vi.advanceTimersByTime(2000)
    const pulls = sentRequests.filter((r) => r.op === 'messages' && r.sessionId === SID && !r.reconcile)
    expect(pulls.length).toBeGreaterThan(0)
    // 落地的通知走合并腿：流式中快照含通知 → 落地且流式保留（复用用例 A 断言逻辑）
    useStore.setState({
      streaming: true,
      streamingMessageId: 'asst_live2',
      messages: [userMsg('u2'), assistantMsg('asst_live2', '正在生')],
    })
    messageHandler!({
      op: 'messages',
      sessionId: SID,
      messages: [userMsg('u2'), taskNotificationMsg('notif_0062_wake'), assistantMsg('asst_live2', '正在生成中')],
    })
    const ids = useStore.getState().messages.map((m) => m.info.id)
    expect(ids).toContain('notif_0062_wake')
    expect(ids.indexOf('notif_0062_wake')).toBeLessThan(ids.indexOf('asst_live2'))
  })

  it('E. wake 轮 id 撞车：流式气泡借用通知真身 id，通知以 local_n_ 副本插入', () => {
    // 12:53 真机实锤：turn.started 借用触发本轮的通知消息 id 建流式气泡，
    // 按 id 去重会把通知拦掉（卡片只能等轮末）。本地副本须换 local_n_ id。
    useStore.setState({
      streaming: true,
      streamingMessageId: 'notif_0062', // 借用！
      messages: [userMsg('u1'), assistantMsg('notif_0062', '正在生')],
    })
    messageHandler!({
      op: 'messages',
      sessionId: SID,
      messages: [
        userMsg('u1'),
        taskNotificationMsg('notif_0062'), // 真身与流式消息同 id
        assistantMsg('asst_wake', '正在生成中'),
      ],
    })
    let ids = useStore.getState().messages.map((m) => m.info.id)
    expect(ids).toContain('local_n_notif_0062')
    expect(ids.indexOf('local_n_notif_0062')).toBeLessThan(ids.indexOf('notif_0062'))
    // 防重：同一通知随后续快照再来，不重复插入
    messageHandler!({
      op: 'messages',
      sessionId: SID,
      messages: [userMsg('u1'), taskNotificationMsg('notif_0062'), assistantMsg('asst_wake', '生成中')],
    })
    ids = useStore.getState().messages.map((m) => m.info.id)
    expect(ids.filter((x) => x === 'local_n_notif_0062').length).toBe(1)
    // 权威快照落地：全量替换后真身接管，本地副本消失、防重登记清空
    useStore.setState({ streaming: false, streamingMessageId: null })
    messageHandler!({
      op: 'messages',
      sessionId: SID,
      messages: [userMsg('u1'), taskNotificationMsg('notif_0062'), assistantMsg('asst_wake', '完成')],
    })
    ids = useStore.getState().messages.map((m) => m.info.id)
    expect(ids).toContain('notif_0062')
    expect(ids).not.toContain('local_n_notif_0062')
  })
})
