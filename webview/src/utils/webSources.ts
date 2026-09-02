/**
 * 网页工具（WebSearch/WebFetch）输出解析：来源链接提取。
 *
 * 实测（2026-09-02 rollout）：WebSearch 输出是"小模型整理后的自由 markdown"——
 * 中段混杂上游工具 trace 转储（```json 代码块里的 "link": "..." JSON 字段），
 * 稳定结构只有整理后的结果列表 `**[标题](URL)**` 与尾部 Sources 列表。
 * 解析策略：剥 code fence → 正则收 markdown 链接 → 按 url 去重；
 * 提取 0 条由调用方回退裸文本预览（输出形态漂移不阻塞）。
 */

export interface WebSource {
  url: string
  /** 链接文本（去 markdown 强调符号、截断）*/
  title: string
  /** 站点域名（去 www. 前缀，弹窗标题/条目次级信息用）*/
  domain: string
}

/** markdown 行内链接 `[text](url)`；负向断言排除图片 `![alt](url)` */
const MD_LINK_RE = /(!*)\[([^\]\n]{1,300}?)\]\((https?:\/\/[^\s)]+)\)/g
/** code fence（``` … ```）整段剥除，防上游 trace 的 JSON 转储误提 */
const CODE_FENCE_RE = /```[\s\S]*?```/g

/** URL → 域名（去 www. 前缀；解析失败回退原样）*/
export function extractDomain(url: string): string {
  try {
    const h = new URL(url).hostname
    return h.replace(/^www\./i, '')
  } catch {
    return url
  }
}

/** 链接文本清理：markdown 强调/空白收敛、超长截断 */
function cleanTitle(raw: string): string {
  const t = raw
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > 100 ? `${t.slice(0, 100)}…` : t
}

/**
 * 从 WebSearch/WebFetch 输出 markdown 提取来源链接列表。
 * @param max 最多保留条数（默认 10，防 trace 爆量撑卡）
 */
export function extractWebSources(markdown: string, max = 10): WebSource[] {
  if (!markdown) return []
  const text = markdown.replace(CODE_FENCE_RE, '')
  const seen = new Set<string>()
  const out: WebSource[] = []
  for (const m of text.matchAll(MD_LINK_RE)) {
    const [, bang, label, url] = m
    if (bang) continue // 图片
    const title = cleanTitle(label)
    if (!title || seen.has(url)) continue
    seen.add(url)
    out.push({ url, title, domain: extractDomain(url) })
    if (out.length >= max) break
  }
  return out
}
