/**
 * 等待指示器
 *
 * 规划文档第四节：
 *   ⊙ GLM-5.2 正在生成响应...（已 12 秒）
 *   - CSS 旋转圆环 spinner
 *   - 三个跳动省略号（500ms 切换 . → .. → ...）
 *   - 计时器用绝对时间差算（跨视图切换不重置）
 *
 * 生成速度（2026-10-14）：streaming 期 2s 轮询 session/debug。显示规则（用户定稿）：
 * 有真值就显示——非生成期（工具执行/请求间隙）恒显最近真值；生成期真值 8s 新鲜，
 * 过期交估算接管（流式字符速率×自校准系数，~ 前缀）。数据是 agent 进程内存，
 * 重启后从新回合开始积累；组件卸载（回合结束）轮询即停。
 * 缺陷FE（2026-10-19）：估算窗口饥饿期（流起步/≥5s 停顿恢复后的 ~1.5s）不再清屏，
 * 保留最近估算值兜底——长思考请求（真值必然过期）+ 渠道停顿组合下数字不再闪没。
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store/useStore'
import { elapsedDesc } from '@/utils/time'
import { lastTpsRound, estimateTpsFromChars, calibrateCharsPerToken } from '@/utils/tps'
import { modelStreamActivity, streamCharsPerSec, streamCharsTotal } from '@/utils/streamReducer'
import '../styles/waiting-indicator.less'

/** 流式静默超过该时长视为"非生成期"（工具执行/请求间隙）：生成期判定用。
 *  速率不因它隐藏——用户定稿：工具执行期间恒显最近的 zcode 真值 */
const STREAM_ACTIVE_MS = 3000
/** 真值新鲜期：rounds 按请求完成落账（服务端统计周期=每请求完成，无周期性推送）。
 *  生成期超过 8s 未落新账即交估算接管（防冻结观感）；非生成期不限，恒显最近真值 */
const REAL_FRESH_MS = 8000
/** 估算显示值保持时长：500ms 自刷会令估算数字跳太快（真机反馈），屏上数字 2s 一更新 */
const EST_HOLD_MS = 2000

interface Props {
  /** 开始等待的时间戳（毫秒）。不传则不显示计时 */
  since?: number
}

