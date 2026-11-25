// ADR-0083 §8: an approval request, the pending registry write a non-person asks a person to approve. The lifecycle runs
// through a test kind injected into the use cases, never the production registry, against SQLite always and Postgres
// when FABRIKA_TEST_POSTGRES_URL is set: creation and the requester's right to ask, the decision under its deadline,
// `approvers` and `requesterMayApprove`, the execution bound to its before-state and the policy as it stands then, and the
// sweep that expires, closes and follows what was left.

import { dispatchRpcRequest } from '@fabrika/app/service'
import type { AuthContext } from '@fabrika/auth'
import { type DomainEvent, permits } from '@fabrika/auth-core'
import { type ApprovalPolicy, type ApprovalSettings, CONTROL_ACTIONS, STRICT_POLICY, STRICT_SETTINGS } from '@fabrika/control-contract'
import { type DeployLocks, SqlDeployLocks, uuidv7 } from '@fabrika/platform'
import type { JsonValue } from '@fabrika/provider-contract'
import { afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { ControlApiError } from '../api/domain'
import { storedPolicy, storedSettings } from '../approval/categories'
import {
	type ApprovalRequestContext,
	createApprovalRequestUseCase,
	decideApprovalRequestUseCase,
	getApprovalRequestUseCase,
	listApprovalRequestsUseCase,
} from '../approval/requests/api'
import { executeApprovedRequest, sweepApprovalRequests } from '../approval/requests/execute'
import { requestKind, type RequestKindRegistry, type RequestOutcome } from '../approval/requests/kind'
import { REFUSED_KINDS } from '../approval/requests/refused'
import { type ControlRpcContext, controlRpcRouter } from '../control-rpc'
import { type ControlRepositories, createControlRepositories } from '../db'
import { acquireLease, LEASE_TTL_MS, runLeaseKey } from '../lease'
import { createHarness, harnessDatabase } from './helpers/harness'
import { authWithActions } from './helpers/iam'
import { fixtureProtect } from './helpers/lock'
import { createPostgres, hasPostgres, skipReason } from './helpers/postgres'
import { fakeControlProvider } from './helpers/provider'
import { unusedSourceConnection } from './helpers/source-connection'

if (!hasPostgres) console.warn(`approval-requests.test.ts Postgres half ${skipReason}`)

const ORIGIN = 'https://console.example.test'
const ENVELOPE = JSON.stringify({ provider: 'harbor', version: 1, payload: {} })
const T0 = 1_800_000_000
const HOUR = 3600

/** The test kind's own state: a note per name, what each execution saw, and how the next one behaves. */
interface Notes {
	readonly values: Map<string, string>
	readonly effects: {
		readonly operationId: string
		readonly state: string | null
		readonly recorded: string | null
		readonly approver: string | null
	}[]
	execute: 'ok' | 'fail' | 'throw'
	follow: RequestOutcome | { readonly state: 'unknown' }
	followed: string[]
}

const noteInput = z.object({ appId: z.string().min(1), env: z.string().min(1), name: z.string().min(1), value: z.string() })

/** `input` stands in for another release's schema of the same kind: a newer one with a key this one drops. */
function notesKind(notes: Notes, input: z.ZodType<z.infer<typeof noteInput>, z.ZodTypeDef, unknown> = noteInput) {
	return requestKind({
		kind: 'test.notes.put',
		category: 'secrets',
		input,
		before: z.object({ value: z.string().nullable() }),
		coordinates: (input) => ({ appId: input.appId, env: input.env }),
		requesterAction: CONTROL_ACTIONS.SECRET_MANAGE,
		captureBefore: (_c, input) => Promise.resolve({ value: notes.values.get(input.name) ?? null }),
		execute: async (c, input, execution) => {
			const row = await c.repositories.approvalRequests.get(execution.requestId)
			notes.effects.push({
				operationId: execution.operationId,
				state: row?.state ?? null,
				recorded: row?.operation_id ?? null,
				approver: c.auth.principal?.id ?? null,
			})
			if (notes.execute === 'throw') throw new Error('the provider did not answer: https://token@example.test')
			if (notes.execute === 'fail') return { state: 'failed', error: 'the provider refused the note' }
			notes.values.set(input.name, input.value)
			return { state: 'executed', result: { name: input.name, length: input.value.length } }
		},
		follow: (_c, _input, execution) => {
			notes.followed.push(execution.operationId)
			return Promise.resolve(notes.follow)
		},
		describe: (input, before) => ({
			summary: [{ text: 'Set the note ', agent: false }, { text: input.name, agent: true }, { text: ` of ${input.appId}@${input.env}`, agent: false }],
			facts: [{ label: 'Before', value: { text: before.value ?? 'none', agent: before.value !== null } }],
		}),
	})
}

interface Backend {
	readonly name: string
	readonly skip: boolean
	open(now: () => number): Promise<{ repositories: ControlRepositories; locks: DeployLocks; close(): Promise<void> }>
}

const backends: readonly Backend[] = [
	{
		name: 'sqlite',
		skip: false,
		open: (now) => {
			const harness = createHarness(now)
			return Promise.resolve({
				repositories: harness.repositories,
				locks: new SqlDeployLocks(harnessDatabase(harness.repositories)),
				close: () => {
					harness.sqlite.close()
					return Promise.resolve()
				},
			})
		},
	},
	{
		name: 'postgres',
		skip: !hasPostgres,
		open: async (now) => {
			const fixture = await createPostgres('control_requests')
			return { repositories: createControlRepositories(fixture.db, { now }), locks: new SqlDeployLocks(fixture.db), close: () => fixture.close() }
		},
	},
]

type Credential = 'console' | 'key' | 'oauth' | 'service'

interface Who {
	readonly credential: Credential
	readonly id?: string
	readonly label?: string
	readonly actions?: readonly string[]
}

const ADA: Who = { credential: 'console', id: 'p-ada', label: 'ada@example.test' }
const BOB: Who = { credential: 'console', id: 'p-bob', label: 'bob@example.test' }
const AGENT: Who = { credential: 'oauth', id: 'p-ada', label: 'ada@example.test', actions: [CONTROL_ACTIONS.SECRET_MANAGE] }

for (const backend of backends) {
	describe.skipIf(backend.skip)(`approval requests (${backend.name})`, () => {
		let closing: (() => Promise<void>) | null = null
		/** Close the current world: a test that opens a second one closes its first. */
		async function closeWorld(): Promise<void> {
			const close = closing
			closing = null
			await close?.()
		}
		afterEach(closeWorld)

		interface World {
			readonly db: ControlRepositories
			readonly locks: DeployLocks
			readonly notes: Notes
			readonly kinds: RequestKindRegistry
			readonly audits: DomainEvent[]
			now: number
		}

		async function world(): Promise<World> {
			const clock = { now: T0 }
			const { repositories, locks, close } = await backend.open(() => clock.now)
			closing = close
			const notes: Notes = { values: new Map(), effects: [], execute: 'ok', follow: { state: 'unknown' }, followed: [] }
			const w: World = {
				db: repositories,
				locks,
				notes,
				kinds: new Map([['test.notes.put', notesKind(notes)]]),
				audits: [],
				get now() {
					return clock.now
				},
				set now(value) {
					clock.now = value
				},
			}
			await repositories.registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes', defaultBranch: 'main' })
			for (const env of ['prod', 'stage']) {
				await repositories.registry.upsertAppEnv({
					appId: 'notes',
					env,
					namespaceId: null,
					provider: 'harbor',
					providerTargetJson: ENVELOPE,
					providerArtifactJson: ENVELOPE,
				})
			}
			return w
		}

		function auth(w: World, who: Who): AuthContext {
			const actions = who.actions ?? [CONTROL_ACTIONS.ACCESS_APPROVE]
			const grants = actions.map((action) => ({ action, scope: null, source: 'grant' as const }))
			const service = who.credential === 'service'
			return {
				ok: true,
				principal: { id: who.id ?? (service ? 'svc-ci' : 'p-ada'), type: service ? 'service' : 'user', label: who.label ?? (service ? 'ci' : 'ada') },
				...(who.credential === 'oauth'
					? { oauth: { app: 'vozka', clientId: 'https://agent.example.test/client.json', scopes: ['operate'], grantId: 'grant-1', tokenId: 't' } }
					: {}),
				can: (action, scope) => permits(grants, action, scope),
				scopedTo: () => null,
				audit: (event) => {
					w.audits.push(event)
					return Promise.resolve()
				},
			}
		}

		/** `kinds: null` serves the production registry. */
		function context(w: World, who: Who, options: { kinds?: RequestKindRegistry | null; consoleOrigin?: string | null } = {}): ApprovalRequestContext {
			const headers: Record<string, string> = { 'Sec-Fetch-Site': 'same-origin' }
			if (who.credential !== 'console') headers.Authorization = 'Bearer px_test'
			return {
				repositories: w.db,
				auth: auth(w, who),
				admission: { request: new Request(`${ORIGIN}/api/rpc`, { method: 'POST', headers }) },
				lock: w.locks,
				...(options.kinds === null ? {} : { kinds: options.kinds ?? w.kinds }),
				...(options.consoleOrigin === null ? {} : { consoleOrigin: options.consoleOrigin ?? ORIGIN }),
				now: () => w.now,
			}
		}

		async function choose(w: World, policy: ApprovalPolicy, settings: ApprovalSettings = STRICT_SETTINGS): Promise<void> {
			await fixtureProtect(w.db.registry, w.locks, { appId: 'notes', env: 'prod' }, true, Date.now, storedPolicy(policy), storedSettings(settings))
		}

		const ask = (w: World, who: Who = AGENT, input: JsonValue = { appId: 'notes', env: 'prod', name: 'greeting', value: 'hello' }) =>
			createApprovalRequestUseCase(context(w, who), { kind: 'test.notes.put', input })

		async function decide(w: World, id: string, decision: 'approve' | 'reject', who: Who = ADA) {
			const request = await getApprovalRequestUseCase(context(w, who), id)
			return decideApprovalRequestUseCase(context(w, who), { id, decision, inputDigest: request.inputDigest })
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

		const row = async (w: World, id: string) => {
			const found = await w.db.approvalRequests.get(id)
			if (found === null) throw new Error(`no request ${id}`)
			return found
		}

		describe('the lifecycle', () => {
			test('created pending with its link, approved by a person, executed with that person under an operation id recorded first', async () => {
				const w = await world()
				const created = await ask(w)
				expect(created).toEqual({ id: created.id, url: `${ORIGIN}/approvals/requests/${created.id}`, state: 'pending' })
				expect(await row(w, created.id)).toMatchObject({
					kind: 'test.notes.put',
					input_json: '{"appId":"notes","env":"prod","name":"greeting","value":"hello"}',
					app_id: 'notes',
					env: 'prod',
					category: 'secrets',
					requester_id: 'p-ada',
					requester_type: 'user',
					requester_credential: 'oauth',
					requester_client_id: 'https://agent.example.test/client.json',
					requester_grant_id: 'grant-1',
					requester_issuer_id: null,
					before_json: '{"value":null}',
					state: 'pending',
					deadline: T0 + 24 * HOUR,
					created_at: T0,
				})

				const read = await getApprovalRequestUseCase(context(w, AGENT), created.id)
				expect(read.description.summary).toEqual([
					{ text: 'Set the note ', agent: false },
					{ text: 'greeting', agent: true },
					{ text: ' of notes@prod', agent: false },
				])
				expect(read).toMatchObject({
					state: 'pending',
					approvers: 1,
					requesterMayApprove: true,
					requester: { personId: 'p-ada', clientId: expect.any(String) },
				})

				w.now += HOUR
				const decided = await decide(w, created.id, 'approve', BOB)
				expect(decided).toMatchObject({
					state: 'executed',
					decision: { principalId: 'p-bob', label: 'bob@example.test', at: T0 + HOUR },
					result: { name: 'greeting', length: 5 },
				})
				expect(w.notes.values.get('greeting')).toBe('hello')
				expect(w.notes.effects).toEqual([{
					operationId: decided.operationId ?? '',
					state: 'executing',
					recorded: decided.operationId ?? '',
					approver: 'p-bob',
				}])
				expect((await row(w, created.id)).decision_id).toEqual(expect.any(String))
				expect(w.audits.map((event) => [event.action, event.resourceType])).toEqual([
					['access.approve', 'approval_request'],
					['test.notes.put', 'approval_request'],
				])
				expect(w.audits[1]?.metadata).toMatchObject({ state: 'executed', operationId: decided.operationId, requester: { id: 'p-ada' } })
			})

			test('a second tap or a repeated POST changes nothing', async () => {
				const w = await world()
				const { id } = await ask(w)
				const first = await decide(w, id, 'approve')
				const again = await decide(w, id, 'approve')
				expect(again).toEqual(first)
				expect(w.notes.effects).toHaveLength(1)
				expect((await status(decide(w, id, 'approve', BOB))).status).toBe(409)
				expect((await status(decide(w, id, 'reject'))).status).toBe(409)
				expect(await row(w, id)).toMatchObject({ state: 'executed', decided_by_id: 'p-ada' })
			})

			test('a refusal closes it, and nothing executes', async () => {
				const w = await world()
				const { id } = await ask(w)
				expect(await decide(w, id, 'reject', BOB)).toMatchObject({ state: 'rejected', decision: { principalId: 'p-bob' } })
				expect(await decide(w, id, 'reject', BOB)).toMatchObject({ state: 'rejected' })
				expect((await status(decide(w, id, 'approve'))).status).toBe(409)
				expect(w.notes.effects).toEqual([])
				expect(w.audits.map((event) => event.metadata)).toEqual([expect.objectContaining({ decision: 'reject' })])
			})

			test('a decision after the deadline is refused, and the sweep expires it', async () => {
				const w = await world()
				const { id } = await ask(w)
				w.now += 24 * HOUR
				const late = await status(decide(w, id, 'approve'))
				expect(late.status).toBe(410)
				expect(late.message).toContain('expired')
				expect((await status(decide(w, id, 'reject'))).status).toBe(410)
				expect((await row(w, id)).state).toBe('pending')
				expect(await sweepApprovalRequests({ repositories: w.db, lock: w.locks, kinds: w.kinds })).toEqual({ expired: 1, interrupted: 0, settled: 0 })
				expect((await getApprovalRequestUseCase(context(w, AGENT), id)).state).toBe('expired')
				expect((await status(decide(w, id, 'approve'))).status).toBe(410)
				expect(await sweepApprovalRequests({ repositories: w.db, lock: w.locks, kinds: w.kinds })).toEqual({ expired: 0, interrupted: 0, settled: 0 })
				expect(w.notes.effects).toEqual([])
			})

			test("the deadline is the environment's requestTtlHours after creation, and the conditional write checks it", async () => {
				const w = await world()
				await choose(w, STRICT_POLICY, { ...STRICT_SETTINGS, requestTtlHours: 2 })
				const { id } = await ask(w)
				expect((await row(w, id)).deadline).toBe(T0 + 2 * HOUR)
				const fresh = await row(w, id)
				w.now += 2 * HOUR
				expect(await w.db.approvalRequests.reject(id, { decisionId: uuidv7(), id: 'p-ada', label: 'ada' })).toBe(false)
				expect(await w.db.approvalRequests.recordPartialApproval(id, { id: 'p-ada', label: 'ada' })).toBe(false)
				expect(await row(w, id)).toEqual(fresh)
			})
		})

		describe('execution', () => {
			test('a changed before-state closes the request stale, and nothing executes', async () => {
				const w = await world()
				const { id } = await ask(w)
				w.notes.values.set('greeting', 'changed by someone else')
				const decided = await decide(w, id, 'approve')
				expect(decided.state).toBe('stale')
				expect(decided.error).toContain('changed since it was asked for')
				expect(decided.operationId).toBeUndefined()
				expect(w.notes.effects).toEqual([])
			})

			test('a failed execution says why', async () => {
				const w = await world()
				w.notes.execute = 'fail'
				const { id } = await ask(w)
				expect(await decide(w, id, 'approve')).toMatchObject({ state: 'failed', error: 'the provider refused the note' })
			})

			test('a throw leaves it unknown without the error text, and the sweep follows the same operation until it settles', async () => {
				const w = await world()
				w.notes.execute = 'throw'
				const { id } = await ask(w)
				const decided = await decide(w, id, 'approve')
				expect(decided.state).toBe('unknown')
				expect(decided.error).not.toContain('token')
				const operationId = decided.operationId ?? ''
				expect(w.audits.at(-1)?.metadata).toMatchObject({ state: 'unknown', operationId })

				const sweep = () => sweepApprovalRequests({ repositories: w.db, lock: w.locks, kinds: w.kinds })
				expect(await sweep()).toEqual({ expired: 0, interrupted: 0, settled: 0 })
				expect((await row(w, id)).state).toBe('unknown')
				w.notes.follow = { state: 'executed', result: { retried: true } }
				expect(await sweep()).toEqual({ expired: 0, interrupted: 0, settled: 1 })
				expect(w.notes.followed).toEqual([operationId, operationId])
				expect(await getApprovalRequestUseCase(context(w, AGENT), id)).toMatchObject({ state: 'executed', operationId, result: { retried: true } })
			})

			test('the sweep turns an interrupted execution unknown and follows it; an approval that never started fails', async () => {
				const w = await world()
				const executing = await ask(w)
				const approvedOnly = await ask(w, AGENT, { appId: 'notes', env: 'prod', name: 'farewell', value: 'bye' })
				const holder = uuidv7()
				expect(await w.locks.acquire(runLeaseKey('notes', 'prod'), holder, LEASE_TTL_MS)).toBe(true)
				const fence = { holder, nowMs: Date.now() }
				const decider = (id: string) => ({ decisionId: uuidv7(), id, label: id })
				expect(await w.db.approvalRequests.approve(executing.id, decider('p-ada'), null, fence)).toBe(true)
				expect(await w.db.approvalRequests.startExecution(executing.id, 'op-1', fence)).toBe(true)
				expect(await w.db.approvalRequests.approve(approvedOnly.id, decider('p-ada'), null, fence)).toBe(true)
				// While the executor holds the lease, the sweep leaves both alone.
				expect(await sweepApprovalRequests({ repositories: w.db, lock: w.locks, kinds: w.kinds })).toEqual({ expired: 0, interrupted: 0, settled: 0 })
				await w.locks.release(runLeaseKey('notes', 'prod'), holder)

				w.notes.follow = { state: 'failed', error: 'the provider holds no such note' }
				expect(await sweepApprovalRequests({ repositories: w.db, lock: w.locks, kinds: w.kinds })).toEqual({ expired: 0, interrupted: 1, settled: 1 })
				expect(w.notes.followed).toEqual(['op-1'])
				expect(await row(w, executing.id)).toMatchObject({ state: 'failed', operation_id: 'op-1', error: 'the provider holds no such note' })
				expect(await row(w, approvedOnly.id)).toMatchObject({ state: 'failed', operation_id: null })
				expect((await row(w, approvedOnly.id)).error).toContain('nothing changed')
				expect(w.notes.effects).toEqual([])
			})

			test('a kind this Control does not serve stays unknown for the release that does', async () => {
				const w = await world()
				w.notes.execute = 'throw'
				const { id } = await ask(w)
				await decide(w, id, 'approve')
				expect(await sweepApprovalRequests({ repositories: w.db, lock: w.locks, kinds: new Map() })).toEqual({ expired: 0, interrupted: 0, settled: 0 })
				expect((await row(w, id)).state).toBe('unknown')
				expect((await getApprovalRequestUseCase(context(w, ADA, { kinds: new Map() }), id)).description.summary[0]?.text).toContain(
					'which this Control cannot describe',
				)
			})

			test('an input this Control reads without a key the person approved is neither described nor executed', async () => {
				const w = await world()
				const newer = new Map([['test.notes.put', notesKind(w.notes, noteInput.extend({ expiresIn: z.number().optional() }))]])
				const { id } = await createApprovalRequestUseCase(context(w, AGENT, { kinds: newer }), {
					kind: 'test.notes.put',
					input: { appId: 'notes', env: 'prod', name: 'greeting', value: 'hello', expiresIn: 60 },
				})
				expect((await row(w, id)).input_json).toContain('"expiresIn":60')
				// This Control serves the kind without the key, as a release rolled back under the request does.
				expect((await getApprovalRequestUseCase(context(w, ADA), id)).description.summary[0]?.text).toContain('which this Control cannot describe')

				const lease = await acquireLease(w.locks, runLeaseKey('notes', 'prod'))
				if (lease === null) throw new Error('the lease is held')
				try {
					expect(await w.db.approvalRequests.approve(id, { decisionId: uuidv7(), id: 'p-ada', label: 'ada' }, null, lease.fence())).toBe(true)
					const kind = w.kinds.get('test.notes.put')
					if (kind === undefined) throw new Error('no test kind')
					await executeApprovedRequest({ repositories: w.db, auth: auth(w, ADA) }, kind, await row(w, id), lease)
				} finally {
					await lease.release()
				}
				const closed = await row(w, id)
				expect(closed).toMatchObject({ state: 'failed', operation_id: null })
				expect(closed.error).toContain('not the input that was approved')
				expect(w.notes.effects).toEqual([])
				expect(w.notes.values.has('greeting')).toBe(false)
			})

			test('a request this Control cannot describe can only be refused: an approval answers 409 and changes nothing', async () => {
				const w = await world()
				const newer = new Map([['test.notes.put', notesKind(w.notes, noteInput.extend({ expiresIn: z.number().optional() }))]])
				const reduced = await createApprovalRequestUseCase(context(w, AGENT, { kinds: newer }), {
					kind: 'test.notes.put',
					input: { appId: 'notes', env: 'prod', name: 'greeting', value: 'hello', expiresIn: 60 },
				})
				const unserved = await ask(w, AGENT, { appId: 'notes', env: 'prod', name: 'farewell', value: 'bye' })
				for (const [id, kinds] of [[reduced.id, w.kinds], [unserved.id, new Map()]] as const) {
					const read = await getApprovalRequestUseCase(context(w, ADA, { kinds }), id)
					expect(read.described).toBe(false)
					const refused = await status(
						decideApprovalRequestUseCase(context(w, ADA, { kinds }), { id, decision: 'approve', inputDigest: read.inputDigest }),
					)
					expect(refused.status).toBe(409)
					expect(refused.message).toContain('cannot show what the request does')
					expect(await row(w, id)).toMatchObject({ state: 'pending', decided_by_id: null, partial_approver_id: null })
					expect((await decideApprovalRequestUseCase(context(w, ADA, { kinds }), { id, decision: 'reject', inputDigest: read.inputDigest })).state).toBe(
						'rejected',
					)
				}
				expect((await getApprovalRequestUseCase(context(w, ADA), unserved.id)).described).toBe(true)
				expect(w.notes.effects).toEqual([])
				expect(w.audits.map((event) => event.metadata)).toEqual([
					expect.objectContaining({ decision: 'reject' }),
					expect.objectContaining({ decision: 'reject' }),
				])
			})

			test('a policy made stricter after the first approval closes it stale at execution: refuse, or the requester now excluded', async () => {
				const twoPeople = { ...STRICT_SETTINGS, approvers: { ...STRICT_SETTINGS.approvers, secrets: 2 as const } }
				const refused = await world()
				await choose(refused, STRICT_POLICY, twoPeople)
				const first = await ask(refused)
				await decide(refused, first.id, 'approve', ADA)
				await choose(refused, { ...STRICT_POLICY, secrets: 'refuse' }, twoPeople)
				const closed = await decide(refused, first.id, 'approve', BOB)
				expect(closed).toMatchObject({ state: 'stale', decision: { principalId: 'p-bob' } })
				expect(closed.error).toContain('now refuses this to an agent or a key (secrets: refuse)')
				expect(refused.notes.effects).toEqual([])
				await closeWorld()

				const excluded = await world()
				await choose(excluded, STRICT_POLICY, twoPeople)
				const second = await ask(excluded)
				await decide(excluded, second.id, 'approve', ADA)
				await choose(excluded, STRICT_POLICY, { ...twoPeople, requesterMayApprove: { ...STRICT_SETTINGS.requesterMayApprove, secrets: false } })
				const stale = await decide(excluded, second.id, 'approve', BOB)
				expect(stale.state).toBe('stale')
				expect(stale.error).toContain("someone other than the requester's person")
				expect(excluded.notes.effects).toEqual([])
			})
		})

		describe('who decides', () => {
			const others = { ...STRICT_SETTINGS, requesterMayApprove: { ...STRICT_SETTINGS.requesterMayApprove, secrets: false } }
			const requesters: readonly { readonly name: string; readonly who: Who }[] = [
				{ name: 'an OAuth token, its subject', who: AGENT },
				{ name: "a person's own key, that person", who: { credential: 'key', id: 'p-ada', actions: [CONTROL_ACTIONS.SECRET_MANAGE] } },
			]
			for (const { name, who } of requesters) {
				test(`requesterMayApprove: false refuses the person behind ${name}`, async () => {
					const w = await world()
					await choose(w, STRICT_POLICY, others)
					const { id } = await ask(w, who)
					expect((await getApprovalRequestUseCase(context(w, ADA), id)).requesterMayApprove).toBe(false)
					const own = await status(decide(w, id, 'approve', ADA))
					expect(own.status).toBe(403)
					expect(own.message).toContain('asked for on your behalf')
					expect((await row(w, id)).state).toBe('pending')
					expect((await decide(w, id, 'approve', BOB)).state).toBe('executed')
				})
			}

			test("a service key's issuer is unknown, so nobody approves it, and either may refuse it", async () => {
				const w = await world()
				await choose(w, STRICT_POLICY, others)
				const { id } = await ask(w, { credential: 'service', actions: [CONTROL_ACTIONS.SECRET_MANAGE] })
				expect((await getApprovalRequestUseCase(context(w, BOB), id)).requester.personId).toBeNull()
				for (const person of [ADA, BOB]) {
					const refused = await status(decide(w, id, 'approve', person))
					expect(refused.status).toBe(403)
					expect(refused.message).toContain('nobody can approve it')
				}
				expect((await decide(w, id, 'reject', BOB)).state).toBe('rejected')
			})

			test('the default lets the requester approve their own agent', async () => {
				const w = await world()
				const { id } = await ask(w)
				expect((await decide(w, id, 'approve', ADA)).state).toBe('executed')
			})

			test('approvers: 2 — the first approval is partial, the same person again changes nothing, another completes it', async () => {
				const w = await world()
				await choose(w, STRICT_POLICY, { ...STRICT_SETTINGS, approvers: { ...STRICT_SETTINGS.approvers, secrets: 2 } })
				const { id } = await ask(w)
				const first = await decide(w, id, 'approve', ADA)
				expect(first).toMatchObject({ state: 'pending', approvers: 2, partialApproval: { principalId: 'p-ada' } })
				expect(w.audits.at(-1)?.metadata).toMatchObject({ decision: 'approve', partial: true })
				expect(await decide(w, id, 'approve', ADA)).toEqual(first)
				expect(w.notes.effects).toEqual([])
				const second = await decide(w, id, 'approve', BOB)
				expect(second).toMatchObject({ state: 'executed', decision: { principalId: 'p-bob' } })
				expect(second.partialApproval).toBeUndefined()
				expect(await row(w, id)).toMatchObject({ partial_approver_id: 'p-ada', decided_by_id: 'p-bob' })
			})

			test('approvers: 2 — either person may refuse', async () => {
				for (const rejecter of [ADA, BOB]) {
					const w = await world()
					await choose(w, STRICT_POLICY, { ...STRICT_SETTINGS, approvers: { ...STRICT_SETTINGS.approvers, secrets: 2 } })
					const { id } = await ask(w)
					await decide(w, id, 'approve', ADA)
					expect((await decide(w, id, 'reject', rejecter)).state).toBe('rejected')
					expect(w.notes.effects).toEqual([])
					await closeWorld()
				}
			})
		})

		describe('permissions', () => {
			test('a person in the console cannot create a request; they act directly', async () => {
				const w = await world()
				const refused = await status(ask(w, { ...ADA, actions: [CONTROL_ACTIONS.SECRET_MANAGE] }))
				expect(refused.status).toBe(409)
				expect(refused.message).toContain('makes the change directly')
			})

			test("creation without the kind's right to ask at the coordinates is refused as an absent environment", async () => {
				const w = await world()
				expect(await status(ask(w, { ...AGENT, actions: [CONTROL_ACTIONS.DEPLOY_TRIGGER, CONTROL_ACTIONS.ACCESS_REQUEST] }))).toEqual({
					status: 404,
					message: 'app env not found',
				})
				expect((await status(ask(w, AGENT, { appId: 'notes', env: 'nowhere', name: 'a', value: '' }))).status).toBe(404)
				expect((await status(ask(w, AGENT, { appId: 'notes', env: 'prod' }))).status).toBe(400)
			})

			test('an action the environment refuses to a non-person is refused when asked for', async () => {
				const w = await world()
				await choose(w, { ...STRICT_POLICY, secrets: 'refuse' })
				const refused = await status(ask(w))
				expect(refused.status).toBe(403)
				expect(refused.message).toContain('(secrets: refuse)')
				expect(await w.db.approvalRequests.listPending(10)).toEqual([])
			})

			test('a refused kind answers 400 naming it and why; any other kind is not requestable yet', async () => {
				const w = await world()
				for (const kind of ['apps.environments.protect', 'approvals.requests.decide', 'namespaces.remove', 'data.content', 'iam.principals.promote']) {
					const refused = await status(createApprovalRequestUseCase(context(w, AGENT), { kind, input: {} }))
					expect(refused.status).toBe(400)
					expect(refused.message).toStartWith(`kind \`${kind}\` can never be requested: `)
				}
				// The production registry serves no kind in this release.
				const production = await status(createApprovalRequestUseCase(context(w, AGENT, { kinds: null }), { kind: 'test.notes.put', input: {} }))
				expect(production).toEqual({
					status: 400,
					message: 'kind `test.notes.put` is not requestable yet: no change goes through an approval request in this release',
				})
				expect((await status(createApprovalRequestUseCase(context(w, AGENT), { kind: 'apps.secrets.put', input: {} }))).status).toBe(400)
				// A refused kind is refused even where a registry would serve it.
				const served = new Map([['namespaces.remove', notesKind(w.notes)]])
				expect((await status(createApprovalRequestUseCase(context(w, AGENT, { kinds: served }), { kind: 'namespaces.remove', input: {} }))).status)
					.toBe(400)
			})

			test('get is scoped to the requester or to access.approve at the coordinates; list and decide to access.approve', async () => {
				const w = await world()
				const { id } = await ask(w)
				const stranger: Who = { credential: 'console', id: 'p-eve', actions: [CONTROL_ACTIONS.SECRET_MANAGE] }
				expect((await status(getApprovalRequestUseCase(context(w, stranger), id))).status).toBe(404)
				expect((await getApprovalRequestUseCase(context(w, AGENT), id)).id).toBe(id)
				expect((await getApprovalRequestUseCase(context(w, BOB), id)).id).toBe(id)
				expect((await listApprovalRequestsUseCase(context(w, BOB))).items.map((item) => item.id)).toEqual([id])
				expect((await listApprovalRequestsUseCase(context(w, stranger))).items).toEqual([])
				expect((await listApprovalRequestsUseCase(context(w, AGENT))).items).toEqual([])
				expect((await status(decideApprovalRequestUseCase(context(w, stranger), { id, decision: 'approve', inputDigest: 'x' }))).status).toBe(404)
			})

			test('only a person in the console decides: a key or an agent holding access.approve is refused', async () => {
				const w = await world()
				const { id } = await ask(w)
				const digest = (await row(w, id)).input_digest
				for (const credential of ['key', 'oauth', 'service'] as const) {
					const who: Who = { credential, id: 'p-bob', actions: [CONTROL_ACTIONS.ACCESS_APPROVE] }
					expect((await status(decideApprovalRequestUseCase(context(w, who), { id, decision: 'approve', inputDigest: digest }))).status).toBe(403)
				}
				expect((await status(decideApprovalRequestUseCase(context(w, BOB), { id, decision: 'approve', inputDigest: `sha256:${'0'.repeat(64)}` }))).status)
					.toBe(409)
				expect((await row(w, id)).state).toBe('pending')
			})

			test('a request needs a console origin for its link', async () => {
				const w = await world()
				const refused = await status(createApprovalRequestUseCase(context(w, AGENT, { consoleOrigin: null }), {
					kind: 'test.notes.put',
					input: { appId: 'notes', env: 'prod', name: 'a', value: 'b' },
				}))
				expect(refused.status).toBe(503)
			})
		})
	})
}

describe('the refused list (ADR-0083 §9)', () => {
	test('names every always-a-person procedure and the kinds that keep their own rule', () => {
		for (
			const kind of [
				'apps.environments.protect',
				'approvals.complete',
				'approvals.requests.decide',
				'apps.environments.delete',
				'apps.delete',
				'sourceConnection.start',
				'builderPairing.approve',
				'iam.principals.promote',
				'iam.secondFactor.reset',
				'iam.grantRequests.decide',
				'iam.grantApproval.set',
				'namespaces.remove',
				'namespaces.releaseClaims',
				'data.content',
				'iam.workloads.issueKey',
			]
		) expect(REFUSED_KINDS).toContain(kind)
	})
})

describe('the RPC edge', () => {
	const call = async (method: string, input: unknown, bearer: boolean) => {
		const harness = createHarness()
		const request = new Request('https://control.test/api/rpc', {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...(bearer ? { authorization: 'Bearer px_test' } : {}) },
			body: JSON.stringify({ method, input }),
		})
		const ctx: ControlRpcContext = {
			auth: authWithActions([CONTROL_ACTIONS.SECRET_MANAGE, CONTROL_ACTIONS.ACCESS_APPROVE]),
			env: {
				DB: harness.d1,
				REPOSITORIES: harness.repositories,
				ASSETS: { fetch: () => Promise.resolve(new Response('')) },
				RUN_LOGS: { put: () => Promise.resolve(), get: () => Promise.resolve(null), delete: () => Promise.resolve() },
				DEPLOY_QUEUE: { send: () => Promise.resolve() },
				WAIT_UNTIL: () => {},
				ENVIRONMENT: 'local',
				FABRIKA_CONTROL_DOMAIN: 'https://control.test',
			},
			provider: fakeControlProvider,
			sourceConnection: unusedSourceConnection('harbor'),
			request,
		}
		const response = await dispatchRpcRequest({ router: controlRpcRouter, ctx, request })
		const body: unknown = await response.json()
		return { status: response.status, body: JSON.stringify(body) }
	}

	test('a create names a kind and a JSON input, nothing more; this release routes no kind through it', async () => {
		expect((await call('approvals.requests.create', { kind: 'apps.secrets.put', input: {}, extra: 1 }, true)).status).toBe(400)
		expect((await call('approvals.requests.create', { input: {} }, true)).status).toBe(400)
		const notYet = await call('approvals.requests.create', { kind: 'apps.secrets.put', input: { appId: 'notes' } }, true)
		expect(notYet.status).toBe(400)
		expect(notYet.body).toContain('not requestable yet')
		const refused = await call('approvals.requests.create', { kind: 'apps.environments.protect', input: {} }, true)
		expect(refused.status).toBe(400)
		expect(refused.body).toContain('can never be requested')
	})

	test('a decision posts the id, approve or reject, and a sha256 digest', async () => {
		expect((await call('approvals.requests.decide', { id: 'r', decision: 'approve', inputDigest: 'x' }, false)).status).toBe(400)
		expect((await call('approvals.requests.decide', { id: 'r', decision: 'maybe', inputDigest: `sha256:${'0'.repeat(64)}` }, false)).status).toBe(400)
		const valid = { id: 'r', decision: 'approve', inputDigest: `sha256:${'0'.repeat(64)}` }
		expect((await call('approvals.requests.decide', valid, true)).status).toBe(403)
		expect((await call('approvals.requests.decide', valid, false)).status).toBe(404)
		expect((await call('approvals.requests.get', { id: 'r' }, true)).status).toBe(404)
		expect((await call('approvals.requests.list', undefined, true)).body).toBe('{"result":{"items":[]}}')
	})
})
