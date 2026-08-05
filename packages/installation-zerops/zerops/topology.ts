// fabrika's OWN Zerops topology: the two projects an installation is made of, declared in TypeScript and
// compiled to `zerops-import.yaml` by the same compiler the deploy driver uses
// (`compileImportYaml` / `compileProvisioningYaml` from `@fabrika/provider-zerops`).
//
// ── The two projects, and why two ─────────────────────────────────────────────────────────────────
//
//   platform    corePackage SERIOUS    proxy · iam · operations · control · db/storage pairs
//   apps-prod   corePackage SERIOUS    proxy — the apps themselves arrive as their own imports
//
// A Zerops project is the unit of isolation: one VXLAN private network, its own balancers, DNS and
// firewall. Inside a project every service reaches every other by hostname; ACROSS projects there is no
// private network at all. ADR-0006 therefore puts the control plane in its own project — "a client who
// breaks the apps project cannot take down the thing that repairs it" — and that decision is the only
// reason this file emits two documents instead of one.
//
// It also means the apps-project proxy reaches the IAM service over a PUBLIC endpoint. That is fine and
// was priced in: the warm path verifies tokens locally against a cached JWKS, so the cross-project hop
// is cold-path only (ADR-0007).
//
// ── What these documents are, and what they are not ───────────────────────────────────────────────
//
// They are IMPORT documents: `POST /client/{id}/project/import` creates the project and its services.
// They are NOT deploy targets — no `deployService` is set, because no single service "carries the code"
// for a whole project. Each platform service is deployed on its own, by its own pipeline, selecting its
// own named setup from the repository-root `zerops.yaml` (see `./setups.ts`).
//
// ── Two things that cannot be fixed afterwards ────────────────────────────────────────────────────
//
//   1. `envIsolation` is settable at project CREATION only — `RequestPutProject` has no such field. A
//      project created without it can never be corrected, so the compiler writes it unconditionally at
//      BOTH levels and `assertZeropsInvariants` refuses to serialize a document missing it.
//   2. `corePackage` is upgrade-only and its upgrade is partially destructive. `assertCorePackageIsExplicit`
//      makes leaving it to the LIGHT default an error rather than a silent choice.
//
// ── Where the secrets are ─────────────────────────────────────────────────────────────────────────
//
// Nowhere in here, and that is structural rather than careful: `ZeropsProjectSpec` has no `envVariables`
// and `ZeropsServiceSpec` has no `envSecrets`/`dotEnvSecrets`, so a secret in this file would not
// compile. Every value below is a hostname, a size or a boolean. The service-level secrets each service
// needs are listed in `./setups.ts` next to the setup that consumes them; they are written through the
// env API, addressed by service, after the provisioning import creates it (ADR-0004).

import {
	compileImportYaml,
	compileProvisioningYaml,
	compileZeropsNamespaceTopology,
	type ZeropsImportDocument,
	type ZeropsNamespacePostgres,
	zeropsNamespacePreset,
	type ZeropsServiceSpec,
	type ZeropsSourceTarget,
} from '@fabrika/provider-zerops'
import { assertTopologyInvariants } from './invariants'

/**
 * How a project's single public entry point is published.
 *
 * `enableSubdomainAccess` is documented as "not suitable for production", so production takes
 * `custom-domain`: nothing in the import is publicly routed, and the domain is bound to the project's L7
 * balancer out of band — the import format has NO field for a custom domain, so that step is manual by
 * construction and not an oversight here. `zerops-subdomain` is the ONLY thing that ever writes
 * `enableSubdomainAccess: true` — on the proxy, and on nothing else.
 *
 * **NEITHER VALUE IS DELIVERED BY THE IMPORT.** Live-verified: the platform accepts
 * `enableSubdomainAccess` on a service the document CREATES and then silently drops it, so the service
 * reads back `subdomainAccess: false` and stays there. The subdomain is established afterwards, by
 * `PUT /service-stack/{id}/enable-subdomain-access` on a service that already publishes an HTTP port —
 * which the namespace lifecycle does for itself (`ensureSubdomainAccess` in `@fabrika/provider-zerops`)
 * and which an operator applying the generated platform artifacts must do by hand; the artifact's header
 * names the call. So `true` here records the INTENT and feeds ADR-0007's `assertOnlyPublicService`; it
 * does not turn anything on.
 */
export type PublicAccess = 'custom-domain' | 'zerops-subdomain'

