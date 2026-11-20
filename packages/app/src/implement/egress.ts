// `egress`: while a site's handler runs, the global `fetch` reaches only the HTTPS origins the site declares, exactly or
// by a one-label pattern (`egressAdmits` of `@fabrika/auth-core`), or, for a cron job that declares `egress: 'public'`,
// only public hosts (ADR-0075). It stops a mistake and makes a bypass conspicuous; it is not a sandbox (ADR-0012 §8):
// code that kept the `fetch` it found before boot, or opens its own sockets, escapes it. The framework's own facilities
// (mail, connectors, IAM, the object store) run outside the site's scope, under their own declarations.

import {
	type DeclaredEgress,
	egressAdmits,
	type EgressEntry,
	FABRIKA_EGRESS_REFUSED_HOSTS,
	isPublicAddress,
	normalizedHost,
	parseEgressEntry,
	PUBLIC_EGRESS,
	publicEgressRefusal,
} from '@fabrika/auth-core'
import { AsyncLocalStorage } from 'node:async_hooks'
import { CapabilityRefusedError } from './capability'

/** The addresses a host name resolves to, where the runtime exposes resolution: Bun's `node:dns`, never a Worker. */
export type HostResolver = (hostname: string) => Promise<readonly string[]>

/** What public egress refuses beyond what a URL alone shows (`publicEgressRefusal`). */
export interface PublicEgressRules {
	/** The installation's own hosts, normalized: every host a framework variable names, and `FABRIKA_EGRESS_REFUSED_HOSTS`. */
	readonly refusedHosts: ReadonlySet<string>
	/** Resolves each hop's host once, before it is sent to an address checked here; `null` on Cloudflare. */
	readonly resolve: HostResolver | null
}

/** What one site's `fetch` reaches: its declared origins, or the rules of public egress. */
export type SiteEgress = readonly string[] | PublicEgressRules

/**
 * The bounds of one request under public egress, the redirects it follows included. The handler's own signal still
 * aborts it sooner (`ctx.signal`, an `AbortSignal.timeout` of its own).
 */
export const PUBLIC_EGRESS_LIMITS = {
	/** One request, its redirects and the reading of its body included: the abort also stops a body still streaming. */
	timeoutMs: 60_000,
	/** One response's body as the handler reads it; a larger one is refused, by its `Content-Length` or while it streams. */
	maxResponseBytes: 16 * 1024 * 1024,
	/** The redirects one request follows when its `redirect` mode is `follow`, each hop checked again. */
	maxRedirects: 10,
} as const

interface EgressScope {
	/** The site, as a refusal names it. */
	readonly site: string
	readonly entries: readonly EgressEntry[]
	/** Public egress: `null` for a site that declares origins, or none. */
	readonly open: PublicEgressRules | null
}

const scope = new AsyncLocalStorage<EgressScope>()
const guards = new WeakSet<object>()
const parsed = new WeakMap<readonly string[], readonly EgressEntry[]>()

/** Runs a site's handler: every `fetch` it starts reaches only `egress`. */
export function runAsSite<T>(site: string, egress: SiteEgress, work: () => Promise<T>): Promise<T> {
	return isOrigins(egress)
		? scope.run({ site, entries: entriesOf(egress), open: null }, work)
		: scope.run({ site, entries: [], open: egress }, work)
}

/**
 * The approved declaration's entries, parsed once per list. The build and the artifact parser refused every other
 * value, so one that does not parse here admits nothing.
 */
function entriesOf(egress: readonly string[]): readonly EgressEntry[] {
	const known = parsed.get(egress)
	if (known !== undefined) return known
	const entries = egress.flatMap((value) => {
		const entry = parseEgressEntry(value)
		return entry.ok ? [entry.entry] : []
	})
	parsed.set(egress, entries)
	return entries
}

/**
 * The egress a site runs with: its declared origins, or `rules` for `'public'`. Only a cron job's runner holds rules; a
 * site run without them reaches nothing, though the build lets no other site declare `'public'`.
 */
export function siteEgress(declared: DeclaredEgress, rules: PublicEgressRules | null): SiteEgress {
	return declared === PUBLIC_EGRESS ? (rules ?? []) : declared
}

