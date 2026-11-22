package com.zcode.kb.core

import kotlinx.serialization.Serializable

/**
 * 知识库条目（指针模型）：文件留在原地不复制，条目记源路径 + git 锚点。
 *
 * - id：`kb-` 前缀 + 随机短 hex，入库即定不改（同时是 entries/<id>.json 的文件名）；
 * - sourcePath：收录判重主键（标准化见 [KbFileStore.normPath]）；
 * - folderId：所属目录 id（[KbFolder.id]），"" = 根级（树垫底）；
 * - tags：多选自由 facet（输入侧禁逗号与引号，保证存储与过滤安全），参与检索
 *   （标题 4 : 标签 2 : 正文 1 计次打分，AND 判据的第三渠道）；
 * - project：系统维度（git 仓根名或父目录名），不占树位（条目 tooltip 展示）；
 * - git*：收录时点锚点（仓根/commit/相对路径），源失联时按 commit 从历史恢复；
 * - status：ok | missing（源文件不存在；检索仍命中缓存文本，预览降级）；
 * - indexedMtime/indexedSize：上次提取时源文件 stat，sweep 对账用。
 */
@Serializable
data class KbEntry(
    val id: String,
    val sourcePath: String,
    val title: String,
    val folderId: String = "",
    val tags: List<String> = emptyList(),
    val notes: String = "",
    val project: String = "",
    val fileExt: String = "",
    val sizeBytes: Long = 0,
    val gitRepo: String? = null,
    val gitCommit: String? = null,
    val gitRel: String? = null,
    val status: String = STATUS_OK,
    val ingestedAt: Long = 0,
    val updatedAt: Long = 0,
    val indexedMtime: Long = 0,
    val indexedSize: Long = 0,
) {
    companion object {
        const val STATUS_OK = "ok"
        const val STATUS_MISSING = "missing"
    }
}

/**
 * 用户自建目录（树结构，层级不限）。id 引用而非路径：重命名/移动不改子条目，
 * 展示路径实时派生（`信创适配/中间件`）。order 是同层排序键（拖拽重排时全层重写）。
 */
@Serializable
data class KbFolder(
    val id: String,
    val name: String,
    val parentId: String? = null,
    val order: Int = 0,
)

/** 检索/列表过滤条件（全可空=不过滤）；tags 多选（空=不过滤），tagMatchAll=true 全部包含（AND）/false 任一包含（OR） */
data class KbFilter(
    val folderId: String? = null,
    val tags: Set<String> = emptySet(),
    val tagMatchAll: Boolean = false,
    val project: String? = null,
    val query: String? = null,
)

/** 检索命中（search 结果） */
data class KbHit(
    val entry: KbEntry,
    val score: Double,
    /** 命中片段（最多 3 个互不重叠窗口，按位置升序；UI 上下文多行展示用） */
    val snippets: List<String>,
    /** 标题+标签+正文命中总次数（不加权；UI「N 处」徽标用） */
    val matchCount: Int = 0,
)
