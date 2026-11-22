package com.zcode.kb.core

import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.TimeUnit

/**
 * git 锚点捕获与历史恢复（ProcessBuilder 薄封装，沿 GitWorktreeCli 惯用法：
 * env 钉死防分页器/锁/编码噪音、超时强杀、stderr 异步 drain 防管道死锁）。
 *
 * - 捕获（收录时点）：仓根 `rev-parse --show-toplevel` + HEAD commit + Kotlin 侧相对化；
 * - 恢复（源失联时）：`cat-file blob <commit>:<rel>` 原始字节落盘——切分支致源文件
 *   消失后按收录时点 commit 捞回（快照链路验证过的语义）。
 *
 * git 可执行路径由调用方解析传入（IDE 内走 GitExecutableManager，缺省 "git"）。
 * 输出按 UTF-8 解码 + `core.quotepath=off`（LC_ALL=C 下中文路径不被引号转义污染）。
 */
class KbGitCli(private val gitExe: String = "git", private val timeoutMs: Long = 10_000L) {

    data class Anchor(val repoRoot: Path, val commit: String, val relPath: String)

    /** 捕获锚点；文件不在 git 仓 / 无 HEAD / 相对化失败返回 null（收录照常，锚点为空） */
    fun anchor(file: Path): Anchor? {
        if (!Files.isRegularFile(file)) return null
        val dir = file.parent
        val rootRaw = text(listOf("rev-parse", "--show-toplevel"), dir)?.trim() ?: return null
        if (rootRaw.isEmpty()) return null
        val root = Path.of(rootRaw.replace('\\', '/')).toAbsolutePath().normalize()
        val commit = text(listOf("rev-parse", "--verify", "--quiet", "HEAD"), dir)?.trim()
        if (commit.isNullOrEmpty()) return null
        val rel = try {
            root.relativize(file.toAbsolutePath().normalize()).toString().replace('\\', '/')
        } catch (e: Exception) {
            return null
        }
        if (rel.isEmpty()) return null
        return Anchor(root, commit, rel)
    }

    /** 锚点所指 blob 是否仍可取（恢复按钮置灰判据） */
    fun hasBlob(repoRoot: String, commit: String, relPath: String): Boolean =
        code(listOf("cat-file", "-e", "$commit:$relPath"), Path.of(repoRoot)) == 0

    /** 按锚点捞回文件字节，写入 target；失败 false */
    fun restoreBlob(repoRoot: String, commit: String, relPath: String, target: Path): Boolean {
        val bytes = bytes(listOf("cat-file", "blob", "$commit:$relPath"), Path.of(repoRoot)) ?: return false
        return try {
            Files.createDirectories(target.parent)
            Files.write(target, bytes)
            true
        } catch (e: Exception) {
            false
        }
    }

    // ── 内部：统一 exec（输出字节 + 退出码），失败 null ──

    private fun exec(args: List<String>, dir: Path?): Pair<Int, ByteArray>? = try {
        val pb = ProcessBuilder(listOf(gitExe, "-c", "core.quotepath=off") + args)
        if (dir != null && Files.isDirectory(dir)) pb.directory(dir.toFile())
        pb.environment().apply {
            put("GIT_OPTIONAL_LOCKS", "0")
            put("GIT_PAGER", "cat")
            put("PAGER", "cat")
            put("TERM", "dumb")
            put("LC_ALL", "C")
            put("LANG", "C")
        }
        pb.redirectErrorStream(false)
        val proc = pb.start()
        val errDrain = Thread({ proc.errorStream.copyTo(ByteArrayOutputStream()) }, "kb-git-err")
        errDrain.isDaemon = true
        errDrain.start()
        val out = ByteArrayOutputStream()
        proc.inputStream.copyTo(out, 64 * 1024)
        val done = proc.waitFor(timeoutMs, TimeUnit.MILLISECONDS)
        if (!done) {
            proc.destroyForcibly()
            null
        } else {
            proc.exitValue() to out.toByteArray()
        }
    } catch (e: Exception) {
        null
    }

    private fun text(args: List<String>, dir: Path?): String? =
        exec(args, dir)?.takeIf { it.first == 0 }?.let { String(it.second, StandardCharsets.UTF_8) }

    private fun bytes(args: List<String>, dir: Path?): ByteArray? =
        exec(args, dir)?.takeIf { it.first == 0 }?.second

    private fun code(args: List<String>, dir: Path?): Int = exec(args, dir)?.first ?: -1
}
