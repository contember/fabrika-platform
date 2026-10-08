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

export const postgresSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('postgresql:ha@18'),
		profile: z.enum(['oltp-staging', 'oltp-production', 'oltp-enterprise', 'olap-production', 'writeheavy-production']).optional(),
	}),
	z.object({
		type: z.literal('postgresql:single@18'),
		profile: z.enum(['oltp-hobby', 'oltp-staging', 'oltp-production', 'olap-production', 'writeheavy-production']).optional(),
	}),
]).transform((value) => {
	if (value.profile === undefined) delete value.profile
	return value
})

const namespaceTargetSchema = z.object({
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
	ready: z.boolean().optional(),
}).transform((target) => {
	for (const key of Object.keys(target)) {
		if (Reflect.get(target, key) === undefined) Reflect.deleteProperty(target, key)
	}
	return target
})

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
