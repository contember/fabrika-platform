import type { ProviderRunEvents } from './deploy'
import type { ProviderEnvelope } from './json'

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

/** Persisted deploy data for one app environment. */
export interface ProviderEnvironment {
	readonly appId: string
	readonly env: string
	readonly domain?: string
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
	readonly dryRun: boolean
	readonly signal: AbortSignal
	readonly events: ProviderRunEvents
}

/** A terminal provider operation result. */
export interface ProviderTerminalOutcome {
	readonly state: 'succeeded' | 'failed'
	readonly exitCode?: number
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
}
