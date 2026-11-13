/**
 * 从根 CHANGELOG.md 生成「版本更新」弹窗数据（What's New，参考 cc-gui extract-changelog.mjs，
 * 适配本项目 Keep a Changelog 格式 + 中英双语段）：
 *
 *   - webview/src/version/changelog.ts  提交仓库（ChangelogEntry[]，最新在前，弹窗分页数据；
 *                                       预发布块剔除——beta 只发 GitHub 预发布、release 页自带
 *                                       描述，弹窗历史只留稳定版，见 omitPrerelease）
 *   - webview/src/version/version.ts    gitignore（APP_VERSION，源头 intellij-plugin/build.gradle.kts，
 *                                       发版版本同步从四处减为三处；单独跑 buildPlugin 用上次
 *                                       生成物，发布走 build.sh 全量构建不受影响）
 *
 * 挂 npm prebuild（build / build:single 前自动执行），保证产物与 CHANGELOG.md 同步
 * （cc-gui 是发版手动跑，这里更进一步）。
 *
 * CHANGELOG.md 解析规则（双语约定见文件头）：
 *   ## [x.y.z] - YYYY-MM-DD     版本头
 *   中文: / English:            语言段标记（cc-gui 同款）：切换后续内容的语言段；
 *                               弹窗中文在前英文在后；无标记的块整块归 zh（旧格式兼容）
 *   ### <节标题>                节（Fixed/Added/Changed 等标准节 + 0.2.0 风格中文自定义节）
 *   - 条目                      列表项（保留 **粗体** / `代码` 行内格式，弹窗内轻量渲染）；
 *                               嵌套子项（缩进 `- `）并入父项（\n- 分隔），渲染层展开二级列表
 *   语言段内、首个节之前的非列表行 → intro 引言段（0.2.0 首版说明 + > 引用）
 *
 * 解析为纯函数（parseChangelog / extractGradleVersion）导出，vitest 覆盖
 * （test/changelog-parse.spec.ts）；main 仅在直接执行时运行。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')

/**
 * 解析 CHANGELOG.md 文本为版本块数组（最新在前，保持文档顺序）。
 * @returns {Array<{version: string, date: string, zh?: {intro?: string, sections: Array}, en?: {intro?: string, sections: Array}}>}
 */
