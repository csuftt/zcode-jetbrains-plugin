/**
 * 技能/命令引用 chip（/斜杠补全选中后展示）
 *
 * skill=笔图标紫色调，command=终端图标绿色调（与补全下拉图标体系一致）。
 * 可删除。选中斜杠命令后以 chip 形式显示在输入框上方，
 * 发送时拼回 /名称 前缀（由 ZCode CLI 解析）。
 */

import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import '../styles/skill-ref.less'

interface Props {
  name: string
  description?: string
  /** skill=技能（笔图标）| command=命令（终端图标）*/
  kind?: 'skill' | 'command'
  onRemove: () => void
}

function SkillRefInner({ name, description, kind = 'skill', onRemove }: Props) {
  const { t } = useTranslation()
  const tooltip = description ? `/${name} — ${description}` : `/${name}`
  return (
    <span
      className={`skill-ref${kind === 'command' ? ' skill-ref--command' : ''}`}
      data-tip={tooltip}
    >
      <span
        className={`codicon ${kind === 'command' ? 'codicon-terminal' : 'codicon-wand'} skill-ref__icon`}
      />
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
