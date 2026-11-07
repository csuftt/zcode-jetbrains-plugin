// @vitest-environment jsdom
/**
 * 色块颜色深度滑条（外观设置页「色块颜色深度」，2026-11-07）
 * 百分比存取/钳制/<style> 双主题注入；持久化经 persistAppearance（mock 模式 no-op 不发桥）。
 * localStorage 手动 stub：node 22 实验性 localStorage 会盖掉 jsdom 实现且缺 clear
 * （breakdown-cache.spec 同款坑）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  getWsColorDepth,
  setWsColorDepth,
  DEFAULT_WS_DEPTH,
  WS_DEPTH_MIN,
  WS_DEPTH_MAX,
  WS_DEPTH_KEY,
  getWsProjectColor,
  setWsProjectColor,
  setWsProjectCustomHex,
  getWsProjectCustomHex,
  WS_PROJECT_KEY,
} from '../src/utils/appearance'

const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
  setItem: (k: string, v: string) => {
    store.set(k, String(v))
  },
  removeItem: (k: string) => {
    store.delete(k)
  },
  clear: () => store.clear(),
})

const styleEl = () => document.getElementById('zcode-ws-depth-style')

describe('色块颜色深度滑条', () => {
  beforeEach(() => {
    store.clear()
    styleEl()?.remove()
  })

  it('缺省回默认 50%（2026-11-06 五轮调色终稿色板）', () => {
    expect(DEFAULT_WS_DEPTH).toBe(50)
    expect(getWsColorDepth()).toBe(DEFAULT_WS_DEPTH)
  })

  it('设置即持久化并注入双主题样式', () => {
    setWsColorDepth(0)
    expect(getWsColorDepth()).toBe(0)
    expect(localStorage.getItem(WS_DEPTH_KEY)).toBe('0')
    const el = styleEl()
    expect(el).not.toBeNull()
    // 双主题规则同写一个 style：暗=:root，浅=:root[data-theme='light']
    expect(el!.textContent).toContain(":root[data-theme='light']")
    expect(el!.textContent).toContain('--ws-dir-1:')
    expect(el!.textContent).toContain('--ws-badge-gold:')
  })

  it('越界钳制到 0..100', () => {
    setWsColorDepth(999)
    expect(getWsColorDepth()).toBe(WS_DEPTH_MAX)
    setWsColorDepth(-1)
    expect(getWsColorDepth()).toBe(WS_DEPTH_MIN)
  })

  it('存储脏值回默认档', () => {
    store.set(WS_DEPTH_KEY, 'abc')
    expect(getWsColorDepth()).toBe(DEFAULT_WS_DEPTH)
    store.set(WS_DEPTH_KEY, '1000')
    expect(getWsColorDepth()).toBe(DEFAULT_WS_DEPTH)
  })
})

describe('默认色块颜色（本项目）', () => {
  beforeEach(() => {
    store.clear()
    document.documentElement.removeAttribute('style')
  })

  it('缺省 -1（默认金黄）且不写 --ws-project-color', () => {
    expect(getWsProjectColor()).toBe(-1)
    setWsProjectColor(-1)
    expect(document.documentElement.style.getPropertyValue('--ws-project-color')).toBe('')
  })

  it('选中色相挂 var 间接引用（深度/主题自动跟随）', () => {
    setWsProjectColor(2)
    expect(getWsProjectColor()).toBe(2)
    expect(localStorage.getItem(WS_PROJECT_KEY)).toBe('2')
    expect(document.documentElement.style.getPropertyValue('--ws-project-color')).toBe('var(--ws-dir-3)')
    setWsProjectColor(8)
    expect(document.documentElement.style.getPropertyValue('--ws-project-color')).toBe('var(--ws-dir-9)')
  })

  it('越界收默认金黄', () => {
    setWsProjectColor(42)
    expect(getWsProjectColor()).toBe(-1)
  })
})

describe('自定义项目色', () => {
  beforeEach(() => {
    store.clear()
    document.documentElement.removeAttribute('style')
  })

  it('合法 hex → 档切 -2 并直接写 --ws-project-color（不参与深度偏移）', () => {
    setWsProjectCustomHex('#AbCdEf')
    expect(getWsProjectColor()).toBe(-2)
    expect(getWsProjectCustomHex()).toBe('#abcdef')
    expect(document.documentElement.style.getPropertyValue('--ws-project-color')).toBe('#abcdef')
  })

  it('空串/非法回默认金黄并移除变量', () => {
    setWsProjectCustomHex('#aabbcc')
    setWsProjectCustomHex('')
    expect(getWsProjectColor()).toBe(-1)
    expect(getWsProjectCustomHex()).toBe('')
    expect(document.documentElement.style.getPropertyValue('--ws-project-color')).toBe('')
    setWsProjectCustomHex('nope')
    expect(getWsProjectColor()).toBe(-1)
  })

  it('切回色相档清掉自定义 hex', () => {
    setWsProjectCustomHex('#aabbcc')
    setWsProjectColor(3)
    expect(getWsProjectColor()).toBe(3)
    expect(getWsProjectCustomHex()).toBe('')
    expect(document.documentElement.style.getPropertyValue('--ws-project-color')).toBe('var(--ws-dir-4)')
  })
})
