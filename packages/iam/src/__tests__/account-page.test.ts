// The person's own account page (`/auth/account`, ADR-0090 step 6), on both engines: it lists the grants that act as the
// signed-in person and revokes one of them, never another person's. Postgres runs when FABRIKA_TEST_POSTGRES_URL is set
// and skips cleanly otherwise.

import { AGENT_CLIENT_ID, OAUTH_CLI_CLIENT_ID } from '@fabrika/auth-core'
import { CONTROL_APP_ID, CONTROL_OPERATIONS_RPC_PATH, CONTROL_RPC_PATH } from '@fabrika/control-contract'
import { uuidv7 } from '@fabrika/platform'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { ACCOUNT_GRANTS_SHOWN, ACCOUNT_PATH } from '../auth/account'
import { handleAuth } from '../auth/routes'
import { createPostgresIamRepositories, type IamRepositories, type OAuthGrantRow } from '../db'
import { randomToken } from '../oidc'
import { unixNow } from '../repositories/sql'
import { hashToken } from '../secret'
import { createHarness } from './helpers/harness'
import { ISSUER, oauthFixture, SIGNING_ENV } from './helpers/oauth'
import { registerTestPasskey } from './helpers/passkey-pages'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'
import { TestAuthenticator } from './helpers/webauthn'

if (!hasPostgres) console.warn(`account-page.test.ts ${skipReason}`)

let postgres: PostgresFixture | null = null
let active: Awaited<ReturnType<typeof oauthFixture>> | null = null

