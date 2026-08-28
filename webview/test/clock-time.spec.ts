import { describe, expect, it } from 'vitest'
import { clockTime } from '../src/utils/time'

/** clockTime 日期感知：今天 HH:mm / 今年非今天 MM-DD HH:mm / 跨年带年份 */
describe('clockTime 消息时间戳', () => {
  // 固定"现在"= 2026-08-28 18:30 本地时间，测试结果不受运行日期影响
  const now = new Date(2026, 7, 28, 18, 30).getTime()

  it('今天的消息只显示 HH:mm', () => {
    const ts = new Date(2026, 7, 28, 9, 5).getTime()
    expect(clockTime(ts, now)).toBe('09:05')
  })

  it('今年非今天的消息显示 MM-DD HH:mm', () => {
    const ts = new Date(2026, 7, 25, 14, 35).getTime()
    expect(clockTime(ts, now)).toBe('08-25 14:35')
  })

  it('跨年的消息带年份', () => {
    const ts = new Date(2025, 11, 31, 23, 59).getTime()
    expect(clockTime(ts, now)).toBe('2025-12-31 23:59')
  })

  it('自然日边界：昨天最后一分钟不算今天', () => {
    const ts = new Date(2026, 7, 27, 23, 59).getTime()
    expect(clockTime(ts, now)).toBe('08-27 23:59')
  })

  it('无效时间戳返回空串', () => {
    expect(clockTime(0, now)).toBe('')
  })
})
