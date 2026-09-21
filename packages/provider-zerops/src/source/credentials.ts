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
	ZeropsSourceGitHubAppIdentityV1,
} from './types'
import { boundedString, exactKeys, identifier, installationId, protocolVersionV2, record, sha256 } from './validation'

const sourceCredentialBundleValueV2 = (value: unknown): ZeropsSourceCredentialBundleV2 => {
	const parsed = record(value, 'source credential bundle v2')
	exactKeys(parsed, ['version', 'connectionId', 'githubAppId', 'privateKeyPem'], 'source credential bundle v2')
	if (parsed['version'] !== ZEROPS_SOURCE_CREDENTIAL_BUNDLE_VERSION_V2) {
		throw new Error('source credential bundle v2 has an unsupported version')
	}
	const connectionId = identifier(parsed['connectionId'], 'source credential bundle v2.connectionId')
	const githubAppId = boundedString(parsed['githubAppId'], 'source credential bundle v2.githubAppId', 32)
	if (!GITHUB_APP_ID_PATTERN.test(githubAppId)) throw new Error('source credential bundle v2.githubAppId is invalid')
	const privateKeyPem = boundedString(
		parsed['privateKeyPem'],
		'source credential bundle v2.privateKeyPem',
		MAX_GITHUB_APP_PRIVATE_KEY_LENGTH,
	)
	if (!isCanonicalPrivateKeyPem(privateKeyPem)) throw new Error('source credential bundle v2.privateKeyPem is invalid')
	return { version: ZEROPS_SOURCE_CREDENTIAL_BUNDLE_VERSION_V2, connectionId, githubAppId, privateKeyPem }
}

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

export function buildZeropsSourceCredentialBundleV2(
	input: Omit<ZeropsSourceCredentialBundleV2, 'version'>,
): ZeropsSourceCredentialBundleV2 {
	return sourceCredentialBundleValueV2({ version: ZEROPS_SOURCE_CREDENTIAL_BUNDLE_VERSION_V2, ...input })
}

