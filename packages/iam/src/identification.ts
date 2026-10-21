// The identification of a person at an enrolled terminal (ADR-0067 §2, §3): what an application asks IAM about an
// identification that `/auth/login` opened for a terminal's browser, and its word about who stands there. IAM takes the
// asserting application from the caller's verified token, never from the input. The code of the handoff the
// application's proxy started is issued only at the completion, to the terminal's own browser (`auth/terminals.ts`).

import {
	type AssertIdentityInput,
	type AssertIdentityResult,
	type CancelIdentificationInput,
	type CancelIdentificationResult,
	IDENTIFICATION_QUERY_PARAMETER,
	type InspectIdentificationInput,
	type InspectIdentificationResult,
	type TerminalCaller,
	type TerminalFailure,
} from '@fabrika/auth-core'
import { uuidv7 } from '@fabrika/platform'
import { IAM_APP } from './admin/router'
import { administersIam } from './auth/sessions'
import { type PrincipalRow, principalStatus, type SessionTerminal, type TerminalIdentificationRow, type TerminalRow } from './db'
import type { Env } from './env'
import { randomToken } from './oidc'
import { unixNow } from './repositories/sql'
import { hashToken } from './secret'
import type { Services } from './services'
import { getSigner, verifyAccessToken } from './signing'

/** How long the person at a terminal has to identify before the sign-in starts over. */
export const IDENTIFICATION_TTL_SECONDS = 120

/** How long the terminal's browser has, after an assertion, to complete the identification at IAM. */
export const COMPLETION_TTL_SECONDS = 60

/** Where an application sends the terminal's browser after its assertion; IAM issues the code there. */
export const TERMINAL_COMPLETE_PATH = '/auth/terminals/complete'

/** The longest identification id or principal id IAM looks up; its own are far shorter. */
const MAX_ID_LENGTH = 128

const NOT_FOUND: TerminalFailure = { ok: false, reason: 'not_found' }
const INVALID_PRINCIPAL: TerminalFailure = { ok: false, reason: 'invalid_principal' }

type CallerEnv = Pick<Env, 'FABRIKA_IAM_SIGNING_KEYS' | 'ENVIRONMENT'>

/** The application asking: the audience of the caller's verified token, which must be the `app` it names. */
async function askingApp(services: Services, env: CallerEnv, caller: TerminalCaller): Promise<{ ok: true; app: string } | TerminalFailure> {
	if (caller.credential === null) {
		return { ok: false, reason: 'missing_token' }
	}
	const claims = await verifyAccessToken(await getSigner(env), caller.credential, { issuer: services.config.issuer, audience: caller.app })
	return claims === null ? { ok: false, reason: 'invalid_token' } : { ok: true, app: claims.aud }
}

interface OpenIdentification {
	readonly identification: TerminalIdentificationRow
	readonly terminal: TerminalRow
}

/**
 * The identification `id` of `app` while it is open: unexpired, unconsumed, on an enrolled terminal with an enabled
 * principal that still lists `app` as an asserter. Null for anything else, so an id reveals nothing.
 */
async function openIdentification(services: Services, app: string, id: string, now: number): Promise<OpenIdentification | null> {
	if (id.length === 0 || id.length > MAX_ID_LENGTH) {
		return null
	}
	const { terminals, principals } = services.repositories
	const identification = await terminals.getIdentification(await hashToken(id))
	if (identification === null || identification.app !== app || identification.consumed_at !== null || identification.expires_at <= now) {
		return null
	}
	const terminal = await terminals.getById(identification.terminal_id)
	if (terminal === null || terminal.revoked_at !== null || await terminals.getAsserter(terminal.principal_id, app) === null) {
		return null
	}
	const principal = await principals.getPrincipalById(terminal.principal_id)
	if (principal === null || principalStatus(principal) !== 'active') {
		return null
	}
	return { identification, terminal }
}

