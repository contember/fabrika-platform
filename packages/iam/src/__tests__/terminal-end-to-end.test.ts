// The end-to-end witness of ADR-0067: a browser enrolled as a terminal, the real IAM, proxy-core's verify service over
// the endpoint table a contract compiles to, and a hand-written application in place of a framework one. The
// application's identification page and public procedure are plain handlers here: a framework public procedure needs
// Postgres, so the procedure asks IAM through `HttpIamTerminals` (what `ctx.terminals` uses on Bun) with a public
// workload token it exchanged at IAM, exactly as the framework's would. IAM runs on its SQLite harness.

import { compileContract, defineApp, defineVocabulary, schemaFromContract } from '@fabrika/app/contract'
import { HttpIamTerminals } from '@fabrika/auth'
import {
	AUTH_CALLBACK_PATH,
	IDENTIFICATION_QUERY_PARAMETER,
	parseAccessClaims,
	PROXY_TOKEN_HEADER,
	SESSION_COOKIE,
	TOKEN_REFRESH_SKEW_SECONDS,
	WORKLOAD_TOKEN_PATH,
} from '@fabrika/auth-core'
import { unusedDatabase } from '@fabrika/platform/testing'
import {
	APP_QUERY_PARAM,
	AUTH_SIGNOUT_PATH,
	createVerifyService,
	DEFAULT_VERIFY_PATH,
	FORWARDED_HOST_HEADER,
	FORWARDED_METHOD_HEADER,
	FORWARDED_PROTO_HEADER,
	FORWARDED_URI_HEADER,
	MemoryTokenCache,
	type VerifyService,
} from '@fabrika/proxy-core'
import { type ContractProxyApp, contractProxyTable } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { decodeJwt } from 'jose'
import { z } from 'zod/v4'
import { createIamApp } from '../app'
import { TERMINAL_COOKIE } from '../auth/terminals'
import type { Env, RequestContext } from '../env'
import { prop } from '../json'
import { randomToken } from '../oidc'
import { createIamRpc } from '../rpc'
import { hashToken } from '../secret'
import { createHarness, type Harness, seedGrant, seedInlineGrant, seedUser, TEST_SIGNING_KEYS } from './helpers/harness'

const ISSUER = 'https://iam.example.test'
const HOST = 'attendance.example.test'
const APP_ORIGIN = `https://${HOST}`
const APP = 'attendance@prod'
const IDENTIFY = '/kiosk/identify'
const PROVISIONING_KEY = `px_${'p'.repeat(43)}`
const PIN = '4711'
const DAY = 24 * 60 * 60

const vocabulary = defineVocabulary({
	app: 'attendance',
	dimensions: {},
	actions: {
		'attendance.read': 'See attendance',
		'attendance.record': 'Record attendance',
		'reports.read': 'Read reports',
		'terminals.identify': 'Identify a person at a terminal',
	},
	roles: { clerk: { grants: ['attendance.read', 'reports.read'] } },
	terminal: { identify: IDENTIFY },
})
const attendance = defineApp(vocabulary)
const Empty = z.strictObject({})
const desk = attendance.group({ callers: ['human'] }, (r) => ({
	whoami: r.query({ input: Empty, output: Empty, access: { action: 'attendance.read', app: true } }).handle(() => ({})),
	record: r.mutation({ input: Empty, output: Empty, access: { action: 'attendance.record', app: true } }).handle(() => ({})),
	reports: r.query({ input: Empty, output: Empty, access: { action: 'reports.read', app: true } }).handle(() => ({})),
}))
const kiosk = attendance.group({}, (r) => ({
	identify: r.mutation({
		input: z.strictObject({ identification: z.string(), pin: z.string() }),
		output: Empty,
		access: { public: true },
		actions: ['terminals.identify'],
	})
		.handle(() => ({})),
}))
const artifact = compileContract(
	attendance.contract((c) => ({
		api: c.rpc('/api', { desk, kiosk }),
		kiosk: c.spa('/kiosk', { dir: 'dist/kiosk', access: { public: true } }),
		web: c.spa('/', { dir: 'dist/web', access: { member: true } }),
	})),
	{},
)

class TestContext implements RequestContext {
	readonly waitUntil = (_promise: Promise<unknown>): void => {}
}

