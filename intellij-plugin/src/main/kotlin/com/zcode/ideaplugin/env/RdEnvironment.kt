package com.zcode.ideaplugin.env

import com.intellij.openapi.diagnostic.Logger

/**
 * 远程开发（JetBrains Gateway / RD）环境判定。
 *
 * RD 下 AI 浏览器工具（browser-use）依赖的 CEF 调试通道跑在前端本机，
 * 后端（remote-dev-server host）探测必失败——envCheck 据此跳过 browserHost
 * 探针，避免误报「浏览器调试通道不可用」横幅（issue #6）。
 *
 * 反射调用 com.intellij.idea.AppMode.isRemoteDevHost()：该类与方法自 2024.1
 * 基线起存在（2024.1 SDK util-8.jar 与 2026.2 RD 后端双核实，public static
 * boolean），但整个类标注 @ApiStatus.Internal——直调会进 Plugin Verifier 的
 * internal usage 报告（Marketplace 审核页红标），故改为反射。类名是核实过的
 * 真实类名，与初版臆造 com.intellij.remoteDev.util.RemoteDevDetector 的失败
 * 反射不同；失败兜底 false（=本地 IDE 语义，最坏退回横幅误报，不会崩溃）。
 */
object RdEnvironment {

    private val LOG = Logger.getInstance(RdEnvironment::class.java)

    /**
     * 当前进程是否 RD 后端 host（remote-dev-server）。
     * 前端（JetBrains Client / 2026.2 起的本机完整 IDE）与本地 IDE 均为 false。
     */
    fun isRemoteDevHost(): Boolean = try {
        val method = Class.forName("com.intellij.idea.AppMode").getMethod("isRemoteDevHost")
        method.invoke(null) as? Boolean == true
    } catch (t: Throwable) {
        LOG.debug("AppMode.isRemoteDevHost 反射调用失败，按本地 IDE 处理（false）", t)
        false
    }
}
