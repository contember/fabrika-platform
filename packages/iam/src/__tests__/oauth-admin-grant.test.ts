// The command-line client's `admin` device grant (ADR-0049 rule 2): a person approves at most an hour of IAM's
// administration, after a warning; the grant's token reaches `/admin/rpc` as `iam.admin` and no further, every call is
// recorded with the grant as its actor, and a revoked grant, a person without `iam.admin` and any other resource's token
// are refused.

import { OAUTH_CLI_CLIENT_ID, SESSION_COOKIE } from '@fabrika/auth-core'
import { IAM_ADMIN_OAUTH_SCOPE, IAM_ADMIN_RPC_PATH, IAM_APP_ID, iamAdminOAuthResource } from '@fabrika/iam-contract'
import { uuidv7 } from '@fabrika/platform'
import { unusedDatabase } from '@fabrika/platform/testing'
import { describe, expect, test } from 'bun:test'
import { createIamApp } from '../app'
import type { Env } from '../env'
import { prop } from '../json'
import { grantAuthority } from '../oauth'
import { parseOAuthConfig, withIamAdminResource } from '../oauth-config'
import { randomToken } from '../oidc'
import { hashToken } from '../secret'
import { createHarness, makeServicesFor, TEST_SIGNING_KEYS } from './helpers/harness'

const ORIGIN = 'https://iam.example.com'
const ADMIN_RESOURCE = `${ORIGIN}${IAM_ADMIN_RPC_PATH}`
const CONSOLE_RESOURCE = 'https://console.example.com/api/rpc'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const OAUTH_CONFIG = JSON.stringify({
	resources: [{
		app: 'vozka',
		resource: CONSOLE_RESOURCE,
		scopeGrants: [{ scope: 'create', permissions: [{ action: 'app.manage' }] }],
		client: 'cli',
	}],
	hosts: ['console.example.com'],
})
const OPS = {
	app: 'ops-tool',
	name: 'Operations tool',
	resource: 'https://ops.example.net',
	roles: [],
	clients: [{ clientId: 'https://ops.example.net/oauth/web.json', redirectUris: ['https://ops.example.net/callback'] }],
}

function env(repositories: Env['REPOSITORIES']): Env {
	return {
		DB: unusedDatabase,
		REPOSITORIES: repositories,
		HUMAN_EMAIL_DOMAINS: '[]',
		HUMAN_EMAILS: '[]',
		IAM_BOOTSTRAP_ADMINS: '[]',
		ENVIRONMENT: 'stage',
		ISSUER: ORIGIN,
		FABRIKA_IAM_SIGNING_KEYS: TEST_SIGNING_KEYS,
		FABRIKA_IAM_PROVISIONING_KEY: 'px_provisioning-key-of-the-admin-grant-suite',
		OIDC_ISSUER: 'https://idp.test',
		OIDC_CLIENT_ID: 'client',
		OIDC_CLIENT_SECRET: 'secret',
		OIDC_SCOPES: '',
		OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
		PASSWORD_ENABLED: 'true',
		OAUTH_CONFIG,
	}
}

