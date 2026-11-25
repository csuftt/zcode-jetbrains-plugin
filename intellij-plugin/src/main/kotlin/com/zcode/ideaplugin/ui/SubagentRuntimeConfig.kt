package com.zcode.ideaplugin.ui

import com.zcode.ideaplugin.protocol.Credentials
import com.intellij.openapi.diagnostic.Logger
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.text.Collator
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put

/**
 * 子代理 Markdown 的官方解析器移植（ZCode 开源 v4.0.0，CLI 与桌面端共用同一份实现：
 * packages/shared/src/subagent-profile-frontmatter.ts、subagent-profile-parser.ts、
 * subagent-markdown-selection.ts、custom-model-value.ts）。逐函数对应、行为等价。
 *
 * 为什么必须是移植而不是复用 [AgentScanner] 的展示用解析：插件经
 * subagents/readRuntimeConfig 接管运行时的子代理配置来源后，这里就是用户级/项目级
 * 定义的唯一解析方——运行时不再自己读文件，任何偏差都会静默改变子代理行为
 * （丢字段、工具清单走样、model 解析错位）。展示用解析（设置页卡片）只求可读，
 * 两者的忠实度要求不同，不合并。
 *
 * JS 语义对照点在各函数注释里标明（trim 的空白集、slice(1,-1)、正则锚点）。
 */
internal object SubagentMarkdown {

    // ---- JS 语义小工具 ----

    /** JS `\s` 的完整字符集（WhiteSpace + LineTerminator）；Kotlin/Java 的 `\s` 与 isWhitespace 都不是它 */
    private const val JS_SPACE = "\\u0009\\u000A\\u000B\\u000C\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF"

    private val JS_SPACE_SET = (listOf(
        '\u0009', '\u000A', '\u000B', '\u000C', '\u000D', '\u0020', '\u00A0', '\u1680',
        '\u2028', '\u2029', '\u202F', '\u205F', '\u3000', '\uFEFF',
    ) + ('\u2000'..'\u200A')).toSet()

    private fun isJsSpace(c: Char) = c in JS_SPACE_SET

    /** JS String.prototype.trim */
    fun trim(s: String): String = s.dropWhile { isJsSpace(it) }.dropLastWhile { isJsSpace(it) }

    private fun String.jsTrim() = trim(this)
    private fun String.jsTrimEnd() = dropLastWhile { isJsSpace(it) }
    private fun String.jsTrimStart() = dropWhile { isJsSpace(it) }

    /** JS `slice(1, -1)`：长度为 1 时得空串（Kotlin `substring(1, 0)` 会抛） */
    private fun String.inner() = substring(1, maxOf(1, length - 1))

    private fun isQuoted(v: String) =
        (v.startsWith("\"") && v.endsWith("\"")) || (v.startsWith("'") && v.endsWith("'"))

    // 锚点一律用 ^ 与 \z：JS 不带 m 标志的 `$` 只匹配串尾，而 Java 的 `$` 还匹配在末尾行终止符之前
    private val LIST_ITEM = Regex("^[$JS_SPACE]*-[$JS_SPACE]+(.*)\\z")
    private val INDENTED = Regex("^[$JS_SPACE]+")
    private val KEY_VALUE = Regex("^([A-Za-z][A-Za-z0-9_-]*)[$JS_SPACE]*:[$JS_SPACE]*(.*)\\z")
    private val DIGITS = Regex("[0-9]+")
    private val MCP_NULL = Regex("null|~", RegexOption.IGNORE_CASE)
    private val MCP_BOOL = Regex("true|false", RegexOption.IGNORE_CASE)
    private val MCP_NUMBER = Regex("[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:e[+-]?[0-9]+)?", RegexOption.IGNORE_CASE)
    private val MAPPING_VALUE = Regex("^[^:]+:(?:[$JS_SPACE]|\\z)")
    private val SPACE_OR_COMMA = Regex("[$JS_SPACE,]+")

    val VALID_COLORS = setOf("red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan")
    val VALID_PERMISSION_MODES = setOf("acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan")
    private val VALID_MEMORY_SCOPES = setOf("user", "project", "local")

    /**
     * frontmatter 值（JS 值域的子集）：键缺失用 Kotlin null 表示。
     * [Arr] 的元素可为 null（JS null，仅 mcpServers 列表项会产出）。
     */
    private sealed class V {
        class Str(val value: String) : V()
        class Bool(val value: Boolean) : V()
        class Num(val value: Double) : V()
        class Arr(val items: List<V?>) : V()
        class Obj(val value: JsonObject) : V()
    }

    /** mcpServers 的三态：未配置 / 配置非法 / 合法的 server 名单 */
    private sealed class Mcp {
        object Absent : Mcp()
        object Invalid : Mcp()
        class Names(val names: List<String>) : Mcp()
    }

    class Diagnostic(val code: String, val message: String, val path: String?)

    class Parsed(val diagnostic: Diagnostic?, val profile: JsonObject?)

    // ============ subagent-profile-frontmatter.ts ============

