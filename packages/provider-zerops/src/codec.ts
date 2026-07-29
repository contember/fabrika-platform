import type { JsonValue, ProviderCodec } from '@fabrika/provider-contract'
import type { ZeropsRuntimeTarget } from './types'

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

export const zeropsTargetCodec: ProviderCodec<ZeropsRuntimeTarget> = {
	version: 1,
	encode: (target) => ({
		projectId: target.projectId,
		serviceId: target.serviceId,
		accessToken: target.accessToken,
		...(target.buildFromGit !== undefined ? { buildFromGit: target.buildFromGit } : {}),
		...(target.apiBaseUrl !== undefined ? { apiBaseUrl: target.apiBaseUrl } : {}),
		...(target.propustkaUrl !== undefined ? { propustkaUrl: target.propustkaUrl } : {}),
		...(target.adminKey !== undefined ? { adminKey: target.adminKey } : {}),
	}),
	decode: (payload) => ({
		projectId: requiredString(payload, 'projectId'),
		serviceId: requiredString(payload, 'serviceId'),
		accessToken: requiredString(payload, 'accessToken'),
		...(optionalString(payload, 'buildFromGit') !== undefined ? { buildFromGit: optionalString(payload, 'buildFromGit') } : {}),
		...(optionalString(payload, 'apiBaseUrl') !== undefined ? { apiBaseUrl: optionalString(payload, 'apiBaseUrl') } : {}),
		...(optionalString(payload, 'propustkaUrl') !== undefined ? { propustkaUrl: optionalString(payload, 'propustkaUrl') } : {}),
		...(optionalString(payload, 'adminKey') !== undefined ? { adminKey: optionalString(payload, 'adminKey') } : {}),
	}),
}
