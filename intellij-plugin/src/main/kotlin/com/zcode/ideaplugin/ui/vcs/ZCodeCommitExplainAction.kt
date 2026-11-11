package com.zcode.ideaplugin.ui.vcs

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.editor.colors.EditorFontType
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.Disposable
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.util.Disposer
import com.intellij.ui.JBColor
import com.intellij.util.ui.JBFont
import com.intellij.vcs.log.CommitId
import com.intellij.vcs.log.VcsLogDataKeys
import com.intellij.vcs.log.VcsLogCommitSelection
import com.zcode.ideaplugin.ZCodeBundle.message
import com.zcode.ideaplugin.zCodeService
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.event.ActionEvent
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import javax.swing.AbstractAction
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JScrollPane
import javax.swing.JTextArea
import javax.swing.JEditorPane
import javax.swing.ScrollPaneConstants
import javax.swing.event.HyperlinkEvent
import javax.swing.text.html.HTMLEditorKit

/**
 * VCS Log 右键「让 ZC GUI 解释这个提交」（IDEA 集成面调研 ⑥）：
 * 取所选提交的 diff（[ZCodeCommitDiffProvider.generateForCommit]，`git show` 带元信息头），
 * 直接走润色同款 generateText 通道（[com.zcode.ideaplugin.ui.LightTaskModels.resolveForGeneration]
 * 轻任务模型链 + getEnhanceClient 专用实例）生成解读，**弹窗直出结果**——不落输入框
 * 不开新会话（2026-11-11 真机反馈：送输入框要切面板打断工作流，弹窗即看即关）。
 *
 * 弹窗内容（2026-11-11 真机反馈三轮）：头部=提交短 id + 主题行（[ZCodeCommitDiffProvider
 * .commitHeading]）；正文=markdown 渲染（平台捆绑 org.intellij.markdown GFM → HTML，
 * JEditorPane 展示，链接可点）；复制钮复制模型原始 markdown。
 *
 * 交互：点击即弹「生成中…（已等 N 秒）」占位窗（模型名就绪后切「<模型名> 生成中…」）；
 * 失败弹窗内红字给原因；再次点击/关窗 = 取消在途生成（workspace/cancelGenerateText
 * 插队旁路）。generateText 无流式形态，占位符表达进行中。
 *
 * 挂点（233 探针实证）：`Vcs.Log.ContextMenu` 平台级组（app.jar!META-INF/vcs-log.xml 定义）；
 * 数据面 `VcsLogDataKeys.VCS_LOG_COMMIT_SELECTION` → `VcsLogCommitSelection.getCommits()`
 * → `CommitId(hash, root)`。类体内引用 git4idea，注册在 git4idea-dependency.xml（可选链）。
 */
