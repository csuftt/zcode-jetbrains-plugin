/**
 * /goal 命令文本解析（手动输入与定时消息共用）
 *
 * 手动路径：InputBox 提交前拦截（goal 命令 chip 序列化成 /goal 前缀文本或直接键入）。
 * 定时路径：定时消息到点受理时拦截（scheduledDue / sendScheduledNow / flushQueue /
 * sendQueuedNow）——定时文本若走普通 sendMessage 会把命令原文当 user 消息发给模型，
 * goal 引擎（session/goal RPC）不会被触发、目标卡不出现（2026-09-04 用户反馈），
 * 必须与手动输入一样转 goalManage 控制意图。
 *
 * 语义（与手动输入一致）：
 *   /goal            → show（无目标时 UI 给用法提示）
 *   /goal pause      → pause
 *   /goal resume     → resume
 *   /goal clear      → clear
 *   /goal <其他文本>  → set <文本>（replace 子命令由 goalManage 面板专用，不在此列）
 */

export interface GoalCommandIntent {
  action: 'set' | 'pause' | 'resume' | 'clear' | 'show'
  /** 仅 set 有：目标文本 */
  objective?: string
}

/** 解析 /goal 命令；非命令文本返回 null */
export function parseGoalCommand(text: string): GoalCommandIntent | null {
  // 尾随空白容忍（定时文本不经 InputBox 的 trimEnd；正则的 $ 锚点会被尾空白顶掉）
  const m = text.replace(/\s+$/, '').match(/^\/goal(?:\s+([\s\S]+))?$/)
  if (!m) return null
  const arg = m[1]?.trim() ?? ''
  if (!arg) return { action: 'show' }
  if (/^pause$/i.test(arg)) return { action: 'pause' }
  if (/^resume$/i.test(arg)) return { action: 'resume' }
  if (/^clear$/i.test(arg)) return { action: 'clear' }
  return { action: 'set', objective: arg }
}