function iamEnv(h: Harness): Env {
	return {
		DB: unusedDatabase,
		REPOSITORIES: h.repositories,
		HUMAN_EMAIL_DOMAINS: '[]',
		HUMAN_EMAILS: '[]',
		IAM_BOOTSTRAP_ADMINS: '[]',
		ENVIRONMENT: 'stage',
		ISSUER,
		FABRIKA_IAM_SIGNING_KEYS: TEST_SIGNING_KEYS,
		FABRIKA_IAM_PROVISIONING_KEY: PROVISIONING_KEY,
		OIDC_ENABLED: 'false',
		PASSWORD_ENABLED: 'true',
	}
}

/** One browser's cookies, per host; a `Max-Age=0` cookie is dropped as a browser drops it. */
class CookieJar {
	private readonly hosts = new Map<string, Map<string, string>>()

	header(host: string): string | null {
		const cookies = this.hosts.get(host)
		if (cookies === undefined || cookies.size === 0) return null
		return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')
	}

	get(host: string, name: string): string | null {
		return this.hosts.get(host)?.get(name) ?? null
	}

	store(host: string, response: Response): void {
		const cookies = this.hosts.get(host) ?? new Map<string, string>()
		this.hosts.set(host, cookies)
		for (const line of response.headers.getSetCookie()) {
			const [pair = '', ...attributes] = line.split(';').map((part) => part.trim())
			const separator = pair.indexOf('=')
			const name = pair.slice(0, separator)
			if (attributes.includes('Max-Age=0')) {
				cookies.delete(name)
			} else {
				cookies.set(name, pair.slice(separator + 1))
			}
		}
	}
}

/** How the browser made a request; it decides the fetch metadata the proxy and IAM read. */
type Fetched = 'navigate' | 'fetch'

/**
 * The application: an identification page with a PIN pad, the public procedure behind it, and the desk procedures,
 * which answer the claims of the token the proxy forwarded. Only its own PIN store knows who a PIN belongs to.
 */
class AttendanceApplication {
	readonly pins = new Map<string, string>()
	/** The terminal each identification was opened on, as `inspect` named it: the key a PIN throttle would use. */
	readonly inspected: string[] = []

	constructor(
		private readonly terminals: HttpIamTerminals,
		private readonly workloadToken: () => Promise<string>,
	) {}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		if (url.pathname === IDENTIFY) {
			return new Response('<form>PIN pad</form>', { headers: { 'content-type': 'text/html' } })
		}
		if (url.pathname === '/api/kiosk.identify') {
			return this.identify(z.strictObject({ identification: z.string(), pin: z.string() }).parse(await request.json()))
		}
		const token = request.headers.get(PROXY_TOKEN_HEADER)
		return Response.json({ claims: token === null ? null : parseAccessClaims(decodeJwt(token)) })
	}

	private async identify(input: { identification: string; pin: string }): Promise<Response> {
		const caller = { app: APP, credential: await this.workloadToken(), requestId: Bun.randomUUIDv7() }
		const open = await this.terminals.inspectIdentification({ ...caller, id: input.identification })
		if (!open.ok) return Response.json({ refused: open.reason }, { status: 400 })
		this.inspected.push(open.terminal.id)
		const person = this.pins.get(input.pin)
		if (person === undefined) return Response.json({ refused: 'unknown_pin' }, { status: 400 })
		const asserted = await this.terminals.assertIdentity({ ...caller, id: input.identification, principalId: person })
		if (!asserted.ok) return Response.json({ refused: asserted.reason }, { status: 400 })
		return Response.json({ callbackUrl: asserted.callbackUrl })
	}
}

interface World {
	readonly h: Harness
	readonly jar: CookieJar
	readonly application: AttendanceApplication
	readonly person: string
	/** The proxy's clock, Unix seconds: a test moves it to let a cached token come due. */
	clock: number
	/** A browser request to IAM's host or the application's host, answered as-is: redirects are followed by the test. */
	go(url: string, options?: { fetched?: Fetched; body?: unknown }): Promise<Response>
	admin(method: string, input: unknown): Promise<unknown>
	enrol(label: string): Promise<string>
}

