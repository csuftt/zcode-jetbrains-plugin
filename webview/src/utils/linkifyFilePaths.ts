/**
 * 消息内文件路径链接化
 *
 * 设计：docs/internal/feat/消息内文件路径可点击打开.md（拍板 A/B/C：
 * span+data-* 形态、v1 从严识别、前端解析相对路径，Kotlin 零改动复用 openFile op）
 *
 * 对 renderMarkdown 产出（DOMPurify 清洗后）的 HTML 做纯函数后处理：
 * 文本节点里的文件路径包一层
 *   <span class="md-file-link" data-file-path data-file-line>原文</span>
 * 点击由 MarkdownBlock/ThinkingBlock 事件委托（fileLink.ts）走 openFile op
 * 在 IDE 打开并跳行；显示文本保留 AI 原文，解析结果只进 data 属性。
 * （另有 data-tip 悬浮气泡属性，已按真机拍板关闭，见 linkifyTextNode 注释）
 *
 * v1 识别范围（从严，宁漏勿错）：
 *   - Windows 绝对路径 X:\... / X:/...、Unix 绝对路径 /...
 *   - 工作区相对路径（含分隔符 + 扩展名白名单），靠 workspaceRoot 解析成绝对路径
 *   - 可选行号后缀 :123 / :L123 / :123-456 与 GitHub 风格 #L123 / #L123-456 / #L123-L456（跳首行）
 *   - 不识别：pre/a/button 子树内文本、~ 与 .. 开头
 *     （基准非工作区根，v1 解析不了就不链接——死链不如不链）、含空格路径
 *
 * 2026-10-09 缺口修复（feat/file-link-linenum-folder-open）：
 *   - 带行号后缀的裸文件名放行（.gitignore:37 / App.kt:1606——:行号是强文件指代
 *     信号，误报面远小于裸文件名本体；无行号裸文件名维持不链），按工作区根解析
 *   - 目录路径（结尾 / 的显式形态，如 /docs/internal/、webview/src/）放行，
 *     无行号；打开方式=系统文件管理器（Kotlin handleOpenFile 目录路由），
 *     前导 / 路径不存在时 Kotlin 侧剥前导拼项目根回退
 */

export interface FileLinkTarget {
  /** 解析后的绝对路径（统一正斜杠，IntelliJ system-independent 格式）*/
  absPath: string
  /** 1 基行号；无行号后缀时 undefined */
  line?: number
  /** 链接显示文本 = 命中原文裁掉首尾粘连标点（行号后缀保留在显示里）*/
  display: string
}

/**
 * 扩展名白名单（小写）：路径样文本的最后闸门，
 * 挡 feature/0.2.1、and/or 这类误报。不在表内 = 不链接（宁漏勿错）。
 */
const KNOWN_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts',
  'kt', 'kts', 'java', 'groovy', 'scala', 'clj',
  'py', 'rb', 'go', 'rs', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs', 'swift', 'm', 'mm',
  'php', 'vue', 'svelte', 'dart', 'lua', 'r', 'jl', 'ex', 'exs', 'erl', 'hs', 'pl',
  'html', 'htm', 'css', 'less', 'scss', 'sass',
  'json', 'jsonc', 'yaml', 'yml', 'xml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'gradle', 'env',
  'md', 'markdown', 'txt', 'log', 'csv', 'tsv',
  'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd',
  'sql', 'graphql', 'proto', 'wasm',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'pdf', 'zip', 'jar', 'war', 'iml',
  'gitignore', 'editorconfig', 'lock',
])

/**
 * 路径候选 token（宽松匹配，严格校验在 resolveFileLink）：
 *   分支1：可选 Windows 盘符 + 段* + (分隔符+段)+ + 可选结尾分隔符（目录形态
 *     /docs/internal/、webview/src/——结尾 / 不进 token 的话 resolveFileLink
 *     收不到目录信号）+ 可选行号后缀
 *   分支2：裸文件名.扩展名 + 行号后缀（后缀经 lookahead 绑定为必选——
 *     无行号裸文件名不进 token，从源头挡 App.tsx 类误报）
 * 段字符类含 CJK（-鿿，docs/静夜思.md 这类中文文件名路径）；
 * 刻意不含：空格/引号/冒号/逗号/书名号——含空格路径 v1 不支持
 * （无法判定词边界，截断错比不链更糟）。
 * lookbehind 排除 \w / \ : . 四种前置字符：挡 URL 碎片
 * （http://x.com/a.ts 里的 com/a.ts 会被 . 前置拒绝）。
 */
