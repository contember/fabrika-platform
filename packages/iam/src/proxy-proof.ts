/**
 * Whether a request proves it came through the platform proxy, which decides if IAM may read the client-address and
 * request-id headers the composition names (`src/client-address.ts`, `src/request-id.ts`).
 *
 * On Zerops IAM is not publicly routed, but anything on the platform project's private network can reach its port and
 * write both headers. So the proxy sends a per-installation secret in `PROXY_SECRET_HEADER` on IAM's route, and a
 * request without it is attributed to nobody. This is attribution, not an enforcement decision (ADR-0022): a missing
 * proof is never a refusal by itself, though the one bucket all such requests share refuses once exhausted.
 */

import { PROXY_SECRET_HEADER } from '@fabrika/auth-core'
import { hashToken, timingSafeEqualHex } from './secret'

/**
 * The client coordinate every request without the proof shares. One bucket for all of them: a caller that cannot prove
 * the proxy sent it cannot pick a fresh bucket per attempt, and the proxy's own requests never land here.
 */
export const UNPROVEN_CLIENT_ADDRESS = 'unproven-caller'

/** Resolves true when the request may be attributed by the composition's headers. */
export type ProxyProof = (request: Request) => Promise<boolean>

/**
 * The proof check for a configured secret. An empty secret means the composition checks nothing, and every request is
 * read as it arrives — the Worker root, and an installation before the deploy that writes the secret.
 */
export function proxyProof(secret: string): ProxyProof {
	if (secret === '') {
		return () => Promise.resolve(true)
	}
	const expected = hashToken(secret)
	return async (request) => {
		const presented = request.headers.get(PROXY_SECRET_HEADER) ?? ''
		return presented !== '' && timingSafeEqualHex(await hashToken(presented), await expected)
	}
}
