import type { ControlRegistryRepository } from './db'

/**
 * The return origins the control plane projects into IAM for one app environment
 * (ADR-0022/0023; `docs/reference/cross-host-sso.md` § Who writes the registry).
 *
 * IAM's registry is keyed by the IAM application id `<app>@<env>` (ADR-0022 rule 6), so the projected
 * set is the deploying environment's own origin and nothing else: a `stage` origin registered under
 * `notes@prod` would let production hand a session to staging's host.
 *
 * The value is already canonical: `public_origin` is validated on write (`canonicalPublicOrigin`).
 *
 * Returns `undefined` when the environment has no public origin — an app fabrika has not been told
 * the address of is LEFT ALONE rather than registered with a guess.
 */
export async function projectedReturnOrigins(
	db: Pick<ControlRegistryRepository, 'getAppEnv'>,
	appId: string,
	env: string,
): Promise<readonly string[] | undefined> {
	const origin = (await db.getAppEnv(appId, env))?.public_origin ?? null
	return origin === null || origin === '' ? undefined : [origin]
}
