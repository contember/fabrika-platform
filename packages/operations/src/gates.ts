// The per-path gates the Operations service's PUBLIC surface is fronted by — the proxy manifest,
// verbatim. Not enforced here and not enforced by the application: since ADR-0007 the proxy is the
// only enforcement point, and it reads this list from its manifest in declaration order.
//
// **This module must stay free of `@fabrika/provider-cloudflare` AND of the rest of this package.**
// It used to live inside `fabrika.config.ts`, which imports the provider, so the local stack could not
// import it and kept a hand-maintained copy pinned by a test instead. It must also not reach `app.ts`:
// this package relaxes `noUncheckedIndexedAccess` for oblaka's sake, so pulling its runtime graph into
// a strict consumer's program fails to compile. Two type-only contract imports and nothing else.

import type { AppGates } from '@fabrika/auth-core'
import { OPERATIONS_RELEASE_RECONCILE_PATH, OPERATIONS_SOURCE_MAP_UPLOAD_PATH } from '@fabrika/operations-contract'

/**
 * The operator surface's own pair: every `/api/*` route admits EITHER a machine `px_` key OR a
 * logged-in human, two precedence-ordered rules sharing one glob. Kept separate from the public rules
 * below because it is the part that describes the APPLICATION rather than the ingest edge.
 */
const OPERATOR_GATES: AppGates = {
	rules: [
		{ path: '/api/*', kind: 'service' },
		{ path: '/api/*', kind: 'human' },
	],
}

export const OPERATIONS_PROXY_GATES: AppGates = {
	rules: [
		{ path: '/healthz', kind: 'public' },
		{ path: '/api/*/envelope/', kind: 'public' },
		{ path: OPERATIONS_SOURCE_MAP_UPLOAD_PATH, kind: 'public' },
		{ path: '/private/catalog/reconcile', kind: 'service' },
		{ path: OPERATIONS_RELEASE_RECONCILE_PATH, kind: 'service' },
		...OPERATOR_GATES.rules,
	],
}
