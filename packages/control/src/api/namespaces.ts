import type { AuthContext } from '@fabrika/auth'
import { API_KEY_PREFIX } from '@fabrika/auth-core'
import type {
	AdoptDeploymentNamespaceRequest,
	CreateDeploymentNamespaceRequest,
	DeploymentNamespaceDetailDto,
	DeploymentNamespaceDto,
	DeploymentNamespaceListResponse,
	PlanDeploymentNamespaceRequest,
	PlanDeploymentNamespaceResponse,
	RemoveDeploymentNamespaceResponse,
} from '@fabrika/control-contract'
import type { JobQueue } from '@fabrika/platform'
import {
	type ControlProvider,
	type JsonValue,
	type ProviderDeploymentNamespace,
	type ProviderNamespaceCapabilities,
	ProviderNamespaceError,
	type ProviderNamespaceMutationInput,
} from '@fabrika/provider-contract'
import { type ControlRepositories, type DeploymentNamespaceRow, NamespaceResourceClaimConflictError } from '../db'
import { readJson } from '../http'
import type { Authorized } from '../iam'
import { nullableStringField, prop, stringField } from '../json'
import type { ControlJobMessage, DeployLockGate, NamespaceJobMessage, NamespaceJobMutation } from '../run-lifecycle'
import { uuidv7 } from '../uuid'
import { fail, jsonAdapter } from './domain'
import { isJsonValue, parseStoredEnvelope, readProviderEnvelope } from './provider-envelope'

export interface NamespaceContext {
	readonly repositories: ControlRepositories
	readonly request: Request
	readonly provider: ControlProvider
	readonly authorized: Authorized
	readonly queue: JobQueue<ControlJobMessage>
}

/**
 * What the WORKER needs. No `auth` and no request signal: the mutation runs behind the queue, long
 * after the caller that asked for it has gone (backlog 74), so the audit happens in the request and
 * the abort signal is the job's own.
 */
export interface NamespaceJobContext {
	readonly repositories: ControlRepositories
	readonly provider: ControlProvider
	readonly signal: AbortSignal
}

export interface NamespaceUseCaseContext extends NamespaceJobContext {
	readonly auth: AuthContext
	readonly queue: JobQueue<ControlJobMessage>
}

