import { OAUTH_CLI_CLIENT_ID, parseAccessClaims } from '@fabrika/auth-core'
import { CONTROL_APP_ID, CONTROL_OPERATIONS_RPC_PATH, CONTROL_RPC_PATH } from '@fabrika/control-contract'
import { afterEach, describe, expect, test } from 'bun:test'
import { decodeJwt } from 'jose'
import type { OAuthConfig } from '../oauth-config'
import { handleOAuth } from '../oauth-http'
import { unixNow } from '../repositories/sql'
import { hashToken } from '../secret'
import type { Services } from '../services'
import { createHarness } from './helpers/harness'
import { ISSUER, oauthFixture, RESOURCE, SIGNING_ENV, tokenBody } from './helpers/oauth'

const SECOND_RESOURCE = 'https://control.example.test/api/rpc'
const OTHER_APP_RESOURCE = 'https://other.example.test/api/rpc'
const MANAGED_RESOURCE = 'https://control.example.test/managed'
const CONSOLE_RESOURCE = `https://console.example.test${CONTROL_RPC_PATH}`
const OPERATIONS_RESOURCE = `https://console.example.test${CONTROL_OPERATIONS_RPC_PATH}`
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const USER_CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/

type Fixture = Awaited<ReturnType<typeof oauthFixture>>
let active: Fixture | null = null

afterEach(() => {
	active?.restoreFetch()
	active = null
})

