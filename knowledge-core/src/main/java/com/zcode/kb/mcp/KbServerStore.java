package com.zcode.kb.mcp;

import com.zcode.kb.core.KbContent;
import com.zcode.kb.core.KbJson;
import com.zcode.kb.core.KbMetaStore;
import com.zcode.kb.text.KbTokenizer;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * MCP server 侧的查询 + 管理写（纯 Java，不得引用 Kotlin 类——fork JVM 无 kotlin-stdlib）。
 *
 * 条目、目录、标签的读写只有一份实现（{@link KbMetaStore}，IDE 侧的 KbFileStore 用的也是它）：
 * AI 经这些工具整理后落盘的文件，与在 IDE 里做同样的操作写出的逐字节相同。本类只负责工具面
 * 的东西：按路径找目录、参数校验（业务性失败抛 {@link KbOpException}）、结果行与统计。
 *
 * 读侧每请求全量扫描，千条以内毫秒级，不做缓存。检索判据（KbTokenizer 分词 + 小写包含 AND +
 * 计次打分 title 4 : tag 2 : body 1）与 IDE 侧 KbFileStore.search 同形，改任一侧必须同步另一侧。
 *
 * 文档快照、解析规则（条目现在读源文件还是读快照）、检索缓存的重建同样只有一份实现
 * （KbContent，IDE 侧同用）：收录与重指向时落文档快照并写 contentHash，摘除时清掉，
 * 状态读取时现算，不落盘。
 */
final class KbServerStore implements AutoCloseable {

    /** 管理操作的业务性失败（路径不存在/防环拒绝等）——工具层转 isError 结果，非 internal */
    static final class KbOpException extends RuntimeException {
        KbOpException(String message) {
            super(message);
        }
    }

    /** 目录统计行（kb_tree 输出源；directCount=直接挂载条目数，subtreeCount=含子孙目录） */
    static final class FolderStat {
        String id;
        String path;
        int directCount;
        int subtreeCount;
    }

    /** 标签统计行（含注册表无主标签 count=0） */
    static final class TagStat {
        String name;
        String color;
        int count;
    }

    /**
     * 检索命中行（tagsJson 是 JSON 数组文本，可直接内嵌结果；folder 是派生展示路径）。
     * status 与 contentPath 读取时现算（不读盘上的值）：status 为 ok | snapshot | missing，
     * contentPath 是现在实际该读的文件——源文件或文档快照（正斜杠），失效条目为空串。
     */
    static final class Row {
        String id;
        String title;
        String folder = "";
        String tagsJson = "[]";
        String project;
        String sourcePath;
        String status;
        String contentPath = "";
        String snippet = "";
        double score;
        long ingestedAt;
    }

    private final Path root;
    private final KbMetaStore core;

    /** root 为库根（entries/ 与 text/ 的父目录，同 KbFileStore 构造参数） */
    KbServerStore(Path root) {
        this.root = root;
        this.core = new KbMetaStore(root);
    }

    boolean available() {
        return Files.isDirectory(root.resolve("entries"));
    }

    int entryCount() {
        return core.entries().size();
    }

    /** 全文检索；rawQuery 为空或库目录缺失返回空表 */
    List<Row> search(String rawQuery, String folder, String tag, String project, int limit) {
        List<Row> out = new ArrayList<>();
        List<String> tokens = KbTokenizer.tokens(rawQuery);
        if (tokens.isEmpty() || !available()) {
            return out;
        }
        List<KbMetaStore.Entry> recs = core.entries();
        Map<String, String> paths = core.folderPaths();
        for (KbMetaStore.Entry r : recs) {
            if (!filterMatches(r, paths, folder, tag, project)) {
                continue;
            }
            String content = textOf(r);
            if (content == null) {
                content = "";
            }
            String titleLower = r.title.toLowerCase(Locale.ROOT);
            String contentLower = content.toLowerCase(Locale.ROOT);
            List<String> tagsLower = new ArrayList<>();
            for (String t : r.tags) {
                tagsLower.add(t.toLowerCase(Locale.ROOT));
            }
            boolean matched = true;
            long score = 0;
            for (String t : tokens) {
                boolean inTitle = titleLower.contains(t);
                boolean inBody = contentLower.contains(t);
                boolean inTags = false;
                for (String tagStr : tagsLower) {
                    if (tagStr.contains(t)) {
                        inTags = true;
                        break;
                    }
                }
                if (!inTitle && !inBody && !inTags) {
                    matched = false;
                    break;
                }
                long tagN = 0;
                for (String tagStr : tagsLower) {
                    tagN += countOf(tagStr, t);
                }
                score += 4L * countOf(titleLower, t) + 2L * tagN + countOf(contentLower, t);
            }
            if (matched) {
                out.add(rowOf(r, paths, score, snippetOf(tokens, content)));
            }
        }
        out.sort((a, b) -> {
            int c = Double.compare(b.score, a.score);
            return c != 0 ? c : Long.compare(b.ingestedAt, a.ingestedAt);
        });
        if (out.size() > limit) {
            out.subList(limit, out.size()).clear();
        }
        return out;
    }

