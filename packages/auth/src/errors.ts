/**
 * Typed request-time errors + a small authorization helper.
 *
 * These are the shared structural HTTP-error contract `@fabrika/app` maps without any
 * cross-package `instanceof`: each error exposes `{ httpStatus, type, message }` plus an optional
 * `issues` (validation detail). A mapper reads those fields structurally — it never imports these
 * classes — so these shapes and the framework reader are the single contract. They live in
 * `@fabrika/auth` because `requirePermission` consumes an `AuthContext` (a client type).
 *
 * There is deliberately no login-bounce error here: since ADR-0007 the proxy 302s an unauthenticated
 * browser, so an app never has to produce a login URL of its own.
 */

import type { Scope } from '@fabrika/auth-core'
import type { AuthContext } from './types'

/**
 * The structural HTTP-error shape. Anything thrown through a request pipeline that satisfies this can be
 * mapped to a Response without an `instanceof` check: `httpStatus` → the status, `type` → the error
 * envelope's `type`, `message` → its `message`, `issues` → optional detail.
 */
export interface HttpError {
	readonly httpStatus: number
	readonly type: string
	readonly message: string
	readonly issues?: unknown
}

/** A caller is unauthenticated. `type: 'auth'`, status 401. */
export class UnauthenticatedError extends Error implements HttpError {
	readonly httpStatus = 401
	readonly type = 'auth'

	constructor(message = 'authentication required') {
		super(message)
		this.name = 'UnauthenticatedError'
	}
}

/** A resolved caller lacks the required permission. `type: 'forbidden'`, status 403. */
export class ForbiddenError extends Error implements HttpError {
	readonly httpStatus = 403
	readonly type = 'forbidden'

	constructor(message = 'forbidden') {
		super(message)
		this.name = 'ForbiddenError'
	}
}

/**
 * Assert the caller may perform `action` (optionally within `scope`). Throws `ForbiddenError` when
 * `auth.can(action, scope)` is false; otherwise returns. The thrown error satisfies the structural
 * `HttpError` contract, so a pipeline maps it to a 403 without importing this module.
 */
export function requirePermission(auth: AuthContext, action: string, scope?: Scope): void {
	if (!auth.can(action, scope)) {
		throw new ForbiddenError(`missing permission: ${action}`)
	}
}
