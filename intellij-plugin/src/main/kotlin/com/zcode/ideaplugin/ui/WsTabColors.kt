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
 * 金黄保留为项目专属色（2026-11-06 用户终审：突兀感根因是块内中文字形——笔画密，
 * 白字压亮底劣化远比 ASCII 字母严重；解法=整套色板按「白字对比度 ≥4.5」压暗一档，
 * 色相/顺序/专属语义全不动），金黄同步压暗见 [PROJECT_GOLD]。
 * webview 侧同款色值在 variables.less --ws-dir-1..9，改动须三处同步。
 */
object WsTabColors {

    /** 色块颜色深度（外观设置页「色块颜色深度」横向滑条，2026-11-07）：存储/传输=百分比
     *  0..100，50=默认档（2026-11-06 五轮调色终稿色板，白字 2.7~2.9）。滑条两端较五档制放开：
     *  0%≈白字 5.5+（最深），100%≈1.9~2.1（贴近原金黄 1.95 洗白线，观感用户自担）。
     *  实现=对基准色板做 HSL 亮度等比偏移（色相/饱和度不动，同调色轮 search 法），端点
     *  ±[DEPTH_L_OFFSET_MAX]；webview 同公式现算注入 CSS 变量，两端逐位一致。 */
    const val DEPTH_DEFAULT_PERCENT = 50

    /** 滑条端点的 HSL 亮度偏移幅度（相对默认档：0%=−0.14 最深，100%=+0.14 最亮） */
    private const val DEPTH_L_OFFSET_MAX = 0.14

    /** 基准 9 色板（=默认档）(light, dark) 原始 RGB。顺序为用户定稿（2026-11-03）：橙 → 青 → 蓝…红 */
    private val BASE_PALETTE: List<Pair<Int, Int>> = listOf(
        0xF07500 to 0xF07500, 0x10AB98 to 0x12AB9A, 0x549BEC to 0x539DE6,
        0x9C8EDA to 0x9C8CE7, 0xA98DCE to 0xA58DC8, 0xD676C8 to 0xC182C4,
        0xC67FC5 to 0xD27AC7, 0xDA7C95 to 0xD77D94, 0xDD7D75 to 0xDD7D76,
    )

    /** 基准金黄 (light, dark)（webview --ws-badge-gold 同值） */
    private val BASE_GOLD: Pair<Int, Int> = 0xC98D00 to 0xCA8F00

    /** 百分比钳制（纯函数测试锚点）：null/越界收 0..100 */
    fun clampPercent(v: Int?): Int = (v ?: DEPTH_DEFAULT_PERCENT).coerceIn(0, 100)

    /** 百分比 → HSL 亮度偏移（纯函数测试锚点）：50%↔0，线性过渡到 ±[DEPTH_L_OFFSET_MAX] */
    fun lightnessOffset(percent: Int): Double = (clampPercent(percent) - 50) / 50.0 * DEPTH_L_OFFSET_MAX

    /** 单个 RGB 值的 HSL 亮度偏移：RGB→HSB→B+δ→RGB（HSB 的 B 即 HSL 的 L） */
    private fun shiftRgb(rgb: Int, delta: Double): Int {
        val hsb = FloatArray(3)
        java.awt.Color.RGBtoHSB((rgb shr 16) and 0xFF, (rgb shr 8) and 0xFF, rgb and 0xFF, hsb)
        hsb[2] = (hsb[2] + delta).toFloat().coerceIn(0f, 1f)
        return java.awt.Color.HSBtoRGB(hsb[0], hsb[1], hsb[2]) and 0xFFFFFF
    }

    /** 按百分比取 9 色板（纯函数测试锚点）：δ=0 原样返回免浮点往返，其余现算 */
    fun paletteAt(percent: Int): List<JBColor> {
        val delta = lightnessOffset(percent)
        if (delta == 0.0) return BASE_PALETTE.map { JBColor(it.first, it.second) }
        return BASE_PALETTE.map { JBColor(shiftRgb(it.first, delta), shiftRgb(it.second, delta)) }
    }

