#!/usr/bin/env node
/**
 * 用 ZCode 官方（开源仓库）共享解析器生成「子代理 Markdown 解析」的黄金样本。
 *
 * 插件经 subagents/readRuntimeConfig 接管运行时的子代理配置来源后，
 * SubagentRuntimeConfig.kt 里的 Kotlin 解析器就是用户级/项目级定义的唯一解析方，
 * 必须与官方逐行为等价。本脚本直接跑官方 TS 实现，把输入与期望输出一起落成
 * intellij-plugin/src/test/resources/subagent-runtime-config/official-golden.json，
 * 由 SubagentRuntimeConfigGoldenTest 逐条回放比对。
 *
 * 用法（在仓库根目录执行）：
 *   node scripts/gen-subagent-profile-golden.mjs <ZCode 开源仓库根目录> --zod <zod 包目录>
 *     --zod    官方 model-selection.ts 依赖 zod；开源仓库本地没装依赖时指一份 zod 给它
 *              （2026-11 实测：feishu-mcp 全局包自带的 zod 3.25 可用，脚本自动取其 v4 入口）
 *   可选 --only-cases：只重写用例、不跑官方实现（期望输出保持原样），用于确认用例集没变。
 *
 * 依赖 webview/node_modules 里的 esbuild 把官方 TS 连同依赖打成单文件再执行。
 * ZCode 官方升级后重跑一次：期望输出有 diff = 官方解析器变了，Kotlin 移植要跟着改。
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const requireWebview = createRequire(join(dirname(fileURLToPath(import.meta.url)), "..", "webview", "package.json"));
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(REPO, "intellij-plugin", "src", "test", "resources", "subagent-runtime-config", "official-golden.json");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const sourceRoot = process.argv[2];
const zodDir = arg("zod");
const onlyCases = process.argv.includes("--only-cases");
if (!sourceRoot || !existsSync(join(sourceRoot, "packages", "shared", "src", "subagent-profile-parser.ts"))) {
  console.error("用法: node scripts/gen-subagent-profile-golden.mjs <ZCode 开源仓库根目录> --zod <zod 包目录>");
  process.exit(2);
}

// ============ 用例 ============

/** mulberry32：种子固定，随机用例可复现 */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const doc = (frontmatter, body = "Review carefully.") => `---\n${frontmatter}\n---\n${body}`;

