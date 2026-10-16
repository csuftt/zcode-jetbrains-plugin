/**
 * 后台任务识别共享判据（单点定义，缺陷Z 教训：判据注释勿逐字引用官方句子）
 *
 * zcode.cjs 的后台化确认（Bash run_in_background / 手动后台化）输出固定形态：
 *   ① 以 `Command` 动作前缀开头（三种官方动作之一）
 *   ② 任务 ID 恒为 `exec_` + 标准 UUID（8-4-4-4-12 十六进制，2026-08-25 起
 *      多个真实事件实测确认）
 * 两者同时要求即足够特异：普通命令输出/源码注释里的占位 ID（exec_xxx、短 ID）
 * 或残缺文案都会被拒绝（缺陷Z 双判据 + 2026-08-26 变体：完整句子 + exec_xxx
 * 占位被 UUID 形态拒绝）。
 */

import { isAgentNotification, parseNotificationText } from '@/utils/parseNotification'

const RE_BG_CMD = /Command (?:running in background|was manually backgrounded by user|was moved to the background)/i
const RE_BG_ID = /with ID:\s*(exec_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

/** 从工具输出文本提取后台任务 ID；非官方后台化确认返回 null */
export function extractBackgroundTaskIdFromContent(content: string): string | null {
  if (!RE_BG_CMD.test(content)) return null
  const m = content.match(RE_BG_ID)
  return m ? m[1] : null
}

/** 渲染层判定：工具输出是否为官方后台化确认（历史消息静态识别用，无账本也能判定） */
export function isBackgroundTaskOutput(output: string | undefined | null): boolean {
  return typeof output === 'string' && extractBackgroundTaskIdFromContent(output) !== null
}

/**
 * 从转录重建历史后台任务条目（refreshStatus 派生，与 parseAgents 同思路）：
 * 遍历 Bash 工具行，state.output 命中官方后台化确认 → 提取 exec_ 任务 ID 合成条目。
 * status 恒为 'ended'（本地合成值）——转录只能证明「启动过」，运行时真实状态由
 * 投影（backgroundWorksBySession）承载，读取处 mergeBackgroundWorks 合并、投影优先：
 * 本进程内同 workId 以投影为准（running 可取消），重启后投影消失即剩 ended 历史。
 */
export function parseBackgroundTaskWorks(messages: import('@/types/messages').ZCodeMessage[]): import('@/types/messages').BackgroundWorkSummary[] {
  const byId = new Map<string, import('@/types/messages').BackgroundWorkSummary>()
  for (const msg of messages) {
    for (const part of msg.parts ?? []) {
      if (part.type !== 'tool' || part.tool !== 'Bash') continue
      const out = part.state?.output
      const id = typeof out === 'string' ? extractBackgroundTaskIdFromContent(out) : null
      if (!id || byId.has(id)) continue
      const command = String(part.state?.input?.command ?? '').slice(0, 200)
      byId.set(id, {
        workId: id,
        kind: 'bash',
        title: command || id,
        status: 'ended',
        startedAt: part.state?.time?.start ?? 0,
        cancellable: false,
      })
    }
  }
  return [...byId.values()]
}

/**
 * 从转录收集「完成通知已投递」的后台任务终态（workId → ended/failed）。
 *
 * 背景（0.3.9 真机实勘）：CLI 的 backgroundWorks 数组在任务结果投递进转录
 * （task-notification 合成消息落地）后并不推收敛帧，投影条目会无限期停在
 * resultPending——通知卡都已渲染、面板还挂着「待投递」。task-notification 的
 * task-id + status 就是投递证据，读取处 mergeBackgroundWorks 据此本地升级，
 * 不再依赖 CLI 帧。只收终态（completed/failed）；agent_ 前缀的子代理完成通知
 * 同样收（子代理投影条目同病同治）。
 */
export function parseDeliveredWorkStatuses(
  messages: import('@/types/messages').ZCodeMessage[],
): Map<string, 'ended' | 'failed'> {
  const delivered = new Map<string, 'ended' | 'failed'>()
  for (const msg of messages) {
    if (!isAgentNotification(msg.info)) continue
    const textPart = msg.parts?.find((p): p is import('@/types/messages').TextPart => p.type === 'text')
    const text = textPart?.text
    if (typeof text !== 'string' || !text.includes('<task-notification>')) continue
    const parsed = parseNotificationText(text)
    if (parsed.kind !== 'task' || !parsed.taskId) continue
    if (parsed.status === 'completed') delivered.set(parsed.taskId, 'ended')
    else if (parsed.status === 'failed') delivered.set(parsed.taskId, 'failed')
  }
  return delivered
}

/**
 * 面板展示排序（读取处 BackgroundTaskList 用）：运行中（running，含 blocked——
 * 同属 running 态）置顶，置顶组与其余组各自按启动时间倒序（新→旧，缺时间戳沉组尾）。
 * 拼接序不能承担展示序：投影组内部是服务端顺序，运行中条目可能沉底（真机反馈）。
 */
export function sortBackgroundWorksRunningFirst<T extends { status: string; startedAt: number }>(works: T[]): T[] {
  return [...works].sort((a, b) => {
    const pa = a.status === 'running' ? 0 : 1
    const pb = b.status === 'running' ? 0 : 1
    if (pa !== pb) return pa - pb
    return (b.startedAt ?? 0) - (a.startedAt ?? 0)
  })
}

/**
 * 投影 ∪ 转录重建合并（读取处用）：按 workId 去重、投影优先（运行时权威状态覆盖
 * 重建的 ended 猜测）；投影组在前（仅数据序，展示排序由 sortBackgroundWorksRunningFirst
 * 在渲染处收口）。
 *
 * deliveredStatuses 非空时先对投影做投递升级：resultPending 且转录已见完成通知的
 * 条目本地翻终态（单向升级——running/resultPending 之外的投影状态不碰、转录重建
 * 组不参与升级；标题/启动时间保留投影值，避免重建条目的命令原文标题劣化）。
 */
export function mergeBackgroundWorks(
  projection: import('@/types/messages').BackgroundWorkSummary[],
  fromTranscript: import('@/types/messages').BackgroundWorkSummary[],
  deliveredStatuses?: ReadonlyMap<string, 'ended' | 'failed'>,
): import('@/types/messages').BackgroundWorkSummary[] {
  let effective = projection
  if (deliveredStatuses && deliveredStatuses.size > 0) {
    effective = projection.map((w) => {
      const delivered = deliveredStatuses.get(w.workId)
      if (delivered && w.status === 'resultPending') {
        return { ...w, status: delivered, cancellable: false }
      }
      return w
    })
  }
  if (fromTranscript.length === 0) return effective
  const seen = new Set(effective.map((w) => w.workId))
  return [...effective, ...fromTranscript.filter((w) => !seen.has(w.workId))]
}
