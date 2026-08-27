package com.zcode.ideaplugin.action

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.wm.ToolWindowManager
import com.zcode.ideaplugin.ZCodeBundle.message
import com.zcode.ideaplugin.ZCodeIcons
import com.zcode.ideaplugin.ui.FileRefs
import com.zcode.ideaplugin.zCodeService
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * 右键菜单：把选中的文件引用发送到 ZCode 输入框（对齐 cc-gui SendFilePathToInputAction）
 *
 * - 注册位置：项目树（ProjectViewPopupMenu）+ 编辑器 Tab（EditorTabPopupMenu）
 * - 支持多选：`@C:\abs\path @C:\abs\path2`（空格分隔）
 * - 只发送引用，不读文件内容（输入框 chip 显示 basename，发送时 CLI 按引用读文件）
 */
class SendFileToInputAction : AnAction(
    message("action.sendFileToInput.text"),
    message("action.sendFileToInput.description"),
    ZCodeIcons.ZcGui,
) {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val files = e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY)
        e.presentation.isEnabledAndVisible = !files.isNullOrEmpty()
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val files = e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY) ?: return
        if (files.isEmpty()) return

        pushRefs(project, FileRefs.toRefs(files.toList()))
    }
}

/** 公共推送入口：确保 ZCode 工具窗口打开后推送 filesToInput 到前端输入框 */
internal fun pushRefs(project: com.intellij.openapi.project.Project, refs: List<String>) {
    ToolWindowManager.getInstance(project).getToolWindow("ZCode")?.show()
    project.zCodeService().pushToWebview(
        buildJsonObject {
            put("op", "filesToInput")
            put("refs", JsonArray(refs.map { JsonPrimitive(it) }))
        }
    )
}
