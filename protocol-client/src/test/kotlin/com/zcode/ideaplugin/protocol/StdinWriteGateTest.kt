package com.zcode.ideaplugin.protocol

import org.junit.jupiter.api.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * StdinWriteGate 行为回归（app-server-silent-hang 三/四例根治，2026-10-28/29）：
 * app-server 挂死后 stdin 无人消费，原 send() 持全局锁的阻塞式写永久卡住，全部
 * stdio 通信（含用户点停止）在锁上排队无痕。门禁把阻塞封顶在时限内：到期判死
 * （恰好一次回调）→ 后续提交快速失败。本测试用假写入动作覆盖四种结果与判死语义。
 */
class StdinWriteGateTest {

    @Test
    fun `写入成功返回OK`() {
        val gate = StdinWriteGate(1000) { }
        try {
            assertEquals(WriteOutcome.OK, gate.submit("m1") { true })
            assertFalse(gate.isDead())
        } finally {
            gate.close()
        }
    }

    @Test
    fun `写入器报错返回BROKEN_PIPE`() {
        val gate = StdinWriteGate(1000) { }
        try {
            // PrintWriter 吞 IO 异常后 checkError=true 的形态：写入"完成"但返回 false
            assertEquals(WriteOutcome.BROKEN_PIPE, gate.submit("m1") { false })
            assertFalse(gate.isDead(), "断管不应触发判死（进程死亡由 readLoop EOF 收尾）")
        } finally {
            gate.close()
        }
    }

    @Test
    fun `写入抛异常返回WRITE_ERROR`() {
        val gate = StdinWriteGate(1000) { }
        try {
            assertEquals(WriteOutcome.WRITE_ERROR, gate.submit("m1") { error("boom") })
            assertFalse(gate.isDead())
        } finally {
            gate.close()
        }
    }

    @Test
    fun `写入阻塞超时判死且恰好回调一次`() {
        val declared = AtomicInteger(0)
        val gate = StdinWriteGate(200) { declared.incrementAndGet() }
        try {
            assertEquals(WriteOutcome.TIMEOUT, gate.submit("m1") {
                CountDownLatch(1).await() // 永久阻塞，模拟挂死对端
                true
            })
            assertTrue(gate.isDead())
            // 判死回调在 gate 线程异步执行，等它落地
            System.err.println("wait declared")
            val deadline = System.currentTimeMillis() + 5000
            while (declared.get() == 0 && System.currentTimeMillis() < deadline) Thread.sleep(20)
            assertEquals(1, declared.get(), "判死回调必须恰好一次")
            // 判死后快速失败，不再执行写入
            var executed = false
            assertEquals(WriteOutcome.DEAD, gate.submit("m2") { executed = true; true })
            assertFalse(executed, "判死后新提交不应执行写入")
        } finally {
            gate.close()
        }
    }

    @Test
    fun `写入按单队列串行执行且不交叉`() {
        val gate = StdinWriteGate(5000) { }
        val order = StringBuilder()
        try {
            // 同线程顺序提交：FIFO 队列保证执行顺序=提交顺序（等价原 sendLock 串行语义）
            for (i in 1..8) gate.submit("m$i") { synchronized(order) { order.append(i) }; true }
            assertEquals("12345678", order.toString())
            // 并发提交：执行序不可预知，但全部执行且每次写入原子不交叉（长度=8 无重复）
            order.setLength(0)
            val threads = (1..8).map { i ->
                Thread { gate.submit("m$i") { synchronized(order) { order.append(i) }; true } }
            }
            threads.forEach { it.start() }
            threads.forEach { it.join(5000) }
            val s = order.toString()
            assertEquals(8, s.length, "全部写入都应执行且不交叉: $s")
            assertEquals((1..8).toSet(), s.map { it - '0' }.toSet(), "每笔恰好执行一次: $s")
        } finally {
            gate.close()
        }
    }

    @Test
    fun `close后提交被拒绝不挂死`() {
        val gate = StdinWriteGate(1000) { }
        gate.close()
        assertEquals(WriteOutcome.WRITE_ERROR, gate.submit("m1") { true }, "shutdown 后 execute 必被拒绝")
    }
}
