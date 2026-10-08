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
 * Adding a route here means proving no `/admin/rpc` procedure can serve the caller.
 *
 * **The whole surface is BEARER-ONLY.** The console reaches it through Control's gateway, which
 * forwards the proxy-injected token as a bearer; machines present a `px_` key. No browser cookie is
 * read, so there is no ambient authority and no CSRF check to keep.
 *
 * `extractCredentials` and `resolveAdmin` live here and are SHARED with `admin/rpc.ts`, so the
 * caller is resolved in one place for both.
 */

import { API_KEY_PREFIX, type PermissionEntry, permits, type PrincipalType } from '@fabrika/auth-core'
import { resolveCaller } from '../auth'
import { principalStatus } from '../db'
import type { Env, RequestContext } from '../env'
import { logError } from '../log'
import { generateRequestId } from '../request-id'
import { resolveUserPermissions } from '../resolve'
import type { Services } from '../services'
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
 * The admin credential read off the request: an `Authorization: Bearer` holding a `px_` admin or
 * provisioning key, or a proxy-injected access JWT forwarded by a first-party gateway.
 */
export function extractCredentials(request: Request, requestId: string): { bearer: string | null; requestId: string } {
	return { bearer: readBearer(request.headers.get('Authorization')), requestId }
}

/** Read the token out of an `Authorization: Bearer <token>` header. Null when absent/non-bearer. */
function readBearer(header: string | null): string | null {
	if (header === null) {
		return null
	}
	const match = /^Bearer\s+(.+)$/i.exec(header.trim())
	return match ? (match[1]?.trim() ?? null) : null
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
 * Resolve the admin caller from its bearer:
 *   - an access JWT whose `aud` is a REGISTERED admin gateway → verify identity, then resolve IAM
 *     permissions;
 *   - a `px_<key>` machine credential (CI / provisioning) → `resolveCaller`.
 * No bearer is 401. Returns the caller + permissions; `handleAdmin` then enforces `iam.admin`. An ANONYMOUS credential
 * (a share link, no principal) is rejected — admin needs an accountable principal.
 */
export async function resolveAdmin(
	services: Services,
	env: Pick<Env, 'FABRIKA_IAM_SIGNING_KEYS' | 'FABRIKA_IAM_PROVISIONING_KEY' | 'ENVIRONMENT'>,
	creds: { bearer: string | null; requestId: string },
): Promise<AdminResolution> {
	if (creds.bearer === null) {
		return { ok: false, status: 401, reason: 'missing_token' }
	}
	// The control gateway receives a proxy-injected access JWT after the browser session has stopped
	// at the proxy. Its signed audience names the calling app and MUST be a registered admin gateway:
	// every app holds this token in cleartext, so an unpinned audience lets any of them replay it.
	if (!creds.bearer.startsWith(API_KEY_PREFIX)) {
		const signer = await getSigner(env)
		const claims = await verifyAccessToken(signer, creds.bearer, { issuer: services.config.issuer })
		if (claims === null) {
			return { ok: false, status: 401, reason: 'invalid_token' }
		}
		if (!services.config.adminAudiences.has(claims.aud)) {
			return { ok: false, status: 403, reason: 'not_allowed' }
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

/**
 * Handle a `/admin/*` PROVISIONING request. The caller is resolved from its bearer and every handler runs only after `can('iam.admin')`
 * passes in-Worker (scope-less → global only). Returns 401 when the caller can't be authenticated,
 * 403 when authenticated but not an admin. `requestId` is the correlation id the composition root
 * allowed (`src/request-id.ts`); a caller that supplies none gets a generated one.
 */
export async function handleAdmin(
	request: Request,
	services: Services,
	env: Pick<Env, 'FABRIKA_IAM_SIGNING_KEYS' | 'FABRIKA_IAM_PROVISIONING_KEY' | 'ENVIRONMENT'>,
	ctx: RequestContext,
	requestId: string = generateRequestId(),
): Promise<Response> {
	const url = new URL(request.url)
	const creds = extractCredentials(request, requestId)

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
