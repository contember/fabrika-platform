/**
 * `/admin/*` — the MACHINE PROVISIONING surface, and the shared admission code `/admin/rpc` uses.
 *
 * It is not a second copy of the administration API. It used to be: about two dozen REST operations
 * mirrored `/admin/rpc` procedure for procedure, and every one of them was a second place a gate
 * could be forgotten (SEC-11) or an internal message could leak (CORR-4) — for operations that had
 * no REST caller at all. They are gone. The console and every operator action go through
 * `/admin/rpc`, so "policy, audit and hidden-object behaviour must not diverge by transport" is no
 * longer a property anyone has to maintain for them; there is one transport.
 *
 * What is left is exactly what cannot be an RPC call from a browser:
 *   - `GET|PUT /admin/apps/:app/schema` — a deploy step reconciling an app's vocabulary
 *     (`reconcileSchema`, `@fabrika/auth`), which runs outside the installation over plain HTTPS;
 *   - `POST /admin/api-keys`, `DELETE /admin/api-keys/:principalId` — first-machine-caller bootstrap,
 *     which runs before a console exists.
 * Both are bearer-authenticated in practice, which is also why they are exempt from the cross-origin
 * check below. Adding a route here means proving no `/admin/rpc` procedure can serve the caller.
 *
 * `extractCredentials`, `rejectCrossOrigin` and `resolveAdmin` live here and are SHARED with
 * `admin/rpc.ts`, so admission is decided in one place for both.
 */

import { API_KEY_PREFIX, type PermissionEntry, permits, type PrincipalType, SESSION_COOKIE } from '@fabrika/auth-core'
import { resolveCaller, sessionUsable } from '../auth'
import { principalStatus } from '../db'
import type { Env, RequestContext } from '../env'
import { logError } from '../log'
import { normalizeOrigin } from '../origin'
import { requestId } from '../request-id'
import { resolveUserPermissions } from '../resolve'
import { hashToken } from '../secret'
import type { Config, Services } from '../services'
import { getSigner, verifyAccessToken } from '../signing'
import { type AdminContext, AdminUseCaseError, getAppSchema, provisionApiKey, putAppSchema, revokeApiKey } from './handlers'
import { error } from './http'

// The pinned sentinel action: only the `admin` role's `*` and bootstrap admins
// hold it. Scope-less → satisfied by a GLOBAL permission only (never a
// project-scoped grant).
export const ADMIN_ACTION = 'iam.admin'

// propustka's own app id — the audience the admin caller is resolved against (the SSO session is
// minted for it in auth/routes.ts). The built-in `admin` role is cross-app, so a global admin grant
// still resolves here regardless.
export const IAM_APP = 'propustka'

/**
 * The propustka-native admin credentials read off the request: a browser SSO session
 * (`px_session` cookie) and/or an `Authorization: Bearer` credential. A bearer may be a `px_`
 * admin/provisioning key or a proxy-injected access JWT forwarded by a first-party gateway.
 */
export function extractCredentials(request: Request, correlationId?: string): {
	bearer: string | null
	session: string | null
	requestId: string
} {
	const bearer = readBearer(request.headers.get('Authorization'))
	const session = parseCookie(request.headers.get('Cookie'), SESSION_COOKIE)
	return { bearer, session, requestId: correlationId ?? requestId(request) }
}

/** Read the token out of an `Authorization: Bearer <token>` header. Null when absent/non-bearer. */
function readBearer(header: string | null): string | null {
	if (header === null) {
		return null
	}
	const match = /^Bearer\s+(.+)$/i.exec(header.trim())
	return match ? (match[1]?.trim() ?? null) : null
}

function parseCookie(header: string | null, name: string): string | null {
	if (!header) {
		return null
	}
	for (const part of header.split(';')) {
		const eq = part.indexOf('=')
		if (eq === -1) {
			continue
		}
		if (part.slice(0, eq).trim() === name) {
			return part.slice(eq + 1).trim()
		}
	}
	return null
}

