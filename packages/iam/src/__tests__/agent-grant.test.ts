// An agent's device grant at an application environment (ADR-0090), on both engines: the device start and its refusals,
// the device page's application case, the resource token, and the exchange for the person's narrowed token with `act`.
// Postgres runs when FABRIKA_TEST_POSTGRES_URL is set and skips cleanly otherwise.

import { AGENT_CLIENT_ID, buildResourceAccessClaims, OAUTH_CLI_CLIENT_ID, parseAccessClaims, permits } from '@fabrika/auth-core'
import { uuidv7 } from '@fabrika/platform'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { decodeJwt } from 'jose'
import { mintFromGrant } from '../agent-grant'
import { createPostgresIamRepositories, type IamRepositories, type OAuthGrantRow } from '../db'
import { mintForGrant } from '../oauth'
import { startDeviceAuthorization } from '../oauth-device'
import { unixNow } from '../repositories/sql'
import { hashToken } from '../secret'
import { getSigner } from '../signing'
import { createHarness } from './helpers/harness'
import { ISSUER, oauthFixture, SIGNING_ENV } from './helpers/oauth'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

if (!hasPostgres) {
	console.warn(`agent-grant.test.ts ${skipReason}`)
}

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const ACTIONS = ['task.read', 'task.write', 'task.list', 'task.archive']

let postgres: PostgresFixture | null = null
let active: Awaited<ReturnType<typeof oauthFixture>> | null = null

beforeAll(async () => {
	if (hasPostgres) postgres = await createPostgres('iam_agent_grant')
})
afterEach(() => {
	active?.restoreFetch()
	active = null
})
afterAll(async () => {
	await postgres?.close()
})

const engines: { name: string; repositories: () => IamRepositories; skip: boolean }[] = [
	{ name: 'SQLite', repositories: () => createHarness().repositories, skip: false },
	{
		name: 'Postgres',
		repositories: () => {
			if (postgres === null) throw new Error('postgres')
			return createPostgresIamRepositories(postgres.db)
		},
		skip: !hasPostgres,
	},
]

function reconcile(repositories: IamRepositories, app: string, options: { agentCallers: boolean; project?: boolean }): Promise<void> {
	return repositories.appSchema.reconcileAppSchema({
		app,
		scopes: options.project === false ? [] : [{ scopeType: 'project', label: 'Project', values: [{ value: 'a', label: 'Alpha' }] }],
		actions: ACTIONS.map((action) => ({ action })),
		roles: [],
		contract: true,
		agentCallers: options.agentCallers,
	})
}

/**
 * A person with a global `task.list`, `task.read` and `task.write` in project `a` and `task.read` in project `b` at an
 * application environment whose schema admits `agent` and whose origin is registered for it alone.
 */
