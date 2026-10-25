import type { ApplicationObjects, AppSchema, ContractArtifact, ManagedEnvironment } from '@fabrika/auth-core'
import type { InstallationBrand } from '@fabrika/proxy-core/brand'
import type { JsonValue, ProviderEnvelope } from './json'

/** Events whose persistence and presentation belong to the control plane. */
export interface ProviderRunEvents {
	log(line: string): void
	/** Atomically persist the external operation id and, when supplied, its credential-free checkpoint. */
	externalId(id: string, state?: JsonValue): Promise<void>
	/** Replace the credential-free checkpoint while this run remains active. */
	checkpoint(state: JsonValue): Promise<void>
	/**
	 * A step boundary: Control checks its lease and reads the run's cancellation request. Rejects with a
	 * `ProviderInvocationAbort` after aborting the run's signal. A long step calls it at its own boundaries.
	 */
	boundary(): Promise<void>
}

/**
 * Complete platform-owned runtime state, parsed by Control (`parseManagedEnvironment`). A provider writes each entry as
 * a secret when it is a `credential`, removes one whose value is null, and removes the stale ones `staleManagedVariables` names.
 */
export type ProviderManagedEnvironment = ManagedEnvironment

/** Provider-neutral coordinates for obtaining one app revision. */
export interface ProviderSource {
	readonly repoUrl: string
	readonly ref: string
	readonly workerDir?: string
	readonly buildCommand?: string
	readonly configPath?: string
}

/** App data needed by a control provider. */
export interface ProviderApp {
	readonly id: string
	readonly source: ProviderSource
}

/** One provider-owned placement boundary shared by zero or more app environments. */
export interface ProviderDeploymentNamespace {
	readonly id: string
	readonly env: string
	readonly exclusiveAppId?: string
	readonly target: ProviderEnvelope
}

export { FRAMEWORK_RELEASE_PATTERN } from '@fabrika/auth-core'

/**
 * The access Control approved for one application environment (ADR-0050): the contract the proxy enforces and the
 * IAM vocabulary compiled from it. A provider publishes a contract application's endpoint table and reconciles its
 * IAM schema from this, never from the artifact or a runner's report.
 */
export interface ProviderApprovedAccess {
	/** The contract in this platform release's model, upcast from the application's own release's artifact (ADR-0062). */
	readonly contract: ContractArtifact
	/**
	 * The digest the application's own framework release computes for its contract, which it compares with
	 * `FABRIKA_CONTRACT_DIGEST` at startup. It is `contractDigest(contract)` only when the application is on this
	 * release's artifact format, so a provider never derives it from `contract`.
	 */
	readonly contractDigest: string
	readonly schema: AppSchema
	/**
	 * The `@fabrika/check` release whose reader read the application (`FRAMEWORK_RELEASE_PATTERN`): the newest patch of
	 * the framework minor it pins (ADR-0062). Its build checks with that release.
	 */
	readonly checker: string
}

/**
 * `dev`: the environment follows a workspace through a platform-owned launcher, which its provider starts instead of the
 * serving entry (ADR-0043). The kind is Control's registry, never the application's.
 */
export type ProviderEnvironmentKind = 'standard' | 'dev'

/** Persisted deploy data for one app environment. */
export interface ProviderEnvironment {
	readonly appId: string
	readonly env: string
	/** Absent means `standard`. */
	readonly kind?: ProviderEnvironmentKind
	readonly domain?: string
	/** Canonical externally reachable HTTP(S) origin; independent of provider domain routing. */
	readonly publicOrigin?: string
	/**
	 * The exact origins whose pages may call the environment's cross-origin endpoints, as the operator listed them in
	 * Control's registry (ADR-0022 "Cross-origin endpoints"). Absent when it lists none. A provider writes them into the
	 * application's proxy manifest entry as `crossOrigins`.
	 */
	readonly crossOrigins?: readonly string[]
	/**
	 * The origin of the environment's active Operations ingest DSN, never the DSN: a contract application's proxy admits
	 * it in `connect-src`. Control sets it on a deploy; absent while the environment has no active ingest.
	 */
	readonly operationsOrigin?: string
	readonly namespace?: ProviderDeploymentNamespace
	readonly target: ProviderEnvelope
	readonly artifact: ProviderEnvelope
	/**
	 * The environment's approved contract, from Control's `approvedSnapshot`. Absent when nothing is approved: then a
	 * provider publishes no endpoint table and reconciles no IAM schema, whatever the artifact claims (ADR-0050).
	 * Control refuses a non-dry deploy without it.
	 */
	readonly access?: ProviderApprovedAccess
}

