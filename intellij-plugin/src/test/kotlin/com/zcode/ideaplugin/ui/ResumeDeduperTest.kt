package com.zcode.ideaplugin.ui

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * resume 同会话去重测试（缺陷AB 优先级编排①）。
 *
 * 虚拟时钟 + 真实线程并发验证：窗口内单次执行、并发调用者等待在途并复用、
 * 窗口过期重新执行、失败不缓存（后续调用可再试）。
 */
class ResumeDeduperTest {

    private lateinit var pool: java.util.concurrent.ExecutorService

    @BeforeTest
    fun setUp() {
        pool = Executors.newFixedThreadPool(4)
    }

    @AfterTest
    fun tearDown() {
        pool.shutdownNow()
    }

    @Test
    fun `窗口内第二次调用复用首次结果不再执行`() {
        var now = 0L
        val calls = AtomicInteger(0)
        val d = ResumeDeduper(windowMs = 10_000, now = { now }, sleep = { })
        assertTrue(d.resumeOnce("s") { calls.incrementAndGet(); true })
        now = 5_000
        assertTrue(d.resumeOnce("s") { calls.incrementAndGet(); true })
        assertEquals(1, calls.get())
    }

    @Test
    fun `窗口过期后重新执行`() {
        var now = 0L
        val calls = AtomicInteger(0)
        val d = ResumeDeduper(windowMs = 10_000, now = { now }, sleep = { })
        d.resumeOnce("s") { calls.incrementAndGet(); true }
        now = 10_001
        d.resumeOnce("s") { calls.incrementAndGet(); true }
        assertEquals(2, calls.get())
    }

    @Test
    fun `失败不缓存 下次调用再执行`() {
        val calls = AtomicInteger(0)
        val d = ResumeDeduper(windowMs = 10_000, sleep = { })
        assertFalse(d.resumeOnce("s") { calls.incrementAndGet(); false })
        assertFalse(d.resumeOnce("s") { calls.incrementAndGet(); false })
        assertEquals(2, calls.get())
    }

    @Test
    fun `并发到达只执行一次 另一调用者等待复用`() {
        var now = 0L
        val calls = AtomicInteger(0)
        val firstStarted = CountDownLatch(1)
        val releaseFirst = CountDownLatch(1)
        val d = ResumeDeduper(windowMs = 10_000, now = { now }, sleep = { now += 100 })

        val f1 = pool.submit<Boolean> {
            d.resumeOnce("s") {
                calls.incrementAndGet()
                firstStarted.countDown()
                releaseFirst.await(5, TimeUnit.SECONDS) // 模拟慢 resume（坏会话 8.7s）
                true
            }
        }
        assertTrue(firstStarted.await(2, TimeUnit.SECONDS))
        val f2 = pool.submit<Boolean> { d.resumeOnce("s") { calls.incrementAndGet(); true } }
        releaseFirst.countDown()
        assertTrue(f1.get(5, TimeUnit.SECONDS))
        assertTrue(f2.get(5, TimeUnit.SECONDS), "并发等待者应复用在途成功结果")
        assertEquals(1, calls.get(), "两条链路（subscribe/messages）并发只 resume 一次")
    }

    @Test
    fun `在途者失败后 等待者自行重试`() {
        val calls = AtomicInteger(0)
        val firstStarted = CountDownLatch(1)
        val releaseFirst = CountDownLatch(1)
        val d = ResumeDeduper(windowMs = 10_000, sleep = { Thread.sleep(10) })

        val f1 = pool.submit<Boolean> {
            d.resumeOnce("s") {
                calls.incrementAndGet()
                firstStarted.countDown()
                releaseFirst.await(5, TimeUnit.SECONDS)
                false // 在途者失败（未缓存）
            }
        }
        assertTrue(firstStarted.await(2, TimeUnit.SECONDS))
        val f2 = pool.submit<Boolean> { d.resumeOnce("s") { calls.incrementAndGet(); true } }
        releaseFirst.countDown()
        assertFalse(f1.get(5, TimeUnit.SECONDS))
        assertTrue(f2.get(5, TimeUnit.SECONDS), "等待者应自己再试并成功")
        assertEquals(2, calls.get())
    }

    @Test
    fun `不同会话互不影响`() {
        val calls = AtomicInteger(0)
        val d = ResumeDeduper(windowMs = 10_000, sleep = { })
        d.resumeOnce("s1") { calls.incrementAndGet(); true }
        d.resumeOnce("s2") { calls.incrementAndGet(); true }
        assertEquals(2, calls.get())
    }
}