    /** splitMarkdownFrontmatter：返回 (frontmatter?, body) */
    fun splitMarkdownFrontmatter(content: String): Pair<String?, String> {
        val normalized = content.removePrefix("\uFEFF")
        if (!normalized.startsWith("---")) return null to normalized
        // JS split(/\r?\n/)：只切 \n 与 \r\n，孤立的 \r 留在行内
        val lines = normalized.split("\n").map { it.removeSuffix("\r") }
        if (lines.firstOrNull()?.jsTrim() != "---") return null to normalized
        val endIndex = lines.indices.firstOrNull { it > 0 && lines[it].jsTrim() == "---" }
            ?: return null to normalized
        return lines.subList(1, endIndex).joinToString("\n") to lines.drop(endIndex + 1).joinToString("\n")
    }

    private class Loose(
        val bareValueKeys: MutableSet<String>,
        val invalidNestedListKeys: MutableSet<String>,
        val values: LinkedHashMap<String, V>,
    )

    /** parseLooseFrontmatter：宽松的 key: value / 块列表 / 内联列表解析，不认 YAML 嵌套 */
    private fun parseLooseFrontmatter(frontmatter: String): Loose {
        val bareValueKeys = mutableSetOf<String>()
        val invalidNestedListKeys = mutableSetOf<String>()
        val values = LinkedHashMap<String, V>()
        var pendingListKey: String? = null

        for (rawLine in frontmatter.split("\n").map { it.removeSuffix("\r") }) {
            val line = rawLine.jsTrimEnd()
            if (line.jsTrim().isEmpty() || line.jsTrimStart().startsWith("#")) continue

            val listMatch = LIST_ITEM.find(line)
            val listKey = pendingListKey
            if (listMatch != null && listKey != null) {
                bareValueKeys.remove(listKey)
                val rawListItem = listMatch.groupValues[1]
                if (listKey == "mcpServers" && isUnquotedMappingValue(rawListItem)) {
                    invalidNestedListKeys.add(listKey)
                }
                val existing = (values[listKey] as? V.Arr)?.items ?: emptyList()
                values[listKey] = V.Arr(
                    existing + (if (listKey == "mcpServers") parseMcpServerListItem(rawListItem) else parseScalarValue(rawListItem)),
                )
                continue
            }

            if (listKey != null && INDENTED.containsMatchIn(rawLine)) {
                // 块状 mapping 不是 server-name 列表，不能被空数组吞掉后扩大 child MCP scope
                invalidNestedListKeys.add(listKey)
                pendingListKey = null
                continue
            }

            pendingListKey = null
            val keyValue = KEY_VALUE.find(line) ?: continue
            val key = keyValue.groupValues[1]
            val rawValue = keyValue.groupValues[2]
            if (rawValue.jsTrim().isEmpty()) {
                values[key] = V.Arr(emptyList())
                bareValueKeys.add(key)
                pendingListKey = key
                continue
            }
            if (key == "mcpServers" && hasUnquotedInlineMappingItem(rawValue)) {
                invalidNestedListKeys.add(key)
            }
            values[key] = parseScalarValue(rawValue, key == "mcpServers")
        }
        return Loose(bareValueKeys, invalidNestedListKeys, values)
    }

    /** parseAgentFrontmatter：裸 `tools:`（无列表项）等于未声明；mcpServers 单独做合法性裁决 */
    private fun parseAgentFrontmatter(frontmatter: String): Pair<Map<String, V>, Mcp> {
        val loose = parseLooseFrontmatter(frontmatter)
        if (loose.bareValueKeys.contains("tools")) loose.values.remove("tools")
        val mcp = parseMcpServerNames(
            loose.values["mcpServers"],
            loose.values.containsKey("mcpServers"),
            loose.bareValueKeys.contains("mcpServers"),
            loose.invalidNestedListKeys.contains("mcpServers"),
        )
        return loose.values to mcp
    }

    private fun parseMcpServerNames(value: V?, isConfigured: Boolean, hasBareValue: Boolean, hasInvalidNestedValue: Boolean): Mcp {
        if (!isConfigured) return Mcp.Absent
        if (value !is V.Arr || hasBareValue || hasInvalidNestedValue) return Mcp.Invalid
        val names = ArrayList<String>()
        for (item in value.items) {
            val name = (item as? V.Str)?.value?.jsTrim() ?: return Mcp.Invalid
            if (name.isEmpty()) return Mcp.Invalid
            names.add(name)
        }
        return Mcp.Names(names)
    }

    private fun hasUnquotedInlineMappingItem(rawValue: String): Boolean {
        val value = stripInlineComment(rawValue.jsTrim())
        if (!value.startsWith("[") || !value.endsWith("]")) return false
        return splitTopLevelList(value.inner(), trackContainerDepth = true).any { isUnquotedMappingValue(it) }
    }

    private fun isUnquotedMappingValue(rawValue: String): Boolean {
        val value = stripInlineComment(rawValue.jsTrim())
        if (isQuoted(value)) return false
        return (value.startsWith("{") && value.endsWith("}")) || MAPPING_VALUE.containsMatchIn(value)
    }

    private fun parseMcpServerListItem(rawValue: String): V? {
        val value = stripInlineComment(rawValue.jsTrim())
        if (isQuoted(value)) return V.Str(unquoteScalar(value))
        if (value.startsWith("[") && value.endsWith("]")) return null
        if (MCP_NULL.matches(value)) return null
        if (MCP_BOOL.matches(value)) return V.Bool(value.lowercase() == "true")
        if (MCP_NUMBER.matches(value)) return V.Num(value.toDouble())
        return V.Str(value)
    }

