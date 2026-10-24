// `ctx.terminals`: the identification of a person at an enrolled terminal (ADR-0067). The application's identification
// page sends what the person entered to its own procedure, which asks IAM through these calls. The framework presents
// the request's credential (a public procedure's workload token), and IAM takes the asserting application from the
// verified transport. Throttling guesses is the application's: `inspect` hands it the terminal to key them on.

import type { IamTerminalRpc, IdentificationTerminal, MembershipCaller, TerminalFailure } from '@fabrika/auth-core'
import { ServerFault } from './faults'

/** An identification id longer than this is none IAM issued, so no call is made for it. */
const MAX_IDENTIFICATION_ID_LENGTH = 200

/** An open identification: the terminal it was opened on and when it expires (unix seconds). */
export interface OpenIdentification {
	readonly terminal: IdentificationTerminal
	readonly expiresAt: number
}

/**
 * IAM's answer to an assertion: the URL the browser goes to next, or why IAM refused. `not_found` is an identification
 * that is unknown, expired, used, cancelled or no longer open to this application; `invalid_principal` a principal
 * that cannot sign in on a terminal (unknown, disabled, not a person, or external).
 */
export type AssertedIdentity =
	| { readonly ok: true; readonly completionUrl: string }
	| { readonly ok: false; readonly reason: 'not_found' | 'invalid_principal' }

/** `ctx.terminals` of an application that declares `terminal: { identify }`. */
export interface TerminalIdentification {
	/** The open identification `id` (the page's `identification` query parameter), or null when there is none. */
	inspect(id: string): Promise<OpenIdentification | null>
	/**
	 * The application's word that `principalId` stands at the identification's terminal. IAM uses the identification up
	 * and, on `ok`, the handler sends the browser to `completionUrl`: IAM signs the person in there, and only on the
	 * terminal's own browser.
	 */
	assert(id: string, principalId: string): Promise<AssertedIdentity>
	/** Ends an identification the person abandoned; one that is no longer open is already ended. */
	cancel(id: string): Promise<void>
}

/** `ctx.terminals` for one request: every call carries the request's credential and correlation id. */
export function terminalIdentification(rpc: IamTerminalRpc, caller: MembershipCaller): TerminalIdentification {
	return Object.freeze({
		async inspect(id: string): Promise<OpenIdentification | null> {
			if (!isIdentificationId(id)) return null
			const result = await ask(() => rpc.inspectIdentification({ ...caller, id }), 'inspect an identification')
			if (!result.ok) return null
			return Object.freeze({ terminal: Object.freeze({ id: result.terminal.id, label: result.terminal.label }), expiresAt: result.expiresAt })
		},
		async assert(id: string, principalId: string): Promise<AssertedIdentity> {
			if (!isIdentificationId(id)) return { ok: false, reason: 'not_found' }
			const result = await ask(() => rpc.assertIdentity({ ...caller, id, principalId }), 'assert an identity')
			return result.ok ? { ok: true, completionUrl: result.completionUrl } : { ok: false, reason: result.reason }
		},
		async cancel(id: string): Promise<void> {
			if (isIdentificationId(id)) {
				await ask(() => rpc.cancelIdentification({ ...caller, id }), 'cancel an identification')
			}
		},
	})
}

function isIdentificationId(id: string): boolean {
	return id !== '' && id.length <= MAX_IDENTIFICATION_ID_LENGTH
}

/**
 * Runs one IAM call. A transport failure is a 503 that names nothing; IAM refusing the application's own credential is
 * a server fault, because the visitor cannot change it. What remains is the handler's answer.
 */
async function ask<T extends { readonly ok: true }>(
	work: () => Promise<T | TerminalFailure>,
	operation: string,
): Promise<T | { readonly ok: false; readonly reason: 'not_found' | 'invalid_principal' }> {
	let result: T | TerminalFailure
	try {
		result = await work()
	} catch {
		throw new ServerFault('iam_unavailable', `IAM could not be asked to ${operation}`, 503)
	}
	if (result.ok) {
		return result
	}
	switch (result.reason) {
		case 'not_found':
		case 'invalid_principal':
			return { ok: false, reason: result.reason }
		case 'missing_token':
		case 'invalid_token':
		case 'not_allowed':
			throw new ServerFault('terminal_refused', `IAM refused the application's credential to ${operation}: ${result.reason}`)
	}
}
