package com.zcode.ideaplugin.viz

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import java.awt.Rectangle

/**
 * VizScreenCapture：::visualize 复制图片的视口矩形→组件内矩形换算测试。
 * 比例法（DOMRect/viewport → 组件内逻辑矩形），超出部分裁剪、非法参数拒绝。
 */
class VizScreenCaptureTest {

    @Test
    fun `比例换算 - DOMRect 映射到组件内矩形`() {
        // 组件 1000x800，视口 500x400（zoom/DPI 归一化为比例 2x）
        val rect = VizScreenCapture.componentRect(1000, 800, 500.0, 400.0, 50.0, 40.0, 400.0, 300.0)
        assertEquals(Rectangle(100, 80, 800, 600), rect)
    }

    @Test
    fun `超出组件边界部分被裁剪`() {
        val rect = VizScreenCapture.componentRect(1000, 800, 500.0, 400.0, -50.0, -60.0, 400.0, 300.0)
        assertEquals(Rectangle(0, 0, 700, 480), rect)
    }

    @Test
    fun `完全在组件外返回 null`() {
        assertNull(VizScreenCapture.componentRect(1000, 800, 500.0, 400.0, 600.0, 0.0, 100.0, 100.0))
        assertNull(VizScreenCapture.componentRect(1000, 800, 500.0, 400.0, 0.0, 500.0, 100.0, 100.0))
    }

    @Test
    fun `非法参数返回 null`() {
        assertNull(VizScreenCapture.componentRect(0, 800, 500.0, 400.0, 0.0, 0.0, 100.0, 100.0))
        assertNull(VizScreenCapture.componentRect(1000, 800, 0.0, 400.0, 0.0, 0.0, 100.0, 100.0))
        assertNull(VizScreenCapture.componentRect(1000, 800, 500.0, 400.0, 0.0, 0.0, 0.0, 100.0))
        assertNull(VizScreenCapture.componentRect(1000, 800, 500.0, 400.0, 0.0, 0.0, -5.0, 100.0))
    }

    @Test
    fun `部分出界的右下角被裁剪`() {
        val rect = VizScreenCapture.componentRect(1000, 800, 500.0, 400.0, 450.0, 380.0, 200.0, 100.0)
        assertEquals(Rectangle(900, 760, 100, 40), rect)
    }
}
