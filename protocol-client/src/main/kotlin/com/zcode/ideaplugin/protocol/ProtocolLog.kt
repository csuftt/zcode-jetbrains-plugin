package com.zcode.ideaplugin.protocol

/**
 * protocol-client 轻量日志门面（模块无 IntelliJ 依赖，用不了平台 Logger）
 *
 * 诊断探针类日志（V4FrameProbe 帧计数、V4FrameMapper 收尾观察）逐帧/逐 turn
 * 打印，生产常开刷屏——统一收口：debug 受开关控制，默认关；排查子代理流类
 * 问题时开 `-Dzcode.protocol.log=1`（或环境变量 ZCODE_PROTOCOL_LOG=1）重启
 * IDE 即可在 idea.log 看到埋点。error 级不受开关控制（丢帧等异常路径保留
 * 生产可见性）。
 */
object ProtocolLog {

    @Volatile
    var debugEnabled: Boolean = System.getProperty("zcode.protocol.log") == "1"
        || System.getenv("ZCODE_PROTOCOL_LOG") == "1"

    fun debug(msg: String) {
        if (debugEnabled) println(msg)
    }

    fun error(msg: String) {
        System.err.println(msg)
    }
}
