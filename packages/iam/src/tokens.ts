/**
 * Minting per-app access tokens — the heart of propustka-native auth.
 *
 * Two fronts over one resolve→sign core:
 *   - `mintToken`   — from the browser's opaque SSO session cookie (a principal-bound credential in a
 *     cookie). Validates the session, resolves the principal's permissions for the calling app.
 *   - `mintFromKey` — from an opaque `px_` credential (API key / share link) presented as a bearer or
 *     URL-path token. Resolves the credential's EFFECTIVE permissions (the 2×2: principal? ∩ inline).
 *
 * Both end in `signAccessToken`: sign a short-lived token the SDK then verifies locally, so this runs
 * ≈ once per TTL per app, not per request. `mintToken` always yields a principal token; `mintFromKey`
 * yields a principal token (bound credential) or an anonymous one (frozen inline grants).
 */

import {
	type AccessTokenClaims,
	buildAccessClaims,
	DEFAULT_TOKEN_TTL_SECONDS,
	type KeyGrant,
	type LinkTokenClaims,
	MAX_ACCESS_TOKEN_BYTES,
	type MintFromKeyResult,
	type MintTokenInput,
	type MintTokenResult,
	type PermissionEntry,
	permits,
	type Scope,
	type TokenPrincipalType,
} from '@fabrika/auth-core'
import { PROVISIONING_ADMIN_ID, sessionUsable } from './auth'
import type { CredentialGrantRow, CredentialRow, PrincipalRow, SessionTerminal } from './db'
import { principalStatus, sessionTerminal } from './db'
import type { Env } from './env'
import { narrowPermissions } from './narrow-permissions'
import { authorityDeadline, reachesCrossAppAuthority, resolveAuthorityAt, type ResolvedAuthority, resolvePermissionsAt } from './resolve'
import { hashToken } from './secret'
import type { Services } from './services'
import { getSigner } from './signing'
import { parseStoredChain } from './stored-chain'

/** The env slice minting needs (the signing keys + environment for `getSigner`). */
type MintEnv = Pick<Env, 'FABRIKA_IAM_SIGNING_KEYS' | 'ENVIRONMENT'>

/**
 * `principalId` (resolved session subject, or null on failure) and the session's terminal are surfaced for the
 * auth_log row.
 */
export interface MintOutcome {
	result: MintTokenResult
	principalId: string | null
	terminal: SessionTerminal | null
}

