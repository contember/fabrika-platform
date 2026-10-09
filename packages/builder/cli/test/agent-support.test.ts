import { APP_AGENT_SKILL_NAME, readAppAgentSkill } from '@fabrika/app/agent-skill'
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { injectAgentSupport, injectSkills, manifestRelativePath, parseAgentHosts } from '../src/inject-skills'
import { type Fixture, makeFixture } from './helpers'

let fixture: Fixture | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new Error('expected an object')
	return value
}

afterEach(() => {
	fixture?.cleanup()
	fixture = null
})

describe('agent host selection', () => {
	test('defaults to both hosts and accepts an explicit subset', () => {
		expect(parseAgentHosts()).toEqual(['claude', 'codex'])
		expect(parseAgentHosts('all')).toEqual(['claude', 'codex'])
		expect(parseAgentHosts('codex')).toEqual(['codex'])
		expect(parseAgentHosts('codex,claude,codex')).toEqual(['codex', 'claude'])
		expect(() => parseAgentHosts('cursor')).toThrow('Invalid --agent value')
	})
})

describe('dual-host installation', () => {
	test('installs canonical skills, gate assets, and valid host agents', () => {
		fixture = makeFixture()
		const result = injectAgentSupport(fixture.root)

		expect(result.hosts).toEqual(['claude', 'codex'])
		expect(result.written.length).toBeGreaterThan(20)
		expect(existsSync(join(fixture.root, '.claude/skills/fabrika/gates/brief.jsx'))).toBe(true)
		expect(existsSync(join(fixture.root, '.agents/skills/fabrika/gates/brief.jsx'))).toBe(true)
		expect(existsSync(join(fixture.root, '.agents/skills/fabrika/agents/openai.yaml'))).toBe(true)
		expect(existsSync(join(fixture.root, '.claude/agents/implementer.md'))).toBe(true)

		const codexSkill = readFileSync(join(fixture.root, '.agents/skills/fabrika/SKILL.md'), 'utf-8')
		const claudeSkill = readFileSync(join(fixture.root, '.claude/skills/fabrika/SKILL.md'), 'utf-8')
		expect(codexSkill).not.toContain('allowed-tools:')
		expect(claudeSkill).toContain('allowed-tools:')

		const implementerToml = readFileSync(join(fixture.root, '.codex/agents/implementer.toml'), 'utf-8')
		const parsed = record(Bun.TOML.parse(implementerToml))
		expect(parsed['name']).toBe('fabrika-implementer')
		expect(parsed['description']).toContain('Use only when the main Fabrika build driver delegates one specific ISSUE-*')
		expect(String(parsed['developer_instructions'])).toContain('Do not coordinate other issues')

		const manifest = record(JSON.parse(readFileSync(join(fixture.root, manifestRelativePath(fixture.root)), 'utf-8')))
		expect(manifest['version']).toBe(1)
		expect(Object.keys(record(manifest['files'])).length).toBe(result.written.length)
	})

	test('installs the application rules of @fabrika/app verbatim as a skill for each host', () => {
		fixture = makeFixture()
		injectAgentSupport(fixture.root)
		const source = readAppAgentSkill().text
		for (const skillsDir of ['.claude/skills', '.agents/skills']) {
			expect(readFileSync(join(fixture.root, skillsDir, APP_AGENT_SKILL_NAME, 'SKILL.md'), 'utf-8')).toBe(source)
		}
	})

	test('is idempotent and preserves a user-edited generated file', () => {
		fixture = makeFixture()
		injectAgentSupport(fixture.root)
		const customPath = join(fixture.root, '.codex/agents/flows-author.toml')
		writeFileSync(customPath, '# user-owned custom agent\n')

		const second = injectAgentSupport(fixture.root)
		expect(second.written).toHaveLength(0)
		expect(second.updated).toHaveLength(0)
		expect(second.preserved).toContain(customPath)
		expect(second.skipped.length).toBeGreaterThan(20)
		expect(readFileSync(customPath, 'utf-8')).toBe('# user-owned custom agent\n')
	})

	test('updates a tracked generated file when its installed copy is unchanged', () => {
		fixture = makeFixture()
		injectAgentSupport(fixture.root)
		const targetRelative = '.codex/agents/flows-author.toml'
		const targetPath = join(fixture.root, targetRelative)
		const simulatedOldGenerated = 'name = "old-generated"\n'
		writeFileSync(targetPath, simulatedOldGenerated)

		const manifestPath = join(fixture.root, manifestRelativePath(fixture.root))
		const manifest = record(JSON.parse(readFileSync(manifestPath, 'utf-8')))
		const files = record(manifest['files'])
		files[targetRelative] = {
			installedHash: createHash('sha256').update(simulatedOldGenerated).digest('hex'),
			host: 'codex',
		}
		manifest['version'] = 'legacy-version-is-ignored'
		files['broken-entry'] = { installedHash: 42, host: 'future-host' }
		writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

		const result = injectAgentSupport(fixture.root)
		expect(result.updated).toContain(targetPath)
		expect(readFileSync(targetPath, 'utf-8')).toContain('name = "fabrika-flows-author"')
		const recovered = record(JSON.parse(readFileSync(manifestPath, 'utf-8')))
		expect(recovered['version']).toBe(1)
		expect(record(recovered['files'])['broken-entry']).toBeUndefined()
	})

	test('can install Codex support without touching Claude layout', () => {
		fixture = makeFixture()
		injectAgentSupport(fixture.root, { hosts: ['codex'] })
		expect(existsSync(join(fixture.root, '.agents/skills/fabrika/SKILL.md'))).toBe(true)
		expect(existsSync(join(fixture.root, '.codex/agents/flows-author.toml'))).toBe(true)
		expect(existsSync(join(fixture.root, '.claude'))).toBe(false)
	})

	test('legacy injectSkills remains Claude-only', () => {
		fixture = makeFixture()
		const result = injectSkills(fixture.root)
		expect(result.hosts).toEqual(['claude'])
		expect(existsSync(join(fixture.root, '.claude/skills/fabrika/SKILL.md'))).toBe(true)
		expect(existsSync(join(fixture.root, '.agents'))).toBe(false)
		expect(existsSync(join(fixture.root, '.codex'))).toBe(false)
	})
})
