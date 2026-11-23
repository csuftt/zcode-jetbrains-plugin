package com.zcode.kb.core;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.OffsetDateTime;
import java.time.temporal.ChronoUnit;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * 知识库的 git 同步——IDE 侧调用的唯一实现（纯 Java）。整个库目录是一个 git 仓库的工作区，
 * 每次同步对应知识库在那一刻的完整状态（目录树、标签、条目信息、全部文档快照）。
 *
 * 同步 = 暂存变化 → 有变化才提交 → 取远端并变基 → 有未推送的提交才推送。只用暂存、提交、
 * 变基、推送四类操作：不硬重置、不清理未跟踪文件（检索缓存与本机缓存靠忽略规则排除）。
 * 变基冲突自动中止，回到同步前的状态（本地提交保留），冲突文件回报给调用方，不自动选边。
 *
 * 依赖系统 git、用户的 git 身份与系统 git 的凭证机制（凭证管理器或 SSH），本类不托管凭证。
 * 远端地址就是仓库的 origin；没有 origin 视为未配置远端。
 */
public final class KbSync {

    private KbSync() {
    }

    public enum Outcome { PUSHED, UP_TO_DATE }

    public enum Failure {
        /** 未配置远端（仓库没有 origin） */
        NO_REMOTE,
        /** git 不可用（找不到可执行文件） */
        GIT_UNAVAILABLE,
        /** 提交之后、变基之前工作区又出现变化（多为 MCP server 恰好写入），重试即可 */
        WORKTREE_DIRTY,
        /** 变基冲突，已中止并回到同步前；conflicts 为冲突文件 */
        CONFLICT,
        /** 本地库与远端历史不相干（本地有内容却没有历史，或两边各有独立历史） */
        UNRELATED_HISTORIES,
        /** git 没有配置提交身份（user.name / user.email） */
        IDENTITY_MISSING,
        /** 其他 git 失败，detail 带 git 的输出 */
        GIT_FAILED
    }

    public static final class Result {
        public final Outcome outcome;
        /** 本次推送的提交数 */
        public final int pushedCommits;
        /** 本次是否取回了远端的新提交 */
        public final boolean pulled;

        Result(Outcome outcome, int pushedCommits, boolean pulled) {
            this.outcome = outcome;
            this.pushedCommits = pushedCommits;
            this.pulled = pulled;
        }

        @Override
        public String toString() {
            return outcome + " pushed=" + pushedCommits + " pulled=" + pulled;
        }
    }

    public static final class SyncException extends Exception {
        private static final long serialVersionUID = 1L;

        public final Failure failure;
        public final List<String> conflicts;
        public final String detail;

        SyncException(Failure failure, String detail, List<String> conflicts) {
            super(failure + (detail == null || detail.isEmpty() ? "" : ": " + detail));
            this.failure = failure;
            this.detail = detail == null ? "" : detail;
            this.conflicts = conflicts == null ? new ArrayList<>() : conflicts;
        }
    }

    /** 进版本历史的路径（其余文件即使落在库目录里也不提交） */
    private static final String[] VERSIONED = {".gitignore", ".gitattributes", "config.json", "entries", "snapshots"};

    /** .git 里决定「有没有东西没提交、没推送」的状态文件（引用目录 refs 另行递归） */
    private static final String[] REPO_STATE_FILES = {"HEAD", "index", "config", "packed-refs", "FETCH_HEAD", "ORIG_HEAD"};

    private static final String GITIGNORE =
            "# ZC GUI knowledge base: rebuildable or machine-local files never enter history\n"
                    + "/text/\n"
                    + "/.local-cache\n"
                    + "/restored/\n"
                    + "/kb.db\n"
                    + "# Library content is always versioned, even if another ignore file (e.g. a global\n"
                    + "# gitignore with *.log or *.json) matches it. Keep these before the *.tmp rule.\n"
                    + "!/.gitignore\n"
                    + "!/.gitattributes\n"
                    + "!/config.json\n"
                    + "!/entries/**\n"
                    + "!/snapshots/**\n"
                    + "*.tmp\n";

    private static final String GITATTRIBUTES =
            "# Keep bytes identical: no end-of-line conversion anywhere in this repository\n"
                    + "* -text\n"
                    + "# Document snapshots are opaque byte copies: never line-merged, no conflict markers inside\n"
                    + "snapshots/** -text -diff -merge\n";

    private static final int LOCAL_TIMEOUT = 30;
    private static final int FETCH_TIMEOUT = 120;
    private static final int PUSH_TIMEOUT = 180;

    private static final boolean WINDOWS =
            System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("windows");

    private static final Pattern EMPTY_FOLDERS = Pattern.compile("\"folders\"\\s*:\\s*\\[\\s*\\]");
    private static final Pattern EMPTY_TAGS = Pattern.compile("\"tags\"\\s*:\\s*\\[\\s*\\]");

