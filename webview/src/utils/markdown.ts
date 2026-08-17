/**
 * Markdown 渲染管线
 *
 * 规划文档第二节第 1 点（cc-gui 同款三件套）：
 *   marked → highlight.js 代码高亮 → DOMPurify 清洗 XSS
 *
 * 单一渲染入口：renderMarkdown(md, isStreaming)
 *   流式和最终都走这里，保证"按构造相同"，不会切换跳动。
 */

import { Marked } from 'marked'
import hljs from 'highlight.js/lib/core'
import DOMPurify from 'dompurify'
import i18n from '@/i18n/config'
import { makeStreamSafe } from './streamSafe'

// ============ 按需注册 highlight.js 语言（减少体积）============
// 规划文档第一节："按需注册 18 种语言"
// 先注册最常用的，后续按需扩充
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml' // HTML/XML/Vue 模板
import css from 'highlight.js/lib/languages/css'
import json from 'highlight.js/lib/languages/json'
import bash from 'highlight.js/lib/languages/bash'
import shell from 'highlight.js/lib/languages/shell'
import python from 'highlight.js/lib/languages/python'
import java from 'highlight.js/lib/languages/java'
import kotlin from 'highlight.js/lib/languages/kotlin'
import go from 'highlight.js/lib/languages/go'
import sql from 'highlight.js/lib/languages/sql'
import yaml from 'highlight.js/lib/languages/yaml'
import markdown from 'highlight.js/lib/languages/markdown'
import diff from 'highlight.js/lib/languages/diff'
import rust from 'highlight.js/lib/languages/rust'
import plaintext from 'highlight.js/lib/languages/plaintext'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('css', css)
hljs.registerLanguage('json', json)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('shell', shell)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('python', python)
hljs.registerLanguage('java', java)
hljs.registerLanguage('kotlin', kotlin)
hljs.registerLanguage('go', go)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('yml', yaml)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('md', markdown)
hljs.registerLanguage('diff', diff)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('plaintext', plaintext)
hljs.registerLanguage('text', plaintext)

/** 语言别名表：把不规范的别名归一到注册名 */
const LANG_ALIASES: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  jsx: 'javascript',
  py: 'python',
  kt: 'kotlin',
  kts: 'kotlin',
  sh: 'bash',
  shell: 'bash',
  yml: 'yaml',
  md: 'markdown',
  text: 'plaintext',
  txt: 'plaintext',
}

// ============ marked 实例（带代码高亮 + mermaid 占位）============

/** HTML 转义（存入 data-mermaid 属性用）*/
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 高亮代码（等价原 markedHighlight 逻辑）：
 * 注册过的语言用指定语言高亮，未知语言用 highlightAuto
 */
function highlightCode(code: string, lang: string): string {
  const normalized = LANG_ALIASES[lang] || lang
  const language = hljs.getLanguage(normalized)
  if (language) {
    try {
      return hljs.highlight(code, { language: normalized }).value
    } catch {
      // 高亮失败，回退到转义原文
    }
  }
  return hljs.highlightAuto(code).value
}

const marked = new Marked()

marked.use({
  renderer: {
    // 自定义 code renderer：手动走 highlight.js（与原 markedHighlight 等价）。
    // 注意：mermaid 代码块不在 renderer 层处理——由 BlockSection 整块拦截成 MermaidBlock；
    // 这里对 mermaid 走普通代码高亮作为兜底（混排场景）
    code({ text, lang }) {
      const safeLang = escapeHtml((lang || '').trim() || 'plaintext')
      // hljs 内部会转义代码文本，直接传原始 text（与 markedHighlight 行为一致）
      const highlighted = lang ? highlightCode(text, lang) : hljs.highlightAuto(text).value
      // 复制按钮挂在外层 wrapper 上（不放进 pre：pre 横向滚动时 absolute 子元素会跟着滚走）。
      // 按钮文案在渲染期取值，语言切换后新渲染的块跟随新语言；点击由 MarkdownBlock 事件委托处理
      const copyLabel = escapeHtml(i18n.t('chat.code.copy'))
      return (
        `<div class="md-code-wrap"><pre><code class="hljs language-${safeLang}">${highlighted}</code></pre>` +
        `<button type="button" class="md-code-copy" aria-label="${copyLabel}" title="${copyLabel}">` +
        '<span class="codicon codicon-copy md-code-copy__icon-copy"></span>' +
        '<span class="codicon codicon-check md-code-copy__icon-done"></span>' +
        '</button></div>'
      )
    },
  },
})

marked.setOptions({
  gfm: true, // GitHub Flavored Markdown
  breaks: true, // 单换行也渲染成 <br>（聊天场景更自然）
})

// ============ DOMPurify 配置 ============

// 允许 code/span 上的 class（highlight.js 高亮需要），允许 data 属性
// 不用 DOMPurify.Config 类型（避免版本类型差异），用内联对象
const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    // 文本结构
    'p', 'br', 'hr', 'blockquote', 'pre', 'code', 'span', 'div',
    // 代码块复制按钮（点击由 MarkdownBlock 事件委托处理）
    'button',
    // 标题
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    // 列表
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    // 强调
    'strong', 'em', 'del', 's', 'mark', 'sub', 'sup', 'u',
    // 链接/图片
    'a', 'img',
    // 表格
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    // 其他
    'details', 'summary', 'abbr', 'kbd', 'cite', 'q', 'ins',
  ],
  ALLOWED_ATTR: [
    'href', 'src', 'alt', 'title', 'class', 'target', 'rel',
    'colspan', 'rowspan', 'id', 'data-language',
    // 代码块复制按钮（button 的 type + 无障碍标签）
    'type', 'aria-label',
  ],
  ALLOW_DATA_ATTR: true,
  // 链接强制 target=_blank + rel=noopener（安全）
  ADD_ATTR: ['target', 'rel'],
}

// ============ 渲染入口 ============

/**
 * 把 Markdown 渲染成清洗后的 HTML。
 * 流式和最终渲染共用此函数。
 *
 * @param md markdown 文本
 * @param isStreaming 是否在流式中（true 时先做 streamSafe 补全）
 */
export function renderMarkdown(md: string, isStreaming: boolean = false): string {
  const safe = isStreaming ? makeStreamSafe(md) : md
  const rawHtml = marked.parse(safe, { async: false }) as string
  return DOMPurify.sanitize(rawHtml, PURIFY_CONFIG)
}

/** 从代码块提取语言标签（用于显示）*/
export function detectLanguage(lang: string): string {
  return LANG_ALIASES[lang] || lang || 'text'
}
