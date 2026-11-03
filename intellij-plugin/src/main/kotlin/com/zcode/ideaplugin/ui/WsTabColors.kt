package com.zcode.ideaplugin.ui

import com.intellij.openapi.project.Project
import com.intellij.ui.JBColor
import com.intellij.util.ui.JBUI
import java.awt.Component
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.RenderingHints
import java.awt.geom.RoundRectangle2D
import javax.swing.Icon

/**
 * 标签目录色块配色（2026-11-02 调研定稿，见内部仓
 * design-research/标签目录色块可行性调研-2026-11-02.md）。
 *
 * 色板抄自 IDEA「项目颜色」9 色板（com.intellij.ide.RecentProjectIconHelper 的
 * ProjectIconPalette Start 色，2024.1 源码核对），观感与 IDEA git 面板目录色块同族；
 * 按目录轮询分配（[ZCodeLinkedWorkspaces.colorIndexFor]，kv 持久化跨重启稳定）。
 * 注意：IDEA git 面板那个色块本质是分支颜色非项目颜色，逐分支复刻已否——
 * 同观感、目录键位，这是调研定稿的核心取舍。
 * 本项目目录固定金黄（webview --ws-badge-gold 同源值），不进轮询。
 * webview 侧同款色值在 variables.less --ws-dir-1..9，改动须三处同步。
 */
object WsTabColors {

    /** 9 色板：JBColor(light, dark)，IDEA ProjectIconPalette Start 色对。
     *  顺序为用户定稿（2026-11-03 三轮修正）：金黄(本项目) → 橙 → 青 → 蓝…红 */
    val PALETTE: List<JBColor> = listOf(
        JBColor(0xF57236, 0xE27237), // 1 橙
        JBColor(0x2BC8BB, 0x2DBCAD), // 2 青
        JBColor(0x359AF2, 0x3895E1), // 3 蓝
        JBColor(0x8379FB, 0x7B75E8), // 4 紫
        JBColor(0x7E54B5, 0x7854AD), // 5 深紫
        JBColor(0xD63CC8, 0x8F4593), // 6 洋红
        JBColor(0x954294, 0xC840B9), // 7 紫红
        JBColor(0xE75371, 0xD75370), // 8 粉红
        JBColor(0xDB3D3C, 0xCE443C), // 9 红
    )

    /** 本项目金黄（webview --ws-badge-gold 同值：浅底加深/暗底提亮） */
    val PROJECT_GOLD: JBColor = JBColor(0xA67708, 0xE2B34E)

    /**
     * 目录颜色解析：项目根=金黄；关联目录（及任何会话归属目录）=轮询色板。
     * 空路径回退金黄（落位空=本项目的默认语义）。
     */
    fun resolve(project: Project, workspacePath: String): JBColor {
        val baseKey = project.basePath?.let { ZCodeLinkedWorkspaces.wsKey(it) }
        if (workspacePath.isNotBlank() && baseKey != null &&
            ZCodeLinkedWorkspaces.wsKey(workspacePath) != baseKey
        ) {
            return PALETTE[ZCodeLinkedWorkspaces.colorIndexFor(project, workspacePath)]
        }
        return PROJECT_GOLD
    }

    /**
     * 目录色块图标工厂：色板色 + 块内字符（IDEA 项目头像同款辨识）。
     * [hollow]=待命空标签变体（° 前缀退役后的空标签标识，用户定稿 2026-11-02）：
     * 空心描边块+彩色字=无会话，实心填充+白字=有会话——延续 ●实心在跑/○空心空 的设计语言。
     * [letterOverride]=会话名首字符（webview setTabTitle 推送）：**仅单工作区时采用**
     * （目录字符在单工作区全同无区分度，2026-11-02 用户定稿），多工作区仍用目录首字符。
     */
    fun iconFor(project: Project, workspacePath: String, hollow: Boolean = false, letterOverride: String? = null): Icon =
        WsColorBlockIcon(resolve(project, workspacePath), pickLetter(ZCodeLinkedWorkspaces.read(project).isEmpty(), letterOverride, workspacePath), hollow)

    /**
     * 块内字符选取（纯函数单测锚点）：单工作区且有会话名首字符 → 会话名首字符；
     * 其余（多工作区/待命无推送/无项目外目录）→ 目录名首字符。
     */
    fun pickLetter(singleWorkspace: Boolean, letterOverride: String?, workspacePath: String): String =
        if (singleWorkspace && !letterOverride.isNullOrBlank()) letterOverride else displayChar(workspacePath)

    /**
     * 推送字母可用性判定（纯函数单测锚点）：字母非空且其推送会话=当前会话才采用。
     * webview 的字母推送只在标题变化时发一次（去重键=目录+标题），而 Java 侧
     * refreshTabColorIcon 在回合中/轮末反复兜底重挂（messages 重拉等）必须沿用已推送
     * 字母，否则把会话首字符冲回目录首字符且永不再自愈（单工作区竞态，真机
     * 2026-11-03）；配对 sessionId 防跨会话串字——切会话/清位后旧字母自然失效，
     * 等新会话的推送接管，待命（currentSessionId 空）恒不用字母（空心块目录字符）。
     */
    fun resolvePushedLetter(letter: String?, letterSession: String?, currentSessionId: String?): String? =
        letter?.takeIf { it.isNotBlank() }
            ?.takeIf { !currentSessionId.isNullOrBlank() && letterSession == currentSessionId }