/**
 * How much platform an installation pays for.
 *
 * `standard` is the production shape: HA Postgres, a separate database and bucket for Operations, and
 * enough containers that no single one is a point of failure.
 *
 * `light` is one project, one `postgresql:single@18` and one bucket shared by IAM, Operations, control
 * AND the apps deployed alongside them, at one container per service. It exists because the standard
 * shape costs ~13 containers before a single application is deployed, which is more platform than a
 * small fleet — or an evaluation — can justify.
 *
 * Sharing is safe rather than merely cheap, and that is a property of the code, not of this comment:
 *
 *   • The three services' table names do not intersect (IAM 10, Operations 24, control 16), and
 *     ADR-0017 already gives each its own migration ledger and advisory lock, so one database holds
 *     all three without coordination.
 *   • Their blob keys are prefix-disjoint — control writes `runs/`, Operations writes `events/`,
 *     `dead/` and `source-maps/` — so one bucket cannot collide.
 *
 * What `light` genuinely gives up is FAILURE-DOMAIN isolation: Operations' high-volume error history
 * now shares capacity with the identity path, and losing the one database loses all three services.
 * That is the trade, and it is why `standard` remains the default rather than the special case.
 */
export type PlatformTier = 'standard' | 'light'

export interface TopologyOptions {
	/** Environment label handed to `services(ctx)`. Part of the project name, so it lands in the GUI too. */
	env: string
	/** How the proxy is published. Production is `custom-domain`. */
	publicAccess?: PublicAccess
	/** How much platform to provision. Defaults to `standard`. */
	tier?: PlatformTier
}

/** One project's topology plus the facts the invariant checks need. */
export interface ProjectTopology {
	/** Stem of the generated filenames, and how this topology is referred to in prose. */
	id: string
	/** The source declaration compiled into the generated topology artifacts. */
	target: ZeropsSourceTarget
	/** The one service allowed to be publicly routed (ADR-0007). Always the proxy. */
	publicService: string
	/** Present on app namespaces so fixtures can prove the selected isolation tier. */
	namespacePreset?: 'cheap' | 'mid' | 'full'
	/** Present only when this namespace is reserved for one app. */
	exclusiveAppId?: string
}

/** The proxy's hostname, in every project. Also the `zerops.yaml` setup name it builds from. */
export const PROXY_HOSTNAME = 'proxy'
/** Public source used when the namespace lifecycle builds a newly provisioned proxy. */
export const FABRIKA_PROXY_SOURCE = 'https://github.com/contember/fabrika-platform'

/**
 * A runtime service, with the field that must never be left to a default written explicitly.
 *
 * `enableSubdomainAccess` is written even when it is `false` — which is also Zerops' default — on
 * purpose. The default protects a service nobody thought about; an explicit `false` makes turning it on
 * a visible one-line diff in review. What it does NOT do is turn anything on or off: the platform drops
 * the field on create and `override: true` leaves an existing service untouched, so this document can
 * neither establish a subdomain nor correct one someone enabled in the GUI. Both directions are separate
 * calls — `EnableSubdomainAccess` and `DisableSubdomainAccess`. See `PublicAccess` above.
 *
 * `verticalAutoscaling` is deliberately NOT written, and that is a decision rather than an omission.
 * A live Bun runtime reads back a floor of 1 shared core / 0.125 GB and a ceiling of 8 cores / 48 GB /
 * 250 GB. The floor is already the minimum the platform offers, so there is nothing to save by
 * restating it; and capping the ceiling would convert a traffic spike into an outage on services whose
 * only other lever is `maxContainers`, which IS written on every one of them. Where a floor genuinely
 * costs money — the managed databases — it is chosen explicitly through `profile` instead.
 *
 * `zeropsSetup` is deliberately NOT written. It used to be, as a redundant restatement of Zerops' own
 * "setup name defaults to the hostname" rule that would keep working the day a service was renamed. On a
 * real account it does not keep working at all: the platform treats it as pipeline configuration and
 * rejects the entire import with `{"iam.buildFromGit": ["parameter is required for use of
 * pipelineConfig"]}` unless the service also names a repository to build from — which none of these do
 * (ADR-0003: fabrika triggers Zerops' pipeline, it does not configure a git integration). The setup name
 * travels at TRIGGER time instead, where the driver already passes it and no repository is required.
 * `assertZeropsInvariants` now refuses the combination so this fails at generation rather than at import.
 */
