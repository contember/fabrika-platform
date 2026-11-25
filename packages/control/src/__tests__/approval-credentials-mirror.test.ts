// ADR-0083 §8: Control mirrors each environment's `credentials` mode to IAM, through IAM's own app in process, and IAM's
// key issuance to a machine caller meets it. After an upgrade IAM holds no mode and refuses; the maintenance pass writes
// every environment's, and a protection change writes its own. On SQLite always, and with IAM and Control both on
// Postgres when FABRIKA_TEST_POSTGRES_URL is set.

import type { AuthContext } from '@fabrika/auth'
import { permits } from '@fabrika/auth-core'
import { type ApprovalSettings, CONTROL_ACTIONS, STRICT_POLICY, STRICT_SETTINGS } from '@fabrika/control-contract'
import { type DeployLocks, type HttpService, SqlDeployLocks } from '@fabrika/platform'
import { unusedDatabase } from '@fabrika/platform/testing'
import { afterEach, describe, expect, test } from 'bun:test'
import { adminTokenFor, createHarness as createIamHarness, TEST_SIGNING_KEYS } from '../../../iam/src/__tests__/helpers/harness'
import { APP, membershipFixture, NOTES_SCHEMA, ORIGIN as IAM_ORIGIN } from '../../../iam/src/__tests__/helpers/membership'
import { createPostgres as createIamPostgres, hasPostgres as hasIamPostgres } from '../../../iam/src/__tests__/helpers/postgres'
import { createIamApp } from '../../../iam/src/app'
import { createPostgresIamRepositories, type IamRepositories } from '../../../iam/src/db'
import { type ApprovalUseCaseContext, setEnvironmentProtectionUseCase } from '../approval/api'
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
			const setCredentials = (credentials: 'off' | 'person' | 'refuse') =>
				setEnvironmentProtectionUseCase(inConsole, {
					appId: 'notes',
					env: 'prod',
					protected: true,
					policy: { ...STRICT_POLICY, credentials },
					settings: NO_STEP_UP,
				})
			const converge = () => convergeIamGates({ repositories: db, grantApproval })
			const adaToken = () => adminTokenFor(opened.iam, ada.id, { issuer: IAM_ORIGIN })

			return { machine, provision, setCredentials, converge, adaToken }
		}

		test('after an upgrade IAM refuses the machine key everywhere until the maintenance pass mirrors each mode', async () => {
			const w = await world()
			expect([await w.provision(w.machine, STAGE), await w.provision(w.machine, APP)]).toEqual([403, 403])
			expect(await w.converge()).toEqual({ written: 2, failed: 0 })
			// The unprotected environment is `off`; the protected one keeps the default, `person`.
			expect([await w.provision(w.machine, STAGE), await w.provision(w.machine, APP)]).toEqual([200, 403])
			expect(await w.converge()).toEqual({ written: 0, failed: 0 })
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