    // ───────────────────────── 对外入口 ─────────────────────────

    /**
     * 执行一次同步。首次同步：初始化仓库、写入仓库属性与忽略规则、提交并推送，分支名跟随
     * 远端的默认分支（手工建的裸仓多半是 master，托管平台多是 main），之后克隆才能直接检出。
     * 本地库为空而远端已有历史时（换了一台电脑：填上同一个远端、点同步），直接接入远端历史，
     * 整个库取回到当前位置。未配置远端时不初始化仓库。
     */
    public static Result sync(Path root, String gitExe) throws SyncException {
        Path repo = normalize(root);
        // 没有远端就没有可同步的对象：不初始化仓库（仓库在配置远端时才建）
        if (!isRepository(repo) || remoteUrlOf(new Git(gitExe, repo)) == null) {
            throw fail(Failure.NO_REMOTE, null);
        }
        Git g = new Git(gitExe, repo);
        requireGit(g);
        initRepoIfNeeded(repo, g);
        writeRepoFiles(repo);
        String branch = currentBranch(g);
        if (branch == null) {
            throw fail(Failure.GIT_FAILED, "HEAD is detached; check out a branch first");
        }
        // --prune：远端地址改指别的仓库后，旧仓库留下的远端跟踪引用要清掉，否则会被当成
        // 「远端有同名分支」而误判两边一致（只清 refs/remotes 下的引用，不动本地分支与工作区）
        must(g, "fetch", FETCH_TIMEOUT, "fetch", "--quiet", "--prune", "origin");
        boolean localHasHead = hasHead(g);
        boolean pulled = false;

        // 远端上与本库对应的分支：通常是同名分支；远端没有同名分支时，首次推送跟随远端的
        // 默认分支名，本地改过分支名时认它的默认分支
        String tracked = branch;
        if (!refExists(g, originRef(tracked))) {
            String def = remoteDefaultBranch(g);
            if (!localHasHead) {
                if (def != null && !def.equals(branch)) {
                    if (hasHead(g)) {
                        must(g, "rename branch", "branch", "-m", def);
                    } else {
                        must(g, "rename branch", "symbolic-ref", "HEAD", "refs/heads/" + def);
                    }
                    branch = def;
                    tracked = def;
                }
            } else if (remoteHasBranches(g)) {
                // 远端有别的分支却没有同名分支：只有远端默认分支是本地历史的祖先时才对得上
                // （比如本地把分支改了名），否则两边不相干，不在远端制造第二条平行分支
                if (def == null || !isAncestor(g, originRef(def), "HEAD")) {
                    throw fail(Failure.UNRELATED_HISTORIES,
                            "the remote has no branch '" + branch + "' (default branch: " + def
                                    + ") and its history is unrelated to the local one");
                }
                tracked = def;
            }
        }

        if (!localHasHead && refExists(g, originRef(tracked))) {
            // 远端已有历史而本地从未提交过：只有本地库为空才接入，否则是两边不相干
            // （先于提交判断，免得把本地可再生的文件先提交成一个孤零零的提交）
            if (!libraryIsEmpty(repo)) {
                    throw fail(Failure.UNRELATED_HISTORIES,
                            "local library has content but no history while the remote has history");
            }
            adoptRemote(g, repo, tracked);
            return new Result(Outcome.UP_TO_DATE, 0, true);
        }

        List<String[]> staged = stage(g, repo, trackedFiles(g));
        if (!staged.isEmpty()) {
            commit(g, staged);
        }

        if (!refExists(g, originRef(tracked))) {
            // 远端还没有这个分支：本地有东西就推上去
            if (!hasHead(g)) {
                return new Result(Outcome.UP_TO_DATE, 0, false); // 空库对空远端
            }
            push(g, branch, tracked);
            return new Result(Outcome.PUSHED, count(g, "rev-list", "--count", "HEAD"), false);
        }
        String mergeBase = g.run(LOCAL_TIMEOUT, "merge-base", "HEAD", originRef(tracked)).out.trim();
        if (mergeBase.isEmpty()) {
            throw fail(Failure.UNRELATED_HISTORIES,
                    "local and remote histories are unrelated; handle them manually in git");
        }
        int behind = count(g, "rev-list", "--count", "HEAD.." + originRef(tracked));
        if (behind > 0) {
            requireCleanWorktree(g, repo);
            String headBefore = g.run(LOCAL_TIMEOUT, "rev-parse", "HEAD").out.trim();
            rebase(g, originRef(tracked));
            pulled = true;
            dropStaleText(g, repo, headBefore);
        }
        int ahead = count(g, "rev-list", "--count", originRef(tracked) + "..HEAD");
        if (ahead == 0) {
            return new Result(Outcome.UP_TO_DATE, 0, pulled);
        }
        push(g, branch, tracked);
        return new Result(Outcome.PUSHED, ahead, pulled);
    }

