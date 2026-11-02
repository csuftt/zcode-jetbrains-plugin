package com.zcode.ideaplugin.remote

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * readSession 响应体积裁剪（手机远程桥，2026-08-25 真机 HAR 9.7MB 响应压垮 H5 后新增）。
 */
class TrimSessionMessagesTest {

    private fun msg(id: Int, text: String) = buildJsonObject {
        put("messageId", "m$id")
        put("role", "assistant")
        put("content", text)
    }

    private fun state(vararg texts: String) = buildJsonObject {
        put("sessionId", "s1")
        put("messages", JsonArray(texts.mapIndexed { i, t -> msg(i, t) }))
    }

    @Test
    fun `小响应原样返回`() {
        val s = state("hello", "world")
        val out = trimSessionMessages(s, 10_000)
        assertSame(s, out)
        assertEquals(2, out["messages"]!!.jsonArray.size)
        assertNull(out["truncated"])
    }

    @Test
    fun `无 messages 字段原样返回`() {
        val s = buildJsonObject { put("sessionId", "s1") }
        assertSame(s, trimSessionMessages(s, 100))
    }

    @Test
    fun `超预算裁剪保留最近消息且顺序正确`() {
        val s = state("a".repeat(50), "b".repeat(50), "c".repeat(50))
        val out = trimSessionMessages(s, 120)
        val kept = out["messages"]!!.jsonArray
        // 最新消息 c 必保；b 超预算被裁
        assertEquals(1, kept.size)
        assertEquals("m2", kept[0].jsonObject["messageId"]!!.jsonPrimitive.content)
        assertEquals("c".repeat(50), kept[0].jsonObject["content"]!!.jsonPrimitive.content)
        assertEquals(true, out["truncated"]!!.jsonPrimitive.content.toBoolean())
        assertEquals("read-session-size-limit", out["truncatedReason"]!!.jsonPrimitive.content)
        assertEquals(3, out["totalMessages"]!!.jsonPrimitive.content.toInt())
    }

    @Test
    fun `预算边界恰好放行全部`() {
        val s = state("a".repeat(50), "b".repeat(50))
        val total = s["messages"]!!.jsonArray.sumOf { it.toString().length }
        val out = trimSessionMessages(s, total)
        assertSame(s, out)
    }

    @Test
    fun `单条消息超预算仍保留最新一条`() {
        val s = state("x".repeat(300), "y".repeat(300))
        val out = trimSessionMessages(s, 100)
        val kept = out["messages"]!!.jsonArray
        assertEquals(1, kept.size)
        assertEquals("m1", kept[0].jsonObject["messageId"]!!.jsonPrimitive.content)
        assertTrue(out["truncated"]!!.jsonPrimitive.content.toBoolean())
    }

    @Test
    fun `裁剪后响应体积不超过预算加单条上限`() {
        val texts = (0..30).map { it.toString().repeat(200) }
        val s = state(*texts.toTypedArray())
        val out = trimSessionMessages(s, 1_000)
        val kept = out["messages"]!!.jsonArray
        assertTrue(kept.size < texts.size, "大响应应被裁剪")
        assertTrue(out.toString().length <= 1_000 + 1_000, "裁剪后整体体积应受控")
        // 保留的是最近消息
        assertEquals("m${texts.size - 1}", kept.last().jsonObject["messageId"]!!.jsonPrimitive.content)
    }

    @Test
    fun `中文按UTF8字节计预算而非字符数`() {
        // 中文 3B/字：按字符数计两行 ~2030≤3000 会全保留；按 UTF-8 字节计单行已 ~3055
        // 超预算——只留最新一条（字符数计预算会低估 CJK 体积 ~3 倍）
        val s = state("中".repeat(1000), "中".repeat(1000))
        val out = trimSessionMessages(s, 3_000)
        val kept = out["messages"]!!.jsonArray
        assertEquals(1, kept.size, "CJK 按 UTF-8 字节计超预算应裁剪")
        assertEquals("m1", kept[0].jsonObject["messageId"]!!.jsonPrimitive.content, "保留最新一条")
        assertTrue(out["truncated"]!!.jsonPrimitive.content.toBoolean())
    }
}
