import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

plugins {
    kotlin("jvm") version "1.9.24"
    id("org.jetbrains.intellij") version "1.17.4"
}

group = "com.zcode.ideaplugin"
version = "0.1.0"

// gradle-intellij-plugin 会注入自己的 repository（指向本地 SDK），
// 覆盖 settings 里的镜像，所以这里要显式加回外部仓库
repositories {
    maven("https://maven.aliyun.com/repository/public")
    maven("https://maven.aliyun.com/repository/central")
    mavenCentral()
}

// IntelliJ Platform 配置
intellij {
    // 用 Idea Community Edition 2024.1 作为 SDK
    // （会自动下载，约 1.5GB；首次较慢，之后缓存）
    version.set("2024.1")
    type.set("IC")  // IC = Idea Community

    // 用到的插件（Bundled）
    plugins.set(listOf())

    // 不每次都更新 plugin
    updateSinceUntilBuild.set(false)
}

tasks {
    // 禁用 runIde 默认行为，避免无谓下载（按需手动跑）
    // 但保留任务可用

    withType<JavaCompile> {
        sourceCompatibility = "17"
        targetCompatibility = "17"
    }

    withType<KotlinCompile> {
        kotlinOptions {
            jvmTarget = "17"
        }
    }

    patchPluginXml {
        sinceBuild.set("241")  // 2024.1
        untilBuild.set("261.*")  // 兼容到 2026.1（覆盖你的 IU-261）
    }

    // 禁用 searchableOptions 扫描（启动完整 IDE 来扫 UI，慢且容易失败，对我们没用）
    buildSearchableOptions {
        enabled = false
    }

    // 发行包命名：默认是「模块名-版本.zip」（intellij-plugin-0.1.0.zip），
    // 改为 ZC-GUI-<版本>.zip，只改 zip 文件名，不影响包内结构与安装
    buildPlugin {
        archiveFileName.set("ZC-GUI-${project.version}.zip")
    }

    // webview 构建产物不入库（.gitignore），此处校验打包前制品在位：
    // 缺失时打出的 zip 只含 inline HTML 兜底页（webview 加载链会降级），极易被当成
    // 前端 bug——配置阶段就 warn 提示先跑 ./build.sh（npm build → buildPlugin）
    val webviewIndex = layout.projectDirectory
        .file("src/main/resources/webview/index.html").asFile
    val webviewSingle = layout.projectDirectory
        .file("src/main/resources/webview-single/index.html").asFile
    if (!webviewIndex.isFile || !webviewSingle.isFile) {
        logger.warn(
            "[ZCode] webview 构建产物缺失（webview/index.html、webview-single/index.html）——" +
                "发行包将回退内置兜底 HTML。请先执行 ./build.sh（webview npm build + gradle buildPlugin）"
        )
    }

    // 不签名（开发期）
    signPlugin {
        enabled = false
    }

    publishPlugin {
        enabled = false
    }
}

dependencies {
    // 依赖协议客户端模块
    implementation(project(":protocol-client"))

    // kotlinx serialization（运行时也需要）
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")

    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.3")
}

tasks.test {
    useJUnitPlatform()
}