/** Raw registration data passed to provider-owned validation and normalization. */
export interface ProviderRegistrationInput {
	readonly app: ProviderApp
	readonly environment: ProviderEnvironment
}

/** Canonical registration returned after provider-owned validation and normalization. */
export type ProviderRegistration = ProviderRegistrationInput

/** Provider-neutral input for resolving one requested source ref to an immutable Git object id. */
export interface ProviderSourceResolutionInput {
	readonly runId: string
	readonly app: ProviderApp
	readonly environment: ProviderEnvironment
	/** An immutable commit already recorded by the trigger, which resolution must verify exactly. */
	readonly expectedCommitSha?: string
	readonly sourceBinding?: ProviderSourceBinding
	readonly signal: AbortSignal
}

/** The exact source revision a provider resolved before starting deploy work. */
export interface ProviderSourceResolution {
	readonly commitSha: string
}

/**
 * Credential-free selector of the GitHub connection and installation that read a private source
 * (ADR-0029). Absent means a public source; an installation id alone never selects a credential.
 */
export interface ProviderSourceBinding {
	readonly connectionId: string
	readonly installationId: number
}

/** How private GitHub sources reach a provider (ADR-0029): one keyed connection's App and installation. */
export interface ProviderSourceCapabilities {
	readonly binding: 'connection'
}

/** One control-plane deploy invocation. */
export interface ProviderDeployInput {
	readonly runId: string
	readonly app: ProviderApp
	readonly environment: ProviderEnvironment
	readonly secrets: Readonly<Record<string, string>>
	readonly vars: Readonly<Record<string, string>>
	/** Platform-owned runtime configuration, separate from operator-managed application vars. */
	readonly managedEnvironment: ProviderManagedEnvironment
	/**
	 * The object that serves the environment's ordinary traffic and the objects its ops channel reaches, as Control records
	 * them (ADR-0070 §9). A provider whose application runs in no object ignores it; absent, the provider's defaults.
	 */
	readonly applicationObjects?: ApplicationObjects
	readonly dryRun: boolean
	readonly sourceBinding?: ProviderSourceBinding
	/** Optional short-lived, run-scoped Operations artifact destination. */
	readonly artifactUpload?: {
		readonly url: string
		readonly bearer: string
		readonly appId: string
		readonly environment: string
		readonly serviceKey: string
		readonly release: string
		readonly runId: string
	}
	readonly signal: AbortSignal
	readonly events: ProviderRunEvents
}

/**
 * A terminal provider operation result. `succeeded` means the version is live: Control then writes the environment's
 * approved IAM schema itself (ADR-0011), so a provider never calls IAM for an application.
 */
export interface ProviderTerminalOutcome {
	readonly state: 'succeeded' | 'failed'
	readonly exitCode?: number
	/** Whether provider-local release artifacts reached Operations. */
	readonly artifactState?: 'complete' | 'incomplete' | 'not_applicable'
}

/** Running means external settlement is unresolved, including an ambiguous submission response. */
export type ProviderDeployOutcome = ProviderTerminalOutcome | { readonly state: 'running' }

/** Settled does not imply rollback: when activation won before cancellation, `outcome` is `succeeded`. */
export type ProviderCancelOutcome = { readonly state: 'pending' } | { readonly state: 'settled'; readonly outcome?: 'succeeded' | 'failed' }

/** Losing invocation ownership must never be interpreted as permission to cancel external work. */
export class ProviderInvocationAbort extends Error {
	constructor(readonly kind: 'lease_lost' | 'cancel_requested') {
		super(kind === 'lease_lost' ? 'provider invocation lost its lease' : 'provider cancellation requested')
		this.name = 'ProviderInvocationAbort'
	}
}

export const isLeaseLoss = (reason: unknown): boolean => reason instanceof ProviderInvocationAbort && reason.kind === 'lease_lost'

