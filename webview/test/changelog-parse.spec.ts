/**
 * extract-changelog.mjs 解析逻辑测试（纯函数，import 脚本模块不触发 main）
 *
 * 覆盖：双语语言段（中文:/English:）/ 版本头/节/条目/intro 引言（含 > 引用）/
 *       文件头忽略/空节过滤/旧格式无语言标记归 zh /
 *       build.gradle.kts 版本抽取 / changelog.ts 生成物可回读 /
 *       预发布块剔除（弹窗版本记录只留稳定版）
 */

import { describe, it, expect } from 'vitest'
import { parseChangelog, extractGradleVersion, generateChangelogTs, omitPrerelease } from '../scripts/extract-changelog.mjs'
import { CHANGELOG_DATA } from '@/version/changelog'

const SAMPLE = `# Changelog

本项目遵循 Keep a Changelog 格式，双语约定见文件头。

## [0.2.3] - 2026-08-25

中文:

### Fixed

- **修复甲**：描述一

English:

### Fixed

- **Fix A**: description one

## [0.2.0] - 2026-08-18

中文:

首个稳定版本说明段。

> 社区第三方插件，与官方无关。

### 对话

- 流式输出

English:

First stable release.

### Conversation

- Streaming output

## [0.1.0] - 2026-08-12

### Removed

- 旧入口
`

describe('parseChangelog', () => {
  it('按版本块解析（最新在前，保持文档顺序）', () => {
    const entries = parseChangelog(SAMPLE)
    expect(entries.map((e) => e.version)).toEqual(['0.2.3', '0.2.0', '0.1.0'])
    expect(entries[0].date).toBe('2026-08-25')
  })

  it('文件头简介不属于任何版本块', () => {
    const entries = parseChangelog(SAMPLE)
    expect(entries.length).toBe(3)
  })

  it('双语语言段：zh 与 en 各自成节，行内格式原文保留', () => {
    const e = parseChangelog(SAMPLE)[0]
    expect(e.zh.sections.map((s) => s.title)).toEqual(['Fixed'])
    expect(e.zh.sections[0].items).toEqual(['**修复甲**：描述一'])
    expect(e.en.sections.map((s) => s.title)).toEqual(['Fixed'])
    expect(e.en.sections[0].items).toEqual(['**Fix A**: description one'])
  })

  it('语言段内、首节之前的非列表行累积为 intro（含 > 引用行）', () => {
    const e = parseChangelog(SAMPLE)[1]
    expect(e.zh.intro).toBe('首个稳定版本说明段。\n> 社区第三方插件，与官方无关。')
    expect(e.zh.sections[0].title).toBe('对话') // 中文自定义节名原样保留
    expect(e.en.intro).toBe('First stable release.')
    expect(e.en.sections[0].title).toBe('Conversation')
  })

  it('旧格式兼容：无语言标记的块整块归 zh', () => {
    const e = parseChangelog(SAMPLE)[2]
    expect(e.zh.sections.map((s) => s.title)).toEqual(['Removed'])
    expect(e.en).toBeUndefined()
  })

  it('空节被过滤、空语言段不产出', () => {
    const md = '## [1.0.0] - 2026-01-01\n\n中文:\n\n### Empty\n\n### Added\n\n- 甲\n\nEnglish:\n'
    const e = parseChangelog(md)[0]
    expect(e.zh.sections.map((s) => s.title)).toEqual(['Added'])
    expect(e.en).toBeUndefined()
  })

  it('空文本返回空数组', () => {
    expect(parseChangelog('')).toEqual([])
  })

  it('四段热修复版本号（0.2.3.1）与预发布后缀均可识别为版本块', () => {
    // 回归：四段号曾被版本头正则跳过，块内容被并入上一块（0.2.3.1 弹窗显示 0.2.3 内容）
    const md = [
      '## [0.2.3] - 2026-08-24', '', '中文:', '', '### Fixed', '', '- 旧块', '',
      '## [0.2.3.1] - 2026-08-25', '', '中文:', '', '### Fixed', '', '- 热修复块', '',
      '## [0.3.0-beta.1] - 2026-09-01', '', '中文:', '', '### Added', '', '- 预发布块',
    ].join('\n')
    const entries = parseChangelog(md)
    expect(entries.map((e) => e.version)).toEqual(['0.2.3', '0.2.3.1', '0.3.0-beta.1'])
    expect(entries[1].zh.sections[0].items).toEqual(['热修复块'])
    expect(entries[2].zh.sections[0].items).toEqual(['预发布块'])
  })

  it('嵌套子项并进父项（\\n- 分隔），渲染层展开二级列表', () => {
    // 回归：嵌套子项曾被整行丢弃（适配块的问题清单在弹窗里消失）
    const md = [
      '## [1.0.0] - 2026-11-13', '', '中文:', '', '### 适配', '',
      '- **适配 XX**（说明）：', '',
      '  - 子项一；',
      '  - 子项二。',
    ].join('\n')
    const e = parseChangelog(md)[0]
    expect(e.zh.sections[0].items).toEqual(['**适配 XX**（说明）：\n- 子项一；\n- 子项二。'])
  })

  it('嵌套子项无父项可挂时按顶格条目处理（防御）', () => {
    const md = '## [1.0.0] - 2026-11-13\n\n中文:\n\n### Fixed\n\n  - 孤儿子项'
    const e = parseChangelog(md)[0]
    expect(e.zh.sections[0].items).toEqual(['孤儿子项'])
  })
})

describe('extractGradleVersion', () => {
  it('抽取 version = "x.y.z"', () => {
    expect(extractGradleVersion('plugins {\n}\n\nversion = "0.2.2"\n')).toBe('0.2.2')
  })

  it('抽不到返回 null', () => {
    expect(extractGradleVersion('plugins {}')).toBeNull()
  })
})

describe('generateChangelogTs', () => {
  it('生成物含类型与数据，可 JSON 回读', () => {
    const entries = parseChangelog(SAMPLE)
    const ts = generateChangelogTs(entries)
    expect(ts).toContain('export const CHANGELOG_DATA: ChangelogEntry[] = [')
    expect(ts).toContain('export interface ChangelogContent')
    // 数据段是 JSON：从 = 后截取回读
    const json = ts.slice(ts.indexOf('= ', ts.indexOf('CHANGELOG_DATA')) + 2)
    expect(JSON.parse(json)).toEqual(entries)
  })
})

describe('omitPrerelease', () => {
  it('预发布块（-beta.N）不入弹窗版本记录，稳定版与四段热修复块保留', () => {
    const md = [
      '## [1.1.0-beta.2] - 2026-11-13', '', '中文:', '', '### Added', '', '- beta2', '',
      '## [1.1.0-beta.1] - 2026-11-12', '', '中文:', '', '### Added', '', '- beta1', '',
      '## [1.0.0] - 2026-11-11', '', '中文:', '', '### Added', '', '- 稳定版', '',
      '## [0.2.3.1] - 2026-08-25', '', '中文:', '', '### Fixed', '', '- 热修复',
    ].join('\n')
    const kept = omitPrerelease(parseChangelog(md))
    expect(kept.map((e) => e.version)).toEqual(['1.0.0', '0.2.3.1'])
    expect(omitPrerelease([])).toEqual([])
  })
})

describe('CHANGELOG_DATA（提交仓库的生成物）', () => {
  it('不含预发布块（beta 只写 GitHub release 描述，不进弹窗版本记录）', () => {
    expect(CHANGELOG_DATA.every((e) => /^\d+\.\d+\.\d+(\.\d+)?$/.test(e.version))).toBe(true)
  })
})
