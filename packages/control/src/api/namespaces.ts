import type { AuthContext } from '@fabrika/auth'
import type {
	AdoptDeploymentNamespaceRequest,
	CreateDeploymentNamespaceRequest,
	DeploymentNamespaceDetailDto,
	DeploymentNamespaceDto,
	DeploymentNamespaceListResponse,
	PlanDeploymentNamespaceRequest,
	PlanDeploymentNamespaceResponse,
} from '@fabrika/control-contract'
import type {
	ControlProvider,
	JsonValue,
	ProviderDeploymentNamespace,
	ProviderNamespaceCapabilities,
	ProviderNamespaceMutationInput,
} from '@fabrika/provider-contract'
import { type ControlRepositories, type DeploymentNamespaceRow, NamespaceResourceClaimConflictError } from '../db'
import { readJson } from '../http'
import type { Authorized } from '../iam'
import { nullableStringField, prop, stringField } from '../json'
import { fail, jsonAdapter } from './domain'
import { isJsonValue, parseStoredEnvelope, readProviderEnvelope } from './provider-envelope'

export interface NamespaceContext {
	readonly repositories: ControlRepositories
	readonly request: Request
	readonly provider: ControlProvider
	readonly authorized: Authorized
}

export interface NamespaceUseCaseContext {
	readonly repositories: ControlRepositories
	readonly provider: ControlProvider
	readonly auth: AuthContext
	readonly signal: AbortSignal
}

function useCaseContext(c: NamespaceContext): NamespaceUseCaseContext {
	return { repositories: c.repositories, provider: c.provider, auth: c.authorized.auth, signal: c.request.signal }
}

function toNamespaceDto(row: DeploymentNamespaceRow): DeploymentNamespaceDto {
	return {
		id: row.id,
		env: row.env,
		provider: row.provider,
		exclusiveAppId: row.exclusive_app_id,
		target: parseStoredEnvelope(row.provider_target_json, `target for namespace ${row.id}`),
		state: row.state,
		lastError: row.last_error,
		createdAt: row.created_at,
	}
}

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

type NamespaceMutation = 'provision' | 'reconcile'

async function mutateNamespace(
	c: NamespaceUseCaseContext,
	row: DeploymentNamespaceRow,
	mutation: NamespaceMutation,
): Promise<DeploymentNamespaceRow> {
	const capabilities = c.provider.namespaces
	if (capabilities === undefined) fail(409, `provider ${c.provider.id} does not support deployment namespaces`)
	let current = toProviderNamespace(row)
	if (
		await c.repositories.registry.updateDeploymentNamespace({
			id: row.id,
			providerTargetJson: JSON.stringify(current.target),
			state: 'provisioning',
			lastError: null,
		}) === null
	) fail(404, 'deployment namespace not found')
	const providerInput = (): ProviderNamespaceMutationInput => ({
		namespace: current,
		signal: c.signal,
		events: {
			checkpoint: async (namespace) => {
				if (!sameCoordinates(namespace, current, c.provider.id)) throw new Error('provider checkpoint changed namespace coordinates')
				current = namespace
				if (
					await c.repositories.registry.updateDeploymentNamespace({
						id: row.id,
						providerTargetJson: JSON.stringify(current.target),
						state: 'provisioning',
						lastError: null,
					}) === null
				) throw new Error('deployment namespace disappeared during checkpoint')
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
		if (ready === null) fail(404, 'deployment namespace not found')
		return ready
	} catch (cause) {
		if (isDomainError(cause)) throw cause
		const message = `namespace ${mutation} failed`
		await c.repositories.registry.updateDeploymentNamespace({
			id: row.id,
			providerTargetJson: JSON.stringify(current.target),
			state: 'failed',
			lastError: message,
		})
		fail(502, message)
	}
}

async function auditMutation(
	c: NamespaceUseCaseContext,
	action: 'namespace.create' | 'namespace.adopt' | 'namespace.reconcile',
	row: DeploymentNamespaceRow,
): Promise<void> {
	await c.auth.audit({
		action,
		resourceType: 'deployment_namespace',
		resourceId: row.id,
		metadata: { env: row.env, provider: row.provider, exclusiveAppId: row.exclusive_app_id, state: row.state },
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
	const created = await c.repositories.registry.createDeploymentNamespaceWithResourceClaims({
		id: candidate.id,
		env: candidate.env,
		exclusiveAppId: candidate.exclusiveAppId ?? null,
		provider: c.provider.id,
		providerTargetJson: JSON.stringify(candidate.target),
	}, namespaceResourceClaims(capabilities, candidate))
	let result: DeploymentNamespaceRow
	try {
		result = await mutateNamespace(c, created, 'provision')
	} catch (cause) {
		const audited = await c.repositories.registry.getDeploymentNamespace(created.id)
		if (audited !== null) await auditMutation(c, 'namespace.create', audited)
		throw cause
	}
	await auditMutation(c, 'namespace.create', result)
	return toNamespaceDetail(c, result)
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
	let result: DeploymentNamespaceRow
	try {
		result = await mutateNamespace(c, created, 'reconcile')
	} catch (cause) {
		const audited = await c.repositories.registry.getDeploymentNamespace(created.id)
		if (audited !== null) await auditMutation(c, 'namespace.adopt', audited)
		throw cause
	}
	await auditMutation(c, 'namespace.adopt', result)
	return toNamespaceDetail(c, result)
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
	let result: DeploymentNamespaceRow
	try {
		result = await mutateNamespace(c, row, 'reconcile')
	} catch (cause) {
		const audited = await c.repositories.registry.getDeploymentNamespace(row.id)
		if (audited !== null) await auditMutation(c, 'namespace.reconcile', audited)
		throw cause
	}
	await auditMutation(c, 'namespace.reconcile', result)
	return toNamespaceDetail(c, result)
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
