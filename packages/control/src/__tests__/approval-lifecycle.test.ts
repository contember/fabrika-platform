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
import type { ControlRepositories, RunRow } from '../db'
import type { ControlJobMessage } from '../run-lifecycle'
import { cancelDeploy, executeDeploy, providerEnvironment, type RunDeps } from '../run-lifecycle'
import { VaultSecretResolver } from '../secret-resolver'
import { memoryCommits } from './helpers/commits'
import { BASE, edited, WITH_EXPORT, WITHOUT_REMOVE } from './helpers/contracts'
import { createHarness } from './helpers/harness'
import { makeFakeLock } from './helpers/lock'

const COMMIT = 'c'.repeat(40)
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
			providerArtifactJson: JSON.stringify({ provider: 'harbor', version: 1, payload: {} }),
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
		// The registry knows a snapshot brought a contract, so the upload's own gates do not apply either.
		expect(prod).toMatchObject({ published_run_id: null, contract_app: 1 })
		const environment = await providerEnvironment(w.db, prod)
		expect([environment.access, environment.artifactAccess]).toEqual([undefined, undefined])
		await republishNamespace({ ...deps(w), queue: { send: () => Promise.resolve() } }, 'apps-prod', { wait: 'started' })
		expect(w.republished.at(-1)?.members.map((member) => [member.access, member.artifactAccess])).toEqual([[undefined, undefined]])
		expect(w.deploys).toEqual([])
	})

	test('an application Control knows has no contract keeps its artifact access, until a snapshot brings one', async () => {
		const w = world()
		await seed(w)
		w.contract = null
		expect((await deploy(w, 'prod')).status).toBe('succeeded')
		expect(w.deploys.map((input) => [input.environment.access, input.environment.artifactAccess])).toEqual([[undefined, true]])
		expect(await w.db.registry.getAppEnv('notes', 'prod')).toMatchObject({ contract_app: 0, generation: 1 })

		w.contract = BASE
		expect((await deploy(w, 'prod')).status).toBe('awaiting_approval')
		const prod = await w.db.registry.getAppEnv('notes', 'prod')
		if (prod === null) throw new Error('no prod')
		expect(prod.contract_app).toBe(1)
		await republishNamespace({ ...deps(w), queue: { send: () => Promise.resolve() } }, 'apps-prod', { wait: 'started' })
		expect(w.republished.at(-1)?.members.map((member) => [member.access, member.artifactAccess])).toEqual([[undefined, undefined]])
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
		runs.publishRunSnapshot = (id, expected, fence) => {
			if (!raced) {
				raced = true
				w.sqlite.query('UPDATE app_envs SET published_run_id = ?, generation = generation + 1 WHERE app_id = ? AND env = ?').run(
					winner.runId,
					'notes',
					'stage',
				)
			}
			return publish(id, expected, fence)
		}

		w.contract = WITH_EXPORT
		const loser = await deploy(w, 'stage')
		expect(loser.status).toBe('succeeded')
		expect(await published(w, 'stage')).toEqual({ runId: loser.runId, generation: 3 })
		expect(w.logs.get(`runs/${loser.runId}/logs.ndjson`)).toContain('another publication or a protection change landed first; classifying again')
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

	test('protection enabled while a run publishes makes the publication lose and the run wait', async () => {
		const w = world()
		await seed(w)
		const runs = w.db.runs
		const publish = runs.publishRunSnapshot.bind(runs)
		let protectedFirst = false
		runs.publishRunSnapshot = async (id, expected, fence) => {
			if (!protectedFirst) {
				protectedFirst = true
				await setEnvironmentProtectionUseCase(approvals(w, auth()), { appId: 'notes', env: 'stage', protected: true })
			}
			return publish(id, expected, fence)
		}

		const raced = await deploy(w, 'stage')
		expect(raced.status).toBe('awaiting_approval')
		const row = await run(w, raced.runId)
		expect(row.approval_json).toBeNull()
		expect(parseClassification(row.classification_json ?? '')).toMatchObject({ outcome: 'widening', protected: true })
		expect(w.logs.get(`runs/${raced.runId}/logs.ndjson`)).toContain('another publication or a protection change landed first; classifying again')
		expect(await published(w, 'stage')).toEqual({ runId: null, generation: 1 })
		expect(w.deploys).toEqual([])
	})
})

describe('protection survives the registry', () => {
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
