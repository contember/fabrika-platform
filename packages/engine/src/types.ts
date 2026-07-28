import type { AnyAppConfig, AppConfig } from '@fabrika/config'

/**
 * Where a secret lives in the control plane's scoping hierarchy, widest → narrowest:
 *  - 'app'      — scoped to one app, across all its environments.
 *  - 'app-env'  — scoped to one app in one environment (the narrowest, e.g. prod-only keys).
 * Resolution layers narrowest over widest. The vault holds ONLY these app-specific secrets;
 * platform credentials (the CF API token, propustka provisioning creds) are fabrika's own Worker
 * secrets (build-time config), never per-app vault entries.
 */
export type SecretScope = 'app' | 'app-env'

/** A reference to a secret in the store — resolved to a value at deploy time, never inlined. */
export interface SecretRef {
	/** The secret's name as the app declares it in `pipeline.secrets`. */
	name: string
	/** The scope this reference resolves against. */
	scope: SecretScope
}

/**
 * WHERE a deploy goes on Cloudflare: the account it lands in, the token that authorizes it, and the
 * oblaka state namespace its resource state is keyed under. Read ONLY by the Cloudflare driver.
 */
export interface CloudflareTarget {
	/** The discriminant — what selects the Cloudflare driver. */
	platform: 'cloudflare'
	/** Cloudflare account id to deploy into. */
	accountId: string
	/** Cloudflare API token with deploy permissions. Never logged. */
	apiToken: string
	/**
	 * oblaka state KV namespace name — where the deploy's resource state lives in the target account.
	 * Defaults to `<app id>-state` (the per-app convention the legacy `oblaka … --state-namespace=<app>-state`
	 * pipelines used). Per-app so deploys of different apps into the SAME account never collide (oblaka keys
	 * state by env within the namespace), and so a migrated app's first fabrika deploy CONTINUES its existing
	 * state instead of re-provisioning. Override only for an app whose existing namespace differs from the default.
	 */
	stateNamespace?: string
}

/**
 * WHERE a deploy goes on Zerops: the project + service it targets and the personal access token that
 * authorizes the REST calls. Read ONLY by the Zerops driver.
 *
 * `projectId` is the registry field ADR-0006 makes the topology decision with — nothing here or in the
 * driver assumes a particular app→project mapping, and nothing keys off a naming convention.
 */
export interface ZeropsTarget {
	/** The discriminant — what selects the Zerops driver. */
	platform: 'zerops'
	/** The Zerops project the service lives in (`app_envs.zerops_project_id`, ADR-0006). */
	projectId: string
	/** The Zerops service being deployed — the one `/app-version` builds and activates. */
	serviceId: string
	/**
	 * A Zerops PERSONAL ACCESS TOKEN, sent verbatim as `Authorization: Bearer` (the API has no
	 * exchange step — `/auth/*` is for email+password sessions). It carries account-wide admin rights:
	 * treat it as a root credential and never log it.
	 */
	accessToken: string
	/**
	 * Public Git repository URL for a ONE-TIME build, when the deploy supplies its own source. Per-run,
	 * not per-app: the control plane resolves the ref it is deploying. Omit — the normal production case —
	 * to let Zerops build from the service's configured GitHub/GitLab integration, which is the only path
	 * that works for a PRIVATE repository.
	 */
	buildFromGit?: string
	/** Override the API host (a different Zerops region). Defaults to `api.app-prg1.zerops.io`. */
	apiBaseUrl?: string
}

/**
 * The registry of deploy targets, keyed by their discriminant. This map IS the engine's entire
 * knowledge of platforms: adding one means adding a key here and a driver under that key, never a
 * branch in the orchestrator (ADR-0009).
 */
export interface DeployTargets {
	cloudflare: CloudflareTarget
	zerops: ZeropsTarget
}

/** The discriminant values — the set of platforms a deploy can target. */
export type PlatformId = keyof DeployTargets

/** Any deploy target. Discriminated on `platform`; a driver reads only its own variant. */
export type DeployTarget = DeployTargets[PlatformId]

