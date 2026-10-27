package com.zcode.ideaplugin.viz

import java.io.File
import java.security.SecureRandom
import java.util.LinkedHashMap

/**
 * ::visualize 内联可视化的本地文件注册表（安全网关 + serve 期注入）
 *
 * 官方客户端在助手消息里输出 `::visualize{"path":...}` 引用会话可视化目录
 * （~/.zcode/v2/visualizations/<hash>/xxx.html）里的 HTML 片段。插件侧兼容链路：
 * webview 发 vizOpen op → 这里校验+登记 → 拿 token 换内置 server 的 /viz/<token>
 * URL 给 iframe 沙箱加载（AI 生成内容不与 webview 主页面同源）。
 *
 * 安全约束：
 * - 白名单根：仅 ~/.zcode/v2/visualizations 与 ~/.zcode/visualizations（测试可注入覆盖），
 *   canonicalPath 前缀校验防 ..\ 与 symlink 穿越（同 ToolResultMediaEnricher.isUnderRoots 手法）
 * - 仅 .html、≤2MB（官方可视化预算 1MB，放宽一倍兜底）
 * - token 间接：URL 里只出现随机 token，不出现磁盘路径；LRU 上限防表膨胀
 *
 * decorate() 负责 serve 期给 fragment 注入宿主基线：官方桌面宿主为 fragment 提供
 * 主题 token（--background/--viz-series-* 等 CSS 变量）、window.zcode API 与
 * data-tooltip/lucide 运行时——插件侧在同一份内容前前置 style+script 等价实现。
 */
object VisualizeFileRegistry {

    /** 大小上限 */
    private const val MAX_FILE_BYTES = 2L * 1024 * 1024

    /** token 表容量上限（同 path 复用 token，正常会话远到不了；测试引用） */
    internal const val MAX_ENTRIES = 64

    /** 测试重置口：单例 token 表与白名单根覆盖须在用例间清场 */
    @Synchronized
    internal fun resetForTest() {
        tokens.clear()
        pathToToken.clear()
        rootsOverride = null
    }

    /** token 形态：SecureRandom 32 hex */
    internal val tokenPattern = Regex("^[a-f0-9]{32}$")

    /** 白名单根（测试可覆盖） */
    @Volatile
    internal var rootsOverride: List<File>? = null

    internal val roots: List<File>
        get() = rootsOverride ?: run {
            val zcode = File(System.getProperty("user.home"), ".zcode")
            listOf(File(File(zcode, "v2"), "visualizations"), File(zcode, "visualizations"))
        }

    // token -> canonical path；accessOrder=true 使读取也续期（LRU）
    private val tokens = LinkedHashMap<String, String>(16, 0.75f, true)
    private val pathToToken = HashMap<String, String>()
    private val random = SecureRandom()

    /** 注册结果（error 为面向用户的中文提示） */
    data class Registration(val ok: Boolean, val token: String? = null, val error: String? = null)

    /** 校验并把文件登记进 token 表；同一路径复用既有 token */
    @Synchronized
    fun register(rawPath: String): Registration {
        val path = rawPath.trim()
        if (path.isEmpty()) return Registration(false, error = "path 为空")
        val f = File(path)
        if (!f.isAbsolute) return Registration(false, error = "path 必须是绝对路径")
        if (!f.name.lowercase().endsWith(".html")) return Registration(false, error = "仅支持 .html 可视化文件")
        if (!f.isFile) return Registration(false, error = "可视化文件不存在")
        if (f.length() > MAX_FILE_BYTES) return Registration(false, error = "可视化文件超过 2MB 上限")
        val canonical = try {
            f.canonicalFile
        } catch (e: Exception) {
            return Registration(false, error = "路径解析失败")
        }
        val underRoot = roots.any { root ->
            val rc = try {
                root.canonicalFile
            } catch (_: Exception) {
                return@any false
            }
            canonical.path.startsWith(rc.path + File.separator)
        }
        if (!underRoot) return Registration(false, error = "路径不在允许的可视化目录内")

        val key = canonical.path
        pathToToken[key]?.let { existing ->
            tokens[existing] = key
            return Registration(true, token = existing)
        }
        var token = newToken()
        while (tokens.containsKey(token)) token = newToken()
        tokens[token] = key
        pathToToken[key] = token
        while (tokens.size > MAX_ENTRIES) {
            val it = tokens.entries.iterator()
            val eldest = it.next()
            pathToToken.remove(eldest.value)
            it.remove()
        }
        return Registration(true, token = token)
    }

