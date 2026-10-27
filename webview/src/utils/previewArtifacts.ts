/**
 * 产物预览卡提取纯函数（B2 二期，移植官方客户端 shared/conversation-preview-artifacts
 * + ui/assistantPreviewCards，开源仓库可直接对照）。
 *
 * 产品规则（与官方对齐）：
 *  - 轮末把本轮 assistant 文本拼接后做五源正则提取（优先级即保护区顺序）：
 *    zcode-file-citation 指令 > markdown 链接 > file:// URL > 引号/反引号定界 > 裸路径
 *  - md/html 必须命中本轮 fileChanges 路径集才出卡（AI 光提路径不出卡，防幻觉）；
 *    docx/xlsx/pptx/pdf/音视频 提及即候选（渲染前批量 stat 过滤已删除文件）
 *  - 网站卡 = 文本里的 localhost/127.0.0.1 http(s) URL（无门控）；
 *    file://…html 归 html 文件卡（有门控）
 *  - 候选上限 15（本模块）/渲染上限 10（组件内再裁）；同位置后提的优先（dedupe 从新到旧）
 *
 * 与官方的差异（插件裁剪，均有意为之）：
 *  - `~` Home-relative 路径一律不解析（官方正文裸路径同样排除；插件无 homePath 注入）
 *  - 无 web 远控抑制、无 PPTX 自动打开（桌面插件无此场景）
 *  - file://…html 引用不转网站卡（官方转 website 卡为走其浏览器面板；插件点开走 IDE 编辑器）
 */

import { maskVisualizeDirectives } from '@/utils/visualizeDirective'

export type PreviewFileKind =
  | 'markdown'
  | 'html'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'pdf'
  | 'video'
  | 'audio'

export interface PreviewFileReference {
  start: number
  end: number
  kind: PreviewFileKind
  path: string
  raw: string
}

export interface PreviewFileChange {
  path: string
  state?: 'active' | 'reverted'
}

export type PreviewCard =
  | { type: 'file'; kind: PreviewFileKind; title: string; path: string }
  | { type: 'website'; title: string; url: string }

export const PREVIEW_CARD_CANDIDATE_LIMIT = 15
export const PREVIEW_CARD_VISIBLE_LIMIT = 10

/** kind → i18n 副标题键（chat.previewCards.*） */
export const PREVIEW_KIND_I18N: Record<PreviewFileKind, string> = {
  markdown: 'chat.previewCards.markdown',
  html: 'chat.previewCards.htmlWebsite',
  docx: 'chat.previewCards.docx',
  xlsx: 'chat.previewCards.xlsx',
  pptx: 'chat.previewCards.pptx',
  pdf: 'chat.previewCards.pdf',
  video: 'chat.previewCards.video',
  audio: 'chat.previewCards.audio',
}

const MEDIA_FORMATS: ReadonlyArray<{ extension: string; kind: PreviewFileKind }> = [
  { extension: '.mp4', kind: 'video' },
  { extension: '.mov', kind: 'video' },
  { extension: '.webm', kind: 'video' },
  { extension: '.m4v', kind: 'video' },
  { extension: '.mp3', kind: 'audio' },
  { extension: '.wav', kind: 'audio' },
  { extension: '.m4a', kind: 'audio' },
  { extension: '.ogg', kind: 'audio' },
  { extension: '.opus', kind: 'audio' },
  { extension: '.flac', kind: 'audio' },
  { extension: '.weba', kind: 'audio' },
]

const PREVIEW_FILE_TYPES: ReadonlyArray<{ extensions: readonly string[]; kind: PreviewFileKind }> = [
  { extensions: ['.md'], kind: 'markdown' },
  { extensions: ['.html', '.htm'], kind: 'html' },
  { extensions: ['.docx'], kind: 'docx' },
  { extensions: ['.xlsx'], kind: 'xlsx' },
  { extensions: ['.pptx'], kind: 'pptx' },
  { extensions: ['.pdf'], kind: 'pdf' },
  ...MEDIA_FORMATS.map(({ extension, kind }) => ({ extensions: [extension], kind })),
]

const EXTENSION_ALT = 'md|html?|docx|xlsx|pptx|pdf|mp4|mov|webm|m4v|mp3|wav|m4a|ogg|opus|flac|weba'

