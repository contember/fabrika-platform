// ─── HTTP errors ─────────────────────────────────────────────────────
//
// The app framework never relies on cross-package `instanceof`. The error contract is purely
// STRUCTURAL: any thrown value MAY expose `httpStatus` / `type` / `message` /
// `issues` / `loginUrl`, and the mapper below reads those fields off whatever it
// is handed. The classes here are a convenience for framework code (and apps
// that want them) — they are not a requirement for interop.

interface ErrorOptions {
	readonly issues?: unknown
	readonly loginUrl?: string
}

export class HttpError extends Error {
	readonly httpStatus: number
	readonly type: string
	readonly issues?: unknown
	readonly loginUrl?: string

	constructor(httpStatus: number, type: string, message: string, options?: ErrorOptions) {
		super(message)
		this.name = new.target.name
		this.httpStatus = httpStatus
		this.type = type
		if (options?.issues !== undefined) this.issues = options.issues
		if (options?.loginUrl !== undefined) this.loginUrl = options.loginUrl
	}
}

export class BadRequestError extends HttpError {
	constructor(message = 'Bad request', options?: ErrorOptions) {
		super(400, 'bad_request', message, options)
	}
}

export class UnauthorizedError extends HttpError {
	constructor(message = 'Unauthorized', options?: ErrorOptions) {
		super(401, 'auth', message, options)
	}
}

export class ForbiddenError extends HttpError {
	constructor(message = 'Forbidden', options?: ErrorOptions) {
		super(403, 'forbidden', message, options)
	}
}

export class NotFoundError extends HttpError {
	constructor(message = 'Not found', options?: ErrorOptions) {
		super(404, 'not_found', message, options)
	}
}

export class ConflictError extends HttpError {
	constructor(message = 'Conflict', options?: ErrorOptions) {
		super(409, 'conflict', message, options)
	}
}

// ─── Structural mapping ──────────────────────────────────────────────

export interface StructuralError {
	readonly httpStatus: number
	readonly type: string
	readonly message: string
	readonly issues?: unknown
	readonly loginUrl?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object'
}

/**
 * Read the structural HTTP-error fields off ANY thrown value. Defaults:
 * `httpStatus → 500`, `type → 'internal'`, `message → the Error message or 'Internal error'`.
 */
export function readStructuralError(err: unknown): StructuralError {
	const record: Record<string, unknown> = isRecord(err) ? err : {}
	const httpStatus = typeof record['httpStatus'] === 'number' ? record['httpStatus'] : 500
	const type = typeof record['type'] === 'string' ? record['type'] : 'internal'
	const message = err instanceof Error
		? err.message
		: typeof record['message'] === 'string'
		? record['message']
		: 'Internal error'
	const issues = record['issues']
	const loginUrl = typeof record['loginUrl'] === 'string' ? record['loginUrl'] : undefined
	return {
		httpStatus,
		type,
		message,
		...(issues !== undefined ? { issues } : {}),
		...(loginUrl !== undefined ? { loginUrl } : {}),
	}
}

export function jsonResponse(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

/** Map any thrown value to a JSON `Response` per the structural error contract. */
export function toErrorResponse(err: unknown): Response {
	const { httpStatus, type, message, issues, loginUrl } = readStructuralError(err)
	const error = {
		type,
		message,
		...(issues !== undefined ? { issues } : {}),
		...(loginUrl !== undefined ? { loginUrl } : {}),
	}
	return jsonResponse({ error }, httpStatus)
}

/** The default `onError` handler — a thin wrapper around {@link toErrorResponse}. */
export function defaultOnError(err: unknown, _request?: Request): Response {
	return toErrorResponse(err)
}