function isOrigins(egress: SiteEgress): egress is readonly string[] {
	return Array.isArray(egress)
}

/**
 * The rules of public egress in one environment: the hosts its framework variables name (IAM, Operations, its own
 * origin, the platform's receivers, the object store), the installation hosts Control hands it, and the resolver the
 * runtime adapter supplies.
 */
export function publicEgressRules(framework: Readonly<Record<string, string>>, resolve: HostResolver | null): PublicEgressRules {
	const hosts = new Set<string>()
	for (const [name, value] of Object.entries(framework)) {
		if (name === FABRIKA_EGRESS_REFUSED_HOSTS) {
			for (const host of value.split(',')) {
				const normalized = normalizedHost(host.trim())
				if (normalized !== '') hosts.add(normalized)
			}
			continue
		}
		const host = urlHost(value)
		if (host !== null) hosts.add(host)
	}
	return { refusedHosts: hosts, resolve }
}

/** The host of a framework variable's value when it is an http(s) URL, such as an origin or a DSN; `null` otherwise. */
function urlHost(value: string): string | null {
	const text = value.trim()
	if (!/^https?:\/\//i.test(text)) return null
	try {
		return normalizedHost(new URL(text).hostname)
	} catch {
		return null
	}
}

/**
 * `facility` with each of its methods run outside any site's scope: a framework facility a handler calls, whose own
 * requests are the platform's, not the site's. Only property reads reach the facility: `in`, `instanceof` and key
 * listings see a copy of its own fields.
 */
export function platformFacility<T extends object>(facility: T): T {
	// The target is an unfrozen copy: a Proxy must answer a frozen property with its own value, never with a wrapper.
	return new Proxy({ ...facility }, {
		get(_copy, property) {
			const value: unknown = Reflect.get(facility, property, facility)
			if (typeof value !== 'function') {
				return value
			}
			return (...args: unknown[]): unknown => scope.exit(() => Reflect.apply(value, facility, args))
		},
	})
}

/** `work`, outside any site's scope: a framework call that happens to run inside a handler. */
export function platformCall<T>(work: () => T): T {
	return scope.exit(work)
}

/** A hop's `init`: the standard fields, and Bun's `decompress` and `tls`, which another runtime ignores. */
type HopInit = RequestInit & { readonly decompress?: boolean; readonly tls?: { readonly serverName: string } }

type Fetch = (input: string, init: HopInit) => Promise<Response>

/**
 * Wraps the global `fetch` in the guard, once: a `fetch` that is already a guard stays. A test that replaces `fetch`
 * after boot replaces the guard with it.
 */
export function installEgressGuard(): void {
	const current = globalThis.fetch
	if (guards.has(current)) {
		return
	}
	const send: Fetch = (input, init) => current(input, init)
	const guarded = Object.assign(
		(input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const running = scope.getStore()
			if (running === undefined) {
				return current(input, init)
			}
			if (running.open !== null) {
				return publicFetch(send, running.site, running.open, input, init)
			}
			const url = urlOf(input)
			if (url !== null && egressAdmits(running.entries, url)) {
				// Only the standard fields: a runtime's own (Bun's `unix`, `proxy`, `tls`) would send the request elsewhere.
				return current(input, standardInit(init))
			}
			return Promise.reject(
				new CapabilityRefusedError(
					'undeclared_egress',
					url === null
						? `${running.site} called fetch with a URL that is not absolute`
						: `${running.site} calls ${url.origin}, which it does not declare (egress: ['${url.origin}'])`,
				),
			)
		},
		{
			// Inside a site's scope a preconnect reaches only a declared origin; public egress, which cannot check a hop
			// before it connects, refuses every one.
			preconnect: (...args: Parameters<typeof current.preconnect>): void => {
				const running = scope.getStore()
				if (running !== undefined) {
					const url = urlOf(args[0])
					if (running.open !== null || url === null || !egressAdmits(running.entries, url)) {
						throw new CapabilityRefusedError(
							running.open === null ? 'undeclared_egress' : 'refused_egress',
							`${running.site} preconnects to ${url?.origin ?? 'a URL that is not absolute'}, which its egress does not reach`,
						)
					}
				}
				if (typeof current.preconnect === 'function') current.preconnect(...args)
			},
		},
	)
	guards.add(guarded)
	globalThis.fetch = guarded
}

/** `init` with the fields of the Fetch standard only. */
function standardInit(init: RequestInit | undefined): RequestInit | undefined {
	if (init === undefined) return undefined
	return {
		...(init.method === undefined ? {} : { method: init.method }),
		...(init.headers === undefined ? {} : { headers: init.headers }),
		...(init.body === undefined ? {} : { body: init.body }),
		...(init.redirect === undefined ? {} : { redirect: init.redirect }),
		...(init.signal === undefined ? {} : { signal: init.signal }),
		...(init.keepalive === undefined ? {} : { keepalive: init.keepalive }),
		...(init.integrity === undefined ? {} : { integrity: init.integrity }),
		...(init.referrer === undefined ? {} : { referrer: init.referrer }),
		...(init.referrerPolicy === undefined ? {} : { referrerPolicy: init.referrerPolicy }),
		...(init.cache === undefined ? {} : { cache: init.cache }),
		...(init.credentials === undefined ? {} : { credentials: init.credentials }),
		...(init.mode === undefined ? {} : { mode: init.mode }),
	}
}

function urlOf(input: string | URL | Request): URL | null {
	try {
		return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
	} catch {
		return null
	}
}

const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])
/** The headers a redirect that turns a request into a `GET` drops with its body (Fetch, "HTTP-redirect fetch"). */
const BODY_HEADERS = ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']
/**
 * The request headers public egress never sends, on any hop: the Fetch standard's forbidden request headers (`Host`
 * among them, which would route a request for a public name to another site at the same address), the forwarding
 * headers a proxy trusts, and the platform's own `X-Fabrika-*`.
 */
