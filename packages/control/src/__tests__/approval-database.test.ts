// The database an application chose in `fabrika.config.ts`, in the reviewed snapshot: Postgres through Hyperdrive on
// Cloudflare. Read statically, as the checker reads it; an application that chose none keeps the digest it had.

import { canonicalArtifactJson, canonicalJson, type ContractArtifact, sha256Hex } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { readAccessSnapshot, SnapshotRefused } from '../approval/read'
import { type AccessSnapshot, approvedAccess, parseSnapshot, serializePublished, serializeSnapshot, snapshotDigest } from '../approval/snapshot'
import { memoryCommits } from './helpers/commits'
import { healthOnly } from './helpers/contracts'

const COMMIT = 'c'.repeat(40)
const MIGRATION = { 'db/migrations/20260101000000_init.sql': 'CREATE TABLE notes (id uuid PRIMARY KEY, title text NOT NULL);\n' }

const cloudflareConfig = (argument: string): string =>
	`import { defineApp } from '@fabrika/provider-cloudflare'

export default defineApp(${argument})
`

const POSTGRES = cloudflareConfig(`{ id: 'notes', database: { kind: 'postgres', provisioningSecret: 'DATABASE_URL' } }`)

async function snapshotOf(files: Readonly<Record<string, string>>, root = ''): Promise<AccessSnapshot> {
	const prefix = root === '' ? '' : `${root}/`
	const tree = Object.fromEntries(
		Object.entries({ 'fabrika.contract.ts': healthOnly('notes'), ...MIGRATION, ...files }).map(([path, text]) => [`${prefix}${path}`, text]),
	)
	const commit = await memoryCommits(tree).open({ repoUrl: 'github.com/acme/notes', commitSha: COMMIT, signal: new AbortController().signal })
	return readAccessSnapshot(commit, root, 'notes')
}

function contractOf(snapshot: AccessSnapshot): ContractArtifact {
	if (snapshot.contract === null) throw new Error('the snapshot has no contract')
	return snapshot.contract
}

async function refusal(files: Readonly<Record<string, string>>): Promise<string> {
	try {
		await snapshotOf(files)
	} catch (error) {
		if (error instanceof SnapshotRefused) return error.code
		throw error
	}
	throw new Error('the snapshot was read')
}

describe('the database in the access snapshot', () => {
	test('a Cloudflare application that states Postgres inline records it, and the provider is handed it', async () => {
		const snapshot = await snapshotOf({ 'fabrika.config.ts': POSTGRES })
		expect(snapshot.database).toBe('postgres')
		expect(approvedAccess(snapshot)?.database).toBe('postgres')
		// Read at the application root the provider executes from.
		expect((await snapshotOf({ 'fabrika.config.ts': POSTGRES }, 'worker')).database).toBe('postgres')
	})

	test('Postgres stated through const bindings, a namespace import or a spread of an object literal is recorded too', async () => {
		const DATABASE = "database: { kind: 'postgres', provisioningSecret: 'DATABASE_URL' }"
		const IMPORT = "import { defineApp } from '@fabrika/provider-cloudflare'\n"
		for (
			const config of [
				`${IMPORT}const app = defineApp({ id: 'notes', ${DATABASE} })\nexport default app\n`,
				`import * as cf from '@fabrika/provider-cloudflare'\nexport default cf.defineApp({ id: 'notes', ${DATABASE} })\n`,
				`${IMPORT}const settings = { id: 'notes', ${DATABASE} } as const\nexport default defineApp(settings)\n`,
				`${IMPORT}const base = { ${DATABASE} }\nexport default defineApp({ id: 'notes', ...base })\n`,
			]
		) {
			expect([config, (await snapshotOf({ 'fabrika.config.ts': config })).database]).toEqual([config, 'postgres'])
		}
	})

	test('every other application chooses none, and its snapshot and digest are what they were before the field existed', async () => {
		const without = await snapshotOf({})
		const configs = {
			sqlite: cloudflareConfig(`{ id: 'notes' }`),
			variable: `import { defineApp } from '@fabrika/provider-cloudflare'\n\nconst config = { id: 'notes' }\nexport default defineApp(config)\n`,
			// The read cannot tell whether it names a database: none is approved, and the deployer refuses a loaded one.
			unsettled: `import { defineApp } from '@fabrika/provider-cloudflare'\n\nexport default defineApp({ id: 'notes', ...load() })\n`,
			zerops:
				`import { defineApp } from '@fabrika/provider-zerops'\n\nexport default defineApp({ id: 'notes', database: { kind: 'postgres', provisioningSecret: 'X' } })\n`,
			unparsable: 'export default defineApp({',
		}
		expect(without.database).toBeUndefined()
		expect('database' in (approvedAccess(without) ?? {})).toBe(false)
		for (const [name, config] of Object.entries(configs)) {
			const snapshot = await snapshotOf({ 'fabrika.config.ts': config })
			expect([name, snapshot]).toEqual([name, without])
			expect([name, snapshotDigest(snapshot)]).toEqual([name, snapshotDigest(without)])
		}
		// The digest formula from before the field existed.
		const before = `sha256:${sha256Hex(`${canonicalArtifactJson(contractOf(without))}\n${canonicalJson(without.migrations)}\nnull`)}`
		expect(snapshotDigest(without)).toBe(before)
		expect(JSON.parse(serializeSnapshot(without))).not.toHaveProperty('database')
	})

	test('the database is in the digest, after the database code, and survives the stored and the published form', async () => {
		const sqlite = await snapshotOf({})
		const postgres = await snapshotOf({ 'fabrika.config.ts': POSTGRES })
		expect(snapshotDigest(postgres)).not.toBe(snapshotDigest(sqlite))
		const contract = canonicalArtifactJson(contractOf(postgres))
		expect(snapshotDigest(postgres)).toBe(`sha256:${sha256Hex(`${contract}\n${canonicalJson(postgres.migrations)}\nnull\ndatabase:postgres`)}`)
		const withCode: AccessSnapshot = { ...postgres, databaseCode: [{ kind: 'function', object: 'app_notes.touch', file: '1.sql', line: 1 }] }
		expect(snapshotDigest(withCode)).toBe(
			`sha256:${sha256Hex(`${contract}\n${canonicalJson(postgres.migrations)}\nnull\n${canonicalJson(withCode.databaseCode)}\ndatabase:postgres`)}`,
		)
		expect(parseSnapshot(serializeSnapshot(postgres))).toEqual(postgres)
		expect(parseSnapshot(serializePublished(postgres)).database).toBe('postgres')
		expect(snapshotDigest(parseSnapshot(serializePublished(postgres)))).toBe(snapshotDigest(postgres))
		// Only Postgres is a database a snapshot can name.
		const stored = JSON.parse(serializeSnapshot(postgres))
		expect(() => parseSnapshot(JSON.stringify({ ...stored, database: 'sqlite' }))).toThrow()
		expect(() => parseSnapshot(JSON.stringify({ ...stored, database: 'mysql' }))).toThrow()
	})

	test('a Cloudflare config that names `database` in a form the static read cannot settle is refused with a code', async () => {
		for (
			const argument of [
				`{ id: 'notes', database: settings }`,
				`{ id: 'notes', database: { kind: process.env.KIND, provisioningSecret: 'DATABASE_URL' } }`,
				`{ id: 'notes', database: { kind: 'mysql', provisioningSecret: 'DATABASE_URL' } }`,
				`{ id: 'notes', database: { ...settings } }`,
			]
		) {
			expect([argument, await refusal({ 'fabrika.config.ts': cloudflareConfig(argument) })]).toEqual([argument, 'config-unreadable'])
		}
	})
})
