import type {
	JsonValue,
	ProviderCodec,
	ProviderDeploymentNamespace,
	ProviderEnvelope,
	ProviderNamespaceHost,
	ProviderNamespaceMutationInput,
} from '@fabrika/provider-contract'
import { commitSha, identifier, optionalFields, record, repository, sha256 } from '../source/validation'
import { decodeZeropsNamespaceProxySource } from './proxy-source'
import type {
	NormalizedZeropsNamespaceTarget,
	ZeropsNamespaceOptions,
	ZeropsNamespacePostgres,
	ZeropsNamespaceProxyBuild,
	ZeropsNamespaceProxyDeployment,
	ZeropsNamespaceProxySource,
	ZeropsNamespaceTarget,
} from './types'

const encodeSource = (source: ZeropsNamespaceProxySource): JsonValue => ({
	repository: { ...source.repository },
	commitSha: source.commitSha,
	descriptor: { ...source.descriptor },
})

const decodeBuild = (value: unknown): ZeropsNamespaceProxyBuild => {
	const raw = record(value, 'proxy build')
	optionalFields(raw, ['runId', 'appVersionId', 'source', 'phase'], ['processId', 'manifestSha256'], 'proxy build')
	const { phase, processId, runId, appVersionId, source } = raw
	if (phase !== 'version_created' && phase !== 'source_uploaded' && phase !== 'build_trigger_requested' && phase !== 'build_triggered') {
		throw new Error('Invalid proxy build phase')
	}
	if (processId !== undefined && phase !== 'build_triggered') throw new Error('Proxy process conflicts with build phase')
	return {
		...(raw['manifestSha256'] === undefined ? {} : { manifestSha256: sha256(raw['manifestSha256'], 'proxy manifest digest') }),
		runId: identifier(runId, 'proxy run'),
		appVersionId: identifier(appVersionId, 'proxy version'),
		source: decodeZeropsNamespaceProxySource(source),
		phase,
		...(processId === undefined ? {} : { processId: identifier(processId, 'proxy process') }),
	}
}

const decodeDeployment = (value: unknown): ZeropsNamespaceProxyDeployment => {
	const raw = record(value, 'proxy deployment')
	optionalFields(raw, ['appVersionId', 'repository', 'commitSha', 'descriptorSha256'], ['manifestSha256'], 'proxy deployment')
	const { appVersionId, repository: coordinates, commitSha: commit, descriptorSha256 } = raw
	return {
		...(raw['manifestSha256'] === undefined ? {} : { manifestSha256: sha256(raw['manifestSha256'], 'proxy manifest digest') }),
		appVersionId: identifier(appVersionId, 'proxy deployment version'),
		repository: repository(coordinates, 'proxy deployment repository'),
		commitSha: commitSha(commit, 'proxy deployment commit'),
		descriptorSha256: sha256(descriptorSha256, 'proxy deployment descriptor digest'),
	}
}

const property = (payload: JsonValue, key: string): JsonValue | undefined => {
	if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
		throw new Error('Zerops namespace target must be an object')
	}
	return payload[key]
}

export const optionalString = (payload: JsonValue, key: string): string | undefined => {
	const value = property(payload, key)
	if (value === undefined) return undefined
	if (typeof value !== 'string' || value === '') {
		throw new Error(`Zerops namespace target ${key} must be a non-empty string`)
	}
	return value
}

const optionalBoolean = (payload: JsonValue, key: string): boolean | undefined => {
	const value = property(payload, key)
	if (value === undefined) return undefined
	if (typeof value !== 'boolean') {
		throw new Error(`Zerops namespace target ${key} must be a boolean`)
	}
	return value
}

const optionalInteger = (payload: JsonValue, key: string): number | undefined => {
	const value = property(payload, key)
	if (value === undefined) return undefined
	if (typeof value !== 'number' || !Number.isInteger(value) || value < -1) {
		throw new Error(`Zerops namespace target ${key} must be an integer greater than or equal to -1`)
	}
	return value
}

const postgresProfiles = {
	'postgresql:ha@18': new Set(['oltp-staging', 'oltp-production', 'oltp-enterprise', 'olap-production', 'writeheavy-production']),
	'postgresql:single@18': new Set(['oltp-hobby', 'oltp-staging', 'oltp-production', 'olap-production', 'writeheavy-production']),
}

export const parsePostgres = (payload: JsonValue): ZeropsNamespacePostgres | undefined => {
	const value = property(payload, 'postgres')
	if (value === undefined) return undefined
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('Zerops namespace target postgres must be an object')
	}
	const type = property(value, 'type')
	const profile = property(value, 'profile')
	if (type !== 'postgresql:ha@18' && type !== 'postgresql:single@18') {
		throw new Error('Zerops namespace PostgreSQL type must be postgresql:ha@18 or postgresql:single@18')
	}
	if (profile !== undefined && (typeof profile !== 'string' || !postgresProfiles[type].has(profile))) {
		throw new Error(`Zerops namespace PostgreSQL profile is not supported by ${type}`)
	}
	if (type === 'postgresql:ha@18') {
		if (
			profile !== undefined
			&& profile !== 'oltp-staging'
			&& profile !== 'oltp-production'
			&& profile !== 'oltp-enterprise'
			&& profile !== 'olap-production'
			&& profile !== 'writeheavy-production'
		) {
			throw new Error(`Zerops namespace PostgreSQL profile is not supported by ${type}`)
		}
		return profile === undefined ? { type } : { type, profile }
	}
	if (
		profile !== undefined
		&& profile !== 'oltp-hobby'
		&& profile !== 'oltp-staging'
		&& profile !== 'oltp-production'
		&& profile !== 'olap-production'
		&& profile !== 'writeheavy-production'
	) {
		throw new Error(`Zerops namespace PostgreSQL profile is not supported by ${type}`)
	}
	return profile === undefined ? { type } : { type, profile }
}

