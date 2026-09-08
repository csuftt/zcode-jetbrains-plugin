/**
 * 自动归档面板测试（历史视图「自动归档」tab，2026-09-08）
 *
 * 行为：
 *   1. 挂载拉取配置+记录；开关/天数按 store 状态渲染
 *   2. 开关切换 → setAutoArchiveConfig（乐观更新 + 发 op）
 *   3. 立即扫描 → running 态 + runAutoArchiveNow op
 *   4. 记录列表渲染（时间/方式徽标/条数），点击展开看本轮会话明细
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('@/ipc/bridge', () => ({
  sendToJava: vi.fn(),
  isInJcef: () => false,
  onMessage: () => () => {},
  getWorkspacePath: () => 'G:\\mock',
  openExternalUrl: () => {},
}))

import { sendToJava } from '@/ipc/bridge'
import '@/i18n/config'
import { AutoArchivePanel } from '@/components/AutoArchivePanel'
import { useStore } from '@/store/useStore'
import type { AutoArchiveRecord } from '@/types/messages'

const RECORDS: AutoArchiveRecord[] = [
  {
    ts: 1700000000000,
    mode: 'manual',
    days: 7,
    count: 2,
    sessions: [
      { sessionId: 'sess_x1', title: '手动轮会话甲' },
      { sessionId: 'sess_x2', title: '手动轮会话乙' },
    ],
  },
  { ts: 1699990000000, mode: 'auto', days: 7, count: 1, sessions: [{ sessionId: 'sess_y1', title: '定时轮会话' }] },
]

const mockedSend = vi.mocked(sendToJava)

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  useStore.setState({
    autoArchiveConfigLoaded: true,
    autoArchiveEnabled: true,
    autoArchiveDays: 7,
    autoArchiveRecords: RECORDS,
    autoArchiveRunning: false,
    autoArchiveLastRunCount: null,
    autoArchiveLastRunSkipped: false,
  })
})

describe('自动归档面板', () => {
  it('挂载拉取配置+记录，渲染开关/天数/记录列表', () => {
    render(<AutoArchivePanel />)
    expect(mockedSend).toHaveBeenCalledWith({ op: 'getAutoArchiveConfig' })
    expect(mockedSend).toHaveBeenCalledWith({ op: 'getAutoArchiveRecords' })
    expect(screen.getByText('自动归档旧任务')).not.toBeNull()
    expect(screen.getByText('7 天后归档')).not.toBeNull()
    // 两条记录：方式徽标 + 条数
    expect(screen.getByText('手动')).not.toBeNull()
    expect(screen.getByText('定时')).not.toBeNull()
    expect(screen.getAllByText(/归档 \d+ 个/).length).toBe(2)
  })

  it('点击记录行展开会话明细', () => {
    render(<AutoArchivePanel />)
    expect(screen.queryByText('手动轮会话甲')).toBeNull()
    // 第一条记录（manual 轮）的行按钮；时间文案随本地时区变，改用条数徽标定位
    fireEvent.click(screen.getAllByText(/归档 \d+ 个/)[0].closest('button')!)
    expect(screen.getByText('手动轮会话甲')).not.toBeNull()
    expect(screen.getByText('手动轮会话乙')).not.toBeNull()
  })

  it('立即扫描：置 running 并发 op；结果文案按 count 分支', () => {
    render(<AutoArchivePanel />)
    fireEvent.click(screen.getByText('立即扫描'))
    expect(mockedSend).toHaveBeenCalledWith({ op: 'runAutoArchiveNow' })
    expect(useStore.getState().autoArchiveRunning).toBe(true)
    expect(screen.getByText('扫描中…')).not.toBeNull()
  })

  it('关闭开关：乐观更新 + 发 setAutoArchiveConfig', () => {
    render(<AutoArchivePanel />)
    // 开关按钮 title 为 onHint/offHint 缺省 null → 直接找胶囊开关按钮（setting-toggle__switch）
    fireEvent.click(document.querySelector('.setting-toggle__switch')!)
    expect(useStore.getState().autoArchiveEnabled).toBe(false)
    expect(mockedSend).toHaveBeenCalledWith({ op: 'setAutoArchiveConfig', enabled: false, olderThanDays: 7 })
  })

  it('未启用：天数档位仍常显可调，扫描按钮禁用且点击不发 op，给出提示', () => {
    useStore.setState({ autoArchiveEnabled: false })
    render(<AutoArchivePanel />)
    // 天数常显（不再挂开关条件）——开关关着也要看得到保留期
    expect(screen.getByText('7 天后归档')).not.toBeNull()
    const btn = screen.getByText('立即扫描').closest('button') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(mockedSend).not.toHaveBeenCalledWith({ op: 'runAutoArchiveNow' })
    expect(useStore.getState().autoArchiveRunning).toBe(false)
    expect(screen.getByText('开启上方「自动归档旧任务」开关后可手动触发扫描')).not.toBeNull()
  })

  it('skipped 轮：显示未执行提示而非归档数', () => {
    useStore.setState({ autoArchiveEnabled: false, autoArchiveLastRunSkipped: true })
    render(<AutoArchivePanel />)
    expect(screen.getByText('自动归档未启用，本轮扫描未执行')).not.toBeNull()
  })
})
