package com.zcode.kb.core;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/**
 * 知识库元数据的存储——目录树、条目、标签注册表的读写，以及收录与元数据编辑的落库规则。
 * IDE 侧的 KbFileStore（Kotlin）与 MCP server 侧的 KbServerStore（Java）都只是它上面的薄接口：
 * 凡是往库里写文件的逻辑只有这一份（纯 Java，不依赖 Kotlin 运行时）。
 *
 * 为什么必须只有一份：库目录同时是 git 仓库，IDE 与 AI（经 MCP 整理）写的是同一批文件。
 * 两份实现只要有一点出入——排版、字段的写法、排序的落位——就会变成历史里的整文件重写、
 * 两台机器之间的合并冲突，或者两边整理出的结果不一样。
 *
 * 文件与排版：
 * <pre>
 * config.json          目录树（folders）+ 标签注册表（tags）
 * entries/&lt;id&gt;.json    每条目一份元数据，逐字段一行、4 空格缩进
 * text/&lt;id&gt;.txt        检索缓存（可重建，不进版本历史）
 * </pre>
 * 写出的字节与格式化的 JSON 写法固定不变（字段顺序即 [Entry]、[Folder]、[Tag] 的字段顺序），
 * 读的时候只认这些字段：未知键忽略、下次写盘即丢弃；缺必填字段或类型不对的文件按损坏处理，
 * 单个条目损坏只丢该条目，config 损坏按空目录树处理。
 *
 * 并发模型：写一律临时文件 + ATOMIC_MOVE（读侧永远看到完整的旧文件或完整的新文件）；进程内
 * 单锁串行；跨进程对同一条目的并发写 = 后写覆盖。条目 id 必须在 [KbContent#isSafeId] 的
 * 白名单内，拼接文件名前必查。
 *
 * 红线：本文件及整个 knowledge-core 不出现 zcode 会话库（db.sqlite / tasks-index.sqlite）的任何路径引用。
 */
public final class KbMetaStore implements AutoCloseable {

    /** 条目元数据；字段顺序即条目文件里的字段顺序 */
    public static final class Entry {
        public String id = "";
        public String sourcePath = "";
        public String title = "";
        /** 所属目录 id；空串 = 根级 */
        public String folderId = "";
        public List<String> tags = new ArrayList<>();
        public String notes = "";
        public String project = "";
        public String fileExt = "";
        public long sizeBytes = 0L;
        /** 源文件字节的 SHA-256：上次确认的内容版本；空串 = 尚未确认过 */
        public String contentHash = "";
        public long ingestedAt = 0L;
        /** 最近一次元数据编辑的时间；对账改内容哈希时不碰它 */
        public long updatedAt = 0L;
        /** 同目录层内的手动排序键（拖拽重排时全层重写 0..n-1） */
        public int order = 0;

        public Entry copy() {
            Entry c = new Entry();
            c.id = id;
            c.sourcePath = sourcePath;
            c.title = title;
            c.folderId = folderId;
            c.tags = new ArrayList<>(tags);
            c.notes = notes;
            c.project = project;
            c.fileExt = fileExt;
            c.sizeBytes = sizeBytes;
            c.contentHash = contentHash;
            c.ingestedAt = ingestedAt;
            c.updatedAt = updatedAt;
            c.order = order;
            return c;
        }

        @Override
        public String toString() {
            return id + " " + title;
        }
    }

    /** 用户自建目录。条目与子目录都按 id 引用，重命名、移动不改它们 */
    public static final class Folder {
        public String id = "";
        public String name = "";
        /** 上级目录 id；null = 根级 */
        public String parentId;
        /** 同层排序键 */
        public int order = 0;

        public Folder() {
        }

        public Folder(String id, String name, String parentId, int order) {
            this.id = id;
            this.name = name;
            this.parentId = parentId;
            this.order = order;
        }

        public Folder copy() {
            return new Folder(id, name, parentId, order);
        }

        @Override
        public String toString() {
            return id + " " + name;
        }
    }

    /** 标签注册表条目：名字 + 颜色（hex）。条目的 tags 只存名字 */
    public static final class Tag {
        public String name = "";
        public String color = "";

        public Tag() {
        }

        public Tag(String name, String color) {
            this.name = name;
            this.color = color;
        }

        public Tag copy() {
            return new Tag(name, color);
        }

        @Override
        public String toString() {
            return name;
        }
    }

    /** 列表过滤条件；null 或空 = 不过滤 */
    public static final class Filter {
        public String folderId;
        public Set<String> tags;
        /** true = 须包含全部标签，false = 任一命中 */
        public boolean tagMatchAll;
        public String project;

        public Filter() {
        }

        public Filter(String folderId, Set<String> tags, boolean tagMatchAll, String project) {
            this.folderId = folderId;
            this.tags = tags;
            this.tagMatchAll = tagMatchAll;
            this.project = project;
        }
    }

    /** 条目变换：入参是库里的最新条目的副本，改完返回即为写盘内容 */
    @FunctionalInterface
    public interface EntryTransform {
        Entry apply(Entry entry);
    }

    /** 标签变换：入参是库里的最新标签，返回值原样写入 */
    @FunctionalInterface
    public interface TagsTransform {
        List<String> apply(List<String> tags);
    }

    /**
     * 元数据编辑请求：非 null 的字段覆盖原值，null = 不动。title 空白 = 保留原标题。
     * newFile 非空 = 改指新的源文件（重新链接），此时 text 是新源文件的检索缓存文本。
     */
    public static final class Edit {
        public String title;
        public String folderId;
        public List<String> tags;
        public String notes;
        public Path newFile;
        public String text;
    }

    /** [ingest] 的结果 */
    public static final class Ingested {
        public final Entry entry;
        /** true = 同一源文件此前已收录，这次是更新 */
        public final boolean existed;
        /** 新收录时是否提取出了正文（false = 仅标题参与检索） */
        public final boolean textExtracted;
        /** 文档快照是否落盘（false = 条目的内容哈希留空，对账首轮补齐） */
        public final boolean snapshotCaptured;

        Ingested(Entry entry, boolean existed, boolean textExtracted, boolean snapshotCaptured) {
            this.entry = entry;
            this.existed = existed;
            this.textExtracted = textExtracted;
            this.snapshotCaptured = snapshotCaptured;
        }
    }

    private static final boolean WINDOWS =
            System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("windows");

    /** 标签自动分配色板（8 色轮转）：中性饱和色，深浅主题通用 */
    public static final List<String> TAG_PALETTE = List.of(
            "#4A9EFF", "#59C17C", "#E05F65", "#B57EE0", "#59B0C9", "#D98A4B", "#E8B339", "#8A919C");

    private static final int MAX_TAGS = 20;

    private final Path root;
    private final Object lock = new Object();

