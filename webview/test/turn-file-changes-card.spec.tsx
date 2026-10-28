/**
 * 逐轮文件更改卡片（UI 对齐官方客户端）渲染测试
 *
 * 行为约定：
 *   - 头部行：chevron + 「N 个文件已更改 +x −y」汇总；canRewind 时右侧「撤销」按钮
 *   - 头部点击展开 → 懒加载明细（发 turnFileChanges 请求，响应按 messageId 匹配）
 *   - 文件行：文件名 + 目录（灰）+ 行数统计 + 「审查」/「打开」
 *   - 审查 → openTurnFileChanges(messageId, {path})；打开 → sendToJava({op:'openFile'})
 *   - reverted 态：头部带「已撤销」徽标、无撤销按钮
 */

// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'

import '@/i18n/config'

let messageHandler: ((msg: unknown) => void) | null = null
const sentRequests: Array<Record<string, unknown>> = []

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\proj',
  getTabWorkspacePath: () => '',
  getInitialSessionId: () => '',
  onStreamEvent: () => () => {},
  onStreamBatch: () => () => {},
  onMessage: (fn: (msg: unknown) => void) => {
    messageHandler = fn
    return () => { messageHandler = null }
  },
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
  openExternalUrl: vi.fn(),
  GITHUB_REPO_URL: 'https://github.com/csuftt/zcode-jetbrains-plugin',
}))

import { TurnFileChangesBar } from '@/components/MessageBubble'
import { useStore, stopSubagentStatusPolling } from '@/store/useStore'
import type { TurnFileChangeSummary } from '@/types/messages'

afterEach(cleanup)

const SID = 'sess_card_1'
const MSG_A = 'msg_assistant_a'

function summary(overrides: Partial<TurnFileChangeSummary> = {}): TurnFileChangeSummary {
  return { rowId: 10, additions: 19, deletions: 10, files: 2, state: 'active', canRewind: true, ...overrides }
}

function setup(): void {
  stopSubagentStatusPolling()
  sentRequests.length = 0
  useStore.getState().init()
  useStore.setState({
    connectionStatus: 'mock',
    currentSessionId: SID,
    currentWorkspacePath: 'G:\\proj',
    projectPath: 'G:\\proj',
    messages: [],
    turnFileChanges: {},
    turnFileChangesDialogFor: null,
    turnFileChangesDialogPath: null,
    turnFileChangesDialogRewind: false,
  })
}

