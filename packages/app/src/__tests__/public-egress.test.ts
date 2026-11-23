// `egress: 'public'` (ADR-0075): a cron job that calls the websites its operators name reaches any public host over
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
import { createServer } from 'node:net'
import { z } from 'zod/v4'
import { CapabilityRefusedError } from '../implement/capability'
import { installEgressGuard, platformCall, PUBLIC_EGRESS_LIMITS, type PublicEgressRules, publicEgressRules, runAsSite } from '../implement/egress'
import { bootApp, environment, frameworkEnvFor, ISSUER, workloadTokensFor } from './fixtures/implement/harness'
import { tables } from './kit-fixture/src/db/tables'
import { vocabulary } from './kit-fixture/src/vocabulary'
import { migration } from './orm-fixture/migration'

const app = defineApp(vocabulary, tables)
/** The `fetch` this file found: Bun's own, or already guarded when an earlier file in the run booted an application. */
const nativeFetch = globalThis.fetch
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
		['credentials in the URL', 'https://crawler:secret@www.example.com/'],
		['the IPv4-mapped loopback', 'http://[::ffff:127.0.0.1]/'],
		["Azure's host endpoint", 'http://168.63.129.16/metadata/instance'],
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
		// Without a resolver (a Worker) no hop is pinned: no serverName, and the runtime's own pooling.
		expect(calls.map((call) => call.init !== undefined && ('tls' in call.init || 'keepalive' in call.init))).toEqual([false, false, false])

		calls.length = 0
		expect(await refusalOf(() => runAsSite(site, NO_RULES, () => fetch('https://www.example.com/sneaky')))).toMatchObject({ reason: 'refused_egress' })
		expect(calls.map((call) => call.url)).toEqual(['https://www.example.com/sneaky'])
	})

	test.each([
		['the metadata address', 'http://169.254.169.254/latest/meta-data/'],
		['a private address', 'https://10.0.0.5/'],
		['localhost', 'http://localhost:8080/'],
		['an internal name', 'http://metadata.google.internal/computeMetadata/v1/'],
		['credentials', 'https://user:pass@cdn.example.net/'],
		['another scheme', 'file:///etc/passwd'],
	])('refuses a redirect to %s, and sends nothing to it', async (_name, location) => {
		const { calls, stub } = stubFetch(() => new Response(null, { status: 302, headers: { location } }))
		restore = () => stub.mockRestore()
		expect(await refusalOf(() => runAsSite(site, NO_RULES, () => fetch('https://www.example.com/')))).toMatchObject({ reason: 'refused_egress' })
		expect(calls.map((call) => call.url)).toEqual(['https://www.example.com/'])
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
			expect([...new Headers(call.init?.headers).entries()]).toEqual([['accept-encoding', 'identity'], ['user-agent', 'site-auditor']])
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
		const [sent] = calls
		expect(Object.keys(sent?.init ?? {}).sort()).toEqual(['body', 'headers', 'method', 'redirect', 'signal'])
		expect(sent?.init).toMatchObject({ method: 'POST', redirect: 'manual' })
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
		// The guard reads the body before the caller gets the answer, so a body past the cap never reaches it.
		expect(await refusalOf(() => runAsSite(site, NO_RULES, () => fetch('https://big.example.com/streamed')))).toMatchObject({
			reason: 'oversized_egress',
		})
	})

	test('asks every hop for identity with no decoding, and refuses an encoded answer unread', async () => {
		let cancelled = false
		const { calls, stub } = stubFetch(() =>
			new Response(new ReadableStream({ pull: () => new Promise<void>(() => {}), cancel: () => void (cancelled = true) }), {
				headers: { 'content-encoding': 'br' },
			})
		)
		restore = () => stub.mockRestore()
		const headers = { 'accept-encoding': 'gzip, br' }
		expect(await refusalOf(() => runAsSite(site, NO_RULES, () => fetch('https://www.example.com/', { headers })))).toMatchObject({
			reason: 'encoded_egress',
		})
		expect(cancelled).toBe(true)
		expect(new Headers(calls[0]?.init?.headers).get('accept-encoding')).toBe('identity')
		expect(Reflect.get(calls[0]?.init ?? {}, 'decompress')).toBe(false)
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
			ended(caller)
			expect(await refusalOf(() => runAsSite(site, NO_RULES, () => fetch('https://www.example.com/', { signal: caller.signal })))).toMatchObject({
				message: 'caller gave up',
			})
		})
	})

	describe("a stage that stalls ends at the guard's own deadline, with no caller signal", () => {
		const original = globalThis.setTimeout
		afterEach(() => Reflect.set(globalThis, 'setTimeout', original))
		// The guard's deadline, shortened: every other timer keeps its delay.
		const shortenDeadline = (): void => {
			Reflect.set(
				globalThis,
				'setTimeout',
				(handler: () => void, delay?: number) => original(handler, delay === PUBLIC_EGRESS_LIMITS.timeoutMs ? 20 : delay),
			)
		}
		const timedOut = { name: 'TimeoutError', message: 'public egress request timed out' }

		test('the resolver', async () => {
			const { calls, stub } = stubFetch(() => new Response('ok'))
			restore = () => stub.mockRestore()
			shortenDeadline()
			const rules: PublicEgressRules = { refusedHosts: new Set(), resolve: () => new Promise(() => {}) }
			expect(await refusalOf(() => runAsSite(site, rules, () => fetch('https://www.example.com/')))).toMatchObject(timedOut)
			expect(calls).toEqual([])
		})

		test('the connection, whose signal the guard aborts', async () => {
			const { calls, stub } = stubFetch((_url, init) =>
				new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))
			)
			restore = () => stub.mockRestore()
			shortenDeadline()
			expect(await refusalOf(() => runAsSite(site, NO_RULES, () => fetch('https://www.example.com/')))).toMatchObject(timedOut)
			expect(calls[0]?.init?.signal?.aborted).toBe(true)
		})

		test("the answer's body, which the guard cancels", async () => {
			let cancelled = false
			const { stub } = stubFetch(() =>
				new Response(new ReadableStream({ pull: () => new Promise<void>(() => {}), cancel: () => void (cancelled = true) }))
			)
			restore = () => stub.mockRestore()
			shortenDeadline()
			expect(await refusalOf(() => runAsSite(site, NO_RULES, () => fetch('https://www.example.com/')))).toMatchObject(timedOut)
			expect(cancelled).toBe(true)
		})
	})

	describe("over Bun's own fetch, to a local server standing in for a public host", () => {
		let stop: (() => Promise<void>) | undefined
		afterEach(async () => {
			await stop?.()
			stop = undefined
		})
		/** Sends every hop of the guard to `port` through Bun's own `fetch`, its `init` as given; `observe` sees a copy of each answer. */
		const forwardingTo = (port: number, observe?: (response: Response) => Promise<void>) => {
			const { stub } = stubFetch(async (url, init) => {
				// Outside the site's scope: a guard installed before this file would refuse the local port.
				const response = await platformCall(() => nativeFetch(`http://127.0.0.1:${port}${new URL(url).pathname}`, init))
				await observe?.(response.clone())
				return response
			})
			restore = () => stub.mockRestore()
		}
		/** Serves `answer` locally and sends every hop of the guard there. */
		const serving = (answer: (path: string) => Response, observe?: (response: Response) => Promise<void>) => {
			const encodings: (string | null)[] = []
			const server = Bun.serve({
				hostname: '127.0.0.1',
				port: 0,
				fetch: (request) => {
					encodings.push(request.headers.get('accept-encoding'))
					return answer(new URL(request.url).pathname)
				},
			})
			stop = () => server.stop(true)
			forwardingTo(Number(server.url.port), observe)
			return encodings
		}
		/** 64 MiB, one MiB every 10 ms as a network delivers it; `cancelled` settles with what was sent when the client hung up. */
		const paced = () => {
			const { promise: cancelled, resolve } = Promise.withResolvers<number>()
			let sent = 0
			const chunk = new Uint8Array(1024 * 1024)
			const body = new ReadableStream<Uint8Array>({
				async pull(controller) {
					await Bun.sleep(10)
					if (sent >= 64 * chunk.byteLength) return controller.close()
					sent += chunk.byteLength
					controller.enqueue(chunk)
				},
				cancel: () => resolve(sent),
			})
			return { body, cancelled, all: 64 * chunk.byteLength }
		}

		test('a compressed answer (a gzip bomb) is refused undecoded, and the request asked for identity', async () => {
			const bomb = Bun.gzipSync(new Uint8Array(64 * 1024 * 1024))
			const received: number[] = []
			const encodings = serving(
				() => new Response(bomb, { headers: { 'content-encoding': 'gzip' } }),
				async (response) => void received.push((await response.arrayBuffer()).byteLength),
			)
			expect(await refusalOf(() => runAsSite(site, NO_RULES, () => fetch('https://www.example.com/')))).toMatchObject({
				reason: 'encoded_egress',
			})
			expect(encodings).toEqual(['identity'])
			// What Bun handed over with the guard's own options: the compressed bytes, not 64 MiB it decoded.
			expect(received).toEqual([bomb.byteLength])
		})

		test('a body past the cap closes the connection at the cap, though the caller never reads it', async () => {
			const { body, cancelled, all } = paced()
			serving(() => new Response(body))
			expect(await refusalOf(() => runAsSite(site, NO_RULES, () => fetch('https://www.example.com/')))).toMatchObject({
				reason: 'oversized_egress',
			})
			expect(await cancelled).toBeLessThan(all)
		})

		test('a status no Response carries (600) is refused, and the connection closes before the body arrives', async () => {
			const { promise: closed, resolve } = Promise.withResolvers<number>()
			const chunk = Buffer.alloc(1024 * 1024)
			const server = createServer((socket) => {
				let sent = 0
				socket.once('close', () => resolve(sent))
				socket.once('data', async () => {
					socket.write('HTTP/1.1 600 Custom\r\nContent-Type: application/octet-stream\r\nTransfer-Encoding: chunked\r\n\r\n')
					for (let index = 0; index < 64 && !socket.destroyed; index++) {
						await Bun.sleep(10)
						socket.write(`${chunk.byteLength.toString(16)}\r\n`)
						socket.write(chunk)
						socket.write('\r\n')
						sent += chunk.byteLength
					}
					socket.end('0\r\n\r\n')
				})
			})
			const { promise: listening, resolve: listened } = Promise.withResolvers<number>()
			server.listen(0, '127.0.0.1', () => {
				const address = server.address()
				listened(typeof address === 'object' && address !== null ? address.port : 0)
			})
			stop = () => new Promise((done) => server.close(() => done()))
			forwardingTo(await listening)
			await expect(runAsSite(site, NO_RULES, () => fetch('https://www.example.com/'))).rejects.toThrow('answers status 600')
			expect(await closed).toBeLessThan(64 * chunk.byteLength)
		})

		test("a redirect's body is not downloaded once the guard follows the redirect", async () => {
			const { body, cancelled, all } = paced()
			serving((path) => path === '/old' ? new Response(body, { status: 302, headers: { location: '/new' } }) : new Response('new'))
			const response = await runAsSite(site, NO_RULES, () => fetch('https://www.example.com/old'))
			expect(await response.text()).toBe('new')
			expect(await cancelled).toBeLessThan(all)
		})

		test('a public answer within the bounds reaches the caller whole', async () => {
			serving(() => new Response('<html>ok</html>', { headers: { 'content-type': 'text/html' } }))
			const response = await runAsSite(site, NO_RULES, () => fetch('https://www.example.com/'))
			expect(await response.text()).toBe('<html>ok</html>')
			expect(response.headers.get('content-type')).toBe('text/html')
			expect(response.url).toBe('https://www.example.com/')
		})
	})

	test('with a resolver, refuses a public name of a private address, at every hop', async () => {
		const { calls, stub } = stubFetch((url) =>
			url === 'https://93.184.216.34/'
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
		expect(calls.map((call) => call.url)).toEqual(['https://93.184.216.34/'])
	})

	test.each([
		['fe80::1', 'link-local'],
		['fd00:ec2::254', "AWS's IPv6 metadata address"],
		['100.100.100.200', "Alibaba's metadata address (shared address space)"],
		['192.0.0.192', "Oracle's metadata address"],
		['100.64.0.1', 'shared address space (CGNAT)'],
		['::ffff:169.254.169.254', 'the metadata address, IPv4-mapped'],
		['64:ff9b::a9fe:a9fe', 'the metadata address behind NAT64'],
	])('with a resolver, refuses a public name of %s (%s)', async (address) => {
		const { calls, stub } = stubFetch(() => new Response('ok'))
		restore = () => stub.mockRestore()
		const rules: PublicEgressRules = { refusedHosts: new Set(), resolve: async () => ['93.184.216.34', address] }
		expect(await refusalOf(() => runAsSite(site, rules, () => fetch('https://mixed.example.com/')))).toMatchObject({
			reason: 'refused_egress',
			message: expect.stringContaining(`resolves to ${address}`),
		})
		expect(calls).toEqual([])
	})

	test('connects each hop to the address it checked, with the name as Host and serverName, so a name that rebinds reaches nothing new', async () => {
		const { calls, stub } = stubFetch((url) =>
			url === 'https://93.184.216.34/start'
				? new Response(null, { status: 302, headers: { location: 'https://v6.example.net/next' } })
				: new Response('ok')
		)
		restore = () => stub.mockRestore()
		// A rebinding name: the first answer is public, every later one private.
		const asked: string[] = []
		const answers: Readonly<Record<string, readonly (readonly string[])[]>> = {
			'www.example.com': [['2606:2800:220:1:248:1893:25c8:1946', '93.184.216.34'], ['127.0.0.1']],
			'v6.example.net': [['2a00:1450:4014:80c::200e'], ['10.0.0.1']],
		}
		const rules: PublicEgressRules = {
			refusedHosts: new Set(),
			resolve: async (host) => {
				const answer = answers[host]?.[asked.filter((name) => name === host).length] ?? []
				asked.push(host)
				return answer
			},
		}
		const response = await runAsSite(site, rules, () => fetch('https://WWW.Example.com./start', { headers: { host: 'iam.acme.cz' } }))
		expect(await response.text()).toBe('ok')
		expect(asked).toEqual(['www.example.com', 'v6.example.net'])
		expect(calls.map((call) => call.url)).toEqual(['https://93.184.216.34/start', 'https://[2a00:1450:4014:80c::200e]/next'])
		expect(calls.map((call) => new Headers(call.init?.headers).get('host'))).toEqual(['www.example.com', 'v6.example.net'])
		// Bun checks the certificate against the TLS serverName, not Host.
		expect(calls.map((call) => (call.init !== undefined && 'tls' in call.init ? call.init.tls : undefined))).toEqual([
			{ serverName: 'www.example.com' },
			{ serverName: 'v6.example.net' },
		])
		// Bun pools connections by address: a pooled one may have been checked against another name's certificate.
		expect(calls.map((call) => call.init?.keepalive)).toEqual([false, false])
		expect(response.url).toBe('https://v6.example.net/next')
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
		expect(calls.map((call) => call.url)).toEqual(['https://93.184.216.34/'])
	})
})