    /** 关库后（库位置迁移）写入一律拒绝，不再在旧路径上建目录 */
    private volatile boolean closed;

    /** root 为库根目录（entries、text、snapshots 的父目录）。构造不建目录：库不存在时读到的是空库 */
    public KbMetaStore(Path root) {
        this.root = root;
    }

    public Path root() {
        return root;
    }

    /** 建库目录骨架（entries、text、snapshots）：首次使用、库位置迁移后调用 */
    public void ensureDirectories() throws IOException {
        synchronized (lock) {
            Files.createDirectories(entriesDir());
            Files.createDirectories(root.resolve(KbContent.TEXT_DIR));
            Files.createDirectories(root.resolve(KbContent.SNAPSHOTS_DIR));
        }
    }

    @Override
    public void close() {
        closed = true;
    }

    // ───────────────────────── 条目 ─────────────────────────

    /** 全部可解析的条目，按 id 排序；损坏文件不计入 */
    public List<Entry> entries() {
        synchronized (lock) {
            return readAllEntries();
        }
    }

    /** 条目不存在或已损坏返回 null */
    public Entry entry(String id) {
        synchronized (lock) {
            return readEntry(id);
        }
    }

    public boolean hasEntry(String id) {
        synchronized (lock) {
            return readEntry(id) != null;
        }
    }

    /** 按源路径找条目（判重键见 [normPath]） */
    public Entry findBySource(String path) {
        synchronized (lock) {
            return findBySourceLocked(path);
        }
    }

    private Entry findBySourceLocked(String path) {
        String key = normPath(path);
        for (Entry e : readAllEntries()) {
            if (normPath(e.sourcePath).equals(key)) {
                return e;
            }
        }
        return null;
    }

    /** 层内顺序：order 升序，并列（0 = 没拖过）按收录时间倒序 */
    public List<Entry> list(Filter f, int limit) {
        synchronized (lock) {
            List<Entry> out = new ArrayList<>();
            for (Entry e : readAllEntries()) {
                if (matches(e, f)) {
                    out.add(e);
                }
            }
            inLayerOrder(out);
            return out.size() > limit ? new ArrayList<>(out.subList(0, Math.max(limit, 0))) : out;
        }
    }

    private static boolean matches(Entry e, Filter f) {
        if (f == null) {
            return true;
        }
        if (f.folderId != null && !f.folderId.equals(e.folderId)) {
            return false;
        }
        if (f.tags != null && !f.tags.isEmpty()) {
            boolean hit = f.tagMatchAll ? e.tags.containsAll(f.tags) : e.tags.stream().anyMatch(f.tags::contains);
            if (!hit) {
                return false;
            }
        }
        return f.project == null || f.project.equals(e.project);
    }

    /** 新条目入库，检索缓存一并写入 */
    public void insert(Entry e, String text) throws IOException {
        synchronized (lock) {
            writeEntry(e);
            writeText(e.id, text);
        }
    }

    /** 整条覆盖写入；text 非 null 时同步刷新检索缓存 */
    public void update(Entry e, String text) throws IOException {
        synchronized (lock) {
            writeEntry(e);
            if (text != null) {
                writeText(e.id, text);
            }
        }
    }

    /**
     * 只改标签：锁内读最新条目，其余字段原样保留（调用方手里的条目可能是过期快照，不能拿它整条覆盖）。
     *
     * @return 是否写盘（条目不存在或标签没变 = false）
     */
    public boolean updateTags(String id, TagsTransform transform) throws IOException {
        synchronized (lock) {
            Entry e = readEntry(id);
            if (e == null) {
                return false;
            }
            List<String> tags = transform.apply(new ArrayList<>(e.tags));
            if (tags.equals(e.tags)) {
                return false;
            }
            Entry next = e.copy();
            next.tags = new ArrayList<>(tags);
            next.updatedAt = System.currentTimeMillis();
            writeEntry(next);
            return true;
        }
    }

    /**
     * 锁内读最新条目，交给 transform 改，返回值写盘。调用方手里的条目可能是过期快照，
     * 拿它整条覆盖会冲掉期间别的入口改的字段。
     *
     * @param text 非 null 时同步刷新检索缓存
     * @return 写盘后的条目；条目不存在返回 null（不写盘）
     */
    public Entry transform(String id, String text, EntryTransform transform) throws IOException {
        synchronized (lock) {
            Entry e = readEntry(id);
            if (e == null) {
                return null;
            }
            Entry next = transform.apply(e.copy());
            if (next == null) {
                return null;
            }
            writeEntry(next);
            if (text != null) {
                writeText(id, text);
            }
            return next;
        }
    }

    /**
     * 内容对账落盘：只改内容哈希与大小，别的字段原样保留。
     * 不动 updatedAt：同一处源文件的变化常被两台电脑各自对账到，两边写下的条目文件必须逐字节相同，
     * 后同步的那台才不会撞上冲突。
     *
     * @return 是否写盘（条目不存在或字段已是目标值 = false）
     */
    public boolean confirmContent(String id, String hash, long size) throws IOException {
        synchronized (lock) {
            Entry e = readEntry(id);
            if (e == null) {
                return false;
            }
            if (e.contentHash.equals(hash) && e.sizeBytes == size) {
                return false;
            }
            Entry next = e.copy();
            next.contentHash = hash;
            next.sizeBytes = size;
            writeEntry(next);
            return true;
        }
    }

    /** 对账入参：全部条目的内容视图 */
    public List<KbContent.Source> contentSources() {
        synchronized (lock) {
            List<KbContent.Source> out = new ArrayList<>();
            for (Entry e : readAllEntries()) {
                out.add(new KbContent.Source(e.id, e.sourcePath, e.contentHash));
            }
            return out;
        }
    }

    /** 摘除条目：删登记、检索缓存与文档快照，绝不动源文件。id 不合法或条目不存在 = 无事发生 */
    public void removeEntry(String id) throws IOException {
        synchronized (lock) {
            if (!KbContent.isSafeId(id)) {
                return;
            }
            Files.deleteIfExists(entriesDir().resolve(id + ".json"));
            Files.deleteIfExists(KbContent.textFile(root, id));
            KbContent.deleteSnapshot(root, id);
        }
    }

    /** 检索缓存文本；没有或读不出返回 null */
    public String readText(String id) {
        synchronized (lock) {
            if (!KbContent.isSafeId(id)) {
                return null;
            }
            Path f = KbContent.textFile(root, id);
            if (!Files.isRegularFile(f)) {
                return null;
            }
            try {
                return Files.readString(f);
            }
            catch (IOException e) {
                return null;
            }
        }
    }

    public void writeText(String id, String text) throws IOException {
        synchronized (lock) {
            atomicWrite(KbContent.textFile(root, id), text);
        }
    }

