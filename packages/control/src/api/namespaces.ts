import type {
	DeploymentNamespaceDetailDto,
	DeploymentNamespaceDto,
	DeploymentNamespaceListResponse,
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
import { error, json, readJson } from '../http'
import type { Authorized } from '../iam'
import { nullableStringField, prop, stringField } from '../json'
import { envelopeField, isJsonValue, parseStoredEnvelope } from './provider-envelope'

export interface NamespaceContext {
	repositories: ControlRepositories
	request: Request
	provider: ControlProvider
	authorized: Authorized
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

function toNamespaceDetail(c: NamespaceContext, row: DeploymentNamespaceRow): DeploymentNamespaceDetailDto | Response {
	const operator = c.provider.namespaces?.operator
	if (operator === undefined) {
		return { ...toNamespaceDto(row), presentation: null }
	}
	try {
		return {
			...toNamespaceDto(row),
			presentation: operator.present(toProviderNamespace(row)),
		}
	} catch (cause) {
		return error(400, cause instanceof Error ? cause.message : 'invalid namespace presentation')
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

function sameCoordinates(
	actual: ProviderDeploymentNamespace,
	expected: ProviderDeploymentNamespace,
	providerId: string,
): boolean {
	return actual.id === expected.id
		&& actual.env === expected.env
		&& actual.exclusiveAppId === expected.exclusiveAppId
		&& actual.target.provider === providerId
}

function normalizeNamespace(
	capabilities: ProviderNamespaceCapabilities,
	providerId: string,
	namespace: ProviderDeploymentNamespace,
): ProviderDeploymentNamespace | Response {
	try {
		const normalized = capabilities.normalize(namespace)
		if (!sameCoordinates(normalized, namespace, providerId)) {
			return error(400, 'provider returned a namespace for different coordinates')
		}
		return normalized
	} catch (cause) {
		return error(400, cause instanceof Error ? cause.message : 'invalid deployment namespace')
	}
}

function namespaceResourceClaims(
	capabilities: ProviderNamespaceCapabilities,
	namespace: ProviderDeploymentNamespace,
): readonly string[] | Response {
	try {
		return capabilities.namespaceResourceClaims(namespace)
	} catch (cause) {
		return error(400, cause instanceof Error ? cause.message : 'invalid namespace resource claims')
	}
}

async function namespaceCandidate(
	c: NamespaceContext,
	idFromPath?: string,
): Promise<ProviderDeploymentNamespace | Response> {
	const capabilities = c.provider.namespaces
	if (capabilities === undefined) {
		return error(409, `provider ${c.provider.id} does not support deployment namespaces`)
	}
	const body = await readJson(c.request)
	const id = idFromPath ?? stringField(body, 'id')
	const env = stringField(body, 'env')
	if (id === undefined || id === '' || env === undefined || env === '') {
		return error(400, 'id and env required')
	}
	const rawExclusiveAppId = prop(body, 'exclusiveAppId')
	const exclusiveAppId = nullableStringField(body, 'exclusiveAppId')
	if (rawExclusiveAppId !== undefined && (exclusiveAppId === undefined || exclusiveAppId === '')) {
		return error(400, 'exclusiveAppId must be a non-empty string or null')
	}
	if (exclusiveAppId !== undefined && exclusiveAppId !== null && await c.repositories.registry.getApp(exclusiveAppId) === null) {
		return error(404, 'exclusive app not found')
	}
	const target = envelopeField(body, 'target')
	if (target instanceof Response) return target
	return normalizeNamespace(capabilities, c.provider.id, {
		id,
		env,
		...(exclusiveAppId === undefined || exclusiveAppId === null ? {} : { exclusiveAppId }),
		target,
	})
}

type NamespaceMutation = 'provision' | 'reconcile'

async function mutateNamespace(
	c: NamespaceContext,
	row: DeploymentNamespaceRow,
	mutation: NamespaceMutation,
): Promise<DeploymentNamespaceRow | Response> {
	const capabilities = c.provider.namespaces
	if (capabilities === undefined) {
		return error(409, `provider ${c.provider.id} does not support deployment namespaces`)
	}
	let current = toProviderNamespace(row)
	const provisioning = await c.repositories.registry.updateDeploymentNamespace({
		id: row.id,
		providerTargetJson: JSON.stringify(current.target),
		state: 'provisioning',
		lastError: null,
	})
	if (provisioning === null) {
		return error(404, 'deployment namespace not found')
	}
	const signal = c.request.signal
	const input = (): ProviderNamespaceMutationInput => ({
		namespace: current,
		signal,
		events: {
			checkpoint: async (namespace) => {
				if (!sameCoordinates(namespace, current, c.provider.id)) {
					throw new Error('provider checkpoint changed namespace coordinates')
				}
				current = namespace
				const checkpoint = await c.repositories.registry.updateDeploymentNamespace({
					id: row.id,
					providerTargetJson: JSON.stringify(current.target),
					state: 'provisioning',
					lastError: null,
				})
				if (checkpoint === null) {
					throw new Error('deployment namespace disappeared during checkpoint')
				}
			},
		},
	})
	try {
		const result = mutation === 'provision'
			? await capabilities.provision(input())
			: await capabilities.reconcile(input())
		if (!sameCoordinates(result, current, c.provider.id)) {
			throw new Error('provider result changed namespace coordinates')
		}
		current = result
		const ready = await c.repositories.registry.updateDeploymentNamespace({
			id: row.id,
			providerTargetJson: JSON.stringify(current.target),
			state: 'ready',
			lastError: null,
		})
		return ready ?? error(404, 'deployment namespace not found')
	} catch {
		const message = `namespace ${mutation} failed`
		await c.repositories.registry.updateDeploymentNamespace({
			id: row.id,
			providerTargetJson: JSON.stringify(current.target),
			state: 'failed',
			lastError: message,
		})
		return error(502, message)
	}
}

async function auditMutation(
	c: NamespaceContext,
	action: 'namespace.create' | 'namespace.adopt' | 'namespace.reconcile',
	row: DeploymentNamespaceRow,
): Promise<void> {
	await c.authorized.auth.audit({
		action,
		resourceType: 'deployment_namespace',
		resourceId: row.id,
		metadata: {
			env: row.env,
			provider: row.provider,
			exclusiveAppId: row.exclusive_app_id,
			state: row.state,
		},
	})
}

export async function listNamespaces(c: NamespaceContext): Promise<Response> {
	const rows = await c.repositories.registry.listDeploymentNamespaces()
	const operator = c.provider.namespaces?.operator
	const response: DeploymentNamespaceListResponse = {
		items: rows.filter((row) => row.provider === c.provider.id).map(toNamespaceDto),
		operator: operator === undefined ? null : { presets: operator.presets },
	}
	return json(response)
}

export async function getNamespace(c: NamespaceContext, id: string): Promise<Response> {
	const row = await c.repositories.registry.getDeploymentNamespace(id)
	if (row === null) {
		return error(404, 'deployment namespace not found')
	}
	if (row.provider !== c.provider.id) {
		return error(409, `deployment namespace belongs to provider ${row.provider}`)
	}
	const detail = toNamespaceDetail(c, row)
	return detail instanceof Response ? detail : json(detail)
}

export async function planNamespace(c: NamespaceContext): Promise<Response> {
	const capabilities = c.provider.namespaces
	const operator = capabilities?.operator
	if (capabilities === undefined || operator === undefined) {
		return error(409, `provider ${c.provider.id} does not support namespace planning`)
	}
	const body = await readJson(c.request)
	const id = stringField(body, 'id')
	const env = stringField(body, 'env')
	const preset = stringField(body, 'preset')
	if (id === undefined || id.trim() === '' || env === undefined || env.trim() === '' || preset === undefined || preset.trim() === '') {
		return error(400, 'id, env, and preset required')
	}
	const rawExclusiveAppId = prop(body, 'exclusiveAppId')
	const exclusiveAppId = nullableStringField(body, 'exclusiveAppId')
	if (rawExclusiveAppId !== undefined && (exclusiveAppId === undefined || exclusiveAppId === '')) {
		return error(400, 'exclusiveAppId must be a non-empty string or null')
	}
	if (exclusiveAppId !== undefined && exclusiveAppId !== null && await c.repositories.registry.getApp(exclusiveAppId) === null) {
		return error(404, 'exclusive app not found')
	}
	const rawOptions = prop(body, 'options')
	let options: JsonValue | undefined
	if (rawOptions !== undefined) {
		if (!isJsonValue(rawOptions)) {
			return error(400, 'options must be JSON')
		}
		options = rawOptions
	}
	try {
		const planned = operator.plan({
			id,
			env,
			preset,
			...(exclusiveAppId === undefined || exclusiveAppId === null ? {} : { exclusiveAppId }),
			...(options === undefined ? {} : { options }),
		})
		if (
			planned.namespace.id !== id
			|| planned.namespace.env !== env
			|| planned.namespace.exclusiveAppId !== (exclusiveAppId ?? undefined)
			|| planned.namespace.target.provider !== c.provider.id
		) {
			return error(400, 'provider returned a namespace plan for different coordinates')
		}
		const normalized = normalizeNamespace(capabilities, c.provider.id, planned.namespace)
		if (normalized instanceof Response) return normalized
		const response: PlanDeploymentNamespaceResponse = {
			namespace: normalized,
			presentation: operator.present(normalized),
		}
		return json(response)
	} catch (cause) {
		return error(400, cause instanceof Error ? cause.message : 'invalid namespace plan')
	}
}

export async function createNamespace(c: NamespaceContext): Promise<Response> {
	const candidate = await namespaceCandidate(c)
	if (candidate instanceof Response) return candidate
	if (await c.repositories.registry.getDeploymentNamespace(candidate.id) !== null) {
		return error(409, 'deployment namespace already exists')
	}
	const capabilities = c.provider.namespaces
	if (capabilities === undefined) {
		return error(409, `provider ${c.provider.id} does not support deployment namespaces`)
	}
	const resourceClaims = namespaceResourceClaims(capabilities, candidate)
	if (resourceClaims instanceof Response) return resourceClaims
	const created = await c.repositories.registry.createDeploymentNamespaceWithResourceClaims({
		id: candidate.id,
		env: candidate.env,
		exclusiveAppId: candidate.exclusiveAppId ?? null,
		provider: c.provider.id,
		providerTargetJson: JSON.stringify(candidate.target),
	}, resourceClaims)
	const result = await mutateNamespace(c, created, 'provision')
	const audited = result instanceof Response ? await c.repositories.registry.getDeploymentNamespace(created.id) : result
	if (audited !== null) await auditMutation(c, 'namespace.create', audited)
	if (result instanceof Response) return result
	const detail = toNamespaceDetail(c, result)
	return detail instanceof Response ? detail : json(detail, { status: 201 })
}

export async function adoptNamespace(c: NamespaceContext, id: string): Promise<Response> {
	const candidate = await namespaceCandidate(c, id)
	if (candidate instanceof Response) return candidate
	if (await c.repositories.registry.getDeploymentNamespace(id) !== null) {
		return error(409, 'deployment namespace already exists')
	}
	const capabilities = c.provider.namespaces
	if (capabilities === undefined) {
		return error(409, `provider ${c.provider.id} does not support deployment namespaces`)
	}
	const resourceClaims = namespaceResourceClaims(capabilities, candidate)
	if (resourceClaims instanceof Response) return resourceClaims
	const created = await c.repositories.registry.createDeploymentNamespaceWithResourceClaims({
		id,
		env: candidate.env,
		exclusiveAppId: candidate.exclusiveAppId ?? null,
		provider: c.provider.id,
		providerTargetJson: JSON.stringify(candidate.target),
	}, resourceClaims)
	const result = await mutateNamespace(c, created, 'reconcile')
	const audited = result instanceof Response ? await c.repositories.registry.getDeploymentNamespace(created.id) : result
	if (audited !== null) await auditMutation(c, 'namespace.adopt', audited)
	if (result instanceof Response) return result
	const detail = toNamespaceDetail(c, result)
	return detail instanceof Response ? detail : json(detail, { status: 201 })
}

export async function reconcileNamespace(c: NamespaceContext, id: string): Promise<Response> {
	const row = await c.repositories.registry.getDeploymentNamespace(id)
	if (row === null) {
		return error(404, 'deployment namespace not found')
	}
	if (row.provider !== c.provider.id) {
		return error(409, `deployment namespace belongs to provider ${row.provider}`)
	}
	const capabilities = c.provider.namespaces
	if (capabilities === undefined) {
		return error(409, `provider ${c.provider.id} does not support deployment namespaces`)
	}
	const resourceClaims = namespaceResourceClaims(capabilities, toProviderNamespace(row))
	if (resourceClaims instanceof Response) return resourceClaims
	try {
		await c.repositories.registry.acquireNamespaceResourceClaims({
			namespaceId: row.id,
			ownerAppId: null,
			ownerEnv: null,
			resourceKeys: resourceClaims,
		})
	} catch (cause) {
		if (cause instanceof NamespaceResourceClaimConflictError) {
			return error(409, cause.message)
		}
		throw cause
	}
	const result = await mutateNamespace(c, row, 'reconcile')
	const audited = result instanceof Response ? await c.repositories.registry.getDeploymentNamespace(row.id) : result
	if (audited !== null) await auditMutation(c, 'namespace.reconcile', audited)
	if (result instanceof Response) return result
	const detail = toNamespaceDetail(c, result)
	return detail instanceof Response ? detail : json(detail)
}
