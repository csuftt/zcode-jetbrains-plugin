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
 *   消失后按收录时点 commit 捞回（快照链路验证过的语义）；
 * - 提交状态（收录/编辑弹窗展示）：该文件自己的最近提交 + 是否有未提交改动，
 *   见 [historyOf] / [historyAt]。
 *
 * git 可执行路径由调用方解析传入（IDE 内走 GitExecutableManager，缺省 "git"）。
 * 输出按 UTF-8 解码 + `core.quotepath=off`（LC_ALL=C 下中文路径不被引号转义污染）。
 */
class KbGitCli(private val gitExe: String = "git", private val timeoutMs: Long = 10_000L) {

    data class Anchor(val repoRoot: Path, val commit: String, val relPath: String)

    /** 一次提交的展示信息（短哈希 / 日期 / 标题行） */
    data class CommitInfo(val hash: String, val date: String, val subject: String)

    /**
     * 文件的提交状态（收录/编辑弹窗「Git 提交」行）。与收录锚点 [Anchor] 是两回事：锚点=
     * 收录时点的 HEAD（只供失联恢复），这里是该文件自己的最近提交。
     */
    data class FileHistory(
        val repoRoot: Path,
        val relPath: String,
        /** 最近一次改动该文件的提交；null = 在仓内但从未提交 */
        val commit: CommitInfo?,
        /** 工作区相对 HEAD 有未提交改动（已跟踪文件被修改，或未跟踪的新文件） */
        val dirty: Boolean,
        /** 被 .gitignore 忽略（不纳入版本管理） */
        val ignored: Boolean,
    )

    /** 源文件在盘时的提交状态；不在 git 仓内返回 null */
    fun historyOf(file: Path): FileHistory? {
        val (root, rel) = locate(file) ?: return null
        return historyAt(root, rel)
    }

    /**
     * 已知仓根与仓内相对路径时的提交状态（源文件已失联时用条目锚点查——得到的是该路径
     * 最近一次提交，可能正是删除它的那次）；仓目录不存在返回 null。
     */
    fun historyAt(repoRoot: Path, relPath: String): FileHistory? {
        if (!Files.isDirectory(repoRoot) || relPath.isEmpty()) return null
        // :(literal)：文件名里的 [ ] * ? 等按字面匹配，不当 pathspec 通配
        val spec = ":(literal)$relPath"
        // --encoding=UTF-8：提交信息按 UTF-8 输出（历史仓可能落的是 GBK）
        val commit = text(listOf("log", "-1", "--encoding=UTF-8", "--format=%h%x1f%aI%x1f%s", "--", spec), repoRoot)
            ?.split('\u001f')
            ?.takeIf { it.size == 3 }
            ?.let { f ->
                CommitInfo(f[0].trim(), DATE.find(f[1])?.groupValues?.get(1) ?: f[1].trim(), f[2].trim())
            }
            ?.takeIf { it.hash.isNotEmpty() }
        // --ignored=matching：被忽略文件逐个列出（traditional 只列到被忽略的目录），!! 前缀=忽略
        val status = text(listOf("status", "--porcelain", "--ignored=matching", "--", spec), repoRoot)
            ?.lines()
            ?.filter { it.isNotBlank() }
            .orEmpty()
        val ignored = status.any { it.startsWith("!!") }
        return FileHistory(repoRoot, relPath, commit, dirty = status.isNotEmpty() && !ignored, ignored = ignored)
    }

    /** 捕获锚点；文件不在 git 仓 / 无 HEAD / 相对化失败返回 null（收录照常，锚点为空） */
    fun anchor(file: Path): Anchor? {
        val (root, rel) = locate(file) ?: return null
        val commit = text(listOf("rev-parse", "--verify", "--quiet", "HEAD"), file.parent)?.trim()
        if (commit.isNullOrEmpty()) return null
        return Anchor(root, commit, rel)
    }

    /** 文件所在仓根 + 仓内相对路径；文件不在盘 / 不在仓内 / 相对化失败返回 null */
    private fun locate(file: Path): Pair<Path, String>? {
        if (!Files.isRegularFile(file)) return null
        val rootRaw = text(listOf("rev-parse", "--show-toplevel"), file.parent)?.trim()
        if (rootRaw.isNullOrEmpty()) return null
        val root = try {
            Path.of(rootRaw.replace('\\', '/')).toAbsolutePath().normalize()
        } catch (e: Exception) {
            return null
        }
        val rel = try {
            root.relativize(file.toAbsolutePath().normalize()).toString().replace('\\', '/')
        } catch (e: Exception) {
            return null
        }
        if (rel.isEmpty()) return null
        return root to rel
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

    /** %aI 的日期部分（ISO 严格格式 `2026-11-20T14:32:10+08:00`）；形态不符原样展示 */
    private val DATE = Regex("""^(\d{4}-\d{2}-\d{2})""")

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
