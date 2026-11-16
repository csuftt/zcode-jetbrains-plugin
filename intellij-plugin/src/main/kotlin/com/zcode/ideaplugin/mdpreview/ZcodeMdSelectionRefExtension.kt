package com.zcode.ideaplugin.mdpreview

import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.Constraints
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.actionSystem.Separator
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.util.Disposer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.intellij.plugins.markdown.extensions.MarkdownBrowserPreviewExtension
import org.intellij.plugins.markdown.ui.preview.BrowserPipe
import org.intellij.plugins.markdown.ui.preview.MarkdownHtmlPanel
import org.intellij.plugins.markdown.ui.preview.ResourceProvider

/**
 * MD 预览划选右键发引用：markdown 插件官方 EP 的接入点。
 *
 * 本类（含 [Provider]）只在 markdown 插件在场时被其实例化（EP 实例化时机=预览面板创建），
 * 是全插件唯一直接 import org.intellij.plugins.markdown 类型的地方；上层
 * [MdPreviewSelectionRegistry]/action 均与其解耦（optional depends 防类加载崩塌）。
 *
 * 职责：
 * 1. 注入选区采集脚本（类相对资源，随预览页面构建自动带上，免疫增量 DOM 重渲染）；
 * 2. 经 BrowserPipe 订阅脚本回传，维护 [MdPreviewSelectionRegistry] 选区快照；
 * 3. 运行时把 `ZCode.MdPreviewSelectionToInput` 注入 `Markdown.PreviewGroup` 菜单组
 *    （组在预览右键弹窗时从 ActionManager 现取，注入即刻生效；233 无此组则静默跳过）。
 *
 * 兼容性：MarkdownBrowserPreviewExtension 接口 233/262 同构（scripts 为 val，编译出
 * getScripts() 满足两版）；browserPipe/project/virtualFile 两版均 @Nullable，一律安全调用。
 * 机制考据见 docs/internal/design-research/MD预览划词引用-*.md。
 */
class ZcodeMdSelectionRefExtension(private val panel: MarkdownHtmlPanel) :
    MarkdownBrowserPreviewExtension, ResourceProvider {

    override val scripts: List<String> = listOf(SCRIPT_RESOURCE)
    override val styles: List<String> = emptyList()
    override val resourceProvider: ResourceProvider = this

    private val handler = object : BrowserPipe.Handler {
        override fun processMessageReceived(data: String): Boolean = processMessage(data)
    }

    init {
        MdPreviewSelectionRegistry.register(panel, panel.component, panel.virtualFile, panel.project)
        panel.browserPipe?.subscribe(TOPIC, handler)
        Disposer.register(this) {
            panel.browserPipe?.removeSubscription(TOPIC, handler)
        }
        injectMenuAction()
    }

    private fun processMessage(data: String): Boolean {
        // 脚本回传 {"from":..,"to":..}（字符偏移区间）或 null（选区清空）
        runCatching {
            val element = Json.parseToJsonElement(data)
            if (element is JsonNull) {
                MdPreviewSelectionRegistry.putSnapshot(panel, null)
                return true
            }
            val obj = element.jsonObject
            val from = obj["from"]?.jsonPrimitive?.int ?: return true
            val to = obj["to"]?.jsonPrimitive?.int ?: return true
            MdPreviewSelectionRegistry.putSnapshot(panel, MdPreviewSelectionRegistry.Snapshot(from, to))
        }
        return true
    }

    override fun canProvide(resourceName: String): Boolean = resourceName in scripts

    override fun loadResource(resourceName: String): ResourceProvider.Resource? =
        if (resourceName in scripts) {
            ResourceProvider.loadInternalResource(this::class, resourceName)
        } else {
            null
        }

    /**
     * 注入右键菜单项。`Markdown.PreviewGroup` 为 markdown 插件应用级组（预览右键弹窗时
     * ActionUtil.getActionGroup 现取）；组不存在（233 及 markdown 插件缺席）时静默跳过，
     * action 永不显示，无副作用。
     *
     * 幂等用应用级布尔而非枚举组内子项：2026.x 起平台把 `DefaultActionGroup.getChildren(null)`
     * 升级为 Logger.error（"Do not expand action groups manually"，真机 2026.2 实测 SEVERE
     * 中断注入致菜单缺席），判重改为 EDT 串行下的布尔哨兵（add 失败不置位，下个面板再试）。
     */
    private fun injectMenuAction() {
        ApplicationManager.getApplication().invokeLater {
            if (menuInjected) return@invokeLater
            val manager = ActionManager.getInstance()
            val group = manager.getAction(MENU_GROUP_ID) as? DefaultActionGroup ?: return@invokeLater
            manager.getAction(ACTION_ID)?.let {
                // 用户定稿：菜单项置顶（11-16 真机反馈），下方加分隔线与原生项（字体/查找）隔开。
                // 两次都 FIRST：后插的在最前 → 终序 = 发送选中内容 / 分隔线 / 原生两项
                group.add(Separator.getInstance(), Constraints.FIRST)
                group.add(it, Constraints.FIRST)
                menuInjected = true
            }
        }
    }

    override fun dispose() {
        MdPreviewSelectionRegistry.unregister(panel)
    }

    class Provider : MarkdownBrowserPreviewExtension.Provider {
        override fun createBrowserExtension(panel: MarkdownHtmlPanel): MarkdownBrowserPreviewExtension =
            ZcodeMdSelectionRefExtension(panel)
    }

    private companion object {
        const val TOPIC = "zcodeMdSelection"
        const val SCRIPT_RESOURCE = "zcodeMdSelectionRef.js"
        const val MENU_GROUP_ID = "Markdown.PreviewGroup"
        const val ACTION_ID = "ZCode.MdPreviewSelectionToInput"

        /** 菜单注入哨兵：应用级一次性（EDT invokeLater 串行保证无竞态；add 成功才置位） */
        @Volatile
        private var menuInjected = false
    }
}
