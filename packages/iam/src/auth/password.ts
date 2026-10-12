import { AUTH_HANDOFF_CHALLENGE_PARAM, AUTH_HANDOFF_STATE_PARAM } from '@fabrika/auth-core'
import { z } from 'zod'
import { type AuditEventInput } from '../db'
import { normalizeEmailIdentity } from '../email-identity'

import { type RequestContext } from '../env'
import { type PasswordActionPurpose } from '../password-db'
import { forgotPasswordPage, invalidActionPage, loginPage, setPasswordPage } from '../password-pages'
import { PASSWORD_MAX_CODE_POINTS, validatePassword } from '../password-policy'
import { deliverPasswordAction, issuePasswordAction } from '../password-service'
import { hashToken } from '../secret'
import { type Config, type Services } from '../services'
import { handoffOf, handoffRedirectOr, loginHandoffFields, readHandoff } from './handoff'
import { authError, methodNotAllowed, readForm, sameOrigin, stringValue } from './http'
import { issueSession, refuseLogin } from './sessions'

const LOGIN_WINDOW_SECONDS = 15 * 60

const LOGIN_BLOCK_SECONDS = 15 * 60

const ACCOUNT_MAX_ATTEMPTS = 5

const GLOBAL_MAX_ATTEMPTS = 1_000

const RECOVERY_ACCOUNT_MAX_ATTEMPTS = 3

const RECOVERY_GLOBAL_MAX_ATTEMPTS = 100

/**
 * The per-client buckets (WU-C, backlog 21 + 49). They sit between the account bucket and the
 * deployment-wide one on purpose: the point is to stop ONE client exhausting the deployment-wide
 * bucket and denying everyone, not to be a second account lockout. Generous enough that a shared
 * office address logging in normally never reaches them; a client that does is not logging in.
 */
const LOGIN_CLIENT_MAX_ATTEMPTS = 100

const RECOVERY_CLIENT_MAX_ATTEMPTS = 30

const emailSchema = z.string().transform(normalizeEmailIdentity).pipe(z.string().min(1).max(254).includes('@'))
const loginFormSchema = z.object({ email: emailSchema, password: z.string().transform((value) => value.normalize('NFC')) })
const passwordActionFormSchema = z.object({ token: z.string().max(512).regex(/^[A-Za-z0-9_-]{32,}$/), password: z.string() })

/**
 * The per-client bucket, and the reason it is shaped differently from the other two.
 *
 * The account and deployment-wide buckets READ first and record a failure afterwards, which is a
 * check-then-act: a concurrent burst all reads "not blocked" and all proceeds. That is tolerable for a
 * bucket whose key an attacker cannot pick freely; it is not tolerable for the one bucket whose whole
 * job is to bound a burst. So this one is a single statement — `recordLoginFailure` is one
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING`, and the admission decision is read from ITS OWN
 * returned row. Every concurrent request therefore observes its own increment and no request can be
 * admitted on a count another has not yet written.
 *
 * It counts every ATTEMPT, not every failure, for the same reason: a decision made before the work
 * cannot know the outcome. A successful login never clears it either — clearing on success would let
 * an attacker who holds one valid credential reset the bucket between bursts.
 *
 * `null` (this composition cannot see the client) records nothing and blocks nothing.
 */
async function clientBlocked(
	services: Services,
	purpose: 'password-login' | 'password-recovery',
	clientAddress: string | null,
	maxAttempts: number,
): Promise<boolean> {
	if (clientAddress === null) return false
	// Hashed like every other key here: the throttle table must never hold a client address in the clear.
	const row = await services.repositories.passwords.recordLoginFailure({
		loginKeyHash: await hashToken(`${purpose}:client:${clientAddress}`),
		windowSeconds: LOGIN_WINDOW_SECONDS,
		maxAttempts,
		blockSeconds: LOGIN_BLOCK_SECONDS,
	})
	return (row.blocked_until ?? 0) > Math.floor(Date.now() / 1000)
}

