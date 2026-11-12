# Triage Labels

skills 使用五个规范 triage 角色；本文件把它们映射到本仓库 issue tracker 里实际使用的标签字符串。

| mattpocock/skills 中的标签 | 本仓库使用的标签 | 含义 |
| -------------------------- | ---------------- | ---- |
| `needs-triage`             | `needs-triage`   | 维护者需要评估 |
| `needs-info`               | `needs-info`     | 等待报告者补充信息 |
| `ready-for-agent`          | `ready-for-agent` | 规格完整，可由 AFK agent 直接实施 |
| `ready-for-human`          | `ready-for-human` | 需要人工实施 |
| `wontfix`                  | `wontfix`        | 不予处理 |

skill 提到某个角色时（如"打上 AFK-ready 标签"），使用本表右侧对应的标签字符串。

分类角色仍沿用 GitHub 默认标签：`bug`（坏了）/ `enhancement`（新功能或改进）。每个完成 triage 的 issue 应恰好带一个分类角色和一个状态角色；状态冲突时先与维护者确认再动。