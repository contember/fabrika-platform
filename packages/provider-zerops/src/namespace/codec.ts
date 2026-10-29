import type {
	JsonValue,
	ProviderCodec,
	ProviderDeploymentNamespace,
	ProviderEnvelope,
	ProviderNamespaceMutationInput,
} from '@fabrika/provider-contract'
import { z } from 'zod'
import { commitShaSchema, identifierSchema, rejectExplicitUndefined, repositorySchema, sha256Schema } from '../source/validation'
import { namespaceProxySourceSchema } from './proxy-source'
import type { NormalizedZeropsNamespaceTarget, ZeropsNamespaceOptions, ZeropsNamespaceProxySource, ZeropsNamespaceTarget } from './types'

/** The one value an update may give `proxySource`: re-pin the namespace's proxy to the installation's default. */
export const ZEROPS_PROXY_SOURCE_CURRENT = 'current'

const encodeSource = (source: ZeropsNamespaceProxySource): JsonValue => ({
	repository: { ...source.repository },
	commitSha: source.commitSha,
	descriptor: { ...source.descriptor },
})

const proxyBuildSchema = z.object({
	appVersionId: identifierSchema,
	triggered: z.boolean(),
	manifestSha256: sha256Schema.optional(),
}).strict().superRefine(rejectExplicitUndefined)

const proxyDeploymentSchema = z.object({
	manifestSha256: sha256Schema.optional(),
	appVersionId: identifierSchema,
	repository: repositorySchema,
	commitSha: commitShaSchema,
	descriptorSha256: sha256Schema,
}).strict().superRefine(rejectExplicitUndefined)

const haPostgresSchema = z.object({
	type: z.literal('postgresql:ha@18'),
	profile: z.enum(['oltp-staging', 'oltp-production', 'oltp-enterprise', 'olap-production', 'writeheavy-production']).optional(),
})
const singlePostgresSchema = z.object({
	type: z.literal('postgresql:single@18'),
	profile: z.enum(['oltp-hobby', 'oltp-staging', 'oltp-production', 'olap-production', 'writeheavy-production']).optional(),
})

/** The Box API origin is exactly an `https:` origin: the key is sent there as a bearer. */
const isHttpsOrigin = (value: string): boolean => {
	try {
		const url = new URL(value)
		return url.protocol === 'https:' && url.origin === value
	} catch {
		return false
	}
}

const sandboxHostSchema = z.object({
	serviceId: z.string().min(1),
	apiOrigin: z.string().refine(isHttpsOrigin),
}).strict()

export const postgresSchema = z.discriminatedUnion('type', [haPostgresSchema, singlePostgresSchema]).transform((value) => {
	if (value.profile === undefined) delete value.profile
	return value
})

const namespaceTargetShape = z.object({
	proxyDeployment: proxyDeploymentSchema.optional(),
	proxySource: namespaceProxySourceSchema,
	proxyBuild: proxyBuildSchema.optional(),
	projectName: z.string().min(1).optional(),
	corePackage: z.enum(['LIGHT', 'SERIOUS']).optional(),
	publicAccess: z.enum(['custom-domain', 'zerops-subdomain']).optional(),
	postgres: postgresSchema.optional(),
	managed: z.boolean().optional(),
	projectId: z.string().min(1).optional(),
	proxyServiceId: z.string().min(1).optional(),
	postgresServiceId: z.string().min(1).optional(),
	proxyConfigured: z.boolean().optional(),
	proxyBaselineSequence: z.number().int().min(-1).optional(),
	proxyAppVersionId: z.string().min(1).optional(),
	proxyHosts: z.array(z.object({ host: z.string().min(1), port: z.number().int().positive() })).optional(),
	sandboxHost: sandboxHostSchema.optional(),
	ready: z.boolean().optional(),
})

const namespaceTargetSchema = namespaceTargetShape.transform((target) => {
	for (const key of Object.keys(target)) {
		if (Reflect.get(target, key) === undefined) Reflect.deleteProperty(target, key)
	}
	return target
})

/**
 * What an update request's payload may name: any target field, each optional, and no field the target
 * does not have — at the top level or inside `postgres`. The target schema STRIPS an unknown key, which
 * would turn a misspelt field into a silent no-op. `proxySource` also takes `current`, the installation's
 * default pin; the plan refuses any other pin than that one (ADR-0045).
 */
export const namespaceUpdatePayloadSchema = namespaceTargetShape.partial().extend({
	postgres: z.discriminatedUnion('type', [haPostgresSchema.strict(), singlePostgresSchema.strict()]).optional(),
	proxySource: z.union([z.literal(ZEROPS_PROXY_SOURCE_CURRENT), namespaceProxySourceSchema]).optional(),
}).strict()

