package com.zcode.kb.core

import java.io.ByteArrayOutputStream
import org.junit.jupiter.api.io.TempDir
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * [KbBiffText] 用例：BIFF 数据与最小 CFB 容器全部程序化构造（与 docx/xlsx 的 zip 构造
 * 同风格），另有一个真实 Excel 产出样本冒烟（防构造器只验证自身假设的布局）。
 */
class KbBiffTextTest {

    // ── BIFF record / 字符串构造 ──

    private fun record(type: Int, body: ByteArray): ByteArray {
        val out = ByteArray(4 + body.size)
        le16put(out, 0, type)
        le16put(out, 2, body.size)
        System.arraycopy(body, 0, out, 4, body.size)
        return out
    }

    private fun bof(ver: Int = 0x0600): ByteArray {
        val body = ByteArray(4)
        le16put(body, 0, ver)
        le16put(body, 2, 0x0010) // dt = workbook globals
        return record(0x0809, body)
    }

    /** XLUnicodeRichExtendedString 编码；richRuns/extBytes>0 时带对应尾随块 */
    private fun xlString(s: String, compressed: Boolean, richRuns: Int = 0, extBytes: Int = 0): ByteArray {
        val out = ByteArrayOutputStream()
        val cchBuf = ByteArray(2)
        le16put(cchBuf, 0, s.length)
        out.write(cchBuf)
        var grbit = if (compressed) 0 else GRBIT_HIGH
        if (richRuns > 0) grbit = grbit or GRBIT_RICH
        if (extBytes > 0) grbit = grbit or GRBIT_EXT
        out.write(grbit)
        if (compressed) s.forEach { out.write(it.code and 0xFF) }
        else s.forEach { c ->
            out.write(c.code and 0xFF)
            out.write((c.code shr 8) and 0xFF)
        }
        if (richRuns > 0) {
            val b = ByteArray(2)
            le16put(b, 0, richRuns)
            out.write(b)
            repeat(richRuns * 8) { out.write(0) } // 每 run 8B（字符索引+字体索引）
        }
        if (extBytes > 0) {
            val b = ByteArray(4)
            le32put(b, 0, extBytes)
            out.write(b)
            repeat(extBytes) { out.write(0) }
        }
        return out.toByteArray()
    }

    private val GRBIT_HIGH = 0x01
    private val GRBIT_EXT = 0x04
    private val GRBIT_RICH = 0x08

    private fun sstRecord(strings: List<ByteArray>): ByteArray {
        val body = ByteArrayOutputStream()
        val buf = ByteArray(8)
        le32put(buf, 0, strings.size) // cstTotal
        le32put(buf, 4, strings.size) // cstUnique
        body.write(buf)
        strings.forEach { body.write(it) }
        return record(0x00FC, body.toByteArray())
    }

    // ── 最小 CFB 容器构造 ──

    private fun putMagic(b: ByteArray) {
        intArrayOf(0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1)
            .forEachIndexed { i, v -> b[i] = v.toByte() }
    }

    private fun writeDirEntry(b: ByteArray, off: Int, name: String, type: Int, start: Int, size: Long) {
        name.forEachIndexed { i, c -> le16put(b, off + 2 * i, c.code) }
        le16put(b, off + 0x40, (name.length + 1) * 2)
        b[off + 0x42] = type.toByte()
        le32put(b, off + 0x74, start)
        for (i in 0 until 8) b[off + 0x78 + i] = ((size shr (8 * i)) and 0xFF).toByte()
    }

    /** 大流路径：sector0=FAT, sector1=目录, sector2..=Workbook 数据（须 ≥4096B） */
    private fun buildCfbLarge(wb: ByteArray): ByteArray {
        val SECTOR = 512
        val nWb = (wb.size + SECTOR - 1) / SECTOR
        val out = ByteArray(512 + (2 + nWb) * SECTOR)
        putMagic(out)
        le16put(out, 0x1E, 9)
        le16put(out, 0x20, 6)
        le32put(out, 0x2C, 1)      // csectFat
        le32put(out, 0x30, 1)      // dirFirst
        le32put(out, 0x38, 4096)   // miniCutoff
        le32put(out, 0x3C, -1)     // miniFatFirst = FREE
        le32put(out, 0x40, 0)      // csectMiniFat
        le32put(out, 0x44, -1)     // difatFirst = FREE
        le32put(out, 0x48, 0)      // csectDif
        le32put(out, 0x4C, 0)      // DIFAT[0]
        val fatOff = 512
        le32put(out, fatOff + 1 * 4, -2) // 目录链 END
        for (i in 0 until nWb) {
            le32put(out, fatOff + (2 + i) * 4, if (i == nWb - 1) -2 else 2 + i + 1)
        }
        val dirOff = 512 + SECTOR
        writeDirEntry(out, dirOff, "Root Entry", 5, -2, 0L)
        writeDirEntry(out, dirOff + 128, "Workbook", 2, 2, wb.size.toLong())
        System.arraycopy(wb, 0, out, 512 + 2 * SECTOR, wb.size)
        return out
    }