function buildProfileCases() {
  const cases = [];
  /** @param {string} content @param {string} [source] @param {string} [path] @param {string} [note] */
  const add = (content, source = "user", path, note) => {
    cases.push({ ...(note ? { note } : {}), ...(path ? { path } : {}), source, content });
  };

  // ---- 官方 apps/zcode-cli/packages/core/tests/subagent-profile.test.ts 的解析用例 ----
  for (const value of ['{"providerId":"wrong","modelId":"wrong"}', "null", '{"modelId":"broken"}']) {
    add(doc(`name: reviewer\ndescription: Review changes\nmodelSelection: ${value}\nmodel: custom-openai/legacy\nthoughtLevel: high`, "Review carefully."), "user", undefined, "官方用例：中间字段不参与正式读取");
  }
  add(doc("name: reviewer\ndescription: Review changes\nmemory: project"), "project", undefined, "官方用例：精确 memory scope");
  add(doc('name: reviewer\ndescription: Review changes\nmemory: " project "'), "project", undefined, "官方用例：带空白的 memory");
  add(doc("name: reviewer\ndescription: Review changes\nmemory: project\ntools: []"), "project", undefined, "官方用例：显式空 tools");
  add(
    doc(
      [
        "name: zcode-reviewer",
        'description: 检查实现边界\\n输出中文结论',
        "model: custom-openai/reviewer-model",
        "thoughtLevel: high",
        "tools: Read, Grep Bash(ls -la)",
        "disallowedTools:",
        "  - Edit",
        "  - Write",
        "skills: code review",
        "color: cyan",
        "permissionMode: acceptEdits",
        'maxTurns: "7"',
        'background: "true"',
        'injectAgentsMd: "false"',
        "mcpServers:",
        "  - local-tools",
      ].join("\n"),
      "你是 zcode-reviewer。\n只输出中文。",
    ),
    "project",
    "/workspace/.zcode/agents/zcode-reviewer.md",
    "官方用例：P0 自定义字段全集",
  );
  add(doc("name: reviewer\ndescription: Use a concrete provider model\nmodel: custom-openai/gpt-5.4\nthoughtLevel: high"), "user", "/home/user/.zcode/agents/reviewer.md", "官方用例：provider/model");
  add(doc("name: reviewer-custom\ndescription: Use the UI custom model value\nmodel: custom:custom-openai:gpt-5.4"), "user", "/home/user/.zcode/agents/reviewer-custom.md", "官方用例：custom: 编码");
  for (const mcpServers of [
    "mcpServers: local-tools",
    "mcpServers:\n  local-tools:\n    type: stdio",
    "mcpServers: { local-tools: { type: stdio } }",
    "mcpServers: [{ type: stdio, command: local-mcp }]",
    "mcpServers: [local-tools, 42]",
    "mcpServers: [local-tools,, analytics]",
    "mcpServers: [null]",
    "mcpServers: [-1, 1.5]",
    "mcpServers: [[alpha, beta]]",
    "mcpServers:",
  ]) {
    add(doc(`name: reviewer\ndescription: Review code\n${mcpServers}`), "user", undefined, "官方用例：非法 mcpServers");
  }
  add(doc("name: empty-scope\ndescription: Use the parent MCP snapshot\nmcpServers: []"), "user", undefined, "官方用例：显式空 mcpServers");
  add(doc('name: scoped\ndescription: Use selected parent MCP servers\nmcpServers: [" local-tools ", analytics, "plugin:tools:", "[alpha]"]'), "project", undefined, "官方用例：mcpServers 名单");
  add(doc("name: reviewer\ndescription: Review code\ntools:\n  invalid: nested\n  - Read"), "user", undefined, "官方用例：非法嵌套不复活列表");

  // ---- frontmatter 结构 ----
  add("name: reviewer\ndescription: no delimiters", "user", undefined, "无分隔符：整体是正文");
  add("", "user", undefined, "空文件");
  add("\uFEFF---\r\nname: reviewer\r\ndescription: BOM + CRLF\r\ntools:\r\n  - Read\r\n---\r\nBody line 1\r\nBody line 2", "user", undefined, "BOM + CRLF");
  add(doc("name: reviewer\ndescription: Review"), "user", undefined, "缺闭合分隔符");
  add("---abc\nname: reviewer\n---\nbody", "user", undefined, "首行不是纯 ---");
  add("---\nname: reviewer\ndescription: Review\n---   \nbody", "user", undefined, "闭合行带尾随空格");
  add("---\nname: reviewer\ndescription: Review\n  ---\nbody", "user", undefined, "闭合行带前导空格");
  add("intro\n---\nname: reviewer\n---\nbody", "user", undefined, "分隔符前有内容");
  add("---\n---\nbody", "user", undefined, "空 frontmatter");
  add("---\n---", "user", undefined, "空 frontmatter 且无正文");
  add("---\nname: reviewer\ndescription: Review\n---\n", "user", undefined, "正文为空");
  add("---\nname: reviewer\ndescription: Review\n---\n\n\n  Body\n\n", "user", undefined, "正文首尾空白");
  add("---\nname: reviewer\ndescription: Review\n---body", "user", undefined, "闭合行粘连正文");
  add(doc("\n\n# name: commented\n\nname: reviewer   \ndescription: Review\n\t\n# trailing comment\n"), "user", undefined, "空行与注释行");
  add(doc("description: Review\nname: reviewer"), "user", undefined, "键序颠倒");

  // ---- 标量：name / description ----
  for (const [i, line] of [
    'name: "reviewer"',
    "name: 'reviewer'",
    'name: "re viewer"',
    'name: "a#b"',
    "name: a#b",
    "name: a #b",
    "name:   reviewer   ",
    "name:　reviewer　",
    "name: Reviewer",
    "name: 123",
    "name: true",
    'name: ""',
    'name: "',
    "name: [a]",
    "name: {a: 1}",
    "Name: reviewer",
    "name :reviewer",
    "name:reviewer",
    "  name: reviewer",
    "name: a\nname: b",
    "name:",
    "name: inherit",
    "name: a\\nb",
    "name: \"a\\\"b\"",
    "name: 'a\"b'",
  ].entries()) {
    add(doc(`${line}\ndescription: Review`), "user", undefined, `name 形态 #${i + 1}`);
  }
  for (const [i, line] of [
    'description: "line1\\nline2"',
    "description: line1\\nline2",
    "description: Review: changes",
    "description: Review changes # notes",
    "description: Review#1",
    'description: say "hi" there',
    "description: 'single \"double\" quotes'",
    "description: \"a\\\"b #c\"",
    "description: 'it''s'",
    "description: Review\n  changes",
    'description: ""',
    "description: 42",
    "description:\n  - a",
    "description: 　padded　 ",
    "description: ends with backslash\\",
    "description: 'unterminated",
    "description: \"unterminated",
    "description: tab\there",
    "description: emoji 🚀 与中文",
  ].entries()) {
    add(doc(`name: reviewer\n${line}`), "user", undefined, `description 形态 #${i + 1}`);
  }

  // ---- 列表：tools / disallowedTools / skills ----
  for (const [i, block] of [
    "tools: Read, Grep Bash(ls -la)",
    'tools: ["Read", "Grep"]',
    "tools: ['Read','Grep']",
    "tools: [Read, Grep]",
    "tools: [ Read , Grep ]",
    "tools: [Read,,Grep]",
    "tools: [Read,]",
    "tools: []",
    'tools: ["Read" , "Grep" ,]',
    "tools: [Bash(ls -la), Read]",
    'tools: ["a, b", Read]',
    'tools: ["a,b"]',
    'tools: [Read, "x # y", Grep]',
    "tools: [Read # c, Grep]",
    "tools: Bash(ls -la, rm)",
    'tools: ""',
    'tools: "Read"',
    "tools: [Read",
    "tools:",
    "tools:\n  - Read\n  - Grep",
    "tools:\n- Read\n- Grep",
    "tools:\n  -  Read  ",
    "tools:\n  - - x",
    "tools:\n  - Read # comment",
    'tools:\n  - "Read"\n  - \'Grep\'',
    "tools:\n  - Read,",
    "tools:\n  - 123",
    "tools:\n  - true",
    "tools:\n  - [a, b]",
    'tools:\n  - ""',
    "tools:\n  - Read\n  - \"\"\n  - Grep",
    "tools: [123]",
    "tools: [\"\"]",
    "tools: {\"a\": 1}",
    "tools: [\"\\u3000\"]",
  ].entries()) {
    add(doc(`name: reviewer\ndescription: Review\n${block}`), "user", undefined, `tools 形态 #${i + 1}`);
  }
  for (const [i, block] of [
    "skills: code review",
    "skills: [code, review]",
    'skills: "code review"',
    "skills: [1, code]",
    "skills:\n  - code\n  - review",
    "skills: code,review",
    "skills: code\treview",
    "skills: code　review",
    "skills: code\nskills: review",
    "skills: []",
    "skills:",
    "disallowedTools: Edit, Write",
    "disallowedTools:\n  - Edit",
    "disallowedTools: []",
    "disallowedTools: \"\"",
  ].entries()) {
    add(doc(`name: reviewer\ndescription: Review\n${block}`), "user", undefined, `skills/disallowedTools 形态 #${i + 1}`);
  }

  // ---- 布尔 / 数值 / 枚举 ----
  for (const [i, v] of ["true", "false", '"true"', '"false"', "True", "FALSE", "yes", "1", '"on"', '"TRUE"', "0", "null", "[true]"].entries()) {
    add(doc(`name: reviewer\ndescription: Review\nbackground: ${v}\ninjectAgentsMd: ${v}`), "user", undefined, `布尔形态 #${i + 1}`);
  }
  for (const [i, v] of ["7", '"7"', "0", "-1", "1.5", '"0"', "abc", "1e3", "007", '" 8 "', "+8", "999999999", "3.0", '"007"', "7 # turns", "07x", "[7]", ""].entries()) {
    add(doc(`name: reviewer\ndescription: Review\nmaxTurns: ${v}`), "user", undefined, `maxTurns 形态 #${i + 1}`);
  }
  for (const [i, v] of ["cyan", "Cyan", '"blue"', "'red'", '" neon "', "pinkish", '""', "blue # fav", "1", "[blue]"].entries()) {
    add(doc(`name: reviewer\ndescription: Review\ncolor: ${v}`), "user", undefined, `color 形态 #${i + 1}`);
  }
  for (const [i, v] of ["acceptEdits", "plan", "bypassPermissions", "yolo", '"auto"', "'dontAsk'", "default", "Build", ""].entries()) {
    add(doc(`name: reviewer\ndescription: Review\npermissionMode: ${v}`), "user", undefined, `permissionMode(user) #${i + 1}`);
    add(doc(`name: reviewer\ndescription: Review\npermissionMode: ${v}`), "project", undefined, `permissionMode(project) #${i + 1}`);
  }
  for (const [i, v] of ["user", "local", "project", '" project "', "PROJECT", "1", '""', "user project", "[user]", ""].entries()) {
    add(doc(`name: reviewer\ndescription: Review\nmemory: ${v}`), "user", undefined, `memory 形态 #${i + 1}`);
  }

  // ---- model / thoughtLevel ----
  for (const [i, v] of [
    "inherit", "main", "sonnet", "opus", "haiku", '""', "   ",
    "custom-openai/gpt-5.4",
    "custom-openai/gpt-5.4$high",
    "provider/model$",
    "provider/$high",
    "/model",
    "provider/",
    "prov / model",
    '"provider/model"',
    "custom:custom-openai:gpt-5.4",
    "custom:custom-openai",
    "custom:builtin:bigmodel-coding-plan:GLM-5.3",
    "custom:my%20provider:model%2Fx",
    "custom::",
    "custom:builtin:x",
    "custom:builtin:a:b:c",
    "custom:a%ZZb",
    "custom:你好:模型",
    "custom:provider:",
    "123", "true", "[a]", "{a: 1}",
    "account:bigmodel-individual-coding-plan/GLM-5.3-Flash",
    "custom:account%3Abigmodel-individual-coding-plan:GLM-5.3-Flash",
    // decodeURIComponent 的边界：百分号序列只认 ASCII 十六进制、UTF-8 必须完整、+ 不解码
    "custom:%E4%BD%A0%E5%A5%BD:m",
    "custom:%E4%BD:m",
    "custom:%zz:m",
    "custom:a+b:c",
    "custom:a%٣b:c",
    "custom:%3A%2F%24:m",
    "custom:a%G1:m",
    "custom:%:m",
  ].entries()) {
    add(doc(`name: reviewer\ndescription: Review\nmodel: ${v}`), "user", undefined, `model 形态 #${i + 1}`);
  }
  // JSON.parse 的严格性：尾逗号、单引号、未加引号的键与值都不合法 → 整个值退回字符串
  for (const [i, v] of [
    '{"a": 1,}', "{'a': 1}", '{"a": undefined}', '{"a": 01}', '{"a": +1}', '{"a": .5}', '{"a": 1e}',
    "{}", '{"a": [1, {"b": 2}]}', '{"a": "\\u4e2d", "b": "x\\"y"}', "{a}", '{"a"}', '{"a": }', '{"a": 1e3}',
    '{"a": true, "b": null}', '{"\\u00e9": 1}', '{"a": 1}{"b": 2}', '{ "a" : 1 }', '{"a":-1.5E-2}',
  ].entries()) {
    add(doc(`name: ${v}\ndescription: Review`), "user", undefined, `JSON 对象形态(name) #${i + 1}`);
    add(doc(`name: reviewer\ndescription: Review\ntools: ${v}`), "user", undefined, `JSON 对象形态(tools) #${i + 1}`);
  }
  for (const [i, v] of ["high", '" high "', '""', "5", "max", "", "True", "low # note", "  "].entries()) {
    add(doc(`name: reviewer\ndescription: Review\nmodel: provider/model$low\nthoughtLevel: ${v}`), "user", undefined, `thoughtLevel 形态 #${i + 1}`);
  }
  add(doc("name: reviewer\ndescription: Review\nthoughtLevel: high"), "user", undefined, "只有 thoughtLevel 没有 model");
  add(doc("name: reviewer\ndescription: Review\nmodel: provider/model\nthoughtLevel:"), "user", undefined, "裸 thoughtLevel");

  // ---- mcpServers ----
  for (const [i, block] of [
    "mcpServers:\n  - local-tools\n  - analytics",
    'mcpServers:\n  - " local-tools "',
    "mcpServers:\n  - local-tools:",
    "mcpServers:\n  - name: value",
    "mcpServers:\n  - {a: 1}",
    "mcpServers:\n  - [alpha, beta]",
    "mcpServers:\n  - null",
    "mcpServers:\n  - ~",
    "mcpServers:\n  - 42",
    'mcpServers:\n  - ""',
    "mcpServers:\n  - ' analytics '",
    "mcpServers:\n  - \"a # b\"\n  - c",
    "mcpServers: [a, b]",
    'mcpServers: ["a"]',
    'mcpServers: [a, "" ]',
    "mcpServers: [ a ]",
    "mcpServers: [a, b,]",
    "mcpServers: [a,,b]",
    "mcpServers: [{type: stdio}]",
    "mcpServers: [ name: value ]",
    "mcpServers: [a # c, b]",
    'mcpServers: ["a # c", b]',
    'mcpServers: "local-tools"',
    "mcpServers: {a: 1}",
    "mcpServers: 5",
    "mcpServers: true",
    "mcpServers: null",
    "mcpServers: [] # none",
    "mcpServers: [\"a\", 'b', c]",
    "mcpServers: [\"a\\\",b\"]",
    "mcpServers:\n  local-tools:\n    type: stdio\n  - after",
    "mcpServers:\n\n  - after-blank",
    "mcpServers: [TRUE, FALSE, 1.5, -2]",
  ].entries()) {
    add(doc(`name: reviewer\ndescription: Review\n${block}`), "user", undefined, `mcpServers 形态 #${i + 1}`);
  }

  // ---- 随机组合（种子固定）：行级乱序拼装，压一压解析器的状态机 ----
  const rand = prng(20261125);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const keys = ["name", "description", "model", "thoughtLevel", "tools", "disallowedTools", "skills", "color", "permissionMode", "memory", "maxTurns", "background", "injectAgentsMd", "mcpServers", "extra_key-1", "Name"];
  const values = [
    "reviewer", '"reviewer"', "Review code", '"a, b"', "'x'", "[a, b]", "[]", "true", "false", "123", "-1", "1.5", "x # y", '"x # y"',
    "a:b", "{a: 1}", "custom:a:b", "p/m$high", "inherit", "　pad　", "a,b", "(x)", "Bash(ls -la)", "#c", '"', "'", "null", "~",
    "Read, Grep", "high", '" high "', "cyan", "plan", "user", "0", "007", '"', "custom:builtin:x:y:z", "a\\nb", "  spaced  ",
  ];
  const junk = ["", "   ", "# comment", "  - Read", "- stray", "no colon line", "  indented junk", "\t", "---", " - x", "  #c"];
  for (let n = 0; n < 400; n += 1) {
    const lines = [];
    const count = 1 + Math.floor(rand() * 9);
    for (let k = 0; k < count; k += 1) {
      const r = rand();
      if (r < 0.12) {
        lines.push(pick(junk));
      } else if (r < 0.3) {
        lines.push(`${pick(keys)}:`);
        const items = Math.floor(rand() * 3);
        for (let j = 0; j < items; j += 1) lines.push(`${rand() < 0.5 ? "  " : ""}- ${pick(values)}`);
      } else {
        lines.push(`${pick(keys)}${rand() < 0.2 ? " " : ""}:${rand() < 0.3 ? "" : " "}${pick(values)}`);
      }
    }
    const crlf = rand() < 0.3;
    let content = doc(lines.join("\n"), rand() < 0.5 ? "Body." : "");
    if (rand() < 0.1) content = `\uFEFF${content}`;
    if (crlf) content = content.replace(/\n/g, "\r\n");
    add(content, pick(["user", "project"]), rand() < 0.3 ? `/ws/.zcode/agents/rand-${n}.md` : undefined, `随机 #${n + 1}`);
  }
  return cases;
}

