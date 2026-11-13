# webview 双产物：HttpServer 优先，单文件降级

**Status**: accepted（回溯记录，2026-11-12）

前端同时构建多文件与单文件两份产物。生产模式优先用内置 HttpServer（127.0.0.1 随机端口）serve 多文件产物，保留 sourcemap 与多文件调试能力；HttpServer 启动失败时自动降级为单文件加载。只做单文件会牺牲排查能力，只做 HttpServer 则端口失败时界面直接打不开。

**Consequences**

- 构建必须先产出两份前端产物再打插件包，否则 zip 里只有兜底 HTML；这条已写进构建纪律。
- 两种模式的资源路径与加载方式不同，新增静态资源要在两种模式下都验证。
- 单文件路径是兜底路径，功能不能只在多文件模式下成立。

**References**

- `AGENTS.md`（构建与关键坑）
- `build.sh`