    /** 小流路径：<4096B 存 MiniStream（sector3），经 MiniFAT（sector1）取 */
    private fun buildCfbSmall(wb: ByteArray): ByteArray {
        val SECTOR = 512
        val MINI = 64
        val nMini = (wb.size + MINI - 1) / MINI
        val out = ByteArray(512 + 4 * SECTOR)
        putMagic(out)
        le16put(out, 0x1E, 9)
        le16put(out, 0x20, 6)
        le32put(out, 0x2C, 1)      // csectFat
        le32put(out, 0x30, 2)      // dirFirst
        le32put(out, 0x38, 4096)   // miniCutoff
        le32put(out, 0x3C, 1)      // miniFatFirst
        le32put(out, 0x40, 1)      // csectMiniFat
        le32put(out, 0x44, -1)     // difatFirst = FREE
        le32put(out, 0x48, 0)      // csectDif
        le32put(out, 0x4C, 0)      // DIFAT[0]
        val fatOff = 512
        le32put(out, fatOff + 1 * 4, -2) // MiniFAT 链 END
        le32put(out, fatOff + 2 * 4, -2) // 目录链 END
        le32put(out, fatOff + 3 * 4, -2) // MiniStream 链 END
        val mfOff = 512 + SECTOR
        for (i in 0 until nMini) le32put(out, mfOff + i * 4, if (i == nMini - 1) -2 else i + 1)
        val dirOff = 512 + 2 * SECTOR
        writeDirEntry(out, dirOff, "Root Entry", 5, 3, (nMini * MINI).toLong())
        writeDirEntry(out, dirOff + 128, "Workbook", 2, 0, wb.size.toLong())
        System.arraycopy(wb, 0, out, 512 + 3 * SECTOR, wb.size)
        return out
    }

    // ── 用例 ──

    @Test
    fun `large stream via fat chain extracts sst`() {
        val wb = bof() + sstRecord(listOf(
            xlString("hello", compressed = true),
            xlString("你好世界", compressed = false),
            xlString("third", compressed = true),
        )) + record(0x0208, ByteArray(4100)) // ROW 填充把流顶过 miniCutoff
        val text = KbBiffText.extract(buildCfbLarge(wb))
        assertEquals("hello\n你好世界\nthird", text)
    }

    @Test
    fun `small stream via mini fat extracts sst`() {
        val wb = bof() + sstRecord(listOf(
            xlString("hello", compressed = true),
            xlString("你好", compressed = false),
        ))
        val text = KbBiffText.extract(buildCfbSmall(wb))
        assertEquals("hello\n你好", text)
    }

    @Test
    fun `rich runs and phonetic blocks are skipped`() {
        val wb = bof() + sstRecord(listOf(
            xlString("richAB", compressed = true, richRuns = 2),
            xlString("plain", compressed = true),
            xlString("extCD", compressed = true, extBytes = 8),
        )) + record(0x0208, ByteArray(4100))
        val text = KbBiffText.extract(buildCfbLarge(wb))
        assertEquals("richAB\nplain\nextCD", text)
    }

    @Test
    fun `continue repeated grbit when split inside char data`() {
        // 字符串切在字符数据中段：SST record 只装得下 "ABCD"，Continue 首字节重复 grbit 后接 "EFGH"
        val head = ByteArrayOutputStream()
        val buf = ByteArray(10)
        le32put(buf, 0, 1)
        le32put(buf, 4, 1)
        le16put(buf, 8, 8)       // cch=8
        head.write(buf)
        head.write(GRBIT_HIGH)   // uncompressed
        "ABCD".forEach { c ->    // 前半字符 uncompressed UTF-16LE
            head.write(c.code and 0xFF)
            head.write((c.code shr 8) and 0xFF)
        }
        val cont = ByteArrayOutputStream()
        cont.write(GRBIT_HIGH)   // 重复 grbit（允许切换压缩标志）
        "EFGH".forEach { c ->    // 剩余字符按 uncompressed UTF-16LE
            cont.write(c.code and 0xFF)
            cont.write((c.code shr 8) and 0xFF)
        }
        val wb = bof() + record(0x00FC, head.toByteArray()) + record(0x003C, cont.toByteArray())
        val text = KbBiffText.extract(buildCfbSmall(wb))
        assertEquals("ABCDEFGH", text)
    }