/** A signal that aborts with `signal`'s reason only when the lease is lost, never on a cancel. */
export const followLeaseLoss = (signal: AbortSignal): AbortSignal => {
	const controller = new AbortController()
	const follow = (): void => {
		if (isLeaseLoss(signal.reason)) controller.abort(signal.reason)
	}
	if (signal.aborted) follow()
	else signal.addEventListener('abort', follow, { once: true })
	return controller.signal
}

/** Resolve after `ms`, or reject with the signal's reason once it aborts. */
export const abortableWait = (ms: number, signal: AbortSignal): Promise<void> =>
	new Promise((resolve, reject) => {
		signal.throwIfAborted()
		const abort = (): void => {
			clearTimeout(timer)
			reject(signal.reason)
		}
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', abort)
			resolve()
		}, ms)
		signal.addEventListener('abort', abort, { once: true })
	})

/** A platform-owned run that can be cancelled or reconciled. */
export interface ProviderRunReference {
	readonly runId: string
	readonly externalId: string
	readonly environment: ProviderEnvironment
	/** Credential-free provider-owned checkpoint recorded by the run's last owner. */
	readonly providerState?: JsonValue
	/** When the run started (`started_at`, else `created_at`), in epoch milliseconds; bounds how long a provider polls. */
	readonly startedAtMs?: number
}

export interface ProviderCancelInput extends ProviderRunReference {
	readonly signal: AbortSignal
}

export interface ProviderReconcileInput extends ProviderRunReference {
	readonly signal: AbortSignal
	/** Append a line to the run's log. */
	log?(line: string): Promise<void>
}

/** The latest state reported while reconciling a platform-owned run. */
export interface ProviderReconcileOutcome {
	readonly state: 'running' | 'succeeded' | 'failed'
	readonly exitCode?: number
	/** See `ProviderTerminalOutcome.artifactState`. */
	readonly artifactState?: 'complete' | 'incomplete' | 'not_applicable'
	/** The settled run was a preview: core projects it as a dry run. */
	readonly dryRun?: boolean
}

/** Write one secret value to provider-managed storage. */
export interface ProviderSecretPutInput {
	readonly environment: ProviderEnvironment
	readonly name: string
	readonly value: string
}

/** Remove one secret value from provider-managed storage. */
export interface ProviderSecretDeleteInput {
	readonly environment: ProviderEnvironment
	readonly name: string
}

/** Opaque reference persisted by core instead of the provider-managed secret value. */
export interface ProviderSecretPutResult {
	readonly valueRef: string
}

/** Optional edit-time secret storage owned by a provider. */
export interface ProviderManagedSecrets {
	put(input: ProviderSecretPutInput): Promise<ProviderSecretPutResult>
	delete(input: ProviderSecretDeleteInput): Promise<void>
}

/**
 * A namespace lifecycle failure an operator can act on.
 *
 * `code` is a STABLE identifier — a platform error code, or one this provider defines for a lifecycle
 * invariant — so core can record and a console can render the CLASS of a failure instead of matching
 * prose. `message` is the provider's own summary; `detail` carries the upstream's words VERBATIM.
 * Neither is safe to persist as-is: core redacts both before they reach a row or a log, because only
 * core knows what a credential looks like in this installation.
 */
export class ProviderNamespaceError extends Error {
	constructor(message: string, readonly code: string, readonly retryable: boolean, readonly detail?: string) {
		super(message)
		this.name = 'ProviderNamespaceError'
	}
}

/**
 * A provider-managed secret write the provider refuses on the app's own terms — a value naming a
 * service the app does not own, say. `message` carries the secret's name and the offending host,
 * never the value, so core may hand it to the caller as a 4xx.
 */
export class ProviderSecretError extends Error {
	constructor(message: string, readonly code: string) {
		super(message)
		this.name = 'ProviderSecretError'
	}
}

/** Persist a canonical namespace target immediately after one external mutation succeeds. */
export interface ProviderNamespaceEvents {
	checkpoint(namespace: ProviderDeploymentNamespace): Promise<void>
	/** A step boundary: Control checks the namespace lease and, for a deploy, the run's cancellation request. */
	boundary(): Promise<void>
}