    private fun parseScalarValue(rawValue: String, parseInlineItemScalars: Boolean = false): V {
        val value = stripInlineComment(rawValue.jsTrim())
        if (value == "true") return V.Bool(true)
        if (value == "false") return V.Bool(false)
        if (DIGITS.matches(value)) return V.Num(value.toDouble())
        if (value.startsWith("[") && value.endsWith("]")) {
            return V.Arr(
                splitTopLevelList(value.inner(), parseInlineItemScalars, parseInlineItemScalars).map { item ->
                    if (parseInlineItemScalars) parseMcpServerListItem(item)
                    else V.Str(unquoteScalar(stripInlineComment(item.jsTrim())))
                },
            )
        }
        if (value.startsWith("{") && value.endsWith("}")) {
            return try {
                // JS JSON.parse 是严格 JSON：先过语法校验（kotlinx 的 parseToJsonElement 对裸字面量
                // 是宽松的，`{"a": 1e}` 之类它照收），不合法时整个值退回字符串
                if (!StrictJson(value).isValid()) V.Str(value)
                else fromJsonValue(Json.parseToJsonElement(value)) ?: V.Str(value)
            } catch (_: Exception) {
                V.Str(value)
            }
        }
        return V.Str(unquoteScalar(value))
    }

    /**
     * JSON.parse 的语法校验（RFC 8259，无扩展）：只认四类空白、带引号的键与字符串、
     * 严格数字字面量，不许尾逗号、单引号、裸字面量、未转义的控制字符。
     */
    private class StrictJson(private val text: String) {
        private var pos = 0

        fun isValid(): Boolean {
            skipWs()
            if (!value()) return false
            skipWs()
            return pos == text.length
        }

        private fun skipWs() {
            while (pos < text.length && (text[pos] == ' ' || text[pos] == '\t' || text[pos] == '\n' || text[pos] == '\r')) pos++
        }

        private fun eat(c: Char): Boolean {
            if (pos >= text.length || text[pos] != c) return false
            pos++
            return true
        }

        private fun lit(word: String): Boolean {
            if (!text.regionMatches(pos, word, 0, word.length)) return false
            pos += word.length
            return true
        }

        private fun string(): Boolean {
            if (!eat('"')) return false
            while (pos < text.length) {
                val c = text[pos++]
                if (c == '"') return true
                if (c == '\\') {
                    if (pos >= text.length) return false
                    when (text[pos++]) {
                        '"', '\\', '/', 'b', 'f', 'n', 'r', 't' -> {}
                        'u' -> {
                            if (pos + 4 > text.length) return false
                            for (i in 0 until 4) if (asciiHex(text[pos + i]) < 0) return false
                            pos += 4
                        }
                        else -> return false
                    }
                } else if (c < ' ') {
                    return false
                }
            }
            return false
        }

        private fun number(): Boolean {
            eat('-')
            when {
                eat('0') -> {}
                pos < text.length && text[pos] in '1'..'9' -> { pos++; digits() }
                else -> return false
            }
            if (eat('.')) {
                if (pos >= text.length || text[pos] !in '0'..'9') return false
                digits()
            }
            if (pos < text.length && (text[pos] == 'e' || text[pos] == 'E')) {
                pos++
                if (pos < text.length && (text[pos] == '+' || text[pos] == '-')) pos++
                if (pos >= text.length || text[pos] !in '0'..'9') return false
                digits()
            }
            return true
        }

        private fun digits() {
            while (pos < text.length && text[pos] in '0'..'9') pos++
        }

        private fun value(): Boolean {
            if (pos >= text.length) return false
            return when (text[pos]) {
                '"' -> string()
                '{' -> objectValue()
                '[' -> arrayValue()
                't' -> lit("true")
                'f' -> lit("false")
                'n' -> lit("null")
                else -> number()
            }
        }

        private fun objectValue(): Boolean {
            pos++ // {
            skipWs()
            if (eat('}')) return true
            do {
                if (!string()) return false
                skipWs()
                if (!eat(':')) return false
                skipWs()
                if (!value()) return false
                skipWs()
            } while (eat(',') && { skipWs(); true }())
            return eat('}')
        }

        private fun arrayValue(): Boolean {
            pos++ // [
            skipWs()
            if (eat(']')) return true
            do {
                if (!value()) return false
                skipWs()
            } while (eat(',') && { skipWs(); true }())
            return eat(']')
        }
    }

    /** JSON.parse 结果 → [V]（数组仍按数组对待，供后续 Array.isArray 判断） */
    private fun fromJsonValue(el: JsonElement): V? = when (el) {
        is JsonNull -> null
        is JsonObject -> V.Obj(el)
        is JsonArray -> V.Arr(el.map { fromJsonValue(it) })
        is JsonPrimitive -> when {
            el.isString -> V.Str(el.content)
            el.booleanOrNull != null -> V.Bool(el.booleanOrNull == true)
            el.doubleOrNull != null -> V.Num(el.doubleOrNull!!)
            else -> V.Str(el.content)
        }
        else -> V.Str(el.toString())
    }

    private fun stripInlineComment(value: String): String {
        var quote: Char? = null
        for (index in value.indices) {
            val char = value[index]
            val prev = if (index > 0) value[index - 1] else Char(0)
            if ((char == '"' || char == '\'') && prev != '\\') {
                quote = if (quote == char) null else (quote ?: char)
            }
            if (quote == null && char == '#' && index > 0 && isJsSpace(prev)) {
                return value.substring(0, index).jsTrimEnd()
            }
        }
        return value
    }