export async function handlePasswordLogin(
	request: Request,
	services: Services,
	ctx: RequestContext,
	clientAddress: string | null,
	requestId: string,
): Promise<Response> {
	if (!services.config.authentication.password.enabled) return authError('password login is disabled', 404)
	if (!sameOrigin(request, services.config)) return authError('invalid request origin', 403)
	const form = await readForm(request)
	if (form === null) return authError('invalid form', 400)
	const login = loginFormSchema.safeParse({ email: form.get('email'), password: form.get('password') })
	// The form is a hint, not a permission: `readHandoff` re-checks the return URL against what the app
	// has registered, so a hand-edited field buys nothing.
	const reading = await readHandoff(
		services,
		stringValue(form.get('app')),
		stringValue(form.get('redirect')),
		stringValue(form.get(AUTH_HANDOFF_STATE_PARAM)),
		stringValue(form.get(AUTH_HANDOFF_CHALLENGE_PARAM)),
	)
	if (reading.kind === 'refused') {
		return refuseLogin(services, { requestId, principalId: null, reason: 'handoff_refused' }, () => authError(reading.message, 400))
	}
	const handoff = handoffOf(reading)
	const redirect = handoffRedirectOr(handoff, stringValue(form.get('redirect')), services)
	const retry = {
		redirect,
		oidcEnabled: services.config.authentication.oidc.enabled,
		forgotEnabled: services.email !== null,
		...loginHandoffFields(handoff),
	}
	if (!login.success) {
		return refuseLogin(
			services,
			{ requestId, principalId: null, reason: 'password_malformed' },
			() => loginPage({ ...retry, error: 'Invalid email or password.' }),
		)
	}
	const { email, password } = login.data
	const passwordWithinLimit = Array.from(password).length <= PASSWORD_MAX_CODE_POINTS

	const accountKey = await hashToken(`password-login:account:${email}`)
	const globalKey = await hashToken('password-login:global')
	const [accountThrottle, globalThrottle, lookup, clientOverLimit] = await Promise.all([
		services.repositories.passwords.getLoginThrottle(accountKey),
		services.repositories.passwords.getLoginThrottle(globalKey),
		services.repositories.passwords.lookupLogin(email),
		clientBlocked(services, 'password-login', clientAddress, LOGIN_CLIENT_MAX_ATTEMPTS),
	])
	const now = Math.floor(Date.now() / 1000)
	const blocked = clientOverLimit || (accountThrottle?.blocked_until ?? 0) > now || (globalThrottle?.blocked_until ?? 0) > now
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
			await services.repositories.passwords.upsertCredential(
				lookup.principal.id,
				await services.passwordHasher.hash(password),
				selfEvent(requestId, lookup.principal.id, 'iam.password.rehash'),
			)
		}
		await services.repositories.passwords.clearLoginFailures(accountKey)
		return issueSession(request, services, ctx, {
			principalId: lookup.principal.id,
			email: lookup.principal.email,
			authenticationMethod: 'password',
			redirect,
			reason: 'password_login',
			requestId,
			handoff,
		})
	}

	if (!blocked) {
		await Promise.all([
			recordLoginFailure(services, accountKey, ACCOUNT_MAX_ATTEMPTS),
			recordLoginFailure(services, globalKey, GLOBAL_MAX_ATTEMPTS),
		])
	}
	return refuseLogin(
		services,
		{
			requestId,
			principalId: lookup.status === 'found' ? lookup.principal.id : null,
			reason: blocked ? 'password_throttled' : 'password_invalid',
		},
		() => loginPage({ ...retry, error: 'Invalid email or password.' }),
	)
}

async function recordLoginFailure(services: Services, loginKeyHash: string, maxAttempts: number): Promise<void> {
	await services.repositories.passwords.recordLoginFailure({
		loginKeyHash,
		windowSeconds: LOGIN_WINDOW_SECONDS,
		maxAttempts,
		blockSeconds: LOGIN_BLOCK_SECONDS,
	})
}

