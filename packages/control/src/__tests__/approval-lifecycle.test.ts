// ADR-0050 end to end through Control: a run reads its snapshot at its commit, a widening waits on a protected
// environment and applies on an unprotected one, a pending change is published nowhere, only a person in the console
// approves, an approval holds only for its baseline, a lost publication classifies again, and a removal runs through.

import type { AuthContext } from '@fabrika/auth'
import { type ArtifactAccess, artifactAccessDigest, contractDigest, permits, type Scope } from '@fabrika/auth-core'
import { readContractSource } from '@fabrika/check/contract'
import type { BlobStore } from '@fabrika/platform'
import { uuidv7 } from '@fabrika/platform'
import { checkoutRelativeDirectory } from '@fabrika/provider-cloudflare/runner'
import type {
	ControlProvider,
	JsonValue,
	ProviderDeployInput,
	ProviderDeployOutcome,
	ProviderEnvelope,
	ProviderNamespaceMember,
} from '@fabrika/provider-contract'
import { describe, expect, spyOn, test } from 'bun:test'
import { ControlApiError } from '../api/domain'
import { republishNamespace } from '../api/namespaces'
import { deleteAppUseCase } from '../api/registry/apps'
import type { RegistryUseCaseContext } from '../api/registry/context'
import { deleteAppEnvUseCase } from '../api/registry/environments'
import { type ApprovalUseCaseContext, completeApprovalUseCase, setEnvironmentProtectionUseCase } from '../approval/api'
import { parseClassification } from '../approval/publish'
import { type AccessSnapshot, approvedSnapshot, artifactAccessSchema } from '../approval/snapshot'
import type { AppEnvRow, ControlRepositories, RunRow } from '../db'
import type { ControlJobMessage } from '../run-lifecycle'
import { cancelDeploy, executeDeploy, providerEnvironment, type RunDeps } from '../run-lifecycle'
import { VaultSecretResolver } from '../secret-resolver'
import { Vault } from '../vault'
import { VaultWorkloadCredentials, type WorkloadKeyIssuer } from '../workload-credentials'
import { memoryCommits } from './helpers/commits'
import { BASE, edited, WITH_EXPORT, WITHOUT_REMOVE } from './helpers/contracts'
import { createHarness, harnessDatabase } from './helpers/harness'
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
	/**
	 * Where the provider learns an application's gates and schema (ADR-0050): nowhere (`none`), from the registry's
	 * artifact before the deploy (`artifact`, as Zerops), or from the deploy itself (`runner`, as Cloudflare).
	 */
	readonly mode: 'none' | 'artifact' | 'runner'
	/** What the runner finds in the checkout, in `runner` mode. */
	checkout: ArtifactAccess
}

const HUMAN_GATES: ArtifactAccess = { gates: { rules: [{ path: '/*', kind: 'human' }] }, schema: null }
const PUBLIC_GATES: ArtifactAccess = { gates: { rules: [{ path: '/*', kind: 'public' }] }, schema: null }

function world(mode: World['mode'] = 'none'): World {
	const { db, sqlite } = createHarness()
	return { db, sqlite, deploys: [], republished: [], queued: [], logs: new Map(), contract: BASE, files: {}, mode, checkout: HUMAN_GATES }
}

/** A harbor artifact carries its gates and schema in the payload. */
const harborArtifact = (access: ArtifactAccess): string => JSON.stringify({ provider: 'harbor', version: 1, payload: { ...access } })

const harborAccess = (artifact: ProviderEnvelope): ArtifactAccess => {
	const payload = artifact.payload
	const field = (
		name: string,
	): JsonValue => (typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? payload[name] ?? null : null)
	return artifactAccessSchema.parse({ gates: field('gates'), schema: field('schema') })
}

/** The runner's check (`runner` mode): a protected mismatch stops before provisioning; anything else deploys. */
function runnerOutcome(w: World, input: ProviderDeployInput): ProviderDeployOutcome {
	const approval = input.environment.artifactAccess
	if (w.mode !== 'runner' || approval === undefined) return { state: 'succeeded' }
	if (approval.protected && artifactAccessDigest(w.checkout) !== approval.digest) {
		return { state: 'failed', artifactAccess: { state: 'pending', access: w.checkout } }
	}
	return { state: 'succeeded', artifactAccess: { state: 'deployed', access: w.checkout } }
}

