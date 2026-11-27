// ADR-0050 §5: an approval plan is a commit's access change approved ahead of its deploy. A person in the console with
// `access.approve` approves or refuses it under the same rules as a parked run; an approved plan's entries let a later
// deploy's `plan` lines through and are consumed by the publication; a refused, expired, revoked or outgrown plan
// lets nothing through, and the deploy parks as before.

import type { AuthContext } from '@fabrika/auth'
import { permits } from '@fabrika/auth-core'
import { type ApprovalPolicy, type ApprovalSettings, STRICT_POLICY, STRICT_SETTINGS } from '@fabrika/control-contract'
import type { BlobStore } from '@fabrika/platform'
import type { ControlProvider } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { ControlApiError } from '../api/domain'
import { type RunsUseCaseContext, triggerDeployUseCase } from '../api/runs'
import { type ApprovalUseCaseContext, completeApprovalUseCase } from '../approval/api'
import {
	type ApprovalPlanContext,
	challengeApprovalPlanUseCase,
	createApprovalPlanUseCase,
	decideApprovalPlanUseCase,
	getApprovalPlanUseCase,
	listApprovalPlansUseCase,
	revokeApprovalPlanUseCase,
} from '../approval/plans/api'
import { planCommitReader } from '../approval/plans/read'
import { parseClassification } from '../approval/publish'
import { iamPasskeyStepUp } from '../approval/step-up'
import type { ControlRepositories } from '../db'
import type { CommitSource } from '../github/source/commit-files'
import { type ControlJobMessage, executeDeploy, type RunDeps } from '../run-lifecycle'
import { VaultSecretResolver } from '../secret-resolver'
import { memoryCommits } from './helpers/commits'
import { BASE, edited } from './helpers/contracts'
import { createHarness } from './helpers/harness'
import { makeFakeLock } from './helpers/lock'
import { answerChallenge, consoleTokenHeaders, type FakePasskeyIam, fakePasskeyIam, protectAsConsole } from './helpers/passkeys'

const ORIGIN = 'https://console.example.test'
const ENVELOPE = JSON.stringify({ provider: 'harbor', version: 1, payload: {} })
const DAY = 86_400
const PLANNED = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)

/** `editor` gains `notes.delete`: one `role.grants` widening, a `role-actions` line. */
const EDITOR_DELETES = edited("editor: { grants: ['notes.read', 'notes.write']", "editor: { grants: ['notes.read', 'notes.write', 'notes.delete']")
/** On top of that, `owner` loses nothing and `editor` keeps it; a further role change: `owner` gains a membership role. */
const EDITOR_ADMINS = edited(
	"owner: { grants: ['notes.read', 'notes.write', 'notes.delete']",
	"owner: { grants: ['notes.read', 'notes.write', 'notes.delete', 'notes.admin']",
	edited("'notes.delete': 'Delete notes' }", "'notes.delete': 'Delete notes', 'notes.admin': 'Administer notes' }", EDITOR_DELETES),
)

/** `role-actions` waits for a plan; nothing else changes the strict preset. */
const PLAN_ROLES: ApprovalPolicy = { ...STRICT_POLICY, 'role-actions': 'plan' }

interface World {
	readonly db: ControlRepositories
	/** The contract each commit holds; an unknown commit holds `BASE`. */
	readonly contracts: Map<string, string>
	readonly queued: string[]
	readonly iam: FakePasskeyIam
	deploys: number
	now: number
}

