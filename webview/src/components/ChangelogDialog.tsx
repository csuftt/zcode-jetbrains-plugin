/**
 * 版本更新弹窗（What's New，参考 cc-gui ChangelogDialog）
 *
 * 数据：src/version/changelog.ts（scripts/extract-changelog.mjs 从根 CHANGELOG.md 生成，
 *   npm prebuild 自动执行）；一版一页（最新在前），可翻看全部历史版本。
 * 触发：App 顶层——升级后首次打开自动弹（已读标记走 persist kv 通道存 IDE
 *   PropertiesComponent——内置 server 随机端口导致 localStorage 跨重启失效）；
 *   欢迎页版本角标 / 设置页「版本记录」手动打开。
 * 交互：←/→ 翻页、Esc / 点遮罩关闭；≤10 版圆点导航，页码文本（当前/总数）恒显。
 * props 驱动（entries 可注入，测试用；缺省真实 CHANGELOG_DATA）。
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CHANGELOG_DATA, type ChangelogEntry, type ChangelogContent } from '@/version/changelog'
import '../styles/changelog-dialog.less'

/** 已读标记的 persist key（App 自动弹判定 + 关闭写回共用；IDE 侧 kvstore 持久） */
export const CHANGELOG_LAST_SEEN_KEY = 'zcode.lastSeenChangelogVersion'

/** 标准节标题 → emoji（Keep a Changelog 英文节；中文自定义节保持原文） */
const SECTION_EMOJI: Record<string, string> = {
  Added: '✨',
  Fixed: '🐛',
  Changed: '🔧',
  Removed: '🗑️',
  Deprecated: '⚠️',
  Security: '🔒',
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 列表项行内轻量 Markdown：**粗体** / *斜体* / `代码` / [文本](链接) */
function renderInline(text: string): string {
  let html = escapeHtml(text)
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
  html = html.replace(/(^|[^*])\*([^*\s][^*]*)\*(?!\*)/g, '$1<em>$2</em>')
  return html
}

/** 单个语言段的正文（intro 引言 + 分节列表） */
function ContentBody({ content }: { content: ChangelogContent }) {
  return (
    <>
      {content.intro && (
        <div className="changelog-dialog__intro">
          {content.intro.split('\n').map((line, i) =>
            line.startsWith('>') ? (
              <blockquote key={i}>{renderInline(line.replace(/^>\s?/, ''))}</blockquote>
            ) : (
              <p key={i} dangerouslySetInnerHTML={{ __html: renderInline(line) }} />
            ),
          )}
        </div>
      )}
      {content.sections.map((section, si) => (
        <div key={si} className="changelog-dialog__section">
          {section.title && (
            <h4 className="changelog-dialog__section-title">
              {SECTION_EMOJI[section.title] ? `${SECTION_EMOJI[section.title]} ${section.title}` : section.title}
            </h4>
          )}
          <ul className="changelog-dialog__list">
            {section.items.map((item, ii) => (
              <li key={ii} dangerouslySetInnerHTML={{ __html: renderInline(item) }} />
            ))}
          </ul>
        </div>
      ))}
    </>
  )
}

interface Props {
  /** 分页数据（缺省真实 CHANGELOG_DATA；测试注入） */
  entries?: ChangelogEntry[]
  onClose: () => void
}

export function ChangelogDialog({ entries = CHANGELOG_DATA, onClose }: Props) {
  const { t } = useTranslation()
  const [page, setPage] = useState(0)

  const total = entries.length
  const entry = entries[page]

  // 键盘：Esc 关闭、←/→ 翻页
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.isComposing) return
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') setPage((p) => Math.max(0, p - 1))
      else if (e.key === 'ArrowRight') setPage((p) => Math.min(total - 1, p + 1))
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [onClose, total])

  if (!entry) return null

  return (
    <div className="changelog-dialog__overlay" onClick={onClose} role="presentation">
      <div
        className="changelog-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('app.changelog.title')}
      >
        <div className="changelog-dialog__header">
          <h3 className="changelog-dialog__title">{t('app.changelog.title')}</h3>
          <span className="changelog-dialog__version-badge">v{entry.version}</span>
          <span className="changelog-dialog__date">{entry.date}</span>
          <button
            type="button"
            className="changelog-dialog__close"
            onClick={onClose}
            title={t('app.changelog.dismiss')}
            aria-label={t('app.changelog.dismiss')}
          >
            <span className="codicon codicon-close" />
          </button>
        </div>

        <div className="changelog-dialog__body" key={page}>
          {/* 双语：中文段在前、英文段在后（固定顺序），中间横线分隔 */}
          {entry.zh && <ContentBody content={entry.zh} />}
          {entry.zh && entry.en && <hr className="changelog-dialog__lang-divider" />}
          {entry.en && <ContentBody content={entry.en} />}
        </div>

        <div className="changelog-dialog__footer">
          <button
            type="button"
            className="changelog-dialog__nav-btn"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            title={t('app.changelog.prev')}
            aria-label={t('app.changelog.prev')}
          >
            <span className="codicon codicon-chevron-left" />
          </button>
          {total <= 10 && (
            <div className="changelog-dialog__dots" role="tablist">
              {entries.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  className={`changelog-dialog__dot ${i === page ? 'changelog-dialog__dot--active' : ''}`}
                  onClick={() => setPage(i)}
                  aria-label={t('app.changelog.page', { current: i + 1, total })}
                />
              ))}
            </div>
          )}
          <span className="changelog-dialog__page-text" aria-live="polite">
            {t('app.changelog.page', { current: page + 1, total })}
          </span>
          <button
            type="button"
            className="changelog-dialog__nav-btn"
            onClick={() => setPage((p) => Math.min(total - 1, p + 1))}
            disabled={page === total - 1}
            title={t('app.changelog.next')}
            aria-label={t('app.changelog.next')}
          >
            <span className="codicon codicon-chevron-right" />
          </button>
          <button type="button" className="changelog-dialog__ok-btn" onClick={onClose}>
            {t('app.changelog.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
