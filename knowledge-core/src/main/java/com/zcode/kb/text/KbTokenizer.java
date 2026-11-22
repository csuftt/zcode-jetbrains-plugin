package com.zcode.kb.text;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 知识库检索分词器——双侧共用（纯 Java）。
 *
 * 必须纯 Java 的原因：MCP server 被 app-server 以 `java -cp <插件>\lib\*` fork，
 * fork JVM 无独立 kotlin-stdlib（CUA 先例实证），server 侧要与本侧查询同形分词；
 * 本类不得引用任何 Kotlin 类。
 *
 * 规则（查询构造与命中判据两侧必须同形，改这里即同时改变两侧行为）：
 * - latin/digit 连续段 → 一个词元，小写化；
 * - CJK（汉字/假名/谚文，不含 CJK 标点）连续段 → 互相重叠的 bigram；长度 1 的段
 *   输出单字词元（文件存储的内存检索按子串包含判命中，单字查询天然可命中）；
 * - 其余（标点/空白/emoji）为分隔符。
 *
 * 产出的词元只含 [0-9a-z] 与 CJK 字符；bigram 粒度让「网络」这样的词能以整词
 * 语义命中（查询与文档同形切分，两侧包含比对即等价于词元相交）。
 */
public final class KbTokenizer {

    private KbTokenizer() {
    }

    /** CJK 表意/假名/谚文（刻意排除 0x3000-0x303F CJK 标点与 0xFF00 全角区） */
    public static boolean isCjk(int cp) {
        return (cp >= 0x3400 && cp <= 0x4DBF)   // 扩展A
                || (cp >= 0x4E00 && cp <= 0x9FFF)   // 基本区
                || (cp >= 0x3040 && cp <= 0x30FF)   // 假名
                || (cp >= 0xAC00 && cp <= 0xD7AF)   // 谚文音节
                || (cp >= 0xF900 && cp <= 0xFAFF)   // 兼容表意
                || (cp >= 0x1100 && cp <= 0x11FF)   // 谚文字母
                || (cp >= 0x20000 && cp <= 0x2FA1F);// 扩展B+
    }

    /** 分词：latin 词元 + CJK bigram（落单单字保留） */
    public static List<String> tokens(String text) {
        List<String> out = new ArrayList<>();
        if (text == null || text.isEmpty()) return out;
        StringBuilder word = new StringBuilder();
        List<Integer> cjkRun = new ArrayList<>();
        int n = text.length();
        int pos = 0;
        while (pos < n) {
            int cp = text.codePointAt(pos);
            pos += Character.charCount(cp);
            if (Character.isLetterOrDigit(cp) && !isCjk(cp)) {
                flushCjk(cjkRun, out);
                word.appendCodePoint(cp);
            } else if (isCjk(cp)) {
                if (word.length() > 0) {
                    out.add(word.toString().toLowerCase(Locale.ROOT));
                    word.setLength(0);
                }
                cjkRun.add(cp);
            } else {
                if (word.length() > 0) {
                    out.add(word.toString().toLowerCase(Locale.ROOT));
                    word.setLength(0);
                }
                flushCjk(cjkRun, out);
            }
        }
        if (word.length() > 0) out.add(word.toString().toLowerCase(Locale.ROOT));
        flushCjk(cjkRun, out);
        return out;
    }

    private static void flushCjk(List<Integer> run, List<String> out) {
        if (run.isEmpty()) return;
        if (run.size() == 1) {
            out.add(new String(Character.toChars(run.get(0))));
        } else {
            for (int i = 0; i < run.size() - 1; i++) {
                out.add(new String(Character.toChars(run.get(i)))
                        + new String(Character.toChars(run.get(i + 1))));
            }
        }
        run.clear();
    }
}
