// Steps off the paved road in the reviewed snapshot: the reach each site declares and the database code the migrations
// declare. A new or widened one waits on a protected environment and applies at once elsewhere, always marked for
// closer review; a moved handler is no change; a refused migration fails the run; an old digest stays what it was.

import { canonicalArtifactJson, canonicalJson, sha256Hex } from '@fabrika/auth-core'
import { readContractSource } from '@fabrika/check/contract'
import { waitsForApproval } from '@fabrika/control-contract'
import type { BlobStore } from '@fabrika/platform'
import { uuidv7 } from '@fabrika/platform'
import type { DataLossStatement, MigrationDataLoss } from '@fabrika/platform-node/sql'
import type { ControlProvider } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { toAppEnvDto } from '../api/registry/registration'
import { completeApprovalUseCase } from '../approval/api'
import { snapshotDeviations } from '../approval/diff'
import { classifyAccess as classifyWithFacts } from '../approval/diff'
import { parseClassification, type StoredClassification } from '../approval/publish'
import { readAccessSnapshot, SNAPSHOT_LIMITS, snapshotReads, SnapshotRefused } from '../approval/read'
import { type AccessSnapshot, approvedSnapshot, parseSnapshot, serializePublished, serializeSnapshot, snapshotDigest } from '../approval/snapshot'
import type { ControlRepositories } from '../db'
import { executeDeploy, type RunDeps } from '../run-lifecycle'
import { VaultSecretResolver } from '../secret-resolver'
import { classifyAccess, type WordedChange, wordsOf } from './helpers/access'
import { memoryCommits } from './helpers/commits'
import { BASE } from './helpers/contracts'
import { createHarness } from './helpers/harness'
import { AUDIT_TRIGGER_MIGRATION, kitFiles, type KitOptions, NOTES_MIGRATION } from './helpers/kit-contract'
import { makeFakeLock } from './helpers/lock'

const COMMIT = 'c'.repeat(40)
const ORIGIN = 'https://control.example.test'

interface World {
	readonly db: ControlRepositories
	readonly logs: Map<string, string>
	/** The commit the next deploy reads. */
	files: Record<string, string>
	/** The provider's `applicationDialect`; absent means Postgres. */
	dialect?: 'postgres' | 'sqlite'
}

const migrationFiles = (...migrations: readonly { name: string; sql: string }[]): Record<string, string> =>
	Object.fromEntries(migrations.map((migration) => [`db/migrations/${migration.name}`, migration.sql]))

const commitOf = (options: KitOptions = {}, migrations = [NOTES_MIGRATION]): Record<string, string> => ({
	...kitFiles(options),
	...migrationFiles(...migrations),
})

const ENVELOPE = JSON.stringify({ provider: 'harbor', version: 1, payload: {} })

function provider(dialect?: 'postgres' | 'sqlite'): ControlProvider {
	return {
		id: 'harbor',
		normalizeRegistration: (input) => input,
		applicationRoot: () => '',
		resolveSource: () => Promise.resolve({ commitSha: COMMIT }),
		deploy: () => Promise.resolve({ state: 'succeeded' }),
		...(dialect === undefined ? {} : { applicationDialect: dialect }),
	}
}

function deps(w: World): RunDeps {
	const logs: Pick<BlobStore, 'put'> = {
		put: (key, value) => {
			if (typeof value === 'string') w.logs.set(key, value)
			return Promise.resolve()
		},
	}
	return {
		repositories: w.db,
		provider: provider(w.dialect),
		secrets: new VaultSecretResolver({}),
		lock: makeFakeLock(w.db),
		queue: { send: () => Promise.resolve() },
		logs,
		commits: { ...memoryCommits(), open: (input) => memoryCommits(w.files).open(input) },
	}
}

async function world(): Promise<World> {
	const { db } = createHarness()
	await db.registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes' })
	for (const env of ['prod', 'stage']) {
		await db.registry.upsertAppEnv({
			appId: 'notes',
			env,
			domain: `${env}.notes.example.test`,
			namespaceId: null,
			provider: 'harbor',
			providerTargetJson: ENVELOPE,
			providerArtifactJson: ENVELOPE,
		})
	}
	return { db, logs: new Map(), files: commitOf() }
}

interface Deployed {
	readonly runId: string
	readonly status: string
	/** Null when the run failed before it was classified. */
	readonly classification: StoredClassification | null
}

