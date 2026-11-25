package com.zcode.ideaplugin.ui

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Kotlin 移植的子代理 Markdown 解析器与官方实现的差分回放。
 *
 * 黄金样本 official-golden.json 由 scripts/gen-subagent-profile-golden.mjs 直接跑
 * ZCode 开源仓库的官方共享解析器生成（CLI 与桌面端共用的同一份实现），用例含官方
 * 测试集、逐字段形态穷举与种子固定的随机拼装。这里逐条回放、与官方输出做结构相等
 * 比对——插件经 subagents/readRuntimeConfig 接管运行时的子代理配置来源后，移植的
 * 解析器就是唯一解析方，任何偏差都会静默改变子代理行为。
 *
 * 失败信息把全部不一致条目一次列全（截前若干条），便于一次性定位是移植的哪条分支。
 */
class SubagentRuntimeConfigGoldenTest {

    private val golden: JsonObject by lazy {
        val stream = javaClass.getResourceAsStream("/subagent-runtime-config/official-golden.json")
            ?: error("缺黄金样本 subagent-runtime-config/official-golden.json（scripts/gen-subagent-profile-golden.mjs 生成）")
        Json.parseToJsonElement(stream.readBytes().decodeToString()).jsonObject
    }

    /** 失败信息里的可读转义（换行/回车/BOM 等控制字符显形） */
    private fun show(s: String): String = buildString {
        for (c in s) {
            append(
                when (c) {
                    '\n' -> "\\n"
                    '\r' -> "\\r"
                    '\t' -> "\\t"
                    '\uFEFF' -> "\\uFEFF"
                    else -> c.toString()
                },
            )
        }
    }

    private fun report(title: String, mismatches: List<String>): String = buildString {
        append(title).append("：").append(mismatches.size).append(" 条不一致\n")
        mismatches.take(30).forEach { append(it).append('\n') }
        if (mismatches.size > 30) append("… 其余 ").append(mismatches.size - 30).append(" 条略\n")
    }

    @Test
    fun `解析器与官方实现逐条等价`() {
        val mismatches = ArrayList<String>()
        golden.getValue("profiles").jsonArray.forEachIndexed { index, el ->
            val c = el.jsonObject
            val content = c.getValue("content").jsonPrimitive.content
            val path = (c["path"] as? JsonPrimitive)?.content
            val source = c.getValue("source").jsonPrimitive.content
            val expected = c.getValue("expected").jsonObject
            val parsed = SubagentMarkdown.parseAgentProfile(content, path, source)
            val actual = buildJsonObject {
                parsed.diagnostic?.let { d ->
                    put("diagnostic", buildJsonObject {
                        d.path?.let { put("path", it) }
                        put("code", d.code)
                        put("message", d.message)
                    })
                }
                parsed.profile?.let { put("profile", it) }
            }
            if (actual != expected) {
                mismatches += "#${index + 1} [${c["note"]?.jsonPrimitive?.content}] source=$source path=$path\n" +
                    "  content : ${show(content)}\n" +
                    "  expected: $expected\n" +
                    "  actual  : $actual"
            }
        }
        assertTrue(mismatches.isEmpty(), report("解析用例与官方输出不一致", mismatches))
    }

    @Test
    fun `模型选择的 strict 校验与官方 modelSelectionSchema 等价`() {
        val mismatches = ArrayList<String>()
        golden.getValue("selections").jsonArray.forEachIndexed { index, el ->
            val c = el.jsonObject
            // 输入里的 undefined 落 JSON 时键被省略，按 null 回放（官方当时收到的也是 null）
            val input = c["input"] ?: JsonNull
            val expected = c["expected"] ?: JsonNull
            val actual = SubagentRuntimeConfig.parseModelSelection(input) ?: JsonNull
            if (actual != expected) {
                mismatches += "#${index + 1} input=$input expected=$expected actual=$actual"
            }
        }
        assertTrue(mismatches.isEmpty(), report("模型选择校验与官方不一致", mismatches))
    }

    @Test
    fun `插件代理模型覆盖的解析与官方等价`() {
        val c = golden.getValue("pluginOverrides").jsonObject
        assertEquals(c["expected"] ?: JsonNull, SubagentRuntimeConfig.parsePluginOverrides(c["input"]))
    }

    @Test
    fun `禁用清单过滤与官方 resolveSubagentRuntimeProfiles 等价`() {
        val mismatches = ArrayList<String>()
        golden.getValue("resolve").jsonArray.forEachIndexed { index, el ->
            val c = el.jsonObject
            val state = c.getValue("state").jsonObject
            val snapshot = SubagentRuntimeConfig.resolve(
                c.getValue("profiles").jsonArray.map { it.jsonObject },
                SubagentRuntimeConfig.State(
                    state.getValue("builtInModelSelectionOverrides").jsonObject,
                    state.getValue("pluginAgentModelSelectionOverrides").jsonObject,
                    (state.getValue("disabledAgentIds") as JsonArray).map { (it as JsonPrimitive).content }.toSet(),
                ),
            )
            val actual = JsonObject(snapshot.filterKeys { it != "kind" })
            if (actual != c.getValue("expected")) {
                mismatches += "#${index + 1} state=$state\n  expected=${c["expected"]}\n  actual  =$actual"
            }
        }
        assertTrue(mismatches.isEmpty(), report("禁用过滤与官方不一致", mismatches))
    }
}
