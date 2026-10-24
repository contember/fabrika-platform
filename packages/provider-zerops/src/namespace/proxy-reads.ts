// What a namespace proxy pinned to an older source cannot read or serve. Its manifest parser is strict: one row of a form
// it does not know, or a CSP directive it does not know, refuses the whole manifest and blocks the namespace's next
// republish; and it has no terminal sign-out. So a deploy that would publish either, or a terminal, is refused before
// publication while the namespace's proxy source is not this control plane's own.

import type { ProviderApprovedAccess } from '@fabrika/provider-contract'
import type { CspOrigins } from '@fabrika/proxy-core/headers'
import { contractProxyTable, type ProxyEndpointRow } from '@fabrika/proxy-core/manifest'
import type { ZeropsNamespaceProxySource } from './types'

/**
 * What the namespace proxy of one older platform release parses of an application's manifest entry: a row, and the
 * entry's CSP directives, each by that release's own parser; and whether it serves the sign-out (ADR-0067 §5).
 */
export interface OlderProxyReader {
	readonly row: (row: ProxyEndpointRow) => boolean
	readonly csp: (csp: CspOrigins) => boolean
	readonly signsOut: boolean
}

/**
 * The namespace proxies of the older releases a pin may run whose parsers Control holds (ADR-0062). A pin's release is not
 * recorded, so what any of them reads is what the pin may read.
 */
export type OlderProxyReaders = readonly [OlderProxyReader, ...OlderProxyReader[]]

/**
 * What of the approved contract's manifest entry no older release's proxy parses, as the namespace publishes it: each
 * such row by its id, and `csp` when no older proxy parses the entry's CSP (`workerSrc`, which only this release knows).
 * A contract that declares a terminal adds `terminal` when no older proxy serves the sign-out its sessions end at
 * (ADR-0067 §5).
 */
export function entriesNeedingCurrentProxy(access: ProviderApprovedAccess, olderProxies: OlderProxyReaders): string[] {
	const table = contractProxyTable(access.contract, access.contractDigest)
	const rows = table.endpoints.filter((row) => !olderProxies.some((proxy) => proxy.row(row))).map((row) => row.id)
	const csp = olderProxies.some((proxy) => proxy.csp(table.csp)) ? [] : ['csp']
	const terminal = access.contract.terminal === undefined || olderProxies.some((proxy) => proxy.signsOut) ? [] : ['terminal']
	return [...rows, ...csp, ...terminal]
}

/** This control plane's own proxy source, and the parsers of the older releases a pinned proxy may run. */
export interface PlatformProxies {
	readonly proxySource: ZeropsNamespaceProxySource
	readonly olderProxies: OlderProxyReaders
}

/**
 * Refuses a deploy whose approved contract holds a row or a CSP directive the namespace's pinned proxy may not read: its source is not the
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
	const rows = entriesNeedingCurrentProxy(access, platform.olderProxies)
	if (rows.length === 0) {
		return
	}
	throw new Error(
		`the proxy of deployment namespace \`${namespace}\` is pinned to an older source than this platform's, and no older release's proxy reads or serves ${
			rows.map((row) => `\`${row}\``).join(', ')
		}; re-pin it with \`fabrika control namespaces update --namespace=${namespace} --proxy-source=current\`, then deploy again`,
	)
}