const runtime = (
	spec: Omit<ZeropsServiceSpec, 'enableSubdomainAccess' | 'zeropsSetup'> & { public?: boolean },
): ZeropsServiceSpec => {
	const { public: isPublic, ...rest } = spec
	return { ...rest, enableSubdomainAccess: isPublic === true }
}

/**
 * The **platform** project: fabrika itself.
 *
 * `SERIOUS` is not a comfort choice. This project holds the thing that repairs the other one, so its
 * availability tier is the recovery story; and because `corePackage` cannot be downgraded, starting
 * LIGHT and "upgrading when it matters" costs a partially destructive migration at the worst moment.
 */
export const platformTopology = (options: TopologyOptions): ProjectTopology => {
	const publicAccess = options.publicAccess ?? 'custom-domain'
	const tier = options.tier ?? 'standard'
	if (tier === 'light') {
		return lightPlatformTopology(options, publicAccess)
	}
	return {
		id: 'platform',
		publicService: PROXY_HOSTNAME,
		target: {
			platform: 'zerops',
			project: {
				name: 'platform',
				description: 'fabrika control plane, Operations, IAM and the auth proxy. Separate from the apps project by ADR-0006.',
				corePackage: 'SERIOUS',
				tags: ['fabrika', 'platform', options.env],
			},
			services: () => [
				// ── data, created first (priority is descending) ──────────────────────────────────
				{
					hostname: 'db',
					// HA is encoded in the TYPE. The deprecated `mode` field is not merely avoided here — it
					// is absent from `ZeropsServiceSpec`, so it cannot be written. One database serves both
					// IAM and the control plane; they are separate schemas in it, not separate services,
					// because a second HA Postgres triples the cost of the isolation the private network
					// already gives us.
					type: 'postgresql:ha@18',
					// The identity and control-plane database: every login, every token mint, every run's
					// state. `oltp-production` is also what an HA service gets by DEFAULT — stated here so
					// the bill is a decision rather than a discovery, and because this is the one place the
					// standard tier should pay for it: dedicated CPU is what keeps auth latency off the
					// noisy-neighbour curve.
					profile: 'oltp-production',
					priority: 100,
				},
				{
					hostname: 'storage',
					// S3-compatible object storage: run logs (`FABRIKA_CONTROL_RUN_LOGS_*`) and deploy artifacts.
					// `@fabrika/platform-node`'s `S3BlobStore` speaks to this unchanged — it is the same
					// implementation that speaks to R2.
					type: 'object-storage',
					objectStorageSize: 25,
					// Never `public-read`: a run log can quote a build's environment.
					objectStoragePolicy: 'private',
					// A CDN in front of private run logs would be a cache in front of a thing nobody reads twice.
					enableCdn: false,
					priority: 100,
				},
				{
					hostname: 'operationsdb',
					// Operations has an independent database service. This prevents its high-volume error
					// history and migrations from sharing IAM/control's failure and capacity domain.
					type: 'postgresql:ha@18',
					// NOT `db`'s profile, and that is the point of stating both. `oltp-staging` keeps the
					// same three-container redundancy and the same 8-core/48 GB ceiling, but starts at one
					// SHARED core and 1 GB instead of two DEDICATED cores and 4 GB — measured off a live
					// HA service, see `docs/reference/zerops-platform.md`. Error history is bursty and
					// tolerant of jitter: slow ingest is a queue, not an outage. Holding two dedicated
					// cores idle for it is the half of the default nobody chose.
					profile: 'oltp-staging',
					priority: 100,
				},
				{
					hostname: 'operationsstorage',
					type: 'object-storage',
					objectStorageSize: 25,
					objectStoragePolicy: 'private',
					enableCdn: false,
					priority: 100,
				},
				// ── services ──────────────────────────────────────────────────────────────────────
				runtime({
					hostname: 'iam',
					type: 'alpine/bun@1.3',
					priority: 50,
					// Identity is on the critical path of every login and every cold-path token mint, and the
					// service is stateless (its state is in `db`), so two containers cost little and remove a
					// single point of failure the product cannot afford.
					minContainers: 2,
					maxContainers: 4,
				}),
				runtime({
					hostname: 'operations',
					type: 'alpine/bun@1.3',
					priority: 40,
					minContainers: 1,
					maxContainers: 3,
				}),
				runtime({
					hostname: 'control',
					type: 'alpine/bun@1.3',
					// IAM → Operations → control is the code deployment order too: control has a private
					// Operations dependency and must never start against a missing service.
					priority: 30,
					// Deliberately allowed to be a single container. The control plane is CRASH-SAFE across a
					// deploy by design — it may trigger its own redeploy and die, then reconcile in-flight runs
					// by polling `/app-version` on restart (ADR-0003) — so an outage window here is a delay,
					// not a lost run. Scaling it out would also multiply the queue consumers for no gain.
					minContainers: 1,
					maxContainers: 2,
				}),
				runtime({
					hostname: PROXY_HOSTNAME,
					// Alpine custom runtime: a Caddy binary plus a compiled Bun auth service, no interpreter
					// (ADR-0008). `run.os` is deprecated — the OS is the service type.
					type: 'alpine@3.21',
					priority: 10,
					// THE ONLY PUBLICLY ROUTED SERVICE. Everything above is reachable only over the project's
					// private network; the proxy is what the internet talks to, including for IAM's own OIDC
					// login and the control-plane dashboard.
					public: publicAccess === 'zerops-subdomain',
					// It is on every request to every service in this project, and it is stateless by
					// construction (ADR-0008 insists on that precisely so this line is allowed to exist).
					minContainers: 2,
					maxContainers: 6,
				}),
			],
		},
	}
}