/**
 * Methods with no side effects. An ALLOWLIST, not a list of the state-changing ones: the previous
 * denylist omitted `PUT`, which is how `PUT /admin/apps/:app/schema` skipped the check, and any
 * method invented later would have skipped it too (SEC-29). Anything not named here is checked.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * In-app CSRF defense: reject a cookie-authenticated state change on `/admin/*` that did not come
 * from a REGISTERED admin origin. Returns `null` when allowed.
 *
 * **The origins compared against are configured (`ADMIN_ORIGINS`), never derived.** The admin surface
 * is driven by the unified console, which lives on the CONTROL PLANE's public domain — a coordinate
 * IAM cannot infer. It used to compare against its own issuer, which the browser never sends for a
 * console request; the gateway then rewrote the `Origin` header to make the comparison pass, and a
 * deployment whose private RPC address differed from its public issuer (the normal production shape)
 * answered every console write with 403. Both halves of that are gone: the header arrives as the
 * browser sent it, and IAM is TOLD which origins may drive it.
 *
 * It is also not `new URL(request.url).origin`. Behind a TLS-terminating balancer the process is
 * reached over plain HTTP, so the reconstructed origin is `http://host` while the browser truthfully
 * sent `https://host` — the same rule as the session cookie's `Secure` flag: the socket is the wrong
 * signal for what the browser did.
 *
 * An EMPTY registry rejects every cookie-authenticated write. That is the fail-closed default and it
 * is deliberately not "allow the issuer": an installation that has not named its console has not
 * decided anything, and guessing on its behalf is what produced the defect above.
 *
 * **A request authenticated SOLELY by `Authorization` is exempt.** CSRF exists because a browser
 * attaches cookies by itself; a bearer token is never attached automatically, so the check buys
 * nothing against a bearer-only request while blocking every CI and provisioning caller — including
 * the documented first-administrator bootstrap. A request carrying a session cookie is checked even
 * if it also carries a bearer: ambient authority is present, so the defense applies.
 *
 * **A request with NO credential at all is CHECKED, not exempt, and that is deliberate.** The
 * exemption above rests on one fact — a browser never attaches `Authorization` by itself — and there
 * is no equivalent fact for a credential-less request: a hostile page can make a cross-site
 * credential-less POST trivially. It matters because `resolveAdmin` treats "no credential presented"
 * as the LOCAL-DEV BYPASS and answers with a synthetic global admin, so exempting it would hand any
 * page a developer visits write access to their local IAM. A machine caller that means to write
 * presents a key; that is what the local stack provisions and what `smoke.ts` sends.
 */
export function rejectCrossOrigin(request: Request, config: Pick<Config, 'adminOrigins'>): Response | null {
	if (SAFE_METHODS.has(request.method)) {
		return null
	}
	const { bearer, session } = extractCredentials(request)
	if (bearer !== null && session === null) {
		return null
	}
	if (config.adminOrigins.length === 0) {
		// No console origin registered: fail closed rather than accept anything.
		return error(403, 'cross-origin request rejected')
	}
	const origin = request.headers.get('Origin')
	if (origin !== null) {
		return admitted(config, origin) ? null : error(403, 'cross-origin request rejected')
	}
	// No `Origin` (some same-origin requests omit it) → fall back to `Referer`.
	const referer = request.headers.get('Referer')
	if (referer !== null) {
		return admitted(config, referer) ? null : error(403, 'cross-origin request rejected')
	}
	// Neither header present on a cookie-authenticated state change → reject.
	return error(403, 'cross-origin request rejected')
}

/** Is this `Origin`/`Referer` value one of the registered admin origins, canonically compared? */
function admitted(config: Pick<Config, 'adminOrigins'>, value: string): boolean {
	const normalized = normalizeOrigin(value)
	return normalized !== null && config.adminOrigins.includes(normalized)
}

/** The resolved admin (already authenticated; the `iam.admin` gate is applied by `handleAdmin`). */
export interface ResolvedAdmin {
	id: string
	type: PrincipalType
	label: string | null
	permissions: PermissionEntry[]
}

export type AdminResolution =
	| { ok: true; admin: ResolvedAdmin }
	| { ok: false; status: 401 | 403; reason: string }

