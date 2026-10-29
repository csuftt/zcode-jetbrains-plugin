package com.zcode.ideaplugin.ui

import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.WriteAction
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.module.Module
import com.intellij.openapi.module.ModuleManager
import com.intellij.openapi.module.ModuleTypeManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ModuleRootManager
import com.intellij.openapi.roots.ModuleRootModificationUtil
import com.intellij.openapi.vfs.VfsUtilCore
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import java.nio.file.Files
import java.nio.file.Path

/**
 * 关联目录（多目录会话）的持久化权威，project 级 kv。
 *
 * 原 ZCodeToolWindowPanel 私有实现（2026-10-27 M1）上移至此：启动 reconcile
 * （ZCodeProjectActivity）与 Project View 挂载投影（[ZCodeWorkspaceMounter]）都要读
 * 同一份列表，收口一处避免解析逻辑双份。存储/比较统一正斜杠形态（与
 * project.basePath 同源）；下游 createSession/listSessions 各自再归一原生分隔符。
 */
object ZCodeLinkedWorkspaces {

    /** 关联目录列表的 project 级 kv key */
    const val KEY = "zcode.linkedWorkspaces.v1"

    /** 目录路径归一比较键：统一分隔符 + 去尾 + 大小写折叠（Windows 不敏感） */
    fun wsKey(path: String): String =
        path.replace('\\', '/').trimEnd('/').lowercase()

    fun read(project: Project): List<String> {
        val raw = PropertiesComponent.getInstance(project).getValue(KEY) ?: return emptyList()
        return try {
            Json.parseToJsonElement(raw).jsonArray.mapNotNull { it.jsonPrimitive.contentOrNull }
        } catch (_: Exception) {
            emptyList() // 损坏降级空表（同 ZCodeScheduledMessageService.loadFromStorage 口径）
        }
    }

    fun persist(project: Project, list: List<String>) {
        PropertiesComponent.getInstance(project)
            .setValue(KEY, JsonArray(list.map { JsonPrimitive(it) }).toString())
    }
}

/**
 * 把关联目录投影到 IDEA Project View（2026-10-28 调研定案，见内部仓
 * design-research/多工作区目录挂载ProjectView调研）。
 *
 * 机制：专属普通模块 [WS_MODULE_NAME]（iml 落 .idea/ 下）承载全部关联目录的内容根
 * ——Project View 顶级节点可浏览、进项目索引（Find in Files/导航可用）；普通模块
 * 不受 Gradle/Maven 模型管理，构建同步不清根。同款机制参照 233 官方
 * File→Open→Attach 的实现（com.intellij.ide.actions.AttachDirectoryUtils，字节码拆解）。
 *
 * kv（[ZCodeLinkedWorkspaces]）是唯一权威，这里只做幂等投影：面板挂载/卸载 handler
 * 与启动 reconcile 共用 [reconcileAsync] diff 补摘，投影被构建同步或手动破坏后由
 * 下次 reconcile 自愈。无关联目录且从未挂过 → 零足迹（不建模块、不碰 .idea）。
 *
 * 线程约定：[reconcileAsync] 后台线程可调（内部跳 EDT 做模型变更，写动作由
 * ModuleRootModificationUtil.updateModel / WriteAction 自带）。
 */
object ZCodeWorkspaceMounter {
    private val log = Logger.getInstance("ZCodePlugin")

    /** 承载关联目录内容根的专属模块名（iml：.idea/ZCGUIWorkspaces.iml，前缀对齐插件名 ZC GUI） */
    const val WS_MODULE_NAME = "ZCGUIWorkspaces"

    /** 验证期更名的两个历史模块名（真机可能已按任一旧名建过模块），reconcile 顺带摘除 */
    private val LEGACY_MODULE_NAMES = listOf("zcguiworkspaces", "ZCodeWorkspaces")

    /**
     * reconcile 差集（纯函数，单测锚点）。
     *
     * currentRootPaths：模块现有内容根路径；desired：kv 关联目录（原生分隔符）；
     * baseKey：项目根归一键（null = 无 basePath，全部照挂）。
     * 规则：项目根自身/其子目录不参与挂载（项目树已可见，挂了出双节点）；
     * desired 按归一键去重；返回 (待挂路径, 待摘路径)。
     */
    fun computeDiff(
        currentRootPaths: List<String>,
        desired: List<String>,
        baseKey: String?,
    ): Pair<List<String>, List<String>> {
        val wanted = desired
            .filter { p ->
                val k = ZCodeLinkedWorkspaces.wsKey(p)
                baseKey == null || !(k == baseKey || k.startsWith("$baseKey/"))
            }
            .distinctBy { ZCodeLinkedWorkspaces.wsKey(it) }
        val currentKeys = currentRootPaths.mapTo(mutableSetOf()) { ZCodeLinkedWorkspaces.wsKey(it) }
        val wantedKeys = wanted.mapTo(mutableSetOf()) { ZCodeLinkedWorkspaces.wsKey(it) }
        val toAdd = wanted.filter { ZCodeLinkedWorkspaces.wsKey(it) !in currentKeys }
        val toRemove = currentRootPaths.filter { ZCodeLinkedWorkspaces.wsKey(it) !in wantedKeys }
        return toAdd to toRemove
    }

