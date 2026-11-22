/**
 * 知识库（ZC-GUI）MCP 工具族共享工具函数（对齐 cuaTools 的职责面）。
 *
 * 工具名双形态（CLI 版本差异，真机截图实锤 `MCP.zcgui-knowledge_kb_list`）：
 *   - mcp__zcgui-knowledge__kb_search（3.17.x 拼法）
 *   - MCP.zcgui-knowledge_kb_search（3.18+/新版拼法）
 * 动词摘要硬编码中文（cuaActionSummary 硬编码先例；主体是 query/path 等数据）。
 */

const KB_TOOL_PREFIXES = ['mcp__zcgui-knowledge__', 'MCP.zcgui-knowledge_']

export function isKbTool(tool: string): boolean {
  return KB_TOOL_PREFIXES.some((p) => tool.startsWith(p))
}

/** 工具短名（MCP.zcgui-knowledge_kb_search → kb_search）*/
export function kbToolShortName(tool: string): string {
  const p = KB_TOOL_PREFIXES.find((x) => tool.startsWith(x))
  return p ? tool.slice(p.length) : tool
}

/** 中文友好名（单卡标题/组卡 header）*/
const KB_LABELS: Record<string, string> = {
  kb_search: '知识库检索',
  kb_read: '知识库读全文',
  kb_list: '知识库浏览',
  kb_tree: '知识库目录结构',
  kb_folder: '目录管理',
  kb_entry: '条目管理',
  kb_tag: '标签管理',
  kb_add: '知识库收录',
}

export function kbToolLabel(tool: string): string {
  return KB_LABELS[kbToolShortName(tool)] ?? kbToolShortName(tool)
}

function idsCount(input: Record<string, unknown> | undefined): number {
  const ids = input?.ids
  return Array.isArray(ids) ? ids.length : 0
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback
}

/**
 * 一行动作摘要（组卡成员行 + 单卡副标题）。kb_add/kb_entry/kb_folder/kb_tag 的
 * action 维度展开为中文动宾；数据（query/路径/标签名）原样呈现。
 */
export function kbActionSummary(tool: string, input?: Record<string, unknown>): string {
  if (!input) return ''
  const short = kbToolShortName(tool)
  switch (short) {
    case 'kb_search': {
      const q = str(input.query)
      if (!q) return ''
      const filter = str(input.folder) || str(input.tag) || str(input.project)
      return filter ? `检索「${q}」 · ${filter}` : `检索「${q}」`
    }
    case 'kb_read':
      return `读全文 ${str(input.id, '')}`
    case 'kb_list': {
      const f = str(input.folder)
      const tag = str(input.tag)
      if (!f && !tag) return '浏览全部'
      return tag ? `浏览 · 标签 ${tag}` : `浏览「${f}」`
    }
    case 'kb_tree':
      return '目录结构总览'
    case 'kb_folder': {
      const p = str(input.path)
      switch (str(input.action)) {
        case 'create': return `新建目录 ${p}`
        case 'rename': return `重命名目录 ${p} → ${str(input.newName)}`
        case 'move': {
          const to = str(input.newPath) || '根目录'
          return `移动目录 ${p} → ${to}`
        }
        case 'delete': return `删除目录 ${p}`
        default: return p
      }
    }
    case 'kb_entry': {
      const n = idsCount(input)
      switch (str(input.action)) {
        case 'move': {
          const to = str(input.folderPath) || '根目录'
          return `移动 ${n} 条 → ${to}`
        }
        case 'update': {
          const what = input.tags !== undefined ? '改标签' : input.notes !== undefined ? '写备注' : input.title !== undefined ? '改标题' : '更新'
          return `更新 ${n} 条（${what}）`
        }
        case 'delete': return `摘除 ${n} 条`
        default: return `${n} 条`
      }
    }
    case 'kb_tag': {
      const name = str(input.name)
      switch (str(input.action)) {
        case 'create': return `新建标签「${name}」`
        case 'rename': return `重命名标签「${name}」→ ${str(input.newName)}`
        case 'delete': return `删除标签「${name}」`
        case 'color': return `标签「${name}」改色`
        default: return name
      }
    }
    case 'kb_add': {
      const p = str(input.path)
      const file = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p
      return `收录 ${file}`
    }
    default:
      return ''
  }
}
