package com.zcode.ideaplugin.ui

import java.util.concurrent.CountDownLatch
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * 忙窗口自愈重试调度器测试（缺陷AB）。
 *
 * 用真实 ScheduledExecutorService + 短延迟（30ms/40ms）验证：
 * 延迟触发、成功即停、耗尽放弃、同 key 防重入、异常计入失败、shutdown 后不再执行。
 */
class BusyRetrySchedulerTest {

    private lateinit var executor: ScheduledThreadPoolExecutor
    private lateinit var scheduler: BusyRetryScheduler

    @BeforeTest
    fun setUp() {
        // 直接构造 ScheduledThreadPoolExecutor（Executors 工厂返回委托类，queue 不可见）
        executor = ScheduledThreadPoolExecutor(1) { r ->
            Thread(r, "test-busy-retry").apply { isDaemon = true }
        }
        scheduler = BusyRetryScheduler(executor, delaysMs = listOf(30, 40))
    }

    @AfterTest
    fun tearDown() {
        executor.shutdownNow()
    }

    /** 等到重试链走完（无新任务）或超时 */
    private fun awaitIdle(timeoutMs: Long = 2000) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (executor.queue.isEmpty() && executor.activeCount == 0) return
            Thread.sleep(10)
        }
    }

    @Test
    fun `首次重试成功即停止并释放 key`() {
        val calls = AtomicInteger(0)
        scheduler.schedule("k") { calls.incrementAndGet(); true }
        awaitIdle()
        assertEquals(1, calls.get())
        assertFalse(scheduler.isScheduled("k"))
    }

    @Test
    fun `两次失败后耗尽放弃且释放 key`() {
        val calls = AtomicInteger(0)
        scheduler.schedule("k") { calls.incrementAndGet(); false }
        awaitIdle()
        assertEquals(2, calls.get(), "delaysMs 两档 = 共执行两次")
        assertFalse(scheduler.isScheduled("k"))
    }

    @Test
    fun `action 抛异常按失败继续重试`() {
        val calls = AtomicInteger(0)
        scheduler.schedule("k") {
            calls.incrementAndGet()
            if (calls.get() == 1) throw IllegalStateException("busy") else true
        }
        awaitIdle()
        assertEquals(2, calls.get())
        assertFalse(scheduler.isScheduled("k"))
    }

    @Test
    fun `在途期间同 key 的再次 schedule 被忽略`() {
        val calls = AtomicInteger(0)
        val firstStarted = java.util.concurrent.CountDownLatch(1)
        // 首次 action 挂住，制造"在途"窗口
        scheduler.schedule("k") {
            firstStarted.countDown()
            Thread.sleep(200)
            false
        }
        assertTrue(firstStarted.await(1, TimeUnit.SECONDS))
        scheduler.schedule("k") { calls.incrementAndGet(); true }
        awaitIdle(1000)
        // 第二次 schedule 被忽略，链上仍是第一次的两次重试
        assertEquals(0, calls.get())
        assertFalse(scheduler.isScheduled("k"))
    }

    @Test
    fun `释放后可再次 schedule`() {
        val calls = AtomicInteger(0)
        scheduler.schedule("k") { calls.incrementAndGet(); true }
        awaitIdle()
        assertFalse(scheduler.isScheduled("k"))
        scheduler.schedule("k") { calls.incrementAndGet(); true }
        awaitIdle()
        assertEquals(2, calls.get())
    }

    @Test
    fun `shutdown 后在途 key 停止且不再执行`() {
        val calls = AtomicInteger(0)
        scheduler.schedule("k") { calls.incrementAndGet(); false }
        scheduler.shutdown()
        awaitIdle(300)
        assertEquals(0, calls.get(), "shutdownNow 取消未触发的延迟任务")
    }
}