const FORBIDDEN_HEADERS = [
	'accept-charset',
	'accept-encoding',
	'access-control-request-headers',
	'access-control-request-method',
	'connection',
	'content-length',
	'cookie2',
	'date',
	'dnt',
	'expect',
	'forwarded',
	'host',
	'keep-alive',
	'origin',
	'referer',
	'set-cookie',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'via',
	'x-http-method',
	'x-http-method-override',
	'x-method-override',
	'x-real-ip',
]
const FORBIDDEN_HEADER_PREFIXES = ['proxy-', 'sec-', 'x-forwarded-', 'x-fabrika-']

function withoutForbiddenHeaders(headers: Headers): Headers {
	for (const name of [...headers.keys()]) {
		if (FORBIDDEN_HEADERS.includes(name) || FORBIDDEN_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix))) {
			headers.delete(name)
		}
	}
	return headers
}

/** The credentials a redirect to another origin drops. */
const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'cookie']

/**
 * One request under public egress. Every hop is sent with `redirect: 'manual'`, so the runtime follows no redirect the
 * guard has not checked: the caller's `follow` is done here, at most `maxRedirects` hops, each host checked again;
 * `manual` hands the caller the redirect, whose next `fetch` passes the guard again; `error` refuses one. The request
 * is bounded in time and its answer's body in size.
 */
async function publicFetch(
	send: Fetch,
	site: string,
	rules: PublicEgressRules,
	input: string | URL | Request,
	init?: RequestInit,
): Promise<Response> {
	const request = new Request(input, init)
	// A timer the guard clears once the body is read, not `AbortSignal.timeout`: on workerd an uncleared timer keeps the
	// Durable Object awake until it fires.
	const deadline = new AbortController()
	const timer = setTimeout(() => deadline.abort(new DOMException('public egress request timed out', 'TimeoutError')), PUBLIC_EGRESS_LIMITS.timeoutMs)
	try {
		return await follow(send, site, rules, request, AbortSignal.any([request.signal, deadline.signal]))
	} finally {
		clearTimeout(timer)
	}
}