    /** unquoteScalar：单字符的引号同样被 JS 判为「两端都是引号」，slice 后得空串 */
    private fun unquoteScalar(value: String): String = if (isQuoted(value)) value.inner() else value

    /** splitTopLevelList：按顶层逗号切分，括号/引号内的逗号不切 */
    private fun splitTopLevelList(
        value: String,
        trackContainerDepth: Boolean = false,
        preserveEmptyItems: Boolean = false,
    ): List<String> {
        val items = ArrayList<String>()
        val current = StringBuilder()
        var quote: Char? = null
        var braceDepth = 0
        var bracketDepth = 0
        var parenDepth = 0
        for (char in value) {
            if ((char == '"' || char == '\'') && quote == null) {
                quote = char
                current.append(char)
                continue
            }
            if (quote == char) {
                quote = null
                current.append(char)
                continue
            }
            if (char == '(') parenDepth += 1
            if (char == ')') parenDepth = maxOf(0, parenDepth - 1)
            if (trackContainerDepth && char == '{') braceDepth += 1
            if (trackContainerDepth && char == '}') braceDepth = maxOf(0, braceDepth - 1)
            if (trackContainerDepth && char == '[') bracketDepth += 1
            if (trackContainerDepth && char == ']') bracketDepth = maxOf(0, bracketDepth - 1)
            if (quote == null && parenDepth == 0 && braceDepth == 0 && bracketDepth == 0 && char == ',') {
                if (current.toString().jsTrim().isNotEmpty() || preserveEmptyItems) items.add(current.toString().jsTrim())
                current.setLength(0)
                continue
            }
            current.append(char)
        }
        if (current.toString().jsTrim().isNotEmpty()) items.add(current.toString().jsTrim())
        return items
    }

    // ============ subagent-markdown-selection.ts ============

    private val INHERIT_NAMES = setOf("inherit", "main", "sonnet", "opus", "haiku")

    /**
     * parseSubagentMarkdownSelection：正式字段始终是字符串 model + thoughtLevel。
     * model 三种形态：`providerId/modelId`（可带 `$档位`）、`custom:<编码 provider>:<编码 model>`、
     * 以及不产生覆盖的继承名。档位取 thoughtLevel（非空字符串时），否则保留 picker 值
     * 自带的 `$档位`。
     */
    private fun parseMarkdownSelection(frontmatter: Map<String, V>): JsonObject? {
        val model = (frontmatter["model"] as? V.Str)?.value ?: return null
        val value = model.jsTrim()
        if (value.isEmpty() || value in INHERIT_NAMES) return null
        val providerId: String
        val modelId: String
        var pickerLevel: String? = null
        val custom = decodeCustomModelValue(value)
        if (custom != null) {
            providerId = custom.providerId.jsTrim()
            modelId = custom.modelName?.jsTrim() ?: return null
            if (providerId.isEmpty() || modelId.isEmpty()) return null
        } else {
            val parsed = parseModelPickerValue(value) ?: return null
            providerId = parsed.first
            modelId = parsed.second
            pickerLevel = parsed.third
        }
        val reasoningLevel = (frontmatter["thoughtLevel"] as? V.Str)?.value?.jsTrim() ?: ""
        return modelSelectionJson(providerId, modelId, reasoningLevel.ifEmpty { pickerLevel })
    }

    private class DecodedCustom(val providerId: String, val modelName: String?)

    /** decodeCustomModelValue */
    private fun decodeCustomModelValue(value: String): DecodedCustom? {
        if (!value.startsWith("custom:")) return null
        val body = value.removePrefix("custom:")
        val separatorIndex = body.indexOf(':')
        if (separatorIndex < 0) return DecodedCustom(safeDecodeUriComponent(body), null)
        val legacyParts = body.split(":")
        if (legacyParts.size >= 3 && legacyParts[0] == "builtin") {
            return DecodedCustom("builtin:" + legacyParts[1], safeDecodeUriComponent(legacyParts.drop(2).joinToString(":")))
        }
        return DecodedCustom(
            safeDecodeUriComponent(body.substring(0, separatorIndex)),
            safeDecodeUriComponent(body.substring(separatorIndex + 1)),
        )
    }

