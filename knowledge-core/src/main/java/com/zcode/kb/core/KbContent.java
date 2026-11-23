package com.zcode.kb.core;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 知识库的文档快照、解析规则、对账与检索缓存——IDE 与 MCP server 共用的唯一实现（纯 Java，
 * 两侧都只经本类读写 snapshots/、text/ 与本机缓存，不各自判断）。
 *
 * 库目录布局（库根 = root）：
 * <pre>
 * entries/<id>.json          条目元数据（contentHash / sizeBytes 由对账经 [ContentSink] 落盘）
 * snapshots/<id>/<原文件名>   文档快照：源文件原始字节，逐字节、不规范化
 * text/<id>.txt               检索缓存：提取文本，可重建，不进版本历史
 * .local-cache                本机缓存：每条目源文件的 (mtime, size)，只作快速跳过条件，不进版本历史
 * </pre>
 *
 * 解析规则（[resolve]，所有读取出口共用）：源文件是普通文件 → 读源文件；否则有文档快照 →
 * 读文档快照；否则失效。状态一律读取时现算，不落盘。
 *
 * 对账（[reconcile]）以内容哈希为准：修改时间与大小命中本机缓存才跳过；源文件内容变了就
 * 覆盖文档快照并经 [ContentSink] 更新条目；内容没变只更新本机缓存，条目文件不动（两台机器
 * 修改时间不同也不会互相改写条目）。
 *
 * 文档快照不依赖 git：不配置同步时照常生成和使用。
 */
public final class KbContent {

    private KbContent() {
    }

    /** 文本提取器：两侧各自提供（IDE 用 KbExtractor，MCP server 用反射调用加降级）。返回 null = 无正文 */
    @FunctionalInterface
    public interface TextExtractor {
        String extract(Path file) throws Exception;
    }

    /** 对账入参：条目的内容视图。contentHash 为空表示尚未确认过内容版本 */
    public static final class Source {
        public final String id;
        public final String sourcePath;
        public final String contentHash;

        public Source(String id, String sourcePath, String contentHash) {
            this.id = id;
            this.sourcePath = sourcePath;
            this.contentHash = contentHash == null ? "" : contentHash;
        }
    }

    /**
     * 内容版本落盘口。IDE 侧走库锁内的读改写（只改 contentHash / sizeBytes），MCP 与测试用纯文件实现。
     *
     * 不动 updatedAt：同一处源文件的变化常被两台电脑各自对账到（对账自动跑、同步要手点），两边写下的
     * 条目必须逐字节相同，后同步的那台才不会撞上冲突。updatedAt 只跟随收录与整理这类元数据编辑。
     */
    @FunctionalInterface
    public interface ContentSink {
        void contentConfirmed(String id, String contentHash, long sizeBytes);
    }

    /** 解析状态：正常（源文件在）/ 仅文档快照 / 失效 */
    public enum State { SOURCE, SNAPSHOT, MISSING }

    /** [resolve] 的结果；state 为 MISSING 时 path 为 null */
    public static final class Resolved {
        public final State state;
        public final Path path;

        Resolved(State state, Path path) {
            this.state = state;
            this.path = path;
        }

        @Override
        public String toString() {
            return state + (path == null ? "" : " " + path);
        }
    }

    /** [capture] 的结果：内容哈希、字节数与采集时刻的源文件修改时间 */
    public static final class Captured {
        public final String hash;
        public final long size;
        public final long mtime;

        Captured(String hash, long size, long mtime) {
            this.hash = hash;
            this.size = size;
            this.mtime = mtime;
        }
    }

    public static final String ENTRIES_DIR = "entries";
    public static final String SNAPSHOTS_DIR = "snapshots";
    public static final String TEXT_DIR = "text";
    static final String LOCAL_CACHE_FILE = ".local-cache";

    private static final boolean WINDOWS =
            System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("windows");

