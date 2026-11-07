package com.zcode.ideaplugin.cua

import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.extensions.PluginId
import com.zcode.ideaplugin.protocol.model.McpServerSpec
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * 电脑控制（CUA）功能开关与注入面。
 *
 * - 开关全局（PropertiesComponent，机器级功能非项目级），默认关；
 * - 打开时把自带 skill 复制到 ~/.zcode/skills/zcgui-computer-use/（ZCode CLI 用户级
 *   技能目录，SkillScanner 同一扫描面）；关闭时删除 SKILL.md（目录内用户自建文件
 *   保留——工具面与 skill 同步，避免 AI 看到技能却调不到工具）；
 * - serverSpec() 构造注入配置：java = IDE 自带 JBR（PathManager.getHomePath()/jbr），
 *   classpath = CuaMcpServerMain 的 codeSource 一个元素（server 主体纯 Java 零依赖，
 *   dev=classes 目录、生产=插件 jar；不带 kotlin-stdlib——2026.1 平台发行已无独立
 *   stdlib jar，这也是 server 用 Java 重写的原因）。
 */
object CuaFeature {

    private val log = Logger.getInstance(CuaFeature::class.java)

    private const val KEY_ENABLED = "zcode.cua.enabled"
    const val SERVER_NAME = "zcgui-computer-use"
    private const val SKILL_RESOURCE = "/skills/zcgui-computer-use/SKILL.md"

    fun isEnabled(): Boolean =
        PropertiesComponent.getInstance().getBoolean(KEY_ENABLED, false)

    fun setEnabled(enabled: Boolean) {
        PropertiesComponent.getInstance().setValue(KEY_ENABLED, enabled)
        if (enabled) installSkill() else uninstallSkill()
        log.info("Computer Use ${if (enabled) "enabled" else "disabled"}")
    }

    /**
     * 注入配置；环境不满足（JBR java 缺失 / classpath 不可解析）返回 null 并落日志，
     * 调用方按「未启用」同路径跳过注入。
     */
    fun serverSpec(): McpServerSpec? {
        val java = jbrJava() ?: run {
            log.warn("Computer Use: IDE JBR java.exe not found, skip injection")
            return null
        }
        val cp = classpath() ?: run {
            log.warn("Computer Use: cannot resolve CuaMcpServerMain code source, skip injection")
            return null
        }
        return McpServerSpec(
            name = SERVER_NAME,
            command = java.absolutePath,
            args = listOf("-Djava.awt.headless=false", "-cp", cp, "com.zcode.ideaplugin.cua.CuaMcpServerMain"),
            env = emptyMap(),
            isolation = "session",
            timeoutMs = 300_000L,
            // 3.17.x 双保险（开源增量勘查 2026-11-07）：scope 绕开 workspace-mcp-trust
            // 撞名门控（不带时名字与项目声明 MCP 撞名会被打成 untrusted 拒连）；
            // alwaysLoad 防 toolSearchMode 非 off 时注入工具被默认延迟出上下文。
            scope = "user",
            alwaysLoad = true,
        )
    }

    /** 创建会话时用（开关开 + 环境满足才非空）。 */
    fun specIfEnabled(): McpServerSpec? = if (isEnabled()) serverSpec() else null

    private fun jbrJava(): File? {
        val home = PathManager.getHomePath()
        for (rel in listOf("jbr/bin/java.exe", "jbr/bin/java")) {
            val f = File(home, rel)
            if (f.isFile) return f
        }
        return null
    }

    /**
     * fork JVM 的 classpath。
     *
     * 权威来源=插件描述符的 pluginPath（真机 2026.2 实测：插件类加载器下
     * protectionDomain.codeSource 可能为 null——WARN "cannot resolve code source"
     * 注入被跳过，故不能依赖它）。形态三种：
     *   - 插件目录（标准磁盘安装）：lib 目录通配（JVM classpath 通配符），覆盖主 jar 与全部依赖；
     *   - 单 jar（老式安装）：jar 自身；
     *   - fallback：codeSource（dev classes 目录）。
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
        val location = CuaMcpServerMain::class.java.protectionDomain.codeSource?.location ?: return null
        return File(location.toURI()).absolutePath
    }

    /** 插件根目录/单 jar（xmlId 固定，与 plugin.xml 一致）。 */
    private fun descriptorRoot(): File? {
        return try {
            val descriptor = PluginManagerCore.getPlugin(PluginId.getId("com.zcode.ideaplugin.zcode-assistant"))
            val path = descriptor?.pluginPath ?: return null
            path.toFile().absoluteFile
        } catch (e: Exception) {
            log.warn("Computer Use: plugin descriptor lookup failed: ${e.message}")
            null
        }
    }

    // ───────────────────────── skill 分发 ─────────────────────────

    fun skillDir(): File = File(File(System.getProperty("user.home"), ".zcode"), "skills/$SERVER_NAME")

    private fun installSkill() {
        try {
            val res = CuaFeature::class.java.getResourceAsStream(SKILL_RESOURCE)
                ?: run { log.warn("Computer Use: skill resource missing $SKILL_RESOURCE"); return }
            val dir = skillDir()
            dir.mkdirs()
            res.use { Files.copy(it, dir.resolve("SKILL.md").toPath(), StandardCopyOption.REPLACE_EXISTING) }
            log.info("Computer Use skill installed to ${dir.path}")
        } catch (e: Exception) {
            log.warn("Computer Use: skill install failed: ${e.message}")
        }
    }

    /**
     * 只删插件部署的 SKILL.md（开关落盘投影 / 执行闸门信号，server 侧 gateClosed
     * 按此文件判开关），不动用户放进同目录的自建文件；目录因此清空时顺带移除。
     */
    private fun uninstallSkill() {
        try {
            val dir = skillDir()
            Files.deleteIfExists(dir.resolve("SKILL.md").toPath())
            if (dir.isDirectory && dir.list().isEmpty()) dir.delete()
        } catch (e: Exception) {
            log.warn("Computer Use: skill uninstall failed: ${e.message}")
        }
    }
}
