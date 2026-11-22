package com.zcode.ideaplugin

import com.intellij.openapi.util.IconLoader
import javax.swing.Icon

/**
 * ZCode 插件图标
 *
 * - [ZcGui]：ZC GUI 品牌标识（深色渐变底 + 白色斜杠像素图案，自带底色，亮暗通用）；
 * - [Knowledge]：知识库 ToolWindow 用的线稿开本书（跟随 IDE 原生图标的灰色描边），
 *   亮/暗两套分别走 knowledge.svg / knowledge_dark.svg，由 IconLoader 的 dark 标记自动选用。
 */
object ZCodeIcons {
    @JvmField
    val ZcGui: Icon = IconLoader.getIcon("/icons/zcgui.svg", ZCodeIcons::class.java)

    /** 知识库（issue#54）：线稿打开的书 + 左页小折线 Z，风格与 IDE 原生工具窗图标一致。 */
    @JvmField
    val Knowledge: Icon = IconLoader.getIcon("/icons/knowledge.svg", ZCodeIcons::class.java)
}
