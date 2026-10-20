// ADR-0050 end to end through Control: a run reads its snapshot at its commit, a widening waits on a protected
// environment and applies on an unprotected one, a pending change is published nowhere, only a person in the console
// approves, an approval holds only for its baseline, a lost publication classifies again, and a removal runs through.

import type { AuthContext } from '@fabrika/auth'
import { CONTRACT_FORMAT, contractDigest, permits, type Scope } from '@fabrika/auth-core'
import { contractDigest as contractDigest04 } from '@fabrika/auth-core-0.4'
import { contractDigest as contractDigest05 } from '@fabrika/auth-core-0.5'
import { readContractSource as readContractSource04 } from '@fabrika/check-0.4/contract'
import { readContractSource as readContractSource05 } from '@fabrika/check-0.5/contract'
import { CHECKER_VERSION, readContractSource } from '@fabrika/check/contract'
import { hashPlatformKey } from '@fabrika/email/platform'
import type { BlobStore } from '@fabrika/platform'
import { uuidv7 } from '@fabrika/platform'
import { checkoutRelativeDirectory } from '@fabrika/provider-cloudflare/runner'
import type { ControlProvider, ProviderDeployInput, ProviderDeployOutcome, ProviderNamespaceMember } from '@fabrika/provider-contract'
import { describe, expect, spyOn, test } from 'bun:test'
import { ControlApiError } from '../api/domain'
import { republishNamespace } from '../api/namespaces'
import { deleteAppUseCase } from '../api/registry/apps'
import type { RegistryUseCaseContext } from '../api/registry/context'
import { deleteAppEnvUseCase } from '../api/registry/environments'
import {
	type ApprovalUseCaseContext,
	completeApprovalUseCase,
	getApprovalUseCase,
	listApprovalsUseCase,
	setEnvironmentProtectionUseCase,
} from '../approval/api'
import { parseClassification } from '../approval/publish'
import { MIGRATION_GUIDE } from '../approval/readers'
import { type AccessSnapshot, approvedSnapshot, serializeSnapshot } from '../approval/snapshot'
import type { AppEnvRow, ControlRepositories, RunRow } from '../db'
import type { InstallationMail } from '../mail-transport'
import { type MembershipKeyIssuer, VaultMembershipTransport } from '../membership-transport'
import { VaultPlatformTransport } from '../platform-transport'
import { type ProviderReconcileDeps, reconcileProviderRuns } from '../provider-reconcile'
import type { ControlJobMessage } from '../run-lifecycle'
import { cancelDeploy, executeDeploy, providerEnvironment, type RunDeps } from '../run-lifecycle'
import { VaultSecretResolver } from '../secret-resolver'
import { Vault } from '../vault'
import { VaultWorkloadCredentials, type WorkloadKeyIssuer } from '../workload-credentials'
import { frameworkLockfile, memoryCommits } from './helpers/commits'
import { BASE, edited, WITH_EXPORT, WITHOUT_REMOVE } from './helpers/contracts'
import { createHarness, harnessDatabase, queryRows } from './helpers/harness'
import { kitFiles } from './helpers/kit-contract'
import { makeFakeLock } from './helpers/lock'
import { protectionRaceScenario } from './helpers/protection-race'
import { refusedClaimScenario } from './helpers/refused-claims'

const COMMIT = 'c'.repeat(40)

const approvedSnapshotOf = (row: AppEnvRow | null): AccessSnapshot | null => (row === null ? null : approvedSnapshot(row).snapshot)
const ORIGIN = 'https://control.example.test'

interface World {
	readonly db: ControlRepositories
	readonly sqlite: ReturnType<typeof createHarness>['sqlite']
	readonly deploys: ProviderDeployInput[]
	readonly republished: Array<{ namespace: string; members: readonly ProviderNamespaceMember[] }>
	readonly queued: ControlJobMessage[]
	readonly logs: Map<string, string>
	/** The source each run's commit reads: the contract the next deploy brings. */
	contract: string | null
	/** Every other file of that commit. */
	files: Record<string, string>
}

function world(): World {
	const { db, sqlite } = createHarness()
	return { db, sqlite, deploys: [], republished: [], queued: [], logs: new Map(), contract: BASE, files: {} }
}

const HARBOR_ARTIFACT = JSON.stringify({ provider: 'harbor', version: 1, payload: {} })

/** What an application without a contract published before those were refused: its gates, and no contract. */
const ARTIFACT_PUBLICATION = JSON.stringify({
	version: 1,
	contract: null,
	migrations: [],
	checker: '0.0.1',
	artifact: { gates: { rules: [{ path: '/*', kind: 'human' }] }, schema: null },
})

const MISSING_CONTRACT = 'access: the commit has no `fabrika.contract.ts`; Fabrika deploys an application only with a contract'

function provider(w: World): ControlProvider {
	return {
		id: 'harbor',
		normalizeRegistration: (input) => input,
		applicationRoot: (source) => checkoutRelativeDirectory(source.workerDir),
		resolveSource: () => Promise.resolve({ commitSha: COMMIT }),
		deploy: (input) => {
			w.deploys.push(input)
			return Promise.resolve({ state: 'succeeded' })
		},
		namespaces: {
			normalize: (namespace) => namespace,
			namespaceResourceClaims: () => [],
			registrationResourceClaims: () => [],
			provision: (input) => Promise.resolve(input.namespace),
			reconcile: (input) => Promise.resolve(input.namespace),
			republish: (input) => {
				w.republished.push({ namespace: input.namespace.id, members: input.members })
				return Promise.resolve({ namespace: input.namespace, settled: true })
			},
		},
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
		queue: { send: (message) => Promise.resolve(void w.queued.push(message)) },
		logs,
		commits: {
			...memoryCommits(),
			open: (input) => memoryCommits({ ...w.files, ...(w.contract === null ? {} : { 'fabrika.contract.ts': w.contract }) }).open(input),
		},
	}
}

async function seed(w: World, workerDir?: string): Promise<void> {
	await w.db.registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes', ...(workerDir === undefined ? {} : { workerDir }) })
	for (const env of ['prod', 'stage']) {
		await w.db.registry.createDeploymentNamespaceWithResourceClaims({
			id: `apps-${env}`,
			env,
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify({ provider: 'harbor', version: 1, payload: {} }),
			state: 'ready',
		}, [])
		await w.db.registry.upsertAppEnv({
			appId: 'notes',
			env,
			domain: `${env}.notes.example.test`,
			namespaceId: `apps-${env}`,
			provider: 'harbor',
			providerTargetJson: JSON.stringify({ provider: 'harbor', version: 1, payload: {} }),
			providerArtifactJson: HARBOR_ARTIFACT,
		})
	}
}

async function deploy(w: World, env: string, runId = uuidv7()): Promise<{ runId: string; status: string }> {
	await w.db.runs.createRun({ id: runId, appId: 'notes', env, ref: 'refs/heads/main', trigger: 'manual', actor: 'user:test' })
	return executeDeploy(deps(w), { runId })
}

async function run(w: World, runId: string): Promise<RunRow> {
	const row = await w.db.runs.getRun(runId)
	if (row === null) throw new Error(`no run ${runId}`)
	return row
}

async function published(w: World, env: string): Promise<{ runId: string | null; generation: number }> {
	const row = await w.db.registry.getAppEnv('notes', env)
	if (row === null) throw new Error(`no env ${env}`)
	return { runId: row.published_run_id, generation: row.generation }
}

function auth(
	options: { type?: 'user' | 'service'; oauth?: boolean; permissions?: readonly { action: string; scope: Scope | null }[] } = {},
): AuthContext & { readonly audited: string[] } {
	const entries = (options.permissions ?? [{ action: 'access.approve', scope: null }]).map((grant) => ({ ...grant, source: 'grant' as const }))
	const audited: string[] = []
	return {
		ok: true,
		principal: { id: 'p-ada', type: options.type ?? 'user', label: 'ada@example.test' },
		...(options.oauth === true ? { oauth: { app: 'vozka', clientId: 'https://claude.ai/oauth', scopes: ['deploy'], grantId: 'g', tokenId: 't' } } : {}),
		can: (action, scope) => permits(entries, action, scope),
		scopedTo: () => null,
		audit: (event) => Promise.resolve(void audited.push(event.action)),
		audited,
	}
}