/** One app environment assigned to a namespace, as its proxy routes it. */
export interface ProviderNamespaceMember {
	readonly appId: string
	readonly env: string
	readonly domain?: string
	/** See `ProviderEnvironment.crossOrigins`: the namespace proxy's entry for this member lists them. */
	readonly crossOrigins?: readonly string[]
	readonly artifact: ProviderEnvelope
	/**
	 * The secret the namespace proxy authenticates itself to this application environment with (ADR-0022 rule 5).
	 * Control generates it once and keeps it in its vault; absent when Control has no vault.
	 */
	readonly proxySecret?: string
	/**
	 * The origin of this environment's active Operations ingest DSN, never the DSN itself: a contract application's
	 * proxy admits it in `connect-src`, as the framework does. Absent while the environment has no active ingest.
	 */
	readonly operationsOrigin?: string
	/** See `ProviderEnvironment.access`: the proxy table of a contract application comes only from here. */
	readonly access?: ProviderApprovedAccess
}

/** One idempotent namespace lifecycle invocation. */
export interface ProviderNamespaceMutationInput {
	readonly namespace: ProviderDeploymentNamespace
	/** Every app environment assigned to the namespace, read under its lease. */
	readonly members: readonly ProviderNamespaceMember[]
	/**
	 * The installation's client logo for the pages the namespace's proxy answers with (ADR-0066), read from IAM for this
	 * mutation; absent or null shows the fabrika mark. A provider passes it only to a proxy that can parse it.
	 */
	readonly brand?: InstallationBrand | null
	readonly signal: AbortSignal
	readonly events: ProviderNamespaceEvents
}

/** `settled` is false while the rebuild is still in flight; core then hands it to a `reconcile` job. */
export interface ProviderNamespaceRepublishResult {
	readonly namespace: ProviderDeploymentNamespace
	readonly settled: boolean
}

/** Rebuild a ready namespace's entry point from its current members. */
export interface ProviderNamespaceRepublishInput extends ProviderNamespaceMutationInput {
	/** `started`: return once the rebuild is submitted. `active`: return once it is live. */
	readonly wait: 'started' | 'active'
}

/**
 * The `code` of a `ProviderNamespaceError` an update plan throws when the requested target changes
 * something the provider cannot move in place. Core answers it as a conflict that names the supported path.
 */
export const PROVIDER_NAMESPACE_IMMUTABLE = 'namespaceImmutable'

/**
 * The `code` of a `ProviderNamespaceError` an update apply throws when the live change MAY have been made
 * and is not confirmed. Any other failure means nothing changed. Applying the same plan again must converge.
 */
export const PROVIDER_NAMESPACE_UPDATE_UNCONFIRMED = 'namespaceUpdateUnconfirmed'

/** One provider-described change, safe to audit: names and values only, never a credential. */
export interface ProviderNamespaceChange {
	readonly field: string
	readonly from: string | null
	readonly to: string
}

/** The validated result of merging a requested target over the stored one. `change` is null for a no-op. */
export interface ProviderNamespaceUpdatePlan {
	readonly namespace: ProviderDeploymentNamespace
	readonly change: ProviderNamespaceChange | null
}

/** Apply one plan. `next` is the planned namespace, with the same coordinates as `namespace`. */
export interface ProviderNamespaceUpdateInput {
	readonly namespace: ProviderDeploymentNamespace
	readonly next: ProviderDeploymentNamespace
	/** The namespace an earlier, unconfirmed update planned; the live resources may already match it. */
	readonly unconfirmed?: ProviderDeploymentNamespace
	readonly signal: AbortSignal
}

/** In-place change of a settled namespace. */
export interface ProviderNamespaceUpdates {
	/**
	 * Merge `requested` — whose payload may name only what changes — over the stored `namespace` and
	 * validate the result. Pure. A change that cannot be made in place throws `PROVIDER_NAMESPACE_IMMUTABLE`.
	 */
	plan(namespace: ProviderDeploymentNamespace, requested: ProviderEnvelope): ProviderNamespaceUpdatePlan
	/** Move the live resources to `next` and return the target core stores. */
	apply(input: ProviderNamespaceUpdateInput): Promise<ProviderDeploymentNamespace>
}

/** One registration whose provider coordinates do not exist until namespace services are prepared. */
export interface ProviderRegistrationPreparationInput {
	readonly registration: ProviderRegistration
	readonly signal: AbortSignal
}

