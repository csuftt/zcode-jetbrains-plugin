package com.zcode.kb.core

import kotlinx.serialization.Serializable

/**
 * 知识库条目：文件留在原地，条目记源路径；内容另有一份文档快照存在库内（见 KbContent）。
 *
 * - id：源路径的确定性哈希（[KbFileStore.newId]），入库即定不改；条目文件、检索缓存、
 *   文档快照目录都以它命名，重新链接换路径也不变；
 * - sourcePath：收录判重主键（标准化见 [KbFileStore.normPath]）；
 * - folderId：所属目录 id（[KbFolder.id]），"" = 根级（树垫底）；
 * - tags：多选 facet（输入侧禁逗号与引号，保证存储与过滤安全），参与检索
 *   （标题 4 : 标签 2 : 正文 1 计次打分，AND 判据的第三渠道）；
 * - project：系统维度（git 仓根名或父目录名），不占树位；
 * - sizeBytes / contentHash：上次确认的源文件字节数与内容哈希，对账经
 *   [KbFileStore.confirmContent] 更新；contentHash 为空表示尚未确认过；
 * - ingestedAt / updatedAt：收录时间、最近一次元数据（标题、目录、标签、备注、排序）变更时间。
 *   对账发现内容变化不改 updatedAt：两台电脑各自对账到同一处变化时写下的条目要逐字节相同，
 *   见 [KbFileStore.confirmContent]。
 *
 * 条目文件随 git 同步，只放对每台机器都成立的事实。「源文件在不在」读取时现算
 * （[KbContent.resolve]），源文件的修改时间只记在本机缓存，都不落在条目里——否则两台
 * 机器会互相改写对方的条目。
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
    /** 源文件字节的 SHA-256（hex）：上次确认的内容版本 */
    val contentHash: String = "",
    val ingestedAt: Long = 0,
    val updatedAt: Long = 0,
    /**
     * 同目录层内手动排序键（拖拽重排时全层重写 0..n-1）。排序键 = order 升序，
     * 并列（含未拖过的 0）按 ingestedAt 倒序——旧库无此字段读为 0，自然退化现状序；
     * 新收录 order=0 恒落层顶，与收录弹窗后的视觉习惯一致。
     */
    val order: Int = 0,
)

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