    /** 按百分比取金黄（纯函数测试锚点） */
    fun goldAt(percent: Int): JBColor {
        val delta = lightnessOffset(percent)
        return if (delta == 0.0) JBColor(BASE_GOLD.first, BASE_GOLD.second)
        else JBColor(shiftRgb(BASE_GOLD.first, delta), shiftRgb(BASE_GOLD.second, delta))
    }

    /** 当前生效百分比（外观配置现读——色块绘制低频，PropertiesComponent 读是内存查找） */
    fun depthPercent(): Int = clampPercent(ZCodeAppearanceStore.wsColorDepthRaw())

    /** 本项目专属色相（外观设置页「默认色块颜色」，2026-11-07）：-2=自定义 hex（不占轮换
     *  序列，不参与深度偏移——用户钦定即最终色）；-1=默认金黄（不占轮换序列，目录从序列
     *  第 0 位轮起）；0..8=该基准色相成为本项目色——该色提到轮换序列第 0 位、其余按原
     *  相对顺序后推，关联目录从第 1 位轮起（防与本项目撞色） */
    const val PROJECT_HUE_DEFAULT = -1
    const val PROJECT_HUE_CUSTOM = -2

    /** 当前项目色相（外观配置现读；非法回默认 -1） */
    fun projectHue(): Int = clampProjectHue(ZCodeAppearanceStore.wsProjectColorIdxRaw())

    /** 项目色相钳制（纯函数测试锚点）：null/-1=默认金黄，-2=自定义，0..8 原样，越界收 -1 */
    fun clampProjectHue(v: Int?): Int = (v ?: PROJECT_HUE_DEFAULT)
        .takeIf { it in PROJECT_HUE_CUSTOM..8 } ?: PROJECT_HUE_DEFAULT

    /**
     * 关联目录 → 色序号映射（纯函数测试锚点；**-1=金黄**，0..8=基准色相）。
     * 默认（[projectHue]<0，含 -2 自定义）：金黄是项目色不占目录序列，目录按位置直轮
     * （0=橙…8=红）。
     * 选中色相 k（2026-11-07 用户定稿修正）：项目色=该色（排所有色块之首），**金黄降入
     * 目录序列且永远排第一**（用户定稿「金黄永远在第一个」+「金黄也参与其他目录序列」），
     * 其余色相按原相对顺序去掉 k 后推——目录序列=[金黄, 0..8 去 k]；第 10 个目录回绕金黄。
     */
    fun hueIndexForLink(linkIdx: Int, projectHue: Int): Int {
        val k = clampProjectHue(projectHue)
        if (k < 0) return ((linkIdx % 9) + 9) % 9
        val seq = listOf(-1) + (0..8).filter { it != k }
        return seq[(((linkIdx % 9) + 9) % 9)]
    }

    /** 按色相序号+深度百分比取色（resolve/调用方共用）：depthPercent 零偏移走原色免浮点往返 */
    fun hueAt(hue: Int, percent: Int): JBColor {
        val idx = hue.coerceIn(0, 8)
        val delta = lightnessOffset(percent)
        val base = BASE_PALETTE[idx]
        return if (delta == 0.0) JBColor(base.first, base.second)
        else JBColor(shiftRgb(base.first, delta), shiftRgb(base.second, delta))
    }

    /** 当前项目色（resolve 消费）：默认金黄 / 选中色相的深度偏移色 / 自定义 hex 原色
     *  （不参与深度偏移——用户钦定即最终色；hex 非法回退金黄） */
    fun projectColor(): JBColor {
        val hue = projectHue()
        return when {
            hue == PROJECT_HUE_CUSTOM -> customProjectColor() ?: goldAt(depthPercent())
            hue < 0 -> goldAt(depthPercent())
            else -> hueAt(hue, depthPercent())
        }
    }

    /** 自定义项目色（hex #rrggbb，外观配置现读；解码失败 null 回退金黄） */
    fun customProjectColor(): JBColor? = ZCodeAppearanceStore.wsProjectCustomHexRaw()?.let {
        runCatching { JBColor(java.awt.Color.decode(it), java.awt.Color.decode(it)) }.getOrNull()
    }

    /** 当前百分比 9 色板（滑条深度维度的取值入口；目录色解析走 [hueAt]+[hueIndexForLink]） */
    val PALETTE: List<JBColor> get() = paletteAt(depthPercent())