export function serializeZeropsSourceCredentialBundleV2(bundle: ZeropsSourceCredentialBundleV2): string {
	const parsed = sourceCredentialBundleValueV2(bundle)
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
	const bundle = sourceCredentialBundleValueV2(decoded)
	if (serializeZeropsSourceCredentialBundleV2(bundle) !== value) {
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

const githubAppIdentity = (value: unknown, label: string): ZeropsSourceGitHubAppIdentityV1 => {
	const parsed = record(value, label)
	exactKeys(parsed, ['id', 'slug', 'htmlUrl', 'public', 'owner', 'permissions', 'events'], label)
	const id = installationId(parsed['id'], `${label}.id`)
	const slug = boundedString(parsed['slug'], `${label}.slug`, 100)
	if (!GITHUB_APP_SLUG_PATTERN.test(slug)) throw new Error(`${label}.slug is invalid`)
	const htmlUrl = boundedString(parsed['htmlUrl'], `${label}.htmlUrl`, 2048)
	let parsedHtmlUrl: URL
	try {
		parsedHtmlUrl = new URL(htmlUrl)
	} catch {
		throw new Error(`${label}.htmlUrl is invalid`)
	}
	if (
		parsedHtmlUrl.protocol !== 'https:' || parsedHtmlUrl.hostname !== 'github.com' || parsedHtmlUrl.port !== ''
		|| parsedHtmlUrl.username !== '' || parsedHtmlUrl.password !== '' || parsedHtmlUrl.search !== '' || parsedHtmlUrl.hash !== ''
		|| parsedHtmlUrl.pathname !== `/apps/${slug}`
	) {
		throw new Error(`${label}.htmlUrl is invalid`)
	}
	if (typeof parsed['public'] !== 'boolean') throw new Error(`${label}.public must be boolean`)
	const owner = record(parsed['owner'], `${label}.owner`)
	exactKeys(owner, ['login', 'type'], `${label}.owner`)
	const login = boundedString(owner['login'], `${label}.owner.login`, 100)
	if (!GITHUB_LOGIN_PATTERN.test(login) || owner['type'] !== 'Organization') throw new Error(`${label}.owner is invalid`)
	const permissions = record(parsed['permissions'], `${label}.permissions`)
	exactKeys(permissions, ['contents'], `${label}.permissions`)
	if (permissions['contents'] !== 'read') throw new Error(`${label}.permissions is invalid`)
	if (!Array.isArray(parsed['events']) || parsed['events'].length !== 1 || parsed['events'][0] !== 'push') {
		throw new Error(`${label}.events is invalid`)
	}
	return {
		id,
		slug,
		htmlUrl,
		public: parsed['public'],
		owner: { login, type: 'Organization' },
		permissions: { contents: 'read' },
		events: ['push'],
	}
}

export function decodeZeropsSourceCredentialActivateRequestV2(value: unknown): ZeropsSourceCredentialActivateRequestV2 {
	const parsed = record(value, 'source credential activate request v2')
	exactKeys(
		parsed,
		['protocolVersion', 'connectionId', 'credentialBundle', 'credentialSha256'],
		'source credential activate request v2',
	)
	const connectionId = identifier(parsed['connectionId'], 'source credential activate request v2.connectionId')
	const credentialBundle = boundedString(
		parsed['credentialBundle'],
		'source credential activate request v2.credentialBundle',
		MAX_SOURCE_CREDENTIAL_BUNDLE_BYTES,
	)
	const bundle = decodeZeropsSourceCredentialBundleV2(credentialBundle)
	if (bundle.connectionId !== connectionId) throw new Error('source credential activate request v2 connectionId does not match its bundle')
	return {
		protocolVersion: protocolVersionV2(parsed, 'source credential activate request v2'),
		connectionId,
		credentialBundle,
		credentialSha256: sha256(parsed['credentialSha256'], 'source credential activate request v2.credentialSha256'),
	}
}

export function buildZeropsSourceCredentialActivateRequestV2(
	input: ZeropsSourceCredentialActivateInput,
): ZeropsSourceCredentialActivateRequestV2 {
	return decodeZeropsSourceCredentialActivateRequestV2({
		protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION_V2,
		connectionId: input.connectionId,
		credentialBundle: input.credentialBundle,
		credentialSha256: input.credentialSha256,
	})
}

export function decodeZeropsSourceCredentialActivateResponseV2(value: unknown): ZeropsSourceCredentialActivateResponseV2 {
	const parsed = record(value, 'source credential activate response v2')
	exactKeys(
		parsed,
		['protocolVersion', 'connectionId', 'credentialVersion', 'credentialSha256', 'githubApp'],
		'source credential activate response v2',
	)
	if (parsed['credentialVersion'] !== ZEROPS_SOURCE_CREDENTIAL_BUNDLE_VERSION_V2) {
		throw new Error('source credential activate response v2 has an unsupported credentialVersion')
	}
	return {
		protocolVersion: protocolVersionV2(parsed, 'source credential activate response v2'),
		connectionId: identifier(parsed['connectionId'], 'source credential activate response v2.connectionId'),
		credentialVersion: ZEROPS_SOURCE_CREDENTIAL_BUNDLE_VERSION_V2,
		credentialSha256: sha256(parsed['credentialSha256'], 'source credential activate response v2.credentialSha256'),
		githubApp: githubAppIdentity(parsed['githubApp'], 'source credential activate response v2.githubApp'),
	}
}

export function buildZeropsSourceCredentialActivateResponseV2(
	input: Omit<ZeropsSourceCredentialActivateResponseV2, 'protocolVersion'>,
): ZeropsSourceCredentialActivateResponseV2 {
	return decodeZeropsSourceCredentialActivateResponseV2({ protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION_V2, ...input })
}

export function decodeZeropsSourceCredentialStatusRequestV2(value: unknown): ZeropsSourceCredentialStatusRequestV2 {
	const parsed = record(value, 'source credential status request v2')
	exactKeys(parsed, ['protocolVersion', 'connectionId'], 'source credential status request v2')
	return {
		protocolVersion: protocolVersionV2(parsed, 'source credential status request v2'),
		connectionId: identifier(parsed['connectionId'], 'source credential status request v2.connectionId'),
	}
}

export function buildZeropsSourceCredentialStatusRequestV2(
	input: ZeropsSourceCredentialStatusInput,
): ZeropsSourceCredentialStatusRequestV2 {
	return decodeZeropsSourceCredentialStatusRequestV2({
		protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION_V2,
		connectionId: input.connectionId,
	})
}

export function decodeZeropsSourceCredentialStatusResponseV2(value: unknown): ZeropsSourceCredentialStatusResponseV2 {
	const parsed = record(value, 'source credential status response v2')
	if (parsed['state'] === 'anonymous') {
		exactKeys(parsed, ['protocolVersion', 'connectionId', 'state'], 'source credential status response v2')
		return {
			protocolVersion: protocolVersionV2(parsed, 'source credential status response v2'),
			connectionId: identifier(parsed['connectionId'], 'source credential status response v2.connectionId'),
			state: 'anonymous',
		}
	}
	if (parsed['state'] !== 'active') throw new Error('source credential status response v2.state is invalid')
	exactKeys(
		parsed,
		['protocolVersion', 'connectionId', 'state', 'credentialVersion', 'credentialSha256', 'githubApp'],
		'source credential status response v2',
	)
	const active = decodeZeropsSourceCredentialActivateResponseV2({
		protocolVersion: parsed['protocolVersion'],
		connectionId: parsed['connectionId'],
		credentialVersion: parsed['credentialVersion'],
		credentialSha256: parsed['credentialSha256'],
		githubApp: parsed['githubApp'],
	})
	return { ...active, state: 'active' }
}

export function buildZeropsSourceCredentialStatusResponseV2(
	input:
		| { readonly connectionId: string; readonly state: 'anonymous' }
		| Omit<ZeropsSourceCredentialActiveStatusResponseV2, 'protocolVersion'>,
): ZeropsSourceCredentialStatusResponseV2 {
	return decodeZeropsSourceCredentialStatusResponseV2({ protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION_V2, ...input })
}