/** The hops of one request, its last answer's body read whole. */
async function follow(send: Fetch, site: string, rules: PublicEgressRules, request: Request, signal: AbortSignal): Promise<Response> {
	const mode = request.redirect
	let url = new URL(request.url)
	let method = request.method
	const headers = withoutForbiddenHeaders(new Headers(request.headers))
	// Read once, so that a 307 or a 308 sends it again.
	let body: ArrayBuffer | null = request.body === null ? null : await untilAborted(signal, request.arrayBuffer())
	for (let hop = 0;; hop++) {
		const address = await admit(site, rules, url, signal)
		// Cancelling a body leaves Bun downloading it into memory; only aborting the request closes the connection.
		const dropped = new AbortController()
		const response = await send(address === null ? url.href : pinnedUrl(url, address), {
			method,
			headers: hopHeaders(headers, url, address),
			body,
			redirect: 'manual',
			signal: AbortSignal.any([signal, dropped.signal]),
			// Bun decompresses natively and unbounded: the guard asks for `identity` and reads the bytes as they came.
			decompress: false,
			// Bun checks the certificate against `serverName`, not `Host`, and pools connections by address and port: a
			// pooled one was checked against another name's certificate.
			...(address === null ? {} : { keepalive: false, tls: { serverName: normalizedHost(url.hostname) } }),
		})
		const location = REDIRECTS.has(response.status) ? response.headers.get('location') : null
		if (location === null || mode === 'manual') {
			return await bounded(site, response, url, hop > 0, signal).catch((error: unknown) => {
				dropped.abort(error)
				throw error
			})
		}
		dropped.abort()
		void response.body?.cancel().catch(() => undefined)
		if (mode === 'error') {
			throw new TypeError(`${site}: ${url.origin} redirects, and the request's redirect mode is 'error'`)
		}
		if (hop >= PUBLIC_EGRESS_LIMITS.maxRedirects) {
			throw new TypeError(`${site}: more than ${PUBLIC_EGRESS_LIMITS.maxRedirects} redirects, the last from ${url.origin}`)
		}
		const next = new URL(location, url)
		const toGet = (response.status === 303 && method !== 'GET' && method !== 'HEAD')
			|| ((response.status === 301 || response.status === 302) && method === 'POST')
		if (toGet) {
			method = 'GET'
			body = null
			for (const name of BODY_HEADERS) headers.delete(name)
		}
		if (next.origin !== url.origin) {
			for (const name of CREDENTIAL_HEADERS) headers.delete(name)
		}
		url = next
	}
}

/**
 * Refuses a hop public egress does not reach: by the URL, by the installation's hosts, by what its name resolves to.
 * Answers the checked address the hop must connect to, or `null` where the runtime resolves nothing (a Worker).
 */
async function admit(site: string, rules: PublicEgressRules, url: URL, signal: AbortSignal): Promise<string | null> {
	const refusal = publicEgressRefusal(url, rules.refusedHosts)
	if (refusal !== null) {
		throw new CapabilityRefusedError('refused_egress', `${site} calls ${url.origin}, which public egress refuses: ${refusal}`)
	}
	const resolve = rules.resolve
	if (resolve === null) {
		return null
	}
	const host = normalizedHost(url.hostname)
	const addresses = await untilAborted(signal, platformCall(() => resolve(host)))
	const internal = addresses.find((address) => !isPublicAddress(address))
	const address = addresses.find((candidate) => !candidate.includes(':')) ?? addresses[0]
	if (address === undefined || internal !== undefined) {
		throw new CapabilityRefusedError(
			'refused_egress',
			`${site} calls ${url.origin}, which public egress refuses: ${
				internal === undefined ? `${host} resolves to no address` : `${host} resolves to ${internal}, which is not a public address`
			}`,
		)
	}
	return address
}

/**
 * `url` with its host replaced by the checked `address`, so the runtime connects where the guard looked and never
 * resolves the name again (DNS rebinding). IPv4 first: a container without an IPv6 route still connects.
 */
function pinnedUrl(url: URL, address: string): string {
	const pinned = new URL(url.href)
	pinned.hostname = address.includes(':') ? `[${address}]` : address
	return pinned.href
}

