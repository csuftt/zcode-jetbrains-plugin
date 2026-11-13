/**
 * $ 技能提及（H4，对齐官方 MentionPlugin 三 trigger）：
 * 触发判定 / 序列化双形态 / 内联 chip DOM / 编辑器文本回转 chip / 消息回显识别
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  matchSkillRefTrigger,
  skillRefText,
  skillShortName,
  SKILL_MD_RE,
  SKILL_BARE_RE,
  unescapeSkillMd,
} from '../src/utils/skillRefPattern'
import {
  buildSkillChipHTML,
  buildCommandChipHTML,
  serializeEditor,
  convertCompletedSkillRefs,
} from '../src/utils/inlineFileTags'
import { renderUserRefChips, hasUserRefChips, type CmdRefInfo } from '../src/utils/userRefChips'

function makeEditor(html: string): HTMLElement {
  const el = document.createElement('div')
  el.innerHTML = html
  document.body.appendChild(el)
  return el
}

describe('$ 技能提及触发判定（matchSkillRefTrigger）', () => {
  it('行首/空白后触发，¥/￥ 归一', () => {
    expect(matchSkillRefTrigger('$co')).toBe('co')
    expect(matchSkillRefTrigger('用 $code-review')).toBe('code-review')
    expect(matchSkillRefTrigger('¥re')).toBe('re')
    expect(matchSkillRefTrigger('￥full')).toBe('full')
  })

  it('前置非空白不触发（金额/变量粘连）', () => {
    expect(matchSkillRefTrigger('成本$100')).toBeNull()
    expect(matchSkillRefTrigger('(a)$b')).toBeNull()
  })

  it('纯数字 query 不触发（$5 金额），字母开头正常', () => {
    expect(matchSkillRefTrigger('$5')).toBeNull()
    expect(matchSkillRefTrigger('$100')).toBeNull()
    expect(matchSkillRefTrigger('$5x')).toBeNull() // 非字母开头
    expect(matchSkillRefTrigger('$a5')).toBe('a5')
  })

  it('裸 $ 与空 query 触发空串（面板可弹）', () => {
    expect(matchSkillRefTrigger('$')).toBe('')
    expect(matchSkillRefTrigger('看 $')).toBe('')
  })

  it('query 不吞触发字符（$ 交叉即不触发）', () => {
    // '$a$b'：query 字符类排除 $，正则要求匹配到串尾，$ 交叉处断链 → 整体不触发
    expect(matchSkillRefTrigger('$a')).toBe('a')
    expect(matchSkillRefTrigger('$a$b')).toBeNull()
  })
})

describe('技能提及序列化（skillRefText 双形态）', () => {
  it('有路径走 markdown 链接，路径反斜杠转义', () => {
    expect(skillRefText('code-review', 'C:\\skills\\review')).toBe(
      '[$code-review](C:\\\\skills\\\\review)',
    )
    expect(skillRefText('x', '/home/u/.zcode/skills/x')).toBe('[$x](/home/u/.zcode/skills/x)')
  })

  it('无路径退化裸 token', () => {
    expect(skillRefText('plain')).toBe('$plain')
  })

  it('名称转义只在链接形态（裸 token 不转义）', () => {
    expect(skillRefText('a[b]c', '/p')).toBe('[$a\\[b\\]c](/p)')
    expect(skillRefText('plain')).toBe('$plain')
  })

  it('markdown 链接可被 SKILL_MD_RE 还原（转义往返）', () => {
    const text = skillRefText('code-review', 'C:\\skills\\review')
    const m = SKILL_MD_RE.exec(text)!
    expect(m[1]).toBe('$')
    expect(unescapeSkillMd(m[2])).toBe('code-review')
    expect(unescapeSkillMd(m[3])).toBe('C:\\skills\\review')
    SKILL_MD_RE.lastIndex = 0
  })

  it('SKILL_MD_RE 不吃普通 md 链接与会话链接', () => {
    SKILL_MD_RE.lastIndex = 0
    expect(SKILL_MD_RE.exec('[看这个](./a.md)')).toBeNull()
    SKILL_MD_RE.lastIndex = 0
    expect(SKILL_MD_RE.exec('[#标题](#sess_ab)')).toBeNull()
    SKILL_MD_RE.lastIndex = 0
  })

  it('SKILL_BARE_RE 词边界识别（中文/空白边界）', () => {
    const m = SKILL_BARE_RE.exec('用 $code-review 帮我')!
    expect(m[2]).toBe('code-review')
    SKILL_BARE_RE.lastIndex = 0
    // $ 前是字母（金额粘连）不匹配
    expect(SKILL_BARE_RE.exec('成本$100')).toBeNull()
    SKILL_BARE_RE.lastIndex = 0
  })
})

describe('技能 chip 展示短名（skillShortName，对齐官方客户端）', () => {
  it('剥插件命名空间前缀，无前缀原样返回', () => {
    expect(skillShortName('mattpocock-skills:grill-with-docs')).toBe('grill-with-docs')
    expect(skillShortName('browser-use:control-browser')).toBe('control-browser')
    expect(skillShortName('code-review')).toBe('code-review')
  })

  it('只剥首个冒号前缀（叶子名自身可含冒号）', () => {
    expect(skillShortName('plugin:a:b')).toBe('a:b')
  })

  it('内联技能 chip：展示短名，data-cmd/tip 保留全名（序列化不受影响）', () => {
    const html = buildSkillChipHTML('mattpocock-skills:grill-with-docs', 'C:\\s\\g')
    expect(html).toContain('data-cmd="mattpocock-skills:grill-with-docs"')
    expect(html).toContain('data-tip="$mattpocock-skills:grill-with-docs — C:\\s\\g"')
    expect(html).toContain('>grill-with-docs</span>')
    expect(html).not.toContain('>mattpocock-skills:grill-with-docs</span>')
  })

  it('/ 面板命令 chip：技能剥前缀，命令冒号是嵌套目录名不剥', () => {
    const skillHtml = buildCommandChipHTML('mattpocock-skills:grill-me', 'skill')
    expect(skillHtml).toContain('>grill-me</span>')
    expect(skillHtml).toContain('data-cmd="mattpocock-skills:grill-me"')
    const cmdHtml = buildCommandChipHTML('review:code', 'command')
    expect(cmdHtml).toContain('>review:code</span>')
    expect(cmdHtml).toContain('data-cmd="review:code"')
  })
})

describe('内联技能 chip（buildSkillChipHTML + serializeEditor）', () => {
  it('chip 结构：cmd-ref--skill 变体 + data-skill 标记 + data-path', () => {
    const html = buildSkillChipHTML('code-review', 'C:\\s\\review', '审查代码')
    expect(html).toContain('cmd-ref--skill')
    expect(html).toContain('data-skill="1"')
    expect(html).toContain('data-cmd="code-review"')
    expect(html).toContain('data-path="C:\\s\\review"')
    expect(html).toContain('codicon-wand')
    expect(html).toContain('data-tip="$code-review — C:\\s\\review"')
  })

  it('无路径 chip 无 data-path', () => {
    expect(buildSkillChipHTML('plain')).not.toContain('data-path')
  })

  it('序列化：data-skill chip 走 skillRefText，普通命令 chip 仍 /name', () => {
    const el = makeEditor('<span class="cmd-ref cmd-ref--inline" data-cmd="goal"></span>')
    expect(serializeEditor(el)).toBe('/goal')
    const el2 = makeEditor(
      '<span class="cmd-ref cmd-ref--inline" data-cmd="code-review" data-skill="1" data-path="C:\\s\\r"></span>',
    )
    expect(serializeEditor(el2)).toBe('[$code-review](C:\\\\s\\\\r)')
    const el3 = makeEditor('<span class="cmd-ref cmd-ref--inline" data-cmd="plain" data-skill="1"></span>')
    expect(serializeEditor(el3)).toBe('$plain')
  })
})

describe('convertCompletedSkillRefs（回填转 chip）', () => {
  it('markdown 链接形态转 chip（保留路径属性；fixture 用序列化产物原形——反斜杠已转义）', () => {
    const el = makeEditor('先用 [$code-review](C:\\\\s\\\\r) 审一遍')
    expect(convertCompletedSkillRefs(el)).toBe(true)
    const chip = el.querySelector('[data-skill="1"]') as HTMLElement
    expect(chip?.getAttribute('data-cmd')).toBe('code-review')
    expect(chip?.getAttribute('data-path')).toBe('C:\\s\\r')
  })

  it('裸 token 白名单命中转 chip（resolver 反查路径）', () => {
    const el = makeEditor('用 $code-review 帮我')
    expect(
      convertCompletedSkillRefs(el, (name) => (name === 'code-review' ? '/s/review' : undefined)),
    ).toBe(true)
    const chip = el.querySelector('[data-skill="1"]') as HTMLElement
    expect(chip?.getAttribute('data-path')).toBe('/s/review')
  })

  it('白名单外裸 token 保留原文（防 $5 金额误伤）', () => {
    const el = makeEditor('这功能收 $5 好贵')
    expect(convertCompletedSkillRefs(el, () => undefined)).toBe(false)
    expect(el.querySelector('[data-skill="1"]')).toBeNull()
  })
})

describe('消息回显识别（renderUserRefChips）', () => {
  const cmdNames = new Map<string, CmdRefInfo>([
    ['code-review', { kind: 'skill', path: 'C:\\s\\r' }],
    ['review', { kind: 'command' }],
  ])

  it('markdown 技能链接 → 紫色 skill chip（title 带路径）', () => {
    const node = renderUserRefChips('先跑 [$code-review](C:\\s\\r) 再说', undefined, cmdNames)
    const html = renderToText(node)
    expect(html).toContain('cmd-ref--skill')
    expect(html).toContain('code-review')
  })

  it('裸 $技能（白名单内）→ chip；白名单外原样', () => {
    const hit = renderUserRefChips('用 $code-review 审查', undefined, cmdNames)
    expect(renderToText(hit)).toContain('cmd-ref--skill')
    const miss = renderUserRefChips('收你 $5', undefined, cmdNames)
    expect(renderToText(miss)).not.toContain('cmd-ref')
  })

  it('普通 /命令 识别不受影响', () => {
    const node = renderUserRefChips('跑 /review', undefined, cmdNames)
    expect(renderToText(node)).toContain('cmd-ref--command')
  })

  it('插件技能 chip 展示短名（剥命名空间前缀，对齐官方客户端）', () => {
    const pluginNames = new Map<string, CmdRefInfo>([
      ['mattpocock-skills:grill-with-docs', { kind: 'skill', path: 'C:\\s\\g' }],
    ])
    const node = renderUserRefChips('先跑 [$mattpocock-skills:grill-with-docs](C:\\s\\g)', undefined, pluginNames)
    const html = renderToText(node)
    expect(html).toContain('cmd-ref--skill')
    expect(html).toContain('grill-with-docs')
    expect(html).not.toContain('mattpocock-skills')
  })

  it('hasUserRefChips 覆盖技能两类形态', () => {
    expect(hasUserRefChips('[$code-review](C:\\s\\r)', cmdNames)).toBe(true)
    expect(hasUserRefChips('用 $code-review', cmdNames)).toBe(true)
    expect(hasUserRefChips('用 $unknown-skill', cmdNames)).toBe(false)
    expect(hasUserRefChips('普通文本', cmdNames)).toBe(false)
  })

  function renderToText(node: unknown): string {
    // ReactNode 是元素时用其 props 粗提取（测试只断言 class/文本存在性）
    const parts: string[] = []
    const visit = (n: unknown): void => {
      if (n === null || n === undefined || typeof n === 'boolean') return
      if (typeof n === 'string' || typeof n === 'number') {
        parts.push(String(n))
        return
      }
      if (Array.isArray(n)) {
        n.forEach(visit)
        return
      }
      const el = n as { props?: { className?: string; title?: string; children?: unknown } }
      if (el?.props) {
        if (el.props.className) parts.push(el.props.className)
        if (el.props.title) parts.push(el.props.title)
        visit(el.props.children)
      }
    }
    visit(node)
    return parts.join(' ')
  }
})
