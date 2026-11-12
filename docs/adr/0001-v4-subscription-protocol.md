# 全面迁移到 v4 订阅协议

**Status**: accepted（回溯记录，2026-11-12）

ZCode 服务端在旧协议（legacy）之外提供了一代新的会话协议面（v4）：订阅推送、快照、回合相位、子代理与后台工作都在这一代暴露。本项目决定新功能与新代码路径一律走 v4，legacy 只保留为旧版服务端的回退通道，不再扩展。原因是 v4 的事件流让界面可以做实时归约，而 legacy 只能靠 resume/轮询驱动，延迟与竞态不可控；官方后续能力也都只在新代提供。

**Consequences**

- 需要自建帧归约与订阅管理（见 ADR-0002），并同时维护两代适配层。
- legacy 回退路径仍需保证可用，但不能成为新功能的实现位置。

**References**

- `docs/internal/design-research/主会话v4化映射路线定案-2026-09-24.md`
- `docs/internal/design-research/主会话v4帧模型对照表-2026-09-24.md`
- `docs/internal/plans-milestones/规划-v4协议面全盘改造-2026-09-24.md`