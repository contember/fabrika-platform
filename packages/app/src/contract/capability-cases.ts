// Which capability of an endpoint of several has no denied case: the rule both the scaffold and the endpoint access kit
// read, so the generated tests never ask the kit for a case it refuses.

import type { CapabilityRequirement, DimensionArtifact } from '@fabrika/auth-core'
import { containersOf } from './containers'

/**
 * The capability that rules out `name`'s denied case, or `undefined` when `name` has one. Only an `over` capability
 * loses it: to another capability that needs the same action on its dimension, on a container of it or on a dimension
 * inside it. Every caller that passes that other one holds the action where the runtime lists the `over` dimension from
 * (a value of it, of a container, or of a dimension inside it, through the same `containersOf`), so none is refused the
 * list. Another one on an unrelated dimension leaves the case: a caller holding the action only there is refused (403).
 */
export function deniedCaseRuledOutBy(
	capabilities: Readonly<Record<string, CapabilityRequirement>>,
	name: string,
	dimensions: Readonly<Record<string, DimensionArtifact>>,
): string | undefined {
	const named = capabilities[name]
	if (named?.access.form !== 'over') return undefined
	const listed = named.access.dimension
	const containers = containersOf(dimensions)
	return Object.entries(capabilities).find(([other, { action, access }]) =>
		other !== name
		&& action === named.action
		&& (access.dimension === listed
			|| (containers.get(listed) ?? []).includes(access.dimension)
			|| (containers.get(access.dimension) ?? []).includes(listed))
	)?.[0]
}
