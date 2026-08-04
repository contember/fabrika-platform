/**
 * The propustka-native auth HTTP surface (public — no admin gate; these live on propustka's OWN
 * host). All nine routes `handleAuth` dispatches:
 *
 *   GET      /.well-known/jwks.json  — the public signing keys (so anything can verify a token)
 *   GET      /auth/login             — the password form when PASSWORD_ENABLED, otherwise straight on
 *                                      to OIDC; both methods compose per ADR-0020's matrix
 *   POST     /auth/login             — verify a password, create the SSO session, set the cookie
 *   GET      /auth/oidc/start        — start OIDC (PKCE), 302 to the provider
 *   GET      /auth/callback          — finish OIDC, admit the email, create the SSO session, 302 back
 *   GET|POST /auth/forgot-password   — request a recovery link; the answer never varies
 *   GET|POST /auth/password/enroll   — set a first password from an enrollment token
 *   GET|POST /auth/password/reset    — replace a password from a reset token
 *   GET|POST /auth/logout            — GET renders a same-origin confirm form, POST revokes and clears
 *
 * `?app=` + `?redirect=` turns ANY login entry above into a cross-host HANDOFF (ADR-0021): the return
 * address is checked against what that app registered, and the browser lands on the app's own
 * callback carrying a single-use code instead of on `redirect`. The parameter rides the password form
 * and the OIDC detour alike, and is re-validated on the way back in — the form is never trusted.
 *
 * `/auth/mint/*` is NOT part of this surface: `src/app.ts` intercepts it upstream for the proxy.
 *
 * There is no Cloudflare Access in front of propustka anymore, so these are plain public routes —
 * the admin gate (`/admin/*`) applies only to the admin surface, never here.
 */

import { AUTH_CALLBACK_PATH, AUTH_CODE_PARAM, SESSION_COOKIE } from '@fabrika/auth-core'
import { isDevBypassSession, LOCAL_DEV_ADMIN_EMAIL, LOCAL_DEV_ADMIN_ID } from '../auth'
import { normalizeEmailIdentity } from '../email-identity'
import type { Env, RequestContext } from '../env'
import { issueAuthCode, normalizeOrigin, resolveReturnUrl } from '../handoff'
import { stringField } from '../json'
import { generatePkce, randomToken } from '../oidc'
import type { PasswordActionPurpose } from '../password-db'
import { forgotPasswordPage, invalidActionPage, loginPage, logoutPage, setPasswordPage } from '../password-pages'
import { PASSWORD_MAX_CODE_POINTS, validatePassword } from '../password-policy'
import { deliverPasswordAction, issuePasswordAction } from '../password-service'
import { requestId } from '../request-id'
import { resolveUserPrincipal } from '../resolve'
import { hashToken } from '../secret'
import type { Config, Services } from '../services'
import { getSigner, verifyInternal } from '../signing'
import { clearCookie, readCookie, serializeCookie } from './cookies'

/** SSO session lifetime — the long-lived credential a browser carries (30 days). */
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60
/** In-flight OIDC cookie: a SIGNED token carrying state + PKCE verifier + redirect; /auth, 10 min. */
const OIDC_COOKIE = 'px_oidc'
const OIDC_TTL_SECONDS = 600

/** The only env the auth surface touches directly is the signing config — the JWKS, and the flight. */
type AuthEnv = Pick<Env, 'FABRIKA_IAM_SIGNING_KEYS' | 'ENVIRONMENT'>

export async function handleAuth(request: Request, services: Services, env: AuthEnv, ctx: RequestContext): Promise<Response> {
	const url = new URL(request.url)
	const secure = secureCookies(url, services.config)

	if (url.pathname === '/.well-known/jwks.json') {
		return handleJwks(env)
	}
	if (url.pathname === '/auth/login') {
		if (request.method === 'POST') return handlePasswordLogin(request, services, secure, ctx)
		if (request.method === 'GET') return handleLogin(request, services, env, secure, ctx)
		return methodNotAllowed()
	}
	if (url.pathname === '/auth/oidc/start') {
		return request.method === 'GET' ? handleOidcStart(request, services, env, secure) : methodNotAllowed()
	}
	if (url.pathname === '/auth/callback') {
		return request.method === 'GET' ? handleCallback(request, services, env, secure, ctx) : methodNotAllowed()
	}
	if (url.pathname === '/auth/forgot-password') {
		return handleForgotPassword(request, services, ctx)
	}
	if (url.pathname === '/auth/password/enroll') {
		return handlePasswordAction(request, services, secure, ctx, 'enrollment')
	}
	if (url.pathname === '/auth/password/reset') {
		return handlePasswordAction(request, services, secure, ctx, 'reset')
	}
	if (url.pathname === '/auth/logout') {
		// Logging out is a state change, so it needs a method that can carry an origin check. A GET
		// stays usable — it renders the same-origin form that posts — because a cross-site
		// `location = '…/auth/logout'` used to revoke the login and every app session under it.
		if (request.method === 'POST') return handleLogout(request, services, secure)
		if (request.method === 'GET') return logoutPage(safeRedirect(url.searchParams.get('redirect'), services.config))
		return methodNotAllowed()
	}
	return new Response('Not found', { status: 404 })
}

