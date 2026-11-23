package com.zcode.kb.mcp;

import java.io.BufferedReader;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 知识库 MCP server（stdio JSON-RPC，纯 Java——fork JVM 无 kotlin-stdlib，不得引用
 * Kotlin 类；分词器 KbTokenizer 同为纯 Java 双侧共用）。
 *
 * 生命周期同 CUA：由 app-server 按 session/create 顶层 mcpServers 注入配置拉起，
 * stdin EOF 即退出（管道断 → readLine null → halt）。读库文件（root/entries/*.json +
 * root/text/*.txt + root/config.json）；管理写与 IDE 侧同手法（临时文件 + ATOMIC_MOVE，
 * 读侧无撕裂，跨进程最坏丢一次更新）。库根环境变量 ZCODE_KB_ROOT（IDE 注入时带上，
 * 自定义库位置生效），缺省 ~/.zcgui/knowledge。
 *
 * 工具面（检索 3 + 管理 4）：
 * - kb_search(query, folder?, tag?, project?, limit?) → 命中列表（id/标题/目录路径/标签/摘要）
 * - kb_read(id)  → 提取全文（超 40k 字符截断并注明）
 * - kb_list(folder?, tag?, project?, limit?) → 浏览清单
 * - kb_tree() → 目录树统计（path/count/subtreeCount）+ 根级/全库计数 + 标签清单（整理起点）
 * - kb_folder(action: create|rename|move|delete, path, ...) → 目录管理（AI 面全用路径定位；
 *   move 可带 index=目标层兄弟位次，同层排序/层首插位）
 * - kb_entry(action: move|update|delete, ids, ...) → 条目批量移动/改标题·标签·备注/摘除
 *   （摘除只删元数据+提取缓存，磁盘源文件永不触碰；move 可带 index=目标层条目位次，
 *   层内顺序 = index 升序、并列按收录新旧——与 IDE 树视觉序一致）
 * - kb_tag(action: create|rename|delete|color, name, ...) → 标签注册表管理
 * - kb_add(path, title?, folderPath?, tags?, notes?) → 收录文档（指针模型，IDE ingest 同
 *   语义：判重命中=更新元数据；提取走 IDE 同款 KbExtractor，git 锚点不抓）
 *
 * 无 CUA 式 fail-closed 闸门：server 只碰本地知识库文件（删条目不碰源文件），无安全敏感
 * 面；工具调用过 zcode 的 MCP 权限审批；设置关闭后的新会话不再注入（KbFeature 门控），
 * 已注入会话存续期内的残留工具无害。
 */
public final class KbMcpServerMain {

