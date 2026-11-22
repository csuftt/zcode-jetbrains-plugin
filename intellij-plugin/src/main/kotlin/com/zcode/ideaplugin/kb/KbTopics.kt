package com.zcode.ideaplugin.kb

import com.intellij.openapi.project.Project
import com.intellij.util.messages.Topic

/**
 * 知识库数据变更广播（issue#54 真机缺陷修复）：右键/拖拽/设置页改动发生在与
 * ToolWindow 面板互不知晓的调用方，收录后面板不刷新（真机：收录成功但列表空）。
 * 统一经 MessageBus 通知，面板订阅即刷；KbManagerService 的变更方法收口发布。
 */
interface KbChangedListener {
    fun kbChanged()
}

/** 知识库启用开关切换（缺陷HW-2）：APP 级广播，各 project 同步工具窗可用性 */
interface KbSwitchListener {
    fun kbSwitched(enabled: Boolean)
}

object KbTopics {
    // TO_CHILDREN：publish(null) 走 app 总线（sweep/摘除/重建无 project 上下文），NONE 只同层
    // 会漏掉所有 project 订阅者（真机实证：摘除后面板不刷新），TO_CHILDREN 使 app 发布到达各 project
    val KB_CHANGED: Topic<KbChangedListener> = Topic.create(
        "ZCode KB changed",
        KbChangedListener::class.java,
        Topic.BroadcastDirection.TO_CHILDREN,
    )

    /** TO_CHILDREN：app 发布、各 project messageBus 订阅可收 */
    val KB_SWITCHED: Topic<KbSwitchListener> = Topic.create(
        "ZCode KB switched",
        KbSwitchListener::class.java,
        Topic.BroadcastDirection.TO_CHILDREN,
    )

    fun publish(project: Project?) {
        val bus = if (project != null) project.messageBus else null
        if (bus != null) {
            bus.syncPublisher(KB_CHANGED).kbChanged()
            return
        }
        // 项目缺失（如拖拽到工具窗前项目已关）退化为全应用广播
        com.intellij.openapi.application.ApplicationManager.getApplication()
            ?.messageBus?.syncPublisher(KB_CHANGED)?.kbChanged()
    }

    /** 开关切换（APP 级发布；TO_CHILDREN 使各 project 订阅者收到） */
    fun publishSwitched(enabled: Boolean) {
        com.intellij.openapi.application.ApplicationManager.getApplication()
            ?.messageBus?.syncPublisher(KB_SWITCHED)?.kbSwitched(enabled)
    }
}
