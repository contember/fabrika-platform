// ADR-0083 §8: Control mirrors each environment's `credentials` mode to IAM, through IAM's own app in process, and IAM's
// key issuance to a machine caller meets it. After an upgrade IAM holds no mode and refuses; the maintenance pass writes
// every environment's, and a protection change writes its own. On SQLite always, and with IAM and Control both on
// Postgres when FABRIKA_TEST_POSTGRES_URL is set.

import { initRpc } from '@fabrika/app'
import { dispatchRpcRequest } from '@fabrika/app/service'
import type { AuthContext } from '@fabrika/auth'
import { permits } from '@fabrika/auth-core'
import { type ApprovalSettings, CONTROL_ACTIONS, STRICT_POLICY, STRICT_SETTINGS } from '@fabrika/control-contract'
import { type DeployLocks, type HttpService, SqlDeployLocks } from '@fabrika/platform'
import { unusedDatabase } from '@fabrika/platform/testing'
import type { ControlProvider, ProviderEnvelope } from '@fabrika/provider-contract'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { z } from 'zod'
import { adminTokenFor, createHarness as createIamHarness, TEST_SIGNING_KEYS } from '../../../iam/src/__tests__/helpers/harness'
import { APP, membershipFixture, NOTES_SCHEMA, ORIGIN as IAM_ORIGIN } from '../../../iam/src/__tests__/helpers/membership'
import { createPostgres as createIamPostgres, hasPostgres as hasIamPostgres } from '../../../iam/src/__tests__/helpers/postgres'
import { createIamApp } from '../../../iam/src/app'
import { createPostgresIamRepositories, type IamRepositories } from '../../../iam/src/db'
import type { RegistryUseCaseContext } from '../api/registry/context'
import { putAppEnvUseCase } from '../api/registry/environments'
import { registerAppUseCase } from '../api/registry/registration'
import { type ApprovalUseCaseContext, type GrantApprovalPort, setEnvironmentProtectionUseCase } from '../approval/api'
import { storedPolicy, storedSettings } from '../approval/categories'
import { convergeIamGates } from '../approval/iam-mirror'
import { type ControlRepositories, createControlRepositories } from '../db'
import { iamProvisioningClient } from '../iam-provisioning'
import { grantApprovalPort } from '../services'
import { createHarness, harnessDatabase } from './helpers/harness'
import { fixtureProtect } from './helpers/lock'
import { createPostgres, hasPostgres, skipReason } from './helpers/postgres'

if (!hasPostgres) console.warn(`approval-credentials-mirror.test.ts Postgres half ${skipReason}`)

const CONSOLE = 'https://console.example.test'
const PROVISIONING_KEY = 'px_provisioning-key-of-the-credentials-mirror-suite'
const ENVELOPE = JSON.stringify({ provider: 'harbor', version: 1, payload: {} })
const STAGE = 'notes@stage'
/** The console's audience in IAM, which a Control key is issued at. */
const CONSOLE_APP = 'vozka'
const REGISTRATION: { target: ProviderEnvelope; artifact: ProviderEnvelope } = {
	target: { provider: 'harbor', version: 1, payload: {} },
	artifact: { provider: 'harbor', version: 1, payload: {} },
}
const PROVIDER: ControlProvider = { id: 'harbor', deploy: () => Promise.resolve({ state: 'succeeded' }) }
/**
 * IAM released before the `credentials` mirror, served by the real RPC dispatcher: its `grantApproval.set` input is
 * strict and has no `credentials`, and it answers the grant gate it holds. `pass()` is a new port over the same IAM, as
 * each maintenance pass builds one; `requests` counts every call that reached IAM, refused ones included.
 */
function olderIam(): {
	readonly port: GrantApprovalPort
	pass(): GrantApprovalPort
	readonly writes: unknown[]
	readonly requests: { count: number }
} {
	const t = initRpc<Record<string, never>>()
	const held = new Map<string, { required: boolean; revision: number }>()
	const writes: unknown[] = []
	const router = t.router({
		grantApproval: t.router({
			set: t.procedure
				.input(z.object({ app: z.string(), required: z.boolean(), revision: z.number().int().nonnegative() }).strict())
				.mutation(({ input }) => {
					writes.push(input)
					const before = held.get(input.app)
					const now = before === undefined || before.revision <= input.revision ? { required: input.required, revision: input.revision } : before
					held.set(input.app, now)
					return { app: input.app, ...now }
				}),
		}),
	})
	const requests = { count: 0 }
	const pass = () =>
		grantApprovalPort(iamProvisioningClient({
			origin: IAM_ORIGIN,
			provisioningKey: PROVISIONING_KEY,
			fetch: (input, init) => {
				requests.count += 1
				return dispatchRpcRequest({ router, ctx: {}, request: new Request(input, init) })
			},
		}))
	return { port: pass(), pass, writes, requests }
}

