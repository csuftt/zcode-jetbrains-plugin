/**
 * MCP 服务器 JSON 粘贴解析/序列化（utils/mcpServerJson.ts，编辑弹窗 JSON 模式）回归：
 *   name 为键的官方形态、mcpServers 外层包裹（zcode 剥外层解析，编辑器同样宽容）、
 *   旧版 name 写对象里形态、多服务器拒绝、裸条目退化、序列化产出 name 为键。
 */
import { describe, it, expect } from 'vitest'
import { parseServerJson, serializeServerJson } from '@/utils/mcpServerJson'

describe('parseServerJson', () => {
  it('解析官方形态：服务器名为键', () => {
    const parsed = parseServerJson(JSON.stringify({
      obsidian: { type: 'http', url: 'https://127.0.0.1:27124/mcp/', headers: { Authorization: 'Bearer x' } },
    }))
    expect(parsed).toEqual({
      ok: true,
      name: 'obsidian',
      entry: { type: 'http', url: 'https://127.0.0.1:27124/mcp/', headers: { Authorization: 'Bearer x' } },
    })
  })

  it('剥掉 mcpServers 外层包裹', () => {
    const parsed = parseServerJson(JSON.stringify({
      mcpServers: { 'my-server': { command: 'npx', args: ['-y', 'pkg'] } },
    }))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.name).toBe('my-server')
      expect(parsed.entry).toEqual({ command: 'npx', args: ['-y', 'pkg'] })
    }
  })

  it('兼容旧版 name 写对象里的形态并提取剥离', () => {
    const parsed = parseServerJson(JSON.stringify({ name: 'legacy', command: 'node', args: ['s.js'] }))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.name).toBe('legacy')
      expect(parsed.entry).toEqual({ command: 'node', args: ['s.js'] })
      expect('name' in parsed.entry).toBe(false)
    }
  })

  it('多服务器拒绝（multi）', () => {
    const parsed = parseServerJson(JSON.stringify({
      mcpServers: { a: { command: 'x' }, b: { command: 'y' } },
    }))
    expect(parsed).toEqual({ ok: false, code: 'multi' })
  })

  it('坏 JSON 与非对象与空对象报错', () => {
    expect(parseServerJson('{ not json').ok).toBe(false)
    expect(parseServerJson('[]').ok).toBe(false)
    expect(parseServerJson('{}').ok).toBe(false)
    expect(parseServerJson('{"not-a-server": "text"}').ok).toBe(false)
  })
})

describe('serializeServerJson', () => {
  it('产出服务器名为键的形态且剥离条目内 name', () => {
    const text = serializeServerJson('srv', { name: 'srv', command: 'npx', cwd: '~/x' })
    expect(JSON.parse(text)).toEqual({ srv: { command: 'npx', cwd: '~/x' } })
  })

  it('名称未填退化为裸条目', () => {
    expect(JSON.parse(serializeServerJson('  ', { command: 'npx' }))).toEqual({ command: 'npx' })
  })
})
