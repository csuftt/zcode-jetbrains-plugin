/**
 * 新会话按钮免确认配置（utils/newSessionConfig.ts）读写回归：
 * - 无配置 → 默认关闭（仍弹三选确认）
 * - 损坏 JSON / 字段类型不对 → 回默认
 * - 写入 → localStorage 落盘且可回读
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ---- mock localStorage（node 环境无实现；persist.ts 经 window.localStorage 访问）----
const store = new Map<string, string>()
const lsMock = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  key: (i: number) => Array.from(store.keys())[i] ?? null,
  get length() {
    return store.size
  },
  clear: () => store.clear(),
}
vi.stubGlobal('localStorage', lsMock)
vi.stubGlobal('window', { localStorage: lsMock, dispatchEvent: () => {} })

import {
  readNewSessionConfig,
  writeNewSessionConfig,
  DEFAULT_NEW_SESSION_CONFIG,
} from '@/utils/newSessionConfig'

describe('新会话按钮免确认配置', () => {
  beforeEach(() => {
    store.clear()
  })

  it('无配置时默认关闭（仍弹确认）', () => {
    expect(readNewSessionConfig()).toEqual(DEFAULT_NEW_SESSION_CONFIG)
    expect(DEFAULT_NEW_SESSION_CONFIG).toEqual({ directOverwrite: false })
  })

  it('损坏 JSON 回默认值', () => {
    store.set('zcode.newSession.config', '{not json')
    expect(readNewSessionConfig()).toEqual(DEFAULT_NEW_SESSION_CONFIG)
  })

  it('类型不对的字段回默认（字符串 "true" 不生效）', () => {
    store.set('zcode.newSession.config', JSON.stringify({ directOverwrite: 'true' }))
    expect(readNewSessionConfig().directOverwrite).toBe(false)
  })

  it('写入后回读一致', () => {
    writeNewSessionConfig({ directOverwrite: true })
    expect(readNewSessionConfig()).toEqual({ directOverwrite: true })
    expect(store.get('zcode.newSession.config')).toBeTruthy()
  })
})