function consoleRequest(headers: Record<string, string> = {}): Request {
	return new Request(`${ORIGIN}/api/rpc`, { method: 'POST', headers: { Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', ...headers } })
}

function approvals(w: World, caller: AuthContext, request = consoleRequest()): ApprovalUseCaseContext {
	return {
		repositories: w.db,
		auth: caller,
		queue: { send: (message) => Promise.resolve(void w.queued.push(message)) },
		lock: makeFakeLock(w.db),
		request,
	}
}

async function approve(w: World, runId: string, caller: AuthContext = auth(), request?: Request) {
	const row = await run(w, runId)
	if (row.classification_json === null) throw new Error('the run has no classification')
	const classification = parseClassification(row.classification_json)
	return completeApprovalUseCase(approvals(w, caller, request), {
		runId,
		decision: 'approve',
		candidateDigest: classification.candidateDigest,
		baselineDigest: classification.baselineDigest,
	})
}

/** A person refuses the parked run, against the classification it shows now. */
async function refuse(w: World, runId: string) {
	const row = await run(w, runId)
	const classification = parseClassification(row.classification_json ?? '')
	return completeApprovalUseCase(approvals(w, auth()), {
		runId,
		decision: 'reject',
		candidateDigest: classification.candidateDigest,
		baselineDigest: classification.baselineDigest,
	})
}

/** A run approved against the empty baseline, which waits again because `BASE` published first. */
async function lapsed(w: World): Promise<string> {
	await seed(w)
	w.contract = WITH_EXPORT
	const wider = await deploy(w, 'prod')
	await approve(w, wider.runId)
	w.contract = BASE
	const first = await deploy(w, 'prod')
	await approve(w, first.runId)
	await executeDeploy(deps(w), { runId: first.runId })
	expect((await executeDeploy(deps(w), { runId: wider.runId })).status).toBe('awaiting_approval')
	return wider.runId
}

const status = async (promise: Promise<unknown>): Promise<number> => {
	try {
		await promise
		return 200
	} catch (error) {
		return error instanceof ControlApiError ? error.httpStatus : 500
	}
}

const DIGEST = contractDigest(readContractSource(new Map([['fabrika.contract.ts', BASE]])))

describe('approved access through the run lifecycle', () => {
	test('a provider refuses an incompatible candidate before publication or a namespace rebuild, then permits it after repair', async () => {
		const w = world()
		await seed(w)
		expect((await deploy(w, 'stage')).status).toBe('succeeded')
		const before = await w.db.registry.getAppEnv('notes', 'stage')
		const namespace = await w.db.registry.getDeploymentNamespace('apps-stage')
		w.contract = WITH_EXPORT
		const d = deps(w)
		let compatible = false
		let checks = 0
		const checked: RunDeps = {
			...d,
			provider: {
				...d.provider,
				validateAccess: ({ environment, access }) => {
					checks++
					expect(environment.namespace?.id).toBe('apps-stage')
					expect(environment.access?.contract.endpoints.some((row) => row.id === 'api.export')).toBe(false)
					expect(access.contract.endpoints.some((row) => row.id === 'api.export')).toBe(true)
					if (!compatible) throw new Error('the pinned proxy cannot read the candidate; re-pin it first')
				},
			},
		}
		const attempt = async () => {
			const runId = uuidv7()
			await w.db.runs.createRun({ id: runId, appId: 'notes', env: 'stage', ref: 'refs/heads/main', trigger: 'manual', actor: 'user:test' })
			return executeDeploy(checked, { runId })
		}
		const refused = await attempt()
		expect(refused.status).toBe('failed')
		expect(checks).toBe(1)
		expect(await w.db.registry.getAppEnv('notes', 'stage')).toEqual(before)
		expect(await w.db.registry.getDeploymentNamespace('apps-stage')).toEqual(namespace)
		expect(w.republished).toHaveLength(1)
		expect(w.deploys).toHaveLength(1)
		expect(w.queued).toEqual([])
		expect(w.logs.get(`runs/${refused.runId}/logs.ndjson`)).toContain('re-pin it first')
		compatible = true
		expect((await attempt()).status).toBe('succeeded')
		expect(checks).toBe(2)
		expect(w.republished).toHaveLength(2)
		expect(w.deploys).toHaveLength(2)
	})

	test('a lost publication validates the candidate again against the updated environment', async () => {
		const w = world()
		await seed(w)
		await deploy(w, 'stage')
		const before = await published(w, 'stage')
		const publish = w.db.runs.publishRunSnapshot.bind(w.db.runs)
		w.db.runs.publishRunSnapshot = (id, expected, snapshot, fence) => {
			w.sqlite.query('UPDATE app_envs SET domain = ?, generation = generation + 1 WHERE app_id = ? AND env = ?')
				.run('changed.example.test', 'notes', 'stage')
			return publish(id, expected, snapshot, fence)
		}
		const d = deps(w)
		const seen: Array<string | undefined> = []
		const runId = uuidv7()
		await w.db.runs.createRun({ id: runId, appId: 'notes', env: 'stage', ref: 'refs/heads/main', trigger: 'manual', actor: 'user:test' })
		const result = await executeDeploy({
			...d,
			provider: {
				...d.provider,
				validateAccess: ({ environment }) => {
					seen.push(environment.domain)
					if (environment.domain === 'changed.example.test') throw new Error('placement changed')
				},
			},
		}, { runId })
		expect(result.status).toBe('failed')
		expect(seen).toEqual(['stage.notes.example.test', 'changed.example.test'])
		expect((await published(w, 'stage')).runId).toBe(before.runId)
		expect(w.republished).toHaveLength(1)
		expect(w.deploys).toHaveLength(1)
	})

	test('a widening applies at once on stage and waits on prod; the first deploy to a protected environment waits', async () => {
		const w = world()
		await seed(w)

		expect((await deploy(w, 'stage')).status).toBe('succeeded')
		const stage = await published(w, 'stage')
		expect(stage.generation).toBe(1)
		expect(w.deploys.map((input) => input.environment.access?.contractDigest)).toEqual([DIGEST])
		expect(w.republished.map((entry) => [entry.namespace, entry.members.map((member) => member.access?.contractDigest)])).toEqual([[
			'apps-stage',
			[DIGEST],
		]])

		const parked = await deploy(w, 'prod')
		expect(parked.status).toBe('awaiting_approval')
		const row = await run(w, parked.runId)
		expect(row.status).toBe('awaiting_approval')
		const classification = parseClassification(row.classification_json ?? '')
		expect(classification.outcome).toBe('widening')
		expect(classification.protected).toBe(true)
		expect(classification.baselineRunId).toBeNull()
		expect(classification.changes.map((change) => change.line)).toContain('The application becomes the contract application `notes`')
		expect(w.logs.get(`runs/${parked.runId}/logs.ndjson`)).toContain('waiting for a human with access.approve')
		expect(await published(w, 'prod')).toEqual({ runId: null, generation: 0 })
		expect(w.deploys).toHaveLength(1)
		expect(w.republished.map((entry) => entry.namespace)).toEqual(['apps-stage'])
	})

	test('a pending widening is published nowhere: no provider environment, namespace member or deploy carries it', async () => {
		const w = world()
		await seed(w)
		const parked = await deploy(w, 'prod')
		expect(parked.status).toBe('awaiting_approval')

		const prod = await w.db.registry.getAppEnv('notes', 'prod')
		if (prod === null) throw new Error('no prod')
		// Nothing is published, so the upload's own gates do not apply either.
		expect(prod).toMatchObject({ published_run_id: null, published_snapshot_json: null })
		const environment = await providerEnvironment(w.db, prod)
		expect(environment.access).toBeUndefined()
		await republishNamespace({ ...deps(w), queue: { send: () => Promise.resolve() } }, 'apps-prod', { wait: 'started' })
		expect(w.republished.at(-1)?.members.map((member) => member.access)).toEqual([undefined])
		expect(w.deploys).toEqual([])
	})

	test('a commit without `fabrika.contract.ts` fails its run on any environment, says why, and publishes nothing', async () => {
		const w = world()
		await seed(w)
		w.contract = null
		for (const env of ['stage', 'prod']) {
			const refused = await deploy(w, env)
			expect(refused.status).toBe('failed')
			expect(w.logs.get(`runs/${refused.runId}/logs.ndjson`)).toContain(MISSING_CONTRACT)
			expect(await published(w, env)).toEqual({ runId: null, generation: 0 })
		}
		expect(w.deploys).toEqual([])
		expect(w.republished).toEqual([])
	})

	test('dropping the contract from the commit fails the run, and the approved contract stays published', async () => {
		const w = world()
		await seed(w)
		const first = await deploy(w, 'prod')
		await approve(w, first.runId)
		await executeDeploy(deps(w), { runId: first.runId })
		const before = await published(w, 'prod')

		w.contract = null
		const dropped = await deploy(w, 'prod')
		expect(dropped.status).toBe('failed')
		expect(w.logs.get(`runs/${dropped.runId}/logs.ndjson`)).toContain(MISSING_CONTRACT)
		expect(await published(w, 'prod')).toEqual(before)
		expect(approvedSnapshotOf(await w.db.registry.getAppEnv('notes', 'prod'))?.contract?.app).toBe('notes')
	})

	test('a run whose snapshot was stored without a contract is refused like a new commit', async () => {
		const w = world()
		await seed(w)
		const runId = uuidv7()
		await w.db.runs.createRun({ id: runId, appId: 'notes', env: 'stage', ref: 'refs/heads/main', trigger: 'manual', actor: 'user:test' })
		w.sqlite.query('UPDATE runs SET snapshot_json = ? WHERE id = ?').run(ARTIFACT_PUBLICATION, runId)
		expect((await executeDeploy(deps(w), { runId })).status).toBe('failed')
		expect(w.logs.get(`runs/${runId}/logs.ndjson`)).toContain(MISSING_CONTRACT)
		expect(w.deploys).toEqual([])
	})

	test('a publication that holds artifact access approves nothing: the first contract waits on prod, and applies on stage', async () => {
		const w = world()
		await seed(w)
		const legacy = uuidv7()
		await w.db.runs.createRun({ id: legacy, appId: 'notes', env: 'prod', ref: 'refs/heads/main', trigger: 'manual', actor: 'user:test' })
		for (const env of ['prod', 'stage']) {
			w.sqlite.query('UPDATE app_envs SET published_run_id = ?, published_snapshot_json = ?, generation = 1 WHERE app_id = ? AND env = ?').run(
				legacy,
				ARTIFACT_PUBLICATION,
				'notes',
				env,
			)
		}
		const prod = await w.db.registry.getAppEnv('notes', 'prod')
		if (prod === null) throw new Error('no prod')
		expect((await providerEnvironment(w.db, prod)).access).toBeUndefined()

		const parked = await deploy(w, 'prod')
		expect(parked.status).toBe('awaiting_approval')
		const classification = parseClassification((await run(w, parked.runId)).classification_json ?? '')
		expect(classification).toMatchObject({ outcome: 'widening', protected: true, baselineRunId: null })
		expect(classification.changes.map((change) => change.line)).toContain('The application becomes the contract application `notes`')
		expect((await deploy(w, 'stage')).status).toBe('succeeded')
		expect(w.deploys.map((input) => [input.environment.env, input.environment.access?.contractDigest])).toEqual([['stage', DIGEST]])
	})

	test('the application root is read as the provider executes it: `.` and `./` are the repository root', async () => {
		for (const workerDir of ['.', './']) {
			const w = world()
			await seed(w, workerDir)
			const parked = await deploy(w, 'prod')
			expect(parked.status).toBe('awaiting_approval')
			expect(parseClassification((await run(w, parked.runId)).classification_json ?? '').outcome).toBe('widening')
		}
	})

	test('an application root that leaves the repository fails the run and publishes nothing', async () => {
		const w = world()
		await seed(w, 'a/../b')
		const refused = await deploy(w, 'stage')
		expect(refused.status).toBe('failed')
		expect(w.logs.get(`runs/${refused.runId}/logs.ndjson`)).toContain('access: snapshot refused (root-invalid, 1 problem)')
		expect(await published(w, 'stage')).toEqual({ runId: null, generation: 0 })
		expect(w.deploys).toEqual([])
	})

	test('a parked run can be cancelled; it fails without reaching the provider', async () => {
		const w = world()
		await seed(w)
		const parked = await deploy(w, 'prod')
		await cancelDeploy(deps(w), await run(w, parked.runId))
		expect((await run(w, parked.runId)).status).toBe('failed')
		expect(w.deploys).toEqual([])
		expect(await published(w, 'prod')).toEqual({ runId: null, generation: 0 })
	})

	test('a person in the console approves; the run classifies again, publishes and deploys with the approved access', async () => {
		const w = world()
		await seed(w)
		const parked = await deploy(w, 'prod')
		const caller = auth()

		const approval = await approve(w, parked.runId, caller)
		expect(approval.run.status).toBe('pending')
		expect(approval.approval).toMatchObject({ principalId: 'p-ada', label: 'ada@example.test', holds: true })
		expect(caller.audited).toEqual(['access.approve'])
		expect(w.queued).toEqual([{ runId: parked.runId }])

		expect((await executeDeploy(deps(w), { runId: parked.runId })).status).toBe('succeeded')
		expect(await published(w, 'prod')).toEqual({ runId: parked.runId, generation: 1 })
		expect(w.deploys.map((input) => input.environment.access?.contractDigest)).toEqual([DIGEST])
		expect(w.republished.at(-1)?.members.map((member) => member.access?.contractDigest)).toEqual([DIGEST])
	})

	test("an approval whose lines open no endpoint to the environment's origins carries no cross-origin list", async () => {
		const w = world()
		await seed(w)
		const parked = await deploy(w, 'prod')
		const approval = await getApprovalUseCase(approvals(w, auth()), parked.runId)
		expect(approval.changes.some((change) => change.environmentOrigins === true)).toBe(false)
		expect(approval.crossOrigins).toBeUndefined()
	})

	test("a waiting approval that opens an endpoint to the environment's origins shows the list as it stands now, which no approval covers", async () => {
		const w = world()
		const { 'fabrika.contract.ts': contract, ...files } = kitFiles({ summary: "admission: { origins: 'listed' }" })
		w.files = files
		w.contract = contract
		await seed(w)
		const parked = await deploy(w, 'prod')
		const read = () => getApprovalUseCase(approvals(w, auth()), parked.runId)
		expect((await read()).changes.filter((change) => change.environmentOrigins === true).map((change) => change.line)).toEqual([
			'New endpoint `api.notes.summary` (POST /api/notes.summary) for human callers with `notes.read` (on `note`), callable from a page on an origin the environment lists',
		])
		expect((await read()).crossOrigins).toEqual([])
		// The candidate's surface of the endpoints the lines name, the whole contract on a first deploy, most exposed first.
		expect((await read()).endpoints.map((endpoint) => endpoint.id)).toEqual(['health', 'api.notes.retitle', 'api.notes.summary'])

		await w.db.registry.upsertAppEnv({
			appId: 'notes',
			env: 'prod',
			domain: 'prod.notes.example.test',
			namespaceId: 'apps-prod',
			provider: 'harbor',
			providerTargetJson: JSON.stringify({ provider: 'harbor', version: 1, payload: {} }),
			providerArtifactJson: HARBOR_ARTIFACT,
			crossOrigins: ['https://shop.example.test'],
		})
		expect((await read()).crossOrigins).toEqual(['https://shop.example.test'])
		// The list renders no origins, so it reads none; a decided run shows none, since the list may have moved since.
		expect((await listApprovalsUseCase(approvals(w, auth()))).items.map((item) => item.crossOrigins)).toEqual([undefined])
		// Nor does it read the snapshot for the endpoints, which only the approval's own page shows.
		expect((await listApprovalsUseCase(approvals(w, auth()))).items.map((item) => item.endpoints)).toEqual([[]])
		expect((await approve(w, parked.runId)).crossOrigins).toBeUndefined()
		expect((await read()).crossOrigins).toBeUndefined()
	})

	test("a run classified before effects and today's outcome names reads by what it did: a job start leaves access unchanged", () => {
		const digest = `sha256:${'0'.repeat(64)}`
		const raw = JSON.stringify({
			outcome: 'widening',
			changes: [
				{ widens: true, line: 'Role `editor` gains `notes.delete`' },
				{ widens: false, line: 'Mount `old` is removed', review: 'closer' },
				{ widens: false, line: 'Form `apply` starts job `welcome` after each accepted submission, beside its schedule' },
				{ widens: false, line: 'Endpoint `api.kicks.touch` no longer starts job `digest` after a call' },
			],
			candidateDigest: digest,
			baselineDigest: digest,
			baselineRunId: null,
			protected: true,
		})
		const stored = parseClassification(raw)
		expect(stored.outcome).toBe('widening')
		const legacyOutcome = (outcome: string) => parseClassification(JSON.stringify({ ...JSON.parse(raw), outcome, changes: [] })).outcome
		expect([legacyOutcome('unchanged'), legacyOutcome('removal')]).toEqual(['none', 'no-widening'])
		expect(stored.changes).toEqual([
			{ effect: 'widens', line: 'Role `editor` gains `notes.delete`' },
			{ effect: 'narrows', line: 'Mount `old` is removed', review: 'closer' },
			{ effect: 'neutral', line: 'Form `apply` starts job `welcome` after each accepted submission, beside its schedule' },
			{ effect: 'neutral', line: 'Endpoint `api.kicks.touch` no longer starts job `digest` after a call' },
		])
	})

	test('a service principal, an OAuth (MCP) token, a key and an operator cannot approve', async () => {
		const w = world()
		await seed(w)
		const parked = await deploy(w, 'prod')
		const operator = auth({ permissions: [{ action: 'deploy.*', scope: null }] })

		expect(await status(approve(w, parked.runId, auth({ type: 'service' })))).toBe(403)
		expect(await status(approve(w, parked.runId, auth({ oauth: true })))).toBe(403)
		expect(await status(approve(w, parked.runId, auth(), consoleRequest({ Authorization: 'Bearer px_builder' })))).toBe(403)
		expect(await status(approve(w, parked.runId, operator))).toBe(404)
		expect((await run(w, parked.runId)).status).toBe('awaiting_approval')
		expect(w.queued).toEqual([])
	})

	test('an approval holds only for its baseline: another publication in between makes the run wait again', async () => {
		const w = world()
		await seed(w)
		w.contract = WITH_EXPORT
		const wider = await deploy(w, 'prod')
		await approve(w, wider.runId)

		w.contract = BASE
		const first = await deploy(w, 'prod')
		await approve(w, first.runId)
		expect((await executeDeploy(deps(w), { runId: first.runId })).status).toBe('succeeded')

		expect((await executeDeploy(deps(w), { runId: wider.runId })).status).toBe('awaiting_approval')
		const again = parseClassification((await run(w, wider.runId)).classification_json ?? '')
		expect(again.baselineRunId).toBe(first.runId)
		expect(again.changes.map((change) => change.line)).toEqual([
			'New endpoint `api.export` (POST /api/export) for human callers with `notes.read` (on `note`)',
		])
		expect(await published(w, 'prod')).toEqual({ runId: first.runId, generation: 1 })
		// The approval stays on the run, bound to the digests it approved, so the page says it lapsed.
		expect((await getApprovalUseCase(approvals(w, auth()), wider.runId)).approval).toMatchObject({ principalId: 'p-ada', holds: false })
	})

	test('refusing or cancelling a run whose approval lapsed drops the approval: nobody approved what it showed', async () => {
		const refused = world()
		const runId = await lapsed(refused)
		expect((await refuse(refused, runId)).approval).toBeNull()
		expect((await run(refused, runId)).status).toBe('failed')

		const cancelled = world()
		const parked = await lapsed(cancelled)
		await cancelDeploy(deps(cancelled), await run(cancelled, parked))
		expect(await run(cancelled, parked)).toMatchObject({ status: 'failed', approval_json: null })
	})

	test('an approved run that publishes against a newer baseline, where it no longer widens, keeps an approval that held', async () => {
		const w = world()
		await seed(w)
		w.contract = WITH_EXPORT
		const approved = await deploy(w, 'prod')
		await approve(w, approved.runId)
		const same = await deploy(w, 'prod')
		await approve(w, same.runId)
		expect((await executeDeploy(deps(w), { runId: same.runId })).status).toBe('succeeded')

		expect((await executeDeploy(deps(w), { runId: approved.runId })).status).toBe('succeeded')
		expect((await getApprovalUseCase(approvals(w, auth()), approved.runId)).approval).toMatchObject({ principalId: 'p-ada', holds: true })
	})

	test('a publication that loses the compare-and-swap classifies again against the snapshot that won', async () => {
		const w = world()
		await seed(w)
		const winner = await deploy(w, 'stage')
		const runs = w.db.runs
		const publish = runs.publishRunSnapshot.bind(runs)
		let raced = false
		runs.publishRunSnapshot = (id, expected, snapshotJson, fence) => {
			if (!raced) {
				raced = true
				w.sqlite.query('UPDATE app_envs SET published_run_id = ?, generation = generation + 1 WHERE app_id = ? AND env = ?').run(
					winner.runId,
					'notes',
					'stage',
				)
			}
			return publish(id, expected, snapshotJson, fence)
		}

		w.contract = WITH_EXPORT
		const loser = await deploy(w, 'stage')
		expect(loser.status).toBe('succeeded')
		expect(await published(w, 'stage')).toEqual({ runId: loser.runId, generation: 3 })
		expect(w.logs.get(`runs/${loser.runId}/logs.ndjson`)).toContain(
			'another publication, registry write or protection change landed first; classifying again',
		)
		expect(parseClassification((await run(w, loser.runId)).classification_json ?? '').baselineRunId).toBe(winner.runId)
	})

	test('a removal runs through on prod without approval', async () => {
		const w = world()
		await seed(w)
		const first = await deploy(w, 'prod')
		await approve(w, first.runId)
		await executeDeploy(deps(w), { runId: first.runId })

		w.contract = WITHOUT_REMOVE
		const removal = await deploy(w, 'prod')
		expect(removal.status).toBe('succeeded')
		const classification = parseClassification((await run(w, removal.runId)).classification_json ?? '')
		expect(classification.outcome).toBe('no-widening')
		expect(await published(w, 'prod')).toEqual({ runId: removal.runId, generation: 2 })
	})

	test('a change whose lines leave access unchanged publishes on prod without approval', async () => {
		const w = world()
		const PUBLIC = "app: c.spa('/', { dir: 'dist/app', access: { public: true } }),"
		const ROOT = "app: c.spa('/', { dir: 'dist/app', access: { member: true } }),"
		w.contract = edited(ROOT, `${PUBLIC}\n\tinterest: c.spa('/interest', { dir: 'dist/interest', access: { public: true } }),`)
		await seed(w)
		const first = await deploy(w, 'prod')
		await approve(w, first.runId)
		await executeDeploy(deps(w), { runId: first.runId })

		w.contract = edited(ROOT, PUBLIC)
		const neutral = await deploy(w, 'prod')
		expect(neutral.status).toBe('succeeded')
		const classification = parseClassification((await run(w, neutral.runId)).classification_json ?? '')
		expect(classification.outcome).toBe('no-widening')
		expect(classification.changes.map((change) => change.effect)).toEqual(['neutral'])
		expect(await published(w, 'prod')).toEqual({ runId: neutral.runId, generation: 2 })
	})

	test('the run log carries counts and codes, never a name from the checkout, parked or refused', async () => {
		const w = world()
		await seed(w)
		const secret = 'sk-live-0f3a9c'
		w.files = { [`db/migrations/0001_${secret}.sql`]: 'CREATE TABLE notes (id TEXT);' }
		const printed: string[] = []
		const info = spyOn(console, 'info').mockImplementation((...args: unknown[]) => void printed.push(args.map(String).join(' ')))
		try {
			expect((await deploy(w, 'prod')).status).toBe('awaiting_approval')
			w.contract = edited("app: 'notes',", `app: '${secret}',`)
			expect((await deploy(w, 'stage')).status).toBe('failed')
		} finally {
			info.mockRestore()
		}
		const logged = [...w.logs.values(), ...printed].join('\n')
		expect(logged).toContain('access: access widens on protected `prod` (')
		expect(logged).toContain('access: snapshot refused (contract-app-mismatch, 1 problem)')
		expect(logged).not.toContain(secret)
	})

	test('a contract the reader refuses fails the run with one actionable line per refusal, and publishes nothing', async () => {
		const w = world()
		await seed(w)
		w.contract = edited("app: 'notes',", 'app: `notes${1}`,')
		const refused = await deploy(w, 'stage')
		expect(refused.status).toBe('failed')
		expect(w.logs.get(`runs/${refused.runId}/logs.ndjson`)).toContain('access: snapshot refused (contract-invalid, 1 problem)')
		expect(await published(w, 'stage')).toEqual({ runId: null, generation: 0 })
		expect(w.deploys).toEqual([])
	})

	test('only a person with access.approve changes the protected flag, and it is audited', async () => {
		const w = world()
		await seed(w)
		expect(await status(setEnvironmentProtectionUseCase(approvals(w, auth({ type: 'service' })), { appId: 'notes', env: 'stage', protected: true })))
			.toBe(403)
		expect(await status(setEnvironmentProtectionUseCase(approvals(w, auth({ oauth: true })), { appId: 'notes', env: 'prod', protected: false })))
			.toBe(403)
		const caller = auth()
		const dto = await setEnvironmentProtectionUseCase(approvals(w, caller), { appId: 'notes', env: 'stage', protected: true })
		expect(dto.protected).toBe(true)
		expect(caller.audited).toEqual(['access.protect'])
		expect((await deploy(w, 'stage')).status).toBe('awaiting_approval')
	})

	test('turning protection off approves no parked run: it waits for a decision, while a new deploy publishes at once', async () => {
		const w = world()
		await seed(w)
		const parked = await deploy(w, 'prod')
		expect(parked.status).toBe('awaiting_approval')

		await setEnvironmentProtectionUseCase(approvals(w, auth()), { appId: 'notes', env: 'prod', protected: false })
		expect((await run(w, parked.runId)).status).toBe('awaiting_approval')
		expect(w.queued).toEqual([])

		const next = await deploy(w, 'prod')
		expect(next.status).toBe('succeeded')
		expect((await published(w, 'prod')).runId).toBe(next.runId)
		expect((await run(w, parked.runId)).status).toBe('awaiting_approval')

		await approve(w, parked.runId)
		expect((await executeDeploy(deps(w), { runId: parked.runId })).status).toBe('succeeded')
		expect(parseClassification((await run(w, parked.runId)).classification_json ?? '').protected).toBe(false)
	})

	test('a protection change while a run deploys answers 409 and changes nothing; once it is done, the change applies', async () => {
		const w = world()
		await seed(w)
		const runs = w.db.runs
		const publish = runs.publishRunSnapshot.bind(runs)
		const during: number[] = []
		runs.publishRunSnapshot = async (id, expected, snapshotJson, fence) => {
			during.push(await status(setEnvironmentProtectionUseCase(approvals(w, auth()), { appId: 'notes', env: 'stage', protected: true })))
			return publish(id, expected, snapshotJson, fence)
		}

		const deployed = await deploy(w, 'stage')
		expect(deployed.status).toBe('succeeded')
		expect(during).toEqual([409])
		expect(await published(w, 'stage')).toEqual({ runId: deployed.runId, generation: 1 })
		expect(await status(setEnvironmentProtectionUseCase(approvals(w, auth()), { appId: 'notes', env: 'stage', protected: true }))).toBe(200)
		expect(await w.db.registry.getAppEnv('notes', 'stage')).toMatchObject({ protected: 1, protection_revision: 1 })
	})
})

describe('protection survives the registry', () => {
	test('stale registry writes and a stale publication lose to a protection change (SQLite)', async () => {
		const w = world()
		await protectionRaceScenario(w.db, makeFakeLock(w.db))
	})

	test('a refused conditional put keeps none of its namespace claims (SQLite)', async () => {
		await refusedClaimScenario(world().db)
	})

	function registry(w: World, caller: AuthContext, request = consoleRequest()): RegistryUseCaseContext {
		return {
			repositories: w.db,
			provider: provider(w),
			auth: caller,
			signal: new AbortController().signal,
			admission: { request },
		}
	}

	const recreate = (w: World, env: string) =>
		w.db.registry.upsertAppEnv({
			appId: 'notes',
			env,
			namespaceId: null,
			provider: 'harbor',
			providerTargetJson: JSON.stringify({ provider: 'harbor', version: 1, payload: {} }),
			providerArtifactJson: JSON.stringify({ provider: 'harbor', version: 1, payload: {} }),
		})

	const protectionOf = async (w: World, env: string): Promise<number | undefined> => (await w.db.registry.getAppEnv('notes', env))?.protected

	test('deleting and recreating an environment keeps the protection a human set, and `prod` starts protected', async () => {
		const w = world()
		await seed(w)
		const human = auth({ permissions: [{ action: '*', scope: null }] })
		await setEnvironmentProtectionUseCase(approvals(w, human), { appId: 'notes', env: 'stage', protected: true })
		await setEnvironmentProtectionUseCase(approvals(w, human), { appId: 'notes', env: 'prod', protected: false })

		for (const env of ['stage', 'prod']) {
			expect(await deleteAppEnvUseCase(registry(w, human), 'notes', env)).toEqual({ ok: true })
			await recreate(w, env)
		}
		expect([await protectionOf(w, 'stage'), await protectionOf(w, 'prod')]).toEqual([1, 0])

		expect(await deleteAppUseCase(registry(w, human), 'notes')).toEqual({ ok: true })
		await w.db.registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes' })
		for (const env of ['stage', 'prod', 'preview']) await recreate(w, env)
		expect([await protectionOf(w, 'stage'), await protectionOf(w, 'prod'), await protectionOf(w, 'preview')]).toEqual([1, 0, 0])
		const fresh = world()
		await seed(fresh)
		expect(await protectionOf(fresh, 'prod')).toBe(1)
	})

	test('deleting a protected environment or its app takes a person in the console with access.approve', async () => {
		const w = world()
		await seed(w)
		const service = auth({ type: 'service', permissions: [{ action: 'app.manage', scope: null }] })
		const operator = auth({ permissions: [{ action: 'app.manage', scope: null }] })

		expect(await status(deleteAppEnvUseCase(registry(w, service), 'notes', 'prod'))).toBe(403)
		expect(await status(deleteAppEnvUseCase(registry(w, operator), 'notes', 'prod'))).toBe(403)
		expect(await status(deleteAppEnvUseCase(registry(w, auth(), consoleRequest({ Authorization: 'Bearer px_key' })), 'notes', 'prod'))).toBe(403)
		expect(await status(deleteAppEnvUseCase({ ...registry(w, auth()), admission: undefined }, 'notes', 'prod'))).toBe(403)
		expect(await status(deleteAppUseCase(registry(w, service), 'notes'))).toBe(403)
		expect(await protectionOf(w, 'prod')).toBe(1)

		// An unprotected environment needs only the caller's own action.
		expect(await deleteAppEnvUseCase(registry(w, service), 'notes', 'stage')).toEqual({ ok: true })
		expect(await deleteAppUseCase(registry(w, auth()), 'notes')).toEqual({ ok: true })
	})
})

/** Workload keys a vault holds, issued by a stand-in IAM that records each issue. */
async function credentialed(w: World) {
	const vault = await Vault.create(harnessDatabase(w.db), btoa(String.fromCharCode(...new Uint8Array(32).fill(7))))
	const issued: string[] = []
	const issuer: WorkloadKeyIssuer = {
		issue: (input) => {
			issued.push(`${input.app}/${input.kind}:${input.name}`)
			return Promise.resolve({ key: `px_${'k'.repeat(40)}${issued.length}`, credentialId: `credential-${issued.length}`, expiresAt: input.expiresAt })
		},
		revoke: () => Promise.reject(new Error('no import is removed here')),
	}
	return { issued, workloadCredentials: new VaultWorkloadCredentials(w.db.workloadCredentials, () => Promise.resolve(vault), issuer) }
}

describe('workload keys from the approved contract', () => {
	const WITH_JOB = edited(
		"\tapp: c.spa('/', { dir: 'dist/app', access: { member: true } }),\n",
		"\tapp: c.spa('/', { dir: 'dist/app', access: { member: true } }),\n\tjobs: { nightly: c.cron('0 3 * * *', { actions: ['notes.delete'] }) },\n",
	)

	test('a deploy hands each job of the approved contract its key, and no run log keeps it', async () => {
		const w = world()
		await seed(w)
		w.contract = WITH_JOB
		const { issued, workloadCredentials } = await credentialed(w)
		const loggingProvider = provider(w)
		const result = await executeDeploy({
			...deps(w),
			workloadCredentials,
			provider: {
				...loggingProvider,
				deploy: (input) => {
					input.events.log(`key=${input.managedEnvironment['FABRIKA_JOB_NIGHTLY_KEY'] ?? 'none'}`)
					return loggingProvider.deploy(input)
				},
			},
		}, { runId: await createdRun(w, 'stage') })
		expect(result.status).toBe('succeeded')
		expect(issued).toEqual(['notes@stage/job:nightly'])
		const key = w.deploys[0]?.managedEnvironment['FABRIKA_JOB_NIGHTLY_KEY']
		expect(key).toMatch(/^px_k+1$/)
		const stored = [...w.logs.values()].join('\n')
		expect(stored).toContain('key=[redacted]')
		expect(stored).not.toContain(String(key))
	})

	test('a contract with a job does not deploy where Control cannot issue its key', async () => {
		const w = world()
		await seed(w)
		w.contract = WITH_JOB
		const quiet = spyOn(console, 'error').mockImplementation(() => {})
		try {
			expect((await deploy(w, 'stage')).status).toBe('failed')
			expect(quiet.mock.calls.flat().map(String).join('\n')).toContain('this installation cannot issue their keys')
		} finally {
			quiet.mockRestore()
		}
		expect(w.deploys).toEqual([])
	})

	test('a dry run issues no key, and a contract without a workload needs none', async () => {
		const w = world()
		await seed(w)
		w.contract = WITH_JOB
		const { issued, workloadCredentials } = await credentialed(w)
		expect((await executeDeploy({ ...deps(w), workloadCredentials }, { runId: await createdRun(w, 'stage'), dryRun: true })).status).toBe('succeeded')
		w.contract = BASE
		expect((await executeDeploy(deps(w), { runId: await createdRun(w, 'stage') })).status).toBe('succeeded')
		expect(issued).toEqual([])
		expect(w.deploys.map((input) => Object.hasOwn(input.managedEnvironment, 'FABRIKA_JOB_NIGHTLY_KEY'))).toEqual([false, false])
	})
})

describe('the installation mail transport for a job that declares it', () => {
	const MAILING = `import { app } from './app-kit'

export const digest = app.cron('0 3 * * *', { actions: ['notes.read'], mailer: 'installation' }).handle(async () => {})
`
	/** The same job as a 0.5 application declares it: that release names a job's scope. */
	const MAILING_05 = MAILING.replace("actions: ['notes.read'],", "actions: ['notes.read'], scope: 'app',")
	const CONTRACT = `import { app } from './src/app-kit'
import { digest } from './src/jobs'
import { notes } from './src/notes/endpoints'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { notes }),
	health: c.health('/healthz'),
	jobs: { digest },
}))
`
	const RESEND_KEY = 're_private-installation-mail-key'
	const mailTransport: InstallationMail = {
		kind: 'transport',
		transport: {
			variables: { FABRIKA_EMAIL_PROVIDER: 'resend', FABRIKA_EMAIL_FROM: 'mail@example.test', FABRIKA_EMAIL_RESEND_API_KEY: RESEND_KEY },
			secretNames: new Set(['FABRIKA_EMAIL_RESEND_API_KEY']),
		},
	}
	const invalidTransport: InstallationMail = { kind: 'invalid', reason: 'Email configuration is invalid: FABRIKA_EMAIL_FROM is invalid' }
	const INVALID_REFUSAL =
		"the contract's job `digest` sends mail through the installation (mailer: 'installation'), and Control's mail transport is invalid"

	/** A release before the relay hands the installation's credential itself, as every release did before 0.7. */
	function mailingWorld(framework = '0.5.2'): World {
		const w = world()
		const { 'fabrika.contract.ts': _contract, ...files } = kitFiles()
		w.files = { ...files, 'src/jobs.ts': framework.startsWith('0.5.') ? MAILING_05 : MAILING, 'bun.lock': frameworkLockfile(framework) }
		w.contract = CONTRACT
		return w
	}

	const mailVariables = (input: ProviderDeployInput | undefined): string[] =>
		Object.keys(input?.managedEnvironment ?? {}).filter((name) => name.startsWith('FABRIKA_EMAIL_') || name.startsWith('FABRIKA_PLATFORM_')).sort()

	const CONTROL_ORIGIN = 'https://control.example.test'

	/** A Control that can relay: it issues the key and names the public origin an application reaches the relay on. */
	async function relayed(w: World): Promise<Pick<RunDeps, 'platformTransport' | 'controlOrigin'>> {
		const vault = await Vault.create(harnessDatabase(w.db), btoa(String.fromCharCode(...new Uint8Array(32).fill(7))))
		return { platformTransport: new VaultPlatformTransport(w.db.platformTransportKeys, () => Promise.resolve(vault)), controlOrigin: CONTROL_ORIGIN }
	}

	test('a deploy hands the whole transport, and no run log keeps its credential', async () => {
		const w = mailingWorld()
		await seed(w)
		const { workloadCredentials } = await credentialed(w)
		const loggingProvider = provider(w)
		const result = await executeDeploy({
			...deps(w),
			workloadCredentials,
			mailTransport,
			...(await relayed(w)),
			provider: {
				...loggingProvider,
				deploy: (input) => {
					input.events.log(`mail=${input.managedEnvironment['FABRIKA_EMAIL_RESEND_API_KEY'] ?? 'none'}`)
					return loggingProvider.deploy(input)
				},
			},
		}, { runId: await createdRun(w, 'stage') })
		expect(result.status).toBe('succeeded')
		const managed = w.deploys[0]?.managedEnvironment
		expect(mailVariables(w.deploys[0])).toEqual(['FABRIKA_EMAIL_FROM', 'FABRIKA_EMAIL_PROVIDER', 'FABRIKA_EMAIL_RESEND_API_KEY'])
		expect(managed?.['FABRIKA_EMAIL_RESEND_API_KEY']).toBe(RESEND_KEY)
		const stored = [...w.logs.values()].join('\n')
		expect(stored).toContain('mail=[redacted]')
		expect(stored).not.toContain(RESEND_KEY)
		expect(await w.db.platformTransportKeys.listForAppEnv('notes', 'stage')).toEqual([])
	})

	test("a 0.7 application behind a namespace proxy sends through Control's relay: its key, and nothing of the provider", async () => {
		const w = mailingWorld('0.7.0')
		await seed(w)
		const { workloadCredentials } = await credentialed(w)
		const loggingProvider = provider(w)
		const result = await executeDeploy({
			...deps(w),
			workloadCredentials,
			mailTransport,
			...(await relayed(w)),
			provider: {
				...loggingProvider,
				deploy: (input) => {
					input.events.log(`relay=${input.managedEnvironment['FABRIKA_PLATFORM_MAIL_KEY'] ?? 'none'}`)
					return loggingProvider.deploy(input)
				},
			},
		}, { runId: await createdRun(w, 'stage') })
		expect(result.status).toBe('succeeded')
		const managed = w.deploys[0]?.managedEnvironment
		expect(mailVariables(w.deploys[0])).toEqual(['FABRIKA_EMAIL_PROVIDER', 'FABRIKA_PLATFORM_MAIL_KEY', 'FABRIKA_PLATFORM_MAIL_URL'])
		expect(managed?.['FABRIKA_EMAIL_PROVIDER']).toBe('platform')
		expect(managed?.['FABRIKA_PLATFORM_MAIL_URL']).toBe(CONTROL_ORIGIN)
		const key = managed?.['FABRIKA_PLATFORM_MAIL_KEY'] ?? ''
		expect(key).toMatch(/^px_[A-Za-z0-9_-]{27}$/)
		expect(await w.db.platformTransportKeys.findValidByHash(await hashPlatformKey(key), Math.floor(Date.now() / 1000))).toMatchObject({
			app_id: 'notes',
			env: 'stage',
			receiver: 'mail',
		})
		const stored = [...w.logs.values()].join('\n')
		expect(stored).toContain('relay=[redacted]')
		expect(stored).not.toContain(key)
		expect(stored).not.toContain(RESEND_KEY)

		// The next deploy hands the same key while it is fresh.
		expect(
			(await executeDeploy({ ...deps(w), workloadCredentials, mailTransport, ...(await relayed(w)) }, {
				runId: await createdRun(w, 'stage'),
			})).status,
		)
			.toBe('succeeded')
		expect(w.deploys[1]?.managedEnvironment['FABRIKA_PLATFORM_MAIL_KEY']).toBe(key)
	})

	test("the relay holds what Control cannot send, so a 0.7 application deploys where Control's transport is invalid or absent", async () => {
		for (const transport of [{ mailTransport: invalidTransport }, {}]) {
			const w = mailingWorld('0.7.0')
			await seed(w)
			const { workloadCredentials } = await credentialed(w)
			const result = await executeDeploy({ ...deps(w), workloadCredentials, ...transport, ...(await relayed(w)) }, {
				runId: await createdRun(w, 'stage'),
			})
			expect(result.status).toBe('succeeded')
			expect(w.deploys[0]?.managedEnvironment['FABRIKA_EMAIL_PROVIDER']).toBe('platform')
			expect(mailVariables(w.deploys[0])).toEqual(['FABRIKA_EMAIL_PROVIDER', 'FABRIKA_PLATFORM_MAIL_KEY', 'FABRIKA_PLATFORM_MAIL_URL'])
		}
	})

	test('a 0.7 application does not deploy behind a namespace proxy where Control cannot issue the key', async () => {
		const w = mailingWorld('0.7.0')
		await seed(w)
		const { workloadCredentials } = await credentialed(w)
		const quiet = spyOn(console, 'error').mockImplementation(() => {})
		try {
			expect(
				(await executeDeploy({ ...deps(w), workloadCredentials, mailTransport, controlOrigin: CONTROL_ORIGIN }, { runId: await createdRun(w, 'stage') }))
					.status,
			).toBe('failed')
			expect(quiet.mock.calls.flat().map(String).join('\n')).toContain('cannot issue the platform transport key')
		} finally {
			quiet.mockRestore()
		}
		expect(w.deploys).toEqual([])
	})

	test('a 0.7 application does not deploy behind a namespace proxy where Control names no public origin: its project cannot reach the private one', async () => {
		const w = mailingWorld('0.7.0')
		await seed(w)
		const { workloadCredentials } = await credentialed(w)
		const { platformTransport } = await relayed(w)
		const quiet = spyOn(console, 'error').mockImplementation(() => {})
		try {
			for (const dryRun of [false, true]) {
				const result = await executeDeploy({ ...deps(w), workloadCredentials, mailTransport, platformTransport }, {
					runId: await createdRun(w, 'stage'),
					dryRun,
				})
				expect(result.status).toBe('failed')
			}
			expect(quiet.mock.calls.flat().map(String).join('\n')).toContain('Control names no public origin for the application to reach it on')
		} finally {
			quiet.mockRestore()
		}
		expect(w.deploys).toEqual([])
		expect(await w.db.platformTransportKeys.listForAppEnv('notes', 'stage')).toEqual([])
	})

	test('a snapshot read before Control recorded the framework release is an older application: it gets the credential', async () => {
		const w = mailingWorld('0.7.0')
		await seed(w)
		const { workloadCredentials } = await credentialed(w)
		expect(
			(await executeDeploy({ ...deps(w), workloadCredentials, mailTransport, ...(await relayed(w)) }, {
				runId: await createdRun(w, 'stage'),
			})).status,
		)
			.toBe('succeeded')
		const recorded = approvedSnapshotOf(await w.db.registry.getAppEnv('notes', 'stage'))
		if (recorded === null) throw new Error('nothing is published')
		const { framework, ...unrecorded } = recorded
		expect(framework).toBe('0.7.0')
		w.sqlite.query("UPDATE app_envs SET published_snapshot_json = ? WHERE app_id = 'notes' AND env = 'stage'").run(serializeSnapshot(unrecorded))
		// A dry run deploys the approved snapshot as stored, without reading the commit again.
		const dryRun = await executeDeploy({ ...deps(w), mailTransport, ...(await relayed(w)) }, {
			runId: await createdRun(w, 'stage'),
			dryRun: true,
		})
		expect(dryRun.status).toBe('succeeded')
		expect(mailVariables(w.deploys[1])).toEqual(['FABRIKA_EMAIL_FROM', 'FABRIKA_EMAIL_PROVIDER', 'FABRIKA_EMAIL_RESEND_API_KEY'])
	})

	test('a dry run of a 0.7 application hands the relay and issues no key; dropping the job forgets the key', async () => {
		const w = mailingWorld('0.7.0')
		await seed(w)
		const { workloadCredentials } = await credentialed(w)
		const relayDeps = { ...deps(w), workloadCredentials, mailTransport, ...(await relayed(w)) }
		expect((await executeDeploy(relayDeps, { runId: await createdRun(w, 'stage') })).status).toBe('succeeded')
		expect(await w.db.platformTransportKeys.listForAppEnv('notes', 'stage')).toHaveLength(1)

		expect((await executeDeploy(relayDeps, { runId: await createdRun(w, 'stage'), dryRun: true })).status).toBe('succeeded')
		expect(mailVariables(w.deploys[1])).toEqual(['FABRIKA_EMAIL_PROVIDER', 'FABRIKA_PLATFORM_MAIL_URL'])
		expect(await w.db.platformTransportKeys.listForAppEnv('notes', 'stage')).toHaveLength(1)

		w.contract = kitFiles()['fabrika.contract.ts'] ?? null
		expect((await executeDeploy(relayDeps, { runId: await createdRun(w, 'stage') })).status).toBe('succeeded')
		expect(mailVariables(w.deploys[2])).toEqual([])
		expect(await w.db.platformTransportKeys.listForAppEnv('notes', 'stage')).toEqual([])
		expect(queryRows(w.sqlite, "SELECT id FROM vault WHERE label LIKE 'platform:platform-key:%'")).toEqual([])
	})

	/** A 0.7 mailer deployed once, so its key is live, and the contract the next deploy brings without the job. */
	async function droppingTheJob() {
		const w = mailingWorld('0.7.0')
		await seed(w)
		const { workloadCredentials } = await credentialed(w)
		const relayDeps = { ...deps(w), workloadCredentials, mailTransport, ...(await relayed(w)) }
		expect((await executeDeploy(relayDeps, { runId: await createdRun(w, 'stage') })).status).toBe('succeeded')
		const key = w.deploys[0]?.managedEnvironment['FABRIKA_PLATFORM_MAIL_KEY'] ?? ''
		const live = async () => (await w.db.platformTransportKeys.findValidByHash(await hashPlatformKey(key), Math.floor(Date.now() / 1000))) !== null
		expect(await live()).toBe(true)
		w.contract = kitFiles()['fabrika.contract.ts'] ?? null
		return { w, relayDeps, live }
	}

	test('a failed deploy that drops the job keeps the running version sending: its key stays valid until a deploy succeeds', async () => {
		const { w, relayDeps, live } = await droppingTheJob()
		const quiet = spyOn(console, 'error').mockImplementation(() => {})
		try {
			const failed = (): Promise<ProviderDeployOutcome> => Promise.resolve({ state: 'failed' })
			const failing = { ...relayDeps, provider: { ...relayDeps.provider, deploy: failed } }
			expect((await executeDeploy(failing, { runId: await createdRun(w, 'stage') })).status).toBe('failed')
			expect(await live()).toBe(true)
			const throwing = { ...relayDeps, provider: { ...relayDeps.provider, deploy: () => Promise.reject(new Error('the build failed')) } }
			expect((await executeDeploy(throwing, { runId: await createdRun(w, 'stage') })).status).toBe('failed')
			expect(await live()).toBe(true)
		} finally {
			quiet.mockRestore()
		}
		expect((await executeDeploy(relayDeps, { runId: await createdRun(w, 'stage') })).status).toBe('succeeded')
		expect(await live()).toBe(false)
		expect(queryRows(w.sqlite, "SELECT id FROM vault WHERE label LIKE 'platform:platform-key:%'")).toEqual([])
	})

	test('a deploy the provider accepted revokes the dropped key only when the reconcile or the cancellation settles it succeeded', async () => {
		const settlements: Record<string, (deps: ProviderReconcileDeps, w: World) => Promise<void>> = {
			reconcile: async (settleDeps) => void (await reconcileProviderRuns(settleDeps)),
			cancellation: async (settleDeps, w) => {
				const [inFlight] = await w.db.runs.listInFlightRuns('harbor')
				if (inFlight === undefined) throw new Error('no run in flight')
				await cancelDeploy(settleDeps, inFlight)
			},
		}
		for (const [path, settle] of Object.entries(settlements)) {
			const { w, relayDeps, live } = await droppingTheJob()
			const settles: { outcome: 'succeeded' | 'failed' } = { outcome: 'failed' }
			const accepting: ControlProvider = {
				...relayDeps.provider,
				deploy: async (input) => {
					await input.events.externalId(`version-${input.runId}`)
					return { state: 'running' }
				},
				reconcile: () => Promise.resolve({ state: settles.outcome }),
				cancel: () => Promise.resolve({ state: 'settled', outcome: settles.outcome }),
			}
			const settleDeps = { repositories: w.db, provider: accepting, lock: relayDeps.lock, platformTransport: relayDeps.platformTransport }
			const outcomes: ReadonlyArray<'failed' | 'succeeded'> = ['failed', 'succeeded']
			for (const outcome of outcomes) {
				settles.outcome = outcome
				const runId = await createdRun(w, 'stage')
				expect((await executeDeploy({ ...relayDeps, provider: accepting }, { runId })).status).toBe('running')
				expect(await live()).toBe(true)
				await settle(settleDeps, w)
				expect({ path, outcome, status: (await run(w, runId)).status }).toEqual({ path, outcome, status: outcome })
				expect({ path, outcome, live: await live() }).toEqual({ path, outcome, live: outcome === 'failed' })
			}
		}
	})

	test('an installation without a transport deploys the contract, and hands its job the explicit none', async () => {
		const w = mailingWorld()
		await seed(w)
		const { workloadCredentials } = await credentialed(w)
		expect((await executeDeploy({ ...deps(w), workloadCredentials }, { runId: await createdRun(w, 'stage') })).status).toBe('succeeded')
		expect(w.deploys[0]?.managedEnvironment['FABRIKA_EMAIL_PROVIDER']).toBe('none')
		expect(mailVariables(w.deploys[0])).toEqual(['FABRIKA_EMAIL_PROVIDER'])
	})

	test('an invalid transport refuses the deploy that needs it, and points at the operator step', async () => {
		const w = mailingWorld()
		await seed(w)
		const { workloadCredentials } = await credentialed(w)
		const quiet = spyOn(console, 'error').mockImplementation(() => {})
		try {
			const result = await executeDeploy({ ...deps(w), workloadCredentials, mailTransport: invalidTransport }, { runId: await createdRun(w, 'stage') })
			expect(result.status).toBe('failed')
		} finally {
			quiet.mockRestore()
		}
		const logs = [...w.logs.values()].join('\n')
		expect(logs).toContain(INVALID_REFUSAL)
		expect(logs).toContain("'Set or rotate the mail transport'")
		expect(w.deploys).toEqual([])
	})

	test('a dry run of the approved contract hands the same transport, and is refused the same way where it is invalid', async () => {
		const w = mailingWorld()
		await seed(w)
		const { workloadCredentials } = await credentialed(w)
		// A dry run publishes nothing, so a real deploy approves the contract it then reads.
		expect((await executeDeploy({ ...deps(w), workloadCredentials, mailTransport }, { runId: await createdRun(w, 'stage') })).status).toBe(
			'succeeded',
		)
		const dryRun = await executeDeploy({ ...deps(w), mailTransport }, { runId: await createdRun(w, 'stage'), dryRun: true })
		expect(dryRun.status).toBe('succeeded')
		expect(mailVariables(w.deploys[1])).toEqual(['FABRIKA_EMAIL_FROM', 'FABRIKA_EMAIL_PROVIDER', 'FABRIKA_EMAIL_RESEND_API_KEY'])

		const quiet = spyOn(console, 'error').mockImplementation(() => {})
		try {
			const refused = await executeDeploy({ ...deps(w), mailTransport: invalidTransport }, { runId: await createdRun(w, 'stage'), dryRun: true })
			expect(refused.status).toBe('failed')
		} finally {
			quiet.mockRestore()
		}
		expect([...w.logs.values()].join('\n')).toContain(INVALID_REFUSAL)
		expect(w.deploys).toHaveLength(2)
		expect([...w.logs.values()].join('\n')).not.toContain(RESEND_KEY)
	})

	test('a stored application variable in the family is refused with the command that deletes it', async () => {
		const w = world()
		await seed(w)
		await w.db.registry.upsertAppVar({ appId: 'notes', env: null, name: 'FABRIKA_EMAIL_API_KEY', value: 'legacy' })
		const quiet = spyOn(console, 'error').mockImplementation(() => {})
		try {
			expect((await executeDeploy(deps(w), { runId: await createdRun(w, 'stage') })).status).toBe('failed')
		} finally {
			quiet.mockRestore()
		}
		expect([...w.logs.values()].join('\n')).toContain(
			'is managed by Fabrika: delete it with `fabrika control apps variables delete --app=notes --name=FABRIKA_EMAIL_API_KEY`',
		)
		expect(w.deploys).toEqual([])
	})

	test('a contract without such a job gets no mail variable while the installation has a transport', async () => {
		const w = world()
		await seed(w)
		expect((await executeDeploy({ ...deps(w), mailTransport }, { runId: await createdRun(w, 'stage') })).status).toBe('succeeded')
		expect(mailVariables(w.deploys[0])).toEqual([])
	})
})

describe('the membership transport key from the approved contract', () => {
	const WITH_MEMBERS = edited(
		'\t}),\n\thealth',
		"\t\tstart: c.mutation({ output: z.strictObject({ workspace: z.string() }), access: { action: 'workspaces.create', creates: 'workspace' } }),\n\t}),\n\thealth",
		edited("'notes.delete': 'Delete notes' }", "'notes.delete': 'Delete notes', 'workspaces.create': 'Start a workspace' }"),
	)

	function keyed(w: World) {
		const issued: string[] = []
		const issuer: MembershipKeyIssuer = {
			issue: (input) => {
				issued.push(`${input.app}:${input.keep ?? 'none'}`)
				return Promise.resolve({ key: `px_${'m'.repeat(26)}${issued.length}`, id: `key-${issued.length}`, expiresAt: input.expiresAt })
			},
		}
		return async () => {
			const vault = await Vault.create(harnessDatabase(w.db), btoa(String.fromCharCode(...new Uint8Array(32).fill(7))))
			return { issued, membershipTransport: new VaultMembershipTransport(w.db.membershipKeys, () => Promise.resolve(vault), issuer) }
		}
	}

	test("an application behind a namespace proxy that creates scopes gets IAM's origin and its key, and no run log keeps the key", async () => {
		const w = world()
		await seed(w)
		w.contract = WITH_MEMBERS
		const { issued, membershipTransport } = await keyed(w)()
		const loggingProvider = provider(w)
		const result = await executeDeploy({
			...deps(w),
			iamIssuer: 'https://iam.example.test',
			membershipTransport,
			provider: {
				...loggingProvider,
				deploy: (input) => {
					input.events.log(`key=${input.managedEnvironment['FABRIKA_IAM_RPC_KEY'] ?? 'none'}`)
					return loggingProvider.deploy(input)
				},
			},
		}, { runId: await createdRun(w, 'stage') })
		expect(result.status).toBe('succeeded')
		expect(issued).toEqual(['notes@stage:none'])
		const managed = w.deploys[0]?.managedEnvironment
		expect(managed?.['FABRIKA_IAM_RPC_URL']).toBe('https://iam.example.test')
		expect(managed?.['FABRIKA_IAM_RPC_KEY']).toBe(`px_${'m'.repeat(26)}1`)
		const stored = [...w.logs.values()].join('\n')
		expect(stored).toContain('key=[redacted]')
		expect(stored).not.toContain(`px_${'m'.repeat(26)}1`)
	})

	test('a contract with no membership operation, and a dry run, get none, and dropping the need forgets the key', async () => {
		const w = world()
		await seed(w)
		w.contract = WITH_MEMBERS
		const { issued, membershipTransport } = await keyed(w)()
		const keyedDeps = { ...deps(w), iamIssuer: 'https://iam.example.test', membershipTransport }
		expect((await executeDeploy(keyedDeps, { runId: await createdRun(w, 'stage'), dryRun: true })).status).toBe('succeeded')
		expect((await executeDeploy(keyedDeps, { runId: await createdRun(w, 'stage') })).status).toBe('succeeded')
		expect(await w.db.membershipKeys.get('notes', 'stage')).not.toBeNull()
		w.contract = BASE
		expect((await executeDeploy(keyedDeps, { runId: await createdRun(w, 'stage') })).status).toBe('succeeded')
		expect(issued).toEqual(['notes@stage:none'])
		expect(w.deploys.map((input) => input.managedEnvironment['FABRIKA_IAM_RPC_KEY'] !== null)).toEqual([false, true, false])
		expect(w.deploys.map((input) => input.managedEnvironment['FABRIKA_IAM_RPC_URL'] !== null)).toEqual([false, true, false])
		expect(await w.db.membershipKeys.get('notes', 'stage')).toBeNull()
	})

	test('a contract that creates scopes does not deploy behind a namespace proxy where Control cannot issue the key', async () => {
		const w = world()
		await seed(w)
		w.contract = WITH_MEMBERS
		const quiet = spyOn(console, 'error').mockImplementation(() => {})
		try {
			expect((await deploy(w, 'stage')).status).toBe('failed')
			expect(quiet.mock.calls.flat().map(String).join('\n')).toContain('cannot issue the membership transport key')
		} finally {
			quiet.mockRestore()
		}
		expect(w.deploys).toEqual([])
	})
})

describe('the framework release an application pins (ADR-0062)', () => {
	test('a release below the window fails its run with one line, and the published contract keeps running', async () => {
		const w = world()
		await seed(w)
		const first = await deploy(w, 'stage')
		expect(first.status).toBe('succeeded')
		const before = await published(w, 'stage')

		w.files['bun.lock'] = frameworkLockfile('0.3.9')
		const refused = await deploy(w, 'stage')
		expect(refused.status).toBe('failed')
		expect(w.logs.get(`runs/${refused.runId}/logs.ndjson`)).toContain(
			`access: the application pins @fabrika/app 0.3.9, outside this platform's window; the oldest release it deploys is 0.4.0. Raise the pin as ${MIGRATION_GUIDE} describes`,
		)
		expect(await published(w, 'stage')).toEqual(before)
		expect(w.deploys).toHaveLength(1)
	})

	test('a release newer than the platform fails its run: the platform is upgraded first', async () => {
		const w = world()
		await seed(w)
		w.files['bun.lock'] = frameworkLockfile('9.0.0')
		const refused = await deploy(w, 'stage')
		expect(refused.status).toBe('failed')
		expect(w.logs.get(`runs/${refused.runId}/logs.ndjson`)).toContain(
			`access: the application pins @fabrika/app 9.0.0, newer than this platform's ${CHECKER_VERSION}; upgrade the platform first`,
		)
		expect(w.deploys).toEqual([])
	})

	test('a 0.5 application is read by the 0.5 reader, and its deploy carries its own release, digest and contract upcast', async () => {
		const w = world()
		await seed(w)
		w.files['bun.lock'] = frameworkLockfile('0.5.2')
		expect((await deploy(w, 'stage')).status).toBe('succeeded')
		const snapshot = approvedSnapshotOf(await w.db.registry.getAppEnv('notes', 'stage'))
		expect(snapshot?.checker).toBe('0.5.5')
		expect(snapshot?.framework).toBe('0.5.2')
		expect(snapshot?.older).toBeDefined()
		const access = w.deploys[0]?.environment.access
		expect(access?.checker).toBe('0.5.5')
		expect(access?.contract.format).toBe(CONTRACT_FORMAT)
		expect(access?.contractDigest).toBe(contractDigest05(readContractSource05(new Map([['fabrika.contract.ts', BASE]]))))
		expect(access?.contractDigest).not.toBe(DIGEST)
	})

	test('a 0.4 application is read by the 0.4 reader, and its build checks with the newest 0.4 patch', async () => {
		const w = world()
		await seed(w)
		w.files['bun.lock'] = frameworkLockfile('0.4.1')
		expect((await deploy(w, 'stage')).status).toBe('succeeded')
		const snapshot = approvedSnapshotOf(await w.db.registry.getAppEnv('notes', 'stage'))
		expect(snapshot?.checker).toBe('0.4.8')
		expect(snapshot?.framework).toBe('0.4.1')
		const access = w.deploys[0]?.environment.access
		expect(access?.checker).toBe('0.4.8')
		expect(access?.contractDigest).toBe(contractDigest04(readContractSource04(new Map([['fabrika.contract.ts', BASE]]))))
	})
})

async function createdRun(w: World, env: string): Promise<string> {
	const runId = uuidv7()
	await w.db.runs.createRun({ id: runId, appId: 'notes', env, ref: 'refs/heads/main', trigger: 'manual', actor: 'user:test' })
	return runId
}
