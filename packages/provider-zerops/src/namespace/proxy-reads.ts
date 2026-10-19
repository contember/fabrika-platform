// What a namespace proxy pinned to an older source cannot read. Its manifest parser is strict: one row of a form it does
// not know refuses the whole manifest, and every member of the namespace loses its proxy at the next republish. So a
// deploy that would publish such a row is refused while the namespace's proxy source is not this control plane's own.

import type { ContractArtifact } from '@fabrika/auth-core'
import type { ZeropsNamespaceProxySource } from './types'

/** The rows only a proxy of this platform's own source reads: a public procedure, and an endpoint of several capabilities. */
export function rowsNeedingCurrentProxy(contract: ContractArtifact): string[] {
	return contract.endpoints.filter((row) => row.kind === 'public' || row.requirement?.kind === 'capabilities').map((row) => row.id)
}

/**
 * Refuses a deploy whose approved contract holds a row the namespace's pinned proxy may not read: its source is not the
 * one this control plane deploys new placements from. `current` is absent where this control plane manages no namespace
 * proxy, which then has nothing to compare.
 */
export function assertNamespaceProxyReads(
	namespace: string,
	contract: ContractArtifact | undefined,
	pinned: ZeropsNamespaceProxySource,
	current: ZeropsNamespaceProxySource | undefined,
): void {
	if (contract === undefined || current === undefined || pinned.commitSha === current.commitSha) {
		return
	}
	const rows = rowsNeedingCurrentProxy(contract)
	if (rows.length === 0) {
		return
	}
	throw new Error(
		`the proxy of deployment namespace \`${namespace}\` is pinned to an older source than this platform's, and cannot read ${
			rows.map((row) => `\`${row}\``).join(', ')
		} (a public procedure or several capabilities); re-pin it with \`fabrika control namespaces update --namespace=${namespace} --proxy-source=current\`, then deploy again`,
	)
}
