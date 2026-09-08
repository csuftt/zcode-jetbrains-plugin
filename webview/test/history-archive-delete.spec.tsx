/**
 * 归档会话删除流测试（HistoryView × SessionItem，2026-09-08）
 *
 * 行为：
 *   1. 归档 tab 条目级删除：点 trash → danger 确认弹窗 → 确认 → onDeleteArchived 调用一次
 *   2. 弹窗取消 → 不调用
 *   3. 批量删除：多选模式勾选 N 项 → 「删除所选」→ 确认 → 每个选中 id 各调用一次
 *
 * 语义对齐：归档页删除 = ZCode 客户端软删（tasks.deleted=1 数据保留），确认文案为
 * 「仅从列表移除」而非「不可撤销」；删除语义重于还原，不走 SessionItem 的 3s 内联轻确认。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

vi.mock('@/ipc/bridge', () => ({
  sendToJava: () => {},
  isInJcef: () => false,
  onMessage: () => () => {},
}))

import '@/i18n/config'
import { HistoryView } from '@/components/HistoryView'
import type { SessionInfo } from '@/types/messages'

function session(id: string, title: string): SessionInfo {
  return {
    sessionId: id,
    title,
    status: 'idle',
    mode: 'yolo',
    workspacePath: 'G:\\mock',
    createdAt: 1,
    updatedAt: 1,
    archivedAt: 1,
  }
}

const ARCH_A = session('sess_a', '归档会话甲')
const ARCH_B = session('sess_b', '归档会话乙')

function setupArchivedTab() {
  const props = {
    sessions: [],
    archivedSessions: [ARCH_A, ARCH_B],
    archivedLoading: false,
    currentSessionId: null,
    onLocate: vi.fn().mockResolvedValue(false),
    onOpenNewTab: vi.fn(),
    onSelect: vi.fn(),
    onBack: vi.fn(),
    onArchive: vi.fn(),
    onRestore: vi.fn(),
    onDeleteArchived: vi.fn(),
    onRefresh: vi.fn(),
    onLoadArchived: vi.fn(),
  }
  render(<HistoryView {...props} />)
  // 切到「已归档」tab
  fireEvent.click(screen.getByText('已归档'))
  return props
}

beforeEach(() => {
  cleanup()
})

describe('归档会话删除流', () => {
  it('条目级删除：trash → danger 确认弹窗 → 确认 → onDeleteArchived 调用一次', async () => {
    const props = setupArchivedTab()
    expect(await screen.findByText('归档会话甲')).not.toBeNull()
    // 两个条目各有一个 trash 按钮，取第一个（甲）
    fireEvent.click(screen.getAllByTitle('删除')[0])
    // danger 弹窗文案（软删语义：仅从列表移除，数据保留）
    expect(await screen.findByText('确认删除')).not.toBeNull()
    expect(screen.getByText(/仅从列表移除/)).not.toBeNull()
    fireEvent.click(screen.getByText('删除', { selector: 'button' }))
    await waitFor(() => expect(props.onDeleteArchived).toHaveBeenCalledTimes(1))
    expect(props.onDeleteArchived).toHaveBeenCalledWith('sess_a')
    expect(props.onRestore).not.toHaveBeenCalled()
  })

  it('弹窗取消：不触发删除', async () => {
    const props = setupArchivedTab()
    fireEvent.click(screen.getAllByTitle('删除')[0])
    await screen.findByText('确认删除')
    fireEvent.click(screen.getByText('取消'))
    await waitFor(() => expect(screen.queryByText('确认删除')).toBeNull())
    expect(props.onDeleteArchived).not.toHaveBeenCalled()
  })

  it('批量删除：多选两项 → 删除所选 → 确认 → 逐 id 调用', async () => {
    const props = setupArchivedTab()
    fireEvent.click(await screen.findByText('多选'))
    fireEvent.click(screen.getByText('归档会话甲'))
    fireEvent.click(screen.getByText('归档会话乙'))
    fireEvent.click(screen.getByText('删除所选'))
    await screen.findByText('确认删除')
    fireEvent.click(screen.getByText('删除', { selector: 'button' }))
    await waitFor(() => expect(props.onDeleteArchived).toHaveBeenCalledTimes(2))
    expect(props.onDeleteArchived).toHaveBeenCalledWith('sess_a')
    expect(props.onDeleteArchived).toHaveBeenCalledWith('sess_b')
  })
})
