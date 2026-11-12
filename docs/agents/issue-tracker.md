# Issue tracker: GitHub

本仓库的 issue 与 spec 都落在 GitHub Issues（`csuftt/zcode-jetbrains-plugin`），统一用 `gh` CLI 操作（Git Bash 下已在 PATH；不在 PATH 时用 `"/c/Program Files/GitHub CLI/gh.exe"`）。

## 常用操作

- **建 issue**：`gh issue create --title "..." --body "..."`；多行 body 用 heredoc。
- **读 issue**：`gh issue view <number> --json number,title,body,labels,comments`。
- **列 issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，配合 `--label` / `--state` 过滤。
- **子 issue**：`gh issue create --parent <parent> ...`，或事后 `gh issue edit <parent> --add-sub-issue <child>`（gh 2.94+）。旧版：`gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`（数据库 id）。不支持子 issue 时，在子 issue body 顶部写 `Part of #<parent>`。
- **阻塞关系**：GitHub 原生 issue dependencies，是权威且 UI 可见的表示。`gh issue create --blocked-by <n>,<n> ...` 或 `gh issue edit <child> --add-blocked-by <blocker>`（gh 2.94+）。旧版：`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`，其中 `<blocker-db-id>` 是阻塞者的数字**数据库 id**（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`，不是 `#number`，也不是 `node_id`）。原生依赖不可用时退化为 child body 顶部 `Blocked by: #<n>, #<n>`；阻塞者全部关闭即解除。
- **统计未关闭阻塞者**：`gh api repos/<owner>/<repo>/issues/<n> --jq .issue_dependencies_summary.blocked_by`（只算 open；0=可开工）。`gh issue view <n> --json blockedBy` 会含已关闭项，需过滤：`--jq '[.blockedBy.nodes[] | select(.state == "OPEN")] | length'`。
- **评论**：`gh issue comment <number> --body "..."`。
- **加/去标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`。
- **关闭**：先 `gh issue comment <number> --body "..."` 再 `gh issue close <number>`。已关闭的 issue 上 `gh issue close --comment` 会丢评论但仍退出 0。

仓库由 `git remote -v` 推断，在 clone 内 gh 自动识别。首次 `gh issue create` 前用 `gh repo view --json nameWithOwner` 核对目标不是上游父仓库。

## 本项目约定：公开 / 内部边界

- **GitHub issue 只放公开面内容**：用户可见的 bug、功能请求、公开适配问题。正文里不写 `zcode.cjs` 逆向细节、抓包帧、凭证形态等敏感事实。
- **内部勘察与协议逆向**留在 `docs/internal/`（独立私有仓库 `csuftt/zcode-plugin-internal`，主仓库 .gitignore 排除），不进 GitHub，也不进 triage 队列。
- 需要时可在 issue/ADR 里写一条指针（如"内部细节见 `docs/internal/design-research/xxx.md`"）；本机 agent 能读，公开读者拿不到细节，这是有意的。

## Pull requests as a triage surface

**PRs as a request surface: no.** _（若要把外部 PR 纳入 `/triage`，把此处置为 `yes`；本项目历史上收过外部 PR #39/#43/#44。）_

置为 `yes` 后，PR 走与 issue 相同的标签与状态机，命令换成 `gh pr` 对应版本：

- **读 PR**：`gh pr view <number>`，再看 `gh pr view <number> --comments`（非 TTY 下 `--comments` 只打评论不打正文），diff 用 `gh pr diff <number>`。
- **列外部 PR**：`gh api --paginate 'repos/{owner}/{repo}/pulls?state=open' --jq '.[] | select(.author_association | IN("OWNER","MEMBER","COLLABORATOR") | not) | {number, title, author: .user.login, author_association, labels: [.labels[].name]}'`。
- **评论 / 标签 / 关闭**：`gh pr comment`、`gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub 的 issue 与 PR 共用一个编号空间，裸 `#42` 可能两者之一：先 `gh pr view 42`，失败再 `gh issue view 42`。

## 当 skill 说"publish to the issue tracker"

新建一个 GitHub issue。

## 当 skill 说"fetch the relevant ticket"

按上面的 **读 issue** 读取。

## Wayfinding operations（`/wayfinder` 使用）

**map** 是一个 issue，**child ticket** 是其子 issue。

- **Map**：带 `wayfinder:map` 标签的 issue，正文含 Notes / Decisions-so-far / Fog。`gh issue create --label wayfinder:map`。
- **Child ticket**：以 GitHub sub-issue 挂到 map（见上）；不支持子 issue 时，把 child 加进 map 正文的 task list 并写 `Part of #<map>`。标签 `wayfinder:<type>`（`research`/`prototype`/`grilling`/`task`）。被认领后 assign 给执行的开发者。
- **阻塞**：见上面 **阻塞关系**。
- **Frontier 查询**：列出 map 下所有 open child，剔除有 open 阻塞者或已有 assignee 的，按 map 顺序取第一个。
- **认领**：`gh issue edit <n> --add-assignee @me`，作为本次会话的第一次写操作。
- **结案**：`gh issue comment <n> --body "<answer>"` → `gh issue close <n>` → 在 map 的 Decisions-so-far 追加一条"要点 + 链接"。