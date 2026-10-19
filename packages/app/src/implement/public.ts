// What a procedure admits before its handler runs, decided once at boot from the approved artifact: its buckets, a
// public procedure's challenge, and its time limit. The buckets live in the application's database
// (`@fabrika/db`'s `Admissions`, keyed by the endpoint id), so every instance shares them. Admission is not authorization: it bounds how much one client, one caller and everyone together send.

import { type AdmissionRate, CLIENT_ADDRESS_HEADER, type ContractArtifact, type ProcedureArtifact } from '@fabrika/auth-core'
import { createHash } from 'node:crypto'
import { REQUEST_BUDGET_MS } from './bounded'
import { type ChallengeFetch, type ChallengeVerifier, turnstileVerifier } from './challenge'
import { clientBucket, clientKey } from './client-address'
import type { RequestClient } from './types'

/** The bucket every call of an endpoint takes from; a client's is `client:<digest>`, a caller's `caller:<digest>`. */
export const ENDPOINT_BUCKET = 'endpoint'

/** The longest `User-Agent` a handler reads: enough to tell browsers apart, too short to carry a payload. */
export const MAX_USER_AGENT_LENGTH = 256

/** A procedure's admission and time limit, from the approved artifact. */
export interface ProcedureAdmission {
	readonly rate: AdmissionRate
	/** The challenge's verifier, with the secret its application variable holds; `null` without a challenge. */
	readonly challenge: ChallengeVerifier | null
	/** The one token the challenge does not record, so it passes again: `fabrika app dev`'s test widget's. */
	readonly repeatableToken: string | null
	/** How long the handler may run after the last body byte. */
	readonly timeoutMs: number
}

/** A procedure the artifact holds no rules for (a `defineContract` one): no bucket, the request budget. */
export const DEFAULT_ADMISSION: ProcedureAdmission = Object.freeze({
	rate: Object.freeze({ perClient: null, perCaller: null, perEndpoint: null, bytesPerHour: null }),
	challenge: null,
	repeatableToken: null,
	timeoutMs: REQUEST_BUDGET_MS,
})

export interface AdmissionOptions {
	readonly application: Readonly<Record<string, unknown>>
	readonly challengeFetch?: ChallengeFetch
	readonly repeatableChallengeToken?: string
}

/**
 * The admission of endpoint `id`, or `null` after a problem: a challenge whose secret's application variable is not set
 * keeps the application from booting, as a form's does.
 */
export function procedureAdmission(id: string, artifact: ContractArtifact, options: AdmissionOptions, problems: string[]): ProcedureAdmission | null {
	const rules: ProcedureArtifact | undefined = artifact.procedures !== undefined && Object.hasOwn(artifact.procedures, id)
		? artifact.procedures[id]
		: undefined
	if (rules === undefined) {
		return DEFAULT_ADMISSION
	}
	let challenge: ChallengeVerifier | null = null
	if (rules.challenge !== null) {
		const secret = options.application[rules.challenge.secret]
		if (typeof secret !== 'string' || secret.trim() === '') {
			problems.push(
				`procedure '${id}' verifies its ${rules.challenge.provider} challenge with the application variable ${rules.challenge.secret}, which is not set`,
			)
			return null
		}
		challenge = turnstileVerifier(secret.trim(), options.challengeFetch ?? ((request) => fetch(request)))
	}
	return Object.freeze({
		rate: rules.rate,
		challenge,
		repeatableToken: challenge === null ? null : (options.repeatableChallengeToken ?? null),
		timeoutMs: rules.timeoutMs,
	})
}

/** The buckets a request takes from, in order: its client's or its caller's first, then the endpoint's. */
export function bucketsOf(rate: AdmissionRate, request: Request, caller: string | null): { readonly bucket: string; readonly limit: number }[] {
	const buckets: { readonly bucket: string; readonly limit: number }[] = []
	if (rate.perClient !== null) {
		buckets.push({ bucket: clientBucket(request), limit: rate.perClient })
	}
	if (rate.perCaller !== null && caller !== null) {
		buckets.push({ bucket: `caller:${createHash('sha256').update(caller).digest('hex')}`, limit: rate.perCaller })
	}
	if (rate.perEndpoint !== null) {
		buckets.push({ bucket: ENDPOINT_BUCKET, limit: rate.perEndpoint })
	}
	return buckets
}

/**
 * Who sent the request, as the proxy saw it. The address is `X-Fabrika-Client-Ip`, which only the proxy sets, and only
 * where the runtime adapter vouches that the proxy saw the visitor (`vouched`); behind a balancer whose range the
 * platform does not trust it is `null`. Anything that is no IP address is `null` too.
 */
export function requestClient(request: Request, vouched: boolean): RequestClient {
	const address = vouched ? request.headers.get(CLIENT_ADDRESS_HEADER)?.trim() ?? '' : ''
	const agent = request.headers.get('User-Agent')
	return Object.freeze({
		ip: address === '' || clientKey(address) === 'unknown' ? null : address,
		userAgent: agent === null || agent === '' ? null : agent.slice(0, MAX_USER_AGENT_LENGTH),
	})
}

/**
 * At most `limit` requests at once, beyond which the next is refused: the share of the connection pool all public
 * procedures of an instance hold together, so a flood of anonymous calls leaves signed-in staff the rest.
 */
export class InFlightShare {
	readonly #limit: number
	#held = 0

	constructor(limit: number) {
		this.#limit = limit
	}

	/** A release to call once the request is answered, or `null` when the share is full. */
	enter(): (() => void) | null {
		if (this.#held >= this.#limit) {
			return null
		}
		this.#held++
		let released = false
		return () => {
			if (!released) {
				released = true
				this.#held--
			}
		}
	}
}

/** A quarter of the pool, at least one connection. */
export function publicShareOf(connections: number): number {
	return Math.max(1, Math.floor(connections / 4))
}
