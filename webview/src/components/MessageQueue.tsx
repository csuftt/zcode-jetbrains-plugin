/**
 * 排队消息列表（输入框 topbar 下方，cc-gui MessageQueue 风格）
 *
 * 对话进行中 Enter 入队的消息在此展示（正序，序号 1 = 下一条发送）：
 *   - 单行省略预览（title 悬浮全文）
 *   - 立即发送：中断当前回合并把该消息提前到队头（turn 结束事件到达后自动发出）
 *   - 编辑：移出队列并回填到输入框（onEdit 由 InputBox 提供操作编辑器）
 *   - 删除：从队列移除
 *
 * 队列数据直连 store（与 ContextRing/ModeSelect 等输入框子组件一致）；
 * 编辑回填涉及 InputBox 私有的 editorRef，经 onEdit 回调上抛。
 */

import { useTranslation } from 'react-i18next'
import { useStore } from '@/store/useStore'
import '../styles/message-queue.less'

interface Props {
  /** 编辑队列消息：组件内已移出队列，回调负责把文本回填输入框 */
  onEdit?: (text: string) => void
}

export function MessageQueue({ onEdit }: Props) {
  const { t } = useTranslation()
  const queued = useStore((s) => s.queuedMessages)
  const removeQueuedMessage = useStore((s) => s.removeQueuedMessage)
  const sendQueuedNow = useStore((s) => s.sendQueuedNow)

  if (queued.length === 0) return null

  return (
    <div className="message-queue">
      {queued.map((m, i) => (
        <div key={m.id} className="message-queue__item">
          <span className="message-queue__index" title={t('input.queue.pendingTitle', { index: i + 1 })}>
            {i + 1}
          </span>
          <span className="message-queue__text" title={m.text}>
            {m.text.replace(/\n/g, ' ')}
          </span>
          <span className="message-queue__actions">
            <button
              className="message-queue__btn message-queue__btn--send"
              onClick={() => sendQueuedNow(m.id)}
              title={t('input.queue.sendNow')}
            >
              <span className="codicon codicon-export message-queue__send-icon" />
              <span className="message-queue__send-label">{t('input.queue.sendNowShort')}</span>
            </button>
            {onEdit && (
              <button
                className="message-queue__btn message-queue__btn--edit"
                onClick={() => {
                  removeQueuedMessage(m.id)
                  onEdit(m.text)
                }}
                title={t('input.queue.edit')}
              >
                <span className="codicon codicon-edit" />
              </button>
            )}
            <button
              className="message-queue__btn message-queue__btn--remove"
              onClick={() => removeQueuedMessage(m.id)}
              title={t('input.queue.remove')}
            >
              <span className="codicon codicon-close" />
            </button>
          </span>
        </div>
      ))}
    </div>
  )
}
