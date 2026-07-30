import type { ProviderManagedEnvironment, ProviderRunEvents } from './deploy'
import type { JsonValue, ProviderEnvelope } from './json'

/** Provider-neutral coordinates for obtaining one app revision. */
export interface ProviderSource {
	readonly repoUrl: string
	readonly ref: string
	readonly workerDir?: string
	readonly buildCommand?: string
	readonly configPath?: string
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

/** One control-plane deploy invocation. */
export interface ProviderDeployInput {
	readonly runId: string
	readonly app: ProviderApp
	readonly environment: ProviderEnvironment
	readonly secrets: Readonly<Record<string, string>>
	readonly vars: Readonly<Record<string, string>>
	/** Platform-owned runtime configuration, separate from operator-managed application vars. */
	readonly managedEnvironment: ProviderManagedEnvironment
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
}

export type ProviderCancelInput = ProviderRunReference
export type ProviderReconcileInput = ProviderRunReference

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
}

/** Provider-owned operator copy for a planned or persisted namespace. */
export interface ProviderNamespacePresentation {
	readonly preset: string
	readonly title: string
	readonly facts: readonly ProviderNamespaceFact[]
	readonly instructions: readonly string[]
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
	deploy(input: ProviderDeployInput): Promise<ProviderTerminalOutcome>
	cancel?(input: ProviderCancelInput): Promise<void>
	reconcile?(input: ProviderReconcileInput): Promise<ProviderReconcileOutcome>
	readonly secrets?: ProviderManagedSecrets
	readonly namespaces?: ProviderNamespaceCapabilities
}
