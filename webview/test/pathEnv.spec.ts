/**
 * 占位符路径展开纯函数测试（缺陷 GY）
 */
import { describe, expect, it } from 'vitest'
import { expandPathPlaceholders, hasPathPlaceholder } from '@/utils/pathEnv'

const ENV = { TEMP: 'C:/Users/demo/AppData/Local/Temp', TMPDIR: '/tmp', HOME: '/home/demo' }

describe('hasPathPlaceholder', () => {
  it('三种形态命中', () => {
    expect(hasPathPlaceholder('%TEMP%\\a.md')).toBe(true)
    expect(hasPathPlaceholder('$TMPDIR/a.md')).toBe(true)
    expect(hasPathPlaceholder('${TMPDIR}/a.md')).toBe(true)
  })
  it('普通路径与孤立 % 不命中', () => {
    expect(hasPathPlaceholder('C:/Users/demo/a.md')).toBe(false)
    expect(hasPathPlaceholder('50%off.md')).toBe(false)
  })
})

describe('expandPathPlaceholders', () => {
  it('Windows/Unix 展开', () => {
    // 契约 = 字面替换不归一斜杠（斜杠归一由调用方 resolveFileLink/resolvePreviewPath 下游做）
    expect(expandPathPlaceholders('%TEMP%/a.md', ENV)).toBe('C:/Users/demo/AppData/Local/Temp/a.md')
    expect(expandPathPlaceholders('$TMPDIR/a.md', ENV)).toBe('/tmp/a.md')
    expect(expandPathPlaceholders('${TMPDIR}/a.md', ENV)).toBe('/tmp/a.md')
    expect(expandPathPlaceholders('%TEMP%\\a.md', ENV)).toBe('C:/Users/demo/AppData/Local/Temp\\a.md')
  })
  it('小写变量名兜底大写键（Windows env 约定全大写）', () => {
    expect(expandPathPlaceholders('%temp%/a.md', ENV)).toBe('C:/Users/demo/AppData/Local/Temp/a.md')
  })
  it('相邻组合变量拼接（与 cmd 语义一致）', () => {
    const vars = { DRIVE: 'C:', SEG: '\\Users\\demo' }
    expect(expandPathPlaceholders('%DRIVE%%SEG%\\a.md', vars)).toBe('C:\\Users\\demo\\a.md')
  })
  it('vars=null（白名单未到）原样返回', () => {
    expect(expandPathPlaceholders('%TEMP%/a.md', null)).toBe('%TEMP%/a.md')
    expect(expandPathPlaceholders('%TEMP%/a.md', undefined)).toBe('%TEMP%/a.md')
  })
  it('未知变量原样保留（调用方以 hasPathPlaceholder 复检判不可解析）', () => {
    const out = expandPathPlaceholders('%UNKNOWN_VAR%/a.md', ENV)
    expect(out).toBe('%UNKNOWN_VAR%/a.md')
    expect(hasPathPlaceholder(out)).toBe(true)
  })
  it('无占位符原样返回', () => {
    expect(expandPathPlaceholders('C:/x/a.md', ENV)).toBe('C:/x/a.md')
  })
})
