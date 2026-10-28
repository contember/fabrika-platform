// `egress: 'public'` (ADR-0071): a cron job that calls the websites its operators name reaches any public host over
// HTTPS or HTTP, never the installation or a private network. The build admits it on a cron job only and records it in
// the artifact; the guard refuses by the URL, by the installation's hosts and, where the runtime resolves names, by the
// addresses; it checks every redirect and bounds each request. The job runs need FABRIKA_TEST_POSTGRES_URL, since a
// job's lease lives in @fabrika/db.

import { compileContract, defineApp } from '@fabrika/app/contract'
import { type ContractImplementation, serve } from '@fabrika/app/implement'
import { applicationSchema, type Database, scoped } from '@fabrika/db'
import { FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'
import { openPostgres } from '@fabrika/db/postgres'
import { SQL } from 'bun'
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { z } from 'zod/v4'
import { CapabilityRefusedError } from '../implement/capability'
import { installEgressGuard, PUBLIC_EGRESS_LIMITS, type PublicEgressRules, publicEgressRules, runAsSite } from '../implement/egress'
import { bootApp, environment, frameworkEnvFor, ISSUER, workloadTokensFor } from './fixtures/implement/harness'
import { tables } from './kit-fixture/src/db/tables'
import { vocabulary } from './kit-fixture/src/vocabulary'
import { migration } from './orm-fixture/migration'

const app = defineApp(vocabulary, tables)
const APP_ID = 'crm@prod'

/** What the crawl job fetched last, and what it read. */
const crawl: { target: string; status: number | null } = { target: 'https://www.example.com/', status: null }

const crawler = app.cron('*/5 * * * *', { actions: ['crm.read'], egress: 'public' }).handle(async ({ ctx }) => {
	const response = await fetch(crawl.target, { signal: ctx.signal })
	await response.text()
	crawl.status = response.status
})
const contract = app.contract(() => ({ jobs: { crawler } }))

describe('the artifact and the build', () => {
	test("records a cron job's egress: 'public' under its site", () => {
		expect(compileContract(contract, tables).declared?.['job:crawler']?.egress).toBe('public')
	})

	test("refuses egress: 'public' on a procedure, a mutation and a webhook, which name their origins", () => {
		const refused = (build: () => unknown): string => {
			try {
				build()
			} catch (error) {
				return error instanceof Error ? error.message : String(error)
			}
			return ''
		}
		// A value the types refuse, as a cast or a widened declaration would carry it.
		const anywhere: readonly `https://${string}`[] = JSON.parse('"public"')
		const group = app.group({ callers: ['human'] }, (r) => ({
			look: r.query({ output: z.strictObject({}), access: { action: 'crm.read', app: true }, egress: anywhere }).handle(() => ({})),
		}))
		expect(refused(() => compileContract(app.contract((c) => ({ api: c.rpc('/api', { group }) })), tables))).toContain(
			"declares egress: 'public', which only a cron job declares",
		)
		const writes = app.group({ callers: ['human'] }, (r) => ({
			poke: r.mutation({ output: z.strictObject({}), access: { action: 'crm.read', app: true }, egress: anywhere }).handle(() => ({})),
		}))
		expect(refused(() => compileContract(app.contract((c) => ({ api: c.rpc('/api', { writes }) })), tables))).toContain(
			"declares egress: 'public', which only a cron job declares",
		)
	})

	test("refuses a job's egress that is neither a list nor 'public', and names 'public' past 16 origins", () => {
		const job = (egress: unknown) => app.cron('0 3 * * *', { actions: ['crm.read'], egress: JSON.parse(JSON.stringify(egress)) }).handle(() => {})
		const refusal = (egress: unknown): string => {
			try {
				compileContract(app.contract(() => ({ jobs: { job: job(egress) } })), tables)
			} catch (error) {
				return error instanceof Error ? error.message : String(error)
			}
			return ''
		}
		expect(refusal('everywhere')).toContain("egress is not a list of origins or 'public'")
		const many = Array.from({ length: 17 }, (_, index) => `https://site-${index}.example.com`)
		expect(refusal(many)).toContain(
			"17 egress origins exceed the limit of 16 (a cron job that calls the websites its operators name declares egress: 'public')",
		)
	})
})

/** A `fetch` stand-in: `answer` per URL, every call recorded with its init. */
function stubFetch(answer: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
	const calls: { url: string; init: RequestInit | undefined }[] = []
	const stub = spyOn(globalThis, 'fetch').mockImplementation(
		Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
			calls.push({ url, init })
			return await answer(url, init)
		}, { preconnect: fetch.preconnect }),
	)
	installEgressGuard()
	return { calls, stub }
}

