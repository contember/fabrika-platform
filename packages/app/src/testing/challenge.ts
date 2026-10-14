// A stand-in for a form challenge's provider, for a test kit and for `fabrika app dev`.

import type { ChallengeFetch } from '../implement/challenge'

/** Turnstile's siteverify that passes every token: a fresh answer for the host and the form the check expects. */
export const passingChallenge: ChallengeFetch = (_request, check) =>
	Promise.resolve(Response.json({ success: true, challenge_ts: new Date().toISOString(), hostname: check.hostname, action: check.action }))
