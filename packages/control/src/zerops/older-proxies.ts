import type { OlderProxyRowReaders } from '@fabrika/provider-zerops'
import { proxyEndpointRowSchema as proxyEndpointRowSchema04 } from '@fabrika/proxy-core-0.4/manifest'
import { proxyEndpointRowSchema as proxyEndpointRowSchema05 } from '@fabrika/proxy-core-0.5/manifest'

/**
 * The strict row parsers of the namespace proxies a Zerops namespace pinned to an older release runs (ADR-0062): the
 * newest patch of each framework minor in the support window, the same releases `approval/formats.ts` reads.
 */
export const OLDER_PROXY_ROW_READERS: OlderProxyRowReaders = [
	(row) => proxyEndpointRowSchema04.safeParse(row).success,
	(row) => proxyEndpointRowSchema05.safeParse(row).success,
]
