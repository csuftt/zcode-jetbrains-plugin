package com.zcode.ideaplugin.action

/**
 * 控制台「最近错误段」提取（纯函数，单测覆盖）。
 *
 * 交互动线（IDEA 集成面调研 ④）：跑应用/跑测试报错时，用户不手动划选，右键一键把
 * 错误段送进 ZCode 输入框。无选区取全文的锚点策略：
 *
 * 1. 取尾部 [MAX_TAIL_LINES] 行做搜索窗（控制台全文可能上万行，全量正则不必要）；
 * 2. 从后往前找最后一个「错误锚点」行（异常类名 / Caused by / 构建失败 / 测试汇总等，
 *    覆盖 Java/SpringCloud + Maven/Gradle 日常报错指纹）；锚点 → 窗口末尾即错误段
 *    （异常头 + 堆栈 + 构建汇总天然都在尾部）；
 * 3. 没有锚点时退化为「最近输出」（尾部 [DEFAULT_NO_ANCHOR_LINES] 行），照发不误——
 *    报错形态千奇百怪，宁可多送不漏送；
 * 4. 行数/字符双预算收口（防超长堆栈把输入框撑爆，字符预算走 paste-chip 折叠通道）。
 *
 * ANSI 控制序列不需处理：ConsoleViewImpl 的内部编辑器 document 文本已过滤着色。
 */
internal object RecentErrorExtractor {

    /** 错误锚点行识别（按行 containsMatchIn） */
    private val ANCHOR = Regex(
        // 异常类名：限定名（java.lang.OutOfMemoryError）与裸类名（Exception/Error）都要命中
        // ——前缀词根必须可选（[\w$]+ 仅匹配"词根+Exception"形态，裸 Exception 恒不命中，
        // 2026-11-11 单测实锤）；结尾 \b 挡住 Errors/Exceptional 等英文单词误报
        """\b(?:([\w$]+\.)*[\w$]+)?(Exception|Error|Throwable)\b""" +
        // JVM 因果链（Spring/Mybatis 常见多层包装）
        """|^\s*Caused by:\s""" +
        // Spring Boot 启动失败横幅
        """|APPLICATION FAILED TO START""" +
        // Maven / Gradle 构建失败
        """|BUILD FAILURE""" +
        """|FAILURE: Build failed""" +
        // Surefire/JUnit 失败汇总行（Failures: 1、Errors: 2）
        """|Tests? run: .*(Failures|Errors): [1-9]""" +
        // IDEA 运行器退出码尾行（进程崩了但没抛异常栈的形态）
        """|Process finished with (non-zero )?exit (code|value) [1-9]"""
    )

    /** 锚点搜索窗（行）：控制台全文尾部这么多行里找最后锚点 */
    const val MAX_TAIL_LINES = 500

    /** 错误段行数上限：堆栈+构建汇总通常几十行，120 行足够装下绝大多数形态 */
    const val MAX_ERROR_LINES = 120

    /** 错误段字符预算：超长时截断（对齐轻任务 8k 字符量级） */
    const val MAX_ERROR_CHARS = 8_000

    /** 无锚点时的退化窗口（行）：「最近输出」语义 */
    const val DEFAULT_NO_ANCHOR_LINES = 40

    /**
     * 从控制台全文提取最近错误段；输入为空/全空白返回空串。
     * 不假设换行风格：CRLF/LF 归一处理。
     */
    fun extract(consoleText: String): String {
        if (consoleText.isBlank()) return ""
        val tail = consoleText.replace("\r\n", "\n").split('\n').takeLast(MAX_TAIL_LINES)
        val anchorIdx = tail.indexOfLast { ANCHOR.containsMatchIn(it) }
        val from = if (anchorIdx >= 0) anchorIdx else (tail.size - DEFAULT_NO_ANCHOR_LINES).coerceAtLeast(0)
        val segment = tail.drop(from).take(MAX_ERROR_LINES).joinToString("\n")
        return if (segment.length <= MAX_ERROR_CHARS) segment
        else segment.take(MAX_ERROR_CHARS) + "\n... (输出过长已截断)"
    }
}
