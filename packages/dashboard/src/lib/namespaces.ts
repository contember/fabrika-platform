import type {
	AppEnvDto,
	DeploymentNamespaceDetailDto,
	DeploymentNamespaceDto,
	DeploymentNamespaceFactDto,
	DeploymentNamespaceState,
	ProviderEnvelopeDto,
	PutAppEnvRequest,
} from './api'
import { isJsonValue } from './json'

/** The operator-visible failure: the class control recorded, its redacted message, and what to do next. */
export interface NamespaceFailureView {
	/** The provider's own identifier, shown verbatim: it is what a release note or an issue names. */
	readonly code: string | null
	readonly message: string
	readonly hint: string | null
}

/** Control's code for an update whose live outcome is unknown; mirrors `PROVIDER_NAMESPACE_UPDATE_UNCONFIRMED`. */
const NAMESPACE_UPDATE_UNCONFIRMED = 'namespaceUpdateUnconfirmed'

/** A ready placement, or one whose last target change must be retried, accepts `namespaces.update`. */
export function canUpdateNamespace(namespace: DeploymentNamespaceDto): boolean {
	return namespace.state === 'ready' || (namespace.state === 'failed' && namespace.lastErrorCode === NAMESPACE_UPDATE_UNCONFIRMED)
}

/**
 * What the target editor starts from: the target an unconfirmed update was moving to, so applying it
 * unchanged finishes that update (even in a session that never saw the request), else the stored target.
 */
export function namespaceUpdateSeed(namespace: DeploymentNamespaceDto): ProviderEnvelopeDto {
	return namespace.unconfirmedTarget ?? namespace.target
}

/**
 * Hints only where the class actually tells an operator what to do. Anything else gets no hint rather
 * than an invented one: the message control stored is the provider's, and it is usually more specific.
 */
const NAMESPACE_FAILURE_HINTS: Readonly<Record<string, string>> = {
	insufficientPermissions: "The platform token may not perform this operation. Check the integration token's grants before retrying.",
	serviceStackIsNotHttp: 'The proxy has no deployed HTTP port yet. Reconcile once its first deploy has finished.',
	internal: 'The provider reported no class for this failure. The control plane log holds the full, redacted cause.',
	[NAMESPACE_UPDATE_UNCONFIRMED]:
		'The live change may or may not have applied. Apply the planned target again (the editor starts from it), and the retry converges either way.',
}

/**
 * Read a failed placement's record. Three different provider failures used to look identical here
 * (backlog 72); the code is what tells them apart, and a row written before the codes existed carries
 * a message and no code.
 */
export function namespaceFailure(namespace: DeploymentNamespaceDto): NamespaceFailureView | null {
	if (namespace.lastError === null) return null
	const code = namespace.lastErrorCode
	return { code, message: namespace.lastError, hint: code === null ? null : NAMESPACE_FAILURE_HINTS[code] ?? null }
}

/**
 * The provider resources a removal leaves behind: the facts the provider MARKED as naming a live
 * resource, and only those. Fabrika deletes none of them (ADR-0034), so this is what an operator is
 * told to clean up by hand. A policy fact such as the core package is not one, and an unmarked
 * presentation means there is nothing to say rather than a list to guess at.
 */
export function retainedNamespaceResources(namespace: DeploymentNamespaceDetailDto): readonly DeploymentNamespaceFactDto[] {
	return (namespace.presentation?.facts ?? []).filter((fact) => fact.resource === true)
}

/** Poll interval while a placement is still settling. The work is minutes long; two seconds is plenty. */
const NAMESPACE_POLL_INTERVAL_MS = 2_000

export type NamespacePollScheduler = (callback: () => void, delayMs: number) => () => void

/** The provider mutation runs behind the queue, so a non-terminal state means work is still in flight. */
export function isNamespaceSettling(state: DeploymentNamespaceState): boolean {
	return state === 'pending' || state === 'provisioning'
}

/**
 * Keep a settling placement's view fresh without a caller staying connected to the mutation: the whole
 * point of provisioning behind the queue. Returns the cancel function the effect cleans up with.
 */
export function scheduleNamespacePoll(
	state: DeploymentNamespaceState,
	invalidate: () => void,
	schedule: NamespacePollScheduler,
): () => void {
	if (!isNamespaceSettling(state)) return () => undefined
	return schedule(invalidate, NAMESPACE_POLL_INTERVAL_MS)
}

/** Placements that can own this exact app environment without changing provider coordinates. */
export function compatibleNamespaces(
	appId: string,
	environment: Pick<AppEnvDto, 'env' | 'provider'>,
	namespaces: readonly DeploymentNamespaceDto[],
): DeploymentNamespaceDto[] {
	return namespaces.filter((namespace) =>
		namespace.state === 'ready'
		&& namespace.env === environment.env
		&& namespace.provider === environment.provider
		&& (namespace.exclusiveAppId === null || namespace.exclusiveAppId === appId)
	)
}

/** Change placement coordinates without interpreting or rebuilding provider envelopes. */
export function namespaceAssignmentRequest(environment: AppEnvDto, namespaceId: string | null): PutAppEnvRequest {
	return {
		domain: environment.domain,
		publicOrigin: environment.publicOrigin,
		triggerRef: environment.triggerRef,
		namespaceId,
		target: environment.target,
		artifact: environment.artifact,
	}
}

export type NamespaceTargetParse =
	| { readonly ok: true; readonly target: ProviderEnvelopeDto }
	| { readonly ok: false; readonly error: string }

/**
 * Read an operator-edited target envelope. Only its SHAPE is checked here: the provider decides what may
 * change, and control answers a refused change with the supported path.
 */
export function parseNamespaceTarget(text: string, provider: string): NamespaceTargetParse {
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		return { ok: false, error: 'The target is not valid JSON.' }
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return { ok: false, error: 'The target must be a JSON object with provider, version and payload.' }
	}
	const envelopeProvider: unknown = Reflect.get(parsed, 'provider')
	const version: unknown = Reflect.get(parsed, 'version')
	const payload: unknown = Reflect.get(parsed, 'payload')
	if (envelopeProvider !== provider) {
		return { ok: false, error: `The target must stay on provider ${provider}.` }
	}
	if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
		return { ok: false, error: 'The target version must be a positive integer.' }
	}
	if (payload === undefined || !isJsonValue(payload)) {
		return { ok: false, error: 'The target payload must be JSON.' }
	}
	return { ok: true, target: { provider, version, payload } }
}