/**
 * Everything the engine needs to deploy one app to one environment. The top level is UNIVERSAL — it
 * holds only what every platform has (the environment, the domain, the resolved secrets/vars, the
 * working directory, dry-run, and the IAM coordinates). Every platform credential and platform handle
 * lives in the discriminated `target`, which is also what selects the driver (ADR-0009).
 *
 * `T` narrows the target: `DeployContext` (the default) is a context for ANY platform, while
 * `DeployContext<CloudflareTarget>` is one a Cloudflare driver can read without a check.
 */
export interface DeployContext<T extends DeployTarget = DeployTarget> {
	/** Target environment, e.g. `staging` / `production`. */
	env: string
	/** Public domain for this stage, when known. */
	domain?: string
	/** WHERE this deploy goes — the platform credentials + handles, keyed by the `platform` discriminant. */
	target: T
	/** Base URL of the propustka IAM service, when reconciling the schema. */
	propustkaUrl?: string
	/**
	 * The propustka admin/provisioning `px_` bearer key used to authenticate the schema reconcile
	 * (the seeded `PROPUSTKA_PROVISIONING_KEY` propustka admits as a synthetic admin). Sent as
	 * `Authorization: Bearer`; omit for a propustka local-dev run (the dev bypass resolves an admin).
	 */
	adminKey?: string
	/** Resolved secret values for this deploy, keyed by secret name. */
	secrets: Record<string, string>
	/**
	 * Resolved NON-SECRET deploy-var values for this deploy, keyed by var name (the app's
	 * `pipeline.vars`). The engine injects each declared var into `process.env` before materializing
	 * the resource graph, so the config reads it via `process.env['NAME']`. Plaintext, per-app-env
	 * registry config — distinct from `secrets` (vault-backed, write-only, `wrangler secret put`).
	 */
	vars?: Record<string, string>
	/** Absolute path the config was loaded from; build + relative paths resolve here. */
	cwd: string
	/**
	 * Plan-only mode. When set, the engine builds the plan, runs the driver's steps with every real
	 * mutation SKIPPED — on Cloudflare `wrangler deploy`, `wrangler d1 migrations apply`,
	 * `wrangler secret put` and the propustka reconcile, with oblaka in plan-only mode — logging what
	 * it WOULD do instead. It stays on the RUN rather than in a driver bundle: it is a property of the
	 * deploy, and every driver must honour it. The only way to exercise the full path without real creds.
	 */
	dryRun?: boolean
}

/**
 * One unit of work in a deploy. The target's `DeployDriver` materializes a `DeployPlan` of these from
 * the app's config + context; the engine then executes them in the order given, surfacing each as a
 * `DeployStep`.
 */
export interface JobSpec {
	/** Stable id of the step within a plan — its primary key (`dependsOn` and execution both use it). */
	id: string
	/**
	 * Coarse kind of work, for logs and progress reporting. The VOCABULARY belongs to the driver
	 * (Cloudflare's is `CloudflareStepKind`), so this is an open string: the engine never interprets it,
	 * and another platform's plan legitimately consists of different kinds in a different order.
	 */
	kind: string
	/** Human-readable description for logs / the dashboard. */
	description: string
	/** Ids of steps that must complete before this one runs. */
	dependsOn?: string[]
}

/** The status of a step or whole run as it moves through the engine. */
export type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'

/** A `JobSpec` plus its live status — what the engine surfaces while executing a plan. */
export interface DeployStep {
	spec: JobSpec
	status: RunStatus
	/** Failure detail when `status === 'failed'`. */
	error?: string
	/** Epoch ms when the step started, once it has. */
	startedAt?: number
	/** Epoch ms when the step finished, once it has. */
	finishedAt?: number
}

/** The full ordered plan the target's driver derives for one `deploy()` before executing anything. */
export interface DeployPlan {
	/** The app being deployed. */
	appId: string
	/** The target environment. */
	env: string
	/** The ordered steps to execute. */
	steps: JobSpec[]
}

/** The outcome of a `deploy()` call: the plan that ran and the final state of each step. */
export interface DeployResult {
	/** The app that was deployed. */
	appId: string
	/** The environment it was deployed to. */
	env: string
	/** Overall outcome of the run. */
	status: RunStatus
	/** The plan that was executed. */
	plan: DeployPlan
	/** Final state of each step, in execution order. */
	steps: DeployStep[]
}

/** Re-exported for callers that build a `deploy()` invocation. */
export type { AnyAppConfig, AppConfig }