/**
 * Resolve the admin caller from propustka-native credentials (no Cloudflare Access):
 *   - an access JWT from a first-party app gateway → verify identity, then resolve IAM permissions;
 *   - an `Authorization: Bearer px_<key>` machine credential (CI / provisioning) → `resolveCaller`
 *     (which also covers the local-dev bypass when no credential is presented);
 *   - else the browser's `px_session` SSO cookie → session → principal → resolved permissions.
 * Returns the caller + permissions; `handleAdmin` then enforces `iam.admin`. An ANONYMOUS credential
 * (a passthrough JWT / share link, no principal) is rejected — admin needs an accountable principal.
 */
export async function resolveAdmin(
	services: Services,
	env: Pick<Env, 'FABRIKA_IAM_SIGNING_KEYS' | 'FABRIKA_IAM_PROVISIONING_KEY' | 'ENVIRONMENT'>,
	creds: { bearer: string | null; session: string | null; requestId: string },
): Promise<AdminResolution> {
	// The control gateway receives a proxy-injected access JWT after the browser session has stopped
	// at the proxy. Its audience names the calling app, so verify that signed audience without treating
	// its app-specific permission snapshot as IAM authority; IAM permissions are resolved live below.
	if (creds.bearer !== null && !creds.bearer.startsWith(API_KEY_PREFIX)) {
		const signer = await getSigner(env)
		const claims = await verifyAccessToken(signer, creds.bearer, { issuer: services.config.issuer })
		if (claims === null) {
			return { ok: false, status: 401, reason: 'invalid_token' }
		}
		if (claims.ptype === undefined) {
			return { ok: false, status: 403, reason: 'not_allowed' }
		}
		const principal = await services.repositories.principals.getPrincipalById(claims.sub)
		if (principal === null) {
			return { ok: false, status: 401, reason: 'invalid_token' }
		}
		if (principalStatus(principal) === 'disabled') {
			return { ok: false, status: 403, reason: 'disabled' }
		}
		const permissions = await resolveUserPermissions({
			repositories: services.repositories,
			principal,
			bootstrapAdmins: services.config.bootstrapAdmins,
			app: IAM_APP,
		})
		return { ok: true, admin: { id: principal.id, type: principal.type, label: principal.label, permissions } }
	}

	// Bearer credential (or no credential at all → local-dev bypass) goes through `resolveCaller`.
	if (creds.bearer !== null || creds.session === null) {
		const res = await resolveCaller(services, env, { app: IAM_APP, credential: creds.bearer, requestId: creds.requestId })
		if (!res.ok) {
			const status = res.reason === 'missing_token' || res.reason === 'invalid_token' ? 401 : 403
			return { ok: false, status, reason: res.reason }
		}
		// A credential bound to ANOTHER app never administers IAM. `resolveCredential` already refuses
		// the mismatch, so this is the second lock on the same rule — and the one that reads as a rule
		// rather than as a consequence of how a credential happens to resolve (SEC-7).
		if (res.verifiedApp !== IAM_APP) {
			return { ok: false, status: 403, reason: 'not_allowed' }
		}
		if (res.caller.type === undefined) {
			return { ok: false, status: 403, reason: 'not_allowed' }
		}
		return { ok: true, admin: { id: res.caller.id, type: res.caller.type, label: res.caller.label, permissions: res.caller.permissions } }
	}

	// Browser SSO session: validate the opaque `px_session`, resolve the principal's permissions for
	// propustka's own app (groups don't apply — there is no CF identity cookie here).
	const session = await services.repositories.sessions.getActiveSessionByHash(await hashToken(creds.session))
	if (!session) {
		return { ok: false, status: 401, reason: 'invalid_session' }
	}
	// A session whose method the installation no longer enables must not open the admin surface either.
	if (!sessionUsable(session, services.config)) {
		return { ok: false, status: 401, reason: 'invalid_session' }
	}
	const principal = await services.repositories.principals.getPrincipalById(session.principal_id)
	if (!principal) {
		return { ok: false, status: 401, reason: 'invalid_session' }
	}
	if (principalStatus(principal) === 'disabled') {
		return { ok: false, status: 403, reason: 'disabled' }
	}
	const permissions = await resolveUserPermissions({
		repositories: services.repositories,
		principal,
		bootstrapAdmins: services.config.bootstrapAdmins,
		app: IAM_APP,
	})
	return { ok: true, admin: { id: principal.id, type: principal.type, label: principal.label, permissions } }
}

