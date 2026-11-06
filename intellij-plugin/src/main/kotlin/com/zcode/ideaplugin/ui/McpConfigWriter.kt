package com.zcode.ideaplugin.ui

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * MCP 服务器磁盘配置写入器（设置页「MCP → 新增/删除」，McpConfigReader 的写侧对偶）
 *
 * 写入目标与读源对齐（reader 三来源中可由插件托管的两处）：
 *   user    ~/.zcode/cli/config.json 的 mcp.servers
 *   project <项目>/.zcode/config.json 的 mcp.servers
 *   （plugin .mcp.json 在插件缓存目录里不可改；host/runtime 条目无磁盘定义——
 *    调用侧 scope 门禁 + reader.scan 全源重名检查共同兜底）
 *
 * 条目形态与 reader 解析字段一致：stdio={command,args,env,cwd,...} /
 * 远程={type:http|sse,url,headers,...}，env/headers 用 {K:V} 对象形态。
 * 条目内容原样落盘不裁剪——CLI 解析 config.json 时自会校验，插件只把住
 * 结构合法性（必须有 command 或 url）。
 *
 * 写回纪律同 protocol-client ProviderConfigWriterV2：进程内单锁串行、.lock
 * 跨进程文件锁、滚动备份 .bak.1~.bak.5、tmp + ATOMIC_MOVE 原子替换、失败回滚；
 * 根节点与 mcp 节点的其余键 LinkedHashMap 保序原样保留。文件不存在时静默创建
 * （首次添加场景，含父目录）；存在但解析失败时拒绝写入（防覆盖坏配置）。
 */
object McpConfigWriter {

    private val json = Json { prettyPrint = true }
    private val WRITE_LOCK = Any()
    private const val BAK_GENERATIONS = 5

    /** 作用域 → 目标配置文件（project 需要项目路径，缺项目路径返回 null）*/
    fun resolveFile(scope: String, basePath: String?): File? = when (scope) {
        "user" -> File(System.getProperty("user.home"), ".zcode/cli/config.json")
        "project" -> basePath?.takeIf { it.isNotBlank() }?.let { File(it, ".zcode/config.json") }
        else -> null
    }

    /**
     * 新增/保存服务器（同文件 mcp.servers 重名拒绝）。
     * @param previousName 编辑保存时的原键名：等于 name 即原条目自身→允许覆盖（upsert）；
     *   改名时同一次写内先移除旧键再写新键（原子，失败整体回滚不留半改名态）
     * @return err null = 成功
     */
    fun addServer(file: File, name: String, entry: JsonObject, previousName: String? = null): String? =
        synchronized(WRITE_LOCK) {
            updateFile(file) { servers ->
                if (name != previousName && name in servers) {
                    throw IllegalStateException("同名服务器已存在于 ${file.absolutePath}: $name")
                }
                JsonObject(LinkedHashMap(servers).apply {
                    if (previousName != null && previousName != name) remove(previousName)
                    put(name, entry)
                })
            }
        }

    /**
     * 删除服务器（条目不存在拒绝；删空保留空 servers 节点，无害）。
     * @return err null = 成功
     */
    fun deleteServer(file: File, name: String): String? =
        synchronized(WRITE_LOCK) {
            updateFile(file) { servers ->
                if (name !in servers) throw IllegalStateException("配置中未找到该服务器: $name")
                JsonObject(LinkedHashMap(servers).apply { remove(name) })
            }
        }

    // ============ 读-改-写骨架（mcp.servers 节点替换，其余键保序保留）============

