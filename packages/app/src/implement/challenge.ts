// A form's challenge, verified on the server before its row is written. The provider list is closed: Turnstile's
// siteverify is the only endpoint the framework asks, with the secret from the application variable the contract
// names; an ALTCHA challenge the application issues and verifies itself, with the HMAC key that variable holds, and asks
// no one. A token verifies only for this host and this form's action, while it is fresh; the dispatcher then records
// it, so its second use is a replay whatever the provider says.

import type { AltchaChallenge, ChallengeProvider } from '@fabrika/auth-core'
import { createChallenge, randomInt, verifySolution } from 'altcha-lib'
import { deriveKey } from 'altcha-lib/algorithms/web/pbkdf2'
import { createHmac } from 'node:crypto'
import { z } from 'zod/v4'
import { ALTCHA_LIMITS } from '../contract/defaults'
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

/**
 * A verification's answer. A passed one names what the dispatcher records it by: the token itself, or, for ALTCHA, the
 * signature of the challenge it solved, since one solution can be encoded as many tokens. Its record lasts at least
 * as long as this token could pass again, even if the issuer's configured lifetime has since changed.
 */
export type ChallengeVerdict =
	| { readonly outcome: 'passed'; readonly replayKey: string; readonly recordMs: number }
	| { readonly outcome: Exclude<ChallengeOutcome, 'passed'> }

export interface ChallengeVerifier {
	readonly provider: ChallengeProvider
	verify(check: ChallengeCheck): Promise<ChallengeVerdict>
}

const verdictOf = (outcome: ChallengeOutcome, replayKey: string, recordMs: number): ChallengeVerdict =>
	outcome === 'passed' ? { outcome, replayKey, recordMs } : { outcome }

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
		async verify(check: ChallengeCheck): Promise<ChallengeVerdict> {
			return verdictOf(await siteverify(secret, fetch, now, check), check.token, CHALLENGE_LIMITS.maxAgeMs + CHALLENGE_LIMITS.maxSkewMs)
		},
	}
	return Object.freeze(verifier)
}

/** Turnstile's answer for `check`, under one deadline and a byte budget. */
async function siteverify(secret: string, fetch: ChallengeFetch, now: () => number, check: ChallengeCheck): Promise<ChallengeOutcome> {
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
}

function parseAnswer(raw: Uint8Array<ArrayBuffer>): z.infer<typeof siteverifyAnswer> | null {
	try {
		const parsed = siteverifyAnswer.safeParse(JSON.parse(new TextDecoder().decode(raw)))
		return parsed.success ? parsed.data : null
	} catch {
		return null
	}
}

/**
 * How hard an ALTCHA challenge is to solve: PBKDF2 attempts of `cost` iterations, up to a count drawn between
 * `minCounter` and `maxCounter`. The contract's by default; a test kit and `fabrika app dev` make it cheap.
 */
export interface ChallengeWork {
	readonly cost: number
	readonly minCounter: number
	readonly maxCounter: number
}

/** The cheapest work: the test kit's and `fabrika app dev`'s, so a test solves a challenge in milliseconds. */
export const MINIMAL_CHALLENGE_WORK: ChallengeWork = Object.freeze({ cost: 1, minCounter: 1, maxCounter: 10 })

/** What the issuing endpoint answers: the signed parameters, which the widget solves and sends back with its solution. */
export interface IssuedChallenge {
	readonly parameters: Readonly<Record<string, unknown>>
	readonly signature?: string
}

export interface ChallengeIssuer {
	/** A fresh challenge for this host and the procedure's action. */
	issue(hostname: string): Promise<IssuedChallenge>
}

const HEX = /^[0-9a-f]+$/
const hex = (length: number) => z.string().length(length).regex(HEX)

// Strict: exactly what `issue` signs, so a payload of another shape (the widget's `test` mode, a server-signed one) never
// reaches the verification.
const altchaPayload = z.strictObject({
	challenge: z.strictObject({
		parameters: z.strictObject({
			algorithm: z.literal(ALTCHA_LIMITS.algorithm),
			nonce: hex(32),
			salt: hex(32),
			cost: z.int().positive(),
			keyLength: z.literal(32),
			keyPrefix: hex(32),
			keySignature: hex(64),
			expiresAt: z.int().positive(),
			data: z.strictObject({ action: z.string(), host: z.string() }),
		}),
		signature: hex(64),
	}),
	solution: z.strictObject({ counter: z.int().nonnegative(), derivedKey: hex(64), time: z.number().nonnegative().optional() }),
})