const NO_RULES: PublicEgressRules = { refusedHosts: new Set(), resolve: null }
const site = "job 'crawler'"

async function refusalOf(work: () => Promise<unknown>): Promise<unknown> {
	return await work().then(() => null, (error: unknown) => error)
}

describe('the guard under public egress', () => {
	let restore: (() => void) | undefined
	afterEach(() => {
		restore?.()
		restore = undefined
	})

	test('reaches a public host over https and http, on the default port', async () => {
		const { calls, stub } = stubFetch(() => new Response('ok'))
		restore = () => stub.mockRestore()
		await runAsSite(site, NO_RULES, async () => {
			expect((await fetch('https://www.example.com/robots.txt')).status).toBe(200)
			expect((await fetch('http://shop.example.org/')).status).toBe(200)
		})
		expect(calls.map((call) => call.url)).toEqual(['https://www.example.com/robots.txt', 'http://shop.example.org/'])
		expect(calls.every((call) => call.init?.redirect === 'manual')).toBe(true)
	})

	test.each([
		['an IPv4 address', 'http://10.0.0.5/'],
		['the metadata address', 'http://169.254.169.254/latest/meta-data/'],
		['an IPv4 address in decimal', 'http://2130706433/'],
		['an IPv6 address', 'http://[::1]/'],
		['a public IP address', 'https://93.184.216.34/'],
		['localhost', 'http://localhost/'],
		['a name under localhost', 'http://app.localhost/'],
		['a name of one label', 'http://iam/'],
		['an internal name', 'http://metadata.google.internal/'],
		['a workers.dev route', 'https://crm-prod.acme.workers.dev/'],
		['a port', 'https://www.example.com:8443/'],
		['another scheme', 'ftp://ftp.example.com/'],
	])('refuses %s before anything is sent', async (_name, url) => {
		const { calls, stub } = stubFetch(() => new Response('ok'))
		restore = () => stub.mockRestore()
		const refusal = await refusalOf(() => runAsSite(site, NO_RULES, () => fetch(url)))
		expect(refusal).toBeInstanceOf(CapabilityRefusedError)
		expect(refusal).toMatchObject({ reason: 'refused_egress' })
		expect(calls).toEqual([])
	})

	test("refuses the installation's own hosts: those its framework variables name, and those Control hands it", async () => {
		const { calls, stub } = stubFetch(() => new Response('ok'))
		restore = () => stub.mockRestore()
		const rules = publicEgressRules({
			FABRIKA_IAM_ISSUER: 'https://iam.acme.cz',
			FABRIKA_OPERATIONS_DSN: 'https://0123@ops.acme.cz/7',
			FABRIKA_APP_DATABASE_URL: 'postgres://crm:secret@db.acme.cz/crm',
			FABRIKA_EGRESS_REFUSED_HOSTS: 'control.acme.cz,Notes.Acme.CZ.',
		}, null)
		expect([...rules.refusedHosts].sort()).toEqual(['control.acme.cz', 'iam.acme.cz', 'notes.acme.cz', 'ops.acme.cz'])
		for (const url of ['https://iam.acme.cz/token', 'https://ops.acme.cz/api', 'https://control.acme.cz/', 'https://notes.acme.cz./']) {
			expect(await refusalOf(() => runAsSite(site, rules, () => fetch(url)))).toMatchObject({
				reason: 'refused_egress',
				message: expect.stringContaining('is a host of this installation'),
			})
		}
		expect((await runAsSite(site, rules, () => fetch('https://www.acme.cz/'))).status).toBe(200)
		expect(calls.map((call) => call.url)).toEqual(['https://www.acme.cz/'])
	})

	test('follows a redirect only after checking its target, and drops credentials on another origin', async () => {
		const { calls, stub } = stubFetch((url) => {
			if (url === 'https://www.example.com/start') return new Response(null, { status: 301, headers: { location: '/' } })
			if (url === 'https://www.example.com/') return new Response(null, { status: 302, headers: { location: 'https://cdn.example.net/home' } })
			if (url === 'https://cdn.example.net/home') return new Response('home')
			if (url === 'https://www.example.com/sneaky') return new Response(null, { status: 307, headers: { location: 'http://169.254.169.254/' } })
			return new Response('missing', { status: 404 })
		})
		restore = () => stub.mockRestore()
		const response = await runAsSite(site, NO_RULES, () => fetch('https://www.example.com/start', { headers: { authorization: 'Bearer k' } }))
		expect(await response.text()).toBe('home')
		expect(response.url).toBe('https://cdn.example.net/home')
		expect(response.redirected).toBe(true)
		expect(calls.map((call) => call.url)).toEqual(['https://www.example.com/start', 'https://www.example.com/', 'https://cdn.example.net/home'])
		expect(new Headers(calls[1]?.init?.headers).get('authorization')).toBe('Bearer k')
		expect(new Headers(calls[2]?.init?.headers).get('authorization')).toBeNull()

		calls.length = 0
		expect(await refusalOf(() => runAsSite(site, NO_RULES, () => fetch('https://www.example.com/sneaky')))).toMatchObject({ reason: 'refused_egress' })
		expect(calls.map((call) => call.url)).toEqual(['https://www.example.com/sneaky'])
	})

	test("hands a manual redirect to the caller, refuses one under 'error', and stops past the limit", async () => {
		let hops = 0
		const { stub } = stubFetch((url) => {
			if (url.startsWith('https://loop.example.com/')) {
				hops += 1
				return new Response(null, { status: 302, headers: { location: `/${hops}` } })
			}
			return new Response(null, { status: 308, headers: { location: 'https://www.example.com/new' } })
		})
		restore = () => stub.mockRestore()
		const manual = await runAsSite(site, NO_RULES, () => fetch('https://www.example.com/old', { redirect: 'manual' }))
		expect(manual.status).toBe(308)
		expect(manual.headers.get('location')).toBe('https://www.example.com/new')
		expect(await refusalOf(() => runAsSite(site, NO_RULES, () => fetch('https://www.example.com/old', { redirect: 'error' })))).toBeInstanceOf(
			TypeError,
		)
		expect(await refusalOf(() => runAsSite(site, NO_RULES, () => fetch('https://loop.example.com/')))).toMatchObject({
			message: expect.stringContaining(`more than ${PUBLIC_EGRESS_LIMITS.maxRedirects} redirects`),
		})
		expect(hops).toBe(PUBLIC_EGRESS_LIMITS.maxRedirects + 1)
	})

	test('sends no Host, forwarding, Sec- or X-Fabrika header on any hop, in follow and in manual mode', async () => {
		const { calls, stub } = stubFetch((url) =>
			url === 'https://www.example.com/'
				? new Response(null, { status: 302, headers: { location: 'https://cdn.example.net/' } })
				: new Response('ok')
		)
		restore = () => stub.mockRestore()
		const headers = {
			host: 'iam.acme.cz',
			'x-forwarded-host': 'iam.acme.cz',
			forwarded: 'host=iam.acme.cz',
			'x-fabrika-token': 'secret',
			'sec-fetch-site': 'same-origin',
			'proxy-authorization': 'Basic x',
			'user-agent': 'site-auditor',
		}
		await runAsSite(site, NO_RULES, () => fetch('https://www.example.com/', { headers }))
		await runAsSite(site, NO_RULES, () => fetch('https://www.example.com/', { headers, redirect: 'manual' }))
		expect(calls.map((call) => call.url)).toEqual(['https://www.example.com/', 'https://cdn.example.net/', 'https://www.example.com/'])
		for (const call of calls) {
			expect([...new Headers(call.init?.headers).keys()]).toEqual(['user-agent'])
		}
	})

	test('refuses a preconnect under public egress, and to an undeclared origin; passes only standard fields to an origin', async () => {
		const { calls, stub } = stubFetch(() => new Response('ok'))
		restore = () => stub.mockRestore()
		expect(await refusalOf(async () => runAsSite(site, NO_RULES, async () => fetch.preconnect('https://www.example.com/')))).toMatchObject({
			reason: 'refused_egress',
		})
		expect(await refusalOf(async () => runAsSite(site, ['https://api.example.com'], async () => fetch.preconnect('https://other.example.com/'))))
			.toMatchObject({ reason: 'undeclared_egress' })
		const bunOnly = JSON.parse('{"unix":"/var/run/docker.sock","proxy":"http://10.0.0.1:3128","method":"POST","body":"x"}')
		await runAsSite(site, ['https://api.example.com'], () => fetch('https://api.example.com/v1', bunOnly))
		expect(calls.map((call) => call.init)).toEqual([{ method: 'POST', body: 'x' }])
	})

	test('a 303 turns a POST into a GET without its body; a 307 sends the body again', async () => {
		const { calls, stub } = stubFetch((url) => {
			if (url === 'https://forms.example.com/see') return new Response(null, { status: 303, headers: { location: '/done' } })
			if (url === 'https://forms.example.com/keep') return new Response(null, { status: 307, headers: { location: '/kept' } })
			return new Response('ok')
		})
		restore = () => stub.mockRestore()
		const post = { method: 'POST', body: 'a=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } }
		await runAsSite(site, NO_RULES, () => fetch('https://forms.example.com/see', post))
		expect(calls[1]).toMatchObject({ url: 'https://forms.example.com/done', init: { method: 'GET', body: null } })
		expect(new Headers(calls[1]?.init?.headers).get('content-type')).toBeNull()
		await runAsSite(site, NO_RULES, () => fetch('https://forms.example.com/keep', post))
		expect(calls[3]?.url).toBe('https://forms.example.com/kept')
		expect(calls[3]?.init?.method).toBe('POST')
		expect(new TextDecoder().decode(new Uint8Array(calls[3]?.init?.body instanceof ArrayBuffer ? calls[3].init.body : new ArrayBuffer(0)))).toBe('a=1')
	})

	test('refuses a body past the cap, by its Content-Length or while it streams', async () => {
		const max = PUBLIC_EGRESS_LIMITS.maxResponseBytes
		const { stub } = stubFetch((url) => {
			if (url.endsWith('/declared')) return new Response('x', { headers: { 'content-length': String(max + 1) } })
			const chunk = new Uint8Array(1024 * 1024)
			let sent = 0
			return new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						if (sent > max) {
							controller.close()
							return
						}
						sent += chunk.byteLength
						controller.enqueue(chunk)
					},
				}),
			)
		})
		restore = () => stub.mockRestore()
		expect(await refusalOf(() => runAsSite(site, NO_RULES, () => fetch('https://big.example.com/declared')))).toMatchObject({
			reason: 'oversized_egress',
		})
		const streamed = await runAsSite(site, NO_RULES, () => fetch('https://big.example.com/streamed'))
		expect(await refusalOf(() => streamed.arrayBuffer())).toMatchObject({ reason: 'oversized_egress' })
	})

	test('bounds the request in time, beside the caller signal', async () => {
		const { calls, stub } = stubFetch(() => new Response('ok'))
		restore = () => stub.mockRestore()
		const caller = new AbortController()
		await runAsSite(site, NO_RULES, () => fetch('https://www.example.com/', { signal: caller.signal }))
		const signal = calls[0]?.init?.signal
		expect(signal).toBeInstanceOf(AbortSignal)
		expect(signal?.aborted).toBe(false)
		caller.abort()
		expect(signal?.aborted).toBe(true)
	})

	describe('a stage that stalls ends with the request signal', () => {
		const stalled = (): ReadableStream<Uint8Array> => new ReadableStream({ pull: () => new Promise<void>(() => {}) })
		const ended = (caller: AbortController): void => void setTimeout(() => caller.abort(new Error('caller gave up')), 20)

		test('the resolver', async () => {
			const { calls, stub } = stubFetch(() => new Response('ok'))
			restore = () => stub.mockRestore()
			const rules: PublicEgressRules = { refusedHosts: new Set(), resolve: () => new Promise(() => {}) }
			const caller = new AbortController()
			ended(caller)
			expect(await refusalOf(() => runAsSite(site, rules, () => fetch('https://www.example.com/', { signal: caller.signal })))).toMatchObject({
				message: 'caller gave up',
			})
			expect(calls).toEqual([])
		})

		test("the request's body", async () => {
			const { calls, stub } = stubFetch(() => new Response('ok'))
			restore = () => stub.mockRestore()
			const caller = new AbortController()
			ended(caller)
			const init: RequestInit = { method: 'POST', body: stalled(), signal: caller.signal }
			expect(await refusalOf(() => runAsSite(site, NO_RULES, () => fetch('https://www.example.com/', init)))).toMatchObject({
				message: 'caller gave up',
			})
			expect(calls).toEqual([])
		})

		test("the answer's body, which the runtime does not abort itself", async () => {
			const { stub } = stubFetch(() => new Response(stalled()))
			restore = () => stub.mockRestore()
			const caller = new AbortController()
			const response = await runAsSite(site, NO_RULES, () => fetch('https://www.example.com/', { signal: caller.signal }))
			ended(caller)
			expect(await refusalOf(() => response.arrayBuffer())).toMatchObject({ message: 'caller gave up' })
		})
	})

	test('with a resolver, refuses a public name of a private address, at every hop', async () => {
		const { calls, stub } = stubFetch((url) =>
			url === 'https://www.example.com/'
				? new Response(null, { status: 302, headers: { location: 'https://rebound.example.net/' } })
				: new Response('ok')
		)
		restore = () => stub.mockRestore()
		const addresses: Readonly<Record<string, readonly string[]>> = {
			'www.example.com': ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'],
			'rebound.example.net': ['93.184.216.35', '::ffff:10.1.2.3'],
			'internal.example.org': ['192.168.1.10'],
			'gone.example.org': [],
		}
		const rules: PublicEgressRules = { refusedHosts: new Set(), resolve: async (host) => addresses[host] ?? [] }
		expect(await refusalOf(() => runAsSite(site, rules, () => fetch('https://internal.example.org/')))).toMatchObject({
			reason: 'refused_egress',
			message: expect.stringContaining('internal.example.org resolves to 192.168.1.10'),
		})
		expect(await refusalOf(() => runAsSite(site, rules, () => fetch('https://gone.example.org/')))).toMatchObject({ reason: 'refused_egress' })
		expect(await refusalOf(() => runAsSite(site, rules, () => fetch('https://www.example.com/')))).toMatchObject({
			message: expect.stringContaining('rebound.example.net resolves to ::ffff:10.1.2.3'),
		})
		expect(calls.map((call) => call.url)).toEqual(['https://www.example.com/'])
	})

	test('a site with origins keeps its exact list: public egress is a cron job declaration, not a wider list', async () => {
		const { stub } = stubFetch(() => new Response('ok'))
		restore = () => stub.mockRestore()
		expect(await refusalOf(() => runAsSite("'api.calls.ping'", ['https://api.example.com'], () => fetch('https://www.example.com/')))).toMatchObject({
			reason: 'undeclared_egress',
		})
	})
})

