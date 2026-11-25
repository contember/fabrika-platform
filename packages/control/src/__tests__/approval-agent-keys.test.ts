// ADR-0083 §8: a key for someone else that an agent asks for (`credentials`), end to end through IAM's own app in
// process. The agent sends a public key; an IAM installation administrator decides the request in the console with a
// passkey (the category's default step-up, verified by IAM's real WebAuthn verifier); IAM issues the key as that person
// and encrypts it to the agent's key; Control keeps the JWE until the agent fetches it once, and a key nobody fetched by
// the deadline is revoked. On SQLite always, and with IAM and Control both on Postgres when FABRIKA_TEST_POSTGRES_URL
// is set.

import type { AuthContext, DomainEvent } from '@fabrika/auth'
import { permits } from '@fabrika/auth-core'
import {
	type ApprovalPolicy,
	type ApprovalSettings,
	type ApprovalStepUp,
	CONTROL_ACTIONS,
	CONTROL_APP_ID,
	STRICT_POLICY,
	STRICT_SETTINGS,
} from '@fabrika/control-contract'
import { type PasskeyChallenge, type PasskeyCreationOptions, recipientKeyThumbprint, type RecipientPublicKey } from '@fabrika/iam-contract'
import { type DeployLocks, type HttpService, type SqlDatabase, SqlDeployLocks } from '@fabrika/platform'
import { unusedDatabase } from '@fabrika/platform/testing'
import type { JsonValue } from '@fabrika/provider-contract'
import { afterEach, describe, expect, test } from 'bun:test'
import { compactDecrypt, exportJWK, generateKeyPair } from 'jose'
import {
	adminTokenFor,
	CONSOLE_APP,
	createHarness as createIamHarness,
	makeServicesFor,
	TEST_SIGNING_KEYS,
} from '../../../iam/src/__tests__/helpers/harness'
import { membershipFixture, ORIGIN as IAM_ORIGIN, type Person } from '../../../iam/src/__tests__/helpers/membership'
import { createPostgres as createIamPostgres, hasPostgres as hasIamPostgres } from '../../../iam/src/__tests__/helpers/postgres'
import { TestAuthenticator } from '../../../iam/src/__tests__/helpers/webauthn'
import { createIamApp } from '../../../iam/src/app'
import { createPostgresIamRepositories, type IamRepositories } from '../../../iam/src/db'
import { mintFromKey } from '../../../iam/src/tokens'
import { controlSchema } from '../../fabrika.schema'
import { ControlApiError } from '../api/domain'
import { storedPolicy, storedSettings } from '../approval/categories'
import {
	type ApprovalRequestContext,
	challengeApprovalRequestUseCase,
	createApprovalRequestUseCase,
	decideApprovalRequestUseCase,
	fetchApprovalRequestKeyUseCase,
	getApprovalRequestUseCase,
} from '../approval/requests/api'
import { sweepUnfetchedKeys } from '../approval/requests/deliveries'
import { sweepApprovalRequests } from '../approval/requests/execute'
import { consoleIamApprover, iamGrantsReader, iamRequestedKeys } from '../approval/requests/iam'
import { iamPasskeyStepUp } from '../approval/step-up'
import { type ControlRepositories, createControlRepositories } from '../db'
import { appScope } from '../iam'
import { iamProvisioningClient } from '../iam-provisioning'
import { createHarness, harnessDatabase } from './helpers/harness'
import { fixtureProtect } from './helpers/lock'
import { createPostgres, hasPostgres, skipReason } from './helpers/postgres'
import { fakeControlProvider } from './helpers/provider'

if (!hasPostgres) console.warn(`approval-agent-keys.test.ts Postgres half ${skipReason}`)

const KIND = 'iam.apiKeys.provision'
const CONSOLE = 'https://console.example.test'
const PROVISIONING_KEY = 'px_provisioning-key-of-the-agent-keys-suite'
const ENVELOPE = JSON.stringify({ provider: 'harbor', version: 1, payload: {} })
const DAY = 24 * 3600
const AGENT_CLIENT = 'https://agent.example.test/client.json'
const OTHER_CLIENT = 'https://other.example.test/client.json'

