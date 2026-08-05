import type { ControlRegistryRepository } from './db'

/**
 * Assemble the return origins the control plane projects into IAM for one app
 * (ADR-0021; `docs/reference/cross-host-sso.md` § Who writes the registry).
 *
 * IAM's registry is keyed by APP ID, while `public_origin` is per ENVIRONMENT — so the projected set
 * is every environment's origin, not the one being deployed. Sending only the deploying environment's
 * origin would un-register the others, and a `stage` deploy would silently break `prod`'s sign-in.
 *
 * The values are already canonical: `public_origin` is validated on write (`canonicalPublicOrigin`),
 * so this only collects, de-duplicates, and orders them. Order is stable so a re-deploy that changed
 * nothing sends the identical body.
 *
 * Returns `undefined` when no environment has a public origin — an app fabrika has not been told the
 * address of is LEFT ALONE rather than registered with a guess.
 */
export async function projectedReturnOrigins(
	db: Pick<ControlRegistryRepository, 'listAppEnvs'>,
	appId: string,
): Promise<readonly string[] | undefined> {
	const origins = new Set<string>()
	for (const row of await db.listAppEnvs(appId)) {
		if (row.public_origin !== null && row.public_origin !== '') {
			origins.add(row.public_origin)
		}
	}
	return origins.size === 0 ? undefined : [...origins].sort()
}
