// ADR-0050 §4 and ADR-0083 §2: a non-person's manual deploy of a protected environment is its own approval request. Every
// bearer is a non-person, a person's own key included; under `deploy-request: person` the run names a commit SHA, merged
// by default, and parks for a person whatever its lines; `off` deploys it, `refuse` refuses it. A parked run has an
// absolute deadline that the decision's own write checks and the sweep settles, and may take two different approvers.

import type { AuthContext } from '@fabrika/auth'
import { permits } from '@fabrika/auth-core'
import { type ApprovalPolicy, type ApprovalSettings, PERMISSIVE_POLICY, STRICT_POLICY, STRICT_SETTINGS } from '@fabrika/control-contract'
import type { BlobStore } from '@fabrika/platform'
import { uuidv7 } from '@fabrika/platform'
import type { ControlProvider } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { ControlApiError } from '../api/domain'
import { getRunUseCase, type RunsUseCaseContext, triggerDeployUseCase } from '../api/runs'
import { type ApprovalUseCaseContext, completeApprovalUseCase, getApprovalUseCase, setEnvironmentProtectionUseCase } from '../approval/api'
import { parseClassification } from '../approval/publish'
import type { ControlRepositories, RunRow } from '../db'
import type { CommitSource, RequestedCommitInput } from '../github/source/commit-files'
import { SourceFailure } from '../github/source/failure'
import { sweepParkedRuns } from '../provider-reconcile'
import { type ControlJobMessage, executeDeploy, type RunDeps } from '../run-lifecycle'
import { VaultSecretResolver } from '../secret-resolver'
import { memoryCommits } from './helpers/commits'
import { BASE, WITH_EXPORT } from './helpers/contracts'
import { createHarness, harnessDatabase } from './helpers/harness'
import { fixtureProtect, makeFakeLock } from './helpers/lock'

const COMMIT = 'c'.repeat(40)
const ORIGIN = 'https://console.example.test'
const ENVELOPE = JSON.stringify({ provider: 'harbor', version: 1, payload: {} })
const HOUR = 3600

interface World {
	readonly db: ControlRepositories
	readonly logs: Map<string, string>
	/** Every run id sent to the queue; creation sends one, a completing approval another. */
	readonly queued: string[]
	/** What the requested-commit read answers, and every read it was asked for. */
	readonly requested: RequestedCommitInput[]
	answer: (input: RequestedCommitInput) => Promise<{ message: string; merged: boolean | null }>
	/** The contract the next deploy's commit holds. */
	contract: string
	deploys: number
	/** The repositories' clock, in unix seconds. */
	now: number
}

async function world(): Promise<World> {
	const clock = { now: Math.floor(Date.now() / 1000) }
	const { db } = createHarness(() => clock.now)
	const w: World = {
		db,
		logs: new Map(),
		queued: [],
		requested: [],
		answer: (input) => Promise.resolve({ message: 'Fix <b>invoice</b> rounding', merged: input.mergedInto === null ? null : true }),
		contract: BASE,
		deploys: 0,
		get now() {
			return clock.now
		},
		set now(value) {
			clock.now = value
		},
	}
	await db.registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes', defaultBranch: 'main' })
	for (const env of ['prod', 'stage']) {
		await db.registry.upsertAppEnv({
			appId: 'notes',
			env,
			domain: `${env}.notes.example.test`,
			triggerRef: env === 'prod' ? 'refs/heads/deploy/prod' : null,
			namespaceId: null,
			provider: 'harbor',
			providerTargetJson: ENVELOPE,
			providerArtifactJson: ENVELOPE,
		})
	}
	return w
}

function commits(w: World): CommitSource {
	return {
		...memoryCommits(),
		open: (input) => memoryCommits({ 'fabrika.contract.ts': w.contract }).open(input),
		requestedCommit: (input) => {
			w.requested.push(input)
			return w.answer(input)
		},
	}
}

