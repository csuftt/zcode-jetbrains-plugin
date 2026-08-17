# ZC GUI 插件图标

当前正式图标：`zcgui-window-soft.svg`——soft 布局 + A 配色（深空渐变底·白 Z 行渐隐）。

## 设计概念

| 元素 | 含义 | 实现细节 |
|---|---|---|
| 渐变底圆角方块 | 应用窗口底板 | 对角渐变 `#1E293B → #312E81`（深空蓝→靛），明暗主题通用 |
| 像素 Z | ZCode → ZC，数字化 | 18 列 × 13 行网格（30×42 长方格，块 26×36）；斜杠 6 块宽**每行左移 1 格**，左右边缘与上下斜缝严格平行直线；视觉斜率 30/42 ≈ 0.71 与原版 0.706 一致；白色按行渐隐（顶行 100% → 底行 50% 透明度）与渐变底融合出层次 |
| 顶杠三圆点 | 窗口控制按钮（标题栏） | 嵌在 Z 顶杠内，中心 (347/377/407, 260) r=10，色 `#262A55`（底色近似挖空） |
| 箭头光标 | GUI 交互隐喻：点击下杠 | 四点极简箭头，尖端 (690,704) 落在下杠顶边；白底 + `#262A55` 13px 描边圆角连接 |

## 文件清单

| 文件 | 用途 |
|---|---|
| `zcgui-window-soft.svg` | **正式图标源文件** |
| `gen-png.js` | PNG 生成脚本（需要时 `node gen-png.js`，Edge headless 透明渲染到 `png/`） |
| `Zai.svg` | 原版图标存档（平滑 Z） |

## 接入（已完成）

`zcgui-window-soft.svg` 已覆盖以下三处（md5 一致）：

- `intellij-plugin/src/main/resources/icons/zai.svg` —— ToolWindow / 菜单图标（`ZCodeIcons.Zai` 代码引用不变）
- `intellij-plugin/src/main/resources/META-INF/pluginIcon.svg` —— 插件 Logo（亮色主题）
- `intellij-plugin/src/main/resources/META-INF/pluginIcon_dark.svg` —— 插件 Logo（深色主题，与亮色同源）

换图标：改 `zcgui-window-soft.svg` 后覆盖以上三个文件并重新构建。Marketplace 上传图需要时 `node gen-png.js` 生成 `png/zcgui-window-soft_640.png`。

## 小尺寸说明

16px 下渐变/渐隐/圆点/光标细节自然消失，剩余"深色圆角块 + 白色 Z"剪影可辨；32~48px 光标渐现；128px+ 全部细节呈现。曾试验 9×7 低密度大块版（zcgui-icon，39 块），小尺寸更清晰但整体观感不及本版，已弃用。

## 修改指引

像素块坐标：`x = 244 + 30×列`、`y = 242 + 42×行`，块 26×36，白色按行 `fill-opacity = 1 - 行/24`；光标路径 `M690 704 L782 484 L814 580 L885 612 Z`。
