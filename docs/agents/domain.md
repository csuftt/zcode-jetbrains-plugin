# Domain Docs

工程类 skill 在探索代码库前，按本文件消费本仓库的领域文档。

## 探索前先读

- 仓库根目录的 **`GLOSSARY.md`**（单 context 布局，本仓库即此情形）。
- **`docs/adr/`**：读与本次改动区域相关的 ADR。
- 若存在 **`GLOSSARY-MAP.md`**，则为多 context 布局：按 map 找到相关 context 的 `GLOSSARY.md` 逐个读取。本仓库当前不需要。

任何一项不存在时**静默跳过**：不要提示缺失，也不要主动建议创建。`/domain-modeling`（经 `/grill-with-docs`、`/improve-codebase-architecture` 触达）会在概念或决策真正落地时按需创建。

## 文件结构（单 context）

```
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-....md
│   └── 0002-....md
├── protocol-client/
├── intellij-plugin/
└── webview/
```

## 用 glossary 的词汇

在 issue 标题、重构提案、假设、测试名里命名领域概念时，使用 `GLOSSARY.md` 定义过的词，不要漂移到 `_Avoid_` 列出的同义词。

若需要的概念不在表里：要么是你在发明项目不用的语言（重新考虑），要么是真实缺口（记下来交给 `/domain-modeling`）。

## ADR 冲突要显式指出

输出与既有 ADR 矛盾时，明确说明而不是静默覆盖：

> _与 ADR-0007（……）矛盾，但值得重开，因为……_

## 本仓库补充：内部过程文档

`docs/internal/` 是独立私有仓库（`csuftt/zcode-plugin-internal`），存放协议逆向、设计调研与缺陷回归记录。它与 GLOSSARY/ADR 分工如下：

- `GLOSSARY.md`：稳定的领域词汇。
- `docs/adr/`：不可逆、且公开后无敏感的架构决策（本仓库的公开决策面）。
- `docs/internal/design-research/`：调研过程、负结论、协议细节；ADR 的 References 指向这里，但正文不搬运敏感内容。