/**
 * The **light** platform: the same six roles in one project, on shared data services.
 *
 * Deliberately NOT a parameterized variation of the standard declaration above. The two differ in
 * which services exist, not merely in their sizes, and a single declaration threaded with conditionals
 * would make both harder to read than either is alone — the standard topology's per-field commentary is
 * the reason that file is worth reading at all.
 *
 * `corePackage: LIGHT` is stated rather than defaulted for exactly the reason `assertCorePackageIsExplicit`
 * exists: it is upgrade-only, and an installation that starts here should have chosen to.
 */
const lightPlatformTopology = (options: TopologyOptions, publicAccess: PublicAccess): ProjectTopology => ({
	id: 'platform-light',
	publicService: PROXY_HOSTNAME,
	target: {
		platform: 'zerops',
		project: {
			name: 'platform',
			description: 'fabrika light tier: control plane, Operations, IAM, the auth proxy and the apps they serve, on shared data services.',
			corePackage: 'LIGHT',
			tags: ['fabrika', 'platform', 'light', options.env],
		},
		services: () => [
			{
				// ONE database for IAM, control, Operations and every app in this project. Which schema each
				// one gets is not expressed here — it is `FABRIKA_*_DATABASE_URL`, written per installation
				// through the env API, because this same repository-root `zerops.yaml` serves both tiers and
				// a `${operationsdb_connectionString}` baked into it would name a service `light` does not have.
				hostname: 'db',
				type: 'postgresql:single@18',
				// `oltp-staging` is also this type's default, written out because a default is not a
				// choice. It is the one profile below `oltp-production` that still sets a 1 GB memory
				// floor, and this single service holds IAM, control, Operations AND the apps beside them
				// — `oltp-hobby` sets no floor at all, which is right for one dev database and not for
				// four tenants sharing one.
				profile: 'oltp-staging',
				priority: 100,
			},
			{
				// ONE bucket. Prefix-disjoint by construction: `runs/` (control) vs `events/`, `dead/` and
				// `source-maps/` (Operations).
				hostname: 'storage',
				type: 'object-storage',
				objectStorageSize: 25,
				objectStoragePolicy: 'private',
				enableCdn: false,
				priority: 100,
			},
			runtime({ hostname: 'iam', type: 'alpine/bun@1.3', priority: 50, minContainers: 1, maxContainers: 2 }),
			runtime({ hostname: 'operations', type: 'alpine/bun@1.3', priority: 40, minContainers: 1, maxContainers: 2 }),
			runtime({ hostname: 'control', type: 'alpine/bun@1.3', priority: 30, minContainers: 1, maxContainers: 2 }),
			runtime({
				hostname: PROXY_HOSTNAME,
				type: 'alpine@3.21',
				priority: 10,
				public: publicAccess === 'zerops-subdomain',
				// Still the only publicly routed service (ADR-0007). One container is a real availability
				// trade and the reason this tier is not for production; it is not a relaxation of the rule
				// about WHICH service faces the internet.
				minContainers: 1,
				maxContainers: 2,
			}),
		],
	},
})

