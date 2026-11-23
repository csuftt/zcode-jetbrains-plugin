package com.zcode.kb.core

import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.TimeUnit

/**
 * 源文件的 git 信息查询（ProcessBuilder 薄封装，沿 GitWorktreeCli 惯用法：env 钉死防
 * 分页器/锁/编码噪音、超时强杀、stderr 异步 drain 防管道死锁）。
 *
 * - [repoRoot]：文件所在仓的根目录——收录时取 project 名（仓根名）用；
 * - [historyOf]：该文件自己的最近一次提交与未提交状态——收录/编辑弹窗「Git 提交」行。
 *
 * 这里查的都是**源文件自己仓库**的事，与知识库仓库的同步（[KbSync]）无关。
 * git 可执行路径由调用方解析传入（IDE 内走 GitExecutableManager，缺省 "git"）。
 * 输出按 UTF-8 解码 + `core.quotepath=off`（LC_ALL=C 下中文路径不被引号转义污染）。
 */
class KbGitCli(private val gitExe: String = "git", private val timeoutMs: Long = 10_000L) {

    /** 一次提交的展示信息（短哈希 / 日期 / 标题行） */
    data class CommitInfo(val hash: String, val date: String, val subject: String)

    /** 文件的提交状态（收录/编辑弹窗「Git 提交」行） */
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

    /** 文件所在 git 仓的根目录；文件不在盘 / 不在仓内 / 查询失败返回 null */
    fun repoRoot(file: Path): Path? = locate(file)?.first

    /** 文件的提交状态；文件不在盘或不在 git 仓内返回 null */
    fun historyOf(file: Path): FileHistory? {
        val (root, rel) = locate(file) ?: return null
        // :(literal)：文件名里的 [ ] * ? 等按字面匹配，不当 pathspec 通配
        val spec = ":(literal)$rel"
        // --encoding=UTF-8：提交信息按 UTF-8 输出（历史仓可能落的是 GBK）
        val commit = text(listOf("log", "-1", "--encoding=UTF-8", "--format=%h%x1f%aI%x1f%s", "--", spec), root)
            ?.split('\u001f')
            ?.takeIf { it.size == 3 }
            ?.let { f ->
                CommitInfo(f[0].trim(), DATE.find(f[1])?.groupValues?.get(1) ?: f[1].trim(), f[2].trim())
            }
            ?.takeIf { it.hash.isNotEmpty() }
        // --ignored=matching：被忽略文件逐个列出（traditional 只列到被忽略的目录），!! 前缀=忽略
        val status = text(listOf("status", "--porcelain", "--ignored=matching", "--", spec), root)
            ?.lines()
            ?.filter { it.isNotBlank() }
            .orEmpty()
        val ignored = status.any { it.startsWith("!!") }
        return FileHistory(root, rel, commit, dirty = status.isNotEmpty() && !ignored, ignored = ignored)
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

    // ── 内部：统一 exec（输出字节 + 退出码），失败 null ──

    /** %aI 的日期部分（ISO 严格格式 `2026-11-20T14:32:10+08:00`）；形态不符原样展示 */
    private val DATE = Regex("""^(\d{4}-\d{2}-\d{2})""")

    private fun exec(args: List<String>, dir: Path?): Pair<Int, String>? = try {
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
        val out = proc.inputStream.readBytes()
        val done = proc.waitFor(timeoutMs, TimeUnit.MILLISECONDS)
        if (!done) {
            proc.destroyForcibly()
            null
        } else {
            proc.exitValue() to String(out, StandardCharsets.UTF_8)
        }
    } catch (e: Exception) {
        null
    }

    private fun text(args: List<String>, dir: Path?): String? =
        exec(args, dir)?.takeIf { it.first == 0 }?.second
}
