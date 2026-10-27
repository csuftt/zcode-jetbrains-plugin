/**
 * ::visualize 内联可视化指令解析
 *
 * 官方客户端约定：助手消息中以独立一行 `::visualize{"path":"...","title":"...","mode":"wide"}`
 * 引用会话可视化目录里的 HTML 片段（单/双冒号同族语法，参照 zcode-file-citation 指令）。
 * 这里在 MarkdownBlock 渲染前把指令行从正文中切出来，交给 VisualizeBlock 渲染 iframe。
 *
 * 流式友好：指令行未写完（只有前缀、JSON 未闭合）时产出 viz-pending 段，渲染层隐藏
 * 裸文本防反斜杠路径闪现；写完的下一帧自动替换成组件。
 */

export interface VizDirective {
  /** 可视化 HTML 绝对路径 */
  path: string
  title?: string
  mode?: string
  /** 原始指令行（错误提示/调试用） */
  raw: string
}

export type MdSegment =
  | { type: 'md'; text: string }
  | { type: 'viz'; directive: VizDirective }
  | { type: 'viz-pending' }

/** 完整指令行：`:visualize{...}` / `::visualize{...}`（行尾允许空白）*/
const VIZ_LINE_RE = /^:{1,2}visualize\s*\{(.+)\}\s*$/i

/** 指令行前缀（流式中未闭合也命中）*/
const VIZ_PREFIX_RE = /^:{1,2}visualize\s*\{/i

/** 全文快速门（无锚定）：不含指令形态的文本直接原样返回 */
const VIZ_ANY_RE = /:{1,2}visualize\s*\{/i

/**
 * 解析单行指令。JSON 优先（吃住 Windows 路径的反斜杠转义），失败降级
 * key="value" 读法（对齐 previewArtifacts 的 zcode-file-citation 参数形态）。
 * 非指令行/解析不出 path 返回 null。
 */
export function parseVizDirective(line: string): VizDirective | null {
  const trimmed = line.trim()
  const m = trimmed.match(VIZ_LINE_RE)
  if (!m) return null
  const body = m[1]
  try {
    const obj = JSON.parse(`{${body}}`) as Record<string, unknown>
    const path = typeof obj.path === 'string' ? obj.path : ''
    if (path) {
      return {
        path,
        title: typeof obj.title === 'string' ? obj.title : undefined,
        mode: typeof obj.mode === 'string' ? obj.mode : undefined,
        raw: trimmed,
      }
    }
  } catch {
    // 降级 key="value" 形态
  }
  const path = readParam(body, 'path')
  if (!path) return null
  return { path, title: readParam(body, 'title'), mode: readParam(body, 'mode'), raw: trimmed }
}

/** key="value" / key='value' 参数读取（citation 同族兼容） */
function readParam(body: string, name: string): string | undefined {
  const m = body.match(new RegExp(`${name}\\s*=\\s*"([^"]+)"`)) ?? body.match(new RegExp(`${name}\\s*=\\s*'([^']+)'`))
  return m?.[1]
}

/**
 * 指令行等长掩码：命中/未完成的指令行整行替换为同长度空格（换行结构不变）。
 * 用于轮末产物预览卡提取的前置清洗——指令 JSON 里的 html 路径会被裸路径源抽成
 * 候选、与可视化卡双出；掩码保 offset 不变，extractPreviewFileReferences 的
 * start/end 排序语义不受影响。
 */
export function maskVisualizeDirectives(md: string): string {
  if (!md || !VIZ_ANY_RE.test(md)) return md
  const lines = md.split('\n')
  let inFence = false
  let fenceChar = ''
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/)
    if (fenceMatch) {
      const ch = fenceMatch[1][0]
      if (!inFence) {
        inFence = true
        fenceChar = ch
      } else if (fenceChar === ch) {
        inFence = false
        fenceChar = ''
      }
      continue
    }
    if (!inFence && VIZ_PREFIX_RE.test(trimmed)) {
      lines[i] = ' '.repeat(lines[i].length)
    }
  }
  return lines.join('\n')
}

/**
 * 围栏感知地把 markdown 切成 普通文本/可视化指令 段序列：
 * - 代码围栏（```/~~~）内的指令行不拦截（照普通代码渲染）
 * - 前缀命中但 JSON 未闭合（流式中）→ viz-pending
 */
export function splitVisualizeDirectives(md: string): MdSegment[] {
  if (!md) return []
  const segments: MdSegment[] = []
  let textBuf: string[] = []
  let inFence = false
  let fenceChar = ''

  // 段边界收敛：块分隔空行不进段文本（可视化组件自带 margin，markdown 空行仅是分隔语义）；
  // 围栏内不收敛（未闭合围栏的尾部空行原样保留，交给 streamSafe 处理）
  const flush = () => {
    if (!inFence) {
      while (textBuf.length > 0 && textBuf[textBuf.length - 1].trim() === '') textBuf.pop()
      let start = 0
      while (start < textBuf.length && textBuf[start].trim() === '') start++
      textBuf = textBuf.slice(start)
    }
    if (textBuf.length > 0) {
      segments.push({ type: 'md', text: textBuf.join('\n') })
      textBuf = []
    }
  }

  for (const line of md.split('\n')) {
    const trimmed = line.trim()
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/)
    if (fenceMatch) {
      const ch = fenceMatch[1][0]
      if (!inFence) {
        inFence = true
        fenceChar = ch
      } else if (fenceChar === ch) {
        inFence = false
        fenceChar = ''
      }
      textBuf.push(line)
      continue
    }
    if (!inFence && VIZ_PREFIX_RE.test(trimmed)) {
      const directive = parseVizDirective(trimmed)
      flush()
      if (directive) {
        segments.push({ type: 'viz', directive })
      } else {
        segments.push({ type: 'viz-pending' })
      }
      continue
    }
    textBuf.push(line)
  }
  flush()
  return segments
}
