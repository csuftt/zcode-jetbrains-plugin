# 发版流程（维护者）

- Marketplace：pluginId=33622（ZC-GUI），xmlId=`com.zcode.ideaplugin.zcode-assistant`；签名密钥在 `~/.zcode/plugin-signing/`，完整流程走 jetbrains-marketplace-publish skill（默认不本地跑 verifier，上传后以平台自动校验为准）

## 版本分支管理

- master = 稳定发布线；每个版本一条 `feature/<版本号>` 分支（如 feature/0.2.1、feature/0.2.2），开发提交都在分支上。
- 发版时把 `feature/x.y.z` 合并回 master 并打 tag `vx.y.z`；发版后从 master 切下一条 `feature/x.y.z+1`。
- 分支推 origin；feature/0.2.1 是 0.2.1 发布快照（不再动）。

## 发版标准流程（x.y.z）

1. **收尾改动**（在 feature/x.y.z 分支）：
   - 升版本号三处同步：`intellij-plugin/build.gradle.kts` 的 `version`、`webview/package.json`、`McpToolsClient.kt` 的 `CLIENT_VERSION`（webview 的 `APP_VERSION` 自 0.2.3 起由 `npm prebuild` 从 build.gradle.kts 自动生成 `src/version/version.ts`，同时生成版本更新弹窗数据 `src/version/changelog.ts`——后者提交仓库，前者 gitignore）。
   - `CHANGELOG.md` 顶部加 `[x.y.z] - 日期` 块（patchPluginXml 提取为 change-notes；只写用户可感知的改动，README/工作流调整类杂务不放）。
   - 测试全过：`./gradlew test` + `cd webview && npm test`（tsc 在 build 时跑）。
2. **构建签名**（必须照 jetbrains-marketplace-publish skill 坑 1b，否则会静默产出未签名包）：
   ```bash
   ./gradlew --stop            # daemon 缓存旧环境变量，先停
   export CERTIFICATE_CHAIN="$(cat ~/.zcode/plugin-signing/chain.crt)"
   export PRIVATE_KEY="$(cat ~/.zcode/plugin-signing/private.pem)"
   export PRIVATE_KEY_PASSWORD=""
   ./build.sh
   ./gradlew :intellij-plugin:signPlugin --rerun-tasks   # 绕开不含环境变量的 build cache
   # verify（zip extra field 机制，别找 .RSA/.SF；别接 grep 看退出码）：
   java -cp intellij-plugin/build/tools/marketplace-zip-signer-cli.jar \
     org.jetbrains.zip.signer.ZipSigningTool verify \
     -in intellij-plugin/build/distributions/ZC-GUI-<版本>-signed.zip \
     -cert ~/.zcode/plugin-signing/chain.crt   # 期望无输出 exit=0
   ```
3. **本机实测**：IDE 磁盘安装 signed.zip，跑通本次改动主路径后才继续。
4. **提交合并**：分支提交（git-commit-format skill）→ 合并回 master → `git push origin master feature/x.y.z`。**构建签名后、push 前必须再 `git status` 检查一次**：prebuild 生成的 `webview/src/version/changelog.ts`（入库产物）落在升版本提交之后的工作区，不补提交会让 master/tag 滞后一个版本块（0.2.4 实踩）。
5. **GitHub release**（csuftt/zcode-jetbrains-plugin，gh 全路径 `"/c/Program Files/GitHub CLI/gh.exe"`）：
   - `git tag vx.y.z <合并提交>` + push tag；
   - `gh release create` 或覆盖旧版（移 tag / `delete-asset`+`upload` / `edit --notes-file`）；notes 写 CHANGELOG 块 + 附件说明，**用 `--notes-file` 别用 `--body`**。
   - notes 结尾固定格式（勿漏，0.4.1 实踩）：`---` 分隔线后接双语附件安装说明（中文段 + `English:` 段），再 `---` + 署名两句：
     ```markdown
     本版本由 @csuftt 发布维护，问题与建议欢迎到 [GitHub Issues](https://github.com/csuftt/zcode-jetbrains-plugin/issues) 反馈。
     Released and maintained by @csuftt — feel free to report issues or suggestions at [GitHub Issues](https://github.com/csuftt/zcode-jetbrains-plugin/issues).
     ```
6. **Marketplace**（pluginId=33622）：
   ```bash
   curl -sS -w "\nHTTP %{http_code}\n" -X POST https://plugins.jetbrains.com/api/updates/upload \
     -H "Authorization: Bearer $MARKETPLACE_TOKEN" \
     -F "pluginId=33622" \
     -F "file=@intellij-plugin/build/distributions/ZC-GUI-<版本>-signed.zip"
   ```
   期望 HTTP 201；返回 `approve:false` = 待审核（≤2 工作日），verifier 平台自动跑。**环境变量里的 MARKETPLACE_TOKEN 可能是失效旧 token（403 Invalid token 时向用户要新 token，不入库不落盘）**。changeNotes 由 build.gradle.kts 从 CHANGELOG 最新块提取**中英双语并列**（中文段 + `<h3>English</h3>` + 英文段；Marketplace 该字段单语无语言切换）。
7. **覆盖发版（例外操作，如 0.2.3 改 notes 重传）**：Marketplace 可用 API 直接删旧版本 `curl -X DELETE https://plugins.jetbrains.com/api/updates/<id> -H "Authorization: Bearer $MARKETPLACE_TOKEN"`（HTTP 200 即删，无需网页；PATCH/PUT 直改 notes 均 405 不支持）→ 重新构建签名 → API 重传同号（重新排队审核，id 会变）；GitHub release 移 tag（force push）+ 换 asset + 改 notes 注明重发。默认走升版本，覆盖需用户明确要求。
