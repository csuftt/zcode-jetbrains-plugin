/**
 * 内联命令 chip（buildCommandChipHTML）：goal/compact 内置命令专属图标
 * + init 用通用命令图标（用户拍板）+ command/skill 兜底（0.3.2 内置命令图标泛化）
 */
import { describe, expect, it } from 'vitest'
import { buildCommandChipHTML } from '../src/utils/inlineFileTags'

describe('内联命令 chip', () => {
  it('内置命令各配专属图标与配色 variant', () => {
    const goal = buildCommandChipHTML('goal', 'goal', '设定长目标')
    expect(goal).toContain('codicon-target')
    expect(goal).toContain('cmd-ref--goal')

    const compact = buildCommandChipHTML('compact', 'compact')
    expect(compact).toContain('codicon-archive')
    expect(compact).toContain('cmd-ref--compact')
  })

  it('command/skill 通用图标兜底', () => {
    expect(buildCommandChipHTML('review', 'command')).toContain('codicon-terminal')
    expect(buildCommandChipHTML('review', 'command')).toContain('cmd-ref--command')
    expect(buildCommandChipHTML('teach', 'skill')).toContain('codicon-wand')
    expect(buildCommandChipHTML('teach', 'skill')).toContain('cmd-ref--skill')
  })

  it('init 用户拍板用通用命令图标；未配置 meta 的 kind 同样兜底（安全降级）', () => {
    const init = buildCommandChipHTML('init', 'init' as never)
    expect(init).toContain('codicon-terminal')
    expect(init).toContain('cmd-ref--command')
    const future = buildCommandChipHTML('future', 'future' as never)
    expect(future).toContain('codicon-terminal')
    expect(future).toContain('cmd-ref--command')
  })

  it('描述拼进 tooltip，名称/描述 HTML 转义', () => {
    const html = buildCommandChipHTML('init', 'init' as never, '初始化 <AGENTS.md> & 指令文件')
    expect(html).toContain('data-cmd="init"')
    expect(html).toContain('data-tip="/init — 初始化 &lt;AGENTS.md&gt; &amp; 指令文件"')
    expect(html).not.toContain('<AGENTS.md>')
  })
})
