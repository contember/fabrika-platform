import { isStructuralError } from '@fabrika/app'
import type { AuthContext } from '@fabrika/auth'
import { API_KEY_PREFIX } from '@fabrika/auth-core'
import type {
	AdoptDeploymentNamespaceRequest,
	CreateDeploymentNamespaceRequest,
	DeploymentNamespaceDetailDto,
	DeploymentNamespaceDto,
	DeploymentNamespaceHostDto,
	DeploymentNamespaceListResponse,
	DeploymentNamespacePresentationDto,
	PlanDeploymentNamespaceRequest,
	PlanDeploymentNamespaceResponse,
	RemoveDeploymentNamespaceResponse,
} from '@fabrika/control-contract'
import type { DeployLocks, JobQueue } from '@fabrika/platform'
import {
	type ControlProvider,
	type ProviderDeploymentNamespace,
	type ProviderNamespaceCapabilities,
	ProviderNamespaceError,
	type ProviderNamespaceHost,
	type ProviderNamespaceMember,
	type ProviderNamespaceMutationInput,
	type ProviderNamespacePresentation,
	type ProviderNamespaceRepublishInput,
} from '@fabrika/provider-contract'
import { type ControlRepositories, type DeploymentNamespaceRow, type DeploymentNamespaceState, NamespaceResourceClaimConflictError } from '../db'
import { acquireLease, type Lease, type LeaseClock, namespaceLeaseKey } from '../lease'
import type { ControlJobMessage, NamespaceJobMessage, NamespaceJobMutation } from '../run-lifecycle'
import { fail } from './domain'
import { parseStoredEnvelope } from './provider-envelope'

/** Repairs the durable-checkpoint/queue-send crash gap; the namespace lease makes duplicate deliveries harmless. */
export async function enqueueUnsettledNamespaces(
	registry: Pick<ControlRepositories['registry'], 'listDeploymentNamespaces'>,
	queue: JobQueue<ControlJobMessage>,
): Promise<void> {
	for (const namespace of await registry.listDeploymentNamespaces()) {
		if (namespace.state === 'provisioning') await queue.send({ kind: 'namespace', namespaceId: namespace.id, mutation: 'reconcile' })
	}
}

/**
 * Republish one deployment namespace's proxy manifest from the registry.
 *
 * The proxy is the only enforcement point (ADR-0022), so its manifest — not the registry — is the live
 * authorization state; every registry change the manifest routes on has to reach it.
 */
export type NamespaceProxyChanged = (namespaceId: string) => Promise<void>

export interface NamespaceUseCaseContext {
	readonly repositories: ControlRepositories
	readonly provider: ControlProvider
	readonly signal: AbortSignal
	readonly auth: AuthContext
	readonly queue: JobQueue<ControlJobMessage>
	readonly namespaceProxyChanged?: NamespaceProxyChanged
}

/**
 * Push the registry's current routing to each named namespace proxy.
 *
 * EVERY id is attempted before anything is reported: a move touches two proxies, and stopping at the
 * first failure would leave the second silently stale — the exact shape of the bug this hook exists for.
 * A failure leaves the registry change in place (the row is already the truth) and names only the
 * namespaces; the cause is redacted before it reaches the log.
 */
export async function syncChangedNamespaceProxies(
	hook: NamespaceProxyChanged | undefined,
	namespaceIds: Iterable<string>,
): Promise<void> {
	if (hook === undefined) return
	const failed: string[] = []
	for (const namespaceId of new Set(namespaceIds)) {
		try {
			await hook(namespaceId)
		} catch (cause) {
			failed.push(namespaceId)
			const described = cause instanceof Error ? cause.message : 'unknown error'
			console.error(`namespace proxy sync failed for ${namespaceId}: ${redactNamespaceErrorText(described)}`)
		}
	}
	if (failed.length > 0) {
		fail(502, `the proxy manifest did not publish for deployment namespace ${failed.join(', ')} — reconcile the namespace`)
	}
}

function toNamespaceDto(row: DeploymentNamespaceRow): DeploymentNamespaceDto {
	return {
		id: row.id,
		env: row.env,
		provider: row.provider,
		exclusiveAppId: row.exclusive_app_id,
		target: parseStoredEnvelope(row.provider_target_json, `target for namespace ${row.id}`),
		state: row.state,
		...decodeNamespaceError(row.last_error),
		createdAt: row.created_at,
	}
}

