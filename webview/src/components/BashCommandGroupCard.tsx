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
import { useStore } from '@/store/useStore'
import { useTick } from '@/hooks/useTick'
import { formatToolDuration } from '@/utils/time'
import { isBackgroundTaskOutput } from '@/utils/backgroundTask'
import { toolErrorText } from '@/utils/parseStatus'
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
    errorMessage: toolErrorText(state.error),
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

/** softenError（子代理弹窗活动 running 期间）：error 降级为「↻ 重试中」中性样式，
 *  同 FileToolGroupCard——子代理中途失败重试是常态，红色 ✗ 会被误读成任务失败 */
export function BashCommandGroupCard({ parts, softenError }: {
  parts: ToolPart[]
  softenError?: boolean
}) {
  const { t } = useTranslation()
  // 组卡片默认展开（cc-gui 行为：批量任务进行中需要看到进度）
  const [expanded, setExpanded] = useState(true)
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const prevCountRef = useRef(0)

  const items = useMemo(() => parts.map(parseBashItem), [parts])

  // 后台任务账本（缺陷Y 体验增强）：按 callID 查各行的后台任务（run_in_background）。
  // 组卡路径下多个后台任务各自独立标识 + 独立计时；任一**运行中**时秒级跳动
  //（已完成后台任务定格显示，见行内 endedAt 分支）
  const backgroundTasks = useStore((s) => s.backgroundTasks)
  const hasBgRunning = items.some((i) => {
    const bg = backgroundTasks[i.callID]
    return !!bg && !bg.endedAt
  })
  const bgNow = useTick(hasBgRunning, 1000)

  // 流式追加新命令时自动滚到底部（新命令总是出现在尾部）
  useEffect(() => {
    if (listRef.current && items.length > prevCountRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
    prevCountRef.current = items.length
  }, [items.length])

  const totalCount = items.length
  // 后台化确认的 result 已回（part 状态变 completed）但任务仍在后台跑——
  // 不算「已完成」，避免「✓ 全部完成」误导；已完成的后台任务（endedAt 有值）算完成
  const doneCount = items.filter((i) => {
    const bg = backgroundTasks[i.callID]
    if (bg && !bg.endedAt) return false
    return i.status === 'completed' || i.status === 'error'
  }).length
  const errorCount = items.filter((i) => i.status === 'error').length
  const bgCount = items.filter((i) => {
    const bg = backgroundTasks[i.callID]
    return !!bg && !bg.endedAt
  }).length

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
        {bgCount > 0 ? (
          <span className="bash-group__progress bash-group__progress--bg">
            <span className="codicon codicon-debug-alt" /> {t('tool.bash.backgroundCount', { count: bgCount })}
          </span>
        ) : errorCount > 0 ? (
          <span className={`bash-group__progress${softenError ? '' : ' bash-group__progress--error'}`}>
            <span className={`codicon ${softenError ? 'codicon-sync' : 'codicon-warning'}`} />
            {' '}{softenError ? t('tool.bash.retryCount', { count: errorCount }) : t('tool.bash.failedCount', { count: errorCount })}
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
            // 后台任务行：运行中 → 徽标 + 跳秒；已完成（endedAt）→ 「后台完成」+ 定格耗时；
            // 历史静态（无账本条目，会话重载后）→ 从行输出识别 → 「后台完成」徽标不计时
            const bg = backgroundTasks[item.callID]
            const bgDone = !!bg && !!bg.endedAt
            const bgStatic = !bg && isBackgroundTaskOutput(item.output)
            const nodeCls =
              bg && !bgDone ? 'bg'
                : item.status === 'error' ? (softenError ? 'retry' : 'error')
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
                    {/* 行尾状态角标：后台任务 = 徽标 + 耗时（运行中跳秒 / 完成定格），否则 ✓/⟳/✗ */}
                    <span className={`bash-group__status bash-group__status--${nodeCls}`}>
                      {bg ? (
                        bgDone ? (
                          <>
                            <span className="codicon codicon-check" />
                            {t('tool.backgroundCompleted')} {formatToolDuration(bg.endedAt! - bg.startedAt)}
                          </>
                        ) : (
                          <>
                            <span className="codicon codicon-debug-alt" />
                            {t('tool.backgroundRunning')} {formatToolDuration(bgNow - bg.startedAt)}
                          </>
                        )
                      ) : bgStatic ? (
                        // 历史静态（无账本条目）：后台化确认已回 → 徽标不计时
                        <>
                          <span className="codicon codicon-check" />
                          {t('tool.backgroundCompleted')}
                        </>
                      ) : item.status === 'error' ? (softenError ? '↻' : '✗') : item.status === 'completed' ? '✓' : '⟳'}
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