    /** Windows 保留设备名（带不带扩展名都不可作文件名） */
    private static final Pattern WINDOWS_RESERVED =
            Pattern.compile("(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\\..*)?");

    /** 拼路径前的 id 白名单（kb- 前缀 + 小写 hex，防路径穿越） */
    public static boolean isSafeId(String id) {
        if (id == null || !id.startsWith("kb-") || id.length() <= 3) {
            return false;
        }
        for (int i = 3; i < id.length(); i++) {
            char c = id.charAt(i);
            if (c != '-' && !(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f')) {
                return false;
            }
        }
        return true;
    }

    /** 状态取值（MCP kb_list / kb_search 的 status 字段）：ok | snapshot | missing */
    public static String statusCode(State state) {
        switch (state) {
            case SOURCE:
                return "ok";
            case SNAPSHOT:
                return "snapshot";
            default:
                return "missing";
        }
    }

    // ───────────────────────── 路径 ─────────────────────────

    public static Path snapshotsDir(Path root) {
        return root.resolve(SNAPSHOTS_DIR);
    }

    public static Path textFile(Path root, String id) {
        return root.resolve(TEXT_DIR).resolve(id + ".txt");
    }

    public static Path localCacheFile(Path root) {
        return root.resolve(LOCAL_CACHE_FILE);
    }

    static Path snapshotDir(Path root, String id) {
        return root.resolve(SNAPSHOTS_DIR).resolve(id);
    }

    /**
     * 文档快照落点：snapshots/<id>/<源文件名>。源文件名在当前文件系统上非法（非法字符、保留
     * 设备名，多见于另一台机器收录的条目）或整条路径过长时，回退为 <id><扩展名>。
     */
    public static Path snapshotFile(Path root, String id, String sourcePath) {
        Path dir = snapshotDir(root, id);
        return dir.resolve(snapshotNames(dir, id, sourcePath).get(0));
    }

    /** 候选文件名，按优先序：合法的原文件名在前，回退名在后 */
    private static List<String> snapshotNames(Path dir, String id, String sourcePath) {
        String full = fileNameOf(sourcePath);
        int dot = full.lastIndexOf('.');
        String fallback = id + (dot >= 0 ? full.substring(dot).toLowerCase(Locale.ROOT) : "");
        List<String> names = new ArrayList<>(2);
        if (isLegalFileName(full) && !tooLong(dir.resolve(full))) {
            names.add(full);
        }
        if (!names.contains(fallback)) {
            names.add(fallback);
        }
        return names;
    }

    /** Windows 的传统路径上限（260 含结尾空字符）：留足余量，超长的回退成短名 */
    private static boolean tooLong(Path file) {
        return WINDOWS && file.toString().length() > 240;
    }

    private static String fileNameOf(String sourcePath) {
        if (sourcePath == null) {
            return "";
        }
        String s = sourcePath;
        int cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
        return cut >= 0 ? s.substring(cut + 1) : s;
    }

    static boolean isLegalFileName(String name) {
        if (name.isEmpty() || name.equals(".") || name.equals("..") || name.indexOf('/') >= 0 || name.indexOf('\0') >= 0) {
            return false;
        }
        if (!WINDOWS) {
            return name.getBytes(StandardCharsets.UTF_8).length <= 255;
        }
        if (name.endsWith(".") || name.endsWith(" ")) {
            return false;
        }
        for (int i = 0; i < name.length(); i++) {
            char c = name.charAt(i);
            if (c < 0x20 || "<>:\"\\|?*".indexOf(c) >= 0) {
                return false;
            }
        }
        return !WINDOWS_RESERVED.matcher(name).matches();
    }

    // ───────────────────────── 解析 ─────────────────────────

    /**
     * 这条条目现在读哪个文件：源文件是普通文件读源文件；否则有文档快照读文档快照；否则失效。
     * 所有读取出口（打开、定位、发送、检索缓存生成、MCP 列表与读全文）都走这里。
     */
    public static Resolved resolve(Path root, String id, String sourcePath) {
        Path src = existingFile(sourcePath);
        if (src != null) {
            return new Resolved(State.SOURCE, src);
        }
        Path snap = isSafeId(id) ? existingSnapshot(root, id, sourcePath) : null;
        return snap != null ? new Resolved(State.SNAPSHOT, snap) : new Resolved(State.MISSING, null);
    }

    private static Path existingFile(String path) {
        if (path == null || path.isEmpty()) {
            return null;
        }
        try {
            Path p = Path.of(path);
            return Files.isRegularFile(p) ? p : null;
        } catch (java.nio.file.InvalidPathException e) {
            return null; // 另一台机器写下的路径在本机非法
        }
    }

    /** 已存在的文档快照文件（原文件名或回退名）。不跟随符号链接：快照只认库内的普通文件 */
    private static Path existingSnapshot(Path root, String id, String sourcePath) {
        Path dir = snapshotDir(root, id);
        for (String name : snapshotNames(dir, id, sourcePath)) {
            try {
                Path p = dir.resolve(name);
                if (Files.isRegularFile(p, LinkOption.NOFOLLOW_LINKS)) {
                    return p;
                }
            } catch (java.nio.file.InvalidPathException ignore) {
                // 该候选名在本机非法，试下一个
            }
        }
        return null;
    }

    // ───────────────────────── 文档快照 ─────────────────────────

    /**
     * 从源文件落文档快照（收录与重新链接时调用）：逐字节复制，不规范化；返回内容哈希与大小，
     * 并记本机缓存。快照目录一条目只留一份——重新链接到改名后的文件时旧文件名的副本随之清掉。
     * 源文件不存在或不可读抛 IOException，由调用方决定是否继续收录。
     */
    public static Captured capture(Path root, String id, String sourcePath) throws IOException {
        if (!isSafeId(id)) {
            throw new IOException("unsafe entry id: " + id);
        }
        Path src = Path.of(sourcePath);
        BasicFileAttributes attrs = Files.readAttributes(src, BasicFileAttributes.class);
        String hash = sha256Hex(src);
        copySnapshot(src, snapshotFile(root, id, sourcePath));
        LocalCache.update(root, id, attrs.lastModifiedTime().toMillis(), attrs.size(), hash);
        return new Captured(hash, attrs.size(), attrs.lastModifiedTime().toMillis());
    }

    /** 摘除条目：删除其文档快照目录（已同步的内容仍在 git 历史里） */
    public static void deleteSnapshot(Path root, String id) {
        if (!isSafeId(id)) {
            return;
        }
        Path dir = snapshotDir(root, id);
        if (!Files.isDirectory(dir, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        try (DirectoryStream<Path> s = Files.newDirectoryStream(dir)) {
            for (Path p : s) {
                if (Files.isRegularFile(p, LinkOption.NOFOLLOW_LINKS)) {
                    makeWritable(p);
                    Files.deleteIfExists(p);
                }
            }
        } catch (IOException ignore) {
            // 删不掉的副本留给对账的孤儿清理
        }
        try {
            Files.deleteIfExists(dir);
        } catch (IOException ignore) {
            // 同上
        }
    }

    private static void copySnapshot(Path src, Path target) throws IOException {
        Files.createDirectories(target.getParent());
        Path tmp = target.resolveSibling(target.getFileName().toString() + ".tmp");
        Files.copy(src, tmp, StandardCopyOption.REPLACE_EXISTING);
        atomicMove(tmp, target);
        Path dir = target.getParent();
        String kept = target.getFileName().toString();
        List<Path> stale = new ArrayList<>();
        try (DirectoryStream<Path> s = Files.newDirectoryStream(dir)) {
            for (Path p : s) {
                if (Files.isRegularFile(p, LinkOption.NOFOLLOW_LINKS) && !p.getFileName().toString().equals(kept)) {
                    stale.add(p);
                }
            }
        }
        for (Path p : stale) {
            makeWritable(p);
            Files.deleteIfExists(p);
        }
    }

    // ───────────────────────── 检索缓存 ─────────────────────────

    /**
     * 检索缓存在则读回；缺失按解析规则即时重建（源文件在从源文件建，否则从文档快照建）。
     * 失效条目一律返回 null——没有内容来源，残留的旧缓存不能当正文用。
     */
    public static String ensureText(Path root, String id, String sourcePath, TextExtractor extractor) {
        if (!isSafeId(id) || resolve(root, id, sourcePath).state == State.MISSING) {
            return null;
        }
        String cached = readTextFile(textFile(root, id));
        return cached != null ? cached : rebuildText(root, id, sourcePath, extractor);
    }

    /**
     * 强制重建检索缓存（「重建索引」用）。返回写入的文本；失效返回 null。
     * 无正文（格式不支持、解析失败、超大）落空缓存，与收录时同口径——否则每轮对账都会重试。
     */
    public static String rebuildText(Path root, String id, String sourcePath, TextExtractor extractor) {
        if (!isSafeId(id)) {
            return null;
        }
        Path text = textFile(root, id);
        Resolved r = resolve(root, id, sourcePath);
        if (r.state == State.MISSING) {
            try {
                Files.deleteIfExists(text);
            } catch (IOException ignore) {
                // 留给孤儿清理
            }
            return null;
        }
        String body = safeExtract(extractor, r.path);
        if (body == null) {
            if (!readable(r.path)) {
                return null; // 瞬时读失败（占用等）：不落盘，下次再试
            }
            body = "";
        }
        try {
            atomicWrite(text, body);
        } catch (IOException e) {
            return null;
        }
        return body;
    }

    // ───────────────────────── 对账 ─────────────────────────

    /**
     * 全库对账一轮。逐条：源文件在 → 内容哈希变了就重提取、覆盖文档快照并经 sink 更新条目，
     * 没变只更新本机缓存；源文件不在 → 有文档快照就补检索缓存。末尾清理孤儿（没有条目的
     * 快照目录与检索缓存）。返回本轮有实际动作的条目数（内容版本变化、快照或检索缓存补齐）。
     *
     * 「现在该读到什么」以解析规则为准：同步取回的文档快照变了，检索缓存由 [afterPull] 作废、这里重建；
     * 条目的内容版本被远端换过之后本机源文件才跟上的，按本机缓存记的版本判断缓存要不要重建。
     */
    public static int reconcile(Path root, List<Source> sources, TextExtractor extractor, ContentSink sink) {
        LocalCache cache = LocalCache.load(root);
        boolean cacheDirty = false;
        int activity = 0;
        Set<String> live = new HashSet<>();
        for (Source s : sources) {
            if (!isSafeId(s.id)) {
                continue;
            }
            live.add(s.id);
            Path src = existingFile(s.sourcePath);
            Path text = textFile(root, s.id);
            boolean textExists = Files.isRegularFile(text);
            if (src == null) {
                if (cache.get(s.id) != null) {
                    cache.remove(s.id);
                    cacheDirty = true;
                }
                boolean hasSnapshot = existingSnapshot(root, s.id, s.sourcePath) != null;
                if (textExists && !hasSnapshot) {
                    // 既没有源文件也没有文档快照：残留的检索缓存是过时正文，清掉
                    try {
                        Files.delete(text);
                        activity++;
                    } catch (IOException ignore) {
                        // 下轮再清
                    }
                } else if (!textExists && hasSnapshot
                        && rebuildText(root, s.id, s.sourcePath, extractor) != null) {
                    activity++;
                }
                continue;
            }
            BasicFileAttributes attrs = stat(src);
            if (attrs == null) {
                continue; // 读取间隙被移走或占用：下轮再看
            }
            long mtime = attrs.lastModifiedTime().toMillis();
            long size = attrs.size();
            boolean hashKnown = !s.contentHash.isEmpty();
            Path snap = existingSnapshot(root, s.id, s.sourcePath);
            LocalCache.Stamp cached = cache.get(s.id);
            // 源文件自上次确认后没动过：本机读到的内容没变
            boolean untouched = hashKnown && cached != null && cached.mtime == mtime && cached.size == size;
            if (untouched && snap != null) {
                if (textExists) {
                    continue; // 本机快速跳过
                }
                // 检索缓存没了（同步取回新文档快照后作废的）：从本机源文件重建。源文件没动过就不算
                // 本机的内容变化，条目与文档快照保持取回来的样子，不拿本机的旧源文件盖回去
                if (rebuildText(root, s.id, s.sourcePath, extractor) != null) {
                    activity++;
                }
                continue;
            }
            String hash = sha256Hex(src);
            if (hash == null) {
                continue; // 读不了：下轮再看
            }
            try {
                String textVersion = hash; // 这一轮之后检索缓存对应的内容版本
                if (hashKnown && hash.equals(s.contentHash)) {
                    // 内容没变，只是修改时间变了，或快照、检索缓存缺了：条目不动
                    if (snap == null) {
                        copySnapshot(src, snapshotFile(root, s.id, s.sourcePath));
                        activity++;
                    }
                    // 检索缓存不是按这个版本提取的（缺了、本机缓存没记版本、或条目的版本被远端换过）：重建
                    if ((!textExists || cached == null || !hash.equals(cached.textVersion))
                            && rebuildText(root, s.id, s.sourcePath, extractor) != null) {
                        activity++;
                    }
                } else {
                    // 内容版本变化（hashKnown）或首次补齐 contentHash（!hashKnown）
                    String body = null;
                    if (hashKnown || !textExists) {
                        body = safeExtract(extractor, src);
                        if (body == null && !textExists) {
                            body = readable(src) ? "" : null; // 提取失败且没有旧缓存：可读=确无正文
                        }
                    }
                    // body 为 null：沿用旧缓存文本（仅补 hash，或提取失败保留旧正文）
                    copySnapshot(src, snapshotFile(root, s.id, s.sourcePath));
                    if (body != null) {
                        atomicWrite(text, body);
                    } else if (hashKnown && cached != null) {
                        textVersion = cached.textVersion; // 提取失败、旧正文留着：它对应的还是原来的版本
                    }
                    sink.contentConfirmed(s.id, hash, size);
                    activity++;
                }
                cache.put(s.id, mtime, size, textVersion);
                cacheDirty = true;
            } catch (IOException e) {
                // 写盘失败（磁盘满、占用）：不记缓存，下轮重试
            }
        }
        activity += cleanupOrphans(root, live);
        if (cache.retain(live)) {
            cacheDirty = true;
        }
        if (cacheDirty) {
            cache.save();
        }
        return activity;
    }

    /**
     * 同步取回远端变化之后调用（changedPaths 是这次取回改动的仓库相对路径）：文档快照变过的条目，
     * 检索缓存随之作废——缓存是从上一次的文档快照提取的，内容换了它就是过时正文，而本机没有源文件
     * 的条目只能靠它检索和读全文。之后的对账按解析规则重建：源文件不在本机的从新快照建，在的从
     * 本机源文件建。必须在取回全部落盘之后调用，否则会从写到一半的文件里提取。
     */
    public static void afterPull(Path root, List<String> changedPaths) {
        Set<String> ids = new HashSet<>();
        String prefix = SNAPSHOTS_DIR + "/";
        for (String p : changedPaths) {
            if (p == null || !p.startsWith(prefix)) {
                continue;
            }
            int end = p.indexOf('/', prefix.length());
            String id = end < 0 ? "" : p.substring(prefix.length(), end);
            if (isSafeId(id)) {
                ids.add(id);
            }
        }
        for (String id : ids) {
            try {
                Files.deleteIfExists(textFile(root, id));
            } catch (IOException ignore) {
                // 删不掉：这一条暂时读旧缓存，下次它的文档快照再变时再试
            }
        }
    }

    /** 没有条目的快照目录与检索缓存：删。只认 id 形态的目录名与文件名，别的一概不碰 */
    static int cleanupOrphans(Path root, Set<String> liveIds) {
        int n = 0;
        Path snapRoot = snapshotsDir(root);
        if (Files.isDirectory(snapRoot, LinkOption.NOFOLLOW_LINKS)) {
            List<Path> dirs = new ArrayList<>();
            try (DirectoryStream<Path> s = Files.newDirectoryStream(snapRoot)) {
                for (Path p : s) {
                    // 条目文件还在就绝不动它的快照（条目损坏不等于条目不存在）
                    if (Files.isDirectory(p, LinkOption.NOFOLLOW_LINKS)
                            && isSafeId(p.getFileName().toString())
                            && !liveIds.contains(p.getFileName().toString())
                            && !Files.exists(root.resolve(ENTRIES_DIR).resolve(p.getFileName() + ".json"))) {
                        dirs.add(p);
                    }
                }
            } catch (IOException ignore) {
                // 扫不动就算了
            }
            for (Path d : dirs) {
                deleteSnapshot(root, d.getFileName().toString());
                n++;
            }
        }
        Path textDir = root.resolve(TEXT_DIR);
        if (Files.isDirectory(textDir, LinkOption.NOFOLLOW_LINKS)) {
            List<Path> files = new ArrayList<>();
            try (DirectoryStream<Path> s = Files.newDirectoryStream(textDir)) {
                for (Path p : s) {
                    String name = p.getFileName().toString();
                    if (Files.isRegularFile(p, LinkOption.NOFOLLOW_LINKS) && name.endsWith(".txt")
                            && !liveIds.contains(name.substring(0, name.length() - 4))) {
                        files.add(p);
                    }
                }
            } catch (IOException ignore) {
                // 同上
            }
            for (Path f : files) {
                try {
                    Files.deleteIfExists(f);
                    n++;
                } catch (IOException ignore) {
                    // 同上
                }
            }
        }
        return n;
    }

    // ───────────────────────── 本机缓存 ─────────────────────────

    /**
     * 本机缓存：每条目一行 id=mtime:size:contentHash 的纯文本——源文件上次确认时的 mtime 与 size
     * （对账的快速跳过条件），以及检索缓存是按哪个内容版本（contentHash）提取的。只在本机有意义，
     * 不进仓库；损坏按空处理（下轮全量重算哈希），没有第三段的旧行按「版本未知」处理。
     */
    static final class LocalCache {
        private static final Object LOCK = new Object();

        /** 源文件上次确认时的 mtime / size，以及检索缓存对应的内容版本（未知为空串） */
        static final class Stamp {
            final long mtime;
            final long size;
            final String textVersion;

            Stamp(long mtime, long size, String textVersion) {
                this.mtime = mtime;
                this.size = size;
                this.textVersion = textVersion == null ? "" : textVersion;
            }
        }

        private final Path file;
        private final Map<String, Stamp> entries = new LinkedHashMap<>();

        private LocalCache(Path root) {
            this.file = localCacheFile(root);
        }

        static LocalCache load(Path root) {
            LocalCache c = new LocalCache(root);
            if (!Files.isRegularFile(c.file)) {
                return c;
            }
            try {
                for (String line : Files.readAllLines(c.file, StandardCharsets.UTF_8)) {
                    int eq = line.indexOf('=');
                    int sep = line.indexOf(':', eq + 1);
                    if (eq <= 0 || sep < 0) {
                        continue;
                    }
                    int last = line.indexOf(':', sep + 1);
                    try {
                        c.entries.put(line.substring(0, eq), new Stamp(
                                Long.parseLong(line.substring(eq + 1, sep)),
                                Long.parseLong(line.substring(sep + 1, last < 0 ? line.length() : last)),
                                last < 0 ? null : line.substring(last + 1)));
                    } catch (NumberFormatException ignore) {
                        // 坏行跳过
                    }
                }
            } catch (IOException ignore) {
                // 读不了按空处理
            }
            return c;
        }

        /** 单条更新并立即落盘（收录、重新链接用）：收录时检索缓存与文档快照出自同一份源文件 */
        static void update(Path root, String id, long mtime, long size, String textVersion) {
            synchronized (LOCK) {
                LocalCache c = load(root);
                c.entries.put(id, new Stamp(mtime, size, textVersion));
                c.saveLocked();
            }
        }

        Stamp get(String id) {
            return entries.get(id);
        }

        void put(String id, long mtime, long size, String textVersion) {
            entries.put(id, new Stamp(mtime, size, textVersion));
        }

        void remove(String id) {
            entries.remove(id);
        }

        /** 只保留仍有条目的 id；@return 是否有删减 */
        boolean retain(Set<String> ids) {
            return entries.keySet().retainAll(ids);
        }

        void save() {
            synchronized (LOCK) {
                saveLocked();
            }
        }

        private void saveLocked() {
            StringBuilder sb = new StringBuilder();
            sb.append("# ZC GUI knowledge base machine-local cache: entry id = source m millis : size bytes : content hash the text cache was built for\n");
            for (Map.Entry<String, Stamp> e : entries.entrySet()) {
                Stamp s = e.getValue();
                sb.append(e.getKey()).append('=').append(s.mtime).append(':').append(s.size).append(':')
                        .append(s.textVersion).append('\n');
            }
            try {
                atomicWrite(file, sb.toString());
            } catch (IOException ignore) {
                // 本机缓存写不进去只是下轮多算一次哈希
            }
        }
    }

    // ───────────────────────── 内部 ─────────────────────────

    private static BasicFileAttributes stat(Path p) {
        try {
            return Files.readAttributes(p, BasicFileAttributes.class);
        } catch (IOException e) {
            return null;
        }
    }

    /** 流式 SHA-256（hex）；读失败返回 null */
    private static String sha256Hex(Path p) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            try (InputStream in = Files.newInputStream(p)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) >= 0) {
                    md.update(buf, 0, n);
                }
            }
            StringBuilder sb = new StringBuilder(64);
            for (byte b : md.digest()) {
                sb.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
            }
            return sb.toString();
        } catch (Exception e) {
            return null;
        }
    }

    private static String safeExtract(TextExtractor extractor, Path file) {
        try {
            return extractor.extract(file);
        } catch (Exception e) {
            return null;
        }
    }

    /** 文件此刻能否读出字节（区分「确无正文」与「瞬时读失败」） */
    private static boolean readable(Path p) {
        try (InputStream in = Files.newInputStream(p)) {
            in.read();
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    private static String readTextFile(Path f) {
        if (!Files.isRegularFile(f)) {
            return null;
        }
        try {
            return Files.readString(f, StandardCharsets.UTF_8);
        } catch (IOException e) {
            return null;
        }
    }

    private static void atomicWrite(Path target, String content) throws IOException {
        Files.createDirectories(target.getParent());
        Path tmp = target.resolveSibling(target.getFileName().toString() + ".tmp");
        Files.writeString(tmp, content, StandardCharsets.UTF_8);
        atomicMove(tmp, target);
    }

    /** 不支持原子移动的文件系统降级普通移动 */
    private static void atomicMove(Path tmp, Path target) throws IOException {
        try {
            Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (java.nio.file.AtomicMoveNotSupportedException e) {
            Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    /** git 对象文件等只读文件删除前先去只读 */
    private static void makeWritable(Path p) {
        if (WINDOWS) {
            p.toFile().setWritable(true);
        }
    }
}
