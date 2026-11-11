package com.zcode.ideaplugin.env

import java.io.File

/**
 * 环境变量占位符路径展开（缺陷 GY，2026-11-10）
 *
 * AI 正文常写 `%TEMP%\x.md`、`$TMPDIR/x.md`、`~/x.md` 这类占位符路径（workspace
 * 本身挂在临时目录下时尤其常见）。两条消费链：
 *  - [expand]：openFile/openFileSystem 打开前的兜底展开——webview 白名单变量缺失
 *    时不下发死链（见 webview resolveFileLink），这里用全量 env 查任意变量名；
 *  - [pathEnvVars]：路径语义白名单下发 webview（getPathEnv op），供 chip 解析与
 *    产物卡门控在纯前端同步展开。只发白名单，不整包 env（env 里有非路径敏感值）。
 *
 * 纯 object 无 IntelliJ 依赖，可脱离平台单测。
 */
object PathEnvExpansion {

    /** Windows 形态 %NAME%（含 %ProgramFiles(x86)% 的括号名） */
    private val WINDOWS_VAR = Regex("%([A-Za-z0-9_()]+)%")

    /** Unix 形态 ${NAME} 与 $NAME（名字段止于非 [A-Za-z0-9_]，`$5` 查不到原样保留） */
    private val UNIX_VAR = Regex("\\$\\{([A-Za-z0-9_]+)}|\\$([A-Za-z0-9_]+)")

    /** 多轮替换：覆盖相邻组合（%HOMEDRIVE%%HOMEPATH%）与罕见嵌套 */
    private const val MAX_PASSES = 3

    /** 全量展开：%NAME% / ${NAME} / $NAME 查 System.getenv，查不到原样保留；前导 ~ 展开 user.home */
    fun expand(raw: String): String {
        if (raw.isEmpty()) return raw
        var result = raw
        var pass = 0
        while (pass < MAX_PASSES) {
            val next = expandUnix(expandWindows(result))
            if (next == result) break
            result = next
            pass++
        }
        return expandHome(result)
    }

    /**
     * 路径语义环境变量白名单（下发 webview）。值做 canonical 化：Windows %TEMP%
     * 实际是 ADMINI~1 短名、Mac /var 是 /private/var 符号链接——与 fileChanges
     * 账本里的真实长路径做精确匹配会失败，必须归真。
     */
    fun pathEnvVars(): Map<String, String> {
        val vars = LinkedHashMap<String, String>()
        for (key in PATH_ENV_KEYS) {
            val value = System.getenv(key) ?: continue
            if (value.isBlank()) continue
            vars[key] = canonicalize(value)
        }
        if ("HOME" !in vars) {
            System.getProperty("user.home")?.takeIf { it.isNotBlank() }?.let { vars["HOME"] = canonicalize(it) }
        }
        return vars
    }

    private val PATH_ENV_KEYS = listOf(
        "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
        "APPDATA", "LOCALAPPDATA", "ALLUSERSPROFILE", "PROGRAMDATA", "PUBLIC",
    )

    private fun expandWindows(path: String): String =
        WINDOWS_VAR.replace(path) { m -> System.getenv(m.groupValues[1]) ?: m.value }

    private fun expandUnix(path: String): String = UNIX_VAR.replace(path) { m ->
        val name = m.groupValues[1].ifEmpty { m.groupValues[2] }
        System.getenv(name) ?: m.value
    }

    /** 仅 ~、~/、~\ 三形态（~user 语法不支持）；占位符展开后落到首段的不在此列 */
    private fun expandHome(path: String): String {
        if (path == "~") return userHome()
        if (path.startsWith("~/") || path.startsWith("~\\")) return userHome() + path.substring(1)
        return path
    }

    private fun userHome(): String = System.getProperty("user.home") ?: "~"

    /**
     * 存在性校验通过才 canonical 化（不存在的路径 canonical 无意义且可能抛异常）。
     * 「C:」盘相对形态例外：canonicalPath 会落到该盘当前目录，语义被污染——原样保留。
     */
    private fun canonicalize(value: String): String {
        if (value.length == 2 && value[1] == ':') return value
        return try {
            val file = File(value)
            if (file.exists()) file.canonicalPath else value
        } catch (t: Throwable) {
            value
        }
    }
}
