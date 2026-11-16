# worktree 托管根复用桌面约定

**Status**: accepted（2026-11-13）

## Context

CLI（app-server）没有 worktree 生命周期 RPC，创建/删除/列表是客户端宿主职责（见 `docs/internal/design-research/worktree功能调研-2026-11-12.md`）。但 CLI 内建「托管 worktree → 源工作区」映射，记忆目录、hooks 信任、`projectDirectory` 都依赖它；该映射只认 `<dataBaseDir>/.zcode/worktrees/<4位hex桶>/<仓库名>` 结构，靠 worktree 的 `.git` 指针文件反解主仓。主 app-server 不注入 `ZCODE_DATA_BASE_DIR`（ADR-0011），映射根 = 用户主目录，与桌面端实际创建位置一致（本机实测 `~/.zcode/worktrees/d8b0/suiteng-ai-agent`）。

## Decision

插件自建 worktree 完全复用桌面约定：同根、同桶结构（4 位 hex 随机桶，冲突重试）、同命名（仓库目录名）。不做插件私有根。

## Consequences

- 插件建的 worktree 自动获得记忆/hooks 共享，零同步代码。
- 桌面端 Worktrees 弹窗可见插件建的 worktree（显示「无任务」，tasks-index 无行）。
- 桌面端删除守卫感知不到插件的运行中会话，跨端互删风险被接受（删除后会话变只读，聊天记录保留）；插件侧删除前自查运行状态。
- 桶/命名规则与桌面端演进绑定，桌面若改约定需跟进。

## Considered Options

- 插件私有根（如 `~/.zcode/cli/worktrees-plugin/`）：路径隔离干净，但失去 CLI 映射（记忆分叉）与桌面互认，否决。

## References

- `docs/internal/design-research/worktree功能调研-2026-11-12.md`
- ADR-0011（数据根重定向边界：主 app-server 保持 home 数据根）
