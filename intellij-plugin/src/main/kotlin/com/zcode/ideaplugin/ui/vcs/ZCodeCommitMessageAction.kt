package com.zcode.ideaplugin.ui.vcs

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.vcs.CheckinProjectPanel
import com.intellij.openapi.vcs.CommitMessageI
import com.intellij.openapi.vcs.VcsDataKeys
import com.intellij.openapi.vcs.changes.Change
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.zcode.ideaplugin.ZCodeBundle
import com.zcode.ideaplugin.zCodeService
import com.zcode.ideaplugin.protocol.ProtocolGeneration
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.lang.reflect.Method
import java.util.concurrent.ConcurrentHashMap

/**
 * AI 生成提交信息（C1）：提交框上方按钮，把用户勾选的变更 diff 交给
 * workspace/generateText（润色/标题同款的轻量一次性通道），结果写回提交框。
 *
 * 交互契约（cc-gui GenerateCommitMessageAction 同款）：
 *  - 生成中占位「AI 生成中…」，模型解析就绪后 ticker 切「<模型名> 生成中…」；
 *    失败恢复用户原草稿（不丢用户手写内容）；
 *  - 再次点击 = 取消在途生成（operationId → workspace/cancelGenerateText 插队旁路）；
 *  - 通道走 getEnhanceClient()（专用轻任务实例，不拖主 app-server 串行队列——
 *    缺陷 CZ 的根因教训；实例内含账号 overlay 推送竞态修复）。
 *
 * 非流式写回：generateText 是一次性 RPC（无流式形态），占位符表达进行中；
 * 结果整体替换占位符。多仓库/大 diff 由 ZCodeCommitDiffProvider 预算裁剪。
 */
class ZCodeCommitMessageAction : AnAction(ZCodeBundle.message("action.commitMessage.text"), ZCodeBundle.message("action.commitMessage.description"), null), DumbAware {

