package com.zcode.ideaplugin.ui

import java.util.concurrent.ConcurrentHashMap

/**
 * 同一会话 resume 的并发/短窗去重（缺陷AB 优先级编排①）。
 *
 * 打开会话时 subscribe 与 messages 两条链路各自 resume 同一会话——恢复大上下文
 * 是重操作（坏会话实测 8.7s/次），在 app-server 的会话队列里排两次队。本类让同一
 * 会话在去重窗口内只执行一次真 resume：并发到达者等待在途那次完成后直接复用；
 * 窗口过后（切走切回/服务端重启自愈场景）恢复正常 resume。resume 失败不缓存
 * （失败可能 already active 也可能真失败），其他调用者可再试——是否继续后续
 * 操作由调用方按旧语义决定。
 */
class ResumeDeduper(
    private val windowMs: Long = 10_000,
    private val now: () -> Long = System::currentTimeMillis,
    private val sleep: (Long) -> Unit = Thread::sleep,
) {
    private val doneAt = ConcurrentHashMap<String, Long>()
    private val inFlight = ConcurrentHashMap<String, Unit>()

    private fun fresh(key: String): Boolean {
        val t = doneAt[key]
        return t != null && now() - t < windowMs
    }

    /**
     * 执行（或复用窗口内的）resume。[resumeAction] 返回是否成功。
     * 返回 false = 尝试过且失败（调用方按需继续后续操作）；窗口内已有成功记录时
     * 直接返回 true 不再执行。
     */
    fun resumeOnce(key: String, resumeAction: () -> Boolean): Boolean {
        if (fresh(key)) return true
        if (inFlight.putIfAbsent(key, Unit) == null) {
            try {
                if (fresh(key)) return true
                val ok = resumeAction()
                if (ok) doneAt[key] = now()
                return ok
            } finally {
                inFlight.remove(key)
            }
        }
        // 并发在途：等它落地（上限 = 窗口 + 余量）；在途者成功 → 复用，
        // 失败（未缓存）→ 自己再试一次
        val deadline = now() + windowMs + 2_000
        while (now() < deadline) {
            if (fresh(key)) return true
            if (inFlight[key] == null) break
            sleep(100)
        }
        if (fresh(key)) return true
        // 在途者已结束且未成功：递归重试（此时锁已空，抢占必成；深度最多 2）
        return if (inFlight[key] == null) resumeOnce(key, resumeAction) else false
    }
}