const PATH_TOKEN =
  /(?<![\w/\\:.])(?:(?:[A-Za-z]:)?[\w$.~@+%&()[\]一-鿿-]*(?:[\\/][\w$.~@+%&()[\]一-鿿-]+)+[\\/]?|[\w$.~@+%&()[\]一-鿿-]*\.[A-Za-z0-9]{1,10}(?=(?::|#L)L?\d))(?:(?::|#L)L?\d{1,6}(?:-L?\d{1,6})?)?/gu

/**
 * 快速门禁：命中以下任一形态才进 DOMParser（流式每帧都过这里，省解析）：
 *   分隔符+扩展名（常规路径）/ 裸文件名.扩展名:行号 / 双分隔符（目录形态 a/b/）
 */
const PATH_GATE =
  /[\\/][^<>\s]*\.[A-Za-z0-9]{1,10}|[\w$~@+%&()[\]一-鿿-]*\.[A-Za-z0-9]{1,10}(?::|#L)L?\d|[\\/][^<>\s]*[\\/]/

/** 首尾粘连标点裁剪（只裁 token 字符类里含有的：. ( ) [ ]）*/
const LEADING_TRIM = /^[(\[]+/
const TRAILING_TRIM = /[.)\]]+$/

/** 中文行文常把路径直接粘在汉字后（见docs/xx.md）：剥掉开头连续 CJK——
 *  只剥到后面跟 ASCII 字母数字为止（"消息/xx.md" 这类纯 CJK 首段不受影响） */
const LEADING_CJK = /^[一-鿿]+(?=[A-Za-z0-9])/

/** 行号后缀：:123 / :L123 / :123-456 与 GitHub 风格 #L123 / #L123-456 / #L123-L456
 * （都取首行）。Windows 盘符冒号后面跟分隔符不是数字，不会被误吃 */
const LINE_SUFFIX = /(?::|#L)L?(\d{1,6})(?:-L?\d{1,6})?$/

/** tooltip 最大长度（全局 data-tip 气泡 nowrap 单行，长路径中间截断）。
 *  随 data-tip 一并停用（见 linkifyTextNode 注释），保留供排查解析类 bug 时启用 */
// const TIP_MAX = 80
//
// function truncateMiddle(text: string, max: number): string {
//   if (text.length <= max) return text
//   const head = Math.ceil((max - 1) / 2)
//   const tail = Math.floor((max - 1) / 2)
//   return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
// }

/**
 * 候选文本 → 链接目标。返回 null = 不链接（误报闸门全在这里）。
 * 纯函数，workspaceRoot 为空时相对路径一律不解析。
 */
export function resolveFileLink(raw: string, workspaceRoot: string): FileLinkTarget | null {
  const text = raw
    .replace(LEADING_TRIM, '')
    .replace(TRAILING_TRIM, '')
    .replace(LEADING_CJK, '')
  // ~ 与 .. 开头：基准不是工作区根，v1 解析不了（死链不如不链）
  if (!text || text.startsWith('~') || text.startsWith('..')) return null

  const display = text
  let path = text
  let line: number | undefined
  const lineMatch = path.match(LINE_SUFFIX)
  if (lineMatch) {
    const n = parseInt(lineMatch[1], 10)
    if (n > 0) {
      line = n
      path = path.slice(0, lineMatch.index)
    }
  }

  // 统一正斜杠（IntelliJ system-independent 路径；显示文本不受影响）
  let p = path.replace(/\\/g, '/')
  if (p.startsWith('./')) p = p.slice(2)
  if (!p || p.includes('/../') || p.includes('/./')) return null

  // 目录形态（只认结尾 / 的显式目录，无扩展名目录名与版本号串难区分不猜）：
  // 跳过扩展名闸门；行号对目录无意义强制丢弃；前导 / 原样下发
  // （Windows 上不存在该绝对路径时由 Kotlin handleOpenFile 剥前导拼项目根回退）
  if (p.endsWith('/')) {
    if (/^[A-Za-z]:\//.test(p) || p.startsWith('/')) {
      return { absPath: p, line: undefined, display }
    }
    const dirRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
    if (!dirRoot) return null
    return { absPath: `${dirRoot}/${p}`, line: undefined, display }
  }

  // 必须有分隔符——例外：带行号后缀的裸文件名（.gitignore:37 / App.kt:1606，
  // :行号是强文件指代信号；无行号裸文件名 App.tsx 误报率太高维持不链）
  if (!p.includes('/') && line == null) return null

  // 扩展名白名单：最后一段必须带已知扩展名（版本号串全在这里被挡）
  const lastSeg = p.slice(p.lastIndexOf('/') + 1)
  const extMatch = lastSeg.match(/\.([A-Za-z0-9]{1,10})$/)
  if (!extMatch || !KNOWN_EXTENSIONS.has(extMatch[1].toLowerCase())) return null

  if (/^[A-Za-z]:\//.test(p) || p.startsWith('/')) {
    return { absPath: p, line, display }
  }
  const root = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!root) return null
  return { absPath: `${root}/${p}`, line, display }
}

/** 单文本节点内的路径全部包 span；有替换返回 true */
function linkifyTextNode(doc: Document, node: Text, workspaceRoot: string): boolean {
  const text = node.nodeValue ?? ''
  if (!text) return false
  const frag = doc.createDocumentFragment()
  let cursor = 0
  let changed = false
  for (const m of text.matchAll(PATH_TOKEN)) {
    const raw = m[0]
    const target = resolveFileLink(raw, workspaceRoot)
    if (!target) continue
    const start = (m.index ?? 0) + raw.indexOf(target.display)
    const end = start + target.display.length
    if (start > cursor) frag.append(doc.createTextNode(text.slice(cursor, start)))
    const span = doc.createElement('span')
    span.className = 'md-file-link'
    span.setAttribute('data-file-path', target.absPath)
    if (target.line) span.setAttribute('data-file-line', String(target.line))
    // data-tip 悬浮气泡（显示解析后绝对路径）按真机拍板关闭（2026-10-09）：日常无用；
    // 但排查"解析到错误路径"类 bug 时是最直接的证据——需要时取消下面这段注释即可
    // span.setAttribute(
    //   'data-tip',
    //   truncateMiddle(target.line ? `${target.absPath}:${target.line}` : target.absPath, TIP_MAX),
    // )
    span.textContent = target.display
    frag.append(span)
    cursor = end
    changed = true
  }
  if (!changed) return false
  if (cursor < text.length) frag.append(doc.createTextNode(text.slice(cursor)))
  node.replaceWith(frag)
  return true
}

/**
 * HTML → HTML：文本节点里的文件路径包成 .md-file-link span。
 * pre/a/button 子树不碰（围栏代码块是误报重灾区；链接文字不动；
 * 已有 .md-file-link 跳过保证幂等）。无替换时返回原字符串（免序列化漂移）。
 */
export function linkifyFilePaths(html: string, workspaceRoot: string): string {
  if (!html || !PATH_GATE.test(html)) return html
  const doc = new DOMParser().parseFromString(html, 'text/html')
  // 先收集再改写：TreeWalker 遍历中改 DOM 会丢节点
  const textNodes: Text[] = []
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    const parent = node.parentElement
    if (!parent || parent.closest('pre, a, button, .md-file-link')) continue
    textNodes.push(node)
  }
  let changed = false
  for (const node of textNodes) {
    if (linkifyTextNode(doc, node, workspaceRoot)) changed = true
  }
  return changed ? doc.body.innerHTML : html
}
