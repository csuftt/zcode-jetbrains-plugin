package com.zcode.kb.core

import java.io.ByteArrayOutputStream

/**
 * 老式 xls（BIFF8 / OLE2 复合文档）正文轻提取——与 docx/xlsx 同款「JDK 内置 API 手写轻解析、
 * 不引 POI 全家桶」路线（issue#54 偏离决定）。
 *
 * 两层：
 * 1. [Cfb]：CFB（Compound File Binary）最小读取器——header→DIFAT→FAT→目录链，按名（大小写
 *    不敏感）取 "Workbook"/"Book" 流；大流（≥miniCutoff 4096）走 FAT 链，小流在 Root Entry
 *    的 MiniStream 里走 MiniFAT 链。链遍历防环（visited set）+ 越界防御。
 * 2. BIFF8 record 扫描：BOF 校验版本（ver≠0x0600 视为 BIFF5 老格式放弃）、FILEPASS 加密放弃、
 *    SST(0x00FC) 抽全簿共享字符串池（同 xlsx sharedStrings 思路，覆盖绝大多数单元格文本；
 *    公式结果串、批注等不在 SST 的文本不参与，与 xlsx 的局限一致）。
 *
 * Continue(0x003C) 跨界规则（[MS-XLS] 2.5.293）：切点落在字符数组**中段**（已消费 ≥1 字符）
 * 时，Continue 首字节是重复的 grbit（fHighByte 允许切换压缩标志）；切在其他字段边界直接接续、
 * 不带 grbit。rich run / phonetic 数据跨段一律不带 grbit。
 *
 * fail-soft：魔数不符/找不到流/非 BIFF8/加密/任何解析异常 → null（调用方按提取失败处理，
 * 与 doc 同待遇仅元数据参与检索）。
 */
object KbBiffText {

    fun extract(bytes: ByteArray): String? {
        return try {
            val wb = Cfb.stream(bytes, WORKBOOK_STREAMS) ?: return null
            sstText(wb)
        } catch (e: Exception) {
            null
        }
    }

    private val WORKBOOK_STREAMS = setOf("workbook", "book")

    // ── BIFF8 record 扫描 ──

    private const val REC_BOF = 0x0809
    private const val REC_FILEPASS = 0x002F
    private const val REC_CONTINUE = 0x003C
    private const val REC_SST = 0x00FC
    private const val BIFF8_BOF_VER = 0x0600

    /** SST record + 紧随 Continue 链的 payload 顺序拼读，解析共享字符串池 */
    private fun sstText(wb: ByteArray): String? {
        val payloads = ArrayList<ByteArray>()
        var bofChecked = false
        var inSst = false
        var i = 0
        while (i + 4 <= wb.size) {
            val type = le16(wb, i)
            val len = le16(wb, i + 2)
            val bodyStart = i + 4
            val bodyEnd = (bodyStart + len).coerceAtMost(wb.size)
            when (type) {
                REC_BOF -> {
                    // 只对全局子流的第一个 BOF 判版本；文件内各子流（worksheet/chart）BOF 均为 BIFF8
                    if (!bofChecked) {
                        if (le16(wb, bodyStart) != BIFF8_BOF_VER) return null
                        bofChecked = true
                    }
                    inSst = false
                }
                REC_FILEPASS -> return null // 加密工作簿：无明文可提
                REC_SST -> {
                    payloads.add(wb.copyOfRange(bodyStart, bodyEnd))
                    inSst = true
                }
                REC_CONTINUE -> if (inSst) payloads.add(wb.copyOfRange(bodyStart, bodyEnd))
                else -> inSst = false // SST 的 Continue 链被其他 record 打断即结束
            }
            i = bodyEnd
        }
        if (payloads.isEmpty()) return null
        val strings = parseSst(payloads)
        if (strings.isEmpty()) return null
        return strings.joinToString("\n")
    }

    private const val GRBIT_FHIGHBYTE = 0x01 // 1=uncompressed UTF-16LE，0=compressed latin1
    private const val GRBIT_FEXTST = 0x04    // 尾随 Asian phonetic 块
    private const val GRBIT_FRICHST = 0x08   // 尾随富文本 run 列表
    private const val MAX_UNIQUE_STRINGS = 1_000_000 // 损坏计数防御

    /** 读 SST payload 序列里的全部 unique 字符串（XLUnicodeRichExtendedString） */
    private fun parseSst(payloads: List<ByteArray>): List<String> {
        val r = ChunkCursor(payloads)
        r.skipFully(4) // cstTotal（重复引用计数，检索不需要）
        val unique = r.readU32()
        val out = ArrayList<String>(unique.coerceAtMost(MAX_UNIQUE_STRINGS))
        repeat(unique.coerceAtMost(MAX_UNIQUE_STRINGS)) { out.add(readRichString(r)) }
        return out
    }

