/**
 * 逐轮文件更改（B2 回合产物）store 归并回归测试
 *
 * 锚点语义（product-projection 3661 实证）：turnHeader 行 entityId = productTurnId
 * （常态=该轮 user 消息 id）；重扫路径 Java 侧已锚定同轮 assistantText entityId
 * （=assistant 消息 id）。前端两步换算 + 匹配失败挂起 + 快照落地 flush。
 *
 * 覆盖：
 *   1. messageId=assistant 消息 id（重扫锚点）直接落地
 *   2. messageId=user 消息 id（增量兜底=productTurnId）换算到其后第一条 assistant
 *   3. 匹配失败挂起 → applyMessagesSnapshot 权威 id 就位后 flush 落地
 *   4. 畸形载荷静默忽略；非当前会话事件不落地
 *   5. canRewindFiles 只认布尔 true（服务端"缺省全 false；只下发为 true 的键"）
 *   6. turnFileRewindApplied 乐观置 reverted + 关弹窗
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
import type { ZCodeMessage } from '@/types/messages'

const SID = 'sess_b2_1'
const OTHER_SID = 'sess_b2_other'
const USER_A = 'msg_user_a'
const ASST_A = 'msg_assistant_a'
const ASST_B = 'msg_assistant_b'

function pushEvent(sid: string, payload: Record<string, unknown>): void {
  streamEventHandler!(sid, {
    type: 'turn.fileChanges', seq: 100, sessionId: sid, turnId: 'turn_b2', timestamp: Date.now(), payload,
  })
}

function fcPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: USER_A,
    rowId: 42,
    fileChanges: { additions: 12, deletions: 3, files: 2, state: 'active' },
    canRewindFiles: true,
    ...overrides,
  }
}

function msg(id: string, role: 'user' | 'assistant'): ZCodeMessage {
  return { info: { id, role, time: { created: Date.now() } }, parts: [] }
}

/** 注入当前会话消息（绕过 applyMessagesSnapshot 的全量管线，直接置 messages） */
function setMessages(...list: ZCodeMessage[]): void {
  useStore.setState({ messages: list })
}

beforeEach(() => {
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
    turnFileChanges: {},
    turnFileChangesDialogFor: null,
  })
})

describe('turn.fileChanges 锚点换算', () => {
  it('messageId=assistant 消息 id（重扫锚点）直接落地', () => {
    setMessages(msg(USER_A, 'user'), msg(ASST_A, 'assistant'))
    pushEvent(SID, fcPayload({ messageId: ASST_A }))
    const entry = useStore.getState().turnFileChanges[ASST_A]
    expect(entry).toBeDefined()
    expect(entry.rowId).toBe(42)
    expect(entry.additions).toBe(12)
    expect(entry.files).toBe(2)
    expect(entry.state).toBe('active')
    expect(entry.canRewind).toBe(true)
  })

  it('messageId=user 消息 id（productTurnId）换算到其后第一条 assistant', () => {
    setMessages(msg(USER_A, 'user'), msg(ASST_A, 'assistant'), msg(ASST_B, 'assistant'))
    pushEvent(SID, fcPayload({ messageId: USER_A }))
    // 挂到该轮第一条 assistant（ASST_A），不是后面的 ASST_B
    expect(useStore.getState().turnFileChanges[ASST_A]).toBeDefined()
    expect(useStore.getState().turnFileChanges[ASST_B]).toBeUndefined()
  })

  it('匹配失败挂起；快照落地（权威 id 就位）后 flush 落地', () => {
    // 流式期：user 还是乐观 id（不在 messages 里）
    setMessages()
    pushEvent(SID, fcPayload({ messageId: USER_A }))
    expect(useStore.getState().turnFileChanges[ASST_A]).toBeUndefined()
    // 轮末权威重拉落地（applyMessagesSnapshot flush）——用真实快照响应驱动
    messageHandler!({
      op: 'messages',
      sessionId: SID,
      messages: [msg(USER_A, 'user'), msg(ASST_A, 'assistant')],
    })
    const entry = useStore.getState().turnFileChanges[ASST_A]
    expect(entry).toBeDefined()
    expect(entry.files).toBe(2)
  })

  it('键漂移重锚定：壳 id 被真身 id 替换后条目迁移到真身键', () => {
    const SHELL_ID = 'msg_shell_local'
    const REAL_ID = 'msg_assistant_real'
    // 流式期：锚定到壳（user 消息 id 可解析时事件直接命中当时列表）
    setMessages(msg(USER_A, 'user'), msg(SHELL_ID, 'assistant'))
    pushEvent(SID, fcPayload({ messageId: USER_A }))
    expect(useStore.getState().turnFileChanges[SHELL_ID]).toBeDefined()
    // 权威重拉：壳消失、真身上位（id 不同）→ applyMessagesSnapshot 重锚定迁移
    messageHandler!({
      op: 'messages',
      sessionId: SID,
      messages: [msg(USER_A, 'user'), msg(REAL_ID, 'assistant')],
    })
    expect(useStore.getState().turnFileChanges[SHELL_ID]).toBeUndefined()
    expect(useStore.getState().turnFileChanges[REAL_ID]).toBeDefined()
    expect(useStore.getState().turnFileChanges[REAL_ID]?._anchor).toBe(USER_A)
  })

  it('同键重复事件整体覆盖（直播更新/重扫幂等）', () => {
    setMessages(msg(ASST_A, 'assistant'))
    pushEvent(SID, fcPayload({ messageId: ASST_A }))
    pushEvent(SID, fcPayload({
      messageId: ASST_A,
      fileChanges: { additions: 20, deletions: 5, files: 3, state: 'active' },
    }))
    const entry = useStore.getState().turnFileChanges[ASST_A]
    expect(entry.additions).toBe(20)
    expect(entry.files).toBe(3)
    expect(Object.keys(useStore.getState().turnFileChanges)).toEqual([ASST_A])
  })

  it('畸形载荷静默忽略（缺 messageId/rowId/fileChanges 数值字段）', () => {
    setMessages(msg(ASST_A, 'assistant'))
    pushEvent(SID, fcPayload({ messageId: undefined }))
    pushEvent(SID, fcPayload({ rowId: undefined }))
    pushEvent(SID, fcPayload({ fileChanges: { additions: 'x', deletions: 1, files: 1 } }))
    expect(useStore.getState().turnFileChanges[ASST_A]).toBeUndefined()
  })

  it('非当前会话事件不落地', () => {
    setMessages(msg(ASST_A, 'assistant'))
    pushEvent(OTHER_SID, fcPayload({ messageId: ASST_A }))
    expect(useStore.getState().turnFileChanges[ASST_A]).toBeUndefined()
  })

  it('canRewindFiles 只认布尔 true（缺省/非布尔=不可撤销）', () => {
    setMessages(msg(ASST_A, 'assistant'))
    pushEvent(SID, fcPayload({ messageId: ASST_A, canRewindFiles: undefined }))
    expect(useStore.getState().turnFileChanges[ASST_A]?.canRewind).toBe(false)
    pushEvent(SID, fcPayload({ messageId: ASST_A, canRewindFiles: true }))
    expect(useStore.getState().turnFileChanges[ASST_A]?.canRewind).toBe(true)
  })
})