// ── /.well-known/jwks.json ─────────────────────────────────────────────────────

async function handleJwks(env: AuthEnv): Promise<Response> {
	const signer = await getSigner(env)
	return Response.json(signer.jwks(), {
		headers: { 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' },
	})
}

// ── /auth/login ────────────────────────────────────────────────────────────────

/**
 * A cross-host handoff in flight (ADR-0021): which app the browser came from and where it goes back
 * to. `null` means an ordinary IAM login, which still uses `safeRedirect` and the shared cookie.
 */
interface Handoff {
	app: string
	returnUrl: string
}

/**
 * What `?app=` + `?redirect=` turned out to be. `none` keeps the ordinary shared-cookie login;
 * `refused` carries the message of a hard 400.
 */
type HandoffReading =
	| { kind: 'none' }
	| { kind: 'handoff'; handoff: Handoff }
	| { kind: 'refused'; message: string }

/**
 * Read `?app=` + `?redirect=` as a handoff, validating the return URL against what that app has
 * registered.
 *
 * Four outcomes, and the distinction between the middle two carries the whole design:
 *
 *   - no `app` at all → not a handoff;
 *   - an app with an EMPTY registry → **not a handoff either**. It has not opted in, so the browser
 *     takes the ordinary shared-cookie path, which is what it did before ADR-0021 and what still
 *     works whenever IAM and the app share a domain — the local stack, for one. The proxy sends
 *     `app=` on every bounce, so without this an installation would break the moment it upgraded.
 *     BUT the opt-out only holds while the shared cookie can actually reach the destination: if
 *     `safeRedirect` refuses the address the proxy sent, that path provably cannot work for this
 *     host, and falling back to it strands the browser in a login loop with nothing logged
 *     anywhere. So that combination is a `400` naming the origin nobody registered;
 *   - an app WITH a registry whose return URL is not in it → a hard `400`, never a quiet fallback.
 *     Here the operator asked for a handoff and got the address wrong, and a fallback would leave
 *     them staring at a login that succeeds and lands somewhere else;
 *   - otherwise, the validated handoff.
 */
async function readHandoff(services: Services, app: string | null, redirect: string | null): Promise<HandoffReading> {
	if (app === null || app === '') {
		return { kind: 'none' }
	}
	if ((await services.repositories.handoff.listReturnOrigins(app)).length === 0) {
		if (redirect !== null && redirect !== '' && acceptableRedirect(redirect, services.config) === null) {
			const origin = normalizeOrigin(redirect) ?? 'that address'
			return {
				kind: 'refused',
				message: `no return origin is registered for this app and ${printable(origin)} is outside the session cookie domain`,
			}
		}
		return { kind: 'none' }
	}
	if (redirect === null || redirect === '') {
		return { kind: 'refused', message: 'unregistered return address for this app' }
	}
	const returnUrl = await resolveReturnUrl(services, app, redirect)
	return returnUrl === null
		? { kind: 'refused', message: 'unregistered return address for this app' }
		: { kind: 'handoff', handoff: { app, returnUrl } }
}

/** The handoff a reading carries, or null — after the caller has already answered a `refused`. */
function handoffOf(reading: HandoffReading): Handoff | null {
	return reading.kind === 'handoff' ? reading.handoff : null
}

async function handleLogin(request: Request, services: Services, env: AuthEnv, secure: boolean, ctx: RequestContext): Promise<Response> {
	const url = new URL(request.url)
	const reading = await readHandoff(services, url.searchParams.get('app'), url.searchParams.get('redirect'))
	if (reading.kind === 'refused') {
		return authError(reading.message, 400)
	}
	const handoff = handoffOf(reading)
	// A handoff's destination is already validated against the app's registry, so `safeRedirect` must
	// not get a say: its allowlist is the session-cookie domain, which by definition does not cover the
	// cross-host case this exists for. Passing its fallback to the form would strand the login on IAM.
	const redirect = handoffRedirectOr(handoff, url.searchParams.get('redirect'), services)

	// Already signed in HERE? Then a handoff needs no prompt — mint the code off the existing login and
	// bounce. This is what makes a second app, and every token expiry, silent.
	if (handoff !== null) {
		const existing = await currentSession(request, services)
		if (existing !== null) {
			return new Response(null, { status: 302, headers: redirectHeaders(await handoffLocation(services, handoff, existing.id)) })
		}
	}

	if (services.config.localDevLogin) {
		return handleLocalLogin(request, services, secure, ctx, redirect, handoff)
	}
	if (services.config.authentication.password.enabled) {
		return loginPage({
			redirect,
			oidcEnabled: services.config.authentication.oidc.enabled,
			forgotEnabled: services.email !== null,
			...(handoff === null ? {} : { app: handoff.app }),
		})
	}
	return startOidc(services, env, secure, redirect, handoff)
}

/** The caller's IAM session, if the browser already holds a valid one on this host. */
async function currentSession(request: Request, services: Services) {
	const raw = readCookie(request.headers.get('Cookie'), SESSION_COOKIE)
	if (raw === null) {
		return null
	}
	const session = await services.repositories.sessions.getActiveSessionByHash(await hashToken(raw))
	if (session === null) {
		return null
	}
	// A child session cannot father another: only the IAM login itself may authorize a handoff.
	if (session.app !== null) {
		return null
	}
	// And a bypass session must not silently hand an app a global admin once the bypass is off.
	return isDevBypassSession(session) && !services.config.localDevLogin ? null : session
}

/**
 * What a login page or an OIDC flight should carry as its return address: the handoff's validated
 * destination when there is one, otherwise the ordinary same-site allowlist.
 */
function handoffRedirectOr(handoff: Handoff | null, raw: string | null, services: Services): string {
	return handoff === null ? safeRedirect(raw, services.config) : handoff.returnUrl
}

/** Issue the code and build the URL of the app's own callback. */
async function handoffLocation(services: Services, handoff: Handoff, parentSessionId: string): Promise<string> {
	const issued = await issueAuthCode(services, { app: handoff.app, parentSessionId, returnUrl: handoff.returnUrl })
	const callback = new URL(AUTH_CALLBACK_PATH, handoff.returnUrl)
	callback.searchParams.set(AUTH_CODE_PARAM, issued.code)
	return callback.toString()
}

async function handleOidcStart(request: Request, services: Services, env: AuthEnv, secure: boolean): Promise<Response> {
	if (!services.config.authentication.oidc.enabled) return authError('OIDC login is disabled', 404)
	const url = new URL(request.url)
	const reading = await readHandoff(services, url.searchParams.get('app'), url.searchParams.get('redirect'))
	if (reading.kind === 'refused') {
		return authError(reading.message, 400)
	}
	const handoff = handoffOf(reading)
	return startOidc(services, env, secure, handoffRedirectOr(handoff, url.searchParams.get('redirect'), services), handoff)
}

async function startOidc(
	services: Services,
	env: AuthEnv,
	secure: boolean,
	redirect: string,
	handoff: Handoff | null = null,
): Promise<Response> {
	if (!services.config.authentication.oidc.enabled || services.oidc === null) return authError('OIDC login is disabled', 404)
	const { verifier, challenge } = await generatePkce()
	const state = randomToken(16)
	const location = await services.oidc.authorizationUrl({ state, codeChallenge: challenge })

	const flight = await encodeFlight(env, { state, verifier, redirect, ...(handoff === null ? {} : { app: handoff.app }) })
	const headers = redirectHeaders(location)
	// The in-flight cookie is scoped to /auth (only the callback reads it), single-use, and SIGNED —
	// see `encodeFlight`.
	headers.append(
		'Set-Cookie',
		serializeCookie(OIDC_COOKIE, flight, { httpOnly: true, secure, sameSite: 'Lax', maxAge: OIDC_TTL_SECONDS, path: '/auth' }),
	)
	return new Response(null, { status: 302, headers })
}

async function handleLocalLogin(
	request: Request,
	services: Services,
	secure: boolean,
	ctx: RequestContext,
	redirect: string,
	handoff: Handoff | null = null,
): Promise<Response> {
	const resolved = await resolveUserPrincipal(services.repositories.principals, LOCAL_DEV_ADMIN_ID, LOCAL_DEV_ADMIN_EMAIL)
	if (!resolved.ok) {
		return authError(`local login refused (${resolved.reason})`, 403)
	}
	return issueSession(request, services, secure, ctx, {
		principalId: resolved.principal.id,
		idpSub: LOCAL_DEV_ADMIN_ID,
		email: LOCAL_DEV_ADMIN_EMAIL,
		redirect,
		reason: 'local_login',
		handoff,
	})
}

// ── /auth/callback ───────────────────────────────────────────────────────────────

async function handleCallback(
	request: Request,
	services: Services,
	env: AuthEnv,
	secure: boolean,
	ctx: RequestContext,
): Promise<Response> {
	if (!services.config.authentication.oidc.enabled || services.oidc === null) return authError('OIDC login is disabled', 404)
	const url = new URL(request.url)
	const code = url.searchParams.get('code')
	const state = url.searchParams.get('state')
	const flight = await decodeFlight(env, readCookie(request.headers.get('Cookie'), OIDC_COOKIE))
	// EVERY terminal outcome below consumes the flight. The cookie holds a live PKCE verifier and the
	// state nonce; leaving it behind on a failure kept both replayable for the rest of their 600s.
	const refuse = (message: string, status: number): Response => authErrorEndingFlight(message, status, secure)

	// CSRF: the state echoed by the IdP must match the one in the flight WE signed.
	if (!code || !state || !flight || flight.state !== state) {
		return refuse('invalid OIDC state', 400)
	}

	const idToken = await services.oidc.exchangeCode(code, flight.verifier)
	if (!idToken) {
		return refuse('code exchange failed', 502)
	}
	const identity = await services.oidc.verifyIdToken(idToken)
	if (!identity) {
		return refuse('invalid id_token', 401)
	}

	// Admission: who may log in as a human. The central allowlist (`HUMAN_EMAIL_DOMAINS`/
	// `HUMAN_EMAILS`, with a `*` entry meaning admit-all) gates SELF-PROVISIONING of a new identity.
	// An already-known or invited principal (and a bootstrap admin) is always admitted regardless —
	// so check existence WITHOUT lazily creating before refusing a non-allowlisted newcomer.
	if (!admitted(identity.email, services.config)) {
		const known = (await services.repositories.principals.getUserByExternalId(identity.sub))
			?? (await services.repositories.principals.getUserByEmail(identity.email))
		if (!known) {
			return refuse('login refused (not allowed)', 403)
		}
	}

	// Resolve (or claim/lazy-create) the principal from the verified OIDC identity — the 3-step flow
	// keyed on the IdP `sub` and verified email.
	const resolved = await resolveUserPrincipal(services.repositories.principals, identity.sub, identity.email)
	if (!resolved.ok) {
		return refuse(`login refused (${resolved.reason})`, 403)
	}

	// Re-validate the handoff on the way back: the flight is ours (signature-checked), but the registry
	// may have changed while the human was away at the IdP.
	const reading = flight.app === undefined ? { kind: 'none' as const } : await readHandoff(services, flight.app, flight.redirect)
	if (reading.kind === 'refused') {
		return refuse(reading.message, 400)
	}

	return issueSession(request, services, secure, ctx, {
		principalId: resolved.principal.id,
		idpSub: identity.sub,
		email: identity.email,
		redirect: safeRedirect(flight.redirect, services.config),
		reason: 'login',
		clearOidc: true,
		handoff: handoffOf(reading),
	})
}

async function issueSession(
	request: Request,
	services: Services,
	secure: boolean,
	ctx: RequestContext,
	input: {
		principalId: string
		idpSub?: string | null
		email?: string | null
		authenticationMethod?: 'oidc' | 'password'
		redirect: string
		reason: string
		clearOidc?: boolean
		/** When set, land on the app's callback with a code instead of on `redirect` (ADR-0021). */
		handoff?: Handoff | null
	},
): Promise<Response> {
	const sessionToken = randomToken(32)
	const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
	const sessionId = await services.repositories.sessions.createSession({
		tokenHash: await hashToken(sessionToken),
		principalId: input.principalId,
		idpSub: input.idpSub,
		email: input.email,
		authenticationMethod: input.authenticationMethod,
		expiresAt,
	})
	ctx.waitUntil(
		services.repositories.audit.writeAuthLog({
			requestId: requestId(request),
			app: 'propustka',
			kind: 'authenticate',
			principalId: input.principalId,
			decision: 'allow',
			reason: input.reason,
		}),
	)

	// The IAM cookie is set either way: it is what makes the NEXT handoff, to this or any other app,
	// silent. What changes is where the browser goes — its own destination, or the app's callback.
	const location = input.handoff == null ? input.redirect : await handoffLocation(services, input.handoff, sessionId)
	const headers = redirectHeaders(location)
	headers.append('Set-Cookie', sessionCookie(sessionToken, services.config, secure))
	if (input.clearOidc === true) {
		headers.append('Set-Cookie', clearCookie(OIDC_COOKIE, { path: '/auth', secure }))
	}
	return new Response(null, { status: 302, headers })
}

// ── Password login and recovery ──────────────────────────────────────────────

const LOGIN_WINDOW_SECONDS = 15 * 60
const LOGIN_BLOCK_SECONDS = 15 * 60
const ACCOUNT_MAX_ATTEMPTS = 5
const GLOBAL_MAX_ATTEMPTS = 1_000
const RECOVERY_ACCOUNT_MAX_ATTEMPTS = 3
const RECOVERY_GLOBAL_MAX_ATTEMPTS = 100

async function handlePasswordLogin(request: Request, services: Services, secure: boolean, ctx: RequestContext): Promise<Response> {
	if (!services.config.authentication.password.enabled) return authError('password login is disabled', 404)
	if (!sameOrigin(request, services.config)) return authError('invalid request origin', 403)
	const form = await readForm(request)
	if (form === null) return authError('invalid form', 400)
	const email = normalizeEmail(form.get('email'))
	const rawPassword = stringValue(form.get('password'))
	// The form is a hint, not a permission: `readHandoff` re-checks the return URL against what the app
	// has registered, so a hand-edited field buys nothing.
	const reading = await readHandoff(services, stringValue(form.get('app')), stringValue(form.get('redirect')))
	if (reading.kind === 'refused') {
		return authError(reading.message, 400)
	}
	const handoff = handoffOf(reading)
	const redirect = handoffRedirectOr(handoff, stringValue(form.get('redirect')), services)
	const retry = {
		redirect,
		oidcEnabled: services.config.authentication.oidc.enabled,
		forgotEnabled: services.email !== null,
		...(handoff === null ? {} : { app: handoff.app }),
	}
	if (email === null || rawPassword === null) {
		return loginPage({ ...retry, error: 'Invalid email or password.' })
	}
	const password = rawPassword.normalize('NFC')
	const passwordWithinLimit = Array.from(password).length <= PASSWORD_MAX_CODE_POINTS

	const accountKey = await hashToken(`password-login:account:${email}`)
	const globalKey = await hashToken('password-login:global')
	const [accountThrottle, globalThrottle, lookup] = await Promise.all([
		services.repositories.passwords.getLoginThrottle(accountKey),
		services.repositories.passwords.getLoginThrottle(globalKey),
		services.repositories.passwords.lookupLogin(email),
	])
	const now = Math.floor(Date.now() / 1000)
	const blocked = (accountThrottle?.blocked_until ?? 0) > now || (globalThrottle?.blocked_until ?? 0) > now
	let valid = false
	let needsRehash = false
	if (!blocked && passwordWithinLimit && lookup.status === 'found') {
		const verification = await services.passwordHasher.verify(password, {
			algorithm: lookup.credential.algorithm,
			parameters: lookup.credential.parameters,
			salt: lookup.credential.salt,
			passwordHash: lookup.credential.password_hash,
		})
		valid = verification.valid
		needsRehash = verification.needsRehash
	} else if (!blocked) {
		// Spend derivation work when the request is allowed but no verifier can run.
		await services.passwordHasher.hash(passwordWithinLimit ? password : 'oversized-password-dummy')
	}

	if (!blocked && valid && lookup.status === 'found') {
		if (needsRehash) {
			// Replacing derived material deliberately revokes older password sessions.
			await services.repositories.passwords.upsertCredential(lookup.principal.id, await services.passwordHasher.hash(password))
		}
		await services.repositories.passwords.clearLoginFailures(accountKey)
		return issueSession(request, services, secure, ctx, {
			principalId: lookup.principal.id,
			email: lookup.principal.email,
			authenticationMethod: 'password',
			redirect,
			reason: 'password_login',
			handoff,
		})
	}

	if (!blocked) {
		await Promise.all([
			recordLoginFailure(services, accountKey, ACCOUNT_MAX_ATTEMPTS),
			recordLoginFailure(services, globalKey, GLOBAL_MAX_ATTEMPTS),
		])
	}
	ctx.waitUntil(
		services.repositories.audit.writeAuthLog({
			requestId: requestId(request),
			app: 'propustka',
			kind: 'authenticate',
			principalId: lookup.status === 'found' ? lookup.principal.id : null,
			decision: 'deny',
			reason: blocked ? 'password_throttled' : 'password_invalid',
		}),
	)
	return loginPage({ ...retry, error: 'Invalid email or password.' })
}

async function recordLoginFailure(services: Services, loginKeyHash: string, maxAttempts: number): Promise<void> {
	await services.repositories.passwords.recordLoginFailure({
		loginKeyHash,
		windowSeconds: LOGIN_WINDOW_SECONDS,
		maxAttempts,
		blockSeconds: LOGIN_BLOCK_SECONDS,
	})
}

async function handleForgotPassword(request: Request, services: Services, ctx: RequestContext): Promise<Response> {
	if (!services.config.authentication.password.enabled) return authError('password login is disabled', 404)
	if (request.method === 'GET') return forgotPasswordPage({})
	if (request.method !== 'POST') return methodNotAllowed()
	if (!sameOrigin(request, services.config)) return authError('invalid request origin', 403)
	const form = await readForm(request)
	if (form === null) return authError('invalid form', 400)
	const email = normalizeEmail(form.get('email'))
	if (services.email === null || email === null) return forgotPasswordPage({ sent: true })
	const accountKey = await hashToken(`password-recovery:account:${email}`)
	const globalKey = await hashToken('password-recovery:global')
	const [accountThrottle, globalThrottle] = await Promise.all([
		services.repositories.passwords.getLoginThrottle(accountKey),
		services.repositories.passwords.getLoginThrottle(globalKey),
	])
	const now = Math.floor(Date.now() / 1000)
	if ((accountThrottle?.blocked_until ?? 0) > now || (globalThrottle?.blocked_until ?? 0) > now) {
		return forgotPasswordPage({ sent: true })
	}
	await Promise.all([
		recordLoginFailure(services, accountKey, RECOVERY_ACCOUNT_MAX_ATTEMPTS),
		recordLoginFailure(services, globalKey, RECOVERY_GLOBAL_MAX_ATTEMPTS),
	])
	ctx.waitUntil(runForgotPassword(services, email).catch(() => console.error('Password recovery request failed')))
	return forgotPasswordPage({ sent: true })
}

async function runForgotPassword(services: Services, email: string): Promise<void> {
	let lookup = await services.repositories.passwords.lookupActionUser(email)
	if (
		lookup.status === 'missing'
		&& !services.config.authentication.oidc.enabled
		&& matchingBootstrapEmail(email, services.config) !== null
	) {
		const principal = await safelyCreateBootstrapPrincipal(services, email)
		if (principal !== null) lookup = { status: 'found', principal, account: await services.repositories.passwords.getAccount(principal.id) }
	}

	if (lookup.status === 'found' && lookup.principal.disabled_at === null) {
		let purpose: PasswordActionPurpose | null = null
		if (lookup.account?.state === 'enabled') purpose = 'reset'
		if (lookup.account?.state === 'pending') purpose = 'enrollment'
		if (lookup.account === null && !services.config.authentication.oidc.enabled && matchingBootstrapEmail(email, services.config) !== null) {
			await services.repositories.passwords.enableEnrollment(lookup.principal.id)
			purpose = 'enrollment'
		}
		if (purpose !== null) {
			const action = await issuePasswordAction(services, { principal: lookup.principal, purpose })
			await deliverPasswordAction(services, action)
		}
	}
}

async function safelyCreateBootstrapPrincipal(services: Services, email: string) {
	// Re-check through the case-insensitive, ambiguity-detecting lookup before the unique insert.
	const existing = await services.repositories.passwords.lookupActionUser(email)
	if (existing.status === 'found') return existing.principal
	if (existing.status === 'ambiguous') return null
	const canonical = matchingBootstrapEmail(email, services.config)
	if (canonical === null) return null
	try {
		const principal = await services.repositories.principals.inviteUser(canonical)
		await services.repositories.passwords.enableEnrollment(principal.id)
		return principal
	} catch {
		const raced = await services.repositories.passwords.lookupActionUser(canonical)
		return raced.status === 'found' ? raced.principal : null
	}
}

async function handlePasswordAction(
	request: Request,
	services: Services,
	secure: boolean,
	ctx: RequestContext,
	purpose: PasswordActionPurpose,
): Promise<Response> {
	if (!services.config.authentication.password.enabled) return authError('password login is disabled', 404)
	if (request.method === 'GET') return setPasswordPage({ purpose })
	if (request.method !== 'POST') return methodNotAllowed()
	if (!sameOrigin(request, services.config)) return authError('invalid request origin', 403)
	const form = await readForm(request)
	if (form === null) return authError('invalid form', 400)
	const submittedToken = stringValue(form.get('token'))
	const password = stringValue(form.get('password'))
	if (!validActionToken(submittedToken) || password === null) return invalidActionPage()
	const tokenHash = await hashToken(submittedToken)
	const action = await services.repositories.passwords.inspectActionToken(tokenHash, purpose)
	if (action === null) return invalidActionPage()
	const principal = await services.repositories.principals.getPrincipalById(action.principal_id)
	if (principal === null || principal.disabled_at !== null) return invalidActionPage()
	const policy = validatePassword(password, { email: principal.email, label: principal.label })
	if (!policy.ok) return setPasswordPage({ token: submittedToken, purpose, error: policy.message })
	const completed = await services.repositories.passwords.completeAction({
		tokenHash,
		purpose,
		password: await services.passwordHasher.hash(policy.password),
	})
	if (completed === null) return invalidActionPage()
	const completedPrincipal = await services.repositories.principals.getPrincipalById(completed.principalId)
	if (completedPrincipal === null || completedPrincipal.disabled_at !== null) return invalidActionPage()
	return issueSession(request, services, secure, ctx, {
		principalId: completedPrincipal.id,
		email: completedPrincipal.email,
		authenticationMethod: 'password',
		redirect: services.config.issuer,
		reason: purpose === 'enrollment' ? 'password_enrollment' : 'password_reset',
	})
}

// ── /auth/logout ─────────────────────────────────────────────────────────────────

/**
 * Revoke the login and clear the cookie. Same-origin only, like every other mutating form here:
 * `px_session` is `SameSite=Lax`, so a cross-site top-level GET carried it, and because every app
 * session hangs off this one, that single request logged the human out of every host at once.
 */
async function handleLogout(request: Request, services: Services, secure: boolean): Promise<Response> {
	if (!sameOrigin(request, services.config)) return authError('invalid request origin', 403)
	const cookie = readCookie(request.headers.get('Cookie'), SESSION_COOKIE)
	if (cookie) {
		await services.repositories.sessions.revokeSessionByHash(await hashToken(cookie))
	}
	const url = new URL(request.url)
	const headers = redirectHeaders(safeRedirect(url.searchParams.get('redirect'), services.config))
	headers.append(
		'Set-Cookie',
		clearCookie(SESSION_COOKIE, { path: '/', secure, ...(services.config.sessionCookieDomain ? { domain: services.config.sessionCookieDomain } : {}) }),
	)
	return new Response(null, { status: 302, headers })
}

// ── Helpers ──────────────────────────────────────────────────────────────────────

/**
 * The human-admission allowlist for self-provisioning a brand-new identity. propustka owns this
 * centrally (the deploy vars `FABRIKA_IAM_HUMAN_EMAIL_DOMAINS` / `FABRIKA_IAM_HUMAN_EMAILS`):
 *   - a `*` entry in EITHER list = admit anyone (allow-all);
 *   - an exact email match in `emails`;
 *   - the email's domain in `emailDomains` (case-insensitive);
 *   - a bootstrap admin.
 * Returns false otherwise — an empty allowlist with no `*` means only known/invited principals and
 * bootstrap admins may log in (fail-closed). Matching uses ONLY the IdP-verified email.
 *
 * Both sides of every comparison are normalized. Entra and Okta both preserve directory casing, so a
 * `FABRIKA_IAM_HUMAN_EMAILS` entry spelled `Vip@Example.com` used to be a control that simply never
 * matched, with nothing said about it either way.
 */
function admitted(email: string, config: Config): boolean {
	const { emailDomains, emails } = config.human
	if (emailDomains.includes('*') || emails.includes('*')) {
		return true
	}
	const mailbox = normalizeEmailIdentity(email)
	if (emails.some((allowed) => normalizeEmailIdentity(allowed) === mailbox)) {
		return true
	}
	const at = mailbox.lastIndexOf('@')
	const domain = at === -1 ? '' : mailbox.slice(at + 1)
	if (domain !== '' && emailDomains.some((d) => d.toLowerCase() === domain)) {
		return true
	}
	return config.bootstrapAdmins.has(mailbox)
}

/**
 * Whether the auth cookies must carry `Secure`.
 *
 * The request's own protocol is not a sufficient signal behind a TLS-TERMINATING BALANCER — Zerops'
 * project L7 balancer, or any reverse proxy: the browser spoke HTTPS, the process sees plain HTTP on
 * the private network, and an SSO session cookie set without `Secure` there is one downgrade away
 * from being sent in the clear. The service's configured public origin (`ISSUER`) is the authority on
 * what the BROWSER actually spoke, so an https issuer forces `Secure` regardless of the socket.
 *
 * Widening only: everything that was `Secure` before still is, so the Cloudflare path is unchanged
 * (there the request protocol and the issuer agree anyway).
 */
function secureCookies(url: URL, config: Config): boolean {
	if (url.protocol === 'https:') {
		return true
	}
	try {
		return new URL(config.issuer).protocol === 'https:'
	} catch {
		return false
	}
}

/** Build the long-lived SSO session `Set-Cookie` (parent-domain when configured). */
function sessionCookie(value: string, config: Config, secure: boolean): string {
	return serializeCookie(SESSION_COOKIE, value, {
		httpOnly: true,
		secure,
		sameSite: 'Lax',
		maxAge: SESSION_TTL_SECONDS,
		path: '/',
		...(config.sessionCookieDomain ? { domain: config.sessionCookieDomain } : {}),
	})
}

/** The in-flight OIDC state carried between /auth/login and /auth/callback. */
interface Flight {
	state: string
	verifier: string
	redirect: string
	/** The handoff app, when this SSO detour started from one (ADR-0021). */
	app?: string
}

/** Audience of the flight token — never an app id, so a flight can never pass as an access token. */
const OIDC_FLIGHT_AUDIENCE = 'fabrika:iam:oidc-flight'

/**
 * SIGN the flight, with IAM's own key.
 *
 * The `state` match alone is not a CSRF check when whoever writes the cookie also writes `state`.
 * `Path=/auth` does not isolate it either: cookie-tossing from any host under a shared registrable
 * domain sets a SECOND `px_oidc` the browser also sends, and per RFC 6265 §5.4 the longer-path one
 * comes first — so an attacker could plant their own flight, hand the victim their authorization
 * code, and have IAM issue the victim a session for the ATTACKER'S identity. A signature is what
 * makes "this flight is ours" true rather than assumed.
 */
async function encodeFlight(env: AuthEnv, flight: Flight): Promise<string> {
	const signer = await getSigner(env)
	return signer.signInternal({ ...flight }, OIDC_FLIGHT_AUDIENCE, OIDC_TTL_SECONDS)
}

async function decodeFlight(env: AuthEnv, raw: string | null): Promise<Flight | null> {
	if (!raw) {
		return null
	}
	const payload = await verifyInternal(await getSigner(env), raw, OIDC_FLIGHT_AUDIENCE)
	const state = stringField(payload, 'state')
	const verifier = stringField(payload, 'verifier')
	const redirect = stringField(payload, 'redirect')
	const app = stringField(payload, 'app')
	if (state === undefined || verifier === undefined || redirect === undefined) {
		return null
	}
	return app === undefined || app === '' ? { state, verifier, redirect } : { state, verifier, redirect, app }
}

/**
 * Open-redirect guard. Accept only an absolute URL whose host is propustka's own, within the
 * configured session-cookie domain, or localhost (dev); anything else falls back to the issuer
 * origin. Prevents `/auth/login?redirect=https://evil.example` from bouncing a logged-in user out.
 */
export function safeRedirect(raw: string | null, config: Config): string {
	return acceptableRedirect(raw, config)?.toString() ?? config.issuer
}

/**
 * The parsed target when the SHARED-COOKIE path may send a browser there, else null.
 *
 * Separated from `safeRedirect` because two callers need the verdict rather than the fallback: a
 * refusal here is what tells `readHandoff` that an unregistered app cannot be served by the ordinary
 * login at all (comparing `safeRedirect`'s output to its input cannot say that — `https://x` and the
 * `https://x/` a URL round-trip produces differ as strings while naming the same place).
 */
function acceptableRedirect(raw: string | null, config: Config): URL | null {
	if (!raw) {
		return null
	}
	let target: URL
	try {
		target = new URL(raw)
	} catch {
		return null
	}
	const issuerHost = safeHost(config.issuer)
	const host = target.hostname
	const isLocal = config.environment === 'local'
		&& (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost'))
	const httpsOk = target.protocol === 'https:' || (target.protocol === 'http:' && isLocal)
	const domain = config.sessionCookieDomain.replace(/^\./, '')
	const hostOk = host === issuerHost || isLocal || (domain !== '' && (host === domain || host.endsWith(`.${domain}`)))
	return httpsOk && hostOk ? target : null
}

function safeHost(origin: string): string {
	try {
		return new URL(origin).hostname
	} catch {
		return ''
	}
}

function sameOrigin(request: Request, config: Config): boolean {
	const fetchSite = request.headers.get('Sec-Fetch-Site')
	if (fetchSite !== null && fetchSite !== 'same-origin') return false
	const origin = request.headers.get('Origin') ?? originOf(request.headers.get('Referer'))
	if (origin === null) return false
	try {
		return new URL(origin).origin === new URL(config.issuer).origin
	} catch {
		return false
	}
}

function originOf(value: string | null): string | null {
	if (value === null) return null
	try {
		return new URL(value).origin
	} catch {
		return null
	}
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
	const contentLength = Number(request.headers.get('Content-Length') ?? '0')
	if (Number.isFinite(contentLength) && contentLength > 16_384) return null
	const contentType = request.headers.get('Content-Type') ?? ''
	if (!contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) return null
	if (request.body === null) return new URLSearchParams()
	const reader = request.body.getReader()
	const decoder = new TextDecoder()
	let body = ''
	let bytes = 0
	try {
		while (true) {
			const chunk = await reader.read()
			if (chunk.done) break
			bytes += chunk.value.byteLength
			if (bytes > 16_384) {
				await reader.cancel()
				return null
			}
			body += decoder.decode(chunk.value, { stream: true })
		}
		body += decoder.decode()
		return new URLSearchParams(body)
	} catch {
		return null
	}
}

function stringValue(value: string | null): string | null {
	return typeof value === 'string' ? value : null
}

function normalizeEmail(value: string | null): string | null {
	if (typeof value !== 'string') return null
	const normalized = normalizeEmailIdentity(value)
	if (normalized.length === 0 || normalized.length > 254 || !normalized.includes('@')) return null
	return normalized
}

function matchingBootstrapEmail(email: string, config: Config): string | null {
	const normalized = normalizeEmailIdentity(email)
	return config.bootstrapAdmins.has(normalized) ? normalized : null
}

function validActionToken(token: string | null): token is string {
	return token !== null && token.length <= 512 && /^[A-Za-z0-9_-]{32,}$/.test(token)
}

function methodNotAllowed(): Response {
	return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } })
}

/**
 * Headers for a 302 out of this surface. `no-store` belongs on every one of them, not just the
 * password pages: these are the responses that carry the 30-day session cookie and, on the handoff
 * path, the single-use code in the `Location` itself.
 */
function redirectHeaders(location: string): Headers {
	return new Headers({ location, 'cache-control': 'no-store' })
}

/** A minimal error page for the browser-facing auth flow (the happy path always redirects). */
function authError(message: string, status: number): Response {
	return new Response(`Authentication error: ${message}`, {
		status,
		headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
	})
}

/** `authError` that also spends the OIDC flight — every terminal callback outcome goes through here. */
function authErrorEndingFlight(message: string, status: number, secure: boolean): Response {
	return new Response(`Authentication error: ${message}`, {
		status,
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'no-store',
			'set-cookie': clearCookie(OIDC_COOKIE, { path: '/auth', secure }),
		},
	})
}

/** Keep an untrusted value fit for a plain-text error body: printable ASCII, bounded. */
function printable(value: string): string {
	return value.replace(/[^\x20-\x7e]/g, '').slice(0, 120)
}
