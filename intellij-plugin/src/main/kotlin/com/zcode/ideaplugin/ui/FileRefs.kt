package com.zcode.ideaplugin.ui

import com.intellij.openapi.vfs.VirtualFile

/**
 * VirtualFile → "@path[/]" 引用串统一转换。
 *
 * 三处调用点（[ZCodeToolWindowPanel.handlePickFiles] / [com.zcode.ideaplugin.action.SendFileToInputAction] /
 * [ZCodeToolWindowPanel.registerFileDropTarget]）共享同一格式：
 *   - 目录末尾补 `/`（前端 FileRef 靠它判定目录图标）
 *   - 加 `@` 前缀（前端 text 序列化时与正文区分）
 *
 * presentableUrl vs path 的选择：
 *   - handlePickFiles 走 presentableUrl（FileChooser 拿到的，Windows 上正斜杠）
 *   - SendFileToInputAction 走 path（VIRTUAL_FILE_ARRAY 拿到的，平台原生形态）
 *   - fileDropTarget 不走本函数——它拿的是 `java.io.File` 而非 `VirtualFile`，内联处理
 *     （AWT File 没有 presentableUrl 概念，与 VirtualFile.path 等价的是 File.absolutePath）
 *
 * 内部可见：仅 intellij-plugin 模块内复用，不暴露给 protocol-client。
 */
internal object FileRefs {
    fun toRef(file: VirtualFile, presentable: Boolean = false): String {
        // presentableUrl 是 VirtualFile 上的非空 String（IDE 平台契约），无须 ?: 兜底
        val p = if (presentable) file.presentableUrl else file.path
        val withSlash = if (file.isDirectory && !p.endsWith("/")) "$p/" else p
        return "@$withSlash"
    }

    fun toRefs(files: List<VirtualFile>, presentable: Boolean = false): List<String> =
        files.map { toRef(it, presentable) }
}