    /**
     * 单个 XLUnicodeRichExtendedString。字符数据逐字符流式读：Continue 切在字符数组中段
     * （已消费 ≥1 字符）时消费新 grbit 并允许压缩标志切换；uncompressed 残 1 字节（按字符
     * 边界切割不应发生）防御性弃残字节跨段。
     */
    private fun readRichString(r: ChunkCursor): String {
        val cch = r.readU16()
        val grbit = r.readByte()
        val rich = (grbit and GRBIT_FRICHST) != 0
        val ext = (grbit and GRBIT_FEXTST) != 0
        var highByte = (grbit and GRBIT_FHIGHBYTE) != 0

        val sb = StringBuilder(cch)
        var remaining = cch
        var consumedAny = false
        while (remaining > 0) {
            var chunkRemain = r.remainingInChunk()
            if (chunkRemain == 0) {
                if (!r.toNextChunk()) throw BiffTruncated()
                if (consumedAny) highByte = (r.readByte() and GRBIT_FHIGHBYTE) != 0
                chunkRemain = r.remainingInChunk()
            }
            val perChar = if (highByte) 2 else 1
            val canRead = minOf(remaining, chunkRemain / perChar)
            if (canRead == 0) {
                // uncompressed 残 1 字节：正常 Excel 按字符边界切不会发生，防御性弃残跨段
                r.skipFully(1)
                continue
            }
            repeat(canRead) {
                if (highByte) {
                    val lo = r.readByte()
                    val hi = r.readByte()
                    sb.append(((hi shl 8) or lo).toChar())
                } else {
                    sb.append(r.readByte().toChar())
                }
            }
            remaining -= canRead
            consumedAny = true
        }
        if (rich) {
            val cRun = r.readU16()
            r.skipFully(cRun * 8)
        }
        if (ext) {
            val cb = r.readU32()
            r.skipFully(cb)
        }
        return sb.toString()
    }

    private class BiffTruncated : Exception()

    /** SST record + Continue 链的顺序 payload 只读游标（自动跨 chunk；跨界不隐式吃 grbit） */
    private class ChunkCursor(private val chunks: List<ByteArray>) {
        private var ci = 0
        private var pos = 0
        private var consumed = 0
        private val total = chunks.sumOf { it.size }

        /** 当前 chunk 内剩余字节数（不跨 chunk） */
        fun remainingInChunk(): Int = if (ci < chunks.size) chunks[ci].size - pos else 0

        /** 推进到下一个非空 chunk；全耗尽返回 false */
        fun toNextChunk(): Boolean {
            while (ci + 1 < chunks.size) {
                ci++
                pos = 0
                if (chunks[ci].isNotEmpty()) return true
            }
            pos = if (ci < chunks.size) chunks[ci].size else 0
            return false
        }

        fun readByte(): Int {
            if (remainingInChunk() == 0 && !toNextChunk()) throw BiffTruncated()
            val v = chunks[ci][pos].toInt() and 0xFF
            pos++
            consumed++
            return v
        }

        fun readU16(): Int = readByte() or (readByte() shl 8)
        fun readU32(): Int = readU16() or (readU16() shl 16)

        fun skipFully(n: Int) {
            if (total - consumed < n) throw BiffTruncated()
            repeat(n) { readByte() }
        }
    }

    // ── CFB（OLE2 复合文档）最小读取器 ──

    private object Cfb {
        private const val END_OF_CHAIN = -2 // 0xFFFFFFFE
        private const val FREE_SECT = -1    // 0xFFFFFFFF

        private val MAGIC = intArrayOf(0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1)