describe('turnFileRewindApplied 乐观回执', () => {
  it('置 reverted + 关弹窗', () => {
    setMessages(msg(USER_A, 'user'), msg(ASST_A, 'assistant'))
    pushEvent(SID, fcPayload({ messageId: USER_A }))
    useStore.getState().openTurnFileChanges(ASST_A)
    expect(useStore.getState().turnFileChangesDialogFor).toBe(ASST_A)
    // 撤销应答的 messageId=弹窗打开时的 assistant 消息 id（map 键一致）
    messageHandler!({ op: 'turnFileRewindApplied', sessionId: SID, messageId: ASST_A })
    const entry = useStore.getState().turnFileChanges[ASST_A]
    expect(entry.state).toBe('reverted')
    expect(entry.canRewind).toBe(false)
    expect(useStore.getState().turnFileChangesDialogFor).toBeNull()
  })

  it('无条目（直接撤销成功）只关弹窗不崩', () => {
    useStore.getState().openTurnFileChanges(ASST_A)
    messageHandler!({ op: 'turnFileRewindApplied', sessionId: SID, messageId: ASST_A })
    expect(useStore.getState().turnFileChangesDialogFor).toBeNull()
    expect(useStore.getState().turnFileChanges[ASST_A]).toBeUndefined()
  })
})

describe('弹窗开关 action', () => {
  it('openTurnFileChanges/closeTurnFileChanges', () => {
    useStore.getState().openTurnFileChanges(ASST_A)
    expect(useStore.getState().turnFileChangesDialogFor).toBe(ASST_A)
    useStore.getState().closeTurnFileChanges()
    expect(useStore.getState().turnFileChangesDialogFor).toBeNull()
  })
})

describe('撤销预览工具名 i18n 资源', () => {
  const TOOL_KEYS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']
  const LANGS = ['zh', 'zh-TW', 'en', 'ja', 'ko']

  it('五语言 fileChanges.tool 键齐全且非空', async () => {
    for (const lang of LANGS) {
      const { fileChanges } = await import(`@/i18n/locales/${lang}/chat.json`)
      const tool = (fileChanges as Record<string, Record<string, string>>).tool
      expect(tool, `${lang} 缺 tool 块`).toBeDefined()
      for (const k of TOOL_KEYS) {
        expect(typeof tool[k], `${lang}.${k}`).toBe('string')
        expect(tool[k].length, `${lang}.${k}`).toBeGreaterThan(0)
      }
    }
  })
})
