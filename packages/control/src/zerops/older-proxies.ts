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
import {
	contractProxyAppSchema as contractProxyAppSchema07,
	proxyEndpointRowSchema as proxyEndpointRowSchema07,
} from '@fabrika/proxy-core-0.7/manifest'

/**
 * The strict manifest parsers of the namespace proxies a Zerops namespace pinned to an older release runs (ADR-0062): the
 * newest patch of each framework minor in the support window, the same releases `approval/formats.ts` reads. Each judges
 * a row with its row parser and an entry's CSP with the CSP field of its entry parser.
 */
export const OLDER_PROXY_READERS: OlderProxyReaders = [
	{
		row: (row) => proxyEndpointRowSchema04.safeParse(row).success,
		csp: (csp) => contractProxyAppSchema04.innerType().shape.csp.safeParse(csp).success,
	},
	{
		row: (row) => proxyEndpointRowSchema05.safeParse(row).success,
		csp: (csp) => contractProxyAppSchema05.innerType().shape.csp.safeParse(csp).success,
	},
	{
		row: (row) => proxyEndpointRowSchema06.safeParse(row).success,
		csp: (csp) => contractProxyAppSchema06.innerType().shape.csp.safeParse(csp).success,
	},
	{
		row: (row) => proxyEndpointRowSchema07.safeParse(row).success,
		csp: (csp) => contractProxyAppSchema07.innerType().shape.csp.safeParse(csp).success,
	},
]
