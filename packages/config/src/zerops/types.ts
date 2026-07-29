// The ZEROPS app-authoring surface. `./schema.generated.ts` is the platform's contract in full; THIS file
// is the subset an app may declare — the platform contract MINUS every field fabrika owns.
//
// The subtraction is the point. ADR-0004's two invariants are enforced by making their violations
// UNTYPEABLE rather than by reviewing for them:
//
//   1. "fabrika never writes an app secret to project-level env" — `ZeropsProjectSpec` has no
//      `envVariables`, and no service field carries a secret value at all (`envSecrets` /
//      `dotEnvSecrets` are subtracted too: on Zerops the platform is the system of record, so a deploy
//      that re-wrote them would silently correct a client's GUI edit — the exact failure ADR-0004
//      rejects). Secrets reach a service through the env API at EDIT time, service-addressed, never
//      through this document.
//   2. "always set `envIsolation: service` explicitly" — `envIsolation` is subtracted at BOTH levels, so
//      an app cannot weaken it and cannot leave it to a platform default. The compiler always writes it.
//
// `override` and the two `@deprecated` fields are subtracted for the same reason: they are the driver's
// levers (idempotent re-import), not the app's.

import type { AppGates } from '@fabrika/auth-core'
import type { ResourceContext } from '../types'
import type { ZeropsImportProject, ZeropsImportService } from './schema.generated'

/**
 * Fields of a Zerops service that fabrika's compiler owns, never the app. Named so the subtraction below
 * reads as a policy statement rather than a list of strings, and so a new one is added in ONE place.
 */
export type ZeropsCompilerOwnedServiceField =
	// Always `service` — the second half of ADR-0004's invariant. `none` leaks every service's
	// service-level variables to every other service in the project.
	| 'envIsolation'
	// Always `true` — re-applying the import is how a Zerops deploy is idempotent (ADR-0003).
	| 'override'
	// Secret VALUES never travel through the compiled document; the platform is the system of record.
	| 'envSecrets'
	| 'dotEnvSecrets'
	// Deprecated in the live schema: availability and OS are encoded in the service `type`.
	| 'mode'
	| 'os'

/** Fields of the managed project that fabrika's compiler owns, never the app. */
export type ZeropsCompilerOwnedProjectField =
	// Project-level variables are injected into EVERY service in the project, and one project holds many
	// apps — ADR-0004 forbids fabrika from ever writing one. Unrepresentable, not merely unwritten.
	| 'envVariables'
	// Always `service`; see above.
	| 'envIsolation'

/**
 * ONE service of a Zerops app, as an app may declare it: the platform's service contract minus what the
 * compiler owns. `hostname` + `type` are required by the platform; everything else is optional.
 *
 * `startWithoutCode: true` provisions the service BEFORE it has any code — the answer to ADR-0004's
 * recorded "no secret can be set before the service exists" gap: import the service, write its secrets
 * through the env API, deploy later.
 */
export type ZeropsServiceSpec = Omit<ZeropsImportService, ZeropsCompilerOwnedServiceField>

/**
 * The managed Zerops project, as an app may declare it. Optional in `ZeropsAppTarget`: by default the
 * project already exists (its id is a registry field — ADR-0006) and only its services are imported.
 *
 * `corePackage` cannot be downgraded once set, which is why ADR-0006 defaults to one project per
 * environment.
 */
export type ZeropsProjectSpec = Omit<ZeropsImportProject, ZeropsCompilerOwnedProjectField>

/**
 * The ZEROPS arm of an app's deploy target. A Zerops app is a set of services in a project, not an oblaka
 * `Worker` — there is no resource graph, no bindings, and no `wrangler`.
 *
 * `services` is a function of the environment for the same reason Cloudflare's `resources` is: hostnames,
 * autoscaling and public access differ per stage.
 */
export interface ZeropsProxySpec {
	/** Private address the shared proxy dials after authorization, for example `api:3000`. */
	upstream: string
	/** Ordered, fail-closed request gates enforced by the proxy auth service. */
	gates: AppGates
}

interface ZeropsTargetBase {
	/** The discriminant — what selects the Zerops driver. */
	platform: 'zerops'
	/**
	 * Hostname of the service the app's CODE deploys to — the one `/app-version` builds and activates.
	 * Optional when the app declares exactly one service; required when it declares several.
	 */
	deployService?: string
	/** Select one setup when the repository's `zerops.yaml` declares several. */
	zeropsSetup?: string
	/** Private ingress and ordered gate declaration compiled into the shared proxy manifest. */
	proxy?: ZeropsProxySpec
}

/** The TypeScript authoring arm. It is evaluated only by `fabrika build`. */
export interface ZeropsSourceTarget extends ZeropsTargetBase {
	/**
	 * The services this app is made of, for one environment. Order does not matter; use `priority` when a
	 * database must exist before the runtime that migrates into it.
	 */
	services: (ctx: ResourceContext) => ZeropsServiceSpec[]
	/**
	 * The managed project's own settings, when fabrika creates or reconciles it. Omit when the project is
	 * pre-existing (the usual case — `app_envs.zerops_project_id` is a registry field, ADR-0006).
	 */
	project?: ZeropsProjectSpec
	/** A source target has no precompiled payload. */
	compiled?: undefined
}

/**
 * The static arm decoded from `fabrika.manifest.json`. The control plane may construct this arm from
 * validated JSON; it contains no callback and cannot execute repository code.
 */
export interface ZeropsCompiledTarget extends ZeropsTargetBase {
	/** A compiled target has no executable service builder. */
	services?: undefined
	project?: undefined
	compiled: {
		/** Deterministic import document emitted by fabrika's invariant-checking compiler. */
		importYaml: string
		/** Declared service hostnames, used for deploy-service validation and planning. */
		serviceHostnames: string[]
	}
}

export type ZeropsAppTarget = ZeropsSourceTarget | ZeropsCompiledTarget