export async function mintToken(services: Services, env: MintEnv, input: MintTokenInput): Promise<MintOutcome> {
	if (!input.session) {
		return { result: { ok: false, reason: 'no_session' }, principalId: null, terminal: null }
	}

	const tokenHash = await hashToken(input.session)
	const session = await services.repositories.sessions.getActiveSessionByHash(tokenHash)
	if (!session) {
		// A revoked or expired session still names its principal and terminal in the refusal's `auth_log` row (ADR-0067 §6).
		const stored = await services.repositories.sessions.getSessionByHashForAudit(tokenHash)
		return {
			result: { ok: false, reason: 'invalid_session' },
			principalId: stored?.principal_id ?? null,
			terminal: stored === null ? null : sessionTerminal(stored),
		}
	}
	const terminal = sessionTerminal(session)
	const refused = (reason: Exclude<MintTokenResult, { ok: true }>['reason'], principalId: string | null): MintOutcome => ({
		result: { ok: false, reason },
		principalId,
		terminal,
	})
	// An app-bound child session (ADR-0022) mints for its own app and nothing else. The cookie is
	// host-only so a sibling app cannot read it; this is the second lock, for a value that leaks anyway.
	if (session.app !== null && session.app !== input.app) {
		return refused('invalid_session', session.principal_id)
	}
	// A session asserted at a terminal mints only for the application that asserted it (ADR-0067 §4).
	if (terminal !== null && terminal.assertedBy !== input.app) {
		return refused('invalid_session', session.principal_id)
	}
	// A session outlives the configuration that issued it; refuse it once its method is off.
	if (!sessionUsable(session, services.config)) {
		return refused('invalid_session', session.principal_id)
	}

	const principal = await services.repositories.principals.getPrincipalById(session.principal_id)
	if (!principal) {
		// The session outlived its principal (deleted) — treat as unknown.
		return refused('unknown_principal', null)
	}
	if (principalStatus(principal) === 'disabled') {
		return refused('disabled', principal.id)
	}

	// Resolve permissions for the requesting app. Sessions are a USER credential (OIDC login).
	const authority = await resolveAuthorityAt(services, principal, input.app)
	const onTerminal = terminal === null ? null : await terminalAuthority(services, terminal, input.app)
	if (terminal !== null && onTerminal === null) {
		return refused('invalid_session', principal.id)
	}
	const permissions = onTerminal === null ? authority.permissions : withinTerminal(authority.permissions, onTerminal)

	const now = Math.floor(Date.now() / 1000)
	// Clamped to the session, exactly as `mintFromKey` clamps to the credential's expiry: a token
	// minted a minute before the session ends must not outlive it, or logging out (or an expiry) would
	// leave a valid token in the app's hands for the rest of its TTL (SEC-27). Nor may it outlive a grant it carries.
	const expiresAt = Math.min(
		now + DEFAULT_TOKEN_TTL_SECONDS,
		session.expires_at,
		authorityDeadline(authority, onTerminal === null ? permissions : narrowPermissions(authority.permissions, onTerminal.ceiling), now)
			?? Number.POSITIVE_INFINITY,
		// A terminal's own entries are its principal's grants, and end with them.
		(onTerminal === null ? null : authorityDeadline(onTerminal.authority, onTerminal.additions, now)) ?? Number.POSITIVE_INFINITY,
	)
	const token = await boundedToken(
		signAccessToken(services, env, {
			app: input.app,
			subject: principal.id,
			type: principal.type,
			label: principal.label,
			...mailboxClaim(principal),
			session: true,
			...(onTerminal === null ? {} : { terminal: { id: onTerminal.id, label: onTerminal.label } }),
			permissions,
			issuedAt: now,
			expiresAt,
		}),
		{ app: input.app, subject: principal.id },
	)
	if (token === null) {
		return refused('token_too_large', principal.id)
	}
	return { result: { ok: true, token, expiresAt }, principalId: principal.id, terminal }
}

/** What a terminal brings to a session on it at one application: its ceiling and its own grants there. */
interface TerminalAuthority {
	id: string
	label: string
	ceiling: KeyGrant[]
	additions: PermissionEntry[]
	/** The terminal principal's own authority, which `additions` come from. */
	authority: ResolvedAuthority
}

/**
 * The terminal's authority at `app`, or null when the session may no longer mint there: `app` is a platform audience,
 * whose tokens carry cross-app authority, the terminal is gone or revoked, no longer lists `app` as an asserter, `app`
 * no longer declares a terminal, or the terminal's principal is disabled. The validity join already refused a revoked terminal; this read is the one the ceiling comes
 * from, so it checks again.
 */
async function terminalAuthority(services: Services, terminal: SessionTerminal, app: string): Promise<TerminalAuthority | null> {
	if (reachesCrossAppAuthority(services.config, app)) {
		return null
	}
	const row = await services.repositories.terminals.getById(terminal.terminalId)
	if (row === null || row.revoked_at !== null) {
		return null
	}
	const asserter = await services.repositories.terminals.getAsserter(row.principal_id, app)
	// An application that no longer declares a terminal is no asserter: its framework may not read a terminal token.
	if (asserter === null || await services.repositories.appSchema.getTerminalIdentifyPath(app) === null) {
		return null
	}
	const principal = await services.repositories.principals.getPrincipalById(row.principal_id)
	if (principal === null || principalStatus(principal) === 'disabled') {
		return null
	}
	const granted = await resolveAuthorityAt(services, principal, app)
	return {
		id: row.principal_id,
		label: row.label,
		ceiling: asserter.ceiling.map((action): KeyGrant => ({ action })),
		additions: granted.permissions.map((entry): PermissionEntry => ({ ...entry, source: 'terminal' })),
		authority: granted,
	}
}

