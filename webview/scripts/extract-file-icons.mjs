/**
 * 从 cc-gui（jetbrains-cc-gui-main，MIT）提取常用文件类型 SVG 图标，
 * 生成 webview/src/utils/fileIcons.ts（内联 SVG 字符串，适配 singlefile 打包）。
 *
 * 用法：node scripts/extract-file-icons.mjs <cc-gui 仓库路径>
 * 重新生成时只需调整下方 ICONS 白名单。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// cc-gui 仓库根目录（jetbrains-cc-gui-main，MIT），从命令行参数传入
const SRC = process.argv[2]
if (!SRC) {
  console.error('用法: node scripts/extract-file-icons.mjs <cc-gui 仓库路径>')
  process.exit(1)
}
const ICON_SRC = join(SRC, 'webview/src/utils/icons')
const OUT = 'src/utils/fileIcons.ts'

/** 需要提取的图标白名单（cc-gui 常量名，去掉 icon_ 前缀）*/
const ICONS = [
  'python', 'java', 'typescript', 'javascript', 'kotlin', 'go', 'rust', 'c', 'cpp',
  'csharp', 'swift', 'ruby', 'php', 'dart', 'scala', 'lua',
  'html', 'css', 'sass', 'less', 'vue', 'svelte', 'json', 'yaml', 'toml', 'markdown',
  'xml', 'graphql', 'proto',
  'database', 'image', 'svg', 'pdf', 'docker', 'makefile', 'gradle', 'maven',
  'console', 'powershell', 'git',
  'document', 'zip', 'log', 'lock', 'key', 'font', 'video', 'audio',
  'word', 'powerpoint', 'table', 'jupyter', 'certificate',
  'file', 'folder',
]

const files = ['generic-icons.ts', 'tech-icons-1.ts', 'tech-icons-2.ts', 'tech-icons-3.ts', 'folder-icons.ts']
const found = new Map()
for (const f of files) {
  const content = readFileSync(join(ICON_SRC, f), 'utf-8')
  const re = /export const (icon_\w+) = `([^`]*)`;/g
  let m
  while ((m = re.exec(content))) {
    const name = m[1].replace('icon_', '')
    if (ICONS.includes(name)) found.set(name, m[2])
  }
}

const missing = ICONS.filter((n) => !found.has(n))
if (missing.length) {
  console.error('Missing icons:', missing)
  process.exit(1)
}

const entries = ICONS.map((n) => `  ${n}: \`${found.get(n)}\`,`).join('\n')

