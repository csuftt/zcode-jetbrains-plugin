/**
 * 粘贴图片发送链路测试（store 级，2026-08-26 缺陷回归）
 *
 * 背景：读回适配修复后用户实测「实时发送模型收不到图」——AI 回复称消息里
 * 连图片占位符都没有，说明 attachments 根本没随 op:send 发出（而非服务端剥离）。
 * 本测试锁定前端链路：sendMessage(text, attachments) → sendToJava 的 op:send
 * 载荷必须携带完整 attachments 数组（属性名对齐协议：kind/filename/mimeType/
 * sizeBytes/dataBase64）。
 *
 * 覆盖：
 * 1. 常规发送：attachments 原样透传，乐观消息 parts 含 image part（dataUrl）
 * 2. streaming 中发送：入队携带 attachments，flushQueue 发出时不丢
 * 3. 无会话懒创建：pendingFirst 暂存，createSession 响应后补发带 attachments
 * 4. 纯图片（空文本 + 附件）：正常发送（不被空文本守卫拦截）
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

let messageHandler: ((msg: unknown) => void) | null = null
const sentRequests: Array<Record<string, unknown>> = []

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getTabWorkspacePath: () => '',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: unknown) => void) => { messageHandler = fn },
  onStreamEvent: () => {},
  onStreamBatch: () => {},
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import { useStore } from '@/store/useStore'
import type { ImageAttachmentInput } from '@/types/messages'

const att = (over: Partial<ImageAttachmentInput> = {}): ImageAttachmentInput => ({
  kind: 'image',
  filename: 'pasted-image-1.png',
  mimeType: 'image/png',
  sizeBytes: 70,
  dataBase64: 'iVBORw0KGgo=',
  ...over,
})

function goStreaming(sid = 'sess_live') {
  useStore.setState({
    currentSessionId: sid,
    streaming: true,
    streamingMessageId: 'm1',
    queuedMessages: [],
    creatingSession: false,
    pendingFirstMessage: null,
    pendingFirstAttachments: null,
  })
}

beforeEach(() => {
  sentRequests.length = 0
  // onMessage 处理器在 store init() 里注册（懒创建补发测试依赖消息通道）
  useStore.getState().init()
  useStore.setState({
    currentSessionId: 'sess_1',
    currentWorkspacePath: 'G:\\mock',
    streaming: false,
    streamingMessageId: null,
    queuedMessages: [],
    creatingSession: false,
    pendingFirstMessage: null,
    pendingFirstAttachments: null,
    currentModel: { modelId: 'GLM-5.2', providerId: 'builtin:bigmodel-coding-plan' },
    messages: [],
  })
})

describe('sendMessage 图片附件链路', () => {
  it('常规发送：op:send 载荷携带 attachments，乐观消息含 image part', () => {
    useStore.getState().sendMessage('看图', [att()])
    const send = sentRequests.find((r) => r.op === 'send')
    expect(send).toBeTruthy()
    const attachments = send!.attachments as ImageAttachmentInput[]
    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({
      kind: 'image',
      filename: 'pasted-image-1.png',
      mimeType: 'image/png',
      sizeBytes: 70,
      dataBase64: 'iVBORw0KGgo=',
    })
    // 乐观消息：image part（dataUrl 直连）+ text part
    const msgs = useStore.getState().messages
    const last = msgs[msgs.length - 1]
    expect(last.info.role).toBe('user')
    expect(last.parts[0].type).toBe('image')
    expect((last.parts[0] as { dataUrl?: string }).dataUrl).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(last.parts[1]).toMatchObject({ type: 'text', text: '看图' })
  })

  it('streaming 中入队：队列条目带 attachments，flushQueue 发出不丢', () => {
    goStreaming()
    useStore.getState().sendMessage('排队带图', [att({ filename: 'q.png' })])
    expect(sentRequests.some((r) => r.op === 'send')).toBe(false) // 未直接发送
    expect(useStore.getState().queuedMessages[0].attachments).toHaveLength(1)
    // 回合结束 → flush
    useStore.setState({ streaming: false })
    useStore.getState().flushQueue()
    const send = sentRequests.find((r) => r.op === 'send')
    expect(send).toBeTruthy()
    expect((send!.attachments as ImageAttachmentInput[])[0].filename).toBe('q.png')
  })

  it('无会话懒创建：createSession 响应后补发带 attachments', () => {
    useStore.setState({ currentSessionId: null, creatingSession: false })
    useStore.getState().sendMessage('首条带图', [att({ filename: 'first.png' })])
    // 暂存且发起建会话
    expect(useStore.getState().pendingFirstMessage).toBe('首条带图')
    expect(useStore.getState().pendingFirstAttachments).toHaveLength(1)
    expect(sentRequests.some((r) => r.op === 'createSession')).toBe(true)
    // 建会话完成
    messageHandler!({ op: 'createSession', sessionId: 'sess_new' })
    const send = sentRequests.find((r) => r.op === 'send')
    expect(send).toBeTruthy()
    expect((send!.attachments as ImageAttachmentInput[])[0].filename).toBe('first.png')
  })

  it('纯图片（空文本）不被空文本守卫拦截', () => {
    useStore.getState().sendMessage('', [att()])
    const send = sentRequests.find((r) => r.op === 'send')
    expect(send).toBeTruthy()
    expect(send!.attachments).toHaveLength(1)
  })
})
