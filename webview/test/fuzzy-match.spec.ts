import { describe, expect, it } from 'vitest'
import { fuzzyRank } from '@/utils/fuzzyMatch'

/**
 * /$ 补全模糊打分（fuzzyMatch）单元测试。
 * 算法移植自 Kotlin FileMentionMatcher（issue #38），用例对照其
 * FileMentionMatcherTest 移植并适配名称/描述两级目标形态。
 *
 * 锁定：分隔符等价归一（含插件命名空间冒号 :）、四档降级顺序
 * （名称前缀 > 名称含 > 描述含 > 名称子序列，同档短名优先）、
 * 描述含保底旧行为、乱序/缺失字符不命中、空查询退化长度序。
 */

const GAP = 1 << 24

describe('fuzzyRank', () => {
  it('issue 主例 散点输入跨连字符命中，精确命中排前', () => {
    // 归一后 "work-recap" 不含 "wrecap"，落子序列档
    const fuzzy = fuzzyRank('wrecap', 'work-recap')
    expect(fuzzy).not.toBeNull()
    const exact = fuzzyRank('recap', 'recap')
    expect(exact).not.toBeNull()
    expect(exact!).toBeLessThan(fuzzy!)
  })

  it('分隔符等价 下划线连字符点号冒号互通', () => {
    for (const q of ['git_commit', 'git-commit', 'git.commit']) {
      const rank = fuzzyRank(q, 'git-commit-format')
      expect(rank, `query=${q} 应命中`).not.toBeNull()
      // 前缀档命中，远优于子序列档
      expect(rank!).toBeLessThan(GAP)
    }
    // 目标侧分隔符同样归一：下划线技能名用连字符查询命中名称含档
    const rank = fuzzyRank('recap', 'work_recap')
    expect(rank).not.toBeNull()
    expect(rank!).toBeLessThan(2 * GAP)
  })

  it('插件命名空间冒号 参与等价归一', () => {
    // 散点跨冒号命中（子序列档）
    const subseq = fuzzyRank('zcdiag', 'zcode-guide:diagnosing-mcp')
    expect(subseq).not.toBeNull()
    expect(subseq!).toBeGreaterThanOrEqual(3 * GAP)
    // 归一后直接包含（冒号折为 - 后落在名称含档）
    const contains = fuzzyRank('guide-diag', 'zcode-guide:diagnosing-mcp')
    expect(contains).not.toBeNull()
    expect(contains!).toBeLessThan(2 * GAP)
  })

  it('档位顺序 名称前缀 > 名称含 > 描述含 > 名称子序列', () => {
    const prefix = fuzzyRank('c', 'cc', '其他')
    const contains = fuzzyRank('c', 'xc', '其他')
    const desc = fuzzyRank('规范', 'xfoo', '规范化 Git 提交信息格式')
    const subseq = fuzzyRank('gf', 'xgof', '其他')
    for (const r of [prefix, contains, desc, subseq]) expect(r).not.toBeNull()
    expect(prefix!).toBeLessThan(contains!)
    expect(contains!).toBeLessThan(desc!)
    expect(desc!).toBeLessThan(subseq!)
  })

  it('描述含保底 名称无线索时命中中文描述', () => {
    // 名称 "gc-fix" 不含 "提交" 任何线索，描述命中（空格归一后跨词段）
    const rank = fuzzyRank('提交', 'gc-fix', '规范化 Git 提交信息格式')
    expect(rank).not.toBeNull()
    expect(rank!).toBeGreaterThanOrEqual(2 * GAP)
    expect(rank!).toBeLessThan(3 * GAP)
  })

  it('同档短名优先', () => {
    const short = fuzzyRank('c', 'cc')
    const long = fuzzyRank('c', 'ccc')
    expect(short).not.toBeNull()
    expect(long).not.toBeNull()
    expect(short!).toBeLessThan(long!)
  })

  it('乱序或缺失字符不命中', () => {
    expect(fuzzyRank('recapwork', 'work-recap')).toBeNull()
    expect(fuzzyRank('wrecapz', 'work-recap')).toBeNull()
  })

  it('大小写不敏感', () => {
    expect(fuzzyRank('WRECAP', 'work-recap')).not.toBeNull()
    expect(fuzzyRank('Work-Recap', 'WORK_RECAP')).not.toBeNull()
  })

  it('空查询全匹配退化为名称长度序', () => {
    expect(fuzzyRank('', 'abc')).toBe(3)
    expect(fuzzyRank('', '')).toBe(0)
  })

  it('无描述时跳过描述档不误命中', () => {
    expect(fuzzyRank('foo', 'bar')).toBeNull()
    expect(fuzzyRank('foo', 'bar', undefined)).toBeNull()
  })
})