interface Backends {
	readonly name: string
	readonly skip: boolean
	open(
		now: () => number,
	): Promise<{ iam: IamRepositories; control: ControlRepositories; controlDb: SqlDatabase; locks: DeployLocks; close(): Promise<void> }>
}

const backends: readonly Backends[] = [
	{
		name: 'sqlite',
		skip: false,
		open: (now) => {
			const iam = createIamHarness()
			const control = createHarness(now)
			const controlDb = harnessDatabase(control.repositories)
			return Promise.resolve({
				iam: iam.repositories,
				control: control.repositories,
				controlDb,
				locks: new SqlDeployLocks(controlDb),
				close: () => {
					iam.sqlite.close()
					control.sqlite.close()
					return Promise.resolve()
				},
			})
		},
	},
	{
		name: 'postgres',
		skip: !hasPostgres || !hasIamPostgres,
		open: async (now) => {
			const iam = await createIamPostgres('iam_agent_keys')
			const control = await createPostgres('control_agent_keys')
			return {
				iam: createPostgresIamRepositories(iam.db),
				control: createControlRepositories(control.db, { now }),
				controlDb: control.db,
				locks: new SqlDeployLocks(control.db),
				close: async () => {
					await iam.close()
					await control.close()
				},
			}
		},
	},
]

