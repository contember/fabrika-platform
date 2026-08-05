// The per-path gates the Operations service's PUBLIC hostname is fronted by — the proxy manifest,
// verbatim. Not enforced here and not enforced by the application: since ADR-0007 the proxy is the
// only enforcement point, and it reads this list from its manifest in declaration order.
//
// **This module must stay free of `@fabrika/provider-cloudflare` AND of the rest of this package.**
// It used to live inside `fabrika.config.ts`, which imports the provider, so the local stack could not
// import it and kept a hand-maintained copy pinned by a test instead. It must also not reach `app.ts`:
// this package relaxes `noUncheckedIndexedAccess` for oblaka's sake, so pulling its runtime graph into
// a strict consumer's program fails to compile. Two contract imports and nothing else.

import type { AppGates } from '@fabrika/auth-core'
import { OPERATIONS_SOURCE_MAP_UPLOAD_PATH } from '@fabrika/operations-contract'

/**
 * Two rules, because the public hostname serves two routes.
 *
 * Every other route Operations declares — `/healthz`, `/private/*` reconciliation and the whole
 * `/api/*` operator surface — is answered with a 404 on this host by `app.ts`'s `isPublicIngress`
 * guard, and reached instead over the private network (`FABRIKA_OPERATIONS_URL` / the `OPERATIONS`
 * service binding). A rule for one of them described a route no request could ever reach through this
 * proxy, which reads as though the surface is served and gated when it is neither; with no rule they
 * are denied here outright (`no_rule` → 403) rather than admitted into a 404.
 *
 * Both remaining rules are `public` because both carry their OWN credential, checked by Operations
 * after the proxy admits them: ingest verifies the source's Sentry key, and the source-map upload
 * verifies the release's upload credential.
 */
export const OPERATIONS_PROXY_GATES: AppGates = {
	rules: [
		{ path: '/api/*/envelope/', kind: 'public' },
		{ path: OPERATIONS_SOURCE_MAP_UPLOAD_PATH, kind: 'public' },
	],
}