const FILE_URL_RE = /\bfile:\/\/[^\s<>()\]`"'*，。！？；：、]+/giu
const FILE_CITATION_RE = /:{1,2}zcode-file-citation\{([^}]*)\}/giu
const MARKDOWN_LINK_RE = /\[([^\]\n]*)\]\(([^)\n]+)\)/g
// 反向引用 \1（同引号闭合）无法用字面量携带动态扩展名表，显式构造
const DELIMITED_FILE_PATH_RE = new RegExp(
  "([`\"'])([^`\"'\\r\\n]+?\\.(?:" + EXTENSION_ALT + ")(?::\\d+(?::\\d+)?)?)\\1",
  'giu',
)
const FILE_PATH_RE = new RegExp(
  "(?:^|[\\s(\"`'.,;:!?，。！？；：、])((?:(?:\\.{1,2}[\\\\/]|[a-zA-Z]:[\\\\/]|\\/|" +
    "[\\p{L}\\p{N}\\p{M}\\p{S}_.@()-]+[\\\\/])[\\p{L}\\p{N}\\p{M}\\p{S}_.@() -]+?" +
    "(?:[\\\\/][\\p{L}\\p{N}\\p{M}\\p{S}_.@() -]+?)*|[\\p{L}\\p{N}\\p{M}\\p{S}_.@()-]+)" +
    "\\.(?:" + EXTENSION_ALT + ")(?::\\d+(?::\\d+)?)?)" +
    "(?=$|[\\s)\"`'.,;:!?，。！？；：、])",
  'giu',
)

