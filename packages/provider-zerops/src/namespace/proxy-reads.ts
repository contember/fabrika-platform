// What a namespace proxy pinned to an older source cannot read. Its manifest parser is strict: one row of a form it does
// not know refuses the whole manifest, and every member of the namespace loses its proxy at the next republish. So a
// deploy that would publish such a row is refused while the namespace's proxy source is not this control plane's own.

import type { ProviderApprovedAccess } from '@fabrika/provider-contract'
import { contractProxyTable, type ProxyEndpointRow } from '@fabrika/proxy-core/manifest'
import type { ZeropsNamespaceProxySource } from './types'

/** Whether the namespace proxy of one older platform release parses a manifest row: that release's own row parser. */
export type OlderProxyRowReader = (row: ProxyEndpointRow) => boolean

/**
 * The namespace proxies of the older releases this platform serves (ADR-0062). Control holds their parsers, as it holds
 * their contract readers; a pin's release is not recorded, so a row any of them reads is one the pin may read.
 */
export type OlderProxyRowReaders = readonly [OlderProxyRowReader, ...OlderProxyRowReader[]]

/** The rows of the approved contract's proxy table that no older release's proxy parses, as the namespace publishes them. */
export function rowsNeedingCurrentProxy(access: ProviderApprovedAccess, olderProxies: OlderProxyRowReaders): string[] {
	return contractProxyTable(access.contract, access.contractDigest).endpoints
		.filter((row) => !olderProxies.some((reads) => reads(row)))
		.map((row) => row.id)
}

/** This control plane's own proxy source, and the parsers of the older releases a pinned proxy may run. */
export interface PlatformProxies {
	readonly proxySource: ZeropsNamespaceProxySource
	readonly olderProxies: OlderProxyRowReaders
}

/**
 * Refuses a deploy whose approved contract holds a row the namespace's pinned proxy may not read: its source is not the
 * one this control plane deploys new placements from. `platform` is absent where this control plane manages no
 * namespace proxy, which then has nothing to compare.
 */
export function assertNamespaceProxyReads(
	namespace: string,
	access: ProviderApprovedAccess | undefined,
	pinned: ZeropsNamespaceProxySource,
	platform: PlatformProxies | undefined,
): void {
	if (access === undefined || platform === undefined || pinned.commitSha === platform.proxySource.commitSha) {
		return
	}
	const rows = rowsNeedingCurrentProxy(access, platform.olderProxies)
	if (rows.length === 0) {
		return
	}
	throw new Error(
		`the proxy of deployment namespace \`${namespace}\` is pinned to an older source than this platform's, and no older release's proxy reads ${
			rows.map((row) => `\`${row}\``).join(', ')
		}; re-pin it with \`fabrika control namespaces update --namespace=${namespace} --proxy-source=current\`, then deploy again`,
	)
}
