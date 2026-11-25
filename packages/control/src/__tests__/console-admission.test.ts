// Admission of the console's state changes through the real proxy (ADR-0022): which requests reach Control on the
// three JSON mounts, the GitHub connection mutations and the approvals, and who refuses the rest. A session needs
// `Sec-Fetch-Site: same-origin` at the proxy; a bearer is explicit authority, which the browser never attaches itself.

import { AUTH_CALLBACK_PATH, HANDOFF_COOKIE_PREFIX, SESSION_COOKIE } from '@fabrika/auth-core'
import { serviceProxyTable } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { controlServiceContract } from '../../fabrika.service'
import { controlApp } from '../app'
import type { Env } from '../env'
import { createHarness, type Harness, harnessDatabase } from './helpers/harness'
import { fakeControlProvider } from './helpers/provider'
import { CONSOLE_ORIGIN, consoleBehindProxy, type ProxyIam } from './helpers/proxy'
import { unusedSourceConnection } from './helpers/source-connection'
import { adminToken, TEST_ISSUER, testIamEnv } from './helpers/tokens'

const SIBLING_ORIGIN = 'https://evil.control.test'

/** Who answered a request: the proxy before Control was asked, or Control with its status. */
type Outcome = `proxy ${number}` | `control ${number}`

interface ConsoleFixture {
	readonly harness: Harness
	readonly fetch: (request: Request) => Promise<{ readonly outcome: Outcome; readonly response: Response }>
}

function consoleFixture(iam: ProxyIam = { session: adminToken, keys: { px_admin: adminToken } }): ConsoleFixture {
	const harness = createHarness()
	const upstreamOk = () => Promise.resolve(Response.json({ result: null }))
	const env: Env = {
		DB: harness.d1,
		REPOSITORIES: harness.repositories,
		ASSETS: { fetch: () => Promise.resolve(new Response('dashboard')) },
		RUN_LOGS: { put: () => Promise.resolve(), get: () => Promise.resolve(null), delete: () => Promise.resolve() },
		DEPLOY_QUEUE: { send: () => Promise.resolve() },
		WAIT_UNTIL: () => {},
		ENVIRONMENT: 'local',
		FABRIKA_CONTROL_DOMAIN: CONSOLE_ORIGIN,
		IAM_ADMIN: { fetch: upstreamOk },
		OPERATIONS: { fetch: upstreamOk },
		...testIamEnv,
	}
	let reached = false
	const fetch = consoleBehindProxy({
		table: serviceProxyTable(controlServiceContract({ mcp: false, cli: false }), { oauth: false }),
		iam,
		upstream: (request) => {
			reached = true
			return controlApp.fetch(request, { env, provider: fakeControlProvider, sourceConnection: unusedSourceConnection('harbor') }, { waitUntil() {} })
		},
	})
	return {
		harness,
		fetch: async (request) => {
			reached = false
			const response = await fetch(request)
			return { outcome: reached ? `control ${response.status}` : `proxy ${response.status}`, response }
		},
	}
}

function admissionFixture(): (request: Request) => Promise<Outcome> {
	const { fetch } = consoleFixture()
	return async (request) => (await fetch(request)).outcome
}

type Credential = 'same-origin session' | 'cross-site session' | 'same-site session' | 'bearer' | 'bearer and cookie'

const BEARERS: readonly Credential[] = ['bearer', 'bearer and cookie']

