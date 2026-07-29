// Shared test helpers. Not a `*.test.ts`, so bun won't run it — but it is still
// typechecked as part of the package.

import type { AuthContext } from '@fabrika/auth'
import type { RequestExecutionContext } from '../app.js'

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object'
}

/** Narrow an `unknown` (e.g. parsed JSON) to a record, throwing if it isn't one. */
export function record(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`expected an object, got ${value === null ? 'null' : typeof value}`)
	return value
}

export function fakeAuth(allowed: ReadonlyArray<string>): AuthContext {
	return {
		ok: true,
		principal: { id: 'u1', type: 'user', label: 'User One' },
		can(action) {
			return allowed.includes(action) || allowed.includes('*')
		},
		scopedTo() {
			return null
		},
		async audit() {},
	}
}

export function fakeExec(): RequestExecutionContext {
	return {
		waitUntil() {},
	}
}

export function jsonRequest(url: string, body: unknown, method = 'POST'): Request {
	return new Request(url, {
		method,
		body: JSON.stringify(body),
		headers: { 'content-type': 'application/json' },
	})
}

export function getRequest(url: string): Request {
	return new Request(url, { method: 'GET' })
}

/** Throw an arbitrary value (lets tests throw structural, non-`Error` payloads). */
export function raise(value: unknown): never {
	throw value
}
