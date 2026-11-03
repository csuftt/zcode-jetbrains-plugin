/**
 * 目录色板取色助手（2026-11-02 统一配色）：标签色块（Java 侧）/标题下徽标/历史页
 * chips 三处共用同一映射（Java 轮询分配，随 linkedWorkspaces 应答推送）。
 * 色板值在 variables.less --ws-dir-1..9（与 Kotlin WsTabColors.PALETTE 对齐）。
 */

/** 目录路径归一比较键：与 Java wsKey / store normalizeWsPath 同口径 */
export function normalizeWsKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** 色板大小（与 Java PALETTE_SIZE 对齐） */
export const WS_PALETTE_SIZE = 9

/**
 * 查目录色板序号：colors 键为 wsKey 归一形态（Java colorsJson 产出）。
 * 命中返回 0-8；未命中（应答未达/旧包）返回 null，调用方回落默认主题色。
 */
export function resolveWsColorIndex(dir: string, colors: Record<string, number>): number | null {
  if (!dir) return null
  const idx = colors[normalizeWsKey(dir)]
  return typeof idx === 'number' && Number.isFinite(idx) ? ((idx % WS_PALETTE_SIZE) + WS_PALETTE_SIZE) % WS_PALETTE_SIZE : null
}
