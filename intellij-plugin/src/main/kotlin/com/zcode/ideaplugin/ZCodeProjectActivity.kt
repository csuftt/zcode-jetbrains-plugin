package com.zcode.ideaplugin

import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import com.zcode.ideaplugin.ui.ZCodeAutoArchiveService

/**
 * 项目启动活动：预热自动归档调度器（缺陷BH）。
 *
 * ZCodeAutoArchiveService 是懒加载 Service，30min 扫描周期挂在 init——此前只有打开
 * 历史「自动归档」tab（webview 拉 config/records）才创建，IDE 重启后不碰该 tab，
 * 自动归档就静默不跑、「最近扫描」停留在上一个会话。这里项目打开即 touch 一行，
 * 让调度器随项目启动（开销：单守护线程 + 一行日志，无 IO）。
 *
 * 扫描本体「搭便车」于已运行的 app-server（客户端未起跳过，不主动拉起进程），
 * 客户端就绪场景由 [ZCodeAutoArchiveService.sweepAfterClientReady] 在 15s 内补扫。
 */
class ZCodeProjectActivity : ProjectActivity {
    override suspend fun execute(project: Project) {
        ZCodeAutoArchiveService.getInstance(project)
    }
}
