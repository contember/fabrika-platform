import type {
	ControlProvider,
	ProviderDeploymentNamespace,
	ProviderNamespaceCapabilities,
	ProviderNamespaceMutationInput,
} from '@fabrika/provider-contract'
import { type Db, type DeploymentNamespaceRow, NamespaceResourceClaimConflictError } from '../db'
import { error, json, readJson } from '../http'
import type { Authorized } from '../iam'
import { nullableStringField, prop, stringField } from '../json'
import { envelopeField, parseStoredEnvelope } from './provider-envelope'

export interface NamespaceContext {
	db: Db
	request: Request
	provider: ControlProvider
	authorized: Authorized
}

function toNamespaceDto(row: DeploymentNamespaceRow): unknown {
	return {
		id: row.id,
		env: row.env,
		provider: row.provider,
		exclusiveAppId: row.exclusive_app_id,
		target: JSON.parse(row.provider_target_json),
		state: row.state,
		lastError: row.last_error,
		createdAt: row.created_at,
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
	if (exclusiveAppId !== undefined && exclusiveAppId !== null && await c.db.getApp(exclusiveAppId) === null) {
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
	const provisioning = await c.db.updateDeploymentNamespace({
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
				const checkpoint = await c.db.updateDeploymentNamespace({
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
		const ready = await c.db.updateDeploymentNamespace({
			id: row.id,
			providerTargetJson: JSON.stringify(current.target),
			state: 'ready',
			lastError: null,
		})
		return ready ?? error(404, 'deployment namespace not found')
	} catch {
		const message = `namespace ${mutation} failed`
		await c.db.updateDeploymentNamespace({
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
	const rows = await c.db.listDeploymentNamespaces()
	return json({ items: rows.filter((row) => row.provider === c.provider.id).map(toNamespaceDto) })
}

export async function getNamespace(c: NamespaceContext, id: string): Promise<Response> {
	const row = await c.db.getDeploymentNamespace(id)
	if (row === null) {
		return error(404, 'deployment namespace not found')
	}
	if (row.provider !== c.provider.id) {
		return error(409, `deployment namespace belongs to provider ${row.provider}`)
	}
	return json(toNamespaceDto(row))
}

export async function createNamespace(c: NamespaceContext): Promise<Response> {
	const candidate = await namespaceCandidate(c)
	if (candidate instanceof Response) return candidate
	if (await c.db.getDeploymentNamespace(candidate.id) !== null) {
		return error(409, 'deployment namespace already exists')
	}
	const capabilities = c.provider.namespaces
	if (capabilities === undefined) {
		return error(409, `provider ${c.provider.id} does not support deployment namespaces`)
	}
	const resourceClaims = namespaceResourceClaims(capabilities, candidate)
	if (resourceClaims instanceof Response) return resourceClaims
	const created = await c.db.createDeploymentNamespaceWithResourceClaims({
		id: candidate.id,
		env: candidate.env,
		exclusiveAppId: candidate.exclusiveAppId ?? null,
		provider: c.provider.id,
		providerTargetJson: JSON.stringify(candidate.target),
	}, resourceClaims)
	const result = await mutateNamespace(c, created, 'provision')
	const audited = result instanceof Response ? await c.db.getDeploymentNamespace(created.id) : result
	if (audited !== null) await auditMutation(c, 'namespace.create', audited)
	return result instanceof Response ? result : json(toNamespaceDto(result), { status: 201 })
}

export async function adoptNamespace(c: NamespaceContext, id: string): Promise<Response> {
	const candidate = await namespaceCandidate(c, id)
	if (candidate instanceof Response) return candidate
	if (await c.db.getDeploymentNamespace(id) !== null) {
		return error(409, 'deployment namespace already exists')
	}
	const capabilities = c.provider.namespaces
	if (capabilities === undefined) {
		return error(409, `provider ${c.provider.id} does not support deployment namespaces`)
	}
	const resourceClaims = namespaceResourceClaims(capabilities, candidate)
	if (resourceClaims instanceof Response) return resourceClaims
	const created = await c.db.createDeploymentNamespaceWithResourceClaims({
		id,
		env: candidate.env,
		exclusiveAppId: candidate.exclusiveAppId ?? null,
		provider: c.provider.id,
		providerTargetJson: JSON.stringify(candidate.target),
	}, resourceClaims)
	const result = await mutateNamespace(c, created, 'reconcile')
	const audited = result instanceof Response ? await c.db.getDeploymentNamespace(created.id) : result
	if (audited !== null) await auditMutation(c, 'namespace.adopt', audited)
	return result instanceof Response ? result : json(toNamespaceDto(result), { status: 201 })
}

export async function reconcileNamespace(c: NamespaceContext, id: string): Promise<Response> {
	const row = await c.db.getDeploymentNamespace(id)
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
		await c.db.acquireNamespaceResourceClaims({
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
	const audited = result instanceof Response ? await c.db.getDeploymentNamespace(row.id) : result
	if (audited !== null) await auditMutation(c, 'namespace.reconcile', audited)
	return result instanceof Response ? result : json(toNamespaceDto(result))
}