/**
 * A person's live authority at `app` on the terminal `terminalId` that asserted them there (ADR-0067 §4): the set a
 * mint would sign now, and the grants behind it, the terminal principal's included; null when the terminal could no
 * longer mint for `app`. What a terminal session's token is re-resolved against.
 */
export async function authorityOnTerminal(
	services: Services,
	principal: PrincipalRow,
	terminalId: string,
	app: string,
): Promise<ResolvedAuthority | null> {
	const terminal = await terminalAuthority(services, { terminalId, assertedBy: app }, app)
	if (terminal === null) {
		return null
	}
	const personal = await resolveAuthorityAt(services, principal, app)
	return { permissions: withinTerminal(personal.permissions, terminal), supports: [...personal.supports, ...terminal.authority.supports] }
}

/**
 * A person's permissions on a terminal (ADR-0067 §4): each of their own entries narrowed by the ceiling patterns it
 * overlaps, keeping its scope, and then the terminal's own, with the source `terminal`. A person's `*` under a ceiling
 * `a.read` keeps `a.read`; an empty ceiling keeps none of the person's.
 */
function withinTerminal(personal: PermissionEntry[], terminal: TerminalAuthority): PermissionEntry[] {
	return [...narrowPermissions(personal, terminal.ceiling), ...terminal.additions]
}

/** `principalId`/`credentialId` are surfaced for the auth_log row. */
export interface MintFromKeyOutcome {
	result: MintFromKeyResult
	principalId: string | null
	credentialId: string | null
}

/**
 * Resolve an opaque `px_` credential into an access token. The credential's EFFECTIVE permissions
 * follow the 2×2: principal-bound → that principal's live resolved perms (∩ inline restriction when
 * present); anonymous → its frozen inline grants. The signed token is principal-bound (carries
 * `ptype`) iff the credential is.
 */
export async function mintFromKey(
	services: Services,
	env: MintEnv,
	input: { app: string; key: string; requestId: string },
): Promise<MintFromKeyOutcome> {
	const cred = await services.repositories.credentials.getActiveCredentialByHash(await hashToken(input.key))
	if (!cred) {
		return { result: { ok: false, reason: 'invalid_key' }, principalId: null, credentialId: null }
	}

	const effective = await resolveCredential(services, cred, input.app)
	if (!effective.ok) {
		// `wrong_app` is reported as `invalid_key`: a caller holding a credential for another app must
		// not learn that it exists, and there is nothing it can do differently here. Nor whose authority it rested on.
		const reason = effective.reason === 'wrong_app' || effective.reason === 'issuer_unauthorized' ? 'invalid_key' : effective.reason
		return { result: { ok: false, reason }, principalId: cred.principal_id, credentialId: cred.id }
	}

	const now = Math.floor(Date.now() / 1000)
	const expiresAt = Math.min(
		now + DEFAULT_TOKEN_TTL_SECONDS,
		cred.expires_at ?? Number.POSITIVE_INFINITY,
		effective.expiresAt ?? Number.POSITIVE_INFINITY,
	)
	const token = await boundedToken(
		signAccessToken(services, env, {
			app: input.app,
			subject: effective.subject,
			...(effective.type === undefined ? {} : { type: effective.type }),
			...(effective.workload === undefined ? {} : { workload: effective.workload }),
			label: effective.label,
			...(effective.email === undefined ? {} : { email: effective.email }),
			permissions: effective.permissions,
			...(effective.link === undefined ? {} : { link: effective.link }),
			issuedAt: now,
			expiresAt,
		}),
		{ app: input.app, subject: effective.subject },
	)
	if (token === null) {
		return { result: { ok: false, reason: 'token_too_large' }, principalId: cred.principal_id, credentialId: cred.id }
	}
	return { result: { ok: true, token, expiresAt }, principalId: cred.principal_id, credentialId: cred.id }
}