const output = `/**
 * 文件类型 SVG 图标（按文件名/扩展名映射，对齐 cc-gui fileIconMaps 精简版）
 *
 * SVG 为内联字符串（适配 vite-plugin-singlefile 打包，无外部资源请求）。
 * 来源：jetbrains-cc-gui（MIT）webview/src/utils/fileIconMaps.ts。
 * ICONS 段由 webview/scripts/extract-file-icons.mjs 提取生成勿手改；
 * EXTENSION_MAP/FILE_NAME_MAP 为手工维护，改动须同步脚本内模板（重生成整体覆盖）。
 */

/** 图标 SVG 常量 */
export const ICONS: Record<string, string> = {
${entries}
}

/** 特殊文件名 → 图标（全小写精确匹配）*/
const FILE_NAME_MAP: Record<string, string> = {
  'dockerfile': 'docker',
  'makefile': 'makefile',
  'jenkinsfile': 'console',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  'license': 'certificate',
  'license.txt': 'certificate',
  'license.md': 'certificate',
  'pom.xml': 'maven',
  'build.gradle': 'gradle',
  'build.gradle.kts': 'gradle',
  'gradlew': 'gradle',
  'gradlew.bat': 'gradle',
  'package.json': 'javascript',
  'package-lock.json': 'javascript',
  'tsconfig.json': 'typescript',
  'jsconfig.json': 'javascript',
  'readme.md': 'markdown',
  'changelog.md': 'markdown',
  'requirements.txt': 'python',
  'pyproject.toml': 'python',
  'setup.py': 'python',
  'go.mod': 'go',
  'go.sum': 'go',
  'cargo.toml': 'rust',
  'cargo.lock': 'rust',
}

/** 扩展名 → 图标（小写）*/
const EXTENSION_MAP: Record<string, string> = {
  // 主流语言
  py: 'python', pyw: 'python',
  java: 'java',
  ts: 'typescript', tsx: 'typescript', cts: 'typescript', mts: 'typescript',
  js: 'javascript', jsx: 'javascript', cjs: 'javascript', mjs: 'javascript',
  kt: 'kotlin', kts: 'kotlin',
  go: 'go',
  rs: 'rust',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', 'c++': 'cpp', hpp: 'cpp', hxx: 'cpp',
  cs: 'csharp', csproj: 'csharp', sln: 'csharp',
  swift: 'swift',
  rb: 'ruby',
  php: 'php',
  dart: 'dart', scala: 'scala', sc: 'scala', lua: 'lua',
  // 标记 / 样式
  html: 'html', htm: 'html',
  xml: 'xml', svg: 'svg',
  css: 'css', scss: 'sass', sass: 'sass', less: 'less',
  vue: 'vue', svelte: 'svelte',
  // 配置 / 数据
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  graphql: 'graphql', gql: 'graphql',
  proto: 'proto',
  properties: 'git', ini: 'git', cfg: 'git', conf: 'git',
  // 文档
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  txt: 'document', rtf: 'document',
  csv: 'table', tsv: 'table', xls: 'table', xlsx: 'table',
  // 构建 / 脚本
  gradle: 'gradle', cmake: 'makefile',
  sh: 'console', bash: 'console', zsh: 'console', fish: 'console',
  bat: 'console', cmd: 'console',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  // 数据库
  sql: 'database', db: 'database', sqlite: 'database',
  // 媒体 / 二进制
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
  ico: 'image', bmp: 'image',
  mp4: 'video', webm: 'video', mov: 'video', m4v: 'video', avi: 'video', mkv: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', ogg: 'audio', opus: 'audio', flac: 'audio', weba: 'audio',
  ttf: 'font', otf: 'font', woff: 'font', woff2: 'font', eot: 'font',
  pdf: 'pdf',
  doc: 'word', docx: 'word',
  ppt: 'powerpoint', pptx: 'powerpoint',
  zip: 'zip', tar: 'zip', gz: 'zip', rar: 'zip', '7z': 'zip',
  exe: 'console', dll: 'console', so: 'console',
  // 其他
  log: 'log', lock: 'lock',
  key: 'key', pem: 'key', pub: 'key', crt: 'certificate', cer: 'certificate',
  ipynb: 'jupyter',
}

/**
 * 取文件路径对应的图标 SVG。
 * @param filePath 文件路径或文件名（文件夹路径末尾带分隔符时返回 folder）
 */
export function getFileIcon(filePath: string): string {
  const name = filePath.replace(/[\\\\/]+$/, '').replace(/\\\\/g, '/').split('/').pop() || filePath
  // 文件夹：路径末尾带分隔符由调用方判断（isDirectory），这里只处理文件名
  const lower = name.toLowerCase()
  if (FILE_NAME_MAP[lower]) return ICONS[FILE_NAME_MAP[lower]]
  const dot = lower.lastIndexOf('.')
  const ext = dot !== -1 && dot < lower.length - 1 ? lower.slice(dot + 1) : ''
  if (ext && EXTENSION_MAP[ext]) return ICONS[EXTENSION_MAP[ext]]
  return ICONS.file
}

/** 默认文件夹图标 */
export function getFolderIcon(): string {
  return ICONS.folder
}
`

writeFileSync(OUT, output, 'utf-8')
console.log(`Generated ${OUT} (${ICONS.length} icons, ${(output.length / 1024).toFixed(1)}KB)`)
