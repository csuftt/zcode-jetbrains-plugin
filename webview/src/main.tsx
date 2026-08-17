import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/variables.less' // 全局 CSS 变量（必须在最前）
import './codicon.css' // VS Code codicon 图标字体（cc-gui 同款）
import { initAppearance } from './utils/appearance'
import { initPersist } from './utils/persist'
import App from './App'

// 外观恢复（字号/自定义颜色；index.html 防闪脚本之后、React 渲染之前兜底补齐）
initAppearance()
// 配置类 kv 恢复（搜索开关/输入历史/模型记忆等；注入权威值写回 localStorage）
initPersist()

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('找不到 #root 容器')

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