    /**
     * 取回的提交改了哪些文档快照，对应条目的检索缓存就作废（缓存是从上一次的文档快照提取的）。
     * 变基已结束、文件全部落盘，这时作废，重建时才不会读到写了一半的文件。
     */
    private static void dropStaleText(Git g, Path repo, String headBefore) {
        Exec d = g.run(LOCAL_TIMEOUT, "diff", "--name-only", headBefore, "HEAD");
        if (d.ok()) {
            KbContent.afterPull(repo, Arrays.asList(d.out.split("\n")));
        }
        // diff 失败（极少见）：缓存留到下次这条文档快照再变时再作废
    }

    private static String originRef(String branch) {
        return "refs/remotes/origin/" + branch;
    }

    private static boolean hasHead(Git g) {
        return g.run(LOCAL_TIMEOUT, "rev-parse", "--verify", "--quiet", "HEAD").ok();
    }

    private static boolean refExists(Git g, String ref) {
        return g.run(LOCAL_TIMEOUT, "rev-parse", "--verify", "--quiet", ref).ok();
    }

    /**
     * 远端的默认分支；查不到返回 null。ls-remote --symref 对空仓库不会广告未诞生的 HEAD
     * （手工 git init --bare 的裸仓正是这种情况，它的 HEAD 多半叫 master），这时退而裸克隆
     * 一份——空仓克隆下来只有元数据——读它的 HEAD，用完即删。
     */
    private static String remoteDefaultBranch(Git g) {
        Exec r = g.run(FETCH_TIMEOUT, "ls-remote", "--symref", "origin", "HEAD");
        if (r.ok()) {
            for (String line : r.out.split("\n")) {
                if (line.startsWith("ref: refs/heads/")) {
                    String name = line.substring("ref: refs/heads/".length()).trim();
                    int sp = name.indexOf('\t');
                    if (sp >= 0) {
                        name = name.substring(0, sp);
                    }
                    name = name.trim();
                    if (!name.isEmpty()) {
                        return name;
                    }
                }
            }
        }
        return probeEmptyRemoteDefault(g);
    }

    private static String probeEmptyRemoteDefault(Git g) {
        String url = remoteUrlOf(g);
        if (url == null) {
            return null;
        }
        Path probe = null;
        try {
            probe = Files.createTempDirectory("zcgui-kb-probe-"); // 放系统临时目录，不落进库目录
            Exec c = g.run(FETCH_TIMEOUT, "clone", "--quiet", "--bare", "--", url, probe.toString());
            if (!c.ok()) {
                return null;
            }
            String head = Files.readString(probe.resolve("HEAD"), StandardCharsets.UTF_8).trim();
            return head.startsWith("ref: refs/heads/") ? head.substring("ref: refs/heads/".length()).trim() : null;
        } catch (IOException e) {
            return null;
        } finally {
            if (probe != null) {
                try {
                    deleteTree(probe);
                } catch (IOException ignore) {
                    // 探针目录留在系统临时目录里，无害
                }
            }
        }
    }

    /** 远端有没有任何分支（本地已取回的远端跟踪引用，不含 origin/HEAD） */
    private static boolean remoteHasBranches(Git g) {
        Exec r = g.run(LOCAL_TIMEOUT, "for-each-ref", "--format=%(refname)", "refs/remotes/origin");
        if (!r.ok()) {
            return false;
        }
        for (String line : r.out.split("\n")) {
            String ref = line.trim();
            if (!ref.isEmpty() && !ref.endsWith("/HEAD")) {
                return true;
            }
        }
        return false;
    }

    private static boolean isAncestor(Git g, String ancestor, String descendant) {
        return g.run(LOCAL_TIMEOUT, "merge-base", "--is-ancestor", ancestor, descendant).ok();
    }

    /** 「待同步」：库里有未提交或未推送的变化。不是仓库、或未配置远端时恒为 false */
    public static boolean hasUnsyncedChanges(Path root, String gitExe) {
        Path repo = normalize(root);
        if (!isRepository(repo)) {
            return false;
        }
        Git g = new Git(gitExe, repo);
        String remote = remoteUrlOf(g);
        if (remote == null) {
            return false;
        }
        String[] paths = versionedPaths(repo, trackedFiles(g));
        if (paths.length > 0) {
            Exec st = g.run(LOCAL_TIMEOUT, statusArgs(paths));
            if (st.code != 0) {
                return false; // git 不可用或仓库异常：不误报
            }
            if (!st.out.trim().isEmpty()) {
                return true;
            }
        }
        if (!g.run(LOCAL_TIMEOUT, "rev-parse", "--verify", "--quiet", "HEAD").ok()) {
            return false;
        }
        String branch = currentBranch(g);
        if (branch == null) {
            return false;
        }
        String upstream = upstreamOf(g, branch);
        if (upstream == null) {
            return true; // 本地有提交，远端还没有这个分支
        }
        return count(g, "rev-list", "--count", upstream + "..HEAD") > 0;
    }

