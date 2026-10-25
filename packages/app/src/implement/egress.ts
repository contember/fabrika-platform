// `egress`: while a site's handler runs, the global `fetch` reaches only the HTTPS origins the site declares, or, for a
// cron job that declares `egress: 'public'`, only public hosts (ADR-0070). It stops a mistake and makes a bypass
// conspicuous; it is not a sandbox (ADR-0012 §8): code that kept the `fetch` it found before boot, or opens its own
// sockets, escapes it. The framework's own facilities (mail, connectors, IAM, the object store) run outside the site's
// scope, under their own declarations.

import {
	type DeclaredEgress,
	FABRIKA_EGRESS_REFUSED_HOSTS,
	isPublicAddress,
	normalizedHost,
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
	/** Resolves each hop's host before it is sent, so a public name of a private address is refused; `null` on Cloudflare. */
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
	readonly origins: ReadonlySet<string>
	/** Public egress: `null` for a site that declares origins, or none. */
	readonly open: PublicEgressRules | null
}

const scope = new AsyncLocalStorage<EgressScope>()
const guards = new WeakSet<object>()

/** Runs a site's handler: every `fetch` it starts reaches only `egress`. */
export function runAsSite<T>(site: string, egress: SiteEgress, work: () => Promise<T>): Promise<T> {
	return isOrigins(egress)
		? scope.run({ site, origins: new Set(egress), open: null }, work)
		: scope.run({ site, origins: new Set(), open: egress }, work)
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
 * requests are the platform's, not the site's.
 */
export function platformFacility<T extends object>(facility: T): T {
	return new Proxy(facility, {
		get(target, property) {
			const value: unknown = Reflect.get(target, property, target)
			if (typeof value !== 'function') {
				return value
			}
			return (...args: unknown[]): unknown => scope.exit(() => Reflect.apply(value, target, args))
		},
	})
}

/** `work`, outside any site's scope: a framework call that happens to run inside a handler. */
export function platformCall<T>(work: () => T): T {
	return scope.exit(work)
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>

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
			const origin = originOf(input)
			if (origin !== null && running.origins.has(origin)) {
				return current(input, init)
			}
			return Promise.reject(
				new CapabilityRefusedError(
					'undeclared_egress',
					origin === null
						? `${running.site} called fetch with a URL that is not absolute`
						: `${running.site} calls ${origin}, which it does not declare (egress: ['${origin}'])`,
				),
			)
		},
		{ preconnect: current.preconnect },
	)
	guards.add(guarded)
	globalThis.fetch = guarded
}

function originOf(input: string | URL | Request): string | null {
	try {
		return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).origin
	} catch {
		return null
	}
}

const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])
/** The headers a redirect that turns a request into a `GET` drops with its body (Fetch, "HTTP-redirect fetch"). */
const BODY_HEADERS = ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']
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
	const done = (): void => clearTimeout(timer)
	try {
		return await follow(send, site, rules, request, AbortSignal.any([request.signal, deadline.signal]), done)
	} catch (error) {
		done()
		throw error
	}
}

/** The hops of one request; `done` clears its deadline once its last answer's body is read. */
async function follow(
	send: Fetch,
	site: string,
	rules: PublicEgressRules,
	request: Request,
	signal: AbortSignal,
	done: () => void,
): Promise<Response> {
	const mode = request.redirect
	let url = new URL(request.url)
	let method = request.method
	const headers = new Headers(request.headers)
	// Read once, so that a 307 or a 308 sends it again.
	let body: ArrayBuffer | null = request.body === null ? null : await request.arrayBuffer()
	for (let hop = 0;; hop++) {
		await admit(site, rules, url)
		const response = await send(url.href, { method, headers: new Headers(headers), body, redirect: 'manual', signal })
		const location = REDIRECTS.has(response.status) ? response.headers.get('location') : null
		if (location === null || mode === 'manual') {
			return await capped(site, response, url, hop > 0, done)
		}
		await response.body?.cancel()
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

/** Refuses a hop public egress does not reach: by the URL, by the installation's hosts, by what its name resolves to. */
async function admit(site: string, rules: PublicEgressRules, url: URL): Promise<void> {
	const refusal = publicEgressRefusal(url, rules.refusedHosts)
	if (refusal !== null) {
		throw new CapabilityRefusedError('refused_egress', `${site} calls ${url.origin}, which public egress refuses: ${refusal}`)
	}
	const resolve = rules.resolve
	if (resolve === null) {
		return
	}
	const host = normalizedHost(url.hostname)
	const addresses = await platformCall(() => resolve(host))
	const internal = addresses.find((address) => !isPublicAddress(address))
	if (addresses.length === 0 || internal !== undefined) {
		throw new CapabilityRefusedError(
			'refused_egress',
			`${site} calls ${url.origin}, which public egress refuses: ${
				internal === undefined ? `${host} resolves to no address` : `${host} resolves to ${internal}, which is not a public address`
			}`,
		)
	}
}

/**
 * `response` with its body bounded by `maxResponseBytes`, and the URL and redirect flag of the request it answers,
 * which a response the guard builds would otherwise lose.
 */
async function capped(site: string, response: Response, url: URL, redirected: boolean, done: () => void): Promise<Response> {
	const max = PUBLIC_EGRESS_LIMITS.maxResponseBytes
	const tooLarge = () =>
		new CapabilityRefusedError(
			'oversized_egress',
			`${site}: ${url.origin} answers more than ${max} bytes, the most public egress reads of one response`,
		)
	const declared = Number(response.headers.get('content-length') ?? '0')
	if (Number.isFinite(declared) && declared > max) {
		await response.body?.cancel()
		throw tooLarge()
	}
	if (response.body === null || response.status < 200 || response.status > 599) {
		done()
		return withRequestUrl(response, url, redirected)
	}
	const reader = response.body.getReader()
	let seen = 0
	const bound = new ReadableStream<Uint8Array>({
		async pull(controller) {
			const read = await reader.read().catch((error: unknown) => {
				done()
				throw error
			})
			if (read.done) {
				done()
				controller.close()
				return
			}
			seen += read.value.byteLength
			if (seen > max) {
				done()
				await reader.cancel()
				controller.error(tooLarge())
				return
			}
			controller.enqueue(read.value)
		},
		async cancel(reason) {
			done()
			await reader.cancel(reason)
		},
	})
	const answer = new Response(bound, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	})
	return withRequestUrl(answer, url, redirected)
}

function withRequestUrl(response: Response, url: URL, redirected: boolean): Response {
	try {
		Object.defineProperties(response, { url: { value: url.href }, redirected: { value: redirected } })
	} catch {
		// A runtime whose responses refuse own properties keeps its own `url`; the body bound holds either way.
	}
	return response
}