    /** decodeURIComponent 的等价实现：百分号序列只认 ASCII 十六进制，序列不完整、含落单代理项
     *  或 UTF-8 非法时抛错（调用方回落原串；Character.digit 会放行非 ASCII 数字，不能用） */
    private fun decodeUriComponent(value: String): String {
        if (!value.contains('%')) return value
        val bytes = java.io.ByteArrayOutputStream()
        var index = 0
        while (index < value.length) {
            val char = value[index]
            if (char == '%') {
                if (index + 2 >= value.length) throw IllegalArgumentException("URI malformed")
                val hi = asciiHex(value[index + 1])
                val lo = asciiHex(value[index + 2])
                if (hi < 0 || lo < 0) throw IllegalArgumentException("URI malformed")
                bytes.write((hi shl 4) or lo)
                index += 3
            } else {
                if (Character.isHighSurrogate(char)) {
                    if (index + 1 >= value.length || !Character.isLowSurrogate(value[index + 1])) {
                        throw IllegalArgumentException("URI malformed")
                    }
                } else if (Character.isLowSurrogate(char)) {
                    throw IllegalArgumentException("URI malformed")
                }
                val cp = value.codePointAt(index)
                val encoded = String(Character.toChars(cp)).toByteArray(Charsets.UTF_8)
                bytes.write(encoded, 0, encoded.size)
                index += Character.charCount(cp)
            }
        }
        return Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes.toByteArray())).toString()
    }

    private fun asciiHex(c: Char): Int = when (c) {
        in '0'..'9' -> c - '0'
        in 'a'..'f' -> c - 'a' + 10
        in 'A'..'F' -> c - 'A' + 10
        else -> -1
    }

    private fun safeDecodeUriComponent(value: String): String =
        try { decodeUriComponent(value) } catch (_: Exception) { value }

    /**
     * parseModelPickerValue：`providerId/modelId` 或 `providerId/modelId$档位`，经
     * modelSelectionSchema（strict，各段 trim 后非空）归一；返回 (providerId, modelId, 档位?)，
     * 不合法返回 null。
     */
    private fun parseModelPickerValue(value: String): Triple<String, String, String?>? {
        val normalized = value.jsTrim()
        val providerSeparatorIndex = normalized.indexOf('/')
        if (providerSeparatorIndex <= 0) return null
        val providerId = normalized.substring(0, providerSeparatorIndex)
        val rawModelId = normalized.substring(providerSeparatorIndex + 1)
        val reasoningSeparatorIndex = rawModelId.indexOf('$')
        return if (reasoningSeparatorIndex <= 0 || reasoningSeparatorIndex >= rawModelId.length - 1) {
            strictModelSelection(providerId, rawModelId, null)?.let { Triple(it.first, it.second, null) }
        } else {
            strictModelSelection(providerId, rawModelId.substring(0, reasoningSeparatorIndex), rawModelId.substring(reasoningSeparatorIndex + 1))
                ?.let { Triple(it.first, it.second, it.third) }
        }
    }

    /** modelSelectionSchema.parse 的三段校验：任一段 trim 后为空即非法；返回 trim 后的三段 */
    private fun strictModelSelection(providerId: String, modelId: String, reasoningLevel: String?): Triple<String, String, String?>? {
        val p = providerId.jsTrim()
        val m = modelId.jsTrim()
        if (p.isEmpty() || m.isEmpty()) return null
        val level = reasoningLevel?.jsTrim()
        if (reasoningLevel != null && level.isNullOrEmpty()) return null
        return Triple(p, m, level)
    }

    fun modelSelectionJson(providerId: String, modelId: String, reasoningLevel: String?): JsonObject = buildJsonObject {
        put("providerId", providerId)
        put("modelId", modelId)
        if (reasoningLevel != null) put("options", buildJsonObject { put("reasoningLevel", reasoningLevel) })
    }

    // ============ subagent-profile-parser.ts ============

    /**
     * parseAgentProfileFromMarkdown。diagnostic 与 profile 可同时存在（仅 memory 非法这一种：
     * 照常产出 profile、memory 丢弃）；其余 diagnostic 都不带 profile。
     */
    fun parseAgentProfile(content: String, path: String?, source: String): Parsed {
        val (split, body) = splitMarkdownFrontmatter(content)
        // 官方判的是 `!parsed.frontmatter`：闭合分隔符紧挨开头时 frontmatter 是空串，同样算缺失
        if (split.isNullOrEmpty()) {
            return Parsed(
                Diagnostic("agent_missing_frontmatter", "Agent Markdown must include frontmatter: ${path ?: "<inline>"}", path),
                null,
            )
        }
        val (values, mcp) = parseAgentFrontmatter(split)
        val name = scalarString(values["name"])
        // 官方：描述里的字面量 \n 还原成换行
        val description = scalarString(values["description"])?.replace("\\n", "\n")
        if (name == null) return Parsed(missingRequiredDiagnostic("name", path), null)
        if (description == null) return Parsed(missingRequiredDiagnostic("description", path), null)

        val modelSelection = parseMarkdownSelection(values)
        val color = scalarString(values["color"])?.takeIf { it in VALID_COLORS }
        // 项目级 subagent markdown 属于仓库输入，不能借 frontmatter 把 child runtime 提升到 bypass/yolo
        val permissionMode = if (source == "project") null else scalarString(values["permissionMode"])?.takeIf { it in VALID_PERMISSION_MODES }
        val maxTurns = normalizePositiveInteger(values["maxTurns"])
        val memory = (values["memory"] as? V.Str)?.value?.takeIf { it in VALID_MEMORY_SCOPES }
        val memoryDiagnostic = if (values.containsKey("memory") && memory == null) {
            Diagnostic(
                "agent_invalid_memory_scope",
                "Agent frontmatter memory must be user, project, or local: ${path ?: "<inline>"}",
                path,
            )
        } else null
        if (mcp is Mcp.Invalid) {
            return Parsed(
                Diagnostic(
                    "agent_invalid_mcp_servers",
                    "Agent frontmatter mcpServers must be a list of parent server names: ${path ?: "<inline>"}",
                    path,
                ),
                null,
            )
        }

        val profile = buildJsonObject {
            put("name", name)
            put("description", description)
            put("source", source)
            put("systemPrompt", body.jsTrim())
            path?.let { put("path", it) }
            modelSelection?.let { put("modelSelection", it) }
            color?.let { put("color", it) }
            permissionMode?.let { put("permissionMode", it) }
            maxTurns?.let { put("maxTurns", it) }
            memory?.let { put("memory", it) }
            optionalList("tools", values["tools"]).forEach { (k, v) -> put(k, v) }
            optionalList("disallowedTools", values["disallowedTools"]).forEach { (k, v) -> put(k, v) }
            optionalList("skills", values["skills"]).forEach { (k, v) -> put(k, v) }
            optionalBoolean(values["background"])?.let { put("background", it) }
            optionalBoolean(values["injectAgentsMd"])?.let { put("injectAgentsMd", it) }
            (mcp as? Mcp.Names)?.let { put("mcpServers", JsonArray(it.names.map { n -> JsonPrimitive(n) })) }
        }
        return Parsed(memoryDiagnostic, profile)
    }

    private fun missingRequiredDiagnostic(field: String, path: String?) =
        Diagnostic("agent_missing_required_frontmatter", "Agent frontmatter must include ${field}: ${path ?: "<inline>"}", path)

    private fun scalarString(value: V?): String? = (value as? V.Str)?.value?.jsTrim()?.takeIf { it.isNotEmpty() }

    /** parseToolList：数组直接归一；字符串按括号外的逗号/空白切分 */
    private fun parseToolList(value: V?): List<String>? {
        if (value is V.Arr) return normalizeToolNames(normalizeStringList(value))
        if (value !is V.Str) return null
        val result = ArrayList<String>()
        val current = StringBuilder()
        var parenDepth = 0
        for (char in value.value) {
            if (char == '(') parenDepth += 1
            if (char == ')') parenDepth = maxOf(0, parenDepth - 1)
            if (parenDepth == 0 && (char == ',' || isJsSpace(char))) {
                if (current.toString().jsTrim().isNotEmpty()) result.add(current.toString().jsTrim())
                current.setLength(0)
                continue
            }
            current.append(char)
        }
        if (current.toString().jsTrim().isNotEmpty()) result.add(current.toString().jsTrim())
        return normalizeToolNames(result)
    }

    /** optionalList：列表非空才落键；tools 显式给了数组却归一成空时落空数组（=不继承任何工具） */
    private fun optionalList(key: String, value: V?): Map<String, JsonElement> {
        val list = if (key == "skills") normalizeStringList(value) else parseToolList(value)
        if (list != null && list.isNotEmpty()) return mapOf(key to JsonArray(list.map { JsonPrimitive(it) }))
        if (key == "tools" && value is V.Arr) return mapOf("tools" to JsonArray(emptyList()))
        return emptyMap()
    }

    private fun optionalBoolean(value: V?): Boolean? {
        if (value is V.Bool) return value.value
        if (value is V.Str) {
            if (value.value.lowercase() == "true") return true
            if (value.value.lowercase() == "false") return false
        }
        return null
    }

    private fun normalizeStringList(value: V?): List<String>? {
        if (value is V.Arr) {
            val list = value.items.filterIsInstance<V.Str>().filter { it.value.isNotEmpty() }.map { it.value }
            return list.ifEmpty { null }
        }
        if (value !is V.Str) return null
        val list = value.value.split(SPACE_OR_COMMA).map { it.jsTrim() }.filter { it.isNotEmpty() }
        return list.ifEmpty { null }
    }

    private fun normalizePositiveInteger(value: V?): Int? {
        val n = when (value) {
            is V.Num -> value.value
            is V.Str -> if (DIGITS.matches(value.value)) value.value.toDouble() else return null
            else -> return null
        }
        return if (!n.isInfinite() && n == Math.floor(n) && n > 0) n.toInt() else null
    }

    private fun normalizeToolNames(values: List<String>?): List<String>? {
        if (values == null) return null
        val names = values.map { toolNameFromSpec(it) }.filter { it.isNotEmpty() }
        return names.ifEmpty { null }
    }

    private fun toolNameFromSpec(value: String): String {
        val trimmed = value.jsTrim()
        val parenIndex = trimmed.indexOf('(')
        if (parenIndex < 0) return trimmed
        return trimmed.substring(0, parenIndex).jsTrim()
    }
}

