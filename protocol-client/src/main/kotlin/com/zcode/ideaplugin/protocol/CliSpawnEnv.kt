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
 * 不用于主 app-server 与 `sendViaCliResume`：插件直读会话库/任务索引（cli/db/db.sqlite、
 * v2/tasks-index.sqlite）仍以 home 为权威，单点重定向会让 app-server 与直读侧错位，
 * `--resume` 也会找不到会话。全面数据根对齐另行设计（ADR-0011）。
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
