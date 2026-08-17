/**
 * 欢迎页（cc-gui WelcomeScreen 简化版）
 * 无消息时显示：Logo + 版本号徽章 + 提示语
 * 动效（见 welcome.less）：Logo 弹性入场/悬浮/扫光/光圈扩散、徽章滑入/辉光呼吸、提示语逐字打字机 + 光标
 */

import { ZaiIcon } from './ZaiIcon'
import '../styles/welcome.less'

const APP_VERSION = '0.1.0'

/**
 * 逐字打字机入场：把文本拆成 span，按序号递增 animation-delay
 * 空格换成 \u00A0 防止 inline-block 下折叠丢失
 */
function StaggeredText({ text, startDelay = 0, step = 0.05 }: { text: string; startDelay?: number; step?: number }) {
  return (
    <>
      {Array.from(text).map((ch, i) => (
        <span
          key={i}
          className="welcome__hint-char"
          style={{ animationDelay: `${(startDelay + i * step).toFixed(3)}s` }}
        >
          {ch === ' ' ? '\u00A0' : ch}
        </span>
      ))}
    </>
  )
}

export function WelcomeScreen() {
  return (
    <div className="welcome">
      <div className="welcome__logo-wrapper">
        {/* 光圈扩散层（两圈错开扩散，放在 box 外避免被 overflow 裁剪） */}
        <span className="welcome__logo-ping" />
        <span className="welcome__logo-ping welcome__logo-ping--delay" />
        <div className="welcome__logo-box">
          {/* Zai 品牌图标（黑底白 Z，固定品牌色不跟随主题） */}
          <ZaiIcon size={56} className="welcome__logo" />
          {/* 扫光高光条 */}
          <span className="welcome__logo-shine" />
        </div>
        <span className="welcome__version-tag" title="ZCode 版本">v{APP_VERSION}</span>
      </div>
      <div className="welcome__hint">
        {/* 无会话（懒创建待命态）与空会话一致：直接输入即开始对话（首条消息触发建会话） */}
        <StaggeredText text="给 ZCode 发送消息" startDelay={0.9} />
        <span className="welcome__hint-caret" />
      </div>
    </div>
  )
}
