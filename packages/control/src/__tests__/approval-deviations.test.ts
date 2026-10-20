// Steps off the paved road in the reviewed snapshot: the reach each site declares and the database code the migrations
// declare. A new or widened one waits on a protected environment and applies at once elsewhere, always marked for
// closer review; a moved handler is no change; a refused migration fails the run; an old digest stays what it was.

import { canonicalArtifactJson, canonicalJson, sha256Hex } from '@fabrika/auth-core'
import { readContractSource } from '@fabrika/check/contract'
import type { BlobStore } from '@fabrika/platform'
import { uuidv7 } from '@fabrika/platform'
import type { ControlProvider } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { toAppEnvDto } from '../api/registry/registration'
import { completeApprovalUseCase } from '../approval/api'
import { snapshotDeviations } from '../approval/diff'
import { parseClassification, type StoredClassification } from '../approval/publish'
import { readAccessSnapshot, snapshotReads, SnapshotRefused } from '../approval/read'
import { type AccessSnapshot, approvedSnapshot, parseSnapshot, serializeSnapshot, snapshotDigest } from '../approval/snapshot'
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
}

const migrationFiles = (...migrations: readonly { name: string; sql: string }[]): Record<string, string> =>
	Object.fromEntries(migrations.map((migration) => [`db/migrations/${migration.name}`, migration.sql]))

const commitOf = (options: KitOptions = {}, migrations = [NOTES_MIGRATION]): Record<string, string> => ({
	...kitFiles(options),
	...migrationFiles(...migrations),
})

const ENVELOPE = JSON.stringify({ provider: 'harbor', version: 1, payload: {} })

function provider(): ControlProvider {
	return {
		id: 'harbor',
		normalizeRegistration: (input) => input,
		applicationRoot: () => '',
		resolveSource: () => Promise.resolve({ commitSha: COMMIT }),
		deploy: () => Promise.resolve({ state: 'succeeded' }),
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
		provider: provider(),
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
			'access: snapshot refused (migrations-refused, 1 problem); `fabrika db migrate` names each refused statement by file and line',
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

describe('the files a snapshot may read', () => {
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
