package com.zcode.ideaplugin.env

import com.intellij.idea.AppMode

/**
 * 远程开发（JetBrains Gateway / RD）环境判定。
 *
 * RD 下 AI 浏览器工具（browser-use）依赖的 CEF 调试通道跑在前端本机，
 * 后端（remote-dev-server host）探测必失败——envCheck 据此跳过 browserHost
 * 探针，避免误报「浏览器调试通道不可用」横幅（issue #6）。
 *
 * 判定用官方公开 API AppMode.isRemoteDevHost()（2024.1 基线与 2026.2
 * 运行时均实测存在，public static）。初版反射臆造的
 * com.intellij.remoteDev.util.RemoteDevDetector 在两个版本都不存在，
 * ClassNotFound 被 catch 吞掉恒 false，降级从未生效（横幅照常误报）。
 */
object RdEnvironment {

    /**
     * 当前进程是否 RD 后端 host（remote-dev-server）。
     * 前端（JetBrains Client / 2026.2 起的本机完整 IDE）与本地 IDE 均为 false。
     */
    fun isRemoteDevHost(): Boolean = try {
        AppMode.isRemoteDevHost()
    } catch (_: Throwable) {
        false
    }
}