        /** 按名（大小写不敏感）取流内容；找不到返回 null，结构异常抛异常由上层 fail-soft */
        fun stream(bytes: ByteArray, names: Set<String>): ByteArray? {
            if (bytes.size < 512) return null
            for (i in MAGIC.indices) {
                if ((bytes[i].toInt() and 0xFF) != MAGIC[i]) return null
            }
            val sectorShift = le16(bytes, 0x1E)
            val miniShift = le16(bytes, 0x20)
            if (sectorShift < 6 || sectorShift > 20 || miniShift < 4 || miniShift > sectorShift) return null
            val sectorSize = 1 shl sectorShift
            val miniSize = 1 shl miniShift
            val dirFirst = le32(bytes, 0x30)
            val miniCutoff = le32(bytes, 0x38)
            val miniFatFirst = le32(bytes, 0x3C)
            val csectMiniFat = le32(bytes, 0x40)
            val difatFirst = le32(bytes, 0x44)
            val csectDif = le32(bytes, 0x48)

            fun sectorOff(sec: Int) = sectorSize + sec * sectorSize
            fun inRange(sec: Int): Boolean {
                if (sec < 0) return false
                val off = sectorOff(sec)
                return off > 0 && off + sectorSize <= bytes.size
            }

            // DIFAT：header 内 109 项 + DIFAT 链 → FAT sector 号清单
            val fatSectors = ArrayList<Int>()
            for (i in 0 until 109) {
                val v = le32(bytes, 0x4C + 4 * i)
                if (v != FREE_SECT) fatSectors.add(v)
            }
            var difatSec = difatFirst
            var difatLeft = csectDif
            val difatSeen = HashSet<Int>()
            while (difatSec != END_OF_CHAIN && difatSec != FREE_SECT && difatLeft > 0 && difatSeen.add(difatSec)) {
                if (!inRange(difatSec)) break
                val off = sectorOff(difatSec)
                val per = sectorSize / 4 - 1 // 末 4 字节是下一个 DIFAT sector 号
                for (i in 0 until per) {
                    val v = le32(bytes, off + 4 * i)
                    if (v != FREE_SECT && v != END_OF_CHAIN) fatSectors.add(v)
                }
                difatSec = le32(bytes, off + sectorSize - 4)
                difatLeft--
            }

            // FAT 表（每 FAT sector 承载 entriesPerSector 个链项）
            val entriesPerSector = sectorSize / 4
            if (fatSectors.isEmpty()) return null
            val fat = IntArray(fatSectors.size * entriesPerSector)
            var fi = 0
            for (sec in fatSectors) {
                if (!inRange(sec)) return null
                val off = sectorOff(sec)
                for (i in 0 until entriesPerSector) fat[fi++] = le32(bytes, off + 4 * i)
            }

            /** 沿 FAT 链拼出整条流（防环 + 越界截断） */
            fun chain(first: Int): ByteArray {
                val out = ByteArrayOutputStream()
                var sec = first
                val seen = HashSet<Int>()
                val buf = ByteArray(sectorSize)
                while (sec != END_OF_CHAIN && sec != FREE_SECT && sec >= 0) {
                    if (!seen.add(sec) || sec >= fat.size || !inRange(sec)) break
                    System.arraycopy(bytes, sectorOff(sec), buf, 0, sectorSize)
                    out.write(buf)
                    sec = fat[sec]
                }
                return out.toByteArray()
            }

            // 目录：128B/项；Root Entry（首项 type=5）的流即 MiniStream
            val dir = chain(dirFirst)
            val nEntries = dir.size / 128
            if (nEntries < 1) return null

            fun entryName(off: Int): String {
                val nameLen = le16(dir, off + 0x40)
                val chars = (nameLen / 2 - 1).coerceIn(0, 31)
                val sb = StringBuilder(chars)
                for (i in 0 until chars) sb.append(le16(dir, off + 2 * i).toChar())
                return sb.toString()
            }

            var miniStream = ByteArray(0)
            var miniFat = IntArray(0)
            if (entryType(dir, 0) == 5) {
                val raw = chain(entryStart(dir, 0))
                val size = leLong(dir, 0x78).coerceAtMost(raw.size.toLong())
                miniStream = if (size == raw.size.toLong()) raw else raw.copyOf(size.toInt())
                if (csectMiniFat > 0 && miniFatFirst != END_OF_CHAIN && miniFatFirst != FREE_SECT) {
                    val mf = chain(miniFatFirst)
                    miniFat = IntArray(mf.size / 4) { le32(mf, it * 4) }
                }
            }

            /** 小流：沿 MiniFAT 链从 MiniStream 切片拼接 */
            fun miniChain(first: Int, size: Int): ByteArray {
                val out = ByteArrayOutputStream(size)
                var sec = first
                val seen = HashSet<Int>()
                while (sec != END_OF_CHAIN && sec != FREE_SECT && sec >= 0 && sec < miniFat.size) {
                    if (!seen.add(sec)) break
                    val off = sec * miniSize
                    if (off + miniSize > miniStream.size) break
                    out.write(miniStream, off, miniSize)
                    sec = miniFat[sec]
                }
                val data = out.toByteArray()
                return if (data.size >= size) data.copyOf(size) else data
            }

            for (e in 1 until nEntries) {
                val off = e * 128
                if (entryType(dir, e) != 2) continue
                if (entryName(off).lowercase() !in names) continue
                val size = leLong(dir, off + 0x78)
                if (size < 0 || size > Int.MAX_VALUE) return null
                val s = size.toInt()
                val data = if (s >= miniCutoff) chain(entryStart(dir, e)) else miniChain(entryStart(dir, e), s)
                return if (data.size >= s) data.copyOf(s) else data
            }
            return null
        }

        private fun entryType(dir: ByteArray, e: Int): Int = dir[e * 128 + 0x42].toInt() and 0xFF
        private fun entryStart(dir: ByteArray, e: Int): Int = le32(dir, e * 128 + 0x74)
    }

    // ── 小端读数 ──

    private fun le16(b: ByteArray, off: Int): Int =
        (b[off].toInt() and 0xFF) or ((b[off + 1].toInt() and 0xFF) shl 8)

    private fun le32(b: ByteArray, off: Int): Int = le16(b, off) or (le16(b, off + 2) shl 16)

    private fun leLong(b: ByteArray, off: Int): Long {
        var v = 0L
        for (i in 7 downTo 0) v = (v shl 8) or (b[off + i].toLong() and 0xFF)
        return v
    }
}
