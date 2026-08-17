package com.zcode.ideaplugin.ui

import java.io.File
import java.security.MessageDigest

/**
 * 记忆文件扫描器（设置页「记忆」条目数据源）
 *
 * 两类记忆：
 *   1. 指令记忆（instructions，缺失可创建默认模板）
 *      - 全局   ~/.zcode/AGENTS.md   所有项目的会话读取
 *      - 项目根 AGENTS.md            仅当前项目的会话读取
 *   2. 自动记忆（auto，ZCode 自动生成，只读展示）
 *      ~/.zcode/cli/memories/projects/<项目目录名小写>-<hash16>/memory/
 *        MEMORY.md = 索引（每条记忆一行），其余 *.md = 单条事实
 *      hash16 = sha256(项目绝对路径小写、原生分隔符形态) 前 16 位 hex（实测反推，
 *      详见 findMemoryDir；文档：zcode.z.ai/cn/docs/memory）
 */
object MemoryFileScanner {

    /** 一条可展示的记忆文件（指令记忆缺失项也返回）*/
    data class MemoryFile(
        /** 文件名，如 AGENTS.md、MEMORY.md */
        val name: String,
        /** global=全局 / project=项目 */
        val scope: String,
        /** instructions=指令记忆（可创建）/ auto=ZCode 自动提取的事实记忆 */
        val kind: String,
        /** 绝对路径 */
        val path: String,
        /** 是否已存在 */
        val exists: Boolean,
        val sizeBytes: Long? = null,
        val lastModified: Long? = null,
        /** 展示说明 */
        val description: String,
    )

    /** 指令记忆固定清单 + 自动记忆目录扫描 */
    fun list(projectBasePath: String?): List<MemoryFile> {
        val home = System.getProperty("user.home") ?: return emptyList()
        val result = mutableListOf<MemoryFile>()

        result.add(inspect(File(home, ".zcode/AGENTS.md"), "global", "instructions", "所有项目的 ZCode 会话自动读取"))
        if (!projectBasePath.isNullOrBlank()) {
            val base = File(projectBasePath)
            result.add(inspect(File(base, "AGENTS.md"), "project", "instructions", "当前项目的 ZCode 会话自动读取"))
            result.addAll(scanAutoMemories(home, projectBasePath))
        }
        return result
    }

    /** 写入默认模板（父目录自动创建）。已存在时不覆盖，直接返回 true */
    fun createWithTemplate(file: MemoryFile): Boolean {
        val f = File(file.path)
        if (f.isFile) return true
        return try {
            f.parentFile?.mkdirs()
            f.writeText(templateFor(file), Charsets.UTF_8)
            true
        } catch (_: Exception) {
            false
        }
    }

    /** 自动记忆目录：MEMORY.md 索引排最前，事实文件按修改时间倒序 */
    private fun scanAutoMemories(home: String, projectBasePath: String): List<MemoryFile> {
        val dir = findMemoryDir(home, projectBasePath) ?: return emptyList()
        val files = dir.listFiles { f -> f.isFile && f.extension.equals("md", ignoreCase = true) }
            ?: return emptyList()
        val (index, facts) = files.partition { it.name.equals("MEMORY.md", ignoreCase = true) }
        val indexItems = index.map {
            inspect(it, "project", "auto", "记忆索引（每条记忆一行，指向同目录事实文件）")
        }
        val factItems = facts.sortedByDescending { it.lastModified() }.map {
            inspect(it, "project", "auto", firstHeading(it) ?: "从已完成对话中自动提取的事实记忆")
        }
        return indexItems + factItems
    }

    /**
     * 定位自动记忆目录。
     *
     * 目录名 = <项目目录名小写>-<hash16>，如 zcode-idea-plugin-e0a18fbbbd5c65a8；
     * hash16 = sha256(小写路径) 前 16 位 hex。ZCode CLI 用原生分隔符（Windows 反斜杠）
     * 形态的路径做哈希，而 IDE 的 project.basePath 是 VFS 正斜杠形态——两种形态都算一遍。
     * 匹配不到再退回项目目录名前缀兜底（目录名前缀即项目目录名小写），取第一个有
     * memory 子目录的命中。
     */
    private fun findMemoryDir(home: String, projectBasePath: String): File? {
        val projectsRoot = File(home, ".zcode/cli/memories/projects")
        if (!projectsRoot.isDirectory) return null

        val projectName = File(projectBasePath).name.lowercase()
        val pathVariants = linkedSetOf(
            projectBasePath,
            projectBasePath.replace('/', File.separatorChar),
            projectBasePath.replace('\\', '/'),
        )
        for (v in pathVariants) {
            val dir = File(projectsRoot, "$projectName-${memoryKey(v)}/memory")
            if (dir.isDirectory) return dir
        }

        val candidates = projectsRoot.listFiles { f ->
            f.isDirectory && f.name.lowercase().startsWith("$projectName-")
        }?.toList() ?: return null
        return candidates.map { File(it, "memory") }.firstOrNull { it.isDirectory }
    }

    /** 项目路径 → 记忆目录 key：sha256(小写路径) 前 16 位 hex */
    private fun memoryKey(projectBasePath: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(projectBasePath.lowercase().toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }.take(16)
    }

    /** 读文件首个「# 标题」行作展示说明（自动记忆的事实文件都有标题行）*/
    private fun firstHeading(f: File): String? = try {
        f.readText(Charsets.UTF_8).lineSequence()
            .firstOrNull { it.startsWith("# ") }
            ?.removePrefix("# ")?.trim()?.take(80)
            ?.let { "自动记忆：$it" }
    } catch (_: Exception) {
        null
    }

    private fun inspect(f: File, scope: String, kind: String, description: String): MemoryFile {
        val exists = f.isFile
        return MemoryFile(
            name = f.name,
            scope = scope,
            kind = kind,
            path = f.absolutePath,
            exists = exists,
            sizeBytes = if (exists) f.length() else null,
            lastModified = if (exists) f.lastModified() else null,
            description = description,
        )
    }

    /** 指令记忆默认模板 */
    private fun templateFor(file: MemoryFile): String = if (file.scope == "global") {
        "# 全局记忆\n\n" +
            "<!-- 全局记忆文件（~/.zcode/AGENTS.md）：所有项目的 ZCode 会话自动读取 -->\n\n"
    } else {
        "# 项目记忆\n\n" +
            "<!-- 项目级记忆（AGENTS.md）：当前项目的 ZCode 会话自动读取 -->\n\n"
    }
}
