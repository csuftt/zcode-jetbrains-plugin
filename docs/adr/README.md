# ADR 索引

本目录记录公开面的架构决策。0001–0010 是 2026-11-12 一次性补齐的**回溯 ADR**，记录项目前几个月已经落地的决策；正文已按公开仓库边界脱敏，细节通过 References 指向内部仓库。

## 决策清单

| 编号 | 决策 | 状态 |
| --- | --- | --- |
| [0001](0001-v4-subscription-protocol.md) | 全面迁移到 v4 订阅协议 | accepted（回溯） |
| [0002](0002-subscription-permanent-slots.md) | 会话订阅常驻不退订，槽位直到进程重启 | accepted（回溯） |
| [0003](0003-jcef-browser-use-host.md) | 浏览器工具以内嵌 JCEF 为执行宿主 | accepted（回溯） |
| [0004](0004-workspace-as-request-parameter.md) | 工作区是每次请求的参数，不是进程级绑定 | accepted（回溯） |
| [0005](0005-webview-dual-output-httpserver-fallback.md) | webview 双产物：HttpServer 优先，单文件降级 | accepted（回溯） |
| [0006](0006-protocol-generation-runtime-adaptation.md) | 协议代际按运行时自适应，不锁 CLI 版本号 | accepted（回溯） |
| [0007](0007-builtin-channel-selectedkey-pat-renewal.md) | 内置渠道以 selectedKey 为激活权威，凭证靠 PAT 换发 | accepted（回溯） |
| [0008](0008-direct-read-write-tasks-index.md) | 直接读写官方 tasks-index.sqlite 承载置顶与归档 | accepted（回溯） |
| [0009](0009-public-internal-repo-boundary.md) | 公开主仓库与内部过程仓库的硬边界 | accepted（回溯） |
| [0010](0010-idea-platform-2023-3-floor.md) | IDE 编译下限钉在 2023.3 | accepted（回溯） |

## 功能 → 决策 → 记录

| 功能 | 首发版本 | 相关 ADR | 内部记录 |
| --- | --- | --- | --- |
| v4 订阅与实时同步 | 0.3.7 起分面接入，0.3.9–0.4.x 全量 | 0001, 0002 | `design-research/主会话v4化映射路线定案-2026-09-24.md` |
| 内嵌浏览器 / browser-use 宿主 | 0.2.x | 0003 | `design-research/browser-use宿主协议接入设计.md` |
| 多工作区 / 关联目录 | 0.4.2（手机远程侧 0.4.3） | 0004 | `design-research/multi-workspace-variant-a-design.md` |
| 产物卡与更改明细 | 0.4.0 | 0004 | `bugs-regressions/`（路径锚点相关缺陷） |
| 会话置顶 | 0.3.9 | 0008 | — |
| 历史归档与自动归档 | 0.3.4 | 0008 | `bugs-regressions/`（自动归档误归档） |
| 账号内置渠道直连 | 0.3.9 | 0007 | `design-research/v1内置渠道迁移标记移除决策-2026-09-18.md` |
| 协议代际适配（含 3.18.0） | 全程；3.18.0 适配在 0.4.5-beta.1 | 0006, 0007 | `design-research/新CLI版本判别与双代适配-2026-09-17.md` |
| 内联可视化卡片 | 0.4.2 | — | `design-research/内联可视化visualize卡片兼容实现-2026-10-27.md` |
| 浏览器独立窗口 | 0.4.1 | 0003 | `design-research/浏览器弹窗独立窗口调研-2026-10-16.md` |
| 手机远程会话 | 0.3.9 | 0004 | `design-research/手机远程会话复用调研-2026-08.md` |
| 轻任务模型 | 0.4.4-beta.1 | — | issue #48 |

内部记录的根目录是 `docs/internal/`（独立私有仓库，主仓库不跟踪）。

## 维护约定

- 新 ADR 按 `docs/adr/` 里最大编号加一，文件名 `NNNN-短横线-slug.md`。
- 只有同时满足"难回退 + 后来者会疑惑 + 真有取舍"三个条件才值得写 ADR；容易回退的决策不写。
- 决策被推翻时不要删除旧 ADR：把 Status 改为 `superseded by ADR-NNNN`，新 ADR 里说明重开原因。
- ADR 正文不写具体文件路径与代码片段，也绝不搬运内部仓库的敏感细节；指向内部文档只写 References。