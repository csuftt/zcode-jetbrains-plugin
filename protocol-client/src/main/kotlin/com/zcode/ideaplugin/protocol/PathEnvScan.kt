package com.zcode.ideaplugin.protocol

import java.nio.file.InvalidPathException
import java.nio.file.Path

/**
 * PATH 环境变量逐段扫描的统一入口（坏段隔离的同型坑收敛点）
 *
 * 历史（issue#47）：用户 Windows 用户名含中文，PATH 段 `C:\Users\<中文名>\.dbx\bin` 在
 * 到达 JVM 之前被 ANSI 代码页转换毒化成 `C:\Users\????\.dbx\bin`，`Path.of` 对含 `?`
 * 的字符串直接抛 InvalidPathException——原实现 `.map { Path.of(it) }` 急切求值，毒段在
 * PATH 任何位置都炸掉整条探测链：locateNode 的兜底（常见安装目录/登录 shell）全被绕过，
 * 异常炸穿环境自检直致死标签。
 *
 * 原则：含非法字符的段只可能来自上游毒化（合法路径不含 `?` 等 Windows 保留字符），
 * 单个坏段只影响自己——静默跳过继续扫其余段，找不到交调用方按各自语义兜底/报错。
 */
object PathEnvScan {

    /**
     * 在 [pathEnv]（原始 PATH 值，按 [sep] 分段）中逐段查找 [names] 可执行文件，
     * 返回首个命中段的完整路径；全未命中（含 PATH 为空、段全坏）返回 null。
     */
    fun findExecutable(pathEnv: String, sep: String, names: List<String>): String? {
        for (name in names) {
            val hit = pathEnv.split(sep)
                .asSequence()
                .mapNotNull { entry ->
                    try {
                        Path.of(entry).resolve(name)
                    } catch (_: InvalidPathException) {
                        null
                    }
                }
                .firstOrNull { it.toFile().exists() }
            if (hit != null) return hit.toString()
        }
        return null
    }
}