async function agentFixture(repositories: IamRepositories) {
	const f = await oauthFixture(repositories)
	active = f
	const tag = uuidv7().slice(-12)
	const app = `tasks-${tag}@prod`
	const origin = `https://tasks-${tag}.example.test`
	await reconcile(repositories, app, { agentCallers: true })
	await repositories.handoff.setReturnOrigins(app, [origin])
	await repositories.grants.createGrant({ principalId: f.principal.id, app, permissions: ['task.list'] })
	await repositories.grants.createGrant({
		principalId: f.principal.id,
		app,
		permissions: ['task.read', 'task.write'],
		scopeType: 'project',
		scopeValue: 'a',
	})
	await repositories.grants.createGrant({ principalId: f.principal.id, app, permissions: ['task.read'], scopeType: 'project', scopeValue: 'b' })

	const form = (path: string, fields: [string, string][], headers: Record<string, string> = {}) =>
		f.call(
			new Request(`${ISSUER}${path}`, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
				body: new URLSearchParams(fields),
			}),
		)
	const start = (fields: Record<string, string>, resources: string[] = [origin], clientId = AGENT_CLIENT_ID) =>
		form('/oauth/device_authorization', [
			['client_id', clientId],
			...Object.entries(fields),
			...resources.map((resource): [string, string] => ['resource', resource]),
		])
	const page = (fields: Record<string, string>) =>
		form('/oauth/device', Object.entries(fields), { cookie: f.cookie, origin: 'null', 'sec-fetch-site': 'same-origin' })
	const poll = (deviceCode: string) =>
		form('/oauth/token', [['grant_type', DEVICE_GRANT], ['client_id', AGENT_CLIENT_ID], ['device_code', deviceCode], ['resource', origin]])

	async function started(fields: Record<string, string>): Promise<{ deviceCode: string; userCode: string }> {
		const response = await start(fields)
		expect(response.status).toBe(200)
		const body: unknown = await response.json()
		const deviceCode = Reflect.get(Object(body), 'device_code')
		const userCode = Reflect.get(Object(body), 'user_code')
		if (typeof deviceCode !== 'string' || typeof userCode !== 'string') throw new Error('no device codes')
		return { deviceCode, userCode }
	}

	/** A grant of the agent client as the device flow records one, and the resource token it mints now. */
	async function directGrant(scope: string, options: { sessionId?: string; label?: string | null; expiresAt?: number } = {}) {
		const now = unixNow()
		const grant: OAuthGrantRow = {
			id: uuidv7(),
			principal_id: f.principal.id,
			session_id: options.sessionId ?? f.sessionId,
			client_id: AGENT_CLIENT_ID,
			app,
			resource: origin,
			resources: JSON.stringify([origin]),
			scopes: JSON.stringify([scope]),
			created_at: now,
			expires_at: options.expiresAt ?? now + 1800,
			revoked_at: null,
			agent_label: options.label === undefined ? 'release bot' : options.label,
		}
		await repositories.oauth.createGrant(grant, {
			token_hash: uuidv7(),
			redirect_uri: 'https://unused.example.test/callback',
			challenge: 'c'.repeat(43),
			expires_at: now + 60,
		})
		const access = await mintForGrant(f.services, SIGNING_ENV, grant, origin, now)
		if (access === null) throw new Error('the grant minted no resource token')
		return { grant, token: access.access_token }
	}

	/** A resource token of the agent client for `grant` that lives five minutes, whatever the grant and its login allow. */
	async function fiveMinuteToken(grant: OAuthGrantRow, scope: string): Promise<string> {
		const now = unixNow()
		return (await getSigner(SIGNING_ENV)).signResourceToken(buildResourceAccessClaims({
			iss: ISSUER,
			app,
			resource: origin,
			subject: f.principal.id,
			label: f.principal.label,
			permissions: [],
			issuedAt: now,
			expiresAt: now + 300,
			clientId: AGENT_CLIENT_ID,
			scopes: [scope],
			grantId: grant.id,
			tokenId: uuidv7(),
		}))
	}

	/** The device flow through approval of `scope`: the first resource token, its refresh token and the grant id. */
	async function approved(scope: string): Promise<{ access: string; refresh: string; grantId: string }> {
		const { deviceCode, userCode } = await started({ scope })
		expect((await page({ user_code: userCode, decision: 'approve', lifetime: '3600', scope })).status).toBe(200)
		const tokens: unknown = await (await poll(deviceCode)).json()
		const access = Reflect.get(Object(tokens), 'access_token')
		const refresh = Reflect.get(Object(tokens), 'refresh_token')
		const grantId = typeof access === 'string' ? parseAccessClaims(decodeJwt(access))?.oauth?.grantId : undefined
		if (typeof access !== 'string' || typeof refresh !== 'string' || grantId === undefined) throw new Error('no tokens')
		return { access, refresh, grantId }
	}

	const exchange = (token: string, overrides: { app?: string; resource?: string } = {}) =>
		mintFromGrant(f.services, SIGNING_ENV, { app, resource: origin, token, requestId: 'req-agent', ...overrides }).then((outcome) => outcome.result)

	return { f, repositories, app, origin, start, page, poll, started, approved, directGrant, fiveMinuteToken, exchange }
}

async function json(response: Response): Promise<unknown> {
	return response.json()
}

function field(value: unknown, name: string): unknown {
	return Reflect.get(Object(value), name)
}