/**
 * The token of a job's or a webhook's own key, for `POST /auth/workload/token`. The kind and the application are
 * checked before anything about the principal is read, so every key that is not a live job or webhook key of `app` —
 * absent, revoked, expired, of another kind or app, or of a disabled principal — answers the same `invalid_key`.
 * A storage failure throws: the route answers it as "IAM could not be asked", never as a refusal.
 */
export async function mintFromWorkloadKey(services: Services, env: MintEnv, input: { app: string; key: string }): Promise<MintFromKeyOutcome> {
	const refused: MintFromKeyOutcome = { result: { ok: false, reason: 'invalid_key' }, principalId: null, credentialId: null }
	const cred = await services.repositories.credentials.getActiveCredentialByHash(await hashToken(input.key))
	if (cred === null || cred.principal_id === null || cred.app !== input.app) {
		return refused
	}
	const workload = await services.repositories.workloads.getByPrincipal(cred.principal_id)
	if (workload === null || workload.kind === 'app' || workload.app !== input.app) {
		return refused
	}
	const effective = await resolveCredential(services, cred, input.app)
	if (!effective.ok || effective.type !== workload.kind) {
		return refused
	}
	const now = Math.floor(Date.now() / 1000)
	const expiresAt = Math.min(now + DEFAULT_TOKEN_TTL_SECONDS, cred.expires_at ?? Number.POSITIVE_INFINITY)
	const token = await boundedToken(
		signAccessToken(services, env, {
			app: input.app,
			subject: effective.subject,
			type: workload.kind,
			workload: workload.name,
			label: effective.label,
			permissions: effective.permissions,
			issuedAt: now,
			expiresAt,
		}),
		{ app: input.app, subject: effective.subject },
	)
	if (token === null) {
		return refused
	}
	return { result: { ok: true, token, expiresAt }, principalId: cred.principal_id, credentialId: cred.id }
}

/**
 * The credential's effective permissions + the token subject/type/label, or a typed failure.
 * `wrong_app` is IAM-internal: every mint front reports it as `invalid_key`, because "this key is
 * not for you" and "there is no such key" must look the same to a caller who holds neither.
 */
export type ResolvedCredential =
	| {
		ok: true
		subject: string
		type?: TokenPrincipalType
		/** A workload principal's name (`job`, `webhook`), or a connector's consuming application (`app`). */
		workload?: string
		label: string | null
		/** A user principal's mailbox. */
		email?: string
		permissions: PermissionEntry[]
		/** When the earliest carried permission loses its last supporting grant; `null` when none expires. */
		expiresAt: number | null
		link?: LinkTokenClaims
	}
	| { ok: false; reason: 'unknown_principal' | 'disabled' | 'wrong_app' | 'issuer_unauthorized' }

/**
 * Resolve a credential's effective permissions FOR ONE APP.
 *
 * **The app binding is checked first, and it is not optional for an anonymous credential.** Inline
 * grants are frozen at issue and were delegation-checked against the issuer's permissions *for the
 * issuing app*; without a binding that authority was granted per app and spent installation-wide, so
 * an app-scoped admin of the least important app could issue `{ action: '*' }` and present the key to
 * every other app behind the proxy (SEC-2). A `NULL` app on an anonymous credential is therefore
 * refused rather than treated as cross-app — a credential issued before the binding existed must be
 * reissued, a hard cutover.
 *
 * A principal-bound credential may be cross-app (`NULL`) because it carries no frozen authority: its
 * permissions are resolved per app from `grants`, which are themselves app-filtered. When it names an
 * app, that is a downscope and is enforced the same way.
 */