    /**
     * 把 desired 投影到项目模型（幂等）。盘上已不存在的目录跳过（chips 侧另有
     * 「目录不存在淡显+移除引导」的产品语义）；投影与 desired 已一致时空操作。
     */
    fun reconcileAsync(project: Project, desiredPaths: List<String>) {
        val basePath = project.basePath ?: return // default project 等无根形态：无法承载模块
        val existing = desiredPaths.filter { p ->
            runCatching { Files.isDirectory(Path.of(p)) }.getOrDefault(false)
        }
        if (existing.isNotEmpty()) {
            // 模块 iml 的父目录预建（I/O 不进 EDT；已存在时是单次 stat）
            runCatching { Files.createDirectories(Path.of(basePath, ".idea")) }
        }
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            try {
                reconcileOnEdt(project, existing)
            } catch (e: Exception) {
                log.warn("workspace mount reconcile failed (ignored): ${e.message}")
            }
        }
    }

    private fun reconcileOnEdt(project: Project, desired: List<String>) {
        removeLegacyModuleIfAny(project)
        val baseKey = project.basePath?.let { ZCodeLinkedWorkspaces.wsKey(it) }
        val module = ModuleManager.getInstance(project).findModuleByName(WS_MODULE_NAME)
        if (module == null && desired.isEmpty()) return
        val currentPaths = module
            ?.let { ModuleRootManager.getInstance(it).contentEntries.map { e -> VfsUtilCore.urlToPath(e.url) } }
            ?: emptyList()
        val (toAdd, toRemove) = computeDiff(currentPaths, desired, baseKey)
        if (toAdd.isEmpty() && toRemove.isEmpty()) return
        val target = module ?: createModule(project) ?: run {
            log.warn("workspace mount skipped (module unavailable)")
            return
        }
        ModuleRootModificationUtil.updateModel(target) { model ->
            toAdd.forEach { model.addContentEntry(VfsUtilCore.pathToUrl(it)) }
            toRemove.forEach { path ->
                val key = ZCodeLinkedWorkspaces.wsKey(path)
                model.contentEntries
                    .firstOrNull { ZCodeLinkedWorkspaces.wsKey(VfsUtilCore.urlToPath(it.url)) == key }
                    ?.let { model.removeContentEntry(it) }
            }
        }
        log.info("workspace mount reconciled: +${toAdd.size}/-${toRemove.size} (module=$WS_MODULE_NAME)")
    }

    /** EDT 调用。iml 落 .idea/ 下（与官方 createDefaultModule 同款落位）；已存在不重复建。 */
    private fun createModule(project: Project): Module? {
        val basePath = project.basePath ?: return null
        return WriteAction.compute<Module?, RuntimeException> {
            val iml = Path.of(basePath, ".idea", "$WS_MODULE_NAME.iml")
            Files.createDirectories(iml.parent)
            ModuleManager.getInstance(project)
                .newModule(iml, ModuleTypeManager.getInstance().defaultModuleType.id)
        }
    }

    /**
     * 一次性迁移：验证期两轮更名（ZCodeWorkspaces → zcguiworkspaces → ZCGUIWorkspaces），
     * 真机若已按任一旧名建过模块则整体摘除（其内容根由本次 reconcile 按 kv 重新投影到
     * 新模块），不摘会出双份顶级节点。残留的 .idea/<旧名>.iml 孤儿文件无登记即失效，可手删。
     * 常态下只有两次 findModuleByName 空转。
     */
    private fun removeLegacyModuleIfAny(project: Project) {
        val manager = ModuleManager.getInstance(project)
        val stale = LEGACY_MODULE_NAMES.filter { manager.findModuleByName(it) != null }
        if (stale.isEmpty()) return
        try {
            WriteAction.compute<Unit, RuntimeException> {
                val model = manager.getModifiableModel()
                stale.forEach { name -> model.findModuleByName(name)?.let { model.disposeModule(it) } }
                model.commit()
            }
            log.info("legacy workspace mount module removed: $stale")
        } catch (e: Exception) {
            log.warn("legacy module cleanup failed (ignored): ${e.message}")
        }
    }
}
