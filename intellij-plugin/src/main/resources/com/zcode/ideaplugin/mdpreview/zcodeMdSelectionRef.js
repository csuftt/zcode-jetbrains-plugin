// ZCode：Markdown 预览划选快照采集脚本。
// 经 markdown 插件官方 EP browserPreviewExtensionProvider 注入（随预览页面构建自动带上，
// 免疫增量 DOM 重渲染）。职责只有一个：把当前选区映射到 md 源码字符偏移并 post 给 IDE。
//
// 位置映射原理（JetBrains ScrollSync.js 同源机制）：
//   - meta[name="markdown-position-attribute-name"] 声明属性名（不硬编码，随版本跟随）；
//   - 预览 DOM 每个块元素带该属性，值为 "from..to"（对应 md 源文件的字符偏移区间）。
// 回传通道：window.__IntelliJTools.messagePipe（markdown 插件内置 BrowserPipe 的 JS 端），
// IDE 侧经 panel.browserPipe.subscribe 同名主题接收。
(function () {
  "use strict";
  if (window.__zcodeMdSelectionRef) { return; }
  window.__zcodeMdSelectionRef = true;

  var TOPIC = "zcodeMdSelection";

  function positionAttributeName() {
    var meta = document.querySelector('meta[name="markdown-position-attribute-name"]');
    return meta ? meta.content : null;
  }

  // 从选区端点沿祖先链找第一个带位置属性的元素，返回 {from, to}
  function offsetsFor(node) {
    var attr = positionAttributeName();
    if (!attr) { return null; }
    // 选区端点通常是 Text 节点（无 getAttribute），先上溯到最近的 Element 再找属性——
    // 首版把「无效节点保护」写成 while 条件，Text 节点首轮即退出，快照恒 null（真机 2026.1 实锤）
    while (node && node.nodeType === Node.TEXT_NODE) { node = node.parentNode; }
    while (node && node !== document.body) {
      if (node.getAttribute) {
        var value = node.getAttribute(attr);
        if (value) {
          var parts = value.split("..");
          if (parts.length === 2) { return { from: +parts[0], to: +parts[1] }; }
        }
      }
      node = node.parentNode;
    }
    return null;
  }

  // 无选区时返回 null（IDE 侧收到 null 即清快照，菜单随之隐藏）
  function currentSnapshot() {
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString()) { return null; }
    var anchor = offsetsFor(selection.anchorNode);
    var focus = offsetsFor(selection.focusNode);
    if (!anchor && !focus) { return null; }
    // 选区可跨块：两端取并集区间；一端无属性（如落在预览头部）退化用另一端
    var from = Math.min(anchor ? anchor.from : Infinity, focus ? focus.from : Infinity);
    var to = Math.max(anchor ? anchor.to : -Infinity, focus ? focus.to : -Infinity);
    if (!isFinite(from) || !isFinite(to) || to < from) { return null; }
    return { from: from, to: to };
  }

  function post() {
    var pipe = window.__IntelliJTools && window.__IntelliJTools.messagePipe;
    if (!pipe || typeof pipe.post !== "function") { return; }
    try { pipe.post(TOPIC, JSON.stringify(currentSnapshot())); } catch (e) { /* 管道未就绪时静默 */ }
  }

  // selectionchange 高频触发，150ms 节流合并；mouseup/keyup 兜底补发
  var timer = null;
  function schedule() {
    if (timer !== null) { return; }
    timer = window.setTimeout(function () { timer = null; post(); }, 150);
  }

  document.addEventListener("selectionchange", schedule);
  document.addEventListener("mouseup", schedule);
  document.addEventListener("keyup", schedule);
})();