    /** 当前百分比金黄（webview --ws-badge-gold 同值；项目色解析走 [projectColor]） */
    val PROJECT_GOLD: JBColor get() = goldAt(depthPercent())

    /**
     * 目录颜色解析：项目根=项目色（默认金黄；外观设置页可选基准色相/自定义 hex）；
     * 关联目录（及任何会话归属目录）=轮换序列（-1=金黄/0..8=色相，[hueIndexForLink]）。
     * 空路径回退项目色（落位空=本项目的默认语义）。
     */
    fun resolve(project: Project, workspacePath: String): JBColor {
        val baseKey = project.basePath?.let { ZCodeLinkedWorkspaces.wsKey(it) }
        if (workspacePath.isNotBlank() && baseKey != null &&
            ZCodeLinkedWorkspaces.wsKey(workspacePath) != baseKey
        ) {
            val hue = hueIndexForLink(ZCodeLinkedWorkspaces.colorIndexFor(project, workspacePath), projectHue())
            return if (hue < 0) goldAt(depthPercent()) else hueAt(hue, depthPercent())
        }
        return projectColor()
    }

    /**
     * 目录色块图标工厂：色板色 + 块内字符（IDEA 项目头像同款辨识）。
     * [hollow]=待命空标签变体（° 前缀退役后的空标签标识，用户定稿 2026-11-02）：
     * 空心描边块+彩色字=无会话，实心填充+白字=有会话——延续 ●实心在跑/○空心空 的设计语言。
     * [letterOverride]=会话名首字符（webview setTabTitle 无条件推送）：**仅 [singleWorkspace]
     * 时采用**（目录字符全同无区分度，2026-11-02 用户定稿），多目录仍用目录首字符。
     * [singleWorkspace] 判据由调用方给（2026-11-06 扩展）：面板实况=打开标签取色轴目录
     * 唯一（[ZCodeToolWindowPanel.isOpenTabsSingleDirectory]），缺省回落「无关联目录」旧口径。
     */
    fun iconFor(
        project: Project,
        workspacePath: String,
        hollow: Boolean = false,
        letterOverride: String? = null,
        singleWorkspace: Boolean = ZCodeLinkedWorkspaces.read(project).isEmpty(),
    ): Icon =
        WsColorBlockIcon(resolve(project, workspacePath), pickLetter(singleWorkspace, letterOverride, workspacePath), hollow)

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

    /** 定比混合（纯色混合不引 ColorUtil 语义歧义）：a×(1-t) + b×t */
    private fun blend(a: java.awt.Color, b: java.awt.Color, t: Double): java.awt.Color = java.awt.Color(
        (a.red * (1 - t) + b.red * t).toInt().coerceIn(0, 255),
        (a.green * (1 - t) + b.green * t).toInt().coerceIn(0, 255),
        (a.blue * (1 - t) + b.blue * t).toInt().coerceIn(0, 255),
    )

    /** 空心态用色：色板压暗后（白字达标线）描边/彩字在暗底上会发闷，暗主题混 35% 白
     *  提亮回可见性 ≥4.4:1（实测校验 2026-11-06）；浅主题直接用压暗色（浅底上压暗色
     *  本就醒目）。paintIcon 每帧按 JBColor.isBright() 现算，切主题跟随（缺陷FC 同款
     *  纪律；2023.3 JBColor 无 Supplier 构造器，不能字段级懒缓存）。 */
    private fun hollowColor(): java.awt.Color =
        if (JBColor.isBright()) color else blend(color, java.awt.Color.WHITE, 0.35)

    override fun paintIcon(c: Component?, g: Graphics?, x: Int, y: Int) {
        val g2 = g?.create() as? Graphics2D ?: return
        try {
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            val size = JBUI.scale(13f)
            val arc = JBUI.scale(3.5f)
            val fx = x + (iconWidth - size) / 2f
            val fy = y + (iconHeight - size) / 2f
            g2.color = if (hollow) hollowColor() else color
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
            // 字形色：实心=白（压暗彩底 ≥4.5 可读）；空心=色板色（透明底直接彩字）
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