function buildSelectionCases() {
  return [
    { providerId: "p", modelId: "m" },
    { providerId: "p", modelId: "m", options: { reasoningLevel: "max" } },
    { providerId: "p", modelId: "m", options: {} },
    { providerId: " p ", modelId: " m ", options: { reasoningLevel: " high " } },
    { providerId: "p", modelId: "m", options: { reasoningLevel: "" } },
    { providerId: "p", modelId: "m", options: { reasoningLevel: "   " } },
    { providerId: "p", modelId: "m", options: { reasoningLevel: 5 } },
    { providerId: "p", modelId: "m", options: { effort: "high" } },
    { providerId: "p", modelId: "m", options: { reasoningLevel: "high", effort: "x" } },
    { providerId: "p", modelId: "m", options: null },
    { providerId: "p", modelId: "m", options: [] },
    { providerId: "p", modelId: "m", options: "max" },
    { providerId: "p", modelId: "m", extra: 1 },
    { providerId: "p", modelId: "m", reasoningLevel: "max" },
    { providerId: "", modelId: "m" },
    { providerId: "   ", modelId: "m" },
    { providerId: "p", modelId: "" },
    { modelId: "m" },
    { providerId: "p" },
    { providerId: 1, modelId: "m" },
    { providerId: "p", modelId: null },
    { providerId: "p", modelId: "m", options: undefined },
    {},
    null, undefined, [], "x", 5, true,
    { providerId: "account:bigmodel-individual-coding-plan", modelId: "GLM-5.3-Flash", options: { reasoningLevel: "max" } },
    { providerId: "custom::acme", modelId: "m::1", options: { reasoningLevel: "low" } },
    { providerId: "　p　", modelId: "m" },
  ];
}

