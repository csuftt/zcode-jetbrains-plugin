package com.zcode.ideaplugin.ui

import com.intellij.DynamicBundle
import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.diagnostic.Logger
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import java.util.Locale

/**
 * webview 语言计算（来源 cc-gui LanguageConfigService，适配本项目 kv 通道）。
 *
 * 语言流转：用户在设置页手动选择的语言（webview 经 kv 通道回存 IDE PropertiesComponent，
 * key=zcode.language）优先；否则跟随 IDE locale（DynamicBundle.getLocale() 映射）。
 * 计算结果经 buildBridgeJs 在 onLoadStart 注入 window.__ZCODE_LANGUAGE__（早于 React bundle）。
 *
 * 支持语言白名单与前端 i18n/config.ts SUPPORTED_LANGUAGES 保持一致。
 */
object ZCodeLanguageService {
    private val LOG = Logger.getInstance(ZCodeLanguageService::class.java)

    /** 支持的语言码（前端 webview/src/i18n/config.ts 同款白名单）*/
    val SUPPORTED_LANGUAGES = setOf("zh", "zh-TW", "en", "ja", "ko")

    /** 手动语言选择在 webview kv store 中的 key */
    const val KV_KEY_LANGUAGE = "zcode.language"

    /** webview 通用 kv 的 PropertiesComponent key（原 Panel 私有常量，迁移到此处共用）*/
    const val KEY_WEBVIEW_KV = "zcode.webview.kvstore"

    /**
     * 计算当前 webview 语言：手动值优先，否则映射 IDE locale。
     * 输出恒为白名单四值之一。
     */
    fun currentLanguage(): String {
        readManualLanguage()?.let { return it }
        return mapIdeLocale(DynamicBundle.getLocale())
    }

    /** 从 webview kv store 读手动语言选择（无/非法返回 null = 跟随 IDE）*/
    fun readManualLanguage(): String? {
        return try {
            val raw = PropertiesComponent.getInstance().getValue(KEY_WEBVIEW_KV)
                ?: return null
            val kv = Json.parseToJsonElement(raw).jsonObject
            when (val v = kv[KV_KEY_LANGUAGE]) {
                is JsonPrimitive -> v.contentOrNull?.takeIf { it in SUPPORTED_LANGUAGES }
                else -> null
            }
        } catch (e: Exception) {
            LOG.warn("读取手动语言选择失败: ${e.message}")
            null
        }
    }

    /**
     * IDE locale 映射到支持语言（简繁按国家/地区区分：zh_TW/zh_HK→zh-TW，其余 zh→zh；
     * ja/ko 直映，其他回退 en）。
     */
    fun mapIdeLocale(locale: Locale?): String {
        if (locale == null) return "en"
        if (locale.language == "zh") {
            return if (locale.country == "TW" || locale.country == "HK") "zh-TW" else "zh"
        }
        return when (locale.language) {
            "ja" -> "ja"
            "ko" -> "ko"
            else -> "en"
        }
    }
}