    /**
     * 库内容与仓库状态的指纹：同步会提交的全部文件（递归到文件），加上 .git 里的状态文件与全部
     * 引用。任一文件的修改时间或大小变了、有文件增删，指纹就变；不进历史的文件（检索缓存、本机
     * 缓存）不影响它。「待同步」一次要起好几个 git 进程，调用方按这个指纹判断上次的结果还能不能
     * 沿用——只按时间缓存的话，刚同步完、刚改完条目的那一瞬沿用的是变化之前的旧结果。
     */
    public static String changeStamp(Path root) {
        Path repo = normalize(root);
        StringBuilder sb = new StringBuilder(8192);
        sb.append(repo).append('\n');
        for (String p : VERSIONED) {
            stampTree(repo, repo.resolve(p), sb);
        }
        Path git = repo.resolve(".git");
        for (String f : REPO_STATE_FILES) {
            stampFile(repo, git.resolve(f), sb);
        }
        stampTree(repo, git.resolve("refs"), sb);
        return sb.toString();
    }

    private static void stampTree(Path repo, Path file, StringBuilder sb) {
        stampFile(repo, file, sb);
        if (!Files.isDirectory(file)) {
            return;
        }
        List<Path> children = new ArrayList<>();
        try (Stream<Path> st = Files.list(file)) {
            st.forEach(children::add);
        } catch (IOException e) {
            return; // 列不出目录：目录自身的时间已记下（增删子项会改它），子项内容的变化这一轮看不到
        }
        Collections.sort(children);
        for (Path c : children) {
            stampTree(repo, c, sb);
        }
    }

    private static void stampFile(Path repo, Path file, StringBuilder sb) {
        sb.append(repo.relativize(file)).append('=');
        try {
            BasicFileAttributes a = Files.readAttributes(file, BasicFileAttributes.class);
            sb.append(a.lastModifiedTime().toMillis()).append(':').append(a.size());
        } catch (IOException e) {
            sb.append('-'); // 不存在或读不到
        }
        sb.append('\n');
    }

    /**
     * 「待同步」的结果缓存（界面角标用）。以 {@link #changeStamp} 为准：库内容与仓库状态都没变、
     * 且在时效内才沿用上次的结果；指纹变了立刻重算，不受时效限制。
     */
    public static final class PendingCache {
        private final long ttlMillis;
        private String stamp;
        private boolean value;
        private long checkedAt;

        public PendingCache(long ttlMillis) {
            this.ttlMillis = ttlMillis;
        }

        /** 库里有未提交或未推送的变化（不是仓库 / 未配置远端 = false） */
        public synchronized boolean get(Path root, String gitExe) {
            String now = changeStamp(root);
            long time = System.currentTimeMillis();
            if (now.equals(stamp) && time - checkedAt < ttlMillis) {
                return value;
            }
            value = hasUnsyncedChanges(root, gitExe);
            stamp = now;
            checkedAt = time;
            return value;
        }

        /**
         * 自上次计算后库内容或仓库状态变过才重算（没变不起 git 进程）。
         *
         * @return 本次是否重算且结果翻转。没有库文件事件可听的变化——另一个 IDE 同步过、远端地址
         *         在别处改过——靠调用方按它刷新界面
         */
        public synchronized boolean flippedIfChanged(Path root, String gitExe) {
            if (changeStamp(root).equals(stamp)) {
                return false;
            }
            boolean before = value;
            return get(root, gitExe) != before;
        }
    }

    public static boolean isRepository(Path root) {
        return Files.exists(normalize(root).resolve(".git"));
    }

    /** origin 的地址；没有 origin 返回 null */
    public static String remoteUrl(Path root, String gitExe) {
        Path repo = normalize(root);
        if (!isRepository(repo)) {
            return null;
        }
        return remoteUrlOf(new Git(gitExe, repo));
    }

    private static String remoteUrlOf(Git g) {
        Exec r = g.run(LOCAL_TIMEOUT, "remote", "get-url", "origin");
        String url = r.ok() ? r.out.trim() : "";
        return url.isEmpty() ? null : url;
    }

