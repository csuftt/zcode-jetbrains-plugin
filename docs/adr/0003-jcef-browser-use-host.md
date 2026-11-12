# 浏览器工具以内嵌 JCEF 为执行宿主

**Status**: accepted（回溯记录，2026-11-12）

AI 的浏览器工具不落到外部 Chrome，而是由插件充当 browser-use 宿主，经反向协议（`interaction/browserList` / `browserExecute`）在内嵌 JCEF 中执行。这样浏览器与 IDE 同进程：用户能直接看到 AI 在操作什么，也不需要用户额外安装浏览器、配置调试端口。

**Considered Options**

- 外部 Chrome + CDP：安装与版本依赖重，用户看不到操作现场。
- 走 IDE 自带的远程调试端口：在 2023.3 上受平台开关限制，不能作为通用通道。

**Consequences**

- JCEF 缺失的能力（如 HTML5 原生拖拽）必须自行实现。
- 多个 IDE 并存时，宿主身份（而不是端口或时间）必须是选择调试目标的第一排序键。

**References**

- `docs/internal/design-research/browser-use宿主协议接入设计.md`
- `docs/internal/design-research/内嵌浏览器前端调试移植调研.md`
- `docs/internal/bugs-regressions/`（宿主身份路由相关缺陷记录）