class ZCodeCommitExplainAction : AnAction(
    message("action.commitExplain.text"),
    message("action.commitExplain.description"),
    null,
), DumbAware {

    companion object {
        private val log = Logger.getInstance("ZCodePlugin")

        /** 在途解释会话（project → dialog）：重触发先 cancel 旧代，完成/关窗自摘 */
        private val ACTIVE = ConcurrentHashMap<Project, ExplainDialog>()
        private val OP_COUNTER = AtomicLong(0)
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT

    override fun update(e: AnActionEvent) {
        // VCS Log 数据规则在 EDT 上取最稳（update 只做非空判）
        val selection = e.getData(VcsLogDataKeys.VCS_LOG_COMMIT_SELECTION)
        e.presentation.isEnabledAndVisible = selection != null && !selection.commits.isEmpty()
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val selection: VcsLogCommitSelection =
            e.getData(VcsLogDataKeys.VCS_LOG_COMMIT_SELECTION) ?: return
        // v1 只解释首个选中提交（多选逐条排队属二期）
        val commit: CommitId = selection.commits.firstOrNull() ?: return
        val revision = commit.hash.asString()
        val root = commit.root

        // 重触发 = 取消在途并关旧弹窗（换一个提交再点 = 重新解释）
        ACTIVE.remove(project)?.cancel()

        val opId = "commit-explain-" + OP_COUNTER.incrementAndGet()
        val dialog = ExplainDialog(project, opId) { ACTIVE.remove(project) }
        ACTIVE[project] = dialog

        // 先派后台任务再 show()：模态时代 show() 阻塞 EDT 直到关窗，调度写在后面
        // 永远执行不到（真机 2026-11-11 实锤：弹窗「生成中」干等 152s 连模型名都不出）；
        // 改非模态后 show() 不再阻塞，顺序保留无害且保证弹窗弹出时生成已在跑。
        // 后台完成走 invokeLater(ModalityState.any()) 照常送达弹窗。
        // EDT 上只留快照，git 与 RPC 全在后台
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                // 提交头（短 id + 主题）：失败只少一行头，不阻断解释
                ZCodeCommitDiffProvider.commitHeading(project, root, revision)?.let { (id, subject) ->
                    ApplicationManager.getApplication().invokeLater({
                        dialog.setHeading(id, subject)
                    }, ModalityState.any())
                }
                val diff = ZCodeCommitDiffProvider.generateForCommit(project, root, revision)
                if (diff.isBlank()) {
                    dialog.failLater(message("commit.explain.noDiff"))
                    return@executeOnPooledThread
                }
                log.info("[commit-explain] generating for $revision (${diff.length} chars)")
                // 轻任务模型链（与润色/AI 提交信息同源，issue #48 归一）
                val model = com.zcode.ideaplugin.ui.LightTaskModels.resolveForGeneration()
                if (model == null) {
                    dialog.failLater(message("commit.noModel"))
                    return@executeOnPooledThread
                }
                dialog.modelReady(model.second)
                val ws = project.basePath
                if (ws.isNullOrBlank()) {
                    dialog.failLater(message("commit.noWorkspace"))
                    return@executeOnPooledThread
                }
                val client = clientOf(project)
                // 超时随 diff 规模放大（与 AI 提交信息同式），上限 120s
                val timeoutMs = (30_000L + diff.length / 400L * 1_000L).coerceAtMost(120_000L)
                val prompt = message("commit.explain.lead") + "\n\n```diff\n" + diff + "\n```"
                val result = client.generateText(
                    workspacePath = ws,
                    providerId = model.first,
                    modelId = model.second,
                    prompt = prompt,
                    systemPrompt = null,
                    querySource = "commit_explain",
                    timeoutMs = timeoutMs,
                    reasoningLevel = client.lightReasoningLevel(model.second),
                    operationId = opId,
                )
                val text = (result["text"]?.jsonPrimitive?.contentOrNull ?: "").trim()
                if (text.isEmpty()) {
                    dialog.failLater(message("commit.emptyResult"))
                    return@executeOnPooledThread
                }
                log.info("[commit-explain] done (${text.length} chars, model=${model.first}/${model.second})")
                ApplicationManager.getApplication().invokeLater({
                    // 代际守卫：生成期间用户重触发（旧 dialog 已被顶掉）→ 丢弃迟到结果
                    if (ACTIVE[project] === dialog) dialog.showResult(text)
                }, ModalityState.any())
            } catch (t: Throwable) {
                log.warn("[commit-explain] failed: ${t.message?.take(200)}")
                dialog.failLater(t.message ?: "unknown")
            }
        }

        // 后台任务已派出，此刻才弹窗（show() 阻塞 EDT 属预期，见上）
        dialog.show()
    }

    /** 轻任务实例（与 AI 提交信息同款回退链：实例起不来退主 client，串行排队可接受） */
    private fun clientOf(project: Project) = try {
        project.zCodeService().getEnhanceClient()
    } catch (e: Exception) {
        project.zCodeService().getClient()
    }
}

/**
 * 解释弹窗：即点即弹的**非模态**窗（2026-11-11 用户反馈：生成要等几十秒，模态窗
 * 阻塞整个 IDE 输入且 Windows 对有模态窗按 OS 惯例不给最小化钮——真非模态后标题栏
 * 自带最小化，生成期间可自由切走干其他活），头部=提交短 id+主题；占位（进行中）→
 * markdown 结果/失败原地切换。关窗（含 OK/取消/标题栏 X）= 取消在途生成
 * （cancelGenerateText 旁路，后台线程发）。
 *
 * ⚠️ 必须用 [DialogWrapper.IdeModalityType.MODELESS] 三参枚举构造：首版用
 * `DialogWrapper(project, true, false)` 真机验证仍阻塞——反汇编 233 平台实锤，
 * 该布尔构造把 isModal=false 映射成 IdeModalityType.PROJECT（项目级模态，单项目
 * 窗口下体验≈全模态，Windows 也不给最小化钮）；MODELESS 才映射 AWT MODELESS。
 */