export async function resolveCredential(services: Services, cred: CredentialRow, app: string): Promise<ResolvedCredential> {
	if (cred.app !== null && cred.app !== app) {
		return { ok: false, reason: 'wrong_app' }
	}
	if (cred.principal_id === null && cred.app === null) {
		return { ok: false, reason: 'wrong_app' }
	}

	const inline = (await services.repositories.credentials.getCredentialGrants(cred.id)).map(credentialGrantToEntry)

	if (cred.principal_id === null) {
		// Anonymous: the frozen inline grants ARE the permission set, delegated by the issuer, who must still hold them.
		if (cred.link_mount === null) {
			const issuer = await issuerAuthority(services, cred.issued_by, app, null, inline.map((entry) => ({ action: entry.action, on: [entry.scope] })))
			if (!issuer.ok) return issuer
			return { ok: true, subject: cred.id, label: cred.label, permissions: inline, expiresAt: issuer.expiresAt }
		}
		// A share link's token names its mount and chain, which the framework re-checks per request.
		const chain = cred.link_chain === null ? null : parseStoredChain(cred.link_chain)
		if (chain === null) {
			return { ok: false, reason: 'wrong_app' }
		}
		const mount = await services.repositories.appSchema.getLinkMount(app, cred.link_mount)
		if (mount === null || mount.dimension !== cred.link_dimension) {
			return { ok: false, reason: 'issuer_unauthorized' }
		}
		// As `issueLink` checked: the mount's `issuedBy` and every frozen action, each held on some link of the chain.
		const required = [mount.issued_by, ...inline.map((entry) => entry.action)].map((action) => ({ action, on: chain }))
		const issuer = await issuerAuthority(services, cred.issued_by, app, cred.link_mount, required)
		if (!issuer.ok) return issuer
		return {
			ok: true,
			subject: cred.id,
			label: cred.label,
			permissions: inline,
			expiresAt: issuer.expiresAt,
			link: { mount: cred.link_mount, chain },
		}
	}

	const principal = await services.repositories.principals.getPrincipalById(cred.principal_id)
	if (!principal) {
		return { ok: false, reason: 'unknown_principal' }
	}
	if (principalStatus(principal) === 'disabled') {
		return { ok: false, reason: 'disabled' }
	}

	// A workload's authority is what the app's schema declares for it now: exact actions, app-wide. Its grants, if an
	// administrator wrote any, give it nothing more.
	const workload = await services.repositories.workloads.getByPrincipal(principal.id)
	if (workload !== null) {
		if (workload.app !== app) {
			return { ok: false, reason: 'wrong_app' }
		}
		const actions = (await services.repositories.workloads.declaredActions(workload.app, workload.kind, workload.name)) ?? []
		const declared = actions.map((action): PermissionEntry => ({ action, scope: null, source: 'grant' }))
		return {
			ok: true,
			subject: principal.id,
			type: workload.kind,
			workload: workload.name,
			label: principal.label,
			permissions: declared,
			expiresAt: null,
		}
	}

	const authority = await resolveAuthorityAt(services, principal, app)
	const resolved = authority.permissions

	// Inline grants on a bound credential are a DOWNSCOPE restriction: keep only what the principal
	// actually holds (effective = resolve(principal) ∩ inline). No inline → the principal's full set.
	const permissions = inline.length === 0 ? resolved : inline.filter((e) => permits(resolved, e.action, e.scope ?? undefined))
	const expiresAt = authorityDeadline(authority, permissions, Math.floor(Date.now() / 1000))
	return { ok: true, subject: principal.id, type: principal.type, label: principal.label, ...mailboxClaim(principal), permissions, expiresAt }
}

/** An action the issuer must still hold on at least one of `on` (`null` is application-wide). */
interface DelegatedAction {
	action: string
	on: readonly (Scope | null)[]
}

/**
 * S8 at every mint of an anonymous credential: its issuer exists, is enabled and still holds each delegated action, and
 * the token ends when the first of them loses its support. A job issuer holds its current declaration, app-wide, and
 * only for the mount it is declared to issue; the provisioning administrator is the installation's named exception. A credential without an issuer, or whose issuer lost any of it, mints
 * nothing (`issuer_unauthorized`, reported as `invalid_key`).
 */