const CREDENTIALS: Readonly<Record<Credential, Record<string, string>>> = {
	'same-origin session': { cookie: `${SESSION_COOKIE}=s`, origin: CONSOLE_ORIGIN, 'sec-fetch-site': 'same-origin' },
	'cross-site session': { cookie: `${SESSION_COOKIE}=s`, origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' },
	'same-site session': { cookie: `${SESSION_COOKIE}=s`, origin: SIBLING_ORIGIN, 'sec-fetch-site': 'same-site' },
	'bearer': { authorization: 'Bearer px_admin' },
	'bearer and cookie': { authorization: 'Bearer px_admin', cookie: `${SESSION_COOKIE}=s` },
}

interface Call {
	readonly name: string
	readonly path: string
	readonly body: unknown
}

const rpc = (method: string, input: unknown): Call => ({ name: method, path: '/api/rpc', body: { method, input } })

const call = (target: Call, credential: Credential) =>
	new Request(`${CONSOLE_ORIGIN}${target.path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...CREDENTIALS[credential] },
		body: JSON.stringify(target.body),
	})

const MOUNTS: readonly Call[] = [
	rpc('installation', null),
	{ name: 'iam admin', path: '/iam/admin/rpc', body: { method: 'listPrincipals', input: null } },
	{ name: 'operations', path: '/operations/api/rpc', body: { method: 'issues', input: null } },
]
const GITHUB: readonly Call[] = [
	rpc('sourceConnection.start', { organization: 'acme', appName: 'Acme', visibility: 'private', repositories: [] }),
	rpc('sourceConnection.handoff', { connectionId: 'missing' }),
	rpc('sourceConnection.cancel', { connectionId: 'missing' }),
	rpc('sourceConnection.verifyInstallation', { connectionId: 'missing' }),
	rpc('sourceConnection.repair', { connectionId: 'missing' }),
	rpc('sourceConnection.reconcile', { connectionId: 'missing' }),
]
const APPROVALS: readonly Call[] = [
	rpc('approvals.complete', {
		runId: 'missing',
		decision: 'approve',
		candidateDigest: `sha256:${'a'.repeat(64)}`,
		baselineDigest: `sha256:${'b'.repeat(64)}`,
	}),
	rpc('apps.environments.protect', { appId: 'missing', env: 'stage', protected: false }),
]

describe('a session reaches a console state change only from the console itself', () => {
	const fetch = admissionFixture()

	for (const target of [...MOUNTS, ...GITHUB, ...APPROVALS]) {
		test(`${target.name}: cross-site and same-site sessions are refused at the proxy`, async () => {
			expect(await fetch(call(target, 'cross-site session'))).toBe('proxy 403')
			expect(await fetch(call(target, 'same-site session'))).toBe('proxy 403')
		})

		test(`${target.name}: a same-origin session reaches Control and passes its admission`, async () => {
			const outcome = await fetch(call(target, 'same-origin session'))
			expect(outcome.startsWith('control ')).toBe(true)
			expect(outcome).not.toBe('control 403')
		})
	}
})

test('a doubled slash cannot route a session around the RPC row', async () => {
	const fetch = admissionFixture()
	const doubled = { name: 'installation', path: '//api/rpc', body: { method: 'installation', input: null } }
	expect(await fetch(call(doubled, 'cross-site session'))).toBe('proxy 400')
})

describe('a bearer is explicit authority', () => {
	const fetch = admissionFixture()

	for (const target of MOUNTS) {
		test(`${target.name}: a bearer, with or without a cookie, is served`, async () => {
			expect(await fetch(call(target, 'bearer'))).toBe('control 200')
			expect(await fetch(call(target, 'bearer and cookie'))).toBe('control 200')
		})
	}

	// The accepted relaxation of B10f: Control's same-origin guards refused these without the console's origin.
	for (const target of GITHUB) {
		test(`${target.name}: a person's key reaches the workflow, which reads no origin`, async () => {
			for (const credential of BEARERS) {
				const outcome = await fetch(call(target, credential))
				expect(outcome.startsWith('control ')).toBe(true)
				expect(outcome).not.toBe('control 403')
			}
		})
	}

	for (const target of APPROVALS) {
		test(`${target.name}: a key is refused by authorization, cookie or not`, async () => {
			expect(await fetch(call(target, 'bearer'))).toBe('control 403')
			expect(await fetch(call(target, 'bearer and cookie'))).toBe('control 403')
		})
	}
})

describe("an organization owner's browser has no console session", () => {
	const fetch = admissionFixture()
	const get = (path: string) => fetch(new Request(`${CONSOLE_ORIGIN}${path}`))

	test('the handoff routes reach Control, which authenticates them by the attempt', async () => {
		expect(await get('/api/source/github/handoff/missing')).toBe('control 200')
		const posted = await fetch(
			new Request(`${CONSOLE_ORIGIN}/api/source/github/handoff/missing`, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: 'token=guess',
			}),
		)
		expect(posted).toBe('control 404')
		expect(await get('/api/source/github/handoff-callback?code=one-time&state=guess')).toBe('control 409')
		expect(await get('/api/source/github/handoff-setup/missing?installation_id=1&setup_action=install')).toBe('control 404')
	})

	test("the administrator's own routes still need a session", async () => {
		for (
			const path of ['/api/source/github/manifest/missing', '/api/source/github/callback?code=one-time&state=guess', '/api/source/github/setup/missing']
		) {
			expect(await get(path)).toStartWith('proxy ')
		}
	})
})

