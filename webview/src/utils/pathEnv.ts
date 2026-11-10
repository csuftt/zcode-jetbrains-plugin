/**
 * 环境变量占位符路径展开（缺陷 GZ，纯函数）
 *
 * AI 正文常写 `%TEMP%\x.md`、`$TMPDIR/x.md`、`${HOME}/x.md` 这类占位符路径
 * （workspace 本身挂在临时目录下时尤其常见）。linkify 的 PATH_TOKEN 段字符类
 * 含 `%` 会把它们渲染成 chip，但严格解析器（resolveFileLink / resolvePreviewPath）
 * 原本不认识占位符——要么拼成 workspace 相对死链（点击无反应），要么门控
 * 匹配失败（md/html 产物卡不出）。本模块用 Java 下发的路径类环境变量白名单
 * （store.pathEnv，getPathEnv op，canonical 化长路径）做同步展开。
 *
 * 边界约定：
 *  - `~` 不在此展开（官方对齐的拒绝语义，previewArtifacts/linkify 各自的注释）
 *  - vars=null（白名单未到达）或变量查不到 → 原样返回，调用方以
 *    `hasPathPlaceholder(展开后)` 仍为 true 判「不可解析」→ 不链接/不出卡
 *    （「死链不如不链」原则）
 *  - 大小写：精确名优先，全大写名兜底（Windows env 约定全大写，AI 可能写 %temp%）
 *  - 多轮替换覆盖相邻组合（%HOMEDRIVE%%HOMEPATH%）
 */

const WINDOWS_VAR = /%([A-Za-z0-9_()]+)%/g
const UNIX_VAR = /\$\{([A-Za-z0-9_]+)\}|\$([A-Za-z0-9_]+)/g

const MAX_PASSES = 3

/** 路径里是否还有未展开的占位符（Windows %NAME% / Unix ${NAME} / $NAME） */
export function hasPathPlaceholder(path: string): boolean {
  return /%[A-Za-z0-9_()]+%|\$\{[A-Za-z0-9_]+\}|\$[A-Za-z0-9_]+/.test(path)
}

function lookupVar(vars: Record<string, string>, name: string): string | undefined {
  return vars[name] ?? vars[name.toUpperCase()]
}

/**
 * 展开占位符路径。vars=null（白名单未到达）时原样返回；查不到的变量原样保留
 * （调用方用 hasPathPlaceholder 复检判定不可解析）。
 */
export function expandPathPlaceholders(
  path: string,
  vars: Record<string, string> | null | undefined,
): string {
  if (!path || !vars || !hasPathPlaceholder(path)) return path
  let result = path
  let pass = 0
  while (pass < MAX_PASSES && hasPathPlaceholder(result)) {
    const next = result.replace(UNIX_VAR, (_m, braced: string, plain: string) => {
      const name = braced || plain
      return lookupVar(vars, name) ?? _m
    })
    const withWindows = next.replace(WINDOWS_VAR, (m, name: string) => lookupVar(vars, name) ?? m)
    if (withWindows === result) break
    result = withWindows
    pass++
  }
  return result
}