/** IAM's own app behind the transport Control's IAM gateway and its provisioning client use. */
function iamTransport(repositories: IamRepositories): HttpService {
	return {
		fetch: (request) =>
			createIamApp().fetch(request, {
				DB: unusedDatabase,
				REPOSITORIES: repositories,
				HUMAN_EMAIL_DOMAINS: '[]',
				HUMAN_EMAILS: '[]',
				IAM_BOOTSTRAP_ADMINS: '[]',
				ENVIRONMENT: 'stage',
				ISSUER: IAM_ORIGIN,
				FABRIKA_IAM_SIGNING_KEYS: TEST_SIGNING_KEYS,
				FABRIKA_IAM_PROVISIONING_KEY: PROVISIONING_KEY,
				OIDC_ISSUER: 'https://idp.test',
				OIDC_CLIENT_ID: 'client',
				OIDC_CLIENT_SECRET: 'secret',
				OIDC_SCOPES: '',
				OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
			}, { waitUntil() {} }),
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

function isCreation(value: unknown): value is PasskeyChallenge<PasskeyCreationOptions> {
	return typeof value === 'object' && value !== null && 'challengeId' in value && 'options' in value
}

/** What the console printed while `run` ran, every level. */
async function printed(run: () => Promise<void>): Promise<string> {
	const lines: string[] = []
	const levels = ['log', 'info', 'warn', 'error', 'debug'] as const
	const saved = levels.map((level) => [level, console[level]] as const)
	for (const level of levels) console[level] = (...args: unknown[]) => void lines.push(args.map(String).join(' '))
	try {
		await run()
	} finally {
		for (const [level, original] of saved) console[level] = original
	}
	return lines.join('\n')
}

for (const backend of backends) {
	describe.skipIf(backend.skip)(`a key an agent asks for as an approval request (${backend.name})`, () => {
		let closing: (() => Promise<void>) | null = null
		afterEach(async () => {
			const close = closing
			closing = null
			await close?.()
		})

		async function world() {
			const clock = { offset: 0 }
			const now = () => Math.floor(Date.now() / 1000) + clock.offset
			const opened = await backend.open(now)
			closing = opened.close
			const { control: db, locks } = opened
			const transport = iamTransport(opened.iam)
			const f = await membershipFixture(opened.iam)
			expect((await f.putSchema(controlSchema, CONTROL_APP_ID)).status).toBe(200)
			await opened.iam.handoff.setReturnOrigins(CONSOLE_APP, [CONSOLE])

			/** An installation administrator in IAM: a person in a signed-in console session. */
			const administrator = async (name: string): Promise<Person> => {
				const person = await f.person(name)
				await opened.iam.grants.createGrant({ principalId: person.id, roleKey: 'admin' })
				return person
			}
			const ada = await administrator('ada')
			const bob = await administrator('bob')
			// Holds every action in Control, but administers nothing in IAM.
			const eve = await f.person('eve')

			await db.registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes', defaultBranch: 'main' })
			for (const env of ['prod', 'stage']) {
				await db.registry.upsertAppEnv({
					appId: 'notes',
					env,
					namespaceId: null,
					provider: 'harbor',
					providerTargetJson: ENVELOPE,
					providerArtifactJson: ENVELOPE,
				})
			}
			const audited: DomainEvent[] = []
			const provisioning = iamProvisioningClient({
				origin: IAM_ORIGIN,
				provisioningKey: PROVISIONING_KEY,
				fetch: (input, init) => transport.fetch(new Request(input, init)),
			})
			const iamGrants = iamGrantsReader(provisioning)
			const iamKeys = iamRequestedKeys(provisioning)

			async function protect(env: string, policy: ApprovalPolicy = STRICT_POLICY, settings: ApprovalSettings = STRICT_SETTINGS) {
				await fixtureProtect(db.registry, locks, { appId: 'notes', env }, true, Date.now, storedPolicy(policy), storedSettings(settings))
			}

			/** A console call by an IAM person: their console token, and `actions` in Control everywhere. */
			async function person(who: Person, label: string, actions: readonly string[] = ['*']): Promise<ApprovalRequestContext> {
				const token = await adminTokenFor(opened.iam, who.id, { issuer: IAM_ORIGIN })
				const request = new Request(`${CONSOLE}/api/rpc`, { method: 'POST', headers: { 'X-Fabrika-Token': token, 'Sec-Fetch-Site': 'same-origin' } })
				const grants = actions.map((action) => ({ action, scope: null, source: 'grant' as const }))
				const auth: AuthContext = {
					ok: true,
					principal: { id: who.id, type: 'user', label },
					can: (action, scope) => permits(grants, action, scope),
					scopedTo: () => null,
					audit: (event) => Promise.resolve(void audited.push(event)),
				}
				const iamApprover = consoleIamApprover(transport, request)
				const stepUp = iamPasskeyStepUp(transport, request)
				return {
					repositories: db,
					provider: fakeControlProvider,
					auth,
					admission: { request },
					lock: locks,
					consoleOrigin: CONSOLE,
					iamGrants,
					iamKeys,
					...(iamApprover === null ? {} : { iamApprover }),
					...(stepUp === null ? {} : { stepUp }),
					now,
				}
			}

			/** An agent's call: an OAuth token acting for `principalId` through `clientId`, holding `actions` at the application. */
			function agent(
				principalId: string,
				actions: readonly string[] = [CONTROL_ACTIONS.ACCESS_REQUEST, CONTROL_ACTIONS.DEPLOY_TRIGGER, CONTROL_ACTIONS.DEPLOY_READ],
				clientId = AGENT_CLIENT,
			): ApprovalRequestContext {
				const grants = actions.map((action) => ({ action, scope: appScope('notes'), source: 'grant' as const }))
				const request = new Request(`${CONSOLE}/api/rpc`, { method: 'POST', headers: { Authorization: 'Bearer mcp-token' } })
				return {
					repositories: db,
					provider: fakeControlProvider,
					auth: {
						ok: true,
						principal: { id: principalId, type: 'user', label: `${principalId} via agent` },
						oauth: { app: CONTROL_APP_ID, clientId, scopes: ['operate'], grantId: 'grant-1', tokenId: 't' },
						can: (action, scope) => permits(grants, action, scope),
						scopedTo: () => null,
						audit: (event) => Promise.resolve(void audited.push(event)),
					},
					admission: { request },
					lock: locks,
					consoleOrigin: CONSOLE,
					iamGrants,
					iamKeys,
					now,
				}
			}

			/** The agent's key pair, made in memory as the CLI makes it. */
			const pair = await generateKeyPair('ECDH-ES', { crv: 'P-256', extractable: true })
			const exported = await exportJWK(pair.publicKey)
			if (typeof exported.x !== 'string' || typeof exported.y !== 'string') throw new Error('no public key')
			const publicKey: RecipientPublicKey = { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y }

			const keyInput = (overrides: Record<string, JsonValue> = {}): JsonValue => ({
				appId: 'notes',
				label: 'ci deploys',
				actions: [CONTROL_ACTIONS.DEPLOY_TRIGGER],
				expiresAt: Math.floor(Date.now() / 1000) + 7 * DAY,
				publicKey,
				...overrides,
			})

			const ask = (input: JsonValue = keyInput(), requester = agent('kim')) => createApprovalRequestUseCase(requester, { kind: KIND, input })

			async function registerPasskey(who: Person): Promise<TestAuthenticator> {
				const authenticator = await TestAuthenticator.create()
				const token = await adminTokenFor(opened.iam, who.id, { issuer: IAM_ORIGIN })
				const rpc = async (method: string, input: unknown): Promise<unknown> => {
					const response = await transport.fetch(
						new Request(`${IAM_ORIGIN}/admin/rpc`, {
							method: 'POST',
							headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
							body: JSON.stringify({ method, input }),
						}),
					)
					const body: { result?: unknown } = await response.json()
					if (response.status !== 200) throw new Error(`${method}: ${response.status}`)
					return body.result
				}
				const issued = await rpc('passkeys.registrationOptions', null)
				if (!isCreation(issued)) throw new Error('no creation options')
				await rpc('passkeys.register', {
					challengeId: issued.challengeId,
					label: 'Laptop',
					credential: await authenticator.register(issued.options, CONSOLE),
				})
				return authenticator
			}
			const adaPasskey = await registerPasskey(ada)

			/** Approve as ada, confirming it with her passkey, as the category's default step-up takes. */
			async function approve(id: string, context?: ApprovalRequestContext) {
				const c = context ?? await person(ada, 'ada')
				const read = await getApprovalRequestUseCase(c, id)
				const decision = { id, decision: 'approve' as const, inputDigest: read.inputDigest }
				const issued = await challengeApprovalRequestUseCase(c, decision)
				if (issued.kind !== 'challenge') throw new Error('ada holds a passkey')
				const stepUp: ApprovalStepUp = {
					challengeId: issued.challenge.challengeId,
					credential: await adaPasskey.assert(issued.challenge.options, CONSOLE),
				}
				return decideApprovalRequestUseCase(c, { ...decision, stepUp })
			}

			async function open(jwe: string): Promise<string> {
				return new TextDecoder().decode((await compactDecrypt(jwe, pair.privateKey)).plaintext)
			}

			/** Whether `key` exchanges for a console token holding `action` at the application. */
			async function authenticates(key: string, action: string = CONTROL_ACTIONS.DEPLOY_TRIGGER): Promise<boolean> {
				const minted = await mintFromKey(makeServicesFor(opened.iam, { environment: 'stage', issuer: IAM_ORIGIN }), {
					FABRIKA_IAM_SIGNING_KEYS: TEST_SIGNING_KEYS,
					ENVIRONMENT: 'stage',
				}, { app: CONTROL_APP_ID, key, requestId: 'r' })
				if (!minted.result.ok) return false
				const [, payload] = minted.result.token.split('.')
				const claims: unknown = JSON.parse(atob((payload ?? '').replaceAll('-', '+').replaceAll('_', '/')))
				return JSON.stringify(claims).includes(action)
			}

			/** The service principals IAM issued since the world was set up. */
			const services = async () => (await opened.iam.principals.listPrincipals({ type: 'service', limit: 100 })).length
			const before = await services()
			const issuedKeys = async (): Promise<number> => (await services()) - before

			/** IAM's audit rows of `action`, with their metadata parsed. */
			async function iamAudit(action: string): Promise<{ principal: string | null; metadata: unknown }[]> {
				const rows = await opened.iam.audit.listAuditEvents({ limit: 500 })
				return rows.filter((row) => row.action === action).map((row) => ({
					principal: row.principal_id,
					metadata: row.metadata === null ? null : JSON.parse(row.metadata),
				}))
			}

			/** Every row Control holds of approval requests and their deliveries, as text. */
			async function controlRows(): Promise<string> {
				const requests = await opened.controlDb.prepare('SELECT * FROM approval_requests').all<Record<string, unknown>>()
				const deliveries = await opened.controlDb.prepare('SELECT * FROM approval_request_deliveries').all<Record<string, unknown>>()
				return JSON.stringify([requests.results, deliveries.results])
			}

			const sweepKeys = () => sweepUnfetchedKeys({ repositories: db, iamKeys })

			await protect('prod')
			return {
				db,
				clock,
				ada,
				bob,
				eve,
				audited,
				iamKeys,
				iamGrants,
				locks,
				publicKey,
				protect,
				person,
				agent,
				ask,
				keyInput,
				approve,
				open,
				authenticates,
				issuedKeys,
				iamAudit,
				controlRows,
				sweepKeys,
				now,
			}
		}

		test('approved with a passkey, IAM issues one key; the agent fetches it once, opens it, and it authenticates', async () => {
			const w = await world()
			const created = await w.ask()
			expect(created).toMatchObject({ state: 'pending', url: `${CONSOLE}/approvals/requests/${created.id}` })
			// The step-up is the category's default: no passkey, no decision.
			const ada = await w.person(w.ada, 'ada')
			const read = await getApprovalRequestUseCase(ada, created.id)
			expect(read.stepUp).toBe('webauthn')
			expect(await status(decideApprovalRequestUseCase(ada, { id: created.id, decision: 'approve', inputDigest: read.inputDigest }))).toMatchObject({
				status: 403,
			})

			const decided = await w.approve(created.id)
			expect(decided.state).toBe('executed')
			expect(decided.delivery).toEqual({ state: 'waiting', deadline: expect.any(Number) })
			expect(await w.issuedKeys()).toBe(1)
			expect(JSON.stringify(decided)).not.toContain('"jwe"')

			const fetched = await fetchApprovalRequestKeyUseCase(w.agent('kim'), created.id)
			const plaintext = await w.open(fetched.jwe)
			expect(plaintext.startsWith('px_')).toBe(true)
			expect(await w.authenticates(plaintext)).toBe(true)
			// Fetching deletes it: the second fetch finds nothing.
			expect(await status(fetchApprovalRequestKeyUseCase(w.agent('kim'), created.id))).toMatchObject({ status: 410 })
			expect((await getApprovalRequestUseCase(w.agent('kim'), created.id)).delivery).toMatchObject({ state: 'fetched' })

			const [record] = await w.iamAudit('iam.apikey.create')
			expect(record).toEqual({
				principal: w.ada.id,
				metadata: expect.objectContaining({
					app: CONTROL_APP_ID,
					label: 'ci deploys',
					approvalRequest: { id: created.id, requester: { id: 'kim', label: 'kim via agent', clientId: AGENT_CLIENT } },
				}),
			})
			const decision = await w.db.approvalRequests.get(created.id)
			expect(decision?.decided_step_up_credential_id).toEqual(expect.any(String))
		})

		test('the page shows who asks, for whom, the actions, the expiry and the thumbprint, the agent’s text marked', async () => {
			const w = await world()
			const expiresAt = Math.floor(Date.now() / 1000) + 3 * DAY
			const created = await w.ask(w.keyInput({ label: '<b>ci</b>', expiresAt }))
			const shown = await getApprovalRequestUseCase(await w.person(w.ada, 'ada'), created.id)
			expect(shown.requester).toMatchObject({ principal: { id: 'kim' }, credential: 'oauth', clientId: AGENT_CLIENT })
			expect(shown.description.summary).toContainEqual({ text: '<b>ci</b>', agent: true })
			const facts = Object.fromEntries(shown.description.facts.map((fact) => [fact.label, fact.value]))
			expect(facts['Label']).toEqual({ text: '<b>ci</b>', agent: true })
			expect(facts['Actions']?.text).toBe('deploy.trigger')
			expect(facts['Expires']).toMatchObject({ at: expiresAt })
			expect(facts['Thumbprint']).toEqual({ text: recipientKeyThumbprint(w.publicKey), agent: false })
			expect(shown.description.warnings).toBeUndefined()
			// The requester reads the same description of its own request.
			expect((await getApprovalRequestUseCase(w.agent('kim'), created.id)).description.facts.map((fact) => fact.label)).toContain('Thumbprint')
		})

		test('only the requester’s own principal and OAuth client fetch the key; nobody else, a decider included', async () => {
			const w = await world()
			const created = await w.ask()
			await w.approve(created.id)
			expect(await status(fetchApprovalRequestKeyUseCase(w.agent('kim', undefined, OTHER_CLIENT), created.id))).toMatchObject({ status: 404 })
			expect(await status(fetchApprovalRequestKeyUseCase(w.agent('lee'), created.id))).toMatchObject({ status: 404 })
			expect(await status(fetchApprovalRequestKeyUseCase(await w.person(w.ada, 'ada'), created.id))).toMatchObject({ status: 404 })
			// The JWE is in nobody's DTO, the requester's included.
			for (const reader of [w.agent('kim'), await w.person(w.ada, 'ada')]) {
				expect(JSON.stringify(await getApprovalRequestUseCase(reader, created.id))).not.toContain('"jwe"')
			}
			expect((await fetchApprovalRequestKeyUseCase(w.agent('kim'), created.id)).jwe).toEqual(expect.any(String))
		})

		test('an execution whose answer was lost is followed to the same key, never a second one', async () => {
			const w = await world()
			const created = await w.ask()
			const ada = await w.person(w.ada, 'ada')
			const approver = ada.iamApprover
			if (approver === undefined) throw new Error('no IAM approver')
			let issued: string | null = null
			// IAM issues the key, and the answer never reaches Control.
			const lost = {
				...ada,
				iamApprover: {
					...approver,
					provisionRequestedKey: async (input: Parameters<typeof approver.provisionRequestedKey>[0]) => {
						issued = (await approver.provisionRequestedKey(input)).jwe
						throw new Error('connection reset')
					},
				},
			}
			expect((await w.approve(created.id, lost)).state).toBe('unknown')
			expect(await w.issuedKeys()).toBe(1)
			expect(await status(fetchApprovalRequestKeyUseCase(w.agent('kim'), created.id))).toMatchObject({ status: 409 })

			// Without IAM the sweep cannot tell, and leaves it unknown.
			await sweepApprovalRequests({ repositories: w.db, lock: w.locks })
			expect((await w.db.approvalRequests.get(created.id))?.state).toBe('unknown')
			const swept = await sweepApprovalRequests({ repositories: w.db, lock: w.locks, iamGrants: w.iamGrants, iamKeys: w.iamKeys })
			expect(swept.settled).toBe(1)
			expect((await w.db.approvalRequests.get(created.id))?.state).toBe('executed')
			expect(await w.issuedKeys()).toBe(1)
			const fetched = await fetchApprovalRequestKeyUseCase(w.agent('kim'), created.id)
			expect(fetched.jwe).toBe(issued ?? '')
			expect(await w.authenticates(await w.open(fetched.jwe))).toBe(true)

			// A repeat of the issuance itself, with the same request id, answers that key too.
			const row = await w.db.approvalRequests.get(created.id)
			const repeat = await approver.provisionRequestedKey({
				label: 'ci deploys',
				app: CONTROL_APP_ID,
				permissions: [CONTROL_ACTIONS.DEPLOY_TRIGGER],
				scopeType: 'app',
				scopeValue: 'notes',
				expiresAt: JSON.parse(row?.input_json ?? '{}').expiresAt,
				recipient: w.publicKey,
				approvalRequest: { id: created.id, requester: { id: 'kim', label: 'kim via agent', clientId: AGENT_CLIENT } },
			})
			expect(repeat.jwe).toBe(fetched.jwe)
			expect(await w.issuedKeys()).toBe(1)
		})

		test('a key nobody fetched by the deadline is revoked in IAM, and the request records it', async () => {
			const w = await world()
			const created = await w.ask()
			const decided = await w.approve(created.id)
			const deadline = decided.delivery?.deadline ?? 0
			const row = await w.db.approvalRequests.get(created.id)
			const result = JSON.parse(row?.result_json ?? '{}')
			const principalId: string = result.key.principalId
			// Before the deadline the sweep leaves it waiting.
			expect(await w.sweepKeys()).toEqual({ expired: 0, revoked: 0 })

			w.clock.offset = deadline - Math.floor(Date.now() / 1000) + 1
			expect(await status(fetchApprovalRequestKeyUseCase(w.agent('kim'), created.id))).toMatchObject({ status: 410 })
			expect(await w.sweepKeys()).toEqual({ expired: 1, revoked: 1 })
			expect((await getApprovalRequestUseCase(w.agent('kim'), created.id)).delivery).toMatchObject({ state: 'revoked' })
			expect(await status(fetchApprovalRequestKeyUseCase(w.agent('kim'), created.id))).toMatchObject({ status: 410 })
			const [revoked] = await w.iamAudit('iam.apikey.revoke')
			expect(revoked).toMatchObject({ metadata: { label: 'ci deploys' } })
			expect((await w.iamGrants.principalAt(principalId, CONTROL_APP_ID))?.grants).toEqual([])
			// A second pass has nothing left to do.
			expect(await w.sweepKeys()).toEqual({ expired: 0, revoked: 0 })
		})

		test('under credentialCeiling: requester, an action the requester lacks is refused; under approver, the page warns of it', async () => {
			const w = await world()
			const beyond = w.keyInput({ actions: [CONTROL_ACTIONS.DEPLOY_TRIGGER, CONTROL_ACTIONS.SECRET_MANAGE] })
			const refused = await status(w.ask(beyond))
			expect(refused.status).toBe(403)
			expect(refused.message).toContain('secret.manage')

			await w.protect('prod', STRICT_POLICY, { ...STRICT_SETTINGS, credentialCeiling: 'approver' })
			const created = await w.ask(beyond)
			const shown = await getApprovalRequestUseCase(await w.person(w.ada, 'ada'), created.id)
			expect(JSON.stringify(shown.description.warnings)).toContain('secret.manage')
			expect(JSON.stringify(shown.description.warnings)).not.toContain('deploy.trigger')
			const actions = shown.description.facts.find((fact) => fact.label === 'Actions')
			expect(actions?.value.text).toBe('deploy.trigger, secret.manage (beyond the requester)')
			expect((await w.approve(created.id)).state).toBe('executed')
			expect(await w.authenticates(await w.open((await fetchApprovalRequestKeyUseCase(w.agent('kim'), created.id)).jwe), 'secret.manage'))
				.toBe(true)
		})

		test('the ceiling turned back to requester before the decision closes a request beyond it stale', async () => {
			const w = await world()
			await w.protect('prod', STRICT_POLICY, { ...STRICT_SETTINGS, credentialCeiling: 'approver' })
			const beyond = await w.ask(w.keyInput({ actions: [CONTROL_ACTIONS.SECRET_MANAGE] }))
			const within = await w.ask()
			await w.protect('prod')
			expect((await w.approve(beyond.id)).state).toBe('stale')
			expect((await w.approve(within.id)).state).toBe('executed')
			expect(await w.issuedKeys()).toBe(1)
		})

		test('creation refuses an expiry past 30 days, a private key, another curve, and what the requester may not ask for', async () => {
			const w = await world()
			const now = Math.floor(Date.now() / 1000)
			expect(await status(w.ask(w.keyInput({ expiresAt: now + 31 * DAY })))).toMatchObject({ status: 400 })
			expect(await status(w.ask(w.keyInput({ expiresAt: now - 1 })))).toMatchObject({ status: 400 })
			const secret = await status(w.ask(w.keyInput({ publicKey: { ...w.publicKey, d: w.publicKey.x } })))
			expect(secret.status).toBe(400)
			expect(secret.message).toContain('private key')
			expect(await status(w.ask(w.keyInput({ publicKey: { kty: 'EC', crv: 'P-384', x: 'a', y: 'b' } })))).toMatchObject({ status: 400 })
			expect(await status(w.ask(w.keyInput({ actions: ['deploy.*'] })))).toMatchObject({ status: 400 })
			expect(await status(w.ask(w.keyInput({ actions: ['nothing.of.control'] })))).toMatchObject({ status: 400 })
			// Without `access.request` at the application: as an absent application answers.
			expect(await status(w.ask(w.keyInput(), w.agent('kim', [CONTROL_ACTIONS.DEPLOY_TRIGGER])))).toMatchObject({ status: 404 })
			// `refuse` refuses it to an agent at all; with no environment gating it there is nothing to approve.
			await w.protect('prod', { ...STRICT_POLICY, credentials: 'refuse' })
			expect((await status(w.ask())).status).toBe(403)
			await w.protect('prod', { ...STRICT_POLICY, credentials: 'off' })
			const off = await status(w.ask())
			expect(off.status).toBe(409)
			expect(off.message).toContain('credentials')
			expect(await w.db.approvalRequests.listPending(100)).toEqual([])
		})

		test('who decides: an IAM installation administrator holding the key’s actions in Control', async () => {
			const w = await world()
			const created = await w.ask()
			// eve holds every Control action, but administers nothing in IAM: she does not see it.
			expect(await status(getApprovalRequestUseCase(await w.person(w.eve, 'eve'), created.id))).toMatchObject({ status: 404 })
			// bob administers IAM, but does not hold `deploy.trigger` in Control: approving would issue it as him.
			const bob = await w.person(w.bob, 'bob', [CONTROL_ACTIONS.ACCESS_APPROVE])
			const read = await getApprovalRequestUseCase(bob, created.id)
			const refused = await status(challengeApprovalRequestUseCase(bob, { id: created.id, decision: 'approve', inputDigest: read.inputDigest }))
			expect(refused.status).toBe(403)
			expect(refused.message).toContain('deploy.trigger')
			expect(await w.issuedKeys()).toBe(0)
		})

		test('the plaintext is never in Control’s database, a DTO, an audit record or a log line; the JWE only in the delivery until fetched', async () => {
			const w = await world()
			let plaintext = ''
			let jwe = ''
			const dtos: string[] = []
			const logs = await printed(async () => {
				const created = await w.ask()
				dtos.push(JSON.stringify(await w.approve(created.id)))
				dtos.push(JSON.stringify(await getApprovalRequestUseCase(w.agent('kim'), created.id)))
				dtos.push(JSON.stringify(await getApprovalRequestUseCase(await w.person(w.ada, 'ada'), created.id)))
				const waiting = await w.controlRows()
				jwe = (await fetchApprovalRequestKeyUseCase(w.agent('kim'), created.id)).jwe
				expect(waiting).toContain(jwe)
				plaintext = await w.open(jwe)
				expect(waiting).not.toContain(plaintext)
			})
			expect(plaintext.startsWith('px_')).toBe(true)
			const rows = await w.controlRows()
			const audit = JSON.stringify(w.audited)
			for (const text of [rows, audit, logs, ...dtos]) {
				expect(text).not.toContain(plaintext)
				expect(text).not.toContain(jwe)
			}
		})
	})
}
