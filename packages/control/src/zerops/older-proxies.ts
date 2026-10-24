import type { OlderProxyReaders } from '@fabrika/provider-zerops'
import {
	contractProxyAppSchema as contractProxyAppSchema04,
	proxyEndpointRowSchema as proxyEndpointRowSchema04,
} from '@fabrika/proxy-core-0.4/manifest'
import {
	contractProxyAppSchema as contractProxyAppSchema05,
	proxyEndpointRowSchema as proxyEndpointRowSchema05,
} from '@fabrika/proxy-core-0.5/manifest'
import {
	contractProxyAppSchema as contractProxyAppSchema06,
	proxyEndpointRowSchema as proxyEndpointRowSchema06,
} from '@fabrika/proxy-core-0.6/manifest'

/**
 * The strict manifest parsers of the namespace proxies a Zerops namespace pinned to an older release runs (ADR-0062): the
 * newest patch of 0.4, 0.5 and 0.6. Each judges a row with its row parser and an entry's CSP with the CSP field of its
 * entry parser. 0.7.0's is not one: a pin's release is not recorded, so a form only 0.7 reads would pass for a namespace
 * pinned to 0.4–0.6, whose parser then refuses the whole manifest. None of them serves the terminal sign-out
 * (ADR-0067 §5), so each is listed with `signsOut: false`.
 */
export const OLDER_PROXY_READERS: OlderProxyReaders = [
	{
		row: (row) => proxyEndpointRowSchema04.safeParse(row).success,
		csp: (csp) => contractProxyAppSchema04.innerType().shape.csp.safeParse(csp).success,
		signsOut: false,
	},
	{
		row: (row) => proxyEndpointRowSchema05.safeParse(row).success,
		csp: (csp) => contractProxyAppSchema05.innerType().shape.csp.safeParse(csp).success,
		signsOut: false,
	},
	{
		row: (row) => proxyEndpointRowSchema06.safeParse(row).success,
		csp: (csp) => contractProxyAppSchema06.innerType().shape.csp.safeParse(csp).success,
		signsOut: false,
	},
]