// ADR-0050 §4: the link a deploy request prints is `<console>/approvals/<run id>`. Opening it signs a person in and
// shows the run; only the console's own same-origin POST decides it.
describe('the approval link', () => {
	const RUN_ID = '01a15abc-0000-7000-8000-000000000000'
	const LINK = `${CONSOLE_ORIGIN}/approvals/${RUN_ID}`
	const navigate = { 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' }

	test('opened without a session, it goes through IAM sign-in and returns to the same approval', async () => {
		// IAM keeps the return URL the bounce named and answers it with the session; `signedIn` stands in for that.
		let signedIn: string | null = null
		const { fetch } = consoleFixture({
			session: adminToken,
			exchangeAuthCode: () =>
				signedIn === null
					? { ok: false, reason: 'invalid_code' }
					: { ok: true, session: 'app-session', returnUrl: signedIn, expiresAt: Math.floor(Date.now() / 1000) + 300 },
		})

		const bounce = await fetch(new Request(LINK, { headers: navigate }))
		expect(bounce.outcome).toBe('proxy 302')
		const login = new URL(bounce.response.headers.get('location') ?? '')
		expect(`${login.origin}${login.pathname}`).toBe(`${TEST_ISSUER}/auth/login`)
		expect(login.searchParams.get('redirect')).toBe(LINK)

		signedIn = login.searchParams.get('redirect')
		const state = login.searchParams.get('state') ?? ''
		const handoff = bounce.response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${HANDOFF_COOKIE_PREFIX}${state}=`))
		const back = await fetch(
			new Request(`${CONSOLE_ORIGIN}${AUTH_CALLBACK_PATH}?code=one-time&state=${state}`, {
				headers: { ...navigate, cookie: handoff?.split(';')[0] ?? '' },
			}),
		)
		expect(back.outcome).toBe('proxy 302')
		expect(back.response.headers.get('location')).toBe(LINK)
		expect(back.response.headers.getSetCookie().some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=app-session`))).toBe(true)

		const page = await fetch(new Request(LINK, { headers: { ...navigate, cookie: `${SESSION_COOKIE}=app-session` } }))
		expect(page.outcome).toBe('control 200')
		expect(await page.response.text()).toBe('dashboard')
	})

	test('opening it changes no run state, and a cross-site POST of the decision is refused before Control', async () => {
		const { fetch, harness } = consoleFixture()
		const envelope = JSON.stringify({ provider: 'harbor', version: 1, payload: {} })
		await harness.repositories.registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes', defaultBranch: 'main' })
		await harness.repositories.registry.upsertAppEnv({
			appId: 'notes',
			env: 'prod',
			namespaceId: null,
			provider: 'harbor',
			providerTargetJson: envelope,
			providerArtifactJson: envelope,
		})
		await harness.repositories.runs.createRun({ id: RUN_ID, appId: 'notes', env: 'prod', ref: 'c'.repeat(40), trigger: 'manual', actor: 'service:svc' })
		await harnessDatabase(harness.repositories)
			.prepare(`UPDATE runs SET status = 'awaiting_approval', approval_deadline = ? WHERE id = ?`)
			.bind(Math.floor(Date.now() / 1000) + 3600, RUN_ID)
			.run()
		const before = await harness.repositories.runs.getRun(RUN_ID)
		expect(before?.status).toBe('awaiting_approval')

		// A link scanner without a session is bounced; a person's browser gets the console's page, which reads the run.
		expect((await fetch(new Request(LINK, { headers: navigate }))).outcome).toBe('proxy 302')
		expect((await fetch(new Request(LINK, { headers: { ...navigate, cookie: `${SESSION_COOKIE}=s` } }))).outcome).toBe('control 200')
		for (const decision of ['approve', 'reject'] as const) {
			const complete = rpc('approvals.complete', {
				runId: RUN_ID,
				decision,
				candidateDigest: `sha256:${'a'.repeat(64)}`,
				baselineDigest: `sha256:${'b'.repeat(64)}`,
			})
			expect((await fetch(call(complete, 'cross-site session'))).outcome).toBe('proxy 403')
		}
		expect(await harness.repositories.runs.getRun(RUN_ID)).toEqual(before)
	})
})