function buildResolveCases() {
  const p = (name, source) => ({ name, description: "d", source, systemPrompt: "" });
  return [
    { profiles: [], state: { disabledAgentIds: [], builtInModelSelectionOverrides: {}, pluginAgentModelSelectionOverrides: {} } },
    { profiles: [p("reviewer", "user")], state: { disabledAgentIds: ["user:user:reviewer"], builtInModelSelectionOverrides: {}, pluginAgentModelSelectionOverrides: {} } },
    { profiles: [p(" Reviewer ", "user"), p("reviewer", "project")], state: { disabledAgentIds: ["user:user:reviewer"], builtInModelSelectionOverrides: {}, pluginAgentModelSelectionOverrides: {} } },
    { profiles: [p("REVIEWER", "user"), p("reviewer", "user")], state: { disabledAgentIds: ["user:user:reviewer"], builtInModelSelectionOverrides: {}, pluginAgentModelSelectionOverrides: {} } },
    { profiles: [p("reviewer", "project")], state: { disabledAgentIds: ["user:user:reviewer"], builtInModelSelectionOverrides: {}, pluginAgentModelSelectionOverrides: {} } },
    { profiles: [p("reviewer", "user")], state: { disabledAgentIds: ["reviewer", "user:project:reviewer", "source:user:reviewer", "user:user:RevieweR"], builtInModelSelectionOverrides: {}, pluginAgentModelSelectionOverrides: {} } },
    {
      profiles: [p("a", "user"), p("b", "user"), p("c", "project")],
      state: { disabledAgentIds: ["user:user:b"], builtInModelSelectionOverrides: { Explore: { providerId: "p", modelId: "m", options: { reasoningLevel: "max" } } }, pluginAgentModelSelectionOverrides: { "plugin:x:y": { providerId: "p2", modelId: "m2" } } },
    },
    {
      profiles: [p("　a　", "user")],
      state: { disabledAgentIds: ["user:user:a"], builtInModelSelectionOverrides: {}, pluginAgentModelSelectionOverrides: {} },
    },
  ];
}