/**
 * 子代理运行时配置快照（subagents/readRuntimeConfig 的应答体），移植官方宿主实现
 * （ZCode 开源 v4.0.0：packages/services/src/subagents/subagentRuntimeConfig.ts 的
 * createSubagentRuntimeConfigCache + subagentsService.ts 的 readAgentStateAtPath，
 * packages/shared/src/subagent-runtime-config.ts 的 resolveSubagentRuntimeProfiles）：
 *
 * - profiles = 用户级 `<存储根>/agents` + 项目级 `<工作目录>/.zcode/agents` 两处的
 *   *.md|*.markdown（非递归，按路径排序），用 [SubagentMarkdown] 解析；带 diagnostic 的
 *   文件照官方跳过（memory 非法那种保留 profile）
 * - 两张覆盖表与禁用清单读 `<存储根>/v2/agents-state.json`：逐条按官方 strict schema
 *   校验，非法项丢弃；禁用只作用于 user 级 profile。不做旧字段迁移（官方宿主与运行时
 *   的文件回退路径各自会迁移）
 * - 读不出来时回落 [FALLBACK] 而不是把异常交给运行时——官方：任一范围读取失败即发布
 *   built-in-fallback；运行时对错误应答的处理是让建会话/回合直接失败
 *
 * 官方宿主带文件监听的内存缓存这里不做：运行时每个回合开始都会重新请求一次，
 * 每次现读现解析（个位数小文件，毫秒级）即是最新的。
 */
