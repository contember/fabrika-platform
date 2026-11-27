import type { RpcFetch } from '@fabrika/app'
import { appEnvironmentId } from '@fabrika/auth-core'
import type { AppDto, GrantDto, GrantRequestDto, IamAdministrationScope } from '@fabrika/iam-contract'
import { quietIamClient } from './iam'
import type { ConsoleSession } from './session'

/** The built-in role whose grant the button issues; at a contract application it holds the declared actions. */
export const ADMIN_ROLE = 'admin'

/** How long a self-granted Admin lasts. No expiry is the default (card t816-iam-admin-a-superadmin). */
export type SelfAdminExpiry = 'none' | '8h' | '7d'

export const SELF_ADMIN_EXPIRIES: readonly { readonly value: SelfAdminExpiry; readonly label: string }[] = [
	{ value: 'none', label: 'No expiry' },
	{ value: '8h', label: '8 hours' },
	{ value: '7d', label: '7 days' },
]

const EXPIRY_SECONDS: Record<Exclude<SelfAdminExpiry, 'none'>, number> = { '8h': 8 * 3600, '7d': 7 * 86400 }

/** The grant's `expiresAt` in epoch seconds, or null for none. */
export function selfAdminExpiresAt(expiry: SelfAdminExpiry, now: number): number | null {
	return expiry === 'none' ? null : now + EXPIRY_SECONDS[expiry]
}

/** One environment whose Admin the caller may give itself, and the Admin it already holds there. */
export interface SelfAdminTarget {
	readonly env: string
	/** The IAM application id, `<app>@<env>`. */
	readonly app: string
	/** The caller's active global Admin there and the grants that give it; null when it holds none. */
	readonly held: { readonly until: number | null; readonly grantIds: readonly string[] } | null
}

/**
 * The environments of `appId` where the caller may grant itself Admin: IAM knows the environment as an application,
 * it is not one of the installation's own, and the caller administers its people (`iam.admin`, or `iam.users.manage`
 * there). IAM decides again on the write; this only decides what to offer.
 */
export function selfAdminTargets(input: {
	readonly appId: string
	readonly envs: readonly string[]
	readonly iamApps: readonly AppDto[]
	readonly administration: IamAdministrationScope
	readonly grants: readonly Pick<GrantDto, 'id' | 'app' | 'roleKey' | 'scopeType' | 'expiresAt'>[]
	readonly now: number
}): SelfAdminTarget[] {
	const known = new Set(input.iamApps.filter((app) => !app.installation).map((app) => app.id))
	const administers = (app: string): boolean =>
		input.administration.kind === 'installation' || input.administration.apps === null || input.administration.apps.includes(app)
	return input.envs.flatMap((env): SelfAdminTarget[] => {
		const app = appEnvironmentId(input.appId, env)
		if (!known.has(app) || !administers(app)) return []
		const active = input.grants.filter((candidate) =>
			candidate.app === app && candidate.roleKey === ADMIN_ROLE && candidate.scopeType === null
			&& (candidate.expiresAt === null || candidate.expiresAt > input.now)
		)
		if (active.length === 0) return [{ env, app, held: null }]
		const until = active.some((grant) => grant.expiresAt === null) ? null : Math.max(...active.map((grant) => grant.expiresAt ?? 0))
		return [{ env, app, held: { until, grantIds: active.map((grant) => grant.id) } }]
	})
}

/**
 * Revokes every grant that gives the caller its Admin in one environment, so none is left behind. Answers the first
 * revocation that waits for another administrator's approval (ADR-0083), or null when all took effect.
 */
export async function revokeSelfAdmin(
	held: NonNullable<SelfAdminTarget['held']>,
	remove: (id: string) => Promise<{ readonly pending?: GrantRequestDto }>,
): Promise<GrantRequestDto | null> {
	let waiting: GrantRequestDto | null = null
	for (const id of held.grantIds) waiting ??= (await remove(id)).pending ?? null
	return waiting
}

/** What the Admin section needs: who the caller is in IAM and the environments it may grant itself Admin in. */
export interface SelfAdminState {
	readonly principalId: string
	readonly targets: readonly SelfAdminTarget[]
}

/**
 * The caller's self-Admin state at `appId`, or null when it administers no people or IAM does not answer: the section
 * is then absent, and the application page loads as before.
 */
export async function readSelfAdmin(
	appId: string,
	envs: readonly string[],
	session: Pick<ConsoleSession, 'principal' | 'iam'>,
	fetcher: RpcFetch = fetch,
): Promise<SelfAdminState | null> {
	if (session.principal === null || session.iam === null || session.iam === false) return null
	try {
		const iam = quietIamClient(fetcher)
		const [apps, principal] = await Promise.all([iam.apps.list(), iam.principals.get({ principalId: session.principal.id })])
		const targets = selfAdminTargets({
			appId,
			envs,
			iamApps: apps.items,
			administration: session.iam,
			grants: principal.grants,
			now: Math.floor(Date.now() / 1000),
		})
		return { principalId: session.principal.id, targets }
	} catch {
		return null
	}
}
