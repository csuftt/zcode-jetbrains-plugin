/**
 * MCP 工具入参表推导（utils/mcpSchema.ts）回归：
 *   properties+required 展开、联合类型、缺省 type、无 schema/空 properties → null
 *   （McpToolDetailDialog 据此显示「无入参」）、hasRawSchema 与无入参互斥。
 */
import { describe, it, expect } from 'vitest'
import { hasRawSchema, schemaToRows } from '@/utils/mcpSchema'

describe('schemaToRows', () => {
  it('展开 properties 与 required', () => {
    const rows = schemaToRows({
      type: 'object',
      properties: {
        query: { type: 'string', description: '查询语句' },
        limit: { type: 'number', description: '条数' },
      },
      required: ['query'],
    })
    expect(rows).toEqual([
      { name: 'query', type: 'string', required: true, description: '查询语句' },
      { name: 'limit', type: 'number', required: false, description: '条数' },
    ])
  })

  it('联合类型 join 且忽略非字符串元素', () => {
    const rows = schemaToRows({ properties: { v: { type: ['string', 'null'] } } })
    expect(rows?.[0].type).toBe('string | null')
    expect(rows?.[0].required).toBe(false)
    expect(rows?.[0].description).toBe('')
  })

  it('schema 为 JSON 字符串形态时解析展开（个别服务器字符串透传）', () => {
    const text = JSON.stringify({
      type: 'object',
      properties: { query: { type: 'string', description: 'd1' } },
      required: ['query'],
    })
    expect(schemaToRows(text)).toEqual([
      { name: 'query', type: 'string', required: true, description: 'd1' },
    ])
    expect(schemaToRows('not-json')).toBeNull()
  })

  it('缺省 type 显示 any；非对象属性节点不炸', () => {
    const rows = schemaToRows({ properties: { a: {}, b: 'junk' } })
    expect(rows).toEqual([
      { name: 'a', type: 'any', required: false, description: '' },
      { name: 'b', type: 'any', required: false, description: '' },
    ])
  })

  it('无 schema / 非对象 / properties 缺失 / 空 properties → null（UI 显示无入参）', () => {
    expect(schemaToRows(undefined)).toBeNull()
    expect(schemaToRows(null)).toBeNull()
    expect(schemaToRows('junk' as unknown as Record<string, unknown>)).toBeNull()
    expect(schemaToRows({ type: 'object' })).toBeNull()
    expect(schemaToRows({ properties: {} })).toBeNull()
  })
})

describe('hasRawSchema', () => {
  it('与无入参提示互斥：空对象/缺失为 false，有键为 true', () => {
    expect(hasRawSchema(undefined)).toBe(false)
    expect(hasRawSchema({})).toBe(false)
    expect(hasRawSchema({ type: 'object' })).toBe(true)
    expect(hasRawSchema({ properties: { a: { type: 'string' } } })).toBe(true)
  })
})
