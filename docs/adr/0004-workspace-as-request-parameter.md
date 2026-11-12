# 工作区是每次请求的参数，不是进程级绑定

**Status**: accepted（回溯记录，2026-11-12）

会话的工作区（workspacePath）作为每次请求的参数传递，而不是进程级绑定。因此一个 app-server 进程可以服务多个工作区，同一个会话也能在不同目录之间切换。两个替代方案都被否决：每个目录起一个 app-server 进程成本过高，把会话强行绑到 IDE 项目根则会污染用户项目。

**Considered Options**

- 每目录一个 app-server 进程：进程与会话数量线性增长，成本不可接受。
- 会话绑死 IDE 项目根：无法访问项目外目录，且会让写操作落在用户不想改的项目里。

**Consequences**

- 界面上的路径锚点必须用会话当前工作区，而不是 IDE 项目根；用错会表现为卡片不显示、明细打不开且无日志。
- 注入值与桥变量存在初始化竞态，初始化必须幂等；环境依赖值要有按需拉取的权威兜底。
- 会话列表、记忆、技能与归档都按激活工作区切换。

**References**

- `docs/internal/design-research/multi-workspace-variant-a-design.md`
- `docs/internal/design-research/多工作区目录挂载ProjectView调研-2026-10-28.md`
- `docs/internal/bugs-regressions/`（工作区注入竞态、路径锚点相关缺陷记录）