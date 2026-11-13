# IDE 编译下限钉在 2023.3

**Status**: accepted（回溯记录，2026-11-12）

插件以 IntelliJ Platform 2023.3（sinceBuild 233）为编译下限，不直接使用 2024.1 及以后才有的 API；确实需要时用反射或按版本门控（`RdEnvironment` 的 AppMode 反射是实例）。替代方案是跟随最新平台或维护双模块：前者牺牲用户覆盖，后者维护成本不划算。

**Considered Options**

- 跟随最新平台：放弃仍停留在 2023.3 的用户群。
- 维护新旧双模块：每项功能写两遍，成本不可接受。

**Consequences**

- 新增功能的评审要检查是否引入 2024.1+ 独有 API，不能"先用了再说"。
- 反射调用要连 getter 一起反射（签名含平台内部类型同样会被 verifier 检查）；平台对象要通过字段取实例，不能字面构造 Key。
- 平台行为差异（远程开发、主题变更、对话框模态）要按版本实测，不能只按当前 IDE 版本推断。

**References**

- `AGENTS.md`（模块与分层）
- `build.gradle.kts`
- `docs/internal/bugs-regressions/`（verifier internal API、DialogWrapper 相关缺陷记录）