    Row entry(String id) {
        if (!KbContent.isSafeId(id)) {
            return null;
        }
        KbMetaStore.Entry e = core.entry(id);
        return e == null ? null : rowOf(e, core.folderPaths(), 0, "");
    }

    /** 检索缓存在则读回，缺失按解析规则即时重建（KbContent.ensureText：源文件在从源文件建，否则从文档快照建）；失效条目返回 null */
    String readText(String id) {
        if (!KbContent.isSafeId(id)) {
            return null;
        }
        KbMetaStore.Entry e = core.entry(id);
        return e == null ? null : textOf(e);
    }

    private String textOf(KbMetaStore.Entry e) {
        try {
            return KbContent.ensureText(root, e.id, e.sourcePath, this::extractText);
        }
        catch (Exception ex) {
            return null;
        }
    }

    List<Row> list(String folder, String tag, String project, int limit) {
        List<Row> out = new ArrayList<>();
        if (!available()) {
            return out;
        }
        Map<String, String> paths = core.folderPaths();
        // 层内视觉序（KbMetaStore.list：order 升序，并列按 ingestedAt 倒序）与 IDE KbFileStore.listEntries 同源
        for (KbMetaStore.Entry r : core.list(null, Integer.MAX_VALUE)) {
            if (!filterMatches(r, paths, folder, tag, project)) {
                continue;
            }
            out.add(rowOf(r, paths, 0, ""));
            if (out.size() >= limit) {
                break;
            }
        }
        return out;
    }

    // ───────────────────────── 管理写（AI 整理：目录/条目/标签） ─────────────────────────
    // 落库规则全在 KbMetaStore；这里只做按路径定位、参数校验与业务性报错。

    /** 目录树统计：目录 path/id/直接挂载/含子树（AI 整理的全景起点）。
     *  顺序同工具窗的目录树：每层按 order 升序、并列按名字，父目录后紧跟其子目录——
     *  move 的 index 位次照的是工具窗，模型拿这份顺序才对得上 */
    List<FolderStat> folderStats() {
        List<FolderStat> ordered = new ArrayList<>();
        if (!available()) {
            return ordered;
        }
        List<KbMetaStore.Folder> folders = core.folders();
        Map<String, Integer> direct = new HashMap<>();
        for (KbMetaStore.Entry e : core.entries()) {
            if (!e.folderId.isEmpty()) {
                direct.merge(e.folderId, 1, Integer::sum);
            }
        }
        Map<String, String> paths = core.folderPaths();
        Map<String, KbMetaStore.Folder> byId = new HashMap<>();
        Map<String, List<String>> children = new HashMap<>();
        for (KbMetaStore.Folder f : folders) {
            byId.put(f.id, f);
            children.computeIfAbsent(f.parentId == null ? "" : f.parentId, k -> new ArrayList<>()).add(f.id);
        }
        for (List<String> layer : children.values()) {
            layer.sort(Comparator.comparingInt((String id) -> byId.get(id).order)
                .thenComparing(id -> byId.get(id).name));
        }
        Set<String> seen = new HashSet<>();
        appendFolderStats("", children, paths, direct, ordered, seen);
        // 父目录已不存在的断链目录工具窗里不显示，这里排在最后，不悄悄丢
        List<FolderStat> orphan = new ArrayList<>();
        for (KbMetaStore.Folder f : folders) {
            if (!seen.contains(f.id)) {
                orphan.add(folderStat(f.id, paths, direct, children));
            }
        }
        orphan.sort((a, b) -> a.path.compareTo(b.path));
        ordered.addAll(orphan);
        return ordered;
    }

    private static FolderStat folderStat(String id, Map<String, String> paths, Map<String, Integer> direct,
                                         Map<String, List<String>> children) {
        FolderStat s = new FolderStat();
        s.id = id;
        s.path = paths.getOrDefault(id, "");
        s.directCount = direct.getOrDefault(id, 0);
        s.subtreeCount = subtreeSum(id, children, direct, new HashSet<>());
        return s;
    }