    private static final PrintStream OUT =
            new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);
    private static final PrintStream ERR =
            new PrintStream(new FileOutputStream(FileDescriptor.err), true, StandardCharsets.UTF_8);

    private static final int MAX_READ_CHARS = 40_000;

    private KbMcpServerMain() {
    }

    public static void main(String[] args) throws Exception {
        Path root = rootDir();
        KbServerStore store = new KbServerStore(root);
        err("root=" + root + " available=" + store.available() + " entries=" + store.entryCount());
        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        while (true) {
            String line = reader.readLine();
            if (line == null) {
                break;
            }
            if (line.isBlank()) {
                continue;
            }
            String response;
            try {
                response = dispatch(line, store);
            } catch (Exception e) {
                err("dispatch crash: " + e.getClass().getSimpleName() + ": " + e.getMessage());
                response = errorResponse(null, -32603, "internal error: " + msg(e));
            }
            if (response != null) {
                OUT.print(response);
                OUT.print("\n");
                OUT.flush();
            }
        }
        store.close();
        Runtime.getRuntime().halt(0);
    }

    static Path rootDir() {
        String env = System.getenv("ZCODE_KB_ROOT");
        if (env != null && !env.isBlank() && Files.isDirectory(Path.of(env))) {
            return Path.of(env);
        }
        String home = System.getProperty("user.home", ".");
        return Path.of(home, ".zcgui", "knowledge");
    }

    private static void err(String msg) {
        ERR.println("[zcgui-kb] " + msg);
    }

    private static String msg(Throwable e) {
        return e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
    }

    /** @return 要写回 stdout 的 JSON 文本；通知返回 null */
    static String dispatch(String line, KbServerStore store) {
        Object parsed;
        try {
            parsed = KbMiniJson.parse(line);
        } catch (Exception e) {
            return errorResponse(null, -32700, "parse error");
        }
        if (!(parsed instanceof Map)) {
            return null;
        }
        Map<?, ?> msg = (Map<?, ?>) parsed;
        String method = (String) msg.get("method");
        Object id = msg.get("id");
        if (method == null) {
            return null;
        }
        switch (method) {
            case "initialize":
                return "{\"jsonrpc\":\"2.0\",\"id\":" + idJson(id)
                    + ",\"result\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{\"tools\":{}},"
                    + "\"serverInfo\":{\"name\":\"zcgui-knowledge\",\"version\":\"0.1.0\"}}}";
            case "notifications/initialized":
            case "notifications/cancelled":
                return null;
            case "ping":
                return "{\"jsonrpc\":\"2.0\",\"id\":" + idJson(id) + ",\"result\":{}}";
            case "tools/list": {
                StringBuilder sb = new StringBuilder("{\"jsonrpc\":\"2.0\",\"id\":").append(idJson(id))
                    .append(",\"result\":{\"tools\":[");
                for (int i = 0; i < TOOLS.length; i++) {
                    if (i > 0) {
                        sb.append(',');
                    }
                    sb.append(TOOLS[i]);
                }
                return sb.append("]}}").toString();
            }
            case "tools/call": {
                Map<?, ?> params = asMap(msg.get("params"));
                String name = params.get("name") instanceof String ? (String) params.get("name") : "";
                Map<?, ?> toolArgs = asMap(params.get("arguments"));
                long started = System.currentTimeMillis();
                String result;
                try {
                    result = callTool(store, name, toolArgs);
                } catch (KbServerStore.KbOpException e) {
                    // 业务性拒绝（路径不存在/防环/条目缺失）—— isError 结果回给模型自行纠正
                    err("tool " + name + " rejected: " + e.getMessage());
                    result = KbMiniJson.textResult("{\"error\":" + KbMiniJson.str(e.getMessage()) + "}", true);
                } catch (Exception e) {
                    err("tool " + name + " crashed: " + e.getClass().getSimpleName() + ": " + e.getMessage());
                    result = KbMiniJson.textResult(
                        "{\"error\":\"internal: " + KbMiniJson.escape(msg(e)) + "\"}", true);
                }
                err("tool " + name + " " + (System.currentTimeMillis() - started) + "ms");
                return "{\"jsonrpc\":\"2.0\",\"id\":" + idJson(id) + ",\"result\":" + result + "}";
            }
            default:
                return errorResponse(id, -32601, "method not found: " + method);
        }
    }

    private static String callTool(KbServerStore store, String name, Map<?, ?> args) {
        switch (name) {
            case "kb_search": {
                String query = strArg(args, "query", "");
                String folder = optStr(args, "folder");
                String tag = optStr(args, "tag");
                String project = optStr(args, "project");
                int limit = intArg(args, "limit", 20);
                List<KbServerStore.Row> rows = store.search(query, folder, tag, project, Math.min(Math.max(limit, 1), 100));
                StringBuilder sb = new StringBuilder("[");
                for (int i = 0; i < rows.size(); i++) {
                    if (i > 0) sb.append(',');
                    sb.append(rowJson(rows.get(i), true));
                }
                sb.append(']');
                return KbMiniJson.textResult(sb.toString(), false);
            }
            case "kb_read": {
                String id = strArg(args, "id", "");
                KbServerStore.Row row = store.entry(id);
                if (row == null) {
                    return KbMiniJson.textResult("{\"error\":\"entry not found: " + KbMiniJson.escape(id) + "\"}", true);
                }
                String text = store.readText(id);
                if (text == null) {
                    return KbMiniJson.textResult("{\"error\":\"entry text missing (index out of date?): " + KbMiniJson.escape(id) + "\"}", true);
                }
                String note = "";
                if (text.length() > MAX_READ_CHARS) {
                    text = text.substring(0, MAX_READ_CHARS);
                    note = "\n\n[truncated at " + MAX_READ_CHARS + " chars; open the source file for the rest]";
                }
                String header = "### " + row.title + "\n"
                    + "- folder: " + safe(row.folder) + " | tags: " + row.tagsJson
                    + " | project: " + safe(row.project) + " | status: " + safe(row.status) + "\n"
                    + "- source: " + safe(row.sourcePath) + "\n\n";
                return KbMiniJson.textResult(KbMiniJson.escape(header + text + note), false);
            }
            case "kb_list": {
                String folder = optStr(args, "folder");
                String tag = optStr(args, "tag");
                String project = optStr(args, "project");
                int limit = intArg(args, "limit", 100);
                List<KbServerStore.Row> rows = store.list(folder, tag, project, Math.min(Math.max(limit, 1), 500));
                StringBuilder sb = new StringBuilder("[");
                for (int i = 0; i < rows.size(); i++) {
                    if (i > 0) sb.append(',');
                    sb.append(rowJson(rows.get(i), false));
                }
                sb.append(']');
                return KbMiniJson.textResult(sb.toString(), false);
            }
            case "kb_tree": {
                StringBuilder sb = new StringBuilder("{\"folders\":[");
                List<KbServerStore.FolderStat> stats = store.folderStats();
                for (int i = 0; i < stats.size(); i++) {
                    if (i > 0) {
                        sb.append(',');
                    }
                    KbServerStore.FolderStat s = stats.get(i);
                    sb.append("{\"id\":").append(KbMiniJson.str(s.id))
                        .append(",\"path\":").append(KbMiniJson.str(s.path))
                        .append(",\"count\":").append(s.directCount)
                        .append(",\"subtreeCount\":").append(s.subtreeCount).append('}');
                }
                sb.append("],\"rootCount\":").append(store.rootCount())
                    .append(",\"total\":").append(store.entryCount())
                    .append(",\"tags\":[");
                List<KbServerStore.TagStat> tags = store.tagStats();
                for (int i = 0; i < tags.size(); i++) {
                    if (i > 0) {
                        sb.append(',');
                    }
                    KbServerStore.TagStat t = tags.get(i);
                    sb.append("{\"name\":").append(KbMiniJson.str(t.name))
                        .append(",\"color\":").append(KbMiniJson.str(t.color))
                        .append(",\"count\":").append(t.count).append('}');
                }
                sb.append("]}");
                return KbMiniJson.textResult(sb.toString(), false);
            }
            case "kb_folder": {
                String action = strArg(args, "action", "");
                switch (action) {
                    case "create": {
                        String path = strArg(args, "path", "");
                        String id = store.createFolderPath(path);
                        return KbMiniJson.textResult(
                            "{\"id\":" + KbMiniJson.str(id) + ",\"path\":" + KbMiniJson.str(path) + "}", false);
                    }
                    case "rename":
                        store.renameFolder(strArg(args, "path", ""), strArg(args, "newName", ""));
                        return okResult("renamed");
                    case "move":
                        store.moveFolder(strArg(args, "path", ""), optStr(args, "newPath"), optInt(args, "index"));
                        return okResult("moved");
                    case "delete": {
                        int moved = store.deleteFolder(strArg(args, "path", ""));
                        return KbMiniJson.textResult("{\"movedToRoot\":" + moved + "}", false);
                    }
                    default:
                        return errResult("unknown action: " + action + " (create|rename|move|delete)");
                }
            }
            case "kb_entry": {
                String action = strArg(args, "action", "");
                switch (action) {
                    case "move": {
                        String fp = optStr(args, "folderPath");
                        int n = store.moveEntries(strList(args, "ids"), fp == null ? "" : fp, optInt(args, "index"));
                        return countResult("moved", n);
                    }
                    case "update": {
                        String title = optStr(args, "title");
                        List<String> tags = optStrList(args, "tags");
                        String notes = optStr(args, "notes");
                        if (title == null && tags == null && notes == null) {
                            return errResult("nothing to update: provide title, tags or notes");
                        }
                        int n = store.updateEntries(strList(args, "ids"), title, tags, notes);
                        return countResult("updated", n);
                    }
                    case "delete": {
                        int n = store.removeEntries(strList(args, "ids"));
                        return countResult("removed", n);
                    }
                    default:
                        return errResult("unknown action: " + action + " (move|update|delete)");
                }
            }
            case "kb_tag": {
                String action = strArg(args, "action", "");
                switch (action) {
                    case "create": {
                        String tagName = strArg(args, "name", "");
                        String color = store.ensureTag(tagName, optStr(args, "color"));
                        return KbMiniJson.textResult(
                            "{\"name\":" + KbMiniJson.str(tagName) + ",\"color\":" + KbMiniJson.str(color) + "}", false);
                    }
                    case "rename": {
                        int n = store.renameTag(strArg(args, "name", ""), strArg(args, "newName", ""));
                        return countResult("updatedEntries", n);
                    }
                    case "delete": {
                        int n = store.deleteTag(strArg(args, "name", ""));
                        return countResult("updatedEntries", n);
                    }
                    case "color": {
                        String color = strArg(args, "color", "");
                        if (color.isEmpty()) {
                            return errResult("color is required (hex, e.g. #4A9EFF)");
                        }
                        store.setTagColor(strArg(args, "name", ""), color);
                        return okResult("color set");
                    }
                    default:
                        return errResult("unknown action: " + action + " (create|rename|delete|color)");
                }
            }
            case "kb_add": {
                Map<?, ?> added = store.addEntry(
                    strArg(args, "path", ""),
                    optStr(args, "title"),
                    optStr(args, "folderPath"),
                    optStrList(args, "tags"),
                    optStr(args, "notes")
                );
                boolean existed = Boolean.TRUE.equals(added.get("existed"));
                return KbMiniJson.textResult(
                    "{\"id\":" + KbMiniJson.str(safe((String) added.get("id")))
                        + ",\"title\":" + KbMiniJson.str(safe((String) added.get("title")))
                        + ",\"folder\":" + KbMiniJson.str(safe((String) added.get("folder")))
                        + ",\"existed\":" + existed
                        + (existed ? ",\"note\":\"entry already existed; metadata updated\"" : "")
                        + "}", false);
            }
            default:
                return KbMiniJson.textResult("{\"error\":\"unknown tool: " + KbMiniJson.escape(name) + "\"}", true);
        }
    }

    private static String okResult(String what) {
        return KbMiniJson.textResult("{\"ok\":\"" + what + "\"}", false);
    }

    private static String countResult(String key, int n) {
        return KbMiniJson.textResult("{\"" + key + "\":" + n + "}", false);
    }

    private static String errResult(String message) {
        return KbMiniJson.textResult("{\"error\":" + KbMiniJson.str(message) + "}", true);
    }

    /** ids 数组参数（过滤非字符串与空项；缺失=空表） */
    private static List<String> strList(Map<?, ?> args, String key) {
        Object v = args.get(key);
        List<String> out = new ArrayList<>();
        if (v instanceof List) {
            for (Object o : (List<?>) v) {
                if (o instanceof String && !((String) o).isEmpty()) {
                    out.add((String) o);
                }
            }
        }
        return out;
    }

    /** tags 数组参数（null=不改动；元素统一转字符串，清洗在 store 层） */
    private static List<String> optStrList(Map<?, ?> args, String key) {
        Object v = args.get(key);
        if (!(v instanceof List)) {
            return null;
        }
        List<String> out = new ArrayList<>();
        for (Object o : (List<?>) v) {
            out.add(o instanceof String ? (String) o : String.valueOf(o));
        }
        return out;
    }

    private static String rowJson(KbServerStore.Row r, boolean withSnippet) {
        StringBuilder sb = new StringBuilder("{\"id\":").append(KbMiniJson.str(safe(r.id)))
            .append(",\"title\":").append(KbMiniJson.str(safe(r.title)))
            .append(",\"folder\":").append(KbMiniJson.str(safe(r.folder)))
            .append(",\"tags\":").append(r.tagsJson == null || r.tagsJson.isEmpty() ? "[]" : r.tagsJson)
            .append(",\"project\":").append(KbMiniJson.str(safe(r.project)))
            .append(",\"status\":").append(KbMiniJson.str(safe(r.status)))
            .append(",\"sourcePath\":").append(KbMiniJson.str(safe(r.sourcePath)));
        if (withSnippet) {
            sb.append(",\"snippet\":").append(KbMiniJson.str(r.snippet));
        }
        return sb.append('}').toString();
    }

    private static String safe(String s) {
        return s == null ? "" : s;
    }

    private static String strArg(Map<?, ?> args, String key, String def) {
        Object v = args.get(key);
        return v instanceof String && !((String) v).isEmpty() ? (String) v : def;
    }

    private static String optStr(Map<?, ?> args, String key) {
        Object v = args.get(key);
        return v instanceof String ? (String) v : null;
    }

    /** 可选整数参数（null=未传；move 的 index 插位用） */
    private static Integer optInt(Map<?, ?> args, String key) {
        Object v = args.get(key);
        return v instanceof Number ? ((Number) v).intValue() : null;
    }

    private static int intArg(Map<?, ?> args, String key, int def) {
        Object v = args.get(key);
        return v instanceof Double ? (int) Math.round((Double) v) : def;
    }

    @SuppressWarnings("unchecked")
    private static Map<?, ?> asMap(Object o) {
        return o instanceof Map ? (Map<Object, Object>) o : Map.of();
    }

    private static String idJson(Object id) {
        if (id == null) {
            return "null";
        }
        if (id instanceof Double) {
            double d = (Double) id;
            return d == Math.floor(d) && !Double.isInfinite(d) ? String.valueOf((long) d) : String.valueOf(d);
        }
        return KbMiniJson.str(String.valueOf(id));
    }

    private static String errorResponse(Object id, int code, String message) {
        return "{\"jsonrpc\":\"2.0\",\"id\":" + idJson(id) + ",\"error\":{\"code\":" + code
            + ",\"message\":" + KbMiniJson.str(message) + "}}";
    }

    // ───────────────────────── 工具声明 ─────────────────────────

    private static final String[] TOOLS = {
        "{\"name\":\"kb_search\","
            + "\"description\":\"Search the user's local knowledge base (documents collected from their projects: markdown/word/pdf/html notes, design docs, deployment guides). Use it when the question may relate to the user's own documents - prior decisions, past solutions, project know-how. Search covers titles, tags and content. Returns id/title/folder/tags/snippet for each hit.\","
            + "\"inputSchema\":{\"type\":\"object\",\"properties\":{"
            + "\"query\":{\"type\":\"string\",\"description\":\"Free-text query; CJK and latin mixed supported\"},"
            + "\"folder\":{\"type\":\"string\",\"description\":\"Filter by folder path as shown in results (e.g. 'Ops/Middleware'); matches that folder and all its sub-folders; empty string = root-level entries (no folder)\"},"
            + "\"tag\":{\"type\":\"string\",\"description\":\"Filter by tag\"},"
            + "\"project\":{\"type\":\"string\",\"description\":\"Filter by source project name\"},"
            + "\"limit\":{\"type\":\"number\",\"description\":\"Max hits (default 20, max 100)\"}"
            + "},\"required\":[\"query\"]}},"

            + "{\"name\":\"kb_read\","
            + "\"description\":\"Read the full extracted text of a knowledge base entry by id (id comes from kb_search or kb_list). Always follow a search with reads of the relevant hits before answering from the knowledge base.\","
            + "\"inputSchema\":{\"type\":\"object\",\"properties\":{"
            + "\"id\":{\"type\":\"string\",\"description\":\"Entry id from kb_search/kb_list\"}"
            + "},\"required\":[\"id\"]}},"

            + "{\"name\":\"kb_list\","
            + "\"description\":\"Browse knowledge base entries (optionally filtered by folder/tag/project) without a text query - useful to see what the knowledge base contains.\","
            + "\"inputSchema\":{\"type\":\"object\",\"properties\":{"
            + "\"folder\":{\"type\":\"string\",\"description\":\"Filter by folder path (matches the folder and its sub-folders); empty string = root-level entries (no folder)\"},"
            + "\"tag\":{\"type\":\"string\"},"
            + "\"project\":{\"type\":\"string\"},"
            + "\"limit\":{\"type\":\"number\"}"
            + "}}},"

            + "{\"name\":\"kb_tree\","
            + "\"description\":\"Show the knowledge base structure: all folders (path + entry counts, subtree counts included), root-level count, total, and the tag registry (name/color/count). Start here when organizing or tidying the knowledge base, then use kb_list to inspect entries and kb_folder/kb_entry/kb_tag to reorganize.\","
            + "\"inputSchema\":{\"type\":\"object\",\"properties\":{}}},"

            + "{\"name\":\"kb_folder\","
            + "\"description\":\"Manage knowledge base folders. Folders are addressed by their full path (e.g. 'Ops/Middleware'), which must match an existing folder (check kb_tree first) unless you are creating. delete removes the folder and its sub-folders; entries inside are moved to the root level (never deleted). move rejects moving a folder into its own subtree; index reorders within the sibling layer (visible in the IDE panel).\","
            + "\"inputSchema\":{\"type\":\"object\",\"properties\":{"
            + "\"action\":{\"type\":\"string\",\"enum\":[\"create\",\"rename\",\"move\",\"delete\"],\"description\":\"create: build folder path level by level (a/b/c); rename: rename keeping position; move: re-parent (newPath empty/omitted = root level); delete: remove folder + sub-folders, entries go to root\"},"
            + "\"path\":{\"type\":\"string\",\"description\":\"Target folder full path, e.g. 'Ops/Middleware'\"},"
            + "\"newName\":{\"type\":\"string\",\"description\":\"rename: new folder name\"},"
            + "\"newPath\":{\"type\":\"string\",\"description\":\"move: new parent folder path; empty or omitted = root level\"},"
            + "\"index\":{\"type\":\"number\",\"description\":\"move: optional position among the target siblings (0 = first, as shown in the IDE tree); omitted = appended last. Use with same-path move to reorder without re-parenting\"}"
            + "},\"required\":[\"action\",\"path\"]}},"

            + "{\"name\":\"kb_entry\","
            + "\"description\":\"Manage knowledge base entries (ids from kb_search/kb_list). move: batch-move entries into a folder (folderPath empty = root level), optionally at a given position (index) within that folder's entry list - omit index to append. The IDE tree order inside each folder follows index then recency. update: batch-set tags (REPLACES the full tag set - read current tags via kb_list and merge yourself to append), set notes, or rename a single entry's title (title only allowed for one id). delete: remove entries from the knowledge base (metadata + extracted text); the source files on disk are NEVER touched. Verify ids before deleting - removal is not undoable.\","
            + "\"inputSchema\":{\"type\":\"object\",\"properties\":{"
            + "\"action\":{\"type\":\"string\",\"enum\":[\"move\",\"update\",\"delete\"]},"
            + "\"ids\":{\"type\":\"array\",\"items\":{\"type\":\"string\"},\"description\":\"Entry ids from kb_search/kb_list; order matters for move+index (ids are inserted in order)\"},"
            + "\"folderPath\":{\"type\":\"string\",\"description\":\"move: destination folder path; empty = root level\"},"
            + "\"index\":{\"type\":\"number\",\"description\":\"move: optional position in the destination folder's entry list (0 = first, as shown in the IDE tree); omitted = appended last; use with the current folder to reorder in place\"},"
            + "\"title\":{\"type\":\"string\",\"description\":\"update: new title (single id only)\"},"
            + "\"tags\":{\"type\":\"array\",\"items\":{\"type\":\"string\"},\"description\":\"update: full replacement tag set (appending requires reading current tags first)\"},"
            + "\"notes\":{\"type\":\"string\",\"description\":\"update: notes; empty string clears\"}"
            + "},\"required\":[\"action\",\"ids\"]}},"

            + "{\"name\":\"kb_tag\","
            + "\"description\":\"Manage the knowledge base tag registry. create registers a tag (auto-assigned color unless given); rename rewrites the tag on all entries carrying it; delete removes it from all entries and the registry; color changes the display color. Entry-level tagging is done via kb_entry update.\","
            + "\"inputSchema\":{\"type\":\"object\",\"properties\":{"
            + "\"action\":{\"type\":\"string\",\"enum\":[\"create\",\"rename\",\"delete\",\"color\"]},"
            + "\"name\":{\"type\":\"string\",\"description\":\"Tag name\"},"
            + "\"newName\":{\"type\":\"string\",\"description\":\"rename: new tag name\"},"
            + "\"color\":{\"type\":\"string\",\"description\":\"create/color: display color as hex (e.g. #4A9EFF)\"}"
            + "},\"required\":[\"action\",\"name\"]}},"

            + "{\"name\":\"kb_add\","
            + "\"description\":\"Collect a document into the knowledge base (pointer model: the source file stays on disk, the entry stores its path plus extracted full text). Use it when the user asks to add/collect a file into the knowledge base. Re-adding an existing source path updates its metadata instead of duplicating. Extraction supports md/text/code/html/word/excel/pdf like the IDE plugin; files without an extractable text layer are stored title-only. The source must be an absolute path to a regular file.\","
            + "\"inputSchema\":{\"type\":\"object\",\"properties\":{"
            + "\"path\":{\"type\":\"string\",\"description\":\"Absolute path of the source file to collect\"},"
            + "\"title\":{\"type\":\"string\",\"description\":\"Entry title; defaults to the file name without extension\"},"
            + "\"folderPath\":{\"type\":\"string\",\"description\":\"Destination folder path; created level by level if missing; empty or omitted = root level\"},"
            + "\"tags\":{\"type\":\"array\",\"items\":{\"type\":\"string\"},\"description\":\"Tags to attach (new names are auto-registered with a color)\"},"
            + "\"notes\":{\"type\":\"string\",\"description\":\"Free-text notes\"}"
            + "},\"required\":[\"path\"]}}"
    };
}
