package com.zcode.ideaplugin.ui

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * SkillScanner 真机数据验证（不写 config，只读扫描）
 *
 * 前置：本机 ~/.zcode/skills、~/.agents/skills、~/.zcode/cli/plugins 存在真实技能
 */
class SkillScannerTest {

    @Test
    fun `全局与插件扫描非空且结构合法`() {
        val skills = SkillScanner.scan(null)
        println("✅ 扫描到 ${skills.size} 条技能")
        assertTrue(skills.size > 50, "本机应有大量技能（.zcode+.agents 去重 + 插件），实际 ${skills.size}")

        skills.forEach { s ->
            assertTrue(s.name.isNotBlank(), "name 非空")
            assertTrue(File(s.path).isFile, "SKILL.md 应存在: ${s.path}")
            assertTrue(s.scope in setOf("user", "project", "plugin"), "scope 合法: ${s.scope}")
            assertTrue(s.source in setOf("zcode", "agents", "plugin"), "source 合法: ${s.source}")
        }
    }

    @Test
    fun `junction 去重后无重复真实路径`() {
        val skills = SkillScanner.scan(null)
        val reals = skills.map { runCatching { File(it.path).canonicalPath }.getOrDefault(it.path) }
        assertEquals(reals.size, reals.toSet().size, "去重后不应有重复 canonical path（.zcode/.agents 同一 junction 只留一条）")
    }

    @Test
    fun `已知技能存在且插件技能带插件名`() {
        val skills = SkillScanner.scan(null)
        val codeReview = skills.firstOrNull { it.name == "code-review" }
        assertNotNull(codeReview, "code-review 技能应存在")
        assertEquals("user", codeReview.scope)
        assertTrue(codeReview.path.endsWith("SKILL.md"))

        val pluginSkill = skills.firstOrNull { it.scope == "plugin" }
        assertNotNull(pluginSkill, "应存在插件贡献技能（browser-use 插件）")
        assertNotNull(pluginSkill.pluginName, "插件技能应推断出 pluginName: ${pluginSkill.path}")
        println("✅ 插件技能示例: ${pluginSkill.name} (plugin=${pluginSkill.pluginName})")
    }

    @Test
    fun `当前 config 无 skill 节点时全部启用`() {
        val skills = SkillScanner.scan(null)
        assertTrue(skills.all { it.enabled }, "config.json 当前无 skill 禁用节点，所有技能应为启用态")
    }
}
