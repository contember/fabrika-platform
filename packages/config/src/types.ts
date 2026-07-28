import type { AppSchema } from '@fabrika/auth-core'
import type { Worker } from 'oblaka-iac'
import type { ZeropsAppTarget } from './zerops/types'

/**
 * The context handed to an app's `resources()` builder when fabrika materializes a deploy.
 * It carries the target environment (and optional public domain) so the app can shape its
 * Cloudflare resources per-stage (names, routes, vars). This is the deploy-time analogue of
 * oblaka's `DefineFn` config — fabrika owns the lifecycle, the app owns the resource graph.
 */
export interface ResourceContext {
	/** The target environment, e.g. `local` / `staging` / `production`. */
	env: string
	/** The public domain this stage serves on, when known (drives routes/vars). */
	domain?: string
}

/**
 * The pipeline an app's deploy goes through: where its Worker source lives, how to build it,
 * and which secrets must be present. fabrika's engine (M1) reads this to drive build + secret
 * provisioning; M0 only declares the shape.
 */
export interface AppPipeline {
	/** Directory containing the Worker source, relative to the config file. Defaults to `.`. */
	workerDir?: string
	/** Shell command run to build the Worker before deploy, e.g. `bun run build`. */
	build?: string
	/** Names of the secrets this app requires at deploy time. */
	secrets?: string[]
	/**
	 * Names of the NON-SECRET deploy-time vars this app needs (e.g. propustka's
	 * `PROPUSTKA_HUMAN_EMAIL_DOMAINS`, `PROPUSTKA_OIDC_ISSUER`). Their values are per-app-env registry
	 * config (NOT vault secrets); the engine
	 * injects each into `process.env` BEFORE materializing `resources()`, so a config reads them the same
	 * way a legacy `oblaka.ts` did (`process.env['NAME']`). Use for config that is plaintext but
	 * environment/account-specific — values that don't belong in the committed config. A declared var with
	 * no resolved value is a hard deploy error (never ship a half-configured deploy).
	 */
	vars?: string[]
}

/**
 * The CLOUDFLARE arm of an app's deploy target: an oblaka `Worker` built per environment. Mirrors the
 * engine's `CloudflareTarget` one level up — that one says WHERE a deploy goes, this one says WHAT is
 * deployed.
 */
export interface CloudflareAppTarget {
	/** The discriminant — what selects the Cloudflare driver. */
	platform: 'cloudflare'
	/** Builds the app's Cloudflare resource graph (an oblaka `Worker`) for a given environment. */
	resources: (ctx: ResourceContext) => Worker
}

/**
 * WHAT an app deploys, discriminated by platform — the app-authoring counterpart of the engine's
 * `DeployTarget` (ADR-0009). A driver reads only its own variant, and the discriminant is what selects it.
 */
export type AppTarget = CloudflareAppTarget | ZeropsAppTarget

/** What every app config carries, whichever platform it targets. */
export interface AppConfigBase {
	/** Stable app id, unique within the control plane. Drives resource naming + propustka app id. */
	id: string
	/** The app's authz vocabulary (scopes/actions/roles), reconciled into propustka at deploy. */
	schema?: AppSchema
	/** How the app is built and which secrets it needs at deploy time. */
	pipeline?: AppPipeline
}

/**
 * A CLOUDFLARE app config, authored in a single `fabrika.config.ts`. One config maps to one deployable app
 * across every environment; `resources()` is re-evaluated per environment.
 *
 * `resources` stays a REQUIRED top-level member rather than moving inside `target`: it is the historical
 * surface, every existing config and consumer reads it, and its presence IS the `cloudflare` arm — see
 * `appTarget()`, the one place the two forms are normalized.
 */
export interface CloudflareAppConfig extends AppConfigBase {
	/** Builds the app's Cloudflare resource graph (an oblaka `Worker`) for a given environment. */
	resources: (ctx: ResourceContext) => Worker
	/** Never set on the Cloudflare arm — `resources` above is this app's target. */
	target?: undefined
}

/**
 * A ZEROPS app config: the discriminated `target` carries the platform's own declaration (a set of
 * services in a project), because a Zerops app has no oblaka resource graph to build.
 */
export interface ZeropsAppConfig extends AppConfigBase {
	/** The Zerops declaration — services, and optionally the managed project. */
	target: ZeropsAppTarget
	/** Never set on the Zerops arm: there is no `Worker`, no bindings, and no `wrangler` on Zerops. */
	resources?: undefined
}

/**
 * App configs keyed by the platform they target — the authoring-side twin of the engine's `DeployTargets`.
 * Keeping the two maps parallel is what lets a driver receive a config already narrowed to its own arm
 * (`DriverRun<'cloudflare'>.config` is a `CloudflareAppConfig`) with no cast and no check.
 */
export interface AppConfigs {
	cloudflare: CloudflareAppConfig
	zerops: ZeropsAppConfig
}

/**
 * Any app config. The union is what a platform-neutral consumer (the engine, the CLI, the control plane)
 * accepts; resolve it to a target with `appTarget()` rather than branching on shape.
 */
export type AnyAppConfig = AppConfigs[keyof AppConfigs]

/**
 * An app's full deploy surface. Bare `AppConfig` means the CLOUDFLARE arm — the historical meaning, kept
 * so every existing consumer (`config.resources(...)`) is unchanged. Use `AnyAppConfig` where a second
 * platform is possible.
 */
export type AppConfig = CloudflareAppConfig
