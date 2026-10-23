/**
 * 内置套餐徽章：两个内置套餐显示名相同（BigModel - Coding Plan），
 * Kotlin 按 providerId 标记 plan（coding-plan=个人、start-plan=体验；
 * team=客户端选中团队套餐，与个人共用同一条 providerId，见 issue #8），徽章区分展示。
 * builtin=team 编码渠道兜底标识（2026-10-23 用户定稿：真团队连接才落此渠道，
 * Lite/Pro/Max 档位本地无数据源不可断言，档位/团队字样均有误导，统一中性
 * 「内置渠道」+绿色背景；individual/trial 徽标保持原生不变；管理页不渲染套餐徽标）。
 * 用于输入框模型下拉分组标题与设置页模型管理 provider 卡片头部。
 */

import { useTranslation } from 'react-i18next'
import '../styles/global.less'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

export function PlanBadge({ plan }: { plan?: 'personal' | 'trial' | 'team' | 'builtin' }) {
  const { t } = useTranslation()
  if (!plan) return null
  return <span className={cx('plan-badge', plan)}>{t(`models.plan.${plan}`)}</span>
}

/**
 * 视觉能力徽章：模型配置 modalities.input 含 image 时展示「视觉」，
 * 用于输入框模型下拉项与设置页模型管理行（能力位来自用户配置，仅供参考）。
 */
export function VisionBadge() {
  const { t } = useTranslation()
  return <span className="vision-badge">{t('models.vision')}</span>
}
