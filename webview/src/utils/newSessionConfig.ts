/**
 * 新建会话按钮配置（纯前端消费）
 *
 * directOverwrite（默认关闭）：工具栏「新会话」按钮跳过「覆盖当前标签页 /
 * 新标签页打开」三选确认弹窗，直接覆盖当前标签页（= 弹窗 onConfirm 路径
 * resetToNewSession，重置为待命态、首条消息懒创建）。默认关闭的理由：两种
 * 错误代价不对称——默认开的代价是误触按钮瞬间切走正在进行的对话（虽可从
 * 历史切回，但打断感强）；默认关的代价是想免确认的用户去设置里开一次。
 *
 * 应用点唯一：App.tsx handleNewSession（Header「新会话」按钮）。空会话置灰
 * 兜底（currentSessionEmpty）不受影响——开关开启时空会话按钮仍置灰。
 * 不应用的路径：历史列表点击历史会话的「覆盖 / 新标签页」选择弹窗
 * （HistoryView setSwitchTarget，独立确认链路，用户显式要求不受影响）、
 * Java createTab 新标签按钮、Java 自动 newSession 兜底。
 *
 * 存储走 persist kv 通道（key=zcode.newSession.config）：localStorage 即时生效 +
 * 去抖回存 IDE PropertiesComponent，跨重启保留。读取方在调用时取值，无同标签
 * 变更事件需求（设置改动等下一次点击自然生效）。
 */
import { getPersisted, setPersisted } from './persist'

export interface NewSessionConfig {
  /** 新会话按钮免确认直接覆盖当前标签页（默认关闭）*/
  directOverwrite: boolean
}

const KEY = 'zcode.newSession.config'

export const DEFAULT_NEW_SESSION_CONFIG: NewSessionConfig = {
  directOverwrite: false,
}

export function readNewSessionConfig(): NewSessionConfig {
  const raw = getPersisted(KEY)
  if (!raw) return { ...DEFAULT_NEW_SESSION_CONFIG }
  try {
    const obj = JSON.parse(raw) as Partial<NewSessionConfig>
    return {
      directOverwrite:
        typeof obj.directOverwrite === 'boolean'
          ? obj.directOverwrite
          : DEFAULT_NEW_SESSION_CONFIG.directOverwrite,
    }
  } catch {
    return { ...DEFAULT_NEW_SESSION_CONFIG }
  }
}

export function writeNewSessionConfig(config: NewSessionConfig): void {
  setPersisted(KEY, JSON.stringify(config))
}
