import { API_KEY_PREFIX, type PermissionEntry, type PrincipalType } from '@fabrika/auth-core'
import type { Env } from './env'
import { hashToken, timingSafeEqualHex } from './secret'
import type { Services } from './services'
import { getSigner, verifyAccessToken } from './signing'
import { resolveCredential } from './tokens'

/**
 * Fixed identity for the local dev bypass below. A row with this id is seeded into
 * `principals` (see `seed.dev.sql`) so audit/auth-log foreign keys resolve.
 */
export const LOCAL_DEV_ADMIN_ID = 'local-dev-admin'
export const LOCAL_DEV_ADMIN_EMAIL = 'admin@local.test'

/**
 * Was this session minted by the local-dev bypass? It records the fixed subject above, which no real
 * IdP emits, so the session carries its own provenance and needs no extra column.
 *
 * **Checked at USE, not at creation, and that is the point.** Turning `LOCAL_DEV_LOGIN` off — or
 * moving `ENVIRONMENT` away from `local` — changes what the next request may do and nothing about
 * what was already issued. Sessions live 30 days, so without this an installation that switched to
 * real authentication would keep honouring bypass sessions for a month, and every one of them is a
 * global admin. Closing the window when the configuration changes is the only bound worth having.
 */
export function isDevBypassSession(session: { idp_sub: string | null }): boolean {
	return session.idp_sub === LOCAL_DEV_ADMIN_ID
}

/**
 * Fixed identity for the SEEDED PROVISIONING KEY below. A stable `service` principal with this id is
 * seeded into `principals` (migration `0008_provisioning_principal.sql`) so the audit the provisioning
 * key drives (e.g. `iam.app.schema.reconcile`) resolves its `principal_id` FK — the prod-applied analog
 * of the dev admin's `seed.dev.sql` row.
 */
export const PROVISIONING_ADMIN_ID = 'provisioning-admin'

// ── Native caller resolution (propustka-native credentials, no Cloudflare Access) ──────────────
//
// Resolve the CALLER for the management RPCs (`issueKey`/`issueJwt`/`revokeKey`/`listPrincipals`)
// and the admin gate from a propustka-native credential the SDK forwards — a `px_token` access JWT
// (verified against our OWN signing keys) or an opaque `px_` key (resolved via the same
// `resolveCredential` core as `mintFromKey`). There is no Cloudflare Access JWT anymore.

/** The resolved caller. `type` is absent for an ANONYMOUS credential (a passthrough JWT / share link). */
export interface ResolvedCaller {
	id: string
	type?: PrincipalType
	label: string | null
	permissions: PermissionEntry[]
}

export type CallerResolution =
	| { ok: true; caller: ResolvedCaller; verifiedApp: string }
	| { ok: false; reason: 'missing_token' | 'invalid_token' | 'unknown_principal' | 'disabled' }

export async function resolveCaller(
	services: Services,
	env: Pick<Env, 'FABRIKA_IAM_SIGNING_KEYS' | 'FABRIKA_IAM_PROVISIONING_KEY' | 'ENVIRONMENT'>,
	input: { app: string; credential: string | null; requestId: string },
): Promise<CallerResolution> {
	// LOCAL DEV BYPASS. With NO durable signing keys configured (an ephemeral key ⇒ dev-only) AND no
	// credential presented, resolve a fixed global-admin so the example app / admin scripts work
	// against `lopata`/`wrangler dev`. A real deploy provisions FABRIKA_IAM_SIGNING_KEYS, so this branch
	// is impossible there.
	if (services.config.environment === 'local' && input.credential === null && (env.FABRIKA_IAM_SIGNING_KEYS ?? '').trim() === '') {
		console.warn('local dev bypass active: resolving fixed global-admin caller (ENVIRONMENT=local, no signing keys configured)')
		return {
			ok: true,
			caller: { id: LOCAL_DEV_ADMIN_ID, type: 'user', label: 'local-dev-admin', permissions: [{ action: '*', scope: null, source: 'bootstrap' }] },
			verifiedApp: input.app,
		}
	}

	if (input.credential === null) {
		return { ok: false, reason: 'missing_token' }
	}

	// An opaque `px_` key → resolve its effective permissions (the same 2×2 as mintFromKey).
	if (input.credential.startsWith(API_KEY_PREFIX)) {
		const presentedHash = await hashToken(input.credential)

		// SEEDED PROVISIONING KEY. A single operator-generated `px_` held ONLY in env (never in the DB) —
		// the machine analog of the `IAM_BOOTSTRAP_ADMINS` email bootstrap. Checked BEFORE the DB lookup so
		// a fresh control plane can reconcile/issue before any DB-backed admin credential exists. Empty env
		// (the default) disables it. Compared by hash in constant time; resolves the seeded `provisioning-admin`
		// principal (migration 0008) so its audit FK holds.
		const provisioningKey = (env.FABRIKA_IAM_PROVISIONING_KEY ?? '').trim()
		if (provisioningKey !== '' && timingSafeEqualHex(presentedHash, await hashToken(provisioningKey))) {
			return {
				ok: true,
				caller: { id: PROVISIONING_ADMIN_ID, type: 'service', label: 'provisioning', permissions: [{ action: '*', scope: null, source: 'bootstrap' }] },
				verifiedApp: input.app,
			}
		}

		const cred = await services.repositories.credentials.getActiveCredentialByHash(presentedHash)
		if (!cred) {
			return { ok: false, reason: 'invalid_token' }
		}
		const eff = await resolveCredential(services, cred, input.app)
		if (!eff.ok) {
			// A credential presented to the wrong app is indistinguishable from one that does not exist.
			return { ok: false, reason: eff.reason === 'wrong_app' ? 'invalid_token' : eff.reason }
		}
		return {
			ok: true,
			caller: { id: eff.subject, ...(eff.type === undefined ? {} : { type: eff.type }), label: eff.label, permissions: eff.permissions },
			// The credential's OWN app when it names one — `input.app` is caller-asserted, and after
			// SEC-2 there is a verified value to prefer. A cross-app credential has nothing to assert
			// with, so the caller's claim stands; `resolveCredential` has already bounded what that buys.
			verifiedApp: cred.app ?? input.app,
		}
	}

	// A `px_token` access JWT → verify against OUR OWN signing keys; `aud` IS the app id and `perms`
	// ARE the caller's resolved permissions for that app (the same snapshot the SDK's `can()` trusts).
	const signer = await getSigner(env)
	const claims = await verifyAccessToken(signer, input.credential, { issuer: services.config.issuer, audience: input.app })
	if (!claims) {
		return { ok: false, reason: 'invalid_token' }
	}
	return {
		ok: true,
		caller: { id: claims.sub, ...(claims.ptype === undefined ? {} : { type: claims.ptype }), label: claims.label, permissions: claims.perms },
		verifiedApp: claims.aud,
	}
}
