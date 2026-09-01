import { describe, expect, it } from 'vitest'
import { compactTokens } from '../src/utils/time'

/** compactTokens token 数紧凑格式：消息统计 footer / 子代理通知卡 / 压缩分隔卡统一口径 */
describe('compactTokens token 紧凑格式', () => {
  it('千以下原样整数', () => {
    expect(compactTokens(0)).toBe('0')
    expect(compactTokens(87)).toBe('87')
    expect(compactTokens(999)).toBe('999')
  })

  it('千级：k 一位小数（4345 → 4.3k，461579 → 461.6k）', () => {
    expect(compactTokens(4345)).toBe('4.3k')
    expect(compactTokens(4000)).toBe('4k') // 尾零 .0 去掉
    expect(compactTokens(461579)).toBe('461.6k')
    expect(compactTokens(999999)).toBe('1000k') // 999,999 四舍五入进位，仍是 k 级
  })

  it('百万级：切 m 单位（4,615,790 → 4.6m）', () => {
    expect(compactTokens(1_000_000)).toBe('1m')
    expect(compactTokens(4_615_790)).toBe('4.6m')
  })
})
