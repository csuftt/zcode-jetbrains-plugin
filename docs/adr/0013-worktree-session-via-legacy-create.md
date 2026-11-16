# worktree 会话经 legacy session/create 落位

**Status**: accepted（2026-11-13）

## Context

只有 v4 `createSession` 命令接受 `cwd` + `worktreeCreation`（后者仅产生「已创建 worktree」装饰性时间线行）；legacy `session/create` 的 schema 没有这两个字段，但 `workspacePath` 传 worktree 路径即可落位（会话 directory=worktree 路径）。记忆共享与 resume 换根依赖托管根路径映射（ADR-0012），不依赖任何元数据。插件现有建会话链路为 legacy 通道。

## Decision

0.4.6 的 worktree 会话走 legacy `session/create`（`workspacePath` = worktree 路径），不新增 v4 建会话命令通道。展示所需的元数据（源工作区、起点、桶、创建时间）由插件侧 worktree 注册表（project 级 kv，同 `ZCodeLinkedWorkspaces` 模式）承载。

## Consequences

- 会话内没有官方「已创建 worktree」时间线行，信息由目录 chip 与注册表补齐。
- 将来整体迁移 v4 建会话时可顺带补 `worktreeCreation`，届时注册表降级为兼容承接。
- 桌面端建的 worktree 会话仍按既有承接路径进列表（tasks-index `worktree_root` 行 + `sessionIds` 拉详情），与注册表合并。

## Considered Options

- 新开 v4 `createSession` 命令通道：为装饰性元数据引入 commandId/admission/firstInput 一整套复杂度，且与现有建会话链路分叉，否决。

## References

- `docs/internal/design-research/worktree功能调研-2026-11-12.md`（协议面盘点）
- ADR-0012（托管根约定）