async function world(): Promise<World> {
	const h = createHarness()
	const env = iamEnv(h)
	const ctx = new TestContext()
	const iamApp = createIamApp({ membershipTransport: true })
	const iam = (request: Request) => iamApp.fetch(request, env, ctx)
	const json = async (path: string, bearer: string, body: unknown): Promise<unknown> => {
		const response = await iam(
			new Request(`${ISSUER}${path}`, {
				method: path === `/admin/apps/${encodeURIComponent(APP)}/schema` ? 'PUT' : 'POST',
				headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
				body: JSON.stringify(body),
			}),
		)
		const text = await response.text()
		if (response.status !== 200) throw new Error(`IAM refused ${path}: ${response.status} ${text}`)
		return JSON.parse(text)
	}

	// Control's side: the approved schema, the public procedure's workload key, the membership transport key, the
	// return origins.
	const schema = schemaFromContract(artifact)
	await json(`/admin/apps/${encodeURIComponent(APP)}/schema`, PROVISIONING_KEY, schema)
	const publicWorkload = (schema.workloads ?? []).find((workload) => workload.kind === 'public')
	if (publicWorkload === undefined) throw new Error('the contract declares no public procedure')
	const issued = await json('/admin/rpc', PROVISIONING_KEY, {
		method: 'workloads.issueKey',
		input: { app: APP, kind: 'public', name: publicWorkload.name, expiresAt: Math.floor(Date.now() / 1000) + 30 * DAY, keep: null },
	})
	const publicKey = z.string().parse(prop(prop(issued, 'result'), 'key'))
	const transportKey = `px_${randomToken(20)}`
	const now = Math.floor(Date.now() / 1000)
	await h.repositories.membershipTransport.issue({ app: APP, keyHash: await hashToken(transportKey), expiresAt: now + 3600, keep: null, now })

	const administrator = seedUser(h.sqlite, { sub: 'sub-admin', email: 'admin@example.test' })
	seedGrant(h.sqlite, administrator, 'admin', null)
	const adminBearer = await h.adminToken(administrator, { issuer: ISSUER })
	const admin = async (method: string, input: unknown): Promise<unknown> => prop(await json('/admin/rpc', adminBearer, { method, input }), 'result')
	await admin('apps.setReturnOrigins', { app: APP, origins: [APP_ORIGIN] })

	const person = seedUser(h.sqlite, { sub: 'sub-ann', email: 'ann@example.test' })
	await admin('grants.create', { principalId: person, roleKey: 'clerk', app: APP })

	const application = new AttendanceApplication(
		new HttpIamTerminals({ origin: ISSUER, key: transportKey, fetch: (input, init) => iam(new Request(input, init)) }),
		async () => {
			const response = await iam(
				new Request(`${ISSUER}${WORKLOAD_TOKEN_PATH}`, {
					method: 'POST',
					headers: { authorization: `Bearer ${publicKey}`, 'content-type': 'application/json' },
					body: JSON.stringify({ app: APP }),
				}),
			)
			return z.string().parse(prop(await response.json(), 'token'))
		},
	)
	application.pins.set(PIN, person)

	const jar = new CookieJar()
	const proxied: ContractProxyApp = { id: APP, hosts: [HOST], upstream: 'app', scheme: 'https', ...contractProxyTable(artifact) }
	const state: World = {
		h,
		jar,
		application,
		person,
		clock: now,
		async go(url, options = {}) {
			const target = new URL(url)
			const fetched = options.fetched ?? 'navigate'
			const method = options.body === undefined ? 'GET' : 'POST'
			const headers = new Headers(
				fetched === 'navigate'
					? { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Dest': 'document' }
					: { 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
			)
			const cookie = jar.header(target.host)
			if (cookie !== null) headers.set('Cookie', cookie)
			const body = options.body === undefined ? null : JSON.stringify(options.body)
			if (target.origin === ISSUER) {
				const response = await iam(new Request(target, { method, headers, body }))
				jar.store(target.host, response)
				return response
			}
			const decided = await proxy(verifyRequest(target, method, headers))
			jar.store(target.host, decided)
			if (decided.status !== 204) return decided
			const forwarded = new Headers(headers)
			const token = decided.headers.get(PROXY_TOKEN_HEADER)
			if (token !== null) forwarded.set(PROXY_TOKEN_HEADER, token)
			return application.fetch(new Request(target, { method, headers: forwarded, body }))
		},
		admin,
		async enrol(label) {
			const enrolling = seedUser(h.sqlite, { sub: `sub-${label}`, email: `${label}-enrols@example.test` })
			seedInlineGrant(h.sqlite, enrolling, ['iam.terminals.manage'], null, 'propustka')
			const login = await h.signSession(enrolling, { idpSub: null, authenticationMethod: 'password' })
			const response = await iam(
				new Request(`${ISSUER}/auth/terminals/enroll`, {
					method: 'POST',
					headers: {
						Cookie: `${SESSION_COOKIE}=${login}`,
						'Content-Type': 'application/x-www-form-urlencoded',
						'Sec-Fetch-Site': 'same-origin',
						Origin: ISSUER,
					},
					body: `label=${label}`,
				}),
			)
			expect(response.status).toBe(200)
			jar.store(new URL(ISSUER).host, response)
			const token = jar.get(new URL(ISSUER).host, TERMINAL_COOKIE)
			const terminal = token === null ? null : await h.repositories.terminals.getActiveByTokenHash(await hashToken(token))
			if (terminal === null) throw new Error('the browser was not enrolled')
			return terminal.principal_id
		},
	}
	const proxy: VerifyService = createVerifyService({
		manifest: { apps: [proxied] },
		iam: createIamRpc(env, ctx),
		issuer: ISSUER,
		cache: new MemoryTokenCache(),
		now: () => state.clock,
	})
	return state
}

/** The `forward_auth` subrequest Caddy sends for a browser request to the application's host. */
function verifyRequest(target: URL, method: string, browser: Headers): Request {
	const headers = new Headers(browser)
	headers.set(FORWARDED_URI_HEADER, `${target.pathname}${target.search}`)
	headers.set(FORWARDED_HOST_HEADER, target.host)
	headers.set(FORWARDED_METHOD_HEADER, method)
	headers.set(FORWARDED_PROTO_HEADER, 'https')
	return new Request(`http://127.0.0.1:9000${DEFAULT_VERIFY_PATH}?${APP_QUERY_PARAM}=${encodeURIComponent(APP)}`, { headers })
}

function location(response: Response): URL {
	const value = response.headers.get('location')
	if (response.status !== 302 || value === null) throw new Error(`expected a redirect, got ${response.status}`)
	return new URL(value, APP_ORIGIN)
}

/** The terminal's browser opens the application and lands on its identification page; answers the identification id. */
async function bounceToIdentification(w: World): Promise<string> {
	const bounce = location(await w.go(`${APP_ORIGIN}/`))
	expect(`${bounce.origin}${bounce.pathname}`).toBe(`${ISSUER}/auth/login`)
	const identify = location(await w.go(bounce.href))
	expect(`${identify.origin}${identify.pathname}`).toBe(`${APP_ORIGIN}${IDENTIFY}`)
	const page = await w.go(identify.href)
	expect(page.status).toBe(200)
	return identify.searchParams.get(IDENTIFICATION_QUERY_PARAMETER) ?? ''
}

/** The person enters their PIN; the application asserts them and the browser follows IAM's callback through the proxy. */
async function identifyWithPin(w: World, identification: string): Promise<void> {
	const identified = await w.go(`${APP_ORIGIN}/api/kiosk.identify`, { fetched: 'fetch', body: { identification, pin: PIN } })
	expect(identified.status).toBe(200)
	const callbackUrl = new URL(z.string().parse(prop(await identified.json(), 'callbackUrl')))
	expect(`${callbackUrl.origin}${callbackUrl.pathname}`).toBe(`${APP_ORIGIN}${AUTH_CALLBACK_PATH}`)
	const landed = location(await w.go(callbackUrl.href))
	expect(landed.href).toBe(`${APP_ORIGIN}/`)
}

async function claimsAt(w: World, path: string): Promise<{ status: number; claims: unknown }> {
	const response = await w.go(`${APP_ORIGIN}${path}`, { fetched: 'fetch', body: {} })
	return { status: response.status, claims: response.status === 200 ? prop(await response.json(), 'claims') : null }
}

describe('a person on a terminal, through the proxy and the real IAM', () => {
	test('identifies at the application, works under the ceiling plus the terminal, signs out, and the next person identifies afresh', async () => {
		const w = await world()
		const terminalId = await w.enrol('Entrance')
		await w.admin('terminals.setProfile', { terminalId, label: 'Entrance', sessionTtl: 300, asserters: [{ app: APP, ceiling: ['attendance.*'] }] })
		await w.admin('grants.create', { principalId: terminalId, permissions: ['attendance.record'], app: APP })
		// Enrolment signed the administrator out of this browser.
		expect(w.jar.get(new URL(ISSUER).host, SESSION_COOKIE)).toBeNull()

		const first = await bounceToIdentification(w)
		await identifyWithPin(w, first)
		expect(w.application.inspected).toEqual([terminalId])
		const session = w.jar.get(HOST, SESSION_COOKIE)
		if (session === null) throw new Error('the proxy set no session')

		const { status, claims } = await claimsAt(w, '/api/desk.whoami')
		expect(status).toBe(200)
		expect(claims).toMatchObject({
			sub: w.person,
			ptype: 'user',
			amr: 'terminal_assertion',
			terminal: { id: terminalId, label: 'Entrance' },
		})
		const perms = z.array(z.object({ action: z.string(), source: z.string() })).parse(prop(claims, 'perms'))
		// The person's attendance.read survives the ceiling, reports.read does not; attendance.record is the terminal's.
		expect(perms.map(({ action, source }) => ({ action, source })).sort((a, b) => a.action.localeCompare(b.action))).toEqual([
			{ action: 'attendance.read', source: 'grant' },
			{ action: 'attendance.record', source: 'terminal' },
		])
		expect((await claimsAt(w, '/api/desk.record')).status).toBe(200)
		expect((await claimsAt(w, '/api/desk.reports')).status).toBe(403)

		const signout = location(
			await w.go(`${APP_ORIGIN}${AUTH_SIGNOUT_PATH}?redirect=${encodeURIComponent('/kiosk/done')}`, { fetched: 'fetch' }),
		)
		expect(w.jar.get(HOST, SESSION_COOKIE)).toBeNull()
		expect(`${signout.origin}${signout.pathname}`).toBe(`${ISSUER}/auth/terminals/release`)
		expect(location(await w.go(signout.href)).href).toBe(`${APP_ORIGIN}/kiosk/done`)
		expect(await w.h.repositories.sessions.getActiveSessionByHash(await hashToken(session))).toBeNull()

		const second = await bounceToIdentification(w)
		expect(second).not.toBe(first)
		await identifyWithPin(w, second)
		expect((await claimsAt(w, '/api/desk.whoami')).claims).toMatchObject({ sub: w.person, terminal: { id: terminalId } })
	})

	test("revoking the terminal ends its active session once the proxy's cached token comes due", async () => {
		const w = await world()
		const terminalId = await w.enrol('Workshop')
		await w.admin('terminals.setProfile', { terminalId, label: 'Workshop', sessionTtl: 300, asserters: [{ app: APP, ceiling: [] }] })
		await w.admin('grants.create', { principalId: terminalId, permissions: ['attendance.record'], app: APP })
		await identifyWithPin(w, await bounceToIdentification(w))
		const session = w.jar.get(HOST, SESSION_COOKIE)
		if (session === null) throw new Error('the proxy set no session')
		// An empty ceiling: the person brings only their identity, and the terminal its own grants.
		expect((await claimsAt(w, '/api/desk.whoami')).status).toBe(403)
		expect((await claimsAt(w, '/api/desk.record')).status).toBe(200)

		await w.admin('terminals.revoke', { terminalId })
		expect(await w.h.repositories.sessions.getActiveSessionByHash(await hashToken(session))).toBeNull()
		// IAM stamps the token from the real clock, so the proxy's clock moves from now: a slow run must not leave it short.
		w.clock = Math.floor(Date.now() / 1000) + 300 - TOKEN_REFRESH_SKEW_SECONDS
		const bounce = location(await w.go(`${APP_ORIGIN}/`))
		expect(`${bounce.origin}${bounce.pathname}`).toBe(`${ISSUER}/auth/login`)
		// The revoked terminal opens no identification: the browser gets the ordinary sign-in.
		expect((await w.go(bounce.href)).status).toBe(200)
	})
})