/** One provider-defined operator choice. Core does not interpret its id or description. */
export interface ProviderNamespacePreset {
	readonly id: string
	readonly label: string
	readonly description: string
	readonly requiresExclusiveApp: boolean
}

/** Provider-neutral coordinates plus opaque provider options for a namespace preview. */
export interface ProviderNamespacePlanInput {
	readonly id: string
	readonly env: string
	readonly preset: string
	readonly exclusiveAppId?: string
	readonly options?: JsonValue
}

/** One safe, human-readable provider fact. Values must never contain credentials. */
export interface ProviderNamespaceFact {
	readonly label: string
	readonly value: string
	/**
	 * Marks a fact that NAMES A LIVE PROVIDER RESOURCE, not a policy choice. Core deletes no provider
	 * resource, so removal has to tell the operator what it stopped tracking — and only the provider
	 * knows which of its facts is a real thing with an id. Absent means "not a resource"; a fact is
	 * marked only when its value identifies something that outlives the namespace row.
	 */
	readonly resource?: true
}

/**
 * One public host this namespace's own entry point answers on, with the listener port that publishes it.
 *
 * Only the provider knows how a host comes to exist — Zerops generates one per published HTTP port — and
 * core knows which of them an application environment already claims, so the provider names them and core
 * marks them. A namespace whose domains are bound out of band names none: the provider cannot see them.
 */
export interface ProviderNamespaceHost {
	readonly host: string
	readonly port: number
}

/** Provider-owned operator copy for a planned or persisted namespace. */
export interface ProviderNamespacePresentation {
	readonly preset: string
	readonly title: string
	readonly facts: readonly ProviderNamespaceFact[]
	readonly instructions: readonly string[]
	/** The hosts this namespace can serve, so an operator can name one as an environment's domain. */
	readonly hosts?: readonly ProviderNamespaceHost[]
}

/** A mutation-free preview that can be submitted unchanged to namespace creation. */
export interface ProviderNamespacePlan {
	readonly namespace: ProviderDeploymentNamespace
	readonly presentation: ProviderNamespacePresentation
}

/** Optional operator surface for providers that offer opinionated namespace presets. */
export interface ProviderNamespaceOperator {
	readonly presets: readonly ProviderNamespacePreset[]
	plan(input: ProviderNamespacePlanInput): ProviderNamespacePlan
	present(namespace: ProviderDeploymentNamespace): ProviderNamespacePresentation
}

/** The app-owned claims of one namespace whose resources Control is asked to confirm gone. */
export interface ProviderClaimedResourcesInput {
	readonly namespace: ProviderDeploymentNamespace
	readonly resourceKeys: readonly string[]
	readonly signal: AbortSignal
}

/** What the provider observed for one claimed resource. */
export interface ProviderClaimedResource {
	readonly resourceKey: string
	readonly exists: boolean
}

/** Optional placement lifecycle owned by providers that use deployment namespaces. */
export interface ProviderNamespaceCapabilities {
	normalize(namespace: ProviderDeploymentNamespace): ProviderDeploymentNamespace
	/** Namespace-owned resources that must be reserved before provisioning starts. */
	namespaceResourceClaims(namespace: ProviderDeploymentNamespace): readonly string[]
	/** App-owned resources derived from one canonical normalized registration. */
	registrationResourceClaims(registration: ProviderRegistration): readonly string[]
	/**
	 * Materialize app-owned provider resources and return their canonical coordinates.
	 * Core acquires every registration resource claim before invoking this mutation.
	 */
	prepareRegistration?(input: ProviderRegistrationPreparationInput): Promise<ProviderRegistration>
	provision(input: ProviderNamespaceMutationInput): Promise<ProviderDeploymentNamespace>
	reconcile(input: ProviderNamespaceMutationInput): Promise<ProviderDeploymentNamespace>
	/** Absent means the namespace has no entry point that follows its members. */
	republish?(input: ProviderNamespaceRepublishInput): Promise<ProviderNamespaceRepublishResult>
	/**
	 * Read-only: whether each claimed resource still exists, one answer per key. Throws when it cannot tell, so Control
	 * releases a claim only over a resource the provider confirmed gone. Absent means no claim can be released.
	 */
	claimedResources?(input: ProviderClaimedResourcesInput): Promise<readonly ProviderClaimedResource[]>
	/** Absent means the provider changes no namespace in place. */
	readonly updates?: ProviderNamespaceUpdates
	readonly operator?: ProviderNamespaceOperator
}

