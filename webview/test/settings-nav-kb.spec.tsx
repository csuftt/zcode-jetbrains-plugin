// @vitest-environment jsdom
/**
 * 设置页左栏的知识库条目，以及「打开知识库设置」的跳转意图：
 * - 图标用工具窗那本书（内联 SVG，与聊天里的知识库工具卡同一个），不再是 codicon-book
 * - pendingSettingsSection='kb'（工具条「同步知识库」没配远端时被带过来）：切到知识库分区，
 *   焦点落到远端地址输入框，意图消费后清掉
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

vi.mock('@/ipc/bridge', () => ({
  sendToJava: () => {},
  isInJcef: () => false,
  onMessage: () => () => {},
}))

import '@/i18n/config'
import { SettingsView } from '@/components/SettingsView'
import { useStore } from '@/store/useStore'

/** jsdom 的 localStorage 是无方法死对象（见项目记忆）：注入 Map 桩，否则默认页签一渲染就炸 */
function installStorageStub() {
  const map = new Map<string, string>()
  const stub = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, String(v)) },
    removeItem: (k: string) => { map.delete(k) },
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size },
  }
  Object.defineProperty(window, 'localStorage', { configurable: true, value: stub })
}
installStorageStub()

describe('设置页左栏与知识库跳转', () => {
  afterEach(() => {
    cleanup()
    useStore.setState({ pendingSettingsSection: null })
  })

  it('知识库条目的图标是工具窗那本书，不再是 codicon-book', () => {
    const { container } = render(<SettingsView onBack={() => {}} />)
    const icon = container.querySelector('.settings-view__nav-item svg.settings-view__nav-kb')
    expect(icon).not.toBeNull()
    const kbItem = icon!.closest('.settings-view__nav-item')!
    expect(kbItem.querySelector('.codicon-book')).toBeNull()
    expect(container.querySelectorAll('.settings-view__nav-item')).toHaveLength(13)
  })

  it('跳转意图 kb：切到知识库分区、焦点落在远端地址输入框、意图被消费', () => {
    useStore.setState({ pendingSettingsSection: 'kb' })
    const { container } = render(<SettingsView onBack={() => {}} />)
    expect(container.querySelector('.kb-settings')).not.toBeNull()
    const input = container.querySelector('.kb-settings .basic-settings__path-input') as HTMLInputElement | null
    expect(input).not.toBeNull()
    expect(document.activeElement).toBe(input)
    expect(useStore.getState().pendingSettingsSection).toBeNull()
  })

  it('没有跳转意图时进设置页不抢焦点', () => {
    useStore.setState({ pendingSettingsSection: null })
    render(<SettingsView onBack={() => {}} />)
    expect(document.activeElement).not.toBe(document.querySelector('.basic-settings__path-input'))
  })
})
