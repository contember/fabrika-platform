import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { basename, join } from 'path'
import { resolveCatalogRoot, resolveStackPointer } from '../src/catalog'

interface DecisionMeta {
	id: string
	slot: string | null
	requires: string[]
	conflicts: string[]
}

function frontmatter(path: string): string {
	const source = readFileSync(path, 'utf8')
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)
	if (!match?.[1]) throw new Error(`Missing frontmatter: ${path}`)
	return match[1]
}

function scalar(yaml: string, key: string): string {
	const match = new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm').exec(yaml)
	if (!match?.[1]) throw new Error(`Missing ${key} in frontmatter`)
	return match[1].replace(/^['"]|['"]$/g, '')
}

function list(yaml: string, key: string): string[] {
	const inline = new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]\\s*$`, 'm').exec(yaml)
	if (inline) {
		return (inline[1] ?? '')
			.split(',')
			.map((value) => value.trim().replace(/^['"]|['"]$/g, ''))
			.filter(Boolean)
	}

	const block = new RegExp(
		`^${key}:\\s*\\r?\\n((?:[ \\t]+- [^\\r\\n]+\\r?\\n?)*)`,
		'm',
	).exec(yaml)
	if (!block?.[1]) return []
	return block[1]
		.split(/\r?\n/)
		.map((line) => /^\s+-\s+(.+?)\s*$/.exec(line)?.[1] ?? '')
		.map((value) => value.replace(/^['"]|['"]$/g, ''))
		.filter(Boolean)
}

function loadDecisions(root: string): Map<string, DecisionMeta> {
	const decisions = new Map<string, DecisionMeta>()
	for (const kind of ['technologies', 'patterns', 'tooling']) {
		const dir = join(root, 'decisions', kind)
		for (const filename of readdirSync(dir).filter((name) => name.endsWith('.md'))) {
			const yaml = frontmatter(join(dir, filename))
			const id = scalar(yaml, 'id')
			expect(id).toBe(basename(filename, '.md'))
			expect(decisions.has(id)).toBe(false)
			const slot = scalar(yaml, 'slot')
			decisions.set(id, {
				id,
				slot: slot === 'null' ? null : slot,
				requires: list(yaml, 'requires'),
				conflicts: list(yaml, 'conflicts'),
			})
		}
	}
	return decisions
}

test('every stack preset is requires-closed, conflict-free and slot-safe', () => {
	const root = resolveCatalogRoot()
	expect(root).not.toBeNull()
	const decisions = loadDecisions(root!)
	const stackDir = join(root!, 'stacks')

	for (
		const filename of readdirSync(stackDir).filter(
			(name) => name.endsWith('.md') && name !== 'README.md',
		)
	) {
		const yaml = frontmatter(join(stackDir, filename))
		const stackId = scalar(yaml, 'id')
		expect(stackId).toBe(basename(filename, '.md'))
		const selected = list(yaml, 'decisions')
		const selectedSet = new Set(selected)
		expect(selectedSet.size).toBe(selected.length)

		const slots = new Map<string, string>()
		for (const id of selected) {
			const decision = decisions.get(id)
			expect(decision, `${stackId}: unknown decision ${id}`).toBeDefined()
			if (!decision) continue

			for (const required of decision.requires) {
				expect(selectedSet.has(required), `${stackId}: ${id} requires ${required}`).toBe(true)
			}
			for (const conflict of decision.conflicts) {
				expect(selectedSet.has(conflict), `${stackId}: ${id} conflicts with ${conflict}`).toBe(false)
			}
			if (decision.slot) {
				expect(
					slots.has(decision.slot),
					`${stackId}: slot ${decision.slot} has ${slots.get(decision.slot)} and ${id}`,
				).toBe(false)
				slots.set(decision.slot, id)
			}
		}
	}
})

test('cf-internal-app is a selectable Fabrika Control + native Fabrika IAM preset', () => {
	const pointer = resolveStackPointer('cf-internal-app')
	expect(pointer?.stackFileExists).toBe(true)
	const yaml = frontmatter(pointer!.stackFile)
	const selected = list(yaml, 'decisions')
	expect(selected).toContain('fabrika-control')
	expect(selected).toContain('fabrika-iam')
	expect(selected).toContain('single-worker-spa')
	expect(selected).toContain('typed-worker-rpc')
	expect(selected).toContain('fabrika-app-deploy')
	expect(selected).not.toContain('cloudflare-access')
	expect(selected).not.toContain('app-deploy')
})