beforeAll(async () => {
	if (hasPostgres) postgres = await createPostgres('iam_account_page')
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

async function grant(
	repositories: IamRepositories,
	values: Pick<OAuthGrantRow, 'principal_id' | 'session_id' | 'client_id' | 'app' | 'resource' | 'scopes'> & Partial<OAuthGrantRow>,
): Promise<string> {
	const now = unixNow()
	const id = uuidv7()
	await repositories.oauth.createGrant(
		{
			id,
			resources: null,
			created_at: now,
			expires_at: now + 3600,
			revoked_at: null,
			agent_label: null,
			passkey_confirmed_at: null,
			passkey_credential_id: null,
			...values,
		},
		{ token_hash: await hashToken(randomToken(32)), redirect_uri: 'urn:device', challenge: '', expires_at: now + 60 },
	)
	// A new grant is always live; a revoked one is revoked after it was written.
	if (values.revoked_at !== undefined && values.revoked_at !== null) await repositories.oauth.revokeGrant(id, values.revoked_at)
	return id
}

async function accountFixture(repositories: IamRepositories) {
	const f = await oauthFixture(repositories)
	active = f
	const person = f.principal.id
	const tag = uuidv7().slice(-12)
	const agentOrigin = `https://notes-${tag}.example.test`
	const agent = await grant(repositories, {
		principal_id: person,
		session_id: f.sessionId,
		client_id: AGENT_CLIENT_ID,
		app: `notes-${tag}@prod`,
		resource: agentOrigin,
		scopes: '["write"]',
		agent_label: 'release bot',
	})
	const cli = await grant(repositories, {
		principal_id: person,
		session_id: f.sessionId,
		client_id: OAUTH_CLI_CLIENT_ID,
		app: CONTROL_APP_ID,
		resource: `https://console.example.test${CONTROL_RPC_PATH}`,
		resources: JSON.stringify([`https://console.example.test${CONTROL_RPC_PATH}`, `https://console.example.test${CONTROL_OPERATIONS_RPC_PATH}`]),
		scopes: '["deploy:alpha"]',
	})
	const revoked = await grant(repositories, {
		principal_id: person,
		session_id: f.sessionId,
		client_id: AGENT_CLIENT_ID,
		app: `revoked-${tag}@prod`,
		resource: `https://revoked-${tag}.example.test`,
		scopes: '["read"]',
		revoked_at: unixNow() - 10,
	})
	const expired = await grant(repositories, {
		principal_id: person,
		session_id: f.sessionId,
		client_id: AGENT_CLIENT_ID,
		app: `expired-${tag}@prod`,
		resource: `https://expired-${tag}.example.test`,
		scopes: '["read"]',
		expires_at: unixNow() - 10,
	})
	// A grant given under a login that has since ended is no longer in force.
	const endedSession = await repositories.sessions.createSession({
		tokenHash: await hashToken(randomToken(32)),
		principalId: person,
		authenticationMethod: 'password',
		expiresAt: unixNow() + 3600,
	})
	const ended = await grant(repositories, {
		principal_id: person,
		session_id: endedSession,
		client_id: AGENT_CLIENT_ID,
		app: `ended-${tag}@prod`,
		resource: `https://ended-${tag}.example.test`,
		scopes: '["read"]',
	})
	await repositories.sessions.revokeSessionById(endedSession)
	const other = await repositories.principals.createUser(uuidv7(), `${uuidv7()}@example.test`)
	const otherSession = await repositories.sessions.createSession({
		tokenHash: await hashToken(randomToken(32)),
		principalId: other.id,
		authenticationMethod: 'password',
		expiresAt: unixNow() + 3600,
	})
	const foreign = await grant(repositories, {
		principal_id: other.id,
		session_id: otherSession,
		client_id: AGENT_CLIENT_ID,
		app: `foreign-${tag}@prod`,
		resource: `https://foreign-${tag}.example.test`,
		scopes: '["read"]',
		agent_label: 'not yours',
	})
	const send = (request: Request) => handleAuth(request, f.services, SIGNING_ENV, { waitUntil() {} }, null, 'req-account')
	const get = (withSession = true, path: string = ACCOUNT_PATH, headers: Record<string, string> = {}) =>
		send(new Request(`${ISSUER}${path}`, { headers: withSession ? { cookie: f.cookie, ...headers } : headers }))
	const revoke = (id: string, headers: Record<string, string> = { cookie: f.cookie, origin: 'null', 'sec-fetch-site': 'same-origin' }) =>
		send(
			new Request(`${ISSUER}${ACCOUNT_PATH}`, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
				body: new URLSearchParams({ grant: id }),
			}),
		)
	return { f, repositories, person, agentOrigin, tag, ids: { agent, cli, revoked, expired, ended, foreign }, get, revoke }
}

/** Where a revocation sent the browser: back to the page, with its outcome named. */
function outcome(response: Response): string | null {
	expect(response.status).toBe(303)
	const location = new URL(response.headers.get('location') ?? '', ISSUER)
	expect(location.pathname).toBe(ACCOUNT_PATH)
	return location.searchParams.get('done')
}

for (const engine of engines) {
	describe.skipIf(engine.skip)(`the account page on ${engine.name}`, () => {
		test('a browser without a login is sent to sign in and back', async () => {
			const a = await accountFixture(engine.repositories())
			const response = await a.get(false)
			expect(response.status).toBe(302)
			const location = new URL(response.headers.get('location') ?? '', ISSUER)
			expect(location.pathname).toBe('/auth/login')
			expect(location.searchParams.get('redirect')).toBe(`${ISSUER}${ACCOUNT_PATH}`)
		})

		test("lists the person's grants in force, and no revoked, expired, ended or foreign one", async () => {
			const a = await accountFixture(engine.repositories())
			const response = await a.get()
			expect(response.status).toBe(200)
			expect(response.headers.get('cache-control')).toBe('no-store')
			const html = await response.text()
			expect(html).toContain('Agent “release bot”')
			expect(html).toContain('Acts as you, including changes')
			expect(html).toContain(a.agentOrigin)
			expect(html).toContain('The fabrika command-line client')
			// The console's resources read as the device page names them, not as the console's app id: the group's name.
			expect(html).toContain('<th colspan="5" scope="rowgroup">Console, Operations <span class="count">1</span></th>')
			expect(html).toContain('<code class="chip">deploy:alpha</code>')
			const listed = Object.entries(a.ids).filter(([, id]) => html.includes(id)).map(([name]) => name)
			expect(listed).toEqual(['agent', 'cli'])
			expect(html).not.toContain('not yours')
		})

		test('revokes an own grant once, records it as the person, and the page no longer lists it', async () => {
			const a = await accountFixture(engine.repositories())
			expect(outcome(await a.revoke(a.ids.agent))).toBe('revoked')
			const html = await (await a.get(true, `${ACCOUNT_PATH}?done=revoked`)).text()
			expect(html).toContain('Access revoked.')
			expect(html).not.toContain(`value="${a.ids.agent}"`)
			expect(html).toContain(`value="${a.ids.cli}"`)
			expect((await a.repositories.oauth.grant(a.ids.agent))?.revoked_at).not.toBeNull()
			expect(outcome(await a.revoke(a.ids.agent))).toBe('already_ended')
			expect(await (await a.get(true, `${ACCOUNT_PATH}?done=already_ended`)).text()).toContain('That access had already ended.')
			const records = await a.repositories.audit.listAuditEvents({ action: 'iam.oauth.grant.revoke', resourceId: a.ids.agent, limit: 5 })
			expect(records).toHaveLength(1)
			expect(records[0]?.principal_id).toBe(a.person)
			expect(JSON.parse(records[0]?.metadata ?? 'null')).toMatchObject({ reason: 'owner', agentLabel: 'release bot', clientId: AGENT_CLIENT_ID })
		})

		test("never revokes another person's grant, a cross-site post, or a post without a login", async () => {
			const a = await accountFixture(engine.repositories())
			expect(outcome(await a.revoke(a.ids.foreign))).toBe('already_ended')
			expect(outcome(await a.revoke(''))).toBe('already_ended')
			// An expired grant has already ended: nothing to revoke, and nothing recorded.
			expect(outcome(await a.revoke(a.ids.expired))).toBe('already_ended')
			expect((await a.repositories.oauth.grant(a.ids.expired))?.revoked_at).toBeNull()
			const crossSite = await a.revoke(a.ids.agent, { cookie: a.f.cookie, origin: 'https://evil.example.test', 'sec-fetch-site': 'cross-site' })
			expect(crossSite.status).toBe(403)
			const signedOut = await a.revoke(a.ids.agent, { origin: 'null', 'sec-fetch-site': 'same-origin' })
			expect(signedOut.status).toBe(303)
			for (const id of [a.ids.foreign, a.ids.agent]) expect((await a.repositories.oauth.grant(id))?.revoked_at).toBeNull()
			for (const id of [a.ids.foreign, a.ids.expired]) {
				expect(await a.repositories.audit.listAuditEvents({ action: 'iam.oauth.grant.revoke', resourceId: id, limit: 5 })).toHaveLength(0)
			}
			// An outcome the page does not know shows no notice.
			const unknown = await (await a.get(true, `${ACCOUNT_PATH}?done=<b>`)).text()
			expect(unknown).not.toContain('role="status"')
		})

		test('names the passkey that confirmed each write grant, one since removed, and one confirmed before it was recorded', async () => {
			const a = await accountFixture(engine.repositories())
			await registerTestPasskey(a.repositories, ISSUER, a.person, await TestAuthenticator.create())
			const [passkey] = await a.repositories.passkeys.list(a.person)
			const at = Date.UTC(2026, 0, 2, 3, 4) / 1000
			const confirmed = (credentialId: string | null, label: string) =>
				grant(a.repositories, {
					principal_id: a.person,
					session_id: a.f.sessionId,
					client_id: AGENT_CLIENT_ID,
					app: `notes-${a.tag}@prod`,
					resource: a.agentOrigin,
					scopes: '["write"]',
					agent_label: label,
					passkey_confirmed_at: at,
					passkey_credential_id: credentialId,
				})
			await confirmed(passkey?.credential_id ?? 'none', 'held')
			await confirmed('a-passkey-removed-earlier', 'removed')
			await confirmed(null, 'unrecorded')
			const markup = `credential-${uuidv7()}`
			await a.repositories.passkeys.insert(
				{ id: uuidv7(), principalId: a.person, credentialId: markup, publicKey: 'AA', signCount: 0, transports: [], label: '<b>Key</b>', createdAt: at },
				{ steppedUp: true, max: 10 },
				{ requestId: 'req', principalId: a.person, principalLabel: a.person, app: 'iam', action: 'iam.passkey.register', resourceType: 'principal' },
			)
			await confirmed(markup, 'markup')
			const html = await (await a.get()).text()
			expect(html).toContain('<span class="line">Confirmed with the passkey “&lt;b&gt;Key&lt;/b&gt;”: 2026-01-02 03:04 UTC</span>')
			expect(html).not.toContain('<b>Key</b>')
			expect(html).toContain('<span class="line">Confirmed with the passkey “Laptop”: 2026-01-02 03:04 UTC</span>')
			expect(html).toContain('<span class="line">Confirmed with a passkey you have since removed: 2026-01-02 03:04 UTC</span>')
			expect(html).toContain('<span class="line">Confirmed with a passkey: 2026-01-02 03:04 UTC</span>')
			// The grant no passkey confirmed says nothing of one.
			expect(html.match(/Confirmed with/g)).toHaveLength(4)
		})

		test('groups the grants by what they reach, tells similar ones apart by when each was last active, and folds the endpoints', async () => {
			const a = await accountFixture(engine.repositories())
			const at = Date.UTC(2026, 0, 2, 3, 4) / 1000
			const similar = (created: number) =>
				grant(a.repositories, {
					principal_id: a.person,
					session_id: a.f.sessionId,
					client_id: OAUTH_CLI_CLIENT_ID,
					app: CONTROL_APP_ID,
					resource: `https://console.example.test${CONTROL_RPC_PATH}`,
					scopes: '["deploy:alpha"]',
					created_at: created,
					expires_at: unixNow() + 3600,
				})
			const renewedOne = await similar(at)
			const idleOne = await similar(at + 60)
			// A rotation spends the previous refresh token: the latest spend is when the grant was last active.
			for (const [index, usedAt] of [at + 600, at + 7200].entries()) {
				await a.repositories.oauth.insertRefreshToken({ token_hash: `renewed-${a.tag}-${index}`, grant_id: renewedOne, expires_at: unixNow() + 3600 })
				await a.repositories.oauth.consumeRefreshToken(`renewed-${a.tag}-${index}`, usedAt)
			}
			await a.repositories.oauth.insertRefreshToken({ token_hash: `idle-${a.tag}`, grant_id: idleOne, expires_at: unixNow() + 3600 })
			const html = await (await a.get()).text()
			const row = (id: string) => {
				const start = html.lastIndexOf('<tr>', html.indexOf(`value="${id}"`))
				return html.slice(start, html.indexOf('</tr>', start))
			}
			expect(row(renewedOne)).toContain('data-label="Last active">2026-01-02 05:04 UTC</td>')
			expect(row(idleOne)).toContain('data-label="Last active">Not since approval</td>')
			expect(row(idleOne)).toContain('data-label="Allowed">2026-01-02 03:05 UTC</td>')
			// One group per application, its rows newest first; the endpoint and the raw scopes sit in the row's details.
			expect(html.match(/scope="rowgroup">Console </g)).toHaveLength(1)
			expect(html).toContain('<th colspan="5" scope="rowgroup">Console <span class="count">2</span></th>')
			expect(html.indexOf(`value="${idleOne}"`)).toBeLessThan(html.indexOf(`value="${renewedOne}"`))
			expect(row(a.ids.agent)).toMatch(new RegExp(`<details><summary>Details</summary><dl><dt>Endpoints</dt><dd><code>${a.agentOrigin}</code></dd>`))
		})

		test('asks before a revocation, names what it revokes, and puts the passkeys first', async () => {
			const a = await accountFixture(engine.repositories())
			const html = await (await a.get()).text()
			const allowed = (await a.repositories.oauth.grant(a.ids.agent))?.created_at ?? 0
			const when = `${new Date(allowed * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`
			const app = `notes-${a.tag}@prod`
			expect(html).toContain(
				`data-confirm="Agent “release bot”: access to ${app} ends within five minutes. What it already changed stays. Allowed ${when}."`,
			)
			expect(html).toContain(`aria-label="Revoke Agent “release bot” at ${app}, allowed ${when}">Revoke</button>`)
			expect(html).toContain('<dialog id="revoke-dialog"')
			// Revoke is quiet: no revoke button is the page's filled one, which is the passkey form's.
			expect(html.match(/<button type="submit" class="danger small"/g)).toHaveLength(2)
			expect(html.indexOf('id="passkeys"')).toBeLessThan(html.indexOf('id="connections"'))
			expect(html).toContain('<a href="#passkeys">Passkeys <span class="count">0</span></a>')
			expect(html).toContain('<main class="workspace">')
		})

		test("the person's own language wins over the browser's", async () => {
			const a = await accountFixture(engine.repositories())
			await a.repositories.principals.setLocale(a.person, 'cs')
			const html = await (await a.get(true, ACCOUNT_PATH, { 'accept-language': 'en' })).text()
			expect(html).toContain('Váš účet')
			expect(html).not.toContain('Your account')
		})

		test(`lists at most ${ACCOUNT_GRANTS_SHOWN} grants, newest first, and says more are live`, async () => {
			const a = await accountFixture(engine.repositories())
			let newest = ''
			for (let index = 0; index < ACCOUNT_GRANTS_SHOWN; index++) {
				newest = await grant(a.repositories, {
					principal_id: a.person,
					session_id: a.f.sessionId,
					client_id: AGENT_CLIENT_ID,
					app: `many-${a.tag}@prod`,
					resource: `https://many-${a.tag}.example.test`,
					scopes: '["read"]',
				})
			}
			const html = await (await a.get()).text()
			expect(html.match(/name="grant"/g)).toHaveLength(ACCOUNT_GRANTS_SHOWN)
			expect(html).toContain(`value="${newest}"`)
			// The two oldest live grants fall past the cut-off.
			expect(html).not.toContain(`value="${a.ids.agent}"`)
			expect(html).toContain(`Showing the ${ACCOUNT_GRANTS_SHOWN} most recent.`)
		})
	})
}
