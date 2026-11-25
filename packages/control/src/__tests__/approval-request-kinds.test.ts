// ADR-0083 §8: Control's local registry writes as approval request kinds, through the production registry, against
// SQLite always and Postgres when FABRIKA_TEST_POSTGRES_URL is set. Each kind is asked for, approved and executed with
// its effect visible, closed stale when what it binds changed, and refused at creation where the requester lacks the
// right or the write would reach outside Control. A secret value is sealed under the request's own purpose: it never
// reaches the row, the page, a log or the audit, and it is deleted once the request is closed.

import type { AuthContext } from '@fabrika/auth'
import { type DomainEvent, permits, type Scope, sha256Hex } from '@fabrika/auth-core'
import {
	ALL_ENVIRONMENTS,
	type ApprovalPolicy,
	type ApprovalSettings,
	CONTROL_ACTIONS,
	STRICT_POLICY,
	STRICT_SETTINGS,
} from '@fabrika/control-contract'
import { type DeployLocks, SqlDeployLocks, uuidv7 } from '@fabrika/platform'
import type { ControlProvider, JsonValue } from '@fabrika/provider-contract'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { ControlApiError } from '../api/domain'
import { putAppSecretUseCase } from '../api/vault'
import { storedPolicy, storedSettings } from '../approval/categories'
import {
	type ApprovalRequestContext,
	challengeApprovalRequestUseCase,
	createApprovalRequestUseCase,
	decideApprovalRequestUseCase,
	getApprovalRequestUseCase,
	listApprovalRequestsUseCase,
} from '../approval/requests/api'
import { sweepApprovalRequests } from '../approval/requests/execute'
import { requestSecretPurpose } from '../approval/requests/kinds/secrets'
import { iamPasskeyStepUp, requestStepUpBinding } from '../approval/step-up'
import { type ControlRepositories, createControlRepositories } from '../db'
import { appScope, envScope } from '../iam'
import { LEASE_TTL_MS, runLeaseKey } from '../lease'
import { appSecretPurpose } from '../secret-resolver'
import { Vault } from '../vault'
import { createHarness, harnessDatabase } from './helpers/harness'
import { fixtureProtect } from './helpers/lock'
import { answerChallenge, consoleTokenHeaders, type FakePasskeyIam, fakePasskeyIam } from './helpers/passkeys'
import { createPostgres, hasPostgres, skipReason } from './helpers/postgres'
import { fakeControlProvider } from './helpers/provider'
import { testVaultKey } from './helpers/vault'

if (!hasPostgres) console.warn(`approval-request-kinds.test.ts Postgres half ${skipReason}`)

const ORIGIN = 'https://console.example.test'
const ENVELOPE = JSON.stringify({ provider: 'harbor', version: 1, payload: {} })
const T0 = 1_800_000_000
const HOUR = 3600
const SECRET = 'sk_live_very-secret-value-1234567890'
const OTHER = 'a-different-secret-value-0987654321'

interface Backend {
	readonly name: string
	readonly skip: boolean
	open(now: () => number): Promise<{ repositories: ControlRepositories; locks: DeployLocks; vault: Vault; close(): Promise<void> }>
}

const backends: readonly Backend[] = [
	{
		name: 'sqlite',
		skip: false,
		open: async (now) => {
			const harness = createHarness(now)
			const db = harnessDatabase(harness.repositories)
			return {
				repositories: harness.repositories,
				locks: new SqlDeployLocks(db),
				vault: await Vault.create(db, testVaultKey()),
				close: () => {
					harness.sqlite.close()
					return Promise.resolve()
				},
			}
		},
	},
	{
		name: 'postgres',
		skip: !hasPostgres,
		open: async (now) => {
			const fixture = await createPostgres('control_request_kinds')
			return {
				repositories: createControlRepositories(fixture.db, { now }),
				locks: new SqlDeployLocks(fixture.db),
				vault: await Vault.create(fixture.db, testVaultKey()),
				close: () => fixture.close(),
			}
		},
	},
]

interface Who {
	readonly console: boolean
	readonly id: string
	readonly label: string
	readonly actions: readonly string[]
	/** Where the actions hold; everywhere when absent. */
	readonly scope?: Scope
}

const APPROVER_ACTIONS = [
	CONTROL_ACTIONS.ACCESS_APPROVE,
	CONTROL_ACTIONS.SECRET_MANAGE,
	CONTROL_ACTIONS.APP_MANAGE,
	CONTROL_ACTIONS.DATA_MANAGE,
]
const BOB: Who = { console: true, id: 'p-bob', label: 'bob@example.test', actions: APPROVER_ACTIONS }
const AGENT: Who = {
	console: false,
	id: 'p-ada',
	label: 'ada@example.test',
	actions: [CONTROL_ACTIONS.SECRET_MANAGE, CONTROL_ACTIONS.APP_MANAGE, CONTROL_ACTIONS.DATA_MANAGE],
}

