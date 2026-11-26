// The SCIM discovery documents (RFC 7644 §4, RFC 7643 §5–7): what this service provider supports, for a provider or
// a validator that reads them. Microsoft Entra ID configures attributes from its own mapping and reads none of them.

import { MAX_ATTRIBUTE_LENGTH, USER_SCHEMA } from './resource'

const SERVICE_PROVIDER_CONFIG_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'
const RESOURCE_TYPE_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:ResourceType'
const SCHEMA_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Schema'
const LIST_RESPONSE_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse'

/** One discovery document, at `<base>/<name>` or `<base>/<name>/<id>`; null for an unknown id. */
type Document = (base: string, id: string | undefined) => Record<string, unknown> | null

function serviceProviderConfig(base: string, id: string | undefined): Record<string, unknown> | null {
	if (id !== undefined) return null
	return {
		schemas: [SERVICE_PROVIDER_CONFIG_SCHEMA],
		patch: { supported: true },
		bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
		filter: { supported: true, maxResults: 100 },
		changePassword: { supported: false },
		sort: { supported: false },
		etag: { supported: false },
		authenticationSchemes: [{
			type: 'oauthbearertoken',
			name: 'Bearer token',
			description: "The installation's SCIM token, created by an installation administrator in the console",
			primary: true,
		}],
		meta: { resourceType: 'ServiceProviderConfig', location: `${base}/ServiceProviderConfig` },
	}
}

function userResourceType(base: string): Record<string, unknown> {
	return {
		schemas: [RESOURCE_TYPE_SCHEMA],
		id: 'User',
		name: 'User',
		endpoint: '/Users',
		description: 'A person of the installation',
		schema: USER_SCHEMA,
		schemaExtensions: [],
		meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/User` },
	}
}

function resourceTypes(base: string, id: string | undefined): Record<string, unknown> | null {
	if (id === 'User') return userResourceType(base)
	if (id !== undefined) return null
	return { schemas: [LIST_RESPONSE_SCHEMA], totalResults: 1, startIndex: 1, itemsPerPage: 1, Resources: [userResourceType(base)] }
}

function attribute(name: string, options: { required?: boolean; uniqueness?: 'none' | 'server'; type?: 'string' | 'boolean' } = {}) {
	return {
		name,
		type: options.type ?? 'string',
		multiValued: false,
		required: options.required ?? false,
		caseExact: false,
		mutability: 'readWrite',
		returned: 'default',
		uniqueness: options.uniqueness ?? 'none',
		...(options.type === 'boolean' ? {} : { description: `At most ${MAX_ATTRIBUTE_LENGTH} characters` }),
	}
}

function userSchema(base: string): Record<string, unknown> {
	return {
		schemas: [SCHEMA_SCHEMA],
		id: USER_SCHEMA,
		name: 'User',
		description: 'The attributes IAM stores; any other attribute is accepted and ignored',
		attributes: [
			attribute('userName', { required: true, uniqueness: 'server' }),
			attribute('externalId'),
			attribute('displayName'),
			{
				name: 'name',
				type: 'complex',
				multiValued: false,
				required: false,
				mutability: 'readWrite',
				returned: 'default',
				subAttributes: [attribute('givenName'), attribute('familyName')],
			},
			attribute('active', { type: 'boolean' }),
			{
				name: 'emails',
				type: 'complex',
				multiValued: true,
				required: false,
				mutability: 'readWrite',
				returned: 'default',
				description: "The primary (else the work) address is the person's mailbox, which their sign-in matches",
				subAttributes: [attribute('value'), attribute('type'), attribute('primary', { type: 'boolean' })],
			},
		],
		meta: { resourceType: 'Schema', location: `${base}/Schemas/${USER_SCHEMA}` },
	}
}

function schemas(base: string, id: string | undefined): Record<string, unknown> | null {
	if (id === USER_SCHEMA) return userSchema(base)
	if (id !== undefined) return null
	return { schemas: [LIST_RESPONSE_SCHEMA], totalResults: 1, startIndex: 1, itemsPerPage: 1, Resources: [userSchema(base)] }
}

/** The documents by their lower-cased path segment. */
export const DISCOVERY: Readonly<Record<string, Document | undefined>> = {
	serviceproviderconfig: serviceProviderConfig,
	resourcetypes: resourceTypes,
	schemas,
}
