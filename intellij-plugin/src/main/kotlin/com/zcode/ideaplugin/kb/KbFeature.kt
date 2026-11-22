package com.zcode.ideaplugin.kb

import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.extensions.PluginId
import com.zcode.ideaplugin.protocol.model.McpServerSpec
import com.zcode.kb.core.KbPaths
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * 知识库功能开关与注入面（CUA 同款骨架）。
 *
 * - 开关全局（PropertiesComponent，机器级），**默认开**——空库零存在感：条目数为 0
 *   时 specIfEnabled 返回 null，不注入任何东西（issue#54 定案）；
 * - spec：java=IDE 自带 JBR，classpath=插件 lib\* 通配（依赖随 implementation 落
 *   lib/，server 与分词器在其上）；env 带 ZCODE_KB_ROOT（自定义
 *   库位置对 server 进程生效）；scope=user + alwaysLoad=true（3.17.x 双保险，老 CLI
 *   由 ZCodeProtocolClient.mcpServersJson 的门控与 -32602 自愈兜底，本类不重复处理）；
 * - server 纯 Java（KbMcpServerMain），检索 + 管理写（目录/条目/标签）；
 * - skill 分发（CUA 同款）：自带 SKILL.md 复制到 ~/.zcode/skills/zcgui-knowledge/
 *   （ZCode CLI 用户级技能目录，SkillScanner 同一扫描面），教 AI 检索与整理工作流；
 *   关闭时删除 SKILL.md（避免 AI 看到技能却调不到工具）。**启动对齐必须做**（CUA
 *   没有这步——它默认关、setEnabled(true) 即装；知识库默认开，存量用户升级插件
 *   没人调 setEnabled，skill 内容更新必须靠启动幂等重装刷新）。
 */
object KbFeature {

    private val log = Logger.getInstance(KbFeature::class.java)

    private const val KEY_ENABLED = "zcode.kb.enabled"
    const val SERVER_NAME = "zcgui-knowledge"
    private const val SKILL_RESOURCE = "/skills/zcgui-knowledge/SKILL.md"

    /** ToolWindow 显示 id（与 plugin.xml 的 toolWindow id 必须手写一致——EP 是静态串） */
    const val TOOLWINDOW_ID = "ZC GUI知识库"

    fun isEnabled(): Boolean =
        PropertiesComponent.getInstance().getBoolean(KEY_ENABLED, true)

    fun setEnabled(enabled: Boolean) {
        // 必须三参并显式 default=true：两参 setValue(String, Boolean) 以 false 为默认值，
        // 写 false 会被当「等于默认值」直接移除键而非落值（真机实证：other.xml 里 CUA 键
        // 落了 true、kb 键永远无踪影），读取侧 getBoolean(key, true) 便永远回 true——
        // 表现为设置页开关关不掉。同族 CuaFeature（默认 false 恰好无事）与
        // ZCodeRemoteService（显式三参）均不受影响。
        PropertiesComponent.getInstance().setValue(KEY_ENABLED, enabled, true)
        if (enabled) installSkill() else uninstallSkill()
        log.info("Knowledge Base ${if (enabled) "enabled" else "disabled"}")
        // 实时同步各 project 工具窗可用性（缺陷HW-2：关闭后条带按钮/窗口即时移除）
        KbTopics.publishSwitched(enabled)
    }

    /**
     * 创建会话时用：开关开 + 库非空 + 环境满足才非空。
     * entryCount 由调用方（KbManagerService）供给——懒查询一个轻连接（空库毫秒级），
     * 会话创建本来就有网络往返，不差这一点。
     */
    fun specIfEnabled(entryCount: Int): McpServerSpec? {
        if (!isEnabled() || entryCount <= 0) return null
        return serverSpec()
    }

    fun serverSpec(): McpServerSpec? {
        val java = jbrJava() ?: run {
            log.warn("Knowledge Base: IDE JBR java not found, skip injection")
            return null
        }
        val cp = classpath() ?: run {
            log.warn("Knowledge Base: cannot resolve plugin lib classpath, skip injection")
            return null
        }
        return McpServerSpec(
            name = SERVER_NAME,
            command = java.absolutePath,
            args = listOf("-cp", cp, "com.zcode.kb.mcp.KbMcpServerMain"),
            env = mapOf("ZCODE_KB_ROOT" to KbPaths.rootDir().toAbsolutePath().toString()),
            isolation = "session",
            timeoutMs = 60_000L,
            // 与 CUA 同款双保险：scope 绕开 workspace-mcp-trust 撞名门控，alwaysLoad 防
            // ToolSearch 延迟加载把注入工具藏出上下文
            scope = "user",
            alwaysLoad = true,
        )
    }

    private fun jbrJava(): File? {
        val home = PathManager.getHomePath()
        for (rel in listOf("jbr/bin/java.exe", "jbr/bin/java")) {
            val f = File(home, rel)
            if (f.isFile) return f
        }
        return null
    }

    /**
     * fork JVM 的 classpath（CUA 同款三形态：插件目录 lib 通配 / 单 jar / codeSource
     * 兜底；权威来源=插件描述符 pluginPath，codeSource 真机可能为 null）。
     */
    private fun classpath(): String? {
        descriptorRoot()?.let { root ->
            if (root.isDirectory) {
                val lib = root.resolve("lib")
                if (lib.isDirectory) return lib.absolutePath + File.separator + "*"
                return root.absolutePath
            }
            return root.absolutePath
        }
        val location = KbFeature::class.java.protectionDomain.codeSource?.location ?: return null
        return File(location.toURI()).absolutePath
    }

    private fun descriptorRoot(): File? {
        return try {
            val descriptor = PluginManagerCore.getPlugin(PluginId.getId("com.zcode.ideaplugin.zcode-assistant"))
            val path = descriptor?.pluginPath ?: return null
            path.toFile().absoluteFile
        } catch (e: Exception) {
            log.warn("Knowledge Base: plugin descriptor lookup failed: ${e.message}")
            null
        }
    }

    // ───────────────────────── skill 分发（CUA 同款） ─────────────────────────

    fun skillDir(): File = File(File(System.getProperty("user.home"), ".zcode"), "skills/$SERVER_NAME")

    private fun installSkill() {
        try {
            val res = KbFeature::class.java.getResourceAsStream(SKILL_RESOURCE)
                ?: run { log.warn("Knowledge Base: skill resource missing $SKILL_RESOURCE"); return }
            val dir = skillDir()
            dir.mkdirs()
            res.use { Files.copy(it, dir.resolve("SKILL.md").toPath(), StandardCopyOption.REPLACE_EXISTING) }
            log.info("Knowledge Base skill installed to ${dir.path}")
        } catch (e: Exception) {
            log.warn("Knowledge Base: skill install failed: ${e.message}")
        }
    }

    /** 只删插件部署的 SKILL.md，不动用户放进同目录的自建文件；目录清空顺带移除 */
    private fun uninstallSkill() {
        try {
            val dir = skillDir()
            Files.deleteIfExists(dir.resolve("SKILL.md").toPath())
            if (dir.isDirectory && dir.list()?.isEmpty() == true) dir.delete()
        } catch (e: Exception) {
            log.warn("Knowledge Base: skill uninstall failed: ${e.message}")
        }
    }

    /** APP 级服务启动对齐：开=幂等重装（升级插件后 skill 内容随包刷新），关=确保清除 */
    fun syncSkillOnStartup() {
        if (isEnabled()) installSkill() else uninstallSkill()
    }
}
