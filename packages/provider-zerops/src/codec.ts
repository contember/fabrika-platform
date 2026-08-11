import type { JsonValue, ProviderCodec } from '@fabrika/provider-contract'
import type { ZeropsRuntimeSource, ZeropsRuntimeTarget } from './types'

const field = (payload: JsonValue, key: string): JsonValue | undefined => {
	if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
		throw new Error('Zerops target must be an object')
	}
	return payload[key]
}

const requiredString = (payload: JsonValue, key: string): string => {
	const value = field(payload, key)
	if (typeof value !== 'string' || value === '') {
		throw new Error(`Zerops target ${key} must be a non-empty string`)
	}
	return value
}

const optionalString = (payload: JsonValue, key: string): string | undefined => {
	const value = field(payload, key)
	if (value === undefined) {
		return undefined
	}
	if (typeof value !== 'string' || value === '') {
		throw new Error(`Zerops target ${key} must be a non-empty string when present`)
	}
	return value
}

const IMMUTABLE_GIT_OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

const object = (value: JsonValue | undefined, label: string): { readonly [key: string]: JsonValue } => {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`)
	}
	return value
}

const runtimeSource = (payload: JsonValue): ZeropsRuntimeSource | undefined => {
	const value = field(payload, 'source')
	if (value === undefined) return undefined
	const source = object(value, 'Zerops target source')
	const repository = object(source['repository'], 'Zerops target source repository')
	const allowedSourceKeys = ['runId', 'repository', 'commitSha', 'githubInstallationId']
	const allowedRepositoryKeys = ['owner', 'name']
	if (Object.keys(source).some((key) => !allowedSourceKeys.includes(key))) {
		throw new Error('Zerops target source contains an unknown field')
	}
	if (Object.keys(repository).some((key) => !allowedRepositoryKeys.includes(key))) {
		throw new Error('Zerops target source repository contains an unknown field')
	}
	const installation = source['githubInstallationId']
	if (installation !== undefined && (typeof installation !== 'number' || !Number.isSafeInteger(installation) || installation <= 0)) {
		throw new Error('Zerops target source githubInstallationId must be a positive safe integer')
	}
	const commitSha = requiredString(source, 'commitSha')
	if (!IMMUTABLE_GIT_OBJECT.test(commitSha)) {
		throw new Error('Zerops target source commitSha must be an exact lowercase Git object id')
	}
	return {
		runId: requiredString(source, 'runId'),
		repository: {
			owner: requiredString(repository, 'owner'),
			name: requiredString(repository, 'name'),
		},
		commitSha,
		...(installation === undefined ? {} : { githubInstallationId: installation }),
	}
}

export const zeropsTargetCodec: ProviderCodec<ZeropsRuntimeTarget> = {
	version: 2,
	encode: (target) => ({
		projectId: target.projectId,
		serviceId: target.serviceId,
		accessToken: target.accessToken,
		...(target.source === undefined
			? {}
			: {
				source: {
					runId: target.source.runId,
					repository: { owner: target.source.repository.owner, name: target.source.repository.name },
					commitSha: target.source.commitSha,
					...(target.source.githubInstallationId === undefined ? {} : { githubInstallationId: target.source.githubInstallationId }),
				},
			}),
		...(target.apiBaseUrl !== undefined ? { apiBaseUrl: target.apiBaseUrl } : {}),
		...(target.propustkaUrl !== undefined ? { propustkaUrl: target.propustkaUrl } : {}),
		...(target.adminKey !== undefined ? { adminKey: target.adminKey } : {}),
	}),
	decode: (payload) => {
		const target = object(payload, 'Zerops target')
		const allowedKeys = ['projectId', 'serviceId', 'accessToken', 'source', 'apiBaseUrl', 'propustkaUrl', 'adminKey']
		if (Object.keys(target).some((key) => !allowedKeys.includes(key))) {
			throw new Error('Zerops target contains an unknown field')
		}
		const source = runtimeSource(payload)
		return {
			projectId: requiredString(payload, 'projectId'),
			serviceId: requiredString(payload, 'serviceId'),
			accessToken: requiredString(payload, 'accessToken'),
			...(source === undefined ? {} : { source }),
			...(optionalString(payload, 'apiBaseUrl') !== undefined ? { apiBaseUrl: optionalString(payload, 'apiBaseUrl') } : {}),
			...(optionalString(payload, 'propustkaUrl') !== undefined ? { propustkaUrl: optionalString(payload, 'propustkaUrl') } : {}),
			...(optionalString(payload, 'adminKey') !== undefined ? { adminKey: optionalString(payload, 'adminKey') } : {}),
		}
	},
}
