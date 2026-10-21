// A stand-in for a form challenge's provider, for a test kit and for `fabrika app dev`; and the solver of an ALTCHA
// challenge, which needs no stand-in: the application issues and verifies it itself.

import { type Challenge, solveChallenge } from 'altcha-lib'
import { deriveKey } from 'altcha-lib/algorithms/web/pbkdf2'
import { z } from 'zod/v4'
import type { RpcFetch } from '../client/transport'
import type { ChallengeFetch } from '../implement/challenge'

/** The token Turnstile's always-passing test widget (site key `1x00000000000000000000AA`) hands out every time. */
export const TURNSTILE_TEST_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX'

/** Turnstile's siteverify that passes every token: a fresh answer for the host and the form the check expects. */
export const passingChallenge: ChallengeFetch = (_request, check) =>
	Promise.resolve(Response.json({ success: true, challenge_ts: new Date().toISOString(), hostname: check.hostname, action: check.action }))

// Read as loosely as the widget reads it: the verification is what holds a challenge to its shape.
const issuedChallenge = z.object({
	parameters: z.object({ algorithm: z.string(), nonce: z.string(), salt: z.string(), cost: z.number(), keyLength: z.number(), keyPrefix: z.string() })
		.catchall(z.unknown()),
	signature: z.string().optional(),
})

/**
 * Fetches a challenge from `url` through `fetch` and solves it as the widget does, answering the payload the page puts
 * into `challengeToken`. The kit issues the cheapest challenge, so this takes milliseconds.
 */
export async function solveChallengeAt(fetch: RpcFetch, url: string): Promise<string> {
	const response = await fetch(url, { headers: { Accept: 'application/json' } })
	if (response.status !== 200) {
		throw new Error(`the challenge at ${url} answered ${response.status}: ${await response.text()}`)
	}
	const parsed = issuedChallenge.safeParse(await response.json())
	if (!parsed.success) {
		throw new Error(`the challenge at ${url} is no ALTCHA challenge`)
	}
	const { parameters, signature } = parsed.data
	const challenge: Challenge = { parameters: { ...parameters }, ...(signature === undefined ? {} : { signature }) }
	const solution = await solveChallenge({ challenge, deriveKey, timeout: 10_000 })
	if (solution === null) {
		throw new Error(`the challenge at ${url} was not solved in time`)
	}
	return btoa(JSON.stringify({ challenge, solution }))
}
