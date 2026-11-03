// The containment chains of a contract's dimensions: what the runtime's `over` reads a caller's grants through, and
// what decides which capability of several has a denied case (`capability-cases.ts`).

import type { DimensionArtifact } from '@fabrika/auth-core'

/** Every dimension's containers, nearest first (`note → [workspace, organization]`); `buildArtifact` refuses a cycle. */
export function containersOf(dimensions: Readonly<Record<string, DimensionArtifact>>): ReadonlyMap<string, readonly string[]> {
	const containers = new Map<string, readonly string[]>()
	for (const dimension of Object.keys(dimensions)) {
		const chain: string[] = []
		let next = dimensions[dimension]?.in ?? null
		while (next !== null && !chain.includes(next)) {
			chain.push(next)
			next = dimensions[next]?.in ?? null
		}
		containers.set(dimension, chain)
	}
	return containers
}