    /** 清空检索缓存（重建索引的第一步，之后的重提取走 KbContent.rebuildText） */
    public void clearIndex() throws IOException {
        synchronized (lock) {
            Path dir = root.resolve(KbContent.TEXT_DIR);
            if (!Files.isDirectory(dir)) {
                return;
            }
            try (DirectoryStream<Path> s = Files.newDirectoryStream(dir)) {
                for (Path f : s) {
                    if (Files.isRegularFile(f)) {
                        Files.deleteIfExists(f);
                    }
                }
            }
        }
    }

    // ───────────────────────── 收录与元数据编辑 ─────────────────────────

    /**
     * 收录：源文件此前没收录过就新建条目，收录过就更新（同一源路径只会有一个条目）。
     * 两种情况都重新落文档快照、刷新内容哈希。
     *
     * @param title    新收录时为空取默认标题（文件名去扩展名）；已收录时为空保留原标题
     * @param folderId 新收录时 null = 根级；已收录时 null = 保留原目录
     * @param tags     null = 已收录时保留原标签（新收录按无标签）；传入即整体替换，清洗规则见 [sanitizeTags]
     * @param notes    null = 已收录时保留原备注（新收录按无备注）
     * @param gitExe   查源文件所在 git 仓根用的可执行文件（取 project 名）；null = 不查，取父目录名
     * @param onError  提取正文、落快照、查 git 失败时的回调（可为 null）：这些失败都不拦收录
     */
    public Ingested ingest(Path file,
                           String title,
                           String folderId,
                           List<String> tags,
                           String notes,
                           KbContent.TextExtractor extractor,
                           String gitExe,
                           Consumer<Exception> onError) throws IOException {
        synchronized (lock) {
            String display = displayPath(file.toString());
            long now = System.currentTimeMillis();
            Entry existing = findBySourceLocked(display);
            if (existing != null) {
                Entry e = existing.copy();
                if (notBlank(title)) {
                    e.title = title.trim();
                }
                if (folderId != null) {
                    e.folderId = folderId;
                }
                if (tags != null) {
                    e.tags = sanitizeTags(tags);
                }
                if (notes != null) {
                    e.notes = notes;
                }
                e.updatedAt = now;
                KbContent.Captured captured = captureQuietly(e.id, file, onError);
                if (captured != null) {
                    e.sizeBytes = captured.size;
                    e.contentHash = captured.hash;
                }
                writeEntry(e);
                return new Ingested(e, true, false, captured != null);
            }

            boolean[] extracted = {true};
            String text = extractQuietly(extractor, file, extracted, onError);
            Entry e = new Entry();
            e.id = newId(display, takenIds());
            e.sourcePath = display;
            e.title = notBlank(title) ? title.trim() : defaultTitle(file);
            e.folderId = folderId == null ? "" : folderId;
            e.tags = sanitizeTags(tags == null ? List.of() : tags);
            e.notes = notes == null ? "" : notes;
            e.project = projectNameOf(file, gitExe, onError);
            e.fileExt = fileExtOf(file);
            KbContent.Captured captured = captureQuietly(e.id, file, onError);
            e.sizeBytes = captured == null ? fileSize(file) : captured.size;
            e.contentHash = captured == null ? "" : captured.hash;
            e.ingestedAt = now;
            e.updatedAt = now;
            writeEntry(e);
            writeText(e.id, text);
            return new Ingested(e, false, extracted[0], captured != null);
        }
    }

    /**
     * 元数据编辑的统一入口（改标题、目录、标签、备注，可同时改指新的源文件），updatedAt 记为当前时间。
     * 条目不存在返回 null，不写盘。
     */
    public Entry edit(String id, Edit edit, Consumer<Exception> onError) throws IOException {
        synchronized (lock) {
            Entry cur = readEntry(id);
            if (cur == null) {
                return null;
            }
            Entry e = cur.copy();
            if (notBlank(edit.title)) {
                e.title = edit.title.trim();
            }
            if (edit.folderId != null) {
                e.folderId = edit.folderId;
            }
            if (edit.tags != null) {
                e.tags = sanitizeTags(edit.tags);
            }
            if (edit.notes != null) {
                e.notes = edit.notes;
            }
            if (edit.newFile != null) {
                // 改指新源文件：以新文件为准重新落文档快照（随之改名）与内容哈希；id、标题、目录、标签、备注不动
                e.sourcePath = displayPath(edit.newFile.toString());
                KbContent.Captured captured = captureQuietly(id, edit.newFile, onError);
                e.sizeBytes = captured == null ? fileSize(edit.newFile) : captured.size;
                e.contentHash = captured == null ? "" : captured.hash;
                e.fileExt = fileExtOf(edit.newFile);
            }
            e.updatedAt = System.currentTimeMillis();
            writeEntry(e);
            if (edit.text != null) {
                writeText(id, edit.text);
            }
            return e;
        }
    }

    private Set<String> takenIds() {
        Set<String> out = new HashSet<>();
        for (Entry e : readAllEntries()) {
            out.add(e.id);
        }
        return out;
    }

    private KbContent.Captured captureQuietly(String id, Path file, Consumer<Exception> onError) {
        try {
            return KbContent.capture(root, id, displayPath(file.toString()));
        }
        catch (Exception e) {
            if (onError != null) {
                onError.accept(e);
            }
            return null;
        }
    }

    private static String extractQuietly(KbContent.TextExtractor extractor, Path file, boolean[] extracted,
                                         Consumer<Exception> onError) {
        try {
            String text = extractor.extract(file);
            if (text == null) {
                extracted[0] = false; // 没有正文可提取：检索缓存写空，只有标题和标签参与检索
                return "";
            }
            return text;
        }
        catch (Exception e) {
            extracted[0] = false;
            if (onError != null) {
                onError.accept(e);
            }
            return "";
        }
    }

    // ───────────────────────── 目录树 ─────────────────────────

    /** 目录全表（config 里的存储序；空目录也返回） */
    public List<Folder> folders() {
        synchronized (lock) {
            return readConfig().folders;
        }
    }

    /** 展示路径（如 信创适配/中间件）；未知 id 与根级返回空串，断链的父引用即止 */
    public String folderPath(String folderId) {
        synchronized (lock) {
            return pathOf(readConfig().folders, folderId);
        }
    }

    /** 每个目录的展示路径（id → 路径），一次读盘算全表 */
    public Map<String, String> folderPaths() {
        synchronized (lock) {
            List<Folder> folders = readConfig().folders;
            Map<String, String> out = new HashMap<>();
            for (Folder f : folders) {
                out.put(f.id, pathOf(folders, f.id));
            }
            return out;
        }
    }

