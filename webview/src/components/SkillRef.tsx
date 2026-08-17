/**
 * 技能引用 chip（/斜杠命令选中后展示）
 *
 * 笔图标 + 技能名，可删除。选中斜杠命令后以 chip 形式显示在输入框上方，
 * 发送时拼回 /技能名 前缀（由 ZCode CLI 解析）。
 * 紫色调，区别于文件引用（蓝色）。
 */

import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import '../styles/skill-ref.less'

interface Props {
  name: string
  description?: string
  onRemove: () => void
}

function SkillRefInner({ name, description, onRemove }: Props) {
  const { t } = useTranslation()
  const tooltip = description ? `/${name} — ${description}` : `/${name}`
  return (
    <span className="skill-ref" data-tip={tooltip}>
      <span className="codicon codicon-wand skill-ref__icon" />
      <span className="skill-ref__name">{name}</span>
      <button
        className="skill-ref__remove"
        onClick={onRemove}
        title={t('skills.removeSkill')}
        type="button"
      >
        ✕
      </button>
    </span>
  )
}

export const SkillRef = memo(SkillRefInner)
