import {
	GITHUB_LOGIN_PATTERN,
	GITHUB_OWNER_PATTERN,
	ID_PATTERN,
	MAX_ID_LENGTH,
	MAX_INSTALLATION_REPOSITORIES,
	MAX_WEBHOOK_SECRET_LENGTH,
	MAX_WEBHOOK_URL_LENGTH,
	ZEROPS_SOURCE_PROTOCOL_VERSION,
} from './constants'
import type {
	ZeropsSourceInstallationScopeV1,
	ZeropsSourceInstallationsVerifyInput,
	ZeropsSourceInstallationsVerifyRequestV1,
	ZeropsSourceInstallationsVerifyResponseV1,
	ZeropsSourceInstallationVerificationV1,
	ZeropsSourceWebhookConfigureInput,
	ZeropsSourceWebhookConfigureRequestV1,
	ZeropsSourceWebhookConfigureResponseV1,
} from './types'
import { boundedString, exactKeys, identifier, installationId, protocolVersion, record, repository, sha256 } from './validation'

const WEBHOOK_PATH = '/webhooks/github'

/**
 * Only the Zerops `source` configure wire reaches this, and every Zerops connection appends its own id
 * so one App's deliveries cannot be replayed against another. The bare path is a Cloudflare URL and is
 * refused here (ADR-0039).
 */
const isWebhookPath = (pathname: string): boolean => {
	if (!pathname.startsWith(`${WEBHOOK_PATH}/`)) return false
	const connectionId = pathname.slice(WEBHOOK_PATH.length + 1)
	// `ID_PATTERN` has no `%`, so a percent-escape in the path fails here rather than round-tripping.
	return connectionId.length > 0 && connectionId.length <= MAX_ID_LENGTH && ID_PATTERN.test(connectionId)
}

const webhookUrl = (value: unknown, label: string): string => {
	const candidate = boundedString(value, label, MAX_WEBHOOK_URL_LENGTH)
	let parsed: URL
	try {
		parsed = new URL(candidate)
	} catch {
		throw new Error(`${label} must be a secure URL`)
	}
	if (
		parsed.protocol !== 'https:' || parsed.port !== '' || parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== ''
		|| !isWebhookPath(parsed.pathname) || parsed.hostname === '' || candidate !== parsed.href
	) throw new Error(`${label} must be an exact secure GitHub webhook URL`)
	return candidate
}

const webhookSecret = (value: unknown, label: string): string => {
	const secret = boundedString(value, label, MAX_WEBHOOK_SECRET_LENGTH)
	if ([...secret].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) {
		throw new Error(`${label} is invalid`)
	}
	return secret
}

export function decodeZeropsSourceWebhookConfigureRequest(value: unknown): ZeropsSourceWebhookConfigureRequestV1 {
	const parsed = record(value, 'source webhook configure request')
	exactKeys(parsed, ['protocolVersion', 'connectionId', 'credentialSha256', 'url', 'secret'], 'source webhook configure request')
	return {
		protocolVersion: protocolVersion(parsed, 'source webhook configure request'),
		connectionId: identifier(parsed['connectionId'], 'source webhook configure request.connectionId'),
		credentialSha256: sha256(parsed['credentialSha256'], 'source webhook configure request.credentialSha256'),
		url: webhookUrl(parsed['url'], 'source webhook configure request.url'),
		secret: webhookSecret(parsed['secret'], 'source webhook configure request.secret'),
	}
}

export function buildZeropsSourceWebhookConfigureRequest(input: ZeropsSourceWebhookConfigureInput): ZeropsSourceWebhookConfigureRequestV1 {
	return decodeZeropsSourceWebhookConfigureRequest({
		protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION,
		connectionId: input.connectionId,
		credentialSha256: input.credentialSha256,
		url: input.url,
		secret: input.secret,
	})
}

export function decodeZeropsSourceWebhookConfigureResponse(value: unknown): ZeropsSourceWebhookConfigureResponseV1 {
	const parsed = record(value, 'source webhook configure response')
	exactKeys(parsed, ['protocolVersion', 'connectionId', 'credentialSha256', 'webhook'], 'source webhook configure response')
	const webhook = record(parsed['webhook'], 'source webhook configure response.webhook')
	exactKeys(webhook, ['url', 'contentType', 'insecureSsl'], 'source webhook configure response.webhook')
	if (webhook['contentType'] !== 'json' || webhook['insecureSsl'] !== '0') throw new Error('source webhook configure response is insecure')
	return {
		protocolVersion: protocolVersion(parsed, 'source webhook configure response'),
		connectionId: identifier(parsed['connectionId'], 'source webhook configure response.connectionId'),
		credentialSha256: sha256(parsed['credentialSha256'], 'source webhook configure response.credentialSha256'),
		webhook: { url: webhookUrl(webhook['url'], 'source webhook configure response.webhook.url'), contentType: 'json', insecureSsl: '0' },
	}
}

