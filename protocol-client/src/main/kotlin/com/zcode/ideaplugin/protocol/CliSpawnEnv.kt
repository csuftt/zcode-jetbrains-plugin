package com.zcode.ideaplugin.protocol

/**
 * CLI 子进程 spawn env 补充：数据根重定向（issue #50）。
 *
 * zcode.cjs 解析数据根只认 env `ZCODE_DATA_BASE_DIR`（缺省 `homedir()`），**不读**
 * setting.json 的 `dataBaseDir`；而插件侧读配置（[Credentials.personalProviderConfigPath]
 * 等）是跟随重定向的。不下发数据根时两侧读的不是同一份 provider_config.json：
 * 润色专用 app-server 报 `-32603`（Provider Registry 中不存在 Provider），CLI 一次性
 * 调用报 `Select a model before sending a message`（issue #50 隔离环境逐字复现）。
 *
 * 使用面（有意保持窄口径）：
 * - 润色/标题专用 app-server（`ZCodeProtocolClient.start(extraEnv = ...)`）
 * - 一次性 CLI 调用 `ZCodeProtocolClient.cliOneShot`
 *
 * 不用于主 app-server 与 `sendViaCliResume`：桌面端自己的 CLI 进程也不跟随 dataBaseDir
 * （迁移实测：会话数据 `cli/` 不随数据根迁移，桌面端新会话照样写 home 的 `cli/db`）。
 * 主进程若注入该变量，CLI 会在重定向目录新建一份空的 `cli` 库，制造真正的会话分叉
 * （ADR-0011）。任务索引等 v2 直读面由插件侧单独跟随 dataBaseDir（见
 * [Credentials.taskIndexPath]），与 CLI 进程无关。
 */
object CliSpawnEnv {

    /** zcode.cjs 数据根基目录环境变量（CLI 侧 resolveZCodeDataBaseDir 唯一入口） */
    const val DATA_BASE_DIR = "ZCODE_DATA_BASE_DIR"

    /**
     * 在既有 env 上追加数据根（配置了才加；同名键以数据根为准，其余键原样保留）。
     * 未配置/空白/相对路径不注入——CLI 保持 homedir 默认语义。
     */
    fun withDataBaseDir(
        base: Map<String, String>,
        home: String = System.getProperty("user.home") ?: ".",
    ): Map<String, String> = Credentials.configuredDataBaseDir(home)
        ?.let { base + mapOf(DATA_BASE_DIR to it) }
        ?: base

    /** 独立 env 片段（`start(extraEnv = ...)` 参数用）；未配置返回空 map */
    fun extraEnv(home: String = System.getProperty("user.home") ?: "."): Map<String, String> =
        withDataBaseDir(emptyMap(), home)
}