    companion object {
        private val log = Logger.getInstance("ZCodePlugin")

        /** 在途生成的取消句柄（project → operationId；重触发先 cancel 旧代） */
        private val ACTIVE = ConcurrentHashMap<Project, String>()
        private val OP_COUNTER = java.util.concurrent.atomic.AtomicLong(0)

        /** 生成 prompt（纯函数，单测覆盖）：内置规约 + 仓库风格参照 + 附加要求 + diff（见下方拼装） */
        internal fun buildPrompt(diff: String, styleSubjects: List<String> = emptyList(), extraPrompt: String? = null): String {
            val sb = StringBuilder(SPEC.trimIndent())
            if (styleSubjects.isNotEmpty()) {
                sb.append("\n\n## 近期提交风格（最高优先参照）\n\n")
                sb.append("以下是本仓库近期的提交主题，请模仿其语言与格式风格（包括类型标记的写法）：\n")
                for (s in styleSubjects) sb.append("- ").append(s).append('\n')
                sb.append("若其风格与上方默认格式冲突（如类型后缀、是否带 scope），以近期提交风格为准。")
            }
            if (!extraPrompt.isNullOrBlank()) {
                sb.append("\n\n## 用户附加要求（优先遵循）\n\n")
                sb.append("以下是用户的额外要求，请在生成 commit message 时优先考虑：\n\n")
                sb.append(extraPrompt.trim())
            }
            sb.append("\n\n---\n\n以下是 git diff，请据此生成 commit message：\n\n").append(diff)
            return sb.toString()
        }

        /** 内置 Conventional Commits 规约（无 diff 尾巴；风格参照与附加要求按段追加） */
        private val SPEC = """
            你是一名资深软件工程师，请基于下方 git diff 撰写一条高质量的 Git commit message，遵循 Conventional Commits 规范。

            输出格式：
            <type>[scope]: <description>

            <body>

            提交类型：feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert

            要求：
            - 主题行：不超过 72 字符，末尾不加句号。
            - 正文：改动多于一个逻辑点时写要点列表（总结改了什么与为什么，归纳而非逐行复述 diff）；单一逻辑改动可省略正文。
            - 每行不超过 72 字符。用中文撰写（代码标识符、路径保持原样）。
            - 只输出 commit message 本身：不要解释、不要 Markdown 代码块包裹、不要 emoji、不要 "Generated with" / "Co-Authored-By" 尾注。
        """.trimIndent()

        /** 模型输出 → 提交信息（剥 Markdown 围栏，模型偶尔不听「不要包裹」） */
        internal fun extractMessage(text: String): String {
            var t = text.trim()
            if (t.startsWith("```")) {
                t = t.removePrefix("```").substringAfter('\n', "")
                if (t.endsWith("```")) t = t.removeSuffix("```")
            }
            return t.trim()
        }
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        // enabled 只看 project 存在（cc-gui 同款轻量 update——提交框打开期逐次走
        // ChangeListManager 会拖慢弹窗；变更不可得时 actionPerformed 内兜底提示）
        e.presentation.isEnabledAndVisible = e.project != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val panel = commitMessagePanel(e) ?: run {
            notify(project, ZCodeBundle.message("commit.cannotAccessPanel"), NotificationType.WARNING)
            return
        }
        val changes = userSelectedChanges(e, project)
        if (changes.isNullOrEmpty()) {
            notify(project, ZCodeBundle.message("commit.noChanges"), NotificationType.WARNING)
            return
        }

        // 重触发 = 取消在途（双击/换勾选重生成）；cancelGenerateText 是插队旁路，秒级生效。
        // RPC 放后台——actionPerformed 在 EDT，不能同步等 5s 超时
        ACTIVE.remove(project)?.let { prevOpId ->
            ApplicationManager.getApplication().executeOnPooledThread {
                runCatching { clientOf(project).cancelGenerateText(prevOpId) }
            }
        }

        // 保存原草稿（CommitMessageI 无 getter，反射读——cc-gui 同款），失败时恢复
        val savedDraft = readCurrentDraft(panel)
        val opId = "commit-" + OP_COUNTER.incrementAndGet()
        ACTIVE[project] = opId
        panel.setCommitMessage(ZCodeBundle.message("commit.generating"))

        // 进度感（generateText 无流式形态，用已等待秒数 ticker 表达进行中）：
        // Swing Timer 在 EDT 触发，setCommitMessage 本就要求 EDT；代际失配（重触发/
        // 完成/失败）自动停表，不留常驻 timer。模型名由后台解析线程就绪后写入
        // modelRef（初始占位时模型未定），下一秒 tick 自动切「<模型名> 生成中…」
        val startedAt = System.currentTimeMillis()
        val modelRef = java.util.concurrent.atomic.AtomicReference<String?>(null)
        val ticker = javax.swing.Timer(1000) {
            if (ACTIVE[project] !== opId) {
                (it.source as? javax.swing.Timer)?.stop()
            } else {
                val elapsed = (System.currentTimeMillis() - startedAt) / 1000
                val modelName = modelRef.get()
                panel.setCommitMessage(
                    if (modelName != null) ZCodeBundle.message("commit.generatingModel", modelName, elapsed)
                    else ZCodeBundle.message("commit.generatingProgress", elapsed),
                )
            }
        }
        ticker.start()

        // EDT 上快照变更集合（ChangeListManager 数据不能离线程遍历），重活全部后台
        val changesSnapshot = changes.toList()
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val diff = ZCodeCommitDiffProvider.generate(project, changesSnapshot)
                if (diff.isBlank()) {
                    failTo(project, panel, opId, savedDraft, ZCodeBundle.message("commit.noDiff"), ticker)
                    return@executeOnPooledThread
                }
                // 仓库近期提交主题（风格参照）+ 设置页附加要求，两段都可空
                val styleSubjects = ZCodeCommitDiffProvider.recentCommitSubjects(project, changesSnapshot)
                val extraPrompt = com.zcode.ideaplugin.ui.ZCodeCommitPromptConfig.readPrompt()
                // 模型：统一轻任务链（轻任务专用模型 → 会话当前模型 → 首个启用渠道，
                // 与润色/标题同源——此前硬挑账号渠道挤掉自定义渠道，issue #48）
                val model = resolveModel()
                if (model == null) {
                    failTo(project, panel, opId, savedDraft, ZCodeBundle.message("commit.noModel"), ticker)
                    return@executeOnPooledThread
                }
                // 进度占位切模型名（ticker 下一秒 tick 生效；modelId 与成功日志同口径）
                modelRef.set(model.second)
                val ws = project.basePath ?: run {
                    failTo(project, panel, opId, savedDraft, ZCodeBundle.message("commit.noWorkspace"), ticker)
                    return@executeOnPooledThread
                }
                val client = clientOf(project)
                // 超时随 diff 规模放大（与润色同式），上限 120s
                val timeoutMs = (30_000L + diff.length / 400L * 1_000L).coerceAtMost(120_000L)
                val result = client.generateText(
                    workspacePath = ws,
                    providerId = model.first,
                    modelId = model.second,
                    prompt = buildPrompt(diff, styleSubjects, extraPrompt),
                    systemPrompt = null,
                    querySource = "commit_message",
                    timeoutMs = timeoutMs,
                    reasoningLevel = client.lightReasoningLevel(model.second),
                    operationId = opId,
                )
                val text = extractMessage(result["text"]?.jsonPrimitive?.contentOrNull ?: "")
                if (text.isEmpty()) {
                    failTo(project, panel, opId, savedDraft, ZCodeBundle.message("commit.emptyResult"), ticker)
                    return@executeOnPooledThread
                }
                // 成功路径也留一行（与 enhancePrompt done 同式）：此前成功零日志，
                // 验证轻任务模型选取只能去 rollout 捞 model-io（2026-11-09 实踩）
                log.info("[ai-commit] done (${text.length} chars, model=${model.first}/${model.second})")
                // 代际守卫：生成期间用户再次点击（旧 opId 已被顶掉）→ 丢弃迟到结果
                if (ACTIVE.remove(project, opId)) {
                    ticker.stop()
                    ApplicationManager.getApplication().invokeLater({
                        panel.setCommitMessage(text)
                    }, ModalityState.any())
                }
            } catch (e: Exception) {
                log.warn("[ai-commit] generation failed: ${e.message?.take(200)}")
                failTo(project, panel, opId, savedDraft, e.message ?: "unknown", ticker)
            }
        }
    }

    /** 失败收口：恢复用户原草稿 + 气泡（代际不符时静默——结果已被新代取代） */
    private fun failTo(project: Project, panel: CommitMessageI, opId: String, savedDraft: String, reason: String, ticker: javax.swing.Timer? = null) {
        if (!ACTIVE.remove(project, opId)) {
            ticker?.stop()
            return
        }
        ticker?.stop()
        ApplicationManager.getApplication().invokeLater({
            panel.setCommitMessage(savedDraft)
            notify(project, ZCodeBundle.message("commit.generateFailed", reason), NotificationType.ERROR)
        }, ModalityState.any())
    }

    private fun clientOf(project: Project) = try {
        project.zCodeService().getEnhanceClient()
    } catch (e: Exception) {
        // 轻任务实例起不来（环境异常）退主 client：commit 生成低频，串行排队可接受。
        // 注意必须走 zCodeService() 扩展（按实现类 ZCodeServiceImpl 查询）——
        // 轻量服务按接口 getService 查询恒返回 null（首版实踩：getService(ZCodeService)
        // 为 null 的 NPE，环境异常时兜底分支二次 NPE 污染报错信息）
        project.zCodeService().getClient()
    }

    /** NEW 代：账号渠道置顶 → provider_config 启用渠道首个模型；OLD 代：config.json 默认模型 */
    /**
     * 统一轻任务模型链（与润色/标题同源，issue #48 修复）：行为设置页「轻任务模型」
     * 专用模型 → kv 会话当前模型 → 首个启用渠道首模型（账号渠道置顶），全空 null。
     * 旧代 CLI：专用模型（config.json 构造校验）→ 默认 provider。
     */
    private fun resolveModel(): Pair<String, String>? {
        val generation = try {
            com.zcode.ideaplugin.env.ZCodeEnvChecker.resolveCliPathForOps()?.let {
                com.zcode.ideaplugin.protocol.ProtocolGenerations.detect(it)
            }
        } catch (_: Exception) {
            null
        }
        val dedicated = com.zcode.ideaplugin.ui.LightTaskModels.dedicatedModel()
        if (generation != ProtocolGeneration.NEW) {
            // 旧代：专用模型须能在 config.json 构造出 runtimeModel（v1 形态渠道 id 直接失效）
            if (dedicated != null &&
                com.zcode.ideaplugin.protocol.RuntimeModels.buildRuntimeModel(dedicated.first, dedicated.second) != null
            ) {
                return dedicated
            }
            val fallback = com.zcode.ideaplugin.protocol.RuntimeModels.defaultRuntimeModel()
                ?.get("model")?.jsonObject ?: return null
            val pid = fallback["providerId"]?.jsonPrimitive?.contentOrNull ?: return null
            val mid = fallback["modelId"]?.jsonPrimitive?.contentOrNull ?: return null
            return pid to mid
        }
        return com.zcode.ideaplugin.ui.LightTaskModels.resolveNewCli()
    }

    /** 提交框面板（三级回退，cc-gui 同款：新 workflow handler → 旧 message control） */
    private fun commitMessagePanel(e: AnActionEvent): CommitMessageI? {
        (e.getData(VcsDataKeys.COMMIT_WORKFLOW_HANDLER) as? CommitMessageI)?.let { return it }
        return e.getData(VcsDataKeys.COMMIT_MESSAGE_CONTROL)
    }

    /** 勾选变更集（四级回退，cc-gui 同款）：workflow UI → CheckinProjectPanel → VcsDataKeys → 全部变更 */
    private fun userSelectedChanges(e: AnActionEvent, project: Project): Collection<Change>? {
        e.getData(VcsDataKeys.COMMIT_WORKFLOW_HANDLER)?.let { handler ->
            includedChangesViaReflection(handler)?.takeIf { it.isNotEmpty() }?.let { return it }
        }
        (e.getData(VcsDataKeys.COMMIT_MESSAGE_CONTROL) as? CheckinProjectPanel)?.let { p ->
            p.selectedChanges.takeIf { it.isNotEmpty() }?.let { return it }
        }
        e.getData(VcsDataKeys.CHANGES)?.takeIf { it.isNotEmpty() }?.let { return it.toList() }
        return com.intellij.openapi.vcs.changes.ChangeListManager.getInstance(project)
            .allChanges.takeIf { it.isNotEmpty() }
    }

    /** AbstractCommitWorkflowHandler.getUi().getIncludedChanges() 反射读取（旧版 IDE 无此 API 静默降级） */
    private fun includedChangesViaReflection(handler: Any): Collection<Change>? {
        return try {
            val ui = handler.javaClass.getMethod("getUi").invoke(handler) ?: return null
            val included = ui.javaClass.getMethod("getIncludedChanges").invoke(ui) as? Collection<*>
            included?.filterIsInstance<Change>()
        } catch (t: Throwable) {
            null
        }
    }

    /** 反射读当前提交框草稿（CommitMessageI 无 getter 声明） */
    private fun readCurrentDraft(panel: CommitMessageI): String = try {
        val getter: Method = panel.javaClass.getMethod("getCommitMessage")
        (getter.invoke(panel) as? String) ?: ""
    } catch (t: Throwable) {
        ""
    }

    private fun notify(project: Project, content: String, type: NotificationType) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup("ZCode")
            .createNotification(ZCodeBundle.message("action.commitMessage.text"), content, type)
            .notify(project)
    }
}