export function buildZeropsSourceWebhookConfigureResponse(
	input: Omit<ZeropsSourceWebhookConfigureResponseV1, 'protocolVersion'>,
): ZeropsSourceWebhookConfigureResponseV1 {
	return decodeZeropsSourceWebhookConfigureResponse({ protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION, ...input })
}

const installationScope = (value: unknown, label: string): ZeropsSourceInstallationScopeV1 => {
	const parsed = record(value, label)
	if (parsed['kind'] === 'organization') {
		exactKeys(parsed, ['kind', 'organization'], label)
		const organization = boundedString(parsed['organization'], `${label}.organization`, 39).toLowerCase()
		if (!GITHUB_OWNER_PATTERN.test(organization)) throw new Error(`${label}.organization is invalid`)
		return { kind: 'organization', organization }
	}
	if (parsed['kind'] !== 'repositories') throw new Error(`${label}.kind is invalid`)
	exactKeys(parsed, ['kind', 'repositories'], label)
	if (!Array.isArray(parsed['repositories']) || parsed['repositories'].length === 0 || parsed['repositories'].length > MAX_INSTALLATION_REPOSITORIES) {
		throw new Error(`${label}.repositories is invalid`)
	}
	const repositories = parsed['repositories'].map((entry) => repository(entry, `${label}.repositories entry`))
	const keys = repositories.map((entry) => `${entry.owner}/${entry.name}`)
	if (new Set(keys).size !== keys.length) throw new Error(`${label}.repositories contains a duplicate`)
	return { kind: 'repositories', repositories }
}

export function decodeZeropsSourceInstallationsVerifyRequest(value: unknown): ZeropsSourceInstallationsVerifyRequestV1 {
	const parsed = record(value, 'source installations verify request')
	exactKeys(parsed, ['protocolVersion', 'connectionId', 'credentialSha256', 'scope'], 'source installations verify request')
	return {
		protocolVersion: protocolVersion(parsed, 'source installations verify request'),
		connectionId: identifier(parsed['connectionId'], 'source installations verify request.connectionId'),
		credentialSha256: sha256(parsed['credentialSha256'], 'source installations verify request.credentialSha256'),
		scope: installationScope(parsed['scope'], 'source installations verify request.scope'),
	}
}

export function buildZeropsSourceInstallationsVerifyRequest(
	input: ZeropsSourceInstallationsVerifyInput,
): ZeropsSourceInstallationsVerifyRequestV1 {
	return decodeZeropsSourceInstallationsVerifyRequest({
		protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION,
		connectionId: input.connectionId,
		credentialSha256: input.credentialSha256,
		scope: input.scope,
	})
}

const installationVerification = (value: unknown, label: string): ZeropsSourceInstallationVerificationV1 => {
	const parsed = record(value, label)
	if (parsed['status'] === 'missing') {
		exactKeys(parsed, ['status'], label)
		return { status: 'missing' }
	}
	if (parsed['status'] !== 'installed') throw new Error(`${label}.status is invalid`)
	exactKeys(parsed, ['status', 'installationId', 'accountLogin', 'repositorySelection'], label)
	const accountLogin = boundedString(parsed['accountLogin'], `${label}.accountLogin`, 100)
	if (!GITHUB_LOGIN_PATTERN.test(accountLogin)) throw new Error(`${label}.accountLogin is invalid`)
	const repositorySelection = parsed['repositorySelection']
	if (repositorySelection !== 'all' && repositorySelection !== 'selected') throw new Error(`${label}.repositorySelection is invalid`)
	return {
		status: 'installed',
		installationId: installationId(parsed['installationId'], `${label}.installationId`),
		accountLogin,
		repositorySelection,
	}
}

export function decodeZeropsSourceInstallationsVerifyResponse(value: unknown): ZeropsSourceInstallationsVerifyResponseV1 {
	const parsed = record(value, 'source installations verify response')
	exactKeys(parsed, ['protocolVersion', 'connectionId', 'credentialSha256', 'installation'], 'source installations verify response')
	return {
		protocolVersion: protocolVersion(parsed, 'source installations verify response'),
		connectionId: identifier(parsed['connectionId'], 'source installations verify response.connectionId'),
		credentialSha256: sha256(parsed['credentialSha256'], 'source installations verify response.credentialSha256'),
		installation: installationVerification(parsed['installation'], 'source installations verify response.installation'),
	}
}

export function buildZeropsSourceInstallationsVerifyResponse(
	input: Omit<ZeropsSourceInstallationsVerifyResponseV1, 'protocolVersion'>,
): ZeropsSourceInstallationsVerifyResponseV1 {
	return decodeZeropsSourceInstallationsVerifyResponse({ protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION, ...input })
}
