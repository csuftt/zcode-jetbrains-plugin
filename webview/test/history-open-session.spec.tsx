/**
 * 历史会话打开方式编排测试（HistoryView 点击流，2026-08-30）
 *
 * 行为：
 *   1. 定位命中（任一标签已绑定该会话）→ 不 onSelect，只 onBack（Java 已激活宿主标签，
 *      本标签切回聊天视图）
 *   2. 定位未命中 + 当前标签无真实会话（新标签待命态）→ 直接 onSelect 覆盖打开，无弹窗
 *   3. 定位未命中 + 当前标签已有会话 → 弹「覆盖当前标签页 / 新标签页打开」选择弹窗：
 *      覆盖 → onSelect；新开 → onOpenNewTab（Java gotoSession 统一路径）；都不丢 onBack
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
  }
}

const TARGET = session('sess_target', '目标会话')

function setup(currentSessionId: string | null, onLocate: (sid: string) => Promise<boolean>) {
  const props = {
    sessions: [session('sess_cur', '当前会话'), TARGET],
    archivedSessions: [],
    archivedLoading: false,
    currentSessionId,
    onLocate,
    onOpenNewTab: vi.fn(),
    onSelect: vi.fn(),
    onBack: vi.fn(),
    onArchive: vi.fn(),
    onRestore: vi.fn(),
    onRefresh: vi.fn(),
    onLoadArchived: vi.fn(),
  }
  render(<HistoryView {...props} />)
  return props
}

function clickTarget() {
  fireEvent.click(screen.getByText('目标会话'))
}

beforeEach(() => {
  cleanup()
})

describe('历史会话打开方式编排', () => {
  it('定位命中：不覆盖本标签，只切回聊天视图（跳转由 Java 激活宿主标签完成）', async () => {
    const onLocate = vi.fn().mockResolvedValue(true)
    const props = setup('sess_cur', onLocate)
    clickTarget()
    await waitFor(() => expect(props.onBack).toHaveBeenCalledTimes(1))
    expect(onLocate).toHaveBeenCalledWith('sess_target')
    expect(props.onSelect).not.toHaveBeenCalled()
    expect(props.onOpenNewTab).not.toHaveBeenCalled()
    expect(screen.queryByText('打开会话')).toBeNull()
  })

  it('定位未命中 + 当前标签无真实会话：直接覆盖打开，不打扰', async () => {
    const props = setup(null, vi.fn().mockResolvedValue(false))
    clickTarget()
    await waitFor(() => expect(props.onSelect).toHaveBeenCalledWith(TARGET))
    expect(props.onBack).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('打开会话')).toBeNull()
  })

  it('定位未命中 + 当前标签已有会话：弹窗选「覆盖当前标签页」→ 本标签 onSelect', async () => {
    const props = setup('sess_cur', vi.fn().mockResolvedValue(false))
    clickTarget()
    const dialog = await screen.findByText('打开会话')
    expect(dialog).not.toBeNull()
    fireEvent.click(screen.getByText('覆盖当前标签页'))
    await waitFor(() => expect(props.onSelect).toHaveBeenCalledWith(TARGET))
    expect(props.onBack).toHaveBeenCalledTimes(1)
    expect(props.onOpenNewTab).not.toHaveBeenCalled()
  })

  it('定位未命中 + 当前标签已有会话：弹窗选「新标签页打开」→ gotoSession 通道，本标签不切会话', async () => {
    const props = setup('sess_cur', vi.fn().mockResolvedValue(false))
    clickTarget()
    await screen.findByText('打开会话')
    fireEvent.click(screen.getByText('新标签页打开'))
    await waitFor(() => expect(props.onOpenNewTab).toHaveBeenCalledWith('sess_target'))
    expect(props.onSelect).not.toHaveBeenCalled()
    // 本标签切回聊天视图（保留自己的会话），目标会话在新标签恢复
    expect(props.onBack).toHaveBeenCalledTimes(1)
  })
})