    private static String pathOf(List<Folder> folders, String folderId) {
        Map<String, Folder> idx = byId(folders);
        Folder cur = idx.get(folderId);
        if (cur == null) {
            return "";
        }
        Deque<String> parts = new ArrayDeque<>();
        Set<String> seen = new HashSet<>();
        while (cur != null && seen.add(cur.id)) {
            parts.addFirst(cur.name);
            cur = cur.parentId == null ? null : idx.get(cur.parentId);
        }
        return String.join("/", parts);
    }

    /** 新建目录，排在目标层末尾。同层重名允许（id 区分）。
     *  @return 新目录 id；名字为空抛 IllegalArgumentException */
    public String createFolder(String parentId, String name) throws IOException {
        synchronized (lock) {
            String clean = name.trim();
            if (clean.isEmpty()) {
                throw new IllegalArgumentException("folder name is empty");
            }
            String parent = parentId == null || parentId.isEmpty() ? null : parentId;
            Config cfg = readConfig();
            Folder folder = new Folder(newFolderId(), clean, parent, maxOrder(cfg.folders, parent) + 1);
            cfg.folders.add(folder);
            writeConfig(cfg);
            return folder.id;
        }
    }

    /** 按路径逐级确保目录存在（a/b/c，缺哪级建哪级，已有则复用）。
     *  @return 最末级目录 id；路径为空返回空串且不写盘 */
    public String ensureFolderPath(String path) throws IOException {
        synchronized (lock) {
            Config cfg = readConfig();
            String parentId = null;
            boolean changed = false;
            for (String segRaw : path.split("/")) {
                String seg = segRaw.trim();
                if (seg.isEmpty()) {
                    continue;
                }
                Folder existing = null;
                for (Folder f : cfg.folders) {
                    if (Objects.equals(f.parentId, parentId) && f.name.equals(seg)) {
                        existing = f;
                        break;
                    }
                }
                if (existing == null) {
                    existing = new Folder(newFolderId(), seg, parentId, maxOrder(cfg.folders, parentId) + 1);
                    cfg.folders.add(existing);
                    changed = true;
                }
                parentId = existing.id;
            }
            if (changed) {
                writeConfig(cfg);
            }
            return parentId == null ? "" : parentId;
        }
    }

    /** 目录改名，位置不变。名字为空或目录不存在 = 无事发生 */
    public void renameFolder(String id, String newName) throws IOException {
        synchronized (lock) {
            String clean = newName.trim();
            if (clean.isEmpty()) {
                return;
            }
            Config cfg = readConfig();
            Folder f = findFolder(cfg.folders, id);
            if (f == null) {
                return;
            }
            Folder renamed = f.copy();
            renamed.name = clean;
            cfg.folders.set(cfg.folders.indexOf(f), renamed);
            writeConfig(cfg);
        }
    }

    /**
     * 移动目录到新的上层（null 或空串 = 根级），并插到目标层第 insertIndex 位。
     * insertIndex 是目标层摘出前的位次（界面插入线换算值），同层自己拖自己时的摘出偏移内部校正；
     * 超出层大小的值落到层尾。目标层 order 全量重写。
     *
     * @return false = 防环拒绝（新上层是自身或其子孙）或目录不存在
     */
    public boolean moveFolder(String id, String newParentId, int insertIndex) throws IOException {
        synchronized (lock) {
            Config cfg = readConfig();
            if (findFolder(cfg.folders, id) == null) {
                return false;
            }
            String parent = newParentId == null || newParentId.isEmpty() ? null : newParentId;
            if (parent != null && isDescendant(cfg.folders, id, parent)) {
                return false;
            }
            List<Folder> layer = new ArrayList<>();
            for (Folder f : cfg.folders) {
                if (Objects.equals(f.parentId, parent)) {
                    layer.add(f);
                }
            }
            layer.sort((a, b) -> Integer.compare(a.order, b.order)); // 稳定排序：并列按存储序
            int at = Math.max(0, Math.min(insertIndex, layer.size()));
            int before = 0;
            for (int i = 0; i < at; i++) {
                if (layer.get(i).id.equals(id)) {
                    before++;
                }
            }
            List<Folder> siblings = new ArrayList<>();
            for (Folder f : layer) {
                if (!f.id.equals(id)) {
                    siblings.add(f);
                }
            }
            reorderFolders(cfg, id, parent, siblings, at - before);
            return true;
        }
    }

    /**
     * 目标层兄弟（已按序、不含被移动的目录）按 insertAt 插位后 order 全量重写 0..n-1，
     * 被移动目录的 parentId 同步改。config 里的存储序不变。
     */
    private void reorderFolders(Config cfg, String id, String parent, List<Folder> siblings, int insertIndex)
            throws IOException {
        Folder moving = findFolder(cfg.folders, id);
        int insertAt = Math.max(0, Math.min(insertIndex, siblings.size()));
        List<Folder> rebuilt = new ArrayList<>(siblings.size() + 1);
        for (int i = 0; i < siblings.size(); i++) {
            Folder f = siblings.get(i).copy();
            f.order = i < insertAt ? i : i + 1;
            rebuilt.add(f);
        }
        Folder moved = moving.copy();
        moved.parentId = parent;
        moved.order = insertAt;
        rebuilt.add(insertAt, moved);
        for (int i = 0; i < cfg.folders.size(); i++) {
            Folder r = findFolder(rebuilt, cfg.folders.get(i).id);
            if (r != null) {
                cfg.folders.set(i, r);
            }
        }
        writeConfig(cfg);
    }

    /** 删目录：子目录连带删除，其下条目退回根级（不丢数据）。
     *  @return 退回根级的条目数 */
    public int deleteFolder(String id) throws IOException {
        synchronized (lock) {
            Config cfg = readConfig();
            Set<String> doomed = subtree(cfg.folders, id);
            int moved = 0;
            for (Entry e : readAllEntries()) {
                if (doomed.contains(e.folderId)) {
                    Entry next = e.copy();
                    next.folderId = "";
                    next.updatedAt = System.currentTimeMillis();
                    writeEntry(next);
                    moved++;
                }
            }
            cfg.folders.removeIf(f -> doomed.contains(f.id));
            writeConfig(cfg);
            return moved;
        }
    }

