# 内置渠道以 selectedKey 为激活权威，凭证靠 PAT 换发

**Status**: accepted（回溯记录，2026-11-12）

账号订阅提供的内置渠道是否激活，只看 selectedKey（剥掉前缀、但不切冒号），不以外层渠道配置是否存在为判据；渠道可用性靠 PAT 换发链维持——以绝对过期时间为锚点，在到期前的窗口内换发。静态 api-key 必须被换发链替换（否则请求必被拒），而"渠道配置还在"经常只是误导性的表象。

**Considered Options**

- 以渠道配置存在为可用判据：会出现渠道"还在"却不可用的误导状态。
- 继续使用静态 api-key：请求必被服务端拒绝。

**Consequences**

- 换发链的网络异常必须在链内消化（合成响应 + 用户可读文案），不能裸抛成 IDE 红错。
- 渠道展示跟随 selection 语义；未选中的内置渠道不应出现在可用模型列表里。
- 凭证格式换代（如加密版本升级）只影响读取层，激活判据不变。

**References**

- `docs/internal/design-research/v1内置渠道迁移标记移除决策-2026-09-18.md`
- `docs/internal/design-research/2026-08-27-apikey-usage-and-env-injection.md`
- `docs/internal/bugs-regressions/`（内置渠道消失、凭证加密换代相关缺陷记录）