/** IAM down: every write of the mirror fails. */
const UNREACHABLE: GrantApprovalPort = { set: () => Promise.reject(new Error('IAM is down')) }
/** No passkey on deciding a key, so a test may release `credentials` without a step-up. */
const NO_STEP_UP: ApprovalSettings = { ...STRICT_SETTINGS, stepUp: { ...STRICT_SETTINGS.stepUp, credentials: 'none' } }

interface Backends {
	readonly name: string
	readonly skip: boolean
	open(): Promise<{ iam: IamRepositories; control: ControlRepositories; locks: DeployLocks; close(): Promise<void> }>
}

const backends: readonly Backends[] = [
	{
		name: 'sqlite',
		skip: false,
		open: () => {
			const iam = createIamHarness()
			const control = createHarness()
			return Promise.resolve({
				iam: iam.repositories,
				control: control.repositories,
				locks: new SqlDeployLocks(harnessDatabase(control.repositories)),
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
		open: async () => {
			const iam = await createIamPostgres('iam_credentials_mirror')
			const control = await createPostgres('control_credentials_mirror')
			return {
				iam: createPostgresIamRepositories(iam.db),
				control: createControlRepositories(control.db),
				locks: new SqlDeployLocks(control.db),
				close: async () => {
					await iam.close()
					await control.close()
				},
			}
		},
	},
]

/** IAM's own app behind the transport Control's provisioning client uses. */
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

for (const backend of backends) {
	describe.skipIf(backend.skip)(`IAM's direct key issuance meets the mode Control mirrors (${backend.name})`, () => {
		let closing: (() => Promise<void>) | null = null
		afterEach(async () => {
			const close = closing
			closing = null
			await close?.()
		})

		async function world() {
			const opened = await backend.open()
			closing = opened.close
			const { control: db, locks } = opened
			const transport = iamTransport(opened.iam)
			const f = await membershipFixture(opened.iam)
			expect((await f.putSchema(NOTES_SCHEMA, STAGE)).status).toBe(200)
			const consoleSchema = { displayName: 'Console', scopes: [{ type: 'app', label: 'App' }], actions: [{ action: 'deploy.read' }], roles: {} }
			expect((await f.putSchema(consoleSchema, CONSOLE_APP)).status).toBe(200)
			const ada = await f.person('ada')
			await opened.iam.grants.createGrant({ principalId: ada.id, roleKey: 'admin' })

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
			await fixtureProtect(db.registry, locks, { appId: 'notes', env: 'prod' }, true, Date.now, storedPolicy(STRICT_POLICY), storedSettings(NO_STEP_UP))
			const grantApproval = grantApprovalPort(iamProvisioningClient({
				origin: IAM_ORIGIN,
				provisioningKey: PROVISIONING_KEY,
				fetch: (input, init) => transport.fetch(new Request(input, init)),
			}))

			async function send(bearer: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
				const response = await transport.fetch(
					new Request(`${IAM_ORIGIN}${path}`, {
						method: 'POST',
						headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
						body: JSON.stringify(body),
					}),
				)
				return { status: response.status, body: await response.json() }
			}
			const bootstrapped = await send(PROVISIONING_KEY, '/admin/api-keys', { label: 'ci administrator', type: 'service', roleKey: 'admin' })
			const machine = typeof bootstrapped.body === 'object' && bootstrapped.body !== null && 'apiKey' in bootstrapped.body
				? String(bootstrapped.body.apiKey)
				: ''
			/** What IAM answers a key at `app` provisioned by `bearer`: its HTTP status. */
			const provision = async (bearer: string, app: string): Promise<number> =>
				(await send(bearer, '/admin/rpc', {
					method: 'apiKeys.provision',
					input: { label: 'export', type: 'service', app, roleKey: 'support', expiresAt: Math.floor(Date.now() / 1000) + 3600 },
				})).status

			/** A person in the console holding `access.approve`, changing protection with the mirror wired to IAM. */
			const approver: AuthContext = {
				ok: true,
				principal: { id: ada.id, type: 'user', label: 'ada' },
				can: (action, scope) => permits([{ action: CONTROL_ACTIONS.ACCESS_APPROVE, scope: null, source: 'grant' }], action, scope),
				scopedTo: () => null,
				audit: () => Promise.resolve(),
			}
			const inConsole: ApprovalUseCaseContext = {
				repositories: db,
				auth: approver,
				queue: { send: () => Promise.resolve() },
				lock: locks,
				request: new Request(`${CONSOLE}/api/rpc`, { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-origin' } }),
				grantApproval,
			}
			const setCredentials = (credentials: 'off' | 'person' | 'refuse', port: GrantApprovalPort = grantApproval) =>
				setEnvironmentProtectionUseCase({ ...inConsole, grantApproval: port }, {
					appId: 'notes',
					env: 'prod',
					protected: true,
					policy: { ...STRICT_POLICY, credentials },
					settings: NO_STEP_UP,
				})
			const converge = (port: GrantApprovalPort = grantApproval) => convergeIamGates({ repositories: db, grantApproval: port })
			const adaToken = () => adminTokenFor(opened.iam, ada.id, { issuer: IAM_ORIGIN })
			/** What IAM answers a Control key reading every environment of `app`, provisioned by `bearer`. */
			const provisionAtControl = async (bearer: string, app: string): Promise<number> =>
				(await send(bearer, '/admin/rpc', {
					method: 'apiKeys.provision',
					input: {
						label: 'watcher',
						type: 'service',
						app: CONSOLE_APP,
						permissions: ['deploy.read'],
						scopeType: 'app',
						scopeValue: app,
						expiresAt: Math.floor(Date.now() / 1000) + 3600,
					},
				})).status
			/** An application environment IAM already holds a vocabulary for, mirrored `off`, as a deploy of it leaves it. */
			const knownToIam = async (app: string): Promise<void> => {
				expect((await f.putSchema(NOTES_SCHEMA, app)).status).toBe(200)
				await grantApproval.set(app, { grants: false, credentials: 'off' }, 0)
			}
			/** Registration's use cases as the console calls them, with the mirror wired to IAM unless `port` says otherwise. */
			const registry = (port: GrantApprovalPort | null = grantApproval): RegistryUseCaseContext => ({
				repositories: db,
				provider: PROVIDER,
				auth: approver,
				signal: new AbortController().signal,
				...(port === null ? {} : { grantApproval: port }),
			})
			const register = (id: string, env: string, port?: GrantApprovalPort | null) =>
				registerAppUseCase(registry(port), { id, repoUrl: `https://github.com/acme/${id}`, env, ...REGISTRATION })
			const putEnv = (appId: string, env: string, port?: GrantApprovalPort | null) => putAppEnvUseCase(registry(port), appId, env, REGISTRATION)

			/** The `credentials` mode IAM holds of each environment. */
			const iamModes = () => opened.iam.grantRequests.credentialsModes()

			return { db, grantApproval, machine, provision, provisionAtControl, setCredentials, converge, adaToken, knownToIam, register, putEnv, iamModes }
		}

		test('after an upgrade IAM refuses the machine key everywhere until the maintenance pass mirrors each mode', async () => {
			const w = await world()
			expect([await w.provision(w.machine, STAGE), await w.provision(w.machine, APP)]).toEqual([403, 403])
			expect(await w.converge()).toEqual({ written: 2, failed: 0 })
			// The unprotected environment is `off`; the protected one keeps the default, `person`.
			expect([await w.provision(w.machine, STAGE), await w.provision(w.machine, APP)]).toEqual([200, 403])
			expect(await w.converge()).toEqual({ written: 0, failed: 0 })
		})

		test('the pass marks an environment done only when IAM holds the revision and the mode it sent', async () => {
			const w = await world()
			// IAM holds notes@stage stricter, at a later revision than Control's: a tightening whose row write then failed.
			await w.grantApproval.set(STAGE, { grants: false, credentials: 'person' }, 5)
			expect(await w.converge()).toEqual({ written: 1, failed: 1 })
			// Not marked, so the next pass writes it again; IAM keeps the stricter mode meanwhile.
			expect(await w.converge()).toEqual({ written: 0, failed: 1 })
			expect(await w.provision(w.machine, STAGE)).toBe(403)
		})

		test('an older IAM that refuses the mode takes the grant gate alone, and the environment stays unmirrored', async () => {
			const w = await world()
			const older = olderIam()
			const warn = spyOn(console, 'warn').mockImplementation(() => {})
			try {
				// A protection change no longer fails: the grant gate is written without the mode.
				await w.setCredentials('refuse', older.port)
				expect(older.writes.length).toBeGreaterThan(0)
				expect(older.writes.every((write) => typeof write === 'object' && write !== null && !('credentials' in write))).toBe(true)
				// The pass writes every environment the same way and records none, so a pass after IAM's upgrade writes them.
				// It finds the older IAM once: one refused call and one line per pass, then one call per environment.
				for (let pass = 0; pass < 2; pass += 1) {
					const [requests, lines] = [older.requests.count, warn.mock.calls.length]
					expect(await w.converge(older.pass())).toEqual({ written: 0, failed: 2 })
					expect([older.requests.count - requests, warn.mock.calls.length - lines]).toEqual([3, 1])
				}
				expect(warn.mock.calls.every((call) => call.length === 1 && typeof call[0] === 'string')).toBe(true)
			} finally {
				warn.mockRestore()
			}
			expect(await w.converge()).toEqual({ written: 2, failed: 0 })
			expect(await w.provision(w.machine, APP)).toBe(403)
		})

		test('an application without `prod` counts it as `person`, and a registered or put `prod` reaches IAM before its row', async () => {
			const w = await world()
			// IAM knows shop@stage as `off` and no shop@prod: `prod` starts protected, so a machine caller issues no key
			// reading every environment of shop, before or after Control registers it there.
			await w.knownToIam('shop@stage')
			expect(await w.provisionAtControl(w.machine, 'shop')).toBe(403)
			await w.register('shop', 'prod')
			expect((await w.iamModes()).get('shop@prod')).toBe('person')
			expect(await w.provisionAtControl(w.machine, 'shop')).toBe(403)

			// `apps.environments.put` that creates one.
			await w.knownToIam('blog@stage')
			await w.register('blog', 'stage')
			expect(await w.provisionAtControl(w.machine, 'blog')).toBe(403)
			await w.putEnv('blog', 'prod')
			expect((await w.iamModes()).get('blog@prod')).toBe('person')
			expect(await w.provisionAtControl(w.machine, 'blog')).toBe(403)
		})

		test('IAM unreachable: an environment that starts protected is not created (503); one that does not is', async () => {
			const w = await world()
			await expect(w.register('down', 'prod', UNREACHABLE)).rejects.toMatchObject({ httpStatus: 503 })
			expect(await w.db.registry.getApp('down')).toBeNull()
			await w.register('down', 'stage', UNREACHABLE)
			await expect(w.putEnv('down', 'prod', UNREACHABLE)).rejects.toMatchObject({ httpStatus: 503 })
			expect(await w.db.registry.getAppEnv('down', 'prod')).toBeNull()
			// The maintenance pass stays the backstop for the one that was created.
			expect(await w.converge()).toMatchObject({ failed: 0 })
		})

		test('IAM holding a looser mode at a later revision: an environment that starts protected is not created (503)', async () => {
			const w = await world()
			// A later revision IAM keeps, as a stale write of a deleted environment of the same id would leave it.
			await w.grantApproval.set('shop@prod', { grants: false, credentials: 'off' }, 99)
			await expect(w.register('shop', 'prod')).rejects.toMatchObject({ httpStatus: 503, message: expect.stringContaining('a later revision') })
			expect(await w.db.registry.getApp('shop')).toBeNull()

			await w.register('blog', 'stage')
			await w.grantApproval.set('blog@prod', { grants: false, credentials: 'off' }, 99)
			await expect(w.putEnv('blog', 'prod')).rejects.toMatchObject({ httpStatus: 503 })
			expect(await w.db.registry.getAppEnv('blog', 'prod')).toBeNull()

			// One IAM holds as strictly as it starts is created.
			await w.grantApproval.set('blog@prod', { grants: false, credentials: 'person' }, 100)
			expect((await w.putEnv('blog', 'prod')).env).toBe('prod')
		})

		test('an older IAM, which answers no mode, does not fail a new environment that starts at `refuse`', async () => {
			const w = await world()
			// A deleted environment leaves its protection, so one created again at its coordinates starts at `refuse`.
			await w.setCredentials('refuse')
			expect(await w.db.registry.deleteAppEnv('notes', 'prod')).toBe(true)
			const older = olderIam()
			const warn = spyOn(console, 'warn').mockImplementation(() => {})
			try {
				expect((await w.putEnv('notes', 'prod', older.port)).env).toBe('prod')
			} finally {
				warn.mockRestore()
			}
			// The grant gate reached IAM; the maintenance pass writes the mode once IAM takes it.
			expect(older.writes).toContainEqual(expect.objectContaining({ app: APP }))
		})

		test('a looser mode IAM answers at the revision Control sent is refused (503) without claiming a later revision', async () => {
			const w = await world()
			const looser: GrantApprovalPort = { set: (_app, _gates, revision) => Promise.resolve({ revision, credentials: 'off' }) }
			const refused = await w.register('shop', 'prod', looser).then(() => null, (cause: unknown) => cause)
			expect(refused).toMatchObject({ httpStatus: 503 })
			const message = refused instanceof Error ? refused.message : ''
			expect([message.includes('looser'), message.includes('later revision')]).toEqual([true, false])
			expect(await w.db.registry.getApp('shop')).toBeNull()
		})

		test('a protection change carries the mode to IAM, and a person in the console issues whatever it is', async () => {
			const w = await world()
			await w.converge()
			expect(await w.provision(w.machine, APP)).toBe(403)
			await w.setCredentials('off')
			expect(await w.provision(w.machine, APP)).toBe(200)
			await w.setCredentials('refuse')
			expect(await w.provision(w.machine, APP)).toBe(403)
			expect(await w.provision(await w.adaToken(), APP)).toBe(200)
		})
	})
}
