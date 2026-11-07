/**
 * 带图用户消息复制的网页内备份（粘贴还原通道）
 *
 * 系统剪贴板的图片槽只装得下一张图（clipboard.write 单个 ClipboardItem 每个 mime
 * 一个值），多图消息复制后走剪贴板必然丢图；且 JCEF 偶发不把系统剪贴板图片暴露给
 * clipboardData（见 InputBox.handlePaste 的 Java AWT 兜底注释）。因此复制带图消息时
 * 在 webview 内存同步留一份 { 文本, 图片src列表 }，粘贴进输入框时按文本全等比对命中，
 * 直接取回全部图片——多图完整还原，同时绕开 JCEF 剪贴板可见性问题。
 *
 * 只影响本 webview 内的粘贴；外部应用粘贴走系统剪贴板（text/plain + 首图）不受影响。
 * 备份不落盘、不入剪贴板，刷新即失（丢的只是「粘贴还原」，复制本身已成功）。
 */

interface CopiedMessageStash {
  text: string
  srcs: string[]
}

let stash: CopiedMessageStash | null = null

/**
 * 复制带图消息时登记备份。空文本（纯图消息）不登记：空文本命中判据太弱，
 * 外部截图后粘贴会被陈年备份误命中（文本比对是唯一防误判信号），
 * 纯图消息的还原走系统剪贴板图片项 / Java AWT 兜底。
 */
export function stashCopiedMessage(text: string, srcs: string[]): void {
  stash = text && srcs.length > 0 ? { text, srcs } : null
}

/**
 * 粘贴文本与最近复制的带图消息一致时取回图片 src 列表（空文本恒不命中）。
 * 不清空备份：同一段内容可连续粘贴多次（换会话再贴同样还原）。
 */
export function matchCopiedMessageImages(text: string): string[] | null {
  if (!text || !stash || stash.text !== text) return null
  return stash.srcs
}

/** 测试用：清空备份 */
export function resetCopiedMessageStash(): void {
  stash = null
}
