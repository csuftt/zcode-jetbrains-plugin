// 由 scripts/extract-changelog.mjs 从根 CHANGELOG.md 生成（npm prebuild 自动执行）——请勿手改；
// 修改变更内容请编辑 CHANGELOG.md 后重新构建。

export interface ChangelogSection {
  title: string
  items: string[]
}

/** 一个语言段的正文（intro 引言 + 分节列表） */
export interface ChangelogContent {
  /** 语言段内、首个节之间的引言段（如 0.2.0 首版说明；多行，> 开头为引用行） */
  intro?: string
  sections: ChangelogSection[]
}

/** 一个版本块：中文段在前英文段后（渲染顺序固定，不随 UI 语言） */
export interface ChangelogEntry {
  version: string
  date: string
  zh?: ChangelogContent
  en?: ChangelogContent
}

export const CHANGELOG_DATA: ChangelogEntry[] = [
  {
    "version": "0.3.1",
    "date": "2026-09-02",
    "zh": {
      "sections": [
        {
          "title": "新增",
          "items": [
            "**子代理详情页全面改版**：执行记录弹窗 UI 对齐主界面——思考过程、图片、工具组卡同款渲染，头部新增执行时刻与所用模型，工具卡实时显示真实耗时，整体排版更紧凑；数据源切换到与官方客户端一致的 v4 实时订阅通道，执行状态判定准确、实时流全程稳定（订阅失败自动降级快照轮询）。",
            "**网页搜索 / 获取工具卡友好渲染**：WebSearch 与 WebFetch 工具卡不再显示裸 JSON——输入内容友好展示，搜索结果带可点击的来源链接列表，网页全文收进弹窗查看；消息正文中的网页链接改为系统浏览器打开，不再在插件内跳转。",
            "**Mermaid 图表复制与放大增强**：图表上方新增工具栏，可一键复制代码或复制为高清 PNG 图片（自动适配深浅主题底色）；放大弹窗支持拖动平移，滚轮缩放步进加大更跟手。",
            "**用量曲线悬停浮层与图例**：设置 → 用量的每日 Token 曲线新增悬停浮层（各模型数值降序对比）与颜色图例，同图对比模型数从 3 个扩展到 6 个。",
            "**长内容弹窗滚动跳转按钮**：子代理报告、文本预览、消息全文等长弹窗统一新增 ↑ 置顶 / ↓ 置底按钮，停止滚动 1.5 秒后自动淡出。",
            "**设置页 GitHub 入口**：其他设置新增「开源与支持」区块，一键直达仓库页点 Star 或复制地址。"
          ]
        },
        {
          "title": "修复",
          "items": [
            "**流式渲染 Mermaid 图表白屏**：流式输出中图表形态切换可能触发页面整体白屏（React 崩溃），已修复。",
            "**弹窗叠开连带关闭**：在子代理详情上打开最终报告 / 阅读弹窗不再连带关闭详情弹窗；Esc 现在只关闭最上层。",
            "**锚点导航出现点击无效的圆点**：压缩摘要消息不再生成锚点圆点。",
            "**IDE 日志噪音收敛**：摘除诊断期遗留的高频埋点日志（此前 10 分钟可写入 3000+ 行 idea.log）。"
          ]
        },
        {
          "title": "变更",
          "items": [
            "**Token 数紧凑显示**：消息统计与子代理通知卡的 token 数改为紧凑可读格式（如 461.6k / 4.3k），精确数值悬停可见。",
            "**设置页视觉统一**：各设置视图字号统一为四档体系，输入栏下拉整体紧凑化，整体视觉更协调。",
            "**阅读类弹窗改版**：粘贴文本预览与消息全文弹窗改为头部行形态（图标 + 标题统计 + 关闭），内容区底色下沉区分层次；压缩摘要全文弹窗补上滚动跳转按钮；版本更新弹窗一屏化、页码恒显。"
          ]
        }
      ]
    },
    "en": {
      "sections": [
        {
          "title": "Added",
          "items": [
            "**Subagent detail page overhaul**: The execution log dialog now matches the main chat UI — thinking blocks, images and grouped tool cards rendered the same way, with execution time and model shown in the header, live tool durations, and a tighter layout. Its data source moved to the v4 live subscription channel used by the official client, keeping status accurate and the live stream stable throughout (with automatic fallback to snapshot polling).",
            "**Friendly rendering for web search / fetch tool cards**: WebSearch and WebFetch cards no longer show raw JSON — inputs are displayed readably, search results come with a clickable source list, and full page content opens in a dialog. Web links in message bodies now open in the system browser instead of navigating inside the plugin.",
            "**Mermaid diagram copy & zoom enhancements**: A toolbar above diagrams copies the code or a high-resolution PNG (theme background applied automatically). The zoom dialog supports drag panning, and the wheel zoom step is larger.",
            "**Usage chart hover overlay & legend**: The daily token chart in Settings → Usage gains a hover overlay (per-model values, sorted) and a color legend; the number of comparable models per chart grows from 3 to 6.",
            "**Scroll-to-top/bottom buttons in long dialogs**: Long dialogs (subagent report, text preview, full message text, etc.) now share ↑ top / ↓ bottom jump buttons that fade out 1.5 seconds after scrolling stops.",
            "**GitHub entry in settings**: A new \"Open source & support\" section under Other settings links straight to the repository page for starring or copying the URL."
          ]
        },
        {
          "title": "Fixed",
          "items": [
            "**White screen when streaming Mermaid diagrams**: A diagram shape change during streaming could crash the page and blank the whole UI; fixed.",
            "**Stacked dialogs closing together**: Opening the final report or a reading dialog above the subagent detail no longer closes the detail dialog; Esc now closes only the topmost layer.",
            "**Dead anchor dots**: Compaction summary messages no longer create anchor dots that did nothing when clicked.",
            "**IDE log noise reduction**: High-frequency diagnostic logging left over from debugging has been removed (it could write 3000+ lines into idea.log in 10 minutes)."
          ]
        },
        {
          "title": "Changed",
          "items": [
            "**Compact token counts**: Token counts in message stats and subagent notification cards now use a compact format (e.g. 461.6k / 4.3k); exact values are visible on hover.",
            "**Unified settings visuals**: Font sizes across the settings views are unified into a four-tier system, and the input bar dropdowns are more compact.",
            "**Reading dialog redesign**: The pasted-text preview and full-message dialogs now use a header-row form (icon + title stats + close) with a sunken content area; the compaction summary dialog gains scroll jump buttons; the version dialog fits on one screen and keeps its page number visible."
          ]
        }
      ]
    }
  },
  {
    "version": "0.3.0",
    "date": "2026-08-31",
    "zh": {
      "sections": [
        {
          "title": "新增",
          "items": [
            "**会话内定时发送**：输入框新增定时入口，设定时间与提示词后到点自动执行——支持时间预设、指定执行模型、勾选「在新会话中执行」；任务卡片支持立即执行 / 改时间 / 取消，「全部定时任务」列表可跨会话管理与跳转；到点自动打开对应会话标签，任务跨插件重启保留，已发消息带「定时执行」标记。",
            "**完成轮执行过程自动折叠**：已完成的回合默认只显示最终结论，结论上方折叠栏展示思考次数 / 工具数 / 轮次耗时，点击展开完整过程；行为设置新增开关（默认开启）；会话内搜索时自动展开保证定位。",
            "**内嵌浏览器调试采集**：AI 可读取内嵌浏览器的 console 输出、接口请求与未捕获异常，排查页面问题不再靠截图转述。",
            "**历史会话打开编排**：点击历史会话时，已在其他标签页打开的直接跳转过去；当前标签已有会话时可选择「覆盖当前」或「新标签打开」。",
            "**环境检测显示 CLI 版本号**：环境检测的 ZCode CLI 徽标直接显示检测到的版本号。"
          ]
        },
        {
          "title": "修复",
          "items": [
            "**体验套餐渠道切模型后回合必失败**：zcode-plan 网关强制滑块验证（官方客户端专属能力），插件切到该渠道后每次对话都报 \"Model request failed\"；现在全链路过滤该渠道并自动兜底到可用渠道。",
            "**历史列表混入子代理会话**：app-server 会把驻留内存的子代理会话混进历史列表（重启才消失）；现在双层过滤，不再出现。",
            "**点停止后后台任务仍在跑**：停止此前只结束前台回合，后台化的子代理任务照常运行并继续触发回调；现在停止会连带取消运行中的后台任务。",
            "**历史列表时间倒序被破坏**：部分会话因路径双形态并集拼接垫底导致时间顺序错乱；现在统一按更新时间倒序。",
            "**切模型后立即发消息的时序防护**：切模型落定瞬间发送可能撞上服务端回合清算窗口导致首回合无输出；现在发送会等待切换落定，切换后 60 秒零输出时顶栏给出挂死提示。",
            "**稳定性批修复**：删除会话 / 任务归档操作偶发卡死、打开新标签卡 UI 数秒、流式回放跨会话串扰、崩溃日志泄露敏感信息等一批代码审查问题。"
          ]
        },
        {
          "title": "变更",
          "items": [
            "**底部栏子代理点击默认开最终报告**：已完成的子代理点击默认打开最终报告弹窗（无报告时回退执行记录）。"
          ]
        }
      ]
    },
    "en": {
      "sections": [
        {
          "title": "Added",
          "items": [
            "**Scheduled messages in a session**: A new timer entry in the input box lets you schedule a prompt to run automatically at a set time — with time presets, a per-task execution model, and an \"execute in a new session\" option. Task cards support run now / reschedule / cancel, and an \"All scheduled tasks\" list manages and jumps across sessions. The corresponding session tab opens automatically when a task fires; tasks survive plugin restarts, and sent messages carry a \"Scheduled\" badge.",
            "**Auto-collapse of finished turns**: A finished turn now shows only the final conclusion by default, with a collapse bar above it showing thought count / tool count / turn duration — click to expand the full execution process. A toggle is added to behavior settings (on by default), and in-session search auto-expands collapsed turns so matches stay reachable.",
            "**Embedded browser debug capture**: The AI can now read console output, network requests and uncaught errors from the embedded browser — no more debugging page issues through screenshots.",
            "**History open orchestration**: Clicking a history session jumps to its tab if it is already open elsewhere; when the current tab already hosts a session, you can choose between \"overwrite current\" and \"open in new tab\".",
            "**CLI version in environment check**: The ZCode CLI badge in environment check now shows the detected version number."
          ]
        },
        {
          "title": "Fixed",
          "items": [
            "**Turns always failing after switching to the trial-plan channel**: The zcode-plan gateway enforces a slider captcha (exclusive to the official client), so every conversation failed with \"Model request failed\" after switching to it. The channel is now filtered out across the stack with automatic fallback to a usable one.",
            "**Subagent sessions leaking into history**: app-server kept in-memory subagent sessions in the history list (until restart). They are now filtered on both ends and no longer appear.",
            "**Background tasks kept running after Stop**: Stop only ended the foreground turn, leaving background subagent tasks running and firing callbacks. Stop now also cancels running background tasks.",
            "**History list ordering broken**: Some sessions sank to the bottom due to dual path-form merging, scrambling the time order. The list is now consistently sorted by update time, newest first.",
            "**Send timing protection after a model switch**: Sending right as a model switch landed could hit the server's turn-settlement window and produce a turn with no output. Sending now waits for the switch to settle, and a banner hint appears if a turn produces no output for 60 seconds right after a switch.",
            "**Batch stability fixes**: A batch of code-review issues — occasional hangs when deleting sessions or archiving tasks, multi-second UI freezes when opening new tabs, streaming replay leaking across sessions, and sensitive data leaking into crash logs."
          ]
        },
        {
          "title": "Changed",
          "items": [
            "**Bottom-bar subagent click opens the final report**: Clicking a completed subagent now opens its final report by default (falling back to the execution log when no report exists)."
          ]
        }
      ]
    }
  },
  {
    "version": "0.2.7",
    "date": "2026-08-28",
    "zh": {
      "sections": [
        {
          "title": "修复",
          "items": [
            "**新版 ZCode CLI 下停止按钮失效**：CLI 0.16.5+ 的兼容性问题导致点停止后回合继续跑，只能等它自然结束；现在停止改走官方 V4 协议通道，毫秒级生效、会话立即可复用，旧版 CLI 自动回退原有停止方式。",
            "**回合进行中切换模型会打断回合**：此前回合中切模型会直接杀掉当前回合（或报错不生效）；现在延迟到回合结束后自动补发生效，等待期间重新选回当前模型可取消切换。",
            "**停止会误取消待切换的模型**：模型切换等待期间点停止，切换会被连带取消而一直用旧模型；现在停止只结束当前回合，待切换的模型照常落地。",
            "**启动时弹出「读取设置失败 [-32004]」**：ZCode CLI 升级或重启后打开插件，冷会话读取设置可能报错弹横幅；现在自动恢复会话后重读，横幅不再出现。"
          ]
        },
        {
          "title": "变更",
          "items": [
            "**回合时间显示日期**：主界面回合时间此前只显示「时:分」，翻看跨天的历史会话时难以分辨是哪天的；现在非当天的回合显示「月-日 时:分」，跨年再加上年份。"
          ]
        }
      ]
    },
    "en": {
      "sections": [
        {
          "title": "Fixed",
          "items": [
            "**Stop button ineffective on the new ZCode CLI**: A regression in CLI 0.16.5+ let the turn keep running after clicking Stop until it finished on its own. Stop now goes through the official V4 protocol channel — it takes effect within milliseconds and the session is immediately reusable; older CLI versions automatically fall back to the previous stop method.",
            "**Switching models mid-turn interrupted the turn**: Previously switching models during a running turn killed the turn outright (or failed to apply). The switch is now deferred and applied automatically when the turn ends; picking the current model again during the wait cancels it.",
            "**Stop accidentally cancelled a pending model switch**: Clicking Stop while a model switch was waiting to apply used to cancel the switch and keep the old model. Stop now only ends the current turn — the pending switch still lands.",
            "**\"Failed to read settings [-32004]\" banner at startup**: After a ZCode CLI upgrade or restart, reading settings for a cold session could fail and show a banner. The session is now auto-resumed and re-read; the banner no longer appears."
          ]
        },
        {
          "title": "Changed",
          "items": [
            "**Round timestamps now include the date**: Round times in the chat previously showed only \"HH:mm\", which was confusing when browsing sessions from earlier days. Rounds not from today now show \"MM-DD HH:mm\" (plus the year when it differs)."
          ]
        }
      ]
    }
  },
  {
    "version": "0.2.6",
    "date": "2026-08-28",
    "zh": {
      "sections": [
        {
          "title": "新增",
          "items": [
            "**应用用量统计**：设置 → 用量新增「应用用量」页签（默认打开）——基于本地会话数据聚合、不依赖 API Key，覆盖第三方模型（DeepSeek 等）；支持近 7 天 / 30 天 / 全部区间，含总 Token、请求次数、会话数等六项统计、每日 Token 曲线（Top 模型）、模型明细（第三方带徽章）与工具调用表。",
            "**拖拽文件到输入框**：从系统拖文件进输入框自动转为文件 chip（与粘贴路径同款）。",
            "**内置渠道命中方式徽章**：设置 → 模型的内置渠道卡片显示「客户端选中」（客户端当前选择生效）或「兜底生效」（所选渠道凭证不可用时自动回退），一眼看清生效渠道的来源。",
            "**套餐用量查询凭证提示**：GLM 套餐用量页显示实际使用的查询凭证渠道，非订阅渠道时以警示色标注（数据口径可能不符）。"
          ]
        },
        {
          "title": "变更",
          "items": [
            "**内置渠道以 ZCode 客户端配置为准（只读）**：插件不再支持启停/切换内置渠道，同一时间只展示当前生效的一个内置渠道（其余内置渠道不再重复出现）；在客户端切换后回来刷新即可。",
            "**对话凭证跟随客户端激活渠道**：插件注入的模型凭证跟随 ZCode 客户端当前选中渠道（API Key 模式 / 订阅套餐），避免\"按量 key 配套餐模型\"的计费错渠道。"
          ]
        },
        {
          "title": "修复",
          "items": [
            "**凭证缺失不再阻断启动（issue #4）**：config.json 中找不到可用凭证时插件直接报错拦死主流程；现在降级为环境提醒条提示补配（登录 ZCode 客户端或添加 API Key 型模型），其余功能不受影响。",
            "**打开损坏会话时全部请求超时**：恢复坏会话触发 app-server 忙窗口后请求全部超时挂死；现在超时自动重试自愈，会话照常打开。",
            "**切换渠道后思考深度消失**：渠道切换后模型名相同但渠道不同时，选中模型未重新兜底导致思考深度档位不渲染；现在自动迁移并重建。",
            "**模型下拉空列表无法刷新**：无可用模型时下拉置灰点不开，只能去设置页刷新；现在可打开下拉并直接点「刷新模型列表」。",
            "**输入历史写入失败（kvSave 单值过大）**：历史输入积累过多后发送消息报错；现在按预算自动从最旧裁剪。",
            "**「重新检测」结果延迟**：环境检测可能吃到 30 秒缓存显示旧状态（如刚禁用渠道仍显示凭证正常）；现在每次点击都读取最新状态。",
            "**套餐用量查询空凭证请求**：订阅 oauth 模式下查询会发出空 Authorization 头导致必然失败；现在跳过空 key 渠道改用有效回退凭证。"
          ]
        }
      ]
    },
    "en": {
      "sections": [
        {
          "title": "Added",
          "items": [
            "**App usage stats**: A new \"App usage\" tab in Settings → Usage (opened by default) — aggregated from local session data with no API Key required, covering third-party models (DeepSeek etc.); supports 7-day / 30-day / all ranges, with six stat cards, a daily token chart (top models), a model table (with third-party badges) and a tool-call table.",
            "**Drag files into the input box**: Files dragged from the OS into the input box automatically become file chips (same as pasted paths).",
            "**Builtin channel resolution badge**: The builtin channel card in Settings → Models shows \"Client selected\" (the channel active in the ZCode client) or \"Fallback\" (auto-fallback when the selected channel has no valid credential), making the effective channel's origin clear at a glance.",
            "**Plan usage credential hint**: The GLM plan usage page shows which provider's key was used for the query; non-subscription channels are highlighted with a warning color (data may not match)."
          ]
        },
        {
          "title": "Changed",
          "items": [
            "**Builtin channels now follow the ZCode client config (read-only)**: The plugin no longer toggles or switches builtin channels, and only the single active builtin channel is shown (no more duplicates); switch in the client, then refresh here.",
            "**Conversation credentials follow the active client channel**: The injected model credential now follows the channel selected in the ZCode client (API Key mode / subscription plan), avoiding cross-channel billing mistakes."
          ]
        },
        {
          "title": "Fixed",
          "items": [
            "**Missing credentials no longer block startup (issue #4)**: The plugin used to fail hard when no usable credential was found in config.json; it now degrades to an environment notice prompting login to the ZCode client or adding an API Key provider, leaving other features intact.",
            "**All requests timing out when opening a corrupted session**: Resuming a bad session triggered an app-server busy window where every request timed out; timeouts now retry automatically and the session opens normally.",
            "**Thinking level lost after switching channels**: When the same model name existed on a different channel, the selected model wasn't re-resolved and the thinking level stopped rendering; it now migrates and rebuilds automatically.",
            "**Model dropdown unusable when the list is empty**: With no available models the dropdown was greyed out and required the settings page to refresh; it now opens with an in-dropdown refresh action.",
            "**Input history write failure (kvSave value too large)**: Sending messages failed after history accumulated beyond the storage limit; history is now pruned from the oldest within a budget.",
            "**Stale \"re-check\" results**: Environment checks could serve a 30-second cache showing outdated state (e.g. credentials shown as fine right after disabling the provider); every explicit re-check now reads fresh state.",
            "**Empty-credential plan usage requests**: In subscription oauth mode the usage query sent an empty Authorization header and always failed; blank-key channels are now skipped in favor of a valid fallback credential."
          ]
        }
      ]
    }
  },
  {
    "version": "0.2.5",
    "date": "2026-08-27",
    "zh": {
      "sections": [
        {
          "title": "新增",
          "items": [
            "**提示词润色**：设置 → 基础设置 → 行为开启（默认关闭）后，输入框出现 ✨ 润色按钮——点击让 AI 优化当前输入，对比确认后替换。走常驻通道（响应更快、不产生额外会话记录）；可配置润色专用模型（默认跟随会话模型，所选模型失效时自动回退默认）；润色弹窗显示实际使用的模型；按钮悬浮有功能说明。",
            "**输入框粘贴图片**：剪贴板截图/图片直接 Ctrl+V 粘贴发送（自动压缩：最长边 1280、单图 ≤900KB）；当前套餐模型不支持图像输入时自动追加附图说明，引导 AI 用读图工具查看。",
            "**模型列表增强**：模型下拉底部新增「刷新模型列表」（ZCode 客户端侧改配置后无需再切设置页）；支持视觉输入的模型显示视觉徽章；刷新后当前模型已被删除时自动切换到可用模型。",
            "**模型 provider 启停多标签同步**：设置页启用/停用模型 provider 后，所有打开的插件标签页即时同步生效。",
            "**工具权限审批弹窗**：「变更前询问」权限模式下，工具调用会弹出审批窗口（工具名/理由/输入预览/风险级/倒计时），选择后继续执行；此前该模式会弹协议错误且工具被自动拒绝。"
          ]
        },
        {
          "title": "修复",
          "items": [
            "**快速切换模型时思考档位报错**：模型切换在途的一瞬间旧模型的思考档位会残留下发，触发 `[-32603] Unsupported reasoning effort` 报错。现在切换期间挡住旧档位，新模型档位就绪后再恢复。"
          ]
        }
      ]
    },
    "en": {
      "sections": [
        {
          "title": "Added",
          "items": [
            "**Prompt enhancer**: Enable in Settings → Basic → Behavior (off by default) to show the ✨ enhance button in the input box — click to let AI polish your input, then apply after review. Uses the resident channel (faster, no extra session records); a dedicated model can be configured (defaults to the session model, auto-falls back to the default model if unavailable); the dialog shows the model actually used; the button has a hover tooltip.",
            "**Paste images into the input box**: Paste screenshots/images directly with Ctrl+V (auto-compressed: max edge 1280, ≤900KB per image); when the current plan's model doesn't accept image input, an attachment note is appended automatically, guiding AI to view images with its vision tools.",
            "**Model list enhancements**: A \"Refresh model list\" action at the bottom of the model dropdown (no need to open settings after changing providers in the ZCode client); vision-capable models show a vision badge; if the current model was removed after refresh, it auto-switches to an available one.",
            "**Multi-tab sync of model provider enablement**: Enabling/disabling a model provider in settings now syncs to all open plugin tabs instantly.",
            "**Tool permission approval dialog**: Under the \"ask before changes\" permission mode, tool calls now show an approval dialog (tool name/reason/input preview/risk level/countdown) and continue after your choice; previously this mode raised a protocol error and tools were auto-denied."
          ]
        },
        {
          "title": "Fixed",
          "items": [
            "**Thinking-level error when switching models quickly**: During an in-flight model switch, the old model's thinking level could leak and trigger `[-32603] Unsupported reasoning effort`. Old levels are now blocked during the switch and restored once the new model's levels are ready."
          ]
        }
      ]
    }
  },
  {
    "version": "0.2.4",
    "date": "2026-08-26",
    "zh": {
      "sections": [
        {
          "title": "修复",
          "items": [
            "**切换 Qwen 模型频繁触发自动上下文清理**：切到 Qwen 等自定义 provider 后每次请求都被压缩、响应变慢，反复 3 次后报「Autocompact stopped」。根因：模型切换时只传了 `modelId`，服务端用残缺模型定义覆盖完整定义，导致上下文窗口归零。现在切模型时携带完整定义（上下文容量、最大输出、能力位）。",
            "**压缩指示器滞后读数复活卡死**：`/compact` 压缩结束后指示器永久卡住，下一回合用户只看到转圈。根因：回合结束时读到的服务端清算数据带 ~1.3s 滞后，把已结束的压缩回合「复活」，下一回合被守卫吞掉。现在读数按 turnId 校验滞后，复活不再发生。",
            "**看门狗误判后台任务等待为流中断**：Bash 后台化后进度事件被拦截，回合静默超过 60s 即被判死，长任务被提前掐断。现在服务端活跃回合信号豁免判死，并放宽判死阈值到 ~140s（对合法慢响应更宽容）。",
            "**后台任务识别误报致徽标永久残留**：普通命令的输出里若恰好包含 `background with ID: xxx` 字样（如 git diff/diff 到源码注释），会被误认为后台任务，徽标永久残留。识别判据收紧为「官方动作前缀 + 标准 UUID 形态任务 ID」双条件，占位/短 ID 一律拒绝。"
          ]
        },
        {
          "title": "新增",
          "items": [
            "**后台任务指示器**：工具卡片行内显示「后台运行中」徽标 + 真实运行时间（秒级跳动）；任务完成后徽标变为「后台完成」并定格耗时。连续 Bash 聚组卡头部显示「后台运行中 N 个」计数。",
            "**历史消息静态识别「后台完成」徽标**：重装 IDE 或重载会话后，历史消息中的后台任务也能识别并显示「后台完成」徽标（不计时）。"
          ]
        }
      ]
    },
    "en": {
      "sections": [
        {
          "title": "Fixed",
          "items": [
            "**Qwen model switching repeatedly triggers autocompact**: After switching to Qwen or other custom providers, every request was compressed and slowed down, failing with \"Autocompact stopped\" after 3 consecutive compressions. Root cause: model switching only passed `modelId`, causing the server to overwrite complete model definitions with incomplete ones, zeroing the context window. Now the full definition (context window, max output, capability flags) is carried on switch.",
            "**Compact indicator stuck after turn ends**: `/compact` indicator permanently frozen, next turn showed only a spinner. Root cause: server-side settlement data arrived with ~1.3s lag, \"reviving\" an ended compact turn, whose guard then swallowed the next turn. Readings are now validated against turnId to prevent revival.",
            "**Watchdog falsely flags background task wait as stream interruption**: After `run_in_background` Bash, progress events are intercepted and silence beyond 60s tripped the watchdog, killing long tasks early. Now server-active turn signal exempts the watchdog, and the threshold is relaxed to ~140s (more tolerant of legitimately slow responses).",
            "**Background task false positive leaves permanent badge**: When a command's output happened to contain `background with ID: xxx` (e.g. from grep/diff against source comments), it was treated as a background task and the badge stuck forever. Detection tightened to require both the official action prefix and a standard-UUID task ID; placeholder/short IDs are rejected."
          ]
        },
        {
          "title": "Added",
          "items": [
            "**Background task indicator**: Inline \"Running in background\" badge with live elapsed time (ticks per second) on tool cards; flips to \"Background completed\" with frozen duration when done. Grouped Bash cards show \"N running in background\" count at the header.",
            "**Historical messages static \"Background completed\" badge**: After IDE restart or session reload, past background tasks in message history are also recognized and shown with a static badge (no duration)."
          ]
        }
      ]
    }
  },
  {
    "version": "0.2.3.1",
    "date": "2026-08-25",
    "zh": {
      "sections": [
        {
          "title": "修复",
          "items": [
            "**会话列表兼容新版 ZCode CLI（0.16.5+）**：新版 CLI 不再把工作区路径规范化为系统分隔符后落库，导致重启 IDE 后当天新建的会话从会话列表消失（数据未丢，仅查询不命中）。会话列表查询现同时兼容正/反斜杠两种存储形态，并向后兼容旧版 CLI。",
            "**归档列表跨项目混入**：特定时序下（如 IDE 重启初期）归档列表可能显示其他项目的归档会话。归档查询现强制限定当前项目，不再回退全库。",
            "**会话标题刷新后回退会话 id（会话运行中）**：会话处于运行中时刷新会话列表，标题可能被服务端返回的空值覆盖，回退显示为会话 id 前缀（如 `sess_37b3cf8`），且随会话运行状态反复闪变。现在空标题会沿用上一帧的完整标题，不再闪变；服务端权威标题仍由标题更新事件 / 后续刷新正常生效。",
            "**移除弃用 API 调用**：移除回合结束通知中的弃用 `setListener` 调用（纯文本通知下从不触发的死代码），消除 Marketplace 兼容性校验告警。"
          ]
        }
      ]
    },
    "en": {
      "sections": [
        {
          "title": "Fixed",
          "items": [
            "**Session list compatibility with new ZCode CLI (0.16.5+)**: the new CLI no longer normalizes workspace path separators when persisting sessions, which made newly created sessions disappear from the session list after restarting the IDE (data was intact, only the query missed). The session list now queries both slash forms and stays backward-compatible with older CLIs.",
            "**Cross-project entries in the archived list**: under certain timing (e.g. right after IDE restart), the archived list could show archived sessions from other projects. Archive queries are now hard-scoped to the current project instead of falling back to the whole database.",
            "**Session title falling back to the session id while the session is running**: when a session is active, refreshing the session list could overwrite its title with an empty value from the server, showing the session-id prefix (e.g. `sess_37b3cf8`) and flickering as the session's running state changed. Empty titles now keep the previously known full title instead of flickering; server-authoritative titles still apply via title-updated events / later refreshes.",
            "**Removed a deprecated API call**: removed the deprecated `setListener` call in the turn-end notification (dead code that never fired for plain-text bodies), clearing the Marketplace verifier warning."
          ]
        }
      ]
    }
  },
  {
    "version": "0.2.3",
    "date": "2026-08-24",
    "zh": {
      "sections": [
        {
          "title": "Added",
          "items": [
            "**上下文压缩（/compact）全程可视**：压缩中显示状态提示，完成后生成摘要卡片（书本图标），点击弹窗查看摘要全文",
            "**提示词润色与子智能体引用**：输入框新增「润色」按钮（在独立临时会话中处理，不污染项目会话列表）；`@` 可引用 ZCode 客户端配置的子智能体，子智能体定义与客户端数据互通",
            "**版本更新弹窗（What's New）**：升级后首次启动自动弹窗展示新版本改动，CHANGELOG 随之双语化",
            "**归档与 ZCode 客户端同源**：插件与客户端共用归档索引，支持恢复客户端归档的历史会话",
            "**过程可视化增强**：AI 写入大文件时实时显示流式行数进度；超长用户消息默认折叠、点击查看全文；斜杠下拉按「命令 / 技能」分组",
            "**对话结束通知与浏览器数据管理**：回合完成发送系统通知（可在设置关闭）；内嵌浏览器支持清除浏览数据与查看站点概览"
          ]
        },
        {
          "title": "Fixed",
          "items": [
            "**app-server 进程换代后发消息无限转圈**：CLI 自动升级或重启后订阅簿记失效，现按进程实例自动失效并重新订阅",
            "**计划审批意见反馈错位**：拒绝计划时填写的反馈意见曾钉在流式输出尾部，现固定显示于审批卡之后，后续修订内容自然衔接",
            "**关闭项目后 AI 回合变僵尸自主续跑**：关闭项目窗口时强制停止 app-server 遗留回合",
            "**版本更新弹窗每次重启误弹**：已读标记读取竞态修复，仅在升级后首次启动弹出"
          ]
        }
      ]
    },
    "en": {
      "sections": [
        {
          "title": "Added",
          "items": [
            "**Fully visible context compaction (/compact)**: a status hint shows while compacting, a summary card (book icon) appears when done, and clicking it opens the full summary in a dialog",
            "**Prompt polish & subagent references**: the input box gains a \"Polish\" button (runs in a detached temporary session that never pollutes the project session list); `@` references subagents configured in the ZCode client, with subagent definitions shared with the client",
            "**What's New dialog**: after upgrading, the new version's changes are shown once on first launch; CHANGELOG became bilingual along the way",
            "**Unified archive with the ZCode client**: the plugin and the client share one archive index; sessions archived by the client can be restored inside the plugin",
            "**Richer progress visualization**: streaming line-count progress while the AI writes large files; overlong user messages collapse by default with a full-text dialog; the slash dropdown is grouped into commands / skills",
            "**Turn-finished notifications & browser data management**: a system notification fires when a turn completes (disableable in Settings); the embedded browser supports clearing browsing data and a site overview"
          ]
        },
        {
          "title": "Fixed",
          "items": [
            "**Messages spinning forever after app-server process replacement**: subscription bookkeeping went stale after the CLI auto-upgraded or restarted; it is now invalidated per process instance and re-subscribed automatically",
            "**Plan-review feedback misplaced**: feedback typed when rejecting a plan used to be pinned at the tail of the streaming output; it now sits right after the approval card with subsequent revisions flowing naturally",
            "**Zombie AI turns after closing a project**: closing the project window now forcibly stops leftover app-server turns",
            "**What's New dialog reappearing on every restart**: a read-marker race was fixed; it only shows once after an upgrade"
          ]
        }
      ]
    }
  },
  {
    "version": "0.2.2",
    "date": "2026-08-21",
    "zh": {
      "sections": [
        {
          "title": "Fixed",
          "items": [
            "**子代理完成后状态持续显示「运行中」**：后台子代理完成（或前台子代理返回）后，底部 Agent 标签与聊天区子代理卡片长时间停在转圈状态、直到整个回合结束才刷新——现通过多层完成信号（子会话结束事件 / 权威状态轮询兜底）秒级收口，并修复过期状态快照把「已完成」覆盖回「运行中」的显示回退",
            "**审批/提问弹窗误触导致会话卡死**：弹窗出现期间双击按钮或误触遮罩会触发重复应答，使回合悬挂并接连报错——现弹窗期间按钮防误触、遮罩不再误拒，新增 5 分钟超时倒计时（最后 60 秒红色警示，五语言）；回合终止时自动废弃挂起弹窗，悬挂回合自动停止并恢复重发",
            "**记忆设置文案**：设置页「记忆」条目描述补齐五语言，开关说明去掉 ZCode 客户端菜单路径（插件内无此入口）"
          ]
        },
        {
          "title": "Added",
          "items": [
            "**环境自检增强**：新增内嵌浏览器（browser-use 宿主）健康检测项，异常时顶栏提醒条给出修复入口；macOS 下 Node.js 安装路径免配置自动探测"
          ]
        }
      ]
    },
    "en": {
      "sections": [
        {
          "title": "Fixed",
          "items": [
            "**Subagent status stuck on \"running\" after completion**: after a background subagent finished (or a foreground one returned), the bottom Agent tab and the in-chat subagent card kept spinning until the whole turn ended — completion is now finalized within seconds via multiple signals (child-session end events plus authoritative status polling as a fallback), and a display regression where stale snapshots overwrote \"completed\" back to \"running\" is fixed",
            "**Mis-taps on approval/question dialogs hanging the session**: double-clicking buttons or accidentally hitting the overlay while a dialog was up triggered duplicate responses, hanging the turn and causing cascading errors — buttons are now protected against mis-taps while a dialog is open and the overlay no longer rejects accidentally; a 5-minute timeout countdown was added (red warning in the last 60 seconds, five languages); pending dialogs are discarded automatically when the turn terminates, and hung turns auto-stop and restore for resending",
            "**Memory settings copy**: the Settings \"Memory\" entry now has descriptions in all five languages, and the toggle hint no longer references ZCode client menu paths (which don't exist inside the plugin)"
          ]
        },
        {
          "title": "Added",
          "items": [
            "**Environment check improvements**: new health probe for the embedded browser (browser-use host), with a fix entry point in the top banner when abnormal; Node.js install locations are auto-detected on macOS without manual configuration"
          ]
        }
      ]
    }
  },
  {
    "version": "0.2.1",
    "date": "2026-08-19",
    "zh": {
      "sections": [
        {
          "title": "Fixed",
          "items": [
            "**插件会话的自动记忆（MEMORY.md）从未生效**：`requestRuntimePreferences` 应答被硬编码为全 false，ZCode 客户端开启的「工作区记忆」对插件创建的所有会话一律无效——现与客户端共用 `~/.zcode/v2/setting.json` 同一份配置，设置页「记忆」条目新增「工作区记忆」开关（双向同步、新建会话生效），`nativeSearchEnhancements` / `askUserQuestionAutoResolution` 两项偏好一并恢复跟随客户端配置",
            "**CLI 升级/重启后恢复会话无限转圈自动收尾**：ZCode 桌面端自动更新会杀掉插件依赖的 app-server 进程，恢复后的回合在服务端真实执行但事件流零下发，界面只认终止帧导致无限转圈——新增流式静默对账看门狗（60 秒无事件即静默探测服务端快照），回合已完成自动落地收尾、流丢失自动收尾并提示重发",
            "**冷会话发送失败自动恢复**：send 撞 `-32004 Session is not active`（升级/重启后新进程未激活会话）时自动 resume 后重试一次，不再需要手动从历史记录重开；该错误同时追加中文提示与操作引导（五语言）"
          ]
        }
      ]
    },
    "en": {
      "sections": [
        {
          "title": "Fixed",
          "items": [
            "**Automatic memory (MEMORY.md) never took effect for plugin sessions**: the `requestRuntimePreferences` response was hard-coded to all false, so \"workspace memory\" enabled in the ZCode client was ignored by every session the plugin created — the plugin now shares the same `~/.zcode/v2/setting.json` as the client, the Settings \"Memory\" entry gained a \"Workspace memory\" toggle (two-way sync, applied to newly created sessions), and the `nativeSearchEnhancements` / `askUserQuestionAutoResolution` preferences follow the client configuration again",
            "**Restored sessions spinning forever after CLI upgrade/restart now settle automatically**: the ZCode desktop app's auto-update kills the app-server process the plugin depends on; restored turns actually ran on the server but emitted zero events, leaving the UI spinning forever because it only accepted terminal frames — a streaming-silence watchdog was added (silently probes the authoritative server snapshot after 60 seconds without events): completed turns are finalized automatically, and lost streams are closed with a resend hint",
            "**Automatic recovery for cold-session send failures**: when send hits `-32004 Session is not active` (the new process hasn't activated the session after upgrade/restart), the plugin now resumes once and retries automatically instead of requiring a manual reopen from history; the error also gains a localized hint with guidance (five languages)"
          ]
        }
      ]
    }
  },
  {
    "version": "0.2.0",
    "date": "2026-08-18",
    "zh": {
      "sections": [
        {
          "title": "对话",
          "items": [
            "流式输出：思考过程 / 正文 / 工具调用实时渲染，Markdown / Mermaid / 代码高亮",
            "思考耗时统计、消息排队（生成中回车自动排队，排队卡片可立即发送 / 删除）",
            "Ctrl+F 会话内搜索（大小写 / 整词 / 正则）、消息锚点导航（用户消息圆点定位 + hover 预览）"
          ]
        },
        {
          "title": "多任务",
          "items": [
            "多标签页并行会话（每标签独立上下文互不串扰），重启 IDE 自动恢复",
            "会话列表 / 重命名 / 搜索 / 批量多选删除"
          ]
        },
        {
          "title": "过程可视",
          "items": [
            "任务清单（TodoWrite）实时进度",
            "子代理（Agent）面板与执行过程 / 最终报告弹窗",
            "文件改动统计（点击在编辑器打开、行内 diff 前后对比）",
            "AskUserQuestion 交互弹窗、计划模式（ExitPlanMode）审批弹窗"
          ]
        },
        {
          "title": "内嵌浏览器 · browser-use 宿主",
          "items": [
            "Header 一键在聊天区右侧展开浏览器分栏：多 tab（全局共享、跨会话沿用）、后退 / 前进 / 刷新 / 地址栏 / 自由尺寸 / DevTools / 外部打开",
            "插件作为宿主实现 ZCode app-server 的 browser-use 反向协议（`interaction/browserList` / `browserExecute`），AI 的浏览器工具零配置落到内嵌 JCEF 浏览器执行",
            "导航与采集：newTab / navigate / screenshot / evaluate，截图直接回传模型",
            "playwright 定位器透传：getByRole / getByText / label / testid / and / or / nth / css 链等选择器引擎，ARIA 树 DOM 快照供 AI 读取",
            "CUA 鼠标键盘：坐标点击 / 输入 / 拖拽 / 滚动 / 组合按键，JS 对话框自动挂起处理",
            "tab 生命周期：markDeliverable / markHandoff / finalize 标记与回读，tab.close 真关闭",
            "自由尺寸：DevTools 设备工具栏形态——虚拟屏居中信箱、缩放档、尺寸持久化",
            "playwright 能力不可用时优雅降级（title / get_visible_dom / screenshot 组合），链路始终可用"
          ]
        },
        {
          "title": "运行时控制",
          "items": [
            "模型下拉切换、权限模式（build / edit / plan / yolo）与思考级别（随模型动态）调整",
            "待命态（未建会话）可预选模式与思考级别，建会话即生效",
            "上下文容量圆环（含用量构成与缓存命中）、5 小时 / 每周额度查询"
          ]
        },
        {
          "title": "设置中心",
          "items": [
            "七页签：基础（主题 / 字体 / 语言 / 自定义配色 + 环境路径）、模型（provider 分组只读清单，路径跟随数据目录迁移）、用量（额度卡片 + 模型 / 工具用量曲线与明细表）、记忆（AGENTS.md 指令记忆 + 自动记忆）、技能（全局 / 项目 / 插件三来源扫描，行内启用禁用）、MCP（服务器清单 / 工具列表 / 连接日志）、其他（输入历史补全开关与历史记录管理）"
          ]
        },
        {
          "title": "环境检测",
          "items": [
            "启动自检 Node.js（≥18）/ ZCode CLI / 登录凭证三件套，异常时顶栏提醒条逐项给出修复入口与重新检测",
            "路径可手动配置，留空自动探测；Windows 下 CLI 自动探测覆盖单用户安装（`%LOCALAPPDATA%\\Programs\\ZCode`）与全局安装（`%ProgramFiles%\\ZCode`、`%ProgramFiles(x86)%\\ZCode`）三类位置"
          ]
        },
        {
          "title": "IDE 集成",
          "items": [
            "项目视图 / 编辑器标签右键发送文件、编辑器右键发送选中代码到输入框（Ctrl+Alt+K）、复制选区引用（路径 + 行号）",
            "文件、记忆、技能、MCP 配置均可一键在编辑器打开"
          ]
        },
        {
          "title": "输入增强",
          "items": [
            "`@` 引用文件（chip + 补全，粘贴绝对路径自动转 chip）、`/` 调用技能、长文本粘贴折叠",
            "输入历史回溯与前缀幽灵补全（Tab 采纳）；单条历史长度上限 2000 字符，避免超长内容撑爆存储"
          ]
        },
        {
          "title": "多语言",
          "items": [
            "简体中文 / English / 日本語 / 한국어 / 繁體中文，跟随 IDE 界面语言自动切换"
          ]
        },
        {
          "title": "兼容性",
          "items": [
            "IntelliJ Platform 2024.1 ~ 2026.3（sinceBuild 241 / untilBuild 263.*），JDK 17",
            "2026.2 起 JCEF API 剥离为独立捆绑插件，已声明可选依赖 `com.intellij.modules.jcef` 兼容"
          ]
        }
      ],
      "intro": "首个稳定发布版本。把 [ZCode](https://zcode.z.ai/cn) 编码助手带进 JetBrains IDE：不切终端、不离开编辑器，会话、对话、模型与任务管理都在一个工具窗口里完成，AI 的 browser-use 还能直接驱动插件内嵌浏览器干活。\n> 社区第三方插件，与 ZCode / Z.ai 官方无关。使用前需本机安装 ZCode CLI 并完成登录。"
    },
    "en": {
      "sections": [
        {
          "title": "Conversation",
          "items": [
            "Streaming output: reasoning / text / tool calls rendered live, with Markdown / Mermaid / syntax highlighting",
            "Reasoning-time tracking and message queuing (press Enter while generating to queue; queued cards can be sent or deleted immediately)",
            "Ctrl+F in-conversation search (case / whole word / regex) and message anchor navigation (dot markers on user messages with hover preview)"
          ]
        },
        {
          "title": "Multitasking",
          "items": [
            "Multi-tab parallel sessions (each tab has its own isolated context), auto-restored on IDE restart",
            "Session list / rename / search / multi-select bulk delete"
          ]
        },
        {
          "title": "Process visibility",
          "items": [
            "TodoWrite checklist with live progress",
            "Subagent (Agent) panel with execution process and final-report dialog",
            "File-change stats (click to open in editor, inline before/after diff)",
            "AskUserQuestion interactive dialog and plan-mode (ExitPlanMode) approval dialog"
          ]
        },
        {
          "title": "Embedded browser · browser-use host",
          "items": [
            "One click in the header opens a browser pane beside the chat: multiple tabs (globally shared across sessions), back / forward / reload / address bar / free sizing / DevTools / open externally",
            "The plugin acts as the host implementing ZCode app-server's browser-use reverse protocol (`interaction/browserList` / `browserExecute`), so AI browser tools land in the embedded JCEF browser with zero configuration",
            "Navigation & capture: newTab / navigate / screenshot / evaluate; screenshots go straight back to the model",
            "Playwright locator pass-through: getByRole / getByText / label / testid / and / or / nth / css chains and other selector engines; ARIA-tree DOM snapshots for the AI to read",
            "CUA mouse & keyboard: coordinate clicks / typing / drag / scroll / key combos, with JS dialogs auto-suspended and handled",
            "Tab lifecycle: markDeliverable / markHandoff / finalize flags with readback, tab.close really closes",
            "Free sizing: DevTools device-toolbar style — centered letterboxed virtual screen, zoom steps, persisted size",
            "Graceful degradation when Playwright capabilities are unavailable (title / get_visible_dom / screenshot combo), keeping the pipeline usable"
          ]
        },
        {
          "title": "Runtime control",
          "items": [
            "Model dropdown switching, permission mode (build / edit / plan / yolo) and thinking level (model-dependent) adjustment",
            "Standby state (no session yet) can preselect mode and thinking level, applied when the session is created",
            "Context-capacity ring (with usage breakdown and cache hits), 5-hour / weekly quota lookup"
          ]
        },
        {
          "title": "Settings hub",
          "items": [
            "Seven tabs: Basic (theme / font / language / custom colors + env paths), Models (read-only provider-grouped list, path follows the data directory), Usage (quota cards + model / tool usage charts and detail tables), Memory (AGENTS.md instruction memory + automatic memory), Skills (global / project / plugin source scanning with inline enable/disable), MCP (server list / tool list / connection logs), Other (input-history completion toggle and history management)"
          ]
        },
        {
          "title": "Environment check",
          "items": [
            "Startup self-check for Node.js (≥18) / ZCode CLI / login credentials; the top banner lists per-item fix entry points and re-check when abnormal",
            "Paths are manually configurable or auto-detected when left empty; on Windows, CLI auto-detection covers per-user installs (`%LOCALAPPDATA%\\Programs\\ZCode`) and machine-wide installs (`%ProgramFiles%\\ZCode`, `%ProgramFiles(x86)%\\ZCode`)"
          ]
        },
        {
          "title": "IDE integration",
          "items": [
            "Right-click a file in Project View / editor tab to send it, right-click a selection in the editor to send code to the input box (Ctrl+Alt+K), copy a selection reference (path + line numbers)",
            "Files, memory, skills and MCP configs all open in the editor with one click"
          ]
        },
        {
          "title": "Input enhancements",
          "items": [
            "`@` file references (chips + completion, pasted absolute paths auto-convert to chips), `/` to invoke skills, long-paste folding",
            "Input history recall and prefix ghost completion (Tab to accept); per-entry history capped at 2000 characters to keep storage lean"
          ]
        },
        {
          "title": "Localization",
          "items": [
            "简体中文 / English / 日本語 / 한국어 / 繁體中文, following the IDE UI language automatically"
          ]
        },
        {
          "title": "Compatibility",
          "items": [
            "IntelliJ Platform 2024.1 ~ 2026.3 (sinceBuild 241 / untilBuild 263.*), JDK 17",
            "Since 2026.2 the JCEF APIs are split into a standalone bundled plugin; an optional `com.intellij.modules.jcef` dependency keeps compatibility"
          ]
        }
      ],
      "intro": "First stable release. Brings the [ZCode](https://zcode.z.ai/cn) coding assistant into JetBrains IDEs: no terminal switching, no leaving the editor — sessions, conversations, models and task management all live in one tool window, and the AI's browser-use can drive the plugin's embedded browser directly.\n> Community third-party plugin, not affiliated with ZCode / Z.ai. Install the ZCode CLI locally and sign in before use."
    }
  }
]
