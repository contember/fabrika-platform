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
 * construction and not an oversight here. `zerops-subdomain` exists for a throwaway environment and is
 * the ONLY thing that ever writes `enableSubdomainAccess: true` — on the proxy, and on nothing else.
 */
export type PublicAccess = 'custom-domain' | 'zerops-subdomain'

export interface TopologyOptions {
	/** Environment label handed to `services(ctx)`. Part of the project name, so it lands in the GUI too. */
	env: string
	/** How the proxy is published. Production is `custom-domain`. */
	publicAccess?: PublicAccess
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
 * A runtime service, with the two fields that must never be left to a default written explicitly.
 *
 * `enableSubdomainAccess` is written even when it is `false` — which is also Zerops' default — on
 * purpose. The default protects a service nobody thought about; an explicit `false` makes turning it on
 * a visible one-line diff in review, and makes `override: true` CORRECT a subdomain someone enabled in
 * the GUI to debug something and forgot about. A default cannot do either.
 */
const runtime = (
	spec: Omit<ZeropsServiceSpec, 'enableSubdomainAccess' | 'zeropsSetup'> & { public?: boolean },
): ZeropsServiceSpec => {
	const { public: isPublic, ...rest } = spec
	return {
		...rest,
		// Setup name == hostname is also Zerops' own matching rule, so this is redundant today and
		// load-bearing the day a service is renamed: the build keeps selecting the setup it was written for.
		zeropsSetup: rest.hostname,
		enableSubdomainAccess: isPublic === true,
	}
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
					priority: 100,
				},
				{
					hostname: 'storage',
					// S3-compatible object storage: run logs (`VOZKA_RUN_LOGS_*`) and deploy artifacts.
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
	appsTopology({ env: 'prod', corePackage: 'SERIOUS' }),
]

/** A compiled topology in both of the forms an operator needs. */
export interface CompiledTopology {
	topology: ProjectTopology
	/** First bring-up: every service `startWithoutCode: true`, so secrets can be written before any deploy. */
	provision: { document: ZeropsImportDocument; yaml: string }
	/** Steady state: the same document re-applied (`override: true`) to reconcile drift. */
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
