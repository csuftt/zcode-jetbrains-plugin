package com.zcode.ideaplugin.protocol

import com.zcode.ideaplugin.protocol.model.AttachmentInput
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull

/**
 * session/send 图片附件序列化测试（纯单元，无需 ZCode 环境）
 *
 * 对齐 zcode.cjs 的 ZCode Protocol 通道附件形态（2026-08-26 源码确认）：
 * {kind:"image", filename, mimeType, sizeBytes?, dataBase64?, localPath?}。
 * 字段名写错会被服务端静默丢弃（v4i 只认这 6 个键），此处锁形状防回归。
 */
class AttachmentsSerializationTest {

    private val json = Json { encodeDefaults = true }

    @Test
    fun `AttachmentInput 序列化字段名与协议一致`() {
        val att = AttachmentInput(
            kind = "image",
            filename = "pasted-image-123.png",
            mimeType = "image/png",
            sizeBytes = 12345,
            dataBase64 = "iVBORw0KGgoAAAANSUhEUg==",
        )
        val obj = json.parseToJsonElement(json.encodeToString(AttachmentInput.serializer(), att)).jsonObject
        assertEquals("image", obj["kind"]?.jsonPrimitive?.content)
        assertEquals("pasted-image-123.png", obj["filename"]?.jsonPrimitive?.content)
        assertEquals("image/png", obj["mimeType"]?.jsonPrimitive?.content)
        assertEquals(12345L, obj["sizeBytes"]?.jsonPrimitive?.content?.toLong())
        assertEquals("iVBORw0KGgoAAAANSUhEUg==", obj["dataBase64"]?.jsonPrimitive?.content)
        // 未提供的字段缺失或为 null（协议端 v4i 按缺省处理；生产链路手工 buildJsonObject 恒省略）
        assertNull(obj["localPath"]?.jsonPrimitive?.contentOrNull)
    }

    @Test
    fun `AttachmentInput 未提供的可选字段缺省不序列化`() {
        // 生产链路手工 buildJsonObject 恒省略未提供的可选字段；此处锁默认省略语义
        val json = Json { encodeDefaults = false }
        val att = AttachmentInput(filename = "a.png", mimeType = "image/png")
        val obj = json.parseToJsonElement(json.encodeToString(AttachmentInput.serializer(), att)).jsonObject
        assertFalse(obj.containsKey("sizeBytes"), "未提供的 sizeBytes 不应出现")
        assertFalse(obj.containsKey("dataBase64"), "未提供的 dataBase64 不应出现")
        assertFalse(obj.containsKey("localPath"), "未提供的 localPath 不应出现")
        assertFalse(obj.containsKey("kind"), "默认 kind=image 不应出现（encodeDefaults=false）")
    }

    @Test
    fun `dataBase64 与 localPath 可共存（localPath 优先的服务端语义不变）`() {
        val att = AttachmentInput(
            filename = "x.png",
            mimeType = "image/png",
            dataBase64 = "QQ==",
            localPath = "C:/tmp/x.png",
        )
        val obj = json.parseToJsonElement(json.encodeToString(AttachmentInput.serializer(), att)).jsonObject
        assertEquals("C:/tmp/x.png", obj["localPath"]?.jsonPrimitive?.content)
        assertEquals("QQ==", obj["dataBase64"]?.jsonPrimitive?.content)
    }
}
