import type { RpcFetch } from '@fabrika/app'
import { appEnvironmentId } from '@fabrika/auth-core'
import { quietIamClient } from './iam'
import type { ConsoleSession } from './session'

/** How many principals hold each role, by role key. A role absent from it has no holder. */
export type RoleHolders = ReadonlyMap<string, number>

/**
 * The IAM application whose counts the Access tab reads for `env`, or null when it reads none: the environment must be
 * one of the application's, and the caller administer IAM there (or be unknown to), or administer the environment's
 * people. IAM decides again and records the read.
 */
export function roleHoldersTarget(input: {
	readonly appId: string
	readonly env: string
	readonly envs: readonly string[]
	readonly iam: ConsoleSession['iam']
	readonly peopleApps: readonly string[]
}): string | null {
	if (!input.envs.includes(input.env)) return null
	const app = appEnvironmentId(input.appId, input.env)
	const iam = input.iam
	const administers = iam === null || (iam !== false && (iam.kind === 'installation' || iam.apps === null || iam.apps.includes(app)))
	return administers || input.peopleApps.includes(app) ? app : null
}

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
