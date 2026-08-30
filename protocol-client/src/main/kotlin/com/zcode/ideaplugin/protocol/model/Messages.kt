package com.zcode.ideaplugin.protocol.model

import kotlinx.serialization.json.JsonElement

/**
 * ZCode Protocol 消息模型
 *
 * 协议格式（0.16.1 实测，参考 zcode-protocol-spec-0.16.1.md）：
 * - 请求:    {"id": <num>, "method": "<ns/name>", "params": {...}}
 * - 响应:    {"id": <num>, "result": {...}} 或 {"id": <num>, "error": {...}}
 * - 通知:    {"method": "<name>", "params": {...}}  （无 id）
 * - 反向请求: {"id": "server-N", "method": "<name>", "params": {...}}  （id 是字符串）
 *
 * ⚠️ 关键约束：消息**不带** `jsonrpc` 字段（0.16+ 硬约束，否则 -32600）
 *
 * 信封结构由客户端直接 buildJsonObject 手工拼装（字段名是协议契约，密封类建模
 * 反而多一层转换），本文件只保留错误模型。
 */

data class ProtocolError(
    val code: Int,
    val message: String,
    val data: JsonElement? = null
)

/** 常见错误码 */
object ErrorCodes {
    const val INVALID_REQUEST = -32600
    const val METHOD_NOT_FOUND = -32601
    const val INVALID_PARAMS = -32602
    const val INTERNAL_ERROR = -32603
    const val SESSION_UNAVAILABLE = -32004
}
