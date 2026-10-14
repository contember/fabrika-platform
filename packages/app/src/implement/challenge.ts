// A form's challenge, verified on the server before its row is written. The provider list is closed: Turnstile's
// siteverify is the only endpoint the framework asks, with the secret from the application variable the contract
// names. A token verifies only for this host and this form's action, while it is fresh; the dispatcher then records
// it, so its second use is a replay whatever the provider says.

import type { ChallengeProvider } from '@fabrika/auth-core'
import { z } from 'zod/v4'
import { readBoundedBytes } from './bounded'

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

export const CHALLENGE_LIMITS = {
	/** The provider's answer, the body read included. */
	timeoutMs: 5000,
	maxAnswerBytes: 16 * 1024,
	/** Turnstile's tokens are at most 2048 characters. */
	maxTokenLength: 2048,
	/** A token is valid for 300 s after the widget issued it; a recorded one is kept as long, plus the skew. */
	maxAgeMs: 300_000,
	maxSkewMs: 60_000,
} as const

/**
 * How the siteverify request reaches the provider. `check` is what a passing answer confirms (the host and the form),
 * for a stand-in that answers as the provider would; the provider itself reads only the request.
 */
export type ChallengeFetch = (request: Request, check: ChallengeCheck) => Promise<Response>

/** `failed` is the visitor's (400); `unavailable` and `misconfigured` are the platform's or the operator's (503). */
export type ChallengeOutcome = 'passed' | 'failed' | 'unavailable' | 'misconfigured'

export interface ChallengeCheck {
	readonly token: string
	/** The host the form was submitted to: the page the widget ran on must be on it. */
	readonly hostname: string
	/** The form's name, which its widget renders as `action`. */
	readonly action: string
}

export interface ChallengeVerifier {
	readonly provider: ChallengeProvider
	verify(check: ChallengeCheck): Promise<ChallengeOutcome>
}

/** A token as the widget issues it: printable ASCII without spaces, within the provider's length. */
const TOKEN = new RegExp(`^[\\x21-\\x7e]{1,${CHALLENGE_LIMITS.maxTokenLength}}$`)

// Not strict: siteverify adds fields (`cdata`, `metadata`) the decision does not read.
const siteverifyAnswer = z.object({
	success: z.boolean(),
	'error-codes': z.array(z.string()).optional(),
	challenge_ts: z.string().optional(),
	hostname: z.string().optional(),
	action: z.string().optional(),
})

/** Error codes that say the secret, not the visitor's token, is wrong. */
const SECRET_ERRORS = ['missing-input-secret', 'invalid-input-secret']

/** Turnstile's siteverify under one deadline and a byte budget; `now` is the clock a token's age is read with. */
export function turnstileVerifier(secret: string, fetch: ChallengeFetch, now: () => number = Date.now): ChallengeVerifier {
	const verifier: ChallengeVerifier = {
		provider: 'turnstile',
		async verify(check: ChallengeCheck): Promise<ChallengeOutcome> {
			if (!TOKEN.test(check.token)) {
				return 'failed'
			}
			const deadline = new AbortController()
			const timer = setTimeout(() => deadline.abort(), CHALLENGE_LIMITS.timeoutMs)
			let raw: Uint8Array<ArrayBuffer> | null
			try {
				const response = await fetch(
					new Request(TURNSTILE_VERIFY_URL, {
						method: 'POST',
						headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
						body: new URLSearchParams({ secret, response: check.token }),
						redirect: 'manual',
						signal: deadline.signal,
					}),
					check,
				)
				const type = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase()
				if (response.status !== 200 || type !== 'application/json') {
					await response.body?.cancel()
					return 'unavailable'
				}
				raw = await readBoundedBytes(response.body, { maxBytes: CHALLENGE_LIMITS.maxAnswerBytes, signal: deadline.signal })
			} catch {
				return 'unavailable'
			} finally {
				clearTimeout(timer)
			}
			const answer = raw === null ? null : parseAnswer(raw)
			if (answer === null) {
				return 'unavailable'
			}
			if (!answer.success) {
				const codes = answer['error-codes'] ?? []
				if (codes.some((code) => SECRET_ERRORS.includes(code))) {
					return 'misconfigured'
				}
				return codes.includes('internal-error') ? 'unavailable' : 'failed'
			}
			const issued = Date.parse(answer.challenge_ts ?? '')
			const age = now() - issued
			const fresh = Number.isFinite(issued) && age <= CHALLENGE_LIMITS.maxAgeMs && age >= -CHALLENGE_LIMITS.maxSkewMs
			return fresh && answer.hostname === check.hostname && answer.action === check.action ? 'passed' : 'failed'
		},
	}
	return Object.freeze(verifier)
}

function parseAnswer(raw: Uint8Array<ArrayBuffer>): z.infer<typeof siteverifyAnswer> | null {
	try {
		const parsed = siteverifyAnswer.safeParse(JSON.parse(new TextDecoder().decode(raw)))
		return parsed.success ? parsed.data : null
	} catch {
		return null
	}
}