function useCaseContext(c: NamespaceContext): NamespaceUseCaseContext {
	return { repositories: c.repositories, provider: c.provider, auth: c.authorized.auth, signal: c.request.signal, queue: c.queue }
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

function toNamespaceDetail(c: NamespaceUseCaseContext, row: DeploymentNamespaceRow): DeploymentNamespaceDetailDto {
	const operator = c.provider.namespaces?.operator
	if (operator === undefined) return { ...toNamespaceDto(row), presentation: null }
	try {
		return { ...toNamespaceDto(row), presentation: operator.present(toProviderNamespace(row)) }
	} catch (cause) {
		fail(400, cause instanceof Error ? cause.message : 'invalid namespace presentation')
	}
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
		if (isDomainError(cause)) throw cause
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
	readonly lock: DeployLockGate
}

/** One lease per namespace, in the same generic table the per-app-env deploy lock uses. */
export const namespaceLockKey = (namespaceId: string): string => `namespace:${namespaceId}`

/**
 * Run one queued namespace mutation.
 *
 * The state guard is what makes redelivery safe: a namespace that already settled (`ready`/`failed`),
 * belongs to another provider, or no longer exists is a NO-OP, while one left `provisioning` by a
 * crashed worker is RESUMED — the provider's checkpoints exist precisely so a re-run picks up where it
 * stopped instead of repeating the work (see `provision` in `@fabrika/provider-zerops`'s namespace.ts).
 *
 * The lease serializes two workers against one namespace; `control` runs more than one container, so
 * the sequential in-process consumer is not on its own enough.
 */
export async function runNamespaceJob(deps: NamespaceJobDeps, message: NamespaceJobMessage): Promise<NamespaceJobResult> {
	const skipped: NamespaceJobResult = { namespaceId: message.namespaceId, status: 'skipped' }
	const runnable = (row: DeploymentNamespaceRow | null): row is DeploymentNamespaceRow =>
		row !== null && row.provider === deps.provider.id && (row.state === 'pending' || row.state === 'provisioning')
	if (!runnable(await deps.repositories.registry.getDeploymentNamespace(message.namespaceId))) return skipped
	const key = namespaceLockKey(message.namespaceId)
	const holder = uuidv7()
	if (!(await deps.lock.acquire(key, holder))) return { namespaceId: message.namespaceId, status: 'deferred' }
	try {
		// Re-read UNDER the lease, as `executeDeploy` re-verifies its run: the first read raced whoever held
		// it, so both the guard and the target handed to the provider have to come from after the acquire.
		const row = await deps.repositories.registry.getDeploymentNamespace(message.namespaceId)
		if (!runnable(row)) return skipped
		// The signal belongs to the JOB, never to a request — a caller that hangs up must not cancel this.
		const controller = new AbortController()
		const context: NamespaceJobContext = { repositories: deps.repositories, provider: deps.provider, signal: controller.signal }
		return { namespaceId: row.id, status: await mutateNamespace(context, row, message.mutation) }
	} finally {
		await deps.lock.release(key, holder)
	}
}

type NamespaceMutationStatus = 'ready' | 'failed' | 'skipped'

/**
 * The provider mutation itself. It has exactly ONE caller — the job above — so a provider refusal is a
 * HANDLED outcome recorded on the row, not a thrown 502: retrying an unrecoverable provider error just
 * burns the retry budget, and the row already carries what an operator reads.
 */
async function mutateNamespace(
	c: NamespaceJobContext,
	row: DeploymentNamespaceRow,
	mutation: NamespaceJobMutation,
): Promise<NamespaceMutationStatus> {
	const capabilities = c.provider.namespaces
	if (capabilities === undefined) return 'skipped'
	let current = toProviderNamespace(row)
	if (
		await c.repositories.registry.updateDeploymentNamespace({
			id: row.id,
			providerTargetJson: JSON.stringify(current.target),
			state: 'provisioning',
			lastError: null,
		}) === null
	) return 'skipped'
	const providerInput = (): ProviderNamespaceMutationInput => ({
		namespace: current,
		signal: c.signal,
		events: {
			checkpoint: async (namespace) => {
				if (!sameCoordinates(namespace, current, c.provider.id)) {
					throw namespaceCheckpointInvariant('provider checkpoint changed namespace coordinates')
				}
				current = namespace
				if (
					await c.repositories.registry.updateDeploymentNamespace({
						id: row.id,
						providerTargetJson: JSON.stringify(current.target),
						state: 'provisioning',
						lastError: null,
					}) === null
				) throw namespaceCheckpointInvariant('deployment namespace disappeared during checkpoint')
			},
		},
	})
	try {
		const result = mutation === 'provision' ? await capabilities.provision(providerInput()) : await capabilities.reconcile(providerInput())
		if (!sameCoordinates(result, current, c.provider.id)) throw new Error('provider result changed namespace coordinates')
		current = result
		const ready = await c.repositories.registry.updateDeploymentNamespace({
			id: row.id,
			providerTargetJson: JSON.stringify(current.target),
			state: 'ready',
			lastError: null,
		})
		return ready === null ? 'skipped' : 'ready'
	} catch (cause) {
		const failure = namespaceFailure(cause, mutation)
		console.error(`namespace ${mutation} failed for ${row.id}: ${failure.code}: ${failure.log}`)
		await c.repositories.registry.updateDeploymentNamespace({
			id: row.id,
			providerTargetJson: JSON.stringify(current.target),
			state: 'failed',
			lastError: encodeNamespaceError(failure.code, failure.message),
		})
		return 'failed'
	}
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

export async function listNamespaces(c: NamespaceContext): Promise<Response> {
	return jsonAdapter(() => listNamespacesUseCase(useCaseContext(c)))
}

export async function listNamespacesUseCase(c: NamespaceUseCaseContext): Promise<DeploymentNamespaceListResponse> {
	const rows = await c.repositories.registry.listDeploymentNamespaces()
	const operator = c.provider.namespaces?.operator
	return {
		items: rows.filter((row) => row.provider === c.provider.id).map(toNamespaceDto),
		operator: operator === undefined ? null : { presets: operator.presets },
	}
}

export async function getNamespace(c: NamespaceContext, id: string): Promise<Response> {
	return jsonAdapter(() => getNamespaceUseCase(useCaseContext(c), id))
}

export async function getNamespaceUseCase(c: NamespaceUseCaseContext, id: string): Promise<DeploymentNamespaceDetailDto> {
	const row = await c.repositories.registry.getDeploymentNamespace(id)
	if (row === null) fail(404, 'deployment namespace not found')
	if (row.provider !== c.provider.id) fail(409, `deployment namespace belongs to provider ${row.provider}`)
	return toNamespaceDetail(c, row)
}

export async function planNamespace(c: NamespaceContext): Promise<Response> {
	return jsonAdapter(async () => planNamespaceUseCase(useCaseContext(c), parsePlan(await readJson(c.request))))
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
		if (isDomainError(cause)) throw cause
		fail(400, cause instanceof Error ? cause.message : 'invalid namespace plan')
	}
}

export async function createNamespace(c: NamespaceContext): Promise<Response> {
	return jsonAdapter(async () => createNamespaceUseCase(useCaseContext(c), parseCreate(await readJson(c.request))), { status: 201 })
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

export async function adoptNamespace(c: NamespaceContext, id: string): Promise<Response> {
	return jsonAdapter(async () => adoptNamespaceUseCase(useCaseContext(c), id, parseAdopt(await readJson(c.request))), { status: 201 })
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

export async function reconcileNamespace(c: NamespaceContext, id: string): Promise<Response> {
	return jsonAdapter(() => reconcileNamespaceUseCase(useCaseContext(c), id))
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
	// A SETTLED namespace goes back to `pending` so the worker's claim still means something. One that is
	// already `pending`/`provisioning` is left completely alone — the request must not touch
	// `provider_target_json`, or a checkpoint the running job just wrote would be rolled back under it.
	// The enqueue is still worth it: it re-arms a namespace whose job was abandoned, and if a job is in
	// flight the new message simply finds the namespace settled and skips.
	const queued = await c.repositories.registry.requeueDeploymentNamespace(row.id)
	const current = queued ?? await c.repositories.registry.getDeploymentNamespace(row.id)
	if (current === null) fail(404, 'deployment namespace not found')
	await enqueueNamespaceJob(c, current, 'reconcile')
	await auditMutation(c, 'namespace.reconcile', current)
	return toNamespaceDetail(c, current)
}

export async function removeNamespace(c: NamespaceContext, id: string): Promise<Response> {
	return jsonAdapter(() => removeNamespaceUseCase(useCaseContext(c), id))
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

function parseCreate(body: unknown): CreateDeploymentNamespaceRequest {
	const id = stringField(body, 'id')
	const common = parseAdopt(body)
	if (!id) fail(400, 'id and env required')
	return { id, ...common }
}

function parseAdopt(body: unknown): AdoptDeploymentNamespaceRequest {
	const env = stringField(body, 'env')
	if (!env) fail(400, 'id and env required')
	const rawExclusiveAppId = prop(body, 'exclusiveAppId')
	const exclusiveAppId = nullableStringField(body, 'exclusiveAppId')
	if (rawExclusiveAppId !== undefined && (exclusiveAppId === undefined || exclusiveAppId === '')) {
		fail(400, 'exclusiveAppId must be a non-empty string or null')
	}
	const target = readProviderEnvelope(prop(body, 'target'))
	if (target === null) fail(400, 'target must be a versioned provider envelope')
	return { env, target, ...(exclusiveAppId === undefined ? {} : { exclusiveAppId }) }
}

function parsePlan(body: unknown): PlanDeploymentNamespaceRequest {
	const id = stringField(body, 'id')
	const env = stringField(body, 'env')
	const preset = stringField(body, 'preset')
	if (!id?.trim() || !env?.trim() || !preset?.trim()) fail(400, 'id, env, and preset required')
	const rawExclusiveAppId = prop(body, 'exclusiveAppId')
	const exclusiveAppId = nullableStringField(body, 'exclusiveAppId')
	if (rawExclusiveAppId !== undefined && (exclusiveAppId === undefined || exclusiveAppId === '')) {
		fail(400, 'exclusiveAppId must be a non-empty string or null')
	}
	const rawOptions = prop(body, 'options')
	let options: JsonValue | undefined
	if (rawOptions !== undefined) {
		if (!isJsonValue(rawOptions)) fail(400, 'options must be JSON')
		options = rawOptions
	}
	return {
		id,
		env,
		preset,
		...(exclusiveAppId === undefined || exclusiveAppId === null ? {} : { exclusiveAppId }),
		...(options === undefined ? {} : { options }),
	}
}

function isDomainError(cause: unknown): boolean {
	return typeof cause === 'object' && cause !== null && typeof Reflect.get(cause, 'httpStatus') === 'number'
}
