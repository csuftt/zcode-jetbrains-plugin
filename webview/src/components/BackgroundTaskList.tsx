/**
 * 后台任务列表（状态面板「任务」popover 的后台任务子 tab；官方 ConversationStatusPanel
 * Terminals/Workflows 分区的简化移植）。
 *
 * 数据源 = v4 帧投影 backgroundWorks（store 按会话落账），过滤掉 subagent 条目
 * （子代理走「子代理」子 tab 的既有列表）。条目：图标/标题/状态/启动时间 + 取消
 * （running 且 cancellable!==false）+ bash 输出查看（backgroundBashOutput 1s 轮询
 * ≤8KB 尾窗，终态/降级形态停止）。取消走 v4/command cancelBackgroundWork（无 CAS），
 * 投影由 backgroundWorks 事件收敛，无乐观更新。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { useStore } from '@/store/useStore'
import { mergeBackgroundWorks, sortBackgroundWorksRunningFirst } from '@/utils/backgroundTask'
import { relativeTime } from '@/utils/time'
import type { BackgroundBashOutputResult, BackgroundWorkSummary } from '@/types/messages'
import { onMessage, sendToJava } from '@/ipc/bridge'

const EMPTY_WORKS: BackgroundWorkSummary[] = []

/** kind → 图标（terminal=终端 / run-all=工作流；subagent 由「子代理」子 tab 承担不在此列表） */
function kindIcon(kind: BackgroundWorkSummary['kind']): string {
  return kind === 'bash' ? 'codicon-terminal' : 'codicon-run-all'
}

/**
 * 后台 bash 输出视图：单监听器 + pending 防重入轮询（running 态 1s 重拉快照；
 * 终态/降级形态停止）。无应答（请求在途丢失）停在上一帧，由下次轮询自然恢复。
 */
export function BashOutputView({ sessionId, workId }: { sessionId: string; workId: string }) {
  const { t } = useTranslation()
  const [result, setResult] = useState<BackgroundBashOutputResult | null>(null)

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let pending = false
    const off = onMessage((msg) => {
      if (msg.op !== 'backgroundBashOutputResult' || msg.workId !== workId) return
      pending = false
      if (disposed) return
      setResult(msg.result)
      if (msg.result.kind === 'output' && msg.result.status === 'running') {
        timer = setTimeout(fetchOnce, 1000)
      }
    })
    const fetchOnce = () => {
      if (pending || disposed) return
      pending = true
      sendToJava({ op: 'backgroundBashOutput', sessionId, workId })
    }
    fetchOnce()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      off()
    }
  }, [sessionId, workId])

  if (!result) {
    return (
      <div className="bgwork-output">
        <div className="bgwork-output__empty">{t('app.status.bgWorks.outputLoading')}</div>
      </div>
    )
  }
  if (result.kind !== 'output') {
    return (
      <div className="bgwork-output">
        <div className="bgwork-output__empty">{t(`app.status.bgWorks.output_${result.kind}`)}</div>
      </div>
    )
  }
  return (
    <div className="bgwork-output">
      <pre className="bgwork-output__pre">{result.output || t('app.status.bgWorks.outputEmpty')}</pre>
      {result.truncated && <div className="bgwork-output__truncated">{t('app.status.bgWorks.outputTruncated')}</div>}
      <div className="bgwork-output__path" title={result.outputPath}>
        {result.outputPath}
      </div>
    </div>
  )
}

