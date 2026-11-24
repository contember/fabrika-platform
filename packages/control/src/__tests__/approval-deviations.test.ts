// Steps off the paved road in the reviewed snapshot: the reach each site declares and the database code the migrations
// declare. A new or widened one waits on a protected environment and applies at once elsewhere, always marked for
// closer review; a moved handler is no change; a refused migration fails the run; an old digest stays what it was.

import { canonicalArtifactJson, canonicalJson, sha256Hex } from '@fabrika/auth-core'
import { readContractSource } from '@fabrika/check/contract'
import { DEFAULT_APPROVAL_CATEGORIES, waitsForApproval } from '@fabrika/control-contract'
import type { BlobStore } from '@fabrika/platform'
import { uuidv7 } from '@fabrika/platform'
import { migrationChecksum, readPostgresMigrationBundle } from '@fabrika/platform-node'
import type { DataLossStatement, MigrationDataLoss } from '@fabrika/platform-node/sql'
import type { ControlProvider } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toAppEnvDto } from '../api/registry/registration'
import { completeApprovalUseCase } from '../approval/api'
import { snapshotDeviations } from '../approval/diff'
import { classifyAccess as classifyWithFacts } from '../approval/diff'
import { parseClassification, type StoredClassification } from '../approval/publish'
import {
	AppliedMigrationsChanged,
	readAccessSnapshot,
	SNAPSHOT_LIMITS,
	type SnapshotReadOptions,
	snapshotReads,
	SnapshotRefused,
} from '../approval/read'
import { type AccessSnapshot, approvedSnapshot, parseSnapshot, serializePublished, serializeSnapshot, snapshotDigest } from '../approval/snapshot'
import type { ControlRepositories } from '../db'
import { gitHubCommitSource } from '../github/source/commit-files'
import { GitHubMetadataClient } from '../github/source/metadata'
import { executeDeploy, type RunDeps } from '../run-lifecycle'
import { VaultSecretResolver } from '../secret-resolver'
import { classifyAccess, type WordedChange, wordsOf } from './helpers/access'
import { frameworkLockfile, memoryCommits } from './helpers/commits'
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
	/** How the provider's next deploys end; absent means `succeeded`. */
	deployState?: 'succeeded' | 'failed'
	/** How many deploys reached the provider. */
	deploys: number
}

const migrationFiles = (...migrations: readonly { name: string; sql: string }[]): Record<string, string> =>
	Object.fromEntries(migrations.map((migration) => [`db/migrations/${migration.name}`, migration.sql]))

const commitOf = (options: KitOptions = {}, migrations = [NOTES_MIGRATION]): Record<string, string> => ({
	...kitFiles(options),
	...migrationFiles(...migrations),
})

const ENVELOPE = JSON.stringify({ provider: 'harbor', version: 1, payload: {} })