const LOCALHOST_URL_RE =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:[/?#][^\s<>()\]`"'*，。！？；：、]*)?/gi
const STRICT_LOCALHOST_URL_RE =
  /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?(?:[/?#][^\s<>()\]`"'*，。！？；：、]*)?$/i

function normalizeSlashes(path: string): string {
  return path.replace(/\\/gu, '/')
}

function cleanPath(path: string): string {
  return path
    .trim()
    .replace(/[.,;!?，。！？；：、]+$/gu, '')
    .replace(/:\d+(?::\d+)?$/u, '')
}

/** 去掉 URL 尾部的强调符号/标点（AI 文本常见 `**http://…**，` 形态） */
function normalizeTrailingUrlText(url: string): string {
  return url.trim().replace(/(?:[*_`]+|[.,;:!?，。！？；：、]+)+$/g, '')
}

function parseFileUrlPath(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'file:') return null
    let pathname: string
    try {
      pathname = decodeURI(url.pathname)
    } catch {
      pathname = url.pathname
    }
    // Windows 盘符形态 /G:/foo → G:/foo
    if (/^\/[a-zA-Z]:\//u.test(pathname)) return pathname.slice(1)
    return pathname
  } catch {
    return null
  }
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:[\\/]/u.test(path) || path.startsWith('\\\\')
}

function normalizeRelativePath(path: string): string | null {
  const segments: string[] = []
  for (const segment of normalizeSlashes(path).split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return null
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.join('/')
}

function normalizeAbsolutePath(path: string): string {
  const normalized = normalizeSlashes(path).replace(/\/{2,}/gu, '/')
  const prefix = normalized.startsWith('/') ? '/' : ''
  const segments: string[] = []
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return `${prefix}${segments.join('/')}`
}

/**
 * 文本里的路径引用 → 绝对路径。相对路径锚 workspace；`~/` 是 shell 展示语义
 * 不是稳定引用，一律拒绝（官方同规则，防把正文 `~/x.md` 当 workspace 文件出卡）。
 */
export function resolvePreviewPath(workspacePath: string, rawPath: string): string | null {
  const cleaned = cleanPath(rawPath)
  if (!cleaned) return null
  if (/^~[\\/]/u.test(cleaned)) return null
  const filePath = /^file:\/\//iu.test(cleaned) ? parseFileUrlPath(cleaned) : cleaned
  if (!filePath) return null
  if (isAbsolutePath(filePath)) return normalizeAbsolutePath(filePath)
  const relative = normalizeRelativePath(filePath)
  if (relative === null) return null
  const workspace = normalizeAbsolutePath(workspacePath).replace(/\/$/u, '')
  if (!workspace) return null
  return `${workspace}/${relative}`
}

export function getPreviewFileKind(path: string): PreviewFileKind | null {
  const normalized = cleanPath(path).toLowerCase()
  const found = PREVIEW_FILE_TYPES.find((definition) =>
    definition.extensions.some((extension) => normalized.endsWith(extension)),
  )
  return found?.kind ?? null
}

function getPathLeaf(path: string): string {
  const segments = normalizeSlashes(path).replace(/\/+$/u, '').split('/').filter(Boolean)
  return segments[segments.length - 1] ?? path
}

function rangesOverlap(start: number, end: number, ranges: ReadonlyArray<[number, number]>): boolean {
  return ranges.some(([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart)
}

function readDirectiveParameter(parameters: string, name: string): string | undefined {
  const match = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'iu').exec(parameters)
  return match?.[1]?.trim() || undefined
}

/** citation 指令只允许 Office/PDF/音视频出卡（md/html 必须走 fileChanges 门控通道） */
const CITATION_ALLOWED_KINDS: ReadonlySet<PreviewFileKind> = new Set([
  'docx',
  'xlsx',
  'pptx',
  'pdf',
  'video',
  'audio',
])

/**
 * 五源提取（保护区语义：高级源的完整区间入保护区，低级正则不得在区内重复捞——
 * 否则 citation/md 链接内部的路径会被裸路径正则再抽一次，绕过产品边界）。
 * 返回按出现位置升序、同路径去重（保留最后出现）的引用列表。
 */
export function extractPreviewFileReferences(
  content: string,
  workspacePath: string,
): PreviewFileReference[] {
  // ::visualize 指令行先等长掩码：指令 JSON 里的 html 路径会被裸路径源抽成候选、
  // 与内嵌可视化卡双出（掩码保 offset，position 排序语义不变）
  return extractPreviewFileReferencesMasked(maskVisualizeDirectives(content), workspacePath)
}

function extractPreviewFileReferencesMasked(
  content: string,
  workspacePath: string,
): PreviewFileReference[] {
  if (!content.trim()) return []
  const references: PreviewFileReference[] = []
  const protectedRanges: Array<[number, number]> = []
  const addReference = (raw: string, start: number, end: number) => {
    const path = resolvePreviewPath(workspacePath, raw)
    const kind = path ? getPreviewFileKind(path) : null
    if (!path || !kind) return
    references.push({ start, end, kind, path, raw })
  }

  for (const match of content.matchAll(FILE_CITATION_RE)) {
    const rawDirective = match[0] ?? ''
    const start = match.index ?? 0
    const end = start + rawDirective.length
    protectedRanges.push([start, end])
    const rawPath = readDirectiveParameter(match[1] ?? '', 'path')
    if (!rawPath) continue
    const artifactKind = readDirectiveParameter(match[1] ?? '', 'artifact_kind')?.toLowerCase()
    const path = resolvePreviewPath(workspacePath, rawPath)
    const kind = path ? getPreviewFileKind(path) : null
    const citationKind = kind && CITATION_ALLOWED_KINDS.has(kind) ? kind : null
    const expectedKind =
      artifactKind === 'document'
        ? 'docx'
        : artifactKind === 'presentation'
          ? 'pptx'
          : artifactKind === 'workbook'
            ? 'xlsx'
            : undefined
    if (path && citationKind && (expectedKind === undefined || expectedKind === citationKind)) {
      references.push({ start, end, kind: citationKind, path, raw: rawPath })
    }
  }

  for (const match of content.matchAll(MARKDOWN_LINK_RE)) {
    const href = (match[2] ?? '').trim().replace(/^<|>$/gu, '')
    const start = match.index ?? 0
    const end = start + (match[0]?.length ?? 0)
    if (rangesOverlap(start, end, protectedRanges)) continue
    protectedRanges.push([start, end])
    addReference(href, start, end)
  }
  for (const match of content.matchAll(FILE_URL_RE)) {
    const raw = cleanPath(match[0] ?? '')
    const start = match.index ?? 0
    const end = start + (match[0]?.length ?? 0)
    if (rangesOverlap(start, end, protectedRanges)) continue
    protectedRanges.push([start, end])
    addReference(raw, start, end)
  }
  for (const match of content.matchAll(DELIMITED_FILE_PATH_RE)) {
    const raw = (match[2] ?? '').trim()
    const fullStart = match.index ?? 0
    const fullEnd = fullStart + (match[0]?.length ?? raw.length)
    if (!raw || rangesOverlap(fullStart, fullEnd, protectedRanges)) continue
    const innerStart = fullStart + (match[0]?.indexOf(raw) ?? 0)
    const innerEnd = innerStart + raw.length
    protectedRanges.push([fullStart, fullEnd])
    addReference(raw, innerStart, innerEnd)
  }
  for (const match of content.matchAll(FILE_PATH_RE)) {
    const raw = match[1] ?? ''
    const fullMatch = match[0] ?? raw
    const start = (match.index ?? 0) + fullMatch.lastIndexOf(raw)
    const end = start + raw.length
    if (!raw || rangesOverlap(start, end, protectedRanges)) continue
    addReference(raw, start, end)
  }

  const seen = new Set<string>()
  return references
    .sort((left, right) => right.start - left.start || right.end - left.end)
    .filter((reference) => {
      const key = normalizeAbsolutePath(reference.path)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .reverse()
}

function normalizePathForCompare(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')
}

/** fileChanges 路径（相对 workspace 或绝对）→ 绝对路径 */
function resolveChangedFilePath(workspacePath: string, path: string): string {
  if (/^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(path)) return cleanPath(path)
  const resolved = resolvePreviewPath(workspacePath, path)
  return resolved ?? path
}

/**
 * 引用 ↔ 本轮 fileChanges 路径匹配：先精确（归一化后相等），裸文件名再按叶子名
 * 唯一命中兜底（AI 常只写 `report.md` 而账本是 `docs/report.md`）。叶子名歧义不猜。
 */
function findMatchingChangedPath(
  reference: PreviewFileReference,
  changedFilePaths: readonly string[],
  workspacePath: string,
): string | null {
  const normalizedReference = normalizePathForCompare(reference.path)
  const normalizedChanged = changedFilePaths.map((path) => {
    const resolved = resolveChangedFilePath(workspacePath, path)
    return { path: resolved, normalized: normalizePathForCompare(resolved) }
  })
  const exact = normalizedChanged.find((candidate) => candidate.normalized === normalizedReference)
  if (exact) return exact.path

  const cleanedRaw = cleanPath(reference.raw)
  if (cleanedRaw.includes('/') || cleanedRaw.includes('\\') || /^file:/i.test(cleanedRaw)) {
    return null
  }
  const leafMatches = normalizedChanged.filter(
    (candidate) => getPathLeaf(candidate.normalized) === cleanedRaw,
  )
  return leafMatches.length === 1 ? leafMatches[0]!.path : null
}

function isValidWebsiteUrl(url: string): boolean {
  const trimmed = normalizeTrailingUrlText(url.trim())
  if (!STRICT_LOCALHOST_URL_RE.test(trimmed)) return false
  try {
    const parsed = new URL(trimmed)
    const port = parsed.port ? Number.parseInt(parsed.port, 10) : null
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') &&
      (port === null || (port > 0 && port <= 65535))
    )
  } catch {
    return false
  }
}

/** 文本里 localhost URL 的展示标题：同名 md 链接标签 > 路径尾段 > host */
function getWebsiteTitle(content: string, url: string): string {
  for (const match of content.matchAll(MARKDOWN_LINK_RE)) {
    const label = (match[1] ?? '').replace(/\s+/g, ' ').trim()
    const href = normalizeTrailingUrlText((match[2] ?? '').trim().replace(/^<|>$/g, ''))
    if (
      href === url &&
      label &&
      label.length <= 80 &&
      !/^https?:\/\//i.test(label) &&
      !/[*_`[\]<>]/.test(label) &&
      /[a-zA-Z0-9\u4e00-\u9fff]/.test(label)
    ) {
      return label
    }
  }
  try {
    const parsed = new URL(url)
    const leaf = getPathLeaf(decodeURI(parsed.pathname))
    return leaf && leaf !== '/' ? leaf : parsed.host
  } catch {
    return url
  }
}

/**
 * 轮文本 → 预览卡候选（网站卡 + 文件卡，后提及优先，去重后取 15）。
 * changedPaths 传 null 表示本轮 fileChanges 明细尚未拉到——md/html 暂不产卡
 * （明细到达后组件重算二段出卡），Office/PDF/音视频不受影响照常产卡。
 */
export function buildPreviewCards(
  content: string,
  workspacePath: string,
  changedPaths: readonly string[] | null,
): PreviewCard[] {
  if (!content.trim()) return []

  const positioned: Array<{ position: number; card: PreviewCard }> = []
  for (const match of content.matchAll(LOCALHOST_URL_RE)) {
    const url = normalizeTrailingUrlText(match[0] ?? '')
    if (!isValidWebsiteUrl(url)) continue
    positioned.push({
      position: match.index ?? 0,
      card: { type: 'website', title: getWebsiteTitle(content, url), url },
    })
  }

  const references = extractPreviewFileReferences(content, workspacePath)
  for (const reference of references) {
    let path = reference.path
    if (reference.kind === 'markdown' || reference.kind === 'html') {
      if (changedPaths === null) continue
      const changed = findMatchingChangedPath(reference, changedPaths, workspacePath)
      if (!changed) continue
      path = changed
    }
    positioned.push({
      position: reference.start,
      card: { type: 'file', kind: reference.kind, title: getPathLeaf(path), path },
    })
  }

  positioned.sort((left, right) => right.position - left.position)
  const seen = new Set<string>()
  const cards: PreviewCard[] = []
  for (const { card } of positioned) {
    const key =
      card.type === 'file'
        ? `file:${normalizePathForCompare(card.path)}`
        : `url:${card.url.replace(/\/+$/u, '')}`
    if (seen.has(key)) continue
    seen.add(key)
    cards.push(card)
    if (cards.length === PREVIEW_CARD_CANDIDATE_LIMIT) break
  }
  return cards
}

/** 预览卡是否有磁盘文件主体（有则渲染前必须 stat，防闪卡/防已删文件） */
export function getPreviewCardFilePath(card: PreviewCard): string | null {
  return card.type === 'file' ? card.path : null
}