    /**
     * mutator 收 servers 节点返回新 servers 节点；业务冲突抛 IllegalStateException = 拒绝文案。
     * 进程内锁由调用方持有（synchronized(WRITE_LOCK)），此处再叠 .lock 跨进程文件锁——
     * config.json 是 CLI 也在写的活文件，跨进程并发写必须有防护（0.4.3 审查补齐：
     * KDoc 早已声称此锁而实现缺失，ProviderConfigWriterV2 同款分工）。
     */
    private fun updateFile(file: File, mutator: (JsonObject) -> JsonObject): String? =
        try {
            // 父目录先建：FileChannel.open 只建文件不建父目录，首次添加场景 .zcode/ 尚不存在
            file.parentFile?.let { Files.createDirectories(it.toPath()) }
            // 官方 withFileLock 同款：advisory 独占文件锁串行多进程写方；OS 级锁
            // 进程崩溃自动释放无残留。写入毫秒级，阻塞等待即可。
            java.nio.channels.FileChannel.open(
                file.toPath().resolveSibling(file.name + ".lock"),
                java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.WRITE,
            ).use { ch ->
                ch.lock()
                updateUnderLocks(file, mutator)
            }
        } catch (_: java.nio.channels.OverlappingFileLockException) {
            // 同进程重入理论不可达（WRITE_LOCK 已串行），防御性拒绝
            "文件锁冲突，放弃写入: ${file.name}"
        } catch (e: Exception) {
            "获取文件锁失败（放弃写入）: ${e.message}"
        }

    /** 进程内锁 + 跨进程 .lock 都已持有的读-改-写本体（ProviderConfigWriterV2 同名分工） */
    private fun updateUnderLocks(file: File, mutator: (JsonObject) -> JsonObject): String? {
        val root: JsonObject = if (file.isFile) {
            try {
                Json.parseToJsonElement(file.readText(Charsets.UTF_8)).jsonObject
            } catch (e: Exception) {
                return "解析 ${file.name} 失败（已放弃写入，防止覆盖）: ${e.message}"
            }
        } else {
            JsonObject(emptyMap())
        }

        val newRoot = try {
            val mcp = root["mcp"]?.jsonObject ?: JsonObject(emptyMap())
            val servers = mcp["servers"]?.jsonObject ?: JsonObject(emptyMap())
            val newServers = mutator(servers)
            buildJsonObject {
                root.forEach { (k, v) -> if (k != "mcp") put(k, v) }
                put("mcp", buildJsonObject {
                    mcp.forEach { (k, v) -> if (k != "servers") put(k, v) }
                    put("servers", newServers)
                })
            }
        } catch (e: IllegalStateException) {
            return e.message ?: "操作失败"
        }

        return try {
            writeAtomically(file, newRoot)
            null
        } catch (e: Exception) {
            "写回失败: ${e.message}"
        }
    }

    /** tmp + ATOMIC_MOVE 原子替换；已有文件先滚动备份，move 失败从 .bak.1 回滚 */
    private fun writeAtomically(file: File, newRoot: JsonObject) {
        file.parentFile?.let { Files.createDirectories(it.toPath()) }
        val bak1 = if (file.isFile) rotateBackups(file) else null
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.writeText(json.encodeToString(JsonObject.serializer(), newRoot), Charsets.UTF_8)
        try {
            try {
                Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            } catch (_: java.nio.file.AtomicMoveNotSupportedException) {
                Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
            }
        } catch (e: Exception) {
            // move 失败从 .bak.1 无条件还原（对齐 ProviderConfigWriterV2：非原子回退
            // 路径存在半途态可能，宁多拷一次）；tmp 残留清理
            bak1?.let { runCatching { Files.copy(it.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING) } }
            tmp.delete()
            throw e
        }
    }

    /** 滚动备份链（ProviderConfigWriterV2 同款策略）：.bak.5 删、其余顺移、当前 → .bak.1 */
    private fun rotateBackups(file: File): File {
        val bak1 = File(file.parentFile, file.name + ".bak.1")
        runCatching {
            Files.deleteIfExists(File(file.parentFile, file.name + ".bak.$BAK_GENERATIONS").toPath())
            for (i in BAK_GENERATIONS - 1 downTo 1) {
                val from = File(file.parentFile, file.name + ".bak.$i")
                if (from.isFile) Files.move(from.toPath(), File(file.parentFile, file.name + ".bak.${i + 1}").toPath(), StandardCopyOption.REPLACE_EXISTING)
            }
            Files.copy(file.toPath(), bak1.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }
        return bak1
    }
}