export async function handleForgotPassword(
	request: Request,
	services: Services,
	ctx: RequestContext,
	clientAddress: string | null,
	requestId: string,
): Promise<Response> {
	if (!services.config.authentication.password.enabled) return authError('password login is disabled', 404)
	if (request.method === 'GET') return forgotPasswordPage({})
	if (request.method !== 'POST') return methodNotAllowed()
	if (!sameOrigin(request, services.config)) return authError('invalid request origin', 403)
	const form = await readForm(request)
	if (form === null) return authError('invalid form', 400)
	const parsedEmail = emailSchema.safeParse(form.get('email'))
	if (services.email === null || !parsedEmail.success) return forgotPasswordPage({ sent: true })
	const email = parsedEmail.data
	const accountKey = await hashToken(`password-recovery:account:${email}`)
	const globalKey = await hashToken('password-recovery:global')
	const [accountThrottle, globalThrottle, clientOverLimit] = await Promise.all([
		services.repositories.passwords.getLoginThrottle(accountKey),
		services.repositories.passwords.getLoginThrottle(globalKey),
		clientBlocked(services, 'password-recovery', clientAddress, RECOVERY_CLIENT_MAX_ATTEMPTS),
	])
	const now = Math.floor(Date.now() / 1000)
	if (clientOverLimit || (accountThrottle?.blocked_until ?? 0) > now || (globalThrottle?.blocked_until ?? 0) > now) {
		return forgotPasswordPage({ sent: true })
	}
	await Promise.all([
		recordLoginFailure(services, accountKey, RECOVERY_ACCOUNT_MAX_ATTEMPTS),
		recordLoginFailure(services, globalKey, RECOVERY_GLOBAL_MAX_ATTEMPTS),
	])
	ctx.waitUntil(runForgotPassword(services, email, requestId).catch(() => console.error('Password recovery request failed')))
	return forgotPasswordPage({ sent: true })
}

async function runForgotPassword(services: Services, email: string, requestId: string): Promise<void> {
	let lookup = await services.repositories.passwords.lookupActionUser(email)
	if (
		lookup.status === 'missing'
		&& !services.config.authentication.oidc.enabled
		&& matchingBootstrapEmail(email, services.config) !== null
	) {
		const principal = await safelyCreateBootstrapPrincipal(services, email, requestId)
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

async function safelyCreateBootstrapPrincipal(services: Services, email: string, requestId: string) {
	// Re-check through the case-insensitive, ambiguity-detecting lookup before the unique insert.
	const existing = await services.repositories.passwords.lookupActionUser(email)
	if (existing.status === 'found') return existing.principal
	if (existing.status === 'ambiguous') return null
	const canonical = matchingBootstrapEmail(email, services.config)
	if (canonical === null) return null
	try {
		const principal = await services.repositories.principals.inviteUser(
			canonical,
			canonical,
			(principalId) => selfEvent(requestId, principalId, 'iam.principal.bootstrap'),
		)
		await services.repositories.passwords.enableEnrollment(principal.id)
		return principal
	} catch {
		const raced = await services.repositories.passwords.lookupActionUser(canonical)
		return raced.status === 'found' ? raced.principal : null
	}
}

export async function handlePasswordAction(
	request: Request,
	services: Services,
	ctx: RequestContext,
	purpose: PasswordActionPurpose,
	requestId: string,
): Promise<Response> {
	if (!services.config.authentication.password.enabled) return authError('password login is disabled', 404)
	if (request.method === 'GET') return setPasswordPage({ purpose })
	if (request.method !== 'POST') return methodNotAllowed()
	if (!sameOrigin(request, services.config)) return authError('invalid request origin', 403)
	const form = await readForm(request)
	if (form === null) return authError('invalid form', 400)
	const submitted = passwordActionFormSchema.safeParse({ token: form.get('token'), password: form.get('password') })
	if (!submitted.success) return invalidActionPage()
	const { token: submittedToken, password } = submitted.data
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
	}, selfEvent(requestId, principal.id, `iam.password.${purpose}.complete`))
	if (completed === null) return invalidActionPage()
	const completedPrincipal = await services.repositories.principals.getPrincipalById(completed.principalId)
	if (completedPrincipal === null || completedPrincipal.disabled_at !== null) return invalidActionPage()
	return issueSession(request, services, ctx, {
		principalId: completedPrincipal.id,
		email: completedPrincipal.email,
		authenticationMethod: 'password',
		redirect: services.config.issuer,
		reason: purpose === 'enrollment' ? 'password_enrollment' : 'password_reset',
		requestId,
	})
}

function matchingBootstrapEmail(email: string, config: Config): string | null {
	const normalized = normalizeEmailIdentity(email)
	return config.bootstrapAdmins.has(normalized) ? normalized : null
}

/** The record of a change a principal made to its own credentials: by it, about it, and with no email in it. */
function selfEvent(requestId: string, principalId: string, action: string): AuditEventInput {
	return { requestId, principalId, principalLabel: principalId, app: 'propustka', action, resourceType: 'principal', resourceId: principalId }
}
