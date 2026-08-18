/**
 * 内置套餐徽章：两个内置套餐显示名相同（BigModel - Coding Plan），
 * Kotlin 按 providerId 标记 plan（coding-plan=个人、start-plan=体验），徽章区分展示。
 * 用于输入框模型下拉分组标题与设置页模型管理 provider 卡片头部。
 */

import { useTranslation } from 'react-i18next'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

export function PlanBadge({ plan }: { plan?: 'personal' | 'trial' }) {
  const { t } = useTranslation()
  if (!plan) return null
  return <span className={cx('plan-badge', plan)}>{t(`models.plan.${plan}`)}</span>
}
