package com.zcode.ideaplugin.env

import com.intellij.openapi.diagnostic.Logger
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption

/**
 * CLI 同级 provider 目录垫底（Linux 形态「app-server 启动即退出」自愈）。
 *
 * zcode.cjs 独立启动会自检内置渠道目录（逆向 resolveBundledZCodeBuiltinProviderConfig，
 * 无任何环境变量入口）：仅搜 ①zcode.cjs 同级 provider/zcode-builtin.json ②自身路径固定
 * 5 级祖先 + config/provider/——后者按 Windows 客户端深层布局设计（AppData 恰好命中），
 * Linux 目录浅溢出到 /config 等死路径。于是 AppImage（provider 在挂载点 config/provider/
 * 内，CLI 无持久落盘）/ deb（provider 在 /opt/ZCode/resources/config/provider/，自检够
 * 不着）形态下 spawn 必报「无法定位 CLI ZCode Built-in Provider Config」秒退，客户端
 * 同步/重建 server/agents 时也从不带 provider/。
 *
 * 自愈：spawn 前若 CLI 同级 provider/zcode-builtin.json 缺失，从官方源拷一份。源按
 * 新鲜度取：①~/.zcode/v2/runtime/provider/（客户端登录产物，随渠道演进最新）②客户端
 * 安装目录 config/provider/。刻意不内置资源副本：两源全落空的场景必然是客户端未登录
 * （无凭证本就不可用），且避免仓库携带会过时的官方目录。
 *
 * 已存在不覆盖（尊重客户端同步的版本）；目标不可写（如 /opt 无 root）时降级 warn，
 * 不阻断 spawn——由 CLI 自检走既有报错链。
 */
object ZCodeProviderBootstrap {
    private val log = Logger.getInstance(ZCodeProviderBootstrap::class.java)

    /** Already=已存在跳过 / Copied=本次垫入 / Failed=自愈失败（不阻断 spawn） */
    sealed interface Result {
        data object Already : Result
        data object Copied : Result
        data class Failed(val reason: String) : Result
    }

    /**
     * @param zcodePath zcode.cjs 绝对路径（provider 目录取其同级）
     * @param home 用户主目录（测试注入用）
     */
    fun ensureBuiltinProvider(
        zcodePath: Path,
        home: Path = Path.of(System.getProperty("user.home")),
    ): Result {
        val target = zcodePath.resolveSibling("provider").resolve("zcode-builtin.json")
        if (Files.isRegularFile(target)) return Result.Already
        val source = newestRuntimeProvider(home) ?: installedProvider(home)
        if (source == null) {
            log.warn(
                "[provider-bootstrap] no zcode-builtin.json source for ${target.parent} " +
                    "(v2/runtime 与安装目录均无)，CLI 自检可能失败"
            )
            return Result.Failed("未找到内置渠道目录源")
        }
        return try {
            Files.createDirectories(target.parent)
            Files.copy(source, target, StandardCopyOption.REPLACE_EXISTING)
            log.info("[provider-bootstrap] seeded $target <- $source")
            Result.Copied
        } catch (e: Exception) {
            log.warn("[provider-bootstrap] failed to seed $target <- $source: ${e.message}")
            Result.Failed("写入失败：${e.message}")
        }
    }

    /** ① 客户端登录产物：~/.zcode/v2/runtime/provider/**/zcode-builtin.json 取 mtime 最新（Kotlin 块注释嵌套：此处不写通配星号）*/
    private fun newestRuntimeProvider(home: Path): Path? = try {
        val root = home.resolve(".zcode").resolve("v2").resolve("runtime").resolve("provider")
        if (Files.isDirectory(root)) {
            var newest: Path? = null
            var newestMtime = Long.MIN_VALUE
            Files.walk(root, 6).use { stream ->
                stream.filter { it.fileName.toString() == "zcode-builtin.json" && Files.isRegularFile(it) }
                    .forEach {
                        val t = runCatching { Files.getLastModifiedTime(it).toMillis() }.getOrDefault(0L)
                        if (t > newestMtime) {
                            newestMtime = t
                            newest = it
                        }
                    }
            }
            newest
        } else {
            null
        }
    } catch (_: Exception) {
        null
    }

    /** ② 客户端安装目录 config/provider/（自检 5 级祖先算法本想命中的位置） */
    private fun installedProvider(home: Path): Path? = listOf(
        home.resolve("AppData").resolve("config/provider/zcode-builtin.json"),
        Path.of("/opt/ZCode/resources/config/provider/zcode-builtin.json"),
        Path.of("/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json"),
    ).firstOrNull { Files.isRegularFile(it) }
}
