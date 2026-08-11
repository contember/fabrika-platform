import type { JsonValue, ProviderEnvelope } from './json'

/** One provider-owned unit of deploy work. Core treats `kind` as an open string. */
export interface ProviderJobSpec {
	readonly id: string
	readonly kind: string
	readonly description: string
	readonly dependsOn?: readonly string[]
}

/** Shared deploy state used for whole runs and individual steps. */
export type ProviderRunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'

/** A provider job plus its observed runtime state. */
export interface ProviderDeployStep {
	readonly spec: ProviderJobSpec
	readonly status: ProviderRunStatus
	readonly error?: string
	readonly startedAt?: number
	readonly finishedAt?: number
}

/** The ordered work derived by a provider before it starts mutation. */
export interface ProviderDeployPlan {
	readonly appId: string
	readonly env: string
	readonly steps: readonly ProviderJobSpec[]
}

/** A provider-owned deploy session opened from one target and artifact. */
export interface ProviderDeploySession {
	readonly plan: ProviderDeployPlan
	execute(stepId: string): Promise<void>
}

/** The final provider-neutral representation of a deploy execution. */
export interface ProviderDeployResult {
	readonly appId: string
	readonly env: string
	readonly status: ProviderRunStatus
	readonly plan: ProviderDeployPlan
	readonly steps: readonly ProviderDeployStep[]
}

/** Events whose persistence and presentation belong to the control plane. */
export interface ProviderRunEvents {
	log(line: string): void
	/** Atomically persist the external operation id and, when supplied, its credential-free resume state. */
	externalId(id: string, state?: JsonValue): Promise<void>
	/** Replace the credential-free resume state while this run remains active. */
	checkpoint(state: JsonValue): Promise<void>
}

/** Complete platform-owned runtime state. A null value removes the key from persistent targets. */
export type ProviderManagedEnvironment = Readonly<Record<string, string | null>>

/** Universal inputs shared by every provider deploy. */
export interface ProviderRunBase {
	readonly appId: string
	readonly env: string
	readonly domain?: string
	/**
	 * Every origin IAM may hand this app a session at, as known by the control plane. App-wide rather
	 * than per-environment, because IAM's registry is keyed by app id and a deploy of one environment
	 * must not un-register the others.
	 */
	readonly returnOrigins?: readonly string[]
	readonly cwd: string
	readonly secrets: Readonly<Record<string, string>>
	readonly vars: Readonly<Record<string, string>>
	/** Platform-owned runtime configuration, separate from operator-managed application vars. */
	readonly managedEnvironment: ProviderManagedEnvironment
	readonly dryRun: boolean
	readonly signal: AbortSignal
	readonly events: ProviderRunEvents
}

/** The run shape seen by a provider after its envelopes have been decoded. */
export interface TypedProviderRun<TTarget, TArtifact> extends ProviderRunBase {
	readonly target: TTarget
	readonly artifact: TArtifact
}

/** The provider-neutral run shape stored and passed by the control plane. */
export interface RuntimeProviderRun extends ProviderRunBase {
	readonly target: ProviderEnvelope
	readonly artifact: ProviderEnvelope
}
