package com.zcode.ideaplugin.remote

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * rowsRange 体积预算裁剪（缺陷FS 七轮）：弱网手机 relay 连接扛不住 ~1MB 物理帧
 * （真机 HAR 14/14 多分片只到 frag0 即断连），裁到单分片内由 H5 翻页。
 */
class RowsRangeTrimTest {

    private fun page(vararg rowIds: Int, hasMore: Boolean = true): JsonObject =
        Json.parseToJsonElement(
            """{"rows":[${rowIds.joinToString(",") { """{"rowId":$it,"kind":"assistantText","text":"${"x".repeat(50)}"}""" }}],"atSeq":10,"atLogEpoch":"e","hasMore":$hasMore}"""
        ).jsonObject

    @Test
    fun `under budget returns unchanged`() {
        val p = page(1, 2, 3)
        assertTrue(trimRowsRangeResult(p, budgetBytes = 1024 * 1024) === p, "预算内原样返回")
    }

    @Test
    fun `over budget keeps newest tail and forces hasMore`() {
        val p = page(*((1..40).toList().toIntArray())) // 40 行 × ~90B
        val trimmed = trimRowsRangeResult(p, budgetBytes = 400)
        val rows = trimmed["rows"]!!.jsonArray
        val ids = rows.map { it.jsonObject["rowId"]!!.jsonPrimitive.content.toInt() }
        assertTrue(rows.size < 40, "超预算被裁")
        assertEquals(40, ids.last(), "最新行（尾行）必须保留")
        assertEquals(ids.sorted(), ids, "升序保持")
        assertEquals("true", trimmed["hasMore"]!!.jsonPrimitive.content, "裁剪强制 hasMore=true 供翻页")
    }

    @Test
    fun `single oversized row always kept`() {
        val big = Json.parseToJsonElement(
            """{"rows":[{"rowId":7,"kind":"toolCall","output":"${"y".repeat(2048)}"}],"atSeq":1,"atLogEpoch":"e","hasMore":false}"""
        ).jsonObject
        val trimmed = trimRowsRangeResult(big, budgetBytes = 100)
        assertEquals(1, trimmed["rows"]!!.jsonArray.size, "单行超预算无条件保留")
    }

    @Test
    fun `hasMore false stays false when nothing dropped`() {
        val p = page(1, hasMore = false)
        val trimmed = trimRowsRangeResult(p, budgetBytes = 1024 * 1024)
        assertFalse(trimmed["hasMore"]!!.jsonPrimitive.content.toBoolean(), "未裁剪不翻页")
    }
}
