import type { JsonValue, ProviderCodec } from '@fabrika/provider-contract'

/** Ephemeral credentials and handles used by one Cloudflare deploy. IAM's key is never among them (ADR-0022). */
export interface CloudflareTarget {
	readonly accountId: string
	readonly apiToken: string
	readonly stateNamespace?: string
}

/** A checkout recipe. The Oblaka graph stays executable code in the referenced config module. */
export interface CloudflareArtifact {
	readonly configPath: string
}

const objectProperty = (value: JsonValue, property: string): JsonValue => {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('expected an object')
	}
	const propertyValue = value[property]
	if (propertyValue === undefined) {
		throw new Error(`missing ${property}`)
	}
	return propertyValue
}

const stringProperty = (value: JsonValue, property: string): string => {
	const propertyValue = objectProperty(value, property)
	if (typeof propertyValue !== 'string' || propertyValue === '') {
		throw new Error(`${property} must be a non-empty string`)
	}
	return propertyValue
}

const optionalStringProperty = (value: JsonValue, property: string): string | undefined => {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('expected an object')
	}
	const propertyValue = value[property]
	if (propertyValue === undefined) {
		return undefined
	}
	if (typeof propertyValue !== 'string' || propertyValue === '') {
		throw new Error(`${property} must be a non-empty string`)
	}
	return propertyValue
}

export const cloudflareTargetCodec: ProviderCodec<CloudflareTarget> = {
	version: 1,
	encode: (target) => ({
		accountId: target.accountId,
		apiToken: target.apiToken,
		...(target.stateNamespace === undefined ? {} : { stateNamespace: target.stateNamespace }),
	}),
	decode: (payload) => ({
		accountId: stringProperty(payload, 'accountId'),
		apiToken: stringProperty(payload, 'apiToken'),
		...(optionalStringProperty(payload, 'stateNamespace') === undefined
			? {}
			: { stateNamespace: optionalStringProperty(payload, 'stateNamespace') }),
	}),
}

export const cloudflareArtifactCodec: ProviderCodec<CloudflareArtifact> = {
	version: 1,
	encode: (artifact) => ({ configPath: artifact.configPath }),
	decode: (payload) => ({ configPath: stringProperty(payload, 'configPath') }),
}

/** Build the default checkout recipe used by the Cloudflare runner. */
export const cloudflareArtifact = (configPath = 'fabrika.config.ts'): CloudflareArtifact => ({ configPath })
