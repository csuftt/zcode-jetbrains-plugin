# 项目记忆

<!-- 项目级记忆（AGENTS.md）：当前项目的 ZCode 会话自动读取 -->

## 项目定位

ZCode（Z.ai/GLM）编码助手的 JetBrains IDEA 插件：以子进程方式启动 `zcode.cjs app-server`，经 stdio JSON-RPC 驱动会话；UI 跑在 JCEF webview（React 19）里，插件同时充当 browser-use 宿主（反向协议 `interaction/browserList` / `browserExecute`），AI 的浏览器工具落到内嵌 JCEF 浏览器执行。

## 模块与分层

- `protocol-client/`：纯 Kotlin JSON-RPC 客户端，无 IntelliJ 依赖，可独立测试；协议结构在 `protocol/model/`。
- `intellij-plugin/`：插件本体（`ZCodeService` 生命周期、`ui/` 下 ToolWindow / JCEF 桥 / browser-use 宿主 / 技能·MCP·记忆扫描器、`env/` 环境自检）。JDK 17，Kotlin 1.9.24，IntelliJ Platform 2024.1（IC），sinceBuild 241 / untilBuild 261.*。
- `webview/`：React 19 + TS + Vite + zustand + less。`src/ipc/bridge.ts` 为 JS 桥、`src/store/useStore.ts` 全局状态、`src/utils/streamReducer.ts` 事件归约。事件流按会话分发、16ms 节流批量推入 JCEF。
- `docs/`：设计与调研 / 缺陷与回归 / 计划与里程碑（长期文档见 `docs/README.md` 索引）。
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
- 改协议交互前先看 `docs/设计与调研/`（含负结论文档，避免重蹈）；缺陷修复要在 `docs/缺陷与回归/` 落记录。

## 外部参考

- CCGUI 源码本地位置：`G:\0-github开源\jetbrains-cc-gui-main`（本项目 UI/设置页参考项目 jetbrains-cc-gui 的本地副本，探索其实现直接读该目录，不要再联网找）

