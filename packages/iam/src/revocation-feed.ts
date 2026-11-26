// The proxy's revocation feed (`IamRevocationRpc`, ADR-0022): which subjects lost something since the proxy's last
// read. Shared layer: no runtime import.

import { REVOCATION_FEED_MAX_SUBJECTS, REVOCATION_FEED_WINDOW_SECONDS, type RevocationsInput, type RevocationsResult } from '@fabrika/auth-core'
import { unixNow } from './repositories/sql'
import type { Services } from './services'

/**
 * The revocations at or after `since`, held to the window: nothing older can end a token still in a cache. More than
 * `REVOCATION_FEED_MAX_SUBJECTS` answers `complete: false` with the newest, and the proxy then drops every cached token.
 */
export async function revocations(services: Services, input: RevocationsInput): Promise<RevocationsResult> {
	const now = unixNow()
	const floor = now - REVOCATION_FEED_WINDOW_SECONDS
	const since = input.since === null ? floor : Math.min(now, Math.max(floor, Math.floor(input.since)))
	const subjects = await services.repositories.revocations.since(since, REVOCATION_FEED_MAX_SUBJECTS + 1)
	const complete = subjects.length <= REVOCATION_FEED_MAX_SUBJECTS
	return { ok: true, now, complete, subjects: complete ? subjects : subjects.slice(0, REVOCATION_FEED_MAX_SUBJECTS) }
}
