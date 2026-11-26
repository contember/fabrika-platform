// ADR-0083 §4 and §8: a role grant an agent asks for at an application (`agent-grants`), end to end through IAM's own
// app in process: Control stores the request, the application's IAM administrator decides it in the console, and the
// approval makes the grant as that administrator's console grant, through IAM's admin transport with their console
// token. Where the application's grants wait, IAM opens its own grant request for a second administrator instead. On
// SQLite always, and with IAM and Control both on Postgres when FABRIKA_TEST_POSTGRES_URL is set.

import type { AuthContext, DomainEvent } from '@fabrika/auth'
import { type ContractArtifact, permits } from '@fabrika/auth-core'
import {
	type ApprovalPolicy,
	type ApprovalSettings,
	type ApprovalStepUp,
	CONTROL_ACTIONS,
	STRICT_POLICY,
	STRICT_SETTINGS,
} from '@fabrika/control-contract'
import type { PasskeyChallenge, PasskeyCreationOptions } from '@fabrika/iam-contract'
import { type DeployLocks, type HttpService, type SqlDatabase, SqlDeployLocks } from '@fabrika/platform'
import { unusedDatabase } from '@fabrika/platform/testing'
import type { JsonValue } from '@fabrika/provider-contract'
import { afterEach, describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { PEOPLE_SCHEMA } from '../../../iam/src/__tests__/helpers/app-people'
import { adminTokenFor, CONSOLE_APP, createHarness as createIamHarness, TEST_SIGNING_KEYS } from '../../../iam/src/__tests__/helpers/harness'
import { APP, membershipFixture, ORIGIN as IAM_ORIGIN, type Person } from '../../../iam/src/__tests__/helpers/membership'
import { createPostgres as createIamPostgres, hasPostgres as hasIamPostgres } from '../../../iam/src/__tests__/helpers/postgres'
import { TestAuthenticator } from '../../../iam/src/__tests__/helpers/webauthn'
import { createIamApp } from '../../../iam/src/app'
import { createPostgresIamRepositories, type IamRepositories } from '../../../iam/src/db'
import { ControlApiError } from '../api/domain'
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
import { consoleIamApprover, iamGrantsReader } from '../approval/requests/iam'
import { PRODUCTION_REQUEST_KINDS } from '../approval/requests/production'
import { iamPasskeyStepUp } from '../approval/step-up'
import { type ControlRepositories, createControlRepositories } from '../db'
import { appScope } from '../iam'
import { iamProvisioningClient } from '../iam-provisioning'
import { createHarness, harnessDatabase } from './helpers/harness'
import { fixtureProtect } from './helpers/lock'
import { createPostgres, hasPostgres, skipReason } from './helpers/postgres'
import { fakeControlProvider } from './helpers/provider'

if (!hasPostgres) console.warn(`approval-agent-grants.test.ts Postgres half ${skipReason}`)

const KIND = 'iam.grants.create'
const CONSOLE = 'https://console.example.test'
const PROVISIONING_KEY = 'px_provisioning-key-of-the-agent-grants-suite'
const ENVELOPE = JSON.stringify({ provider: 'harbor', version: 1, payload: {} })
const DAY = 24 * 3600
const AGENT_CLIENT = 'https://agent.example.test/client.json'

/** The notes contract as the environment published it, with `staff`, an application-wide role, beside `editor`. */
const CONTRACT: ContractArtifact = {
	...notesArtifact,
	roles: { ...notesArtifact.roles, staff: { grants: ['notes.read', 'notes.write', 'notes.share', 'notes.admin'], member: null } },
}

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
			const iam = await createIamPostgres('iam_agent_grants')
			const control = await createPostgres('control_agent_grants')
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

for (const backend of backends) {
	describe.skipIf(backend.skip)(`an agent's grant as an approval request (${backend.name})`, () => {
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
			expect((await f.putSchema(PEOPLE_SCHEMA)).status).toBe(200)
			await opened.iam.handoff.setReturnOrigins(CONSOLE_APP, [CONSOLE])

			/** An installation administrator in IAM: a person in a signed-in console session. */
			const administrator = async (name: string): Promise<Person> => {
				const person = await f.person(name)
				await opened.iam.grants.createGrant({ principalId: person.id, roleKey: 'admin' })
				return person
			}
			const ada = await administrator('ada')
			const bob = await administrator('bob')
			// Holds `access.approve` in Control, but administers nothing in IAM.
			const eve = await f.person('eve')
			const grantee = await f.person('cy')

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

			/** Publish `contract` on the environment, as a deploy's publication writes it. */
			async function publish(env: string, contract: ContractArtifact = CONTRACT): Promise<void> {
				const snapshot = JSON.stringify({ version: 1, contract, migrations: [], checker: '0.9.0' })
				await opened.controlDb
					.prepare('UPDATE app_envs SET published_run_id = ?, published_snapshot_json = ? WHERE app_id = ? AND env = ?')
					.bind(crypto.randomUUID(), snapshot, 'notes', env)
					.run()
			}

			async function protect(env: string, policy: ApprovalPolicy = STRICT_POLICY, settings: ApprovalSettings = STRICT_SETTINGS) {
				await fixtureProtect(db.registry, locks, { appId: 'notes', env }, true, Date.now, storedPolicy(policy), storedSettings(settings))
			}

			/** A console call by an IAM person: their console token, and `access.approve` in Control everywhere. */
			async function person(who: Person, label: string): Promise<ApprovalRequestContext> {
				const token = await adminTokenFor(opened.iam, who.id, { issuer: IAM_ORIGIN })
				const request = new Request(`${CONSOLE}/api/rpc`, { method: 'POST', headers: { 'X-Fabrika-Token': token, 'Sec-Fetch-Site': 'same-origin' } })
				const grants = [{ action: CONTROL_ACTIONS.ACCESS_APPROVE, scope: null, source: 'grant' as const }]
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
					reservedHosts: [],
					provider: fakeControlProvider,
					auth,
					admission: { request },
					lock: locks,
					consoleOrigin: CONSOLE,
					iamGrants,
					...(iamApprover === null ? {} : { iamApprover }),
					...(stepUp === null ? {} : { stepUp }),
					now,
				}
			}

			/** An agent's call: an OAuth token acting for `principalId`, holding `actions` at the application. */
			function agent(principalId: string, actions: readonly string[] = [CONTROL_ACTIONS.ACCESS_REQUEST]): ApprovalRequestContext {
				const grants = actions.map((action) => ({ action, scope: appScope('notes'), source: 'grant' as const }))
				const request = new Request(`${CONSOLE}/api/rpc`, { method: 'POST', headers: { Authorization: 'Bearer mcp-token' } })
				return {
					repositories: db,
					reservedHosts: [],
					provider: fakeControlProvider,
					auth: {
						ok: true,
						principal: { id: principalId, type: 'user', label: `${principalId} via agent` },
						oauth: { app: 'vozka', clientId: AGENT_CLIENT, scopes: ['operate'], grantId: 'grant-1', tokenId: 't' },
						can: (action, scope) => permits(grants, action, scope),
						scopedTo: () => null,
						audit: (event) => Promise.resolve(void audited.push(event)),
					},
					admission: { request },
					lock: locks,
					consoleOrigin: CONSOLE,
					iamGrants,
					now,
				}
			}

			const grantInput = (overrides: Record<string, JsonValue> = {}): JsonValue => ({
				appId: 'notes',
				env: 'prod',
				principalId: grantee.id,
				role: 'staff',
				scope: null,
				expiresAt: Math.floor(Date.now() / 1000) + 7 * DAY,
				...overrides,
			})

			const ask = (input: JsonValue = grantInput(), requester = agent('kim')) => createApprovalRequestUseCase(requester, { kind: KIND, input })

			async function decide(id: string, decision: 'approve' | 'reject', who: Person, label: string, stepUp?: ApprovalStepUp) {
				const read = await getApprovalRequestUseCase(await person(who, label), id)
				return decideApprovalRequestUseCase(await person(who, label), {
					id,
					decision,
					inputDigest: read.inputDigest,
					...(stepUp === undefined ? {} : { stepUp }),
				})
			}

			/** The grantee's grants at the application, as IAM holds them. */
			const grantsAt = async () => (await opened.iam.grants.listGrants(grantee.id)).filter((grant) => grant.app === APP)

			/** IAM's audit rows of `action`, with their metadata parsed. */
			async function iamAudit(action: string): Promise<{ principal: string | null; metadata: unknown }[]> {
				const rows = await opened.iam.audit.listAuditEvents({ limit: 500 })
				return rows.filter((row) => row.action === action).map((row) => ({
					principal: row.principal_id,
					metadata: row.metadata === null ? null : JSON.parse(row.metadata),
				}))
			}

			/** The application's grants wait (ADR-0083 §4), set as Control sets it, with the provisioning key. */
			const gateGrants = () => provisioning.grantApproval.set({ app: APP, required: true, revision: 1 })

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

			await publish('prod')
			await publish('stage')
			await protect('prod')
			return {
				db,
				locks,
				clock,
				ada,
				bob,
				eve,
				grantee,
				audited,
				transport,
				iamGrants,
				provisioning,
				publish,
				protect,
				person,
				agent,
				ask,
				grantInput,
				decide,
				grantsAt,
				iamAudit,
				gateGrants,
				registerPasskey,
				iam: opened.iam,
			}
		}

		test('approved by an IAM administrator, the grant is made as their console grant, and IAM audits the request and the requester', async () => {
			const w = await world()
			const created = await w.ask()
			expect(created).toMatchObject({ state: 'pending', url: `${CONSOLE}/approvals/requests/${created.id}` })
			expect(await w.grantsAt()).toEqual([])

			const shown = await getApprovalRequestUseCase(await w.person(w.ada, 'ada'), created.id)
			expect(shown.description.role).toMatchObject({ role: 'staff', scope: null, actions: ['notes.admin', 'notes.read', 'notes.share', 'notes.write'] })
			expect(shown.description.summary.some((part) => part.agent && part.text === w.grantee.id)).toBe(false)

			const decided = await w.decide(created.id, 'approve', w.ada, 'ada')
			expect(decided.state).toBe('executed')
			const [grant, ...more] = await w.grantsAt()
			expect(more).toEqual([])
			expect(grant).toMatchObject({ role_key: 'staff', granted_by: w.ada.id, scope_value: null })
			expect(decided.result).toMatchObject({ grant: { id: expect.any(String) } })
			// The requester reads the outcome, which repeats what it asked.
			expect((await getApprovalRequestUseCase(w.agent('kim'), created.id)).result).toEqual(decided.result)

			const [record] = await w.iamAudit('iam.grant.create')
			expect(record).toEqual({
				principal: w.ada.id,
				metadata: expect.objectContaining({
					app: APP,
					roleKey: 'staff',
					approvalRequest: { id: created.id, requester: { id: 'kim', label: 'kim via agent', clientId: AGENT_CLIENT } },
				}),
			})
			expect(w.audited.map((event) => event.action)).toEqual([CONTROL_ACTIONS.ACCESS_APPROVE, KIND])
		})

		test('a membership role is granted in the value of its scope the agent named', async () => {
			const w = await world()
			const created = await w.ask(w.grantInput({ role: 'editor', scope: { type: 'workspace', value: 'ws-1' } }))
			expect((await w.decide(created.id, 'approve', w.bob, 'bob')).state).toBe('executed')
			expect(await w.grantsAt()).toMatchObject([{ role_key: 'editor', scope_type: 'workspace', scope_value: 'ws-1', granted_by: w.bob.id }])
		})

		test("where the application's grants wait, the approval opens IAM's grant request, and nothing is granted until another administrator approves it", async () => {
			const w = await world()
			await w.gateGrants()
			const created = await w.ask()

			const decided = await w.decide(created.id, 'approve', w.ada, 'ada')
			expect(decided.state).toBe('executed')
			const grantRequestId = grantRequestIdOf(decided.result)
			expect(decided.result).toMatchObject({ grantRequest: { status: 'pending', principalId: w.grantee.id, role: 'staff', app: APP } })
			expect(await w.grantsAt()).toEqual([])
			const [requested] = await w.iamAudit('iam.grant.request')
			expect(requested).toMatchObject({ principal: w.ada.id, metadata: { approvalRequest: { id: created.id, requester: { id: 'kim' } } } })

			const call = async (who: Person) => {
				const token = await adminTokenFor(w.iam, who.id, { issuer: IAM_ORIGIN })
				return w.transport.fetch(
					new Request(`${IAM_ORIGIN}/admin/rpc`, {
						method: 'POST',
						headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
						body: JSON.stringify({ method: 'grantRequests.decide', input: { id: grantRequestId, decision: 'approve' } }),
					}),
				)
			}
			// The approver made IAM's request, so another administrator approves it.
			expect((await call(w.ada)).status).toBe(403)
			expect(await w.grantsAt()).toEqual([])
			expect((await call(w.bob)).status).toBe(200)
			expect(await w.grantsAt()).toMatchObject([{ role_key: 'staff' }])
			// Executed once: the request stays as it ended, linking IAM's request.
			expect((await getApprovalRequestUseCase(await w.person(w.ada, 'ada'), created.id)).state).toBe('executed')
		})

		test("a change of the principal's grants, or of the role in the contract, before the decision closes the request stale", async () => {
			const w = await world()
			const first = await w.ask()
			await w.iam.grants.createGrant({ principalId: w.grantee.id, app: APP, roleKey: 'reader' })
			expect(await w.decide(first.id, 'approve', w.ada, 'ada')).toMatchObject({ state: 'stale' })
			expect((await w.grantsAt()).map((grant) => grant.role_key)).toEqual(['reader'])

			const second = await w.ask()
			const roles = { ...CONTRACT.roles, staff: { grants: ['notes.read', 'notes.write', 'notes.share', 'notes.admin', 'notes.delete'], member: null } }
			await w.publish('prod', { ...CONTRACT, roles })
			expect(await w.decide(second.id, 'approve', w.ada, 'ada')).toMatchObject({ state: 'stale' })
			expect((await w.grantsAt()).map((grant) => grant.role_key)).toEqual(['reader'])
		})

		test('IAM not answering when the approval executes closes the request failed, saying it could not be read and nothing was done', async () => {
			const w = await world()
			const created = await w.ask()
			const ada = await w.person(w.ada, 'ada')
			const read = await getApprovalRequestUseCase(ada, created.id)
			const down = () => Promise.reject(new Error('IAM is down'))
			const blind = { ...ada, iamGrants: { principalAt: down, openGrantRequests: down } }
			const decided = await decideApprovalRequestUseCase(blind, { id: created.id, decision: 'approve', inputDigest: read.inputDigest })
			expect(decided.state).toBe('failed')
			expect(decided.error).toContain('could not read what the request acts on now')
			expect(decided.error).toContain('nothing was done')
			expect(decided.error).not.toContain('IAM is down')
			expect(await w.grantsAt()).toEqual([])
		})

		test('a refusal and an expiry grant nothing', async () => {
			const w = await world()
			const refused = await w.ask()
			expect((await w.decide(refused.id, 'reject', w.ada, 'ada')).state).toBe('rejected')

			const expiring = await w.ask()
			w.clock.offset += 25 * 3600
			expect(await status(w.decide(expiring.id, 'approve', w.ada, 'ada'))).toMatchObject({ status: 410 })
			await sweepApprovalRequests({
				repositories: w.db,
				lock: w.locks,
				iamGrants: w.iamGrants,
				now: () => Math.floor(Date.now() / 1000) + w.clock.offset,
			})
			expect((await w.db.approvalRequests.get(expiring.id))?.state).toBe('expired')
			expect(await w.grantsAt()).toEqual([])
		})

		test('creation refuses what the requester may not ask for', async () => {
			const w = await world()
			// Without `access.request` at the application: as an absent environment answers.
			expect(await status(w.ask(w.grantInput(), w.agent('kim', [CONTROL_ACTIONS.APP_MANAGE])))).toMatchObject({ status: 404 })
			// A role the environment's approved contract does not declare, IAM's built-in `admin` among them.
			for (const role of ['admin', 'auditor', 'nobody']) {
				const refused = await status(w.ask(w.grantInput({ role })))
				expect(refused.status).toBe(400)
				expect(refused.message).toContain(`role \`${role}\``)
			}
			// The scope a role is granted in is the role's own.
			expect((await status(w.ask(w.grantInput({ role: 'editor' })))).status).toBe(400)
			expect((await status(w.ask(w.grantInput({ scope: { type: 'workspace', value: 'ws-1' } })))).status).toBe(400)
			// An expiry in the past, or further than 30 days ahead.
			expect(await status(w.ask(w.grantInput({ expiresAt: Math.floor(Date.now() / 1000) - 1 })))).toMatchObject({ status: 400 })
			expect(await status(w.ask(w.grantInput({ expiresAt: Math.floor(Date.now() / 1000) + 31 * DAY })))).toMatchObject({ status: 400 })
			// `refuse` refuses it to an agent at all; `off` (an unprotected environment) has nothing to approve.
			await w.protect('prod', { ...STRICT_POLICY, 'agent-grants': 'refuse' })
			expect((await status(w.ask())).status).toBe(403)
			const off = await status(w.ask(w.grantInput({ env: 'stage' })))
			expect(off.status).toBe(409)
			expect(off.message).toContain('agent-grants')
			expect(await w.db.approvalRequests.listPending(100)).toEqual([])
		})

		test("the requester's own request shows nothing Control read from IAM, and a principal IAM does not know reads the same", async () => {
			const w = await world()
			await w.iam.grants.createGrant({ principalId: w.grantee.id, app: APP, roleKey: 'reader' })
			const expiresAt = Math.floor(Date.now() / 1000) + 7 * DAY
			const known = await w.ask(w.grantInput({ expiresAt }))
			// Not refused at creation: a refusal would tell a principal IAM knows from one it does not.
			const unknown = await w.ask(w.grantInput({ expiresAt, principalId: 'p-nobody' }))

			const kim = w.agent('kim')
			const own = await getApprovalRequestUseCase(kim, known.id)
			const ownText = JSON.stringify(own.description)
			expect(ownText).not.toContain('cy@example.test')
			expect(ownText).not.toContain('reader')
			expect(own.description.facts.map((fact) => fact.label)).not.toContain('Holds now')
			expect(own.description.role).toBeUndefined()
			const ownUnknown = await getApprovalRequestUseCase(kim, unknown.id)
			const same = (text: string, principalId: string) => text.replaceAll(principalId, '<principal>')
			expect(same(JSON.stringify(ownUnknown.description), 'p-nobody')).toBe(same(ownText, w.grantee.id))

			// The administrator who decides sees both as IAM holds them.
			const ada = await w.person(w.ada, 'ada')
			const shown = await getApprovalRequestUseCase(ada, known.id)
			expect(shown.description.summary.map((part) => part.text).join('')).toContain('cy@example.test')
			// The expiry is a time the page formats, in the summary and in its fact.
			expect(shown.description.summary.filter((part) => part.at === expiresAt)).toHaveLength(1)
			expect(shown.description.facts.find((fact) => fact.label === 'Expires')?.value).toMatchObject({ at: expiresAt, agent: false })
			expect(shown.description.facts.find((fact) => fact.label === 'Holds now')?.value.text).toContain('reader')
			const shownUnknown = await getApprovalRequestUseCase(ada, unknown.id)
			expect(shownUnknown.description.facts.find((fact) => fact.label === 'Holds now')?.value.text).toBe('IAM knows no such principal')
			// Approved anyway, IAM refuses it and nothing is granted.
			expect((await w.decide(unknown.id, 'approve', w.ada, 'ada')).state).toBe('failed')
			expect((await w.grantsAt()).map((grant) => grant.role_key)).toEqual(['reader'])
		})

		test('only an IAM administrator of the application decides it; access.approve in Control alone does not', async () => {
			const w = await world()
			const created = await w.ask()
			expect(await status(getApprovalRequestUseCase(await w.person(w.eve, 'eve'), created.id))).toMatchObject({ status: 404 })
			expect((await listApprovalRequestsUseCase(await w.person(w.eve, 'eve'))).items).toEqual([])
			expect(await status(w.decide(created.id, 'approve', w.eve, 'eve'))).toMatchObject({ status: 404 })
			expect((await listApprovalRequestsUseCase(await w.person(w.bob, 'bob'))).items.map((item) => item.id)).toEqual([created.id])
		})

		test('an administrator IAM cannot be asked about is told so (503), never that the request does not exist', async () => {
			const w = await world()
			const created = await w.ask()
			const unreachable = async (transport: HttpService): Promise<ApprovalRequestContext> => {
				const ada = await w.person(w.ada, 'ada')
				const iamApprover = consoleIamApprover(transport, ada.admission.request)
				if (iamApprover === null) throw new Error('no console token')
				return { ...ada, iamApprover }
			}
			const outages: HttpService[] = [
				{ fetch: () => Promise.reject(new Error('connection refused')) },
				{ fetch: () => Promise.resolve(new Response('upstream unavailable', { status: 502 })) },
			]
			for (const outage of outages) {
				const read = await status(getApprovalRequestUseCase(await unreachable(outage), created.id))
				expect(read.status).toBe(503)
				expect(read.message).toContain('IAM')
				const decision = {
					id: created.id,
					decision: 'approve' as const,
					inputDigest: (await getApprovalRequestUseCase(await w.person(w.ada, 'ada'), created.id)).inputDigest,
				}
				expect((await status(decideApprovalRequestUseCase(await unreachable(outage), decision))).status).toBe(503)
				// The list leaves the request out, and says why.
				expect(await listApprovalRequestsUseCase(await unreachable(outage))).toEqual({ items: [], iamUnreachable: true })
				// The requester reads its own request still, shown no more than without IAM.
				const agentToken = new Request(`${CONSOLE}/api/rpc`, { method: 'POST', headers: { 'X-Fabrika-Token': 'agent-token' } })
				const agentIam = consoleIamApprover(outage, agentToken)
				if (agentIam === null) throw new Error('no token')
				const own = await getApprovalRequestUseCase({ ...w.agent('kim'), iamApprover: agentIam }, created.id)
				expect(own.description.facts.map((fact) => fact.label)).not.toContain('Holds now')
			}
			expect((await w.db.approvalRequests.get(created.id))?.state).toBe('pending')
			// A person IAM answers administers nothing still reads it as absent, with no word of IAM.
			expect(await status(getApprovalRequestUseCase(await w.person(w.eve, 'eve'), created.id))).toMatchObject({ status: 404 })
			expect(await listApprovalRequestsUseCase(await w.person(w.eve, 'eve'))).toEqual({ items: [] })
		})

		test("requesterMayApprove: false keeps the requester's own person from approving their agent's grant", async () => {
			const w = await world()
			await w.protect('prod', STRICT_POLICY, {
				...STRICT_SETTINGS,
				requesterMayApprove: { ...STRICT_SETTINGS.requesterMayApprove, 'agent-grants': false },
			})
			const created = await w.ask(w.grantInput(), w.agent(w.ada.id))
			expect(await status(w.decide(created.id, 'approve', w.ada, 'ada'))).toMatchObject({ status: 403 })
			expect(await w.grantsAt()).toEqual([])
			expect((await w.decide(created.id, 'approve', w.bob, 'bob')).state).toBe('executed')
			expect(await w.grantsAt()).toMatchObject([{ granted_by: w.bob.id }])
		})

		test('under stepUp: webauthn the decision carries a passkey assertion IAM verified', async () => {
			const w = await world()
			await w.protect('prod', STRICT_POLICY, { ...STRICT_SETTINGS, stepUp: { ...STRICT_SETTINGS.stepUp, 'agent-grants': 'webauthn' } })
			const authenticator = await w.registerPasskey(w.ada)
			const created = await w.ask()
			expect(await status(w.decide(created.id, 'approve', w.ada, 'ada'))).toMatchObject({ status: 403 })
			expect(await w.grantsAt()).toEqual([])

			const shown = await getApprovalRequestUseCase(await w.person(w.ada, 'ada'), created.id)
			const item = { id: created.id, decision: 'approve' as const, inputDigest: shown.inputDigest }
			const issued = await challengeApprovalRequestUseCase(await w.person(w.ada, 'ada'), item)
			if (issued.kind !== 'challenge') throw new Error('ada holds a passkey')
			const stepUp = { challengeId: issued.challenge.challengeId, credential: await authenticator.assert(issued.challenge.options, CONSOLE) }
			expect((await w.decide(created.id, 'approve', w.ada, 'ada', stepUp)).state).toBe('executed')
			expect(await w.grantsAt()).toMatchObject([{ role_key: 'staff', granted_by: w.ada.id }])
			expect((await w.db.approvalRequests.get(created.id))?.decided_step_up_credential_id).toBe(authenticator.credentialId)
		})

		test("an execution whose outcome was not seen is followed through IAM's grants and grant requests", async () => {
			const w = await world()
			const granted = await w.ask()
			const lost = await w.person(w.ada, 'ada')
			const approver = lost.iamApprover
			if (approver === undefined) throw new Error('no IAM approver')
			// IAM makes the grant, and the answer never reaches Control.
			const unseen = {
				...lost,
				iamApprover: {
					...approver,
					createGrant: async (input: Parameters<typeof approver.createGrant>[0]) => {
						await approver.createGrant(input)
						throw new Error('connection reset')
					},
				},
			}
			const read = await getApprovalRequestUseCase(lost, granted.id)
			expect((await decideApprovalRequestUseCase(unseen, { id: granted.id, decision: 'approve', inputDigest: read.inputDigest })).state).toBe('unknown')
			// The answer that never arrived: nothing was asked of IAM.
			const nothing = await w.ask(w.grantInput({ role: 'editor', scope: { type: 'workspace', value: 'ws-9' } }))
			const neverSent = {
				...lost,
				iamApprover: { ...approver, createGrant: () => Promise.reject(new Error('connection refused')) },
			}
			const readNothing = await getApprovalRequestUseCase(lost, nothing.id)
			expect((await decideApprovalRequestUseCase(neverSent, { id: nothing.id, decision: 'approve', inputDigest: readNothing.inputDigest })).state).toBe(
				'unknown',
			)

			// Without IAM the sweep cannot tell, and leaves both unknown.
			await sweepApprovalRequests({ repositories: w.db, lock: w.locks })
			expect((await w.db.approvalRequests.get(granted.id))?.state).toBe('unknown')

			const swept = await sweepApprovalRequests({ repositories: w.db, lock: w.locks, iamGrants: w.iamGrants, kinds: PRODUCTION_REQUEST_KINDS })
			expect(swept.settled).toBe(2)
			const settled = await w.db.approvalRequests.get(granted.id)
			expect(settled?.state).toBe('executed')
			expect(JSON.parse(settled?.result_json ?? 'null')).toMatchObject({ grant: { id: expect.any(String) } })
			expect((await w.db.approvalRequests.get(nothing.id))?.state).toBe('failed')
			expect((await w.grantsAt()).map((grant) => grant.role_key)).toEqual(['staff'])
		})

		test('following an unseen execution claims no grant another person made in the console', async () => {
			const w = await world()
			const created = await w.ask()
			const ada = await w.person(w.ada, 'ada')
			const approver = ada.iamApprover
			if (approver === undefined) throw new Error('no IAM approver')
			const neverSent = {
				...ada,
				iamApprover: { ...approver, createGrant: () => Promise.reject(new Error('connection refused')) },
			}
			const read = await getApprovalRequestUseCase(ada, created.id)
			expect((await decideApprovalRequestUseCase(neverSent, { id: created.id, decision: 'approve', inputDigest: read.inputDigest })).state).toBe(
				'unknown',
			)
			// Meanwhile another administrator grants the same role in the console.
			await w.iam.grants.createGrant({ principalId: w.grantee.id, app: APP, roleKey: 'staff', grantedBy: w.bob.id })

			await sweepApprovalRequests({ repositories: w.db, lock: w.locks, iamGrants: w.iamGrants })
			const followed = await w.db.approvalRequests.get(created.id)
			expect(followed?.state).toBe('failed')
			expect(followed?.result_json).toBeNull()
		})
	})
}

/** The id of IAM's grant request an executed request's result links. */
function grantRequestIdOf(result: JsonValue | undefined): string {
	const linked = typeof result === 'object' && result !== null && !Array.isArray(result) ? result['grantRequest'] : undefined
	const id = typeof linked === 'object' && linked !== null && !Array.isArray(linked) ? linked['id'] : undefined
	if (typeof id !== 'string') throw new Error(`no grant request in ${JSON.stringify(result)}`)
	return id
}
