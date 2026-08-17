/**
 * 额度卡片列表（从原 QuotaView 抽出，UsageView 和未来其他视图复用）
 *
 * 卡片结构对齐 glm GlmUsagePanel.buildLimitCard：
 *   head(标题 + 大号百分比) → 进度条 → 重置时间
 *
 * 注：额度 API（quota/limit）对 5 小时/每周等档位只返回 percentage，
 * 没有 currentValue/usage（具体 token 数），故卡片只展示百分比 + 重置时间，
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
            <div className="quota-card__head">
              <span className="quota-card__title">{limitTitle(limit)}</span>
              <span className="quota-card__pct">{pct.toFixed(0)}%</span>
            </div>
            <div className="quota-card__bar">
              <div className="quota-card__bar-fill" style={{ width: `${pct}%` }} />
            </div>
            {limit.nextResetTime ? (
              <div className="quota-card__foot">
                <span className="quota-card__reset">{t('usage.quota.resetAt', { time: fmtResetTime(limit.nextResetTime) })}</span>
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
