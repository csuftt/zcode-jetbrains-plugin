---
name: zcgui-knowledge
description: "Use only for the ZC-GUI plugin's knowledge base (ZC GUI 知识库, the documents collected into ~/.zcgui/knowledge/ via the IDE plugin): explicit requests to search, browse or reorganize that collection (检索/整理/归类/移动/打标签 ZC GUI 知识库). NOT for Obsidian vaults, other note apps, separately installed knowledge MCPs or skills, or general file/web search — those have their own tools. If the user says just 知识库 but context points to their own vault or another tool, prefer that tool."
---

# Knowledge Base (ZC-GUI)

The user's personal knowledge base **of the ZC-GUI plugin**: documents
collected from their projects via the IDE plugin (markdown/word/pdf/html/log/
code notes), stored as pointer entries under `~/.zcgui/knowledge`. Tools are
the `mcp__zcgui-knowledge__*` family.

Scope guard: this collection only. If the user means another knowledge store
(Obsidian vault, RAG server, a different knowledge MCP or skill), use that
tool instead — do not funnel those requests here.

- Entries reference source files and the knowledge base keeps a byte-exact
  **document snapshot** of each file (kept up to date as the source changes).
  **Deleting an entry never touches the file on disk** — it only removes the
  entry, its search cache and the stored snapshot.
- Every entry carries a `status`, computed when it is read:
  - `ok` — the source file is present; `contentPath` is the source file.
  - `snapshot` — the source file is missing on this machine (deleted, renamed,
    on another branch, or on another computer). Content comes from the stored
    snapshot, which **may be out of date** — say so when you quote it, and do
    not claim it reflects the current file.
  - `missing` — neither the source file nor a snapshot exists; nothing to read.
  Open files via `contentPath` (the file to actually read now), not `sourcePath`.
- Retrieval covers titles, tags and body text (CJK and latin mixed supported).
- `kb_add` collects a document the same way the IDE does: the source stays where
  it is, and a snapshot copy is stored inside the knowledge base.

## Search flow

1. When the user asks to consult their collected documents, or the question
   clearly maps to them (past solutions, conventions, deployment steps),
   `kb_search` first. Free-text query; add `folder` / `tag` / `project`
   filters when the user names one.
2. `kb_read` the relevant hits (id from search/list) before answering; the
   result includes title/folder/tags/source path, and says in the header when
   the text comes from a stored snapshot. If text is truncated, open the content
   file with your regular file tools via its `contentPath`.

## Organizing flow (整理 / 归类 / 移动 / 打标签 / tidying)

1. `kb_tree` first — folders with entry counts (subtree counts included),
   root-level count, and the tag registry. **Never guess folder paths**; use
   exactly the paths kb_tree reports.
2. `kb_list(folder: "...")` to see the entries and their current tags inside
   a folder.
3. Re-file with `kb_entry` `move` (batch ids into a folder path; empty
   folderPath = root level).
4. Tagging with `kb_entry` `update`: `tags` **replaces the full tag set** —
   to append, read current tags via kb_list and merge yourself before
   sending. `title` renames one entry only (single id). `notes` is free
   annotation (empty string clears). `sourcePath` re-points one entry to a
   new absolute file path (single id; re-extracts its text from the new file
   and refreshes the stored snapshot, id/title/folder/tags stay) — use it when
   the real source file moved, e.g. an entry showing `snapshot` status should
   follow its original file again.
5. New tag needed? `kb_tag` `create` first (auto-assigns a display color);
   `kb_tag` `rename` / `delete` rewrite every entry carrying the tag.
6. Folders: `kb_folder` `create` builds paths level by level (`a/b/c`);
   `move` re-parents and refuses to move a folder into its own subtree;
   `delete` removes the folder and sub-folders but moves their entries to the
   root level (entries are never deleted by a folder delete).
7. Destructive actions (`kb_entry` `delete`, `kb_folder` `delete`) apply
   immediately with no confirmation prompt: state the scope and get the
   user's go-ahead first when more than a couple of entries are involved.
   Entry ids come only from kb_search/kb_list output — never invent ids.
   Removed entries stay recoverable from the repository history only if the
   user syncs the knowledge base; do not promise an undo.
8. Finish with a short summary of what was moved/renamed/tagged/deleted; the
   IDE panel picks up changes within seconds.
