package com.zcode.ideaplugin.ui

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * 「提问自动继续」配置（插件自有配置，与 ZCode 客户端 setting.json 不同源）
 *
 * 存储：复用 webview kv 通道（PropertiesComponent KEY_WEBVIEW_KV）的
 * `zcode.askUser.config` 键——前端行为设置页经 utils/askUserConfig.ts 写入，
 * Kotlin 侧即时读取，无消息往返。
 *
 * 语义：autoContinueEnabled=true → Agent 提问 5 分钟未答自动继续（本地弹窗超时
 * decline + requestRuntimePreferences 应答透传 true，服务端同语义）；
 * false（默认）→ 提问一直等待用户应答，弹窗无倒计时不自动关闭。
 */
object ZCodeAskUserConfig {

    /** kv 通道里的配置键（前端 utils/askUserConfig.ts 同源）*/
    const val KV_KEY = "zcode.askUser.config"

    /** 配置（前端 JSON 持久化镜像；字段缺席走默认——默认关闭=一直等待）*/
    data class Config(
        val autoContinueEnabled: Boolean = false,
    )

    /** 从 kv store 解析配置（缺失/损坏回默认值，绝不因配置问题抛异常）*/
    fun readConfig(): Config = try {
        parseConfig(
            com.intellij.ide.util.PropertiesComponent.getInstance()
                .getValue(ZCodeLanguageService.KEY_WEBVIEW_KV)
        )
    } catch (_: Exception) {
        Config()
    }

    /** 纯解析（单测覆盖）：kvstore JSON 原文 → Config */
    internal fun parseConfig(kvStoreRaw: String?): Config {
        val root = try {
            kotlinx.serialization.json.Json.parseToJsonElement(kvStoreRaw ?: return Config())
                as? kotlinx.serialization.json.JsonObject ?: return Config()
        } catch (_: Exception) {
            return Config()
        }
        val conf = try {
            (root[KV_KEY] as? JsonPrimitive)?.content ?: return Config()
        } catch (_: Exception) {
            return Config()
        }
        val obj = try {
            kotlinx.serialization.json.Json.parseToJsonElement(conf) as? kotlinx.serialization.json.JsonObject
                ?: return Config()
        } catch (_: Exception) {
            return Config()
        }
        return Config(autoContinueEnabled = obj.boolOr("autoContinueEnabled", false))
    }

    /** 布尔字段解析（对齐前端 TS 语义：只认 JSON 布尔字面量；字符串 "false" 等回默认）*/
    private fun kotlinx.serialization.json.JsonObject.boolOr(key: String, def: Boolean): Boolean {
        val p = this[key] as? JsonPrimitive ?: return def
        if (p.isString) return def
        return p.booleanOrNull ?: def
    }
}
