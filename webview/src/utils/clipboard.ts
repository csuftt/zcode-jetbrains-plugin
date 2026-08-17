/**
 * 剪贴板工具
 *
 * navigator.clipboard 优先（内置 server 走 localhost，属 secure context，API 可用）；
 * 不可用/被拒时降级 document.execCommand('copy')（隐藏 textarea 方案）。
 */

export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      /* 权限拒绝或 CEF 实现异常，走降级 */
    }
  }
  return copyViaExecCommand(text)
}

function copyViaExecCommand(text: string): boolean {
  const ta = document.createElement('textarea')
  ta.value = text
  // fixed + 透明：不触发页面滚动、不产生视觉闪烁
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  document.body.removeChild(ta)
  return ok
}