for (const engine of engines) {
	describe.skipIf(engine.skip)(`an agent's device grant at an application (${engine.name})`, () => {
		test('the device flow gives a grant narrowed to one project, and the exchange gives the person narrowed, with act', async () => {
			const a = await agentFixture(engine.repositories())
			const { deviceCode, userCode } = await a.started({ scope: 'read:project=a', agent_label: 'release bot' })

			const consent = await a.page({ user_code: userCode })
			const html = await consent.text()
			expect(consent.status).toBe(200)
			expect(html).toContain('<q>release bot</q>')
			expect(html).toContain('These are its own words')
			expect(html).toContain('<strong>Alpha</strong> (<code>a</code>)')
			expect(html).toContain('environment <strong>prod</strong>')
			expect(html).toContain(a.origin)
			expect(html).toContain('name="scope" value="read:project=a"')
			// The actions it would get: the person's set narrowed to project a, the global grant moved there.
			expect(html).toContain('<code>task.list</code> <span>project a</span>')
			expect(html).not.toContain('project b')

			const approved = await a.page({ user_code: userCode, decision: 'approve', lifetime: '3600', scope: 'read:project=a' })
			expect(approved.status).toBe(200)
			const tokens = await json(await a.poll(deviceCode))
			expect(field(tokens, 'scope')).toBe('read:project=a')
			const access = field(tokens, 'access_token')
			const refresh = field(tokens, 'refresh_token')
			if (typeof access !== 'string' || typeof refresh !== 'string') throw new Error('no tokens')

			// The resource token names the origin and the environment and carries no permission (ADR-0090 §1).
			const resourceClaims = parseAccessClaims(decodeJwt(access))
			expect(resourceClaims?.aud).toBe(a.origin)
			expect(resourceClaims?.perms).toEqual([])
			expect(resourceClaims?.oauth).toMatchObject({ app: a.app, clientId: AGENT_CLIENT_ID, scopes: ['read:project=a'] })
			const grantId = resourceClaims?.oauth?.grantId ?? ''
			expect((await a.repositories.oauth.grant(grantId))?.agent_label).toBe('release bot')
			const [created] = await a.repositories.audit.listAuditEvents({ resourceType: 'oauth_grant', resourceId: grantId, limit: 5 })
			expect(JSON.parse(created?.metadata ?? 'null')).toMatchObject({
				clientId: AGENT_CLIENT_ID,
				agentLabel: 'release bot',
				sessionId: a.f.sessionId,
				expiresAt: expect.any(Number),
			})

			const exchanged = await a.exchange(access)
			if (!exchanged.ok) throw new Error(`refused: ${exchanged.reason}`)
			const claims = parseAccessClaims(decodeJwt(exchanged.token))
			expect(claims?.aud).toBe(a.app)
			expect(claims?.session).toBeUndefined()
			expect(claims?.act).toEqual({
				sub: AGENT_CLIENT_ID,
				grant: grantId,
				scope: { mode: 'read', within: { type: 'project', value: 'a' } },
				label: 'release bot',
			})
			expect(exchanged.expiresAt).toBeLessThanOrEqual(resourceClaims?.exp ?? 0)
			const perms = claims?.perms ?? []
			expect(perms.map((entry) => `${entry.action}@${entry.scope?.type}=${entry.scope?.value}`).sort()).toEqual([
				'task.list@project=a',
				'task.read@project=a',
				'task.write@project=a',
			])
			// Isolation: the person holds task.read at b and task.list everywhere; the token holds neither outside a.
			expect(permits(perms, 'task.read', { type: 'project', value: 'a' })).toBe(true)
			expect(permits(perms, 'task.read', { type: 'project', value: 'b' })).toBe(false)
			expect(permits(perms, 'task.list', { type: 'project', value: 'b' })).toBe(false)
			expect(permits(perms, 'task.list')).toBe(false)

			// The agent client refreshes, and RFC 7009 revocation ends the grant at its next exchange.
			const refreshed = await a.f.post('/oauth/token', {
				grant_type: 'refresh_token',
				client_id: AGENT_CLIENT_ID,
				refresh_token: refresh,
				resource: a.origin,
			})
			expect(refreshed.status).toBe(200)
			const next = field(await json(refreshed), 'refresh_token')
			if (typeof next !== 'string') throw new Error('no refresh token')
			expect((await a.f.post('/oauth/revoke', { client_id: AGENT_CLIENT_ID, token: next })).status).toBe(200)
			expect(await a.exchange(access)).toEqual({ ok: false, reason: 'invalid_grant' })
			const records = await a.repositories.audit.listAuditEvents({ action: 'iam.oauth.grant.revoke', resourceId: grantId, limit: 5 })
			expect(JSON.parse(records[0]?.metadata ?? 'null')).toMatchObject({ agentLabel: 'release bot', sessionId: a.f.sessionId })
		})

		test('the device start refuses what is no application resource, a scope it cannot hold and a malformed label', async () => {
			const a = await agentFixture(engine.repositories())
			const error = async (response: Promise<Response>) => field(await json(await response), 'error')
			const tag = uuidv7().slice(-12)
			// An environment whose schema admits no agent, and an origin registered for two environments.
			const plain = `https://plain-${tag}.example.test`
			await reconcile(a.repositories, `plain-${tag}@prod`, { agentCallers: false })
			await a.repositories.handoff.setReturnOrigins(`plain-${tag}@prod`, [plain])
			const shared = `https://shared-${tag}.example.test`
			for (const env of ['stage', 'prod']) {
				await reconcile(a.repositories, `shared-${tag}@${env}`, { agentCallers: true })
				await a.repositories.handoff.setReturnOrigins(`shared-${tag}@${env}`, [shared])
			}

			for (
				const resources of [
					[plain],
					[shared],
					[`https://unknown-${tag}.example.test`],
					[`${a.origin}/api`],
					[`${a.origin}/`],
					[a.origin, plain],
					// The console's own resource is never served to the agent client.
					[a.f.config.resources[0]?.resource ?? ''],
				]
			) {
				expect(await error(a.start({ scope: 'read' }, resources))).toBe('invalid_target')
			}
			for (const scope of ['read write', 'admin', 'read:org=x', 'read:project=', 'deploy:alpha']) {
				expect(await error(a.start({ scope }))).toBe('invalid_scope')
			}
			for (const label of ['x'.repeat(65), ' padded', 'line\nbreak', '']) {
				expect(await error(a.start({ scope: 'read', agent_label: label }))).toBe('invalid_request')
			}
			// The console's command-line client keeps its own resources and still names a scope.
			expect(await error(a.start({}, [a.origin], OAUTH_CLI_CLIENT_ID))).toBe('invalid_request')
			expect(await error(a.start({ scope: 'read' }, [a.origin], OAUTH_CLI_CLIENT_ID))).toBe('invalid_target')

			// No scope asks for read, and so does an empty one (RFC 6749 §3.1); the label is optional.
			const { deviceCode } = await a.started({})
			const attempt = await a.repositories.oauth.deviceAuthorization(await hashToken(deviceCode))
			expect(attempt?.scopes).toBe('["read"]')
			expect(attempt?.agent_label).toBeNull()
			expect(attempt?.app).toBe(a.app)
			const empty = await a.repositories.oauth.deviceAuthorization(await hashToken((await a.started({ scope: '' })).deviceCode))
			expect(empty?.scopes).toBe('["read"]')
			expect(await error(a.start({ scope: '' }, [a.origin], OAUTH_CLI_CLIENT_ID))).toBe('invalid_request')
		})

		test('a flood of refused targets from one address is throttled before the targets are looked up', async () => {
			const a = await agentFixture(engine.repositories())
			const address = `address-${uuidv7()}`
			const bogus = { client_id: AGENT_CLIENT_ID, scope: [], resources: [`https://bogus-${uuidv7().slice(-12)}.example.test`] }
			const outcomes: string[] = []
			for (let attempt = 0; attempt < 31; attempt++) {
				const outcome = await startDeviceAuthorization(a.f.services, a.f.config, bogus, address)
				outcomes.push(outcome.ok ? 'ok' : outcome.error)
			}
			expect(outcomes.slice(0, 30).every((error) => error === 'invalid_target')).toBe(true)
			expect(outcomes[30]).toBe('temporarily_unavailable')
			// The spent bucket refuses a valid target from that address too, and no other address.
			const valid = { client_id: AGENT_CLIENT_ID, scope: [], resources: [a.origin] }
			expect(await startDeviceAuthorization(a.f.services, a.f.config, valid, address)).toEqual({ ok: false, error: 'temporarily_unavailable' })
			expect((await startDeviceAuthorization(a.f.services, a.f.config, valid, `${address}-other`)).ok).toBe(true)
		})

		test('the page offers read for a write request, keeps the narrowing, and says that nothing checks an unlisted value', async () => {
			const a = await agentFixture(engine.repositories())
			const { deviceCode, userCode } = await a.started({ scope: 'write:project=b' })
			const html = await (await a.page({ user_code: userCode })).text()
			expect(html).toContain('Agents may only read in this environment')
			expect(html).toContain('name="scope" value="read:project=b"')
			expect(html).not.toContain('value="write:project=b"')
			expect(html).toContain('Nothing checks that this value exists')
			expect(html).toContain('The agent gave no name for itself.')

			for (const scope of ['write:project=b', 'read', 'read:project=a', 'nonsense']) {
				const refused = await a.page({ user_code: userCode, decision: 'approve', lifetime: '3600', scope })
				expect(refused.status).toBe(400)
			}
			expect((await a.page({ user_code: userCode, decision: 'approve', lifetime: '3600' })).status).toBe(400)
			const approved = await a.page({ user_code: userCode, decision: 'approve', lifetime: '3600', scope: 'read:project=b' })
			expect(approved.status).toBe(200)
			const tokens = await json(await a.poll(deviceCode))
			expect(field(tokens, 'scope')).toBe('read:project=b')
		})

		test('the exchange refuses another resource or app, another client, a write grant, and a grant that no longer holds', async () => {
			const a = await agentFixture(engine.repositories())
			const { grant, token } = await a.directGrant('read:project=a')
			expect((await a.exchange(token)).ok).toBe(true)

			expect(await a.exchange(token, { resource: `${a.origin}.other` })).toEqual({ ok: false, reason: 'invalid_grant' })
			expect(await a.exchange(token, { app: 'other@prod' })).toEqual({ ok: false, reason: 'invalid_grant' })
			expect(await a.exchange('not-a-token')).toEqual({ ok: false, reason: 'invalid_grant' })
			// A resource token of the console's command-line client, for this very origin and grant.
			const now = unixNow()
			const cliToken = await (await getSigner(SIGNING_ENV)).signResourceToken(buildResourceAccessClaims({
				iss: ISSUER,
				app: a.app,
				resource: a.origin,
				subject: a.f.principal.id,
				label: a.f.principal.label,
				permissions: [],
				issuedAt: now,
				expiresAt: now + 300,
				clientId: OAUTH_CLI_CLIENT_ID,
				scopes: ['read:project=a'],
				grantId: grant.id,
				tokenId: uuidv7(),
			}))
			expect(await a.exchange(cliToken)).toEqual({ ok: false, reason: 'invalid_grant' })

			// Until Control mirrors `agent-write`, no environment serves a write grant.
			const write = await a.directGrant('write:project=a')
			expect(await a.exchange(write.token)).toEqual({ ok: false, reason: 'write_refused' })

			const revoked = await a.directGrant('read')
			await a.repositories.oauth.revokeGrant(revoked.grant.id, unixNow())
			expect(await a.exchange(revoked.token)).toEqual({ ok: false, reason: 'invalid_grant' })

			// A grant ends with the login that approved it.
			const login = await a.repositories.sessions.createSession({
				tokenHash: uuidv7(),
				principalId: a.f.principal.id,
				authenticationMethod: 'password',
				expiresAt: unixNow() + 3600,
			})
			const ended = await a.directGrant('read', { sessionId: login })
			expect((await a.exchange(ended.token)).ok).toBe(true)
			await a.repositories.sessions.revokeSessionById(login)
			expect(await a.exchange(ended.token)).toEqual({ ok: false, reason: 'invalid_grant' })

			// The narrowing's dimension is checked again at every exchange, and so is the environment admitting `agent`.
			await reconcile(a.repositories, a.app, { agentCallers: true, project: false })
			expect(await a.exchange(token)).toEqual({ ok: false, reason: 'invalid_grant' })
			const unnarrowed = await a.directGrant('read', { label: null })
			const plainRead = await a.exchange(unnarrowed.token)
			if (!plainRead.ok) throw new Error(`refused: ${plainRead.reason}`)
			expect(parseAccessClaims(decodeJwt(plainRead.token))?.act).toEqual({
				sub: AGENT_CLIENT_ID,
				grant: unnarrowed.grant.id,
				scope: { mode: 'read', within: null },
			})
			await reconcile(a.repositories, a.app, { agentCallers: false })
			expect(await a.exchange(unnarrowed.token)).toEqual({ ok: false, reason: 'invalid_grant' })
			await reconcile(a.repositories, a.app, { agentCallers: true })
			expect((await a.exchange(unnarrowed.token)).ok).toBe(true)

			// A disabled person's grant exchanges for nothing.
			await a.repositories.principals.disablePrincipal(a.f.principal.id)
			expect(await a.exchange(unnarrowed.token)).toEqual({ ok: false, reason: 'invalid_grant' })
		})

		test('a grant the person gains at another project after approval never reaches the narrowed token', async () => {
			const a = await agentFixture(engine.repositories())
			const { token } = await a.directGrant('read:project=a')
			const narrowed = async () => {
				const exchanged = await a.exchange(token)
				if (!exchanged.ok) throw new Error(`refused: ${exchanged.reason}`)
				return parseAccessClaims(decodeJwt(exchanged.token))?.perms ?? []
			}
			const before = await narrowed()
			const b = { type: 'project', value: 'b' }
			await a.repositories.grants.createGrant({
				principalId: a.f.principal.id,
				app: a.app,
				permissions: ['task.write', 'task.archive'],
				scopeType: 'project',
				scopeValue: 'b',
			})
			const after = await narrowed()
			expect(after).toEqual(before)
			for (const action of ['task.read', 'task.write', 'task.archive', 'task.list']) {
				expect(permits(after, action, b)).toBe(false)
			}
			// The person's own set holds them at b: the narrowing, not a missing grant, keeps them out.
			const { token: whole } = await a.directGrant('read')
			const unnarrowed = await a.exchange(whole)
			if (!unnarrowed.ok) throw new Error(`refused: ${unnarrowed.reason}`)
			expect(permits(parseAccessClaims(decodeJwt(unnarrowed.token))?.perms ?? [], 'task.archive', b)).toBe(true)
		})

		test('a replayed refresh token revokes the grant, and the console CLI client neither refreshes nor revokes it', async () => {
			const a = await agentFixture(engine.repositories())
			const refreshAs = (clientId: string, refreshToken: string) =>
				a.f.post('/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken, resource: a.origin })

			const first = await a.approved('read')
			// RFC 7009 answers 200 to a foreign token, and the grant stays.
			expect((await a.f.post('/oauth/revoke', { client_id: OAUTH_CLI_CLIENT_ID, token: first.refresh })).status).toBe(200)
			expect((await a.f.post('/oauth/revoke', { client_id: OAUTH_CLI_CLIENT_ID, token: first.access })).status).toBe(200)
			expect((await a.repositories.oauth.grant(first.grantId))?.revoked_at).toBeNull()
			const cliRefresh = await refreshAs(OAUTH_CLI_CLIENT_ID, first.refresh)
			expect(cliRefresh.status).toBe(400)
			expect(field(await json(cliRefresh), 'access_token')).toBeUndefined()

			const second = await a.approved('read')
			const rotated = await refreshAs(AGENT_CLIENT_ID, second.refresh)
			expect(rotated.status).toBe(200)
			expect((await a.repositories.oauth.grant(second.grantId))?.revoked_at).toBeNull()
			const replay = await refreshAs(AGENT_CLIENT_ID, second.refresh)
			expect(field(await json(replay), 'error')).toBe('invalid_grant')
			expect((await a.repositories.oauth.grant(second.grantId))?.revoked_at).not.toBeNull()
			expect(await a.exchange(second.access)).toEqual({ ok: false, reason: 'invalid_grant' })
		})

		test('the exchanged token ends no later than the grant, its login or the authority it carries', async () => {
			const a = await agentFixture(engine.repositories())
			const expiry = async (grant: OAuthGrantRow, scope: string) => {
				const exchanged = await a.exchange(await a.fiveMinuteToken(grant, scope))
				if (!exchanged.ok) throw new Error(`refused: ${exchanged.reason}`)
				expect(parseAccessClaims(decodeJwt(exchanged.token))?.exp).toBe(exchanged.expiresAt)
				return exchanged.expiresAt
			}
			const now = unixNow()

			const shortGrant = await a.directGrant('read', { expiresAt: now + 100 })
			expect(await expiry(shortGrant.grant, 'read')).toBe(now + 100)

			const login = await a.repositories.sessions.createSession({
				tokenHash: uuidv7(),
				principalId: a.f.principal.id,
				authenticationMethod: 'password',
				expiresAt: now + 120,
			})
			const shortLogin = await a.directGrant('read', { sessionId: login })
			expect(await expiry(shortLogin.grant, 'read')).toBe(now + 120)

			// task.archive at a rests on a grant that ends in 90 seconds; nothing else supports it.
			await a.repositories.grants.createGrant({
				principalId: a.f.principal.id,
				app: a.app,
				permissions: ['task.archive'],
				scopeType: 'project',
				scopeValue: 'a',
				expiresAt: now + 90,
			})
			const deadline = await a.directGrant('read:project=a')
			expect(await expiry(deadline.grant, 'read:project=a')).toBe(now + 90)
		})
	})
}