const pluginOverrides = [
  {},
  { "plugin:foo:bar": { providerId: "p", modelId: "m" } },
  { foo: { providerId: "p", modelId: "m" }, "plugin:": { providerId: "p", modelId: "m" } },
  { "plugin:a:b": { providerId: " p ", modelId: "m", options: { reasoningLevel: " high " } }, "plugin:c:d": { providerId: "", modelId: "m" }, "plugin:e:f": { providerId: "p" }, "plugin:g:h": null, "plugin:i:j": { providerId: "p", modelId: "m", x: 1 } },
  { "plugin:a:b": { providerId: "p", modelId: "m", options: {} } },
  null, undefined, [], "x", 5,
];

// ============ 跑官方实现 ============

let commit = "unknown";
try {
  commit = execFileSync("git", ["-C", sourceRoot, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
} catch {
  // 取不到提交号不影响生成
}

const cases = {
  _meta: {
    source: "ZCode 开源仓库 packages/shared/src（CLI 与桌面端共用的同一份解析器）",
    zcodeCommit: commit,
    generatedAt: new Date().toISOString(),
    generator: "scripts/gen-subagent-profile-golden.mjs",
  },
  profiles: buildProfileCases(),
  selections: buildSelectionCases(),
  pluginOverrides,
  resolve: buildResolveCases(),
};

const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;
const onlyCasesOut = {
  ...cases,
  profiles: cases.profiles.map((c, i) => ({ ...c, expected: previous?.profiles?.[i]?.expected ?? null })),
  selections: cases.selections.map((v, i) => ({ input: v, expected: previous?.selections?.[i]?.expected ?? null })),
  pluginOverrides: { input: pluginOverrides, expected: previous?.pluginOverrides?.expected ?? null },
  resolve: cases.resolve.map((r, i) => ({ ...r, expected: previous?.resolve?.[i]?.expected ?? null })),
};
if (onlyCases) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(onlyCasesOut, null, 2) + "\n");
  console.log(`仅重写用例：${cases.profiles.length} 条解析用例，期望输出沿用旧文件（${OUT}）`);
  process.exit(0);
}

