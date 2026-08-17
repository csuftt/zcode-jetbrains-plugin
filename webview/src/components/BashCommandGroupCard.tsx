/**
 * 批量运行命令组卡片（cc-gui BashToolGroupBlock 移植）
 *
 * 一轮 turn 里连续多条 Bash 命令合并成一张卡，压缩消息区长度：
 *   - 头部：「批量运行命令 (N)」+ 进度摘要（x/N 已完成 / ✓ 全部完成 / ⚠ N 个失败）
 *   - 时间线：竖向连接线 + 状态节点（运行中呼吸 / 完成 绿 / 失败 红），
 *     每行显示 description（无则截断命令前 60 字符，等宽字体）
 *   - 点击某行展开该命令详情（命令 + 输出），再点收起
 *   - 超过 3.5 行（32px/行）时列表内部滚动；流式追加新命令自动滚到底
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { ToolPart } from '@/types/messages'
import '../styles/tool-call-card.less'

/** 列表最大可见高度（3.5 项 × 32px/项），超出内部滚动 */
const MAX_VISIBLE_ITEMS = 3.5
const ITEM_HEIGHT = 32
/** 单项展开详情后的列表高度上限 */
const EXPANDED_MAX_HEIGHT = 400
/** 命令截断长度（无 description 时显示）*/
const COMMAND_TRUNCATE = 60

interface BashItem {
  command: string
  description: string
  output: string
  errorMessage: string
  status: ToolPart['state']['status']
  callID: string
  /** 流式早期 input 未解析时的原始 JSON 片段（兜底显示）*/
  rawInput: string
}

function parseBashItem(part: ToolPart): BashItem {
  const { state } = part
  const input = state.input as Record<string, unknown> | undefined
  const command = typeof input?.command === 'string' ? input.command : ''
  const description = typeof input?.description === 'string' ? input.description : ''
  return {
    command,
    description,
    output: state.output ?? '',
    errorMessage: state.error?.message ?? '',
    status: state.status,
    callID: part.callID,
    rawInput: !state.input && state.inputRaw ? state.inputRaw.replace(/\s+/g, ' ') : '',
  }
}

function truncateCommand(command: string): string {
  const oneLine = command.replace(/\s+/g, ' ').trim()
  return oneLine.length <= COMMAND_TRUNCATE ? oneLine : oneLine.slice(0, COMMAND_TRUNCATE) + '…'
}

/** 单行摘要：description 优先，无则截断命令；流式早期两者皆无时回退原始片段 */
function itemSummary(item: BashItem, t: TFunction): string {
  if (item.description.trim()) return item.description.trim()
  if (item.command.trim()) return truncateCommand(item.command)
  return item.rawInput ? truncateCommand(item.rawInput) : t('tool.bash.waitingInput')
}

export function BashCommandGroupCard({ parts }: { parts: ToolPart[] }) {
  const { t } = useTranslation()
  // 组卡片默认展开（cc-gui 行为：批量任务进行中需要看到进度）
  const [expanded, setExpanded] = useState(true)
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const prevCountRef = useRef(0)

  const items = useMemo(() => parts.map(parseBashItem), [parts])

  // 流式追加新命令时自动滚到底部（新命令总是出现在尾部）
  useEffect(() => {
    if (listRef.current && items.length > prevCountRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
    prevCountRef.current = items.length
  }, [items.length])

  const totalCount = items.length
  const doneCount = items.filter((i) => i.status === 'completed' || i.status === 'error').length
  const errorCount = items.filter((i) => i.status === 'error').length

  // 列表高度：有项展开时放宽（详情可能很高），否则按可见项数封顶
  const baseHeight = (totalCount > MAX_VISIBLE_ITEMS ? MAX_VISIBLE_ITEMS : totalCount) * ITEM_HEIGHT
  const listMaxHeight = expandedIdx !== null ? EXPANDED_MAX_HEIGHT : baseHeight
  const overflowY = (totalCount > MAX_VISIBLE_ITEMS || expandedIdx !== null) ? 'auto' : 'hidden'

  return (
    <div className="bash-group">
      {/* 头部：标题 + 进度摘要 + 折叠开关 */}
      <div
        className={`bash-group__header${expanded ? ' bash-group__header--open' : ''}`}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="tool-card__icon bash-group__icon">
          <span className="codicon codicon-terminal" />
        </span>
        <span className="bash-group__title">{t('tool.bash.groupTitle', { count: totalCount })}</span>
        <span className="bash-group__spacer" />
        {errorCount > 0 ? (
          <span className="bash-group__progress bash-group__progress--error">
            <span className="codicon codicon-warning" /> {t('tool.bash.failedCount', { count: errorCount })}
          </span>
        ) : doneCount === totalCount ? (
          <span className="bash-group__progress bash-group__progress--ok">
            <span className="codicon codicon-check" /> {t('tool.bash.allDone')}
          </span>
        ) : (
          <span className="bash-group__progress">{t('tool.bash.progress', { done: doneCount, total: totalCount })}</span>
        )}
        <span className="tool-card__toggle">{expanded ? '▼' : '▶'}</span>
      </div>

      {/* 时间线列表 */}
      {expanded && (
        <div
          ref={listRef}
          className="bash-group__timeline"
          style={{ maxHeight: listMaxHeight, overflowY }}
        >
          {items.map((item, index) => {
            const isLast = index === totalCount - 1
            const isItemExpanded = expandedIdx === index
            const nodeCls =
              item.status === 'error' ? 'error'
                : item.status === 'completed' ? 'completed'
                  : 'pending'
            return (
              <div key={item.callID || `bash-${index}`} className="bash-group__item">
                <div className="bash-group__connector">
                  <div className={`bash-group__line${isLast ? ' bash-group__line--last' : ''}`} />
                  <div className={`bash-group__node bash-group__node--${nodeCls}`} />
                </div>
                <div
                  className={`bash-group__content${isItemExpanded ? ' bash-group__content--open' : ''}`}
                  onClick={() => setExpandedIdx((prev) => (prev === index ? null : index))}
                >
                  <div className="bash-group__row">
                    <span
                      className={`bash-group__desc${item.description.trim() || !item.command.trim() ? '' : ' bash-group__desc--cmd'}`}
                      title={item.description.trim() || item.command}
                    >
                      {itemSummary(item, t)}
                    </span>
                    {/* 行尾状态角标（与节点色一致的文字态）*/}
                    <span className={`bash-group__status bash-group__status--${nodeCls}`}>
                      {item.status === 'error' ? '✗' : item.status === 'completed' ? '✓' : '⟳'}
                    </span>
                  </div>
                  {isItemExpanded && (
                    <div className="bash-group__detail">
                      <div className="bash-group__cmd">
                        {item.command || item.rawInput || t('tool.bash.unparsed')}
                      </div>
                      {(item.output || item.errorMessage) && (
                        <pre className={`tool-card__code bash-group__out${item.status === 'error' ? ' bash-group__out--err' : ''}`}>
                          {item.status === 'error' && item.errorMessage ? item.errorMessage : item.output}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