    /** 深度优先：先放目录自己，再按层内序放它的子目录 */
    private static void appendFolderStats(String parentKey, Map<String, List<String>> children,
                                          Map<String, String> paths, Map<String, Integer> direct,
                                          List<FolderStat> out, Set<String> seen) {
        for (String id : children.getOrDefault(parentKey, List.of())) {
            if (seen.add(id)) {
                out.add(folderStat(id, paths, direct, children));
                appendFolderStats(id, children, paths, direct, out, seen);
            }
        }
    }

    int rootCount() {
        int n = 0;
        for (KbMetaStore.Entry e : core.entries()) {
            if (e.folderId.isEmpty()) {
                n++;
            }
        }
        return n;
    }

    /** 标签统计（注册表无主标签 count=0——先建体系后挂条目；count 降序、同数名字序） */
    List<TagStat> tagStats() {
        List<TagStat> out = new ArrayList<>();
        if (!available()) {
            return out;
        }
        Map<String, TagStat> byName = new LinkedHashMap<>();
        for (KbMetaStore.Tag t : core.tagMetas()) {
            if (!t.name.isEmpty() && !byName.containsKey(t.name)) {
                TagStat s = new TagStat();
                s.name = t.name;
                s.color = t.color;
                s.count = 0;
                byName.put(t.name, s);
            }
        }
        for (KbMetaStore.Entry e : core.entries()) {
            for (String t : e.tags) {
                TagStat s = byName.get(t);
                if (s == null) {
                    s = new TagStat();
                    s.name = t;
                    s.color = "";
                    s.count = 0;
                    byName.put(t, s);
                }
                s.count++;
            }
        }
        out.addAll(byName.values());
        out.sort((a, b) -> b.count != a.count ? Integer.compare(b.count, a.count) : a.name.compareTo(b.name));
        return out;
    }

    /** 按路径逐级建目录（`a/b/c` 缺哪级建哪级，已存在复用）。@return 末级目录 id */
    String createFolderPath(String path) {
        if (path == null || path.trim().isEmpty()) {
            throw new KbOpException("folder path is empty");
        }
        return io(() -> core.ensureFolderPath(path));
    }

    /** 目录改名（保留位置） */
    void renameFolder(String path, String newName) {
        String clean = newName == null ? "" : newName.trim();
        if (clean.isEmpty()) {
            throw new KbOpException("folder name is empty");
        }
        String id = folderIdByPath(path);
        io(() -> {
            core.renameFolder(id, clean);
            return null;
        });
    }

    /**
     * 目录移动到新父路径（null/""=根级）。防环：新父不得是自身或其子孙。index=目标层
     * 摘出前视觉位次（null=追加尾部），落位规则与 IDE 拖拽同一份实现。
     */
    void moveFolder(String path, String newParentPath, Integer index) {
        String id = folderIdByPath(path);
        String newParent = newParentPath == null || newParentPath.trim().isEmpty()
                ? null : folderIdByPath(newParentPath.trim());
        int at = index == null ? Integer.MAX_VALUE : index;
        boolean moved = io(() -> core.moveFolder(id, newParent, at));
        if (!moved) {
            throw new KbOpException("cannot move folder '" + path + "' into its own subtree");
        }
    }

    /** 删目录：子目录连带，其下条目一律退回根级（不丢数据）。@return 退根级条目数 */
    int deleteFolder(String path) {
        String id = folderIdByPath(path);
        return io(() -> core.deleteFolder(id));
    }

    /**
     * 批量移动/重排条目（folderPath 空=根级；非空路径不存在即报错——不静默容错）。
     * index=目标层摘出前视觉位次（null=追加尾部），落位规则与 IDE 拖拽同一份实现。@return 移动条目数
     */
    int moveEntries(List<String> ids, String folderPath, Integer index) {
        if (ids == null || ids.isEmpty()) {
            throw new KbOpException("ids is empty");
        }
        String target = "";
        if (folderPath != null && !folderPath.trim().isEmpty()) {
            target = folderIdByPath(folderPath.trim());
        }
        Set<String> uniq = new LinkedHashSet<>(ids);
        for (String id : uniq) {
            if (!core.hasEntry(id)) {
                throw new KbOpException("entry not found: " + id);
            }
        }
        int at = index == null ? Integer.MAX_VALUE : index;
        String targetFolder = target;
        io(() -> {
            core.reorderEntries(new ArrayList<>(uniq), targetFolder, at);
            return null;
        });
        return uniq.size();
    }