object SubagentRuntimeConfig {

    private val LOG = Logger.getInstance("zcode.ideaplugin.subagents")

    /** 官方 {kind:"built-in-fallback"}：只用内置子代理，自定义/插件 profile 与覆盖表全空 */
    val FALLBACK: JsonObject = buildJsonObject { put("kind", "built-in-fallback") }

    /** agents-state.json 的三键（已按官方规则归一） */
    class State(
        val builtInModelSelectionOverrides: JsonObject,
        val pluginAgentModelSelectionOverrides: JsonObject,
        val disabledAgentIds: Set<String>,
    )

    private val EMPTY_STATE = State(JsonObject(emptyMap()), JsonObject(emptyMap()), emptySet())

    private val json = Json { ignoreUnknownKeys = true }

    private fun stringOf(el: JsonElement?): String? = (el as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun blankAfterTrim(s: String) = SubagentMarkdown.trim(s).isEmpty()

    /** parsePluginSubagentModelSelectionOverrides：只收 plugin: 前缀且合规的条目；入参不是对象 = 空 */
    internal fun parsePluginOverrides(el: JsonElement?): JsonObject {
        val obj = el as? JsonObject ?: return JsonObject(emptyMap())
        return buildJsonObject {
            obj.forEach { (id, candidate) ->
                if (id.startsWith("plugin:")) parseModelSelection(candidate)?.let { put(id, it) }
            }
        }
    }

    /**
     * modelSelectionSchema.safeParse(...).data 的等价实现（strict）：providerId/modelId
     * trim 后非空；options 可缺省，但出现时只能是对象且至多含 reasoningLevel（trim 后非空）。
     * 非法返回 null；返回值即上线形态（已 trim）。
     */
    fun parseModelSelection(el: JsonElement?): JsonObject? {
        val obj = el as? JsonObject ?: return null
        if (obj.keys.any { it != "providerId" && it != "modelId" && it != "options" }) return null
        val providerId = stringOf(obj["providerId"])?.let { SubagentMarkdown.trim(it) }?.takeIf { it.isNotEmpty() } ?: return null
        val modelId = stringOf(obj["modelId"])?.let { SubagentMarkdown.trim(it) }?.takeIf { it.isNotEmpty() } ?: return null
        return buildJsonObject {
            put("providerId", providerId)
            put("modelId", modelId)
            obj["options"]?.let { optionsEl ->
                val options = optionsEl as? JsonObject ?: return null
                if (options.keys.any { it != "reasoningLevel" }) return null
                val reasoningLevel = options["reasoningLevel"]?.let {
                    stringOf(it)?.let { l -> SubagentMarkdown.trim(l) }?.takeIf { it.isNotEmpty() } ?: return null
                }
                put("options", buildJsonObject { reasoningLevel?.let { put("reasoningLevel", it) } })
            }
        }
    }

    /**
     * 读 agents-state.json（官方 readAgentStateAtPath）：文件缺失/JSON 损坏/根不是对象
     * 按空状态；其余 IO 异常照官方上抛（由 [snapshot] 决定回退）。
     */
    fun readState(storageRoot: File): State {
        val file = File(storageRoot, "v2/agents-state.json")
        if (!file.isFile) return EMPTY_STATE
        val root = try {
            json.parseToJsonElement(file.readText()) as? JsonObject ?: return EMPTY_STATE
        } catch (_: SerializationException) {
            return EMPTY_STATE
        } catch (_: IllegalArgumentException) {
            return EMPTY_STATE
        }
        val structured = root["builtInModelSelectionOverrides"] as? JsonObject
        val builtIn = buildJsonObject {
            parseModelSelection(structured?.get("general-purpose"))?.let { put("general-purpose", it) }
            parseModelSelection(structured?.get("Explore"))?.let { put("Explore", it) }
        }
        val plugin = parsePluginOverrides(root["pluginAgentModelSelectionOverrides"])
        val disabled = (root["disabledAgentIds"] as? JsonArray)
            ?.mapNotNull { id -> stringOf(id)?.takeIf { !blankAfterTrim(it) } }
            ?.toSet()
            ?: emptySet()
        return State(builtIn, plugin, disabled)
    }

    /** createAgentStateId({name, scope:"user", source:"user"}) */
    private fun userStateId(profile: JsonObject): String =
        "user:user:" + SubagentMarkdown.trim(stringOf(profile["name"]).orEmpty()).lowercase()

    /** 官方 resolveSubagentRuntimeProfiles：禁用清单只作用于 user 级 profile */
    fun resolve(profiles: List<JsonObject>, state: State): JsonObject = buildJsonObject {
        put("kind", "ready")
        put(
            "profiles",
            JsonArray(
                profiles.filter { profile ->
                    stringOf(profile["source"]) != "user" || userStateId(profile) !in state.disabledAgentIds
                },
            ),
        )
        put("builtInModelSelectionOverrides", state.builtInModelSelectionOverrides)
        put("pluginAgentModelSelectionOverrides", state.pluginAgentModelSelectionOverrides)
    }

    /**
     * 现读现解析出一份快照。构建结果自检不过（subagentRuntimeConfigSchema 的 strict 形状）
     * 或状态文件读取异常时返回 [FALLBACK]——宁可控降级也不把非法应答交给运行时。
     *
     * @param workingDirectory 会话工作目录（项目级定义的根）；null = 只取用户级
     */
    fun snapshot(workingDirectory: String?): JsonObject {
        return try {
            build(workingDirectory)
        } catch (e: Exception) {
            LOG.warn("subagent runtime config fallback: ${e.javaClass.simpleName}: ${e.message}")
            FALLBACK
        }
    }

    private fun build(workingDirectory: String?): JsonObject {
        val storageRoot = Credentials.storageRoot().toFile()
        val profiles = ArrayList<JsonObject>()
        profiles.addAll(loadProfiles(File(storageRoot, "agents"), "user"))
        if (!workingDirectory.isNullOrBlank()) {
            profiles.addAll(loadProfiles(File(workingDirectory, ".zcode/agents"), "project"))
        }
        val snapshot = resolve(profiles, readState(storageRoot))
        if (!isValidSnapshot(snapshot)) {
            LOG.warn("subagent runtime config snapshot failed self-validation, using built-in fallback")
            return FALLBACK
        }
        return snapshot
    }

    private val MARKDOWN_NAME = Regex("\\.(md|markdown)$", RegexOption.IGNORE_CASE)

    /** listDocuments + loadDocuments：根目录下第一层的 *.md|*.markdown，按路径排序逐个解析 */
    private fun loadProfiles(root: File, source: String): List<JsonObject> {
        // 官方是 /\.(md|markdown)$/iu.test(name)（搜索）：这里必须用 containsMatchIn，
        // Kotlin 的 matches 是全匹配，对文件名永远为 false
        val files = root.listFiles { f -> f.isFile && MARKDOWN_NAME.containsMatchIn(f.name) } ?: return emptyList()
        val collator = Collator.getInstance()
        val profiles = ArrayList<JsonObject>()
        for (file in files.sortedWith(compareBy(collator) { it.path })) {
            val content = try {
                file.readText()
            } catch (_: IOException) {
                continue // 读取前被删：以文件不存在为准，不回填
            }
            val parsed = SubagentMarkdown.parseAgentProfile(content, file.path, source)
            parsed.diagnostic?.let { LOG.debug("subagent profile diagnostic ${it.code}: ${file.path}") }
            parsed.profile?.let { profiles.add(it) }
        }
        return profiles
    }

    // ---- subagentRuntimeConfigSchema 的形状自检（strict：多键少键类型不符都算不过）----

    private val SNAPSHOT_KEYS = setOf("kind", "profiles", "builtInModelSelectionOverrides", "pluginAgentModelSelectionOverrides")
    private val PROFILE_KEYS = setOf(
        "name", "description", "source", "systemPrompt", "path", "modelSelection", "background", "injectAgentsMd",
        "color", "permissionMode", "memory", "maxTurns", "tools", "disallowedTools", "skills", "mcpServers",
    )
    private val STRING_LIST_KEYS = listOf("tools", "disallowedTools", "skills", "mcpServers")

    fun isValidSnapshot(snapshot: JsonObject): Boolean {
        if (stringOf(snapshot["kind"]) != "ready") return false
        if (snapshot.keys.any { it !in SNAPSHOT_KEYS }) return false
        val profiles = snapshot["profiles"] as? JsonArray ?: return false
        if (profiles.any { !isValidProfile(it as? JsonObject) }) return false
        val builtIn = snapshot["builtInModelSelectionOverrides"] as? JsonObject ?: return false
        if (builtIn.keys.any { it != "Explore" && it != "general-purpose" }) return false
        if (builtIn.values.any { parseModelSelection(it) != it }) return false
        val plugin = snapshot["pluginAgentModelSelectionOverrides"] as? JsonObject ?: return false
        if (plugin.keys.any { !it.startsWith("plugin:") }) return false
        return plugin.values.all { parseModelSelection(it) == it }
    }

    private fun isValidProfile(p: JsonObject?): Boolean {
        if (p == null || p.keys.any { it !in PROFILE_KEYS }) return false
        val name = stringOf(p["name"])
        if (name == null || name.length < 1) return false
        if (stringOf(p["description"]) == null) return false
        if (stringOf(p["source"]) !in setOf("project", "user")) return false
        if (stringOf(p["systemPrompt"]) == null) return false
        if (p.containsKey("path") && stringOf(p["path"]) == null) return false
        if (p.containsKey("modelSelection") && parseModelSelection(p["modelSelection"]) != p["modelSelection"]) return false
        for (key in listOf("background", "injectAgentsMd")) {
            if (p.containsKey(key) && (p[key] as? JsonPrimitive)?.booleanOrNull == null) return false
        }
        if (p.containsKey("color") && stringOf(p["color"]) !in SubagentMarkdown.VALID_COLORS) return false
        if (p.containsKey("permissionMode") && stringOf(p["permissionMode"]) !in SubagentMarkdown.VALID_PERMISSION_MODES) return false
        if (p.containsKey("memory") && stringOf(p["memory"]) !in setOf("user", "project", "local")) return false
        if (p.containsKey("maxTurns")) {
            val n = (p["maxTurns"] as? JsonPrimitive)?.doubleOrNull ?: return false
            if (n != Math.floor(n) || n <= 0) return false
        }
        for (key in STRING_LIST_KEYS) {
            if (!p.containsKey(key)) continue
            val arr = p[key] as? JsonArray ?: return false
            if (arr.any { stringOf(it) == null }) return false
        }
        return true
    }
}