// ── The operator-visible failure (backlog 72) ─────────────────────────────────

const ERROR_MESSAGE_MAX_LENGTH = 300
const ERROR_CODE_MAX_LENGTH = 64
const ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/
const STORED_ERROR_PATTERN = /^([A-Za-z][A-Za-z0-9_.-]*): ([\s\S]+)$/
/** The code for a failure that was not a typed provider one — the class is unknown, not absent. */
const INTERNAL_ERROR_CODE = 'internal'

/**
 * `last_error` carries `<code>: <message>` in ONE column. The code charset excludes the separator and
 * every space, so the parse below is unambiguous, and a row written before the codes existed decodes as
 * a message with no code rather than as a mis-split one.
 */
export function encodeNamespaceError(code: string, message: string): string {
	return `${code}: ${message}`
}

export function decodeNamespaceError(stored: string | null): { lastError: string | null; lastErrorCode: string | null } {
	if (stored === null) return { lastError: null, lastErrorCode: null }
	const match = STORED_ERROR_PATTERN.exec(stored)
	const code = match?.[1]
	const message = match?.[2]
	if (code === undefined || message === undefined) return { lastError: stored, lastErrorCode: null }
	return { lastError: message, lastErrorCode: code }
}

/**
 * Make a provider failure safe to store and to log. Redaction, NOT deletion: the sentence an operator
 * needs and a value that must never be persisted arrive in the same string, and discarding both is what
 * made three different live failures indistinguishable (backlog 72).
 *
 * Five hazards, each seen in this repository: userinfo in a clone URL (`x-access-token:<token>@`), the
 * signed query string of an upload URL, a `px_` credential, a signed token, and an environment
 * assignment quoted back at us (`CLOUDFLARE_API_TOKEN=…`).
 *
 * `cap` bounds the result for the ROW, which is a column an operator reads; the LOG takes it uncapped,
 * because truncating the cause is the failure mode this whole projection exists to end.
 */