export function BackgroundTaskList({ sessionId }: { sessionId: string | null }) {
  const { t } = useTranslation()
  const projection = useStore((s) => (sessionId ? s.backgroundWorksBySession[sessionId] : undefined)) ?? EMPTY_WORKS
  const fromTranscript = useStore((s) => s.backgroundWorksFromTranscript)
  const deliveredWorkStatuses = useStore((s) => s.deliveredWorkStatuses)
  const cancelBackgroundWork = useStore((s) => s.cancelBackgroundWork)
  const [expandedWorkId, setExpandedWorkId] = useState<string | null>(null)
  // 标题截断悬浮全文（JCEF 不渲染原生 title，复用 .inline-chip-tip fixed 挂 body 方案，
  // TurnFileChangesDialog 同款：量宽收敛 + 上/下翻转）
  const [tip, setTip] = useState<{ text: string; left: number; top: number; bottom: number } | null>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const node = tipRef.current
    if (!tip || !node) return
    const w = node.offsetWidth
    const h = node.offsetHeight
    let x = Math.max(8, tip.left)
    if (x + w > window.innerWidth - 8) x = Math.max(8, window.innerWidth - 8 - w)
    node.style.left = `${x}px`
    if (tip.top - h - 6 >= 8) {
      node.style.top = `${tip.top - 6}px`
      node.style.transform = 'translateY(-100%)'
    } else {
      node.style.top = `${tip.bottom + 6}px`
      node.style.transform = 'none'
    }
  }, [tip])
  const showTip = (e: React.MouseEvent<HTMLElement>, text: string) => {
    if (!text) return
    const rect = e.currentTarget.getBoundingClientRect()
    setTip({ text, left: rect.left, top: rect.top, bottom: rect.bottom })
  }
  const hideTip = () => setTip(null)

  // 投影 ∪ 转录重建合并（重启后投影消失，重建条目让「后台工作」栏不空）；
  // 转录完成通知命中 workId 时把投影的 resultPending 本地升级终态（CLI 不为投递推帧）
  const works = useMemo(
    () => mergeBackgroundWorks(projection, fromTranscript, deliveredWorkStatuses),
    [projection, fromTranscript, deliveredWorkStatuses],
  )

  // 子代理条目不在本列表（子代理子 tab），bash+workflow 全状态展示；
  // 运行中置顶、置顶组内外各按启动时间倒序（拼接序只是数据序，运行中可能沉底）
  const tasks = sortBackgroundWorksRunningFirst(works.filter((w) => w.kind !== 'subagent'))

  if (tasks.length === 0) {
    return <div className="status-panel-empty">{t('app.status.bgWorks.empty')}</div>
  }

  const statusText = (w: BackgroundWorkSummary): string => {
    if (w.status === 'running') return w.blocked ? t('app.status.bgWorks.statusBlocked') : t('app.status.bgWorks.statusRunning')
    if (w.status === 'resultPending') return t('app.status.bgWorks.statusPending')
    if (w.status === 'failed') return t('app.status.bgWorks.statusFailed')
    if (w.status === 'ended') return t('app.status.bgWorks.statusEnded')
    return t('app.status.bgWorks.statusCancelled')
  }

  const list = (
    <div className="status-panel-bgwork-list">
      {tasks.map((w) => (
        <div key={w.workId} className={`bgwork-item status-${w.status}`}>
          <div className="bgwork-item__row">
            <span className={`codicon ${kindIcon(w.kind)} bgwork-item__icon`} />
            <div
              className="bgwork-item__main"
              onMouseEnter={(e) => showTip(e, w.title || w.workId)}
              onMouseLeave={hideTip}
            >
              <div className="bgwork-item__title">{w.title || w.workId}</div>
              <div className="bgwork-item__meta">
                <span className={`bgwork-item__status bgwork-item__status--${w.status}`}>{statusText(w)}</span>
                <span className="bgwork-item__time">{relativeTime(w.startedAt)}</span>
              </div>
            </div>
            <div className="bgwork-item__actions">
              {w.kind === 'bash' && (
                <button
                  type="button"
                  className="bgwork-item__action"
                  onClick={() => setExpandedWorkId((v) => (v === w.workId ? null : w.workId))}
                >
                  {expandedWorkId === w.workId ? t('app.status.bgWorks.hideOutput') : t('app.status.bgWorks.viewOutput')}
                </button>
              )}
              {w.status === 'running' && w.cancellable !== false && (
                <button
                  type="button"
                  className="bgwork-item__action bgwork-item__action--danger"
                  onClick={() => sessionId && cancelBackgroundWork(sessionId, w.workId)}
                >
                  {t('app.status.bgWorks.cancel')}
                </button>
              )}
            </div>
          </div>
          {w.kind === 'bash' && expandedWorkId === w.workId && sessionId && (
            <BashOutputView sessionId={sessionId} workId={w.workId} />
          )}
        </div>
      ))}
    </div>
  )

  return (
    <>
      {list}
      {tip && createPortal(
        <div ref={tipRef} className="inline-chip-tip" style={{ left: tip.left, top: tip.top }}>
          {tip.text}
        </div>,
        document.body,
      )}
    </>
  )
}