/** The terminal an open identification belongs to and when it expires; the application keys its throttle on the terminal. */
export async function inspectIdentification(
	services: Services,
	env: CallerEnv,
	input: InspectIdentificationInput,
): Promise<InspectIdentificationResult> {
	const asking = await askingApp(services, env, input)
	if (!asking.ok) {
		return asking
	}
	const open = await openIdentification(services, asking.app, input.id, unixNow())
	if (open === null) {
		return NOT_FOUND
	}
	return { ok: true, terminal: { id: open.terminal.principal_id, label: open.terminal.label }, expiresAt: open.identification.expires_at }
}

/** The answer of an assertion, with the principal and terminal its `auth_log` row of a refusal names. */
export interface AssertOutcome {
	result: AssertIdentityResult
	principalId: string | null
	terminal: SessionTerminal | null
}

/**
 * The application's word that `principalId` stands at the identification's terminal. In one batch, IAM consumes the
 * identification and opens a login for the person that no browser holds (the parent of the application session), with
 * its `auth_log` row. It answers IAM's completion URL, never a code: only the terminal's own browser completes the
 * identification there, and only then does IAM issue the code of the handoff the identification carries. A refused
 * principal leaves the identification open, so the person can try again within its two minutes.
 */
export async function assertIdentity(services: Services, env: CallerEnv, input: AssertIdentityInput): Promise<AssertOutcome> {
	const asking = await askingApp(services, env, input)
	if (!asking.ok) {
		return { result: asking, principalId: null, terminal: null }
	}
	const now = unixNow()
	const open = await openIdentification(services, asking.app, input.id, now)
	if (open === null) {
		return { result: NOT_FOUND, principalId: null, terminal: null }
	}
	const terminal: SessionTerminal = { terminalId: open.terminal.principal_id, assertedBy: asking.app }
	const person = input.principalId.length > MAX_ID_LENGTH ? null : await services.repositories.principals.getPrincipalById(input.principalId)
	if (person === null || !signsInAtTerminal(person)) {
		return { result: INVALID_PRINCIPAL, principalId: person?.id ?? null, terminal }
	}
	const { terminals, sessions } = services.repositories
	const idHash = open.identification.id_hash
	const loginId = uuidv7()
	const login = sessions.createSessionStatements(loginId, {
		tokenHash: await hashToken(randomToken(32)),
		principalId: person.id,
		authenticationMethod: 'terminal_assertion',
		terminal,
		expiresAt: now + open.terminal.session_ttl,
	}, {
		requestId: input.requestId,
		app: IAM_APP,
		kind: 'authenticate',
		principalId: person.id,
		decision: 'allow',
		reason: 'terminal_assertion',
		privileged: await administersIam(services, person.id),
		terminal,
	}, terminals.consumedFor(idHash, loginId))
	// Single use: a concurrent assertion of the same id consumes nothing, opens no login and is refused here.
	const consumed = await terminals.consumeIdentification({ idHash, sessionId: loginId, now, completeBy: now + COMPLETION_TTL_SECONDS }, login)
	if (consumed === null) {
		return { result: NOT_FOUND, principalId: person.id, terminal }
	}
	const completion = new URL(TERMINAL_COMPLETE_PATH, services.config.issuer)
	completion.searchParams.set(IDENTIFICATION_QUERY_PARAMETER, input.id)
	return { result: { ok: true, completionUrl: completion.toString() }, principalId: person.id, terminal }
}

/** An active internal person. A service never signs in, and an external principal never on a terminal (ADR-0051). */
function signsInAtTerminal(principal: PrincipalRow): boolean {
	return principal.type === 'user' && principal.affiliation === 'internal' && principalStatus(principal) === 'active'
}

/** End an identification of the asking application that the person abandoned. */
export async function cancelIdentification(
	services: Services,
	env: CallerEnv,
	input: CancelIdentificationInput,
): Promise<CancelIdentificationResult> {
	const asking = await askingApp(services, env, input)
	if (!asking.ok) {
		return asking
	}
	if (input.id.length === 0 || input.id.length > MAX_ID_LENGTH) {
		return NOT_FOUND
	}
	const cancelled = await services.repositories.terminals.cancelIdentification(await hashToken(input.id), asking.app)
	return cancelled ? { ok: true } : NOT_FOUND
}
