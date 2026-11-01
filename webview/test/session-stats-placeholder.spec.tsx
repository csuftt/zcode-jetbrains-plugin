/**
 * 会话列表统计占位测试（SessionItem meta 行，2026-11-01）
 *
 * 行为（列表响应不等后台 stats 计算（全库直读 3~4s）的懒加载机制，防统计到达时
 * meta 行从无到有引发布局跳动）：
 *   1. 统计未就绪（sessionStatsReady=false 且条目无统计）→ meta 行渲染 * 占位
 *   2. 运行中会话：占位与运行中徽标共存（* 条消息 · * MB · 运行中）
 *   3. sessionStatsPatch 合并后（就绪+真值）→ 占位消失，渲染真实消息数/大小
 *   4. 就绪后仍无统计的条目（乐观新建会话等）→ meta 行整行隐藏（原行为不回退）
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('@/ipc/bridge', () => ({
  sendToJava: () => {},
  isInJcef: () => false,
  onMessage: () => () => {},
}))

import '@/i18n/config'
import { SessionItem } from '@/components/SessionItem'
import { useStore } from '@/store/useStore'
import type { SessionInfo } from '@/types/messages'

function session(partial: Partial<SessionInfo>): SessionInfo {
  return {
    sessionId: 'sess_stats',
    title: '统计占位会话',
    status: 'idle',
    mode: 'yolo',
    workspacePath: 'G:\\mock',
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  }
}

const noop = () => {}

function renderItem(s: SessionInfo) {
  return render(<SessionItem session={s} active={false} onSelect={noop} />)
}

beforeEach(() => {
  cleanup()
  useStore.setState({ sessionStatsReady: false })
})

describe('会话列表统计占位', () => {
  it('统计未就绪：meta 行渲染 * 占位而非整行隐藏', () => {
    renderItem(session({}))
    expect(screen.getByText('* 条消息 · * MB')).not.toBeNull()
  })

  it('运行中会话：占位与运行中徽标共存', () => {
    renderItem(session({ status: 'running' }))
    expect(screen.getByText('* 条消息 · * MB')).not.toBeNull()
    expect(screen.getByText('运行中')).not.toBeNull()
  })

  it('统计就绪（patch 合并后）：占位消失，渲染真实消息数与大小', () => {
    useStore.setState({ sessionStatsReady: true })
    renderItem(session({ messageCount: 3, sizeBytes: 46_300 }))
    expect(screen.queryByText('* 条消息 · * MB')).toBeNull()
    expect(screen.getByText('3 条消息')).not.toBeNull()
    expect(screen.getByText('45.2 KB')).not.toBeNull()
  })

  it('就绪后仍无统计的条目（乐观新建会话）：meta 行整行隐藏', () => {
    useStore.setState({ sessionStatsReady: true })
    renderItem(session({}))
    expect(screen.queryByText('* 条消息 · * MB')).toBeNull()
    expect(screen.queryByText(/条消息/)).toBeNull()
    expect(screen.queryByText('运行中')).toBeNull()
  })
})