    /**
     * 设置远端地址（空 = 清除 origin）。仓库还不存在时先初始化（提交与推送仍由首次同步完成）。
     * @return null = 成功；非空 = 失败原因
     */
    public static String setRemoteUrl(Path root, String gitExe, String url) {
        Path repo = normalize(root);
        String trimmed = url == null ? "" : url.trim();
        if (!trimmed.isEmpty() && !isValidRemoteUrl(trimmed)) {
            return "invalid remote url";
        }
        Git g = new Git(gitExe, repo);
        if (g.run(LOCAL_TIMEOUT, "--version").code == -2) {
            return "git is not available";
        }
        try {
            initRepoIfNeeded(repo, g);
            writeRepoFiles(repo);
            String current = remoteUrlOf(g);
            if (trimmed.isEmpty()) {
                if (current != null) {
                    must(g, "remote remove", "remote", "remove", "origin");
                }
            } else if (current == null) {
                must(g, "remote add", "remote", "add", "origin", trimmed);
            } else if (!current.equals(trimmed)) {
                must(g, "remote set-url", "remote", "set-url", "origin", trimmed);
            }
            return null;
        } catch (SyncException e) {
            return e.detail;
        }
    }

    /** 远端地址的基本合法性：非空、不含空白与控制字符（具体形态交给 git 判断） */
    public static boolean isValidRemoteUrl(String url) {
        if (url == null || url.isEmpty()) {
            return false;
        }
        for (int i = 0; i < url.length(); i++) {
            if (Character.isWhitespace(url.charAt(i)) || url.charAt(i) < 0x20) {
                return false;
            }
        }
        return true;
    }

    // ───────────────────────── 仓库准备 ─────────────────────────

    private static Path normalize(Path root) {
        return root.toAbsolutePath().normalize();
    }

    private static void requireGit(Git g) throws SyncException {
        if (g.run(LOCAL_TIMEOUT, "--version").code == -2) {
            throw fail(Failure.GIT_UNAVAILABLE, g.exe);
        }
    }

    /** 仓库不存在时初始化，默认分支 main；已存在的仓库（含 .git 是文件的形态）原样不动 */
    private static void initRepoIfNeeded(Path repo, Git g) throws SyncException {
        if (Files.exists(repo.resolve(".git"))) {
            return;
        }
        try {
            Files.createDirectories(repo);
        } catch (IOException e) {
            throw fail(Failure.GIT_FAILED, e.toString());
        }
        must(g, "init", "init", "--quiet");
        must(g, "set default branch", "symbolic-ref", "HEAD", "refs/heads/main");
    }

    /** 仓库属性与忽略规则缺失时写入；已存在的（例如克隆下来的）不覆盖 */
    private static void writeRepoFiles(Path repo) throws SyncException {
        try {
            writeFileIfAbsent(repo.resolve(".gitignore"), GITIGNORE);
            writeFileIfAbsent(repo.resolve(".gitattributes"), GITATTRIBUTES);
        } catch (IOException e) {
            throw fail(Failure.GIT_FAILED, e.toString());
        }
    }

    private static void writeFileIfAbsent(Path file, String content) throws IOException {
        if (!Files.exists(file)) {
            Files.writeString(file, content, StandardCharsets.UTF_8);
        }
    }

    // ───────────────────────── 暂存与提交 ─────────────────────────

    /** 当前被跟踪的文件路径（相对仓根，正斜杠） */
    private static Set<String> trackedFiles(Git g) {
        Exec r = g.run(LOCAL_TIMEOUT, "ls-files");
        Set<String> out = new HashSet<>();
        if (r.ok()) {
            for (String line : r.out.split("\n")) {
                if (!line.isEmpty()) {
                    out.add(line.trim());
                }
            }
        }
        return out;
    }

    /** 本次要暂存的路径：磁盘上在的，或索引里还有记录的（后者为了把整目录被删的删除也暂存上） */
    private static String[] versionedPaths(Path repo, Set<String> tracked) {
        List<String> paths = new ArrayList<>();
        for (String p : VERSIONED) {
            boolean onDisk = Files.exists(repo.resolve(p));
            boolean inIndex = false;
            for (String t : tracked) {
                if (t.equals(p) || t.startsWith(p + "/")) {
                    inIndex = true;
                    break;
                }
            }
            if (onDisk || inIndex) {
                paths.add(p);
            }
        }
        return paths.toArray(new String[0]);
    }

    /**
     * 暂存全部变化（仅限库内容路径——库目录里的其他文件不进历史）。
     * @return 已暂存的变化 [状态, 路径]，空表示没有变化
     */
    private static List<String[]> stage(Git g, Path repo, Set<String> tracked) throws SyncException {
        String[] paths = versionedPaths(repo, tracked);
        if (paths.length == 0) {
            return new ArrayList<>();
        }
        List<String> add = new ArrayList<>();
        add.add("add");
        add.add("-A");
        add.add("--");
        add.addAll(Arrays.asList(paths));
        must(g, "stage", LOCAL_TIMEOUT, add);
        Exec d = g.run(LOCAL_TIMEOUT, "diff", "--cached", "--name-status");
        if (!d.ok()) {
            throw fail(Failure.GIT_FAILED, brief(d));
        }
        List<String[]> staged = new ArrayList<>();
        for (String line : d.out.split("\n")) {
            int tab = line.indexOf('\t');
            if (tab <= 0) {
                continue;
            }
            String status = line.substring(0, tab);
            String rest = line.substring(tab + 1);
            if (status.startsWith("R") || status.startsWith("C")) {
                // 重命名/复制：旧路径按删除、新路径按新增计
                int lastTab = rest.lastIndexOf('\t');
                staged.add(new String[]{"D", lastTab >= 0 ? rest.substring(0, lastTab) : rest});
                staged.add(new String[]{"A", lastTab >= 0 ? rest.substring(lastTab + 1) : rest});
            } else {
                staged.add(new String[]{status.substring(0, 1), rest});
            }
        }
        return staged;
    }

