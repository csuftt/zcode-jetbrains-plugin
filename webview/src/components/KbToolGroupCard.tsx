/**
 * 知识库动作组卡（kb 工具同名相邻聚组，见 utils/groupParts.ts 'kb' 类别）。
 *
 * AI 整理知识库时 kb_entry/kb_list/kb_search 高频连发，逐张单卡拉长消息区——沿用
 * CuaActionGroupCard 的组卡壳：
 *   - header：工具窗那本书的图标（KbIcon）+ 中文友好名 + 次数
 *   - 成员行：展开箭头 + 一行动作摘要（utils/kbTools.kbActionSummary）+ 结果数量 + 状态字符。
 *     点一行就地展开这一次调用的参数与结果（KbToolBody，与单卡展开区同一套渲染）
 *   - 没有行展开时超过 3 行内部滚动（与文件组卡同款跟滚语义）；有行展开时放宽到 420px，
 *     同样内部滚动（展开的内容自己还有一层限高，见 KbToolBody 的 kb-scroll）
 */

import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ToolPart } from '@/types/messages'
import { kbToolLabel, kbActionSummary, kbResultHint } from '@/utils/kbTools'
import { KbIcon } from './KbIcon'
import { KbToolBody } from './KbToolBody'
import { NEAR_BOTTOM_PX } from './ScrollJumpButton'
import '../styles/tool-call-card.less'

/** 列表最大可见行数，超出内部滚动（与文件组卡同款）*/
const MAX_VISIBLE_ITEMS = 3
const ITEM_HEIGHT = 28
/** 有成员行展开时列表的高度上限：展开的参数与结果要看得见，再长在卡片里滚，不把消息区拉长 */
const OPEN_MAX_HEIGHT = 420

function statusChar(status: ToolPart['state']['status']): { text: string; cls: string } {
  switch (status) {
    case 'completed': return { text: '✓', cls: 'completed' }
    case 'error': return { text: '✗', cls: 'error' }
    default: return { text: '⟳', cls: 'pending' }
  }
}

export function KbToolGroupCard({ parts }: { parts: ToolPart[] }) {
  const [expanded, setExpanded] = useState(true)
  // 展开着参数与结果的成员行（按组内下标记，可同时展开多行）
  const [openRows, setOpenRows] = useState<ReadonlySet<number>>(() => new Set())
  const listRef = useRef<HTMLDivElement>(null)
  const prevCountRef = useRef(0)
  const stickToBottom = useRef(true)

  const count = parts.length
  const label = kbToolLabel(parts[0].tool)
  const anyOpen = openRows.size > 0

  // 流式追加新项时自动滚到底部（用户上滚查看历史时不打扰）
  useEffect(() => {
    if (listRef.current && count > prevCountRef.current && stickToBottom.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
    prevCountRef.current = count
  }, [count])

  const handleListScroll = () => {
    const el = listRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
  }

  const toggleRow = (index: number) => {
    setOpenRows((prev) => {
      const next = new Set(prev)
      if (next.has(index)) {
        next.delete(index)
      } else {
        next.add(index)
      }
      return next
    })
  }

  const handleRowKeyDown = (e: ReactKeyboardEvent, index: number) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      toggleRow(index)
    }
  }

  // 有行展开时放宽但不放开：展开的参数与结果在卡片里滚，不把消息区拉长
  const listMaxHeight = anyOpen
    ? OPEN_MAX_HEIGHT
    : (count > MAX_VISIBLE_ITEMS ? MAX_VISIBLE_ITEMS : count) * ITEM_HEIGHT
  const overflowY = anyOpen || count > MAX_VISIBLE_ITEMS ? 'auto' : 'hidden'

  return (
    <div className="bash-group kb-group">
      <div
        className={`bash-group__header${expanded ? ' bash-group__header--open' : ''}`}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="tool-card__icon bash-group__icon">
          <KbIcon className="bash-group__kb-icon" />
        </span>
        <span className="bash-group__title" title={parts[0].tool}>{label} ({count})</span>
        <span className="bash-group__spacer" />
        <span className="tool-card__toggle">{expanded ? '▼' : '▶'}</span>
      </div>

      {expanded && (
        <div
          ref={listRef}
          className="file-group__list"
          style={{ maxHeight: listMaxHeight, overflowY }}
          onScroll={handleListScroll}
        >
          {parts.map((p, index) => {
            const st = statusChar(p.state.status)
            const summary = kbActionSummary(p.tool, p.state.input as Record<string, unknown> | undefined)
            const hint = kbResultHint(p.tool, p.state.output)
            const open = openRows.has(index)
            return (
              <div key={p.callID || index} className="kb-group__item">
                <div
                  className={`file-group__row kb-group__row${open ? ' kb-group__row--open' : ''}`}
                  title={open ? undefined : '点击看这次调用的参数与结果'}
                  role="button"
                  tabIndex={0}
                  aria-expanded={open}
                  onClick={() => toggleRow(index)}
                  onKeyDown={(e) => handleRowKeyDown(e, index)}
                >
                  <span className={`codicon ${open ? 'codicon-chevron-down' : 'codicon-chevron-right'} kb-group__chevron`} />
                  <span className="file-group__pattern kb-group__summary">
                    {summary || kbToolLabel(p.tool)}
                  </span>
                  {hint && (
                    <span className={`kb-group__hint${hint.error ? ' kb-group__hint--err' : ''}`}>{hint.text}</span>
                  )}
                  <span className={`bash-group__status bash-group__status--${st.cls}`}>{st.text}</span>
                </div>
                {open && (
                  <div className="kb-group__detail">
                    <KbToolBody part={p} compact />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