export interface ProviderAuthoring {
	/** The file NAMES (no `/`) that configure the provider's deploy; a workspace changes none of them, at any depth. */
	readonly protectedFiles: readonly string[]
}

/** One call on the service of a `dev` environment, between its bootstrap runs. */
export interface ProviderDevEnvironmentInput {
	readonly environment: ProviderEnvironment
	readonly signal: AbortSignal
}

/**
 * The service of a `dev` environment outside a run (ADR-0049): Control stops it after an idle period and starts it on
 * the next commit. Files the launcher wrote survive both.
 */
export interface ProviderDevEnvironments {
	stop(input: ProviderDevEnvironmentInput): Promise<void>
	start(input: ProviderDevEnvironmentInput): Promise<void>
}

/**
 * The control-plane capability bundle selected statically by one composition root.
 *
 * Core owns no provider registry. The selected provider validates registration envelopes and owns
 * every provider-specific deploy lifecycle capability.
 */
export interface ControlProvider {
	readonly id: string
	/** Absent means core stores the registration as submitted. */
	normalizeRegistration?(input: ProviderRegistrationInput): ProviderRegistration
	resolveSource?(input: ProviderSourceResolutionInput): Promise<ProviderSourceResolution>
	/**
	 * Mutation-free check of a candidate's compatibility with its placement. Control calls it before publishing the
	 * snapshot, under the namespace lease, on every publication attempt. The candidate is not yet approved access.
	 */
	validateAccess?(input: { readonly environment: ProviderEnvironment; readonly access: ProviderApprovedAccess }): void
	deploy(input: ProviderDeployInput): Promise<ProviderDeployOutcome>
	cancel?(input: ProviderCancelInput): Promise<ProviderCancelOutcome>
	reconcile?(input: ProviderReconcileInput): Promise<ProviderReconcileOutcome>
	readonly secrets?: ProviderManagedSecrets
	readonly namespaces?: ProviderNamespaceCapabilities
	/** MCP authoring (ADR-0049): an environment of this provider can be an authoring target. Absent means none can. */
	readonly authoring?: ProviderAuthoring
	/**
	 * Every application environment gets `FABRIKA_PROXY_SECRET`, with or without a namespace proxy: the provider's own
	 * hop to the application carries it (Cloudflare's Worker to its Durable Object, ADR-0065). Absent means only a
	 * namespace proxy's environments get one.
	 */
	readonly applicationHopSecret?: true
	/** Absent means the provider runs no `dev` environment, and Control refuses one. */
	readonly devEnvironments?: ProviderDevEnvironments
	/**
	 * Whether an environment at this approved access is served the ops channel through which Control reaches its object
	 * (ADR-0069), so its deploy gets `FABRIKA_OPS_KEY_DIGESTS`. The release gate is the provider's, so core keeps no
	 * release logic. Absent means no environment of this provider is.
	 */
	opsChannel?(access: ProviderApprovedAccess): boolean
	/** Absent means the provider deploys public sources only. */
	readonly source?: ProviderSourceCapabilities
	/**
	 * The variable names this artifact declares, so core can refuse one it would silently ignore
	 * ([ADR-0035](../../../docs/decisions/0035-the-platform-owns-the-application-iam-issuer.md)).
	 *
	 * OPTIONAL, and `undefined` is the honest answer rather than an empty set: a provider whose artifact
	 * names a config path in the repository cannot know what that config declares, and guessing would
	 * refuse a variable that works. A provider that CAN answer — one whose artifact is the compiled
	 * manifest — constrains what an operator may set.
	 */
	declaredVariables?(input: { readonly artifact: ProviderEnvelope }): readonly string[] | undefined
	/**
	 * The repository-relative directory this provider executes the application from, normalized as its execution
	 * normalizes it (`''` for the repository root), or null for a root execution refuses. Control reads the run's
	 * access snapshot there (ADR-0050). Absent means the repository root.
	 */
	applicationRoot?(source: ProviderSource): string | null
}