    /** 提交信息：首行是同步时间，正文是各区域的变化概况 */
    private static void commit(Git g, List<String[]> staged) throws SyncException {
        Map<String, int[]> areas = new LinkedHashMap<>();
        for (String[] s : staged) {
            areas.computeIfAbsent(areaOf(s[1]), k -> new int[3])[columnOf(s[0])]++;
        }
        StringBuilder body = new StringBuilder();
        for (Map.Entry<String, int[]> e : areas.entrySet()) {
            int[] n = e.getValue();
            body.append(e.getKey()).append(": ");
            List<String> parts = new ArrayList<>();
            if (n[0] > 0) {
                parts.add("+" + n[0]);
            }
            if (n[1] > 0) {
                parts.add("~" + n[1]);
            }
            if (n[2] > 0) {
                parts.add("-" + n[2]);
            }
            body.append(String.join(" ", parts)).append('\n');
        }
        String subject = "sync " + OffsetDateTime.now().truncatedTo(ChronoUnit.SECONDS)
                .format(DateTimeFormatter.ISO_OFFSET_DATE_TIME);
        Exec c = g.run(LOCAL_TIMEOUT, "commit", "--quiet", "-m", subject, "-m", body.toString().trim());
        if (c.ok()) {
            return;
        }
        String text = c.err + "\n" + c.out;
        if (text.contains("tell me who you are") || text.contains("unable to auto-detect email address")) {
            throw fail(Failure.IDENTITY_MISSING, brief(c));
        }
        throw fail(Failure.GIT_FAILED, brief(c));
    }

    private static String areaOf(String path) {
        if (path.startsWith("snapshots/")) {
            return "snapshots";
        }
        if (path.startsWith("entries/")) {
            return "entries";
        }
        if (path.equals("config.json")) {
            return "config.json";
        }
        return "repository files";
    }

    private static int columnOf(String status) {
        switch (status) {
            case "A":
                return 0;
            case "D":
                return 2;
            default:
                return 1;
        }
    }

    // ───────────────────────── 取远端、变基、推送 ─────────────────────────

    private static String currentBranch(Git g) {
        Exec r = g.run(LOCAL_TIMEOUT, "symbolic-ref", "--quiet", "--short", "HEAD");
        return r.ok() ? r.out.trim() : null;
    }

    /** 当前分支的上游（本地已有的远端跟踪引用）；拿不到返回 null */
    private static String upstreamOf(Git g, String branch) {
        Exec u = g.run(LOCAL_TIMEOUT, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}");
        if (u.ok() && !u.out.trim().isEmpty()) {
            return u.out.trim();
        }
        String ref = "refs/remotes/origin/" + branch;
        return g.run(LOCAL_TIMEOUT, "rev-parse", "--verify", "--quiet", ref).ok() ? ref : null;
    }

