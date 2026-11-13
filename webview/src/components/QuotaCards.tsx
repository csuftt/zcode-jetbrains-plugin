/**
 * 额度卡片列表（从原 QuotaView 抽出，UsageView 和未来其他视图复用）
 *
 * 单容器紧凑行布局（原三张竖排大卡过高，压缩为每条额度一行）：
 *   标题 → 进度条 → 百分比 → 重置时间
 *
 * 行内只显示百分比（「已用」语义已上移到区块标题，2026-11-12 用户定）；
 * 注：额度 API（quota/limit）对 5 小时/每周等档位只返回 percentage，
 * 没有 currentValue/usage（具体 token 数），故只展示百分比 + 重置时间，
 * 不展示「已用/总量」。与「工具用量」不同——后者有调用次数。
 */

import { useTranslation } from 'react-i18next'
import type { QuotaLimit } from '@/types/messages'
import { limitTitle, fmtResetTime } from '@/utils/format'
import '../styles/quota-view.less'

interface Props {
  limits: QuotaLimit[]
}

export function QuotaCards({ limits }: Props) {
  const { t } = useTranslation()
  if (limits.length === 0) {
    return <div className="quota-view__empty">{t('usage.quota.empty')}</div>
  }
  return (
    <div className="quota-view__cards">
      {limits.map((limit, i) => {
        const pct = Math.min(100, Math.max(0, limit.percentage ?? 0))
        return (
          <div key={i} className="quota-card">
            <span className="quota-card__title">{limitTitle(limit)}</span>
            <div className="quota-card__bar">
              <div className="quota-card__bar-fill" style={{ width: `${pct}%` }} />
            </div>
            {/* 行内只显示百分比（「已用」语义放在区块标题，2026-11-12 用户定）*/}
            <span className="quota-card__pct">{pct.toFixed(0)}%</span>
            {limit.nextResetTime ? (
              <span className="quota-card__reset">{t('usage.quota.resetAt', { time: fmtResetTime(limit.nextResetTime) })}</span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
