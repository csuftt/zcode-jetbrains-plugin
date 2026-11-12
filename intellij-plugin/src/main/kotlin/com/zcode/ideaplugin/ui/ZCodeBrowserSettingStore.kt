package com.zcode.ideaplugin.ui

import java.io.File

/**
 * 内置浏览器设置（与 ZCode 客户端公用配置，只读展示——修改一律以 ZCode 客户端为准）：
 *
 * 浏览器控制开关 = 官方启用状态：`~/.zcode/cli/config.json` 的 plugins.enabledPlugins
 * 显式 false 即禁用（官方判定 `enabledPlugins[id] ?? defaultEnabled`）。data/ 目录只是
 * 插件曾初始化的残留——禁用不删除（pdf/presentations 等实测 data 仍在但已 disabled），
 * 所以不能单独拿目录存在当启用判据，要叠加 config 开关。客户端侧开关改的就是这两个位置。
 * （曾实现可写开关，但 zcode.cjs 每次加载插件都 mkdirSync 重建 data 目录——长驻
 * app-server 会把删除的目录"复活"，禁用必须重启后端、中断进行中对话，改为只读。）
 *
 * （「忽略证书校验」开关曾于 0.2.3 实现后移除：注入通道 JCEF 启动参数
 * appRequiredArgumentsProvider EP 工作正常，但 IntelliJ 的 JCEF 对证书错误有自带的
 * "另存为可信站点"弹窗接管，开关开与不开都会弹，功能无实际意义。）
 */
object ZCodeBrowserSettingStore {

    /** Browser Use 官方插件（zcode-plugins-official 市场）*/
    private const val PLUGIN_ID = "browser-use@zcode-plugins-official"

    /** ~/.zcode/cli/plugins/（config.json 同根；浏览器控制与本插件的其他 CLI 配置共用此树）*/
    fun pluginsRoot(home: String = System.getProperty("user.home")): File =
        File(File(File(home, ".zcode"), "cli"), "plugins")

    /** 启用判据目录（存在即启用；zcode.cjs yS() 规范化 pluginId 为目录名）*/
    private fun dataDir(home: String): File = File(File(pluginsRoot(home), "data"), PLUGIN_ID)

    /** 安装判据：cache/zcode-plugins-official/browser-use/ 下有任意版本目录 */
    fun isPluginInstalled(home: String = System.getProperty("user.home")): Boolean {
        val versions = File(File(File(pluginsRoot(home), "cache"), "zcode-plugins-official"), "browser-use")
        return versions.isDirectory && versions.list()?.isNotEmpty() == true
    }

    /** 浏览器控制是否开启：data 目录存在（曾初始化）+ config.json 未显式禁用（只读，客户端侧修改）*/
    fun isBrowserControlEnabled(home: String = System.getProperty("user.home")): Boolean =
        dataDir(home).isDirectory && PLUGIN_ID !in SlashCommandScanner.disabledPluginIds(pluginsRoot(home))
}