    private static int count(Git g, String... args) {
        Exec r = g.run(LOCAL_TIMEOUT, args);
        try {
            return r.ok() ? Integer.parseInt(r.out.trim()) : 0;
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    /** 变基前工作区必须是干净的：库内容路径上不能有未提交的变化 */
    private static void requireCleanWorktree(Git g, Path repo) throws SyncException {
        String[] paths = versionedPaths(repo, trackedFiles(g));
        if (paths.length == 0) {
            return;
        }
        Exec st = g.run(LOCAL_TIMEOUT, statusArgs(paths));
        if (st.ok() && !st.out.trim().isEmpty()) {
            throw fail(Failure.WORKTREE_DIRTY, "uncommitted changes appeared while syncing; sync again");
        }
    }

    /** git status 的参数：只看库内容路径上的变化 */
    private static List<String> statusArgs(String[] paths) {
        List<String> cmd = new ArrayList<>();
        cmd.add("status");
        cmd.add("--porcelain");
        cmd.add("--");
        cmd.addAll(Arrays.asList(paths));
        return cmd;
    }

    /** 变基到远端；冲突时中止并回报冲突文件，工作区回到同步前 */
    private static void rebase(Git g, String onto) throws SyncException {
        Exec r = g.run(FETCH_TIMEOUT, "rebase", "--empty=drop", "--quiet", onto);
        if (!r.ok() && (r.err.contains("--empty") || r.out.contains("--empty"))) {
            r = g.run(FETCH_TIMEOUT, "rebase", "--quiet", onto); // 旧版 git 不认 --empty=drop
        }
        if (r.ok()) {
            return;
        }
        if (rebaseInProgress(g)) {
            List<String> conflicts = new ArrayList<>();
            Exec u = g.run(LOCAL_TIMEOUT, "diff", "--name-only", "--diff-filter=U");
            if (u.ok()) {
                for (String line : u.out.split("\n")) {
                    if (!line.trim().isEmpty()) {
                        conflicts.add(line.trim());
                    }
                }
            }
            g.run(LOCAL_TIMEOUT, "rebase", "--abort");
            throw new SyncException(Failure.CONFLICT, null, conflicts);
        }
        throw fail(Failure.GIT_FAILED, "rebase failed: " + brief(r));
    }

    private static boolean rebaseInProgress(Git g) {
        for (String marker : new String[]{"rebase-merge", "rebase-apply"}) {
            Exec p = g.run(LOCAL_TIMEOUT, "rev-parse", "--git-path", marker);
            if (!p.ok() || p.out.trim().isEmpty()) {
                continue;
            }
            Path path = Paths.get(p.out.trim());
            Path cwd = g.cwd();
            if (!path.isAbsolute() && cwd != null) {
                path = cwd.resolve(path);
            }
            if (Files.exists(path)) {
                return true;
            }
        }
        return false;
    }

    /** 推送本地分支 branch 到远端的 remoteBranch（通常同名），并建立上游跟踪 */
    private static void push(Git g, String branch, String remoteBranch) throws SyncException {
        must(g, "push", PUSH_TIMEOUT, "push", "--quiet", "--set-upstream", "origin",
                branch + ":refs/heads/" + remoteBranch);
    }

    // ───────────────────────── 接入远端历史 ─────────────────────────

    /** 本地库是否为空：没有条目、没有快照、config 里没有目录与标签 */
    static boolean libraryIsEmpty(Path repo) {
        Path entries = repo.resolve(KbContent.ENTRIES_DIR);
        if (Files.isDirectory(entries, LinkOption.NOFOLLOW_LINKS)) {
            try (DirectoryStream<Path> s = Files.newDirectoryStream(entries)) {
                for (Path p : s) {
                    if (Files.isRegularFile(p)) {
                        return false;
                    }
                }
            } catch (IOException ignore) {
                return false; // 扫不动按非空处理，宁可拒绝接入
            }
        }
        Path snapshots = repo.resolve(KbContent.SNAPSHOTS_DIR);
        if (Files.isDirectory(snapshots, LinkOption.NOFOLLOW_LINKS)) {
            try (DirectoryStream<Path> s = Files.newDirectoryStream(snapshots)) {
                if (s.iterator().hasNext()) {
                    return false;
                }
            } catch (IOException ignore) {
                return false;
            }
        }
        Path config = repo.resolve("config.json");
        if (Files.isRegularFile(config)) {
            try {
                String text = Files.readString(config, StandardCharsets.UTF_8);
                return EMPTY_FOLDERS.matcher(text).find() && EMPTY_TAGS.matcher(text).find();
            } catch (IOException e) {
                return false;
            }
        }
        return true;
    }

    /** 像不像一个知识库仓库（接入既有克隆的判据）：有 .git，且有 entries 目录或 config.json */
    public static boolean looksLikeLibrary(Path dir) {
        Path d = normalize(dir);
        return Files.exists(d.resolve(".git"))
                && (Files.isDirectory(d.resolve("entries")) || Files.isRegularFile(d.resolve("config.json")));
    }

    /** 本地无历史、库为空：清掉可再生成的本地文件，直接检出到远端分支（同时建立上游跟踪） */
    private static void adoptRemote(Git g, Path repo, String branch) throws SyncException {
        try {
            Files.deleteIfExists(repo.resolve("config.json"));
            Files.deleteIfExists(repo.resolve(".gitignore"));
            Files.deleteIfExists(repo.resolve(".gitattributes"));
        } catch (IOException e) {
            throw fail(Failure.GIT_FAILED, e.toString());
        }
        must(g, "checkout", "checkout", "--quiet", "-B", branch, "origin/" + branch);
    }

    /** 探针目录用完即删（git 对象文件只读，先去只读） */
    private static void deleteTree(Path p) throws IOException {
        if (Files.isDirectory(p, LinkOption.NOFOLLOW_LINKS)) {
            try (DirectoryStream<Path> s = Files.newDirectoryStream(p)) {
                for (Path c : s) {
                    deleteTree(c);
                }
            }
        }
        if (WINDOWS) {
            p.toFile().setWritable(true);
        }
        Files.deleteIfExists(p);
    }

    // ───────────────────────── git 进程 ─────────────────────────

    private static SyncException fail(Failure failure, String detail) {
        return new SyncException(failure, detail, null);
    }

    /** 失败即抛；detail 取 git 的输出（stderr 优先） */
    private static void must(Git g, String what, int timeoutSec, String... args) throws SyncException {
        must(g, what, timeoutSec, Arrays.asList(args));
    }

    private static void must(Git g, String what, int timeoutSec, List<String> args) throws SyncException {
        Exec r = g.run(timeoutSec, args);
        if (!r.ok()) {
            throw fail(Failure.GIT_FAILED, what + " failed: " + brief(r));
        }
    }

    private static void must(Git g, String what, String... args) throws SyncException {
        must(g, what, LOCAL_TIMEOUT, args);
    }

    /** git 输出截短（首尾空白去掉，最多 600 字符），给用户看的失败原因 */
    private static String brief(Exec r) {
        String text = (r.err == null || r.err.trim().isEmpty() ? r.out : r.err).trim();
        if (r.code == -1) {
            return "timed out" + (text.isEmpty() ? "" : " (" + text + ")");
        }
        return text.length() > 600 ? text.substring(0, 600) + "…" : text;
    }

    private static final class Exec {
        /** 退出码；-1 超时，-2 进程没起来 */
        final int code;
        final String out;
        final String err;

        Exec(int code, String out, String err) {
            this.code = code;
            this.out = out;
            this.err = err;
        }

        boolean ok() {
            return code == 0;
        }
    }

    /**
     * 在库目录里跑 git。环境钉死防分页器、锁与编码噪音；清掉可能从宿主进程继承的
     * GIT_DIR / GIT_WORK_TREE 等变量；关闭终端提示（没有终端可答，挂到超时不如直接失败）。
     */
    private static final class Git {
        final String exe;
        final Path dir;

        Git(String exe, Path dir) {
            this.exe = exe == null || exe.trim().isEmpty() ? "git" : exe.trim();
            this.dir = dir;
        }

        /**
         * git 的实际工作目录：库目录还不存在时（git init 之前）退到最近的已存在的上级目录，
         * 否则进程起不来，会被误报成「git 不可用」。每次运行时现算——同一个 Git 对象会跨越
         * 「库目录从无到有」。
         */
        private Path cwd() {
            Path d = dir;
            while (d != null && !Files.isDirectory(d)) {
                d = d.getParent();
            }
            return d;
        }

        Exec run(int timeoutSec, String... args) {
            return run(timeoutSec, Arrays.asList(args));
        }

        Exec run(int timeoutSec, List<String> args) {
            List<String> cmd = new ArrayList<>();
            cmd.add(exe);
            cmd.add("-c");
            cmd.add("core.quotepath=off");
            cmd.addAll(args);
            try {
                ProcessBuilder pb = new ProcessBuilder(cmd);
                Path cwd = cwd();
                if (cwd != null) {
                    pb.directory(cwd.toFile());
                }
                Map<String, String> env = pb.environment();
                for (String k : new String[]{"GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_NAMESPACE"}) {
                    env.remove(k);
                }
                env.put("GIT_PAGER", "cat");
                env.put("PAGER", "cat");
                env.put("TERM", "dumb");
                env.put("LC_ALL", "C");
                env.put("LANG", "C");
                env.put("GIT_OPTIONAL_LOCKS", "0");
                env.put("GIT_TERMINAL_PROMPT", "0");
                pb.redirectErrorStream(false);
                Process p = pb.start();
                p.getOutputStream().close();
                ByteArrayOutputStream errBuf = new ByteArrayOutputStream();
                Thread errDrain = new Thread(() -> {
                    try {
                        p.getErrorStream().transferTo(errBuf);
                    } catch (IOException ignore) {
                        // 进程被杀
                    }
                }, "zcgui-kb-git-err");
                errDrain.setDaemon(true);
                errDrain.start();
                byte[] out = p.getInputStream().readAllBytes();
                boolean done = p.waitFor(timeoutSec, TimeUnit.SECONDS);
                if (!done) {
                    p.destroyForcibly();
                    return new Exec(-1, "", "timed out after " + timeoutSec + "s");
                }
                errDrain.join(2000);
                return new Exec(p.exitValue(), utf8(out), utf8(errBuf.toByteArray()));
            } catch (IOException | InterruptedException e) {
                if (e instanceof InterruptedException) {
                    Thread.currentThread().interrupt();
                }
                return new Exec(-2, "", e.toString());
            }
        }

        private static String utf8(byte[] bytes) {
            return new String(bytes, StandardCharsets.UTF_8);
        }
    }
}
