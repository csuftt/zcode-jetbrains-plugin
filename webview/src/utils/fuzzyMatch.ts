/**
 * /$ 补全候选打分匹配（InputBox 的 / 命令·技能·子智能体下拉与 $ 技能面板共用）。
 *
 * 算法移植自 Kotlin 侧 @ 文件补全的 FileMentionMatcher（issue #38 五档降级），
 * 按命令/技能候选形态泛化为名称/描述两级目标：
 *
 * 分隔符 _ - . : 空格 / 与大小写在两侧归一为同一形态（work_recap ≡ work-recap，
 * 散点输入靠子序列层命中）；: 参与等价是本场景特有——技能名含插件命名空间冒号
 * （zcode-guide:diagnosing-mcp 须跨冒号命中）。归一后按四档降级：
 * 0 名称前缀 / 1 名称含 / 2 描述含（保底旧 includes 行为）/ 3 名称子序列。
 * 描述不做子序列档（中文长描述散点命中噪声大）。同档短名优先。
 *
 * 候选池全量在 webview 内存（slashItems，几十条量级），匹配留在前端即可，
 * 不为按键走 IPC 到 Kotlin（那边 FileMentionMatcher 只服务 @ 文件路径）。
 */

const TIER_GAP = 1 << 24

/** 空查询全匹配（返回 name.length 退化长度序，对齐 Kotlin 版）；调用方空查询时
 * 通常跳过按 rank 排序以保留原顺序，此返回值仅为「全收」契约。*/
export function fuzzyRank(query: string, name: string, description?: string): number | null {
  const q = normalize(query)
  if (!q) return name.length
  const nName = normalize(name)
  let tier: number
  if (nName.startsWith(q)) tier = 0
  else if (nName.includes(q)) tier = 1
  else if (description && normalize(description).includes(q)) tier = 2
  else if (isSubsequence(q, nName)) tier = 3
  else return null
  return tier * TIER_GAP + name.length
}

/** 分隔符归一：_ - . : 空格 / 统一折为 -（比 Kotlin 文件版多 : ，命名空间冒号）*/
const SEPARATOR_RE = /[\s_\-./:]/

function normalize(s: string): string {
  let out = ''
  for (const c of s.toLowerCase()) out += SEPARATOR_RE.test(c) ? '-' : c
  return out
}

function isSubsequence(query: string, target: string): boolean {
  if (query.length > target.length) return false
  let qi = 0
  for (const c of target) {
    if (qi < query.length && c === query[qi]) qi++
  }
  return qi === query.length
}