/**
 * Handle a `/admin/*` PROVISIONING request. The caller is resolved from propustka-native credentials
 * (`px_session` SSO cookie or a `px_` bearer) and every handler runs only after `can('iam.admin')`
 * passes in-Worker (scope-less → global only). Returns 401 when the caller can't be authenticated,
 * 403 when authenticated but not an admin.
 */
export async function handleAdmin(
	request: Request,
	services: Services,
	env: Pick<Env, 'FABRIKA_IAM_SIGNING_KEYS' | 'FABRIKA_IAM_PROVISIONING_KEY' | 'ENVIRONMENT'>,
	ctx: RequestContext,
): Promise<Response> {
	const url = new URL(request.url)
	const creds = extractCredentials(request)

	// CSRF defense: reject cross-origin state-changing writes before touching the DB.
	const crossOrigin = rejectCrossOrigin(request, services.config)
	if (crossOrigin) {
		return crossOrigin
	}

	// Backstop: resolution and the handlers touch D1, which can throw on a transient
	// error. Map any unexpected throw to a 500 (never leak internals) so the admin
	// surface degrades gracefully instead of surfacing a raw rejection.
	try {
		const resolution = await resolveAdmin(services, env, creds)
		if (!resolution.ok) {
			return error(resolution.status, resolution.reason)
		}
		if (!permits(resolution.admin.permissions, ADMIN_ACTION)) {
			return error(403, 'admin permission required')
		}

		const c: AdminContext = {
			services,
			request,
			url,
			admin: resolution.admin,
			app: IAM_APP,
			requestId: creds.requestId,
			ctx,
		}

		return await dispatch(c)
	} catch (err) {
		if (err instanceof AdminUseCaseError) {
			return error(err.httpStatus, err.message)
		}
		logError('admin request failed', err)
		return error(500, 'internal error')
	}
}

/**
 * Path segments after `/admin/`. Returns the matched handler, or 404/405.
 *
 * FOUR operations, and the list is closed. Anything an operator does — principals, grants, roles,
 * policies, share links, sessions, audit — is `/admin/rpc` and only `/admin/rpc`.
 */
async function dispatch(c: AdminContext): Promise<Response> {
	const method = c.request.method
	const segments = c.url.pathname.replace(/^\/admin\/?/, '').split('/').filter(Boolean)
	const [resource, idOrSub, action] = segments

	switch (resource) {
		// GET|PUT /admin/apps/:app/schema — read / reconcile an app's vocabulary. The PUT is
		// `reconcileSchema` in the app SDK, called from a DEPLOY: it runs outside the installation with
		// nothing but a URL and a key, so a service binding is not available to it.
		case 'apps':
			if (segments.length !== 3 || idOrSub === undefined || action !== 'schema') {
				return error(404, 'not found')
			}
			if (method === 'GET') return getAppSchema(c, idOrSub)
			if (method === 'PUT') return putAppSchema(c, idOrSub)
			return methodNotAllowed()

		// POST /admin/api-keys, DELETE /admin/api-keys/:principalId — the first machine caller.
		// Bootstrap runs before any console exists, from a shell script or a stack bring-up holding the
		// provisioning key, so it cannot be a browser-shaped RPC call either.
		case 'api-keys':
			if (idOrSub === undefined) {
				return method === 'POST' ? provisionApiKey(c) : methodNotAllowed()
			}
			if (segments.length !== 2) {
				return error(404, 'not found')
			}
			return method === 'DELETE' ? revokeApiKey(c, idOrSub) : methodNotAllowed()

		default:
			return error(404, 'not found')
	}
}

function methodNotAllowed(): Response {
	return error(405, 'method not allowed')
}
