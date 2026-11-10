// Authority an artifact states that an older framework release would not enforce (ADR-0062): a relation, a role's
// `via`, a table's `confers`, `when` or `relationWhen`. The reader of the current minor reads them from any release of
// that minor, so a deploy of a release before the first one that enforces them is refused before anything publishes.

import type { ContractArtifact } from '@fabrika/auth-core'
import { comparePrecedence, FRAMEWORK_PACKAGE, parseRelease, type Release } from './readers'

// A floor is the first release whose source enforces its fields: the release after the source version when the
// enforcement lands, since the source version names the last release cut. `enforcement-floors.test.ts` holds that.

/**
 * The first framework release whose data layer and dispatch enforce relations, `via`, `confers` and `when`. Compared
 * with its prerelease: every earlier `0.9.0-*` release reads none of them and would widen access.
 */
export const RELATION_GRANTS_SINCE: Release = { text: '0.9.0-dev.13', major: 0, minor: 9, patch: 0 }

/** The first framework release that ANDs a table's `relationWhen` onto its relation's terms; an earlier one ignores it. */
export const RELATION_WHEN_SINCE: Release = { text: '0.9.0-dev.14', major: 0, minor: 9, patch: 0 }

/** The fields of a contract one floor guards, as `field` or `field of name`. */
export interface FloorFields {
	readonly since: Release
	readonly fields: readonly string[]
}

/** Each floor with the fields of `contract` that only a release from it enforces, in ascending order of the floors. */
export function relationFloors(contract: ContractArtifact): FloorFields[] {
	const grants: string[] = []
	const relationWhen: string[] = []
	for (const relation of Object.keys(contract.relations ?? {})) grants.push(`relation ${relation}`)
	for (const [name, role] of Object.entries(contract.roles)) {
		if (role.via !== undefined && Object.keys(role.via).length > 0) grants.push(`via of role ${name}`)
	}
	for (const [name, table] of Object.entries(contract.tables)) {
		if (table.confers !== undefined && Object.keys(table.confers).length > 0) grants.push(`confers of table ${name}`)
		if (table.when !== undefined && Object.keys(table.when).length > 0) grants.push(`when of table ${name}`)
		if (table.relationWhen !== undefined && Object.keys(table.relationWhen).length > 0) relationWhen.push(`relationWhen of table ${name}`)
	}
	return [{ since: RELATION_GRANTS_SINCE, fields: grants }, { since: RELATION_WHEN_SINCE, fields: relationWhen }]
}

/** Every field of `contract` that some floor guards. */
export function relationFields(contract: ContractArtifact): string[] {
	return relationFloors(contract).flatMap(({ fields }) => fields)
}

/**
 * Why the application's pinned release cannot run `contract`, or null when it can. A snapshot without a release was
 * read before Control recorded one, so it is an older application. The refusal names the highest floor it misses.
 */
export function relationGrantsRefusal(contract: ContractArtifact | null, framework: string | undefined): string | null {
	const release = framework === undefined ? null : parseRelease(framework)
	const missed = (contract === null ? [] : relationFloors(contract)).filter(({ since, fields }) =>
		fields.length > 0 && (release === null || comparePrecedence(release, since) < 0)
	)
	const highest = missed.at(-1)
	if (highest === undefined) return null
	const fields = missed.flatMap((floor) => floor.fields)
	return `the contract declares ${fields.length} relation grant field${fields.length === 1 ? '' : 's'} (${fields.slice(0, 3).join(', ')}${
		fields.length > 3 ? ', …' : ''
	}), which ${FRAMEWORK_PACKAGE} enforces from ${highest.since.text}, and the application pins ${framework ?? 'an older release'}; raise the pin`
}
