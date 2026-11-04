// Authority an artifact states that an older framework release would not enforce (ADR-0062): a relation, a role's
// `via`, a table's `confers` or `when`. The reader of the current minor reads them from any release of that minor, so a
// deploy of a release before the first one that enforces them is refused before anything publishes.

import type { ContractArtifact } from '@fabrika/auth-core'
import { compareReleases, FRAMEWORK_PACKAGE, parseRelease, type Release } from './readers'

/** The first framework release whose data layer and dispatch enforce relations, `via`, `confers` and `when`. */
export const RELATION_GRANTS_SINCE: Release = { text: '0.9.0', major: 0, minor: 9, patch: 0 }

/** The fields of `contract` that only a release from `RELATION_GRANTS_SINCE` enforces, as `field` or `field of name`. */
export function relationFields(contract: ContractArtifact): string[] {
	const fields: string[] = []
	for (const relation of Object.keys(contract.relations ?? {})) fields.push(`relation ${relation}`)
	for (const [name, role] of Object.entries(contract.roles)) {
		if (role.via !== undefined && Object.keys(role.via).length > 0) fields.push(`via of role ${name}`)
	}
	for (const [name, table] of Object.entries(contract.tables)) {
		if (table.confers !== undefined && Object.keys(table.confers).length > 0) fields.push(`confers of table ${name}`)
		if (table.when !== undefined && Object.keys(table.when).length > 0) fields.push(`when of table ${name}`)
	}
	return fields
}

/**
 * Why the application's pinned release cannot run `contract`, or null when it can. A snapshot without a release was
 * read before Control recorded one, so it is an older application.
 */
export function relationGrantsRefusal(contract: ContractArtifact | null, framework: string | undefined): string | null {
	const fields = contract === null ? [] : relationFields(contract)
	if (fields.length === 0) return null
	const release = framework === undefined ? null : parseRelease(framework)
	if (release !== null && compareReleases(release, RELATION_GRANTS_SINCE) >= 0) return null
	return `the contract declares ${fields.length} relation grant field${fields.length === 1 ? '' : 's'} (${fields.slice(0, 3).join(', ')}${
		fields.length > 3 ? ', …' : ''
	}), which ${FRAMEWORK_PACKAGE} enforces from ${RELATION_GRANTS_SINCE.text}, and the application pins ${
		framework ?? 'an older release'
	}; raise the pin`
}
