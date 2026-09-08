/**
 * 排队消息列表（输入框 topbar 下方，cc-gui MessageQueue 风格）
 *
 * 对话进行中 Enter 入队的消息在此展示（正序，序号 1 = 下一条发送）：
 *   - 单行省略预览（title 悬浮全文；纯图消息显示占位文案与图片数徽标）
 *   - 立即发送：中断当前回合并把该消息提前到队头（turn 结束事件到达后自动发出）
 *   - 引导（steer）：把该消息注入当前运行中的回合（不打断不排队，v4 guide 通道）；
 *     定时来源条目无此入口（定时 ack 语义未验证）。带附件条目可引导（2026-09-08
 *     扩展）：v4 附件走 ref 形态，但 guide+附件服务端必降级为 queue——表现为本回合
 *     结束后立即发出（附件完整保留），chip 文案区分
 *   - 编辑：移出队列并回填到输入框（onEdit 由 InputBox 提供操作编辑器；图片附件
 *     一并回填附件栏）
 *   - 删除：从队列移除
 *
 * 队列数据直连 store（与 ContextRing/ModeSelect 等输入框子组件一致）；
 * 编辑回填涉及 InputBox 私有的 editorRef，经 onEdit 回调上抛。
 */

import { useTranslation } from 'react-i18next'
import { useStore } from '@/store/useStore'
import '../styles/message-queue.less'

interface Props {
  /** 编辑队列消息：组件内已移出队列，回调负责把文本回填输入框、图片回填附件栏 */
  onEdit?: (text: string, attachments?: import('@/types/messages').ImageAttachmentInput[]) => void
}

export function MessageQueue({ onEdit }: Props) {
  const { t } = useTranslation()
  const queued = useStore((s) => s.queuedMessages)
  const removeQueuedMessage = useStore((s) => s.removeQueuedMessage)
  const sendQueuedNow = useStore((s) => s.sendQueuedNow)
  const sendQueuedAsSteer = useStore((s) => s.sendQueuedAsSteer)
  const steerPending = useStore((s) => s.steerPending)

  if (queued.length === 0) return null

  return (
    <div className="message-queue">
      {queued.map((m, i) => {
        const imageCount = m.attachments?.length ?? 0
        return (
          <div key={m.id} className="message-queue__item">
            <span className="message-queue__index" title={t('input.queue.pendingTitle', { index: i + 1 })}>
              {i + 1}
            </span>
            <span className="message-queue__text" title={m.text}>
              {m.text.trim() ? m.text.replace(/\n/g, ' ') : t('input.queue.imageOnly')}
            </span>
            {imageCount > 0 && (
              <span
                className="message-queue__img-badge"
                title={t('input.queue.imageBadge', { count: imageCount })}
              >
                <span className="codicon codicon-file-media" />
                {imageCount > 1 && <span className="message-queue__img-count">{imageCount}</span>}
              </span>
            )}
            {m.scheduledFireAt != null && (
              <span
                className="message-queue__sched-badge"
                title={t('input.queue.scheduledBadge', { time: new Date(m.scheduledFireAt).toLocaleString() })}
              >
                <span className="codicon codicon-clockface" />
                {t('input.queue.scheduledShort')}
              </span>
            )}
            <span className="message-queue__actions">
              <button
                className="message-queue__btn message-queue__btn--send"
                onClick={() => sendQueuedNow(m.id)}
                title={t('input.queue.sendNow')}
              >
                <span className="codicon codicon-export message-queue__send-icon" />
                <span className="message-queue__send-label">{t('input.queue.sendNowShort')}</span>
              </button>
              {/* 引导（steer）：定时来源条目不显示；带附件条目可引导（服务端降级为
                  本回合结束后立即发出，见组件头注释）；已有在途引导时禁用
                  （同一时刻只收一条在途注入，steerMessage 守卫兜底）*/}
              {m.scheduledFireAt == null && (
                <button
                  className="message-queue__btn message-queue__btn--steer"
                  onClick={() => sendQueuedAsSteer(m.id)}
                  disabled={!!steerPending}
                  title={
                    steerPending
                      ? t('input.queue.steerDisabled')
                      : imageCount > 0
                        ? t('input.queue.steerImageNow')
                        : t('input.queue.steerNow')
                  }
                >
                  <span className="codicon codicon-zap" />
                  <span className="message-queue__send-label">{t('input.queue.steerNowShort')}</span>
                </button>
              )}
              {onEdit && (
                <button
                  className="message-queue__btn message-queue__btn--edit"
                  onClick={() => {
                    removeQueuedMessage(m.id)
                    onEdit(m.text, m.attachments)
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
        )
      })}
    </div>
  )
}
