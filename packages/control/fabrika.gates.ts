// The per-path gates the control plane's PUBLIC surface is fronted by — the proxy manifest, verbatim.
//
// They are not enforced here and not enforced by the application either: since ADR-0007 the proxy is
// the only enforcement point, and it reads this list from its manifest in declaration order. See
// `examples/zerops-app/fabrika.gates.ts` for the semantics (order is precedence, an absent credential
// falls through, a present one is terminal, no match denies).
//
// **This module must stay free of `@fabrika/provider-cloudflare` AND of the rest of this package.**
// It used to live inside `fabrika.config.ts`, which imports the provider, so the local stack could not
// import it and kept a hand-maintained copy pinned by a test instead. It must also not reach `src/`:
// this package relaxes `noUncheckedIndexedAccess` for oblaka's sake, so pulling its runtime graph into
// a strict consumer's program fails to compile. One type-only contract import and nothing else.

import type { AppGates } from '@fabrika/auth-core'

/**
 * The control surface's default pair: `/api/*` admits a machine `px_` key or a logged-in human. The
 * source connection browser routes override it with earlier human-only rules.
 */
const CONTROL_GATES: AppGates = {
	rules: [
		{ path: '/api/*', kind: 'service' },
		{ path: '/api/*', kind: 'human' },
	],
}

export const CONTROL_PROXY_GATES: AppGates = {
	rules: [
		{ path: '/healthz', kind: 'public' },
		{ path: '/api/health', kind: 'public' },
		{ path: '/webhooks/github', kind: 'public' },
		{ path: '/webhooks/github/*', kind: 'public' },
		{ path: '/iam/admin', kind: 'service' },
		{ path: '/iam/admin', kind: 'human' },
		{ path: '/iam/admin/*', kind: 'service' },
		{ path: '/iam/admin/*', kind: 'human' },
		{ path: '/operations/api', kind: 'service' },
		{ path: '/operations/api', kind: 'human' },
		{ path: '/operations/api/*', kind: 'service' },
		{ path: '/operations/api/*', kind: 'human' },
		{ path: '/api/source/github/manifest/*', kind: 'human' },
		{ path: '/api/source/github/callback', kind: 'human' },
		...CONTROL_GATES.rules,
		{ path: '/*', kind: 'human' },
	],
}
