import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

interface Migration {
	readonly tag: string
	readonly new_sqlite_classes?: readonly string[]
	readonly new_classes?: readonly string[]
	readonly deleted_classes?: readonly string[]
	readonly renamed_classes?: ReadonlyArray<{ readonly from: string; readonly to: string }>
}

interface WranglerConfig {
	readonly migrations?: readonly Migration[]
	readonly durable_objects?: { readonly bindings?: ReadonlyArray<{ readonly class_name: string }> }
}

const readConfig = async (path: string): Promise<WranglerConfig> => Bun.JSONC.parse(await readFile(path, 'utf8')) as WranglerConfig

/**
 * Replays the history as Cloudflare does on a script with no deployment: every step from the first tag. A class is
 * created before it is deleted or renamed, and the replay ends at exactly the classes the Worker binds.
 */
const replay = (migrations: readonly Migration[]): string[] => {
	const classes = new Set<string>()
	const tags = migrations.map((migration) => migration.tag)
	expect(tags).toEqual([...tags].sort())
	expect(new Set(tags).size).toBe(tags.length)
	for (const migration of migrations) {
		for (const name of [...(migration.new_sqlite_classes ?? []), ...(migration.new_classes ?? [])]) {
			if (classes.has(name)) throw new Error(`${migration.tag} creates \`${name}\`, which already exists`)
			classes.add(name)
		}
		for (const { from, to } of migration.renamed_classes ?? []) {
			if (!classes.delete(from)) throw new Error(`${migration.tag} renames \`${from}\`, which no earlier migration created`)
			classes.add(to)
		}
		for (const name of migration.deleted_classes ?? []) {
			// Cloudflare: "Cannot apply delete-class migration to class … which was not exported in the previous version" (10074).
			if (!classes.delete(name)) throw new Error(`${migration.tag} deletes \`${name}\`, which no earlier migration created`)
		}
	}
	return [...classes].sort()
}

const PLATFORM_WORKERS = {
	control: resolve(import.meta.dir, '../../wrangler.jsonc'),
	'runner-cloudflare': resolve(import.meta.dir, '../../../runner-cloudflare/wrangler.jsonc'),
}

describe('the Durable Object migrations of the platform Workers', () => {
	for (const [name, path] of Object.entries(PLATFORM_WORKERS)) {
		test(`${name}: the full history applies to a fresh account and ends at the bound classes`, async () => {
			const config = await readConfig(path)
			const bound = [...new Set((config.durable_objects?.bindings ?? []).map((binding) => binding.class_name))].sort()
			expect(replay(config.migrations ?? [])).toEqual(bound)
		})
	}

	test('control keeps the tags existing installations are at, with DeployLock created before it is deleted', async () => {
		const config = await readConfig(PLATFORM_WORKERS.control)
		expect(config.migrations?.map((migration) => migration.tag)).toEqual(['v0001', 'v0002', 'v0003', 'v0004'])
		expect(config.migrations?.[1]).toEqual({ tag: 'v0002', new_sqlite_classes: ['DeployLock'] })
	})

	test('the replay refuses a history that deletes a class it never created', () => {
		expect(() => replay([{ tag: 'v0001', new_sqlite_classes: ['A'] }, { tag: 'v0002', deleted_classes: ['B'] }])).toThrow(
			'v0002 deletes `B`, which no earlier migration created',
		)
	})
})