const esbuild = requireWebview("esbuild");
const sharedSrc = join(sourceRoot, "packages", "shared", "src");
let zodEntry;
if (zodDir && existsSync(join(zodDir, "v4", "index.js"))) zodEntry = join(zodDir, "v4", "index.js");
else if (zodDir) zodEntry = zodDir;

const entry = `
import { parseAgentProfileFromMarkdown } from "./subagent-profile-parser.ts";
import { modelSelectionSchema } from "./model-selection.ts";
import { resolveSubagentRuntimeProfiles } from "./subagent-runtime-config.ts";
import { parsePluginSubagentModelSelectionOverrides } from "./subagents-types.ts";
import { readFileSync } from "node:fs";
const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
const out = {
  profiles: input.profiles.map((c) => parseAgentProfileFromMarkdown(c)),
  selections: input.selections.map((v) => { const r = modelSelectionSchema.safeParse(v); return r.success ? r.data : null; }),
  pluginOverrides: parsePluginSubagentModelSelectionOverrides(input.pluginOverrides),
  resolve: input.resolve.map((r) => resolveSubagentRuntimeProfiles(r.profiles, r.state)),
};
process.stdout.write(JSON.stringify(out));
`;

const work = join(tmpdir(), "zcode-subagent-golden");
mkdirSync(work, { recursive: true });
const bundle = join(work, "official-parser.cjs");
const casesFile = join(work, "cases.json");
await esbuild.build({
  stdin: { contents: entry, loader: "ts", resolveDir: sharedSrc },
  bundle: true, platform: "node", format: "cjs", outfile: bundle, logLevel: "error",
  ...(zodEntry ? { alias: { zod: zodEntry } } : {}),
});
const slim = { profiles: cases.profiles, selections: cases.selections, pluginOverrides, resolve: cases.resolve };
writeFileSync(casesFile, JSON.stringify(slim));
const out = JSON.parse(execFileSync(process.execPath, [bundle, casesFile], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));

const golden = {
  ...cases,
  profiles: cases.profiles.map((c, i) => ({ ...c, expected: out.profiles[i] })),
  selections: cases.selections.map((v, i) => ({ input: v, expected: out.selections[i] })),
  pluginOverrides: { input: pluginOverrides, expected: out.pluginOverrides },
  resolve: cases.resolve.map((r, i) => ({ ...r, expected: out.resolve[i] })),
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(golden, null, 2) + "\n");
console.log(`已生成 ${OUT}`);
console.log(`  解析用例 ${golden.profiles.length} 条（含诊断 ${out.profiles.filter((p) => p.diagnostic).length} 条）`);
console.log(`  模型选择 ${golden.selections.length} 条，插件覆盖 1 组，禁用过滤 ${golden.resolve.length} 组`);
console.log(`  zcode=${commit} zod=${zodEntry ?? "(源码自带)"}`);