async function issuerAuthority(
	services: Services,
	issuerId: string | null,
	app: string,
	mount: string | null,
	required: readonly DelegatedAction[],
): Promise<{ ok: true; expiresAt: number | null } | { ok: false; reason: 'issuer_unauthorized' }> {
	const refused: { ok: false; reason: 'issuer_unauthorized' } = { ok: false, reason: 'issuer_unauthorized' }
	const issuer = issuerId === null ? null : await services.repositories.principals.getPrincipalById(issuerId)
	if (issuer === null || principalStatus(issuer) === 'disabled') {
		return refused
	}
	if (issuer.id === PROVISIONING_ADMIN_ID) {
		// The named exception: the seeded installation administrator holds every action, and its issuance was audited.
		return { ok: true, expiresAt: null }
	}
	const workload = await services.repositories.workloads.getByPrincipal(issuer.id)
	if (workload !== null) {
		const declaration = workload.kind === 'job' && workload.app === app
			? await services.repositories.workloads.declaration(app, 'job', workload.name)
			: null
		if (declaration === null || mount === null || declaration.issues !== mount) {
			return refused
		}
		return required.every(({ action }) => declaration.actions.includes(action)) ? { ok: true, expiresAt: null } : refused
	}
	const authority = await resolveAuthorityAt(services, issuer, app)
	const now = Math.floor(Date.now() / 1000)
	let expiresAt: number | null = null
	for (const { action, on } of required) {
		// Per action the latest support among the chain links it is held on, then the earliest across actions.
		let latest: number | null | undefined
		for (const scope of on) {
			if (!permits(authority.permissions, action, scope ?? undefined)) continue
			const until = authorityDeadline(authority, [{ action, scope, source: 'grant' }], now)
			latest = latest === undefined ? until : latest === null || until === null ? null : Math.max(latest, until)
		}
		if (latest === undefined) {
			return refused
		}
		if (latest !== null && (expiresAt === null || latest < expiresAt)) {
			expiresAt = latest
		}
	}
	return { ok: true, expiresAt }
}

/**
 * A user's mailbox for its token: `principals.email`, normalized by `PrincipalRepository`, the address the person signs
 * in with. An application mails it as `ctx.principal.email`, so it is never `label`, the spelling the person sees.
 */
function mailboxClaim(principal: PrincipalRow): { email?: string } {
	return principal.type === 'user' && principal.email !== null ? { email: principal.email } : {}
}

/** A `credential_grants` row → a `PermissionEntry` (source 'grant'; both scope cols null = global). */
function credentialGrantToEntry(row: CredentialGrantRow): PermissionEntry {
	const scope: Scope | null = row.scope_type === null || row.scope_value === null ? null : { type: row.scope_type, value: row.scope_value }
	return { action: row.action, scope, source: 'grant' }
}

/**
 * The signed token, or null — with a warning naming the subject and the size — when it is above
 * `MAX_ACCESS_TOKEN_BYTES`. Every bearer IAM issues passes here: native tokens and OAuth resource tokens.
 */
export async function boundedToken(signed: Promise<string>, who: { app: string; subject: string }): Promise<string | null> {
	const token = await signed
	if (token.length <= MAX_ACCESS_TOKEN_BYTES) {
		return token
	}
	console.warn(
		`access token for '${who.subject}' at app '${who.app}' is ${token.length} bytes, above the ${MAX_ACCESS_TOKEN_BYTES}-byte bound; refused`,
	)
	return null
}

/** Sign an access token with the isolate's active signing key. Shared by every mint front. */
export async function signAccessToken(
	services: Services,
	env: MintEnv,
	params: Omit<Parameters<typeof buildAccessClaims>[0], 'iss'>,
): Promise<string> {
	const signer = await getSigner(env)
	const claims: AccessTokenClaims = buildAccessClaims({ ...params, iss: services.config.issuer })
	return signer.sign(claims)
}