    /**
     * 批量更新条目。title/sourcePath 仅单条目（批量设同标题无意义；sourcePath=重指向，
     * 与 IDE 侧重新链接同语义：换路径即重抽取文本，id/标题/目录/标签/备注不动，传当前
     * 路径=仅刷新缓存文本）；tags=**替换**全集合（追加场景调用方先 kb_list 读现有 tags
     * 自行合并）；null 参数=不改动。@return 更新条目数
     */
    int updateEntries(List<String> ids, String title, List<String> tags, String notes, String sourcePath) {
        if (ids == null || ids.isEmpty()) {
            throw new KbOpException("ids is empty");
        }
        if (title != null && ids.size() > 1) {
            throw new KbOpException("title applies to a single entry only");
        }
        if (sourcePath != null && ids.size() > 1) {
            throw new KbOpException("sourcePath applies to a single entry only");
        }
        Set<String> uniq = new LinkedHashSet<>(ids);
        // 重指向预检（写入前全部完成）：文件存在 + 不与其他条目撞路径（判重同 addEntry 口径）
        Path relinkFile = null;
        if (sourcePath != null) {
            try {
                relinkFile = Path.of(sourcePath.trim());
            }
            catch (Exception e) {
                throw new KbOpException("invalid path: " + sourcePath);
            }
            if (!Files.isRegularFile(relinkFile)) {
                throw new KbOpException("source file not found: " + sourcePath);
            }
            String norm = KbMetaStore.normPath(relinkFile.toString());
            for (KbMetaStore.Entry other : core.entries()) {
                if (!uniq.contains(other.id) && KbMetaStore.normPath(other.sourcePath).equals(norm)) {
                    throw new KbOpException("source path already collected by entry " + other.id);
                }
            }
        }
        int n = 0;
        for (String id : uniq) {
            KbMetaStore.Edit edit = new KbMetaStore.Edit();
            edit.title = title;
            edit.tags = tags;
            edit.notes = notes;
            if (relinkFile != null) {
                edit.newFile = relinkFile;
                edit.text = orEmpty(extractText(relinkFile));
            }
            KbMetaStore.Entry updated = io(() -> core.edit(id, edit, null));
            if (updated == null) {
                throw new KbOpException("entry not found: " + id);
            }
            n++;
        }
        return n;
    }

    /** 摘除条目：删元数据 + 检索缓存 + 文档快照；磁盘源文件永不触碰（安全语义）。@return 摘除数 */
    int removeEntries(List<String> ids) {
        if (ids == null || ids.isEmpty()) {
            throw new KbOpException("ids is empty");
        }
        int n = 0;
        for (String id : new LinkedHashSet<>(ids)) {
            if (!KbContent.isSafeId(id)) {
                throw new KbOpException("entry not found: " + id);
            }
            try {
                core.removeEntry(id);
                n++;
            }
            catch (IOException e) {
                throw new KbOpException("remove failed: " + id + " (" + errMsg(e) + ")");
            }
        }
        return n;
    }

    /** 注册标签（已存在仅返回原色；未指定颜色走 8 色板空闲优先）。@return 标签颜色 */
    String ensureTag(String name, String colorOrNull) {
        String clean = KbMetaStore.sanitizeTag(name);
        if (clean.isEmpty()) {
            throw new KbOpException("tag name is empty");
        }
        List<KbMetaStore.Tag> metas = core.tagMetas();
        for (KbMetaStore.Tag t : metas) {
            if (clean.equals(t.name)) {
                return t.color;
            }
        }
        String color = colorOrNull != null && !colorOrNull.trim().isEmpty()
                ? colorOrNull.trim() : KbMetaStore.pickTagColor(metas);
        io(() -> core.ensureTagMeta(clean, color));
        return color;
    }

    /** 全局重命名标签（改写全部含该标签条目 + 注册表）。@return 改写条目数 */
    int renameTag(String from, String to) {
        String clean = KbMetaStore.sanitizeTag(to);
        if (from == null || from.isEmpty() || clean.isEmpty()) {
            throw new KbOpException("tag name is empty");
        }
        return io(() -> core.renameTag(from, clean));
    }

    /** 从全部条目移除标签 + 注册表删除。@return 影响条目数 */
    int deleteTag(String name) {
        if (name == null || name.isEmpty()) {
            throw new KbOpException("tag name is empty");
        }
        return io(() -> core.deleteTag(name));
    }

