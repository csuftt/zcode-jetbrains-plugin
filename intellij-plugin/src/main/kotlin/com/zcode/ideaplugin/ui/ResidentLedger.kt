package com.zcode.ideaplugin.ui

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 服务端会话驻留水位的插件侧账本（缺陷BA 缓解）。
 *
 * app-server 维护内存驻留会话集合（实测 zcode.cjs：高水位 16；超限触发
 * high_water_lru 淘汰——且淘汰排序存在"总是踢掉刚载入会话自己"的缺陷，
 * 2026-09-04 cli 日志毫秒级定案，同会话重新 resume 也立刻再被踢）。
 *
 * 关键语义（源码 isEligible 定案）：被 legacy session/subscribe 订阅的会话
 * （hasLegacySubscriber）永不参与空闲清理，且服务端无任何退订 RPC
 * （legacyStreamSubscribed 只写 true 无清除）——插件"永不 unsubscribe"设计
 * 下每个打开过的会话**永久占坑**，空闲 10 分钟自动释放对它们不存在；
 * 坑位只能靠进程重启清零。
 *
 * 因此账本 = 已 resume 过的会话集合（进程生命周期内只增不减，与真实占坑
 * 集合同构：未被订阅的服务端内部/子会话会被空闲清理，恰好不在账本里）。
 * 打开新会话前 [checkBeforeOpen] 估算水位，越过提醒阈值返回 true
 * （每次跨越只提醒一次，进程换代 [invalidateAll] 后重置）。
 */
class ResidentLedger(
    private val highWater: Int = 16,
    private val warnThreshold: Int = 15,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val touched = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private val warned = AtomicBoolean(false)

    /** resume 成功即记账（该会话自此被 legacy 订阅钉住，占坑直到进程重启）*/
    fun touch(sessionId: String) {
        if (sessionId.isNotEmpty()) touched.add(sessionId)
    }

    /** app-server 进程换代：驻留集合随进程消亡，账本与提醒状态一并重置 */
    fun invalidateAll() {
        touched.clear()
        warned.set(false)
    }

    /** 当前占坑数（= 账本大小）*/
    fun activeCount(): Int = touched.size

    /**
     * 打开新会话前的水位检查：估算打开后的占坑数（已打开的复用不增，新会话 +1）。
     * 越过提醒阈值返回 true；同水位只提醒一次。
     */
    fun checkBeforeOpen(sessionId: String): Boolean {
        val projected = touched.size + if (touched.contains(sessionId)) 0 else 1
        if (projected < warnThreshold) return false
        return warned.compareAndSet(false, true)
    }
}
