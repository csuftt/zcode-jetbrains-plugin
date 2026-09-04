import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/variables.less' // 全局 CSS 变量（必须在最前）
import './codicon.css' // VS Code codicon 图标字体（cc-gui 同款）
import { initAppearance } from './utils/appearance'
import { initPersist } from './utils/persist'
import './i18n/config' // i18n 初始化（语言解析：IDE 注入 > 手动值 > 默认 zh）
import { initI18nLanguage } from './i18n/language'
import { installFlashProbe } from './utils/flashProbe'
import App from './App'

// 外观恢复（字号/自定义颜色；index.html 防闪脚本之后、React 渲染之前兜底补齐）
initAppearance()
// 配置类 kv 恢复（搜索开关/输入历史/模型记忆等；注入权威值写回 localStorage）
initPersist()
// 语言兜底（注入晚到补切换）+ 多标签同步 + <html lang> 修正
initI18nLanguage()
// 闪屏探针（临时诊断：goal 运行中间歇闪屏排查，定案后移除；zcode.flashProbe=0 关闭）
installFlashProbe()

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('找不到 #root 容器')

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