    /** token → 磁盘文件（每次 serve 前重验存在，文件被轮转删除则自然 404） */
    @Synchronized
    fun resolve(token: String): File? {
        if (!tokenPattern.matches(token)) return null
        val path = tokens[token] ?: return null
        val f = File(path)
        return if (f.isFile) f else null
    }

    private fun newToken(): String {
        val bytes = ByteArray(16)
        random.nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }

    /**
     * 给可视化 fragment 注入宿主基线（前置 style + script，先于 fragment 自身脚本执行）。
     * theme 只接受 light/dark（其余按 dark）。
     */
    fun decorate(rawHtml: String, theme: String): String {
        val t = if (theme.equals("light", ignoreCase = true)) "light" else "dark"
        return buildString {
            append("<style>").append(THEME_CSS).append("</style>\n")
            append("<script>").append(BOOTSTRAP_JS.replace("__VIZ_THEME__", t)).append("</script>\n")
            append(rawHtml)
        }
    }

    // 主题 token 集：取值映射自 webview/src/styles/variables.less（--chart-line-* 对应
    // 官方宿主的 --viz-series-*，保持插件内图表配色一致）
    private val THEME_CSS = """
*{box-sizing:border-box}
:root{
  color-scheme:dark;
  --font-size-base:14px;
  --background:#1e1e1e;--foreground:#cccccc;
  --card:#2d2d2d;--card-foreground:#cccccc;
  --popover:#252526;--popover-foreground:#cccccc;
  --primary:#007fd4;--primary-foreground:#ffffff;
  --secondary:#2b2d31;--secondary-foreground:#cccccc;
  --muted:#2b2d31;--muted-foreground:#858585;
  --accent:#35373c;--accent-foreground:#cccccc;
  --destructive:#f44336;
  --border:#3a3a3a;--input:#3e3e42;--ring:#007fd4;
  --blue:#64b5f6;--green:#4caf50;--orange:#ff9800;--red:#f44336;--yellow:#f5b942;--purple:#9c64f6;
  --viz-series-1:#6B9BFF;--viz-series-2:#FF9E5E;--viz-series-3:#66BB6A;
  --viz-series-4:#B98BFF;--viz-series-5:#4DC3D6;--viz-series-6:#F06292;
}
:root[data-theme='light']{
  color-scheme:light;
  --background:#ffffff;--foreground:#333333;
  --card:#ffffff;--card-foreground:#333333;
  --popover:#ffffff;--popover-foreground:#333333;
  --primary:#0066b8;--primary-foreground:#ffffff;
  --secondary:#ececec;--secondary-foreground:#333333;
  --muted:#f3f3f3;--muted-foreground:#616161;
  --accent:#e8e8e8;--accent-foreground:#333333;
  --destructive:#c62828;
  --border:#d4d4d4;--input:#d0d0d0;--ring:#0078d4;
  --blue:#0969da;--green:#2e7d32;--orange:#e65100;--red:#c62828;--yellow:#c48a10;--purple:#7d3fc4;
  --viz-series-1:#134CFF;--viz-series-2:#FF7C1E;--viz-series-3:#2E7D32;
  --viz-series-4:#7C4DFF;--viz-series-5:#00838F;--viz-series-6:#C2185B;
}
html{margin:0;padding:0;background:transparent}
/* body 四周留缝：对齐官方桌面宿主卡片内的留白；scrollHeight 含 padding，
   高度上报天然自洽（复制图片截 iframe 区域时截图自带边距） */
body{margin:0;padding:12px 16px;background:transparent;color:var(--foreground);font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;font-size:var(--font-size-base);line-height:1.5;overflow-wrap:break-word}
h1,h2,h3{margin:.6em 0 .4em;line-height:1.3}
p{margin:.5em 0}
a{color:var(--blue)}
hr{border:none;border-top:1px solid var(--border)}
button,input,select,textarea{font:inherit;color:inherit}
.text-small{font-size:12px}
.text-muted{color:var(--muted-foreground)}
.tabular-nums{font-variant-numeric:tabular-nums}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.card{background:var(--card);color:var(--card-foreground);border:1px solid var(--border);border-radius:10px;padding:14px}
.viz-stat-value{font-size:20px;font-weight:500}
.viz-dotted-background{background-image:radial-gradient(var(--border) 1px,transparent 1px);background-size:16px 16px}
.zcode-viz-tooltip{position:fixed;z-index:2147483647;max-width:260px;padding:5px 9px;background:var(--popover);color:var(--popover-foreground);border:1px solid var(--border);border-radius:6px;font-size:12px;pointer-events:none;box-shadow:0 4px 12px rgba(0,0,0,.3)}
""".trim()

