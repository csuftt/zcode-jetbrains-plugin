/**
 * 文件类工具批量组卡片（cc-gui Read/Edit/SearchToolGroupBlock 移植，合并为一个壳）
 *
 * 连续的同类文件操作合并成一张卡，压缩消息区长度：
 *   - read（Read）：文件列表行，点击文件名在 IDE 打开
 *   - edit（Edit/Write）：文件行 + 每项 +N/−N 增删统计 + diff/刷新按钮，头部合计
 *   - search（Grep/Glob）：pattern（等宽）+ 搜索路径行
 * 超过 3 行（28px/行）时列表内部滚动；流式追加自动滚到底。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ToolPart } from '@/types/messages'
import { sendToJava } from '@/ipc/bridge'
import { FileIcon } from './FileIcon'
import '../styles/tool-call-card.less'

type FileGroupKind = 'read' | 'edit' | 'search'

/** 列表最大可见行数，超出内部滚动 */
const MAX_VISIBLE_ITEMS = 3
const ITEM_HEIGHT = 28

/** 头部配置：图标 + 标题文案 key（标题经 i18n）*/
const GROUP_META: Record<FileGroupKind, { icon: string; titleKey: string }> = {
  read: { icon: 'codicon-file-code', titleKey: 'tool.fileGroup.read' },
  edit: { icon: 'codicon-edit', titleKey: 'tool.fileGroup.edit' },
  search: { icon: 'codicon-search', titleKey: 'tool.fileGroup.search' },
}

interface FileItem {
  filePath: string
  fileName: string
  status: ToolPart['state']['status']
  // edit 项
  additions: number
  deletions: number
  oldContent: string
  newContent: string
  isEditTool: boolean
}

interface SearchItem {
  tool: string
  pattern: string
  path: string
  status: ToolPart['state']['status']
}

/** 行数统计（末尾换行不计）*/
function lineCount(s: string): number {
  if (!s) return 0
  const t = s.replace(/\n$/, '')
  return t ? t.split('\n').length : 0
}

function fileNameOf(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || path
}

function parseFileItem(part: ToolPart): FileItem {
  const input = (part.state.input ?? {}) as Record<string, unknown>
  const filePath = String(input.file_path || input.path || '')
  const oldContent = String(input.old_string ?? input.oldString ?? '')
  const newContent = String(input.new_string ?? input.newString ?? input.content ?? '')
  return {
    filePath,
    fileName: fileNameOf(filePath),
    status: part.state.status,
    // Edit：替换前后行数近似增删；Write：整个文件视为新增（newContent 已按工具取对字段）
    additions: lineCount(newContent),
    deletions: part.tool === 'Write' ? 0 : lineCount(oldContent),
    oldContent,
    newContent,
    isEditTool: part.tool === 'Edit',
  }
}

function parseSearchItem(part: ToolPart): SearchItem {
  const input = (part.state.input ?? {}) as Record<string, unknown>
  return {
    tool: part.tool,
    pattern: String(input.pattern ?? input.query ?? input.search_term ?? input.regex ?? ''),
    path: String(input.path ?? input.directory ?? ''),
    status: part.state.status,
  }
}

/** 状态字符（与批量命令组一致）*/
function statusChar(status: ToolPart['state']['status']): { text: string; cls: string } {
  switch (status) {
    case 'completed': return { text: '✓', cls: 'completed' }
    case 'error': return { text: '✗', cls: 'error' }
    default: return { text: '⟳', cls: 'pending' }
  }
}

