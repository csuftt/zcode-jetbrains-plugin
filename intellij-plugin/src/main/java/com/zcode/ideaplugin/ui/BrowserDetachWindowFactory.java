package com.zcode.ideaplugin.ui;

import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.FrameWrapper;

/**
 * FrameWrapper 的构造桥。Kotlin 侧直接构造带默认参的 FrameWrapper 时（继承 super 调用同理），
 * 编译产物会解析到携带 kotlinx.coroutines.CoroutineScope 形参的全参合成构造器；插件 lib 自带的
 * coroutines 副本与平台副本分属两个类加载器，同名类型参与跨加载器方法签名解析时触发
 * loader constraint violation（LinkageError，0.4.1 真机实炸）。javac 解析的是 @JvmOverloads
 * 生成的 (Project, String) 桥构造器，签名里没有跨加载器类型，构造期冲突由此绕开；
 * FrameWrapper 其余成员方法签名只含 JDK/平台类型，Kotlin 侧可安全调用。
 */
final class BrowserDetachWindowFactory {

    private BrowserDetachWindowFactory() {
    }

    static FrameWrapper create(Project project, String dimensionKey) {
        return new FrameWrapper(project, dimensionKey);
    }
}