async function setup() {
	const harness = createHarness()
	const { repositories } = harness
	const app = createIamApp()
	const send = (request: Request) => app.fetch(request, env(repositories), { waitUntil() {} })
	const form = (path: string, body: Record<string, string> | URLSearchParams, headers: Record<string, string> = {}) =>
		send(
			new Request(`${ORIGIN}${path}`, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
				body: body instanceof URLSearchParams ? body : new URLSearchParams(body),
			}),
		)

	/** A signed-in person: an IAM session and its cookie, with `admin` making them an installation administrator. */
	async function person(admin: boolean) {
		const principal = await repositories.principals.createUser(uuidv7(), `${uuidv7()}@example.com`)
		await repositories.grants.createGrant(
			admin ? { principalId: principal.id, roleKey: 'admin' } : { principalId: principal.id, app: 'vozka', permissions: ['app.manage'] },
		)
		const token = randomToken(32)
		await repositories.sessions.createSession({
			tokenHash: await hashToken(token),
			principalId: principal.id,
			authenticationMethod: 'password',
			expiresAt: Math.floor(Date.now() / 1000) + 7200,
		})
		return { principal, cookie: `${SESSION_COOKIE}=${token}` }
	}

	async function start(resource = ADMIN_RESOURCE, scope = IAM_ADMIN_OAUTH_SCOPE): Promise<{ deviceCode: string; userCode: string }> {
		const response = await form('/oauth/device_authorization', { client_id: OAUTH_CLI_CLIENT_ID, scope, resource })
		expect(response.status).toBe(200)
		const body: unknown = await response.json()
		const deviceCode = prop(body, 'device_code')
		const userCode = prop(body, 'user_code')
		if (typeof deviceCode !== 'string' || typeof userCode !== 'string') throw new Error('no device codes')
		return { deviceCode, userCode }
	}

	const page = (cookie: string, fields: Record<string, string>) =>
		form('/oauth/device', fields, { cookie, origin: 'null', 'sec-fetch-site': 'same-origin' })

	async function poll(deviceCode: string, resource = ADMIN_RESOURCE): Promise<{ access: string; refresh: string }> {
		harness.sqlite.run('UPDATE oauth_device_authorizations SET next_poll_at = 0')
		const response = await form('/oauth/token', { grant_type: DEVICE_GRANT, client_id: OAUTH_CLI_CLIENT_ID, device_code: deviceCode, resource })
		const body: unknown = await response.json()
		const access = prop(body, 'access_token')
		const refresh = prop(body, 'refresh_token')
		if (response.status !== 200 || typeof access !== 'string' || typeof refresh !== 'string') throw new Error(`no tokens (${response.status})`)
		return { access, refresh }
	}

	/** A person's approved `admin` grant: its access and refresh tokens. */
	async function adminGrant(cookie: string) {
		const codes = await start()
		expect((await page(cookie, { user_code: codes.userCode, decision: 'approve', lifetime: '3600' })).status).toBe(200)
		return poll(codes.deviceCode)
	}

	async function rpc(bearer: string, method: string, input: unknown): Promise<{ status: number; result: unknown }> {
		const response = await send(
			new Request(`${ORIGIN}/admin/rpc`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
				body: JSON.stringify({ method, input }),
			}),
		)
		const body: unknown = await response.json()
		return { status: response.status, result: prop(body, 'result') }
	}

	const audit = () =>
		harness.sqlite
			.query<{ action: string; principal_id: string | null; actor_id: string | null; actor_label: string | null; resource_id: string | null }, []>(
				'SELECT action, principal_id, actor_id, actor_label, resource_id FROM audit_events ORDER BY created_at, id',
			)
			.all()

	return { harness, repositories, form, person, start, page, poll, adminGrant, rpc, audit }
}

