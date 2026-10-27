package com.zcode.ideaplugin.viz

import java.awt.Rectangle
import java.awt.Robot
import java.awt.image.BufferedImage
import kotlin.math.roundToInt

/**
 * ::visualize「复制图片」的屏幕截取（webview iframe → PNG）
 *
 * iframe 是沙箱 opaque origin，DOM/canvas 都拿不到内容（foreignObject 序列化还会撞
 * Chromium taint 红线，mermaid 已实测）；JCEF 是 heavyweight native 组件，Swing paint
 * 也拿不到——唯一通路是前端上报 iframe 的视口矩形，Java 侧 Robot 对屏幕区域截屏。
 *
 * 坐标换算用比例法（前端 DOMRect / 视口尺寸 → JCEF 组件内矩形），天然免疫 CEF zoom
 * 与系统 DPI；Robot.createScreenCapture 在 JDK9+ HiDPI 下接受 AWT 逻辑坐标、返回物理
 * 像素图（JBR 17 同行为），所以 locationOnScreen(逻辑) + 组件内矩形直接相加即可。
 */
object VizScreenCapture {

    /**
     * 前端上报的 iframe 视口矩形 → JCEF 组件内逻辑矩形（超出组件的部分裁剪）。
     * 返回 null = 参数非法或裁剪后为空（iframe 完全在视口外）。
     */
    internal fun componentRect(
        compW: Int,
        compH: Int,
        vw: Double,
        vh: Double,
        x: Double,
        y: Double,
        w: Double,
        h: Double,
    ): Rectangle? {
        if (compW <= 0 || compH <= 0 || vw <= 0.0 || vh <= 0.0 || w <= 0.0 || h <= 0.0) return null
        val sx = compW / vw
        val sy = compH / vh
        val rect = Rectangle(
            (x * sx).roundToInt(),
            (y * sy).roundToInt(),
            (w * sx).roundToInt(),
            (h * sy).roundToInt(),
        )
        val clipped = rect.intersection(Rectangle(0, 0, compW, compH))
        return if (clipped.width > 0 && clipped.height > 0) clipped else null
    }

    /** 对组件所在屏幕的给定组件内矩形截屏（组件须已显示）。失败返回 null。 */
    fun captureComponentRect(comp: java.awt.Component, rect: Rectangle): BufferedImage? {
        return try {
            val loc = comp.locationOnScreen
            val robot = Robot(comp.graphicsConfiguration.device)
            robot.createScreenCapture(Rectangle(loc.x + rect.x, loc.y + rect.y, rect.width, rect.height))
        } catch (e: Exception) {
            null
        }
    }
}