async function world(policy: ApprovalPolicy = PLAN_ROLES, settings: ApprovalSettings = STRICT_SETTINGS): Promise<World> {
	const clock = { now: Math.floor(Date.now() / 1000) }
	const { db } = createHarness(() => clock.now)
	const w: World = {
		db,
		contracts: new Map([[PLANNED, EDITOR_DELETES]]),
		queued: [],
		iam: fakePasskeyIam(['p-ada', 'p-bob']),
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
	await protectAsConsole(approvals(w), { appId: 'notes', env: 'prod', protected: true, policy, settings }, 'p-ada')
	return w
}

function commits(w: World): CommitSource {
	return {
		...memoryCommits(),
		open: (input) => memoryCommits({ 'fabrika.contract.ts': w.contracts.get(input.commitSha) ?? BASE }).open(input),
		requestedCommit: () => Promise.resolve({ message: 'Change', merged: true }),
	}
}

function provider(w: World, commit: { sha: string }): ControlProvider {
	return {
		id: 'harbor',
		normalizeRegistration: (input) => input,
		applicationRoot: () => '',
		resolveSource: () => Promise.resolve({ commitSha: commit.sha }),
		deploy: () => {
			w.deploys++
			return Promise.resolve({ state: 'succeeded' })
		},
	}
}

function deps(w: World, sha: string): RunDeps {
	const logs: Pick<BlobStore, 'put'> = { put: () => Promise.resolve() }
	return {
		repositories: w.db,
		provider: provider(w, { sha }),
		secrets: new VaultSecretResolver({}),
		lock: makeFakeLock(w.db),
		queue: { send: () => Promise.resolve() },
		logs,
		runLogs: { put: logs.put, get: () => Promise.resolve(null) },
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

/** A user with `deploy.*` and, unless `approves` is false, `access.approve`. */
function person(id = 'p-ada', approves = true): AuthContext {
	const grants = [{ action: 'deploy.*', scope: null }, ...(approves ? [{ action: 'access.approve', scope: null }] : [])].map((grant) => ({
		...grant,
		source: 'grant' as const,
	}))
	return {
		ok: true,
		principal: { id, type: 'user', label: `${id}@example.test` },
		can: (action, scope) => permits(grants, action, scope),
		scopedTo: () => null,
		audit: () => Promise.resolve(),
	}
}

/** An agent acting for `p-ada` through an OAuth client, with `deploy.*` only. */
function agent(): AuthContext {
	const base = person('p-ada', false)
	return { ...base, oauth: { app: 'vozka', clientId: 'https://agent.example.test/client.json', scopes: ['deploy'], grantId: 'g', tokenId: 't' } }
}

function request(bearer: boolean, principalId: string): Request {
	const headers: Record<string, string> = { Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', ...consoleTokenHeaders(principalId) }
	if (bearer) headers.Authorization = 'Bearer px_test'
	return new Request(`${ORIGIN}/api/rpc`, { method: 'POST', headers })
}

function plans(w: World, auth: AuthContext = person(), bearer = auth.oauth !== undefined): ApprovalPlanContext {
	const admitted = request(bearer, auth.principal?.id ?? 'anonymous')
	const stepUp = iamPasskeyStepUp(w.iam.gateway, admitted)
	return {
		repositories: w.db,
		auth,
		admission: { request: admitted },
		readCommit: planCommitReader({ repositories: w.db, provider: provider(w, { sha: PLANNED }), commits: commits(w) }),
		consoleOrigin: ORIGIN,
		now: () => w.now,
		...(stepUp === null ? {} : { stepUp }),
	}
}

function approvals(w: World, auth: AuthContext = person()): ApprovalUseCaseContext {
	const console = request(false, auth.principal?.id ?? 'p-ada')
	const stepUp = iamPasskeyStepUp(w.iam.gateway, console)
	return {
		repositories: w.db,
		auth,
		queue: queue(w),
		lock: makeFakeLock(w.db),
		request: console,
		now: () => w.now,
		...(stepUp === null ? {} : { stepUp }),
	}
}

function runs(w: World): RunsUseCaseContext {
	return {
		repositories: w.db,
		queue: queue(w),
		logs: { get: () => Promise.resolve(null) },
		cancel: () => Promise.resolve(),
		auth: person(),
		admission: { request: request(false, 'p-ada') },
		commits: commits(w),
		consoleOrigin: ORIGIN,
	}
}

const status = async (promise: Promise<unknown>): Promise<{ status: number; message: string }> => {
	try {
		await promise
		return { status: 200, message: '' }
	} catch (error) {
		if (error instanceof ControlApiError) return { status: error.httpStatus, message: error.message }
		throw error
	}
}

/** A person's deploy of `sha` on `prod`, run until it parks or finishes; a parked one is approved when `approve` says so. */
async function deploy(w: World, sha: string, approve = false): Promise<{ runId: string; status: string }> {
	const created = await triggerDeployUseCase(runs(w), { appId: 'notes', env: 'prod', ref: sha })
	const result = await executeDeploy(deps(w, sha), { runId: created.id })
	if (result.status !== 'awaiting_approval' || !approve) return result
	const row = await w.db.runs.getRun(created.id)
	const classification = parseClassification(await w.db.runs.document(row?.classification_json ?? ''))
	await completeApprovalUseCase(approvals(w), {
		runId: created.id,
		decision: 'approve',
		candidateDigest: classification.candidateDigest,
		baselineDigest: classification.baselineDigest,
	})
	return executeDeploy(deps(w, sha), { runId: created.id })
}

/** `prod` runs `BASE`, approved by a person: its health check opens to anyone, a `public` line. */
async function published(w: World): Promise<void> {
	expect((await deploy(w, 'c'.repeat(40), true)).status).toBe('succeeded')
}

async function plan(w: World, auth: AuthContext = agent(), commitSha = PLANNED) {
	return createApprovalPlanUseCase(plans(w, auth), { appId: 'notes', env: 'prod', commitSha })
}

async function decidePlan(w: World, id: string, decision: 'approve' | 'reject', auth: AuthContext = person()) {
	const held = await getApprovalPlanUseCase(plans(w, auth), id)
	return decideApprovalPlanUseCase(plans(w, auth), {
		id,
		decision,
		candidateDigest: held.candidateDigest,
		baselineDigest: held.baselineDigest,
	})
}

describe('a plan is made for a commit and shown to whoever may approve it', () => {
	test("an agent plans a commit: its `plan` lines, one entry per subject, waiting; a person sees it, another agent's caller does not", async () => {
		const w = await world()
		await published(w)
		const made = await plan(w)
		expect(made).toMatchObject({ state: 'pending', commitSha: PLANNED, outcome: 'widening', approvers: 1, requesterMayApprove: true, stepUp: 'none' })
		expect(made.url).toBe(`${ORIGIN}/approvals/plans/${made.id}`)
		expect(made.requester).toMatchObject({ credential: 'oauth', personId: 'p-ada' })
		expect(made.lines.some((line) => line.mode === 'plan' && line.change.rule === 'role.grants')).toBe(true)
		expect(made.entries).toEqual([{ subject: 'role:editor', state: 'pending' }])
		expect((await listApprovalPlansUseCase(plans(w, person('p-bob')))).items.map((item) => item.id)).toEqual([made.id])
		// A person without `access.approve` who did not ask sees neither the plan nor its listing.
		expect((await status(getApprovalPlanUseCase(plans(w, person('p-eve', false)), made.id))).status).toBe(404)
		expect((await listApprovalPlansUseCase(plans(w, person('p-eve', false)))).items).toEqual([])
	})

	test('refused: no `deploy.trigger` (404), an unprotected environment, and a change with no line a plan lets through (409)', async () => {
		const w = await world()
		await published(w)
		const noTrigger: AuthContext = { ...person('p-eve', false), can: () => false }
		expect((await status(plan(w, noTrigger))).status).toBe(404)
		const stage = await status(createApprovalPlanUseCase(plans(w, agent()), { appId: 'notes', env: 'stage', commitSha: PLANNED }))
		expect(stage).toMatchObject({ status: 409, message: expect.stringContaining('is not protected') })
		const nothing = await status(plan(w, agent(), OTHER))
		expect(nothing).toMatchObject({ status: 409, message: expect.stringContaining('no line of this change waits for a plan') })
	})
})

describe('deciding a plan follows the rules of a parked run', () => {
	test('approved in the console: the deploy of the commit publishes without waiting and consumes the entry', async () => {
		const w = await world()
		await published(w)
		const made = await plan(w)
		const approved = await decidePlan(w, made.id, 'approve')
		expect(approved).toMatchObject({ state: 'approved', decision: { principalId: 'p-ada' }, expiresAt: w.now + 30 * DAY })
		expect(approved.entries).toEqual([{ subject: 'role:editor', state: 'active' }])
		const deployed = await deploy(w, PLANNED)
		expect(deployed.status).toBe('succeeded')
		expect(w.deploys).toBe(2)
		const after = await getApprovalPlanUseCase(plans(w), made.id)
		expect(after.entries).toEqual([{ subject: 'role:editor', state: 'consumed', consumedByRunId: deployed.runId }])
	})

	test('a consumed entry covers one publication: the same change again, after a revert, waits', async () => {
		const w = await world()
		await published(w)
		await decidePlan(w, (await plan(w)).id, 'approve')
		expect((await deploy(w, PLANNED)).status).toBe('succeeded')
		expect((await deploy(w, 'c'.repeat(40))).status).toBe('succeeded')
		expect((await deploy(w, PLANNED)).status).toBe('awaiting_approval')
	})

	test('rejected: nothing is covered, the deploy parks', async () => {
		const w = await world()
		await published(w)
		const made = await plan(w)
		expect((await decidePlan(w, made.id, 'reject')).state).toBe('rejected')
		expect((await status(decidePlan(w, made.id, 'approve'))).status).toBe(409)
		expect((await deploy(w, PLANNED)).status).toBe('awaiting_approval')
	})

	test('the wrong person: an agent or a key (403), a person without `access.approve` (404)', async () => {
		const w = await world()
		await published(w)
		const made = await plan(w)
		const asAgent = await status(decideApprovalPlanUseCase(plans(w, agent()), {
			id: made.id,
			decision: 'approve',
			candidateDigest: made.candidateDigest,
			baselineDigest: made.baselineDigest,
		}))
		expect(asAgent.status).toBe(403)
		const withKey = await status(decideApprovalPlanUseCase(plans(w, person(), true), {
			id: made.id,
			decision: 'approve',
			candidateDigest: made.candidateDigest,
			baselineDigest: made.baselineDigest,
		}))
		expect(withKey).toMatchObject({ status: 403, message: expect.stringContaining('not with a key') })
		expect((await status(decidePlan(w, made.id, 'approve', person('p-eve', false)))).status).toBe(404)
		expect((await getApprovalPlanUseCase(plans(w), made.id)).state).toBe('pending')
		expect((await deploy(w, PLANNED)).status).toBe('awaiting_approval')
	})

	test("requesterMayApprove: false keeps the requester's own person from approving, not from refusing", async () => {
		const w = await world(PLAN_ROLES, {
			...STRICT_SETTINGS,
			requesterMayApprove: { ...STRICT_SETTINGS.requesterMayApprove, 'role-actions': false },
		})
		await published(w)
		const made = await plan(w)
		expect(made.requesterMayApprove).toBe(false)
		expect(await status(decidePlan(w, made.id, 'approve', person('p-ada')))).toMatchObject({
			status: 403,
			message: expect.stringContaining('asked for on your behalf'),
		})
		expect((await decidePlan(w, made.id, 'approve', person('p-bob'))).state).toBe('approved')
	})

	test('approvers: 2 takes two different people; the first approval alone covers nothing', async () => {
		const w = await world(PLAN_ROLES, { ...STRICT_SETTINGS, approvers: { ...STRICT_SETTINGS.approvers, 'role-actions': 2 } })
		await published(w)
		const made = await plan(w)
		const partial = await decidePlan(w, made.id, 'approve', person('p-ada'))
		expect(partial).toMatchObject({ state: 'pending', partialApproval: { principalId: 'p-ada' } })
		expect((await decidePlan(w, made.id, 'approve', person('p-ada'))).state).toBe('pending')
		expect((await deploy(w, PLANNED)).status).toBe('awaiting_approval')
		expect((await decidePlan(w, made.id, 'approve', person('p-bob'))).state).toBe('approved')
	})

	test('stepUp: webauthn takes a passkey bound to the decision', async () => {
		const w = await world(PLAN_ROLES, { ...STRICT_SETTINGS, stepUp: { ...STRICT_SETTINGS.stepUp, 'role-actions': 'webauthn' } })
		await published(w)
		const made = await plan(w)
		expect(made.stepUp).toBe('webauthn')
		const input = { id: made.id, decision: 'approve' as const, candidateDigest: made.candidateDigest, baselineDigest: made.baselineDigest }
		expect((await status(decideApprovalPlanUseCase(plans(w), input))).status).toBe(403)
		const stepUp = answerChallenge(await challengeApprovalPlanUseCase(plans(w), input), 'p-ada')
		expect((await decideApprovalPlanUseCase(plans(w), { ...input, stepUp })).state).toBe('approved')
	})

	test('a decision on other digests than the page showed is refused', async () => {
		const w = await world()
		await published(w)
		const made = await plan(w)
		const stale = await status(decideApprovalPlanUseCase(plans(w), {
			id: made.id,
			decision: 'approve',
			candidateDigest: made.baselineDigest,
			baselineDigest: made.baselineDigest,
		}))
		expect(stale.status).toBe(409)
	})
})

describe('a plan covers only for a while, and only what it showed', () => {
	test('an expired plan: past its deadline nobody decides it (410), it is listed nowhere, and the deploy parks', async () => {
		const w = await world()
		await published(w)
		const made = await plan(w)
		w.now = made.deadline
		expect(await status(decidePlan(w, made.id, 'approve'))).toMatchObject({ status: 410, message: expect.stringContaining('expired') })
		expect((await getApprovalPlanUseCase(plans(w), made.id)).state).toBe('expired')
		expect((await listApprovalPlansUseCase(plans(w))).items).toEqual([])
		expect((await deploy(w, PLANNED)).status).toBe('awaiting_approval')
	})

	test('approved entries expire after planTtlDays', async () => {
		const w = await world(PLAN_ROLES, { ...STRICT_SETTINGS, planTtlDays: 2 })
		await published(w)
		const approved = await decidePlan(w, (await plan(w)).id, 'approve')
		expect(approved.expiresAt).toBe(w.now + 2 * DAY)
		w.now += 2 * DAY
		expect((await getApprovalPlanUseCase(plans(w), approved.id)).entries[0]?.state).toBe('expired')
		expect((await deploy(w, PLANNED)).status).toBe('awaiting_approval')
	})

	test('a revoked plan covers nothing; only a person in the console with access.approve revokes it', async () => {
		const w = await world()
		await published(w)
		const approved = await decidePlan(w, (await plan(w)).id, 'approve')
		expect((await status(revokeApprovalPlanUseCase(plans(w, agent()), approved.id))).status).toBe(403)
		const revoked = await revokeApprovalPlanUseCase(plans(w), approved.id)
		expect(revoked).toMatchObject({ state: 'revoked', entries: [{ subject: 'role:editor', state: 'revoked' }] })
		expect((await deploy(w, PLANNED)).status).toBe('awaiting_approval')
	})

	test('a deploy with a line the plan did not show waits; the plan stays unconsumed', async () => {
		const w = await world()
		await published(w)
		const approved = await decidePlan(w, (await plan(w)).id, 'approve')
		w.contracts.set(OTHER, EDITOR_ADMINS)
		expect((await deploy(w, OTHER)).status).toBe('awaiting_approval')
		expect((await getApprovalPlanUseCase(plans(w), approved.id)).entries[0]?.state).toBe('active')
	})

	test('transition binding: a baseline the approver did not see is not covered; after-state covers it', async () => {
		// Owners and editors may assign `editor`: a change of the role that no `plan` category holds.
		const assignable = edited(
			"editor: { grants: ['notes.read', 'notes.write'], member: { scope: 'workspace', assignableBy: ['owner'] } }",
			"editor: { grants: ['notes.read', 'notes.write'], member: { scope: 'workspace', assignableBy: ['owner', 'editor'] } }",
		)
		const w = await world()
		await published(w)
		await decidePlan(w, (await plan(w)).id, 'approve')
		// Someone changes `editor` on prod in between: the plan approved `BASE → EDITOR_DELETES`, not `assignable → EDITOR_DELETES`.
		w.contracts.set(OTHER, assignable)
		expect((await deploy(w, OTHER)).status).toBe('succeeded')
		expect((await deploy(w, PLANNED)).status).toBe('awaiting_approval')

		await protectAsConsole(approvals(w), {
			appId: 'notes',
			env: 'prod',
			protected: true,
			policy: PLAN_ROLES,
			settings: { ...STRICT_SETTINGS, planBinding: 'after-state' },
		}, 'p-ada')
		// The run parked above still waits on its own; a new deploy is classified again: the line it shows the plan showed too.
		expect((await deploy(w, PLANNED)).status).toBe('succeeded')
	})

	test('plans follow one another: a plan made after the first deployed covers the next change', async () => {
		const w = await world()
		await published(w)
		await decidePlan(w, (await plan(w)).id, 'approve')
		// A second plan made after the first deployed would start from EDITOR_DELETES; plan it against that baseline.
		expect((await deploy(w, PLANNED)).status).toBe('succeeded')
		w.contracts.set(OTHER, EDITOR_ADMINS)
		const second = await decidePlan(w, (await plan(w, agent(), OTHER)).id, 'approve')
		expect(second.entries.map((entry) => entry.subject)).toContain('role:owner')
		expect((await deploy(w, OTHER)).status).toBe('succeeded')
	})
})
