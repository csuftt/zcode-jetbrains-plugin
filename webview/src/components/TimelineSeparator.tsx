/**
 * 时间线分隔符（timeline part 渲染）
 *
 * marker 消息（role=assistant + timeline part）的专门渲染：官方语义
 * display:"separator"——横线 + 居中短文案，标记聊天流的结构性事件。
 * 已实测两类（2026-08-21 RPC 抓包）：
 *   - context_compaction：上下文已压缩（token 收缩指标）
 *   - model_change：模型切换（from → to）
 * 未知 timelineType 退化为中性「时间线事件」，不吞不炸。
 *
 * 长文案（model_change 的 from/to label 带渠道前缀）窄面板下换行而非截断：
 * label 部分（icon+文案）nowrap 保持一体，meta 允许任意字符断行。
 */

import { useTranslation } from 'react-i18next'
import type { TimelinePart } from '@/types/messages'
import { compactTokens } from '@/utils/time'
import '../styles/compaction.less'

interface Props {
  part: TimelinePart
}

/**
 * from/to 模型显示名：取短名 modelId（服务端实测小写 d）。
 * 服务端 marker 的 label 是 "providerId/modelId" 复合（如
 * builtin:bigmodel-coding-plan/GLM-5-Turbo），直接显示会与本地合成卡
 * （用 modelId）两套观感，且长名窄面板换行——统一短名，全名走 title 悬停。
 */
function modelLabel(m?: { modelID?: string; modelId?: string; label?: string }): string | undefined {
  return m?.modelId ?? m?.modelID ?? m?.label
}

export function TimelineSeparator({ part }: Props) {
  const { t } = useTranslation()

  if (part.timelineType === 'context_compaction') {
    const pre = part.preCompactTokenCount
    const post = part.truePostCompactTokenCount ?? part.postCompactTokenCount
    return (
      <div className="tl-sep">
        <span className="tl-sep__line" />
        <span className="tl-sep__text">
          <span className="tl-sep__label">
            <span className="codicon codicon-compress" />
            {t('chat.compaction.title')}
          </span>
          {pre != null && post != null && (
            <span className="tl-sep__meta" title={`${pre.toLocaleString()} → ${post.toLocaleString()}`}>
              {compactTokens(pre)} → {compactTokens(post)} tokens
            </span>
          )}
        </span>
        <span className="tl-sep__line" />
      </div>
    )
  }

  if (part.timelineType === 'model_change') {
    // 无 fromModel = 老服务端「以模型 X 开始」固有标记；from==to = 净零切换
    // （实测 2026-09-03 db.sqlite：服务端连相同模型的注册重放也记 marker）——
    // 两者都无信息量，整条隐藏
    const fromId = part.fromModel?.modelId ?? part.fromModel?.modelID
    const toId = part.toModel?.modelId ?? part.toModel?.modelID
    if (!part.fromModel || (fromId && fromId === toId)) return null
    const from = modelLabel(part.fromModel)
    const to = modelLabel(part.toModel)
    return (
      <div className="tl-sep">
        <span className="tl-sep__line" />
        <span className="tl-sep__text">
          <span className="tl-sep__label">
            <span className="codicon codicon-arrow-swap" />
            {t('chat.timeline.modelChanged')}
          </span>
          {from && to && (
            <span
              className="tl-sep__meta"
              title={`${part.fromModel?.label ?? from} → ${part.toModel?.label ?? to}`}
            >
              {`${from} → ${to}`}
            </span>
          )}
        </span>
        <span className="tl-sep__line" />
      </div>
    )
  }

  return (
    <div className="tl-sep">
      <span className="tl-sep__line" />
      <span className="tl-sep__text">{t('chat.timeline.event')}</span>
      <span className="tl-sep__line" />
    </div>
  )
}
