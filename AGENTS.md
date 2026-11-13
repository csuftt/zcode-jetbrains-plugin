# 项目记忆

<!-- 项目级记忆（AGENTS.md）：当前项目的 ZCode 会话自动读取 -->

## 项目定位

ZCode（Z.ai/GLM）编码助手的 JetBrains 插件：以子进程方式启动 `zcode.cjs app-server`，经 stdio JSON-RPC 驱动会话；UI 跑在 JCEF webview（React 19）里，插件同时充当 browser-use 宿主（反向协议 `interaction/browserList` / `browserExecute`），AI 的浏览器工具落到内嵌 JCEF 浏览器执行。

## 模块与分层

- `protocol-client/`：纯 Kotlin JSON-RPC 客户端，无 IntelliJ 依赖，可独立测试；协议结构在 `protocol/model/`。
- `intellij-plugin/`：插件本体（`ZCodeService` 生命周期、`ui/` 下 ToolWindow / JCEF 桥 / browser-use 宿主 / 技能·MCP·记忆扫描器、`env/` 环境自检）。JDK 17，Kotlin 1.9.24，IntelliJ Platform 2023.3（IC），sinceBuild 233 / untilBuild 263.*。编译下限=2023.3，新功能不得直接使用 2024.1+ 独有 API（要用须反射或按版本门控，如 `RdEnvironment` 的 AppMode 反射）。
- `webview/`：React 19 + TS + Vite + zustand + less。`src/ipc/bridge.ts` 为 JS 桥、`src/store/useStore.ts` 全局状态、`src/utils/streamReducer.ts` 事件归约。事件流按会话分发、16ms 节流批量推入 JCEF。
- `docs/`：`internal/`（design-research / bugs-regressions / plans-milestones）为过程文档，**自身是独立 git 仓库**（私有 remote `csuftt/zcode-plugin-internal`，主仓库 .gitignore 排除——含 zcode.cjs 逆向细节，绝不并入公开主仓库；`probe/` 下凭证与抓包帧在该仓库内亦 gitignore）；`screenshots/` 为 README 配图。
- `scripts/`：Python 直连 app-server 的协议诊断脚本（diag-*.py），排查协议问题优先复用。
- Maven 仓库走国内镜像（阿里云/腾讯云，settings 与子模块 build 脚本里显式配置）。

## 构建与测试

```bash
./build.sh                 # 一键清理+重建：webview 双产物 → buildPlugin，产物 ZC-GUI-<版本>.zip
./build.sh --skip-clean    # 增量构建
./gradlew :intellij-plugin:runIde      # 沙箱 IDE 体验
./gradlew test                         # Kotlin 测试（JUnit5）
cd webview && npm run dev             # webview 独立开发（自动 mock 数据源）
cd webview && npm test                # webview 测试（vitest，test/ 与 *.test.ts）
```

## 关键坑

- webview 产物（`intellij-plugin/src/main/resources/webview`、`webview-single`）不入库（.gitignore）。**单独跑 `buildPlugin` 会打出只含兜底 HTML 的 zip**——必须先 `npm run build` + `npm run build:single`（或直接 `./build.sh`）。
- 生产模式用内置 HttpServer（127.0.0.1 随机端口）serve 多文件产物（sourcemap 可用），启动失败自动降级 singlefile 单文件加载。
- 改协议交互前先看 `docs/internal/design-research/`（含负结论文档，避免重蹈）；缺陷修复要在 `docs/internal/bugs-regressions/` 落记录。
- 插件技能/MCP 发现：启用权威是 `~/.zcode/cli/config.json` 的 `plugins.enabledPlugins`（`enabledPlugins[id] ?? 默认启用`；`plugins/data/` 目录只是曾初始化残留，禁用不删，别当判据）；技能集合按插件清单 `skills` 声明（`.zcode-plugin → .claude-plugin → .codex-plugin`，字符串=技能根直下两层、数组=逐个技能目录，不递归更深）。统一走 `SlashCommandScanner.enabledPluginVersionDirs()` / `pluginSkillDirs()`，勿另写扫描面。

## 发版流程

版本分支管理与完整发版流程（升版本三处、构建签名、GitHub release、Marketplace 上传与覆盖发版）见 [`docs/release-process.md`](docs/release-process.md)，发版时先读。

## Agent skills

### Issue tracker

公开 issue/spec 落在 GitHub Issues（`csuftt/zcode-jetbrains-plugin`）；协议逆向等内部内容留 `docs/internal/` 私有仓库。详见 `docs/agents/issue-tracker.md`。

### Triage labels

沿用五个规范 triage 角色同名字符串（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`）。详见 `docs/agents/triage-labels.md`。

### Domain docs

单 context 布局：根目录 `GLOSSARY.md` + `docs/adr/`。详见 `docs/agents/domain.md`。

## 外部参考

- CCGUI 参考项目（GitHub）：https://github.com/zhukunpenglinyutong/jetbrains-cc-gui （本项目 UI/设置页参考项目 jetbrains-cc-gui，探索其实现直接读 GitHub 源码；本机副本路径见工作区记忆）

