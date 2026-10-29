package com.zcode.ideaplugin.protocol

import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean

/** [StdinWriteGate.submit] 结果语义 */
enum class WriteOutcome {
    /** 写入完成且 checkError 为假 */
    OK,
    /** 写入完成但写入器报错（PrintWriter 吞 IO 异常，靠 checkError 探测的断管） */
    BROKEN_PIPE,
    /** 写入阻塞/排队超过时限（阻塞判死由 gate 恰好一次回调 onDeclared） */
    TIMEOUT,
    /** 已判死，快速失败（未执行写入） */
    DEAD,
    /** 写入动作抛出异常 */
    WRITE_ERROR,
}

/**
 * stdin 写入门禁：把「串行化」与「限时写入」拆开——写入动作在单线程执行器上跑
 * （FIFO 队列保证写入顺序，等价原 sendLock 的串行语义），调用方限时等结果。
 * 写入阻塞超过时限即判定对端挂死（管道缓冲满且对端不再消费），触发判死回调
 * （client 侧 kill 进程树 + 通知重建）并返回 TIMEOUT。
 *
 * 背景（app-server-silent-hang 三/四例，2026-10-28/29）：交互弹窗（AskUserQuestion/
 * ExitPlanMode）应答后下一轮模型请求发起时 app-server 进程整体静默挂死，stdin 从此
 * 无人消费。原 send() 是持全局锁的阻塞式写且无超时：首个撞进 println 的调用（2s
 * 轮询的 sessionDebug）永久阻塞持有 sendLock，此后一切 stdio 通信在锁上排队——用户
 * 点停止/重发全部卡死无痕（RPC 都没发出，request 层超时机制根本没轮到执行），唯一
 * 解 = 用户手动杀进程。本门禁把阻塞封顶在时限内：到期 → 判死回调（kill → readLoop
 * EOF → 在途请求集中 fail → Service 层懒重建接管），后续调用快速失败直到实例换代。
 *
 * 排队与阻塞的区分：队列堆积只会发生在队头写入卡死时（队头先超时先判死），所以
 * 任务尚未开跑就超时的场景不判死（避免二次 kill），仅返回 TIMEOUT——此刻 DEAD
 * 标志已由队头置位，后续调用走 DEAD 快速失败。
 *
 * 线程模型：单执行器线程保证写入顺序；gate 自身无锁，判死标志 CAS 恰好一次。
 * 判死后执行器不再接收任务（DEAD 短路），卡在写入里的那一线程随进程被 kill
 * （管道断裂）自然解锁，守护线程不阻退出。
 */
internal class StdinWriteGate(
    private val writeTimeoutMs: Long,
    /** 判死回调（恰好一次）：evidence 描述阻塞证据（method/时长），调用方自行 kill/重建 */
    private val onDeclared: (evidence: String) -> Unit,
) {
    private val executor = ThreadPoolExecutor(
        1, 1, 60L, TimeUnit.SECONDS, LinkedBlockingQueue()
    ) { r -> Thread(r).apply { isDaemon = true; name = "zcode-stdin-writer" } }
        .apply { allowCoreThreadTimeOut(true) }

    private val dead = AtomicBoolean(false)

    fun isDead(): Boolean = dead.get()

    /**
     * 提交一次写入并限时等待。[write] 在单执行器线程上执行，返回 false 表示写失败
     * （PrintWriter 吞 IO 异常，由调用方 checkError 探测）；抛出视为写失败。
     */
    fun submit(method: String?, write: () -> Boolean): WriteOutcome {
        if (dead.get()) return WriteOutcome.DEAD
        val started = AtomicBoolean(false)
        val outcome = CompletableFuture<Boolean>()
        try {
            executor.execute {
                started.set(true)
                try {
                    outcome.complete(write())
                } catch (t: Throwable) {
                    outcome.completeExceptionally(t)
                }
            }
        } catch (_: RejectedExecutionException) {
            return WriteOutcome.WRITE_ERROR
        }
        return try {
            if (outcome.get(writeTimeoutMs, TimeUnit.MILLISECONDS)) WriteOutcome.OK
            else WriteOutcome.BROKEN_PIPE
        } catch (_: TimeoutException) {
            if (started.get()) {
                dead.compareAndSet(false, true)
                onDeclared("stdin 写入阻塞超 ${writeTimeoutMs}ms (method=$method)")
            }
            WriteOutcome.TIMEOUT
        } catch (_: ExecutionException) {
            WriteOutcome.WRITE_ERROR
        }
    }

    /** 停收新任务并中断空闲等待（卡在写入里的线程随进程 kill 的管道断裂自然解锁） */
    fun close() {
        executor.shutdownNow()
    }
}