private class ExplainDialog(
    private val project: Project,
    private val opId: String,
    private val onClosed: () -> Unit,
) : DialogWrapper(project, true, DialogWrapper.IdeModalityType.MODELESS) {

    private val log = Logger.getInstance("ZCodePlugin")

    // ---- 头部：短 id（粗体等宽）+ 主题行（超长省略+tooltip 全文） ----
    private val monoFont: java.awt.Font = EditorColorsManager.getInstance()
        .globalScheme.getFont(EditorFontType.PLAIN)

    private val hashLabel = JLabel().apply {
        font = monoFont.deriveFont(java.awt.Font.BOLD)
        foreground = JBColor.namedColor("Link.activeForeground", JBColor.BLUE)
        isVisible = false
    }
    private val subjectLabel = JLabel().apply {
        isVisible = false
    }

    /** 模型输出的原始 markdown（复制钮复制它，非渲染后 HTML） */
    @Volatile
    private var rawText: String? = null

    // ---- 正文：markdown 渲染面板（GFM → HTML，JEditorPane；不可编辑、链接可点） ----
    private val htmlPane = JEditorPane().apply {
        isEditable = false
        contentType = "text/html"
        isOpaque = false
        putClientProperty(JEditorPane.HONOR_DISPLAY_PROPERTIES, true)
        (editorKit as? HTMLEditorKit)?.styleSheet?.addRule(
            buildString {
                append("body { font-family: '").append(JBFont.label().family)
                append("'; font-size: ").append(JBFont.label().size).append("; }")
                append("code, pre { font-family: '").append(monoFont.family)
                append("'; font-size: ").append(monoFont.size).append("; }")
                // 代码块浅衬底（主题感知灰，swing CSS 不认就自动忽略，无害）
                append("pre { background: #").append(
                    Integer.toHexString(JBColor.border().rgb and 0xFFFFFF),
                ).append("22; }")
            },
        )
        addHyperlinkListener { e ->
            if (e.eventType == HyperlinkEvent.EventType.ACTIVATED) e.url?.let { BrowserUtil.browse(it) }
        }
    }

    private val statusLabel = JLabel(message("commit.generating"))

    /** 进度占位（generateText 无流式，用已等待秒数 ticker 表达进行中，AI 提交信息同式） */
    private val startedAt = System.currentTimeMillis()
    private val modelRef = java.util.concurrent.atomic.AtomicReference<String?>(null)
    private val ticker = javax.swing.Timer(1000) {
        if (!isShowing || isDisposed) {
            (it.source as? javax.swing.Timer)?.stop()
        } else {
            val elapsed = (System.currentTimeMillis() - startedAt) / 1000
            val modelName = modelRef.get()
            statusLabel.text =
                if (modelName != null) message("commit.generatingModel", modelName, elapsed)
                else message("commit.generatingProgress", elapsed)
        }
    }

    /** 用户已关窗（取消）：迟到结果/失败一律丢弃 */
    @Volatile
    private var cancelled = false

    /** 结果落地后启用的复制钮（属性初始化须先于 init()——createActions 在 init 内回调） */
    private val copyAction = object : AbstractAction(message("commit.explain.copy")) {
        init {
            isEnabled = false
        }

        override fun actionPerformed(e: ActionEvent?) {
            val content = rawText ?: return
            com.intellij.openapi.ide.CopyPasteManager.getInstance()
                .setContents(java.awt.datatransfer.StringSelection(content))
        }
    }

    init {
        title = message("commit.explain.dialogTitle")
        // 非模态后弹窗生命周期与 project 解耦（模态时代用户关不掉 project，天然无此
        // 路径）：project 关闭时自动取消在途生成并收掉弹窗，防孤儿窗+迟到结果写死窗
        Disposer.register(project, Disposable { cancel() })
        ticker.start()
        init()
    }

    override fun createCenterPanel(): JComponent {
        val head = JPanel(BorderLayout(8, 0)).apply {
            isOpaque = false
            add(hashLabel, BorderLayout.WEST)
            add(subjectLabel, BorderLayout.CENTER)
        }
        val body = JPanel(BorderLayout(0, 8)).apply {
            isOpaque = false
            add(head, BorderLayout.NORTH)
            add(statusLabel, BorderLayout.SOUTH)
            add(JScrollPane(htmlPane).apply {
                preferredSize = Dimension(680, 460)
                verticalScrollBarPolicy = ScrollPaneConstants.VERTICAL_SCROLLBAR_AS_NEEDED
            }, BorderLayout.CENTER)
        }
        return body
    }

    /** 动作组：复制（结果就绪后启用）+ 关闭（关窗即取消在途生成） */
    override fun createActions(): Array<javax.swing.Action> = arrayOf(copyAction, okAction)

    /** 提交头（EDT）：短 id + 主题；主题超长省略，tooltip 给全文 */
    fun setHeading(shortId: String, subject: String) {
        if (cancelled || isDisposed) return
        hashLabel.text = shortId
        hashLabel.isVisible = true
        subjectLabel.text = if (subject.length > 90) subject.take(90) + "…" else subject
        subjectLabel.toolTipText = subject
        subjectLabel.isVisible = true
    }

    /** 模型解析就绪（进度占位切「<模型名> 生成中…」） */
    fun modelReady(modelName: String) {
        modelRef.set(modelName)
    }

    /** 结果落地：markdown 渲染进正文、启复制钮、光标回顶 */
    fun showResult(text: String) {
        if (cancelled || isDisposed) return
        ticker.stop()
        statusLabel.text = ""
        rawText = text
        htmlPane.text = renderMarkdownHtml(text)
        htmlPane.caretPosition = 0
        copyAction.isEnabled = true
    }

    /** 失败：弹窗内红字给原因（不炸窗，用户可关窗重试） */
    fun failLater(reason: String) {
        ApplicationManager.getApplication().invokeLater({
            if (cancelled || isDisposed) return@invokeLater
            ticker.stop()
            statusLabel.text = message("commit.explain.failed", reason)
            statusLabel.foreground = JBColor.RED
        }, ModalityState.any())
    }

    /** 重触发/project 关闭路径：取消在途 + 关窗（幂等——多入口可撞，只放第一进） */
    fun cancel() {
        if (cancelled) return
        cancelled = true
        ticker.stop()
        cancelInFlight()
        ApplicationManager.getApplication().invokeLater({
            close(DialogWrapper.CANCEL_EXIT_CODE)
        }, ModalityState.any())
    }

    /** 用户关窗（OK/取消/X 都走到 dispose）：摘 ACTIVE + 取消在途生成 */
    override fun dispose() {
        ticker.stop()
        onClosed()
        if (!cancelled) cancelInFlight()
        super.dispose()
    }

    private fun cancelInFlight() {
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                project.zCodeService().getEnhanceClient().cancelGenerateText(opId)
            } catch (e: Exception) {
                runCatching { project.zCodeService().getClient().cancelGenerateText(opId) }
            }
        }
    }

    /**
     * markdown → HTML（平台捆绑 org.intellij.markdown，GFM 味：表格/删除线/自动链接）。
     * 库渲染失败 fail-open 退 <pre> 纯文本（与协议层 fail-open 同纪律，不吞结果）。
     */
    private fun renderMarkdownHtml(md: String): String {
        val body = try {
            val flavour = org.intellij.markdown.flavours.gfm.GFMFlavourDescriptor()
            val tree = org.intellij.markdown.parser.MarkdownParser(flavour)
                .buildMarkdownTreeFromString(md)
            val html = org.intellij.markdown.html.HtmlGenerator(md, tree, flavour).generateHtml()
            // 防不同版本夹带 body 标签：剥掉后自配外壳（swing 解析器对嵌套 body 虽宽容，不赌）
            html.replace(Regex("(?i)^<\\s*body[^>]*>"), "").replace(Regex("(?i)</\\s*body\\s*>$"), "")
        } catch (t: Throwable) {
            log.warn("[commit-explain] markdown render fallback to plain: ${t.message}")
            "<pre>" + xmlEscape(md) + "</pre>"
        }
        return "<html><body>$body</body></html>"
    }

    private fun xmlEscape(s: String): String =
        s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
}
