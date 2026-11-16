package com.zcode.ideaplugin.mdpreview

import com.intellij.openapi.vfs.VirtualFile
import java.awt.Point
import java.awt.IllegalComponentStateException
import java.util.concurrent.ConcurrentHashMap
import javax.swing.JComponent

/**
 * Markdown 预览划选快照登记表（MD 预览右键发引用功能的中枢）。
 *
 * 设计约束：**本文件不得 import 任何 org.intellij.plugins.markdown 类**——
 * optional depends 下 markdown 插件可能缺席，而本类会被 [com.zcode.ideaplugin.action.MdPreviewSelectionToInputAction]
 * 的 update()（无条件注册的 action）加载。panel 以 Any 弱语义键传入，markdown 类型只存在于
 * [ZcodeMdSelectionRefExtension]（仅在 markdown 在场时被 markdown 插件实例化）一侧。
 *
 * 数据流：注入脚本（zcodeMdSelectionRef.js）selectionchange → messagePipe →
 * 扩展订阅 → [putSnapshot]；action update() → [resolve] 决定菜单显隐，actionPerformed() →
 * snapshot 偏移 → Document 行号 → `@path#L10-20` → pushRefs。
 */
object MdPreviewSelectionRegistry {

    /** 选区相对 md 源文件的字符偏移区间（1 文档 = 同一坐标系，来自预览 DOM 位置属性） */
    data class Snapshot(val from: Int, val to: Int)

    class Entry internal constructor(
        val component: JComponent,
        val file: VirtualFile?,
        val project: com.intellij.openapi.project.Project?,
    ) {
        @Volatile
        var snapshot: Snapshot? = null
            internal set
    }

    private val entries = ConcurrentHashMap<Any, Entry>()

    fun register(panel: Any, component: JComponent, file: VirtualFile?, project: com.intellij.openapi.project.Project?) {
        entries[panel] = Entry(component, file, project)
    }

    fun unregister(panel: Any) {
        entries.remove(panel)
    }

    fun putSnapshot(panel: Any, snapshot: Snapshot?) {
        entries[panel]?.let { entry -> entry.snapshot = snapshot }
    }

    /**
     * 解析右键菜单所属的预览面板：屏幕点精确命中优先（分屏多个预览同时 showing 时定位归属），
     * 无点信息时取唯一 showing 候选兜底。返回的 entry.snapshot 为空仅表示该面板当前无选区。
     */
    fun resolve(screenPoint: Point?): Entry? {
        val showing = entries.values.filter { it.component.isShowing }
        if (showing.isEmpty()) return null
        if (screenPoint != null) {
            val hit = showing.firstOrNull { containsScreen(it.component, screenPoint) }
            if (hit != null) return hit
        }
        return if (showing.size == 1) showing[0] else null
    }

    private fun containsScreen(component: JComponent, screen: Point): Boolean {
        val location = try {
            component.locationOnScreen
        } catch (_: IllegalComponentStateException) {
            return false
        }
        return screen.x >= location.x && screen.y >= location.y &&
            screen.x <= location.x + component.width && screen.y <= location.y + component.height
    }
}
