// ADR-0050 end to end through Control: a run reads its snapshot at its commit, a widening waits on a protected
// environment and applies on an unprotected one, a pending change is published nowhere, only a person in the console
// approves, an approval holds only for its baseline, a lost publication classifies again, and a removal runs through.

import type { AuthContext } from '@fabrika/auth'
import { contractDigest, permits, type Scope } from '@fabrika/auth-core'
import { readContractSource } from '@fabrika/check/contract'
import type { BlobStore } from '@fabrika/platform'
import { uuidv7 } from '@fabrika/platform'
import { checkoutRelativeDirectory } from '@fabrika/provider-cloudflare/runner'
import type { ControlProvider, ProviderDeployInput, ProviderNamespaceMember } from '@fabrika/provider-contract'
import { describe, expect, spyOn, test } from 'bun:test'
import { ControlApiError } from '../api/domain'
import { republishNamespace } from '../api/namespaces'
import { deleteAppUseCase } from '../api/registry/apps'
import type { RegistryUseCaseContext } from '../api/registry/context'
import { deleteAppEnvUseCase } from '../api/registry/environments'
import { type ApprovalUseCaseContext, completeApprovalUseCase, setEnvironmentProtectionUseCase } from '../approval/api'
import { parseClassification } from '../approval/publish'
import { type AccessSnapshot, approvedSnapshot } from '../approval/snapshot'
import type { AppEnvRow, ControlRepositories, RunRow } from '../db'
import type { InstallationMail } from '../mail-transport'
import { type MembershipKeyIssuer, VaultMembershipTransport } from '../membership-transport'
import type { ControlJobMessage } from '../run-lifecycle'
import { cancelDeploy, executeDeploy, providerEnvironment, type RunDeps } from '../run-lifecycle'
import { VaultSecretResolver } from '../secret-resolver'
import { Vault } from '../vault'
import { VaultWorkloadCredentials, type WorkloadKeyIssuer } from '../workload-credentials'
import { memoryCommits } from './helpers/commits'
import { BASE, edited, WITH_EXPORT, WITHOUT_REMOVE } from './helpers/contracts'
import { createHarness, harnessDatabase } from './helpers/harness'
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
		expect(approval.approval).toMatchObject({ principalId: 'p-ada', label: 'ada@example.test' })
		expect(caller.audited).toEqual(['access.approve'])
		expect(w.queued).toEqual([{ runId: parked.runId }])

		expect((await executeDeploy(deps(w), { runId: parked.runId })).status).toBe('succeeded')
		expect(await published(w, 'prod')).toEqual({ runId: parked.runId, generation: 1 })
		expect(w.deploys.map((input) => input.environment.access?.contractDigest)).toEqual([DIGEST])
		expect(w.republished.at(-1)?.members.map((member) => member.access?.contractDigest)).toEqual([DIGEST])
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
		"\tapp: c.spa('/', { dir: 'dist/app', access: { member: true } }),\n\tjobs: { nightly: c.cron('0 3 * * *', { actions: ['notes.delete'], scope: 'app' }) },\n",
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

export const digest = app.cron('0 3 * * *', { actions: ['notes.read'], scope: 'app', mailer: 'installation' }).handle(async () => {})
`
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

	function mailingWorld(): World {
		const w = world()
		const { 'fabrika.contract.ts': _contract, ...files } = kitFiles()
		w.files = { ...files, 'src/jobs.ts': MAILING }
		w.contract = CONTRACT
		return w
	}

	const mailVariables = (input: ProviderDeployInput | undefined): string[] =>
		Object.keys(input?.managedEnvironment ?? {}).filter((name) => name.startsWith('FABRIKA_EMAIL_')).sort()

	test('a deploy hands the whole transport, and no run log keeps its credential', async () => {
		const w = mailingWorld()
		await seed(w)
		const { workloadCredentials } = await credentialed(w)
		const loggingProvider = provider(w)
		const result = await executeDeploy({
			...deps(w),
			workloadCredentials,
			mailTransport,
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

async function createdRun(w: World, env: string): Promise<string> {
	const runId = uuidv7()
	await w.db.runs.createRun({ id: runId, appId: 'notes', env, ref: 'refs/heads/main', trigger: 'manual', actor: 'user:test' })
	return runId
}