export const zeropsNamespaceTargetCodec: ProviderCodec<ZeropsNamespaceTarget> = {
	version: 1,
	encode: (target) => ({
		...(target.proxyDeployment === undefined
			? {}
			: {
				proxyDeployment: {
					appVersionId: target.proxyDeployment.appVersionId,
					repository: { ...target.proxyDeployment.repository },
					commitSha: target.proxyDeployment.commitSha,
					descriptorSha256: target.proxyDeployment.descriptorSha256,
					...(target.proxyDeployment.manifestSha256 === undefined ? {} : { manifestSha256: target.proxyDeployment.manifestSha256 }),
				},
			}),
		proxySource: encodeSource(target.proxySource),
		...(target.proxyBuild === undefined ? {} : {
			proxyBuild: {
				appVersionId: target.proxyBuild.appVersionId,
				triggered: target.proxyBuild.triggered,
				...(target.proxyBuild.manifestSha256 === undefined ? {} : { manifestSha256: target.proxyBuild.manifestSha256 }),
			},
		}),
		...(target.projectName !== undefined ? { projectName: target.projectName } : {}),
		...(target.corePackage !== undefined ? { corePackage: target.corePackage } : {}),
		...(target.publicAccess !== undefined ? { publicAccess: target.publicAccess } : {}),
		...(target.postgres !== undefined
			? { postgres: { type: target.postgres.type, ...(target.postgres.profile !== undefined ? { profile: target.postgres.profile } : {}) } }
			: {}),
		...(target.managed !== undefined ? { managed: target.managed } : {}),
		...(target.projectId !== undefined ? { projectId: target.projectId } : {}),
		...(target.proxyServiceId !== undefined ? { proxyServiceId: target.proxyServiceId } : {}),
		...(target.postgresServiceId !== undefined ? { postgresServiceId: target.postgresServiceId } : {}),
		...(target.proxyConfigured !== undefined ? { proxyConfigured: target.proxyConfigured } : {}),
		...(target.proxyBaselineSequence !== undefined ? { proxyBaselineSequence: target.proxyBaselineSequence } : {}),
		...(target.proxyAppVersionId !== undefined ? { proxyAppVersionId: target.proxyAppVersionId } : {}),
		...(target.proxyHosts === undefined ? {} : { proxyHosts: target.proxyHosts.map((entry) => ({ host: entry.host, port: entry.port })) }),
		...(target.sandboxHost === undefined ? {} : { sandboxHost: { serviceId: target.sandboxHost.serviceId, apiOrigin: target.sandboxHost.apiOrigin } }),
		...(target.ready !== undefined ? { ready: target.ready } : {}),
	}),
	decode: (payload) => {
		const result = namespaceTargetSchema.safeParse(payload)
		if (!result.success) {
			const path = result.error.issues[0]?.path ?? []
			if (path[0] === 'postgres') {
				if (path[1] === 'type') throw new Error('Zerops namespace PostgreSQL type must be postgresql:ha@18 or postgresql:single@18')
				throw new Error('Zerops namespace PostgreSQL profile is not supported')
			}
			if (path[0] === 'proxyHosts' && path.at(-1) === 'port') throw new Error('Zerops namespace target proxyHosts port must be a positive integer')
			throw new Error(`Zerops namespace target ${path.join('.')} is invalid`)
		}
		return result.data
	},
}

export const envelope = (target: ZeropsNamespaceTarget): ProviderEnvelope => ({
	provider: 'zerops',
	version: zeropsNamespaceTargetCodec.version,
	payload: zeropsNamespaceTargetCodec.encode(target),
})

export const decodeEnvelope = (value: ProviderEnvelope): ZeropsNamespaceTarget => {
	if (value.provider !== 'zerops') {
		throw new Error(`namespace belongs to provider "${value.provider}", expected "zerops"`)
	}
	if (value.version !== zeropsNamespaceTargetCodec.version) {
		throw new Error(`namespace schema version ${value.version} is not supported by provider "zerops"`)
	}
	return zeropsNamespaceTargetCodec.decode(value.payload)
}

export const normalizeTarget = (
	namespace: ProviderDeploymentNamespace,
	options: ZeropsNamespaceOptions,
): NormalizedZeropsNamespaceTarget => {
	if (namespace.id.trim() === '' || namespace.env.trim() === '') {
		throw new Error('Zerops namespace id and env must be non-empty')
	}
	const decoded = decodeEnvelope(namespace.target)
	return {
		...decoded,
		projectName: decoded.projectName ?? namespace.id,
		corePackage: decoded.corePackage ?? 'LIGHT',
		publicAccess: decoded.publicAccess ?? 'custom-domain',
		managed: decoded.managed ?? decoded.projectId === undefined,
		ready: decoded.ready ?? false,
	}
}

export const normalizedNamespace = (
	namespace: ProviderDeploymentNamespace,
	options: ZeropsNamespaceOptions,
): ProviderDeploymentNamespace => ({
	...namespace,
	target: envelope(normalizeTarget(namespace, options)),
})

const withTarget = (
	namespace: ProviderDeploymentNamespace,
	target: ZeropsNamespaceTarget,
): ProviderDeploymentNamespace => ({ ...namespace, target: envelope(target) })

export const checkpoint = async (
	input: ProviderNamespaceMutationInput,
	namespace: ProviderDeploymentNamespace,
	target: ZeropsNamespaceTarget,
): Promise<ProviderDeploymentNamespace> => {
	const updated = withTarget(namespace, target)
	await input.events.checkpoint(updated)
	return updated
}
