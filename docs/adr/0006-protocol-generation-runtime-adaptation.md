# 协议代际按运行时自适应，不锁 CLI 版本号

**Status**: accepted（回溯记录，2026-11-12）

插件不按 CLI 版本号判断协议代际，而是在运行时探测能力、按错误码自适应（例如 v4 方法不可用时回退 legacy）。原因是官方协议迁移不 bump 版本号：同一个 npm 版本可能横跨多个桌面端代际，按版本号判代已被实测证伪。

**Considered Options**

- 锁死支持的 CLI 版本区间：用户一升级就不可用，且版本号本身不可信。
- 只按版本号门控新字段：会把同一版本号下的多代行为混为一谈。

**Consequences**

- 新参数、新字段要按代际门控；老服务端以 strict schema 拒收未知键时，不能让整条请求失败。
- 需要保留一份可回归的旧版基线做兼容验证。
- 版本探测本身要轻量，不能拖慢启动。

**References**

- `docs/internal/design-research/新CLI版本判别与双代适配-2026-09-17.md`
- `docs/internal/plans-milestones/3.17.2降级兼容测试基线-2026-11-12.md`
- `docs/internal/bugs-regressions/`（3.18.0 适配、strict schema 相关缺陷记录）