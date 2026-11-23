package com.zcode.kb.mcp;

import com.zcode.kb.core.KbContent;
import com.zcode.kb.text.KbTokenizer;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * MCP server 侧查询 + 管理写（纯 Java，不得引用 Kotlin 类——fork JVM 无 kotlin-stdlib）。
 *
 * 与 IDE 侧 KbFileStore（Kotlin）共享同一文件布局（root/entries/&lt;id&gt;.json 元数据 +
 * text/&lt;id&gt;.txt 检索缓存 + snapshots/&lt;id&gt;/ 文档快照 +
 * root/config.json 目录树/标签注册表）：
 * 写侧（IDE 与本 server）一律临时文件 + ATOMIC_MOVE（读侧无撕裂，跨进程最坏丢一次
 * 更新、结构不撕裂）；读侧每请求全量扫描，千条以内毫秒级，不做缓存。
 * ⚠️ 检索判据与 KbFileStore.search 保持同形（KbTokenizer 分词 + 小写包含 AND + 计次
 * 打分 title 4 : tag 2 : body 1 + 首命中点摘要），改任一侧必须同步另一侧。
 * ⚠️ 管理写语义（目录防环/删目录条目退根级/标签清洗/自动配色）与 KbFileStore 同形，
 * 两套实现，改任一侧必须对照另一侧。
 *
 * 文档快照、解析规则（条目现在读源文件还是读快照）、检索缓存的重建只有一份实现
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

    /** 条目元数据的内存投影（entry json 字段子集） */
    private static final class Rec {
        String id;
        String title = "";
        String folderId = "";
        String tagsJson = "[]";
        String project = "";
        String sourcePath = "";
        long ingestedAt;
        int order;
    }

    /** config.json 目录投影：id → name/parentId */
    private static final class Folder {
        String id = "";
        String name = "";
        String parentId = "";
    }

    private final Path root;

    /** root 为库根（entries/ 与 text/ 的父目录，同 KbFileStore 构造参数） */
    KbServerStore(Path root) {
        this.root = root;
    }

    boolean available() {
        return Files.isDirectory(root.resolve("entries"));
    }

    int entryCount() {
        return loadEntries().size();
    }

    /** 全文检索；rawQuery 为空或库目录缺失返回空表 */
    List<Row> search(String rawQuery, String folder, String tag, String project, int limit) {
        List<Row> out = new ArrayList<>();
        List<String> tokens = KbTokenizer.tokens(rawQuery);
        if (tokens.isEmpty() || !available()) {
            return out;
        }
        List<Rec> recs = loadEntries();
        Map<String, Folder> folders = loadFolders();
        for (Rec r : recs) {
            if (!filterMatches(r, folders, folder, tag, project)) {
                continue;
            }
            String content = textOf(r);
            if (content == null) {
                content = "";
            }
            String titleLower = r.title.toLowerCase(Locale.ROOT);
            String contentLower = content.toLowerCase(Locale.ROOT);
            List<String> tagsLower = tagsOf(r.tagsJson);
            for (int i = 0; i < tagsLower.size(); i++) {
                tagsLower.set(i, tagsLower.get(i).toLowerCase(Locale.ROOT));
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
                out.add(rowOf(r, folders, score, snippetOf(tokens, content)));
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
        if (!isSafeId(id)) {
            return null;
        }
        Rec r = parseEntry(root.resolve("entries").resolve(id + ".json"));
        return r == null ? null : rowOf(r, loadFolders(), 0, "");
    }

    /** 检索缓存在则读回，缺失按解析规则即时重建（KbContent.ensureText：源文件在从源文件建，否则从文档快照建）；失效条目返回 null */
    String readText(String id) {
        if (!isSafeId(id)) {
            return null;
        }
        Rec r = parseEntry(root.resolve("entries").resolve(id + ".json"));
        return r == null ? null : textOf(r);
    }

    private String textOf(Rec r) {
        try {
            return KbContent.ensureText(root, r.id, r.sourcePath, this::extractText);
        } catch (Exception e) {
            return null;
        }
    }

    List<Row> list(String folder, String tag, String project, int limit) {
        List<Row> out = new ArrayList<>();
        if (!available()) {
            return out;
        }
        List<Rec> recs = loadEntries();
        Map<String, Folder> folders = loadFolders();
        // 层内视觉序与 IDE KbFileStore.listEntries 同形：order 升序，并列（0=未拖过）按 ingestedAt 倒序
        recs.sort((a, b) -> {
            int c = Integer.compare(a.order, b.order);
            return c != 0 ? c : Long.compare(b.ingestedAt, a.ingestedAt);
        });
        for (Rec r : recs) {
            if (!filterMatches(r, folders, folder, tag, project)) {
                continue;
            }
            out.add(rowOf(r, folders, 0, ""));
            if (out.size() >= limit) {
                break;
            }
        }
        return out;
    }

    // ───────────────────────── 管理写（AI 整理：目录/条目/标签） ─────────────────────────
    // 全部与 IDE 侧 KbFileStore 同形（防环/删目录条目退根级/标签清洗/自动配色），写=临时文件+ATOMIC_MOVE。

    /** 目录树统计：目录 path/id/直接挂载/含子树 + 根级与全库计数（AI 整理的全景起点） */
    List<FolderStat> folderStats() {
        List<FolderStat> out = new ArrayList<>();
        if (!available()) {
            return out;
        }
        Map<String, Folder> folders = loadFolders();
        Map<String, Integer> direct = new java.util.HashMap<>();
        for (Rec r : loadEntries()) {
            String fid = r.folderId == null ? "" : r.folderId;
            if (!fid.isEmpty()) {
                direct.merge(fid, 1, Integer::sum);
            }
        }
        for (Map.Entry<String, Folder> en : folders.entrySet()) {
            FolderStat s = new FolderStat();
            s.id = en.getKey();
            s.path = folderPathOf(folders, en.getKey());
            s.directCount = direct.getOrDefault(en.getKey(), 0);
            out.add(s);
        }
        Map<String, List<String>> children = new java.util.HashMap<>();
        for (Map.Entry<String, Folder> en : folders.entrySet()) {
            String p = en.getValue().parentId == null ? "" : en.getValue().parentId;
            children.computeIfAbsent(p, k -> new ArrayList<>()).add(en.getKey());
        }
        for (FolderStat s : out) {
            s.subtreeCount = subtreeSum(s.id, children, direct, new java.util.HashSet<>());
        }
        out.sort((a, b) -> a.path.compareTo(b.path));
        return out;
    }

    int rootCount() {
        int n = 0;
        for (Rec r : loadEntries()) {
            if (r.folderId == null || r.folderId.isEmpty()) {
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
        Map<String, TagStat> byName = new java.util.LinkedHashMap<>();
        for (Map<String, Object> t : tagMetasOf(configMap())) {
            TagStat s = new TagStat();
            s.name = orEmpty(str(t.get("name")));
            s.color = orEmpty(str(t.get("color")));
            s.count = 0;
            if (!s.name.isEmpty() && !byName.containsKey(s.name)) {
                byName.put(s.name, s);
            }
        }
        for (Rec r : loadEntries()) {
            for (String t : tagsOf(r.tagsJson)) {
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
        Map<String, Object> cfg = configMap();
        List<Map<String, Object>> folders = new ArrayList<>(foldersOf(cfg));
        String parentId = null;
        for (String segRaw : path.split("/")) {
            String seg = segRaw.trim();
            if (seg.isEmpty()) {
                continue;
            }
            String existing = null;
            int maxOrder = -1;
            for (Map<String, Object> f : folders) {
                if (!eqParent(f.get("parentId"), parentId)) {
                    continue;
                }
                Object o = f.get("order");
                int ord = o instanceof Number ? ((Number) o).intValue() : 0;
                if (ord > maxOrder) {
                    maxOrder = ord;
                }
                if (seg.equals(orEmpty(str(f.get("name"))))) {
                    existing = str(f.get("id"));
                }
            }
            if (existing == null) {
                Map<String, Object> nf = new java.util.LinkedHashMap<>();
                nf.put("id", newFolderId());
                nf.put("name", seg);
                nf.put("parentId", parentId);
                nf.put("order", maxOrder + 1);
                folders.add(nf);
                existing = str(nf.get("id"));
            }
            parentId = existing;
        }
        if (parentId == null) {
            throw new KbOpException("folder path is empty");
        }
        cfg.put("folders", folders);
        writeConfigMap(cfg);
        return parentId;
    }

    /** 目录改名（保留位置） */
    void renameFolder(String path, String newName) {
        String clean = newName == null ? "" : newName.trim();
        if (clean.isEmpty()) {
            throw new KbOpException("folder name is empty");
        }
        Map<String, Object> cfg = configMap();
        String id = folderIdByPath(cfg, path);
        for (Map<String, Object> f : foldersOf(cfg)) {
            if (id.equals(str(f.get("id")))) {
                f.put("name", clean);
                break;
            }
        }
        writeConfigMap(cfg);
    }

    /**
     * 目录移动到新父路径（null/""=根级）。防环：新父不得是自身或其子孙。index=目标层
     * 摘出前视觉位次（同层自拖偏移内部校正，null=追加尾部），目标层 order 全量重写，
     * 与 IDE 侧 KbFileStore.moveFolder 同形。
     */
    void moveFolder(String path, String newParentPath, Integer index) {
        Map<String, Object> cfg = configMap();
        List<Map<String, Object>> folders = foldersOf(cfg);
        String id = folderIdByPath(cfg, path);
        String newParent = "";
        if (newParentPath != null && !newParentPath.trim().isEmpty()) {
            newParent = folderIdByPath(cfg, newParentPath.trim());
        }
        if (isDescendant(folders, id, newParent)) {
            throw new KbOpException("cannot move folder '" + path + "' into its own subtree");
        }
        Map<String, Object> moving = null;
        List<int[]> no = new ArrayList<>(); // 目标层 [mapIndex, order]（摘出前）
        for (int i = 0; i < folders.size(); i++) {
            Map<String, Object> f = folders.get(i);
            String fid = str(f.get("id"));
            if (fid != null && fid.equals(id)) {
                moving = f;
            } else if (eqParent(f.get("parentId"), newParent.isEmpty() ? null : newParent)) {
                Object o = f.get("order");
                int ord = o instanceof Number ? ((Number) o).intValue() : 0;
                no.add(new int[]{i, ord});
            }
        }
        if (moving == null) {
            throw new KbOpException("folder not found: " + path);
        }
        no.sort((a, b) -> a[1] != b[1] ? Integer.compare(a[1], b[1]) : Integer.compare(a[0], b[0]));
        int at = index == null ? no.size() : Math.min(index, no.size());
        // 同层自拖：插入点之前每有一个被拖目录本体，摘出后位次 -1（跨层拖入 dropK=0）
        int dropK = 0;
        for (int[] slot : no.subList(0, at)) {
            if (id.equals(str(folders.get(slot[0]).get("id")))) {
                dropK++;
            }
        }
        int corrected = at - dropK;
        moving.put("parentId", newParent.isEmpty() ? null : newParent);
        // 目标层 order 全量重写 0..n-1（插位之后的兄弟 +1 平移）
        for (int i = 0; i < no.size(); i++) {
            int[] slot = no.get(i);
            folders.get(slot[0]).put("order", i < corrected ? i : i + 1);
        }
        moving.put("order", corrected);
        writeConfigMap(cfg);
    }

    /** 删目录：子目录连带，其下条目一律退回根级（不丢数据）。@return 退根级条目数 */
    int deleteFolder(String path) {
        Map<String, Object> cfg = configMap();
        List<Map<String, Object>> folders = foldersOf(cfg);
        String id = folderIdByPath(cfg, path);
        java.util.Set<String> doomed = collectSubtree(folders, id);
        int moved = 0;
        for (String entryId : entryIds()) {
            Map<String, Object> e = readEntryMap(entryId);
            if (e == null) {
                continue;
            }
            String fid = orEmpty(str(e.get("folderId")));
            if (doomed.contains(fid)) {
                e.put("folderId", "");
                e.put("updatedAt", (double) System.currentTimeMillis());
                writeEntryMap(e);
                moved++;
            }
        }
        List<Map<String, Object>> kept = new ArrayList<>();
        for (Map<String, Object> f : folders) {
            String fid = str(f.get("id"));
            if (fid == null || !doomed.contains(fid)) {
                kept.add(f);
            }
        }
        cfg.put("folders", kept);
        writeConfigMap(cfg);
        return moved;
    }

    /**
     * 批量移动/重排条目（folderPath 空=根级；非空路径不存在即报错——不静默容错）。
     * index=目标层摘出前视觉位次（null=追加尾部），与 IDE 侧 reorderEntries 同形：
     * 被移动条目 folderId 落目标层且目标层 order 全量重写 0..n-1（folderId 变才刷
     * updatedAt），跨层拖入时各原层剩余条目 order 重写收拢空洞。@return 移动条目数
     */
    int moveEntries(List<String> ids, String folderPath, Integer index) {
        if (ids == null || ids.isEmpty()) {
            throw new KbOpException("ids is empty");
        }
        Map<String, Object> cfg = configMap();
        String target = "";
        if (folderPath != null && !folderPath.trim().isEmpty()) {
            target = folderIdByPath(cfg, folderPath.trim());
        }
        java.util.LinkedHashSet<String> uniq = new java.util.LinkedHashSet<>(ids);
        // 读全部被移动条目（缺失即报错，语义同旧实现）
        java.util.LinkedHashMap<String, Map<String, Object>> moving = new java.util.LinkedHashMap<>();
        for (String id : uniq) {
            Map<String, Object> e = readEntryMap(id);
            if (e == null) {
                throw new KbOpException("entry not found: " + id);
            }
            moving.put(id, e);
        }
        // 目标层现状（摘出前，按层内视觉序 = order 升序、并列 ingestedAt 倒序）：摘出被移动项 → 插位
        List<Rec> targetRecs = new ArrayList<>();
        for (Rec r : loadEntries()) {
            if (orEmpty(str(r.folderId)).equals(target)) {
                targetRecs.add(r);
            }
        }
        targetRecs.sort((a, b) -> {
            int c = Integer.compare(a.order, b.order);
            return c != 0 ? c : Long.compare(b.ingestedAt, a.ingestedAt);
        });
        List<String> layer = new ArrayList<>();
        for (Rec r : targetRecs) {
            layer.add(r.id);
        }
        int at = index == null ? layer.size() : Math.min(index, layer.size());
        List<String> rebuilt = new ArrayList<>(layer);
        List<String> headDrop = new ArrayList<>();
        for (String id : uniq) {
            int i = rebuilt.indexOf(id);
            if (i >= 0) {
                rebuilt.remove(i);
                if (i < at) {
                    headDrop.add(id);
                }
            }
        }
        int insertAt = at - headDrop.size();
        insertAt = Math.max(0, Math.min(insertAt, rebuilt.size()));
        int k = 0;
        for (String id : uniq) {
            rebuilt.add(insertAt + k, id);
            k++;
        }
        // 全量重写目标层 order（folderId 变才刷 updatedAt）
        for (int i = 0; i < rebuilt.size(); i++) {
            String id = rebuilt.get(i);
            Map<String, Object> e = moving.containsKey(id) ? moving.get(id) : readEntryMap(id);
            if (e == null) {
                continue;
            }
            Object orderObj = e.get("order");
            int oldOrder = orderObj instanceof Number ? ((Number) orderObj).intValue() : 0;
            boolean movedCross = !orEmpty(str(e.get("folderId"))).equals(target);
            if (movedCross) {
                e.put("folderId", target);
                e.put("updatedAt", (double) System.currentTimeMillis());
            }
            if (oldOrder != i || movedCross) {
                e.put("order", (double) i);
                writeEntryMap(e);
            }
        }
        // 跨层拖入：各原层剩余条目 order 重写收拢空洞
        java.util.Set<String> origins = new java.util.LinkedHashSet<>();
        for (Map<String, Object> e : moving.values()) {
            String of = orEmpty(str(e.get("folderId")));
            if (!of.equals(target)) {
                origins.add(of);
            }
        }
        for (String origin : origins) {
            // 剩余条目按现视觉序排好后赋 order 0..n-1（乱序赋值会打乱相对顺序）
            List<Rec> restRecs = new ArrayList<>();
            for (Rec r : loadEntries()) {
                if (orEmpty(str(r.folderId)).equals(origin) && !uniq.contains(r.id)) {
                    restRecs.add(r);
                }
            }
            restRecs.sort((a, b) -> {
                int c = Integer.compare(a.order, b.order);
                return c != 0 ? c : Long.compare(b.ingestedAt, a.ingestedAt);
            });
            for (int i = 0; i < restRecs.size(); i++) {
                Map<String, Object> e = readEntryMap(restRecs.get(i).id);
                if (e == null) {
                    continue;
                }
                if (restRecs.get(i).order != i) {
                    e.put("order", (double) i);
                    writeEntryMap(e);
                }
            }
        }
        return uniq.size();
    }

    /**
     * 批量更新条目。title/sourcePath 仅单条目（批量设同标题无意义；sourcePath=重指向，
     * 与 IDE 侧 relink 同语义：换路径即重抽取文本，id/标题/目录/标签/备注不动，传当前
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
        // 重指向预检（写入前全部完成）：文件存在 + 不与其他条目撞路径（判重同 addEntry 口径）
        Path relinkFile = null;
        if (sourcePath != null) {
            try {
                relinkFile = Path.of(sourcePath.trim());
            } catch (Exception e) {
                throw new KbOpException("invalid path: " + sourcePath);
            }
            if (!Files.isRegularFile(relinkFile)) {
                throw new KbOpException("source file not found: " + sourcePath);
            }
            String norm = normPath(relinkFile.toString().replace('\\', '/').trim());
            for (String otherId : entryIds()) {
                if (new java.util.LinkedHashSet<>(ids).contains(otherId)) {
                    continue;
                }
                Map<String, Object> oe = readEntryMap(otherId);
                if (oe != null && normPath(orEmpty(str(oe.get("sourcePath")))).equals(norm)) {
                    throw new KbOpException("source path already collected by entry " + otherId);
                }
            }
        }
        int n = 0;
        for (String id : new java.util.LinkedHashSet<>(ids)) {
            Map<String, Object> e = readEntryMap(id);
            if (e == null) {
                throw new KbOpException("entry not found: " + id);
            }
            if (title != null) {
                e.put("title", title.trim());
            }
            if (tags != null) {
                List<Object> clean = new ArrayList<>();
                for (String t : tags) {
                    String c = sanitizeTag(t);
                    if (!c.isEmpty()) {
                        clean.add(c);
                    }
                }
                e.put("tags", clean);
            }
            if (notes != null) {
                e.put("notes", notes);
            }
            if (relinkFile != null) {
                // relink 同形（IDE KbManagerService.relink）：换源后重新落文档快照（随之改名）
                // 与内容哈希，文本重抽取；id/标题/目录/标签/备注不动
                String display = displayPath(relinkFile);
                KbContent.Captured captured = captureQuietly(id, relinkFile);
                e.put("sourcePath", display);
                e.put("sizeBytes", (double) (captured == null ? fileSize(relinkFile) : captured.size));
                e.put("contentHash", captured == null ? "" : captured.hash);
                e.put("fileExt", fileExt(relinkFile));
                atomicWrite(textDir().resolve(id + ".txt"), orEmpty(extractText(relinkFile)));
            }
            e.put("updatedAt", (double) System.currentTimeMillis());
            writeEntryMap(e);
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
        for (String id : new java.util.LinkedHashSet<>(ids)) {
            if (!isSafeId(id)) {
                throw new KbOpException("entry not found: " + id);
            }
            try {
                Files.deleteIfExists(root.resolve("entries").resolve(id + ".json"));
                Files.deleteIfExists(textDir().resolve(id + ".txt"));
                KbContent.deleteSnapshot(root, id);
                n++;
            } catch (Exception e) {
                throw new KbOpException("remove failed: " + id + " (" + errMsg(e) + ")");
            }
        }
        return n;
    }

    /** 注册标签（已存在仅返回原色；未指定颜色走 8 色板空闲优先）。@return 标签颜色 */
    String ensureTag(String name, String colorOrNull) {
        String clean = sanitizeTag(name);
        if (clean.isEmpty()) {
            throw new KbOpException("tag name is empty");
        }
        Map<String, Object> cfg = configMap();
        List<Map<String, Object>> tags = new ArrayList<>(tagMetasOf(cfg));
        for (Map<String, Object> t : tags) {
            if (clean.equals(str(t.get("name")))) {
                return orEmpty(str(t.get("color")));
            }
        }
        String color = colorOrNull != null && !colorOrNull.trim().isEmpty()
                ? colorOrNull.trim() : pickTagColor(tags);
        Map<String, Object> nt = new java.util.LinkedHashMap<>();
        nt.put("name", clean);
        nt.put("color", color);
        tags.add(nt);
        cfg.put("tags", tags);
        writeConfigMap(cfg);
        return color;
    }

    /** 全局重命名标签（改写全部含该标签条目 + 注册表；与 KbFileStore 同形：注册表可能产生重名，条目侧 distinct）。@return 改写条目数 */
    int renameTag(String from, String to) {
        String clean = sanitizeTag(to);
        if (from == null || from.isEmpty() || clean.isEmpty()) {
            throw new KbOpException("tag name is empty");
        }
        int n = 0;
        for (String entryId : entryIds()) {
            Map<String, Object> e = readEntryMap(entryId);
            if (e == null) {
                continue;
            }
            List<Object> tags = tagsListOf(e);
            if (!tags.contains(from)) {
                continue;
            }
            java.util.LinkedHashSet<Object> dedup = new java.util.LinkedHashSet<>();
            for (Object t : tags) {
                dedup.add(from.equals(t) ? clean : t);
            }
            e.put("tags", new ArrayList<>(dedup));
            e.put("updatedAt", (double) System.currentTimeMillis());
            writeEntryMap(e);
            n++;
        }
        Map<String, Object> cfg = configMap();
        List<Map<String, Object>> renamed = new ArrayList<>();
        for (Map<String, Object> t : tagMetasOf(cfg)) {
            if (from.equals(str(t.get("name")))) {
                Map<String, Object> nt = new java.util.LinkedHashMap<>(t);
                nt.put("name", clean);
                renamed.add(nt);
            } else {
                renamed.add(t);
            }
        }
        cfg.put("tags", renamed);
        writeConfigMap(cfg);
        return n;
    }

    /** 从全部条目移除标签 + 注册表删除。@return 影响条目数 */
    int deleteTag(String name) {
        if (name == null || name.isEmpty()) {
            throw new KbOpException("tag name is empty");
        }
        int n = 0;
        for (String entryId : entryIds()) {
            Map<String, Object> e = readEntryMap(entryId);
            if (e == null) {
                continue;
            }
            List<Object> tags = tagsListOf(e);
            if (!tags.contains(name)) {
                continue;
            }
            List<Object> kept = new ArrayList<>();
            for (Object t : tags) {
                if (!name.equals(t)) {
                    kept.add(t);
                }
            }
            e.put("tags", kept);
            e.put("updatedAt", (double) System.currentTimeMillis());
            writeEntryMap(e);
            n++;
        }
        Map<String, Object> cfg = configMap();
        List<Map<String, Object>> tags = tagMetasOf(cfg);
        List<Map<String, Object>> kept = new ArrayList<>();
        boolean changed = false;
        for (Map<String, Object> t : tags) {
            if (name.equals(str(t.get("name")))) {
                changed = true;
            } else {
                kept.add(t);
            }
        }
        if (changed) {
            cfg.put("tags", kept);
            writeConfigMap(cfg);
        }
        return n;
    }

    void setTagColor(String name, String color) {
        Map<String, Object> cfg = configMap();
        List<Map<String, Object>> tags = new ArrayList<>(tagMetasOf(cfg));
        for (Map<String, Object> t : tags) {
            if (name != null && name.equals(str(t.get("name")))) {
                t.put("color", color);
                cfg.put("tags", tags);
                writeConfigMap(cfg);
                return;
            }
        }
        if (name != null && !name.isEmpty()) {
            Map<String, Object> nt = new java.util.LinkedHashMap<>();
            nt.put("name", name);
            nt.put("color", color);
            tags.add(nt);
            cfg.put("tags", tags);
            writeConfigMap(cfg);
        }
    }

    /**
     * 收录（kb_add）：IDE 侧 ingest 同语义——sourcePath 归一判重，命中=更新元数据（传了才
     * 覆盖）并重新确认内容；新收录走 ensureFolderPath 语义建目录 + 提取正文 + 全字段落库
     * （fileExt 带点、project=源文件所在 git 仓根名或父目录名）。收录即落文档快照
     * （KbContent.capture：源文件原始字节 + 内容哈希 + 本机缓存），快照写不成不拦收录，
     * IDE 侧对账会补齐。提取优先 IDE 同款 KbExtractor（反射调用——fork classpath 含
     * kotlin-stdlib/jsoup/pdfbox，反射免编译期耦合；加载失败降级纯文本直读），返回 null
     * （doc 等）→ 空文本缓存=仅标题检索。状态不落盘（读取时现算）。
     */
    java.util.Map<String, Object> addEntry(String path, String title, String folderPath, java.util.List<String> tags, String notes) {
        Path f;
        try {
            f = Path.of(path == null ? "" : path.trim());
        } catch (Exception e) {
            throw new KbOpException("invalid path: " + path);
        }
        if (!Files.isRegularFile(f)) {
            throw new KbOpException("source file not found: " + path);
        }
        String display = f.toString().replace('\\', '/').trim();
        String norm = normPath(display);

        // 判重：命中=更新元数据（folderPath/tags/notes 传了才覆盖，title 空保留原值）
        for (String id : entryIds()) {
            Map<String, Object> e = readEntryMap(id);
            if (e == null || !normPath(orEmpty(str(e.get("sourcePath")))).equals(norm)) {
                continue;
            }
            if (title != null && !title.trim().isEmpty()) {
                e.put("title", title.trim());
            }
            if (folderPath != null && !folderPath.trim().isEmpty()) {
                e.put("folderId", createFolderPath(folderPath.trim()));
            }
            if (tags != null) {
                e.put("tags", cleanTags(tags));
            }
            if (notes != null) {
                e.put("notes", notes);
            }
            // 再次收录 = 重新确认内容：文档快照与内容哈希一并刷新
            KbContent.Captured recaptured = captureQuietly(id, f);
            if (recaptured != null) {
                e.put("sizeBytes", (double) recaptured.size);
                e.put("contentHash", recaptured.hash);
            }
            e.put("updatedAt", (double) System.currentTimeMillis());
            writeEntryMap(e);
            return resultOf(id, orEmpty(str(e.get("title"))), e, true);
        }

        // 新收录
        String folderId = "";
        if (folderPath != null && !folderPath.trim().isEmpty()) {
            folderId = createFolderPath(folderPath.trim());
        }
        String text = extractText(f);
        long now = System.currentTimeMillis();
        String base = f.getFileName().toString();
        String defTitle = base.contains(".") && !base.startsWith(".")
                ? base.substring(0, base.lastIndexOf('.')) : base;
        Map<String, Object> e = new java.util.LinkedHashMap<>();
        String id = newEntryId(display, new java.util.HashSet<>(entryIds()));
        e.put("id", id);
        e.put("sourcePath", display);
        e.put("title", title != null && !title.trim().isEmpty() ? title.trim() : defTitle);
        e.put("folderId", folderId);
        e.put("tags", cleanTags(tags));
        e.put("notes", notes == null ? "" : notes);
        e.put("project", projectNameOf(f));
        e.put("fileExt", fileExt(f));
        // 文档快照：源文件原始字节逐字节入库 + 内容哈希（与 IDE 收录同一实现）
        KbContent.Captured captured = captureQuietly(id, f);
        e.put("sizeBytes", (double) (captured == null ? fileSize(f) : captured.size));
        e.put("contentHash", captured == null ? "" : captured.hash);
        e.put("ingestedAt", (double) now);
        e.put("updatedAt", (double) now);
        writeEntryMap(e);
        atomicWrite(textDir().resolve(id + ".txt"), orEmpty(text));
        return resultOf(id, (String) e.get("title"), e, false);
    }

    private java.util.Map<String, Object> resultOf(String id, String title, Map<String, Object> e, boolean existed) {
        Map<String, Object> out = new java.util.LinkedHashMap<>();
        out.put("id", id);
        out.put("title", title);
        String fid = orEmpty(str(e.get("folderId")));
        out.put("folderId", fid);
        out.put("folder", folderPathOf(loadFolders(), fid));
        out.put("existed", existed);
        return out;
    }

    /** 判重键：反斜杠归一正斜杠 + Windows 下小写（同 KbFileStore.normPath） */
    private static String normPath(String p) {
        String s = p == null ? "" : p.trim().replace('\\', '/');
        return System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT).contains("windows")
                ? s.toLowerCase(java.util.Locale.ROOT) : s;
    }

    /**
     * 条目 id = normPath 的 SHA-256 前 5 字节 hex：**确定性 id**（同 KbFileStore.newId 跨语言同形）——
     * 同一源文件摘除重加 id 恒定，外部脚本/引用缓存 id 不失效。taken=已占用 id 集合：
     * 40bit 碰撞（~2^-40）时按盐 "#"/"##" 递增重哈希，确定性派生不引入随机性。
     */
    private static String newEntryId(String sourcePath, java.util.Set<String> taken) {
        String norm = normPath(sourcePath);
        String salt = "";
        while (true) {
            byte[] digest;
            try {
                digest = java.security.MessageDigest.getInstance("SHA-256")
                        .digest((norm + salt).getBytes(java.nio.charset.StandardCharsets.UTF_8));
            } catch (Exception e) {
                throw new IllegalStateException("SHA-256 unavailable", e);
            }
            StringBuilder sb = new StringBuilder("kb-");
            for (int i = 0; i < 5; i++) {
                sb.append(String.format("%02x", digest[i]));
            }
            String id = sb.toString();
            if (!taken.contains(id)) {
                return id;
            }
            salt += "#";
        }
    }

    /** 标签清洗（去空项 + 去重保序；单元素清洗走 sanitizeTag） */
    private static java.util.List<Object> cleanTags(java.util.List<String> tags) {
        java.util.LinkedHashSet<Object> out = new java.util.LinkedHashSet<>();
        if (tags != null) {
            for (String t : tags) {
                String c = sanitizeTag(t);
                if (!c.isEmpty()) {
                    out.add(c);
                }
            }
        }
        return new ArrayList<>(out);
    }

    private static long fileSize(Path f) {
        try {
            return Files.size(f);
        } catch (Exception e) {
            return 0;
        }
    }

    /** 展示态路径：反斜杠归一正斜杠（同 KbFileStore.displayPath） */
    private static String displayPath(Path f) {
        return f.toString().replace('\\', '/').trim();
    }

    private static String fileExt(Path f) {
        String base = f.getFileName().toString();
        int dot = base.lastIndexOf('.');
        return dot > 0 ? base.substring(dot).toLowerCase(java.util.Locale.ROOT) : "";
    }

    /**
     * 落文档快照（收录/重指向/再次收录共用，KbContent.capture）：失败返回 null，不拦业务——
     * 条目 contentHash 留空，IDE 侧对账首轮即补齐快照与哈希。
     */
    private KbContent.Captured captureQuietly(String id, Path f) {
        try {
            return KbContent.capture(root, id, displayPath(f));
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * project = 源文件所在 git 仓的根目录名（与 IDE 收录同口径）；不在 git 仓内 / 查询失败
     * 取父目录名。
     */
    private static String projectNameOf(Path f) {
        Path dir = f.getParent();
        if (dir == null) {
            return "";
        }
        String rootRaw = gitText(dir, "rev-parse", "--show-toplevel");
        if (rootRaw != null && !rootRaw.isEmpty()) {
            Path repoRoot = java.nio.file.Paths.get(rootRaw.replace('\\', '/')).toAbsolutePath().normalize();
            Path name = repoRoot.getFileName();
            if (name != null) {
                return name.toString();
            }
        }
        Path parentName = dir.getFileName();
        return parentName == null ? "" : parentName.toString();
    }

    /** 单条 git 命令输出（stdout trim）；失败/超时返回 null。env 同 KbGitCli（pager 关、LC_ALL=C） */
    private static String gitText(Path dir, String... args) {
        try {
            java.util.List<String> cmd = new java.util.ArrayList<>();
            cmd.add("git");
            cmd.add("-c");
            cmd.add("core.quotepath=off");
            for (String a : args) {
                cmd.add(a);
            }
            ProcessBuilder pb = new ProcessBuilder(cmd);
            if (Files.isDirectory(dir)) {
                pb.directory(dir.toFile());
            }
            pb.environment().put("GIT_OPTIONAL_LOCKS", "0");
            pb.environment().put("GIT_PAGER", "cat");
            pb.environment().put("PAGER", "cat");
            pb.environment().put("TERM", "dumb");
            pb.environment().put("LC_ALL", "C");
            pb.environment().put("LANG", "C");
            pb.redirectErrorStream(true);
            Process p = pb.start();
            String out = new String(p.getInputStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
            boolean done = p.waitFor(10, java.util.concurrent.TimeUnit.SECONDS);
            if (!done) {
                p.destroyForcibly();
                return null;
            }
            if (p.exitValue() != 0) {
                return null;
            }
            return out.trim();
        } catch (Exception e) {
            return null;
        }
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
        } catch (Throwable ignore) {
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
            } catch (java.nio.charset.CharacterCodingException e) {
                return new String(bytes, charsetGbk());
            }
        } catch (Exception e) {
            return "";
        }
    }

    private static java.nio.charset.Charset charsetGbk() {
        try {
            return java.nio.charset.Charset.forName("GBK");
        } catch (Exception e) {
            return java.nio.charset.StandardCharsets.UTF_8;
        }
    }

    // ───────────────────────── 内部 ─────────────────────────

    /** 检索缓存目录（库根下 text，单根模型——与 IDE 侧同源） */
    private Path textDir() {
        return root.resolve(KbContent.TEXT_DIR);
    }

    /** config.json 读投影（缺文件/损坏按缺省结构返回，写回即重建——与 IDE 侧 readConfig 同语义）。顶层复制，folders/tags 数组元素与原文件共享引用（改前由调用方复制） */
    @SuppressWarnings("unchecked")
    private Map<String, Object> configMap() {
        Path f = root.resolve("config.json");
        if (Files.isRegularFile(f)) {
            try {
                Object parsed = KbMiniJson.parse(Files.readString(f));
                if (parsed instanceof Map) {
                    return new java.util.LinkedHashMap<>((Map<String, Object>) parsed);
                }
            } catch (Exception ignore) {
                // 损坏按缺省重建
            }
        }
        Map<String, Object> m = new java.util.LinkedHashMap<>();
        m.put("version", 2);
        m.put("folders", new ArrayList<>());
        m.put("tags", new ArrayList<>());
        return m;
    }

    private void writeConfigMap(Map<String, Object> cfg) {
        atomicWrite(root.resolve("config.json"), KbMiniJson.stringify(cfg));
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> foldersOf(Map<String, Object> cfg) {
        Object v = cfg.get("folders");
        return v instanceof List ? (List<Map<String, Object>>) v : new ArrayList<>();
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> tagMetasOf(Map<String, Object> cfg) {
        Object v = cfg.get("tags");
        return v instanceof List ? (List<Map<String, Object>>) v : new ArrayList<>();
    }

    @SuppressWarnings("unchecked")
    private static List<Object> tagsListOf(Map<String, Object> entry) {
        Object v = entry.get("tags");
        return v instanceof List ? (List<Object>) v : new ArrayList<>();
    }

    /** parentId 投影判等（null/缺键 与 "" 同义=根级） */
    private static boolean eqParent(Object pid, String parentId) {
        String p = pid == null ? "" : String.valueOf(pid);
        return p.equals(parentId == null ? "" : parentId);
    }

    /** 全路径 → 目录 id（逐段精确匹配 name；任一段不存在抛 KbOpException） */
    private String folderIdByPath(Map<String, Object> cfg, String path) {
        List<Map<String, Object>> folders = foldersOf(cfg);
        String cur = null;
        for (String seg : path.split("/")) {
            seg = seg.trim();
            if (seg.isEmpty()) {
                continue;
            }
            String found = null;
            for (Map<String, Object> f : folders) {
                String fid = str(f.get("id"));
                if (seg.equals(orEmpty(str(f.get("name")))) && fid != null && eqParent(f.get("parentId"), cur)) {
                    found = fid;
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

    /** node 是否是 ancestor 的子孙（含自身；断链父引用/环即止——同 KbFileStore.isDescendantLocked） */
    private static boolean isDescendant(List<Map<String, Object>> folders, String ancestor, String node) {
        if (ancestor.equals(node)) {
            return true;
        }
        Map<String, Map<String, Object>> idx = new java.util.HashMap<>();
        for (Map<String, Object> f : folders) {
            String fid = str(f.get("id"));
            if (fid != null) {
                idx.put(fid, f);
            }
        }
        Map<String, Object> cur = idx.get(node);
        if (cur == null) {
            return false;
        }
        java.util.Set<String> seen = new java.util.HashSet<>();
        while (true) {
            String p = cur.get("parentId") == null ? "" : String.valueOf(cur.get("parentId"));
            if (p.isEmpty()) {
                return false;
            }
            if (p.equals(ancestor) || !seen.add(p)) {
                return true;
            }
            cur = idx.get(p);
            if (cur == null) {
                return false;
            }
        }
    }

    /** id 及其全部子孙 id 集合（删目录连带面） */
    private static java.util.Set<String> collectSubtree(List<Map<String, Object>> folders, String id) {
        Map<String, List<String>> children = new java.util.HashMap<>();
        for (Map<String, Object> f : folders) {
            String fid = str(f.get("id"));
            String p = f.get("parentId") == null ? "" : String.valueOf(f.get("parentId"));
            if (fid != null) {
                children.computeIfAbsent(p, k -> new ArrayList<>()).add(fid);
            }
        }
        java.util.Set<String> out = new java.util.LinkedHashSet<>();
        java.util.ArrayDeque<String> stack = new java.util.ArrayDeque<>();
        stack.push(id);
        while (!stack.isEmpty()) {
            String cur = stack.pop();
            if (!out.add(cur)) {
                continue;
            }
            stack.addAll(children.getOrDefault(cur, List.of()));
        }
        return out;
    }

    /** 子树直接挂载计数之和（防环 seen） */
    private static int subtreeSum(String id, Map<String, List<String>> children, Map<String, Integer> direct, java.util.Set<String> seen) {
        if (!seen.add(id)) {
            return 0;
        }
        int sum = direct.getOrDefault(id, 0);
        for (String c : children.getOrDefault(id, List.of())) {
            sum += subtreeSum(c, children, direct, seen);
        }
        return sum;
    }

    /** 合法条目 id 全集（`.json` 剥除后校验，`.tmp` 残留/异物挡在门外） */
    private List<String> entryIds() {
        List<String> out = new ArrayList<>();
        Path dir = root.resolve("entries");
        if (!Files.isDirectory(dir)) {
            return out;
        }
        try (var stream = Files.newDirectoryStream(dir, "*.json")) {
            for (Path f : stream) {
                String base = f.getFileName().toString();
                base = base.substring(0, base.length() - ".json".length());
                if (isSafeId(base)) {
                    out.add(base);
                }
            }
        } catch (Exception ignore) {
        }
        out.sort(String::compareTo);
        return out;
    }

    /** 条目原始 JSON Map（保全部字段供读改写；损坏返回 null） */
    @SuppressWarnings("unchecked")
    private Map<String, Object> readEntryMap(String id) {
        if (!isSafeId(id)) {
            return null;
        }
        Path f = root.resolve("entries").resolve(id + ".json");
        if (!Files.isRegularFile(f)) {
            return null;
        }
        try {
            Object parsed = KbMiniJson.parse(Files.readString(f));
            return parsed instanceof Map ? new java.util.LinkedHashMap<>((Map<String, Object>) parsed) : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** 已退役的条目字段（读取时现算的状态、git 锚点、源文件 stat）：存量文件里还有就在写盘时丢弃 */
    private static final java.util.Set<String> RETIRED_KEYS = new java.util.HashSet<>(
        java.util.Arrays.asList("status", "indexedMtime", "indexedSize", "gitRepo", "gitCommit", "gitRel"));

    private void writeEntryMap(Map<String, Object> e) {
        e.keySet().removeAll(RETIRED_KEYS);
        atomicWrite(root.resolve("entries").resolve(orEmpty(str(e.get("id"))) + ".json"), KbMiniJson.stringify(e));
    }

    private static String newFolderId() {
        java.security.SecureRandom rnd = new java.security.SecureRandom();
        byte[] bytes = new byte[4];
        rnd.nextBytes(bytes);
        StringBuilder sb = new StringBuilder("f-");
        for (byte b : bytes) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }

    /** 标签清洗（同 KbFileStore.sanitizeTag：去逗号/引号/空白） */
    private static String sanitizeTag(String raw) {
        return raw == null ? "" : raw.trim().replace(',', ' ').replace('"', ' ').replace('，', ' ').trim();
    }

    /** 8 色板自动配色（同 KbFileStore.pickTagColor：空闲优先，用尽取占用最少） */
    private static String pickTagColor(List<Map<String, Object>> tags) {
        String[] palette = {"#4A9EFF", "#59C17C", "#E05F65", "#B57EE0", "#59B0C9", "#D98A4B", "#E8B339", "#8A919C"};
        Map<String, Integer> counts = new java.util.HashMap<>();
        for (String hex : palette) {
            counts.put(hex, 0);
        }
        for (Map<String, Object> t : tags) {
            String c = orEmpty(str(t.get("color")));
            if (counts.containsKey(c)) {
                counts.merge(c, 1, Integer::sum);
            }
        }
        int min = Integer.MAX_VALUE;
        for (int v : counts.values()) {
            min = Math.min(min, v);
        }
        for (String hex : palette) {
            if (counts.get(hex) == min) {
                return hex;
            }
        }
        return palette[0];
    }

    /** 临时文件 + ATOMIC_MOVE（同 IDE 侧 KbFileStore.atomicWrite；不支持原子移动的文件系统降级普通 move） */
    private void atomicWrite(Path target, String content) {
        try {
            Files.createDirectories(target.getParent());
            Path tmp = target.resolveSibling(target.getFileName().toString() + ".tmp");
            Files.writeString(tmp, content);
            try {
                Files.move(tmp, target, java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                        java.nio.file.StandardCopyOption.ATOMIC_MOVE);
            } catch (java.nio.file.AtomicMoveNotSupportedException e) {
                Files.move(tmp, target, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (KbOpException e) {
            throw e;
        } catch (Exception e) {
            throw new KbOpException("write failed: " + target.getFileName() + " (" + errMsg(e) + ")");
        }
    }

    private static String errMsg(Exception e) {
        return e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
    }

    /** 库内全部可解析条目（损坏文件跳过，隔离不炸全库） */
    private List<Rec> loadEntries() {
        List<Rec> out = new ArrayList<>();
        Path dir = root.resolve("entries");
        if (!Files.isDirectory(dir)) {
            return out;
        }
        try (var stream = Files.newDirectoryStream(dir, "*.json")) {
            for (Path f : stream) {
                if (!Files.isRegularFile(f)) {
                    continue;
                }
                Rec r = parseEntry(f);
                if (r != null) {
                    out.add(r);
                }
            }
        } catch (Exception ignore) {
            // 目录扫不动按空库返回
        }
        return out;
    }

    private static Rec parseEntry(Path f) {
        try {
            Object parsed = KbMiniJson.parse(Files.readString(f));
            if (!(parsed instanceof Map)) {
                return null;
            }
            Map<?, ?> m = (Map<?, ?>) parsed;
            String id = str(m.get("id"));
            if (id == null || !isSafeId(id)) {
                return null;
            }
            Rec r = new Rec();
            r.id = id;
            r.title = orEmpty(str(m.get("title")));
            r.folderId = orEmpty(str(m.get("folderId")));
            r.project = orEmpty(str(m.get("project")));
            r.sourcePath = orEmpty(str(m.get("sourcePath")));
            Object ingestedAt = m.get("ingestedAt");
            r.ingestedAt = ingestedAt instanceof Number ? ((Number) ingestedAt).longValue() : 0;
            Object order = m.get("order");
            r.order = order instanceof Number ? ((Number) order).intValue() : 0;
            Object tags = m.get("tags");
            if (tags instanceof List) {
                StringBuilder sb = new StringBuilder("[");
                boolean first = true;
                for (Object t : (List<?>) tags) {
                    if (!first) {
                        sb.append(',');
                    }
                    first = false;
                    sb.append(KbMiniJson.str(t instanceof String ? (String) t : String.valueOf(t)));
                }
                r.tagsJson = sb.append(']').toString();
            }
            return r;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * 过滤语义同 KbFileStore.matchesFilter（folder 维度 MCP 面用展示路径）：null=不过滤；
     * folder 空串=根级；非空=精确路径或其子树前缀（`信创适配` 命中 `信创适配/中间件`）。
     */
    private static boolean filterMatches(Rec r, Map<String, Folder> folders, String folder, String tag, String project) {
        if (folder != null) {
            String path = folderPathOf(folders, r.folderId);
            boolean hit = folder.isEmpty() ? path.isEmpty()
                    : path.equals(folder) || path.startsWith(folder + "/");
            if (!hit) {
                return false;
            }
        }
        if (tag != null && !tag.isEmpty()) {
            if (!tagsOf(r.tagsJson).contains(tag)) {
                return false;
            }
        }
        if (project != null && !project.isEmpty() && !r.project.equals(project)) {
            return false;
        }
        return true;
    }

    /** config.json folders 数组投影（缺文件/损坏/旧版无 folders 返回空表=全根级） */
    private Map<String, Folder> loadFolders() {
        Map<String, Folder> out = new java.util.HashMap<>();
        Path f = root.resolve("config.json");
        if (!Files.isRegularFile(f)) {
            return out;
        }
        try {
            Object parsed = KbMiniJson.parse(Files.readString(f));
            if (!(parsed instanceof Map)) {
                return out;
            }
            Object foldersObj = ((Map<?, ?>) parsed).get("folders");
            if (!(foldersObj instanceof List)) {
                return out;
            }
            for (Object o : (List<?>) foldersObj) {
                if (!(o instanceof Map)) {
                    continue;
                }
                Map<?, ?> m = (Map<?, ?>) o;
                String id = str(m.get("id"));
                String name = str(m.get("name"));
                if (id == null || name == null) {
                    continue;
                }
                Folder fd = new Folder();
                fd.id = id;
                fd.name = name;
                fd.parentId = orEmpty(str(m.get("parentId")));
                out.put(id, fd);
            }
        } catch (Exception ignore) {
            // config 读不动按空目录树返回
        }
        return out;
    }

    /** 展示路径派生（同 KbFileStore.folderPath 语义）：未知 id 与根级返回 ""，断链/环即止 */
    private static String folderPathOf(Map<String, Folder> folders, String folderId) {
        if (folderId == null || folderId.isEmpty()) {
            return "";
        }
        Folder cur = folders.get(folderId);
        if (cur == null) {
            return "";
        }
        java.util.ArrayDeque<String> parts = new java.util.ArrayDeque<>();
        java.util.Set<String> seen = new java.util.HashSet<>();
        while (cur != null && seen.add(cur.id)) {
            parts.addFirst(cur.name);
            cur = cur.parentId.isEmpty() ? null : folders.get(cur.parentId);
        }
        return String.join("/", parts);
    }

    /** tagsJson 里的字符串元素拆回 List（tags 录入侧已禁引号/逗号，无嵌套） */
    private static List<String> tagsOf(String tagsJson) {
        List<String> out = new ArrayList<>();
        Object parsed;
        try {
            parsed = KbMiniJson.parse(tagsJson == null || tagsJson.isEmpty() ? "[]" : tagsJson);
        } catch (Exception e) {
            return out;
        }
        if (parsed instanceof List) {
            for (Object t : (List<?>) parsed) {
                if (t instanceof String) {
                    out.add((String) t);
                }
            }
        }
        return out;
    }

    /** 条目 id 只允许我们生成器的字符集（kb- + 小写 hex），文件名拼接前必查 */
    private static boolean isSafeId(String id) {
        if (id == null || !id.startsWith("kb-") || id.length() <= 3) {
            return false;
        }
        for (int i = 3; i < id.length(); i++) {
            char c = id.charAt(i);
            boolean ok = c == '-' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
            if (!ok) {
                return false;
            }
        }
        return true;
    }

    private Row rowOf(Rec r, Map<String, Folder> folders, double score, String snippet) {
        Row row = new Row();
        row.id = r.id;
        row.title = r.title;
        row.folder = folderPathOf(folders, r.folderId);
        row.tagsJson = r.tagsJson;
        row.project = r.project;
        row.sourcePath = r.sourcePath;
        // 状态与「现在该读哪个文件」读取时现算（KbContent.resolve，与 IDE 侧同一规则），不读盘上的值
        KbContent.Resolved resolved = KbContent.resolve(root, r.id, r.sourcePath);
        row.status = KbContent.statusCode(resolved.state);
        row.contentPath = resolved.path == null ? "" : displayPath(resolved.path);
        row.score = score;
        row.snippet = snippet == null ? "" : snippet;
        row.ingestedAt = r.ingestedAt;
        return row;
    }

    private static String str(Object o) {
        return o instanceof String ? (String) o : null;
    }

    private static String orEmpty(String s) {
        return s == null ? "" : s;
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