export function FileToolGroupCard({ kind, parts }: { kind: FileGroupKind; parts: ToolPart[] }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(true)
  const listRef = useRef<HTMLDivElement>(null)
  const prevCountRef = useRef(0)

  const fileItems = useMemo(
    () => (kind === 'search' ? [] : parts.map(parseFileItem)),
    [kind, parts],
  )
  const searchItems = useMemo(
    () => (kind === 'search' ? parts.map(parseSearchItem) : []),
    [kind, parts],
  )
  const count = kind === 'search' ? searchItems.length : fileItems.length

  // 流式追加新项时自动滚到底部
  useEffect(() => {
    if (listRef.current && count > prevCountRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
    prevCountRef.current = count
  }, [count])

  const totalAdditions = fileItems.reduce((s, i) => s + i.additions, 0)
  const totalDeletions = fileItems.reduce((s, i) => s + i.deletions, 0)

  const listMaxHeight = (count > MAX_VISIBLE_ITEMS ? MAX_VISIBLE_ITEMS : count) * ITEM_HEIGHT
  const overflowY = count > MAX_VISIBLE_ITEMS ? 'auto' : 'hidden'

  const meta = GROUP_META[kind]

  const handleOpenFile = (filePath: string) => (e: React.MouseEvent) => {
    e.stopPropagation()
    if (filePath) sendToJava({ op: 'openFile', filePath })
  }
  const handleShowDiff = (item: FileItem) => (e: React.MouseEvent) => {
    e.stopPropagation()
    sendToJava({
      op: 'showDiff',
      filePath: item.filePath,
      oldContent: item.oldContent,
      newContent: item.newContent,
      title: t('tool.editFileTitle', { name: item.fileName }),
    })
  }
  const handleRefreshFile = (filePath: string) => (e: React.MouseEvent) => {
    e.stopPropagation()
    if (filePath) sendToJava({ op: 'refreshFile', filePath })
  }

  return (
    <div className="file-group">
      <div
        className={`bash-group__header${expanded ? ' bash-group__header--open' : ''}`}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="tool-card__icon bash-group__icon">
          <span className={`codicon ${meta.icon}`} />
        </span>
        <span className="bash-group__title">{t(meta.titleKey)} ({count})</span>
        {kind === 'edit' && (totalAdditions > 0 || totalDeletions > 0) && (
          <span className="file-group__stats">
            {totalAdditions > 0 && <span className="file-group__add">+{totalAdditions}</span>}
            {totalAdditions > 0 && totalDeletions > 0 && <span className="file-group__stats-sep" />}
            {totalDeletions > 0 && <span className="file-group__del">−{totalDeletions}</span>}
          </span>
        )}
        <span className="bash-group__spacer" />
        <span className="tool-card__toggle">{expanded ? '▼' : '▶'}</span>
      </div>

      {expanded && (
        <div
          ref={listRef}
          className="file-group__list"
          style={{ maxHeight: listMaxHeight, overflowY }}
        >
          {kind !== 'search' &&
            fileItems.map((item, index) => {
              const st = statusChar(item.status)
              return (
                <div key={parts[index].callID} className="file-group__row">
                  <FileIcon path={item.filePath} className="file-type-icon file-group__file-ic" />
                  <span
                    className="file-group__file-name"
                    title={item.filePath}
                    onClick={handleOpenFile(item.filePath)}
                  >
                    {item.fileName}
                  </span>
                  {(item.additions > 0 || item.deletions > 0) && (
                    <span className="file-group__stats">
                      {item.additions > 0 && <span className="file-group__add">+{item.additions}</span>}
                      {item.additions > 0 && item.deletions > 0 && <span className="file-group__stats-sep" />}
                      {item.deletions > 0 && <span className="file-group__del">−{item.deletions}</span>}
                    </span>
                  )}
                  {item.isEditTool && item.oldContent && item.newContent && (
                    <button className="tool-card__action" onClick={handleShowDiff(item)} title={t('tool.viewDiff')} aria-label={t('tool.viewDiff')}>
                      <span className="codicon codicon-diff" />
                    </button>
                  )}
                  {item.filePath && (
                    <button className="tool-card__action" onClick={handleRefreshFile(item.filePath)} title={t('tool.refreshInEditor')} aria-label={t('tool.refreshInEditor')}>
                      <span className="codicon codicon-refresh" />
                    </button>
                  )}
                  <span className={`bash-group__status bash-group__status--${st.cls}`}>{st.text}</span>
                </div>
              )
            })}
          {kind === 'search' &&
            searchItems.map((item, index) => {
              const st = statusChar(item.status)
              return (
                <div
                  key={parts[index].callID}
                  className="file-group__row"
                  title={item.pattern ? `${item.pattern}${item.path ? ` → ${item.path}` : ''}` : item.path}
                >
                  <span className={`codicon ${item.tool === 'Glob' ? 'codicon-folder' : 'codicon-search'} file-group__tool-ic`} />
                  {item.pattern && <span className="file-group__pattern">{item.pattern}</span>}
                  {item.path && <span className="file-group__path">{item.path}</span>}
                  {!item.pattern && !item.path && <span className="file-group__path">{item.tool}</span>}
                  <span className={`bash-group__status bash-group__status--${st.cls}`}>{st.text}</span>
                </div>
              )
            })}
        </div>
      )}
    </div>
  )
}