const parseProxyHosts = (payload: JsonValue): readonly ProviderNamespaceHost[] | undefined => {
	const value = property(payload, 'proxyHosts')
	if (value === undefined) return undefined
	if (!Array.isArray(value)) {
		throw new Error('Zerops namespace target proxyHosts must be an array')
	}
	return value.map((entry) => {
		if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
			throw new Error('Zerops namespace target proxyHosts entry must be an object')
		}
		const host = property(entry, 'host')
		const port = property(entry, 'port')
		if (typeof host !== 'string' || host === '') {
			throw new Error('Zerops namespace target proxyHosts host must be a non-empty string')
		}
		if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0) {
			throw new Error('Zerops namespace target proxyHosts port must be a positive integer')
		}
		return { host, port }
	})
}

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
		...(target.proxySource === undefined ? {} : { proxySource: encodeSource(target.proxySource) }),
		...(target.proxyBuild === undefined ? {} : {
			proxyBuild: {
				...(target.proxyBuild.manifestSha256 === undefined ? {} : { manifestSha256: target.proxyBuild.manifestSha256 }),
				runId: target.proxyBuild.runId,
				appVersionId: target.proxyBuild.appVersionId,
				source: encodeSource(target.proxyBuild.source),
				phase: target.proxyBuild.phase,
				...(target.proxyBuild.processId === undefined ? {} : { processId: target.proxyBuild.processId }),
			},
		}),
		...(target.projectName !== undefined ? { projectName: target.projectName } : {}),
		...(target.corePackage !== undefined ? { corePackage: target.corePackage } : {}),
		...(target.publicAccess !== undefined ? { publicAccess: target.publicAccess } : {}),
		...(target.proxyBuildFromGit !== undefined && target.proxyBuildFromGit !== '' ? { proxyBuildFromGit: target.proxyBuildFromGit } : {}),
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
		const corePackage = optionalString(payload, 'corePackage')
		if (corePackage !== undefined && corePackage !== 'LIGHT' && corePackage !== 'SERIOUS') {
			throw new Error('Zerops namespace target corePackage must be LIGHT or SERIOUS')
		}
		const publicAccess = optionalString(payload, 'publicAccess')
		if (publicAccess !== undefined && publicAccess !== 'custom-domain' && publicAccess !== 'zerops-subdomain') {
			throw new Error('Zerops namespace target publicAccess is not supported')
		}
		return {
			...(property(payload, 'proxyDeployment') === undefined ? {} : { proxyDeployment: decodeDeployment(property(payload, 'proxyDeployment')) }),
			...(property(payload, 'proxySource') === undefined ? {} : { proxySource: decodeZeropsNamespaceProxySource(property(payload, 'proxySource')) }),
			...(property(payload, 'proxyBuild') === undefined ? {} : { proxyBuild: decodeBuild(property(payload, 'proxyBuild')) }),
			...(optionalString(payload, 'projectName') !== undefined ? { projectName: optionalString(payload, 'projectName') } : {}),
			...(corePackage !== undefined ? { corePackage } : {}),
			...(publicAccess !== undefined ? { publicAccess } : {}),
			...(optionalString(payload, 'proxyBuildFromGit') !== undefined
				? { proxyBuildFromGit: optionalString(payload, 'proxyBuildFromGit') }
				: {}),
			...(parsePostgres(payload) !== undefined ? { postgres: parsePostgres(payload) } : {}),
			...(optionalBoolean(payload, 'managed') !== undefined ? { managed: optionalBoolean(payload, 'managed') } : {}),
			...(optionalString(payload, 'projectId') !== undefined ? { projectId: optionalString(payload, 'projectId') } : {}),
			...(optionalString(payload, 'proxyServiceId') !== undefined ? { proxyServiceId: optionalString(payload, 'proxyServiceId') } : {}),
			...(optionalString(payload, 'postgresServiceId') !== undefined
				? { postgresServiceId: optionalString(payload, 'postgresServiceId') }
				: {}),
			...(optionalBoolean(payload, 'proxyConfigured') !== undefined
				? { proxyConfigured: optionalBoolean(payload, 'proxyConfigured') }
				: {}),
			...(optionalInteger(payload, 'proxyBaselineSequence') !== undefined
				? { proxyBaselineSequence: optionalInteger(payload, 'proxyBaselineSequence') }
				: {}),
			...(optionalString(payload, 'proxyAppVersionId') !== undefined
				? { proxyAppVersionId: optionalString(payload, 'proxyAppVersionId') }
				: {}),
			...(parseProxyHosts(payload) !== undefined ? { proxyHosts: parseProxyHosts(payload) } : {}),
			...(optionalBoolean(payload, 'ready') !== undefined ? { ready: optionalBoolean(payload, 'ready') } : {}),
		}
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
	const proxyBuildFromGit = decoded.proxyBuildFromGit ?? ''
	return {
		...decoded,
		projectName: decoded.projectName ?? namespace.id,
		corePackage: decoded.corePackage ?? 'LIGHT',
		publicAccess: decoded.publicAccess ?? 'custom-domain',
		proxyBuildFromGit,
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
