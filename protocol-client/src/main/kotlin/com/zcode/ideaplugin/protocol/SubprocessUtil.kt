package com.zcode.ideaplugin.protocol

import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/**
 * node 内联子进程的统一执行器（防管道死锁的同型坑收敛点）
 *
 * 历史：stderr 4KB 管道满导致 node 卡死（全部请求超时的根因）、getSessionStats
 * 「先 waitFor 后读 stdout」同样会因输出超管道缓冲死锁——凡是「先等后读」或
 * 「不读 stderr」的子进程代码都是同型隐患。
 *
 * 正确姿势（与 cliOneShot 同型）：
 * - stdout 并发读（边等边 drain，不依赖脚本输出量小于管道缓冲）
 * - stderr 异步 drain（供失败诊断，8KB 截断防无界）
 * - waitFor 限时 + 超时强杀
 */
internal object SubprocessUtil {

    /** 子进程执行结果：stdout / stderr（8KB 截断）/ 退出码 */
    class Result(val out: String, val err: String, val exitValue: Int)

    /**
     * 启动 [pb] 并收集输出，[timeoutSec] 内未退出则强杀并抛 [IllegalStateException]。
     * @param timeoutMsg 超时异常文案（自动附超时时长）
     */
    fun runForOutput(pb: ProcessBuilder, timeoutSec: Long, timeoutMsg: String): Result {
        val p = pb.start()
        val err = StringBuilder()
        Thread({
            runCatching {
                p.errorStream.bufferedReader().forEachLine {
                    if (err.length < 8000) err.appendLine(it)
                }
            }
        }, "zcode-subproc-stderr").apply { isDaemon = true }.start()

        // stdout 并发读：进程输出超过管道缓冲时，若先 waitFor 会互相等死（写端阻塞、读端在等退出）
        val outFuture = CompletableFuture.supplyAsync {
            runCatching { p.inputStream.bufferedReader().readText() }.getOrDefault("")
        }
        if (!p.waitFor(timeoutSec, TimeUnit.SECONDS)) {
            p.destroyForcibly()
            throw IllegalStateException("$timeoutMsg（${timeoutSec}s，进程已终止）")
        }
        val out = outFuture.get(5, TimeUnit.SECONDS)
        return Result(out, err.toString(), p.exitValue())
    }
}
