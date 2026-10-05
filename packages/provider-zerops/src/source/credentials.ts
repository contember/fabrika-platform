import { z } from 'zod'
import {
	GITHUB_APP_ID_PATTERN,
	GITHUB_APP_SLUG_PATTERN,
	GITHUB_LOGIN_PATTERN,
	MAX_GITHUB_APP_PRIVATE_KEY_LENGTH,
	MAX_SOURCE_CREDENTIAL_BUNDLE_BYTES,
	ZEROPS_SOURCE_CREDENTIAL_BUNDLE_VERSION_V2,
	ZEROPS_SOURCE_CREDENTIAL_ENV_V2_PREFIX,
	ZEROPS_SOURCE_PROTOCOL_VERSION_V2,
} from './constants'
import type {
	ZeropsSourceCredentialActivateInput,
	ZeropsSourceCredentialActivateRequestV2,
	ZeropsSourceCredentialActivateResponseV2,
	ZeropsSourceCredentialActiveStatusResponseV2,
	ZeropsSourceCredentialBundleV2,
	ZeropsSourceCredentialStatusInput,
	ZeropsSourceCredentialStatusRequestV2,
	ZeropsSourceCredentialStatusResponseV2,
} from './types'
import { identifier, identifierSchema, installationIdSchema, parseSourceWire, sha256Schema } from './validation'

const isCanonicalPrivateKeyPem = (value: string): boolean => {
	const match = /^-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----\n([A-Za-z0-9+/=\n]+)\n-----END (RSA PRIVATE KEY|PRIVATE KEY)-----\n?$/.exec(value)
	if (match === null || match[1] !== match[3]) return false
	const body = match[2]
	if (body === undefined) return false
	const lines = body.split('\n')
	if (lines.some((line) => line.length === 0 || line.length > 64)) return false
	if (lines.slice(0, -1).some((line) => line.includes('='))) return false
	const encoded = lines.join('')
	if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false
	try {
		const decoded = atob(encoded)
		return decoded.length > 0 && decoded.charCodeAt(0) === 0x30
	} catch {
		return false
	}
}

const credentialBundleSchema = z.object({
	version: z.literal(ZEROPS_SOURCE_CREDENTIAL_BUNDLE_VERSION_V2),
	connectionId: identifierSchema,
	githubAppId: z.string().min(1).max(32).regex(GITHUB_APP_ID_PATTERN),
	privateKeyPem: z.string().min(1).max(MAX_GITHUB_APP_PRIVATE_KEY_LENGTH).refine(isCanonicalPrivateKeyPem, 'privateKeyPem is invalid'),
}).strict()

const githubAppIdentitySchema = z.object({
	id: installationIdSchema,
	slug: z.string().min(1).max(100).regex(GITHUB_APP_SLUG_PATTERN),
	htmlUrl: z.string().min(1).max(2048),
	public: z.boolean(),
	owner: z.object({ login: z.string().min(1).max(100).regex(GITHUB_LOGIN_PATTERN), type: z.literal('Organization') }).strict(),
	permissions: z.object({ contents: z.literal('read') }).strict(),
	events: z.tuple([z.literal('push')]),
}).strict().refine(({ htmlUrl, slug }) => {
	let parsed: URL
	try {
		parsed = new URL(htmlUrl)
	} catch {
		return false
	}
	return parsed.protocol === 'https:' && parsed.hostname === 'github.com' && parsed.port === ''
		&& parsed.username === '' && parsed.password === '' && parsed.search === '' && parsed.hash === ''
		&& parsed.pathname === `/apps/${slug}`
}, 'githubApp.htmlUrl is invalid')

const credentialStatusRequestSchema = z.object({
	protocolVersion: z.literal(ZEROPS_SOURCE_PROTOCOL_VERSION_V2),
	connectionId: identifierSchema,
}).strict()
const credentialActivateRequestSchema = credentialStatusRequestSchema.extend({
	credentialBundle: z.string().min(1).max(MAX_SOURCE_CREDENTIAL_BUNDLE_BYTES),
	credentialSha256: sha256Schema,
})
const credentialActivateResponseSchema = credentialStatusRequestSchema.extend({
	credentialVersion: z.literal(ZEROPS_SOURCE_CREDENTIAL_BUNDLE_VERSION_V2),
	credentialSha256: sha256Schema,
	githubApp: githubAppIdentitySchema,
})
const credentialStatusResponseSchema = z.discriminatedUnion('state', [
	credentialStatusRequestSchema.extend({ state: z.literal('anonymous') }),
	credentialActivateResponseSchema.extend({ state: z.literal('active') }),
])

