/**
 * 知识库动作组卡（kb 工具同名相邻聚组，见 utils/groupParts.ts 'kb' 类别）。
 *
 * AI 整理知识库时 kb_entry/kb_list/kb_search 高频连发，逐张单卡拉长消息区——对齐
 * CuaActionGroupCard 的组卡壳（去截图/应用图标语义，换知识库图标）：
 *   - header：codicon-database 图标 + 中文友好名 + 次数
 *   - 成员行：状态字符 + 一行动作摘要（utils/kbTools.kbActionSummary），
 *     超 3 行内部滚动（与文件组卡同款跟滚语义）
 */

import { useEffect, useRef, useState } from 'react'
import type { ToolPart } from '@/types/messages'
import { kbToolLabel, kbActionSummary } from '@/utils/kbTools'
import { NEAR_BOTTOM_PX } from './ScrollJumpButton'
import '../styles/tool-call-card.less'

/** 列表最大可见行数，超出内部滚动（与文件组卡同款）*/
const MAX_VISIBLE_ITEMS = 3
const ITEM_HEIGHT = 28

function statusChar(status: ToolPart['state']['status']): { text: string; cls: string } {
  switch (status) {
    case 'completed': return { text: '✓', cls: 'completed' }
    case 'error': return { text: '✗', cls: 'error' }
    default: return { text: '⟳', cls: 'pending' }
  }
}

export function KbToolGroupCard({ parts }: { parts: ToolPart[] }) {
  const [expanded, setExpanded] = useState(true)
  const listRef = useRef<HTMLDivElement>(null)
  const prevCountRef = useRef(0)
  const stickToBottom = useRef(true)

  const count = parts.length
  const label = kbToolLabel(parts[0].tool)

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

  const listMaxHeight = (count > MAX_VISIBLE_ITEMS ? MAX_VISIBLE_ITEMS : count) * ITEM_HEIGHT
  const overflowY = count > MAX_VISIBLE_ITEMS ? 'auto' : 'hidden'

  return (
    <div className="bash-group">
      <div
        className={`bash-group__header${expanded ? ' bash-group__header--open' : ''}`}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="tool-card__icon bash-group__icon">
          <span className="codicon codicon-database" />
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
            return (
              <div key={p.callID || index} className="file-group__row" title={p.tool}>
                <span className="codicon codicon-database file-group__tool-ic" />
                <span className="file-group__pattern">
                  {summary || kbToolLabel(p.tool)}
                </span>
                <span className={`bash-group__status bash-group__status--${st.cls}`}>{st.text}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
