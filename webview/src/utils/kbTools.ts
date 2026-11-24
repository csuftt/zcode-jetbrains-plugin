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

// ───────────── 展开区的友好渲染：结果解析、参数与回执 ─────────────
// 工具输出是 MCP 结果里的那段文本：检索/浏览是条目行数组，目录结构是一个对象，
// 整理类工具是 {moved: n} / {ok: "..."} 这样的回执，读全文是「头信息 + 空行 + 正文」。
// 解析不出来（流式半截、形状变了）一律返回 null，由渲染层回退原文。

/** kb_search / kb_list 的一行 */
export interface KbRow {
  id: string
  title: string
  /** 展示路径（信创适配/中间件）；根级为空串 */
  folder: string
  tags: string[]
  project: string
  /** ok | snapshot | missing */
  status: string
  sourcePath: string
  contentPath: string
  /** 仅检索结果带：命中片段 */
  snippet?: string
}

export interface KbTree {
  folders: { id: string; path: string; count: number; subtreeCount: number }[]
  rootCount: number
  total: number
  tags: { name: string; color: string; count: number }[]
}

/** 结果里可显示的一笔：标签色块、出错详情这类附属信息按需带上 */
export interface KbNote {
  text: string
  /** 色块（标签颜色，hex）*/
  swatch?: string
  /** 出错时的原因 */
  detail?: string
}

function parseJson(output?: string): unknown {
  if (!output) return null
  try {
    return JSON.parse(output)
  } catch {
    return null
  }
}

function numOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export function kbParseRows(output?: string): KbRow[] | null {
  const v = parseJson(output)
  if (!Array.isArray(v)) return null
  const rows: KbRow[] = []
  for (const r of v) {
    if (!r || typeof r !== 'object') return null
    const o = r as Record<string, unknown>
    if (typeof o.id !== 'string' || typeof o.title !== 'string') return null
    rows.push({
      id: o.id,
      title: o.title,
      folder: typeof o.folder === 'string' ? o.folder : '',
      tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string') : [],
      project: typeof o.project === 'string' ? o.project : '',
      status: typeof o.status === 'string' ? o.status : 'ok',
      sourcePath: typeof o.sourcePath === 'string' ? o.sourcePath : '',
      contentPath: typeof o.contentPath === 'string' ? o.contentPath : '',
      snippet: typeof o.snippet === 'string' && o.snippet ? o.snippet : undefined,
    })
  }
  return rows
}

export function kbParseTree(output?: string): KbTree | null {
  const v = parseJson(output)
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (!Array.isArray(o.folders) || !Array.isArray(o.tags)) return null
  const total = numOf(o.total)
  const rootCount = numOf(o.rootCount)
  if (total === null || rootCount === null) return null
  const folders: KbTree['folders'] = []
  for (const f of o.folders) {
    if (!f || typeof f !== 'object') return null
    const fo = f as Record<string, unknown>
    const count = numOf(fo.count)
    const subtreeCount = numOf(fo.subtreeCount)
    if (typeof fo.path !== 'string' || count === null || subtreeCount === null) return null
    folders.push({ id: typeof fo.id === 'string' ? fo.id : '', path: fo.path, count, subtreeCount })
  }
  const tags: KbTree['tags'] = []
  for (const t of o.tags) {
    if (!t || typeof t !== 'object') return null
    const to = t as Record<string, unknown>
    const count = numOf(to.count)
    if (typeof to.name !== 'string' || count === null) return null
    tags.push({ name: to.name, color: typeof to.color === 'string' ? to.color : '', count })
  }
  return { folders, rootCount, total, tags }
}

/** 工具回执里的出错原因（业务性拒绝 / 内部错误都是 {"error": "..."}）；没有返回 null */
export function kbOutputError(output?: string): string | null {
  const v = parseJson(output)
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const err = (v as Record<string, unknown>).error
  return typeof err === 'string' && err ? err : null
}

/** 条目状态的说法（ok 不标；用词与工具窗树里的标识一致）*/
export function kbStateLabel(status: string): string {
  return status === 'snapshot' ? '快照' : status === 'missing' ? '已失效' : ''
}

/** 收起时就能看到的结果数量：检索/浏览的条数、目录结构的目录数；其余工具没有可数的返回 null */
export function kbResultHint(tool: string, output?: string): { text: string; error?: boolean } | null {
  if (!output) return null
  if (kbOutputError(output)) return { text: '未成功', error: true }
  switch (kbToolShortName(tool)) {
    case 'kb_search': {
      const rows = kbParseRows(output)
      return rows ? { text: rows.length > 0 ? `命中 ${rows.length} 条` : '无命中' } : null
    }
    case 'kb_list': {
      const rows = kbParseRows(output)
      return rows ? { text: `${rows.length} 条` } : null
    }
    case 'kb_tree': {
      const tree = kbParseTree(output)
      return tree ? { text: `${tree.folders.length} 个目录` } : null
    }
    default:
      return null
  }
}