function provider(w: World): ControlProvider {
	return {
		id: 'harbor',
		normalizeRegistration: (input) => input,
		applicationRoot: () => '',
		resolveSource: () => Promise.resolve({ commitSha: COMMIT }),
		deploy: () => {
			w.deploys++
			return Promise.resolve({ state: 'succeeded' })
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
		queue: { send: () => Promise.resolve() },
		logs,
		runLogs: {
			put: logs.put,
			get: (key) => {
				const value = w.logs.get(key)
				return Promise.resolve(value === undefined ? null : { body: new Blob([value]).stream(), text: () => Promise.resolve(value) })
			},
		},
		commits: commits(w),
	}
}

function queue(w: World): { send: (message: ControlJobMessage) => Promise<void> } {
	return {
		send: (message) => {
			if (message.kind !== 'namespace') w.queued.push(message.runId)
			return Promise.resolve()
		},
	}
}

type Caller = 'console' | 'key' | 'oauth' | 'service'

function caller(kind: Caller, id = 'p-ada', label = 'ada@example.test'): AuthContext {
	const grants = [{ action: 'deploy.*', scope: null }, { action: 'access.approve', scope: null }].map((grant) => ({
		...grant,
		source: 'grant' as const,
	}))
	return {
		ok: true,
		principal: {
			id: kind === 'service' ? 'svc-builder' : id,
			type: kind === 'service' ? 'service' : 'user',
			label: kind === 'service' ? 'builder' : label,
		},
		...(kind === 'oauth'
			? { oauth: { app: 'vozka', clientId: 'https://agent.example.test/client.json', scopes: ['deploy'], grantId: 'g', tokenId: 't' } }
			: {}),
		can: (action, scope) => permits(grants, action, scope),
		scopedTo: () => null,
		audit: () => Promise.resolve(),
	}
}

/** A console request, or one with a bearer: a person's own `px_` key, an agent's token, a service key. */
function request(kind: Caller): Request {
	const headers: Record<string, string> = { Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin' }
	if (kind !== 'console') headers.Authorization = 'Bearer px_test'
	return new Request(`${ORIGIN}/api/rpc`, { method: 'POST', headers })
}

function runs(w: World, kind: Caller): RunsUseCaseContext {
	return {
		repositories: w.db,
		queue: queue(w),
		logs: { get: () => Promise.resolve(null) },
		cancel: () => Promise.resolve(),
		auth: caller(kind),
		admission: { request: request(kind) },
		commits: commits(w),
		consoleOrigin: ORIGIN,
	}
}

function approvals(w: World, auth: AuthContext = caller('console')): ApprovalUseCaseContext {
	return {
		repositories: w.db,
		auth,
		queue: queue(w),
		lock: makeFakeLock(w.db),
		request: request('console'),
		now: () => w.now,
	}
}

async function choose(w: World, env: string, policy: ApprovalPolicy, settings: ApprovalSettings = STRICT_SETTINGS): Promise<void> {
	await setEnvironmentProtectionUseCase(approvals(w), { appId: 'notes', env, protected: true, policy, settings })
}

async function run(w: World, runId: string): Promise<RunRow> {
	const row = await w.db.runs.getRun(runId)
	if (row === null) throw new Error(`no run ${runId}`)
	return row
}

async function decide(w: World, runId: string, decision: 'approve' | 'reject', auth: AuthContext = caller('console')) {
	const row = await run(w, runId)
	const classification = parseClassification(await w.db.runs.document(row.classification_json ?? ''))
	return completeApprovalUseCase(approvals(w, auth), {
		runId,
		decision,
		candidateDigest: classification.candidateDigest,
		baselineDigest: classification.baselineDigest,
	})
}

const sends = (w: World, runId: string): number => w.queued.filter((id) => id === runId).length

const status = async (promise: Promise<unknown>): Promise<{ status: number; message: string }> => {
	try {
		await promise
		return { status: 200, message: '' }
	} catch (error) {
		if (error instanceof ControlApiError) return { status: error.httpStatus, message: error.message }
		throw error
	}
}

/** `prod` runs `BASE`, deployed by a person, so a request of the same commit changes no line. */
async function published(w: World): Promise<void> {
	const created = await triggerDeployUseCase(runs(w, 'console'), { appId: 'notes', env: 'prod', ref: 'refs/heads/main' })
	expect((await executeDeploy(deps(w), { runId: created.id })).status).toBe('succeeded')
	w.deploys = 0
}

/** A request of `COMMIT` on `prod` by `kind`, deployed until it parks or finishes. */
async function requested(w: World, kind: Caller = 'oauth'): Promise<{ runId: string; status: string }> {
	const created = await triggerDeployUseCase(runs(w, kind), { appId: 'notes', env: 'prod', ref: COMMIT })
	return executeDeploy(deps(w), { runId: created.id })
}

describe('every bearer is a non-person', () => {
	test("a person's own key parks its deploy for a person instead of deploying it", async () => {
		const w = await world()
		await published(w)
		const parked = await requested(w, 'key')
		expect(parked.status).toBe('awaiting_approval')
		expect(w.deploys).toBe(0)
		expect(await run(w, parked.runId)).toMatchObject({ by_person: 0, park_reason: 'requested' })
	})

	test('the same person in the console deploys as before, and the run records it', async () => {
		const w = await world()
		await published(w)
		const created = await triggerDeployUseCase(runs(w, 'console'), { appId: 'notes', env: 'prod', ref: COMMIT })
		expect((await executeDeploy(deps(w), { runId: created.id })).status).toBe('succeeded')
		expect(await run(w, created.id)).toMatchObject({ by_person: 1, request_json: null, park_reason: null })
		expect(w.requested).toEqual([])
	})

	test('a run created before the record reads as its actor did: a user ran, a key is judged as a request', async () => {
		const w = await world()
		await published(w)
		const person = uuidv7()
		await w.db.runs.createRun({ id: person, appId: 'notes', env: 'prod', ref: 'refs/heads/main', trigger: 'manual', actor: 'user:p-ada' })
		expect((await executeDeploy(deps(w), { runId: person })).status).toBe('succeeded')
		const key = uuidv7()
		await w.db.runs.createRun({ id: key, appId: 'notes', env: 'prod', ref: COMMIT, trigger: 'manual', actor: 'service:svc' })
		expect((await executeDeploy(deps(w), { runId: key })).status).toBe('awaiting_approval')
	})
})

describe("a non-person's deploy of a protected environment under each mode", () => {
	for (const kind of ['key', 'oauth', 'service'] as const) {
		test(`${kind}: person parks it whatever its lines, off deploys it, refuse answers 403`, async () => {
			const w = await world()
			await published(w)
			const parked = await requested(w, kind)
			expect(parked.status).toBe('awaiting_approval')

			await choose(w, 'prod', { ...STRICT_POLICY, 'deploy-request': 'off' })
			expect((await requested(w, kind)).status).toBe('succeeded')
			expect(w.deploys).toBe(1)

			await choose(w, 'prod', { ...STRICT_POLICY, 'deploy-request': 'refuse' })
			const refused = await status(triggerDeployUseCase(runs(w, kind), { appId: 'notes', env: 'prod', ref: COMMIT }))
			expect(refused.status).toBe(403)
			expect(refused.message).toContain('refuses a deploy a non-person asks for (deploy-request: refuse)')
		})
	}

	test('a request names a commit SHA, never a ref, and never a workspace branch', async () => {
		const w = await world()
		for (const ref of ['refs/heads/main', 'refs/tags/v1', 'main']) {
			const refused = await status(triggerDeployUseCase(runs(w, 'oauth'), { appId: 'notes', env: 'prod', ref }))
			expect(refused).toEqual({
				status: 400,
				message: `environment \`prod\` is protected: a deploy an agent or a key asks for names a 40-character commit SHA, not \`${ref}\`, `
					+ 'and waits for a person to approve it',
			})
		}
		expect((await status(triggerDeployUseCase(runs(w, 'oauth'), { appId: 'notes', env: 'prod', ref: 'refs/heads/fabrika/0190' }))).status)
			.toBe(403)
		expect(w.queued).toEqual([])
		// An unprotected environment takes any ref, as before.
		expect((await status(triggerDeployUseCase(runs(w, 'oauth'), { appId: 'notes', env: 'stage', ref: 'refs/heads/main' }))).status).toBe(200)
	})

	test('the request records who asked and the commit message, and the approval page shows them beside the running commit', async () => {
		const w = await world()
		await published(w)
		const parked = await requested(w, 'oauth')
		const approval = await getApprovalUseCase(approvals(w), parked.runId)
		expect(approval.request).toEqual({
			principal: { id: 'p-ada', type: 'user', label: 'ada@example.test' },
			credential: 'oauth',
			clientId: 'https://agent.example.test/client.json',
			commitSha: COMMIT,
			commitMessage: 'Fix <b>invoice</b> rounding',
			runningCommitSha: COMMIT,
			compareUrl: null,
		})
		expect(approval.changes).toEqual([])
		expect(approval.approvers).toBe(1)
		expect(approval.deadline).toBe(w.now + 24 * HOUR)
	})
})

describe('a requested commit must be merged by default', () => {
	test('merged: the source is asked against the trigger branch, and an unmerged commit is refused', async () => {
		const w = await world()
		w.answer = () => Promise.resolve({ message: 'wip', merged: false })
		const refused = await status(triggerDeployUseCase(runs(w, 'oauth'), { appId: 'notes', env: 'prod', ref: COMMIT }))
		expect(refused).toEqual({
			status: 400,
			message: `environment \`prod\` is protected: a deploy an agent or a key asks for must be merged into \`deploy/prod\`; commit ${COMMIT} is not`,
		})
		expect(w.requested.map((input) => input.mergedInto)).toEqual(['deploy/prod'])
		expect(w.queued).toEqual([])
	})

	test('merged: a trigger pattern asks against the default branch, and a source that does not answer refuses it', async () => {
		const w = await world()
		await w.db.registry.upsertAppEnv({
			appId: 'notes',
			env: 'prod',
			domain: 'prod.notes.example.test',
			triggerRef: 'refs/tags/v*',
			namespaceId: null,
			provider: 'harbor',
			providerTargetJson: ENVELOPE,
			providerArtifactJson: ENVELOPE,
		})
		w.answer = () => Promise.reject(new SourceFailure('rate_limited', 'resolve'))
		const refused = await status(triggerDeployUseCase(runs(w, 'oauth'), { appId: 'notes', env: 'prod', ref: COMMIT }))
		expect(refused.status).toBe(400)
		expect(refused.message).toContain('the source did not answer whether commit')
		expect(refused.message).toContain('(rate_limited)')
		expect(w.requested.map((input) => input.mergedInto)).toEqual(['main'])
	})

	test('any: an unmerged commit is admitted, and an unreadable message leaves it unread', async () => {
		const w = await world()
		await choose(w, 'prod', STRICT_POLICY, { ...STRICT_SETTINGS, deployRequestCommits: 'any' })
		w.answer = () => Promise.reject(new SourceFailure('internal', 'resolve'))
		const created = await triggerDeployUseCase(runs(w, 'oauth'), { appId: 'notes', env: 'prod', ref: COMMIT })
		expect(w.requested.map((input) => input.mergedInto)).toEqual([null])
		expect(JSON.parse((await run(w, created.id)).request_json ?? '')).toMatchObject({ commitMessage: null })
	})
})

describe('the restart check judges the environment as it is when the run starts', () => {
	async function queued(w: World): Promise<string> {
		await published(w)
		return (await triggerDeployUseCase(runs(w, 'oauth'), { appId: 'notes', env: 'prod', ref: COMMIT })).id
	}

	test('refuse fails the run with the cause in its log', async () => {
		const w = await world()
		const runId = await queued(w)
		await choose(w, 'prod', { ...STRICT_POLICY, 'deploy-request': 'refuse' })
		expect((await executeDeploy(deps(w), { runId })).status).toBe('failed')
		expect(w.deploys).toBe(0)
		expect(w.logs.get(`runs/${runId}/logs.ndjson`)).toContain('deploy-request: refuse')
	})

	test('off deploys it, and person parks it unless an approval covers it', async () => {
		const w = await world()
		const off = await queued(w)
		await choose(w, 'prod', { ...STRICT_POLICY, 'deploy-request': 'off' })
		expect((await executeDeploy(deps(w), { runId: off })).status).toBe('succeeded')

		await choose(w, 'prod', STRICT_POLICY)
		const parked = (await triggerDeployUseCase(runs(w, 'oauth'), { appId: 'notes', env: 'prod', ref: COMMIT })).id
		expect((await executeDeploy(deps(w), { runId: parked })).status).toBe('awaiting_approval')
		await decide(w, parked, 'approve')
		expect(sends(w, parked)).toBe(2)
		expect((await executeDeploy(deps(w), { runId: parked })).status).toBe('succeeded')
	})
})

describe('a parked run has an absolute deadline', () => {
	test('a decision after the deadline changes nothing', async () => {
		const w = await world()
		await published(w)
		const { runId } = await requested(w)
		expect((await run(w, runId)).approval_deadline).toBe(w.now + 24 * HOUR)
		w.now += 24 * HOUR
		for (const decision of ['approve', 'reject'] as const) {
			const late = await status(decide(w, runId, decision))
			expect(late.status).toBe(410)
			expect(late.message).toContain('expired')
		}
		expect((await run(w, runId)).status).toBe('awaiting_approval')
		expect(sends(w, runId)).toBe(1)
	})

	test("the environment's requestTtlHours sets it", async () => {
		const w = await world()
		await published(w)
		await choose(w, 'prod', STRICT_POLICY, { ...STRICT_SETTINGS, requestTtlHours: 2 })
		const { runId } = await requested(w)
		expect((await run(w, runId)).approval_deadline).toBe(w.now + 2 * HOUR)
	})

	test('the sweep expires a run past its deadline: it fails, deploys nothing, and says so', async () => {
		const w = await world()
		await published(w)
		const { runId } = await requested(w)
		expect(await sweepParkedRuns(deps(w))).toEqual({ deadlines: 0, expired: 0 })
		w.now += 24 * HOUR
		expect(await sweepParkedRuns(deps(w))).toEqual({ deadlines: 0, expired: 1 })
		expect(await run(w, runId)).toMatchObject({ status: 'failed', failure_cause: 'expired' })
		expect(w.logs.get(`runs/${runId}/logs.ndjson`)).toContain('so it expired')
		expect((await getRunUseCase(runs(w, 'oauth'), runId)).failureCause).toBe('expired')
		expect((await status(decide(w, runId, 'approve'))).status).toBe(410)
		expect(w.deploys).toBe(0)
	})

	test('a run parked before deadlines existed gets one from the sweep, counted from then', async () => {
		const w = await world()
		await published(w)
		const { runId } = await requested(w)
		// As a row parked before the column: no deadline.
		await harnessDatabase(w.db).prepare('UPDATE runs SET approval_deadline = NULL WHERE id = ?').bind(runId).run()
		w.now += 30 * 24 * HOUR
		expect(await sweepParkedRuns(deps(w))).toEqual({ deadlines: 1, expired: 0 })
		expect(await run(w, runId)).toMatchObject({ status: 'awaiting_approval', approval_deadline: w.now + 24 * HOUR })
		expect(await sweepParkedRuns(deps(w))).toEqual({ deadlines: 0, expired: 0 })
	})

	test('a run that parks again after its digests changed gets a fresh deadline', async () => {
		const w = await world()
		await published(w)
		// Lines pass on their own here, so another deploy publishes without waiting; the request still waits for a person.
		await choose(w, 'prod', { ...PERMISSIVE_POLICY, 'deploy-request': 'person' })
		const older = await triggerDeployUseCase(runs(w, 'console'), { appId: 'notes', env: 'prod', ref: 'refs/heads/main' })
		const { runId } = await requested(w)
		const first = (await run(w, runId)).approval_deadline
		await decide(w, runId, 'approve')
		w.contract = WITH_EXPORT
		w.now += 5 * HOUR
		expect((await executeDeploy(deps(w), { runId: older.id })).status).toBe('succeeded')
		expect((await executeDeploy(deps(w), { runId })).status).toBe('awaiting_approval')
		expect((await run(w, runId)).approval_deadline).toBe(w.now + 24 * HOUR)
		expect((await run(w, runId)).approval_deadline).not.toBe(first)
	})
})

describe('two approvers on a parked run', () => {
	const ada = () => caller('console', 'p-ada', 'ada@example.test')
	const bob = () => caller('console', 'p-bob', 'bob@example.test')

	async function twoApprovers(w: World): Promise<string> {
		await published(w)
		await choose(w, 'prod', STRICT_POLICY, { ...STRICT_SETTINGS, approvers: { ...STRICT_SETTINGS.approvers, 'deploy-request': 2 } })
		return (await requested(w)).runId
	}

	test('the first approval is partial, the same person again changes nothing, and a second person completes it', async () => {
		const w = await world()
		const runId = await twoApprovers(w)
		const first = await decide(w, runId, 'approve', ada())
		expect(first.approvers).toBe(2)
		expect(first.partialApproval).toMatchObject({ principalId: 'p-ada', label: 'ada@example.test' })
		expect(first.run.status).toBe('awaiting_approval')
		expect(sends(w, runId)).toBe(1)

		const again = await decide(w, runId, 'approve', ada())
		expect(again.run.status).toBe('awaiting_approval')
		expect(sends(w, runId)).toBe(1)

		const second = await decide(w, runId, 'approve', bob())
		expect(second.run.status).toBe('pending')
		expect(second.approval).toMatchObject({ principalId: 'p-bob' })
		expect(sends(w, runId)).toBe(2)
		expect((await executeDeploy(deps(w), { runId })).status).toBe('succeeded')
	})

	test('a rejection by either refuses it', async () => {
		for (const rejecter of [ada, bob]) {
			const w = await world()
			const runId = await twoApprovers(w)
			await decide(w, runId, 'approve', ada())
			const rejected = await decide(w, runId, 'reject', rejecter())
			expect(rejected.run).toMatchObject({ status: 'failed', failureCause: 'rejected' })
			expect(w.deploys).toBe(0)
		}
	})
})

describe('the approval link', () => {
	test('runs.get carries it from the creation of a request until it is decided, and never for a person', async () => {
		const w = await world()
		await published(w)
		const created = await triggerDeployUseCase(runs(w, 'oauth'), { appId: 'notes', env: 'prod', ref: COMMIT })
		const url = `${ORIGIN}/approvals/${created.id}`
		expect(created.approvalUrl).toBe(url)
		await executeDeploy(deps(w), { runId: created.id })
		const parked = await getRunUseCase(runs(w, 'oauth'), created.id)
		expect(parked).toMatchObject({ status: 'awaiting_approval', approvalUrl: url, approvalDeadline: w.now + 24 * HOUR })
		await decide(w, created.id, 'approve')
		expect((await getRunUseCase(runs(w, 'oauth'), created.id)).approvalUrl).toBeUndefined()

		const person = await triggerDeployUseCase(runs(w, 'console'), { appId: 'notes', env: 'prod', ref: COMMIT })
		expect(person.approvalUrl).toBeUndefined()
	})

	test('the page of a request still being classified says so', async () => {
		const w = await world()
		const created = await triggerDeployUseCase(runs(w, 'oauth'), { appId: 'notes', env: 'prod', ref: COMMIT })
		expect((await status(getApprovalUseCase(approvals(w), created.id))).status).toBe(409)
	})
})

describe('the settings are stored with the protection', () => {
	test('stored as their difference from the defaults, kept beyond the deletion of the environment', async () => {
		const w = await world()
		const settings: ApprovalSettings = {
			deployRequestCommits: 'any',
			requestTtlHours: 6,
			approvers: { ...STRICT_SETTINGS.approvers, 'deploy-request': 2, secrets: 2 },
		}
		const dto = await setEnvironmentProtectionUseCase(approvals(w), { appId: 'notes', env: 'prod', protected: true, settings })
		expect(dto.approvalSettings).toEqual(settings)
		expect(JSON.parse((await w.db.registry.getAppEnv('notes', 'prod'))?.approval_settings ?? '')).toEqual({
			deployRequestCommits: 'any',
			requestTtlHours: 6,
			approvers: { 'deploy-request': 2, secrets: 2 },
		})
		// Omitted keeps them; the defaults store nothing.
		expect((await setEnvironmentProtectionUseCase(approvals(w), { appId: 'notes', env: 'prod', protected: true })).approvalSettings).toEqual(settings)
		await w.db.registry.deleteAppEnv('notes', 'prod')
		await w.db.registry.upsertAppEnv({
			appId: 'notes',
			env: 'prod',
			namespaceId: null,
			provider: 'harbor',
			providerTargetJson: ENVELOPE,
			providerArtifactJson: ENVELOPE,
		})
		expect((await w.db.registry.getAppEnv('notes', 'prod'))?.approval_settings).not.toBeNull()
		await setEnvironmentProtectionUseCase(approvals(w), { appId: 'notes', env: 'prod', protected: true, settings: STRICT_SETTINGS })
		expect((await w.db.registry.getAppEnv('notes', 'prod'))?.approval_settings).toBeNull()
	})

	test('a protection change from a fixture holder writes them too', async () => {
		const w = await world()
		const row = await fixtureProtect(w.db.registry, makeFakeLock(w.db), { appId: 'notes', env: 'stage' }, true, Date.now, undefined, {
			settings: JSON.stringify({ requestTtlHours: 3 }),
		})
		expect(row?.approval_settings).toBe('{"requestTtlHours":3}')
	})
})