/**
 * A hop's headers: for a pinned hop, `Host` names the checked host, which Bun sends; `follow` names it as the TLS
 * `serverName` too (`public-egress-pinning.test.ts` holds the pinned Bun release to both).
 */
function hopHeaders(headers: Headers, url: URL, address: string | null): Headers {
	const hop = new Headers(headers)
	hop.set('accept-encoding', 'identity')
	if (address !== null) hop.set('host', normalizedHost(url.hostname))
	return hop
}

/** The statuses from 200 up whose answer has no body (Fetch, "null body status"); `Response` refuses one with a body. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304])

/**
 * `response` read whole before the caller sees it, at most `maxResponseBytes`, within the request's deadline, with the
 * URL and redirect flag of the request it answers. Bun buffers a body as it arrives whether or not anyone reads it, so
 * the guard reads it at once and cancels it at the cap. An encoded body is refused unread: the guard asked for
 * `identity`, and decoding it would grow it without a bound the guard controls.
 */
async function bounded(site: string, response: Response, url: URL, redirected: boolean, signal: AbortSignal): Promise<Response> {
	const encoding = response.headers.get('content-encoding')?.trim().toLowerCase() ?? ''
	if (encoding !== '' && encoding !== 'identity') {
		void response.body?.cancel().catch(() => undefined)
		throw new CapabilityRefusedError(
			'encoded_egress',
			`${site}: ${url.origin} answers with Content-Encoding ${encoding}, which public egress neither asks for nor decodes`,
		)
	}
	if (response.status < 200 || response.status > 599) {
		// Bun answers a status a `Response` cannot carry (600 and up); refusing it lets the caller abort the hop.
		throw new TypeError(`${site}: ${url.origin} answers status ${response.status}, which public egress does not read`)
	}
	const init = { status: response.status, statusText: response.statusText, headers: response.headers }
	const body = await readCapped(site, response, url, signal)
	return withRequestUrl(new Response(NULL_BODY_STATUSES.has(response.status) ? null : body, init), url, redirected)
}

/** The bytes of `response`'s body, refused past `maxResponseBytes` by its `Content-Length` or as they arrive. */
async function readCapped(site: string, response: Response, url: URL, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
	const max = PUBLIC_EGRESS_LIMITS.maxResponseBytes
	const tooLarge = () =>
		new CapabilityRefusedError(
			'oversized_egress',
			`${site}: ${url.origin} answers more than ${max} bytes, the most public egress reads of one response`,
		)
	if (response.body === null) {
		return new Uint8Array()
	}
	const declared = Number(response.headers.get('content-length') ?? '0')
	if (Number.isFinite(declared) && declared > max) {
		void response.body.cancel().catch(() => undefined)
		throw tooLarge()
	}
	const reader = response.body.getReader()
	const chunks: Uint8Array[] = []
	let seen = 0
	try {
		for (;;) {
			const read = await untilAborted(signal, reader.read())
			if (read.done) break
			seen += read.value.byteLength
			if (seen > max) throw tooLarge()
			chunks.push(read.value)
		}
	} catch (error) {
		void reader.cancel(error).catch(() => undefined)
		throw error
	}
	const bytes = new Uint8Array(seen)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return bytes
}

/**
 * `work`, or the signal's reason once it aborts, whichever comes first: a stage the runtime does not abort by the
 * signal (a resolver, a body read) still ends at the deadline. The work itself is left to settle unobserved.
 */
async function untilAborted<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
	signal.throwIfAborted()
	let abort = (): void => {}
	const aborted = new Promise<never>((_resolve, reject) => {
		abort = () => reject(signal.reason)
	})
	signal.addEventListener('abort', abort, { once: true })
	try {
		return await Promise.race([work, aborted])
	} finally {
		signal.removeEventListener('abort', abort)
	}
}

function withRequestUrl(response: Response, url: URL, redirected: boolean): Response {
	try {
		Object.defineProperties(response, { url: { value: url.href }, redirected: { value: redirected } })
	} catch {
		// A runtime whose responses refuse own properties keeps its own `url`; the body bound holds either way.
	}
	return response
}
