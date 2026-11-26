// The person's own account page (`/auth/account`, ADR-0090 step 6), on both engines: it lists the grants that act as the
// signed-in person and revokes one of them, never another person's. Postgres runs when FABRIKA_TEST_POSTGRES_URL is set
// and skips cleanly otherwise.

import { AGENT_CLIENT_ID, OAUTH_CLI_CLIENT_ID } from '@fabrika/auth-core'
import { uuidv7 } from '@fabrika/platform'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { ACCOUNT_PATH } from '../auth/account'
import { handleAuth } from '../auth/routes'
import { createPostgresIamRepositories, type IamRepositories, type OAuthGrantRow } from '../db'
import { randomToken } from '../oidc'
import { unixNow } from '../repositories/sql'
import { hashToken } from '../secret'
import { createHarness } from './helpers/harness'
import { ISSUER, oauthFixture, SIGNING_ENV } from './helpers/oauth'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

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
		{ id, resources: null, created_at: now, expires_at: now + 3600, revoked_at: null, agent_label: null, ...values },
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
		app: 'control',
		resource: 'https://control.example.test/api/rpc',
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
	const get = (withSession = true) => send(new Request(`${ISSUER}${ACCOUNT_PATH}`, { headers: withSession ? { cookie: f.cookie } : {} }))
	const revoke = (id: string, headers: Record<string, string> = { cookie: f.cookie, origin: 'null', 'sec-fetch-site': 'same-origin' }) =>
		send(
			new Request(`${ISSUER}${ACCOUNT_PATH}`, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
				body: new URLSearchParams({ grant: id }),
			}),
		)
	return { f, repositories, person, agentOrigin, ids: { agent, cli, revoked, expired, ended, foreign }, get, revoke }
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
			expect(html).toContain('<code>deploy:alpha</code>')
			const listed = Object.entries(a.ids).filter(([, id]) => html.includes(id)).map(([name]) => name)
			expect(listed).toEqual(['agent', 'cli'])
			expect(html).not.toContain('not yours')
		})

		test('revokes an own grant once, records it as the person, and the page no longer lists it', async () => {
			const a = await accountFixture(engine.repositories())
			const first = await a.revoke(a.ids.agent)
			expect(first.status).toBe(200)
			const html = await first.text()
			expect(html).toContain('Access revoked.')
			expect(html).not.toContain(`value="${a.ids.agent}"`)
			expect(html).toContain(`value="${a.ids.cli}"`)
			expect((await a.repositories.oauth.grant(a.ids.agent))?.revoked_at).not.toBeNull()
			expect(await (await a.revoke(a.ids.agent)).text()).toContain('That access had already ended.')
			const records = await a.repositories.audit.listAuditEvents({ action: 'iam.oauth.grant.revoke', resourceId: a.ids.agent, limit: 5 })
			expect(records).toHaveLength(1)
			expect(records[0]?.principal_id).toBe(a.person)
			expect(JSON.parse(records[0]?.metadata ?? 'null')).toMatchObject({ reason: 'owner', agentLabel: 'release bot', clientId: AGENT_CLIENT_ID })
		})

		test("never revokes another person's grant, a cross-site post, or a post without a login", async () => {
			const a = await accountFixture(engine.repositories())
			expect(await (await a.revoke(a.ids.foreign)).text()).toContain('That access had already ended.')
			expect(await (await a.revoke('')).text()).toContain('That access had already ended.')
			const crossSite = await a.revoke(a.ids.agent, { cookie: a.f.cookie, origin: 'https://evil.example.test', 'sec-fetch-site': 'cross-site' })
			expect(crossSite.status).toBe(403)
			const signedOut = await a.revoke(a.ids.agent, { origin: 'null', 'sec-fetch-site': 'same-origin' })
			expect(signedOut.status).toBe(303)
			for (const id of [a.ids.foreign, a.ids.agent]) expect((await a.repositories.oauth.grant(id))?.revoked_at).toBeNull()
			expect(await a.repositories.audit.listAuditEvents({ action: 'iam.oauth.grant.revoke', resourceId: a.ids.foreign, limit: 5 })).toHaveLength(0)
		})
	})
}
