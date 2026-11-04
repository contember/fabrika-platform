// `egress`: while a site's handler runs, the global `fetch` reaches only the HTTPS origins the site declares, exactly or
// by a one-label pattern (`egressAdmits` of `@fabrika/auth-core`). It stops a mistake and makes a bypass conspicuous; it
// is not a sandbox (ADR-0012 §8): code that kept the `fetch` it found before boot, or opens its own sockets, escapes it.
// The framework's own facilities (mail, connectors, IAM, the object store) run outside the site's scope, under their own
// declarations.

import { egressAdmits, type EgressEntry, parseEgressEntry } from '@fabrika/auth-core'
import { AsyncLocalStorage } from 'node:async_hooks'
import { CapabilityRefusedError } from './capability'

interface EgressScope {
	/** The site, as a refusal names it. */
	readonly site: string
	readonly entries: readonly EgressEntry[]
}

const scope = new AsyncLocalStorage<EgressScope>()
const guards = new WeakSet<object>()
const parsed = new WeakMap<readonly string[], readonly EgressEntry[]>()

/** Runs a site's handler: every `fetch` it starts reaches only `egress`. */
export function runAsSite<T>(site: string, egress: readonly string[], work: () => Promise<T>): Promise<T> {
	return scope.run({ site, entries: entriesOf(egress) }, work)
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

/**
 * Wraps the global `fetch` in the guard, once: a `fetch` that is already a guard stays. A test that replaces `fetch`
 * after boot replaces the guard with it.
 */
export function installEgressGuard(): void {
	const current = globalThis.fetch
	if (guards.has(current)) {
		return
	}
	const guarded = Object.assign(
		(input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const running = scope.getStore()
			if (running === undefined) {
				return current(input, init)
			}
			const url = urlOf(input)
			if (url !== null && egressAdmits(running.entries, url)) {
				return current(input, init)
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
		{ preconnect: current.preconnect },
	)
	guards.add(guarded)
	globalThis.fetch = guarded
}

function urlOf(input: string | URL | Request): URL | null {
	try {
		return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
	} catch {
		return null
	}
}