    @Test
    fun `continue can switch compression flag mid string`() {
        // 前半 compressed、Continue 切 uncompressed：cch=10，SST 段 5 字节 latin1，Continue 段 UTF-16LE
        val head = ByteArrayOutputStream()
        val buf = ByteArray(10)
        le32put(buf, 0, 1)
        le32put(buf, 4, 1)
        le16put(buf, 8, 10)  // cch=10
        head.write(buf)
        head.write(0)        // compressed
        head.write("ABCDE".toByteArray(Charsets.ISO_8859_1))
        val cont = ByteArrayOutputStream()
        cont.write(GRBIT_HIGH)
        "FGHIJ".forEach { c ->   // 切换为 uncompressed，UTF-16LE 逐字符交错
            cont.write(c.code and 0xFF)
            cont.write((c.code shr 8) and 0xFF)
        }
        val wb = bof() + record(0x00FC, head.toByteArray()) + record(0x003C, cont.toByteArray())
        val text = KbBiffText.extract(buildCfbSmall(wb))
        assertEquals("ABCDEFGHIJ", text)
    }

    @Test
    fun `continue at field boundary has no grbit`() {
        // 切点在字符串边界（SST 恰好在字符串边界耗尽）：Continue 直接接下一字符串，无 grbit
        val s1 = xlString("abc", compressed = true)
        val s2 = xlString("def", compressed = true)
        val head = ByteArrayOutputStream()
        val buf = ByteArray(8)
        le32put(buf, 0, 2)
        le32put(buf, 4, 2)
        head.write(buf)
        head.write(s1) // SST 段只装下第一个字符串
        val wb = bof() + record(0x00FC, head.toByteArray()) + record(0x003C, s2)
        val text = KbBiffText.extract(buildCfbSmall(wb))
        assertEquals("abc\ndef", text)
    }

    @Test
    fun `encrypted workbook returns null`() {
        val wb = bof() + record(0x002F, ByteArray(4)) + sstRecord(listOf(xlString("secret", compressed = true)))
        assertNull(KbBiffText.extract(buildCfbSmall(wb)))
    }

    @Test
    fun `biff5 workbook returns null`() {
        val wb = bof(0x0500) + sstRecord(listOf(xlString("old", compressed = true)))
        assertNull(KbBiffText.extract(buildCfbSmall(wb)))
    }

    @Test
    fun `bad magic and broken container return null`() {
        val ok = buildCfbSmall(bof() + sstRecord(listOf(xlString("x", compressed = true))))
        val badMagic = ok.copyOf().also { it[0] = 0x00 }
        assertNull(KbBiffText.extract(badMagic))
        // 目录声称的流起点越界 → 链读不满 → fail-soft（不抛）
        val broken = ok.copyOf()
        le32put(broken, 512 + 2 * 512 + 128 + 0x74, 0x7FFFFFF0)
        assertNull(KbBiffText.extract(broken))
    }

    @Test
    fun `real excel sample extracts cell text via full pipeline`(@TempDir dir: java.nio.file.Path) {
        val resource = javaClass.getResourceAsStream("/sample.xls") ?: error("sample.xls missing")
        val f = dir.resolve("sample.xls")
        resource.use { input -> java.nio.file.Files.copy(input, f) }
        val text = KbExtractor.extract(f)
        assertNotNull(text)
        assertTrue(text.contains("哈哈哈哈"), "实际提取：$text")
    }
}

private fun le16put(b: ByteArray, off: Int, v: Int) {
    b[off] = (v and 0xFF).toByte()
    b[off + 1] = ((v shr 8) and 0xFF).toByte()
}

private fun le32put(b: ByteArray, off: Int, v: Int) {
    le16put(b, off, v and 0xFFFF)
    le16put(b, off + 2, (v ushr 16) and 0xFFFF)
}
