// The one response header policy of a contract application (ADR-0022, "Response headers"). The framework sets it on
// every response it answers, denials included; the proxy sets the same definition, from `@fabrika/proxy-core/headers`.

import type { CspExtensions } from '@fabrika/auth-core'
import { applyHeaderPolicy, cspOrigins, type HeaderPolicy, headerPolicy, withResponseHeaders } from '@fabrika/proxy-core/headers'

export type { HeaderPolicy }

/** The policy of an application: its contract's named origins and the Operations ingest origin the browser reports to. */
export function applicationPolicy(csp: CspExtensions, operationsOrigin: string | null): HeaderPolicy {
	return headerPolicy(cspOrigins(csp), operationsOrigin)
}

/** A copy of `response` carrying the policy; whatever the handler or an asset server set for these names is replaced. */
export function withHeaderPolicy(response: Response, policy: HeaderPolicy): Response {
	return withResponseHeaders(response, (headers) => applyHeaderPolicy(headers, policy))
}
