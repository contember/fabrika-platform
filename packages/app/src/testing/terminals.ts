// The kit's IAM for identifications at a terminal (ADR-0067): a test opens one as IAM does when an enrolled terminal's
// browser arrives with no login, and the application's `ctx.terminals` inspects, asserts and cancels it under IAM's
// rules: single use, two minutes, the application's own credential, and a principal that may sign in at a terminal.

import {
	type AssertIdentityResult,
	type CancelIdentificationResult,
	type IamTerminalRpc,
	IDENTIFICATION_QUERY_PARAMETER,
	type IdentificationTerminal,
	type InspectIdentificationResult,
	type TerminalCaller,
	type TerminalFailure,
} from '@fabrika/auth-core'
import type { TestCaller } from './caller'

/** IAM's `IDENTIFICATION_TTL_SECONDS`: how long the person at a terminal has to identify. */
const IDENTIFICATION_TTL_SECONDS = 120

/** IAM's `TERMINAL_COMPLETE_PATH`, where the application sends the terminal's browser after its assertion. */
const TERMINAL_COMPLETE_PATH = '/auth/terminals/complete'

const NOT_FOUND: TerminalFailure = { ok: false, reason: 'not_found' }

/** An identification the kit's IAM opened, as the terminal's browser arrives at the identification page. */
export interface TestIdentification {
	/** The id IAM appends to the identification page as `?identification=`. */
	readonly id: string
	readonly terminal: IdentificationTerminal
	/** The identification page with the id, where IAM sends the terminal's browser. */
	readonly url: string
	/** Unix seconds. */
	readonly expiresAt: number
}

/** What became of an identification: still open, asserted for a principal, or cancelled. */
export type TestIdentificationState =
	& TestIdentification
	& (
		| { readonly state: 'open'; readonly principalId: null; readonly completionUrl: null }
		| { readonly state: 'asserted'; readonly principalId: string; readonly completionUrl: string }
		| { readonly state: 'cancelled'; readonly principalId: null; readonly completionUrl: null }
	)

export interface KitIdentificationsOptions {
	readonly issuer: string
	/** The identification page on the application's origin, absolute. */
	readonly identifyUrl: string
	/** Whether `credential` is a token the kit's IAM signed for this application. */
	readonly verifies: (credential: string) => Promise<boolean>
	/** The kit's callers holding the principal id `id`. */
	readonly principals: (id: string) => readonly TestCaller[]
}

export interface KitIdentifications {
	readonly rpc: IamTerminalRpc
	open(terminal: IdentificationTerminal): TestIdentification
	stateOf(id: string): TestIdentificationState | undefined
}

/** The kit's stand-in for IAM's identification operations, over the identifications a test opened. */
export function kitIdentifications(options: KitIdentificationsOptions): KitIdentifications {
	const identifications = new Map<string, TestIdentificationState>()

	/** The open identification `id`, or why IAM answers none: the caller's credential first, as IAM checks it. */
	async function openOne(caller: TerminalCaller, id: string): Promise<TestIdentificationState | TerminalFailure> {
		if (caller.credential === null) {
			return { ok: false, reason: 'missing_token' }
		}
		if (!(await options.verifies(caller.credential))) {
			return { ok: false, reason: 'invalid_token' }
		}
		const identification = identifications.get(id)
		if (identification === undefined || identification.state !== 'open' || identification.expiresAt <= unixNow()) {
			return NOT_FOUND
		}
		return identification
	}

	const rpc: IamTerminalRpc = {
		async inspectIdentification(input): Promise<InspectIdentificationResult> {
			const open = await openOne(input, input.id)
			return 'ok' in open ? open : { ok: true, terminal: open.terminal, expiresAt: open.expiresAt }
		},
		async assertIdentity(input): Promise<AssertIdentityResult> {
			const open = await openOne(input, input.id)
			if ('ok' in open) {
				return open
			}
			// A refused principal leaves the identification open, so the person can try again.
			if (!options.principals(input.principalId).some(signsInAtTerminal)) {
				return { ok: false, reason: 'invalid_principal' }
			}
			const completion = new URL(TERMINAL_COMPLETE_PATH, options.issuer)
			completion.searchParams.set(IDENTIFICATION_QUERY_PARAMETER, open.id)
			const completionUrl = completion.toString()
			identifications.set(open.id, Object.freeze({ ...identity(open), state: 'asserted', principalId: input.principalId, completionUrl }))
			return { ok: true, completionUrl }
		},
		async cancelIdentification(input): Promise<CancelIdentificationResult> {
			const open = await openOne(input, input.id)
			if ('ok' in open) {
				return open
			}
			identifications.set(open.id, Object.freeze({ ...identity(open), state: 'cancelled', principalId: null, completionUrl: null }))
			return { ok: true }
		},
	}

	return {
		rpc,
		open(terminal) {
			const id = `identification_${crypto.randomUUID().replaceAll('-', '')}`
			const url = new URL(options.identifyUrl)
			url.searchParams.set(IDENTIFICATION_QUERY_PARAMETER, id)
			const opened: TestIdentification = Object.freeze({
				id,
				terminal: Object.freeze({ id: terminal.id, label: terminal.label }),
				url: url.toString(),
				expiresAt: unixNow() + IDENTIFICATION_TTL_SECONDS,
			})
			identifications.set(id, Object.freeze({ ...opened, state: 'open', principalId: null, completionUrl: null }))
			return opened
		},
		stateOf: (id) => identifications.get(id),
	}
}

function identity(identification: TestIdentification): TestIdentification {
	return { id: identification.id, terminal: identification.terminal, url: identification.url, expiresAt: identification.expiresAt }
}

/** An enabled internal person, as IAM admits one at a terminal: never a service, a link holder or an external (ADR-0051). */
function signsInAtTerminal(caller: TestCaller): boolean {
	return caller.kind === 'human' && caller.affiliation === 'internal' && !caller.disabled
}

function unixNow(): number {
	return Math.floor(Date.now() / 1000)
}
