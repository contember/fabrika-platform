// The Zerops driver's plan derivation — pure, side-effect-free, exactly as the Cloudflare one is. Given a
// config + context it decides WHICH steps a Zerops deploy applies and in WHAT order.
//
// THIS PLAN IS NOT CLOUDFLARE'S WITH NO-OPS. That is the whole reason ADR-0002 moved derivation into the
// driver, so it is worth being explicit about the differences:
//
//   • NO `build` — Zerops has its own CI. fabrika triggers it; it does not run it (ADR-0003).
//   • NO `deploy-worker` — build and deploy are ONE indivisible platform-side operation. What fabrika
//     splits instead is TRIGGERING it from OBSERVING it, which is a seam the platform really has (and
//     which ADR-0003's crash-safety requirement depends on: the control plane may trigger its own redeploy
//     and die, then reconcile by polling).
//   • NO `migrate` — migrations run as `run.initCommands` when a runtime container starts. There is
//     nothing for the deploy to do.
//   • NO `sync-secrets` — and this one is a DECISION, not an omission. On Zerops the platform is the
//     system of record for secret values and they change without a redeploy (ADR-0004), so pushing them at
//     deploy time would silently overwrite a client's GUI edit. Secrets are written through the env API at
//     EDIT time. A no-op step here would be a lie in the deploy log.
//   • NEW `await-deploy` — polling a platform-run pipeline and relaying its logs has no Cloudflare
//     analogue at all.
//
// The one step both drivers share is `reconcile-schema`: it talks to the IAM service, not to a cloud, so
// ADR-0002 classifies it as portable and both plans end with it.

import type { AnyAppConfig, ZeropsAppTarget } from '@fabrika/config'
import type { DeployContext, DeployPlan, JobSpec, ZeropsTarget } from '../../types'

/** The step vocabulary of a ZEROPS deploy. Closed, and this driver's alone — the engine never reads it. */
export type ZeropsStepKind = 'apply-import' | 'trigger-deploy' | 'await-deploy' | 'reconcile-schema'

/** A step of a Zerops plan: a `JobSpec` narrowed to this driver's step vocabulary. */
export interface ZeropsJobSpec extends JobSpec {
	kind: ZeropsStepKind
}

/** A Zerops deploy plan: a `DeployPlan` whose steps are all this driver's. */
export interface ZeropsPlan extends DeployPlan {
	steps: ZeropsJobSpec[]
}

/**
 * Which service the app's CODE deploys to. Explicit when the app names one; otherwise the single declared
 * service. Ambiguity is an ERROR rather than a guess — picking "the first one" from a list that holds a
 * database and a runtime would deploy code to the database on a day someone reorders the array.
 */
export const resolveDeployHostname = (target: ZeropsAppTarget, hostnames: string[]): string => {
	if (target.deployService !== undefined) {
		if (!hostnames.includes(target.deployService)) {
			throw new Error(`zerops: \`deployService: ${target.deployService}\` names no declared service (have: ${hostnames.join(', ') || 'none'})`)
		}
		return target.deployService
	}
	if (hostnames.length === 1 && hostnames[0] !== undefined) {
		return hostnames[0]
	}
	throw new Error(`zerops: app declares ${hostnames.length} services — set \`deployService\` to say which one carries the code`)
}

/**
 * Build the ordered deploy plan for one app + environment ON ZEROPS:
 * apply-import → trigger-deploy → await-deploy → reconcile-schema.
 *
 * `hostnames` is the already-compiled service list (the driver compiles the import document once in
 * `open()` and passes it in), so derivation stays pure and the plan can name what it will import.
 */
export const buildZeropsPlan = (config: AnyAppConfig, ctx: DeployContext<ZeropsTarget>, hostnames: string[]): ZeropsPlan => {
	const steps: ZeropsJobSpec[] = []
	let previous: string | undefined

	const add = (spec: Omit<ZeropsJobSpec, 'dependsOn'>): void => {
		steps.push(previous === undefined ? spec : { ...spec, dependsOn: [previous] })
		previous = spec.id
	}

	add({
		id: 'apply-import',
		kind: 'apply-import',
		description: `Apply the Zerops import for ${hostnames.length} service(s): ${hostnames.join(', ')}`,
	})
	add({ id: 'trigger-deploy', kind: 'trigger-deploy', description: 'Trigger the Zerops build+deploy pipeline' })
	add({ id: 'await-deploy', kind: 'await-deploy', description: 'Await the Zerops pipeline and relay its build log' })

	// Identical condition to Cloudflare's, because this step is genuinely portable (ADR-0002): a first
	// reconcile SELF-REGISTERS the app in propustka.
	if (config.schema !== undefined && ctx.propustkaUrl !== undefined) {
		add({ id: 'reconcile-schema', kind: 'reconcile-schema', description: 'Reconcile authz schema into propustka' })
	}

	return { appId: config.id, env: ctx.env, steps }
}
