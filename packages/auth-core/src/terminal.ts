// What an application declares and calls to sign a person in on an enrolled terminal (ADR-0067): its identification
// page, and the identification operations a handler asks IAM for. IAM takes the asserting application from the
// verified transport, never from the input: over `/membership/*` the application's membership transport key pins it, and
// over a Workers binding the `props` the deployer wrote on the application's `IAM` binding pin it. The credential must
// also verify for that application, but its audience alone proves nothing.

import { isCanonicalPath } from './canonical-path'
import type { MembershipCaller } from './membership'

/** The terminal declaration of a contract: the page on the application's own origin that identifies a person. */
export interface TerminalArtifact {
	readonly identify: string
}

/** The longest identification path a contract declares. */
export const MAX_TERMINAL_IDENTIFY_PATH_LENGTH = 200

/** The query parameter IAM appends to the identification page: the identification's id. */
export const IDENTIFICATION_QUERY_PARAMETER = 'identification'

/** The path prefix the platform owns on every application host. */
const PLATFORM_PATH = '/__fabrika'

/**
 * Why `path` is not an identification page, or `null`: an absolute, canonical path on the application's own origin,
 * with no query or fragment (IAM appends its own) and outside the platform's `/__fabrika`.
 */
export function terminalIdentifyProblem(path: string): string | null {
	if (path.length === 0 || path.length > MAX_TERMINAL_IDENTIFY_PATH_LENGTH) {
		return `is 1 to ${MAX_TERMINAL_IDENTIFY_PATH_LENGTH} characters`
	}
	if (!path.startsWith('/') || path.startsWith('//')) {
		return "is not an absolute path on the application's own origin (write it as '/identify')"
	}
	if (/[?#\s\p{Cc}]/u.test(path)) {
		return 'carries a query, a fragment, whitespace or a control character; IAM appends the query itself'
	}
	if (!isCanonicalPath(path)) {
		return 'is not a canonical path: no empty, `.` or `..` segment, no `\\` and no encoded separator'
	}
	if (path === PLATFORM_PATH || path.startsWith(`${PLATFORM_PATH}/`)) {
		return `lies under ${PLATFORM_PATH}, which the platform owns`
	}
	return null
}

/** Every identification operation carries the caller's verified credential: a public procedure's workload token. */
export type TerminalCaller = MembershipCaller

/**
 * Why IAM refused. `not_found` is an identification that is unknown, expired, consumed, cancelled, of another
 * application, or whose terminal no longer lists the application: alike, so an id reveals nothing. `invalid_principal`
 * is a principal that cannot sign in on a terminal: unknown, disabled, not a person, or external (ADR-0051).
 */
export type TerminalFailure = {
	ok: false
	reason: 'missing_token' | 'invalid_token' | 'not_allowed' | 'not_found' | 'invalid_principal'
}

export type TerminalFailureReason = TerminalFailure['reason']

/** The terminal an identification was opened on, as the token's `terminal` claim names it. */
export interface IdentificationTerminal {
	id: string
	label: string
}

/** Read an open identification: the id is the `identification` query parameter of the identification page. */
export interface InspectIdentificationInput extends TerminalCaller {
	id: string
}

/** `expiresAt` is unix seconds. The application keys its throttle of guesses on `terminal.id`. */
export type InspectIdentificationResult = { ok: true; terminal: IdentificationTerminal; expiresAt: number } | TerminalFailure

/**
 * The application's word that `principalId` stands at the identification's terminal. IAM consumes the identification
 * (single use), signs the person in under the terminal's ceiling, and answers the URL the browser goes to next: IAM's
 * completion of the identification, which issues the handoff code only to the terminal's own browser. The application
 * never holds a code.
 */
export interface AssertIdentityInput extends TerminalCaller {
	id: string
	principalId: string
}

export type AssertIdentityResult = { ok: true; completionUrl: string } | TerminalFailure

/** End an identification the person abandoned. Repeating it, or cancelling a consumed one, answers `not_found`. */
export interface CancelIdentificationInput extends TerminalCaller {
	id: string
}

export type CancelIdentificationResult = { ok: true } | TerminalFailure

/**
 * The identification operations IAM serves an application: on the membership transport (`/membership/<method>`) and
 * on its application entrypoint. A SEPARATE interface from `IamMembershipRpc`, so a transport that predates terminals
 * still satisfies that one.
 */
export interface IamTerminalRpc {
	inspectIdentification(input: InspectIdentificationInput): Promise<InspectIdentificationResult>
	assertIdentity(input: AssertIdentityInput): Promise<AssertIdentityResult>
	cancelIdentification(input: CancelIdentificationInput): Promise<CancelIdentificationResult>
}