describe('TurnFileChangesBar', () => {
  it('头部行：汇总文案 + 撤销按钮（canRewind）；点击撤销直达弹窗 rewind 模式', () => {
    setup()
    const { container } = render(<TurnFileChangesBar fc={summary()} messageId={MSG_A} />)
    expect(screen.getByText('2 个文件已更改 · +19 −10')).toBeTruthy()
    const undo = screen.getByText('撤销')
    fireEvent.click(undo)
    expect(useStore.getState().turnFileChangesDialogFor).toBe(MSG_A)
    expect(useStore.getState().turnFileChangesDialogRewind).toBe(true)
    expect(container.querySelector('.msg__fcbar-tag')).toBeNull()
  })

  it('reverted 态：带已撤销徽标、无撤销按钮', () => {
    setup()
    render(<TurnFileChangesBar fc={summary({ state: 'reverted', canRewind: false })} messageId={MSG_A} />)
    expect(screen.getByText('已撤销')).toBeTruthy()
    expect(screen.queryByText('撤销')).toBeNull()
  })

  it('展开懒加载明细：请求按 messageId 发出，响应落地文件行；审查带 path、打开走 openFile', () => {
    setup()
    render(<TurnFileChangesBar fc={summary()} messageId={MSG_A} />)
    // 展开 → 明细请求
    fireEvent.click(screen.getByText('2 个文件已更改 · +19 −10'))
    const req = sentRequests.find((r) => r.op === 'turnFileChanges')
    expect(req).toBeDefined()
    expect(req!.sessionId).toBe(SID)
    expect(req!.messageId).toBe(MSG_A)
    // 响应落地（messageId 匹配；手动派发须包 act flush React 状态）
    act(() => {
      messageHandler!({
        op: 'turnFileChangesResult',
        sessionId: SID,
        messageId: MSG_A,
        data: {
          files: 2, additions: 19, deletions: 10, state: 'active',
          items: [
            {
              path: 'src/main/com/zcode/ui/Panel.kt', additions: 6, deletions: 6, writeCount: 2,
              toolNames: ['Edit'],
              patches: [
                { oldStart: 10, oldLines: 1, newStart: 10, newLines: 2, lines: ['-a', '+b', '+c'] },
                { oldStart: 40, oldLines: 2, newStart: 41, newLines: 2, lines: [' x', '-y', '+z', ' w'] },
              ],
            },
            { path: 'src/main/com/zcode/protocol/Client.kt', additions: 13, deletions: 4, writeCount: 1, toolNames: ['Edit'], patches: [] },
          ],
        },
      })
    })
    expect(screen.getByText('Panel.kt')).toBeTruthy()
    expect(screen.getByText('src/main/com/zcode/ui/')).toBeTruthy()
    // 文件行带文件类型图标（FileIcon SVG，非 codicon 通用文档图标）
    expect(document.querySelectorAll('.msg__fccard-file .file-type-icon').length).toBe(2)
    // 审查 → IDEA 原生 diff（op:turnFileDiff：绝对路径 + 本轮 hunk 交 Java 反推旧全文）
    fireEvent.click(screen.getAllByText('审查')[0])
    const diffReq = sentRequests.find((r) => r.op === 'turnFileDiff') as
      | { op: string; filePath: string; path: string; patches: unknown[]; title: string }
      | undefined
    expect(diffReq).toBeDefined()
    expect(diffReq!.filePath.replace(/\\/g, '/')).toBe('G:/proj/src/main/com/zcode/ui/Panel.kt')
    expect(diffReq!.path).toBe('src/main/com/zcode/ui/Panel.kt')
    expect(diffReq!.patches).toHaveLength(2)
    expect(diffReq!.title).toContain('Panel.kt')
    expect(useStore.getState().turnFileChangesDialogFor).toBeNull()
    // 打开 → openFile 绝对路径（workspacePath 拼接）
    fireEvent.click(screen.getAllByText('打开')[0])
    const openReq = sentRequests.find((r) => r.op === 'openFile') as { op: string; filePath: string } | undefined
    expect(openReq).toBeDefined()
    expect(openReq!.filePath.replace(/\\/g, '/')).toBe('G:/proj/src/main/com/zcode/ui/Panel.kt')
  })

  it('无 patches 时审查降级内置弹窗定位', () => {
    setup()
    render(<TurnFileChangesBar fc={summary()} messageId={MSG_A} />)
    fireEvent.click(screen.getByText('2 个文件已更改 · +19 −10'))
    act(() => {
      messageHandler!({
        op: 'turnFileChangesResult',
        sessionId: SID,
        messageId: MSG_A,
        data: {
          files: 1, additions: 6, deletions: 6, state: 'active',
          items: [
            { path: 'src/main/com/zcode/ui/Panel.kt', additions: 6, deletions: 6, writeCount: 2, toolNames: ['Edit'], patches: [] },
          ],
        },
      })
    })
    fireEvent.click(screen.getByText('审查'))
    expect(sentRequests.find((r) => r.op === 'turnFileDiff')).toBeUndefined()
    expect(useStore.getState().turnFileChangesDialogFor).toBe(MSG_A)
    expect(useStore.getState().turnFileChangesDialogPath).toBe('src/main/com/zcode/ui/Panel.kt')
  })

  it('turnFileDiffError（兜底异常）降级内置弹窗定位回显 path', () => {
    setup()
    render(<TurnFileChangesBar fc={summary()} messageId={MSG_A} />)
    fireEvent.click(screen.getByText('2 个文件已更改 · +19 −10'))
    act(() => {
      messageHandler!({
        op: 'turnFileChangesResult',
        sessionId: SID,
        messageId: MSG_A,
        data: {
          files: 1, additions: 6, deletions: 6, state: 'active',
          items: [
            {
              path: 'src/main/com/zcode/ui/Panel.kt', additions: 6, deletions: 6, writeCount: 2,
              toolNames: ['Edit'],
              patches: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' ctx', '+add', '+add2', ' ctx'] }],
            },
          ],
        },
      })
    })
    fireEvent.click(screen.getByText('审查'))
    expect(sentRequests.find((r) => r.op === 'turnFileDiff')).toBeDefined()
    act(() => {
      messageHandler!({
        op: 'turnFileDiffError',
        reason: 'internal',
        path: 'src/main/com/zcode/ui/Panel.kt',
      })
    })
    expect(useStore.getState().turnFileChangesDialogFor).toBe(MSG_A)
    expect(useStore.getState().turnFileChangesDialogPath).toBe('src/main/com/zcode/ui/Panel.kt')
  })

  it('messageId 不匹配的响应不落地（跨卡隔离）', () => {
    setup()
    render(<TurnFileChangesBar fc={summary()} messageId={MSG_A} />)
    fireEvent.click(screen.getByText('2 个文件已更改 · +19 −10'))
    messageHandler!({
      op: 'turnFileChangesResult',
      sessionId: SID,
      messageId: 'msg_other',
      data: { files: 1, additions: 1, deletions: 0, items: [{ path: 'x.txt', additions: 1, deletions: 0, writeCount: 1, toolNames: [], patches: [] }] },
    })
    expect(screen.queryByText('x.txt')).toBeNull()
  })

  it('查询失败：渲染失败文案并停止自动重试（不发第二次请求）；收起再展开=重试', () => {
    setup()
    render(<TurnFileChangesBar fc={summary()} messageId={MSG_A} />)
    fireEvent.click(screen.getByText('2 个文件已更改 · +19 −10'))
    expect(sentRequests.filter((r) => r.op === 'turnFileChanges')).toHaveLength(1)
    act(() => {
      messageHandler!({ op: 'turnFileChangesError', sessionId: SID, messageId: MSG_A, reason: 'revisionUnknown', message: '水位未知' })
    })
    // 失败文案落地、loading 停止
    expect(screen.getByText(/明细加载失败/)).toBeTruthy()
    expect(document.querySelector('.codicon-loading')).toBeNull()
    // 失败后 effect 依赖变化（loading/failed 翻转）不得再发请求（重试风暴回归锚）
    const countAfterError = sentRequests.filter((r) => r.op === 'turnFileChanges').length
    expect(countAfterError).toBe(1)
    // 收起（清失败态）再展开 → 重新发起查询
    fireEvent.click(screen.getByText('2 个文件已更改 · +19 −10')) // 收起
    fireEvent.click(screen.getByText('2 个文件已更改 · +19 −10')) // 再展开
    expect(sentRequests.filter((r) => r.op === 'turnFileChanges')).toHaveLength(2)
  })
})