describe('the admin device grant', () => {
	test('IAM serves its administration resource beside the configured ones, and a config that names it fails the boot', () => {
		const config = withIamAdminResource(parseOAuthConfig(OAUTH_CONFIG), ORIGIN)
		expect(config?.resources.map((resource) => resource.resource)).toEqual([CONSOLE_RESOURCE, ADMIN_RESOURCE])
		expect(withIamAdminResource(null, ORIGIN)).toBeNull()
		const naming = JSON.stringify({ resources: [iamAdminOAuthResource(ORIGIN)] })
		expect(() => withIamAdminResource(parseOAuthConfig(naming), ORIGIN)).toThrow(/serves its administration resource itself/)
	})

	test('the consent page warns about installation administration and offers one hour alone', async () => {
		const f = await setup()
		const admin = await f.person(true)
		const codes = await f.start()
		const consent = await f.page(admin.cookie, { user_code: codes.userCode })
		const html = await consent.text()
		expect(consent.status).toBe(200)
		expect(html).toContain('full administration of identity and access')
		expect(html).toContain('<code>iam.admin</code>')
		expect(html).toContain('value="3600"')
		expect(html).not.toContain('value="86400"')
		expect(html).not.toContain('value="604800"')
	})

	test('an approval longer than an hour is refused and leaves the request pending', async () => {
		const f = await setup()
		const admin = await f.person(true)
		const codes = await f.start()
		const refused = await f.page(admin.cookie, { user_code: codes.userCode, decision: 'approve', lifetime: '86400' })
		expect(refused.status).toBe(400)
		expect(await refused.text()).toContain('one hour at most')
		f.harness.sqlite.run('UPDATE oauth_device_authorizations SET next_poll_at = 0')
		const pending = await f.form('/oauth/token', {
			grant_type: DEVICE_GRANT,
			client_id: OAUTH_CLI_CLIENT_ID,
			device_code: codes.deviceCode,
			resource: ADMIN_RESOURCE,
		})
		expect(prop(await pending.json(), 'error')).toBe('authorization_pending')
	})

	test("the grant's token puts and deletes an external application, and every call is recorded with the grant as its actor", async () => {
		const f = await setup()
		const admin = await f.person(true)
		const { access } = await f.adminGrant(admin.cookie)
		const grant = f.harness.sqlite.query<{ id: string; expires_at: number; created_at: number }, []>(
			`SELECT id, expires_at, created_at FROM oauth_grants WHERE client_id = '${OAUTH_CLI_CLIENT_ID}'`,
		).get()
		expect(grant === null ? null : grant.expires_at - grant.created_at).toBeLessThanOrEqual(3600)

		expect((await f.rpc(access, 'externalApps.put', OPS)).status).toBe(200)
		expect((await f.rpc(access, 'externalApps.get', { app: OPS.app })).result).toMatchObject({ app: OPS.app, resource: OPS.resource })
		expect((await f.rpc(access, 'externalApps.delete', { app: OPS.app })).status).toBe(200)
		expect((await f.rpc(access, 'externalApps.get', { app: OPS.app })).status).toBe(404)

		const actor = `oauth:${grant?.id}`
		const rows = f.audit()
		const accesses = rows.filter((row) => row.action === 'iam.admin.access')
		expect(accesses.map((row) => row.resource_id)).toEqual([
			'/admin/rpc#externalApps.put',
			'/admin/rpc#externalApps.get',
			'/admin/rpc#externalApps.delete',
			'/admin/rpc#externalApps.get',
		])
		expect(accesses.every((row) => row.principal_id === admin.principal.id && row.actor_id === actor && row.actor_label === OAUTH_CLI_CLIENT_ID))
			.toBe(true)
		const changes = rows.filter((row) =>
			row.action !== 'iam.admin.access' && row.principal_id === admin.principal.id && row.action !== 'iam.oauth.grant.create'
		)
		expect(changes.length).toBeGreaterThan(0)
		expect(changes.every((row) => row.actor_id === actor)).toBe(true)
	})

	test('a path that needs the person in the console refuses the grant, as it refuses a key', async () => {
		const f = await setup()
		const admin = await f.person(true)
		const { access } = await f.adminGrant(admin.cookie)
		expect((await f.rpc(access, 'scim.get', null)).status).toBe(403)
	})

	test('a person without iam.admin gets a token that administers nothing', async () => {
		const f = await setup()
		const user = await f.person(false)
		const { access } = await f.adminGrant(user.cookie)
		expect((await f.rpc(access, 'externalApps.list', null)).status).toBe(403)
	})

	test("another resource's token, a revoked grant and an ended sign-in are refused", async () => {
		const f = await setup()
		const admin = await f.person(true)
		const consoleCodes = await f.start(CONSOLE_RESOURCE, 'create')
		expect((await f.page(admin.cookie, { user_code: consoleCodes.userCode, decision: 'approve', lifetime: '3600' })).status).toBe(200)
		const consoleToken = await f.poll(consoleCodes.deviceCode, CONSOLE_RESOURCE)
		expect((await f.rpc(consoleToken.access, 'externalApps.list', null)).status).toBe(401)

		const revoked = await f.adminGrant(admin.cookie)
		expect((await f.rpc(revoked.access, 'externalApps.list', null)).status).toBe(200)
		expect((await f.form('/oauth/revoke', { client_id: OAUTH_CLI_CLIENT_ID, token: revoked.refresh, token_type_hint: 'refresh_token' })).status).toBe(
			200,
		)
		expect((await f.rpc(revoked.access, 'externalApps.list', null)).status).toBe(401)

		const ended = await f.adminGrant(admin.cookie)
		f.harness.sqlite.run('UPDATE sessions SET revoked_at = 1')
		expect((await f.rpc(ended.access, 'externalApps.list', null)).status).toBe(401)
	})

	test('an admin grant written for longer than an hour carries no authority', async () => {
		const f = await setup()
		const admin = await f.person(true)
		const session = f.harness.sqlite.query<{ id: string }, []>('SELECT id FROM sessions').get()
		if (session === null) throw new Error('no session')
		const now = Math.floor(Date.now() / 1000)
		const grant = {
			id: uuidv7(),
			principal_id: admin.principal.id,
			session_id: session.id,
			client_id: OAUTH_CLI_CLIENT_ID,
			app: IAM_APP_ID,
			resource: ADMIN_RESOURCE,
			resources: null,
			scopes: JSON.stringify([IAM_ADMIN_OAUTH_SCOPE]),
			created_at: now,
			expires_at: now + 7200,
			revoked_at: null,
			agent_label: null,
			passkey_confirmed_at: null,
			passkey_credential_id: null,
		}
		const services = makeServicesFor(f.repositories, {
			issuer: ORIGIN,
			authentication: { oidc: false, password: true },
			oauth: withIamAdminResource(parseOAuthConfig(OAUTH_CONFIG), ORIGIN),
		})
		expect(await grantAuthority(services, grant, now, ADMIN_RESOURCE)).toBeNull()
		expect(await grantAuthority(services, { ...grant, expires_at: now + 3600 }, now, ADMIN_RESOURCE)).not.toBeNull()
	})
})