/** 展开区的一个参数：中文字段名 + 值 */
export interface KbParam {
  label: string
  value: string
  /** 值的色块（标签颜色）*/
  swatch?: string
  /** 悬浮看全文（条目 id 列表这类折叠起来的值）*/
  title?: string
}

const FOLDER_ACTIONS: Record<string, string> = { create: '新建', rename: '重命名', move: '移动', delete: '删除' }
const ENTRY_ACTIONS: Record<string, string> = { move: '移动', update: '更新', delete: '摘除' }
const TAG_ACTIONS: Record<string, string> = { create: '新建', rename: '重命名', delete: '删除', color: '改颜色' }
const STATUS_LABEL: Record<string, string> = { ok: '正常', snapshot: '快照', missing: '已失效' }

function actionOf(actions: Record<string, string>, input: Record<string, unknown>, label: string): KbParam[] {
  const action = typeof input.action === 'string' ? input.action : ''
  return action ? [{ label, value: actions[action] ?? action }] : []
}

/** 参数的友好展示（替代裸 JSON）：只列传了的，值原样 */
export function kbParams(tool: string, input?: Record<string, unknown>): KbParam[] {
  if (!input) return []
  const out: KbParam[] = []
  const add = (label: string, v: unknown, extra: Partial<KbParam> = {}) => {
    if (typeof v === 'string' && v.trim()) out.push({ label, value: v.trim(), ...extra })
  }
  const addTags = (label: string, v: unknown) => {
    if (Array.isArray(v)) out.push({ label, value: v.length ? v.join('、') : '（清空）' })
  }
  // 位次参数是「摘出前的下标」，给人看的是第几位
  const position = typeof input.index === 'number' ? String(input.index + 1) : undefined
  switch (kbToolShortName(tool)) {
    case 'kb_search':
      add('检索词', input.query)
      add('目录', input.folder)
      add('标签', input.tag)
      add('项目', input.project)
      add('最多', typeof input.limit === 'number' ? `${input.limit} 条` : undefined)
      break
    case 'kb_read':
      add('条目', input.id)
      break
    case 'kb_list':
      add('目录', input.folder)
      add('标签', input.tag)
      add('项目', input.project)
      add('最多', typeof input.limit === 'number' ? `${input.limit} 条` : undefined)
      if (out.length === 0) out.push({ label: '范围', value: '全部条目' })
      break
    case 'kb_tree':
      break
    case 'kb_folder':
      out.push(...actionOf(FOLDER_ACTIONS, input, '操作'))
      add('目录', input.path)
      add('新名称', input.newName)
      if (typeof input.action === 'string' && input.action === 'move') {
        out.push({ label: '移到', value: str(input.newPath) || '根级' })
      }
      add('放在第几位', position)
      break
    case 'kb_entry': {
      out.push(...actionOf(ENTRY_ACTIONS, input, '操作'))
      const ids = Array.isArray(input.ids) ? input.ids.filter((x): x is string => typeof x === 'string') : []
      if (ids.length) out.push({ label: '条目', value: ids.length === 1 ? ids[0] : `${ids.length} 条`, title: ids.join('\n') })
      if (typeof input.action === 'string' && input.action === 'move') {
        out.push({ label: '移到', value: str(input.folderPath) || '根级' })
      }
      add('放在第几位', position)
      add('标题', input.title)
      addTags('标签', input.tags)
      add('备注', input.notes)
      add('源文件', input.sourcePath)
      break
    }
    case 'kb_tag':
      out.push(...actionOf(TAG_ACTIONS, input, '操作'))
      add('标签', input.name)
      add('新名称', input.newName)
      add('颜色', input.color, { swatch: typeof input.color === 'string' ? input.color : undefined })
      break
    case 'kb_add':
      add('文件', input.path)
      add('标题', input.title)
      add('目录', input.folderPath)
      addTags('标签', input.tags)
      add('备注', input.notes)
      break
    default:
      break
  }
  return out
}

function countField(o: Record<string, unknown>, key: string): number | null {
  return numOf(o[key])
}

/**
 * 整理类工具的结果回执，一句话说清做了什么（已移动 3 条到「运维」）。
 * 输出形状对不上返回 null（渲染层回退原文）。
 */
