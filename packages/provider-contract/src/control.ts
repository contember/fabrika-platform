import type { ProviderManagedEnvironment, ProviderRunEvents } from './deploy'
import type { JsonValue, ProviderEnvelope } from './json'

/** Provider-neutral coordinates for obtaining one app revision. */
export interface ProviderSource {
	readonly repoUrl: string
	readonly ref: string
	readonly workerDir?: string
	readonly buildCommand?: string
	readonly configPath?: string
	readonly githubConnectionId?: string
	readonly githubInstallationId?: number
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

/** Persisted deploy data for one app environment. */
export interface ProviderEnvironment {
	readonly appId: string
	readonly env: string
	readonly domain?: string
	/** Canonical externally reachable HTTP(S) origin; independent of provider domain routing. */
	readonly publicOrigin?: string
	readonly namespace?: ProviderDeploymentNamespace
	readonly target: ProviderEnvelope
	readonly artifact: ProviderEnvelope
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
	readonly signal: AbortSignal
}

/** The exact source revision a provider resolved before starting deploy work. */
export interface ProviderSourceResolution {
	readonly commitSha: string
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
	 * Every origin IAM may hand this app a session at (ADR-0021). App-wide, not per-environment:
	 * IAM's registry is keyed by app id, so the set is assembled from every environment of the app.
	 * Absent when the app has no public origin at all, which leaves IAM's registry untouched.
	 */
	readonly returnOrigins?: readonly string[]
	readonly dryRun: boolean
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

/** A terminal provider operation result. */
export interface ProviderTerminalOutcome {
	readonly state: 'succeeded' | 'failed'
	readonly exitCode?: number
	/** Whether provider-local release artifacts reached Operations. */
	readonly artifactState?: 'complete' | 'incomplete' | 'not_applicable'
}

/** A platform-owned run that can be cancelled or reconciled. */
export interface ProviderRunReference {
	readonly runId: string
	readonly externalId: string
	readonly environment: ProviderEnvironment
	/** Credential-free provider-owned progress needed to resume the external operation. */
	readonly providerState?: JsonValue
}

export type ProviderCancelInput = ProviderRunReference

export interface ProviderReconcileInput extends ProviderRunReference {
	/** See `ProviderDeployInput.returnOrigins`; a provider that finishes a resumed deploy projects the same set. */
	readonly returnOrigins?: readonly string[]
	/** Persist a credential-free recovery checkpoint before the next irreversible provider call. */
	checkpoint(state: JsonValue): Promise<void>
}

/** The latest state reported while reconciling a platform-owned run. */
export interface ProviderReconcileOutcome {
	readonly state: 'running' | 'succeeded' | 'failed'
	readonly exitCode?: number
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

/** Persist a canonical namespace target immediately after one external mutation succeeds. */
export interface ProviderNamespaceEvents {
	checkpoint(namespace: ProviderDeploymentNamespace): Promise<void>
}

/** One idempotent namespace lifecycle invocation. */
export interface ProviderNamespaceMutationInput {
	readonly namespace: ProviderDeploymentNamespace
	readonly signal: AbortSignal
	readonly events: ProviderNamespaceEvents
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
	readonly operator?: ProviderNamespaceOperator
}

/**
 * The control-plane capability bundle selected statically by one composition root.
 *
 * Core owns no provider registry. The selected provider validates registration envelopes and owns
 * every provider-specific deploy lifecycle capability.
 */
export interface ControlProvider {
	readonly id: string
	normalizeRegistration(input: ProviderRegistrationInput): ProviderRegistration
	resolveSource?(input: ProviderSourceResolutionInput): Promise<ProviderSourceResolution>
	deploy(input: ProviderDeployInput): Promise<ProviderTerminalOutcome>
	cancel?(input: ProviderCancelInput): Promise<void>
	reconcile?(input: ProviderReconcileInput): Promise<ProviderReconcileOutcome>
	readonly secrets?: ProviderManagedSecrets
	readonly namespaces?: ProviderNamespaceCapabilities
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
}
