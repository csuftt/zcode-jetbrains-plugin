plugins {
    kotlin("jvm") version "1.9.24"
    kotlin("plugin.serialization") version "1.9.24"
    application
}

group = "com.zcode.ideaplugin"
version = "0.1.0"

/*
 * 知识库核心（平台无关）：
 * - Kotlin 侧（com.zcode.kb.core / kb.tools）：存储、提取、git 锚点、启发式——只在 IDE 进程内加载；
 * - Java 侧（com.zcode.kb.text / kb.mcp）：MCP server 主体——被 app-server 以
 *   `java -cp <插件>\lib\*` fork 出去运行，fork JVM 无 kotlin-stdlib（CUA 先例实证），
 *   因此 server 主体与双侧共用的分词器必须纯 Java，且 Java 类不得引用任何 Kotlin 类。
 * 依赖随 implementation 落进插件 zip 的 lib/，fork classpath `lib\*` 天然覆盖。
 */
dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
    // pdf 提取（fontbox/commons-logging 传递）
    implementation("org.apache.pdfbox:pdfbox:3.0.3")
    // html 去标签
    implementation("org.jsoup:jsoup:1.18.3")
    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.3")
    testImplementation("org.junit.platform:junit-platform-launcher:1.10.3")
}

tasks.test {
    useJUnitPlatform()
    testLogging {
        events("passed", "skipped", "failed")
    }
}

kotlin {
    jvmToolchain(17)
}
