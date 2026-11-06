/**
 * MCP 工具 inputSchema → 入参表行推导（McpToolDetailDialog 数据整形，纯函数）
 *
 * JSON Schema 形态（tools/list 原样透传）：{properties: {名: {type, description}},
 * required: [名]}。只展开一层 properties（嵌套 object/array 类型列标注类型名，
 * 结构细节看折叠的原始 Schema）。
 */

export interface McpParamRow {
  name: string
  /** 类型名；联合类型 "string | null"，声明缺省 "any" */
  type: string
  required: boolean
  description: string
}

type JsonSchemaLike = {
  properties?: Record<string, unknown>
  required?: unknown
}

/** 单个属性节点的 type 字段 → 展示串（数组 = 联合类型；缺省 any）*/
function typeLabel(type: unknown): string {
  if (typeof type === 'string' && type) return type
  if (Array.isArray(type)) {
    const parts = type.filter((x): x is string => typeof x === 'string')
    if (parts.length > 0) return parts.join(' | ')
  }
  return 'any'
}

/**
 * schema → 参数行；无 schema / properties 为空对象 → null（UI 显示「无入参」）
 * 兼容 schema 为 JSON 字符串的形态（个别 MCP 服务器把 inputSchema 编码为字符串透传）。
 */
export function schemaToRows(schema: Record<string, unknown> | string | undefined | null): McpParamRow[] | null {
  let s0: unknown = schema
  if (typeof s0 === 'string') {
    try {
      s0 = JSON.parse(s0)
    } catch {
      return null
    }
  }
  if (!s0 || typeof s0 !== 'object' || Array.isArray(s0)) return null
  const s = s0 as JsonSchemaLike
  const props = s.properties
  if (!props || typeof props !== 'object' || Array.isArray(props)) return null
  const entries = Object.entries(props)
  if (entries.length === 0) return null
  const requiredSet =
    Array.isArray(s.required)
      ? new Set(s.required.filter((x): x is string => typeof x === 'string'))
      : new Set<string>()
  return entries.map(([name, def]) => {
    const d = (def && typeof def === 'object' ? def : {}) as { type?: unknown; description?: unknown }
    return {
      name,
      type: typeLabel(d.type),
      required: requiredSet.has(name),
      description: typeof d.description === 'string' ? d.description : '',
    }
  })
}

/** schema 存在且有内容才给「原始入参 Schema」折叠区用（与无入参提示互斥的判据）*/
export function hasRawSchema(schema: Record<string, unknown> | string | undefined | null): boolean {
  if (typeof schema === 'string') return schema.trim().length > 0
  return !!schema && typeof schema === 'object' && Object.keys(schema).length > 0
}
