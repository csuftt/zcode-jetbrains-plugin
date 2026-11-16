/**
 * worktree chip 起点渲染回归（spec #52 追评「拿不到就不显示」）
 *
 * 背景（0.4.6 缺陷评审 2026-11-16）：桌面端承接行的 startRef/startSha 曾传空串，
 * 前端兜底 'HEAD' 渲染出随副本演进漂移的假起点；同期树节点显示 reflog 首条，
 * 两个口径并存。修复后 Java 侧注入 reflog 首条，前端对缺失起点不再兜底 'HEAD'。
 *
 * 覆盖：
 * 1. startRef+startSha 齐 → 「⎇ 桶 · 基于 main@sha7」
 * 2. startRef 空 + startSha → 「基于 HEAD@sha7」（游离 detached 副本的合法形态）
 * 3. 双空 → 只显桶，无「基于」段、无 HEAD 字样（本次回归核心）
 * 4. startSha 缺、startRef 显式（老条目）→ 退化只显 ref，不兜 HEAD
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

vi.mock('@/ipc/bridge', () => ({
  sendToJava: vi.fn(),
  isInJcef: () => false,
  onMessage: () => () => {},
}))

import '@/i18n/config'
import { SessionItem } from '@/components/SessionItem'
import type { SessionInfo, WorktreeMeta } from '@/types/messages'

function sessionWithWorktree(wt: Partial<WorktreeMeta>): SessionInfo {
  return {
    sessionId: 'sess_wt_chip',
    title: '副本会话',
    status: 'idle',
    mode: 'yolo',
    workspacePath: 'G:\\repo',
    createdAt: 1,
    updatedAt: 1,
    worktree: {
      sourceWorkspace: 'G:\\repo',
      cwd: 'C:\\wt\\repo',
      worktreeRoot: 'C:\\wt\\repo',
      bucket: 'a1b2',
      ...wt,
    } as WorktreeMeta,
  }
}

function chipText(): string {
  const el = document.querySelector('.session-item__worktree-chip')
  if (!el) throw new Error('worktree chip 未渲染')
  return el.textContent ?? ''
}

beforeEach(() => {
  cleanup()
})

describe('worktree chip 起点渲染（spec #52 追评：拿不到就不显示）', () => {
  it('startRef+startSha 齐：⎇ 桶 · 基于 main@sha7', () => {
    render(
      <SessionItem
        session={sessionWithWorktree({ startRef: 'main', startSha: 'abcdef1234567890' })}
        active={false}
        onSelect={vi.fn()}
      />,
    )
    expect(chipText()).toContain('a1b2 · 基于 main@abcdef1')
  })

  it('startRef 空 + startSha：退「基于 HEAD@sha7」（游离 detached 合法形态）', () => {
    render(
      <SessionItem
        session={sessionWithWorktree({ startRef: '', startSha: 'abcdef1234567890' })}
        active={false}
        onSelect={vi.fn()}
      />,
    )
    expect(chipText()).toContain('基于 HEAD@abcdef1')
  })

  it('startRef/startSha 双空：只显桶，不渲染「基于」段、无 HEAD 字样', () => {
    render(
      <SessionItem
        session={sessionWithWorktree({ startRef: '', startSha: '' })}
        active={false}
        onSelect={vi.fn()}
      />,
    )
    const text = chipText()
    expect(text).toContain('a1b2')
    expect(text).not.toContain('基于')
    expect(text).not.toContain('HEAD')
  })

  it('startSha 缺、startRef 显式（老条目）：退化只显 ref，不兜 HEAD', () => {
    render(
      <SessionItem
        session={sessionWithWorktree({ startRef: 'main', startSha: '' })}
        active={false}
        onSelect={vi.fn()}
      />,
    )
    expect(chipText()).toContain('基于 main')
    expect(chipText()).not.toContain('HEAD')
  })

  it('tooltip 首行=副本路径，次行=源工作区（spec 追评：副本路径 + 源工作区）', () => {
    render(
      <SessionItem
        session={sessionWithWorktree({ startRef: 'main', startSha: 'abcdef1234567890' })}
        active={false}
        onSelect={vi.fn()}
      />,
    )
    const el = document.querySelector('.session-item__worktree-chip') as HTMLElement
    const lines = (el.getAttribute('title') ?? '').split('\n')
    expect(lines[0]).toBe('C:\\wt\\repo')
    expect(lines[1]).toContain('G:\\repo')
  })
})