for (const backend of backends) {
	describe.skipIf(backend.skip)(`local registry writes as approval requests (${backend.name})`, () => {
		let closing: (() => Promise<void>) | null = null
		afterEach(async () => {
			const close = closing
			closing = null
			await close?.()
		})

		interface World {
			readonly db: ControlRepositories
			readonly locks: DeployLocks
			readonly vault: Vault
			readonly audits: DomainEvent[]
			/** IAM's passkey step-up behind Control's transport; bob holds a passkey. */
			readonly iam: FakePasskeyIam
			provider: ControlProvider
			now: number
		}

		async function world(): Promise<World> {
			const clock = { now: T0 }
			const opened = await backend.open(() => clock.now)
			closing = opened.close
			const w: World = {
				db: opened.repositories,
				locks: opened.locks,
				vault: opened.vault,
				audits: [],
				iam: fakePasskeyIam([BOB.id]),
				provider: fakeControlProvider,
				get now() {
					return clock.now
				},
				set now(value) {
					clock.now = value
				},
			}
			await w.db.registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes', defaultBranch: 'main' })
			for (const env of ['prod', 'stage']) {
				await w.db.registry.upsertAppEnv({
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
			const grants = who.actions.map((action) => ({ action, scope: who.scope ?? null, source: 'grant' as const }))
			return {
				ok: true,
				principal: { id: who.id, type: 'user', label: who.label },
				...(who.console ? {} : {
					oauth: { app: 'vozka', clientId: 'https://agent.example.test/client.json', scopes: ['operate'], grantId: 'grant-1', tokenId: 't' },
				}),
				can: (action, scope) => permits(grants, action, scope),
				scopedTo: () => null,
				audit: (event) => {
					w.audits.push(event)
					return Promise.resolve()
				},
			}
		}

		function context(w: World, who: Who): ApprovalRequestContext {
			const headers: Record<string, string> = { 'Sec-Fetch-Site': 'same-origin' }
			if (who.console) Object.assign(headers, consoleTokenHeaders(who.id))
			else headers.Authorization = 'Bearer px_test'
			const request = new Request(`${ORIGIN}/api/rpc`, { method: 'POST', headers })
			const stepUp = iamPasskeyStepUp(w.iam.gateway, request)
			return {
				repositories: w.db,
				provider: w.provider,
				vault: () => Promise.resolve(w.vault),
				auth: auth(w, who),
				admission: { request },
				lock: w.locks,
				...(stepUp === null ? {} : { stepUp }),
				consoleOrigin: ORIGIN,
				now: () => w.now,
			}
		}

		const ask = (w: World, kind: string, input: JsonValue, who: Who = AGENT) => createApprovalRequestUseCase(context(w, who), { kind, input })

		async function decide(w: World, id: string, decision: 'approve' | 'reject', who: Who = BOB) {
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

		async function protect(w: World, env: string, policy: ApprovalPolicy = STRICT_POLICY, settings: ApprovalSettings = STRICT_SETTINGS) {
			await fixtureProtect(w.db.registry, w.locks, { appId: 'notes', env }, true, Date.now, storedPolicy(policy), storedSettings(settings))
		}

		/** The value an app secret holds now, read under its own purpose. */
		async function secretValue(w: World, env: string | null, name: string): Promise<string | null> {
			const found = (await w.db.registry.listAppSecrets('notes')).find((secret) => secret.env === env && secret.name === name)
			return found === undefined ? null : w.vault.getSecretForPurpose(found.value_ref, appSecretPurpose('notes', env, name))
		}

		/** Whether the request's sealed copy is still in the vault. */
		async function sealedExists(w: World, id: string): Promise<boolean> {
			const sealed: unknown = JSON.parse((await row(w, id)).input_json)
			const ref = typeof sealed === 'object' && sealed !== null ? Reflect.get(Reflect.get(sealed, 'sealed'), 'ref') : null
			if (typeof ref !== 'string') throw new Error('the request holds no sealed reference')
			return (await w.vault.sealedVersion(ref, requestSecretPurpose(id))) !== null
		}

		/** Write a secret directly, as a person would. */
		async function setDirectly(w: World, env: string | null, name: string, value: string): Promise<void> {
			await putAppSecretUseCase(
				{ repositories: w.db, provider: w.provider, vault: () => Promise.resolve(w.vault), auth: auth(w, BOB) },
				'notes',
				{ name, value, env },
			)
		}

		const putSecret = (env: string | null, value = SECRET) => ({ appId: 'notes', secret: { name: 'API_KEY', value, env } })

		describe('secrets', () => {
			test('a value is sealed under the request, answered by its fingerprint, and moved to the secret on approval', async () => {
				const w = await world()
				const logged: string[] = []
				const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
					spyOn(console, level).mockImplementation((...args: unknown[]) => {
						logged.push(args.map(String).join(' '))
					})
				)
				try {
					const created = await ask(w, 'apps.secrets.put', putSecret('prod'))
					const fingerprint = sha256Hex(SECRET).slice(0, 8)
					expect(created).toEqual({ id: created.id, url: `${ORIGIN}/approvals/requests/${created.id}`, state: 'pending', fingerprint })
					const stored = await row(w, created.id)
					expect(stored.input_json).not.toContain(SECRET)
					expect(JSON.parse(stored.input_json)).toEqual({
						appId: 'notes',
						env: 'prod',
						name: 'API_KEY',
						sealed: { ref: expect.stringMatching(/^vault:/), length: SECRET.length, fingerprint },
					})
					expect(await sealedExists(w, created.id)).toBe(true)

					const page = await getApprovalRequestUseCase(context(w, BOB), created.id)
					expect(JSON.stringify(page)).not.toContain(SECRET)
					expect(page.description.summary.map((part) => part.text).join('')).toBe(
						`Set secret API_KEY of notes@prod, ${SECRET.length} characters, fingerprint ${fingerprint}`,
					)
					expect(page.description.summary[1]).toEqual({ text: 'API_KEY', agent: true })

					const decided = await decide(w, created.id, 'approve')
					expect(decided).toMatchObject({ state: 'executed', result: { name: 'API_KEY', env: 'prod', fingerprint } })
					expect(await secretValue(w, 'prod', 'API_KEY')).toBe(SECRET)
					expect(await sealedExists(w, created.id)).toBe(false)
					expect(w.audits.map((event) => event.action)).toEqual(['access.approve', 'app.secret.upsert', 'apps.secrets.put'])
				} finally {
					for (const spy of spies) spy.mockRestore()
				}
				expect(JSON.stringify(w.audits)).not.toContain(SECRET)
				expect(logged.join('\n')).not.toContain(SECRET)
			})

			test('a secret written since the request closes it stale, and the sealed copy goes', async () => {
				const w = await world()
				const { id } = await ask(w, 'vault.set', { appId: 'notes', name: 'API_KEY', env: 'prod', value: SECRET })
				await setDirectly(w, 'prod', 'API_KEY', OTHER)
				const decided = await decide(w, id, 'approve')
				expect(decided.state).toBe('stale')
				expect(await secretValue(w, 'prod', 'API_KEY')).toBe(OTHER)
				expect(await sealedExists(w, id)).toBe(false)
			})

			test('a refusal and an expiry delete the sealed value', async () => {
				const w = await world()
				const refused = await ask(w, 'apps.secrets.put', putSecret('prod'))
				const expiring = await ask(w, 'apps.secrets.put', putSecret('stage'))
				await decide(w, refused.id, 'reject')
				expect(await sealedExists(w, refused.id)).toBe(false)
				expect(await sealedExists(w, expiring.id)).toBe(true)
				w.now += 24 * HOUR
				const swept = await sweepApprovalRequests({ repositories: w.db, lock: w.locks, vault: () => Promise.resolve(w.vault) })
				expect(swept.expired).toBe(2 - 1)
				expect(await sealedExists(w, expiring.id)).toBe(false)
				expect(await secretValue(w, 'stage', 'API_KEY')).toBeNull()
			})

			test('the sweep deletes a sealed copy left behind once it is older than the longest wait, unless its request may still need it', async () => {
				const w = await world()
				// Sealed, and the row never written: Control stopped between the two.
				const neverWritten = requestSecretPurpose(uuidv7())
				const orphan = await w.vault.putSecret(neverWritten.scope, neverWritten.label, SECRET)
				// Refused, and the discard never ran: Control stopped after the refusal, or a release without kinds refused it.
				const refused = await ask(w, 'apps.secrets.put', putSecret('prod'))
				expect(await w.db.approvalRequests.reject(refused.id, { decisionId: uuidv7(), id: 'p-bob', label: 'bob' })).toBe(true)
				// Its outcome unknown: the kind's follow compares against the copy.
				const unknown = await ask(w, 'apps.secrets.put', putSecret('stage'))
				const holder = uuidv7()
				expect(await w.locks.acquire(runLeaseKey('notes', 'stage'), holder, LEASE_TTL_MS)).toBe(true)
				const fence = { holder, nowMs: Date.now() }
				expect(await w.db.approvalRequests.approve(unknown.id, { decisionId: uuidv7(), id: 'p-bob', label: 'bob' }, null, fence)).toBe(true)
				expect(await w.db.approvalRequests.startExecution(unknown.id, 'op-stage', fence)).toBe(true)
				expect(await w.db.approvalRequests.markUnknown(unknown.id, 'op-stage', 'lost', fence)).toBe(true)
				// Kept held, so the sweep leaves the unknown request to the next pass rather than settling it.
				const waiting = await ask(w, 'apps.secrets.put', putSecret(null))

				const sweep = (now: number) => sweepApprovalRequests({ repositories: w.db, lock: w.locks, vault: () => Promise.resolve(w.vault), now: () => now })
				const sealedNow = Math.floor(Date.now() / 1000)
				expect((await sweep(sealedNow + 168 * HOUR)).orphans).toBe(0)
				expect(await w.vault.sealedVersion(orphan, neverWritten)).not.toBeNull()
				expect(await sealedExists(w, refused.id)).toBe(true)

				expect((await sweep(sealedNow + 170 * HOUR)).orphans).toBe(2)
				expect(await w.vault.sealedVersion(orphan, neverWritten)).toBeNull()
				expect(await sealedExists(w, refused.id)).toBe(false)
				expect(await sealedExists(w, unknown.id)).toBe(true)
				expect(await sealedExists(w, waiting.id)).toBe(true)
				expect((await row(w, unknown.id)).state).toBe('unknown')
				await w.locks.release(runLeaseKey('notes', 'stage'), holder)
			})

			test('a rotation replaces the value of a secret that exists; one that does not is refused at creation', async () => {
				const w = await world()
				expect((await status(ask(w, 'vault.rotate', { appId: 'notes', name: 'API_KEY', env: 'prod', value: SECRET }))).status).toBe(404)
				await setDirectly(w, 'prod', 'API_KEY', OTHER)
				const { id } = await ask(w, 'vault.rotate', { appId: 'notes', name: 'API_KEY', env: 'prod', value: SECRET })
				expect((await decide(w, id, 'approve')).state).toBe('executed')
				expect(await secretValue(w, 'prod', 'API_KEY')).toBe(SECRET)
			})

			test('a delete removes the secret; a rotation since closes it stale', async () => {
				const w = await world()
				await setDirectly(w, 'prod', 'API_KEY', OTHER)
				const removed = await ask(w, 'apps.secrets.delete', { appId: 'notes', name: 'API_KEY', env: 'prod' })
				expect((await decide(w, removed.id, 'approve')).state).toBe('executed')
				expect(await secretValue(w, 'prod', 'API_KEY')).toBeNull()

				await setDirectly(w, 'prod', 'API_KEY', OTHER)
				const stale = await ask(w, 'vault.delete', { appId: 'notes', name: 'API_KEY', env: 'prod' })
				const ref = (await w.db.registry.listAppSecrets('notes')).find((secret) => secret.name === 'API_KEY')?.value_ref ?? ''
				// The ref stays; only the version of the value it holds tells the rotation apart.
				await w.vault.rotate(ref, SECRET)
				expect((await decide(w, stale.id, 'approve')).state).toBe('stale')
				expect(await secretValue(w, 'prod', 'API_KEY')).toBe(SECRET)
			})

			test('a secret the provider keeps reaches outside Control, so it is not requestable yet', async () => {
				const w = await world()
				w.provider = { ...fakeControlProvider, secrets: { put: () => Promise.resolve({ valueRef: 'provider' }), delete: () => Promise.resolve() } }
				const refused = await status(ask(w, 'apps.secrets.put', putSecret('prod')))
				expect(refused.status).toBe(400)
				expect(refused.message).toContain('not requestable yet')
				expect((await w.db.approvalRequests.listPending(10)).length).toBe(0)
			})

			test('a rotated token key is asked of the next deploy', async () => {
				const w = await world()
				await w.db.tokenKeys.insert({
					app_id: 'notes',
					env: 'prod',
					key_id: 'k1',
					value_ref: 'vault:k1',
					created_at: T0,
					retired_at: null,
					max_days: 1,
					rotation_requested_at: null,
				})
				const { id } = await ask(w, 'apps.environments.rotateTokenKey', { appId: 'notes', env: 'prod' })
				expect(await decide(w, id, 'approve')).toMatchObject({ state: 'executed', result: { requested: true } })
				expect((await w.db.tokenKeys.list('notes', 'prod'))[0]?.rotation_requested_at).toEqual(expect.any(Number))
			})

			test('an execution that did not report is settled by what the secret holds, and the sealed copy goes then', async () => {
				const w = await world()
				const landed = await ask(w, 'apps.secrets.put', putSecret('prod'))
				const lost = await ask(w, 'apps.secrets.put', putSecret('stage'))
				const holder = uuidv7()
				for (const env of ['prod', 'stage']) {
					expect(await w.locks.acquire(runLeaseKey('notes', env), holder, LEASE_TTL_MS)).toBe(true)
					const fence = { holder, nowMs: Date.now() }
					const id = env === 'prod' ? landed.id : lost.id
					expect(await w.db.approvalRequests.approve(id, { decisionId: uuidv7(), id: 'p-bob', label: 'bob' }, null, fence)).toBe(true)
					expect(await w.db.approvalRequests.startExecution(id, `op-${env}`, fence)).toBe(true)
					await w.locks.release(runLeaseKey('notes', env), holder)
				}
				// The write landed in prod before the execution stopped; in stage it never did.
				await setDirectly(w, 'prod', 'API_KEY', SECRET)
				const swept = await sweepApprovalRequests({ repositories: w.db, lock: w.locks, vault: () => Promise.resolve(w.vault) })
				expect(swept.settled).toBe(2)
				expect(await row(w, landed.id)).toMatchObject({ state: 'executed', operation_id: 'op-prod' })
				expect(await row(w, lost.id)).toMatchObject({ state: 'failed', operation_id: 'op-stage' })
				expect(await sealedExists(w, landed.id)).toBe(false)
				expect(await sealedExists(w, lost.id)).toBe(false)
			})
		})

		describe('the all-environments layer', () => {
			test('reaches every environment: the strictest protected one decides, and the page names them all', async () => {
				const w = await world()
				await protect(w, 'stage', STRICT_POLICY, {
					...STRICT_SETTINGS,
					requestTtlHours: 2,
					approvers: { ...STRICT_SETTINGS.approvers, secrets: 2 },
				})
				const created = await ask(w, 'apps.secrets.put', putSecret(null))
				const stored = await row(w, created.id)
				expect(stored).toMatchObject({ app_id: 'notes', env: ALL_ENVIRONMENTS, deadline: T0 + 2 * HOUR })
				const page = await getApprovalRequestUseCase(context(w, BOB), created.id)
				expect(page).toMatchObject({ env: ALL_ENVIRONMENTS, approvers: 2 })
				expect(page.description.summary.map((part) => part.text).join('')).toContain('of every environment of notes')
				expect(page.description.facts.at(-1)).toEqual({
					label: 'Environments',
					value: { text: 'every environment of notes: prod, stage; protected: prod, stage', agent: false },
				})

				// The approver holds access.approve at every protected environment it reaches, not one of them.
				const prodOnly: Who = { ...BOB, id: 'p-cy', scope: envScope('prod') }
				expect((await status(getApprovalRequestUseCase(context(w, prodOnly), created.id))).status).toBe(404)
				expect((await decide(w, created.id, 'approve')).state).toBe('pending')
				expect((await decide(w, created.id, 'approve', { ...BOB, id: 'p-dan' })).state).toBe('executed')
				expect(await secretValue(w, null, 'API_KEY')).toBe(SECRET)
			})

			test('an environment that refuses the category refuses the layer, and a new environment closes it stale', async () => {
				const w = await world()
				await protect(w, 'stage', { ...STRICT_POLICY, variables: 'refuse' })
				const variable = { appId: 'notes', variable: { name: 'GREETING', value: 'hello', env: null } }
				const refused = await status(ask(w, 'apps.variables.put', variable))
				expect(refused).toEqual({ status: 403, message: expect.stringContaining('environment `stage` refuses this') })

				const { id } = await ask(w, 'apps.secrets.put', putSecret(null))
				await w.db.registry.upsertAppEnv({
					appId: 'notes',
					env: 'qa',
					namespaceId: null,
					provider: 'harbor',
					providerTargetJson: ENVELOPE,
					providerArtifactJson: ENVELOPE,
				})
				expect((await decide(w, id, 'approve')).state).toBe('stale')
			})

			test('a passkey on deciding where any protected environment it reaches asks for one', async () => {
				const w = await world()
				await protect(w, 'prod')
				await protect(w, 'stage', STRICT_POLICY, { ...STRICT_SETTINGS, stepUp: { ...STRICT_SETTINGS.stepUp, secrets: 'webauthn' } })
				const layer = await ask(w, 'apps.secrets.put', putSecret(null))
				const single = await ask(w, 'apps.secrets.put', putSecret('prod'))
				expect((await getApprovalRequestUseCase(context(w, BOB), single.id)).stepUp).toBe('none')
				const { inputDigest, stepUp } = await getApprovalRequestUseCase(context(w, BOB), layer.id)
				expect(stepUp).toBe('webauthn')

				for (const decision of ['approve', 'reject'] as const) {
					expect(await status(decide(w, layer.id, decision))).toEqual({
						status: 403,
						message: 'this decision takes a passkey: confirm it with one of your passkeys',
					})
				}
				expect(await row(w, layer.id)).toMatchObject({ state: 'pending', decided_by_id: null })

				const issued = await challengeApprovalRequestUseCase(context(w, BOB), { id: layer.id, decision: 'approve', inputDigest })
				expect(issued.kind).toBe('challenge')
				expect(w.iam.bindings).toEqual([requestStepUpBinding(layer.id, 'approve', inputDigest)])
				const assertion = answerChallenge(issued, BOB.id)
				expect(await decideApprovalRequestUseCase(context(w, BOB), { id: layer.id, decision: 'approve', inputDigest, stepUp: assertion })).toMatchObject({
					state: 'executed',
				})
				expect(await row(w, layer.id)).toMatchObject({ decided_by_id: BOB.id, decided_step_up_credential_id: `cred-${BOB.id}` })
				expect(await secretValue(w, null, 'API_KEY')).toBe(SECRET)
			})

			test('a deploy of an environment it reaches holds the layer off: the decision answers 409, the sweep waits, nothing is recorded', async () => {
				const w = await world()
				const { id } = await ask(w, 'apps.secrets.put', putSecret(null))
				const deploy = uuidv7()
				expect(await w.locks.acquire(runLeaseKey('notes', 'prod'), deploy, LEASE_TTL_MS)).toBe(true)
				expect((await status(decide(w, id, 'approve'))).status).toBe(409)
				expect(await row(w, id)).toMatchObject({ state: 'pending', decided_by_id: null, operation_id: null })
				expect(await secretValue(w, null, 'API_KEY')).toBeNull()

				// Approved, and stopped before its execution started: the sweep closes it only once it holds every lease.
				const fence = uuidv7()
				expect(await w.locks.acquire(runLeaseKey('notes', ALL_ENVIRONMENTS), fence, LEASE_TTL_MS)).toBe(true)
				expect(await w.db.approvalRequests.approve(id, { decisionId: uuidv7(), id: 'p-bob', label: 'bob' }, null, { holder: fence, nowMs: Date.now() }))
					.toBe(true)
				await w.locks.release(runLeaseKey('notes', ALL_ENVIRONMENTS), fence)
				const sweep = () => sweepApprovalRequests({ repositories: w.db, lock: w.locks, vault: () => Promise.resolve(w.vault) })
				expect((await sweep()).interrupted).toBe(0)
				expect((await row(w, id)).state).toBe('approved')
				// What the layer took before it met the busy lease, it released.
				for (const env of [ALL_ENVIRONMENTS, 'stage']) {
					const probe = uuidv7()
					expect(await w.locks.acquire(runLeaseKey('notes', env), probe, LEASE_TTL_MS)).toBe(true)
					await w.locks.release(runLeaseKey('notes', env), probe)
				}
				await w.locks.release(runLeaseKey('notes', 'prod'), deploy)
				expect((await sweep()).interrupted).toBe(1)
				expect((await row(w, id)).state).toBe('failed')
			})

			test('`*` is the layer, never an environment name', async () => {
				const w = await world()
				const refused = await status(ask(w, 'apps.secrets.put', putSecret(ALL_ENVIRONMENTS)))
				expect(refused.status).toBe(400)
				expect(refused.message).toContain('env: null')
			})
		})

		describe('variables', () => {
			test('set and deleted on approval; a value changed since closes it stale', async () => {
				const w = await world()
				const put = await ask(w, 'apps.variables.put', { appId: 'notes', variable: { name: 'GREETING', value: 'hello', env: 'prod' } })
				const page = await getApprovalRequestUseCase(context(w, BOB), put.id)
				expect(page.description.facts).toContainEqual({ label: 'Before → after', value: { text: 'none → hello', agent: true } })
				expect((await decide(w, put.id, 'approve')).state).toBe('executed')
				expect((await w.db.registry.listAppVars('notes')).map((item) => [item.env, item.name, item.value])).toEqual([['prod', 'GREETING', 'hello']])

				const removed = await ask(w, 'apps.variables.delete', { appId: 'notes', name: 'GREETING', env: 'prod' })
				await w.db.registry.upsertAppVar({ appId: 'notes', env: 'prod', name: 'GREETING', value: 'changed' })
				expect((await decide(w, removed.id, 'approve')).state).toBe('stale')
				const again = await ask(w, 'apps.variables.delete', { appId: 'notes', name: 'GREETING', env: 'prod' })
				expect((await decide(w, again.id, 'approve')).state).toBe('executed')
				expect(await w.db.registry.listAppVars('notes')).toEqual([])
			})

			test('a value the use case would refuse is refused when it is asked for', async () => {
				const w = await world()
				const refused = await status(ask(w, 'apps.variables.put', { appId: 'notes', variable: { name: 'API_TOKEN', value: SECRET, env: 'prod' } }))
				expect(refused.status).toBe(400)
				expect(refused.message).toContain('looks like a credential')
			})
		})

		describe('registry', () => {
			test("an environment's trigger ref and domain, shown before → after; the target is not requestable", async () => {
				const w = await world()
				const { id } = await ask(w, 'apps.environments.put', {
					appId: 'notes',
					env: 'prod',
					environment: { triggerRef: 'release', domain: 'notes.example.com' },
				})
				const page = await getApprovalRequestUseCase(context(w, BOB), id)
				expect(page.description.facts).toEqual([
					{ label: 'Trigger ref', value: { text: 'none → refs/heads/release', agent: true } },
					{ label: 'Domain', value: { text: 'none → notes.example.com', agent: true } },
				])
				expect((await decide(w, id, 'approve')).state).toBe('executed')
				expect(await w.db.registry.getAppEnv('notes', 'prod')).toMatchObject({
					trigger_ref: 'refs/heads/release',
					domain: 'notes.example.com',
					provider_target_json: ENVELOPE,
				})

				const target = await status(ask(w, 'apps.environments.put', {
					appId: 'notes',
					env: 'prod',
					environment: { triggerRef: 'main', target: { provider: 'harbor', version: 1, payload: {} } },
				}))
				expect(target.status).toBe(400)
				expect(target.message).toContain('does not take')
			})

			test("the put's own checks of a trigger ref and a dev environment refuse it when it is asked for", async () => {
				const w = await world()
				const held = await ask(w, 'apps.environments.put', { appId: 'notes', env: 'stage', environment: { triggerRef: 'main' } })
				expect((await decide(w, held.id, 'approve')).state).toBe('executed')
				const taken = await status(ask(w, 'apps.environments.put', { appId: 'notes', env: 'prod', environment: { triggerRef: 'refs/heads/main' } }))
				expect(taken).toEqual({ status: 409, message: expect.stringContaining('stage') })

				await w.db.registry.upsertAppEnv({
					appId: 'notes',
					env: 'dev',
					kind: 'dev',
					namespaceId: null,
					provider: 'harbor',
					providerTargetJson: ENVELOPE,
					providerArtifactJson: ENVELOPE,
				})
				const dev = await status(ask(w, 'apps.environments.put', { appId: 'notes', env: 'dev', environment: { domain: 'dev.example.com' } }))
				expect(dev).toEqual({ status: 409, message: expect.stringContaining('runs no dev environment') })
				expect((await w.db.approvalRequests.listPending(10)).length).toBe(0)
			})

			test('a changed environment closes it stale; a provider that prepares registrations cannot take it yet', async () => {
				const w = await world()
				const { id } = await ask(w, 'apps.environments.put', { appId: 'notes', env: 'prod', environment: { crossOrigins: ['https://app.example.com'] } })
				await protect(w, 'prod')
				expect((await decide(w, id, 'approve')).state).toBe('stale')

				w.provider = {
					...fakeControlProvider,
					namespaces: {
						normalize: (namespace) => namespace,
						namespaceResourceClaims: () => [],
						registrationResourceClaims: () => [],
						prepareRegistration: (input) => Promise.resolve(input.registration),
						provision: (input) => Promise.resolve(input.namespace),
						reconcile: (input) => Promise.resolve(input.namespace),
					},
				}
				const refused = await status(ask(w, 'apps.environments.put', { appId: 'notes', env: 'prod', environment: { triggerRef: 'main' } }))
				expect(refused.status).toBe(400)
				expect(refused.message).toContain('not requestable yet')
			})

			test('an application patch shows each field before → after and goes stale when a before-value changed', async () => {
				const w = await world()
				const { id } = await ask(w, 'apps.update', { appId: 'notes', app: { buildCmd: 'bun run build', defaultBranch: 'trunk' } })
				expect(await row(w, id)).toMatchObject({ env: ALL_ENVIRONMENTS, category: 'registry' })
				const page = await getApprovalRequestUseCase(context(w, BOB), id)
				expect(page.description.facts.slice(0, 2)).toEqual([
					{ label: 'Default branch', value: { text: 'main → trunk', agent: true } },
					{ label: 'Build command', value: { text: 'none → bun run build', agent: true } },
				])
				expect((await decide(w, id, 'approve')).state).toBe('executed')
				expect(await w.db.registry.getApp('notes')).toMatchObject({ build_cmd: 'bun run build', default_branch: 'trunk' })

				const stale = await ask(w, 'apps.update', { appId: 'notes', app: { buildCmd: 'bun run build:prod' } })
				await w.db.registry.updateApp('notes', { buildCmd: 'make' })
				expect((await decide(w, stale.id, 'approve')).state).toBe('stale')
				expect((await w.db.registry.getApp('notes'))?.build_cmd).toBe('make')

				expect((await status(ask(w, 'apps.update', { appId: 'notes', app: { repoUrl: 'github.com/evil/notes' } }))).status).toBe(400)
			})
		})

		describe('data', () => {
			test("an environment's daily backups switched off on approval", async () => {
				const w = await world()
				const { id } = await ask(w, 'data.backups.setSchedule', { appId: 'notes', env: 'prod', daily: false })
				expect((await getApprovalRequestUseCase(context(w, BOB), id)).description.facts[0]).toEqual({
					label: 'Now',
					value: { text: 'daily backups on', agent: false },
				})
				expect(await decide(w, id, 'approve')).toMatchObject({ state: 'executed', result: { daily: false } })
				expect((await w.db.backups.getSchedule('notes', 'prod'))?.daily).toBe(0)
			})

			test('suspension reaches the environment itself, so it is not requestable yet', async () => {
				const w = await world()
				const refused = await status(ask(w, 'apps.environments.suspend', { appId: 'notes', env: 'prod' }))
				expect(refused).toEqual({ status: 400, message: expect.stringContaining('not requestable yet') })
			})
		})

		describe('rights', () => {
			test("the requester's right is the route's, checked when the request is created", async () => {
				const w = await world()
				const without: Who = { ...AGENT, actions: [CONTROL_ACTIONS.APP_MANAGE] }
				expect((await status(ask(w, 'apps.secrets.put', putSecret('prod'), without))).status).toBe(404)
				// The secret route takes `secret.manage` at the application; one held at an environment does not ask for it.
				const atEnv: Who = { ...AGENT, scope: envScope('prod') }
				expect((await status(ask(w, 'apps.secrets.put', putSecret('prod'), atEnv))).status).toBe(404)
				// The backup schedule takes `data.manage` at the environment, as its route does.
				expect((await ask(w, 'data.backups.setSchedule', { appId: 'notes', env: 'prod', daily: true }, atEnv)).state).toBe('pending')
				const atApp: Who = { ...AGENT, scope: appScope('notes') }
				expect((await ask(w, 'apps.secrets.put', putSecret(null), atApp)).state).toBe('pending')
				expect(await w.vault.sealedVersion('vault:00000000-0000-7000-8000-000000000000', requestSecretPurpose('x'))).toBeNull()
			})

			test("a reader without the kind's action sees a name and a length, never a fingerprint or a value", async () => {
				const w = await world()
				const fingerprint = sha256Hex(SECRET).slice(0, 8)
				const secret = await ask(w, 'apps.secrets.put', putSecret('prod'))
				await w.db.registry.upsertAppVar({ appId: 'notes', env: 'prod', name: 'GREETING', value: 'current-greeting' })
				const variable = await ask(w, 'apps.variables.put', { appId: 'notes', variable: { name: 'GREETING', value: 'next-greeting', env: 'prod' } })
				const approveOnly: Who = { ...BOB, id: 'p-cy', actions: [CONTROL_ACTIONS.ACCESS_APPROVE] }
				const hidden = { label: 'Not shown', value: { text: expect.stringContaining('`secret.manage`'), agent: false } }

				const page = await getApprovalRequestUseCase(context(w, approveOnly), secret.id)
				expect(JSON.stringify(page)).not.toContain(fingerprint)
				expect(page.description.summary.map((part) => part.text).join('')).toBe(`Set secret API_KEY of notes@prod, ${SECRET.length} characters`)
				expect(page.description.facts).toContainEqual(hidden)
				const variablePage = await getApprovalRequestUseCase(context(w, approveOnly), variable.id)
				expect(JSON.stringify(variablePage)).not.toContain('greeting')
				expect(variablePage.description.facts).toContainEqual({ label: 'New value', value: { text: '13 characters', agent: false } })
				const listed = JSON.stringify(await listApprovalRequestsUseCase(context(w, approveOnly)))
				expect(listed).not.toContain(fingerprint)
				expect(listed).not.toContain('greeting')

				// One who holds the action sees them; one who does not may still refuse.
				expect(JSON.stringify(await getApprovalRequestUseCase(context(w, BOB), secret.id))).toContain(fingerprint)
				expect(JSON.stringify(await getApprovalRequestUseCase(context(w, BOB), variable.id))).toContain('current-greeting')
				expect((await decide(w, secret.id, 'reject', approveOnly)).state).toBe('rejected')
				expect((await decide(w, variable.id, 'approve')).state).toBe('executed')
				expect(JSON.stringify(await getApprovalRequestUseCase(context(w, approveOnly), variable.id))).not.toContain('greeting')
			})

			test('an approver who does not hold the action cannot approve, since the change executes as them', async () => {
				const w = await world()
				const { id } = await ask(w, 'apps.secrets.put', putSecret('prod'))
				const approveOnly: Who = { ...BOB, actions: [CONTROL_ACTIONS.ACCESS_APPROVE] }
				const refused = await status(decide(w, id, 'approve', approveOnly))
				expect(refused.status).toBe(403)
				expect(refused.message).toContain('secret.manage')
				expect((await row(w, id)).state).toBe('pending')
				expect((await decide(w, id, 'reject', approveOnly)).state).toBe('rejected')
			})

			test('under a passkey, that approver is refused before a challenge is issued or an assertion spent', async () => {
				const w = await world()
				await protect(w, 'prod', STRICT_POLICY, { ...STRICT_SETTINGS, stepUp: { ...STRICT_SETTINGS.stepUp, secrets: 'webauthn' } })
				const { id } = await ask(w, 'apps.secrets.put', putSecret('prod'))
				const approveOnly: Who = { ...BOB, actions: [CONTROL_ACTIONS.ACCESS_APPROVE] }
				const { inputDigest } = await getApprovalRequestUseCase(context(w, approveOnly), id)
				const approve = { id, decision: 'approve' as const, inputDigest }
				expect((await status(challengeApprovalRequestUseCase(context(w, approveOnly), approve))).status).toBe(403)
				expect(w.iam.bindings).toEqual([])

				const assertion = answerChallenge(await challengeApprovalRequestUseCase(context(w, BOB), approve), BOB.id)
				expect((await status(decideApprovalRequestUseCase(context(w, approveOnly), { ...approve, stepUp: assertion }))).status).toBe(403)
				expect(w.iam.verifications).toBe(0)
				expect(await decideApprovalRequestUseCase(context(w, BOB), { ...approve, stepUp: assertion })).toMatchObject({ state: 'executed' })
			})
		})
	})
}