    // 宿主运行时 shim：主题应用/转发、window.zcode API 兜底、lucide 懒补齐、
    // 高度 postMessage 上报（父页据此自适应 iframe 高）、data-tooltip 迷你实现。
    // __VIZ_THEME__ 由 decorate 替换；JS 内禁用模板字面量与 $，避免与 Kotlin 转义纠缠。
    private val BOOTSTRAP_JS = """
(function(){
  var parentWin=null;
  try{parentWin=window.parent;}catch(e){parentWin=null;}
  function post(msg){if(!parentWin)return;try{parentWin.postMessage(msg,'*');}catch(e){}}
  function applyTheme(t){document.documentElement.setAttribute('data-theme',(t==='light')?'light':'dark');}
  applyTheme('__VIZ_THEME__');
  window.addEventListener('message',function(ev){
    var d=ev.data;
    if(!d||d.source!=='zcode-viz-host')return;
    if(d.type==='theme')applyTheme(d.theme);
  });
  window.zcode={
    widgetState:{},
    setWidgetState:function(){return Promise.resolve();},
    sendFollowUpMessage:function(p){post({source:'zcode-viz',type:'follow-up',prompt:p&&p.prompt,title:p&&p.title});return Promise.resolve();},
    openExternal:function(o){post({source:'zcode-viz',type:'open-external',href:o&&o.href});return Promise.resolve();}
  };
  if(!window.lucide){window.lucide={createIcons:function(){},icons:{}};}
  var s=document.createElement('script');
  s.src='https://cdn.jsdelivr.net/npm/lucide/dist/umd/lucide.min.js';
  s.async=true;
  s.onload=function(){try{if(window.lucide&&window.lucide.createIcons)window.lucide.createIcons({attrs:{width:16,height:16}});}catch(e){}};
  (document.head||document.documentElement).appendChild(s);
  var scheduled=false;
  function report(){
    if(scheduled)return;
    scheduled=true;
    requestAnimationFrame(function(){
      scheduled=false;
      var h=Math.max(document.documentElement.scrollHeight||0,document.body?document.body.scrollHeight:0);
      post({source:'zcode-viz',type:'resize',height:h});
    });
  }
  if(window.ResizeObserver){
    var ro=new ResizeObserver(report);
    ro.observe(document.documentElement);
    var watchBody=function(){if(document.body){ro.observe(document.body);}else{setTimeout(watchBody,50);}};
    watchBody();
  }
  window.addEventListener('load',report);
  report();
  var tip=null;
  function hideTip(){if(tip){tip.remove();tip=null;}}
  function showTip(el){
    var text=el.getAttribute('data-tooltip');
    if(!text)return;
    hideTip();
    tip=document.createElement('div');
    tip.className='zcode-viz-tooltip';
    tip.textContent=text;
    document.body.appendChild(tip);
    var r=el.getBoundingClientRect();
    var tr=tip.getBoundingClientRect();
    var left=r.left+r.width/2-tr.width/2;
    left=Math.max(4,Math.min(left,(window.innerWidth||9999)-tr.width-4));
    var top=r.top-tr.height-6;
    if(top<4)top=r.bottom+6;
    tip.style.left=left+'px';
    tip.style.top=top+'px';
  }
  function closestTip(target){return target&&target.closest?target.closest('[data-tooltip]'):null;}
  document.addEventListener('mouseover',function(e){var el=closestTip(e.target);if(el)showTip(el);});
  document.addEventListener('mouseout',function(e){if(closestTip(e.target))hideTip();});
  document.addEventListener('focusin',function(e){var el=closestTip(e.target);if(el)showTip(el);});
  document.addEventListener('focusout',hideTip);
})();
""".trim()
}