async function deploy(w: World, env: string): Promise<Deployed> {
	const runId = uuidv7()
	await w.db.runs.createRun({ id: runId, appId: 'notes', env, ref: 'refs/heads/main', trigger: 'manual', actor: 'user:test' })
	const { status } = await executeDeploy(deps(w), { runId })
	const stored = (await w.db.runs.getRun(runId))?.classification_json ?? null
	return { runId, status, classification: stored === null ? null : parseClassification(stored) }
}

function classified(deployed: Deployed): StoredClassification {
	if (deployed.classification === null) throw new Error(`run ${deployed.runId} was not classified`)
	return deployed.classification
}

/** A deploy that a person approves where it parks: the environment's published baseline for the next case. */
async function publish(w: World, env: string): Promise<void> {
	const first = await deploy(w, env)
	if (first.status === 'succeeded') return
	expect(first.status).toBe('awaiting_approval')
	await completeApprovalUseCase({
		repositories: w.db,
		auth: {
			ok: true,
			principal: { id: 'p-ada', type: 'user', label: 'ada@example.test' },
			can: () => true,
			scopedTo: () => null,
			audit: () => Promise.resolve(),
		},
		queue: { send: () => Promise.resolve() },
		lock: makeFakeLock(w.db),
		request: new Request(`${ORIGIN}/api/rpc`, { method: 'POST', headers: { Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin' } }),
	}, { runId: first.runId, decision: 'approve', ...digests(classified(first)) })
	expect((await executeDeploy(deps(w), { runId: first.runId })).status).toBe('succeeded')
}

const digests = (classification: StoredClassification) => ({
	candidateDigest: classification.candidateDigest,
	baselineDigest: classification.baselineDigest,
})

const closer = (classification: { readonly changes: readonly WordedChange[] }): string[] =>
	classification.changes.filter((change) => change.review === 'closer').map((change) => change.line)

async function snapshotOf(files: Record<string, string>, settled: AccessSnapshot['migrations'] = []): Promise<AccessSnapshot> {
	const commit = await memoryCommits(files).open({ repoUrl: 'github.com/acme/notes', commitSha: COMMIT, signal: new AbortController().signal })
	return readAccessSnapshot(commit, '', 'notes', settled)
}

async function environment(w: World, env: string) {
	const row = await w.db.registry.getAppEnv('notes', env)
	if (row === null) throw new Error(`no env ${env}`)
	return row
}

describe('declared reach in the reviewed snapshot', () => {
	test("a commit adding `sql: 'read'` parks on a protected environment and publishes at once on an unprotected one, marked for closer review in both", async () => {
		const w = await world()
		await publish(w, 'prod')
		await publish(w, 'stage')

		w.files = commitOf({ summary: "sql: 'read'" })
		const line = 'Endpoint `api.notes.summary` declares raw SQL (`read`)'
		const stage = await deploy(w, 'stage')
		expect(stage.status).toBe('succeeded')
		expect(classified(stage).outcome).toBe('widening')
		expect(wordsOf(classified(stage).changes)).toEqual([{ effect: 'widens', line, review: 'closer' }])

		const prod = await deploy(w, 'prod')
		expect(prod.status).toBe('awaiting_approval')
		expect(closer(classified(prod))).toEqual([line])
		expect([...w.logs.values()].join('\n')).toContain(
			'access: access widens on protected `prod` (1 changes, 1 widening, 0 narrowing, 0 unchanged, 1 needing closer review;',
		)

		// The environment page lists the published snapshot's deviations, protected or not.
		expect(toAppEnvDto(await environment(w, 'stage')).deviationSubjects).toEqual([
			{ subject: 'Endpoint `api.notes.summary`', steps: ['declares raw SQL (`read`)'] },
		])
		expect(toAppEnvDto(await environment(w, 'prod')).deviationSubjects).toEqual([])
	})

	test('`read` → `write` and a new `unscoped` table each widen with closer review; the way back narrows', async () => {
		const base = await snapshotOf(commitOf({ retitle: "sql: 'read', unscoped: { notes: 'read' }" }))
		const writes = await snapshotOf(commitOf({ retitle: "sql: 'write', unscoped: { notes: 'write' }" }))
		expect(snapshotDeviations(writes)).toEqual([
			{ subject: 'Endpoint `api.notes.retitle`', steps: ['declares raw SQL (`write`)', 'declares table `notes` unscoped (`write`)'] },
		])
		const wider = classifyAccess(base, writes)
		expect(wider.outcome).toBe('widening')
		expect(closer(wider)).toEqual([
			'Endpoint `api.notes.retitle` raw SQL changes from `read` to `write`',
			'Endpoint `api.notes.retitle` table `notes` unscoped changes from `read` to `write`',
		])
		expect(classifyAccess(writes, base)).toEqual({
			outcome: 'no-widening',
			changes: [
				{ effect: 'narrows', line: 'Endpoint `api.notes.retitle` raw SQL changes from `write` to `read`' },
				{ effect: 'narrows', line: 'Endpoint `api.notes.retitle` table `notes` unscoped changes from `write` to `read`' },
			],
		})

		const unscoped = classifyAccess(await snapshotOf(commitOf()), await snapshotOf(commitOf({ retitle: "unscoped: { audit: 'read' }" })))
		expect(unscoped).toEqual({
			outcome: 'widening',
			changes: [{ effect: 'widens', line: 'Endpoint `api.notes.retitle` declares table `audit` unscoped (`read`)', review: 'closer' }],
		})
	})

	test('a moved or rewritten handler body with the same declaration is no change, and its digest stays', async () => {
		const before = await snapshotOf(commitOf({ summary: "sql: 'read'" }))
		const after = await snapshotOf(commitOf({
			summary: "sql: 'read'",
			summaryBody: 'async ({ ctx }) => {\n\t\t\tconst note = await ctx.db.target.get()\n\t\t\treturn { title: note.title }\n\t\t}',
		}))
		expect(classifyAccess(before, after)).toEqual({ outcome: 'none', changes: [] })
		expect(snapshotDigest(after)).toBe(snapshotDigest(before))
	})

	test('a removed declaration narrows and runs through on a protected environment', async () => {
		const w = await world()
		w.files = commitOf({ summary: "sql: 'read'" })
		await publish(w, 'prod')
		expect(toAppEnvDto(await environment(w, 'prod')).deviationSubjects).toEqual([
			{ subject: 'Endpoint `api.notes.summary`', steps: ['declares raw SQL (`read`)'] },
		])

		w.files = commitOf()
		const removal = await deploy(w, 'prod')
		expect(removal.status).toBe('succeeded')
		expect(wordsOf(classified(removal).changes)).toEqual([{ effect: 'narrows', line: 'Endpoint `api.notes.summary` no longer declares raw SQL' }])
		expect(toAppEnvDto(await environment(w, 'prod')).deviationSubjects).toEqual([])
	})

	test('a contract that leaves the staged kit cannot be classified site by site: it widens with closer review', async () => {
		const kit = await snapshotOf(commitOf())
		expect(kit.contract?.declared).toEqual({})
		const plain: AccessSnapshot = { ...kit, contract: readContractSource(new Map([['fabrika.contract.ts', BASE]])) }
		expect(closer(classifyAccess(kit, plain))).toEqual([
			"The contract leaves the staged kit: its sites' reach off the paved road is no longer declared",
		])
		expect(classifyAccess(plain, kit).changes).toContainEqual({
			effect: 'narrows',
			line: 'The contract moves to the staged kit: each site reaches only what it declares',
		})
	})
})

describe('database code in the reviewed snapshot', () => {
	test('a declared trigger widens with closer review, by its object, and the environment lists it once published', async () => {
		const w = await world()
		await publish(w, 'prod')

		w.files = commitOf({}, [NOTES_MIGRATION, AUDIT_TRIGGER_MIGRATION])
		const parked = await deploy(w, 'prod')
		expect(parked.status).toBe('awaiting_approval')
		expect(wordsOf(classified(parked).changes)).toEqual([
			{ effect: 'widens', line: `New migration \`${AUDIT_TRIGGER_MIGRATION.name}\`` },
			{ effect: 'widens', line: `Migration \`${AUDIT_TRIGGER_MIGRATION.name}\` declares function \`record_retitle\``, review: 'closer' },
			{ effect: 'widens', line: `Migration \`${AUDIT_TRIGGER_MIGRATION.name}\` declares trigger \`notes.audit_retitle\``, review: 'closer' },
		])

		await publish(w, 'stage')
		expect(toAppEnvDto(await environment(w, 'stage')).deviationSubjects).toEqual([
			{
				subject: `Migration \`${AUDIT_TRIGGER_MIGRATION.name}\``,
				steps: ['declares function `record_retitle`', 'declares trigger `notes.audit_retitle`'],
			},
		])
	})

	test('the same database code in the next commit is no change; an edit of its file needs closer review again', async () => {
		const migrations = [NOTES_MIGRATION, AUDIT_TRIGGER_MIGRATION]
		const before = await snapshotOf(commitOf({}, migrations))
		expect(classifyAccess(before, await snapshotOf(commitOf({}, migrations)))).toEqual({ outcome: 'none', changes: [] })

		const edited = { ...AUDIT_TRIGGER_MIGRATION, sql: AUDIT_TRIGGER_MIGRATION.sql.replace('AFTER UPDATE', 'AFTER INSERT OR UPDATE') }
		expect(closer(classifyAccess(before, await snapshotOf(commitOf({}, [NOTES_MIGRATION, edited])))))
			.toEqual([
				`Migration \`${AUDIT_TRIGGER_MIGRATION.name}\` changes, and declares function \`record_retitle\``,
				`Migration \`${AUDIT_TRIGGER_MIGRATION.name}\` changes, and declares trigger \`notes.audit_retitle\``,
			])
	})

	test('a refused migration statement fails the run with its code and count, names nothing from the checkout, and publishes nothing', async () => {
		const w = await world()
		const secret = 'sk-live-0f3a9c'
		w.files = commitOf({}, [NOTES_MIGRATION, { name: '20261012110000_escape.sql', sql: `COPY notes TO PROGRAM 'curl ${secret}';` }])
		const refused = await deploy(w, 'stage')
		expect(refused.status).toBe('failed')
		expect(refused.classification).toBeNull()
		const log = w.logs.get(`runs/${refused.runId}/logs.ndjson`) ?? ''
		expect(log).toContain(
			'access: snapshot refused (migrations-refused, 1 problem); `fabrika-check` names each refused statement by file and line (rule migration-refused)',
		)
		expect(log).not.toContain(secret)
		expect((await environment(w, 'stage')).published_run_id).toBeNull()
	})

	test('a refused statement in a migration the environment already published, unchanged, does not refuse the read', async () => {
		const legacy = { name: '20261012110000_legacy.sql', sql: 'GRANT SELECT ON notes TO PUBLIC;' }
		const files = commitOf({}, [NOTES_MIGRATION, legacy])
		await expect(snapshotOf(files)).rejects.toEqual(new SnapshotRefused('migrations-refused', 1))
		const settled = [{ name: legacy.name, checksum: sha256Hex(legacy.sql) }]
		expect((await snapshotOf(files, settled)).migrations.map((migration) => migration.name)).toEqual([NOTES_MIGRATION.name, legacy.name])
		// An edit of the settled file is classified again, as the runner refuses it again.
		const edited = commitOf({}, [NOTES_MIGRATION, { ...legacy, sql: `${legacy.sql}\n` }])
		await expect(snapshotOf(edited, settled)).rejects.toEqual(new SnapshotRefused('migrations-refused', 1))
	})
})

describe("SQLite's table options in the provider's dialect", () => {
	const STRICT_MIGRATION = {
		name: '20261012100000_tags.sql',
		sql: 'CREATE TABLE tags (id TEXT PRIMARY KEY, note_id TEXT NOT NULL) STRICT, WITHOUT ROWID;',
	}

	test('a provider whose applications run on SQLite publishes a STRICT table; on Postgres the run fails as before', async () => {
		const sqlite = await world()
		sqlite.dialect = 'sqlite'
		sqlite.files = commitOf({}, [NOTES_MIGRATION, STRICT_MIGRATION])
		expect((await deploy(sqlite, 'stage')).status).toBe('succeeded')
		expect((await environment(sqlite, 'stage')).published_run_id).not.toBeNull()

		for (const dialect of [undefined, 'postgres'] as const) {
			const postgres = await world()
			if (dialect !== undefined) postgres.dialect = dialect
			postgres.files = commitOf({}, [NOTES_MIGRATION, STRICT_MIGRATION])
			const refused = await deploy(postgres, 'stage')
			expect({ dialect, status: refused.status }).toEqual({ dialect, status: 'failed' })
			expect(postgres.logs.get(`runs/${refused.runId}/logs.ndjson`) ?? '').toContain('access: snapshot refused (migrations-refused, 1 problem)')
		}
	})
})

describe('the files a snapshot may read', () => {
	/** The kit commit, its contract importing a module of `chars` characters (mostly a comment) per entry. */
	const padded = (sizes: readonly number[]): Record<string, string> => {
		const files = commitOf()
		const contract = files['fabrika.contract.ts'] ?? ''
		const imports = sizes.map((_, index) => `import { pad${index} } from './src/pad${index}'\n`).join('')
		const modules = Object.fromEntries(
			sizes.map((size, index) => [`src/pad${index}.ts`, `export const pad${index} = 1\n// ${'x'.repeat(size)}\n`]),
		)
		return { ...files, ...modules, 'fabrika.contract.ts': imports + contract }
	}

	test('a contract over the former 512 KiB limit is read', async () => {
		const snapshot = await snapshotOf(padded([400 * 1024, 400 * 1024]))
		expect(snapshot.contract?.app).toBe('notes')
	})

	test('modules a round names that together pass the total are refused before they are parsed', async () => {
		const sizes = Array.from({ length: 11 }, () => Math.floor(SNAPSHOT_LIMITS.readerFileBytes * 0.75))
		expect(sizes.reduce((total, size) => total + size, 0)).toBeGreaterThan(SNAPSHOT_LIMITS.readerTotalChars)
		await expect(snapshotOf(padded(sizes))).rejects.toEqual(new SnapshotRefused('contract-too-large'))
	})

	test('a module over the limit of one module is not read, so no reader of the window parses it', async () => {
		const files = padded([SNAPSHOT_LIMITS.readerFileBytes + 1])
		const commit = await memoryCommits(files).open({ repoUrl: 'github.com/acme/notes', commitSha: COMMIT, signal: new AbortController().signal })
		const reads: string[] = []
		const bounded = {
			paths: commit.paths,
			read: async (path: string, maxBytes: number): Promise<string> => {
				const text = await commit.read(path, maxBytes)
				if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error(`${path} is over ${maxBytes} bytes`)
				reads.push(path)
				return text
			},
		}
		await expect(readAccessSnapshot(bounded, '', 'notes')).rejects.toThrow('src/pad0.ts is over 524288 bytes')
		expect(reads).not.toContain('src/pad0.ts')
	})

	test('are the reader inputs and the migrations under the application root, nothing beside it', () => {
		const reads = snapshotReads('apps/notes')
		expect(
			['apps/notes/fabrika.contract.ts', 'apps/notes/tsconfig.json', 'apps/notes/bunfig.toml', 'apps/notes/db/migrations/0001.sql'].every(reads),
		).toBe(true)
		expect(['apps/notes/README.md', 'apps/other/fabrika.contract.ts', 'fabrika.contract.ts'].some(reads)).toBe(false)
		expect(snapshotReads('')('src/db/tables.ts')).toBe(true)
	})
})

const ADOPTION_MIGRATION = {
	name: '20261020120000_note_attachments.sql',
	sql: `CREATE TABLE note_attachments (id uuid PRIMARY KEY, file uuid NOT NULL REFERENCES fabrika_files (id));
SELECT fabrika_files_copy_legacy('attachments');
INSERT INTO note_attachments (id, file) SELECT id, id FROM fabrika_files_attachments;
SELECT fabrika_files_release('attachments');
`,
}

describe('a file collection adopted into a table (ADR-0061)', () => {
	const pair = (baseline: AccessSnapshot, candidate: AccessSnapshot): readonly WordedChange[] => classifyAccess(baseline, candidate).changes

	test('the snapshot records the adoption and the release, keeps them through storage, and leaves the digest as it was', async () => {
		const snapshot = await snapshotOf(commitOf({}, [NOTES_MIGRATION, ADOPTION_MIGRATION]))
		expect(snapshot.fileAdoptions).toEqual([
			{ step: 'adopt', collection: 'attachments', table: 'note_attachments', file: ADOPTION_MIGRATION.name, line: 3 },
			{ step: 'release', collection: 'attachments', file: ADOPTION_MIGRATION.name, line: 4 },
		])
		const stored = parseSnapshot(serializeSnapshot(snapshot))
		expect(stored.fileAdoptions).toEqual(snapshot.fileAdoptions)
		const { fileAdoptions: _, ...without } = snapshot
		expect(snapshotDigest(snapshot)).toBe(snapshotDigest(without))
		expect(JSON.parse(serializeSnapshot(await snapshotOf(commitOf())))).not.toHaveProperty('fileAdoptions')
		// A publication leaves them out: the diff reads them only from a candidate, and an older Control reads it.
		expect(JSON.parse(serializePublished(snapshot))).not.toHaveProperty('fileAdoptions')
		expect(parseSnapshot(serializePublished(snapshot))).toEqual(parseSnapshot(serializeSnapshot(without)))
	})

	test('a new adoption migration widens with closer review, its release narrows with closer review; an unchanged one adds nothing', async () => {
		const before = await snapshotOf(commitOf())
		const after = await snapshotOf(commitOf({}, [NOTES_MIGRATION, ADOPTION_MIGRATION]))
		const adoption = pair(before, after).filter((change) => change.line.includes('collection `attachments`'))
		expect(adoption).toEqual([
			{
				effect: 'widens',
				line:
					'Migration `20261020120000_note_attachments.sql` adopts the files of collection `attachments` into `note_attachments`: whoever the policy of `note_attachments` lets read a row reads its file',
				review: 'closer',
			},
			{
				effect: 'narrows',
				line:
					'Migration `20261020120000_note_attachments.sql` releases file collection `attachments`: its table is dropped, with every file no column adopted',
				review: 'closer',
			},
		])
		// A baseline that holds the file unchanged ran it already, also when it was read before adoptions were recorded.
		const { fileAdoptions: _, ...readBefore } = after
		expect(pair(readBefore, after)).toEqual([])
	})

	test('the run keeps the adoptions it was classified with, the publication leaves them out', async () => {
		const w = await world()
		w.files = commitOf({}, [NOTES_MIGRATION, ADOPTION_MIGRATION])
		await publish(w, 'stage')
		const published = await environment(w, 'stage')
		expect(JSON.parse(published.published_snapshot_json ?? '{}')).not.toHaveProperty('fileAdoptions')
		const run = await w.db.runs.getRun(published.published_run_id ?? '')
		expect(JSON.parse(run?.snapshot_json ?? '{}').fileAdoptions).toHaveLength(2)
	})
})

const DATA_LOSS_MIGRATION = {
	name: '20261117120000_drop_audit.sql',
	sql: `DELETE FROM notes WHERE title = '';
ALTER TABLE notes DROP COLUMN workspace_id;
DROP TABLE audit;
`,
}

describe('a migration that deletes data', () => {
	test('the snapshot records each statement, keeps them through storage, leaves the digest as it was, and the publication leaves them out', async () => {
		const snapshot = await snapshotOf(commitOf({}, [NOTES_MIGRATION, DATA_LOSS_MIGRATION]))
		expect(snapshot.dataLoss).toEqual([
			{ statement: 'DELETE', object: 'notes', file: DATA_LOSS_MIGRATION.name, line: 1 },
			{ statement: 'DROP COLUMN', object: 'notes.workspace_id', file: DATA_LOSS_MIGRATION.name, line: 2 },
			{ statement: 'DROP TABLE', object: 'audit', file: DATA_LOSS_MIGRATION.name, line: 3 },
		])
		expect(parseSnapshot(serializeSnapshot(snapshot)).dataLoss).toEqual(snapshot.dataLoss)
		const { dataLoss: _, ...without } = snapshot
		expect(snapshotDigest(snapshot)).toBe(snapshotDigest(without))
		expect(JSON.parse(serializeSnapshot(await snapshotOf(commitOf())))).not.toHaveProperty('dataLoss')
		expect(JSON.parse(serializePublished(snapshot))).not.toHaveProperty('dataLoss')
	})

	test('each statement of a new or changed file is its own closer-review line that leaves access unchanged; a file that ran adds none', async () => {
		const before = await snapshotOf(commitOf())
		const after = await snapshotOf(commitOf({}, [NOTES_MIGRATION, DATA_LOSS_MIGRATION]))
		const { changes } = classifyWithFacts(before, after)
		const lines = changes.filter((change) => change.rule === 'migration.deletes-data')
		expect(lines.map(({ effect, line, review, reason, subject }) => ({ effect, line, review, reason, subject }))).toEqual([
			{
				effect: 'neutral',
				line: 'Migration `20261117120000_drop_audit.sql` deletes data: deletes rows of `notes`',
				review: 'closer',
				reason: 'deletes-data',
				subject: { kind: 'migration', name: DATA_LOSS_MIGRATION.name },
			},
			{
				effect: 'neutral',
				line: 'Migration `20261117120000_drop_audit.sql` deletes data: drops column `notes.workspace_id` with its values',
				review: 'closer',
				reason: 'deletes-data',
				subject: { kind: 'migration', name: DATA_LOSS_MIGRATION.name },
			},
			{
				effect: 'neutral',
				line: 'Migration `20261117120000_drop_audit.sql` deletes data: drops table `audit` with every row',
				review: 'closer',
				reason: 'deletes-data',
				subject: { kind: 'migration', name: DATA_LOSS_MIGRATION.name },
			},
		])
		expect(waitsForApproval(changes)).toBe(true)
		expect(classifyWithFacts(after, after).changes).toEqual([])
		const edited = await snapshotOf(commitOf({}, [NOTES_MIGRATION, { ...DATA_LOSS_MIGRATION, sql: `${DATA_LOSS_MIGRATION.sql}\n` }]))
		expect(classifyWithFacts(after, edited).changes.filter((change) => change.rule === 'migration.deletes-data')).toHaveLength(3)
	})

	test('a new migration that keeps every row widens, needs no closer review, and does not wait', async () => {
		const before = await snapshotOf(commitOf())
		const added = { name: '20261117130000_titles.sql', sql: 'ALTER TABLE notes ADD COLUMN subtitle text;\n' }
		const { outcome, changes } = classifyWithFacts(before, await snapshotOf(commitOf({}, [NOTES_MIGRATION, added])))
		expect(outcome).toBe('widening')
		expect(changes.map((change) => change.rule)).toEqual(['migration.added'])
		expect(waitsForApproval(changes)).toBe(false)
	})
})

describe('a migration that overwrites data or calls database code', () => {
	/** Applied already: the type a later migration drops and the function a later one calls. */
	const SETTLED = {
		name: '20261117100000_status.sql',
		sql: "CREATE TYPE status AS ENUM ('open', 'done');\nCREATE FUNCTION purge_drafts() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\n",
	}
	const NAME = '20261117140000_change.sql'

	test('a DROP TYPE … CASCADE, an UPDATE and a call of database code each need closer review on their own line, and wait', async () => {
		const before = await snapshotOf(commitOf({}, [NOTES_MIGRATION, SETTLED]))
		for (
			const [sql, line] of [
				[
					'DROP TYPE status CASCADE;\n',
					`Migration \`${NAME}\` deletes data: drops \`type status\` with CASCADE, which also removes what depends on it, stored columns included`,
				],
				[
					"UPDATE notes SET title = '' WHERE title IS NULL;\n",
					`Migration \`${NAME}\` overwrites data: overwrites \`notes.title\` in every row it matches`,
				],
				[
					'INSERT INTO audit (id, workspace_id, note_id) SELECT id, workspace_id, id FROM notes WHERE purge_drafts() > 0;\n',
					`Migration \`${NAME}\` may change data: calls database code \`purge_drafts\``,
				],
			] as const
		) {
			const { changes } = classifyWithFacts(before, await snapshotOf(commitOf({}, [NOTES_MIGRATION, SETTLED, { name: NAME, sql }])))
			const closer = changes.filter((change) => change.review === 'closer')
			expect(closer.map(({ rule, reason, line }) => ({ rule, reason, line }))).toEqual([{
				rule: 'migration.deletes-data',
				reason: 'deletes-data',
				line,
			}])
			expect(waitsForApproval(changes)).toBe(true)
		}
	})

	test('filling and converting what the same file created does not wait', async () => {
		const before = await snapshotOf(commitOf())
		for (
			const sql of [
				'ALTER TABLE notes ADD COLUMN subtitle text;\nUPDATE notes SET subtitle = title;\n',
				'ALTER TABLE notes ADD COLUMN rank int;\nALTER TABLE notes ALTER rank TYPE bigint;\n',
				"CREATE TABLE drafts (id uuid PRIMARY KEY, body text);\nINSERT INTO drafts (id, body) SELECT id, title FROM notes;\nUPDATE drafts SET body = '';\n",
				"CREATE TABLE drafts (id uuid PRIMARY KEY, body text);\nINSERT INTO drafts (id, body) VALUES (gen_random_uuid(), '') ON CONFLICT (id) DO UPDATE SET body = excluded.body;\n",
			]
		) {
			const { changes } = classifyWithFacts(before, await snapshotOf(commitOf({}, [NOTES_MIGRATION, { name: NAME, sql }])))
			expect(changes.map((change) => change.rule)).toEqual(['migration.added'])
			expect(waitsForApproval(changes)).toBe(false)
		}
	})

	test('each form round 2 found losing stored data waits, or is refused', async () => {
		const before = await snapshotOf(commitOf())
		const waits = async (sql: string) => {
			const { changes } = classifyWithFacts(before, await snapshotOf(commitOf({}, [NOTES_MIGRATION, { name: NAME, sql }])))
			return { waits: waitsForApproval(changes), lines: changes.filter((change) => change.reason === 'deletes-data').map((change) => change.line) }
		}
		expect(
			await waits(
				"INSERT INTO notes AS conflict (id, workspace_id, title) VALUES (gen_random_uuid(), 'w', 't') ON CONFLICT (id) DO UPDATE SET title = excluded.title;\n",
			),
		)
			.toEqual({ waits: true, lines: [`Migration \`${NAME}\` overwrites data: overwrites rows of \`notes\` that already exist`] })
		expect(await waits("INSERT OR REPLACE INTO notes (id, workspace_id, title) VALUES ('1', 'w', 't');\n")).toEqual({
			waits: true,
			lines: [`Migration \`${NAME}\` may change data: \`INSERT OR REPLACE INTO\` at line 1`],
		})
		await expect(
			snapshotOf(commitOf({}, [NOTES_MIGRATION, { name: NAME, sql: 'CREATE TABLE kv (k TEXT PRIMARY KEY ON CONFLICT REPLACE, v TEXT);\n' }])),
		)
			.rejects.toEqual(new SnapshotRefused('migrations-refused', 1))
		expect(
			await waits(
				"ALTER TABLE audit ADD COLUMN title text;\nALTER INDEX audit RENAME TO audit_old;\nALTER INDEX notes RENAME TO audit;\nUPDATE audit SET title = '';\n",
			),
		)
			.toEqual({
				waits: true,
				lines: [
					`Migration \`${NAME}\` may change data: \`ALTER INDEX\` at line 2`,
					`Migration \`${NAME}\` may change data: \`ALTER INDEX\` at line 3`,
					`Migration \`${NAME}\` overwrites data: overwrites \`audit.title\` in every row it matches`,
				],
			})
	})

	test('every data-loss kind survives storage', async () => {
		const at = { file: NAME, line: 1 }
		const every: Record<DataLossStatement, MigrationDataLoss> = {
			'DROP TABLE': { statement: 'DROP TABLE', object: 'audit', ...at },
			'DROP COLUMN': { statement: 'DROP COLUMN', object: 'notes.title', ...at },
			'DROP CASCADE': { statement: 'DROP CASCADE', object: 'type status', ...at },
			TRUNCATE: { statement: 'TRUNCATE', object: 'notes', ...at },
			'TRUNCATE CASCADE': { statement: 'TRUNCATE CASCADE', object: 'notes', ...at },
			DELETE: { statement: 'DELETE', object: 'notes', ...at },
			UPDATE: { statement: 'UPDATE', object: 'notes', columns: ['title'], ...at },
			'UPDATE OR REPLACE': { statement: 'UPDATE OR REPLACE', object: 'notes', ...at },
			UPSERT: { statement: 'UPSERT', object: 'notes', ...at },
			'ALTER COLUMN TYPE': { statement: 'ALTER COLUMN TYPE', object: 'notes.title', ...at },
			CALL: { statement: 'CALL', object: 'purge', ...at },
			UNPROVEN: { statement: 'UNPROVEN', object: 'ALTER INDEX', ...at },
		}
		const snapshot = { ...(await snapshotOf(commitOf())), dataLoss: Object.values(every) }
		expect(parseSnapshot(serializeSnapshot(snapshot)).dataLoss).toEqual(Object.values(every))
	})
})

describe('the snapshot digest', () => {
	test('a snapshot without database code keeps the digest formula approvals were stored under', async () => {
		const snapshot = await snapshotOf(commitOf({ summary: "sql: 'read'" }))
		expect(snapshot.databaseCode).toBeUndefined()
		if (snapshot.contract === null) throw new Error('no contract')
		const before = `sha256:${sha256Hex(`${canonicalArtifactJson(snapshot.contract)}\n${canonicalJson(snapshot.migrations)}\nnull`)}`
		expect(snapshotDigest(snapshot)).toBe(before)
		expect(snapshotDigest(parseSnapshot(serializeSnapshot(snapshot)))).toBe(before)
		expect(JSON.parse(serializeSnapshot(snapshot))).not.toHaveProperty('databaseCode')
	})

	test('database code is in the digest and survives storage', async () => {
		const snapshot = await snapshotOf(commitOf({}, [NOTES_MIGRATION, AUDIT_TRIGGER_MIGRATION]))
		const stored = parseSnapshot(serializeSnapshot(snapshot))
		expect(stored.databaseCode?.map((deviation) => `${deviation.kind} ${deviation.object}`)).toEqual([
			'function record_retitle',
			'trigger notes.audit_retitle',
		])
		expect(snapshotDigest(stored)).toBe(snapshotDigest(snapshot))
		const { databaseCode: _, ...withoutCode } = snapshot
		expect(snapshotDigest(withoutCode)).not.toBe(snapshotDigest(snapshot))
		expect(
			snapshotDeviations(
				approvedSnapshot({
					app_id: 'notes',
					env: 'prod',
					published_run_id: 'run-1',
					published_snapshot_json: serializeSnapshot(snapshot),
					generation: 1,
				}).snapshot,
			).flatMap((subject) => subject.steps),
		).toHaveLength(2)
	})
})
