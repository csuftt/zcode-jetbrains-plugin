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
import { NEAR_BOTTOM_PX } from './ScrollJumpButton'
import '../styles/tool-call-card.less'

/** 列表最大可见高度（3.5 项 × 32px/项），超出内部滚动 */
const MAX_VISIBLE_ITEMS = 3.5
const ITEM_HEIGHT = 32
/** 时间线上下内边距之和（8+8）。maxHeight 是 border-box 必须含内边距，
 *  否则全部项恰好可见时也差 16px 成幻影滚动：挂载自动滚底停在 scrollTop=16
 *  （顶 padding 被滚出），行内展开一次容器放宽又把 scrollTop 钳回 0 且收起后
 *  不会还原 → 收起后所有行整体下移 16px（缺陷FG 实测复现） */
const TIMELINE_PADDING_Y = 16
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
  // 行收起时把列表滚回展开前位置（缺陷FG）：行展开瞬间容器 maxHeight 放宽，
  // 浏览器把 scrollTop 钳到新的（通常为 0）；收起后容器高度回落，钳走的位移
  // 不会自动还原，行会整体跳位——展开前采样、收起后按新 max 还原
  const savedScrollRef = useRef(0)
  const prevExpandedIdxRef = useRef<number | null>(null)
  // 距底附近才自动跟滚：用户上滚回看历史命令时不被新命令置底打断，
  // 滚回底部附近自动恢复（语义同 ChatView 主容器跟滚）
  const stickToBottom = useRef(true)

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

  // 流式追加新命令时自动滚到底部（新命令总是出现在尾部；用户上滚查看历史时不打扰）
  useEffect(() => {
    if (listRef.current && items.length > prevCountRef.current && stickToBottom.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
    prevCountRef.current = items.length
  }, [items.length])

  // 行收起（expandedIdx 非空 → null）后还原滚动位；挂载和直接换行展开不还原
  //（挂载还原会覆盖自动滚底，换行展开容器未回落无需还原）
  useEffect(() => {
    const prev = prevExpandedIdxRef.current
    prevExpandedIdxRef.current = expandedIdx
    if (prev === null || expandedIdx !== null) return
    const el = listRef.current
    if (!el) return
    const max = el.scrollHeight - el.clientHeight
    if (max > 0) el.scrollTop = Math.min(savedScrollRef.current, max)
  }, [expandedIdx])

  const handleRowToggle = (index: number) => {
    // 只在从全收起态展开时采样：展开后容器的 scrollTop 已被浏览器钳位，
    // 收起/换行点击时再采样会采到钳后的值，还原即失效
    if (expandedIdx === null) savedScrollRef.current = listRef.current?.scrollTop ?? 0
    setExpandedIdx((prev) => (prev === index ? null : index))
  }

  const handleListScroll = () => {
    const el = listRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
  }

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

  // 列表高度：有项展开时放宽（详情可能很高），否则按可见项数封顶（含上下内边距）
  const baseHeight =
    (totalCount > MAX_VISIBLE_ITEMS ? MAX_VISIBLE_ITEMS : totalCount) * ITEM_HEIGHT + TIMELINE_PADDING_Y
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
          onScroll={handleListScroll}
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
                  onClick={() => handleRowToggle(index)}
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
