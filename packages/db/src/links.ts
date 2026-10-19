// A Ref's predicate over a table's containment links: the first link takes the Ref's id, every other link a value
// of its chain, and a chain entry no link covers is refused. Shared by the stores and the handles.

import type { OperationNode } from 'kysely'
import { freeze, inSet, nameSet, ownEntry, ownKeys, recordOf } from './builtins'
import type { RefGrant } from './capability'
import { CapabilityError } from './errors'
import { allOf, equals } from './nodes'
import type { Container } from './policy'

function chainValue(grant: RefGrant, chain: Readonly<Record<string, string>>, dimension: string): string {
	const value = ownEntry(chain, dimension)
	if (value === undefined) {
		throw new CapabilityError('out_of_reach', `the Ref of ${grant.dimension} carries no ${dimension} in its chain`)
	}
	return value
}

export interface LinkValue {
	readonly link: Container
	readonly value: string
}

/**
 * The column values a Ref addresses over `links`: the first link takes the Ref's id, every other link a value
 * from its chain. A chain entry no link covers cannot be enforced, so it is refused rather than ignored.
 */
export function linkValues(table: string, links: readonly Container[], grant: RefGrant): readonly LinkValue[] {
	const first = links[0]
	if (first === undefined) {
		throw new CapabilityError('out_of_reach', `${table} has no containment link for a Ref of ${grant.dimension}`)
	}
	const chain = recordOf(grant.chain)
	const covered: string[] = []
	for (let index = 1; index < links.length; index++) {
		covered[covered.length] = links[index]?.dimension ?? ''
	}
	const coveredSet = nameSet(covered)
	const dimensions = ownKeys(chain)
	for (let index = 0; index < dimensions.length; index++) {
		const dimension = dimensions[index] ?? ''
		if (!inSet(coveredSet, dimension)) {
			throw new CapabilityError(
				'unenforceable',
				`the Ref of ${grant.dimension} lies in ${dimension}, which ${table} carries no column for; the layer cannot enforce it`,
			)
		}
	}
	const values: LinkValue[] = [{ link: first, value: grant.id }]
	for (let index = 1; index < links.length; index++) {
		const link = links[index]
		if (link !== undefined) {
			values[values.length] = { link, value: chainValue(grant, chain, link.dimension) }
		}
	}
	return freeze(values)
}

export function linksPredicate(table: string, values: readonly LinkValue[]): OperationNode {
	return allOf(values.map(({ link, value }) => equals(table, link.column, value)))
}
