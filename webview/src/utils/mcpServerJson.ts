/**
 * MCP 服务器 JSON 粘贴解析/序列化（编辑弹窗 JSON 模式共用纯函数）
 *
 * zcode CLI 解析配置时会剥掉 mcpServers 外层，编辑器粘贴同样宽容，兼容三种形态：
 *   ① {"server-name": {command...}}         —— 官方客户端「完整配置」形态（name 为键）
 *   ② {"mcpServers": {"server-name": ...}}  —— .mcp.json 标准格式整块粘贴
 *   ③ {"name": "server-name", command...}   —— 旧版弹窗序列化形态（name 写对象里）
 * 序列化一律产出①（与官方编辑弹窗 JSON 形态一致）。
 */

export type ParsedServerJson =
  | { ok: true; name: string; entry: Record<string, unknown> }
  | { ok: false; code: 'parse' | 'invalid' | 'multi'; message?: string }

export function parseServerJson(text: string): ParsedServerJson {
  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch (e) {
    return { ok: false, code: 'parse', message: (e as Error).message }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, code: 'invalid' }
  let body = obj as Record<string, unknown>
  // ② mcpServers 包裹：剥外层（顶层其余键忽略）
  const wrapper = body.mcpServers
  if (wrapper && typeof wrapper === 'object' && !Array.isArray(wrapper)) {
    body = wrapper as Record<string, unknown>
  }
  // ③ name 写对象里且 command/url 可辨认 → 提取后剥离（与外层键一致的要求在 Kotlin 校验）
  if (
    typeof body.name === 'string' &&
    (typeof body.command === 'string' || typeof body.url === 'string')
  ) {
    const entry = { ...body }
    const name = entry.name as string
    delete entry.name
    return { ok: true, name: name.trim(), entry }
  }
  // ① name 为键的单服务器映射（多键拒绝——弹窗一次只管一条）
  const keys = Object.keys(body).filter(
    (k) => body[k] !== null && typeof body[k] === 'object' && !Array.isArray(body[k]),
  )
  if (keys.length !== 1 || !keys[0].trim()) return { ok: false, code: keys.length > 1 ? 'multi' : 'invalid' }
  return { ok: true, name: keys[0].trim(), entry: body[keys[0]] as Record<string, unknown> }
}

/** 表单状态 → JSON 文本（官方 name 为键形态；名称未填时退化为裸条目） */
export function serializeServerJson(name: string, entry: Record<string, unknown>): string {
  const clean = { ...entry }
  delete clean.name
  const trimmed = name.trim()
  return JSON.stringify(trimmed ? { [trimmed]: clean } : clean, null, 2)
}
