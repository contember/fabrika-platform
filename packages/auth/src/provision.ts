// Deploy-time schema reconcile — authz-vocabulary as code.
//
// Each app OWNS its authz vocabulary (scope dimensions, action catalog, roles) and declares it
// in its own code as an `AppSchema`. At deploy time the app reconciles that declaration into
// IAM by PUTting it to the idempotent admin endpoint `PUT /admin/apps/:app/schema`, so the
// IAM Worker's DB always mirrors what the app actually checks at runtime. An app's FIRST schema
// reconcile is also how it REGISTERS itself in IAM's app registry.
//
// The same deploy step optionally projects the app's RETURN ORIGINS (ADR-0021) — see
// `returnOrigins` below. That is a SECOND call to a different endpoint, deliberately: the schema is
// vocabulary the application declares, a return origin is a fact the control plane knows, and the
// two must never travel in one body.
//
// This is a DEPLOY/OPERATOR helper, NOT a runtime one: it talks HTTP to the admin origin (not the
// `IAM` service binding) and authenticates with an IAM-issued `px_` ADMIN key as a bearer —
// reconcile is a privileged admin operation. Call it from a deploy step / provisioning script,
// never from request handling.
//
// Idempotent: the endpoint upserts scopes/actions/origin='app' roles and deletes app-origin rows
// absent from the body; origin='custom' policies are never touched. Re-running is safe, and so is
// re-sending the same return-origin set.

import type { AppSchema } from '@fabrika/auth-core'

export interface ReconcileSchemaOptions {
	/** The IAM Worker's admin origin, e.g. `https://iam.example.com` (trailing slash ok). */
	url: string
	/** The app id; its FIRST reconcile registers it in IAM's app registry. */
	app: string
	/** The app's declared vocabulary. */
	schema: AppSchema
	/**
	 * Every origin IAM may hand this app a session at (ADR-0021), as known by the CONTROL PLANE.
	 *
	 * Omit to leave the registry alone; a supplied set REPLACES it, so it must be the complete set for
	 * the app and not just the environment being deployed. It is NEVER read off the `AppSchema`: an app
	 * that could name its own return origin could name any origin, which is the thing the registry
	 * exists to prevent. An empty array is a caller error — clearing the registry is its own admin
	 * operation, not an accident of having nothing to send.
	 */
	returnOrigins?: readonly string[]
	/**
	 * An IAM-issued `px_` ADMIN key, sent as `Authorization: Bearer`. Effectively required: IAM's CSRF
	 * guard exempts BEARER-ONLY callers, and nothing else — a credential-less server-side call sends
	 * neither `Origin` nor `Referer` and is refused whatever the admin-origin registry holds. The
	 * exemption rests on one fact, that a browser never attaches `Authorization` by itself; no such
	 * fact covers a credential-less request, and `resolveAdmin` would read it as a global admin.
	 */
	adminKey?: string
	/** Cancels the in-flight request when schema reconciliation belongs to a deploy lifecycle. */
	signal?: AbortSignal
}

/** Thrown when the admin endpoint rejects the reconcile; `status` is the HTTP status. */
export class ReconcileSchemaError extends Error {
	constructor(message: string, readonly status: number) {
		super(message)
		this.name = 'ReconcileSchemaError'
	}
}

/**
 * Pull a human-readable message out of an admin failure body. REST answers `{ error: "…" }`;
 * `/admin/rpc` answers `{ error: { type, message } }`. Null when neither shape is present.
 */
function errorMessage(value: unknown): string | null {
	if (typeof value !== 'object' || value === null || !('error' in value)) {
		return null
	}
	const message = value.error
	if (typeof message === 'string') {
		return message
	}
	if (typeof message === 'object' && message !== null && 'message' in message && typeof message.message === 'string') {
		return message.message
	}
	return null
}

/**
 * Reconcile one app's declared `AppSchema` into IAM (idempotent), then — when `returnOrigins` is
 * supplied — project that set into IAM's return-origin registry. Resolves on success; throws
 * `ReconcileSchemaError` on a non-2xx response, or `Error` on a half-set service token.
 */
export async function reconcileSchema(options: ReconcileSchemaOptions): Promise<void> {
	const { url, app, schema, returnOrigins, adminKey, signal } = options

	if (returnOrigins !== undefined && returnOrigins.length === 0) {
		throw new Error('reconcileSchema: returnOrigins must not be empty — omit it to leave the registry untouched')
	}

	const headers: Record<string, string> = { 'content-type': 'application/json' }
	if (adminKey !== undefined) {
		headers['authorization'] = `Bearer ${adminKey}`
	}

	// Trim a trailing slash so `${base}${path}` never doubles up.
	const base = url.replace(/\/+$/, '')
	const schemaPath = `/admin/apps/${encodeURIComponent(app)}/schema`
	const response = await fetch(`${base}${schemaPath}`, {
		method: 'PUT',
		headers,
		body: JSON.stringify(schema),
		signal,
	})
	if (!response.ok) {
		throw new ReconcileSchemaError(`PUT /admin/apps/${app}/schema failed (${response.status}): ${await detail(response)}`, response.status)
	}

	if (returnOrigins === undefined) {
		return
	}

	// Second call, second endpoint, and it runs SECOND on purpose: `apps.setReturnOrigins` answers 404
	// for an app IAM has never heard of, and the schema PUT above is what registers it.
	const registration = await fetch(`${base}/admin/rpc`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ method: 'apps.setReturnOrigins', input: { app, origins: [...returnOrigins] } }),
		signal,
	})
	const failure = registration.ok ? await rpcError(registration) : await detail(registration)
	if (failure !== null) {
		throw new ReconcileSchemaError(
			`apps.setReturnOrigins for ${app} failed (${registration.status}): ${failure}`,
			registration.status,
		)
	}
}

/** The admin API's own message for a failed response, falling back to the status text. */
async function detail(response: Response): Promise<string> {
	const payload: unknown = await response.json().catch(() => null)
	return errorMessage(payload) ?? response.statusText
}

/**
 * A single `/admin/rpc` call maps its error onto the HTTP status, so a 2xx is already success. Read
 * the envelope anyway: a body carrying `error` at 200 means the call was answered in a shape this
 * caller did not ask for (a batch, say), and treating it as success would report a registration that
 * never happened. Null when the envelope is clean.
 */
async function rpcError(response: Response): Promise<string | null> {
	const payload: unknown = await response.json().catch(() => null)
	return errorMessage(payload)
}
