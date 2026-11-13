/**
 * $ 技能提及文本形态的唯一来源（对齐 sessionRefPattern 的收口原则：
 * 序列化/识别正则被 inlineFileTags（输入框内联 chip）与 userRefChips（消息只读
 * chip）共享，单一来源防双份手写漂移）。
 *
 * 官方客户端同款双形态（mentionMarkdown.ts）：
 *   1. markdown 链接 [$名称](技能路径) —— 选自 $ 面板的 chip 序列化产物，路径
 *      指向技能目录（模型据此可读 SKILL.md）；label 是转义后的 $名称。
 *   2. 词边界裸 token $名称 —— 无路径技能的退化形态，也是官方解析器的合法输入。
 * 触发符 $ / ¥ / ￥ 归一（部分键盘/输入法输出全角），对齐官方 promptInputTriggers。
 */

/** 技能名的字符集（对齐 SlashCommand.name：字母开头 + 字母数字._:-，含插件命名空间冒号）*/
const SKILL_NAME_PATTERN = String.raw`[A-Za-z][A-Za-z0-9._:-]*`

/**
 * $ 技能提及补全触发判定：光标前文本命中「未完成的 $query」时返回 query，否则 null。
 * 对齐官方 ACTIVE_TRIGGER_RE：$ 前须行首或空白（成本$100 这类粘连不触发）；
 * ¥/￥ 归一为 $ 语义；query 不含其他触发字符（/@$#¥￥）与空白。
 * 防误判两条：
 *   1. $ 后紧跟空白/结尾 = 裸 $（变量引用行文），不触发（query 空时面板仍可弹出——
 *      由调用方决定，本函数返回空串表示「触发但无过滤词」，与 # 会话引用语义一致）；
 *   2. query 是纯数字（$5 金额）不触发——技能名须字母开头。
 */
export function matchSkillRefTrigger(beforeCursor: string): string | null {
  const m = beforeCursor.match(/(^|\s)([$¥￥])([^\s$¥￥/]*)$/)
  if (!m) return null
  const query = m[3] ?? ''
  // 纯数字（金额）与空 query 后跟数字直接不弹面板；空 query（刚敲 $）正常触发
  if (query !== '' && !/^[A-Za-z]/.test(query)) return null
  return query
}

/** markdown 技能链接：label 为转义的 $名称（序列化会转义 \ [ ]），destination 任意路径。
 *  捕获组：1=$ 符号，2=名称（不含 $，转义未解码），3=destination（未解码）*/
export const SKILL_MD_RE = new RegExp(
  String.raw`\[(\$)((?:\\.|[^\]])*)\]\(((?:\\.|[^)])*)\)`,
  'g',
)

/** 词边界裸 token（$名称）。仅配已知技能名白名单使用（$5/成本$100 防误伤），
 *  捕获组：1=边界前缀，2=名称（不含 $，消费方算 end 时自行 +1 补 $）*/
export const SKILL_BARE_RE = new RegExp(
  String.raw`(^|[\s\u4e00-\u9fa5])\$(${SKILL_NAME_PATTERN})(?=$|[\s\u4e00-\u9fa5])`,
  'g',
)

/** markdown 链接 label / destination 的转义（官方 escapeMarkdownLabel/Destination 同款：
 *  label 转 \ [ ]，destination 转 \ >；路径里的 \ 必须转义否则链接被反斜杠吞掉）*/
export function escapeSkillMdLabel(label: string): string {
  return label.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]')
}

export function escapeSkillMdDestination(destination: string): string {
  return destination.replace(/\\/g, '\\\\').replace(/>/g, '\\>')
}

/** 上述转义的逆操作（回显解析用）*/
export function unescapeSkillMd(text: string): string {
  return text.replace(/\\(.)/g, '$1')
}

/** 技能提及的发送文本：有路径走 markdown 链接，无路径退化裸 token（官方 buildSkillMentionMarkdown 同构）*/
export function skillRefText(name: string, path?: string): string {
  if (!path) return `$${name}`
  return `[$${escapeSkillMdLabel(name)}](${escapeSkillMdDestination(path)})`
}

/**
 * 技能 chip 的展示短名：剥掉插件命名空间前缀（mattpocock-skills:grill-with-docs →
 * grill-with-docs），对齐官方客户端 chip 只显叶子名；全名保留在 data-tip 悬浮兜底。
 * 仅对 kind=skill 的名字使用——用户自建命令的冒号是嵌套目录名本身（review:code），
 * 剥了会丢语义；用户自建技能无冒号（scanSkillDir 不加命名空间），天然不受影响。
 * 序列化仍走全名（data-cmd），此处只管展示层。
 */
export function skillShortName(name: string): string {
  const i = name.indexOf(':')
  return i >= 0 ? name.slice(i + 1) : name
}