export function buildZeropsSourceCredentialBundleV2(input: Omit<ZeropsSourceCredentialBundleV2, 'version'>): ZeropsSourceCredentialBundleV2 {
	return parseSourceWire(credentialBundleSchema, { version: ZEROPS_SOURCE_CREDENTIAL_BUNDLE_VERSION_V2, ...input }, 'source credential bundle v2')
}

export function serializeZeropsSourceCredentialBundleV2(bundle: ZeropsSourceCredentialBundleV2): string {
	return canonicalCredentialBundle(parseSourceWire(credentialBundleSchema, bundle, 'source credential bundle v2'))
}

function canonicalCredentialBundle(parsed: ZeropsSourceCredentialBundleV2): string {
	return JSON.stringify({
		version: parsed.version,
		connectionId: parsed.connectionId,
		githubAppId: parsed.githubAppId,
		privateKeyPem: parsed.privateKeyPem,
	})
}

export function decodeZeropsSourceCredentialBundleV2(value: unknown): ZeropsSourceCredentialBundleV2 {
	if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > MAX_SOURCE_CREDENTIAL_BUNDLE_BYTES) {
		throw new Error('source credential bundle v2 must be bounded canonical JSON')
	}
	let decoded: unknown
	try {
		decoded = JSON.parse(value)
	} catch {
		throw new Error('source credential bundle v2 must be bounded canonical JSON')
	}
	const bundle = parseSourceWire(credentialBundleSchema, decoded, 'source credential bundle v2')
	if (canonicalCredentialBundle(bundle) !== value) {
		throw new Error('source credential bundle v2 must be bounded canonical JSON')
	}
	return bundle
}

export async function sha256ZeropsSourceCredentialBundleV2(value: string): Promise<string> {
	decodeZeropsSourceCredentialBundleV2(value)
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
	return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function zeropsSourceCredentialEnvV2(connectionId: string): Promise<string> {
	const canonicalConnectionId = identifier(connectionId, 'source credential connectionId')
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalConnectionId)))
	return `${ZEROPS_SOURCE_CREDENTIAL_ENV_V2_PREFIX}${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export function decodeZeropsSourceCredentialActivateRequestV2(value: unknown): ZeropsSourceCredentialActivateRequestV2 {
	const parsed = parseSourceWire(credentialActivateRequestSchema, value, 'source credential activate request v2')
	const bundle = decodeZeropsSourceCredentialBundleV2(parsed.credentialBundle)
	if (bundle.connectionId !== parsed.connectionId) throw new Error('source credential activate request v2 connectionId does not match its bundle')
	return parsed
}

export function buildZeropsSourceCredentialActivateRequestV2(input: ZeropsSourceCredentialActivateInput): ZeropsSourceCredentialActivateRequestV2 {
	return decodeZeropsSourceCredentialActivateRequestV2({
		protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION_V2,
		connectionId: input.connectionId,
		credentialBundle: input.credentialBundle,
		credentialSha256: input.credentialSha256,
	})
}

export function decodeZeropsSourceCredentialActivateResponseV2(value: unknown): ZeropsSourceCredentialActivateResponseV2 {
	return parseSourceWire(credentialActivateResponseSchema, value, 'source credential activate response v2')
}

export function buildZeropsSourceCredentialActivateResponseV2(
	input: Omit<ZeropsSourceCredentialActivateResponseV2, 'protocolVersion'>,
): ZeropsSourceCredentialActivateResponseV2 {
	return decodeZeropsSourceCredentialActivateResponseV2({ protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION_V2, ...input })
}

export function decodeZeropsSourceCredentialStatusRequestV2(value: unknown): ZeropsSourceCredentialStatusRequestV2 {
	return parseSourceWire(credentialStatusRequestSchema, value, 'source credential status request v2')
}

export function buildZeropsSourceCredentialStatusRequestV2(input: ZeropsSourceCredentialStatusInput): ZeropsSourceCredentialStatusRequestV2 {
	return decodeZeropsSourceCredentialStatusRequestV2({ protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION_V2, connectionId: input.connectionId })
}

export function decodeZeropsSourceCredentialStatusResponseV2(value: unknown): ZeropsSourceCredentialStatusResponseV2 {
	return parseSourceWire(credentialStatusResponseSchema, value, 'source credential status response v2')
}

export function buildZeropsSourceCredentialStatusResponseV2(
	input:
		| { readonly connectionId: string; readonly state: 'anonymous' }
		| Omit<ZeropsSourceCredentialActiveStatusResponseV2, 'protocolVersion'>,
): ZeropsSourceCredentialStatusResponseV2 {
	return decodeZeropsSourceCredentialStatusResponseV2({ protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION_V2, ...input })
}
