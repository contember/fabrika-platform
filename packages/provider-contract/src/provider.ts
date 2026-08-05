import type { ProviderDeploySession, RuntimeProviderRun, TypedProviderRun } from './deploy'
import type { ProviderCodec, ProviderEnvelope } from './json'

/** A provider implementation with its target and artifact types preserved. */
export interface ProviderDefinition<TId extends string, TTarget, TArtifact> {
	readonly id: TId
	readonly target: ProviderCodec<TTarget>
	readonly artifact: ProviderCodec<TArtifact>
	open(run: TypedProviderRun<TTarget, TArtifact>): Promise<ProviderDeploySession>
}

/** The opaque interface consumed by a provider-specific composition root. */
export interface RuntimeProvider {
	readonly id: string
	open(run: RuntimeProviderRun): Promise<ProviderDeploySession>
}

/**
 * A provider module exposes typed encoders to its authoring side and an opaque runtime adapter to
 * its control-plane side.
 */
export interface ProviderModule<TId extends string, TTarget, TArtifact> {
	readonly id: TId
	encodeTarget(value: TTarget): ProviderEnvelope
	encodeArtifact(value: TArtifact): ProviderEnvelope
	readonly runtime: RuntimeProvider
}

const decodeEnvelope = <T>(kind: string, provider: string, envelope: ProviderEnvelope, codec: ProviderCodec<T>): T => {
	if (envelope.provider !== provider) {
		throw new Error(`${kind} belongs to provider "${envelope.provider}", expected "${provider}"`)
	}
	if (envelope.version !== codec.version) {
		throw new Error(`${kind} schema version ${envelope.version} is not supported by provider "${provider}"`)
	}
	return codec.decode(envelope.payload)
}

/**
 * Closes over a provider's concrete types and exposes only JSON envelopes at runtime.
 *
 * A new provider calls this factory in its own package. No central platform map or discriminated
 * union changes when a provider id is added.
 */
export const createProvider = <TId extends string, TTarget, TArtifact>(
	definition: ProviderDefinition<TId, TTarget, TArtifact>,
): ProviderModule<TId, TTarget, TArtifact> => {
	const envelope = <T>(codec: ProviderCodec<T>, value: T): ProviderEnvelope => ({
		provider: definition.id,
		version: codec.version,
		payload: codec.encode(value),
	})

	return {
		id: definition.id,
		encodeTarget: (value) => envelope(definition.target, value),
		encodeArtifact: (value) => envelope(definition.artifact, value),
		runtime: {
			id: definition.id,
			open: async (run) =>
				definition.open({
					appId: run.appId,
					env: run.env,
					domain: run.domain,
					returnOrigins: run.returnOrigins,
					cwd: run.cwd,
					secrets: run.secrets,
					vars: run.vars,
					managedEnvironment: run.managedEnvironment,
					dryRun: run.dryRun,
					signal: run.signal,
					events: run.events,
					target: decodeEnvelope('target', definition.id, run.target, definition.target),
					artifact: decodeEnvelope('artifact', definition.id, run.artifact, definition.artifact),
				}),
		},
	}
}
