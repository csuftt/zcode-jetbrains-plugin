package com.zcode.kb.core

import com.zcode.kb.text.KbTokenizer
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class KbTokenizerTest {

    @Test
    fun `latin words lowercased`() {
        assertEquals(listOf("hello", "world"), KbTokenizer.tokens("Hello WORLD"))
    }

    @Test
    fun `cjk run becomes overlapping bigrams`() {
        assertEquals(listOf("中文", "文库", "库检", "检索"), KbTokenizer.tokens("中文库检索"))
    }

    @Test
    fun `single cjk char kept as unigram`() {
        assertEquals(listOf("网"), KbTokenizer.tokens("网"))
    }

    @Test
    fun `mixed text splits words and bigrams`() {
        // 4 字 CJK 连串 → 3 个重叠 bigram（构实 是重叠产物，属预期）
        assertEquals(listOf("spring", "cloud", "架构", "构实", "实践"), KbTokenizer.tokens("Spring Cloud 架构实践"))
    }

    @Test
    fun `cjk punctuation is separator not token`() {
        assertEquals(listOf("中文", "逗号"), KbTokenizer.tokens("中文，逗号。"))
    }

    @Test
    fun `digits join latin words`() {
        assertEquals(listOf("v2", "config"), KbTokenizer.tokens("V2 config"))
    }

    @Test
    fun `cjk runs become overlapping bigrams and separators split`() {
        assertEquals(listOf("中文", "文检", "检索"), KbTokenizer.tokens("中文检索！"))
        assertEquals(emptyList<String>(), KbTokenizer.tokens("!!!"))
    }

    @Test
    fun `punctuation never leaks into tokens`() {
        val toks = KbTokenizer.tokens("a:b\"c'd'e (f) 部署手册")
        toks.forEach { t ->
            assertFalse(t.any { it == ':' || it == '"' || it == '\'' || it == '(' || it == ')' }, t)
        }
        assertTrue(toks.contains("部署"))
    }
}