export function redactNamespaceErrorText(text: string, options: { cap?: boolean } = {}): string {
	const redacted = text
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1')
		.replace(/(https?:\/\/[^\s?#]*)\?\S*/gi, '$1?***')
		.replace(new RegExp(`${API_KEY_PREFIX}[A-Za-z0-9_-]+`, 'g'), `${API_KEY_PREFIX}***`)
		.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '***')
		.replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '***')
		.replace(/\b([A-Z][A-Z0-9_]{2,})=\S+/g, '$1=***')
	if (options.cap === false || redacted.length <= ERROR_MESSAGE_MAX_LENGTH) return redacted
	return `${redacted.slice(0, ERROR_MESSAGE_MAX_LENGTH)}…`
}

/** A provider code has to survive the round trip above; a malformed one is a provider bug, not a class. */
const namespaceErrorCode = (code: string): string =>
	code.length <= ERROR_CODE_MAX_LENGTH && ERROR_CODE_PATTERN.test(code) ? code : INTERNAL_ERROR_CODE

/**
 * Recognize the typed failure STRUCTURALLY as well as by identity. A duplicated
 * `@fabrika/provider-contract` in one installation's module graph would make `instanceof` false for a
 * genuine provider error and silently turn every failure back into `internal` — the exact blindness
 * backlog 72 is about.
 */
function asProviderNamespaceError(cause: unknown): ProviderNamespaceError | null {
	if (cause instanceof ProviderNamespaceError) return cause
	if (!(cause instanceof Error) || cause.name !== 'ProviderNamespaceError') return null
	const code = Reflect.get(cause, 'code')
	if (typeof code !== 'string') return null
	const detail = Reflect.get(cause, 'detail')
	return new ProviderNamespaceError(cause.message, code, Reflect.get(cause, 'retryable') === true, typeof detail === 'string' ? detail : undefined)
}

/**
 * What the row records and what the log records. The row gets a stable class and a bounded, redacted
 * message; the log gets the same text UNCAPPED and, for an untyped cause, everything the cause said.
 * Neither is ever the error OBJECT: a cause can carry a clone URL with an embedded token.
 */
function namespaceFailure(cause: unknown, mutation: NamespaceJobMutation): { code: string; message: string; log: string } {
	const generic = `namespace ${mutation} failed`
	const typed = asProviderNamespaceError(cause)
	if (typed !== null) {
		const detail = typed.detail === undefined || typed.detail.trim() === '' ? '' : ` — ${typed.detail}`
		const full = `${typed.message}${detail}`
		// Redaction can empty a message that was nothing but a credential; the encoding still has to be total.
		const message = redactNamespaceErrorText(full) || generic
		return {
			code: namespaceErrorCode(typed.code),
			message,
			log: `${redactNamespaceErrorText(full, { cap: false })}${typed.retryable ? ' (retryable)' : ''}`,
		}
	}
	const described = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
	return { code: INTERNAL_ERROR_CODE, message: generic, log: redactNamespaceErrorText(described, { cap: false }) }
}

/**
 * Control's OWN namespace invariants, coded here so a broken checkpoint is never reported under a
 * provider's vocabulary. The class is contract-level, so a provider passes it through untouched.
 */
const namespaceCheckpointInvariant = (message: string): ProviderNamespaceError => new ProviderNamespaceError(message, 'checkpointInvariant', false)

function namespacePresentation(c: NamespaceUseCaseContext, row: DeploymentNamespaceRow): ProviderNamespacePresentation | null {
	const operator = c.provider.namespaces?.operator
	if (operator === undefined) return null
	try {
		return operator.present(toProviderNamespace(row))
	} catch (cause) {
		fail(400, cause instanceof Error ? cause.message : 'invalid namespace presentation')
	}
}

/** Projected field by field: the hosts are answered joined with what takes them, not raw beside them. */
function toPresentationDto(presentation: ProviderNamespacePresentation): DeploymentNamespacePresentationDto {
	return {
		preset: presentation.preset,
		title: presentation.title,
		facts: presentation.facts,
		instructions: presentation.instructions,
	}
}

function toNamespaceDetail(c: NamespaceUseCaseContext, row: DeploymentNamespaceRow): DeploymentNamespaceDetailDto {
	const presentation = namespacePresentation(c, row)
	return { ...toNamespaceDto(row), presentation: presentation === null ? null : toPresentationDto(presentation) }
}

/**
 * What the namespace can serve, and what already sits on it.
 *
 * The provider names the hosts because only it knows how they come to exist; control marks the taken
 * ones because only it knows the registrations. The join is by DOMAIN, which is exactly what the proxy
 * manifest routes on, so a host reads `free` here precisely when it is available to the next `--domain`.
 */
async function namespaceHosts(
	c: NamespaceUseCaseContext,
	row: DeploymentNamespaceRow,
	hosts: readonly ProviderNamespaceHost[] | undefined,
): Promise<readonly DeploymentNamespaceHostDto[] | undefined> {
	if (hosts === undefined || hosts.length === 0) return undefined
	const takenBy = new Map<string, { appId: string; environment: string }>()
	for (const environment of await c.repositories.registry.listAppEnvsByNamespace(row.id)) {
		const domain = environment.domain
		if (domain === null || domain === '') continue
		takenBy.set(domain.toLowerCase(), { appId: environment.app_id, environment: environment.env })
	}
	return hosts.map((entry) => {
		const taken = takenBy.get(entry.host.toLowerCase())
		return { host: entry.host, port: entry.port, ...(taken === undefined ? {} : { takenBy: taken }) }
	})
}

function toProviderNamespace(row: DeploymentNamespaceRow): ProviderDeploymentNamespace {
	return {
		id: row.id,
		env: row.env,
		...(row.exclusive_app_id === null ? {} : { exclusiveAppId: row.exclusive_app_id }),
		target: parseStoredEnvelope(row.provider_target_json, `target for namespace ${row.id}`),
	}
}

function sameCoordinates(actual: ProviderDeploymentNamespace, expected: ProviderDeploymentNamespace, providerId: string): boolean {
	return actual.id === expected.id
		&& actual.env === expected.env
		&& actual.exclusiveAppId === expected.exclusiveAppId
		&& actual.target.provider === providerId
}

function normalizeNamespace(
	capabilities: ProviderNamespaceCapabilities,
	providerId: string,
	namespace: ProviderDeploymentNamespace,
): ProviderDeploymentNamespace {
	try {
		const normalized = capabilities.normalize(namespace)
		if (!sameCoordinates(normalized, namespace, providerId)) fail(400, 'provider returned a namespace for different coordinates')
		return normalized
	} catch (cause) {
		if (isStructuralError(cause)) throw cause
		fail(400, cause instanceof Error ? cause.message : 'invalid deployment namespace')
	}
}

function namespaceResourceClaims(capabilities: ProviderNamespaceCapabilities, namespace: ProviderDeploymentNamespace): readonly string[] {
	try {
		return capabilities.namespaceResourceClaims(namespace)
	} catch (cause) {
		fail(400, cause instanceof Error ? cause.message : 'invalid namespace resource claims')
	}
}

async function namespaceCandidate(
	c: NamespaceUseCaseContext,
	id: string,
	input: CreateDeploymentNamespaceRequest | AdoptDeploymentNamespaceRequest,
): Promise<ProviderDeploymentNamespace> {
	const capabilities = c.provider.namespaces
	if (capabilities === undefined) fail(409, `provider ${c.provider.id} does not support deployment namespaces`)
	if (input.exclusiveAppId !== undefined && input.exclusiveAppId !== null && await c.repositories.registry.getApp(input.exclusiveAppId) === null) {
		fail(404, 'exclusive app not found')
	}
	return normalizeNamespace(capabilities, c.provider.id, {
		id,
		env: input.env,
		...(input.exclusiveAppId === undefined || input.exclusiveAppId === null ? {} : { exclusiveAppId: input.exclusiveAppId }),
		target: input.target,
	})
}

/** What one namespace job did. EVERY value is a HANDLED message — the consumer acks and never retries. */
export interface NamespaceJobResult {
	readonly namespaceId: string
	readonly status: 'ready' | 'failed' | 'skipped' | 'deferred'
}

export interface NamespaceJobDeps {
	readonly repositories: ControlRepositories
	readonly provider: ControlProvider
	readonly lock: DeployLocks
	readonly leaseClock?: LeaseClock
}

/**
 * Persist one namespace row as the holder of its lease; a write the fence refused ends the lease. Only a
 * job's `claim` moves a `pending` row: any other write keeps an operator's requeue for the queued job.
 */
async function writeNamespace(
	repositories: ControlRepositories,
	lease: Lease,
	row: DeploymentNamespaceRow,
	namespace: ProviderDeploymentNamespace,
	state: DeploymentNamespaceState,
	options: { lastError?: string; claim?: true } = {},
): Promise<void> {
	lease.assertWritten(
		await repositories.registry.writeDeploymentNamespace({
			id: row.id,
			createdAt: row.created_at,
			fence: lease.fence(),
			providerTargetJson: JSON.stringify(namespace.target),
			state,
			lastError: options.lastError ?? null,
			claim: options.claim === true,
		}),
	)
}

/** Every app environment the namespace's entry point routes, read under its lease. */
async function namespaceMembers(repositories: ControlRepositories, namespaceId: string): Promise<ProviderNamespaceMember[]> {
	return (await repositories.registry.listAppEnvsByNamespace(namespaceId)).map((row) => ({
		appId: row.app_id,
		env: row.env,
		...(row.domain === null ? {} : { domain: row.domain }),
		artifact: parseStoredEnvelope(row.provider_artifact_json, `artifact for ${row.app_id}/${row.env}`),
	}))
}

/**
 * Run one queued namespace mutation.
 *
 * The state guard is what makes redelivery safe: a namespace that already settled (`ready`/`failed`),
 * belongs to another provider, or no longer exists is a NO-OP, while one left `provisioning` by a
 * crashed worker is RESUMED — the provider's checkpoints exist precisely so a re-run picks up where it
 * stopped instead of repeating the work.
 *
 * The lease serializes two workers against one namespace; `control` runs more than one container, so
 * the sequential in-process consumer is not on its own enough.
 */
export async function runNamespaceJob(deps: NamespaceJobDeps, message: NamespaceJobMessage): Promise<NamespaceJobResult> {
	const skipped: NamespaceJobResult = { namespaceId: message.namespaceId, status: 'skipped' }
	const runnable = (row: DeploymentNamespaceRow | null): row is DeploymentNamespaceRow =>
		row !== null && row.provider === deps.provider.id && (row.state === 'pending' || row.state === 'provisioning')
	if (!runnable(await deps.repositories.registry.getDeploymentNamespace(message.namespaceId))) return skipped
	const lease = await acquireLease(deps.lock, namespaceLeaseKey(message.namespaceId), deps.leaseClock)
	if (lease === null) return { namespaceId: message.namespaceId, status: 'deferred' }
	try {
		// Re-read UNDER the lease, as `executeDeploy` re-verifies its run: the first read raced whoever held
		// it, so both the guard and the target handed to the provider have to come from after the acquire.
		const row = await deps.repositories.registry.getDeploymentNamespace(message.namespaceId)
		lease.assertHeld()
		if (!runnable(row)) return skipped
		return { namespaceId: row.id, status: await mutateNamespace(deps, row, message.mutation, lease) }
	} finally {
		await lease.release()
	}
}

type NamespaceMutationStatus = 'ready' | 'failed' | 'skipped'

/**
 * The provider mutation itself. It has exactly ONE caller — the job above — so a provider refusal is a
 * HANDLED outcome recorded on the row, not a thrown 502: retrying an unrecoverable provider error just
 * burns the retry budget, and the row already carries what an operator reads.
 */
async function mutateNamespace(
	deps: NamespaceJobDeps,
	row: DeploymentNamespaceRow,
	mutation: NamespaceJobMutation,
	lease: Lease,
): Promise<NamespaceMutationStatus> {
	const capabilities = deps.provider.namespaces
	if (capabilities === undefined) return 'skipped'
	let current = toProviderNamespace(row)
	await writeNamespace(deps.repositories, lease, row, current, 'provisioning', { claim: true })
	const providerInput: ProviderNamespaceMutationInput = {
		namespace: current,
		members: await namespaceMembers(deps.repositories, row.id),
		// The signal belongs to the JOB, never to a request — a caller that hangs up must not cancel this.
		signal: lease.signal,
		events: {
			checkpoint: async (namespace) => {
				if (!sameCoordinates(namespace, current, deps.provider.id)) {
					throw namespaceCheckpointInvariant('provider checkpoint changed namespace coordinates')
				}
				current = namespace
				await writeNamespace(deps.repositories, lease, row, current, 'provisioning')
			},
			boundary: async () => lease.assertHeld(),
		},
	}
	try {
		const result = mutation === 'provision' ? await capabilities.provision(providerInput) : await capabilities.reconcile(providerInput)
		if (!sameCoordinates(result, current, deps.provider.id)) throw new Error('provider result changed namespace coordinates')
		current = result
		await writeNamespace(deps.repositories, lease, row, current, 'ready')
		return 'ready'
	} catch (cause) {
		lease.assertHeld()
		const failure = namespaceFailure(cause, mutation)
		console.error(`namespace ${mutation} failed for ${row.id}: ${failure.code}: ${failure.log}`)
		const state = asProviderNamespaceError(cause)?.retryable === true ? 'provisioning' : 'failed'
		await writeNamespace(deps.repositories, lease, row, current, state, { lastError: encodeNamespaceError(failure.code, failure.message) })
		return 'failed'
	}
}

export interface NamespaceRepublishDeps extends NamespaceJobDeps {
	/** Where an unsettled rebuild is handed to a namespace `reconcile` job. */
	readonly queue: Pick<JobQueue<ControlJobMessage>, 'send'>
}

export interface NamespaceRepublishOptions {
	readonly wait: ProviderNamespaceRepublishInput['wait']
	readonly signal?: AbortSignal
	/** The caller's own step boundary, e.g. a deploy's cancellation read. */
	readonly boundary?: () => Promise<void>
}

/**
 * Rebuild one namespace's entry point from the registry (ADR-0044). The namespace stays `provisioning`
 * until the rebuild is live; one that ends any other way is handed to a `reconcile` job. A provider
 * without the capability has nothing to republish.
 */
export async function republishNamespace(deps: NamespaceRepublishDeps, namespaceId: string, options: NamespaceRepublishOptions): Promise<void> {
	if (deps.provider.namespaces?.republish === undefined) return
	const lease = await acquireLease(deps.lock, namespaceLeaseKey(namespaceId), deps.leaseClock)
	if (lease === null) {
		// The holder may have read the members before this change; a queued reconcile publishes it after.
		await deps.repositories.registry.requeueDeploymentNamespace(namespaceId)
		await deps.queue.send({ kind: 'namespace', namespaceId, mutation: 'reconcile' })
		throw new Error(`Namespace ${namespaceId} proxy is busy; a reconcile is queued`)
	}
	try {
		await republishUnderLease(deps, lease, namespaceId, options)
	} finally {
		await lease.release()
	}
}

/** `republishNamespace` for a caller that already holds the namespace lease. */
export async function republishUnderLease(
	deps: NamespaceRepublishDeps,
	lease: Lease,
	namespaceId: string,
	options: NamespaceRepublishOptions,
): Promise<void> {
	const capabilities = deps.provider.namespaces
	if (capabilities?.republish === undefined) return
	const row = await deps.repositories.registry.getDeploymentNamespace(namespaceId)
	lease.assertHeld()
	if (row === null) throw new Error(`deployment namespace ${namespaceId} not found`)
	if (row.provider !== deps.provider.id || row.state === 'failed') throw new Error(`Namespace ${namespaceId} is not ready`)
	let current = toProviderNamespace(row)
	const members = await namespaceMembers(deps.repositories, row.id)
	await writeNamespace(deps.repositories, lease, row, current, 'provisioning')
	const reconcileLater = (): Promise<void> => deps.queue.send({ kind: 'namespace', namespaceId, mutation: 'reconcile' })
	let settled: boolean
	try {
		const result = await capabilities.republish({
			namespace: current,
			members,
			wait: options.wait,
			signal: options.signal === undefined ? lease.signal : AbortSignal.any([lease.signal, options.signal]),
			events: {
				checkpoint: async (namespace) => {
					if (!sameCoordinates(namespace, current, deps.provider.id)) {
						throw namespaceCheckpointInvariant('provider checkpoint changed namespace coordinates')
					}
					current = namespace
					await writeNamespace(deps.repositories, lease, row, current, 'provisioning')
				},
				boundary: async () => {
					lease.assertHeld()
					await options.boundary?.()
				},
			},
		})
		if (!sameCoordinates(result.namespace, current, deps.provider.id)) throw new Error('provider result changed namespace coordinates')
		current = result.namespace
		settled = result.settled
	} catch (cause) {
		await reconcileLater().catch(() => console.error(`namespace ${namespaceId}: the reconcile job could not be queued`))
		throw cause
	}
	await writeNamespace(deps.repositories, lease, row, current, settled ? 'ready' : 'provisioning')
	if (!settled) await reconcileLater()
}

/**
 * The TRIGGER is durable in the same order a deploy's is: the row is persisted first, the queue is
 * touched second, so a queue that is momentarily unavailable leaves a namespace an operator can
 * reconcile rather than one that was never recorded.
 */
async function enqueueNamespaceJob(c: NamespaceUseCaseContext, row: DeploymentNamespaceRow, mutation: NamespaceJobMutation): Promise<void> {
	await c.queue.send({ kind: 'namespace', namespaceId: row.id, mutation })
}

async function auditMutation(
	c: NamespaceUseCaseContext,
	action: 'namespace.create' | 'namespace.adopt' | 'namespace.reconcile' | 'namespace.remove',
	row: DeploymentNamespaceRow,
	extra: Readonly<Record<string, unknown>> = {},
): Promise<void> {
	await c.auth.audit({
		action,
		resourceType: 'deployment_namespace',
		resourceId: row.id,
		metadata: { env: row.env, provider: row.provider, exclusiveAppId: row.exclusive_app_id, state: row.state, ...extra },
	})
}

export async function listNamespacesUseCase(c: NamespaceUseCaseContext): Promise<DeploymentNamespaceListResponse> {
	const rows = await c.repositories.registry.listDeploymentNamespaces()
	const operator = c.provider.namespaces?.operator
	return {
		items: rows.filter((row) => row.provider === c.provider.id).map(toNamespaceDto),
		operator: operator === undefined ? null : { presets: operator.presets },
	}
}

export async function getNamespaceUseCase(c: NamespaceUseCaseContext, id: string): Promise<DeploymentNamespaceDetailDto> {
	const row = await c.repositories.registry.getDeploymentNamespace(id)
	if (row === null) fail(404, 'deployment namespace not found')
	if (row.provider !== c.provider.id) fail(409, `deployment namespace belongs to provider ${row.provider}`)
	// The one read that answers "what can I pass as `--domain`", so it is the one that pays for the join.
	const presentation = namespacePresentation(c, row)
	const hosts = await namespaceHosts(c, row, presentation?.hosts)
	return {
		...toNamespaceDto(row),
		presentation: presentation === null ? null : toPresentationDto(presentation),
		...(hosts === undefined ? {} : { hosts }),
	}
}

export async function planNamespaceUseCase(
	c: NamespaceUseCaseContext,
	input: PlanDeploymentNamespaceRequest,
): Promise<PlanDeploymentNamespaceResponse> {
	const capabilities = c.provider.namespaces
	const operator = capabilities?.operator
	if (capabilities === undefined || operator === undefined) fail(409, `provider ${c.provider.id} does not support namespace planning`)
	if (input.exclusiveAppId !== undefined && await c.repositories.registry.getApp(input.exclusiveAppId) === null) fail(404, 'exclusive app not found')
	try {
		const planned = operator.plan(input)
		if (
			planned.namespace.id !== input.id
			|| planned.namespace.env !== input.env
			|| planned.namespace.exclusiveAppId !== input.exclusiveAppId
			|| planned.namespace.target.provider !== c.provider.id
		) fail(400, 'provider returned a namespace plan for different coordinates')
		const normalized = normalizeNamespace(capabilities, c.provider.id, planned.namespace)
		return { namespace: normalized, presentation: operator.present(normalized) }
	} catch (cause) {
		if (isStructuralError(cause)) throw cause
		fail(400, cause instanceof Error ? cause.message : 'invalid namespace plan')
	}
}

export async function createNamespaceUseCase(
	c: NamespaceUseCaseContext,
	input: CreateDeploymentNamespaceRequest,
): Promise<DeploymentNamespaceDetailDto> {
	const candidate = await namespaceCandidate(c, input.id, input)
	if (await c.repositories.registry.getDeploymentNamespace(candidate.id) !== null) fail(409, 'deployment namespace already exists')
	const capabilities = c.provider.namespaces
	if (capabilities === undefined) fail(409, `provider ${c.provider.id} does not support deployment namespaces`)
	// The row lands `pending` (the insert's default) and the provider mutation runs behind the queue —
	// it takes minutes, and the caller used to receive a gateway timeout instead of a result (backlog 74).
	const created = await c.repositories.registry.createDeploymentNamespaceWithResourceClaims({
		id: candidate.id,
		env: candidate.env,
		exclusiveAppId: candidate.exclusiveAppId ?? null,
		provider: c.provider.id,
		providerTargetJson: JSON.stringify(candidate.target),
	}, namespaceResourceClaims(capabilities, candidate))
	await enqueueNamespaceJob(c, created, 'provision')
	await auditMutation(c, 'namespace.create', created)
	return toNamespaceDetail(c, created)
}

export async function adoptNamespaceUseCase(
	c: NamespaceUseCaseContext,
	id: string,
	input: AdoptDeploymentNamespaceRequest,
): Promise<DeploymentNamespaceDetailDto> {
	const candidate = await namespaceCandidate(c, id, input)
	if (await c.repositories.registry.getDeploymentNamespace(id) !== null) fail(409, 'deployment namespace already exists')
	const capabilities = c.provider.namespaces
	if (capabilities === undefined) fail(409, `provider ${c.provider.id} does not support deployment namespaces`)
	const created = await c.repositories.registry.createDeploymentNamespaceWithResourceClaims({
		id,
		env: candidate.env,
		exclusiveAppId: candidate.exclusiveAppId ?? null,
		provider: c.provider.id,
		providerTargetJson: JSON.stringify(candidate.target),
	}, namespaceResourceClaims(capabilities, candidate))
	await enqueueNamespaceJob(c, created, 'reconcile')
	await auditMutation(c, 'namespace.adopt', created)
	return toNamespaceDetail(c, created)
}

export async function reconcileNamespaceUseCase(c: NamespaceUseCaseContext, id: string): Promise<DeploymentNamespaceDetailDto> {
	const row = await c.repositories.registry.getDeploymentNamespace(id)
	if (row === null) fail(404, 'deployment namespace not found')
	if (row.provider !== c.provider.id) fail(409, `deployment namespace belongs to provider ${row.provider}`)
	const capabilities = c.provider.namespaces
	if (capabilities === undefined) fail(409, `provider ${c.provider.id} does not support deployment namespaces`)
	try {
		await c.repositories.registry.acquireNamespaceResourceClaims({
			namespaceId: row.id,
			ownerAppId: null,
			ownerEnv: null,
			resourceKeys: namespaceResourceClaims(capabilities, toProviderNamespace(row)),
		})
	} catch (cause) {
		if (cause instanceof NamespaceResourceClaimConflictError) fail(409, cause.message)
		throw cause
	}
	// Republish BEFORE the requeue below, which takes the namespace out of `ready` — this is the operator's
	// repair verb for a manifest a registry change could not reach. A republish that fails must NOT skip the
	// queueing that follows, or the one verb an operator has stops working exactly when the proxy is down.
	let republishFailed = false
	if (row.state === 'ready') {
		try {
			await syncChangedNamespaceProxies(c.namespaceProxyChanged, [row.id])
		} catch {
			// `syncChangedNamespaceProxies` already logged the redacted cause.
			republishFailed = true
		}
	}
	// The namespace goes back to `pending`, state only: rewriting `provider_target_json` would roll back a
	// checkpoint a running job just wrote. That job keeps `pending` (only a claim moves it), so the queued
	// reconcile runs after it with fresh members; it also re-arms a namespace whose job was abandoned.
	const queued = await c.repositories.registry.requeueDeploymentNamespace(row.id)
	const current = queued ?? await c.repositories.registry.getDeploymentNamespace(row.id)
	if (current === null) fail(404, 'deployment namespace not found')
	await enqueueNamespaceJob(c, current, 'reconcile')
	await auditMutation(c, 'namespace.reconcile', current)
	if (republishFailed) {
		fail(502, `deployment namespace ${row.id}: the provider reconcile is queued, but the proxy manifest did not publish — retry the republish`)
	}
	return toNamespaceDetail(c, current)
}

/**
 * Free a namespace id (backlog 73). The narrow case only: no app environment may be registered here, and
 * a namespace a worker is settling is left to finish. It removes the ROW and releases its reservations —
 * it deletes NO provider resource, because fabrika holds `OWNER` on the projects it creates (ADR-0034)
 * and deleting one is a destructive act on live state. The removed row is returned whole so the operator
 * can see the provider target and presentation naming what is now unowned.
 */
export async function removeNamespaceUseCase(c: NamespaceUseCaseContext, id: string): Promise<RemoveDeploymentNamespaceResponse> {
	const row = await c.repositories.registry.getDeploymentNamespace(id)
	if (row === null) fail(404, 'deployment namespace not found')
	if (row.provider !== c.provider.id) fail(409, `deployment namespace belongs to provider ${row.provider}`)
	await refuseNamespaceRemoval(c, row)
	// Answer from the row the DELETE returned, not from the read above: the statement is the moment the
	// namespace ceased to exist, and its `RETURNING *` is the only description of it that is certainly true.
	const deleted = await c.repositories.registry.deleteDeploymentNamespaceWithResourceClaims(id)
	if (deleted === null) {
		// The same guard is in the statement, so a namespace claimed between the check above and the write
		// keeps its claims. Re-read to answer with the reason rather than with a bare conflict.
		await refuseNamespaceRemoval(c, await c.repositories.registry.getDeploymentNamespace(id))
		fail(409, 'deployment namespace changed while it was being removed')
	}
	const removed = toRemovedDetail(c, deleted)
	// The provider target is credential-free by contract (ADR-0014) and it is what names the resources this
	// removal stopped tracking — an audit row without it cannot answer "what did we orphan, and where".
	await auditMutation(c, 'namespace.remove', deleted, { target: removed.target })
	return { removed }
}

async function refuseNamespaceRemoval(c: NamespaceUseCaseContext, row: DeploymentNamespaceRow | null): Promise<void> {
	if (row === null) fail(404, 'deployment namespace not found')
	if (row.state === 'provisioning') fail(409, 'deployment namespace provisioning is in progress')
	const environments = await c.repositories.registry.listAppEnvsByNamespace(row.id)
	if (environments.length > 0) {
		const apps = [...new Set(environments.map((environment) => environment.app_id))].sort()
		fail(409, `deployment namespace is registered to ${apps.join(', ')}`)
	}
}

/** A namespace that failed early may hold a target its provider cannot present; that must not block removal. */
function toRemovedDetail(c: NamespaceUseCaseContext, row: DeploymentNamespaceRow): DeploymentNamespaceDetailDto {
	try {
		return toNamespaceDetail(c, row)
	} catch {
		return { ...toNamespaceDto(row), presentation: null }
	}
}