/**
 * An application namespace: one proxy plus the namespace-owned resources selected by its preset.
 *
 * This is only an adapter over the provider-owned namespace compiler. The control plane uses that same
 * compiler for live create/adopt/reconcile operations, so generated bring-up artifacts cannot drift
 * into a second definition of what an application namespace contains.
 *
 * `mid` stays the default for the committed apps-prod artifact: each app imports its own prefixed
 * database. `cheap` adds namespace-owned Postgres. `full` reserves the project for one app, while the
 * app's own import still owns its runtime services and database.
 */
export interface AppsTopologyOptions extends TopologyOptions {
	readonly corePackage: 'LIGHT' | 'SERIOUS'
	readonly preset?: 'cheap' | 'mid' | 'full'
	readonly projectName?: string
	readonly exclusiveAppId?: string
	readonly postgres?: ZeropsNamespacePostgres
}

export const appsTopology = (options: AppsTopologyOptions): ProjectTopology => {
	const preset = options.preset ?? 'mid'
	const id = options.projectName ?? `apps-${options.env}`
	if (preset === 'full' && options.exclusiveAppId === undefined) {
		throw new Error('A full Zerops namespace requires exclusiveAppId')
	}
	if (preset !== 'full' && options.exclusiveAppId !== undefined) {
		throw new Error(`A ${preset} Zerops namespace cannot reserve an exclusive app`)
	}
	const namespaceTarget = zeropsNamespacePreset({
		preset,
		env: options.env,
		projectName: id,
		corePackage: options.corePackage,
		publicAccess: options.publicAccess ?? 'custom-domain',
		proxyBuildFromGit: FABRIKA_PROXY_SOURCE,
		...(options.postgres === undefined ? {} : { postgres: options.postgres }),
	})
	const namespace = compileZeropsNamespaceTopology({
		id,
		env: options.env,
		...(options.exclusiveAppId === undefined ? {} : { exclusiveAppId: options.exclusiveAppId }),
		target: { provider: 'zerops', version: 1, payload: {} },
	}, namespaceTarget)
	return {
		id,
		publicService: PROXY_HOSTNAME,
		target: namespace.source,
		namespacePreset: preset,
		...(options.exclusiveAppId === undefined ? {} : { exclusiveAppId: options.exclusiveAppId }),
	}
}

/** The topologies this repo commits generated documents for. */
export const fabrikaTopologies = (): ProjectTopology[] => [
	platformTopology({ env: 'prod' }),
	// The light tier is committed for the same reason the other two are: an operator applies the file, so
	// it should be reviewable in a diff. `zerops-subdomain` because a single-project installation has no
	// second project to bind a custom domain in front of, and this tier is where a throwaway starts.
	platformTopology({ env: 'prod', tier: 'light', publicAccess: 'zerops-subdomain' }),
	appsTopology({ env: 'prod', corePackage: 'SERIOUS' }),
]

/** A compiled topology in both of the forms an operator needs. */
export interface CompiledTopology {
	topology: ProjectTopology
	/**
	 * First bring-up ONLY: every service `startWithoutCode: true`, so secrets can be written before any
	 * deploy. Applying this a second time at a project whose services already carry code activates a new
	 * EMPTY app version on each of them — verified live. It is not a reconcile document.
	 */
	provision: { document: ZeropsImportDocument; yaml: string }
	/**
	 * Steady state: the same document, re-appliable because every service carries `override: true`.
	 *
	 * "Re-appliable" is the whole claim, and deliberately not "reconciling". Live-verified: applying
	 * this at an existing project creates whatever is missing and leaves everything that exists exactly
	 * as it is — a changed `profile`, `minContainers` or `objectStorageSize` in here is accepted by the
	 * API and silently ignored. Changing a live service is a separate, field-specific API call.
	 */
	steady: { document: ZeropsImportDocument; yaml: string }
}

/**
 * Compile one topology to both documents, asserting every invariant on each.
 *
 * The provisioning form exists because of the cost ADR-0004 accepted out loud: on Zerops no secret can
 * be set before the service exists, since the env API is addressed BY SERVICE. So bring-up is
 * import-without-code → write secrets → deploy, and `compileProvisioningYaml` is the first of those three.
 */
export const compileTopology = (topology: ProjectTopology, env: string): CompiledTopology => {
	const input = { target: topology.target, ctx: { env } }
	const provision = compileProvisioningYaml(input)
	const steady = compileImportYaml(input)
	assertTopologyInvariants(provision.document, topology.publicService)
	assertTopologyInvariants(steady.document, topology.publicService)
	return { topology, provision, steady }
}