    /**
     * 移动或重排条目（拖拽落位的统一入口）：ids 依次移入目标目录（空串 = 根级；目标目录已不存在则
     * 回到根级），插到目标层第 insertIndex 位（摘出前的位次，同层自拖的偏移内部校正，超出落到层尾）。
     * 目标层 order 全量重写 0..n-1，跨层时原层也重写收拢空洞。只改排序不刷 updatedAt，换了目录才刷。
     */
    public void reorderEntries(List<String> ids, String targetFolderId, int insertIndex) throws IOException {
        synchronized (lock) {
            if (ids.isEmpty()) {
                return;
            }
            Config cfg = readConfig();
            String target = targetFolderId.isEmpty() || findFolder(cfg.folders, targetFolderId) != null ? targetFolderId : "";
            Set<String> idSet = new LinkedHashSet<>(ids);
            List<Entry> moving = new ArrayList<>();
            for (String id : ids) {
                Entry e = readEntry(id);
                if (e != null && findEntry(moving, e.id) == null) {
                    moving.add(e);
                }
            }
            Set<String> origins = new LinkedHashSet<>();
            for (Entry e : moving) {
                if (!e.folderId.equals(target)) {
                    origins.add(e.folderId);
                }
            }
            List<Entry> layer = new ArrayList<>();
            for (Entry e : readAllEntries()) {
                if (e.folderId.equals(target)) {
                    layer.add(e);
                }
            }
            inLayerOrder(layer);
            int at = Math.max(0, Math.min(insertIndex, layer.size()));
            List<Entry> rebuilt = new ArrayList<>();
            int before = 0;
            for (int i = 0; i < layer.size(); i++) {
                Entry e = layer.get(i);
                if (idSet.contains(e.id)) {
                    if (i < at) {
                        before++;
                    }
                } else {
                    rebuilt.add(e);
                }
            }
            int insertAt = Math.max(0, Math.min(at - before, rebuilt.size()));
            rebuilt.addAll(insertAt, moving);
            for (int i = 0; i < rebuilt.size(); i++) {
                Entry next = rebuilt.get(i).copy();
                boolean crossLayer = !next.folderId.equals(target);
                if (crossLayer || next.order != i) {
                    if (crossLayer) {
                        next.folderId = target;
                        next.updatedAt = System.currentTimeMillis();
                    }
                    next.order = i;
                    writeEntry(next);
                }
            }
            for (String origin : origins) {
                List<Entry> rest = new ArrayList<>();
                for (Entry e : readAllEntries()) {
                    if (e.folderId.equals(origin) && !idSet.contains(e.id)) {
                        rest.add(e);
                    }
                }
                inLayerOrder(rest);
                for (int i = 0; i < rest.size(); i++) {
                    Entry e = rest.get(i);
                    if (e.order != i) {
                        Entry next = e.copy();
                        next.order = i;
                        writeEntry(next);
                    }
                }
            }
        }
    }

    private static void inLayerOrder(List<Entry> list) {
        list.sort((a, b) -> {
            int c = Integer.compare(a.order, b.order);
            return c != 0 ? c : Long.compare(b.ingestedAt, a.ingestedAt);
        });
    }

    private static int maxOrder(List<Folder> folders, String parentId) {
        int max = -1;
        for (Folder f : folders) {
            if (Objects.equals(f.parentId, parentId)) {
                max = Math.max(max, f.order);
            }
        }
        return max;
    }

    /** node 是否是 ancestor 的子孙（含自身）；断链的父引用按不存在处理，环即止 */
    private static boolean isDescendant(List<Folder> folders, String ancestor, String node) {
        if (ancestor.equals(node)) {
            return true;
        }
        Map<String, Folder> idx = byId(folders);
        Folder cur = idx.get(node);
        if (cur == null) {
            return false;
        }
        Set<String> seen = new HashSet<>();
        while (cur.parentId != null) {
            if (cur.id.equals(ancestor) || !seen.add(cur.id)) {
                return true;
            }
            cur = idx.get(cur.parentId);
            if (cur == null) {
                return false;
            }
        }
        return cur.id.equals(ancestor);
    }