    /** 改标签颜色。标签得存在（在注册表里，或挂在条目上）：名字打错就报错，不替调用方建出一个空标签。
     *  共享实现那层是「没注册过就注册」，那是 IDE 标签弹窗的需要——只挂在条目上的标签也从改色补进注册表 */
    void setTagColor(String name, String color) {
        if (name == null || name.isEmpty()) {
            throw new KbOpException("tag name is empty");
        }
        if (!core.tagCounts().containsKey(name)) {
            throw new KbOpException("tag not found: " + name);
        }
        io(() -> {
            core.setTagColor(name, color);
            return null;
        });
    }

    /**
     * 收录（kb_add），落库规则与 IDE 收录是同一份实现（KbMetaStore.ingest）：sourcePath 归一判重，
     * 命中=更新元数据（传了才覆盖）并重新确认内容；新收录建目录（folderPath 逐级确保）+ 提取正文
     * + 全字段落库。提取优先 IDE 同款 KbExtractor（反射调用——fork classpath 含
     * kotlin-stdlib/jsoup/pdfbox，反射免编译期耦合；加载失败降级纯文本直读）。
     *
     * @return id / title / folderId / folder（展示路径）/ existed
     */
    Map<String, Object> addEntry(String path, String title, String folderPath, List<String> tags, String notes) {
        Path f;
        try {
            f = Path.of(path == null ? "" : path.trim());
        }
        catch (Exception e) {
            throw new KbOpException("invalid path: " + path);
        }
        if (!Files.isRegularFile(f)) {
            throw new KbOpException("source file not found: " + path);
        }
        String folderId = folderPath != null && !folderPath.trim().isEmpty()
                ? createFolderPath(folderPath.trim()) : null;
        KbMetaStore.Ingested r = io(() -> core.ingest(f, title, folderId, tags, notes, this::extractText, "git", null));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", r.entry.id);
        out.put("title", r.entry.title);
        out.put("folderId", r.entry.folderId);
        out.put("folder", r.entry.folderId.isEmpty() ? "" : io(() -> core.folderPath(r.entry.folderId)));
        out.put("existed", r.existed);
        return out;
    }

    // ───────────────────────── 内部 ─────────────────────────

    /** 一次写盘调用；IO 失败转成业务性报错 */
    private interface Io<T> {
        T run() throws IOException;
    }

    private static <T> T io(Io<T> call) {
        try {
            return call.run();
        }
        catch (IOException e) {
            throw new KbOpException("write failed: " + errMsg(e));
        }
    }

    /** 全路径 → 目录 id（逐段精确匹配 name；任一段不存在抛 KbOpException） */
    private String folderIdByPath(String path) {
        List<KbMetaStore.Folder> folders = core.folders();
        String cur = null;
        for (String segRaw : path.split("/")) {
            String seg = segRaw.trim();
            if (seg.isEmpty()) {
                continue;
            }
            String found = null;
            for (KbMetaStore.Folder f : folders) {
                if (seg.equals(f.name) && Objects.equals(f.parentId, cur)) {
                    found = f.id;
                    break;
                }
            }
            if (found == null) {
                throw new KbOpException("folder not found: " + path);
            }
            cur = found;
        }
        if (cur == null) {
            throw new KbOpException("folder path is empty");
        }
        return cur;
    }

    /** 子树直接挂载计数之和（防环 seen） */
    private static int subtreeSum(String id, Map<String, List<String>> children, Map<String, Integer> direct,
                                  Set<String> seen) {
        if (!seen.add(id)) {
            return 0;
        }
        int sum = direct.getOrDefault(id, 0);
        for (String c : children.getOrDefault(id, List.of())) {
            sum += subtreeSum(c, children, direct, seen);
        }
        return sum;
    }

