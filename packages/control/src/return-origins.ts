import type { ControlRepositories } from './db'
import { devSandboxOrigin } from './dev/sandbox-keys'

/**
 * The return origins the control plane projects into IAM for one app environment
 * (ADR-0022/0023; `docs/reference/cross-host-sso.md` § Who writes the registry).
 *
 * IAM's registry is keyed by the IAM application id `<app>@<env>` (ADR-0022 rule 6), so the projected
 * set is the deploying environment's own origins and nothing else: a `stage` origin registered under
 * `notes@prod` would let production hand a session to staging's host. A `dev` environment's own origins are those of
 * its ready workspace sandboxes, all under the one IAM application id.
 *
 * The value is already canonical: `public_origin` is validated on write (`canonicalPublicOrigin`).
 *
 * Returns `undefined` when the environment has no origin — an app fabrika has not been told the address of is LEFT
 * ALONE rather than registered with a guess, and a dev environment whose last sandbox is gone keeps its previous set,
 * since IAM refuses an empty one.
 */
export async function projectedReturnOrigins(
	db: Pick<ControlRepositories, 'registry' | 'devSandboxes'>,
	appId: string,
	env: string,
): Promise<readonly string[] | undefined> {
	const appEnv = await db.registry.getAppEnv(appId, env)
	if (appEnv === null) return undefined
	const origins = appEnv.public_origin === null || appEnv.public_origin === '' ? [] : [appEnv.public_origin]
	if (appEnv.kind === 'dev' && appEnv.domain !== null && appEnv.domain !== '') {
		for (const sandbox of await db.devSandboxes.listByEnvironment(appId, env)) {
			if (sandbox.state === 'ready') origins.push(devSandboxOrigin(appEnv, sandbox.workspace_id))
		}
	}
	return origins.length === 0 ? undefined : origins
}