const URL_VARIABLE = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VARIABLE] ?? ''
const hasPostgres = url !== ''
if (!hasPostgres) {
	console.warn(`public-egress.test.ts: the job runs skipped; set ${URL_VARIABLE} to run them (a job's lease lives in @fabrika/db)`)
}
const schema = applicationSchema(`pubegress-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`)
const connections: Database[] = []

async function admin(statement: string): Promise<void> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		await sql.unsafe(statement)
	} finally {
		await sql.close()
	}
}

beforeAll(async () => {
	if (!hasPostgres) return
	await admin(`create schema ${schema}; set search_path to ${schema}; ${FRAMEWORK_MIGRATIONS.map((file) => file.sql).join('\n')} ${migration}`)
})

afterAll(async () => {
	if (!hasPostgres) return
	for (const connection of connections) await connection.close()
	await admin(`drop schema ${schema} cascade`)
})

describe.skipIf(!hasPostgres)('a cron job that declares it', () => {
	let restore: (() => void) | undefined
	afterEach(() => {
		restore?.()
		restore = undefined
	})

	function deployed(implementation: ContractImplementation, resolve: (host: string) => Promise<readonly string[]>) {
		const database = openPostgres({ url, schema, max: 2 })
		connections.push(database)
		return bootApp(implementation, {
			environment: environment({
				...frameworkEnvFor(implementation),
				FABRIKA_IAM_APP_ID: APP_ID,
				FABRIKA_APP_ORIGIN: 'https://crm.acme.cz',
				FABRIKA_EGRESS_REFUSED_HOSTS: 'control.acme.cz',
			}),
			workloadTokens: workloadTokensFor(implementation, undefined, ISSUER, APP_ID),
			database,
			resolveHost: resolve,
		})
	}

	test("crawls a public site, and fails with the guard's reason on the installation, a private address or its own origin", async () => {
		const { calls, stub } = stubFetch(() => new Response('<html></html>'))
		restore = () => stub.mockRestore()
		const resolved: string[] = []
		const runtime = deployed(serve(contract, { database: scoped(tables) }), async (host) => {
			resolved.push(host)
			return host === 'intranet.acme.cz' ? ['10.0.0.8'] : ['93.184.216.34']
		})
		crawl.target = 'https://www.example.com/'
		expect(await runtime.jobs.run('crawler')).toEqual({ status: 'succeeded', attempts: 1 })
		expect(crawl.status).toBe(200)
		expect(resolved).toEqual(['www.example.com'])
		for (const target of ['https://control.acme.cz/', 'https://crm.acme.cz/api', 'https://intranet.acme.cz/', 'http://127.0.0.1/']) {
			crawl.target = target
			const errors = spyOn(console, 'error').mockImplementation(() => {})
			try {
				expect(await runtime.jobs.run('crawler')).toMatchObject({ status: 'failed', code: 'capability_refused', reason: 'refused_egress' })
			} finally {
				errors.mockRestore()
			}
		}
		expect(calls.map((call) => call.url)).toEqual(['https://www.example.com/'])
	})
})