function provider(w: World): ControlProvider {
	return {
		id: 'harbor',
		normalizeRegistration: (input) => input,
		applicationRoot: () => '',
		resolveSource: () => Promise.resolve({ commitSha: COMMIT }),
		deploy: () => {
			w.deploys++
			return Promise.resolve({ state: w.deployState ?? 'succeeded' })
		},
		...(w.dialect === undefined ? {} : { applicationDialect: w.dialect }),
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
		provider: provider(w),
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
	return { db, logs: new Map(), files: commitOf(), deploys: 0 }
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
	return readAccessSnapshot(commit, '', 'notes', { settled })
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

/** `notes.summary`'s handler running one `ctx.sql` statement. */
const statementBody = (statement: string): string => `async ({ ctx }) => ({ title: (await ctx.sql(Summary)\`${statement}\`)[0]?.title ?? '' })`

const SCOPED = "select title from notes where ${ctx.sql.scope(ctx.target, 'notes')}"
const sqlCommit = (statement: string, extra: Record<string, string> = {}): Record<string, string> => ({
	...commitOf({ summary: "sql: 'read'", summaryBody: statementBody(statement) }),
	...extra,
})
/** Where the statement of `notes.summary` stands in the generated endpoints module. */
const summaryStatement = (): string => {
	const line = kitFiles({ summaryBody: statementBody(SCOPED) })['src/notes/endpoints.ts']?.split('\n').findIndex((text) => text.includes('ctx.sql('))
		?? -1
	return `src/notes/endpoints.ts:${line + 1}`
}
const QUERIES = 'src/notes/queries.ts'
const queries = (statement: string) => ({ [QUERIES]: `export const count = (sql) => sql(Count)\`${statement}\`\n` })

describe('SQL statements in the reviewed snapshot', () => {
	test('a statement edited under an unchanged `sql` declaration parks on a protected environment, as an off-road line', async () => {
		const w = await world()
		w.files = sqlCommit(SCOPED)
		await publish(w, 'prod')
		await publish(w, 'stage')

		// The scope fragment is dropped: the declaration is the same, the statement now reads every note.
		w.files = sqlCommit('select title from notes')
		const line = `The SQL statement at \`${summaryStatement()}\` changes`
		const prod = await deploy(w, 'prod')
		expect(prod.status).toBe('awaiting_approval')
		expect(classified(prod).changes).toEqual([
			{
				effect: 'widens',
				line,
				review: 'closer',
				reason: 'off-road',
				rule: 'application.sql-statement',
				subject: { kind: 'application', name: 'notes' },
			},
		])
		expect(waitsForApproval(classified(prod).changes, DEFAULT_APPROVAL_CATEGORIES)).toBe(true)
		expect(waitsForApproval(classified(prod).changes, DEFAULT_APPROVAL_CATEGORIES.filter((category) => category !== 'off-road'))).toBe(false)

		const stage = await deploy(w, 'stage')
		expect(stage.status).toBe('succeeded')
		expect(closer(classified(stage))).toEqual([line])
	})

	test('re-indenting or moving a statement is no change, and its digest stays', async () => {
		const before = await snapshotOf(sqlCommit(SCOPED))
		const moved = await snapshotOf(commitOf({
			summary: "sql: 'read'",
			summaryBody:
				`async ({ ctx }) => {\n\n\t\tconst rows = await ctx.sql(Summary)\`\n\t\t\t${SCOPED}\n\t\t\`\n\t\treturn { title: rows[0]?.title ?? '' }\n\t}`,
		}))
		expect(moved.sqlStatements?.[0]?.line).not.toBe(before.sqlStatements?.[0]?.line)
		expect(classifyAccess(before, moved)).toEqual({ outcome: 'none', changes: [] })
		expect(snapshotDigest(moved)).toBe(snapshotDigest(before))
		expect(snapshotDigest(await snapshotOf(sqlCommit('select title from notes')))).not.toBe(snapshotDigest(before))
	})

	test('a statement in another server module of any tag name is new, and its removal needs closer review too', async () => {
		const before = await snapshotOf(sqlCommit(SCOPED))
		const added = await snapshotOf(sqlCommit(SCOPED, queries('select count(*) from notes')))
		expect(closer(classifyAccess(before, added))).toEqual([`The SQL statement at \`${QUERIES}:1\` is new`])
		expect(closer(classifyAccess(added, before))).toEqual([`The SQL statement at \`${QUERIES}:1\` is removed`])
		// A test module and the SPA run no statement against the application's database.
		const elsewhere = await snapshotOf(
			sqlCommit(SCOPED, { 'src/notes/queries.test.ts': queries('select 1')[QUERIES] ?? '', 'web/app.ts': 'x`select 1`' }),
		)
		expect(classifyAccess(before, elsewhere)).toEqual({ outcome: 'none', changes: [] })
	})

	test('a module the parser refuses is compared as a whole', async () => {
		const before = await snapshotOf(sqlCommit(SCOPED, { [QUERIES]: 'export const = 1\n' }))
		expect(before.sqlStatements?.filter((entry) => entry.file === QUERIES)).toEqual([
			{ file: QUERIES, line: 0, digest: sha256Hex('export const = 1\n') },
		])
		const after = await snapshotOf(sqlCommit(SCOPED, { [QUERIES]: 'export const = 2\n' }))
		expect(closer(classifyAccess(before, after))).toEqual([`\`${QUERIES}\`, which Control cannot parse for its SQL statements, changes`])
	})

	test('a baseline read before statements were recorded shows none, and a site without `sql` records none', async () => {
		const { sqlStatements: _, ...older } = await snapshotOf(sqlCommit(SCOPED))
		expect(classifyAccess(older, await snapshotOf(sqlCommit('select title from notes')))).toEqual({ outcome: 'none', changes: [] })
		expect((await snapshotOf(commitOf({}, [NOTES_MIGRATION]))).sqlStatements).toBeUndefined()
		// A declaring site that runs no statement yet records an empty list, so its first statement compares.
		const empty = await snapshotOf(commitOf({ summary: "sql: 'read'" }))
		expect(empty.sqlStatements).toEqual([])
		expect(closer(classifyAccess(empty, await snapshotOf(sqlCommit(SCOPED))))).toEqual([`The SQL statement at \`${summaryStatement()}\` is new`])
	})

	test('the statements survive the publication, an empty list included', async () => {
		for (const snapshot of [await snapshotOf(sqlCommit(SCOPED)), await snapshotOf(commitOf({ summary: "sql: 'read'" }))]) {
			const published = parseSnapshot(serializePublished(snapshot))
			expect(published.sqlStatements).toEqual(snapshot.sqlStatements)
			expect(snapshotDigest(published)).toBe(snapshotDigest(snapshot))
		}
	})

	test('too many server modules, or too many statements, refuse the read', async () => {
		const many = Object.fromEntries(Array.from({ length: SNAPSHOT_LIMITS.sqlSources }, (_, index) => [`src/many/m${index}.ts`, 'export {}\n']))
		await expect(snapshotOf(sqlCommit(SCOPED, many))).rejects.toEqual(new SnapshotRefused('sources-too-large'))
		// Bounded on its own: the stored size of a snapshot an older reader read is not checked.
		const statements = Array.from({ length: SNAPSHOT_LIMITS.sqlStatements }, (_, index) => `q\`select ${index}\``).join('\n')
		await expect(snapshotOf(sqlCommit(SCOPED, { [QUERIES]: statements }))).rejects.toEqual(new SnapshotRefused('sources-too-large'))
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

describe('a migration the environment applied, changed since', () => {
	const TAGS_MIGRATION = { name: '20261012100000_tags.sql', sql: 'CREATE TABLE tags (id uuid PRIMARY KEY, workspace_id text NOT NULL);\n' }
	const applied = [{ name: NOTES_MIGRATION.name, checksum: sha256Hex(NOTES_MIGRATION.sql) }]
	const edited = { ...NOTES_MIGRATION, sql: `${NOTES_MIGRATION.sql}-- notes and their audit\n` }
	const allowed = 'as applied and put the change in a new migration (`bunx fabrika db new <slug>`)'

	const read = async (files: Record<string, string>, options: SnapshotReadOptions): Promise<AccessSnapshot> =>
		readAccessSnapshot(
			await memoryCommits(files).open({ repoUrl: 'github.com/acme/notes', commitSha: COMMIT, signal: new AbortController().signal }),
			'',
			'notes',
			options,
		)
	const refusal = async (files: Record<string, string>, options: SnapshotReadOptions): Promise<AppliedMigrationsChanged> => {
		try {
			await read(files, options)
		} catch (error) {
			if (error instanceof AppliedMigrationsChanged) return error
			throw error
		}
		throw new Error('the read was not refused')
	}

	test('is refused on either dialect, one line per file, byte for byte as the runners compare', async () => {
		const crlf = { ...NOTES_MIGRATION, sql: NOTES_MIGRATION.sql.replaceAll('\n', '\r\n') }
		const trailingSpace = { ...NOTES_MIGRATION, sql: NOTES_MIGRATION.sql.replace(';\n', '; \n') }
		for (const dialect of ['postgres', 'sqlite'] as const) {
			for (const changed of [edited, crlf, trailingSpace]) {
				const error = await refusal(commitOf({}, [changed, TAGS_MIGRATION]), { applied, dialect })
				expect(error.lines).toEqual([`db/migrations/${NOTES_MIGRATION.name}: an applied migration changed; leave it ${allowed}`])
				expect(error.message).toBe(`an applied migration changed: db/migrations/${NOTES_MIGRATION.name}; leave it ${allowed}`)
			}
		}
		const both = [...applied, { name: TAGS_MIGRATION.name, checksum: sha256Hex(TAGS_MIGRATION.sql) }]
		const twice = await refusal(commitOf({}, [edited, { ...TAGS_MIGRATION, sql: `${TAGS_MIGRATION.sql}\n` }]), { applied: both })
		expect(twice.lines).toHaveLength(2)
		expect(twice.message).toBe(
			`2 applied migrations changed: db/migrations/${NOTES_MIGRATION.name}, db/migrations/${TAGS_MIGRATION.name}; leave each ${allowed}`,
		)
	})

	test('an unchanged, a new or a removed one, a first deploy and a file no runner applies are not refused', async () => {
		for (const dialect of ['postgres', 'sqlite'] as const) {
			const unchangedAndNew = await read(commitOf({}, [NOTES_MIGRATION, TAGS_MIGRATION]), { applied, dialect })
			expect(unchangedAndNew.migrations.map(({ name }) => name)).toEqual([NOTES_MIGRATION.name, TAGS_MIGRATION.name])
			// Both runners tolerate a ledger row without its file: the database ahead of the code after a rollback.
			const removed = [...applied, { name: TAGS_MIGRATION.name, checksum: sha256Hex(TAGS_MIGRATION.sql) }]
			expect((await read(commitOf({}, [NOTES_MIGRATION]), { applied: removed, dialect })).migrations).toHaveLength(1)
			expect((await read(commitOf({}, [edited]), { applied: [], dialect })).migrations).toHaveLength(1)
		}
		// The checksum a snapshot records is the one the runners record, so both compare the same bytes.
		const crlf = { ...TAGS_MIGRATION, sql: 'CREATE TABLE tags (id uuid PRIMARY KEY, label text NOT NULL); -- štítky \r\n' }
		const [, recordedTags] = (await read(commitOf({}, [NOTES_MIGRATION, crlf]), {})).migrations
		expect(recordedTags).toEqual({ name: crlf.name, checksum: migrationChecksum(crlf.sql) })
		const notApplied = { name: 'seed/demo.sql', sql: '-- demo rows\n' }
		const recorded = [...applied, { name: notApplied.name, checksum: sha256Hex('-- other rows\n') }]
		expect((await read(commitOf({}, [NOTES_MIGRATION, notApplied]), { applied: recorded })).migrations).toHaveLength(2)
	})

	test('a deploy that changed one fails before the provider, names the file in the run log, and publishes nothing', async () => {
		for (const dialect of [undefined, 'sqlite'] as const) {
			const w = await world()
			if (dialect !== undefined) w.dialect = dialect
			expect((await deploy(w, 'stage')).status).toBe('succeeded')
			const published = (await environment(w, 'stage')).published_run_id

			w.files = commitOf({}, [edited])
			const refused = await deploy(w, 'stage')
			expect({ dialect, status: refused.status, classification: refused.classification }).toEqual({ dialect, status: 'failed', classification: null })
			expect(w.deploys).toBe(1)
			const log = w.logs.get(`runs/${refused.runId}/logs.ndjson`) ?? ''
			expect(log).toContain(`access: db/migrations/${NOTES_MIGRATION.name}: an applied migration changed; leave it ${allowed}`)
			expect(log).toContain(`deploy failed: an applied migration changed: db/migrations/${NOTES_MIGRATION.name}; leave it ${allowed}`)
			expect((await environment(w, 'stage')).published_run_id).toBe(published)
		}
	})

	test('a migration applied in one environment, edited, deploys to another where it never ran', async () => {
		const w = await world()
		expect((await deploy(w, 'stage')).status).toBe('succeeded')

		w.files = commitOf({}, [edited])
		await publish(w, 'prod')
		const prod = await environment(w, 'prod')
		const log = w.logs.get(`runs/${prod.published_run_id ?? ''}/logs.ndjson`) ?? ''
		expect(log).not.toContain('an applied migration changed')
	})

	test('a BOM-only edit passes Control, whose decoder drops a leading BOM, and the Postgres runner still refuses it', async () => {
		const bom = new Uint8Array([0xef, 0xbb, 0xbf])
		const text = new TextEncoder().encode(NOTES_MIGRATION.sql)
		const withBom = new Uint8Array([...bom, ...text])
		const files = new Map<string, Uint8Array<ArrayBuffer>>(
			Object.entries({ ...commitOf({}, []), 'bun.lock': frameworkLockfile() }).map(([path, body]) => [path, new TextEncoder().encode(body)]),
		)
		files.set(`db/migrations/${NOTES_MIGRATION.name}`, withBom)
		const tree = 'd'.repeat(40)
		const github = new GitHubMetadataClient({
			fetch: (input) => {
				const url = new URL(input.toString())
				const path = decodeURIComponent(url.pathname)
				if (path === `/repos/acme/notes/commits/${COMMIT}`) return Promise.resolve(Response.json({ sha: COMMIT, commit: { tree: { sha: tree } } }))
				if (path === `/repos/acme/notes/git/trees/${tree}`) {
					const entries = [...files.keys()].map((file) => ({ path: file, sha: 'b'.repeat(40), type: 'blob', mode: '100644' }))
					return Promise.resolve(Response.json({ sha: tree, truncated: false, tree: entries }))
				}
				const body = files.get(path.slice('/repos/acme/notes/contents/'.length))
				return Promise.resolve(body === undefined ? new Response(null, { status: 404 }) : new Response(body))
			},
		})
		const source = gitHubCommitSource(github, {
			repositoryToken: () => Promise.reject(new Error('a public repository needs no token')),
			ownerConnectionToken: () => Promise.resolve(undefined),
		})
		const commit = await source.open({ repoUrl: 'github.com/acme/notes', commitSha: COMMIT, signal: new AbortController().signal })
		const snapshot = await readAccessSnapshot(commit, '', 'notes', { applied })
		expect(snapshot.migrations).toEqual(applied)

		const directory = mkdtempSync(join(tmpdir(), 'bom-migration-'))
		try {
			writeFileSync(join(directory, NOTES_MIGRATION.name), withBom)
			const [runnerFile] = readPostgresMigrationBundle({ name: 'app', directory }).migrations
			expect(migrationChecksum(runnerFile?.sql ?? '')).not.toBe(applied[0]?.checksum)
		} finally {
			rmSync(directory, { recursive: true })
		}
	})

	test('a migration published by a deploy that failed may still change: a publication is not what the database applied', async () => {
		const w = await world()
		w.deployState = 'failed'
		expect((await deploy(w, 'stage')).status).toBe('failed')
		expect((await environment(w, 'stage')).published_run_id).not.toBeNull()

		w.deployState = 'succeeded'
		w.files = commitOf({}, [edited])
		const fixed = await deploy(w, 'stage')
		expect(fixed.status).toBe('succeeded')
		expect(wordsOf(classified(fixed).changes)).toContainEqual({ effect: 'widens', line: `Migration \`${NOTES_MIGRATION.name}\` changes` })
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

	test('a contract over the former 2 MiB limit is read', async () => {
		const snapshot = await snapshotOf(padded(Array.from({ length: 6 }, () => 400 * 1024)))
		expect(snapshot.contract?.app).toBe('notes')
	})

	test('a contract of 300 modules is read; one whose modules alone reach the file limit is refused', async () => {
		const read = await snapshotOf(padded(Array.from({ length: 300 }, () => 16)))
		expect(read.contract?.app).toBe('notes')
		await expect(snapshotOf(padded(Array.from({ length: SNAPSHOT_LIMITS.readerFiles }, () => 16)))).rejects.toEqual(
			new SnapshotRefused('contract-too-large'),
		)
	})

	test('modules a round names that together pass the total are refused before they are parsed', async () => {
		const size = Math.floor(SNAPSHOT_LIMITS.readerFileBytes * 0.75)
		const sizes = Array.from({ length: Math.floor(SNAPSHOT_LIMITS.readerTotalChars / size) + 1 }, () => size)
		expect(sizes.reduce((total, size) => total + size, 0)).toBeGreaterThan(SNAPSHOT_LIMITS.readerTotalChars)
		await expect(snapshotOf(padded(sizes))).rejects.toEqual(new SnapshotRefused('contract-too-large'))
	})

	test('a contract the reader accepts whose stored form would not fit its row is refused as too large', async () => {
		// 24 000 distinct fields of 60-character names: within every reader limit, about 2 MB in the shared encoding.
		const files = commitOf()
		const schemas = Array.from({ length: 24 }, (_, index) => {
			const fields = Array.from({ length: 1000 }, (_, field) => `\t${`f${index}_${field}_`.padEnd(60, 'x')}: z.string(),`).join('\n')
			return `export const S${index} = z.strictObject({\n${fields}\n})\n`
		})
		const modules = Object.fromEntries(
			Array.from(
				{ length: 4 },
				(_, module) => [`src/wide/s${module}.ts`, `import { z } from 'zod/v4'\n${schemas.slice(module * 6, module * 6 + 6).join('')}`],
			),
		)
		const imports = schemas.map((_, index) => `import { S${index} } from './s${Math.floor(index / 6)}'\n`).join('')
		const procedures = schemas.map((_, index) =>
			`\tq${index}: r.query({ input: ById, output: S${index}, access: { action: 'notes.read', on: 'note', from: 'id' } }),`
		)
		const wide = `import { z } from 'zod/v4'\nimport { app } from '../app-kit'\n${imports}\nconst ById = z.strictObject({ id: z.uuid() })\n\n`
			+ `export const wide = app.group({ callers: ['human'] }, (r) => ({\n${procedures.join('\n')}\n}))\n`
		const contract = (files['fabrika.contract.ts'] ?? '')
			.replace(
				"import { notes } from './src/notes/endpoints'\n",
				"import { notes } from './src/notes/endpoints'\nimport { wide } from './src/wide/endpoints'\n",
			)
			.replace("c.rpc('/api', { notes })", "c.rpc('/api', { notes, wide })")
		const large = { ...files, ...modules, 'src/wide/endpoints.ts': wide, 'fabrika.contract.ts': contract }
		expect(readContractSource(new Map(Object.entries(large))).endpoints.filter((row) => row.id.startsWith('api.wide.'))).toHaveLength(24)
		await expect(snapshotOf(large)).rejects.toEqual(new SnapshotRefused('contract-too-large'))
	}, 60_000)

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
		expect(waitsForApproval(changes, DEFAULT_APPROVAL_CATEGORIES)).toBe(true)
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
		expect(waitsForApproval(changes, DEFAULT_APPROVAL_CATEGORIES)).toBe(false)
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
			expect(waitsForApproval(changes, DEFAULT_APPROVAL_CATEGORIES)).toBe(true)
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
			expect(waitsForApproval(changes, DEFAULT_APPROVAL_CATEGORIES)).toBe(false)
		}
	})

	test('each form round 2 found losing stored data waits, or is refused', async () => {
		const before = await snapshotOf(commitOf())
		const waits = async (sql: string) => {
			const { changes } = classifyWithFacts(before, await snapshotOf(commitOf({}, [NOTES_MIGRATION, { name: NAME, sql }])))
			return {
				waits: waitsForApproval(changes, DEFAULT_APPROVAL_CATEGORIES),
				lines: changes.filter((change) => change.reason === 'deletes-data').map((change) => change.line),
			}
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