    /**
     * 正文提取：反射调 IDE 同款 KbExtractor.extract（知识库全类型提取路径都在其上；
     * fork classpath=插件 lib\* 含 kotlin-stdlib/jsoup/pdfbox）。反射失败/类缺失/提取
     * 异常 → 降级纯文本直读（BOM + UTF-8 严格试解 + GBK 兜底，与 KbExtractor.decodeText
     * 同形）；返回 null → 空串（仅标题检索，text 缓存写空文件与 IDE 同款）。
     */
    private String extractText(Path f) {
        try {
            Class<?> kx = Class.forName("com.zcode.kb.core.KbExtractor");
            Object inst = kx.getField("INSTANCE").get(null);
            Object r = kx.getMethod("extract", Path.class).invoke(inst, f);
            if (r instanceof String) {
                return (String) r;
            }
        }
        catch (Throwable ignore) {
            // 反射路径不可用（stdlib 缺失等）→ 降级直读
        }
        try {
            if (Files.size(f) > 50L * 1024 * 1024) {
                return "";
            }
            byte[] bytes = Files.readAllBytes(f);
            if (bytes.length >= 3 && bytes[0] == -17 && bytes[1] == -69 && bytes[2] == -65) {
                return new String(bytes, 3, bytes.length - 3, java.nio.charset.StandardCharsets.UTF_8);
            }
            if (bytes.length >= 2 && bytes[0] == -1 && bytes[1] == -2) {
                return new String(bytes, 2, bytes.length - 2, java.nio.charset.StandardCharsets.UTF_16LE);
            }
            if (bytes.length >= 2 && bytes[0] == -2 && bytes[1] == -1) {
                return new String(bytes, 2, bytes.length - 2, java.nio.charset.StandardCharsets.UTF_16BE);
            }
            try {
                java.nio.charset.StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                    .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
                    .decode(java.nio.ByteBuffer.wrap(bytes));
                return new String(bytes, java.nio.charset.StandardCharsets.UTF_8);
            }
            catch (java.nio.charset.CharacterCodingException e) {
                return new String(bytes, charsetGbk());
            }
        }
        catch (Exception e) {
            return "";
        }
    }

    private static java.nio.charset.Charset charsetGbk() {
        try {
            return java.nio.charset.Charset.forName("GBK");
        }
        catch (Exception e) {
            return java.nio.charset.StandardCharsets.UTF_8;
        }
    }

    /**
     * 过滤语义：null=不过滤；folder 空串=根级；非空=精确路径或其子树前缀
     * （`信创适配` 命中 `信创适配/中间件`）。folder 维度 MCP 面用展示路径。
     */
    private static boolean filterMatches(KbMetaStore.Entry r, Map<String, String> paths, String folder, String tag,
                                         String project) {
        if (folder != null) {
            String path = paths.getOrDefault(r.folderId, "");
            boolean hit = folder.isEmpty() ? path.isEmpty()
                    : path.equals(folder) || path.startsWith(folder + "/");
            if (!hit) {
                return false;
            }
        }
        if (tag != null && !tag.isEmpty() && !r.tags.contains(tag)) {
            return false;
        }
        return project == null || project.isEmpty() || r.project.equals(project);
    }

    private Row rowOf(KbMetaStore.Entry r, Map<String, String> paths, double score, String snippet) {
        Row row = new Row();
        row.id = r.id;
        row.title = r.title;
        row.folder = paths.getOrDefault(r.folderId, "");
        row.tagsJson = KbJson.stringify(r.tags);
        row.project = r.project;
        row.sourcePath = r.sourcePath;
        // 状态与「现在该读哪个文件」读取时现算（KbContent.resolve，与 IDE 侧同一规则），不读盘上的值
        KbContent.Resolved resolved = KbContent.resolve(root, r.id, r.sourcePath);
        row.status = KbContent.statusCode(resolved.state);
        row.contentPath = resolved.path == null ? "" : KbMetaStore.displayPath(resolved.path.toString());
        row.score = score;
        row.snippet = snippet == null ? "" : snippet;
        row.ingestedAt = r.ingestedAt;
        return row;
    }

    private static String orEmpty(String s) {
        return s == null ? "" : s;
    }

    private static String errMsg(Exception e) {
        return e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
    }

    private static int countOf(String haystack, String needle) {
        if (needle.isEmpty()) {
            return 0;
        }
        int idx = 0, n = 0;
        while (true) {
            idx = haystack.indexOf(needle, idx);
            if (idx < 0) {
                break;
            }
            n++;
            idx += needle.length();
        }
        return n;
    }

    private static String snippetOf(List<String> tokens, String content) {
        String lower = content.toLowerCase(Locale.ROOT);
        int at = -1;
        for (String t : tokens) {
            at = lower.indexOf(t);
            if (at >= 0) {
                break;
            }
        }
        if (at < 0) {
            return content.length() > 80 ? content.substring(0, 80) : content;
        }
        int start = Math.max(0, at - 40);
        int end = Math.min(content.length(), at + 80);
        return (start > 0 ? "…" : "") + content.substring(start, end) + (end < content.length() ? "…" : "");
    }

    @Override
    public void close() {
        // 无持久连接，形面保留（KbMcpServerMain 退出路径调用）
    }
}
