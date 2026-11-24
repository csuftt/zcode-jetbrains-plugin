/**
 * 知识库工具窗图标的网页版：线稿打开的书 + 左页一个小折线 Z，与插件资源里的
 * icons/knowledge.svg（工具窗标题栏那个）同一造型。聊天里的知识库工具卡片用它，
 * 让人一眼对上工具窗。
 *
 * 线条颜色写 currentColor 跟随文字色，深浅主题自动适配（Swing 那边是靠亮/暗两份
 * SVG 换色，网页这边不需要）。路径数据与资源文件各存一份，test/kb-icon.spec.ts
 * 盯着两边一致——改图标时两处一起改。
 */

/** 书的两页轮廓 */
export const KB_ICON_BOOK_PATH = 'M 8 3.05 C 6.5 2.5 4.6 3.1 2.15 3.6 L 2.15 12.3 C 4.6 11.9 6.5 12.5 8 13.2 C 9.5 12.5 11.4 11.9 13.85 12.3 L 13.85 3.6 C 11.4 3.1 9.5 2.5 8 3.05 Z'
/** 中央书脊线 */
export const KB_ICON_SPINE_PATH = 'M 8 3.1 L 8 13.2'
/** 左页的折线 Z */
export const KB_ICON_Z_PATH = 'M 4.0 6.2 H 6.15 L 4.0 8.55 H 6.15'

/** 按资源文件里的书写顺序排列的路径（描边 1.2 的两条 + 描边 1.1 的 Z）*/
export const KB_ICON_PATHS = [KB_ICON_BOOK_PATH, KB_ICON_SPINE_PATH, KB_ICON_Z_PATH]

export function KbIcon({ className, size = 16 }: { className?: string; size?: number }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <g stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round">
        <path d={KB_ICON_BOOK_PATH} />
        <path d={KB_ICON_SPINE_PATH} />
      </g>
      <path d={KB_ICON_Z_PATH} stroke="currentColor" strokeWidth={1.1} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