export function WaitingIndicator({ since }: Props) {
  const { t } = useTranslation()
  const currentModel = useStore((s) => s.currentModel)
  const messages = useStore((s) => s.messages)
  const streamingMessageId = useStore((s) => s.streamingMessageId)
  const sessionDebug = useStore((s) => s.sessionDebug)
  const loadSessionDebug = useStore((s) => s.loadSessionDebug)
  const [, force] = useState(0)
  // 自校准取样锚点：上次观察到的真值回合 id 与当时的字符累计值
  const lastRoundIdRef = useRef<string | null>(null)
  const charsMarkRef = useRef(0)
  // 估算显示值保持槽（2s 一更新，防数字跳太快）
  const estHoldRef = useRef<{ v: number | null; at: number }>({ v: null, at: 0 })

  // 每 500ms 重渲染（更新省略号 + 计时）；另挂 2s 轮询拉 session/debug 真值 TPS——
  // 数值只在模型请求完成时变（单请求秒级~几十秒），2s 已贴合变化节拍，1s 属同值空转
  useEffect(() => {
    const timer = setInterval(() => force((n) => n + 1), 500)
    loadSessionDebug()
    const tpsTimer = setInterval(loadSessionDebug, 2000)
    return () => {
      clearInterval(timer)
      clearInterval(tpsTimer)
    }
  }, [])

  // 模型名优先取 currentModel，回退最后一条 assistant 消息的 modelID
  const modelName = currentModel?.modelId
    ?? (() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i].info.modelID
        if (m) return m
      }
      return null
    })()

  const dots = '.'.repeat(Math.floor(Date.now() / 500) % 3 + 1)
  const elapsed = since ? elapsedDesc(since) : ''
  // 速率只在模型流式活跃时显示：rounds 是请求完成后的静态值，工具执行/构建期间
  // 挂出来会被误读成实时速度（真机反馈"构建中为何还有值"）；500ms 自刷保证
  // 静默 3s 后即消失、恢复输出即回归
  const streamActive = Date.now() - modelStreamActivity.lastAt < STREAM_ACTIVE_MS
  // 工具忙碌起点仅用于自校准取样门控（子代理重映射帧污染防护），不再隐藏速率
  const toolBusy = (() => {
    const msg = streamingMessageId ? messages.find((m) => m.info.id === streamingMessageId) : null
    if (!msg) return false
    return msg.parts.some(
      (p) => p.type === 'tool' && (p.state.status === 'running' || p.state.status === 'pending'),
    )
  })()
  const lastRound = sessionDebug ? lastTpsRound(sessionDebug.rounds) : null
  // 自校准：新真值回合落账 → 用"两次落账间的流式字符增量 ÷ 服务端 outputTokens"
  // 反推实测 chars/token，EMA 进估算除数（首回合仅记锚点不校准——那笔回合的字符
  // 不在本进程计数里）。取样仅在"主会话真在流式产出"时进行，防工具/子代理期污染
  if (lastRound && lastRound.requestId !== lastRoundIdRef.current) {
    if (lastRoundIdRef.current !== null && streamActive && !toolBusy) {
      calibrateCharsPerToken(streamCharsTotal() - charsMarkRef.current, lastRound.usage.outputTokens ?? 0)
    }
    lastRoundIdRef.current = lastRound.requestId
    charsMarkRef.current = streamCharsTotal()
  }
  // 速率显示（用户定稿）：有真值就显示——非生成期（工具执行/请求间隙）恒显最近真值
  // 不隐藏；生成期真值新鲜（落账 8s 内）恒显，过期则交估算接管防冻结观感
  const realFresh = lastRound != null && Date.now() - lastRound.recordedAt < REAL_FRESH_MS
  const realTps = lastRound
    ? realFresh || !streamActive
      ? lastRound.tokensPerSecond
      : null
    : null
  const estRaw =
    streamActive && realTps == null ? estimateTpsFromChars(streamCharsPerSec()) : null
  if (estRaw != null) {
    // 数值 2s 一更新（防跳动）；estRaw 为 null（流起步/停顿恢复的估算窗口饥饿期，
    // 约 1.5s）不再立即清屏——保留最近估算值兜底，数字不闪没（缺陷FE：千帆长思考
    // 请求真值过期+渠道停顿恢复时速率消失）。回合结束组件卸载自然复位；新鲜真值
    // 或新鲜估算落地时按渲染优先级原样接管
    const estHold = estHoldRef.current
    if (estHold.v == null || Date.now() - estHold.at >= EST_HOLD_MS) {
      estHoldRef.current = { v: estRaw, at: Date.now() }
    }
  }
  const estTps = estHoldRef.current.v

  return (
    <div className="waiting">
      <div className="waiting__spinner" />
      <span className="waiting__text">
        {(modelName ? t('common.waiting.generatingWithModel', { model: modelName }) : t('common.waiting.generating'))}
        {/* 省略号定宽：动画 1~3 个点宽度变化不再推挤后面的速率/计时（真机反馈抖动）*/}
        <span className="waiting__dots">{dots}</span>
      </span>
      {realTps != null && (
        <span className="waiting__rate">{t('usage.speed.live', { tps: realTps.toFixed(1) })}</span>
      )}
      {realTps == null && estTps != null && (
        <span className="waiting__rate waiting__rate--estimate">
          {t('usage.speed.estimate', { tps: estTps.toFixed(1) })}
        </span>
      )}
      {elapsed && <span className="waiting__time">{t('common.waiting.elapsed', { time: elapsed })}</span>}
    </div>
  )
}