    /** id 及其全部子孙（删目录的连带面） */
    private static Set<String> subtree(List<Folder> folders, String id) {
        Map<String, List<String>> children = new HashMap<>();
        for (Folder f : folders) {
            children.computeIfAbsent(f.parentId == null ? "" : f.parentId, k -> new ArrayList<>()).add(f.id);
        }
        Set<String> out = new LinkedHashSet<>();
        Deque<String> stack = new ArrayDeque<>();
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

    private static Map<String, Folder> byId(List<Folder> folders) {
        Map<String, Folder> idx = new HashMap<>();
        for (Folder f : folders) {
            idx.put(f.id, f);
        }
        return idx;
    }

    private static Folder findFolder(List<Folder> folders, String id) {
        for (Folder f : folders) {
            if (f.id.equals(id)) {
                return f;
            }
        }
        return null;
    }

    private static Entry findEntry(List<Entry> entries, String id) {
        for (Entry e : entries) {
            if (e.id.equals(id)) {
                return e;
            }
        }
        return null;
    }

    // ───────────────────────── 标签与项目 ─────────────────────────

    /** 全部标签名（条目上的 + 注册表里的），排序 */
    public List<String> allTags() {
        synchronized (lock) {
            Set<String> out = new TreeSet<>();
            for (Entry e : readAllEntries()) {
                out.addAll(e.tags);
            }
            for (Tag t : readConfig().tags) {
                out.add(t.name);
            }
            return new ArrayList<>(out);
        }
    }

    /** 标签使用计数：条目聚合 + 注册表里的无主标签（count = 0） */
    public Map<String, Integer> tagCounts() {
        synchronized (lock) {
            Map<String, Integer> counts = new HashMap<>();
            for (Entry e : readAllEntries()) {
                for (String t : e.tags) {
                    counts.merge(t, 1, Integer::sum);
                }
            }
            for (Tag t : readConfig().tags) {
                counts.putIfAbsent(t.name, 0);
            }
            return counts;
        }
    }

    public List<Tag> tagMetas() {
        synchronized (lock) {
            return readConfig().tags;
        }
    }

    /** 注册标签；已存在只返回原色。名字清洗后为空 = 无事发生，返回传入的颜色。
     *  @return 标签颜色 */
    public String ensureTagMeta(String name, String color) throws IOException {
        synchronized (lock) {
            String clean = sanitizeTag(name);
            if (clean.isEmpty()) {
                return color;
            }
            Config cfg = readConfig();
            for (Tag t : cfg.tags) {
                if (t.name.equals(clean)) {
                    return t.color;
                }
            }
            cfg.tags.add(new Tag(clean, color));
            writeConfig(cfg);
            return color;
        }
    }

    /** 改标签颜色；标签没注册过就注册 */
    public void setTagColor(String name, String color) throws IOException {
        synchronized (lock) {
            if (name == null || name.isEmpty()) {
                return;
            }
            Config cfg = readConfig();
            for (int i = 0; i < cfg.tags.size(); i++) {
                if (cfg.tags.get(i).name.equals(name)) {
                    Tag recolored = cfg.tags.get(i).copy();
                    recolored.color = color;
                    cfg.tags.set(i, recolored);
                    writeConfig(cfg);
                    return;
                }
            }
            cfg.tags.add(new Tag(name, color));
            writeConfig(cfg);
        }
    }

    /** 全局重命名标签：改写全部带这个标签的条目与注册表。
     *  @return 改写的条目数；名字为空 = 0 */
    public int renameTag(String from, String to) throws IOException {
        synchronized (lock) {
            String clean = sanitizeTag(to);
            if (from.isEmpty() || clean.isEmpty()) {
                return 0;
            }
            int n = 0;
            for (Entry e : readAllEntries()) {
                if (!e.tags.contains(from)) {
                    continue;
                }
                Entry next = e.copy();
                next.tags = new ArrayList<>();
                for (String t : e.tags) {
                    String renamed = t.equals(from) ? clean : t;
                    if (!next.tags.contains(renamed)) {
                        next.tags.add(renamed);
                    }
                }
                next.updatedAt = System.currentTimeMillis();
                writeEntry(next);
                n++;
            }
            Config cfg = readConfig();
            boolean changed = false;
            for (int i = 0; i < cfg.tags.size(); i++) {
                if (cfg.tags.get(i).name.equals(from)) {
                    Tag renamed = cfg.tags.get(i).copy();
                    renamed.name = clean;
                    cfg.tags.set(i, renamed);
                    changed = true;
                }
            }
            if (changed) {
                writeConfig(cfg);
            }
            return n;
        }
    }

    /** 从全部条目移除标签，注册表里一并删除。
     *  @return 受影响的条目数 */
    public int deleteTag(String name) throws IOException {
        synchronized (lock) {
            if (name.isEmpty()) {
                return 0;
            }
            int n = 0;
            for (Entry e : readAllEntries()) {
                if (!e.tags.contains(name)) {
                    continue;
                }
                Entry next = e.copy();
                next.tags = new ArrayList<>();
                for (String t : e.tags) {
                    if (!t.equals(name)) {
                        next.tags.add(t);
                    }
                }
                next.updatedAt = System.currentTimeMillis();
                writeEntry(next);
                n++;
            }
            Config cfg = readConfig();
            if (cfg.tags.removeIf(t -> t.name.equals(name))) {
                writeConfig(cfg);
            }
            return n;
        }
    }

    /** 条目上出现过的项目名，排序去重 */
    public List<String> allProjects() {
        synchronized (lock) {
            Set<String> out = new TreeSet<>();
            for (Entry e : readAllEntries()) {
                if (!e.project.isEmpty()) {
                    out.add(e.project);
                }
            }
            return new ArrayList<>(out);
        }
    }

    // ───────────────────────── 收录用到的字段规则 ─────────────────────────

    /** 默认标题 = 文件名去扩展名；没有扩展名或以点开头的文件（.gitignore）取整个文件名 */
    public static String defaultTitle(Path file) {
        String base = file.getFileName().toString();
        int dot = base.lastIndexOf('.');
        return dot > 0 ? base.substring(0, dot) : base;
    }

    /** 扩展名，带点、小写（.md）；没有扩展名或以点开头的文件为空串 */
    public static String fileExtOf(Path file) {
        String base = file.getFileName().toString();
        int dot = base.lastIndexOf('.');
        return dot > 0 ? base.substring(dot).toLowerCase(Locale.ROOT) : "";
    }

    /** project = 源文件所在 git 仓的根目录名；不在 git 仓内（或没给 git、查询失败）取父目录名 */
    public static String projectNameOf(Path file, String gitExe, Consumer<Exception> onError) {
        Path dir = file.getParent();
        if (dir == null) {
            return "";
        }
        if (gitExe != null && !gitExe.isEmpty()) {
            try {
                String rootRaw = gitToplevel(dir, gitExe);
                if (rootRaw != null && !rootRaw.isEmpty()) {
                    Path name = Paths.get(rootRaw.replace('\\', '/')).toAbsolutePath().normalize().getFileName();
                    if (name != null) {
                        return name.toString();
                    }
                }
            }
            catch (Exception e) {
                if (onError != null) {
                    onError.accept(e);
                }
            }
        }
        Path parentName = dir.getFileName();
        return parentName == null ? "" : parentName.toString();
    }

    /** git rev-parse --show-toplevel 的输出（首尾空白去掉）；失败或超时返回 null */
    private static String gitToplevel(Path dir, String gitExe) throws Exception {
        ProcessBuilder pb = new ProcessBuilder(gitExe, "-c", "core.quotepath=off", "rev-parse", "--show-toplevel");
        pb.directory(dir.toFile());
        // 环境钉死：不进分页器、不写索引锁、输出不随 locale 变
        pb.environment().put("GIT_OPTIONAL_LOCKS", "0");
        pb.environment().put("GIT_PAGER", "cat");
        pb.environment().put("PAGER", "cat");
        pb.environment().put("TERM", "dumb");
        pb.environment().put("LC_ALL", "C");
        pb.environment().put("LANG", "C");
        pb.redirectErrorStream(true);
        Process p = pb.start();
        try {
            byte[] out;
            try {
                out = p.getInputStream().readAllBytes();
            }
            finally {
                p.getInputStream().close();
            }
            if (!p.waitFor(10, TimeUnit.SECONDS)) {
                p.destroyForcibly();
                return null;
            }
            if (p.exitValue() != 0) {
                return null;
            }
            return new String(out, StandardCharsets.UTF_8).trim();
        }
        finally {
            p.destroyForcibly();
        }
    }

    /** 标签清洗（单元素）：逗号、引号换成空格，去首尾空白 */
    public static String sanitizeTag(String raw) {
        if (raw == null) {
            return "";
        }
        return raw.trim().replace(',', ' ').replace('"', ' ').replace('，', ' ').trim();
    }

    /** 标签集合的清洗：逐个清洗、去空项、去重保序，最多 20 个 */
    public static List<String> sanitizeTags(List<String> tags) {
        Set<String> out = new LinkedHashSet<>();
        for (String t : tags) {
            String c = sanitizeTag(t);
            if (!c.isEmpty()) {
                out.add(c);
            }
            if (out.size() >= MAX_TAGS) {
                break;
            }
        }
        return new ArrayList<>(out);
    }

    /** 新建标签的自动配色：优先取没被占用的色板色（按色板顺序），用尽才取占用最少的 */
    public static String pickTagColor(List<Tag> existing) {
        int min = Integer.MAX_VALUE;
        int[] counts = new int[TAG_PALETTE.size()];
        for (int i = 0; i < TAG_PALETTE.size(); i++) {
            for (Tag t : existing) {
                if (TAG_PALETTE.get(i).equals(t.color)) {
                    counts[i]++;
                }
            }
            min = Math.min(min, counts[i]);
        }
        for (int i = 0; i < counts.length; i++) {
            if (counts[i] == min) {
                return TAG_PALETTE.get(i);
            }
        }
        return TAG_PALETTE.get(0);
    }

    // ───────────────────────── 路径与 id ─────────────────────────

    /** 判重键：反斜杠归一正斜杠 + Windows 下小写（不区分大小写的盘） */
    public static String normPath(String p) {
        String s = p == null ? "" : p.trim().replace('\\', '/');
        return WINDOWS ? s.toLowerCase(Locale.ROOT) : s;
    }

    /** 展示态路径：反斜杠归一正斜杠，保留大小写 */
    public static String displayPath(String p) {
        return p == null ? "" : p.trim().replace('\\', '/');
    }

    /**
     * 条目 id = 源路径判重键的 SHA-256 前 5 字节 hex：确定性 id——同一源文件摘除重加 id 恒定，
     * 外部脚本与引用缓存的 id 不失效。taken = 已被占用的 id：碰撞（约 2^-40）时按盐 "#"、"##"…
     * 递增重哈希，同样确定，不引入随机性。
     */
    public static String newId(String sourcePath, Set<String> taken) {
        String norm = normPath(sourcePath);
        String salt = "";
        while (true) {
            byte[] digest;
            try {
                digest = MessageDigest.getInstance("SHA-256").digest((norm + salt).getBytes(StandardCharsets.UTF_8));
            }
            catch (Exception e) {
                throw new IllegalStateException("SHA-256 unavailable", e);
            }
            StringBuilder sb = new StringBuilder("kb-");
            for (int i = 0; i < 5; i++) {
                sb.append(Character.forDigit((digest[i] >> 4) & 0xF, 16)).append(Character.forDigit(digest[i] & 0xF, 16));
            }
            String id = sb.toString();
            if (taken == null || !taken.contains(id)) {
                return id;
            }
            salt += "#";
        }
    }

    /** 目录 id：f- 前缀，与条目 id 区分 */
    public static String newFolderId() {
        byte[] bytes = new byte[4];
        new SecureRandom().nextBytes(bytes);
        StringBuilder sb = new StringBuilder("f-");
        for (byte b : bytes) {
            sb.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString();
    }

    // ───────────────────────── 文件读写 ─────────────────────────

    private Path entriesDir() {
        return root.resolve(KbContent.ENTRIES_DIR);
    }

    private Path configFile() {
        return root.resolve("config.json");
    }

    /** 合法条目文件名对应的 id，排序（.tmp 残留与异物挡在门外） */
    private List<String> entryIds() throws IOException {
        List<String> out = new ArrayList<>();
        Path dir = entriesDir();
        if (!Files.isDirectory(dir)) {
            return out;
        }
        try (DirectoryStream<Path> s = Files.newDirectoryStream(dir, "*.json")) {
            for (Path f : s) {
                String base = f.getFileName().toString();
                base = base.substring(0, base.length() - ".json".length());
                if (KbContent.isSafeId(base)) {
                    out.add(base);
                }
            }
        }
        out.sort(String::compareTo);
        return out;
    }

    private List<Entry> readAllEntries() {
        List<Entry> out = new ArrayList<>();
        List<String> ids;
        try {
            ids = entryIds();
        }
        catch (IOException e) {
            return out; // 目录扫不动按空库
        }
        for (String id : ids) {
            Entry e = readEntry(id);
            if (e != null) {
                out.add(e);
            }
        }
        return out;
    }

    /** 读条目；id 不合法、文件不存在、内容损坏都返回 null（单文件损坏只丢该条目，不炸全库） */
    private Entry readEntry(String id) {
        if (!KbContent.isSafeId(id)) {
            return null;
        }
        Path f = entriesDir().resolve(id + ".json");
        if (!Files.isRegularFile(f)) {
            return null;
        }
        try {
            return parseEntry(Files.readString(f));
        }
        catch (Exception e) {
            return null;
        }
    }

    private void writeEntry(Entry e) throws IOException {
        if (!KbContent.isSafeId(e.id)) {
            throw new IllegalArgumentException("unsafe entry id: " + e.id);
        }
        atomicWrite(entriesDir().resolve(e.id + ".json"), entryJson(e));
    }

    private Config readConfig() {
        Path f = configFile();
        if (!Files.isRegularFile(f)) {
            return new Config();
        }
        try {
            return parseConfig(Files.readString(f));
        }
        catch (Exception e) {
            return new Config(); // 损坏按空目录树：下次写盘即重建
        }
    }

    private void writeConfig(Config cfg) throws IOException {
        atomicWrite(configFile(), configJson(cfg));
    }

    /** 临时文件 + ATOMIC_MOVE（不支持原子移动的文件系统降级普通 move） */
    private void atomicWrite(Path target, String content) throws IOException {
        if (closed) {
            throw new IllegalStateException("knowledge base store is closed: " + root);
        }
        Files.createDirectories(target.getParent());
        Path tmp = target.resolveSibling(target.getFileName().toString() + ".tmp");
        Files.writeString(tmp, content);
        try {
            Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        }
        catch (AtomicMoveNotSupportedException e) {
            Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    // ───────────────────────── JSON：解析 ─────────────────────────
    // 读取口径与原来 IDE 侧的序列化库一致：只认已知键，缺的取默认值；必填字段缺失、类型不对、
    // 给了 null 都算损坏（抛异常，由调用方按单个文件隔离）。

    private static final class Config {
        int version = 2;
        List<Folder> folders = new ArrayList<>();
        List<Tag> tags = new ArrayList<>();
    }

    private static Entry parseEntry(String text) {
        Map<?, ?> m = objectOf(KbJson.parse(text));
        Entry e = new Entry();
        e.id = requiredString(m, "id");
        e.sourcePath = requiredString(m, "sourcePath");
        e.title = requiredString(m, "title");
        e.folderId = optionalString(m, "folderId", "");
        e.tags = optionalStrings(m, "tags");
        e.notes = optionalString(m, "notes", "");
        e.project = optionalString(m, "project", "");
        e.fileExt = optionalString(m, "fileExt", "");
        e.sizeBytes = optionalLong(m, "sizeBytes");
        e.contentHash = optionalString(m, "contentHash", "");
        e.ingestedAt = optionalLong(m, "ingestedAt");
        e.updatedAt = optionalLong(m, "updatedAt");
        e.order = optionalInt(m, "order");
        if (!KbContent.isSafeId(e.id)) {
            throw new IllegalArgumentException("unsafe entry id: " + e.id);
        }
        return e;
    }

    private static Config parseConfig(String text) {
        Map<?, ?> m = objectOf(KbJson.parse(text));
        Config c = new Config();
        c.version = m.containsKey("version") ? optionalInt(m, "version") : 2;
        List<?> folders = optionalList(m, "folders");
        for (Object o : folders) {
            Map<?, ?> fm = objectOf(o);
            Folder f = new Folder();
            f.id = requiredString(fm, "id");
            f.name = requiredString(fm, "name");
            // 空串与 null 同义（根级）：读的时候归一，写的时候统一写 null
            String parent = fm.containsKey("parentId") && fm.get("parentId") != null ? stringAt(fm, "parentId") : null;
            f.parentId = parent == null || parent.isEmpty() ? null : parent;
            f.order = optionalInt(fm, "order");
            c.folders.add(f);
        }
        List<?> tags = optionalList(m, "tags");
        for (Object o : tags) {
            Map<?, ?> tm = objectOf(o);
            c.tags.add(new Tag(requiredString(tm, "name"), requiredString(tm, "color")));
        }
        return c;
    }

    private static Map<?, ?> objectOf(Object v) {
        if (!(v instanceof Map)) {
            throw new IllegalArgumentException("expected an object");
        }
        return (Map<?, ?>) v;
    }

    private static String requiredString(Map<?, ?> m, String key) {
        if (!m.containsKey(key)) {
            throw new IllegalArgumentException("missing " + key);
        }
        return stringAt(m, key);
    }

    private static String stringAt(Map<?, ?> m, String key) {
        Object v = m.get(key);
        if (!(v instanceof String)) {
            throw new IllegalArgumentException("not a string: " + key);
        }
        return (String) v;
    }

    private static String optionalString(Map<?, ?> m, String key, String dflt) {
        return m.containsKey(key) ? stringAt(m, key) : dflt;
    }

    private static List<String> optionalStrings(Map<?, ?> m, String key) {
        List<String> out = new ArrayList<>();
        for (Object o : optionalList(m, key)) {
            if (!(o instanceof String)) {
                throw new IllegalArgumentException("not a string in " + key);
            }
            out.add((String) o);
        }
        return out;
    }

    private static List<?> optionalList(Map<?, ?> m, String key) {
        if (!m.containsKey(key)) {
            return List.of();
        }
        Object v = m.get(key);
        if (!(v instanceof List)) {
            throw new IllegalArgumentException("not an array: " + key);
        }
        return (List<?>) v;
    }

    /**
     * 数值字段：整数、小数、指数的写法都接受，带引号的数字（"2"）也接受，按截断取整；
     * 其他类型（字符串里不是数字、布尔、null）算损坏。
     */
    private static final java.util.regex.Pattern NUMERIC =
            java.util.regex.Pattern.compile("[+-]?(\\d+(\\.\\d*)?|\\.\\d+)([eE][+-]?\\d+)?");

    private static double numberAt(Map<?, ?> m, String key) {
        Object v = m.get(key);
        if (v instanceof Double) {
            return (Double) v;
        }
        if (v instanceof String && NUMERIC.matcher((String) v).matches()) {
            return Double.parseDouble((String) v);
        }
        throw new IllegalArgumentException("not a number: " + key);
    }

    private static long optionalLong(Map<?, ?> m, String key) {
        return m.containsKey(key) ? (long) numberAt(m, key) : 0L;
    }

    private static int optionalInt(Map<?, ?> m, String key) {
        return m.containsKey(key) ? (int) numberAt(m, key) : 0;
    }

    // ───────────────────────── JSON：写出 ─────────────────────────
    // 排版固定：逐字段一行、4 空格缩进、空数组写成 []、无尾换行。字段顺序即模型里的字段顺序。

    private static String entryJson(Entry e) {
        StringBuilder sb = new StringBuilder(512);
        sb.append("{\n");
        line(sb, 1, "id", KbJson.str(e.id));
        line(sb, 1, "sourcePath", KbJson.str(e.sourcePath));
        line(sb, 1, "title", KbJson.str(e.title));
        line(sb, 1, "folderId", KbJson.str(e.folderId));
        sb.append("    \"tags\": ");
        if (e.tags.isEmpty()) {
            sb.append("[],\n");
        } else {
            sb.append("[\n");
            for (int i = 0; i < e.tags.size(); i++) {
                sb.append("        ").append(KbJson.str(e.tags.get(i))).append(i < e.tags.size() - 1 ? ",\n" : "\n");
            }
            sb.append("    ],\n");
        }
        line(sb, 1, "notes", KbJson.str(e.notes));
        line(sb, 1, "project", KbJson.str(e.project));
        line(sb, 1, "fileExt", KbJson.str(e.fileExt));
        line(sb, 1, "sizeBytes", String.valueOf(e.sizeBytes));
        line(sb, 1, "contentHash", KbJson.str(e.contentHash));
        line(sb, 1, "ingestedAt", String.valueOf(e.ingestedAt));
        line(sb, 1, "updatedAt", String.valueOf(e.updatedAt));
        sb.append("    \"order\": ").append(e.order).append("\n");
        sb.append("}");
        return sb.toString();
    }

    private static String configJson(Config c) {
        StringBuilder sb = new StringBuilder(512);
        sb.append("{\n");
        line(sb, 1, "version", String.valueOf(c.version));
        sb.append("    \"folders\": ");
        if (c.folders.isEmpty()) {
            sb.append("[],\n");
        } else {
            sb.append("[\n");
            for (int i = 0; i < c.folders.size(); i++) {
                Folder f = c.folders.get(i);
                sb.append("        {\n");
                line(sb, 3, "id", KbJson.str(f.id));
                line(sb, 3, "name", KbJson.str(f.name));
                line(sb, 3, "parentId", f.parentId == null ? "null" : KbJson.str(f.parentId));
                sb.append("            \"order\": ").append(f.order).append("\n");
                sb.append("        }").append(i < c.folders.size() - 1 ? ",\n" : "\n");
            }
            sb.append("    ],\n");
        }
        sb.append("    \"tags\": ");
        if (c.tags.isEmpty()) {
            sb.append("[]\n");
        } else {
            sb.append("[\n");
            for (int i = 0; i < c.tags.size(); i++) {
                Tag t = c.tags.get(i);
                sb.append("        {\n");
                line(sb, 3, "name", KbJson.str(t.name));
                sb.append("            \"color\": ").append(KbJson.str(t.color)).append("\n");
                sb.append("        }").append(i < c.tags.size() - 1 ? ",\n" : "\n");
            }
            sb.append("    ]\n");
        }
        sb.append("}");
        return sb.toString();
    }

    /** 一行字符串字段（后面还有字段）：缩进 + "键": 值 + 逗号换行 */
    private static void line(StringBuilder sb, int depth, String key, String jsonValue) {
        sb.append("    ".repeat(depth)).append('"').append(key).append("\": ").append(jsonValue).append(",\n");
    }

    private static boolean notBlank(String s) {
        return s != null && !s.trim().isEmpty();
    }

    private static long fileSize(Path f) {
        try {
            return Files.size(f);
        }
        catch (IOException e) {
            return 0L;
        }
    }
}
