package com.zcode.ideaplugin

import com.intellij.ide.util.PropertiesComponent
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import com.zcode.ideaplugin.protocol.V1BuiltinMigrator
import com.zcode.ideaplugin.ui.ZCodeAutoArchiveService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

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
        withContext(Dispatchers.IO) { migrateV1BuiltinsOnce(project) }
        // 关联目录 → Project View 挂载（2026-10-28）：kv 为唯一权威的幂等投影，
        // 重启自愈（被构建同步/手动摘除的根补回、盘上失效的根清理）；无关联目录零足迹。
        // 内部跳 EDT 做模型变更，此处仅 IO 读 kv + 盘存在性过滤。
        // 3s 后补跑一次：赢 Git 子系统初始化竞态——上次快速开关后立即退出时，EDT 策略
        // 任务可能没跑完就落了带旧映射的 vcs.xml，Git 启动早期按它建好仓库对象；首轮
        // reconcile 即便摘了映射，分支弹窗也可能已按旧态渲染，补跑兜底。
        withContext(Dispatchers.IO) {
            val linked = com.zcode.ideaplugin.ui.ZCodeLinkedWorkspaces.read(project)
            com.zcode.ideaplugin.ui.ZCodeWorkspaceMounter.reconcileAsync(project, linked)
            kotlinx.coroutines.delay(3000)
            com.zcode.ideaplugin.ui.ZCodeWorkspaceMounter.reconcileAsync(project, linked)
        }
        // 手机远程重启恢复（2026-09-24 用户需求）：上次退出时开着 → 自动重连。
        // 服务内部自判开关+凭据、后台线程执行；多项目打开幂等（connect 已运行守卫短路）
        com.zcode.ideaplugin.remote.ZCodeRemoteService.getInstance().restoreIfEnabled()
    }

    companion object {
        private val log = Logger.getInstance(ZCodeProjectActivity::class.java)

        /** 0.3.6 早期版本的一次性标记键（语义已废，仅作升级清理用）*/
        private const val LEGACY_MARKER_KEY = "zcode.v1builtin.migrated"
    }

    /**
     * v1 内置渠道兜底迁移（2026-09-17 需求，2026-09-18 改按现状判定）：NEW 代 +
     * provider_config.json 里没有对应模板渠道 + v1 config.json 里该渠道带明文 apiKey
     * → 按模板形态迁入（BigModel/Z.ai Coding Plan 与 API Key 手填型，详见
     * [V1BuiltinMigrator]）。
     *
     * 幂等无标记：用户在 v2 删掉的渠道下次启动会补回来；要永久停用请在 v1 config.json
     * 把该渠道 enabled 置 false 或清空 apiKey（迁移的 opt-out 口径）。旧版本写入的
     * 「防复活」标记在此顺带清理一次。
     *
     * 后台线程 fail-soft（任意异常只落日志，不阻塞启动）；迁入成功弹 IDE 气泡提示。
     */
    private fun migrateV1BuiltinsOnce(project: Project) {
        try {
            clearLegacyMarker()
            val zcodePath = com.zcode.ideaplugin.env.ZCodeEnvChecker.resolveCliPathForOps()
            val migrated = V1BuiltinMigrator.migrateIfNeeded(zcodePath)
            if (migrated.isEmpty()) return
            log.info("v1 builtin channels migrated to provider_config.json: $migrated")
            NotificationGroupManager.getInstance().getNotificationGroup("ZCode")
                .createNotification(
                    ZCodeBundle.message("migrate.v1builtin.title"),
                    ZCodeBundle.message("migrate.v1builtin.body", migrated.joinToString("、")),
                    NotificationType.INFORMATION,
                )
                .notify(project)
        } catch (e: Exception) {
            log.warn("v1 builtin migration failed (ignored): ${e.message}")
        }
    }

    /** 清理旧版本写入的一次性标记（zcode.v1builtin.migrated）：现语义只按文件现状判定，键已无用 */
    private fun clearLegacyMarker() {
        val pc = PropertiesComponent.getInstance()
        if (pc.getValue(LEGACY_MARKER_KEY) != null) {
            pc.unsetValue(LEGACY_MARKER_KEY)
            log.info("legacy v1-builtin migration marker cleared")
        }
    }
}