    /** 目录名首字符（basename 第一个码点，ASCII 大写化；空 basename 回退中点） */
    fun displayChar(path: String): String {
        val base = path.replace('\\', '/').trimEnd('/').substringAfterLast('/').trim()
        if (base.isEmpty()) return "·"
        val sb = StringBuilder().appendCodePoint(base.codePointAt(0))
        return sb.toString().uppercase()
    }

    /** 目录路径取末段显示名（badge/chip/tooltip 通用；空段回退原串） */
    fun dirBasename(path: String): String {
        val base = path.replace('\\', '/').trimEnd('/').substringAfterLast('/')
        return base.ifEmpty { path }
    }

    /** HTML 转义：标签 tooltip 走 Swing HTML 通道，标题/目录名必须原样呈现防结构破坏 */
    fun escapeHtml(s: String): String =
        s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")

    /**
     * 标签 tooltip 组合（纯函数测试锚点）：[dirName]/[dirColor] 齐备=多工作区——目录按
     * **与会话名下徽标同配比**呈现：底=目录色 14% 混 tooltip 背景、字=目录色 75% 混
     * 前景色（Swing HTML 无 color-mix，等比预混成不透明 hex；用户定稿 2026-11-03
     * 对齐徽标观感，【】文字前缀废弃）；否则纯会话名（单工作区/无目录）。
     * [tooltipBg]/[tooltipFg] 由调用方取 UIUtil.getToolTipBackground/getLabelForeground。
     */
    fun tooltipHtml(dirName: String?, dirColor: java.awt.Color?, tooltipBg: java.awt.Color, tooltipFg: java.awt.Color, title: String): String {
        val safeTitle = escapeHtml(title)
        if (dirName.isNullOrBlank() || dirColor == null) return safeTitle
        // 14%≈36/255、75%≈191/255；alphaBlending=前景按透明度合成到背景，得完全不透明 hex
        val bg = com.intellij.ui.ColorUtil.toHex(
            com.intellij.ui.ColorUtil.alphaBlending(com.intellij.ui.ColorUtil.toAlpha(dirColor, 36), tooltipBg),
        )
        val fg = com.intellij.ui.ColorUtil.toHex(
            com.intellij.ui.ColorUtil.alphaBlending(com.intellij.ui.ColorUtil.toAlpha(dirColor, 191), tooltipFg),
        )
        return "<html><span style=\"background-color:#$bg;color:#$fg;font-size:10pt;\">&nbsp;${escapeHtml(dirName)}&nbsp;</span>&nbsp;&nbsp;$safeTitle</html>"
    }
}

/**
 * 标签名字前的目录色块图标：13px 圆角方块（居中于 16px 高图标槽）+ 内嵌目录首字符。
 * 两形态：实心（彩底白字=有会话）/ 空心（透明底描边+彩字=待命空标签）。
 * 用 JBColor 动态画（每帧取当前主题解析色），绝不缓存成位图——切主题要跟着刷
 * （缺陷FC 同款教训：webview 侧 JBColor 进程缓存坑的 Java 侧对偶）。
 */
class WsColorBlockIcon(private val color: JBColor, private val letter: String, private val hollow: Boolean = false) : Icon {

    /** 字形字体：标签字体的 ~72%（跟随系统缩放），粗体 */
    private val glyphFont: java.awt.Font by lazy {
        com.intellij.util.ui.JBFont.label().deriveFont(java.awt.Font.BOLD, com.intellij.util.ui.JBFont.label().size2D * 0.72f)
    }

    override fun paintIcon(c: Component?, g: Graphics?, x: Int, y: Int) {
        val g2 = g?.create() as? Graphics2D ?: return
        try {
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            val size = JBUI.scale(13f)
            val arc = JBUI.scale(3.5f)
            val fx = x + (iconWidth - size) / 2f
            val fy = y + (iconHeight - size) / 2f
            g2.color = color
            if (hollow) {
                // 空心：1.2px 圆角描边内收半线宽防裁切；首字符用色板色（透明底上保持可读）
                val sw = JBUI.scale(1.2f)
                g2.stroke = java.awt.BasicStroke(sw, java.awt.BasicStroke.CAP_BUTT, java.awt.BasicStroke.JOIN_ROUND)
                g2.draw(RoundRectangle2D.Float(fx + sw / 2f, fy + sw / 2f, size - sw, size - sw, arc, arc))
            } else {
                g2.fill(RoundRectangle2D.Float(fx, fy, size, size, arc, arc))
            }
            g2.font = glyphFont
            val fm = g2.fontMetrics
            // 字形色：实心=白（饱和彩底可读）；空心=色板色（透明底直接彩字）
            if (!hollow) g2.color = java.awt.Color.WHITE
            val tx = fx + (size - fm.stringWidth(letter)) / 2f
            val ty = fy + (size - (fm.ascent + fm.descent)) / 2f + fm.ascent
            g2.drawString(letter, tx, ty)
        } finally {
            g2.dispose()
        }
    }

    override fun getIconWidth(): Int = JBUI.scale(15)

    override fun getIconHeight(): Int = JBUI.scale(16)
}
