package com.zcode.ideaplugin.ui

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * 会话级请求超时的忙窗口自愈重试（缺陷AB，2026-08-27 用户日志实测）。
 *
 * 背景：resume 恢复带未完成回合的会话（如模型 API 不可达留下中断回合）时，app-server
 * 对该会话的请求处理进入约 1~2 分钟忙窗口——期间 session/subscribe(10s)、
 * session/setModel(6s)、session/read(10s) 全部排队超时，窗口结束后自行恢复。
 * 用户侧表现是"订阅失败 + 思考深度消失"，且一看报错就重启 IDE 反而重新 resume
 * 重新进窗口，永远观察不到自愈。本调度器在超时后延迟重试（默认 15s/30s 两次），
 * 跨过窗口让恢复对用户无感；只应调度超时类瞬时失败，永久错误（会话不存在等）不重试。
 *
 * - 按 key 防重入：在途期间同 key 的再次 schedule 被忽略；成功或耗尽后自动释放
 * - action 返回 true = 成功停止；false / 抛异常 = 用下一档延迟再试；耗尽即放弃
 *   （业务侧用户仍可通过切会话等手动触发，无需告警）
 * - action 内部应自取最新协议客户端（app-server 可能已重启）并做幂等判断
 */
class BusyRetryScheduler(
    private val executor: ScheduledExecutorService,
    private val delaysMs: List<Long> = listOf(15_000, 30_000),
) {
    private val keys: MutableSet<String> = ConcurrentHashMap.newKeySet()

    /** 是否已有该 key 的重试在途（调用方日志/提示可据此区分）*/
    fun isScheduled(key: String): Boolean = key in keys

    fun schedule(key: String, action: () -> Boolean) {
        if (!keys.add(key)) return
        scheduleNext(key, 0, action)
    }

    /** 主动释放 key（业务状态已由其他路径恢复、不再需要重试时用）*/
    fun cancel(key: String) {
        keys.remove(key)
    }

    private fun scheduleNext(key: String, attempt: Int, action: () -> Boolean) {
        if (attempt >= delaysMs.size) {
            keys.remove(key)
            return
        }
        executor.schedule({
            if (executor.isShutdown) {
                keys.remove(key)
                return@schedule
            }
            val done = try {
                action()
            } catch (_: Exception) {
                false
            }
            if (done) keys.remove(key) else scheduleNext(key, attempt + 1, action)
        }, delaysMs[attempt], TimeUnit.MILLISECONDS)
    }

    fun shutdown() {
        executor.shutdownNow()
    }
}