function provider(w: World): ControlProvider {
	return {
		id: 'harbor',
		normalizeRegistration: (input) => input,
		applicationRoot: (source) => checkoutRelativeDirectory(source.workerDir),
		...(w.mode === 'artifact' ? { artifactAccess: harborAccess } : {}),
		resolveSource: () => Promise.resolve({ commitSha: COMMIT }),
		deploy: (input) => {
			w.deploys.push(input)
			return Promise.resolve(runnerOutcome(w, input))
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
			providerArtifactJson: harborArtifact(HUMAN_GATES),
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
		publicOrigin: ORIGIN,
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
		expect([environment.access, environment.artifactAccess]).toEqual([undefined, undefined])
		await republishNamespace({ ...deps(w), queue: { send: () => Promise.resolve() } }, 'apps-prod', { wait: 'started' })
		expect(w.republished.at(-1)?.members.map((member) => [member.access, member.artifactAccess])).toEqual([[undefined, undefined]])
		expect(w.deploys).toEqual([])
	})

	test('artifact access read before the deploy: the first protected deploy waits, and an approval names its digest', async () => {
		const w = world('artifact')
		await seed(w)
		w.contract = null
		const parked = await deploy(w, 'prod')
		expect(parked.status).toBe('awaiting_approval')
		expect(parseClassification((await run(w, parked.runId)).classification_json ?? '').changes.map((change) => change.line)).toEqual([
			"The artifact's gates and IAM schema apply for the first time",
			'Gate `/* → human` is added',
		])
		await approve(w, parked.runId)
		expect((await executeDeploy(deps(w), { runId: parked.runId })).status).toBe('succeeded')
		expect(w.deploys.map((input) => input.environment.artifactAccess)).toEqual([{ digest: artifactAccessDigest(HUMAN_GATES), protected: true }])
	})

	test('a contract removed (1 → 0) waits with the artifact access, and a later wider upload is published nowhere', async () => {
		const w = world('artifact')
		await seed(w)
		const first = await deploy(w, 'prod')
		await approve(w, first.runId)
		await executeDeploy(deps(w), { runId: first.runId })

		w.contract = null
		const removal = await deploy(w, 'prod')
		expect(removal.status).toBe('awaiting_approval')
		const lines = parseClassification((await run(w, removal.runId)).classification_json ?? '').changes.map((change) => change.line)
		expect(lines).toContain('The contract is removed: the proxy no longer applies an endpoint table to this application')
		expect(lines).toContain('Gate `/* → human` is added')
		await approve(w, removal.runId)
		expect((await executeDeploy(deps(w), { runId: removal.runId })).status).toBe('succeeded')

		// A registry write changes the artifact to `/* → public`; the approved digest stays the narrow one.
		const prod = await w.db.registry.getAppEnv('notes', 'prod')
		if (prod === null) throw new Error('no prod')
		await w.db.registry.upsertAppEnv({
			appId: 'notes',
			env: 'prod',
			domain: prod.domain,
			namespaceId: prod.namespace_id,
			provider: 'harbor',
			providerTargetJson: prod.provider_target_json,
			providerArtifactJson: harborArtifact(PUBLIC_GATES),
		})
		await republishNamespace({ ...deps(w), queue: { send: () => Promise.resolve() } }, 'apps-prod', { wait: 'started' })
		const member = w.republished.at(-1)?.members[0]
		expect(member?.artifactAccess?.digest).toBe(artifactAccessDigest(HUMAN_GATES))
		expect(member === undefined ? null : artifactAccessDigest(harborAccess(member.artifact))).not.toBe(artifactAccessDigest(HUMAN_GATES))
		// Deploying the wider upload is a change of approved access, so it waits too.
		expect((await deploy(w, 'prod')).status).toBe('awaiting_approval')
	})

	test('artifact access learnt in the deploy: the first protected Cloudflare deploy stops, and a new run waits for a human', async () => {
		const w = world('runner')
		await seed(w)
		w.contract = null
		const first = await deploy(w, 'prod')
		// Nothing changed in the commit, so the run published; the runner then found gates nobody approved.
		expect(first.status).toBe('failed')
		expect(w.deploys.map((input) => input.environment.artifactAccess)).toEqual([{ digest: null, protected: true }])
		const parked = (await w.db.runs.listRunsAwaitingApproval(10))[0]
		if (parked === undefined) throw new Error('no run waits for approval')
		expect(parked).toMatchObject({ commit_sha: COMMIT, actor: 'user:test', pending_access_json: JSON.stringify(HUMAN_GATES) })
		expect(parseClassification(parked.classification_json ?? '')).toMatchObject({ outcome: 'widening', protected: true })
		expect(w.logs.get(`runs/${first.runId}/logs.ndjson`)).toContain(`run ${parked.id} waits for a human with access.approve`)
		expect(approvedSnapshotOf(await w.db.registry.getAppEnv('notes', 'prod'))?.artifact).toBeNull()

		await approve(w, parked.id)
		expect((await executeDeploy(deps(w), { runId: parked.id })).status).toBe('succeeded')
		expect(w.deploys.at(-1)?.environment.artifactAccess).toEqual({ digest: artifactAccessDigest(HUMAN_GATES), protected: true })
		expect(approvedSnapshotOf(await w.db.registry.getAppEnv('notes', 'prod'))?.artifact).toEqual(HUMAN_GATES)
	})

	test('on an unprotected environment the runner deploys new gates at once, and Control records them', async () => {
		const w = world('runner')
		await seed(w)
		w.contract = null
		expect((await deploy(w, 'stage')).status).toBe('succeeded')
		const stage = await w.db.registry.getAppEnv('notes', 'stage')
		expect(approvedSnapshotOf(stage)?.artifact).toEqual(HUMAN_GATES)
		expect(stage?.generation).toBe(2)
		w.checkout = PUBLIC_GATES
		expect((await deploy(w, 'stage')).status).toBe('succeeded')
		expect(approvedSnapshotOf(await w.db.registry.getAppEnv('notes', 'stage'))?.artifact).toEqual(PUBLIC_GATES)
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
		expect(approval.approval).toMatchObject({ principalId: 'p-ada', label: 'ada@example.test' })
		expect(caller.audited).toEqual(['access.approve'])
		expect(w.queued).toEqual([{ runId: parked.runId }])

		expect((await executeDeploy(deps(w), { runId: parked.runId })).status).toBe('succeeded')
		expect(await published(w, 'prod')).toEqual({ runId: parked.runId, generation: 1 })
		expect(w.deploys.map((input) => input.environment.access?.contractDigest)).toEqual([DIGEST])
		expect(w.republished.at(-1)?.members.map((member) => member.access?.contractDigest)).toEqual([DIGEST])
	})

	test('a service principal, an OAuth (MCP) token, a key, another origin and an operator cannot approve', async () => {
		const w = world()
		await seed(w)
		const parked = await deploy(w, 'prod')
		const operator = auth({ permissions: [{ action: 'deploy.*', scope: null }] })

		expect(await status(approve(w, parked.runId, auth({ type: 'service' })))).toBe(403)
		expect(await status(approve(w, parked.runId, auth({ oauth: true })))).toBe(403)
		expect(await status(approve(w, parked.runId, auth(), consoleRequest({ Authorization: 'Bearer px_builder' })))).toBe(403)
		expect(await status(approve(w, parked.runId, auth(), consoleRequest({ Origin: 'https://evil.example.test', 'Sec-Fetch-Site': 'cross-site' }))))
			.toBe(403)
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
		expect(classification.outcome).toBe('removal')
		expect(await published(w, 'prod')).toEqual({ runId: removal.runId, generation: 2 })
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

	test('dropping the contract from the commit widens, so it waits on prod', async () => {
		const w = world()
		await seed(w)
		const first = await deploy(w, 'prod')
		await approve(w, first.runId)
		await executeDeploy(deps(w), { runId: first.runId })

		w.contract = null
		expect((await deploy(w, 'prod')).status).toBe('awaiting_approval')
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
			admission: { request, publicOrigin: ORIGIN },
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

describe('workload keys from the approved contract', () => {
	const WITH_JOB = edited(
		"\tapp: c.spa('/', { dir: 'dist/app', access: { member: true } }),\n",
		"\tapp: c.spa('/', { dir: 'dist/app', access: { member: true } }),\n\tjobs: { nightly: c.cron('0 3 * * *', { actions: ['notes.delete'], scope: 'app' }) },\n",
	)

	async function credentialed(w: World) {
		const vault = await Vault.create(harnessDatabase(w.db), btoa(String.fromCharCode(...new Uint8Array(32).fill(7))))
		const issued: string[] = []
		const issuer: WorkloadKeyIssuer = {
			issue: (input) => {
				issued.push(`${input.app}/${input.kind}:${input.name}`)
				return Promise.resolve({ key: `px_${'k'.repeat(40)}${issued.length}`, credentialId: `credential-${issued.length}`, expiresAt: input.expiresAt })
			},
		}
		return { issued, workloadCredentials: new VaultWorkloadCredentials(w.db.workloadCredentials, () => Promise.resolve(vault), issuer) }
	}

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

async function createdRun(w: World, env: string): Promise<string> {
	const runId = uuidv7()
	await w.db.runs.createRun({ id: runId, appId: 'notes', env, ref: 'refs/heads/main', trigger: 'manual', actor: 'user:test' })
	return runId
}