export function parseChangelog(md) {
  const lines = md.split(/\r?\n/)
  const entries = []
  let cur = null
  let lang = null // 当前语言段：'zh' | 'en' | null（版本头之后、首个语言标记之前）
  let content = null
  let section = null

  const startLang = (key) => {
    lang = key
    content = { intro: '', sections: [] }
    cur[key] = content
    section = null
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    // 四段版本号（0.2.3.1 热修复号）为可选第四组；预发布后缀（-beta.1）保留兼容
    const versionMatch = line.match(/^## \[(\d+\.\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)\] - (\d{4}-\d{2}-\d{2})/)
    if (versionMatch) {
      cur = { version: versionMatch[1], date: versionMatch[2] }
      entries.push(cur)
      lang = null
      content = null
      section = null
      continue
    }
    if (!cur) continue // 文件头简介（# Changelog 之后的说明段）不属于任何版本块
    if (/^中文:\s*$/.test(line)) { startLang('zh'); continue }
    // 英文段标记两形态：`English:` 行（0.3.4 及更早）/ `<h3>English</h3>` 行（0.3.5 起）
    if (/^English:\s*$/.test(line) || /^<h3>English<\/h3>\s*$/.test(line)) { startLang('en'); continue }
    if (!lang) {
      // 旧格式兼容：无语言标记的块，首个内容行自动开 zh 段
      if (line.trim()) startLang('zh')
      else continue
    }
    const sectionMatch = line.match(/^### (.+)$/)
    if (sectionMatch) {
      section = { title: sectionMatch[1].trim(), items: [] }
      content.sections.push(section)
      continue
    }
    if (/^- /.test(line)) {
      if (!section) {
        // 列表项先于任何节出现（现有格式不会，防御）：归入一个无标题节
        section = { title: '', items: [] }
        content.sections.push(section)
      }
      section.items.push(line.slice(2).trim())
      continue
    }
    const subMatch = line.match(/^\s+- (.+)$/)
    if (subMatch) {
      // 嵌套子项：并进父项（\n- 分隔），渲染层展开二级列表（如适配块的问题清单）；
      // 无父项可挂时防御性按顶格条目处理
      if (section && section.items.length) section.items[section.items.length - 1] += '\n- ' + subMatch[1].trim()
      else if (section) section.items.push(subMatch[1].trim())
      continue
    }
    if (line.trim() && !section) {
      // 语言段内、首个节之间的引言段（多行累积，保留 > 引用前缀由渲染层处理）
      content.intro = content.intro ? content.intro + '\n' + line.trim() : line.trim()
    }
  }
  return entries.map((e) => {
    const out = { version: e.version, date: e.date }
    for (const key of ['zh', 'en']) {
      if (e[key]) {
        const c = { sections: e[key].sections.filter((s) => s.items.length) }
        if (e[key].intro) c.intro = e[key].intro
        if (c.intro || c.sections.length) out[key] = c
      }
    }
    return out
  })
}

/** 从 build.gradle.kts 文本抽插件版本号（`version = "x.y.z"`），抽不到返回 null */
export function extractGradleVersion(gradleKts) {
  const m = gradleKts.match(/^version\s*=\s*"([^"]+)"/m)
  return m ? m[1] : null
}

/**
 * 剔除预发布版本块（`-beta.1` 等 semver 预发布后缀；四段热修复号 0.2.3.1 不受影响）。
 * beta 只发 GitHub 预发布（release 页自带描述）、不上 Marketplace，正式版发布后
 * 「版本更新」弹窗的历史里不应再出现 beta 页（2026-11-13 定）。
 */
export function omitPrerelease(entries) {
  return entries.filter((e) => !/-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*$/.test(e.version))
}

/** 生成 changelog.ts 源码（JSON 序列化即合法 TS 表达式） */
export function generateChangelogTs(entries) {
  const data = JSON.stringify(entries, null, 2)
  return `// 由 scripts/extract-changelog.mjs 从根 CHANGELOG.md 生成（npm prebuild 自动执行）——请勿手改；
// 修改变更内容请编辑 CHANGELOG.md 后重新构建。

export interface ChangelogSection {
  title: string
  /** 条目；嵌套子项以 '\\n- ' 追加在父项文本内（如适配块的问题清单），渲染层展开二级列表 */
  items: string[]
}

/** 一个语言段的正文（intro 引言 + 分节列表） */
export interface ChangelogContent {
  /** 语言段内、首个节之间的引言段（如 0.2.0 首版说明；多行，> 开头为引用行） */
  intro?: string
  sections: ChangelogSection[]
}

/** 一个版本块：中文段在前英文段后（渲染顺序固定，不随 UI 语言） */
export interface ChangelogEntry {
  version: string
  date: string
  zh?: ChangelogContent
  en?: ChangelogContent
}

export const CHANGELOG_DATA: ChangelogEntry[] = ${data}
`
}

function main() {
  const md = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')
  const entries = parseChangelog(md)
  if (!entries.length) {
    console.error('[extract-changelog] CHANGELOG.md 未解析到任何版本块，中止')
    process.exit(1)
  }
  const gradle = readFileSync(path.join(ROOT, 'intellij-plugin', 'build.gradle.kts'), 'utf8')
  const version = extractGradleVersion(gradle)
  if (!version) {
    console.error('[extract-changelog] intellij-plugin/build.gradle.kts 未找到 version = "..."，中止')
    process.exit(1)
  }
  if (entries[0].version !== version) {
    console.warn(
      `[extract-changelog] 注意：CHANGELOG.md 最新块 [${entries[0].version}] ≠ build.gradle.kts ${version}` +
        '（发版四处同步漏了 CHANGELOG.md？）',
    )
  }
  const stable = omitPrerelease(entries)
  const outDir = path.join(__dirname, '..', 'src', 'version')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(path.join(outDir, 'changelog.ts'), generateChangelogTs(stable), 'utf8')
  writeFileSync(
    path.join(outDir, 'version.ts'),
    `// 由 scripts/extract-changelog.mjs 从 intellij-plugin/build.gradle.kts 生成（npm prebuild 自动执行；\n` +
      `// gitignore 不入库，单独跑 buildPlugin 时沿用上次生成物——发布一律走 ./build.sh 全量构建）。\n\n` +
      `export const APP_VERSION = '${version}'\n`,
    'utf8',
  )
  const langs = stable.map((e) => `${e.version}(${e.zh ? 'zh' : ''}${e.en ? '+en' : ''})`).join(' ')
  const skipped = entries.length - stable.length
  console.log(
    `[extract-changelog] ${stable.length} 个稳定版块${skipped ? `（已剔除 ${skipped} 个预发布块）` : ''} [${langs}]` +
      ` → src/version/changelog.ts；APP_VERSION=${version} → src/version/version.ts`,
  )
}

// 直接执行（node scripts/extract-changelog.mjs）才跑 main；被测试 import 时跳过
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