type AltchaPayload = z.infer<typeof altchaPayload>

/** A payload as the widget sends it: base64 of its JSON, within the bound. */
const PAYLOAD = new RegExp(`^[A-Za-z0-9+/]{1,${ALTCHA_LIMITS.maxTokenLength}}={0,2}$`)

/**
 * The two HMAC keys of an ALTCHA challenge, each derived from the application's key for one use: one signs the
 * parameters, the other the solution the server knows, so neither signature can stand in for the other.
 */
function altchaKeys(secret: string): { readonly signature: string; readonly key: string } {
	const derive = (use: string) => createHmac('sha256', secret).update(`fabrika-altcha-${use}`).digest('hex')
	return { signature: derive('challenge'), key: derive('solution') }
}

function parsePayload(token: string): AltchaPayload | null {
	if (token.length > ALTCHA_LIMITS.maxTokenLength || !PAYLOAD.test(token)) {
		return null
	}
	try {
		const parsed = altchaPayload.safeParse(JSON.parse(atob(token)))
		return parsed.success ? parsed.data : null
	} catch {
		return null
	}
}

/**
 * The issuer and the verifier of one public procedure's ALTCHA challenge, with the HMAC key its application variable
 * holds. A challenge carries the action and the host it was issued for and expires `maxAgeMs` after it was issued; the
 * server picks the attempt that solves it and signs that attempt's key, so verifying is two HMACs and no proof of work.
 * Nothing leaves the process. `now` is the clock a challenge's expiry is set with; altcha-lib reads it on the real clock,
 * and so does the verifier, so the two never disagree.
 */
export function altchaChallenge(
	secret: string,
	rules: Pick<AltchaChallenge, 'action' | 'cost' | 'maxAgeMs'>,
	work: ChallengeWork | null = null,
	now: () => number = Date.now,
): { readonly issuer: ChallengeIssuer; readonly verifier: ChallengeVerifier } {
	const keys = altchaKeys(secret)
	const effort = work ?? { cost: rules.cost, minCounter: ALTCHA_LIMITS.minCounter, maxCounter: ALTCHA_LIMITS.maxCounter }
	const issuer: ChallengeIssuer = {
		async issue(hostname: string): Promise<IssuedChallenge> {
			const challenge = await createChallenge({
				algorithm: ALTCHA_LIMITS.algorithm,
				cost: effort.cost,
				counter: randomInt(effort.maxCounter, effort.minCounter),
				expiresAt: Math.floor((now() + rules.maxAgeMs) / 1000),
				data: { action: rules.action, host: hostname },
				deriveKey,
				hmacSignatureSecret: keys.signature,
				hmacKeySignatureSecret: keys.key,
			})
			return { parameters: { ...challenge.parameters }, ...(challenge.signature === undefined ? {} : { signature: challenge.signature }) }
		},
	}
	const verifier: ChallengeVerifier = {
		provider: 'altcha',
		async verify(check: ChallengeCheck): Promise<ChallengeVerdict> {
			const payload = parsePayload(check.token)
			if (payload === null) {
				return { outcome: 'failed' }
			}
			const { parameters } = payload.challenge
			// The signature covers these; they are read before it only to answer without the HMAC.
			if (parameters.data.action !== check.action || parameters.data.host !== check.hostname || parameters.expiresAt * 1000 < Date.now()) {
				return { outcome: 'failed' }
			}
			try {
				const result = await verifySolution({
					challenge: payload.challenge,
					solution: payload.solution,
					deriveKey,
					hmacSignatureSecret: keys.signature,
					hmacKeySignatureSecret: keys.key,
				})
				// A previous deployment may have issued longer-lived challenges with this same key.
				const recordMs = Math.max(0, parameters.expiresAt * 1000 - Date.now()) + CHALLENGE_LIMITS.maxSkewMs
				return verdictOf(result.verified ? 'passed' : 'failed', payload.challenge.signature, recordMs)
			} catch {
				return { outcome: 'failed' }
			}
		},
	}
	return Object.freeze({ issuer: Object.freeze(issuer), verifier: Object.freeze(verifier) })
}
