import { describe, it, expect } from 'vitest'
import { extractWebSources, extractDomain } from '../src/utils/webSources'

/** 真实形态样例（2026-09-02 rollout 实抓）：trace 转储 + 整理后列表混合 */
const REAL_SHAPE = `Web search results for query: "IntelliJ JCEF plugin open external link"

Summary:
**🌐 Z.ai Built-in Tool: web_search_prime**

**Input:**
\`\`\`json
{"content_size":"medium","location":"cn","search_query":"IntelliJ JCEF plugin"}
\`\`\`
*Executing on server...*

Here are the search results for your query:

1. **[Plugin implemented using JCEF API - How to open hyperlinks](https://intellij-support.jetbrains.com/hc/en-us/community/posts/360009678839)** (JetBrains Support)
   - This is directly on-topic.

2. **[Embedded Browser (JCEF) | IntelliJ Platform Plugin SDK](https://plugins.jetbrains.com/docs/intellij/embedded-browser-jcef.html)** (Official Docs)

3. **[JCEF reference guide (jcef.md) on GitHub](https://github.com/hltj/intellij/blob/master/reference_guide/jcef.md?plain=1)**

Sources:
- [Embedded Browser (JCEF)](https://plugins.jetbrains.com/docs/intellij/embedded-browser-jcef.html)
- [JetBrains Support](https://intellij-support.jetbrains.com/hc/en-us/community/posts/360009678839)`

describe('extractWebSources', () => {
  it('真实形态：提取去重后的来源列表（结果列表与 Sources 段同 url 合并）', () => {
    const out = extractWebSources(REAL_SHAPE)
    expect(out.map((s) => s.domain)).toEqual([
      'intellij-support.jetbrains.com',
      'plugins.jetbrains.com',
      'github.com',
    ])
    expect(out[0].title).toBe('Plugin implemented using JCEF API - How to open hyperlinks')
  })

  it('code fence 里的 JSON "link" 字段不误提（非 markdown 链接语法）', () => {
    const md = '前置说明\n```json\n{"link": "https://example.com/a"}\n```\n[真链接](https://example.com/real)'
    const out = extractWebSources(md)
    expect(out).toHaveLength(1)
    expect(out[0].url).toBe('https://example.com/real')
  })

  it('图片 ![alt](url) 不算来源', () => {
    const out = extractWebSources('![截图](https://img.example.com/x.png)\n[文档](https://docs.example.com)')
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('文档')
  })

  it('非 http(s) 与空标题链接跳过', () => {
    const out = extractWebSources('[ftp 链接](ftp://x.com/a)\n[](https://empty-title.com)\n[好的](https://ok.com)')
    expect(out).toHaveLength(1)
    expect(out[0].url).toBe('https://ok.com')
  })

  it('标题清理：去 ** 强调、空白收敛、超 100 字截断', () => {
    const long = 'x'.repeat(150)
    const out = extractWebSources(`**[  ${long}  ](https://long.com)**`)
    expect(out[0].title).toBe(`${'x'.repeat(100)}…`)
  })

  it('max 上限防爆量', () => {
    const md = Array.from({ length: 30 }, (_, i) => `[条目${i}](https://s.com/${i})`).join('\n')
    expect(extractWebSources(md)).toHaveLength(10)
    expect(extractWebSources(md, 3)).toHaveLength(3)
  })

  it('空串 / 无链接输出返回空数组（调用方回退裸文本）', () => {
    expect(extractWebSources('')).toEqual([])
    expect(extractWebSources('The server returned HTTP 404 Not Found.')).toEqual([])
  })
})

describe('extractDomain', () => {
  it('去 www. 前缀', () => {
    expect(extractDomain('https://www.jetbrains.com/docs/x.html')).toBe('jetbrains.com')
  })
  it('非 www 域名原样', () => {
    expect(extractDomain('https://plugins.jetbrains.com/docs/x')).toBe('plugins.jetbrains.com')
  })
  it('解析失败回退原串', () => {
    expect(extractDomain('not a url')).toBe('not a url')
  })
})
