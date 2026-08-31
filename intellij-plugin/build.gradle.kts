import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

plugins {
    kotlin("jvm") version "1.9.24"
    id("org.jetbrains.intellij") version "1.17.4"
}

group = "com.zcode.ideaplugin"
version = "0.3.0"

// 从仓库根 CHANGELOG.md 提取「最新一个版本块」（## 标题到下一个 ## 之前），
// 输出中英双语并列的 HTML：中文段在前（主用户群），<h3>English</h3> 分隔后接英文段
// （Marketplace changeNotes 是单字段、无语言切换，双语并列为通行做法）；无语言标记的
// 旧块整块兼容、单语输出。Marketplace 渲染 changeNotes 的 HTML 子集但不解析 markdown
// ——**加粗** / `代码` / [链接] 必须在此转换为 <b>/<code>/<a>，否则星号反引号原样显示；
// 先做 HTML 转义防 CHANGELOG 里的 <depends> 等文本破坏 XML
fun latestChangelogSection(): String {
    val changelog = rootProject.file("CHANGELOG.md").readText()
    val headings = Regex("(?m)^## ").findAll(changelog).toList()
    if (headings.isEmpty()) return ""
    val start = headings.first().range.first
    val end = if (headings.size > 1) headings[1].range.first else changelog.length
    val section = changelog.substring(start, end).trim()

    // 按语言标记拆段：标记行本身移除；English: 之前（含 ## 版本头）为中文段，之后为英文段
    val zhLines = mutableListOf<String>()
    val enLines = mutableListOf<String>()
    var inEnglish = false
    for (line in section.lines()) {
        when (line.trim()) {
            "English:" -> inEnglish = true
            "中文:" -> Unit // 标记行本身移除
            else -> (if (inEnglish) enLines else zhLines).add(line)
        }
    }
    // 英文段不再重复 ## 版本头行
    enLines.removeAll { it.startsWith("## ") }

    fun markdownToHtml(lines: List<String>): String {
        fun inline(s: String): String = s
            .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .let { Regex("\\*\\*([^*]+)\\*\\*").replace(it, "<b>$1</b>") }
            .let { Regex("`([^`]+)`").replace(it, "<code>$1</code>") }
            .let { Regex("\\[([^\\]]+)\\]\\((https?://[^)\\s]+)\\)").replace(it, "<a href=\"$2\">$1</a>") }

        val html = StringBuilder()
        var inList = false
        fun closeList() {
            if (inList) {
                html.append("</ul>\n")
                inList = false
            }
        }
        for (line in lines) {
            when {
                line.startsWith("## ") -> {
                    closeList()
                    html.append("<h3>").append(inline(line.removePrefix("## "))).append("</h3>\n")
                }
                line.startsWith("### ") -> {
                    closeList()
                    html.append("<h4>").append(inline(line.removePrefix("### "))).append("</h4>\n")
                }
                line.startsWith("- ") -> {
                    if (!inList) {
                        html.append("<ul>\n")
                        inList = true
                    }
                    html.append("<li>").append(inline(line.removePrefix("- "))).append("</li>\n")
                }
                line.isBlank() -> { /* 空行：段落间隔，列表边界在下一内容行处理 */ }
                else -> {
                    closeList()
                    html.append("<div>").append(inline(line.trim())).append("</div>\n")
                }
            }
        }
        closeList()
        return html.toString().trim()
    }

    val zhHtml = markdownToHtml(zhLines)
    if (enLines.all { it.isBlank() }) return zhHtml
    return zhHtml + "\n<h3>English</h3>\n" + markdownToHtml(enLines)
}

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
        untilBuild.set("263.*")  // 兼容到 2026.3
        changeNotes.set(latestChangelogSection())
    }

    // 兼容性验证（Marketplace 上架前必跑）：对 gradle.properties 里列出的
    // pluginVerifierIdeVersions 逐个 IDE 版本验证二进制兼容性。
    // 完整列表本地跑：./gradlew :intellij-plugin:runPluginVerifier
    runPluginVerifier {
        ideVersions.set(
            providers.gradleProperty("pluginVerifierIdeVersions").map { it.split(',') }
        )
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

    // 插件签名（Marketplace 官方要求）：证书链/私钥/密码从环境变量读。
    // 未配置时任务自动跳过（本地开发期不签名也不报错）；发布前先跑
    // scripts/gen-signing-key.sh 生成密钥，并 export CERTIFICATE_CHAIN / PRIVATE_KEY /
    // PRIVATE_KEY_PASSWORD（CI 里对应仓库 secrets）
    signPlugin {
        val chain = System.getenv("CERTIFICATE_CHAIN")
        if (!chain.isNullOrBlank()) {
            certificateChain.set(chain)
            privateKey.set(System.getenv("PRIVATE_KEY"))
            password.set(System.getenv("PRIVATE_KEY_PASSWORD") ?: "")
        }
    }

    // 发布到 JetBrains Marketplace：token 从环境变量 MARKETPLACE_TOKEN 读
    // （plugins.jetbrains.com/author/me/tokens 创建）。首次上架必须网页手动上传，
    // 之后打 tag 由 CI（.github/workflows/release.yml）自动发布到 stable 渠道
    publishPlugin {
        val marketplaceToken = System.getenv("MARKETPLACE_TOKEN")
        if (!marketplaceToken.isNullOrBlank()) {
            token.set(marketplaceToken)
        }
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
