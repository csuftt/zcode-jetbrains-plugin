import { describe, expect, it } from 'vitest'
import { normalizeWsKey, resolveWsColorIndex, WS_PALETTE_SIZE } from '../src/utils/wsColors'

/** 目录统一配色取色助手（2026-11-02）：三处渲染点（徽标/chips/Java 标签块）同源映射 */
describe('normalizeWsKey', () => {
  it('反斜杠转正斜杠、去尾斜杠、小写折叠（与 Java wsKey 同口径）', () => {
    expect(normalizeWsKey('E:\\Work\\Proj\\')).toBe('e:/work/proj')
    expect(normalizeWsKey('e:/work/proj')).toBe('e:/work/proj')
  })
})

describe('resolveWsColorIndex', () => {
  it('命中映射返回归一后的色板序号', () => {
    const colors = { 'e:/work/proj': 3 }
    expect(resolveWsColorIndex('E:\\Work\\Proj\\', colors)).toBe(3)
  })

  it('越界序号按色板大小取模归正（防脏数据越界无对应 CSS 类）', () => {
    expect(resolveWsColorIndex('e:/a', { 'e:/a': 11 })).toBe(2)
    expect(resolveWsColorIndex('e:/a', { 'e:/a': -1 })).toBe(-1, '金黄哨兵直通（目录序列成员）')
    expect(resolveWsColorIndex('e:/a', { 'e:/a': -10 })).toBe(8, '其余负值仍取模归正')
  })

  it('未命中/空目录/非数值返回 null（调用方回落默认主题色）', () => {
    expect(resolveWsColorIndex('e:/missing', { 'e:/other': 1 })).toBeNull()
    expect(resolveWsColorIndex('', { '': 1 })).toBeNull()
    expect(resolveWsColorIndex('e:/a', { 'e:/a': Number.NaN })).toBeNull()
  })
})
