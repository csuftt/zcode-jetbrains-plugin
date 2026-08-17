#!/usr/bin/env bash
# ============================================================
# ZCode IDEA 插件 —— 一键清理 + 重建
#
# 用法（Git Bash / 任意终端）：
#   ./build.sh               # 完整清理 + 重建
#   ./build.sh --skip-clean  # 跳过清理，仅增量构建
#
# 流程：
#   1. 清理：gradlew clean + webview 的 tsc 增量缓存 / dist / 旧产物
#   2. 构建：webview 双产物——npm run build（多文件 + sourcemap，内置 server 加载）
#      + build:single（单文件 fallback）→ Gradle buildPlugin
#   3. 验证：输出发行包路径与大小
#
# 产物：intellij-plugin/build/distributions/ZC-GUI-<版本>.zip（IDE 内离线安装）
# 沙箱体验：./gradlew :intellij-plugin:runIde
# ============================================================
set -euo pipefail

# 切到仓库根（脚本可在任意目录调用）
cd "$(dirname "$0")"

SKIP_CLEAN=0
if [ "${1:-}" = "--skip-clean" ]; then
  SKIP_CLEAN=1
elif [ $# -gt 0 ]; then
  echo "未知参数: $1（仅支持 --skip-clean）" >&2
  exit 1
fi

step() { printf '\n\033[36m=== %s ===\033[0m\n' "$1"; }

if [ "$SKIP_CLEAN" -eq 1 ]; then
  step "跳过清理（--skip-clean）"
else
  step "清理 Gradle 构建目录"
  ./gradlew clean --console=plain -q

  step "清理 webview 缓存与旧产物"
  rm -f webview/tsconfig.tsbuildinfo
  rm -rf webview/dist
  # 旧产物（构建会重新生成；先删保证产物一定是全新构建的）
  rm -rf intellij-plugin/src/main/resources/webview
  rm -rf intellij-plugin/src/main/resources/webview-single
fi

step "构建 webview 多文件产物（tsc 类型检查 + vite build，含 sourcemap）"
(
  cd webview
  npm run build
)

step "构建 webview 单文件 fallback 产物（vite singlefile）"
(
  cd webview
  npm run build:single
)

step "构建插件发行包（Gradle buildPlugin）"
./gradlew :intellij-plugin:buildPlugin --console=plain

step "产物"
ZIP="$(ls intellij-plugin/build/distributions/ZC-GUI-*.zip 2>/dev/null | head -1 || true)"
if [ -z "$ZIP" ]; then
  echo "❌ 未找到发行包 ZC-GUI-*.zip" >&2
  exit 1
fi
ls -lh "$ZIP"
echo "✅ 构建完成：$ZIP"
