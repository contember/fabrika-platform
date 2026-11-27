import type { RpcFetch } from '@fabrika/app'
import { quietIamClient } from './iam'

/** How many principals hold each role, by role key. A role absent from it has no holder. */
export type RoleHolders = ReadonlyMap<string, number>

/**
 * The holders of every role of one IAM application (`<app>@<env>`), in one read IAM records. Null when IAM refuses or
 * does not answer: the roles then show without counts.
 */
export async function readRoleHolders(app: string, fetcher: RpcFetch = fetch): Promise<RoleHolders | null> {
	try {
		const answer = await quietIamClient(fetcher).appPeople.holders({ app })
		return new Map(answer.roles.map((entry) => [entry.role, entry.holders]))
	} catch {
		return null
	}
}

/** `3 holders`, `1 holder`, `no holders`. */
export function holdersLabel(holders: RoleHolders, role: string): string {
	const count = holders.get(role) ?? 0
	return count === 0 ? 'no holders' : `${count} ${count === 1 ? 'holder' : 'holders'}`
}