export function kbReceipt(tool: string, input?: Record<string, unknown> | undefined, output?: string): KbNote | null {
  const err = kbOutputError(output)
  if (err) return { text: '未成功', detail: err }
  if (!output) return null
  const v = parseJson(output)
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const inp = input ?? {}
  const action = typeof inp.action === 'string' ? inp.action : ''
  const path = str(inp.path)
  const name = str(inp.name)
  switch (kbToolShortName(tool)) {
    case 'kb_folder':
      if (action === 'create') {
        const p = typeof o.path === 'string' ? o.path : path
        return typeof o.id === 'string' && p ? { text: `已新建目录「${p}」` } : null
      }
      if (action === 'rename') {
        return o.ok === 'renamed' ? { text: `目录「${path}」已改名为「${str(inp.newName)}」` } : null
      }
      if (action === 'move') {
        if (o.ok !== 'moved') return null
        const to = str(inp.newPath) || '根级'
        const at = typeof inp.index === 'number' ? `，放在第 ${inp.index + 1} 位` : ''
        return { text: `目录「${path}」已移到「${to}」${at}` }
      }
      if (action === 'delete') {
        const moved = countField(o, 'movedToRoot')
        return moved === null ? null
          : { text: `已删除目录「${path}」${moved > 0 ? `，其中 ${moved} 条退回根级` : '，里面没有条目'}` }
      }
      return null
    case 'kb_entry': {
      if (action === 'move') {
        const n = countField(o, 'moved')
        if (n === null) return null
        const at = typeof inp.index === 'number' ? `，放在第 ${inp.index + 1} 位` : ''
        return { text: `已把 ${n} 条移到「${str(inp.folderPath) || '根级'}」${at}` }
      }
      if (action === 'update') {
        const n = countField(o, 'updated')
        return n === null ? null : { text: `已更新 ${n} 条` }
      }
      if (action === 'delete') {
        const n = countField(o, 'removed')
        return n === null ? null : { text: `已摘除 ${n} 条` }
      }
      return null
    }
    case 'kb_tag':
      if (action === 'create') {
        const created = typeof o.name === 'string' ? o.name : name
        const color = typeof o.color === 'string' ? o.color : ''
        return created ? { text: `已创建标签「${created}」${color ? `，颜色 ${color}` : ''}`, swatch: color || undefined } : null
      }
      if (action === 'rename') {
        const n = countField(o, 'updatedEntries')
        return n === null ? null
          : { text: `标签「${name}」已改名为「${str(inp.newName)}」${n > 0 ? `，${n} 条条目跟着改` : '，没有条目用到它'}` }
      }
      if (action === 'delete') {
        const n = countField(o, 'updatedEntries')
        return n === null ? null
          : { text: `已删除标签「${name}」${n > 0 ? `，从 ${n} 条条目上摘掉` : '，没有条目用到它'}` }
      }
      if (action === 'color') {
        const color = str(inp.color)
        return o.ok === 'color set' && color ? { text: `标签「${name}」已改为 ${color}`, swatch: color } : null
      }
      return null
    case 'kb_add': {
      if (typeof o.title !== 'string' || typeof o.id !== 'string') return null
      const folder = typeof o.folder === 'string' ? o.folder : ''
      const where = folder ? `，放在「${folder}」` : '，放在根级'
      return o.existed === true
        ? { text: `「${o.title}」此前已收录，这次更新了元数据${where}` }
        : { text: `已收录「${o.title}」${where}` }
    }
    default:
      return null
  }
}

/** 读全文输出的头信息：标题一行 + 「- folder: … | tags: […] | project: … | status: …」+ 「- source: …」，空行之后是正文 */
export interface KbReadDoc {
  title: string
  folder: string
  tags: string[]
  project: string
  status: string
  source: string
  body: string
}

export function kbParseRead(output?: string): KbReadDoc | null {
  if (!output) return null
  const sep = output.indexOf('\n\n')
  const head = sep >= 0 ? output.slice(0, sep) : output
  const body = sep >= 0 ? output.slice(sep + 2) : ''
  const lines = head.split('\n')
  if (!lines[0]?.startsWith('### ')) return null
  const metaLine = lines.find((l) => l.startsWith('- folder:'))
  if (!metaLine) return null
  const fields = new Map<string, string>()
  for (const part of metaLine.slice(2).split('|')) {
    const idx = part.indexOf(':')
    if (idx > 0) fields.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim())
  }
  const tagsJson = fields.get('tags') ?? '[]'
  let tags: string[] = []
  try {
    const parsed = JSON.parse(tagsJson)
    if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string')
  } catch {
    tags = tagsJson ? [tagsJson] : []
  }
  const sourceLine = lines.find((l) => l.startsWith('- source:'))
  return {
    title: lines[0].slice(4).trim(),
    folder: fields.get('folder') ?? '',
    tags,
    project: fields.get('project') ?? '',
    status: fields.get('status') ?? 'ok',
    source: sourceLine ? sourceLine.slice('- source:'.length).trim() : '',
    body,
  }
}

/** 读全文头信息里的状态说法（ok 不标，与条目行一致）*/
export function kbReadStateLabel(status: string): string {
  return STATUS_LABEL[status] && status !== 'ok' ? STATUS_LABEL[status] : ''
}
