import { describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { APP_AGENT_SKILL_NAME, installedAppAgentSkill, readAppAgentSkill, renderAgentsFile } from '../agent-skill'

const packageDir = join(import.meta.dir, '..', '..')

describe('the agent skill', () => {
	test('is a skill file whose name is the directory the builder installs it under', () => {
		const { text, body } = readAppAgentSkill()
		const frontmatter = text.slice(0, text.length - body.length)
		expect(frontmatter).toStartWith('---\n')
		expect(frontmatter).toContain(`\nname: ${APP_AGENT_SKILL_NAME}\n`)
		expect(frontmatter).toContain('\ndescription: >\n')
		expect(body).toStartWith('# Fabrika application rules\n')
		expect(body).not.toContain('\n---\n')
	})

	test("its version is the package's version", () => {
		const manifest = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf-8')))
		expect(readAppAgentSkill().version).toBe(manifest.version)
		expect(readAppAgentSkill().text).toContain(`\nversion: ${manifest.version}\n`)
	})

	test('every reference file SKILL.md names exists, and each one is named there', () => {
		const skill = readAppAgentSkill()
		const named = new Set([...skill.body.matchAll(/`(?:references\/)?([a-z-]+)\.md`/g)].map((match) => match[1]))
		expect(skill.references.length).toBeGreaterThan(0)
		for (const reference of skill.references) {
			expect(named.has(reference.topic)).toBe(true)
			expect(reference.text).toStartWith(`# ${reference.path} — `)
		}
	})

	test('the AGENTS.md of an application is the skill body and every reference file under a generated-file marker', () => {
		const skill = readAppAgentSkill()
		const agents = renderAgentsFile(skill)
		expect(agents).toStartWith(`<!-- Generated from skill/ of @fabrika/app ${skill.version}. Change those files, not this one. -->\n\n`)
		expect(agents).toContain(skill.body)
		for (const reference of skill.references) expect(agents).toContain(`\n---\n\n${reference.text}`)
	})

	test("the template's AGENTS.md is the rendered file: regenerate it, never edit it", () => {
		const template = readFileSync(new URL('../../../../examples/zerops-app/AGENTS.md', import.meta.url), 'utf-8')
		expect(template).toBe(renderAgentsFile(readAppAgentSkill()))
	})

	test('an application reads the skill of the @fabrika/app it installed, from its directory or above it', () => {
		const root = mkdtempSync(join(tmpdir(), 'fabrika-skill-'))
		try {
			const installed = join(root, 'node_modules', '@fabrika', 'app', 'skill')
			mkdirSync(installed, { recursive: true })
			cpSync(join(packageDir, 'skill'), installed, { recursive: true })
			mkdirSync(join(root, 'app'))
			expect(installedAppAgentSkill(join(root, 'app'))).toEqual(readAppAgentSkill())
			rmSync(join(root, 'node_modules'), { recursive: true })
			expect(installedAppAgentSkill(join(root, 'app'))).toBeNull()
		} finally {
			rmSync(root, { recursive: true })
		}
	})
})