async function fixture() {
	const harness = createHarness()
	const f = await oauthFixture(harness.repositories)
	active = f
	// Beside the fixture's grants at app `alpha`, the person may create applications everywhere.
	await f.repositories.grants.createGrant({ principalId: f.principal.id, app: 'control', permissions: ['app.create'] })
	const scopeGrants = [
		{ scope: 'deploy', parameter: 'app', permissions: [{ action: 'source.workspace.read' }, { action: 'deploy.run' }] },
		{ scope: 'create', permissions: [{ action: 'app.create' }] },
	]
	const config: OAuthConfig = {
		hosts: [],
		resources: [
			{
				app: 'control',
				resource: RESOURCE,
				scopeGrants: [...scopeGrants, { scope: 'first-only', permissions: [{ action: 'deploy.run' }] }],
				client: 'cli',
			},
			{ app: 'control', resource: SECOND_RESOURCE, scopeGrants, client: 'cli' },
			{ app: 'other', resource: OTHER_APP_RESOURCE, scopeGrants, client: 'cli' },
			// Served to the managed clients only, so never through the device grant.
			{ app: 'control', resource: MANAGED_RESOURCE, scopeGrants },
			// The console's own resources, which the consent page names as the console declares them.
			{ app: CONTROL_APP_ID, resource: CONSOLE_RESOURCE, scopeGrants, client: 'cli' },
			{ app: CONTROL_APP_ID, resource: OPERATIONS_RESOURCE, scopeGrants, client: 'cli' },
		],
	}
	const services: Services = { ...f.services, config: { ...f.services.config, oauth: config } }
	const call = (request: Request, clientAddress: string | null = null) => handleOAuth(request, services, SIGNING_ENV, 'req-device', clientAddress)
	const form = (path: string, body: URLSearchParams, headers: Record<string, string> = {}) =>
		call(new Request(`${ISSUER}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body }))

	function start(
		scope = 'deploy:alpha',
		resources: string[] = [RESOURCE, SECOND_RESOURCE],
		extra: [string, string][] = [],
		clientAddress: string | null = null,
	) {
		const body = new URLSearchParams([
			['client_id', OAUTH_CLI_CLIENT_ID],
			['scope', scope],
			...resources.map((r): [string, string] => ['resource', r]),
			...extra,
		])
		return call(
			new Request(`${ISSUER}/oauth/device_authorization`, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body,
			}),
			clientAddress,
		)
	}

	async function started(scope?: string): Promise<{ device_code: string; user_code: string; verification_uri_complete: string }> {
		const response = await start(scope)
		expect(response.status).toBe(200)
		const body: unknown = await response.json()
		const deviceCode = Reflect.get(Object(body), 'device_code')
		const userCode = Reflect.get(Object(body), 'user_code')
		const complete = Reflect.get(Object(body), 'verification_uri_complete')
		if (typeof deviceCode !== 'string' || typeof userCode !== 'string' || typeof complete !== 'string') throw new Error('no device codes')
		return { device_code: deviceCode, user_code: userCode, verification_uri_complete: complete }
	}

	/** One poll; `onTime` first moves the attempt's next allowed poll to now, as if the interval had passed. */
	function poll(deviceCode: string, resource = RESOURCE, onTime = true, clientId = OAUTH_CLI_CLIENT_ID) {
		if (onTime) harness.sqlite.run('UPDATE oauth_device_authorizations SET next_poll_at = 0')
		return form('/oauth/token', new URLSearchParams({ grant_type: DEVICE_GRANT, client_id: clientId, device_code: deviceCode, resource }))
	}

	const page = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
		form('/oauth/device', new URLSearchParams(fields), { cookie: f.cookie, origin: 'null', 'sec-fetch-site': 'same-origin', ...headers })

	const refresh = (refreshToken: string, resource: string) =>
		form('/oauth/token', new URLSearchParams({ grant_type: 'refresh_token', client_id: OAUTH_CLI_CLIENT_ID, refresh_token: refreshToken, resource }))

	return { f, harness, services, call, start, started, poll, page, refresh }
}

async function userCode(started: Promise<Response>): Promise<string> {
	const code = Reflect.get(Object(await (await started).json()), 'user_code')
	if (typeof code !== 'string') throw new Error('no user code')
	return code
}

async function errorOf(response: Response): Promise<unknown> {
	return Reflect.get(Object(await response.json()), 'error')
}

describe('the device authorization endpoint', () => {
	test('answers RFC 8628 codes for the CLI client, and the device waits until a person decides', async () => {
		const { started, poll } = await fixture()
		const codes = await started()
		expect(codes.user_code).toMatch(USER_CODE)
		expect(codes.verification_uri_complete).toBe(`${ISSUER}/oauth/device?user_code=${codes.user_code}`)

		expect(await errorOf(await poll(codes.device_code))).toBe('authorization_pending')
		// Polling again before the interval has passed slows the device down.
		expect(await errorOf(await poll(codes.device_code, RESOURCE, false))).toBe('slow_down')
	})

	test('refuses another client, an assertion, an unknown or foreign resource, a scope one resource lacks, and repeated parameters', async () => {
		const { f, start } = await fixture()
		const managed = await start('deploy:alpha', [RESOURCE], [])
		expect(managed.status).toBe(200)
		const asManaged = await start('deploy:alpha', [RESOURCE], [['client_id', f.clientId]])
		expect(await errorOf(asManaged)).toBe('invalid_request')

		const body = new URLSearchParams([['client_id', f.clientId], ['scope', 'deploy:alpha'], ['resource', RESOURCE]])
		const other = await f.call(
			new Request(`${ISSUER}/oauth/device_authorization`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }),
		)
		expect(await errorOf(other)).toBe('unauthorized_client')

		const asserted = await start('deploy:alpha', [RESOURCE], [
			['client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'],
			['client_assertion', 'a.b.c'],
		])
		expect(asserted.status).toBe(401)
		expect(await errorOf(await start('deploy:alpha', ['https://control.example.test/unknown']))).toBe('invalid_target')
		expect(await errorOf(await start('deploy:alpha', [RESOURCE, OTHER_APP_RESOURCE]))).toBe('invalid_target')
		expect(await errorOf(await start('deploy:alpha', [MANAGED_RESOURCE]))).toBe('invalid_target')
		expect(await errorOf(await start('first-only'))).toBe('invalid_scope')
		expect(await errorOf(await start('deploy'))).toBe('invalid_scope')
		expect(await errorOf(await start('deploy:alpha', [RESOURCE, RESOURCE]))).toBe('invalid_request')
	})

	test('gives the CLI five minutes to decide, polled every five seconds', async () => {
		const { harness, start } = await fixture()
		const body: unknown = await (await start()).json()
		expect(Reflect.get(Object(body), 'expires_in')).toBe(300)
		expect(Reflect.get(Object(body), 'interval')).toBe(5)
		const row = harness.sqlite.query<{ created_at: number; expires_at: number }, []>('SELECT created_at, expires_at FROM oauth_device_authorizations')
			.get()
		expect((row?.expires_at ?? 0) - (row?.created_at ?? 0)).toBe(300)
	})

	test('limits starts per client address, and a start refused there does not count against the shared bucket', async () => {
		const { f, start } = await fixture()
		for (let attempt = 0; attempt < 30; attempt++) expect((await start('deploy:alpha', [RESOURCE], [], '203.0.113.7')).status).toBe(200)
		const refused = await start('deploy:alpha', [RESOURCE], [], '203.0.113.7')
		expect(refused.status).toBe(429)
		expect(refused.headers.get('retry-after')).toBe('60')
		for (let attempt = 0; attempt < 10; attempt++) await start('deploy:alpha', [RESOURCE], [], '203.0.113.7')
		const shared = await f.repositories.passwords.getLoginThrottle(await hashToken(`oauth-device-start:client:${OAUTH_CLI_CLIENT_ID}`))
		expect(shared?.attempt_count).toBe(30)
		// Another address, and a composition that names none, are not held by that address's bucket.
		expect((await start('deploy:alpha', [RESOURCE], [], '203.0.113.8')).status).toBe(200)
		expect((await start('deploy:alpha', [RESOURCE], [], null)).status).toBe(200)
	})
})

describe('the device page', () => {
	test('sends a signed-out browser to sign in and back, and renders the entry form prefilled', async () => {
		const { f, started, call } = await fixture()
		const codes = await started()
		const signedOut = await call(new Request(codes.verification_uri_complete))
		expect(signedOut.status).toBe(302)
		expect(signedOut.headers.get('location')).toBe(`${ISSUER}/auth/login?redirect=${encodeURIComponent(codes.verification_uri_complete)}`)
		const form = await call(new Request(codes.verification_uri_complete, { headers: { cookie: f.cookie } }))
		expect(form.status).toBe(200)
		expect(await form.text()).toContain(`value="${codes.user_code}"`)
	})

	test('shows what the device asks for, narrowed to what the person holds, and warns about a scope bound to no value', async () => {
		const { started, page } = await fixture()
		const narrow = await started('deploy:alpha')
		const consent = await (await page({ user_code: narrow.user_code.toLowerCase() })).text()
		expect(consent).toContain('<li><code>deploy.run</code> <span>app alpha</span></li>')
		expect(consent).toContain('<li><code>source.workspace.read</code> <span>app alpha</span></li>')
		expect(consent).not.toContain('Warning')

		const wide = await started('create')
		const warned = await (await page({ user_code: wide.user_code })).text()
		expect(warned).toContain('<strong>Warning:</strong> <code>create</code>')
		expect(warned).toContain('<li><code>app.create</code> <span>everywhere</span></li>')
	})

	test('names each resource above its address, sets each lifetime beside its radio, and puts both decisions in one row', async () => {
		const { start, page } = await fixture()
		const ownApp = await (await page({ user_code: await userCode(start('deploy:alpha', [RESOURCE, SECOND_RESOURCE])) })).text()
		// A resource the console does not declare is named by its path, which tells two resources of one app apart.
		expect(ownApp).toContain(`<h2>/mcp</h2><p class="uri">${RESOURCE}</p>`)
		expect(ownApp).toContain(`<h2>/api/rpc</h2><p class="uri">${SECOND_RESOURCE}</p>`)
		expect(ownApp).toContain(
			'<fieldset><legend>Access lasts</legend><label class="choice"><input type="radio" name="lifetime" value="3600" checked> 1 hour</label>',
		)
		expect(ownApp.match(/<label class="choice"><input type="radio" name="lifetime"/g)?.length).toBe(3)
		expect(ownApp).toMatch(
			/<div class="actions"><button name="decision" value="approve">Allow<\/button>\s*<button name="decision" value="deny">Deny<\/button><\/div>/,
		)

		const consoleRpc = await (await page({ user_code: await userCode(start('deploy:alpha', [CONSOLE_RESOURCE, OPERATIONS_RESOURCE])) })).text()
		expect(consoleRpc).toContain(`<h2>Console</h2><p class="uri">${CONSOLE_RESOURCE}</p>`)
		expect(consoleRpc).toContain(`<h2>Operations</h2><p class="uri">${OPERATIONS_RESOURCE}</p>`)
	})

	test('refuses a cross-site submission and blocks code entry after twenty entries', async () => {
		const { started, page } = await fixture()
		const codes = await started()
		expect((await page({ user_code: codes.user_code }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
		for (let attempt = 0; attempt < 20; attempt++) expect((await page({ user_code: 'BBBB-BBBB' })).status).toBe(400)
		expect((await page({ user_code: 'BBBB-BBBB' })).status).toBe(429)
		// Blocked: even the right code is refused now.
		expect((await page({ user_code: codes.user_code })).status).toBe(429)
	})
})

describe('a device grant', () => {
	test('approved for a day, gives a token per resource bound to the approving session, and a replayed device code revokes it', async () => {
		const { f, harness, started, poll, page, refresh } = await fixture()
		const sessionEnd = unixNow() + 30 * 86_400
		harness.sqlite.run('UPDATE sessions SET expires_at = ? WHERE id = ?', [sessionEnd, f.sessionId])
		const codes = await started()
		const approved = await page({ user_code: codes.user_code, decision: 'approve', lifetime: '86400' })
		expect(approved.status).toBe(200)

		// A resource the grant does not name is refused without spending the approval.
		expect(await errorOf(await poll(codes.device_code, OTHER_APP_RESOURCE))).toBe('invalid_grant')
		const first = await tokenBody(await poll(codes.device_code))
		const claims = parseAccessClaims(decodeJwt(first.access_token))
		expect(claims?.aud).toBe(RESOURCE)
		expect(claims?.perms.map((entry) => `${entry.action}@${entry.scope?.type}:${entry.scope?.value}`).sort()).toEqual([
			'deploy.run@app:alpha',
			'source.workspace.read@app:alpha',
		])
		const grantId = claims?.oauth?.grantId ?? ''
		const grant = await f.repositories.oauth.grant(grantId)
		expect(grant?.session_id).toBe(f.sessionId)
		expect(grant?.client_id).toBe(OAUTH_CLI_CLIENT_ID)
		expect(grant?.expires_at).toBeGreaterThanOrEqual(unixNow() + 86_400 - 5)
		expect(grant?.expires_at).toBeLessThanOrEqual(unixNow() + 86_400)
		const recorded = harness.sqlite.query<{ n: number }, [string]>(
			"SELECT COUNT(*) AS n FROM audit_events WHERE action = 'iam.oauth.grant.create' AND resource_id = ?",
		).get(grantId)
		expect(recorded?.n).toBe(1)

		const second = await tokenBody(await refresh(first.refresh_token ?? '', SECOND_RESOURCE))
		expect(parseAccessClaims(decodeJwt(second.access_token))?.aud).toBe(SECOND_RESOURCE)

		expect(await errorOf(await poll(codes.device_code))).toBe('invalid_grant')
		expect((await f.repositories.oauth.grant(grantId))?.revoked_at).not.toBeNull()
	})

	test('writes nothing when the approving sign-in ended before the device redeemed it', async () => {
		const { f, harness, started, poll, page } = await fixture()
		const codes = await started()
		await page({ user_code: codes.user_code, decision: 'approve', lifetime: '3600' })
		harness.sqlite.run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [unixNow(), f.sessionId])
		expect(await errorOf(await poll(codes.device_code))).toBe('invalid_grant')
		expect(await f.repositories.oauth.listForPrincipal(f.principal.id, undefined, 10)).toEqual([])
		const recorded = harness.sqlite.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'iam.oauth.grant.create'").get()
		expect(recorded?.n).toBe(0)
	})

	test('ends with the approving sign-in when that ends before the chosen lifetime', async () => {
		const { f, started, poll, page } = await fixture()
		const codes = await started()
		await page({ user_code: codes.user_code, decision: 'approve', lifetime: '604800' })
		const token = await tokenBody(await poll(codes.device_code))
		const grant = await f.repositories.oauth.grant(parseAccessClaims(decodeJwt(token.access_token))?.oauth?.grantId ?? '')
		// The fixture's sign-in ends in an hour.
		expect(grant?.expires_at).toBeLessThanOrEqual(unixNow() + 3600)
	})

	test('is refused when denied, when it expired, for another lifetime, and for a client other than the CLI', async () => {
		const { f, harness, started, poll, page } = await fixture()
		const denied = await started()
		expect((await page({ user_code: denied.user_code, decision: 'approve', lifetime: '999' })).status).toBe(400)
		expect((await page({ user_code: denied.user_code, decision: 'deny' })).status).toBe(200)
		expect(await errorOf(await poll(denied.device_code))).toBe('access_denied')

		const expired = await started()
		await page({ user_code: expired.user_code, decision: 'approve', lifetime: '3600' })
		harness.sqlite.run('UPDATE oauth_device_authorizations SET expires_at = ?', [unixNow() - 1])
		expect(await errorOf(await poll(expired.device_code))).toBe('expired_token')

		const foreign = await started()
		expect(await errorOf(await poll(foreign.device_code, RESOURCE, true, f.clientId))).toBe('unauthorized_client')
	})
})
